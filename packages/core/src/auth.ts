import type { SerializedCookieJar } from "tough-cookie";
import { PATHS, PORTAL_ORIGIN } from "./constants.js";
import { AuthenticationError } from "./errors.js";
import type { ClalitSession } from "./session.js";
import {
  extractBotDetectFields,
  extractCaptchaImageUrl,
  extractLoginEventTarget,
  extractSubmitFields,
  resolveBotDetectInstanceId,
  resolveInputName,
} from "./captcha.js";
import { writeCaptchaRejectedDump } from "./login-diagnostics.js";
import { ClalitTransport, readBytes, readText } from "./transport.js";
import { buildPostBackBody, extractWebFormsState, looksLikeBotChallenge } from "./webforms.js";

/**
 * Login is interactive on the member's own machine (residential IP).
 *
 * Observed flow (Gate 2 HAR + 2026-09 live HTML — ASP.NET WebForms, not a JSON API):
 * 1. GET/POST /onlineweb/general/infootplogin.aspx
 *    fields: ctl00$cphBody$tbUserId, ctl00$cphBody$tbCaptchaLogin,
 *    LBD_VCID_… (BotDetect instance id), __EVENTTARGET=ctl00$cphBody$btnSendOTP,
 *    plus __VIEWSTATE…
 * 2. GET/POST /OnlineWeb/General/OTPSMSVerification.aspx — field txtClientOTP
 * 3. GET /OnlineWeb/General/Login.aspx (302 into portal)
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

function looksLikeOtpPage(html: string): boolean {
  return /txtClientOTP|OTPSMSVerification/i.test(html);
}

function looksLikeCaptchaLoginPage(html: string): boolean {
  return /tbCaptchaLogin|tbUserId/i.test(html) && /captcha/i.test(html);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
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
  async loginInteractive(idNumber: string, prompts: LoginPrompts): Promise<ClalitSession> {
    if (!/^\d{1,9}$/.test(idNumber)) throw new AuthenticationError("INVALID_ID_FORMAT");

    await this.transport.clearSession();
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
        if (/VCID/i.test(name)) botDetectFields[name] = instanceId;
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
    const code = await prompts.readOtp({
      message: "Enter the SMS one-time code from Clalit.",
    });
    if (!/^\d{4,8}$/.test(code)) throw new AuthenticationError("INVALID_OTP_FORMAT");

    const otpBody = buildPostBackBody(otpState, { [otpField]: code });
    const verified = await this.transport.request(otpUrl, {
      method: "POST",
      allowLoginHtml: true,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: otpBody,
    });
    // Follow manual redirects toward portal home / labs
    let location = verified.headers.get("location");
    let hops = 0;
    while (location && hops < 8) {
      hops += 1;
      const next = location.startsWith("http") ? location : PORTAL_ORIGIN + location;
      const hop = await this.transport.request(next, { allowLoginHtml: true });
      location = hop.headers.get("location");
      if (hop.status === 200 && !location) break;
    }

    this.transport.markAuthenticated();
    return this.transport.exportSession();
  }

  /**
   * POST captcha + ID, follow redirects / OTP GET, and return OTP page HTML.
   * Throws CAPTCHA_REJECTED when Clalit redisplays the login CAPTCHA form.
   */
  async #advanceToOtpPage(
    loginUrl: string,
    body: string,
    loginHtmlForDump: string,
  ): Promise<string> {
    const otpUrl = PORTAL_ORIGIN + PATHS.otpSms;
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

    for (let hops = 0; hops < 8; hops += 1) {
      if (looksLikeBotChallenge(html, current.status)) {
        throw new AuthenticationError("BOT_CHALLENGE", current.status);
      }
      if (looksLikeOtpPage(html)) {
        return html;
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
