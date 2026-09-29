import type { SerializedCookieJar } from "tough-cookie";
import { PATHS, PORTAL_ORIGIN } from "./constants.js";
import { AuthenticationError } from "./errors.js";
import type { ClalitSession } from "./session.js";
import { ClalitTransport, readText } from "./transport.js";
import { buildPostBackBody, extractWebFormsState, looksLikeBotChallenge } from "./webforms.js";

/**
 * Login is interactive on the member's own machine (residential IP).
 *
 * Observed flow (Gate 2 HAR — ASP.NET WebForms, not a JSON API):
 * 1. GET/POST /onlineweb/general/infootplogin.aspx
 *    fields: tbUserId, tbCaptchaLogin, BotDetect captcha id field, __VIEWSTATE…
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

export interface CaptchaChallenge {
  /** HTML or image hint for the human. Image bytes may be attached by the CLI. */
  pageHtml: string;
  /** BotDetect / captcha field name if detected. */
  captchaFieldName?: string;
  viewStatePresent: boolean;
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
    const captchaField =
      /name="([^"]*Captcha[^"]*)"/i.exec(html)?.[1] ??
      /name="([^"]*BotDetect[^"]*)"/i.exec(html)?.[1];

    const captcha = await prompts.solveCaptcha({
      pageHtml: html,
      ...(captchaField ? { captchaFieldName: captchaField } : {}),
      viewStatePresent: Boolean(state.viewState),
    });

    const body = buildPostBackBody(state, {
      tbUserId: idNumber,
      tbCaptchaLogin: captcha,
      ...(captchaField ? { [captchaField]: captcha } : {}),
    });

    const posted = await this.transport.request(loginUrl, {
      method: "POST",
      allowLoginHtml: true,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const postHtml = await readText(posted);
    if (looksLikeBotChallenge(postHtml, posted.status)) {
      throw new AuthenticationError("BOT_CHALLENGE", posted.status);
    }

    // Expect OTP page
    const otpUrl = PORTAL_ORIGIN + PATHS.otpSms;
    let otpHtml = postHtml;
    if (!/txtClientOTP|OTPSMSVerification/i.test(postHtml)) {
      const otpPage = await this.transport.request(otpUrl, { allowLoginHtml: true });
      otpHtml = await readText(otpPage);
    }

    const otpState = extractWebFormsState(otpHtml);
    const code = await prompts.readOtp({
      message: "Enter the SMS one-time code from Clalit.",
    });
    if (!/^\d{4,8}$/.test(code)) throw new AuthenticationError("INVALID_OTP_FORMAT");

    const otpBody = buildPostBackBody(otpState, { txtClientOTP: code });
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

  /** Optional soft keep-alive. Safe only with an existing session; never bypasses login. */
  async refreshSession(): Promise<void> {
    const res = await this.transport.request(PORTAL_ORIGIN + PATHS.refreshSession);
    if (!res.ok) throw new AuthenticationError("REFRESH_FAILED", res.status);
  }
}
