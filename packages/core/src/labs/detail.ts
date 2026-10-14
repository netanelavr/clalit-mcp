import * as cheerio from "cheerio";
import { ParseError } from "../errors.js";
import type { LabAnalyte, LabDetailRef, LabResultDetail } from "./types.js";

const DOWNLOAD_HINT = /download|הורד|pdf|שמור|מסמך|Print|btnDownload|lnkDownload/i;

/**
 * Parse LabTestDetails.aspx HTML into structured analytes + document affordance.
 *
 * The live page (2026-10, read from redacted captures of six results) has two layouts:
 *
 * - **Numeric / qualitative results** — `table#tblSingleTestResult`, one `tr[trtype="labData"]` per
 *   analyte: `td.LabTestNameCol span#TestName` (name), `td.LabTestMeasureUnitCol span` (the result as
 *   shown: `113 %`, `10.6 Sec`, `0.91`, `Negative`, `0.52 Negative`, `FEW`), `td.LabTestGraphColumn`
 *   (empty when the test has no reference range; otherwise a bar whose `span.LABTD_JSC_MIN_VAL_TITLE`
 *   and `span.LABTD_JSC_MAX_VAL_TITLE` hold the range and whose `span[title^="ערך:"]` holds the value —
 *   the page's own script positions the marker and shows the out-of-range warning, so the flag is
 *   computed here from value and range, as that script does), `td.LabSlaCol` (turnaround, "N ימי
 *   עבודה") and `td.LabTestMoreInfoCol` (the "הערות והסבר" toggle and a `LabTestCompare.aspx` link
 *   with opaque `labId`/`labName`). The row after each, `tr.MoreInfoTR`, holds Clalit's explanation of
 *   the test in `.LabTestCommentDiv`. A `table.LabTestNotes` after the grid carries the lab's remarks
 *   on particular tests. Nothing in a row is a value's third copy: the old column heuristic read the
 *   bar's numbers as rows of their own and the explanation's close button as units.
 * - **Microbiology** — `#gvMicroProcesses table`: `td.LabDetailsMicroProcessName`,
 *   `td.LabDetailsMicroProcessResult` (result, then turnaround), `.MicroTestMoreInfoCol`; an organism
 *   heading in `.LabDetailsMicroKotOrganism h3` and a `#gvMicroTreatments` grid when there is one.
 *
 * The header (`.UserDetails`) names the member and their ID number; neither is read. Only the
 * sample's date-time is taken from it.
 */
export function parseLabDetailHtml(html: string, ref: LabDetailRef): LabResultDetail {
  if (!ref.s || !ref.d || !ref.ls) throw new ParseError("INVALID_REF");

  const $ = cheerio.load(html);
  const clean = (text: string): string => text.replace(/\s+/g, " ").trim();
  /** Text with the element's <br>s kept as line breaks (an explanation, a remark). */
  const lines = (el: ReturnType<cheerio.CheerioAPI>): string => {
    const copy = el.clone();
    copy.find("br").replaceWith("\n");
    return copy.text().replace(/[ \t\r]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  };

  const section = clean($("[id$='lblLabSection']").first().text()).replace(/\s*\|\s*$/, "");
  const microTitle = clean($("[id$='dtrmResults_sectionTitle']").first().text());
  const title =
    section ||
    microTitle ||
    clean($("h1, h2, .page-title, #ctl00_ctl00_cphBody_bodyContent_lblTitle").first().text()) ||
    clean($("title").text()) ||
    "Lab result";

  // "HH:MM dd.MM.yyyy" in the sample block; the member's name and ID in the same block are left alone.
  const header = clean($(".UserDetails").text());
  const when = /(\d{2}:\d{2})\s+(\d{2}\.\d{2}\.\d{4})/.exec(header) ?? /(\d{2}\.\d{2}\.\d{4})/.exec(header);
  const dateText = when ? (when[2] ?? when[1]) : clean($("[id*='lblDate'], .lab-date").first().text()) || undefined;
  const timeText = when && when[2] ? when[1] : undefined;
  const testNumber = /(\d{6,})/.exec(clean($("[id$='lblPageSubtitle']").first().text()))?.[1];

  const analytes: LabAnalyte[] = [];
  const notes: string[] = [];

  // Layout 1: the results grid.
  $("tr[trtype='labData'], tr[trType='labData']").each((_, tr) => {
    const row = $(tr);
    const name = clean(row.find("#TestName, .LabTestNameCol").first().text());
    const shown = clean(row.find(".LabTestMeasureUnitCol").first().text());
    if (!name) return;
    const analyte: LabAnalyte = { name, result: shown, ...splitResult(shown) };

    const graph = row.find(".LabTestGraphColumn").first();
    const min = parseNumber(graph.find(".LABTD_JSC_MIN_VAL_TITLE").first().text());
    const max = parseNumber(graph.find(".LABTD_JSC_MAX_VAL_TITLE").first().text());
    if (min !== undefined && max !== undefined) {
      analyte.referenceRange = `${trimNumber(min)}-${trimNumber(max)}`;
      analyte.rangeMin = min;
      analyte.rangeMax = max;
      const marked = graph.find("span[title^='ערך:']").first().attr("title");
      const value = analyte.value ?? parseNumber(marked?.replace(/^ערך:\s*/, "") ?? "");
      if (value !== undefined) {
        if (value < min) analyte.flag = "L";
        else if (value > max) analyte.flag = "H";
      }
    }

    const sla = clean(row.find(".LabSlaCol").first().text());
    if (sla) analyte.turnaround = sla;

    const compare = row.find("a[href*='LabTestCompare.aspx']").first().attr("href");
    if (compare) {
      try {
        const u = new URL(compare, "https://e-services.clalit.co.il");
        const labId = u.searchParams.get("labId");
        const labName = u.searchParams.get("labName");
        if (labId && labName) analyte.compare = { labId, labName };
      } catch {
        /* a link that is not a URL carries nothing */
      }
    }

    const more = row.next("tr.MoreInfoTR");
    const explanation = lines(more.find(".LabTestCommentDiv p").first());
    if (explanation) analyte.explanation = explanation;

    analytes.push(analyte);
  });

  // Layout 2: microbiology.
  if (analytes.length === 0) {
    $("#gvMicroProcesses tr").each((_, tr) => {
      const row = $(tr);
      if (row.find("th").length) return;
      const name = clean(row.find(".LabDetailsMicroProcessName").first().text());
      const cells = row.find(".LabDetailsMicroProcessResult").toArray().map((td) => clean($(td).text()));
      if (!name) return;
      const analyte: LabAnalyte = { name, result: cells[0] ?? "" };
      if (cells[1]) analyte.turnaround = cells[1];
      const more = clean(row.find(".MicroTestMoreInfoCol").first().text());
      if (more) analyte.explanation = more;
      analytes.push(analyte);
    });
    const organism = clean($(".LabDetailsMicroKotOrganism").first().text());
    if (organism) notes.push(organism);
    $("#gvMicroTreatments tr").each((_, tr) => {
      const row = $(tr);
      if (row.find("th").length) return;
      const cells = row.find("td").toArray().map((td) => clean($(td).text())).filter(Boolean);
      if (cells.length >= 2) analytes.push({ name: cells[0]!, result: cells.slice(1).join(" · ") });
    });
  }

  // Layout 0: the shape the first fixture guessed (plain name | result | units | range | flag table),
  // kept so an older or simpler page still yields something.
  if (analytes.length === 0) {
    for (const table of $("table").toArray()) {
      for (const tr of $(table).find("tr").toArray()) {
        if ($(tr).find("th").length) continue;
        const cells = $(tr).find("td").toArray().map((td) => clean($(td).text()));
        const [name, result, units, referenceRange, flag] = cells;
        if (cells.length < 2 || !name || !result || /^(שם|בדיקה|name|test)$/i.test(name)) continue;
        analytes.push({
          name,
          result,
          ...(units ? { units } : {}),
          ...(referenceRange ? { referenceRange } : {}),
          ...(flag ? { flag } : {}),
        });
      }
    }
  }

  // The lab's own remarks on particular tests ("הערות המעבדה": test name, then lines).
  $("table.LabTestNotes").each((_, table) => {
    const rows = $(table).find("tr").toArray().map((tr) => lines($(tr))).filter(Boolean);
    // The first row is the heading; each later row is "<test name> <remark lines>".
    for (const text of rows.slice(1)) notes.push(text);
  });
  $("[id*='Remark'], [id*='Comment'], .lab-notes, .remarks").each((_, el) => {
    if ($(el).closest(".MoreInfoTR").length || $(el).closest("tr[trtype='labData']").length) return;
    const text = clean($(el).text());
    if (text && !notes.includes(text)) notes.push(text);
  });

  const documentEventTarget = findDocumentControl($);

  return {
    ref,
    title,
    ...(dateText ? { date: dateText } : {}),
    ...(timeText ? { time: timeText } : {}),
    ...(testNumber ? { testNumber } : {}),
    analytes,
    notes,
    hasDocument: Boolean(documentEventTarget),
    ...(documentEventTarget ? { documentEventTarget } : {}),
  };
}

/**
 * The result cell as shown, split: a leading number becomes `value` and the rest `units`
 * ("113 %", "10.6 Sec", "0 /HPF") or, when the rest is a word like Negative, a `qualifier`
 * ("0.52 Negative"). Text alone ("Negative", "FEW") stays as the result only.
 */
export function splitResult(shown: string): Pick<LabAnalyte, "value" | "units" | "qualifier"> {
  const m = /^([-+]?\d+(?:[.,]\d+)?)\s*(.*)$/.exec(shown);
  if (!m) return {};
  const value = Number(m[1]!.replace(",", "."));
  if (!Number.isFinite(value)) return {};
  const rest = m[2]!.trim();
  if (!rest) return { value };
  if (/^(negative|positive|normal|abnormal|reactive|non-?reactive|borderline|equivocal|trace|שלילי|חיובי|תקין)$/i.test(rest)) {
    return { value, qualifier: rest };
  }
  return { value, units: rest };
}

function parseNumber(text: string): number | undefined {
  const t = text.replace(/\s+/g, "").replace(",", ".");
  if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return undefined;
  return Number(t);
}

function trimNumber(n: number): string {
  return String(n);
}

function findDocumentControl($: cheerio.CheerioAPI): string | undefined {
  let target: string | undefined;
  // The live page: a left-menu link "לשמור את התוצאות כ־PDF" that posts back (onclick Export('pdf')).
  $("a[onclick*=\"Export('pdf')\"], a[onclick*='Export(&#39;pdf&#39;)']").each((_, el) => {
    const post = /__doPostBack\(\s*['"]([^'"]+)['"]/.exec($(el).attr("href") ?? "");
    if (post?.[1]) {
      target = post[1];
      return false;
    }
  });
  if (target) return target;
  $("a[href*='__doPostBack'], a[id], input[type='submit'], input[type='button'], button").each((_, el) => {
    const id = $(el).attr("id") ?? "";
    const name = $(el).attr("name") ?? "";
    const text = $(el).text() + ($(el).attr("value") ?? "") + id + name;
    const href = $(el).attr("href") ?? "";
    if (!DOWNLOAD_HINT.test(text) && !DOWNLOAD_HINT.test(href)) return;
    const post = /__doPostBack\(\s*['"]([^'"]+)['"]/.exec(href);
    if (post?.[1]) {
      target = post[1];
      return false;
    }
    if (name) {
      target = name;
      return false;
    }
    if (id) {
      target = id.replace(/_/g, "$"); // ASP.NET id → uniqueID often replaces _ with $
      return false;
    }
  });
  return target;
}
