/**
 * A session handed over from the member's own browser.
 *
 * The member signs in there, by whichever road Clalit Online offers them — the permanent password,
 * or the SMS code — solving the CAPTCHA by hand like any visit. The cookies that sign-in left in the
 * browser become this client's session, once a request for the labs list shows they are a signed-in
 * session and not a login redirect. Nothing is replayed, solved or bypassed: the browser did the
 * sign-in; this only carries its result over, the way the Playwright cookie warm already carries the
 * Imperva cookies over before the loopback login.
 *
 * Also here: the shape reducers behind `login --browser --record`. They turn what the browser sent
 * and received during the sign-in into field names, value classes and lengths, paths, query keys and
 * cookie names — never a value — so the record can be shared and read to build a sign-in that needs
 * no browser, without a value of the member's in it.
 */
import { PATHS, PORTAL_ORIGIN } from "./constants.js";
import { AuthenticationError } from "./errors.js";
import type { ClalitSession } from "./session.js";
import {
  ClalitTransport,
  isPortalDefenseCookieName,
  readText,
  type BrowserCookieSeed,
  type FetchFunction,
} from "./transport.js";
import { isLoginRedirectTarget, looksLikeBotChallenge, looksLikeLoginPage } from "./webforms.js";

export interface AdoptOptions {
  fetch?: FetchFunction;
  /** The browser's own user agent, kept with the session so later requests look like the same client. */
  userAgent?: string;
  now?: () => number;
  minGapMs?: number;
}

export interface AdoptResult {
  session: ClalitSession;
  /** Cookie names the session holds (never values). */
  cookieNames: string[];
}

/**
 * Takes the browser's cookies for the portal, checks them with one request for the labs list, and
 * returns the session to save. Throws BROWSER_SESSION_INCOMPLETE (nothing is saved) when the labs
 * list redirects to login, when the page is a bot challenge, or when no Imperva cookie came along.
 */
export async function adoptBrowserSession(
  cookies: BrowserCookieSeed[],
  options: AdoptOptions = {},
): Promise<AdoptResult> {
  const transport = new ClalitTransport({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.minGapMs !== undefined ? { minGapMs: options.minGapMs } : {}),
  });
  const portalCookies = cookies.filter((c) => /clalit\.co\.il$/i.test(c.domain.replace(/^\./, "")));
  const imported = await transport.importBrowserCookies(portalCookies);
  if (imported === 0) {
    throw new AuthenticationError("BROWSER_SESSION_INCOMPLETE", undefined, "The browser holds no cookies for the Clalit portal; sign in there first.");
  }
  const names = await transport.listCookieNames();
  if (!names.some(isPortalDefenseCookieName)) {
    throw new AuthenticationError("BROWSER_SESSION_INCOMPLETE", undefined, "The browser's cookies for the portal carry no Imperva cookie; the session was not saved.");
  }

  const probe = await transport.request(PORTAL_ORIGIN + PATHS.labsList, { allowLoginHtml: true });
  const location = probe.headers.get("location") ?? "";
  let html = "";
  try {
    html = await readText(probe);
  } catch {
    html = "";
  }
  if (looksLikeBotChallenge(html, probe.status)) {
    throw new AuthenticationError("BOT_CHALLENGE", probe.status);
  }
  // Fail closed: only a 200 that is not a login page counts. A redirect (to login or anywhere else)
  // or an error means the browser's cookies do not make a signed-in session for this client.
  if (probe.status !== 200 || looksLikeLoginPage(html)) {
    const where = isRedirect(probe.status) ? ` (${probe.status} → ${isLoginRedirectTarget(location) ? "login" : safePath(location)})` : ` (${probe.status})`;
    throw new AuthenticationError(
      "BROWSER_SESSION_INCOMPLETE",
      probe.status,
      `The labs list does not open with the browser's cookies${where}, so the session was not saved. Finish the sign-in in the browser (your personal page should be showing) and try again.`,
    );
  }
  transport.markAuthenticated();
  return { session: await transport.exportSession(), cookieNames: names };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** What the CLI reads from the browser's page to tell a finished sign-in from one still in progress. */
export interface PageState {
  host: string;
  path: string;
  /** `name` or `id` and `type` of every <input> on the page. */
  inputs: { name: string; type: string }[];
}

/**
 * Inputs that belong to a sign-in step: the ID, user-name, password and CAPTCHA boxes, the SMS code, the
 * BotDetect instance id. Matched on the control's own name, not the whole unique id: a signed-in page
 * carries a "ResetPasswordPopupReminder" button, which is not a password box.
 */
const SIGN_IN_INPUT = /(^|\$)(tbUserId|tbUserName|tbPassword|tbCaptchaLogin|txtClientOTP)$|^(LBD|BDC)_VCID_/i;

/**
 * True when the page is a portal page past the sign-in: on the portal's own host, not a login gate or the
 * OTP page, and without a password, CAPTCHA, ID or SMS-code box on it.
 */
export function pageLooksSignedIn(state: PageState): boolean {
  if (state.host.toLowerCase() !== new URL(PORTAL_ORIGIN).host) return false;
  if (isLoginRedirectTarget(state.path)) return false;
  if (/OTPSMSVerification\.aspx/i.test(state.path)) return false;
  if (!/^\/OnlineWeb\//i.test(state.path)) return false;
  return !state.inputs.some((i) => i.type === "password" || SIGN_IN_INPUT.test(i.name));
}

// ---------------------------------------------------------------------------------------------
// Shapes: what a value is like, never what it is.

/** "digits(9)", "letters(6)", "alnum(8)", "text(14)", "base64(2316)", "empty", "bool", "number". */
export function valueShape(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "number";
  if (typeof value !== "string") return typeof value;
  if (value === "") return "empty";
  const n = value.length;
  if (/^\d+$/.test(value)) return `digits(${n})`;
  if (/^[A-Za-z]+$/.test(value)) return `letters(${n})`;
  if (/^[A-Za-z0-9]+$/.test(value)) return `alnum(${n})`;
  if (n >= 40 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return `base64(${n})`;
  if (/^[\d.\/-]+$/.test(value)) return `date-like(${n})`;
  if (/^https?:\/\//i.test(value)) return `url(${safePath(value)})`;
  if (/^\/[\w\/.-]*/.test(value) && !/\s/.test(value)) return `path(${stripQuery(value)})`;
  return `text(${n})`;
}

/** A URL reduced to its path and the names of its query keys, each with its value's shape. */
export function safePath(url: string): string {
  try {
    const u = new URL(url, PORTAL_ORIGIN);
    return u.pathname + shapeQuery(u.search);
  } catch {
    return stripQuery(url);
  }
}

function stripQuery(value: string): string {
  const i = value.indexOf("?");
  return i >= 0 ? value.slice(0, i) + "?…" : value;
}

/** "?a=digits(3)&b=base64(44)" for "?a=123&b=…". */
export function shapeQuery(search: string): string {
  if (!search || search === "?") return "";
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const parts: string[] = [];
  for (const [k, v] of params) parts.push(`${k}=${valueShape(v)}`);
  return parts.length ? "?" + parts.join("&") : "";
}

/** A request body reduced to field names and value shapes; JSON to keys and types. */
export function shapeBody(body: string | undefined, contentType = ""): Record<string, unknown> | string | undefined {
  if (body === undefined || body === "") return undefined;
  if (/json/i.test(contentType)) {
    try {
      return shapeJson(JSON.parse(body)) as Record<string, unknown>;
    } catch {
      return `unparsable json(${body.length})`;
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType) || /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body.slice(0, 2000))) {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(body)) out[k] = valueShape(v);
    return out;
  }
  return `bytes(${body.length})`;
}

/** A JSON value reduced to keys and value shapes. */
export function shapeJson(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    return value.length ? [shapeJson(value[0], depth + 1), ...(value.length > 1 ? [`…${value.length}`] : [])] : [];
  }
  if (value && typeof value === "object") {
    if (depth > 4) return "{…}";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = shapeJson(v, depth + 1);
    return out;
  }
  return valueShape(value);
}

export interface HtmlSummary {
  forms: { action: string; method: string }[];
  /** Every input: name (or id), type, and the shape of its value. */
  inputs: { name: string; type: string; value: string }[];
  /** __doPostBack targets the page can post, from its scripts and controls (names only). */
  postBackTargets: string[];
  /** Names the page's scripts set with setCookie()/document.cookie (never values). */
  cookiesSetByScript: string[];
  /** Where the page sends the browser next: redirectInfoToOnline, location=, meta refresh, Object moved. */
  redirects: string[];
  /** Links into the portal's sign-in area (/OnlineWeb/General/, /onlineweb/general/), paths only. */
  signInLinks: string[];
  /** Which sign-in boxes the page shows. */
  has: { userId: boolean; password: boolean; captcha: boolean; otp: boolean };
}

const ATTR = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
};

/** The structure of a portal page, with no text and no value from it. */
export function summarizeHtml(html: string): HtmlSummary {
  const forms: HtmlSummary["forms"] = [];
  for (const m of html.matchAll(/<form\b[^>]*>/gi)) {
    forms.push({ action: safePath(ATTR(m[0], "action") ?? ""), method: (ATTR(m[0], "method") ?? "get").toLowerCase() });
  }
  const inputs: HtmlSummary["inputs"] = [];
  for (const m of html.matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)) {
    const tag = m[0];
    const name = ATTR(tag, "name") ?? ATTR(tag, "id");
    if (!name) continue;
    const type = tag.toLowerCase().startsWith("<select") ? "select" : tag.toLowerCase().startsWith("<textarea") ? "textarea" : (ATTR(tag, "type") ?? "text").toLowerCase();
    const value = ATTR(tag, "value");
    inputs.push({ name: decodeEntities(name), type, value: valueShape(value === undefined ? undefined : decodeEntities(value)) });
  }
  const decoded = decodeEntities(html);
  const postBackTargets = unique([...decoded.matchAll(/__doPostBack\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!));
  const cookiesSetByScript = unique([
    ...[...decoded.matchAll(/setCookie\s*\(\s*['"]([^'"]+)['"]/gi)].map((m) => m[1]!),
    ...[...decoded.matchAll(/document\.cookie\s*=\s*['"]([^='"]+)=/gi)].map((m) => m[1]!),
  ]);
  const redirects = unique([
    ...[...decoded.matchAll(/redirectInfoToOnline\s*\(\s*['"]([^'"]+)['"]/gi)].map((m) => safePath(m[1]!)),
    ...[...decoded.matchAll(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/gi)].map((m) => safePath(m[1]!)),
    ...[...decoded.matchAll(/http-equiv\s*=\s*['"]?refresh['"]?[^>]*content\s*=\s*['"]?\d+\s*;\s*url=([^"'\s>]+)/gi)].map((m) => safePath(m[1]!)),
    ...(/object\s+moved/i.test(decoded) ? [...decoded.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].slice(0, 1).map((m) => safePath(m[1]!)) : []),
  ]);
  const signInLinks = unique(
    [...decoded.matchAll(/href\s*=\s*["']([^"']*\/onlineweb\/general\/[^"']*)["']/gi)].map((m) => safePath(m[1]!)),
  );
  const names = inputs.map((i) => i.name).join("\n");
  return {
    forms,
    inputs,
    postBackTargets,
    cookiesSetByScript,
    redirects,
    signInLinks,
    has: {
      userId: /tbUserId|txtUser|tbUser/i.test(names),
      password: inputs.some((i) => i.type === "password") || /password|pwd/i.test(names),
      captcha: /captcha|LBD_|BDC_/i.test(names),
      otp: /txtClientOTP/i.test(names),
    },
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

/** One request the browser made during the sign-in, as the record keeps it. */
export interface RecordedRequest {
  n: number;
  method: string;
  /** Path and query keys with value shapes. */
  url: string;
  resourceType: string;
  /** Request headers worth knowing about (content-type, referer path, origin, x-requested-with). */
  headers: Record<string, string>;
  body?: Record<string, unknown> | string;
  status?: number;
  mime?: string;
  /** Location header reduced to a safe path. */
  location?: string;
  /** Names set by the response's Set-Cookie headers. */
  setCookie?: string[];
  /** For an HTML document: its structure. For JSON: keys and shapes. */
  page?: HtmlSummary;
  json?: unknown;
}

export interface LoginRecord {
  recordedAt: string;
  /** The page the member was on when the session was taken. */
  landedOn: string;
  requests: RecordedRequest[];
  /** The browser's cookies for the portal at the end: name, domain, flags. Never values. */
  cookies: { name: string; domain: string; path: string; httpOnly: boolean; secure: boolean; session: boolean }[];
}

const RECORD_HEADERS = ["content-type", "referer", "origin", "x-requested-with", "accept"];

/** Request headers reduced to the few that shape a replay; the referer to its path. */
export function shapeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (!RECORD_HEADERS.includes(key)) continue;
    out[key] = key === "referer" ? safePath(v) : key === "accept" ? v.slice(0, 40) : v;
  }
  return out;
}

/** Whether a request belongs in the record: a portal document, XHR/fetch, a form post, or the CAPTCHA image. */
export function worthRecording(url: string, resourceType: string, method: string): boolean {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  if (!/(^|\.)clalit\.co\.il$/i.test(host)) return false;
  if (/^gb\./i.test(host) || /\/glassbox\//i.test(url)) return false; // session-replay analytics, not the sign-in
  if (method !== "GET") return true;
  if (["Document", "XHR", "Fetch"].includes(resourceType)) return true;
  return resourceType === "Image" && /captcha/i.test(url);
}
