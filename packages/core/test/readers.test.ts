import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ClalitReaders } from "../src/readers.js";
import type { ClalitTransport } from "../src/transport.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

class FakeTransport {
  assertNotIdleExpired(): void {}
  constructor(private readonly pages: Map<string, { html?: string; bytes?: Uint8Array; headers?: Record<string, string> }>) {}
  async request(input: string | URL): Promise<Response> {
    const url = String(input);
    for (const [key, value] of this.pages) {
      if (url.includes(key)) {
        if (value.bytes) {
          return new Response(Buffer.from(value.bytes), {
            status: 200,
            headers: { "content-type": "application/pdf", ...(value.headers ?? {}) },
          });
        }
        return new Response(value.html ?? "", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
    }
    return new Response("missing", { status: 404 });
  }
}

describe("ClalitReaders against fixtures", () => {
  test("listLabs + getLabResult + getLabDocument", async () => {
    const list = readFileSync(join(fixtures, "labs-list.html"), "utf8");
    const detail = readFileSync(join(fixtures, "lab-detail.html"), "utf8");
    const pdf = new Uint8Array(Buffer.from("%PDF-1.4 fixture-bytes"));
    const transport = new FakeTransport(
      new Map([
        ["LabsTestList.aspx", { html: list }],
        ["LabTestDetails.aspx", { html: detail }],
      ]),
    ) as unknown as ClalitTransport;

    const readers = new ClalitReaders(transport);
    const labs = await readers.listLabs();
    expect(labs).toHaveLength(2);
    expect(labs[0]!.refToken).toBeTruthy();

    const result = await readers.getLabResult(labs[0]!.refToken!);
    expect(result.analytes[0]!.name).toBe("המוגלובין");

    // document path: detail HTML then PDF response — swap map mid-flight via subclass
    let detailHits = 0;
    const docTransport = {
      assertNotIdleExpired(): void {},
      async request(input: string | URL, init?: RequestInit): Promise<Response> {
        const url = String(input);
        if (url.includes("LabTestDetails.aspx")) {
          detailHits += 1;
          if (init?.method === "POST") {
            return new Response(Buffer.from(pdf), {
              status: 200,
              headers: {
                "content-type": "application/octet-stream",
                "content-disposition": 'attachment; filename="blood-count.pdf"',
              },
            });
          }
          return new Response(detail, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("no", { status: 404 });
      },
    } as unknown as ClalitTransport;

    const docReaders = new ClalitReaders(docTransport);
    const doc = await docReaders.getLabDocument(labs[0]!.ref!);
    expect(doc.filename).toBe("blood-count.pdf");
    expect(Buffer.from(doc.bytes).toString("utf8").startsWith("%PDF")).toBe(true);
    expect(detailHits).toBeGreaterThanOrEqual(2);
  });
});
