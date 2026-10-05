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
import { PORTAL_ORIGIN } from "./constants.js";
import { isLoginRedirectTarget, looksLikeLoginPage } from "./webforms.js";

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
  /** Response content-type without parameters (e.g. text/html). */
  contentType?: string;
  /** Redirect Location header, path only (query/host stripped). */
  locationPath?: string;
  /** Short classification of what this hop's response looks like. */
  pageKind?: LoginPageKind;
}

export interface LabsProbeDiagnostic {
  status: number;
  location?: string;
  locationPath?: string;
  loginRedirect: boolean;
}

/**
 * Best-effort redacted dump of the OTP→portal hop chain (mode 0600).
 * Never writes cookie values — names, statuses, paths, and page kinds only.
 */
export async function writeLoginHopDump(opts: {
  hops: LoginHopDiagnostic[];
  finalJarNames: string[];
  finalJarCount: number;
  reason?: string;
  labsProbe?: LabsProbeDiagnostic;
  /** Primary explanation for an incomplete login (or omitted when ok). */
  why?: OtpFailureExplanation;
  /** Redacted OTP POST summary (same shape as otp-redisplay dump). */
  otpPost?: OtpPostDiagnostic;
  /** Other dump files written during this attempt (e.g. otp-redisplay-*.json). */
  relatedDumps?: string[];
}): Promise<string | undefined> {
  try {
    const dir = clalitConfigDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `login-hops-${stamp}.json`);
    const payload = {
      version: 2,
      kind: "login-hops",
      at: new Date().toISOString(),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.why ? { why: opts.why } : {}),
      hops: opts.hops.map((h) => ({
        url: h.url,
        status: h.status,
        ...(h.contentType ? { contentType: h.contentType } : {}),
        ...(h.locationPath ? { locationPath: h.locationPath } : {}),
        pageKind: h.pageKind ?? "unknown",
        setCookieNames: h.setCookieNames,
        jarCookieNames: h.jarCookieNames,
        jarCount: h.jarCount,
      })),
      pageKinds: opts.hops.map((h) => h.pageKind ?? "unknown"),
      finalJarNames: opts.finalJarNames,
      finalJarCount: opts.finalJarCount,
      ...(opts.labsProbe ? { labsProbe: opts.labsProbe } : {}),
      ...(opts.otpPost ? { otpPost: opts.otpPost } : {}),
      ...(opts.relatedDumps?.length ? { relatedDumps: opts.relatedDumps } : {}),
    };
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Redacted dump when OTP POST returns HTTP 200 still showing the OTP form.
 * Field names, control ids, statuses, cookie *names*, and digit-stripped
 * validation text only — never cookie/OTP/ID/viewstate values.
 */
export async function writeOtpRedisplayDump(opts: {
  fieldNames: string[];
  eventTarget: string;
  validationMessagePresent: boolean;
  status?: number;
  /** Rich redacted OTP POST summary (version 2 fields). */
  otpPost?: OtpPostDiagnostic;
}): Promise<string | undefined> {
  try {
    const dir = clalitConfigDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `otp-redisplay-${stamp}.json`);
    const payload = {
      version: 2,
      kind: "otp-redisplay",
      at: new Date().toISOString(),
      reason: "otp_form_redisplay",
      ...(opts.status !== undefined ? { httpStatus: opts.status } : {}),
      fieldNames: opts.fieldNames,
      eventTarget: opts.eventTarget,
      validationMessagePresent: opts.validationMessagePresent,
      ...(opts.otpPost ? { otpPost: opts.otpPost } : {}),
    };
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Page-kind / OTP helpers (pure; safe to unit test; never return values)
// ---------------------------------------------------------------------------

export type LoginPageKind =
  | "otp"
  | "login"
  | "personal_details"
  | "labs"
  | "object_moved"
  | "unknown";

function isRedirectStatusCode(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Path only — strips host, query (ReturnUrl etc.), and fragment. */
export function urlPathOnly(raw: string | null | undefined, base: string = PORTAL_ORIGIN): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed, base).pathname;
  } catch {
    return trimmed.split(/[?#]/)[0] || undefined;
  }
}

/** Content-type without parameters, lowercased. */
export function contentTypeOnly(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.split(";")[0]!.trim().toLowerCase();
  return t || undefined;
}

/** True when the SMS code <input> is on the page. */
export function otpEntryInputPresent(html: string): boolean {
  return /<input\b[^>]*\b(?:name|id)\s*=\s*["'][^"']*txtClientOTP[^"']*["']/i.test(html);
}

/** Best-effort: visible validation / error chrome on a redisplayed OTP page (no values). */
export function otpValidationMessagePresent(html: string): boolean {
  if (/validation.*?error|error.*?validation|Validator|ValidationSummary/i.test(html) &&
      /(?:color\s*:\s*red|class\s*=\s*["'][^"']*error|סיסמה|שגוי|לא תקין|קוד|otp)/i.test(html)) {
    return true;
  }
  if (/style\s*=\s*["'][^"']*color\s*:\s*red[^"']*["'][^>]*>[^<]*(?:קוד|OTP|סיסמה|שגוי|לא)/i.test(html)) {
    return true;
  }
  const re = /<(?:span|div|label)\b[^>]*\bid\s*=\s*["'][^"']*(?:cv|lbl)[^"']*(?:OTP|Code|Error)[^"']*["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (!/display\s*:\s*none/i.test(m[0]!)) return true;
  }
  return false;
}

/** <form action> values resolved to paths (relative to the page URL when given). */
export function formActionPaths(html: string, pageUrl?: string): string[] {
  const base = pageUrl && /^https?:/i.test(pageUrl) ? pageUrl : `${PORTAL_ORIGIN}/OnlineWeb/General/`;
  return [...html.matchAll(/<form\b[^>]*\baction\s*=\s*["']([^"']*)["']/gi)]
    .map((m) => urlPathOnly(m[1]!.replace(/&amp;/g, "&"), base))
    .filter((p): p is string => Boolean(p));
}

/**
 * Short page-kind enum for a portal response. Order matters: a redirect is
 * object_moved even when the body mentions Login; a page with the SMS-code
 * input is otp even if shared chrome mentions Login.aspx.
 */
export function classifyLoginPageKind(input: {
  url?: string;
  status?: number;
  html?: string;
  location?: string;
}): LoginPageKind {
  const html = input.html ?? "";
  const status = input.status ?? 0;
  const path = (urlPathOnly(input.url) ?? "").toLowerCase();
  const head = html.slice(0, 6000);
  if (/object\s+moved/i.test(head) || (isRedirectStatusCode(status) && Boolean(input.location))) {
    return "object_moved";
  }
  if (otpEntryInputPresent(html)) return "otp";
  const actions = formActionPaths(html, input.url).map((a) => a.toLowerCase());
  if (/gvTestListInDateRange|LabsHistory1/i.test(html) || actions.some((a) => a.includes("/labs/labstestlist"))) {
    return "labs";
  }
  if (path.includes("personaldetails.aspx") || actions.some((a) => a.endsWith("personaldetails.aspx"))) {
    return "personal_details";
  }
  if (
    isLoginRedirectTarget(path) ||
    actions.some((a) => isLoginRedirectTarget(a)) ||
    (html && looksLikeLoginPage(html))
  ) {
    return "login";
  }
  if (path.includes("/services/labs/") && status === 200 && html) return "labs";
  return "unknown";
}

export interface OtpFormPresence {
  /** SMS code <input> (txtClientOTP) is present. */
  txtClientOTP: boolean;
  /** Hidden ctl00$cphBody$hdnRegExp is present. */
  hdnRegExp: boolean;
  /** btnContinue LinkButton / postback target is present. */
  btnContinue: boolean;
  /** Login CAPTCHA / ID controls (tbCaptchaLogin, tbUserId, LBD_/BDC_) are present. */
  captchaLoginFields: boolean;
  /** Cross-page postback marker __PREVIOUSPAGE is present. */
  previousPageField: boolean;
}

export function summarizeOtpFormPresence(html: string): OtpFormPresence {
  return {
    txtClientOTP: otpEntryInputPresent(html),
    hdnRegExp: /<input\b[^>]*\b(?:name|id)\s*=\s*["'][^"']*hdnRegExp[^"']*["']/i.test(html),
    btnContinue: /btnContinue/i.test(html),
    captchaLoginFields:
      /<input\b[^>]*\bname\s*=\s*["'][^"']*(?:tbCaptchaLogin|tbUserId|LBD_|BDC_)[^"']*["']/i.test(html),
    previousPageField: /name\s*=\s*["']__PREVIOUSPAGE["']/i.test(html),
  };
}

export interface BodyLooksLike {
  objectMoved: boolean;
  otp: boolean;
  personalDetails: boolean;
  login: boolean;
  labs: boolean;
}

export function summarizeBodyLooksLike(html: string): BodyLooksLike {
  const head = html.slice(0, 6000);
  return {
    objectMoved: /object\s+moved/i.test(head),
    otp: otpEntryInputPresent(html),
    personalDetails: /PersonalDetails\.aspx/i.test(html),
    login: Boolean(html) && looksLikeLoginPage(html),
    labs: /gvTestListInDateRange|LabsHistory1/i.test(html),
  };
}

// ---------------------------------------------------------------------------
// Validation text (redacted)
// ---------------------------------------------------------------------------

export interface RedactedValidationSnippet {
  source: "validator" | "red_text" | "script_message";
  /** ASP.NET control id (structural, not personal) when available. */
  elementId?: string;
  /** Visible text with digits → "#", emails/tokens masked, truncated to 200 chars. */
  text: string;
  /** Length of the decoded text before redaction. */
  rawLength: number;
  /** Count of digits removed (raw text is NOT hashed: short digit strings are brute-forceable). */
  digitsRedacted: number;
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeFromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeFromCodePoint(Number.parseInt(d, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function safeFromCodePoint(n: number): string {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

/** Strip tags, decode entities, collapse whitespace, then redact digits / emails / long tokens. */
export function redactValidationText(raw: string): {
  text: string;
  rawLength: number;
  digitsRedacted: number;
} {
  const decoded = decodeBasicEntities(raw.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  let digitsRedacted = 0;
  let text = decoded
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, "[token]")
    .replace(/[0-9\u0660-\u0669\u06F0-\u06F9]+/g, (m) => {
      digitsRedacted += m.length;
      return "#";
    });
  if (text.length > 200) text = `${text.slice(0, 200)}…`;
  return { text, rawLength: decoded.length, digitsRedacted };
}

const VALIDATOR_ID =
  /validat|valsum|error|errmsg|(?:^|[_$])(?:cv|rfv|rev|cmpv|cusv)[A-Z_]|lblmsg|lblmessage|lblotp|otpmsg|otperr/i;

function isHiddenTag(tag: string): boolean {
  const style = /\bstyle\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style) || /\bhidden\b(?!\s*=\s*["']?false)/i.test(tag.replace(/type\s*=\s*["']hidden["']/i, ""));
}

/**
 * Visible Hebrew/English validation / error snippets on a portal page,
 * digit-stripped. Best-effort; never includes input values or attributes.
 */
export function extractRedactedValidationSnippets(html: string, max = 8): RedactedValidationSnippet[] {
  const out: RedactedValidationSnippet[] = [];
  const seen = new Set<string>();
  const push = (snippet: RedactedValidationSnippet): void => {
    if (out.length >= max) return;
    if (!/[A-Za-z\u0590-\u05FF]/.test(snippet.text)) return;
    const key = `${snippet.elementId ?? ""}|${snippet.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(snippet);
  };

  const re = /<(span|div|label|p|li|td|font)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[2] ?? "";
    const inner = m[3] ?? "";
    if (inner.length > 2000) continue;
    const tag = `<${m[1]}${attrs}>`;
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const cls = /\bclass\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
    const style = /\bstyle\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    const validatorish = VALIDATOR_ID.test(id ?? "") || VALIDATOR_ID.test(cls);
    const red = /color\s*:\s*(?:red|#f00\b|#ff0000|rgb\(\s*255\s*,\s*0\s*,\s*0\s*\))/i.test(style);
    if (!validatorish && !red) continue;
    if (isHiddenTag(tag)) continue;
    const r = redactValidationText(inner);
    if (!r.text) continue;
    push({ source: validatorish ? "validator" : "red_text", ...(id ? { elementId: id } : {}), ...r });
  }

  const scriptRe =
    /\b(?:alert|\w*(?:show|open)\w*(?:message|msg|alert|dialog|error)\w*)\s*\(\s*(['"])((?:(?!\1)[^\\\n]|\\.){1,400})\1/gi;
  while ((m = scriptRe.exec(html)) !== null) {
    const r = redactValidationText(m[2]!.replace(/\\(.)/g, "$1"));
    if (!r.text) continue;
    push({ source: "script_message", ...r });
  }
  return out;
}

// ---------------------------------------------------------------------------
// OTP POST summary + failure explanation
// ---------------------------------------------------------------------------

export interface OtpPostKeyCheck {
  keys: string[];
  /** __EVENTTARGET value posted (an ASP.NET control id, never user data). */
  eventTarget: string;
  eventTargetEmpty: boolean;
  /** Name of the posted OTP field (value never kept). */
  otpFieldKey?: string;
  /** True when the OTP field was posted as bare "txtClientOTP" (resolver fallback). */
  otpFieldShortNameFallback: boolean;
  /** Expected keys absent from the POST (e.g. "*hdnRegExp", "__EVENTTARGET(empty)"). */
  missingExpectedKeys: string[];
  /** Login-page keys that should not be in an OTP POST (LBD_*, tbUserId, tbCaptchaLogin, __PREVIOUSPAGE). */
  unexpectedLoginKeys: string[];
}

export function checkOtpPostKeys(postBody: string): OtpPostKeyCheck {
  const params = new URLSearchParams(postBody);
  const keys = [...params.keys()];
  const eventTarget = params.get("__EVENTTARGET") ?? "";
  const otpFieldKey = keys.find((k) => /(?:^|\$)txtClientOTP$/i.test(k));
  const missing: string[] = [];
  for (const k of ["__VIEWSTATE", "__EVENTVALIDATION"]) if (!params.has(k)) missing.push(k);
  if (!params.has("__EVENTTARGET")) missing.push("__EVENTTARGET");
  else if (!eventTarget.trim()) missing.push("__EVENTTARGET(empty)");
  if (!otpFieldKey) missing.push("*txtClientOTP");
  if (!keys.some((k) => /hdnRegExp$/i.test(k))) missing.push("*hdnRegExp");
  const unexpectedLoginKeys = keys.filter((k) =>
    /^(?:LBD_|BDC_)|tbUserId$|tbCaptchaLogin$|^__PREVIOUSPAGE$/i.test(k),
  );
  return {
    keys,
    eventTarget,
    eventTargetEmpty: !eventTarget.trim(),
    ...(otpFieldKey ? { otpFieldKey } : {}),
    otpFieldShortNameFallback: otpFieldKey === "txtClientOTP",
    missingExpectedKeys: missing,
    unexpectedLoginKeys,
  };
}

/** The page whose WebForms state was used to build the OTP POST. */
export interface OtpSourcePageDiagnostic {
  /** Path of the URL the OTP-page HTML was fetched from. */
  path?: string;
  pageKind: LoginPageKind;
  formActionPaths: string[];
  /** Path the client POSTed the OTP to. */
  postPath: string;
  /** False when the page's <form action> points somewhere other than postPath. */
  formActionMatchesPost: boolean;
  presence: OtpFormPresence;
  /** "extracted" from __doPostBack/WebForm_PostBackOptions, or "fallback" UniqueID. */
  eventTargetSource: "extracted" | "fallback";
  resolvedOtpField?: string;
}

export function summarizeOtpSourcePage(opts: {
  html: string;
  url?: string;
  postUrl: string;
  eventTargetSource: "extracted" | "fallback";
  resolvedOtpField?: string;
}): OtpSourcePageDiagnostic {
  const actions = formActionPaths(opts.html, opts.url);
  const postPath = urlPathOnly(opts.postUrl) ?? opts.postUrl;
  return {
    ...(urlPathOnly(opts.url) ? { path: urlPathOnly(opts.url) } : {}),
    pageKind: classifyLoginPageKind({ url: opts.url, status: 200, html: opts.html }),
    formActionPaths: actions,
    postPath,
    formActionMatchesPost:
      actions.length === 0 || actions.some((a) => a.toLowerCase() === postPath.toLowerCase()),
    presence: summarizeOtpFormPresence(opts.html),
    eventTargetSource: opts.eventTargetSource,
    ...(opts.resolvedOtpField ? { resolvedOtpField: opts.resolvedOtpField } : {}),
  };
}

export interface LoginTimingMs {
  /** CAPTCHA answer submitted → OTP page HTML ready. */
  captchaToOtpPageMs?: number;
  /** OTP page ready → human entered the code (long = possibly expired code). */
  otpPageToCodeMs?: number;
  /** OTP POST round trip. */
  otpPostMs?: number;
}

export interface OtpPostDiagnostic {
  status: number;
  requestPath: string;
  /** response.url path when the runtime reports one. */
  responseUrlPath?: string;
  locationPath?: string;
  /** Where this hop leads: Location path, else response/request path. */
  finalPath: string;
  contentType?: string;
  pageKind: LoginPageKind;
  setCookieNames: string[];
  jarCookieNamesBefore: string[];
  jarCookieNamesAfter: string[];
  jarCookieNamesAdded: string[];
  portalAuthCookieSet: boolean;
  bodyLooksLike: BodyLooksLike;
  responseForm: OtpFormPresence;
  validationMessagePresent: boolean;
  validationSnippets: RedactedValidationSnippet[];
  post: OtpPostKeyCheck;
  source?: OtpSourcePageDiagnostic;
  timingMs: LoginTimingMs;
}

/** Cookies that mean the OTP postback actually established a portal session. */
export function isPortalAuthCookieName(name: string): boolean {
  return /^(?:PostOtpAuth|AfterLogin|PortalAuth|ClalitPortal|ExtraPortal|\.ASPXAUTH)$/i.test(name);
}

export function summarizeOtpPostResponse(opts: {
  status: number;
  requestUrl: string;
  responseUrl?: string;
  location?: string;
  contentType?: string;
  html: string;
  setCookieNames: string[];
  jarBefore: string[];
  jarAfter: string[];
  postBody: string;
  source?: OtpSourcePageDiagnostic;
  timingMs?: LoginTimingMs;
}): OtpPostDiagnostic {
  const requestPath = urlPathOnly(opts.requestUrl) ?? opts.requestUrl;
  const responseUrlPath = urlPathOnly(opts.responseUrl);
  const locationPath = urlPathOnly(opts.location, opts.requestUrl);
  const before = new Set(opts.jarBefore);
  const contentType = contentTypeOnly(opts.contentType);
  return {
    status: opts.status,
    requestPath,
    ...(responseUrlPath ? { responseUrlPath } : {}),
    ...(locationPath ? { locationPath } : {}),
    finalPath: locationPath ?? responseUrlPath ?? requestPath,
    ...(contentType ? { contentType } : {}),
    pageKind: classifyLoginPageKind({
      url: opts.requestUrl,
      status: opts.status,
      html: opts.html,
      ...(opts.location ? { location: opts.location } : {}),
    }),
    setCookieNames: opts.setCookieNames,
    jarCookieNamesBefore: opts.jarBefore,
    jarCookieNamesAfter: opts.jarAfter,
    jarCookieNamesAdded: [...new Set(opts.jarAfter.filter((n) => !before.has(n)))],
    portalAuthCookieSet: opts.setCookieNames.some(isPortalAuthCookieName),
    bodyLooksLike: summarizeBodyLooksLike(opts.html),
    responseForm: summarizeOtpFormPresence(opts.html),
    validationMessagePresent: otpValidationMessagePresent(opts.html),
    validationSnippets: extractRedactedValidationSnippets(opts.html),
    post: checkOtpPostKeys(opts.postBody),
    ...(opts.source ? { source: opts.source } : {}),
    timingMs: opts.timingMs ?? {},
  };
}

export type OtpFailureWhy =
  | "otp_source_not_otp_form"
  | "otp_post_form_action_mismatch"
  | "otp_event_target_empty"
  | "otp_redisplayed_with_error"
  | "otp_redisplayed_silent"
  | "missing_portal_defense_cookies"
  | "missing_post_otp_auth"
  | "labs_login_redirect";

export interface OtpFailureExplanation {
  why: OtpFailureWhy;
  en: string;
  he: string;
  /** Secondary hints (e.g. otp_entry_slow, unexpected_login_keys_in_otp_post). */
  signals: string[];
}

/** OTP lifetime is not documented; flag entries slower than this as possibly expired. */
export const OTP_SLOW_ENTRY_MS = 3 * 60 * 1000;

/**
 * Pick the single most likely reason an OTP login did not produce a usable
 * session. Ordered from "client sent the wrong thing" to "portal refused".
 */
export function explainOtpFailure(input: {
  otpPost?: OtpPostDiagnostic;
  hasDefenseCookies: boolean;
  portalAuthCookieSeen: boolean;
  labsLoginRedirect: boolean;
}): OtpFailureExplanation {
  const p = input.otpPost;
  const signals: string[] = [];
  if (p) {
    if (p.timingMs.otpPageToCodeMs !== undefined && p.timingMs.otpPageToCodeMs > OTP_SLOW_ENTRY_MS) {
      signals.push("otp_entry_slow");
    }
    if (p.post.unexpectedLoginKeys.length) signals.push("unexpected_login_keys_in_otp_post");
    if (p.post.otpFieldShortNameFallback) signals.push("otp_field_short_name_fallback");
    if (p.post.missingExpectedKeys.includes("*hdnRegExp")) signals.push("hdnRegExp_missing");
    if (p.validationSnippets.length) signals.push("validation_text_present");
    if (p.setCookieNames.length === 0) signals.push("no_set_cookie_on_otp_post");
    if (p.source && !p.source.presence.txtClientOTP) signals.push("source_page_without_otp_input");
    if (p.source?.presence.captchaLoginFields) signals.push("source_page_has_captcha_login_fields");
  }
  const mk = (why: OtpFailureWhy, en: string, he: string): OtpFailureExplanation => ({
    why,
    en,
    he,
    signals,
  });

  if (p && p.pageKind === "otp") {
    if (p.source && !p.source.presence.txtClientOTP) {
      return mk(
        "otp_source_not_otp_form",
        `Portal redisplayed the OTP form. The page used to build the OTP POST (${p.source.path ?? "?"}, kind ${p.source.pageKind}) had no SMS-code input — the client posted from the wrong page state; the code itself may be fine.`,
        "הפורטל הציג שוב את טופס הקוד. הדף שממנו נבנתה שליחת הקוד לא הכיל שדה קוד SMS — השליחה נבנתה ממצב דף שגוי; ייתכן שהקוד עצמו תקין.",
      );
    }
    if (p.source && !p.source.formActionMatchesPost) {
      return mk(
        "otp_post_form_action_mismatch",
        `Portal redisplayed the OTP form. The OTP form's action is ${p.source.formActionPaths.join(", ")} but the client POSTed to ${p.source.postPath} (page state mismatch), not necessarily a wrong code.`,
        "הפורטל הציג שוב את טופס הקוד. כתובת הטופס בדף שונה מהכתובת שאליה נשלח הקוד (אי-התאמה במצב הדף) — לא בהכרח קוד שגוי.",
      );
    }
    if (p.post.eventTargetEmpty) {
      return mk(
        "otp_event_target_empty",
        "Portal redisplayed the OTP form because the POST had an empty __EVENTTARGET (Continue was never 'clicked').",
        "הפורטל הציג שוב את טופס הקוד כי השליחה נשלחה ללא __EVENTTARGET (כפתור ההמשך לא 'נלחץ').",
      );
    }
    if (p.validationMessagePresent || p.validationSnippets.length) {
      return mk(
        "otp_redisplayed_with_error",
        "Portal redisplayed the OTP form with a validation message — likely a wrong or expired SMS code. Request a new code and retry.",
        "הפורטל הציג שוב את טופס הקוד עם הודעת שגיאה — כנראה קוד SMS שגוי או שפג תוקפו. בקש/י קוד חדש ונסה/י שוב.",
      );
    }
    return mk(
      "otp_redisplayed_silent",
      "Portal redisplayed the OTP form without a visible error — the postback was not accepted (hidden fields / event target / page state).",
      "הפורטל הציג שוב את טופס הקוד ללא הודעת שגיאה — השליחה לא התקבלה (שדות נסתרים / event target / מצב דף).",
    );
  }
  if (!input.hasDefenseCookies) {
    return mk(
      "missing_portal_defense_cookies",
      "After OTP the cookie jar has no Imperva/TS defense cookies, so the portal will not keep the session.",
      "אחרי הקוד חסרות עוגיות ההגנה של Imperva/TS ולכן הפורטל לא ישמור את החיבור.",
    );
  }
  if (!input.portalAuthCookieSeen) {
    return mk(
      "missing_post_otp_auth",
      "OTP POST left the form but no PostOtpAuth/AfterLogin cookie was set after the redirect — the portal still treats the session as anonymous.",
      "שליחת הקוד עברה הלאה אך לא התקבלה עוגיית PostOtpAuth/AfterLogin אחרי ההפניה — הפורטל עדיין רואה את החיבור כאנונימי.",
    );
  }
  return mk(
    "labs_login_redirect",
    "Portal auth cookies were set but the labs page still sends you to sign-in.",
    "עוגיות ההזדהות התקבלו אך דף המעבדה עדיין מפנה להתחברות.",
  );
}

// ---------------------------------------------------------------------------
// Progress events (stderr one-liners in the CLI; never secrets)
// ---------------------------------------------------------------------------

export type LoginProgressStage =
  | "login_page"
  | "captcha_submit"
  | "captcha_ok"
  | "otp_page"
  | "otp_post"
  | "otp_redisplay"
  | "hop"
  | "labs_probe"
  | "dump"
  | "result";

export interface LoginProgressEvent {
  stage: LoginProgressStage;
  /** Built only from statuses, paths, page kinds, cookie names, and timings. */
  message: string;
}

export type LoginProgressListener = (event: LoginProgressEvent) => void;

export function formatLoginProgress(event: LoginProgressEvent): string {
  return `[clalit login] ${event.stage}: ${event.message}`;
}
