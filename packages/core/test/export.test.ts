import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ReauthenticationRequired, UpstreamError } from "../src/errors.js";
import { exportAll, exportName, isoDate, safeTitle, shortHash, type ExportClient, type ExportSink } from "../src/export/index.js";
import { encodeLabRef, parseLabDetailHtml, parseLabsListHtml } from "../src/labs/index.js";
import { parseLabOrderDetailHtml, parseLabOrdersListHtml, encodeLabOrderRef } from "../src/lab-orders/index.js";
import { parsePrescriptionsListHtml } from "../src/prescriptions/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

class MemorySink implements ExportSink {
  files = new Map<string, string | Uint8Array>();
  async exists(rel: string) {
    return this.files.has(rel);
  }
  async putJson(rel: string, value: unknown) {
    this.files.set(rel, JSON.stringify(value, null, 2));
  }
  async putBytes(rel: string, bytes: Uint8Array) {
    this.files.set(rel, bytes);
  }
  async putText(rel: string, text: string) {
    this.files.set(rel, text);
  }
  json(rel: string): any {
    return JSON.parse(this.files.get(rel) as string);
  }
}

/** A client over the fixtures: every list row's ref answers with the one detail fixture. */
function fakeClient(opts: { failDocument?: boolean; noDocument?: boolean; endSessionAt?: number } = {}) {
  const calls: string[] = [];
  const labs = parseLabsListHtml(read("labs-list.html")).map((item) => ({ ...item, refToken: encodeLabRef(item.ref) }));
  const orders = parseLabOrdersListHtml(read("lab-orders-list.html")).map((item) => ({ ...item, refToken: item.hasDetail ? encodeLabOrderRef(item.ref) : undefined }));
  const client: ExportClient = {
    async listLabs(options) {
      calls.push("listLabs " + JSON.stringify(options));
      return labs;
    },
    async getLabResult(token) {
      calls.push("getLabResult");
      if (opts.endSessionAt !== undefined && calls.length >= opts.endSessionAt) throw new ReauthenticationRequired();
      const item = labs.find((l) => l.refToken === token)!;
      const detail = parseLabDetailHtml(read("lab-detail.html"), item.ref);
      if (opts.noDocument) {
        const { documentEventTarget: _t, ...rest } = detail;
        return { ...rest, hasDocument: false };
      }
      return detail;
    },
    async getLabDocument(token) {
      calls.push("getLabDocument");
      if (opts.noDocument) throw new UpstreamError("NO_DOCUMENT");
      if (opts.failDocument) throw new Error("The Clalit request could not be completed (network error).");
      const item = labs.find((l) => l.refToken === token)!;
      return { ref: item.ref, contentType: "application/pdf", filename: "lab.pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4 " + token.slice(0, 6))) };
    },
    async listPrescriptions(options) {
      calls.push("listPrescriptions " + JSON.stringify(options));
      return parsePrescriptionsListHtml(read("prescriptions-list.html"));
    },
    async listLabOrders() {
      calls.push("listLabOrders");
      return orders;
    },
    async getLabOrder(token) {
      calls.push("getLabOrder");
      const item = orders.find((o) => o.refToken === token)!;
      return parseLabOrderDetailHtml(read("lab-order-detail.html"), item.ref);
    },
  };
  return { client, calls, labs, orders };
}

const clock = { now: () => Date.parse("2026-10-14T10:00:00Z"), sleep: async () => {} };

describe("exportAll", () => {
  test("writes every section as the folder layout, with the root files, and asks for the whole history", async () => {
    const { client, calls, labs, orders } = fakeClient();
    const sink = new MemorySink();
    const log: string[] = [];
    const report = await exportAll(client, sink, { ...clock, log: (l) => log.push(l) });

    expect(calls[0]).toBe('listLabs {"fromDate":"01.01.1990","toDate":"14.10.2026"}');
    expect(report.problems).toEqual([]);
    expect(report.stopped).toBe(false);
    const names = [...sink.files.keys()].sort();
    expect(names.filter((n) => n.startsWith("labs/details/"))).toHaveLength(labs.filter((l) => l.hasDetail).length);
    expect(names.filter((n) => n.startsWith("labs/files/") && n.endsWith(".pdf"))).toHaveLength(labs.filter((l) => l.hasDetail).length);
    expect(names).toContain("labs/list.json");
    expect(names).toContain("prescriptions/list.json");
    expect(names).toContain("lab-orders/list.json");
    expect(names.filter((n) => n.startsWith("lab-orders/details/"))).toHaveLength(orders.filter((o) => o.hasDetail).length);
    // The session token stays out of the archive for lab orders too.
    const listedOrders = sink.json("lab-orders/list.json").data as Record<string, unknown>[];
    expect(listedOrders).toHaveLength(orders.length);
    for (const row of listedOrders) expect(row).not.toHaveProperty("refToken");
    for (const n of names.filter((n) => n.startsWith("lab-orders/details/"))) {
      expect(sink.json(n).list).toHaveProperty("ref");
      expect(sink.json(n).list).not.toHaveProperty("refToken");
    }
    for (const root of ["README.md", "export-errors.json", "CLAUDE.md", "AGENTS.md"]) expect(names).toContain(root);

    // File names: the list date as yyyy-mm-dd, a stable short id from the opaque ref, the test's name.
    const detail = names.filter((n) => n.startsWith("labs/details/")).at(-1)!; // sorted: the newest date last, the list's first row
    expect(detail).toMatch(/^labs\/details\/\d{4}-\d{2}-\d{2}_[0-9a-f]{8}_\S+\.json$/);
    const rec = sink.json(detail);
    expect(rec).toMatchObject({ source: "clalit-mcp", kind: "lab-result", fetched_at: "2026-10-14T10:00:00.000Z" });
    expect(rec.data.analytes[0]).toMatchObject({ name: "PT-INR", result: "0.91" });
    expect(rec.data.analytes[1]).toMatchObject({ name: "PT %", result: "113 %", units: "%" });
    expect(rec.list.ref).toEqual(labs[0]!.ref);
    // The session token stays out of the archive: rows keep only the opaque `ref`.
    expect(rec.list).not.toHaveProperty("refToken");
    const listed = sink.json("labs/list.json").data as Record<string, unknown>[];
    expect(listed).toHaveLength(labs.length);
    for (const row of listed) {
      expect(row).toHaveProperty("ref");
      expect(row).not.toHaveProperty("refToken");
    }
    expect(sink.json("export-errors.json")).toEqual([]);
    const readme = sink.files.get("README.md") as string;
    expect(readme).toContain("export layout 1");
    expect(readme).toContain("`labs/`");
    expect(readme).toContain("01.01.1990 to 14.10.2026");
    expect(readme).toContain("Nothing: every request was answered.");
    expect(report.folders).toMatchObject({ labs: 1 + 2 * labs.filter((l) => l.hasDetail).length, prescriptions: 1 });
    expect(log[0]).toBe("labs");

    // A rerun asks for nothing it already has.
    const before = calls.length;
    const again = await exportAll(client, sink, clock);
    expect(again.problems).toEqual([]);
    expect(calls.slice(before).filter((c) => c.startsWith("getLabResult") || c.startsWith("getLabDocument"))).toEqual([]);
  });

  test("a result the portal offers no PDF for is skipped without a request, on a rerun too, and is not a problem", async () => {
    const { client, calls, labs } = fakeClient({ noDocument: true });
    const withDetail = labs.filter((l) => l.hasDetail).length;
    const sink = new MemorySink();
    const report = await exportAll(client, sink, clock);
    expect(report.problems).toEqual([]);
    expect(report.withoutDocument).toBe(withDetail);
    expect(calls.filter((c) => c === "getLabDocument")).toEqual([]); // the detail already said so
    expect([...sink.files.keys()].filter((n) => n.startsWith("labs/files/"))).toEqual([]);
    expect([...sink.files.keys()].filter((n) => n.startsWith("labs/details/"))).toHaveLength(withDetail);
    expect(sink.json("export-errors.json")).toEqual([]);
    const readme = sink.files.get("README.md") as string;
    expect(readme).toContain(`(${withDetail} results have none)`);
    expect(readme).toContain("Nothing: every request was answered.");

    // A rerun has the details on disk, so it asks the reader, which answers NO_DOCUMENT: still not a problem.
    const again = await exportAll(client, sink, clock);
    expect(again.problems).toEqual([]);
    expect(again.withoutDocument).toBe(withDetail);
    expect(calls.filter((c) => c === "getLabDocument")).toHaveLength(withDetail);
  });

  test("files a document that fails to download as a problem and goes on; nothing from the record is in the problem", async () => {
    const { client, labs } = fakeClient({ failDocument: true });
    const sink = new MemorySink();
    const report = await exportAll(client, sink, clock);
    expect(report.withoutDocument).toBe(0);
    expect(report.problems).toHaveLength(labs.filter((l) => l.hasDetail).length);
    expect(report.problems[0]).toMatchObject({ what: "The Clalit request could not be completed (network error).", at: "2026-10-14T10:00:00.000Z" });
    expect(report.problems[0]!.where).toMatch(/^labs\/files\/.*\.pdf$/);
    expect([...sink.files.keys()].filter((n) => n.startsWith("labs/details/"))).toHaveLength(labs.filter((l) => l.hasDetail).length);
    expect(sink.files.get("README.md")).toContain("## What this export failed to collect\n\n- `labs/files/");
  });

  test("an ended session stops the export, keeps what was collected, and says so in the root files", async () => {
    const { client } = fakeClient({ endSessionAt: 4 });
    const sink = new MemorySink();
    const report = await exportAll(client, sink, clock);
    expect(report.stopped).toBe(true);
    expect(sink.files.has("labs/list.json")).toBe(true);
    expect(sink.files.has("prescriptions/list.json")).toBe(false);
    expect(report.problems.at(-1)).toMatchObject({ where: "session" });
    expect(sink.files.get("README.md")).toContain("cut short");
    expect(sink.files.get("README.md")).toContain("`prescriptions/`");
  });

  test("names", () => {
    expect(exportName(Date.parse("2026-10-14T23:30:00Z"))).toBe("clalit-export-2026-10-15"); // Israel is ahead of UTC
    expect(isoDate("15/03/2025")).toBe("2025-03-15");
    expect(isoDate("15.03.2025")).toBe("2025-03-15");
    expect(isoDate("20250315")).toBe("2025-03-15");
    expect(isoDate(undefined)).toBe("undated");
    expect(safeTitle("ספירת דם (CBC) / מלאה")).toBe("ספירת-דם-CBC-מלאה");
    expect(shortHash("a", "b")).toMatch(/^[0-9a-f]{8}$/);
    expect(shortHash("a", "b")).toBe(shortHash("a", "b"));
  });
});
