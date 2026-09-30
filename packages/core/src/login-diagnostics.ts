import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  extractBotDetectFields,
  extractCaptchaImageUrl,
  extractLoginEventTarget,
  extractSubmitFields,
  resolveInputName,
} from "./captcha.js";

/** Same config-dir resolution as the CLI (never commit this directory). */
export function clalitConfigDir(): string {
  if (process.env.CLALIT_CONFIG_DIR) return process.env.CLALIT_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "clalit-mcp");
  return join(homedir(), ".config", "clalit-mcp");
}

export interface LoginFieldShape {
  tag: string;
  name?: string;
  id?: string;
  type: string;
  valueEmpty: boolean;
}

export interface CaptchaImageShape {
  path: string;
  queryKeys: string[];
  hasD: boolean;
  hasT: boolean;
  hasC: boolean;
  hasI: boolean;
}

export interface LoginHtmlShapeDump {
  fields: LoginFieldShape[];
  botDetectFields: Array<{ name: string; type: string; valueEmpty: boolean }>;
  submitButtons: LoginFieldShape[];
  eventTargets: string[];
  captchaImage?: CaptchaImageShape;
  resolved: {
    userIdField?: string;
    captchaField?: string;
    loginEventTarget?: string;
    botDetectVcidsEmpty: boolean;
  };
  htmlHints: {
    hasViewState: boolean;
    hasEventValidation: boolean;
    hasViewStateEncrypted: boolean;
    formActions: string[];
  };
}

const SENSITIVE_KEY =
  /(?:user|id|captcha|otp|password|viewstate|eventvalidation|cookie|token|secret|ssn|tz)/i;

/** Inventory login HTML without values (field names/types and captcha URL query keys only). */
export function summarizeLoginHtmlShape(pageHtml: string): LoginHtmlShapeDump {
  const fields: LoginFieldShape[] = [];
  const re = /<(input|button|select|textarea)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pageHtml)) !== null) {
    const tagName = match[1]!.toLowerCase();
    const tag = match[0]!;
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const type =
      (/\btype\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "").toLowerCase() || tagName;
    const rawValue = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    const valueEmpty = rawValue === undefined || rawValue.trim() === "";
    fields.push({
      tag: tagName,
      ...(name ? { name } : {}),
      ...(id ? { id } : {}),
      type,
      valueEmpty,
    });
  }

  const botDetectFields = fields
    .filter((f) => f.name && /^(?:BDC_|LBD_)/i.test(f.name))
    .map((f) => ({
      name: f.name!,
      type: f.type,
      valueEmpty: f.valueEmpty,
    }));

  const submitButtons = fields.filter((f) => {
    const isButton =
      f.tag === "button" || f.type === "submit" || f.type === "image" || f.type === "button";
    return isButton && Boolean(f.name);
  });

  const eventTargets = [
    ...pageHtml.matchAll(/WebForm_PostBackOptions\(\s*(?:&quot;|")([^"&]+)(?:&quot;|")/gi),
  ].map((m) => m[1]!);

  let captchaImage: CaptchaImageShape | undefined;
  const imageUrl = extractCaptchaImageUrl(pageHtml);
  if (imageUrl) {
    try {
      const u = new URL(imageUrl);
      captchaImage = {
        path: u.pathname,
        queryKeys: [...u.searchParams.keys()],
        hasD: u.searchParams.has("d"),
        hasT: u.searchParams.has("t"),
        hasC: u.searchParams.has("c"),
        hasI: u.searchParams.has("i"),
      };
    } catch {
      captchaImage = {
        path: "(unparseable)",
        queryKeys: [],
        hasD: false,
        hasT: false,
        hasC: false,
        hasI: false,
      };
    }
  }

  const extractedBd = extractBotDetectFields(pageHtml);
  const vcidEntries = Object.entries(extractedBd).filter(([n]) => /VCID/i.test(n));
  const botDetectVcidsEmpty =
    vcidEntries.length === 0 || vcidEntries.every(([, v]) => !String(v).trim());

  return {
    fields,
    botDetectFields,
    submitButtons,
    eventTargets,
    ...(captchaImage ? { captchaImage } : {}),
    resolved: {
      ...(resolveInputName(pageHtml, "tbUserId")
        ? { userIdField: resolveInputName(pageHtml, "tbUserId") }
        : {}),
      ...(resolveInputName(pageHtml, "tbCaptchaLogin")
        ? { captchaField: resolveInputName(pageHtml, "tbCaptchaLogin") }
        : {}),
      ...(extractLoginEventTarget(pageHtml)
        ? { loginEventTarget: extractLoginEventTarget(pageHtml) }
        : {}),
      botDetectVcidsEmpty,
    },
    htmlHints: {
      hasViewState: /name=["']__VIEWSTATE["']/i.test(pageHtml),
      hasEventValidation: /name=["']__EVENTVALIDATION["']/i.test(pageHtml),
      hasViewStateEncrypted: /name=["']__VIEWSTATEENCRYPTED["']/i.test(pageHtml),
      formActions: [...pageHtml.matchAll(/<form\b[^>]*\baction=["']([^"']*)["']/gi)].map(
        (m) => m[1]!,
      ),
    },
  };
}


/** Booleans only — never HTML snippets or cookie values — for CAPTCHA_REJECTED dumps. */
export function summarizeCaptchaRejectHints(pageHtml: string): {
  hasHasOtpSetCookie: boolean;
  hasRedirectInfoToOnlineLogin: boolean;
  cvCaptchaDisplayNone: boolean;
  cvCaptchaVisibleRed: boolean;
} {
  const hasHasOtpSetCookie = /setCookie\s*\(\s*['"]HasOTP['"]/i.test(pageHtml);
  const hasRedirectInfoToOnlineLogin =
    /redirectInfoToOnline\s*\(\s*['"][^'"]*Login\.aspx['"]/i.test(pageHtml);

  const cvTag =
    /<(?:span|div)\b[^>]*\bid\s*=\s*["']cvClalitInfoCaptchaLogin["'][^>]*>/i.exec(pageHtml)?.[0] ??
    /<(?:span|div)\b[^>]*\bid\s*=\s*["'][^"']*cvCaptcha[^"']*["'][^>]*>/i.exec(pageHtml)?.[0];

  let cvCaptchaDisplayNone = false;
  let cvCaptchaVisibleRed = false;
  if (cvTag) {
    const style = /\bstyle\s*=\s*["']([^"']*)["']/i.exec(cvTag)?.[1] ?? "";
    const displayNone = /display\s*:\s*none/i.test(style);
    const red = /color\s*:\s*(?:Red|#f00|#ff0000|rgb\(\s*255\s*,\s*0\s*,\s*0\s*\))/i.test(style);
    cvCaptchaDisplayNone = displayNone;
    cvCaptchaVisibleRed = red && !displayNone;
  }

  return {
    hasHasOtpSetCookie,
    hasRedirectInfoToOnlineLogin,
    cvCaptchaDisplayNone,
    cvCaptchaVisibleRed,
  };
}

/** POST body key list only; values are never retained. */
export function summarizePostBodyKeys(body: string): {
  keys: string[];
  sensitiveKeysRedacted: string[];
  submitKeys: string[];
  botDetectKeys: string[];
} {
  const params = new URLSearchParams(body);
  const keys = [...params.keys()];
  const sensitiveKeysRedacted = keys.filter((k) => SENSITIVE_KEY.test(k));
  const submitKeys = keys.filter(
    (k) => /btn|submit|\.x$|\.y$/i.test(k) || k === "__EVENTTARGET" || k === "__EVENTARGUMENT",
  );
  const botDetectKeys = keys.filter((k) => /^(?:BDC_|LBD_)/i.test(k));
  return { keys, sensitiveKeysRedacted, submitKeys, botDetectKeys };
}

/**
 * Best-effort redacted dump under ~/.config/clalit-mcp/ (mode 0600).
 * Never writes ID / captcha / viewstate values — keys and HTML shape only.
 */
export async function writeCaptchaRejectedDump(opts: {
  pageHtml: string;
  postBody: string;
  status?: number;
}): Promise<string | undefined> {
  try {
    const dir = clalitConfigDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `captcha-rejected-${stamp}.json`);
    const payload = {
      version: 1,
      reason: "CAPTCHA_REJECTED",
      at: new Date().toISOString(),
      ...(opts.status !== undefined ? { httpStatus: opts.status } : {}),
      captchaRejectHints: summarizeCaptchaRejectHints(opts.pageHtml),
      loginHtmlShape: summarizeLoginHtmlShape(opts.pageHtml),
      // For comparison: what extractSubmitFields would have added (names only).
      extractSubmitFieldNames: Object.keys(extractSubmitFields(opts.pageHtml)),
      postBody: summarizePostBodyKeys(opts.postBody),
    };
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}


/** One login redirect hop — names only, never cookie values. */
export interface LoginHopDiagnostic {
  url: string;
  status: number;
  setCookieNames: string[];
  jarCookieNames: string[];
  jarCount: number;
}

/**
 * Best-effort redacted dump of the OTP→portal hop chain (mode 0600).
 * Never writes cookie values — names, statuses, and URLs only.
 */
export async function writeLoginHopDump(opts: {
  hops: LoginHopDiagnostic[];
  finalJarNames: string[];
  finalJarCount: number;
  reason?: string;
  labsProbe?: { status: number; location?: string; loginRedirect: boolean };
}): Promise<string | undefined> {
  try {
    const dir = clalitConfigDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `login-hops-${stamp}.json`);
    const payload = {
      version: 1,
      kind: "login-hops",
      at: new Date().toISOString(),
      ...(opts.reason ? { reason: opts.reason } : {}),
      hops: opts.hops.map((h) => ({
        url: h.url,
        status: h.status,
        setCookieNames: h.setCookieNames,
        jarCookieNames: h.jarCookieNames,
        jarCount: h.jarCount,
      })),
      finalJarNames: opts.finalJarNames,
      finalJarCount: opts.finalJarCount,
      ...(opts.labsProbe ? { labsProbe: opts.labsProbe } : {}),
    };
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Redacted dump when OTP POST returns HTTP 200 still showing the OTP form.
 * Field names + __EVENTTARGET used only — never cookie/OTP/viewstate values.
 */
export async function writeOtpRedisplayDump(opts: {
  fieldNames: string[];
  eventTarget: string;
  validationMessagePresent: boolean;
  status?: number;
}): Promise<string | undefined> {
  try {
    const dir = clalitConfigDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `otp-redisplay-${stamp}.json`);
    const payload = {
      version: 1,
      kind: "otp-redisplay",
      at: new Date().toISOString(),
      reason: "otp_form_redisplay",
      ...(opts.status !== undefined ? { httpStatus: opts.status } : {}),
      fieldNames: opts.fieldNames,
      eventTarget: opts.eventTarget,
      validationMessagePresent: opts.validationMessagePresent,
    };
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}
