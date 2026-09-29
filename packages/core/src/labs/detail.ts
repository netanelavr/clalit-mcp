import * as cheerio from "cheerio";
import { ParseError } from "../errors.js";
import type { LabAnalyte, LabDetailRef, LabResultDetail } from "./types.js";

const DOWNLOAD_HINT = /download|הורד|pdf|שמור|מסמך|Print|btnDownload|lnkDownload/i;

/**
 * Parse LabTestDetails.aspx HTML into structured analytes + document affordance.
 */
export function parseLabDetailHtml(html: string, ref: LabDetailRef): LabResultDetail {
  if (!ref.s || !ref.d || !ref.ls) throw new ParseError("INVALID_REF");

  const $ = cheerio.load(html);
  const title =
    $("h1, h2, .page-title, #ctl00_ctl00_cphBody_bodyContent_lblTitle")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim() ||
    $("title").text().replace(/\s+/g, " ").trim() ||
    "Lab result";

  const dateText =
    $("[id*='lblDate'], [id*='Date'], .lab-date")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim() || undefined;

  const analytes: LabAnalyte[] = [];
  const tables = $("table").toArray();
  for (const table of tables) {
    const rows = $(table).find("tr").toArray();
    for (const tr of rows) {
      const cells = $(tr)
        .find("td")
        .toArray()
        .map((td) => $(td).text().replace(/\s+/g, " ").trim());
      if (cells.length < 2) continue;
      if ($(tr).find("th").length) continue;
      // Heuristic: name | result | units | range | flag
      const [name, result, units, referenceRange, flag] = cells;
      if (!name || !result) continue;
      if (/^(שם|בדיקה|name|test)$/i.test(name)) continue;
      analytes.push({
        name,
        result,
        ...(units ? { units } : {}),
        ...(referenceRange ? { referenceRange } : {}),
        ...(flag ? { flag } : {}),
      });
    }
  }

  const notes: string[] = [];
  $("[id*='Remark'], [id*='Comment'], [id*='Note'], .lab-notes, .remarks").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text) notes.push(text);
  });

  let documentEventTarget: string | undefined;
  $("a[href*='__doPostBack'], a[id], input[type='submit'], input[type='button'], button").each((_, el) => {
    const id = $(el).attr("id") ?? "";
    const name = $(el).attr("name") ?? "";
    const text = $(el).text() + ($(el).attr("value") ?? "") + id + name;
    const href = $(el).attr("href") ?? "";
    if (!DOWNLOAD_HINT.test(text) && !DOWNLOAD_HINT.test(href)) return;
    const post = /__doPostBack\(\s*['"]([^'"]+)['"]/.exec(href);
    if (post?.[1]) {
      documentEventTarget = post[1];
      return false;
    }
    if (name) {
      documentEventTarget = name;
      return false;
    }
    if (id) {
      // ASP.NET id → uniqueID often replaces _ with $
      documentEventTarget = id.replace(/_/g, "$");
      return false;
    }
  });

  return {
    ref,
    title,
    ...(dateText ? { date: dateText } : {}),
    analytes,
    notes,
    hasDocument: Boolean(documentEventTarget),
    ...(documentEventTarget ? { documentEventTarget } : {}),
  };
}
