import * as cheerio from "cheerio";
import { ParseError, ReauthenticationRequired } from "../errors.js";
import { looksLikeLabOrdersListChrome, looksLikeLoginPage } from "../webforms.js";
import type { LabOrderListItem, LabOrderRef } from "./types.js";

const DETAIL_PATH_HINT = /LabOrderDetails\.aspx/i;

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function parseOrderRef(href: string): LabOrderRef | undefined {
  try {
    const url = new URL(href, "https://e-services.clalit.co.il");
    if (!DETAIL_PATH_HINT.test(url.pathname)) return undefined;
    const ord = url.searchParams.get("ord");
    if (!ord) return undefined;
    return { ord };
  } catch {
    return undefined;
  }
}

/**
 * Parse LabOrderList.aspx HTML into owner lab-order rows.
 * Prefer lnkOrderDetails / row presence over NoLabOrdersFound alone (marker may
 * still appear alongside rows).
 */
export function parseLabOrdersListHtml(html: string): LabOrderListItem[] {
  const $ = cheerio.load(html);
  const items: LabOrderListItem[] = [];
  const seen = new Set<string>();

  const grid =
    $("table[id*='gvLabOrdersList']").length > 0
      ? $("table[id*='gvLabOrdersList']").first()
      : $("table")
          .filter((_, t) => $(t).find('a[href*="LabOrderDetails.aspx"], a[id*="lnkOrderDetails"]').length > 0)
          .first();

  if (grid.length === 0) {
    if (looksLikeLoginPage(html)) {
      throw new ReauthenticationRequired();
    }
    // Empty history is valid when real list chrome is present (incl. NoLabOrdersFound).
    if (looksLikeLabOrdersListChrome(html)) return [];
    throw new ParseError("LAB_ORDERS_LIST_SHAPE", "Lab orders list grid not found.");
  }

  grid.find("tr").each((_, tr) => {
    const row = $(tr);
    if (row.find("th").length > 0) return;

    const link = row
      .find('a[href*="LabOrderDetails.aspx"], a[id*="lnkOrderDetails"]')
      .first();
    const href = link.attr("href");
    const ref = href ? parseOrderRef(href) : undefined;

    const issuanceDate =
      cleanText(row.find("[id*='dcOrderIssuanceDate']").first().text()) || undefined;
    const referer = cleanText(row.find("[id*='dcReferer']").first().text()) || undefined;
    const validTo =
      cleanText(row.find("[id*='txtValidTo'], [id*='dcValidTo']").first().text()) || undefined;
    const section =
      cleanText(row.find("[id*='dcLabSectionList']").first().text()) || undefined;

    // Fallback: td cell texts when control ids absent
    const cells = row
      .find("td")
      .toArray()
      .map((td) => cleanText($(td).text()))
      .filter(Boolean);

    if (!ref && cells.length === 0 && !issuanceDate && !section) return;

    if (ref) {
      if (seen.has(ref.ord)) return;
      seen.add(ref.ord);
    }

    const issuance = issuanceDate || cells[0] || undefined;
    const refererText = referer || (cells.length > 1 ? cells[1] : undefined);
    const valid = validTo || (cells.length > 2 ? cells[2] : undefined);

    items.push({
      ref: ref ?? { ord: "" },
      ...(issuance ? { issuanceDate: issuance } : {}),
      ...(refererText ? { referer: refererText } : {}),
      ...(valid ? { validTo: valid } : {}),
      ...(section ? { section } : {}),
      hasDetail: Boolean(ref),
    });
  });

  const filtered = items.filter((item) => item.hasDetail || item.issuanceDate || item.section);
  // Grid present but only header → empty list (chrome already validated by grid find)
  return filtered;
}

/** Encode a lab-order ref into a stable CLI/MCP handle. */
export function encodeLabOrderRef(ref: LabOrderRef): string {
  if (!ref.ord) throw new ParseError("INVALID_REF", "Incomplete lab-order ref.");
  return Buffer.from(JSON.stringify(ref), "utf8").toString("base64url");
}

export function decodeLabOrderRef(token: string): LabOrderRef {
  try {
    const raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<LabOrderRef>;
    if (typeof raw.ord !== "string" || !raw.ord) throw new Error("shape");
    return { ord: raw.ord };
  } catch {
    throw new ParseError("INVALID_REF", "Lab-order ref token is invalid.");
  }
}
