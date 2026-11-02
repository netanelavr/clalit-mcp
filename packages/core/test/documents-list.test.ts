import { describe, expect, test } from "vitest";
import {
  decodeDocumentRef,
  DOCUMENT_SOURCE_IDS,
  encodeDocumentRef,
  parseDocumentsListHtml,
  selectOptions,
} from "../src/documents/index.js";

const GRID = `<table><tr><th>תאריך</th><th>רופא</th><th>תחום</th><th></th></tr>
<tr class="ClalitGridRow">
  <td><span>01.03.2026</span></td><td><span>ישראל ישראלי</span></td><td><span>רפואה כללית</span></td>
  <td class="ClalitGridActions"><ul><li><a class="VisitSummaryViewBtn GridBtn" href="javascript:void(0);"
    data-actionurl="/OnlineWeb/api/SummaryLetterPdf/DoesPdfExists/1/1?docId=123456">הצגה</a></li></ul></td>
</tr>
<tr class="ClalitGridAltRow">
  <td><span>01.02.2025</span></td><td><span>פלונית אלמונית</span></td><td><span>תחום לדוגמה</span></td>
  <td class="ClalitGridActions"><a class="GridBtn" data-actionurl="https://evil.example/steal">x</a></td>
</tr></table>
<select name="ddlHospitalName"><option value="0">בחר בית חולים</option><option value="999">בית חולים לדוגמה</option></select>`;

describe("document sources", () => {
  test("parses rows with portal action URLs only", () => {
    const rows = parseDocumentsListHtml(GRID, "visit_summaries");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe("01.03.2026");
    expect(rows[0]!.details).toEqual(["ישראל ישראלי", "רפואה כללית"]);
    expect(decodeDocumentRef(rows[0]!.refToken)).toEqual({
      source: "visit_summaries",
      actionUrl: "/OnlineWeb/api/SummaryLetterPdf/DoesPdfExists/1/1?docId=123456",
    });
  });

  test("refuses refs outside the portal API or for unknown sources", () => {
    expect(() =>
      decodeDocumentRef(encodeDocumentRef({ source: "visit_summaries", actionUrl: "https://evil.example/x" })),
    ).toThrow();
    expect(() =>
      decodeDocumentRef(encodeDocumentRef({ source: "nope", actionUrl: "/OnlineWeb/api/X/Y?docId=1" })),
    ).toThrow();
  });

  test("absolute portal URLs, POST action data and dd/MM/yyyy dates", () => {
    const html = `<table>
<tr class="ClalitGridRow"><td>01/01/2017</td><td>בית חולים</td><td class="ClalitGridActions">
  <a data-actionurl="https://e-services.clalit.co.il/onlineweb/api/SummaryLetterPdf/DoesPdfExists/2/1?docId=42">v</a></td></tr>
<tr class="ClalitGridRow"><td>01/03/2026</td><td class="ClalitGridActions">
  <a class="GridBtn" data-actionurl="/OnlineWeb/api/Form17/DoesPdfExists" data-actiondata='{"issueDate":"01/03/2026","tofes17No":"abc%252f"}'>v</a>
  <a class="GridBtnPrint" data-actionurl="/OnlineWeb/api/Form17/DoesPdfExists" data-actiondata='{"issueDate":"01/03/2026","tofes17No":"abc%252f"}'>p</a></td></tr>
<tr class="ClalitGridRow"><td>01/01/2026</td><td class="ClalitGridActions">
  <a data-actionurl="/OnlineWeb/api/Form17/DoesPdfExists" data-actiondata='{"nested":{"x":"y"}}'>v</a></td></tr>
</table>`;
    const rows = parseDocumentsListHtml(html, "form17");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date).toBe("01.01.2017");
    expect(rows[0]!.ref.actionUrl).toBe("/onlineweb/api/SummaryLetterPdf/DoesPdfExists/2/1?docId=42");
    expect(rows[1]!.date).toBe("01.03.2026");
    expect(decodeDocumentRef(rows[1]!.refToken).actionData).toBe('{"issueDate":"01/03/2026","tofes17No":"abc%252f"}');
  });

  test("fan-out options skip the placeholder", () => {
    expect(selectOptions(GRID, "ddlHospitalName")).toEqual([["999", "בית חולים לדוגמה"]]);
  });

  test("known sources", () => {
    expect(DOCUMENT_SOURCE_IDS).toContain("visit_summaries");
    expect(DOCUMENT_SOURCE_IDS).toContain("hospital_summaries");
    expect(DOCUMENT_SOURCE_IDS).toContain("medical_approvals");
    expect(DOCUMENT_SOURCE_IDS).toContain("form17");
  });
});
