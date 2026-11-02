import { describe, expect, test } from "vitest";
import {
  decodeRecordRef,
  encodeRecordRef,
  nextRecordPagerPage,
  parseApiJson,
  parseAppointmentsHtml,
  parseRecommendationsHtml,
  parseRecordGridHtml,
  parseReferralsHtml,
  RECORD_SOURCE_IDS,
  recordSource,
  referralsHaveNextPage,
} from "../src/records/index.js";
import { ClalitReaders } from "../src/readers.js";
import type { ClalitTransport } from "../src/transport.js";

// Fixtures follow the live grids' structure (tools/sitemap.mts --raw, Oct 2026) with made-up values.
const B = "ctl00_ctl00_cphBody_bodyContent_";

const DIAGNOSES = `<html><body><form><input type="hidden" name="__VIEWSTATE" value="vs"/>
<table class="ClalitGridTable" id="${B}DiagnosisGrid1_gvDiagnosis"><thead><tr>
<th>עודכן בתאריך</th><th>הרופא המאבחן</th><th>התמחות</th><th>שם האבחנה</th><th>פעולות</th></tr></thead><tbody>
<tr class="ClalitGridRow"><td><span>11.05.2025</span></td><td><span>ד"ר פלוני אלמוני</span></td><td><span>רופא משפחה</span></td><td><span>EXAMPLE DIAGNOSIS ONE</span></td><td class="ClalitGridActions"><ul><li></li></ul></td></tr>
<tr class=" DescBlockRow NoDisplay"><td class="DescBlockCell" colspan="5"><div class="ClalitGridDescriptionDiv">&nbsp;</div></td></tr>
<tr class="ClalitGridAltRow"><td><span>01.07.2013</span></td><td><span>עדכון מאגר</span></td><td><span>רופא משפחה</span></td><td><span>EXAMPLE DIAGNOSIS TWO</span></td><td class="ClalitGridActions"><ul><li></li></ul></td></tr>
</tbody></table></form></body></html>`;

const IMAGING = `<html><body><form><input type="hidden" name="__VIEWSTATE" value="vs"/>
<table id="${B}gvRentgenGrid_gvRentgenNew"><tr><th>תאריך הבדיקה</th><th>סוג הבדיקה</th><th>הגורם המפנה</th><th>סטטוס</th><th>פעולות</th><th></th></tr>
<tr class="ClalitGridRow"><td>17.05.2026</td><td>צילום ברך</td><td>רופא מפנה</td><td> קיים פענוח</td>
<td class="ClalitGridActions"><a class="GridBtn rentgen" data-actionurl="/OnlineWeb/api/Rentgen/GetPDFDocument/100000001/1000" data-lab-num="100000001" href="javascript:void(0);">צפייה בפענוח</a></td>
<td class="ClalitGridActions"><a class="WTClickRentgen" ProcedureNo="opaque==">צפייה בצילום</a></td></tr>
<tr class="ClalitGridAltRow"><td>28.10.2025</td><td>US בטן</td><td>רופא מפנה</td><td> אין פענוח</td><td class="ClalitGridActions"></td><td></td></tr>
</table></form></body></html>`;

const HOSPITAL_LABS = `<html><body><form><input type="hidden" name="__VIEWSTATE" value="vs"/>
<table class="ClalitGridTable"><tr><th>תאריך</th><th>בית חולים</th><th>מחלקה</th><th></th></tr>
<tr class="ClalitGridRow"><td>02.03.2024</td><td>בית חולים לדוגמה</td><td>המטולוגיה</td><td><a href="/OnlineWeb/Services/HospitalsLabs/HospitalsLabTestDetails.aspx?x=1">הצגה</a></td></tr>
</table></form></body></html>`;

const REFERRALS = `<html><body><form><input type="hidden" name="__VIEWSTATE" value="vs"/>
<div class="dataHead"><div class="textContainer"><div class="info title"><span title='5000000001'><span class='textInfo'>הפניה ל:</span><span class='medicalReferralheaderData'><bdi>בדיקה רפואית - אורתופדיה</bdi></span></span></div>
<div class="text"><span class="info"><span class='medicalReferralheaderData'>28.10.2026</span></span><span class="info"><span class='medicalReferralheaderData'>ד"ר פלוני אלמוני</span></span>
<span class="info"><span><span class='textInfo'>בתוקף עד</span><strong class='medicalReferralheaderData'>28.04.2027</strong></span></span></div></div>
<div class="buttons-container"><a class="GridBtnPrint" data-actionurl="/OnlineWeb/api/MedicalReferral/DoesPdfExists/5000000001">הדפסה</a><a class="GridBtn" data-actionurl="/OnlineWeb/api/MedicalReferral/DoesPdfExists/5000000001">הצגה</a></div></div>
<table class="ClalitGridTable GridInfoTable" id="medicalReferrals"><thead><tr><th>קוד שירות רפואי</th><th>השירות הרפואי</th><th>קוד משרד הבריאות</th><th>טופס 17</th><th>פעולות</th></tr></thead>
<tbody><tr class="ClalitGridRow"><td><span class="ThMovedToTd"></span> 70017 </td><td> בדיקה רפואית - אורתופדיה </td><td> L9249 </td><td><a><img/></a></td><td></td></tr></tbody></table>
<div class="ClalitGridPagerContainer"><a id="${B}MedicalReferralsList_btnNext" href="javascript:__doPostBack(&#39;ctl00$ctl00$cphBody$bodyContent$MedicalReferralsList$btnNext&#39;,&#39;&#39;)">הבא</a></div>
</form></body></html>`;

describe("record grids", () => {
  test("rows keep the portal's headers as keys and skip the hidden description rows", () => {
    const rows = parseRecordGridHtml(DIAGNOSES, "diagnoses");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: "diagnoses",
      date: "11.05.2025",
      fields: { "עודכן בתאריך": "11.05.2025", "הרופא המאבחן": 'ד"ר פלוני אלמוני', התמחות: "רופא משפחה", "שם האבחנה": "EXAMPLE DIAGNOSIS ONE" },
    });
    expect(rows[0]!.fields).not.toHaveProperty("פעולות");
    expect(rows[0]!.ref).toBeUndefined();
  });

  test("a row's PDF action becomes a validated ref; rows without one have none", () => {
    const rows = parseRecordGridHtml(IMAGING, "imaging_clinics");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.ref).toEqual({ source: "imaging_clinics", actionUrl: "/OnlineWeb/api/Rentgen/GetPDFDocument/100000001/1000" });
    expect(decodeRecordRef(rows[0]!.refToken!)).toEqual(rows[0]!.ref);
    expect(rows[0]!.fields["סוג הבדיקה"]).toBe("צילום ברך");
    expect(rows[1]!.ref).toBeUndefined();
    expect(rows[1]!.fields["סטטוס"]).toBe("אין פענוח");
  });

  test("detail-page links in a row are kept as portal paths", () => {
    const rows = parseRecordGridHtml(HOSPITAL_LABS, "hospital_labs");
    expect(rows[0]!.links).toEqual(["/OnlineWeb/Services/HospitalsLabs/HospitalsLabTestDetails.aspx?x=1"]);
  });

  test("a page without the grid is an empty list, a sign-in page is not", () => {
    expect(parseRecordGridHtml("<html><body><p>לא נמצאו תוצאות</p></body></html>", "diagnoses")).toEqual([]);
    // The portal's visible "temporary fault" in place of the results is an error, not an empty list; its hidden copy is not.
    expect(() => parseRecordGridHtml('<html><body><span id="x">תקלה זמנית. נסה שוב מאוחר יותר.</span></body></html>', "medicines_purchased")).toThrow(/temporary fault/);
    expect(parseRecordGridHtml('<html><body><span style="display:none">תקלה זמנית. נסה שוב מאוחר יותר.</span><p>לא נמצאו</p></body></html>', "medicines_purchased")).toEqual([]);
    expect(() => parseRecordGridHtml('<html><body><form action="/onlineweb/general/infootplogin.aspx"></form></body></html>', "diagnoses")).toThrow();
  });

  test("refs are refused outside the portal API or for unknown sources", () => {
    expect(() => decodeRecordRef(encodeRecordRef({ source: "imaging_clinics", actionUrl: "https://evil.example/x" }))).toThrow();
    expect(() => decodeRecordRef(encodeRecordRef({ source: "nope", actionUrl: "/OnlineWeb/api/X/Y" }))).toThrow();
  });

  test("the pager is read from the page", () => {
    const source = recordSource("medicines_purchased")!;
    const html = `<a href="javascript:__doPostBack(&#39;ctl00$ctl00$cphBody$bodyContent$MedicineSearchCustomGrid$PagerLink-2&#39;,&#39;&#39;)">2</a>`;
    expect(nextRecordPagerPage(html, source, 1)).toBe(2);
    expect(nextRecordPagerPage(html, source, 2)).toBeUndefined();
    expect(nextRecordPagerPage(html, recordSource("diagnoses")!, 1)).toBeUndefined();
  });

  test("known sources", () => {
    for (const id of ["diagnoses", "sensitivities", "chronic_medications", "medicines_purchased", "medication_approvals", "imaging_clinics", "imaging_hospitals", "imaging_external", "hospital_visits", "hospital_labs", "referrals"]) {
      expect(RECORD_SOURCE_IDS).toContain(id);
    }
  });
});

describe("referrals", () => {
  test("each referral keeps its header, its services and its PDF ref", () => {
    const rows = parseReferralsHtml(REFERRALS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "referrals",
      date: "28.10.2026",
      fields: { "הפניה ל": "בדיקה רפואית - אורתופדיה", תאריך: "28.10.2026", מפנה: 'ד"ר פלוני אלמוני', "בתוקף עד": "28.04.2027" },
      items: [{ "קוד שירות רפואי": "70017", "השירות הרפואי": "בדיקה רפואית - אורתופדיה", "קוד משרד הבריאות": "L9249" }],
      ref: { source: "referrals", actionUrl: "/OnlineWeb/api/MedicalReferral/DoesPdfExists/5000000001" },
    });
    expect(referralsHaveNextPage(REFERRALS)).toBe(true);
    expect(referralsHaveNextPage("<html></html>")).toBe(false);
  });
});

describe("ClalitReaders listRecords", () => {
  function portal(perHospital: Record<string, string[]>) {
    const posts: Array<Record<string, string>> = [];
    const transport = {
      assertNotIdleExpired(): void {},
      async request(_input: string | URL, init?: RequestInit): Promise<Response> {
        const page = (rows: string[]) =>
          new Response(
            `<html><form><input type="hidden" name="__VIEWSTATE" value="vs"/>
<select name="ctl00$ctl00$cphBody$bodyContent$ddlHospitalName"><option value="0">בחר בית חולים</option>${Object.keys(perHospital)
              .map((h, i) => `<option value="${i + 1}">${h}</option>`)
              .join("")}</select>
<table><tr><th>תאריך הבדיקה</th><th>סוג הבדיקה</th><th>פעולות</th></tr>${rows
              .map((d) => `<tr class="ClalitGridRow"><td>${d}</td><td>CT</td><td><a data-actionurl="/OnlineWeb/api/Rentgen/GetPDFDocument/${d.replace(/\./g, "")}/1000">v</a></td></tr>`)
              .join("")}</table></form></html>`,
            { status: 200, headers: { "content-type": "text/html" } },
          );
        if ((init?.method ?? "GET") === "GET") return page([]);
        const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
        posts.push(params);
        const hospital = Object.keys(perHospital)[Number(params["ctl00$ctl00$cphBody$bodyContent$ddlHospitalName"]) - 1]!;
        return page(perHospital[hospital] ?? []);
      },
    } as unknown as ClalitTransport;
    return { transport, posts };
  }

  test("a fan-out source searches every hospital and keeps the hospital with each row", async () => {
    const { transport, posts } = portal({ "בית חולים א": ["01.02.2024"], "בית חולים ב": ["03.04.2025", "05.06.2025"] });
    const rows = await new ClalitReaders(transport).listRecords("imaging_hospitals", { toDate: "31.12.2026" });
    expect(rows).toHaveLength(3);
    expect(rows[0]!.fields["בית חולים"]).toBe("בית חולים א");
    expect(rows[1]!.cells[0]).toBe("בית חולים ב");
    expect(rows[1]!.context).toEqual({ select: "ctl00$ctl00$cphBody$bodyContent$ddlHospitalName", value: "2" });
    expect(rows[1]!.ref?.actionUrl).toBe("/OnlineWeb/api/Rentgen/GetPDFDocument/03042025/1000");
    expect(posts).toHaveLength(2);
    expect(posts[0]!["__EVENTTARGET"]).toBe("ctl00$ctl00$cphBody$bodyContent$btnShow$lnkSubButton");
    expect(posts[0]!["ctl00$ctl00$cphBody$bodyContent$DatepickerRangeCalendar1$txtFromDate"]).toBe("01.01.2000");
  });
});

describe("pages of their own shape", () => {
  test("appointments: the home page's PopUpVisit calls, without the member's name and id", () => {
    const html = `<div onclick="javascript:PopUpVisit('ד&quot;ר פלונית','ישראל ישראלי','000000000','11111111-2222-3333-4444-555555555555','אולטרסאונד בטן','02.11.2026','11:20');"></div>
<div onclick="javascript:PopUpVisit('','ישראל ישראלי','000000000','66666666-7777-8888-9999-000000000000','בדיקת דם','05.11.2026','08:00');"></div>`;
    const rows = parseAppointmentsHtml(html);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ source: "appointments", date: "02.11.2026", fields: { תאריך: "02.11.2026", שעה: "11:20", "רופא/ה": 'ד"ר פלונית', שירות: "אולטרסאונד בטן" } });
    expect(JSON.stringify(rows)).not.toContain("000000000");
    expect(JSON.stringify(rows)).not.toContain("ישראל ישראלי");
    expect(rows[1]!.fields).not.toHaveProperty("רופא/ה");
  });

  test("recommendations: title, text and the updated date of each Measures panel", () => {
    const html = `<h2 aria-controls="ctl00_pnlContent"><a><span id="ctl00_ShowMeasure">המלצה רפואית בשבילך: חיסון נגד דלקת ריאות</span></a></h2>
<div id="ctl00_pnlContent"><p>אנחנו ממליצים לך להתחסן.<br>למה חשוב?<br>כי כן.</p><span><p>המלצה זו מעודכנת לתאריך&nbsp;<b>30.10.2026</b>. אם חוסנת בינתיים אנא עדכן את הרופא שלך.</p></span></div>`;
    const rows = parseRecommendationsHtml(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields["המלצה"]).toBe("חיסון נגד דלקת ריאות");
    expect(rows[0]!.fields["מעודכנת לתאריך"]).toBe("30.10.2026");
    expect(rows[0]!.date).toBe("30.10.2026");
    expect(rows[0]!.fields["טקסט"]).toContain("אנחנו ממליצים לך להתחסן.\nלמה חשוב?");
  });

  test("api json: a JSON string holding JSON, dates surfaced, nulls dropped", () => {
    const inner = JSON.stringify([
      { RecordId: 1, ExaminationDate: "/Date(1761868800000)/", ExaminationName: "SHINGRIX", ExaminationLocation: "מרפאה", ReportSource: null, GilYomiMonth: 940 },
      { RecordId: 2, ExaminationDate: "2024-10-15T00:00:00", ExaminationName: "FLU" },
    ]);
    const rows = parseApiJson(JSON.stringify(inner), "vaccinations");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ source: "vaccinations", date: "31.10.2025", fields: { ExaminationName: "SHINGRIX", ExaminationLocation: "מרפאה", GilYomiMonth: "940" } });
    expect(rows[0]!.fields).not.toHaveProperty("ReportSource");
    expect(rows[1]!.date).toBe("15.10.2024");
    expect(parseApiJson(JSON.stringify({ Status: 10206 }), "blood_type")).toEqual([{ source: "blood_type", fields: { Status: "10206" }, cells: ["10206"] }]);
    // The vaccinations endpoint answers an envelope whose Results is itself a JSON string.
    const envelope = JSON.stringify({ Results: JSON.stringify([{ RecordId: "1", ExaminationName: "VZV", ExaminationDate: "2026-10-28T10:59:00+02:00", GilYomiMonth: "78.7" }]), Status: "Success" });
    expect(parseApiJson(envelope, "vaccinations")).toEqual([
      { source: "vaccinations", date: "28.10.2026", fields: { RecordId: "1", ExaminationName: "VZV", ExaminationDate: "28.10.2026", GilYomiMonth: "78.7" }, cells: ["1", "VZV", "28.10.2026", "78.7"] },
    ]);
    expect(parseApiJson("null", "blood_type")).toEqual([]);
  });

  test("hospital lab rows keep their detail link resolved against the page", () => {
    const html = `<table class="ClalitGridTable" id="x_gvTestListInDateRange"><tr><th>תאריך</th><th>תחום</th><th></th></tr>
<tr class="ClalitGridRow"><td>02.09.2026</td><td>המטולוגיה</td><td><a href="HospitalsLabTestDetails.aspx?s=AA%3d%3d&amp;d=BB&amp;h=CC%3d">הצגה</a></td></tr></table>`;
    const rows = parseRecordGridHtml(html, "hospital_labs");
    expect(rows[0]!.links).toEqual(["/OnlineWeb/Services/HospitalsLabs/HospitalsLabTestDetails.aspx?s=AA%3d%3d&d=BB&h=CC%3d"]);
    expect(nextRecordPagerPage(`__doPostBack(&#39;ctl00$ctl00$cphBody$bodyContent$LabsHistory1$gvTestListInDateRange$PagerLink-2&#39;`, recordSource("hospital_labs")!, 1)).toBe(2);
  });
});
