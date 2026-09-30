import * as cheerio from "cheerio";
import { ParseError } from "./errors.js";

export interface WebFormsState {
  viewState: string;
  viewStateGenerator?: string;
  eventValidation?: string;
  /** Extra hidden inputs to round-trip on POST (excluding the three above). */
  hidden: Record<string, string>;
}

const HIDDEN_SKIP = new Set([
  "__VIEWSTATE",
  "__VIEWSTATEGENERATOR",
  "__EVENTVALIDATION",
  "__EVENTTARGET",
  "__EVENTARGUMENT",
]);

/** Extract ASP.NET WebForms hidden fields from an HTML page. */
export function extractWebFormsState(html: string): WebFormsState {
  const $ = cheerio.load(html);
  const viewState = $('input[name="__VIEWSTATE"]').attr("value");
  if (!viewState) throw new ParseError("MISSING_VIEWSTATE", "No __VIEWSTATE on page.");

  const viewStateGenerator = $('input[name="__VIEWSTATEGENERATOR"]').attr("value");
  const eventValidation = $('input[name="__EVENTVALIDATION"]').attr("value");
  const hidden: Record<string, string> = {};

  $('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr("name");
    const value = $(el).attr("value") ?? "";
    if (!name || HIDDEN_SKIP.has(name)) return;
    hidden[name] = value;
  });

  return {
    viewState,
    ...(viewStateGenerator !== undefined ? { viewStateGenerator } : {}),
    ...(eventValidation !== undefined ? { eventValidation } : {}),
    hidden,
  };
}

/** Build application/x-www-form-urlencoded body for a WebForms postback. */
export function buildPostBackBody(
  state: WebFormsState,
  fields: Record<string, string> = {},
  eventTarget = "",
  eventArgument = "",
): string {
  const params = new URLSearchParams();
  params.set("__VIEWSTATE", state.viewState);
  if (state.viewStateGenerator !== undefined) {
    params.set("__VIEWSTATEGENERATOR", state.viewStateGenerator);
  }
  if (state.eventValidation !== undefined) {
    params.set("__EVENTVALIDATION", state.eventValidation);
  }
  params.set("__EVENTTARGET", eventTarget);
  params.set("__EVENTARGUMENT", eventArgument);
  for (const [k, v] of Object.entries(state.hidden)) {
    if (!(k in fields)) params.set(k, v);
  }
  for (const [k, v] of Object.entries(fields)) {
    params.set(k, v);
  }
  return params.toString();
}

/** Detect Imperva / bot-challenge pages without parsing challenge internals. */
export function looksLikeBotChallenge(html: string, status?: number): boolean {
  const lower = html.slice(0, 8000).toLowerCase();
  // Normal login HTML may load /_Incapsula_Resource scripts — that is not Error 16.
  const looksLikeLoginForm = lower.includes("tbuserid") && lower.includes("captcha");
  if (lower.includes("error 16") || lower.includes("pardon our interruption")) return true;
  if (status === 403) return !looksLikeLoginForm;
  if (looksLikeLoginForm) return false;
  return (
    lower.includes("imperva") ||
    lower.includes("incapsula") ||
    lower.includes("_incapsula_resource")
  );
}

/** Detect login / session-expired redirects in HTML. */
export function looksLikeLoginPage(html: string): boolean {
  const lower = html.slice(0, 12000).toLowerCase();
  return (
    lower.includes("infootplogin.aspx") ||
    lower.includes("otpsmsverification.aspx") ||
    (lower.includes("tbuserid") && lower.includes("captcha"))
  );
}
