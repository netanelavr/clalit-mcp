import type { SerializedCookieJar } from "tough-cookie";
import { PATHS, PORTAL_ORIGIN } from "./constants.js";
import { AuthenticationError, otpSessionIncompleteMessage } from "./errors.js";
import type { ClalitSession } from "./session.js";
import {
  extractBotDetectFields,
  extractCaptchaImageUrl,
  extractLoginEventTarget,
  extractOtpEventTarget,
  extractSubmitFields,
  resolveBotDetectInstanceId,
  resolveInputName,
} from "./captcha.js";
import {
  writeCaptchaRejectedDump,
  writeLoginHopDump,
  type LoginHopDiagnostic,
} from "./login-diagnostics.js";
import {
  ClalitTransport,
  isPortalDefenseCookieName,
  readBytes,
  readText,
  responseSetCookieNames,
  setCookieHeaderName,
  type BrowserCookieSeed,
} from "./transport.js";
import {
  buildPostBackBody,
  extractWebFormsState,
  isLoginRedirectTarget,
  looksLikeBotChallenge,
  looksLikeLoginPage,
} from "./webforms.js";

/**
 * Login is interactive on the member's own machine (residential IP).
 *
 * Observed flow (Gate 2 HAR + 2026-09 live HTML — ASP.NET WebForms, not a JSON API):
 * 1. GET/POST /onlineweb/general/infootplogin.aspx
 *    fields: ctl00$cphBody$tbUserId, ctl00$cphBody$tbCaptchaLogin,
 *    LBD_VCID_… (BotDetect instance id), __EVENTTARGET=ctl00$cphBody$btnSendOTP,
 *    plus __VIEWSTATE…
 * 2. GET/POST /OnlineWeb/General/OTPSMSVerification.aspx — field txtClientOTP,
 *    __EVENTTARGET=ctl00$cphBody$btnContinue$lnkSubButton (LinkButton).
 *    Empty event target redisplays the OTP form (HTTP 200, no PostOtpAuth).
 * 3. GET /OnlineWeb/General/Login.aspx only after that postback (302 / Object moved).
 *    A cold GET sets .ONLINEAUTH without PostOtpAuth/AfterLogin and labs stays logged out.
 *
 * Imperva sits in front. Datacenter / headless IPs get Error 16.
 * This package NEVER solves or bypasses CAPTCHA / Imperva. The human solves
 * CAPTCHA in a real browser (or an interactive prompt that shows the image),
 * then enters the SMS OTP. Session cookies are then reused for reads.
 *
 * Optional keep-alive: GET RefreshSession.aspx — only after a valid session,
 * rate-limited, and never as a substitute for login.
 */

/** Wall-clock budget for captcha POST → OTP page (transport also aborts ~30s/request). */
export const CAPTCHA_CHECK_BUDGET_MS = 30_000;

export interface CaptchaChallenge {
  /** HTML or image hint for the human. Image bytes may be attached by the CLI. */
  pageHtml: string;
  /** BotDetect / captcha field name if detected. */
  captchaFieldName?: string;
  viewStatePresent: boolean;
  /** Absolute CAPTCHA image URL on the portal (same cookie jar), when detected. */
  captchaImageUrl?: string;
  /** Image bytes fetched with the login session, when available. */
  captchaImage?: { bytes: Uint8Array; contentType: string };
}

export interface OtpChallenge {
  message: string;
}

export interface PendingLoginExport {
  version: 1;
  stage: "awaiting_captcha" | "awaiting_otp";
  idNumber: string;
  cookies: SerializedCookieJar;
  createdAt: string;
}

export interface LoginPrompts {
  /** Return the CAPTCHA text the human solved. */
  solveCaptcha(challenge: CaptchaChallenge): Promise<string>;
  /** Return the SMS OTP the human received. */
  readOtp(challenge: OtpChallenge): Promise<string>;
}

export interface LoginOptions {
  /**
   * Optional browser/Playwright cookies to seed the jar before login
   * (Imperva visid_incap_, incap_ses_, TS, _cls_). Values never logged.
   */
  seedCookies?: BrowserCookieSeed[];
}

function looksLikeOtpPage(html: string): boolean {
  return /txtClientOTP|OTPSMSVerification/i.test(html);
}

function looksLikeCaptchaLoginPage(html: string): boolean {
  return /tbCaptchaLogin|tbUserId/i.test(html) && /captcha/i.test(html);
}

/**
 * After a correct BotDetect answer Clalit often returns HTTP 200 HTML that still
 * contains the captcha form, plus JS:
 *   setCookie('HasOTP', '-otp-sms', 90);
 *   redirectInfoToOnline('/OnlineWeb/General/Login.aspx');
 * Treat that as captcha accepted (browser would follow to Login.aspx → OTP).
 */
function looksLikeHasOtpAcceptedRedirect(html: string): boolean {
  return (
    /setCookie\s*\(\s*['"]HasOTP['"]/i.test(html) &&
    /redirectInfoToOnline\s*\(\s*['"][^'"]*Login\.aspx['"]/i.test(html)
  );
}

/** Value from setCookie('HasOTP', '…', …) when present. */
function extractHasOtpCookieValue(html: string): string | undefined {
  const m = html.match(/setCookie\s*\(\s*['"]HasOTP['"]\s*,\s*['"]([^'"]*)['"]/i);
  return m?.[1];
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Resolve Location / href against the current portal request URL. */
function resolvePortalUrl(target: string, baseUrl: string): string {
  const trimmed = target.trim();
  if (!trimmed) return baseUrl;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
    return PORTAL_ORIGIN + (trimmed.startsWith("/") ? trimmed : `/${trimmed}`);
  }
}

/**
 * Next hop from ASP.NET Object-moved body or Clalit JS redirects.
 * Prefer caller Location header when present.
 */
function extractHtmlRedirectTarget(html: string): string | undefined {
  if (/object\s+moved/i.test(html)) {
    const href = html.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) return href;
  }
  const info = html.match(/redirectInfoToOnline\s*\(\s*['"]([^'"]+)['"]/i);
  if (info?.[1]) return info[1];
  const loc = html.match(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i);
  if (loc?.[1]) return loc[1];
  const meta =
    html.match(
      /http-equiv\s*=\s*['"]?refresh['"]?[^>]*content\s*=\s*['"]?\d+\s*;\s*url=([^"'\s>]+)/i,
    ) ??
    html.match(
      /content\s*=\s*['"]?\d+\s*;\s*url=([^"'\s>]+)[^>]*http-equiv\s*=\s*['"]?refresh/i,
    );
  if (meta?.[1]) return meta[1];
  return undefined;
}

/**
 * Mirror browser document setCookie('name', 'value', days) into raw Set-Cookie lines.
 * Never log the values.
 */
function extractJsSetCookieLines(html: string): string[] {
  const lines: string[] = [];
  const re =
    /setCookie\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*(?:,\s*(\d+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[1];
    const value = m[2] ?? "";
    const days = m[3] !== undefined ? Number(m[3]) : 90;
    const maxAge = Number.isFinite(days) && days > 0 ? Math.floor(days * 86400) : 7_776_000;
    lines.push(`${name}=${value}; Path=/; Max-Age=${maxAge}`);
  }
  const docRe = /document\.cookie\s*=\s*['"]([^'"]+)['"]/gi;
  while ((m = docRe.exec(html))) {
    const raw = m[1]?.trim();
    if (!raw || !raw.includes("=")) continue;
    lines.push(/(?:^|;)\s*path\s*=/i.test(raw) ? raw : `${raw}; Path=/`);
  }
  return lines;
}

/** Cookies that mean the OTP postback actually established a portal session. */
function isPortalAuthCookieName(name: string): boolean {
  return /^(?:PostOtpAuth|AfterLogin|PortalAuth|ClalitPortal|ExtraPortal|\.ASPXAUTH)$/i.test(name);
}

/** True when the SMS code <input> is still on the page (postback did not leave OTP). */
function otpEntryFormPresent(html: string): boolean {
  return /<input\b[^>]*\b(?:name|id)\s*=\s*["'][^"']*txtClientOTP[^"']*["']/i.test(html);
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Interactive login. Designed for Mac/local residential use.
 * On this agent box (Imperva Error 16) the first GET will throw BOT_CHALLENGE.
 */
export class ClalitAuth {
  readonly transport: ClalitTransport;

  constructor(transport = new ClalitTransport()) {
    this.transport = transport;
  }

  /**
   * Full interactive login. Prompts belong to the caller (CLI).
   * Returns an authenticated session.
   */
  async loginInteractive(
    idNumber: string,
    prompts: LoginPrompts,
    options: LoginOptions = {},
  ): Promise<ClalitSession> {
    if (!/^\d{1,9}$/.test(idNumber)) throw new AuthenticationError("INVALID_ID_FORMAT");

    await this.transport.clearSession();
    if (options.seedCookies?.length) {
      await this.transport.importBrowserCookies(options.seedCookies);
    }
    const loginUrl = PORTAL_ORIGIN + PATHS.loginFoot;
    const page = await this.transport.request(loginUrl, { allowLoginHtml: true });
    const html = await readText(page);
    if (looksLikeBotChallenge(html, page.status)) {
      throw new AuthenticationError("BOT_CHALLENGE", page.status);
    }

    const state = extractWebFormsState(html);
    // Live page uses UniqueIDs: ctl00$cphBody$tbUserId / tbCaptchaLogin.
    // Fall back to short names for fixtures / older HTML.
    const userIdField = resolveInputName(html, "tbUserId") ?? "tbUserId";
    const captchaField = resolveInputName(html, "tbCaptchaLogin") ?? "tbCaptchaLogin";
    // Typed answer goes only to the captcha text box. BotDetect BDC_*/LBD_* fields
    // (often type=text, not hidden) must be round-tripped separately — extractWebFormsState
    // only collects type=hidden, so without this a type=text VCID never reaches Clalit.
    const botDetectFields = extractBotDetectFields(html);
    // Prefer LinkButton __EVENTTARGET (btnSendOTP). Only fall back to submit inputs
    // when no postback target is present — avoids posting BottomMenuModalDialog.
    const loginEventTarget = extractLoginEventTarget(html);
    const submitFields = loginEventTarget ? {} : extractSubmitFields(html);

    const captchaImageUrl = extractCaptchaImageUrl(html);
    let captchaImage: CaptchaChallenge["captchaImage"];
    let imageFinalUrl = captchaImageUrl;
    if (captchaImageUrl) {
      try {
        const imgRes = await this.transport.request(captchaImageUrl, { allowLoginHtml: true });
        imageFinalUrl = imgRes.url || captchaImageUrl;
        const bytes = await readBytes(imgRes, 500_000);
        const contentType = imgRes.headers.get("content-type") ?? "image/png";
        if (
          imgRes.ok &&
          bytes.byteLength > 0 &&
          !looksLikeBotChallenge(Buffer.from(bytes).toString("latin1"), imgRes.status)
        ) {
          captchaImage = { bytes, contentType: contentType.split(";")[0]!.trim() || "image/png" };
        }
      } catch {
        /* Image is best-effort; human can still type from portal browser. */
      }
    }

    const instanceId = resolveBotDetectInstanceId(html, imageFinalUrl);
    if (instanceId) {
      for (const name of Object.keys(botDetectFields)) {
        // Never overwrite a server-rendered VCID with a guess from the image URL.
        if (/VCID/i.test(name) && !botDetectFields[name]?.trim()) {
          botDetectFields[name] = instanceId;
        }
      }
    }

    const captcha = await prompts.solveCaptcha({
      pageHtml: html,
      captchaFieldName: captchaField,
      viewStatePresent: Boolean(state.viewState),
      ...(captchaImageUrl ? { captchaImageUrl } : {}),
      ...(captchaImage ? { captchaImage } : {}),
    });

    const body = buildPostBackBody(
      state,
      {
        [userIdField]: idNumber,
        [captchaField]: captcha,
        ...botDetectFields,
        ...submitFields,
      },
      loginEventTarget ?? "",
      "",
    );

    // Cap the entire captcha-submit → OTP-page path so UI never waits forever.
    const otpHtml = await withTimeout(
      this.#advanceToOtpPage(loginUrl, body, html),
      CAPTCHA_CHECK_BUDGET_MS,
      () => new AuthenticationError("CAPTCHA_CHECK_TIMEOUT"),
    );

    const otpUrl = PORTAL_ORIGIN + PATHS.otpSms;
    const otpState = extractWebFormsState(otpHtml);
    const otpField = resolveInputName(otpHtml, "txtClientOTP") ?? "txtClientOTP";
    // Live page posts via LinkButton, not a type=submit. Empty __EVENTTARGET
    // redisplays OTPSMSVerification (200, no PostOtpAuth) and a later cold
    // Login.aspx GET only sets .ONLINEAUTH.
    const otpEventTarget = extractOtpEventTarget(otpHtml) ?? "";
    const otpSubmitFields = otpEventTarget ? {} : extractSubmitFields(otpHtml);
    const code = await prompts.readOtp({
      message: "Enter the SMS one-time code from Clalit.",
    });
    if (!/^\d{4,8}$/.test(code)) throw new AuthenticationError("INVALID_OTP_FORMAT");

    const otpBody = buildPostBackBody(
      otpState,
      { [otpField]: code, ...otpSubmitFields },
      otpEventTarget,
      "",
    );
    const verified = await this.transport.request(otpUrl, {
      method: "POST",
      allowLoginHtml: true,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: otpUrl,
        origin: PORTAL_ORIGIN,
      },
      body: otpBody,
    });
    // OTP POST + Login.aspx/portal hops set auth cookies via Set-Cookie (and JS
    // setCookie mirrors). Follow the full chain and merge into the jar before export.
    const hops = await this.#completePortalSessionAfterOtp(verified, otpUrl);

    // Fail-closed: do not markAuthenticated / write session on incomplete jars.
    await this.#assertCompleteOtpSession(hops);

    this.transport.markAuthenticated();
    return this.transport.exportSession();
  }

  /**
   * After OTPSMSVerification succeeds, follow Location / Object-moved / JS redirects,
   * mirror setCookie(...) into the jar, and ensure Login.aspx → portal runs so
   * exportSession persists portal auth cookies (not only ASP.NET_SessionId).
   */
  async #completePortalSessionAfterOtp(
    otpResponse: Response,
    otpUrl: string,
  ): Promise<LoginHopDiagnostic[]> {
    const hops = await this.#followAuthRedirectChain(otpResponse, otpUrl, 8);
    const touchedLogin = hops.some((h) => /\/Login\.aspx\b/i.test(h.url));
    // Do not cold-GET Login.aspx unless the OTP response already set portal auth
    // cookies. Otherwise Login.aspx is the anonymous login page: it sets
    // .ONLINEAUTH and labs still 302s (dump 2026-09-30T10:16:57Z).
    if (!touchedLogin) {
      const names = await this.transport.listCookieNames();
      if (names.some(isPortalAuthCookieName)) {
        const loginUrl = PORTAL_ORIGIN + PATHS.login;
        const hop = await this.transport.request(loginUrl, { allowLoginHtml: true });
        hops.push(...(await this.#followAuthRedirectChain(hop, loginUrl, 8)));
      }
    }
    return hops;
  }

  /**
   * Fail closed when the jar lacks Imperva/TS-style cookies or LabsTestList still
   * redirects to Login. Does not call markAuthenticated — session must not be written.
   */
  async #assertCompleteOtpSession(hops: LoginHopDiagnostic[]): Promise<void> {
    const finalJarNames = await this.transport.listCookieNames();
    const finalJarCount = await this.transport.cookieCount();
    const hasDefense = finalJarNames.some(isPortalDefenseCookieName);

    let labsProbe: { status: number; location?: string; loginRedirect: boolean } | undefined;
    let labsLoginRedirect = false;
    try {
      const labsUrl = PORTAL_ORIGIN + PATHS.labsList;
      const labsRes = await this.transport.request(labsUrl, { allowLoginHtml: true });
      const location = labsRes.headers.get("location") ?? undefined;
      let loginRedirect =
        (labsRes.status === 301 ||
          labsRes.status === 302 ||
          labsRes.status === 303 ||
          labsRes.status === 307 ||
          labsRes.status === 308) &&
        Boolean(location && isLoginRedirectTarget(location));
      if (!loginRedirect) {
        try {
          const html = await readText(labsRes);
          loginRedirect = looksLikeLoginPage(html);
        } catch {
          /* body unreadable — treat as incomplete below only if status suggests login */
        }
      }
      labsLoginRedirect = loginRedirect;
      labsProbe = {
        status: labsRes.status,
        ...(location ? { location } : {}),
        loginRedirect,
      };
    } catch {
      labsLoginRedirect = true;
      labsProbe = { status: 0, loginRedirect: true };
    }

    await writeLoginHopDump({
      hops,
      finalJarNames,
      finalJarCount,
      reason: !hasDefense
        ? "missing_portal_defense_cookies"
        : labsLoginRedirect
          ? "labs_login_redirect"
          : "ok",
      ...(labsProbe ? { labsProbe } : {}),
    });

    const incompleteReason = !hasDefense
      ? "missing_portal_defense_cookies"
      : labsLoginRedirect
        ? "labs_login_redirect"
        : undefined;
    if (incompleteReason) {
      throw new AuthenticationError(
        "OTP_SESSION_INCOMPLETE",
        undefined,
        otpSessionIncompleteMessage(incompleteReason),
      );
    }
  }

  /**
   * Follow redirects while merging every hop's Set-Cookie (via transport) and
   * mirroring HTML setCookie() calls. Returns per-hop diagnostics (names only).
   */
  async #followAuthRedirectChain(
    initial: Response,
    initialUrl: string,
    maxHops: number,
  ): Promise<LoginHopDiagnostic[]> {
    const hops: LoginHopDiagnostic[] = [];
    const visited: string[] = [initialUrl];
    let current = initial;
    let currentUrl = initialUrl;

    for (let hop = 0; hop < maxHops; hop += 1) {
      const setCookieNames = responseSetCookieNames(current);
      let html = "";
      const ct = current.headers.get("content-type") ?? "";
      const mightBeHtml =
        ct.includes("text/html") ||
        current.status === 200 ||
        isRedirectStatus(current.status);
      let jsCookieLines: string[] = [];
      if (mightBeHtml) {
        try {
          html = await readText(current);
        } catch {
          html = "";
        }
        jsCookieLines = extractJsSetCookieLines(html);
        for (const raw of jsCookieLines) {
          // Values never logged.
          await this.transport.setCookie(raw, currentUrl);
        }
      }

      const jarCookieNames = await this.transport.listCookieNames();
      hops.push({
        url: currentUrl,
        status: current.status,
        setCookieNames,
        jarCookieNames,
        jarCount: jarCookieNames.length,
      });

      const locationHeader = current.headers.get("location") ?? undefined;
      const htmlTarget = html ? extractHtmlRedirectTarget(html) : undefined;
      const jsNames = jsCookieLines
        .map(setCookieHeaderName)
        .filter((n): n is string => Boolean(n));
      const gotPortalAuth =
        setCookieNames.some(isPortalAuthCookieName) || jsNames.some(isPortalAuthCookieName);
      // Shared chrome on the still-visible OTP form calls redirectInfoToOnline(Login.aspx).
      // Following that without PostOtpAuth lands on anonymous Login.aspx (.ONLINEAUTH only).
      const ignoreEmbeddedLogin =
        Boolean(html) &&
        otpEntryFormPresent(html) &&
        !gotPortalAuth &&
        !isRedirectStatus(current.status);

      let nextRaw: string | undefined;
      if (locationHeader && (isRedirectStatus(current.status) || !ignoreEmbeddedLogin)) {
        nextRaw = locationHeader;
      }
      if (!nextRaw && htmlTarget && !ignoreEmbeddedLogin) {
        nextRaw = htmlTarget;
      }
      if (!nextRaw) break;

      const nextUrl = resolvePortalUrl(nextRaw, currentUrl);
      if (visited.includes(nextUrl) && hop > 0) break;
      try {
        // Origin allowlist enforced inside transport.request.
        current = await this.transport.request(nextUrl, { allowLoginHtml: true });
      } catch {
        break;
      }
      currentUrl = nextUrl;
      visited.push(nextUrl);
    }

    return hops;
  }

  /**
   * POST captcha + ID, follow redirects / OTP GET, and return OTP page HTML.
   * Throws CAPTCHA_REJECTED when Clalit redisplays the login CAPTCHA form
   * without a HasOTP → Login.aspx success redirect.
   */
  async #advanceToOtpPage(
    loginUrl: string,
    body: string,
    loginHtmlForDump: string,
  ): Promise<string> {
    const otpUrl = PORTAL_ORIGIN + PATHS.otpSms;
    const portalLoginUrl = PORTAL_ORIGIN + PATHS.login;
    let current = await this.transport.request(loginUrl, {
      method: "POST",
      allowLoginHtml: true,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: loginUrl,
        origin: PORTAL_ORIGIN,
      },
      body,
    });
    let html = await readText(current);
    let triedOtpGet = false;
    let followedHasOtpRedirect = false;

    for (let hops = 0; hops < 8; hops += 1) {
      if (looksLikeBotChallenge(html, current.status)) {
        throw new AuthenticationError("BOT_CHALLENGE", current.status);
      }
      if (looksLikeOtpPage(html)) {
        return html;
      }
      // Captcha accepted: JS redirect to Login.aspx (still captcha-shaped HTML).
      if (looksLikeHasOtpAcceptedRedirect(html)) {
        if (followedHasOtpRedirect) {
          throw new AuthenticationError("OTP_PAGE_MISSING", current.status);
        }
        followedHasOtpRedirect = true;
        // Mirror browser setCookie('HasOTP', …) before following Login.aspx → OTP.
        const hasOtpValue = extractHasOtpCookieValue(html) ?? "-otp-sms";
        await this.transport.setCookie(`HasOTP=${hasOtpValue}; Path=/; Max-Age=7776000`);
        current = await this.transport.request(portalLoginUrl, { allowLoginHtml: true });
        html = await readText(current);
        continue;
      }
      if (looksLikeCaptchaLoginPage(html)) {
        // Prefer the response HTML (may show validators); fall back to pre-POST shape.
        const dumpHtml = html.length > 100 ? html : loginHtmlForDump;
        await writeCaptchaRejectedDump({
          pageHtml: dumpHtml,
          postBody: body,
          status: current.status,
        });
        throw new AuthenticationError("CAPTCHA_REJECTED", current.status);
      }

      const location = current.headers.get("location");
      if (location && isRedirectStatus(current.status)) {
        const next = location.startsWith("http") ? location : PORTAL_ORIGIN + location;
        current = await this.transport.request(next, { allowLoginHtml: true });
        html = await readText(current);
        continue;
      }

      // Empty/non-OTP body with no redirect: progress with an explicit OTP GET once.
      if (!triedOtpGet) {
        triedOtpGet = true;
        current = await this.transport.request(otpUrl, { allowLoginHtml: true });
        html = await readText(current);
        continue;
      }

      throw new AuthenticationError("OTP_PAGE_MISSING", current.status);
    }

    throw new AuthenticationError("OTP_PAGE_MISSING", current.status);
  }

  /** Optional soft keep-alive. Safe only with an existing session; never bypasses login. */
  async refreshSession(): Promise<void> {
    const res = await this.transport.request(PORTAL_ORIGIN + PATHS.refreshSession);
    if (!res.ok) throw new AuthenticationError("REFRESH_FAILED", res.status);
  }
}
