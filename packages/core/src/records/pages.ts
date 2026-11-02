/**
 * Pages of their own shape: the home page's upcoming appointments, the
 * Measures accordion, and the JSON endpoints behind the React pages
 * (vaccinations, blood type). Each is read into RecordRow[] like a grid,
 * so the CLI, MCP tools and export treat every source alike.
 */
import * as cheerio from "cheerio";
import { ReauthenticationRequired } from "../errors.js";
import { looksLikeLoginPage } from "../webforms.js";
import type { RecordRow } from "./types.js";

const DATE_RE = /\b(\d{2})[./](\d{2})[./](\d{4})\b/;

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** The few entities an inline script attribute carries (`ד&quot;ר`). */
function decodeEntities(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The home page lists upcoming visits as `PopUpVisit('<doctor>', '<member name>',
 * '<member id>', '<visit guid>', '<service>', '<dd.MM.yyyy>', '<HH:mm>')` calls.
 * Only the doctor, the service, the date and the time are kept: the member's
 * name and id are the owner's own and never belong in a record, and the guid
 * is an opaque handle for the portal's own popup.
 */
export function parseAppointmentsHtml(html: string): RecordRow[] {
  const rows: RecordRow[] = [];
  const seen = new Set<string>();
  const re = /PopUpVisit\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*'(?:[^'\\]|\\.)*'\s*,\s*'(?:[^'\\]|\\.)*'\s*,\s*'(?:[^'\\]|\\.)*'\s*,\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\)/g;
  for (const m of html.matchAll(re)) {
    const [, doctor, service, date, time] = m.map((v) => decodeEntities(cleanText(v ?? "").replace(/\\'/g, "'")));
    const key = `${date}|${time}|${service}|${doctor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fields: Record<string, string> = {
      תאריך: date!,
      שעה: time!,
      ...(doctor ? { "רופא/ה": doctor } : {}),
      ...(service ? { שירות: service } : {}),
    };
    rows.push({ source: "appointments", ...(DATE_RE.test(date!) ? { date: date! } : {}), fields, cells: Object.values(fields) });
  }
  if (rows.length === 0 && looksLikeLoginPage(html)) throw new ReauthenticationRequired();
  return rows;
}

/**
 * Measures.aspx: one accordion panel per recommendation — the title in a
 * `ShowMeasure` span, the text in the panel, and "מעודכנת לתאריך dd.MM.yyyy".
 */
export function parseRecommendationsHtml(html: string): RecordRow[] {
  const $ = cheerio.load(html);
  const rows: RecordRow[] = [];
  $("[id$='_ShowMeasure']").each((_, titleEl) => {
    const title = cleanText($(titleEl).text()).replace(/^המלצה רפואית בשבילך:\s*/, "");
    const header = $(titleEl).closest("h2");
    const panelId = header.attr("aria-controls");
    const panel = panelId ? $(`#${panelId.replace(/([$:.[\]])/g, "\\$1")}`) : header.next();
    const copy = panel.clone();
    copy.find("br").replaceWith("\n");
    copy.find("p").after("\n");
    const text = copy
      .text()
      .split("\n")
      .map((l) => cleanText(l))
      .filter(Boolean)
      .join("\n");
    const updated = /מעודכנת לתאריך\s*(\d{2}\.\d{2}\.\d{4})/.exec(text)?.[1];
    const fields: Record<string, string> = {
      המלצה: title,
      ...(updated ? { "מעודכנת לתאריך": updated } : {}),
      טקסט: text,
    };
    rows.push({ source: "recommendations", ...(updated ? { date: updated } : {}), fields, cells: [title, updated ?? "", text] });
  });
  if (rows.length === 0 && looksLikeLoginPage(html)) throw new ReauthenticationRequired();
  return rows;
}

/** `/Date(1700000000000)/`, ISO, or `dd.MM.yyyy` → the portal's `dd.MM.yyyy`; anything else as given. */
export function apiDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const ms = /^\/Date\((-?\d+)/.exec(value)?.[1];
  const d = ms ? new Date(Number(ms)) : /^\d{4}-\d{2}-\d{2}/.test(value) ? new Date(value) : undefined;
  if (d && !Number.isNaN(d.getTime())) {
    return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
  }
  return DATE_RE.test(value) ? value.replace(DATE_RE, "$1.$2.$3") : value;
}

/**
 * A JSON endpoint's answer as rows. The portal's React pages read a JSON
 * string that itself holds JSON (`JSON.parse(responseJson)`), so both layers
 * are unwrapped. An array gives one row per element; an object one row;
 * status-only answers ("no data") give none. Every scalar is kept as text under
 * its own key; dates are also surfaced as the row's `date`.
 */
export function parseApiJson(text: string, sourceId: string): RecordRow[] {
  let value: unknown = text.trim();
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  // Envelopes: { Results: "[…]", Status: "Success" } / { data: [...] } — the list may itself be a JSON string.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const env = value as Record<string, unknown>;
    for (const k of ["Results", "results", "Result", "result", "Data", "data", "Items", "items"]) {
      let inner = env[k];
      if (typeof inner === "string") {
        try {
          inner = JSON.parse(inner);
        } catch {
          continue;
        }
      }
      if (Array.isArray(inner)) {
        value = inner;
        break;
      }
    }
  }
  const items: unknown[] = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  const rows: RecordRow[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const fields: Record<string, string> = {};
    let date: string | undefined;
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "object") {
        fields[k] = JSON.stringify(v);
        continue;
      }
      const asDate = /date|time/i.test(k) ? apiDate(v) : undefined;
      fields[k] = asDate ?? String(v);
      if (!date && asDate && DATE_RE.test(asDate)) date = asDate;
    }
    if (Object.keys(fields).length === 0) continue;
    rows.push({ source: sourceId, ...(date ? { date } : {}), fields, cells: Object.values(fields) });
  }
  return rows;
}
