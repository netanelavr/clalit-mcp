import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseLabDetailHtml, splitResult } from "../src/labs/detail.js";
import { assertPdfBytes, buildLabDocument, filenameFromContentDisposition } from "../src/labs/document.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const ref = { s: "opaqueS1", d: "20250315", ls: "opaqueLS1" };

describe("parseLabDetailHtml", () => {
  test("reads the live results grid: one analyte per row, the range from the bar, the flag from value and range", () => {
    const html = readFileSync(join(fixtures, "lab-detail.html"), "utf8");
    const detail = parseLabDetailHtml(html, ref);
    expect(detail.title).toBe("המטולוגיה");
    expect(detail.date).toBe("15.03.2025");
    expect(detail.time).toBe("08:15");
    expect(detail.testNumber).toBe("100000001");
    expect(detail.analytes.map((a) => a.name)).toEqual(["PT-INR", "PT %", "APTT-sec", "TOXOPLASMA IgG", "EPITHELIAL-SED"]);
    expect(detail.analytes[0]).toEqual({
      name: "PT-INR",
      result: "0.91",
      value: 0.91,
      turnaround: "1 ימי עבודה",
      compare: { labId: "opaqueLabId1", labName: "opaqueLabName1" },
      explanation: "שם הבדיקה בעברית: בדיקת קרישת דם INR\nהסבר כללי על הבדיקה, לדוגמה בלבד.",
    });
    expect(detail.analytes[1]).toMatchObject({ name: "PT %", result: "113 %", value: 113, units: "%", referenceRange: "85-150", rangeMin: 85, rangeMax: 150, turnaround: "1 ימי עבודה" });
    expect(detail.analytes[1]!.flag).toBeUndefined();
    expect(detail.analytes[2]).toMatchObject({ name: "APTT-sec", result: "35.8 Sec", value: 35.8, units: "Sec", referenceRange: "20.9-32.9", flag: "H" });
    expect(detail.analytes[3]).toMatchObject({ name: "TOXOPLASMA IgG", result: "0.52 Negative", value: 0.52, qualifier: "Negative" });
    expect(detail.analytes[3]!.units).toBeUndefined();
    expect(detail.analytes[4]).toEqual({ name: "EPITHELIAL-SED", result: "FEW", turnaround: "1 ימי עבודה" });
    // The bar's placeholders (8.99 / 9.99) and the explanation's close button are not analytes.
    expect(JSON.stringify(detail.analytes)).not.toContain("8.99");
    expect(JSON.stringify(detail.analytes)).not.toContain("סגירת הערות");
    expect(detail.notes).toEqual(["APTT-sec\nהדגימה המוליטית\nתוצאה לדוגמה בלבד"]);
    // The member's name and ID number in the header are not read.
    expect(JSON.stringify(detail)).not.toContain("פלונית");
    expect(JSON.stringify(detail)).not.toContain("000000000");
    expect(detail.hasDocument).toBe(true);
    expect(detail.documentEventTarget).toBe("ctl00$ctl00$cphLeftMenu$cphPageLeftMenu$ctl00$ctl00$ctl07");
  });

  test("reads a microbiology result from its own grid", () => {
    const html = readFileSync(join(fixtures, "lab-detail-micro.html"), "utf8");
    const detail = parseLabDetailHtml(html, { s: "opaqueS3", d: "20251011", ls: "opaqueLS3" });
    expect(detail.title).toBe("מיקרוביולוגיה");
    expect(detail.date).toBe("11.10.2025");
    expect(detail.analytes).toEqual([{ name: "Urine culture", result: "אין צמיחה", turnaround: "3 ימי עבודה" }]);
    expect(detail.documentEventTarget).toBe("ctl00$ctl00$cphLeftMenu$cphPageLeftMenu$ctl00$ctl00$ctl07");
  });

  test("still reads a plain name | result | units | range table", () => {
    const html = `<html><body><h1>ספירת דם</h1><table><tr><th>בדיקה</th><th>תוצאה</th></tr><tr><td>המוגלובין</td><td>14.2</td><td>g/dL</td><td>12.0-16.0</td><td></td></tr></table>
      <a id="ctl00_ctl00_cphBody_leftMenu_lnkDownloadPdf" href="javascript:__doPostBack('ctl00$ctl00$cphBody$leftMenu$lnkDownloadPdf','')">הורד PDF</a></body></html>`;
    const detail = parseLabDetailHtml(html, ref);
    expect(detail.title).toBe("ספירת דם");
    expect(detail.analytes).toEqual([{ name: "המוגלובין", result: "14.2", units: "g/dL", referenceRange: "12.0-16.0" }]);
    expect(detail.documentEventTarget).toBe("ctl00$ctl00$cphBody$leftMenu$lnkDownloadPdf");
  });

  test("splitResult", () => {
    expect(splitResult("113 %")).toEqual({ value: 113, units: "%" });
    expect(splitResult("10.6 Sec")).toEqual({ value: 10.6, units: "Sec" });
    expect(splitResult("0 /HPF")).toEqual({ value: 0, units: "/HPF" });
    expect(splitResult("0.52 Negative")).toEqual({ value: 0.52, qualifier: "Negative" });
    expect(splitResult("Negative")).toEqual({});
    expect(splitResult("<1")).toEqual({});
    expect(splitResult("1,023")).toEqual({ value: 1.023 });
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
