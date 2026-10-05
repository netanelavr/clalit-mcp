import * as cheerio from "cheerio";
import { ParseError } from "../errors.js";
import type { LabOrderDetail, LabOrderItem, LabOrderRef } from "./types.js";

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Parse LabOrderDetails.aspx HTML into header chrome + gvLabOrdersItem rows.
 * Does not fetch print/PDF UI actions.
 */
export function parseLabOrderDetailHtml(html: string, ref: LabOrderRef): LabOrderDetail {
  if (!ref.ord) throw new ParseError("INVALID_REF");

  const $ = cheerio.load(html);
  const title =
    cleanText(
      $("h1, h2, .page-title, [id*='lblTitle']").first().text() ||
        $("title").text(),
    ) || undefined;

  const labOrderId =
    $('input[name*="hdnLabOrderID"], input[id*="hdnLabOrderID"]').attr("value")?.trim() ||
    undefined;

  // Header validity labels are chrome text near Hebrew markers — keep optional/best-effort.
  let validFrom: string | undefined;
  let validTo: string | undefined;
  const bodyText = cleanText($("form").first().text() || $("body").text());
  const fromMatch = /בתוקף מ\s*([0-9./\-]+)/.exec(bodyText);
  const toMatch = /בתוקף עד\s*([0-9./\-]+)/.exec(bodyText);
  if (fromMatch?.[1]) validFrom = fromMatch[1];
  if (toMatch?.[1]) validTo = toMatch[1];

  const items: LabOrderItem[] = [];
  const grid =
    $("table[id*='gvLabOrdersItem']").length > 0
      ? $("table[id*='gvLabOrdersItem']").first()
      : $("table")
          .filter(
            (_, t) =>
              $(t).find("[id*='dcTestName'], [id*='dcLabSection']").length > 0,
          )
          .first();

  if (grid.length > 0) {
    grid.find("tr").each((_, tr) => {
      const row = $(tr);
      if (row.find("th").length > 0) return;
      const section = cleanText(row.find("[id*='dcLabSection']").first().text()) || undefined;
      const testName = cleanText(row.find("[id*='dcTestName']").first().text()) || undefined;
      if (!section && !testName) {
        const cells = row
          .find("td")
          .toArray()
          .map((td) => cleanText($(td).text()))
          .filter(Boolean);
        if (cells.length >= 2) {
          items.push({ section: cells[0], testName: cells[1] });
        } else if (cells.length === 1) {
          items.push({ testName: cells[0] });
        }
        return;
      }
      items.push({
        ...(section ? { section } : {}),
        ...(testName ? { testName } : {}),
      });
    });
  }

  return {
    ref,
    ...(title ? { title } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
    items,
    ...(labOrderId ? { labOrderId } : {}),
  };
}
