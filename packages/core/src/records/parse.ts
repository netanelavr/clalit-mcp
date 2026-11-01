import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { PORTAL_ORIGIN } from "../constants.js";
import { ParseError, ReauthenticationRequired, UpstreamError } from "../errors.js";
import { looksLikeLoginPage } from "../webforms.js";
export { selectOptions } from "../documents/list.js";
import { recordSource, type RecordSource } from "./sources.js";
import type { RecordRef, RecordRow } from "./types.js";

const DATE_RE = /\b(\d{2})[./](\d{2})[./](\d{4})\b/;
/** Action URLs are portal-issued API paths; anything else is not ours to call. */
const ACTION_URL_RE = /^\/OnlineWeb\/api\/[\w/]+(\?[\w=&%.-]*)?$/i;

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function portalPath(raw: string, base: string = PORTAL_ORIGIN): string {
  try {
    const url = new URL(raw, base);
    return url.origin === PORTAL_ORIGIN ? url.pathname + url.search : "";
  } catch {
    return "";
  }
}

function isActionData(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((v) => typeof v === "string")
    );
  } catch {
    return false;
  }
}

export function encodeRecordRef(ref: RecordRef): string {
  return Buffer.from(JSON.stringify(ref), "utf8").toString("base64url");
}

export function decodeRecordRef(token: string): RecordRef {
  try {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<RecordRef>;
    if (typeof raw.source !== "string" || !recordSource(raw.source)) throw new Error("source");
    if (typeof raw.actionUrl !== "string" || !ACTION_URL_RE.test(raw.actionUrl)) throw new Error("url");
    if (raw.actionData !== undefined && !isActionData(raw.actionData)) throw new Error("data");
    return {
      source: raw.source,
      actionUrl: raw.actionUrl,
      ...(raw.actionData !== undefined ? { actionData: raw.actionData } : {}),
    };
  } catch {
    throw new ParseError("INVALID_REF", "Record ref token is invalid.");
  }
}

/** "תקלה זמנית. נסה שוב מאוחר יותר" shown where the results would be (not merely present in the page's hidden messages). */
function looksLikePortalFault($: cheerio.CheerioAPI): boolean {
  let shown = false;
  $("span, div, p").each((_, el) => {
    if (shown) return;
    const text = $(el).text();
    if (!/תקלה זמנית/.test(text) || text.length > 400) return;
    const style = ($(el).attr("style") ?? "") + ($(el).parents("[style]").map((_, p) => $(p).attr("style")).get().join(";"));
    const hidden = /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style) || $(el).closest(".NoDisplay").length > 0;
    if (!hidden) shown = true;
  });
  return shown;
}

/** The portal's own date form, whichever separator the grid used. */
function portalDate(text: string): string | undefined {
  const m = DATE_RE.exec(text);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : undefined;
}

/** The row's PDF action, when it has one, as a validated ref. */
function rowRef($: cheerio.CheerioAPI, tr: AnyNode, source: RecordSource): RecordRef | undefined {
  if (!source.pdfPath) return undefined;
  const a = $(tr).find("a[data-actionurl]").first();
  if (a.length === 0) return undefined;
  const actionUrl = portalPath(a.attr("data-actionurl")?.trim() ?? "");
  const actionData = a.attr("data-actiondata")?.trim() || undefined;
  if (!ACTION_URL_RE.test(actionUrl) || (actionData && !isActionData(actionData))) return undefined;
  return { source: source.id, actionUrl, ...(actionData ? { actionData } : {}) };
}

/** Same-origin `.aspx` links in the row, as portal paths with their query (a detail page, say). */
function rowLinks($: cheerio.CheerioAPI, tr: AnyNode, pagePath: string): string[] {
  const links = new Set<string>();
  $(tr)
    .find("a[href]")
    .each((_, a) => {
      const href = $(a).attr("href") ?? "";
      if (/^\s*javascript:/i.test(href)) return;
      // Relative hrefs ("HospitalsLabTestDetails.aspx?s=…") resolve against the page, not the origin.
      const path = portalPath(href, PORTAL_ORIGIN + pagePath);
      if (/\.aspx/i.test(path)) links.add(path);
    });
  return [...links];
}

/** The page's record grid: by id part when the source names one, else the first Clalit grid with headers. */
function findGrid($: cheerio.CheerioAPI, source: RecordSource): cheerio.Cheerio<AnyNode> {
  if (source.gridId) {
    const byId = $(`table[id*="${source.gridId}"]`).first();
    if (byId.length > 0) return byId;
  }
  return $("table")
    .filter((_, t) => $(t).find("th").length > 0 && $(t).find("tr.ClalitGridRow, tr.ClalitGridAltRow").length > 0)
    .first();
}

/**
 * Parse one record grid into rows: headers from `th`, one row per
 * `ClalitGridRow` / `ClalitGridAltRow` (the hidden description rows the grid
 * expands on click are skipped), cells as shown, plus any PDF action and page
 * links the row carries.
 */
export function parseRecordGridHtml(html: string, sourceId: string): RecordRow[] {
  const source = recordSource(sourceId);
  if (!source) throw new ParseError("UNKNOWN_SOURCE", "Unknown record source.");
  const $ = cheerio.load(html);
  const grid = findGrid($, source);
  if (grid.length === 0) {
    if (looksLikeLoginPage(html)) throw new ReauthenticationRequired();
    // The portal's own "temporary fault, try again later" in place of the grid is not an empty list.
    if (looksLikePortalFault($)) throw new UpstreamError("PORTAL_TEMPORARY_FAULT", 200);
    // A page without the grid shows "no results" chrome instead; an empty list is the right reading.
    return [];
  }
  const headers = grid
    .find("th")
    .map((_, th) => cleanText($(th).text()))
    .get();
  const rows: RecordRow[] = [];
  grid.find("tr").each((_, tr) => {
    const cls = $(tr).attr("class") ?? "";
    if (!/ClalitGrid(Alt)?Row/.test(cls) || /DescBlockRow/.test(cls)) return;
    const cells = $(tr)
      .children("td")
      .map((_, td) => cleanText($(td).text()))
      .get();
    if (cells.length === 0) return;
    const fields: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h && cells[i] !== undefined && !/^פעולות$/.test(h)) fields[h] = cells[i]!;
    });
    const dateCell = cells.find((c) => DATE_RE.test(c));
    const ref = rowRef($, tr, source);
    const links = rowLinks($, tr, source.path);
    rows.push({
      source: source.id,
      ...(dateCell ? { date: portalDate(dateCell) } : {}),
      fields,
      cells,
      ...(links.length ? { links } : {}),
      ...(ref ? { ref, refToken: encodeRecordRef(ref) } : {}),
    });
  });
  return rows;
}

/** The pager's link for page `current + 1`, when the page shows one. */
export function nextRecordPagerPage(html: string, source: RecordSource, current: number): number | undefined {
  if (!source.pagerLinkPrefix) return undefined;
  const next = current + 1;
  const target = `${source.pagerLinkPrefix}${next}`;
  return html.includes(target) || html.includes(target.replace(/\$/g, "_")) ? next : undefined;
}

// ---- Referrals (הפניות): a repeater of referrals, each with a services table ----

export const REFERRALS_SOURCE_ID = "referrals";
/** `__EVENTTARGET` of the referrals pager's "next" link. */
export const REFERRALS_NEXT_TARGET = "ctl00$ctl00$cphBody$bodyContent$MedicalReferralsList$btnNext";

/**
 * Each referral is a `.dataHead` block (what it is for, its date, who referred,
 * valid until) followed by a table of the services it covers. The block's
 * "show" action carries the PDF's action URL.
 */
export function parseReferralsHtml(html: string): RecordRow[] {
  const $ = cheerio.load(html);
  const rows: RecordRow[] = [];
  $(".dataHead").each((_, head) => {
    const block = $(head);
    const title = cleanText(block.find(".info.title .medicalReferralheaderData").first().text());
    const infos = block
      .find(".text .info")
      .map((_, el) => cleanText($(el).text()))
      .get()
      .filter(Boolean);
    const date = infos.map(portalDate).find((d, i) => d && !/בתוקף/.test(infos[i]!));
    const validUntil = infos.find((t) => /בתוקף עד/.test(t));
    const referrer = infos.find((t) => !DATE_RE.test(t) && !/בתוקף/.test(t));
    const fields: Record<string, string> = {
      "הפניה ל": title,
      ...(date ? { תאריך: date } : {}),
      ...(referrer ? { מפנה: referrer } : {}),
      ...(validUntil ? { "בתוקף עד": portalDate(validUntil) ?? validUntil.replace(/^בתוקף עד\s*/, "") } : {}),
    };
    // The services table is the next grid after this header.
    const table = block.nextAll("table").first().length ? block.nextAll("table").first() : block.parent().find("table").first();
    const headers = table
      .find("th")
      .map((_, th) => cleanText($(th).text()))
      .get();
    const items: Record<string, string>[] = [];
    table.find("tr.ClalitGridRow, tr.ClalitGridAltRow").each((_, tr) => {
      const cells = $(tr)
        .children("td")
        .map((_, td) => cleanText($(td).text()))
        .get();
      const item: Record<string, string> = {};
      headers.forEach((h, i) => {
        if (h && !/^(פעולות|טופס 17)$/.test(h) && cells[i]) item[h] = cells[i]!;
      });
      if (Object.keys(item).length) items.push(item);
    });
    const a = block.find("a[data-actionurl]").first();
    const actionUrl = a.length ? portalPath(a.attr("data-actionurl")?.trim() ?? "") : "";
    const ref: RecordRef | undefined = ACTION_URL_RE.test(actionUrl) ? { source: REFERRALS_SOURCE_ID, actionUrl } : undefined;
    rows.push({
      source: REFERRALS_SOURCE_ID,
      ...(date ? { date } : {}),
      fields,
      cells: Object.values(fields),
      items,
      ...(ref ? { ref, refToken: encodeRecordRef(ref) } : {}),
    });
  });
  if (rows.length === 0 && looksLikeLoginPage(html)) throw new ReauthenticationRequired();
  return rows;
}

/** Whether the referrals page offers a "next" page. */
export function referralsHaveNextPage(html: string): boolean {
  const $ = cheerio.load(html);
  const next = $("a[id$='MedicalReferralsList_btnNext']");
  return next.length > 0 && (next.attr("href") ?? "").includes("__doPostBack");
}
