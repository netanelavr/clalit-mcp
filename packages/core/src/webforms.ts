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

/** True when Location / href targets a Clalit login gate. */
export function isLoginRedirectTarget(locationOrHref: string): boolean {
  const raw = locationOrHref.trim();
  if (!raw) return false;
  let pathAndQuery = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      pathAndQuery = `${u.pathname}${u.search}`;
    }
  } catch {
    /* use raw */
  }
  return /(?:^|\/)(?:Login|InfoFullLogin|infootplogin|InfoOtpLogin)\.aspx\b/i.test(pathAndQuery);
}

/** Detect login / session-expired redirects in HTML. */
export function looksLikeLoginPage(html: string): boolean {
  const slice = html.slice(0, 12000);
  const lower = slice.toLowerCase();
  if (
    lower.includes("infootplogin.aspx") ||
    lower.includes("otpsmsverification.aspx") ||
    (lower.includes("tbuserid") && lower.includes("captcha"))
  ) {
    return true;
  }
  // ASP.NET "Object moved" interstitial → Login.aspx?ReturnUrl=...
  if (/object\s+moved/i.test(slice)) {
    const href = slice.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href && isLoginRedirectTarget(href)) return true;
    if (isLoginRedirectTarget(slice)) return true;
  }
  // Explicit login ReturnUrl (avoid matching bare footer Login.aspx links)
  if (/login\.aspx\?[^"'>\s]*returnurl=/i.test(slice)) return true;
  if (/infofulllogin\.aspx/i.test(slice)) return true;
  return false;
}

/**
 * Real LabsTestList chrome for an empty history page.
 * Never treat ASP.NET "Object moved" + ReturnUrl=...LabsTestList as chrome.
 */
export function looksLikeLabsListChrome(html: string): boolean {
  if (/object\s+moved/i.test(html)) return false;
  if (looksLikeLoginPage(html)) return false;
  if (/__VIEWSTATE/i.test(html) && /LabsHistory|gvTestListInDateRange|בדיקות מעבדה/i.test(html)) {
    return true;
  }
  // LabsTestList in path text alone is not enough (ReturnUrl false positive).
  return /LabsTestList/i.test(html) && /__VIEWSTATE/i.test(html) && !/ReturnUrl=/i.test(html);
}

/**
 * Real PatientPrescriptionsex chrome for an empty prescriptions page.
 * Never treat ASP.NET "Object moved" + ReturnUrl=...PatientPrescriptions as chrome.
 */
export function looksLikePrescriptionsListChrome(html: string): boolean {
  if (/object\s+moved/i.test(html)) return false;
  if (looksLikeLoginPage(html)) return false;
  if (
    /__VIEWSTATE/i.test(html) &&
    /PatientPrescriptions|rptPatientPrescriptions|מרשמים|dateRange\$txtFromDate|hdnSectionID/i.test(
      html,
    )
  ) {
    return true;
  }
  return (
    /PatientPrescriptionsex\.aspx/i.test(html) &&
    /__VIEWSTATE/i.test(html) &&
    !/ReturnUrl=/i.test(html)
  );
}

/**
 * Real LabOrderList chrome for an empty lab-orders page.
 * Prefer row/lnkOrderDetails presence over NoLabOrdersFound alone when parsing.
 */
export function looksLikeLabOrdersListChrome(html: string): boolean {
  if (/object\s+moved/i.test(html)) return false;
  if (looksLikeLoginPage(html)) return false;
  if (
    /__VIEWSTATE/i.test(html) &&
    /LabOrderList|gvLabOrdersList|NoLabOrdersFound|הפניות לבדיקות מעבדה|divLabOrders/i.test(html)
  ) {
    return true;
  }
  return /LabOrderList\.aspx/i.test(html) && /__VIEWSTATE/i.test(html) && !/ReturnUrl=/i.test(html);
}
