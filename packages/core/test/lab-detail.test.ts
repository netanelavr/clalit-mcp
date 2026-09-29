import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseLabDetailHtml } from "../src/labs/detail.js";
import { assertPdfBytes, buildLabDocument, filenameFromContentDisposition } from "../src/labs/document.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const ref = { s: "opaqueS1", d: "20250315", ls: "opaqueLS1" };

describe("parseLabDetailHtml", () => {
  test("extracts analytes and download event target", () => {
    const html = readFileSync(join(fixtures, "lab-detail.html"), "utf8");
    const detail = parseLabDetailHtml(html, ref);
    expect(detail.title).toContain("ספירת דם");
    expect(detail.analytes).toHaveLength(2);
    expect(detail.analytes[0]).toMatchObject({
      name: "המוגלובין",
      result: "14.2",
      units: "g/dL",
      referenceRange: "12.0-16.0",
    });
    expect(detail.hasDocument).toBe(true);
    expect(detail.documentEventTarget).toBe("ctl00$ctl00$cphBody$leftMenu$lnkDownloadPdf");
    expect(detail.notes[0]).toMatch(/תוצאה לדוגמה/);
  });
});

describe("lab document helpers", () => {
  test("accepts PDF magic and content-disposition", () => {
    const bytes = new Uint8Array(Buffer.from("%PDF-1.4 synthetic fixture"));
    assertPdfBytes(bytes);
    const doc = buildLabDocument(ref, bytes, "application/pdf", 'attachment; filename="lab.pdf"');
    expect(doc.filename).toBe("lab.pdf");
    expect(filenameFromContentDisposition(null, "fallback.pdf")).toBe("fallback.pdf");
  });

  test("rejects non-PDF", () => {
    expect(() => assertPdfBytes(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
