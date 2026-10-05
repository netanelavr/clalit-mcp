import * as cheerio from "cheerio";
import { ParseError, ReauthenticationRequired } from "../errors.js";
import { looksLikeLabsListChrome, looksLikeLoginPage } from "../webforms.js";
import type { LabDetailRef, LabListItem } from "./types.js";

const DETAIL_PATH_HINT = /LabTestDetails\.aspx/i;

/** Page numbers offered by LabsTestList pager controls in the HTML. */
export function listVisibleLabPagerPages(html: string): number[] {
  const pages = new Set<number>();
  for (const match of html.matchAll(/gvTestListInDateRange[_$]PagerLink-(\d+)/g)) {
    pages.add(Number(match[1]));
  }
  return [...pages].sort((a, b) => a - b);
}

/** Next pager page after `currentPage`, or undefined when this is the last page. */
export function nextLabPagerPage(html: string, currentPage: number): number | undefined {
  return listVisibleLabPagerPages(html).find((page) => page > currentPage);
}


function parseDetailRef(href: string): LabDetailRef | undefined {
  try {
    const url = new URL(href, "https://e-services.clalit.co.il");
    if (!DETAIL_PATH_HINT.test(url.pathname)) return undefined;
    const s = url.searchParams.get("s");
    const d = url.searchParams.get("d");
    const ls = url.searchParams.get("ls");
    if (s === null || d === null || ls === null) return undefined;
    // Reject empty or obviously non-opaque garbage
    if (!s || !d || !ls) return undefined;
    return { s, d, ls };
  } catch {
    return undefined;
  }
}

/**
 * Parse LabsTestList.aspx HTML into owner lab rows.
 * Only follows detail links present in the list (own record). Never invents refs.
 */
export function parseLabsListHtml(html: string): LabListItem[] {
  const $ = cheerio.load(html);
  const items: LabListItem[] = [];
  const seen = new Set<string>();

  // Prefer the observed grid id; fall back to any table that links to LabTestDetails.
  const grid =
    $("#gvTestListInDateRange").length > 0
      ? $("#gvTestListInDateRange")
      : $("#ctl00_ctl00_cphBody_bodyContent_LabsHistory1_gvTestListInDateRange").length > 0
        ? $("#ctl00_ctl00_cphBody_bodyContent_LabsHistory1_gvTestListInDateRange")
        : $("table").filter((_, t) => $(t).find('a[href*="LabTestDetails.aspx"]').length > 0).first();

  if (grid.length === 0) {
    // Login redirect "Object moved" bodies mention LabsTestList only inside ReturnUrl —
    // never treat that as an empty labs list.
    if (looksLikeLoginPage(html)) {
      throw new ReauthenticationRequired();
    }
    // Empty history is valid only when real list chrome is present.
    if (looksLikeLabsListChrome(html)) return [];
    throw new ParseError("LABS_LIST_SHAPE", "Labs list grid not found.");
  }

  grid.find("tr").each((_, tr) => {
    const row = $(tr);
    if (row.find("th").length > 0) return;

    const link = row.find('a[href*="LabTestDetails.aspx"]').first();
    const href = link.attr("href");
    const ref = href ? parseDetailRef(href) : undefined;

    const cells = row
      .find("td")
      .toArray()
      .map((td) => $(td).text().replace(/\s+/g, " ").trim())
      .filter(Boolean);

    if (cells.length === 0 && !ref) return;

    const name =
      (link.text().replace(/\s+/g, " ").trim() ||
        cells.find((c, i) => i > 0 && c.length > 0) ||
        "") || "—";
    const date = cells[0] ?? "";
    const summary = cells.length > 2 ? cells.slice(2).join(" · ") : cells[1] !== name ? cells[1] : undefined;

    if (ref) {
      const key = `${ref.s}|${ref.d}|${ref.ls}`;
      if (seen.has(key)) return;
      seen.add(key);
    }

    items.push({
      ...(ref ? { ref } : { ref: { s: "", d: "", ls: "" } }),
      date,
      name,
      ...(summary ? { summary } : {}),
      hasDetail: Boolean(ref),
    });
  });

  // Drop placeholder rows without detail and without meaningful text
  return items.filter((item) => item.hasDetail || (item.date && item.name && item.name !== "—"));
}

/** Encode a detail ref into a stable CLI/MCP handle (not a portal secret format guarantee). */
export function encodeLabRef(ref: LabDetailRef): string {
  if (!ref.s || !ref.d || !ref.ls) throw new ParseError("INVALID_REF", "Incomplete lab ref.");
  return Buffer.from(JSON.stringify(ref), "utf8").toString("base64url");
}

export function decodeLabRef(token: string): LabDetailRef {
  try {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<LabDetailRef>;
    if (typeof raw.s !== "string" || typeof raw.d !== "string" || typeof raw.ls !== "string") {
      throw new Error("shape");
    }
    if (!raw.s || !raw.d || !raw.ls) throw new Error("empty");
    return { s: raw.s, d: raw.d, ls: raw.ls };
  } catch {
    throw new ParseError("INVALID_REF", "Lab ref token is invalid.");
  }
}
