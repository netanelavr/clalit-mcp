/**
 * Export everything this client can read into one folder, so a member keeps a copy of their records
 * and can hand it whole to an assistant, a spreadsheet, or a database — instead of asking the MCP for
 * one record at a time while the session lasts.
 *
 * The folder's shape follows the one Health Records Export for Maccabi writes
 * (https://github.com/RoniRachmani/health-records-export-for-maccabi), so a reader that knows one
 * knows the other: a folder per section, `list.json` for the list, one file per record under
 * `details/`, documents under `files/`, and at the root a `README.md` that is the export's own data
 * dictionary, `export-errors.json` for what failed, and `CLAUDE.md` / `AGENTS.md` pointing at the
 * README. Every record is wrapped with where it came from and when.
 *
 * Reads only through the readers, so the owner-scope rules hold: refs come from the owner's own lists.
 * Requests are paced; an item that fails is filed and the export goes on; an ended session stops it,
 * and what was collected stays. A rerun into the same folder writes nothing it already has.
 */
import { createHash } from "node:crypto";
import { ReauthenticationRequired } from "../errors.js";
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
}

/** Where the files go. The CLI gives a folder; tests give memory. */
export interface ExportSink {
  exists(rel: string): Promise<boolean>;
  putJson(rel: string, value: unknown): Promise<void>;
  putBytes(rel: string, bytes: Uint8Array): Promise<void>;
  putText(rel: string, text: string): Promise<void>;
}

export interface ExportOptions {
  /** Labs list range, `dd.MM.yyyy`; the portal's default range is short, so the export asks for a wide one. */
  fromDate?: string;
  toDate?: string;
  /** Download each result's PDF (default true). */
  documents?: boolean;
  /** Expired prescriptions too (default true: an archive keeps history). */
  includeExpired?: boolean;
  /** Milliseconds between requests (default 300). */
  paceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Progress lines: section names, counts; never a value. */
  log?: (line: string) => void;
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

  try {
    // ---- labs ----
    log("labs");
    const labs = await client.listLabs({ fromDate, toDate });
    await putJson("labs/list.json", wrap("lab-list", labs, { range: { fromDate, toDate } }));
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
      if (await sink.exists(rel)) {
        count(rel);
      } else {
        try {
          await sleep(pace);
          const detail = await client.getLabResult(item.refToken);
          await putJson(rel, wrap("lab-result", detail, { list: item }));
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
        } else {
          try {
            await sleep(pace);
            const doc = await client.getLabDocument(item.refToken);
            await sink.putBytes(pdf, doc.bytes);
            count(pdf);
          } catch (e) {
            if (e instanceof ReauthenticationRequired) throw e;
            // A result without a document (the detail page offers no download) is not a failure: the detail says so.
            problem(pdf, e);
          }
        }
      }
      if ((i + 1) % 10 === 0 || i === labs.length - 1) log(`  ${i + 1}/${labs.length}`);
    }

    // ---- prescriptions ----
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

    // ---- lab orders ----
    log("lab-orders");
    try {
      await sleep(pace);
      const orders = await client.listLabOrders();
      await putJson("lab-orders/list.json", wrap("lab-order-list", orders));
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
          await putJson(rel, wrap("lab-order", await client.getLabOrder(order.refToken), { list: order }));
        } catch (e) {
          if (e instanceof ReauthenticationRequired) throw e;
          problem(rel, e);
        }
      }
    } catch (e) {
      if (e instanceof ReauthenticationRequired) throw e;
      problem("lab-orders/list.json", e);
    }
  } catch (e) {
    if (!(e instanceof ReauthenticationRequired)) throw e;
    stopped = true;
    problem("session", "the Clalit session ended; what was collected is kept. Sign in again and rerun into the same folder.");
  }

  await sink.putJson("export-errors.json", problems);
  await sink.putText("README.md", readme({ startedAt, folders, problems, stopped, fromDate, toDate, documents }));
  await sink.putText("CLAUDE.md", "This folder's instructions are in README.md, beside this file:\n\n@README.md\n");
  await sink.putText("AGENTS.md", "Read README.md, beside this file, before anything else, and follow it: it is this folder's\ninstructions — what the export holds, what it lacks and how its records are shaped.\n");
  return { folders, problems, stopped };
}

function readme(r: { startedAt: string; folders: Record<string, number>; problems: ExportProblem[]; stopped: boolean; fromDate: string; toDate: string; documents: boolean }): string {
  const has = (f: string) => (r.folders[f] ?? 0) > 0;
  const failedIn = new Set(r.problems.map((p) => p.where.split("/")[0]));
  const missing = ["labs", "prescriptions", "lab-orders"].filter((f) => !has(f));
  const absent = missing.map((f) => `\`${f}/\`` + (failedIn.has(f) ? " (collecting it failed — see export-errors.json)" : " (nothing on record, or not reached)")).join(", ");
  return `# Clalit health records export

> **Member:** this folder is a copy of your own records from Clalit Online (e-services.clalit.co.il), made by
> clalit-mcp. Open the whole folder in an AI assistant to ask about it; keep it somewhere safe — it is not encrypted.

Exported ${israelDate(Date.parse(r.startedAt))} by clalit-mcp ${PACKAGE_VERSION}, export layout ${EXPORT_LAYOUT}; everything here belongs to one member.
${r.stopped ? "\n**This export was cut short**: the session ended before it finished. What is here is complete for the files it holds; the rest was not collected.\n" : ""}
## How to read this export

- Every JSON file is a record as this client parsed it from the portal's page, wrapped with \`source\`, \`kind\`,
  \`fetched_at\` (UTC) and \`data\`. Nothing is interpreted: values, units, ranges and flags are the portal's own text.
- Dates in the records are as the portal shows them (\`dd/MM/yyyy\`); file names carry them as \`yyyy-mm-dd\`.
- Cite the file a fact comes from. Say plainly when something needs a doctor; this is a copy of records, not advice.

## What is here
${has("labs") ? `
**\`labs/\`** · ${r.folders.labs} files — laboratory results from ${r.fromDate} to ${r.toDate} (the range asked of the
portal; the portal's own default is far shorter). \`list.json\` is every row of the results list (\`data[]\`: \`date\`,
\`name\`, \`summary\`, \`hasDetail\`, \`ref\`). \`details/<date>_<id>_<name>.json\` is one result: \`data.analytes[]\` with
\`name\`, \`result\`, \`units\`, \`referenceRange\`, \`flag\` as displayed (a \`result\` can be text — NEGATIVE, <0.5),
\`data.notes[]\` the lab's remarks, \`list\` the row it came from.${r.documents ? " `files/<same name>.pdf` is the portal's own PDF of the result where it offers one." : ""}` : ""}
${has("prescriptions") ? `
**\`prescriptions/\`** · ${r.folders.prescriptions} file — \`list.json\`: prescriptions with their medicines
(\`prescriptionNo\`, \`prescriberName\`, \`medicines[]\` with \`medicineName\`, \`medicineStartDate\`), expired ones included. A
prescription says what was prescribed, not what is taken.` : ""}
${has("lab-orders") ? `
**\`lab-orders/\`** · ${r.folders["lab-orders"]} files — \`list.json\`: referrals for laboratory tests (\`issuanceDate\`,
\`referer\`, \`validTo\`); \`details/\`: the tests each order lists (\`data.items[]\`).` : ""}
${missing.length ? `\nThis export has no ${absent}.\n` : ""}
## What is not here

Visit summaries, imaging, vaccinations, letters, general referrals and the medical file: this client does not read them
(Clalit Online shows them, but no reader exists yet). An absence here is not an absence in your history.

## What this export failed to collect

${r.problems.length ? r.problems.map((p) => `- \`${p.where}\`: ${p.what}`).join("\n") : "Nothing: every request was answered."}

\`export-errors.json\` holds the same list.
`;
}
