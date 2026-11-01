/**
 * Export everything this client can read into one folder, so a member keeps a copy of their records
 * and can hand it whole to an assistant, a spreadsheet, or a database — instead of asking the MCP for
 * one record at a time while the session lasts.
 *
 * The folder's layout is modeled on the one Health Records Export for Maccabi writes
 * (https://github.com/RoniRachmani/health-records-export-for-maccabi): a folder per section,
 * `list.json` for the list, one file per record under `details/`, documents under `files/`, and at
 * the root a `README.md` that is the export's own data dictionary, `export-errors.json` for what
 * failed, and `CLAUDE.md` / `AGENTS.md` pointing at the README. Every record is wrapped with where it came from and when.
 *
 * Reads only through the readers, so the owner-scope rules hold: refs come from the owner's own lists.
 * Requests are paced; an item that fails is filed and the export goes on; an ended session stops it,
 * and what was collected stays. A rerun into the same folder writes nothing it already has.
 */
import { createHash } from "node:crypto";
import { ClalitError, ReauthenticationRequired } from "../errors.js";
import { DOCUMENT_SOURCES } from "../documents/sources.js";
import type { ClalitDocument, DocumentListItem } from "../documents/types.js";
import { ALL_RECORD_SOURCES } from "../records/sources.js";
import type { RecordDocument, RecordRow } from "../records/types.js";
import type { LabDocument, LabResultDetail } from "../labs/types.js";
import type { LabOrderDetail } from "../lab-orders/types.js";
import type { PrescriptionListItem } from "../prescriptions/types.js";
import type { ListedLab, ListedLabOrder } from "../readers.js";
import { PACKAGE_VERSION } from "../version.js";

/** What the export reads: the readers' list and detail calls, nothing that writes. */
export interface ExportClient {
  listLabs(options?: { fromDate?: string; toDate?: string }): Promise<ListedLab[]>;
  getLabResult(refOrToken: string): Promise<LabResultDetail>;
  getLabDocument(refOrToken: string): Promise<LabDocument>;
  listPrescriptions(options?: { includeExpired?: boolean }): Promise<PrescriptionListItem[]>;
  listLabOrders(): Promise<ListedLabOrder[]>;
  getLabOrder(refOrToken: string): Promise<LabOrderDetail>;
  listDocuments(sourceId: string, options?: { fromDate?: string; toDate?: string }): Promise<DocumentListItem[]>;
  getDocument(refOrToken: string): Promise<ClalitDocument>;
  listRecords(sourceId: string, options?: { fromDate?: string; toDate?: string; onPage?: (rows: RecordRow[]) => Promise<void> }): Promise<RecordRow[]>;
  getRecordDocument(refOrToken: string): Promise<RecordDocument>;
  getHospitalLabResult(row: { link?: string; context?: { select: string; value: string }; testNumber?: string; date?: string; section?: string }): Promise<LabResultDetail>;
}

/** Where the files go. The CLI gives a folder; tests give memory. */
export interface ExportSink {
  exists(rel: string): Promise<boolean>;
  /** A JSON file written earlier, when the sink can read it back (so an empty answer never replaces a list that had rows). */
  readJson?(rel: string): Promise<unknown>;
  putJson(rel: string, value: unknown): Promise<void>;
  putBytes(rel: string, bytes: Uint8Array): Promise<void>;
  putText(rel: string, text: string): Promise<void>;
}

export interface ExportOptions {
  /** Labs list range, `dd.MM.yyyy`; the portal's default range is short, so the export asks for a wide one. */
  fromDate?: string;
  toDate?: string;
  /** Download the PDFs: each lab result's, and every document of the document sources (default true). The lists are written either way. */
  documents?: boolean;
  /** Expired prescriptions too (default true: an archive keeps history). */
  includeExpired?: boolean;
  /** Milliseconds between requests (default 300). */
  paceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Progress lines: section names, counts; never a value. */
  log?: (line: string) => void;
  /**
   * Only these sections: `labs`, `prescriptions`, `lab-orders`, a document source id, a record source id.
   * Everything else is left as it is on disk. Default: everything.
   */
  only?: string[];
}

export interface ExportProblem {
  where: string;
  what: string;
  at: string;
}

export interface ExportReport {
  /** Files written or kept, per top folder. */
  folders: Record<string, number>;
  problems: ExportProblem[];
  /** Lab results the portal offers no PDF for: skipped, not failures. */
  withoutDocument: number;
  /** True when the session ended before the export finished; what was collected is kept. */
  stopped: boolean;
}

export const EXPORT_LAYOUT = 1;
export const DEFAULT_FROM_DATE = "01.01.1990";

/** The name of the export folder for a run on this day, in Israel's calendar. */
export function exportName(now: number): string {
  return "clalit-export-" + israelDate(now);
}

export function israelDate(now: number): string {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
}

/** `15/03/2025`, `15.03.2025` or `20250315` → `2025-03-15`; anything else is kept as given. */
export function isoDate(s: string | undefined): string {
  if (!s) return "undated";
  const dmy = s.match(/^(\d{2})[./](\d{2})[./](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const ymd = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  return s.replace(/[^\w.-]+/g, "-");
}

/** A title fit for a file name: letters of any script, digits, `.` and `-`; everything else becomes `-`. */
export function safeTitle(s: string | undefined, max = 60): string {
  if (!s) return "";
  const t = s
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}.-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return t.length > max ? t.slice(0, max).replace(/[-.]+$/, "") : t;
}

/** First 8 hex of sha256 over the parts: a stable, short id for a record the site names only by an opaque ref. */
export function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 8);
}

/** refToken is a session token for `--ref`; it is dead once the session ends, so the archive keeps only `ref`. */
function withoutToken<T extends { refToken?: string }>({ refToken: _token, ...row }: T): Omit<T, "refToken"> {
  return row;
}

function stem(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join("_");
}

export async function exportAll(client: ExportClient, sink: ExportSink, options: ExportOptions = {}): Promise<ExportReport> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pace = options.paceMs ?? 300;
  const log = options.log ?? (() => undefined);
  const documents = options.documents ?? true;
  const folders: Record<string, number> = {};
  const problems: ExportProblem[] = [];
  const startedAt = new Date(now()).toISOString();
  const fromDate = options.fromDate ?? DEFAULT_FROM_DATE;
  const toDate = options.toDate ?? israelDate(now()).split("-").reverse().join(".");

  const wrap = (kind: string, data: unknown, extra: Record<string, unknown> = {}) => ({
    source: "clalit-mcp",
    kind,
    ...extra,
    fetched_at: new Date(now()).toISOString(),
    data,
  });
  const count = (rel: string) => {
    const top = rel.split("/")[0]!;
    folders[top] = (folders[top] ?? 0) + 1;
  };
  const problem = (where: string, e: unknown) => {
    problems.push({ where, what: (e instanceof Error ? e.message : String(e)).slice(0, 300), at: new Date(now()).toISOString() });
  };
  const putJson = async (rel: string, value: unknown) => {
    await sink.putJson(rel, value);
    count(rel);
  };
  let stopped = false;
  let withoutDocument = 0;
  const wanted = (id: string) => !options.only || options.only.includes(id);
  /** Writes a list, unless it came back empty where an earlier run had rows: a portal hiccup must not erase an archive. */
  const putList = async (rel: string, rows: unknown[], value: unknown): Promise<boolean> => {
    if (rows.length === 0 && sink.readJson && (await sink.exists(rel))) {
      const previous = (await sink.readJson(rel).catch(() => undefined)) as { data?: unknown[] } | undefined;
      if (Array.isArray(previous?.data) && previous.data.length > 0) {
        count(rel);
        problem(rel, `the portal answered with no rows where the previous run had ${previous.data.length}; the previous list is kept`);
        return false;
      }
    }
    await putJson(rel, value);
    return true;
  };

  try {
    // ---- labs ----
    if (!wanted("labs")) log("labs: skipped (--only)");
    else {
    log("labs");
    const labs = await client.listLabs({ fromDate, toDate });
    const archived = labs.map(withoutToken);
    await putJson("labs/list.json", wrap("lab-list", archived, { range: { fromDate, toDate } }));
    log(`  ${labs.length} results listed (${fromDate} – ${toDate})`);
    const seen = new Set<string>();
    for (let i = 0; i < labs.length; i++) {
      const item = labs[i]!;
      if (!item.hasDetail || !item.refToken) continue;
      const id = shortHash(item.ref.s, item.ref.d, item.ref.ls);
      let name = stem(isoDate(item.date), id, safeTitle(item.name));
      if (seen.has(name)) name += "-" + i;
      seen.add(name);
      const rel = `labs/details/${name}.json`;
      let detail: LabResultDetail | undefined;
      if (await sink.exists(rel)) {
        count(rel);
      } else {
        try {
          await sleep(pace);
          detail = await client.getLabResult(item.refToken);
          await putJson(rel, wrap("lab-result", detail, { list: archived[i] }));
        } catch (e) {
          if (e instanceof ReauthenticationRequired) throw e;
          problem(rel, e);
          continue;
        }
      }
      if (documents) {
        const pdf = `labs/files/${name}.pdf`;
        if (await sink.exists(pdf)) {
          count(pdf);
        } else if (detail && !detail.hasDocument) {
          // The portal offers no PDF for this result: nothing to fetch, and not a failure.
          withoutDocument += 1;
        } else {
          try {
            await sleep(pace);
            const doc = await client.getLabDocument(item.refToken);
            await sink.putBytes(pdf, doc.bytes);
            count(pdf);
          } catch (e) {
            if (e instanceof ReauthenticationRequired) throw e;
            // On a rerun the detail is on disk and was not read again; the reader says there is no PDF.
            if (e instanceof ClalitError && e.code === "NO_DOCUMENT") withoutDocument += 1;
            else problem(pdf, e);
          }
        }
      }
      if ((i + 1) % 10 === 0 || i === labs.length - 1) log(`  ${i + 1}/${labs.length}`);
    }
    if (withoutDocument) log(`  ${withoutDocument} ${withoutDocument === 1 ? "result has" : "results have"} no PDF on the portal (not an error)`);
    }

    // ---- prescriptions ----
    if (wanted("prescriptions")) {
    log("prescriptions");
    try {
      await sleep(pace);
      const rx = await client.listPrescriptions({ includeExpired: options.includeExpired ?? true });
      await putJson("prescriptions/list.json", wrap("prescription-list", rx));
      log(`  ${rx.length} prescriptions`);
    } catch (e) {
      if (e instanceof ReauthenticationRequired) throw e;
      problem("prescriptions/list.json", e);
    }
    }

    // ---- lab orders ----
    if (wanted("lab-orders")) {
    log("lab-orders");
    try {
      await sleep(pace);
      const orders = await client.listLabOrders();
      await putJson("lab-orders/list.json", wrap("lab-order-list", orders.map(withoutToken)));
      log(`  ${orders.length} lab orders`);
      for (const order of orders) {
        if (!order.hasDetail || !order.refToken) continue;
        const rel = `lab-orders/details/${stem(isoDate(order.issuanceDate), safeTitle(order.ref.ord, 40) || shortHash(order.ref.ord))}.json`;
        if (await sink.exists(rel)) {
          count(rel);
          continue;
        }
        try {
          await sleep(pace);
          await putJson(rel, wrap("lab-order", await client.getLabOrder(order.refToken), { list: withoutToken(order) }));
        } catch (e) {
          if (e instanceof ReauthenticationRequired) throw e;
          problem(rel, e);
        }
      }
    } catch (e) {
      if (e instanceof ReauthenticationRequired) throw e;
      problem("lab-orders/list.json", e);
    }
    }

    // ---- documents: visit summaries, hospital summaries, medical approvals, Form 17 ----
    for (const source of DOCUMENT_SOURCES) {
      if (!wanted(source.id)) continue;
      const folder = `documents/${source.id}`;
      log(source.id);
      let rows: DocumentListItem[];
      try {
        await sleep(pace);
        // Each source is searched over the whole range the portal allows; --from/--to filter labs only.
        rows = await client.listDocuments(source.id);
        await putList(`${folder}/list.json`, rows, wrap("document-list", rows.map(withoutToken), { title: source.title }));
        log(`  ${rows.length} ${rows.length === 1 ? "document" : "documents"}`);
      } catch (e) {
        if (e instanceof ReauthenticationRequired) throw e;
        problem(`${folder}/list.json`, e);
        continue;
      }
      if (!documents) continue;
      const seenDocs = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        let name = stem(isoDate(row.date), shortHash(row.ref.actionUrl, row.ref.actionData ?? ""), safeTitle(row.details.join("-")));
        if (seenDocs.has(name)) name += "-" + i;
        seenDocs.add(name);
        const pdf = `${folder}/files/${name}.pdf`;
        if (await sink.exists(pdf)) {
          count(pdf);
          continue;
        }
        try {
          await sleep(pace);
          const doc = await client.getDocument(row.refToken);
          await sink.putBytes(pdf, doc.bytes);
          count(pdf);
        } catch (e) {
          if (e instanceof ReauthenticationRequired) throw e;
          if (e instanceof ClalitError && e.code === "NO_DOCUMENT") withoutDocument += 1;
          else problem(pdf, e);
        }
        if ((i + 1) % 10 === 0 || i === rows.length - 1) log(`  ${i + 1}/${rows.length}`);
      }
    }

    // ---- records: diagnoses, sensitivities, medications, imaging, hospital visits and labs, referrals ----
    for (const source of ALL_RECORD_SOURCES) {
      if (!wanted(source.id)) continue;
      const folder = `records/${source.id}`;
      log(source.id);
      let rows: RecordRow[];
      // Rows that link to a result page (hospital labs) are read as each page of the list is rendered:
      // the portal re-issues those links on every render, so they are good only right then.
      let detailsDone = 0;
      const onPage =
        source.detail === "hospital_lab"
          ? async (pageRows: RecordRow[]) => {
              for (const row of pageRows) {
                const link = row.links?.find((l) => /HospitalsLabTestDetails\.aspx/i.test(l));
                if (!link) continue;
                const testNumber = row.fields["מספר הבדיקה"] ?? "";
                const name = stem(isoDate(row.date), shortHash(row.context?.value ?? "", row.date ?? "", testNumber, row.fields["תחום המעבדה"] ?? ""), safeTitle(Object.values(row.fields).slice(0, 3).join("-")));
                const rel = `${folder}/details/${name}.json`;
                if (await sink.exists(rel)) {
                  count(rel);
                  continue;
                }
                try {
                  await sleep(pace);
                  const detail = await client.getHospitalLabResult({ link });
                  await putJson(rel, wrap("hospital-lab-result", detail, { list: withoutToken(row) }));
                  detailsDone++;
                } catch (e) {
                  if (e instanceof ReauthenticationRequired) throw e;
                  problem(rel, e);
                }
              }
              if (detailsDone) log(`  ${detailsDone} results read so far`);
            }
          : undefined;
      try {
        await sleep(pace);
        rows = await client.listRecords(source.id, onPage ? { onPage } : {});
        if (!(await putList(`${folder}/list.json`, rows, wrap("record-list", rows.map(withoutToken), { title: source.title, ...(source.notes ? { notes: source.notes } : {}) })))) continue;
        log(`  ${rows.length} ${rows.length === 1 ? "row" : "rows"}`);
      } catch (e) {
        if (e instanceof ReauthenticationRequired) throw e;
        problem(`${folder}/list.json`, e);
        continue;
      }
      if (!documents) continue;
      const seenPdfs = new Set<string>();
      const withPdf = rows.filter((r) => r.refToken && r.ref);
      for (let i = 0; i < withPdf.length; i++) {
        const row = withPdf[i]!;
        let name = stem(isoDate(row.date), shortHash(row.ref!.actionUrl, row.ref!.actionData ?? ""), safeTitle(Object.values(row.fields).slice(0, 3).join("-")));
        if (seenPdfs.has(name)) name += "-" + i;
        seenPdfs.add(name);
        const pdf = `${folder}/files/${name}.pdf`;
        if (await sink.exists(pdf)) {
          count(pdf);
          continue;
        }
        try {
          await sleep(pace);
          const doc = await client.getRecordDocument(row.refToken!);
          await sink.putBytes(pdf, doc.bytes);
          count(pdf);
        } catch (e) {
          if (e instanceof ReauthenticationRequired) throw e;
          if (e instanceof ClalitError && e.code === "NO_DOCUMENT") withoutDocument += 1;
          else problem(pdf, e);
        }
        if ((i + 1) % 10 === 0 || i === withPdf.length - 1) log(`  ${i + 1}/${withPdf.length} PDFs`);
      }
    }
  } catch (e) {
    if (!(e instanceof ReauthenticationRequired)) throw e;
    stopped = true;
    problem("session", "the Clalit session ended; what was collected is kept. Sign in again and rerun into the same folder.");
  }

  await sink.putJson("export-errors.json", problems);
  await sink.putText("README.md", readme({ startedAt, folders, problems, stopped, fromDate, toDate, documents, withoutDocument }));
  await sink.putText("CLAUDE.md", "This folder's instructions are in README.md, beside this file:\n\n@README.md\n");
  await sink.putText("AGENTS.md", "Read README.md, beside this file, before anything else, and follow it: it is this folder's\ninstructions — what the export holds, what it lacks and how its records are shaped.\n");
  return { folders, problems, stopped, withoutDocument };
}

function readme(r: { startedAt: string; folders: Record<string, number>; problems: ExportProblem[]; stopped: boolean; fromDate: string; toDate: string; documents: boolean; withoutDocument: number }): string {
  const has = (f: string) => (r.folders[f] ?? 0) > 0;
  const failedIn = new Set(r.problems.map((p) => p.where.split("/")[0]));
  const missing = ["labs", "prescriptions", "lab-orders", "documents", "records"].filter((f) => !has(f));
  const files = (n: number | undefined) => `${n ?? 0} ${n === 1 ? "file" : "files"}`;
  const absent = missing.map((f) => `\`${f}/\`` + (failedIn.has(f) ? " (collecting it failed — see export-errors.json)" : " (nothing on record, or not reached)")).join(", ");
  return `# Clalit health records export

> **Member:** this folder is a copy of your own records from Clalit Online (e-services.clalit.co.il), made by
> clalit-mcp. Open the whole folder in an AI assistant to ask about it; keep it somewhere safe — it is not encrypted.
> Anything you open in an AI assistant is sent to its provider and handled under that provider's privacy terms.

Exported ${israelDate(Date.parse(r.startedAt))} by clalit-mcp ${PACKAGE_VERSION}, export layout ${EXPORT_LAYOUT}; everything here belongs to one member.
${r.stopped ? "\n**This export was cut short**: the session ended before it finished. What is here is complete for the files it holds; the rest was not collected.\n" : ""}
## How to read this export

- Every JSON file is a record as this client parsed it from the portal's page, wrapped with \`source\`, \`kind\`,
  \`fetched_at\` (UTC) and \`data\`. \`result\`, \`referenceRange\` and \`notes\` are the portal's text; \`value\`,
  \`units\`, \`rangeMin\`, \`rangeMax\` and \`flag\` are parsed from it.
- Dates in the records are \`dd.MM.yyyy\`, as the portal shows them; file names use \`yyyy-mm-dd\`.
- Cite the file a fact comes from. Say plainly when something needs a doctor; this is a copy of records, not advice.

## What is here
${has("labs") ? `
**\`labs/\`** · ${files(r.folders.labs)} — laboratory results from ${r.fromDate} to ${r.toDate} (the range asked of the
portal; the portal's own default is far shorter). \`list.json\` is every row of the results list (\`data[]\`: \`date\`,
\`name\` (the lab section), \`doctor\`, \`testNumber\`, \`summary\`, \`hasDetail\`, \`ref\`).
\`details/<date>_<id>_<name>.json\` is one result:
\`data.analytes[]\` with \`name\`, \`result\` (the text as shown, unit included: \`113 %\`, \`0.52 Negative\`, \`FEW\`),
\`value\` (its leading number), \`units\`, \`qualifier\` when present, \`referenceRange\`, \`rangeMin\`/\`rangeMax\` (numbers),
\`flag\` (\`L\` or \`H\` only), and \`turnaround\`, \`explanation\`, \`compare\` when the page has them; \`data.date\`,
\`data.time\`, \`data.testNumber\` from the header, \`data.notes[]\` the lab's remarks, \`list\` the row it came from.${r.documents ? ` \`files/<same name>.pdf\` is the portal's own PDF of the result where it offers one${r.withoutDocument ? ` (${r.withoutDocument} ${r.withoutDocument === 1 ? "result has" : "results have"} none)` : ""}; a result without one says \`hasDocument: false\` in its detail, and that is not an error.` : ""}` : ""}
${has("prescriptions") ? `
**\`prescriptions/\`** · ${files(r.folders.prescriptions)} — \`list.json\`: prescriptions with their medicines
(\`prescriptionNo\`, \`prescriberName\` when shown, \`medicines[]\` with \`medicineId\`, \`medicineName\`, \`medicineFormName\`,
\`medicineStartDate\`), expired ones included. A prescription says what was prescribed, not what is taken.` : ""}
${has("lab-orders") ? `
**\`lab-orders/\`** · ${files(r.folders["lab-orders"])} — \`list.json\`: referrals for laboratory tests (\`issuanceDate\`,
\`referer\`, \`validTo\`); \`details/\`: the tests each order lists (\`data.items[]\`).` : ""}
${has("documents") ? `
**\`documents/\`** · ${files(r.folders.documents)} — one folder per portal source, each with \`list.json\` (\`data[]\`: \`date\`,
\`details[]\` — the row's cells as shown: doctor, specialty, hospital, type…) and${r.documents ? " \`files/<date>_<id>_<details>.pdf\`, the portal's own PDF of each" : " no PDFs (--no-documents)"}:
\`visit_summaries/\` סיכומי ביקור רפואה יועצת (specialist visit summaries), \`hospital_summaries/\` סיכומים מבתי חולים
(hospital discharge and summary letters; the first detail is the hospital), \`medical_approvals/\` אישורים רפואיים
(medical certificates and approvals), \`form17/\` התחייבויות — Form 17 commitments, which the portal keeps for one year only.
The PDFs are the clinical text; \`list.json\` only says which exist.` : ""}
${has("records") ? `
**\`records/\`** · ${files(r.folders.records)} — one folder per portal page, each with \`list.json\` (\`data[]\`: \`date\`, \`fields\` — the
row's cells keyed by the portal's own Hebrew column headers, \`cells\` in column order, \`items\` for a referral's services,
\`links\` when a row points at a detail page) and, where the portal offers one, \`files/<date>_<id>_<fields>.pdf\`:
\`diagnoses/\` האבחנות שלי, \`sensitivities/\` הרגישויות שלי (allergies and reactions), \`chronic_medications/\` תרופות קבועות
(the regular medication list), \`medicines_purchased/\` תרופות שנקנו (pharmacy purchases since 08.2008 — what was actually
dispensed), \`medication_approvals/\` אישורי תרופות, \`imaging_clinics/\` · \`imaging_hospitals/\` · \`imaging_external/\` פענוחי
דימות (imaging reports; the PDF is the radiologist's text), \`hospital_visits/\` ביקורים בבתי החולים של כללית, \`hospital_labs/\`
בדיקות מעבדה מבתי חולים (hospital lab tests, separate from \`labs/\`; \`details/\` holds each draw's analytes in the same shape as
\`labs/details/\`), \`referrals/\` הפניות (the last year only; the PDF is the referral), \`appointments/\` תורים עתידיים (the next
appointments: date, time, doctor or service), \`recommendations/\` המלצות רפואיות (the portal's own preventive-care recommendations
for this member, with their text), \`vaccinations/\` החיסונים שעשיתי and \`blood_type/\` סוג הדם (from the endpoints the portal's
own pages read; keys are the portal's field names).
Each \`list.json\` carries the portal's own \`notes\` on what that page leaves out.` : ""}
${missing.length ? `\nThis export has no ${absent}.\n` : ""}
## What is not here

Family-doctor visit notes (the portal exposes only specialist summaries), the images behind imaging reports (only the
radiologist's report), records from non-Clalit hospitals, and anything the portal marks sensitive or confidential: not here.
An absence here is not an absence in your history.

## What this export failed to collect

${r.problems.length ? r.problems.map((p) => `- \`${p.where}\`: ${p.what}`).join("\n") : "Nothing: every request was answered."}

\`export-errors.json\` holds the same list.
`;
}
