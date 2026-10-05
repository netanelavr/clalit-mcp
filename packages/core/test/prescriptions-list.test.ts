import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ReauthenticationRequired } from "../src/errors.js";
import {
  currentPrescriptionPagerPage,
  extractPrescriptionSectionId,
  listVisiblePrescriptionPagerPages,
  nextPrescriptionPagerPage,
  parsePrescriptionsListHtml,
} from "../src/prescriptions/list.js";
import {
  buildIssueDrugsRequestBody,
  parseIssueDrugsResponse,
} from "../src/prescriptions/issue-status.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("parsePrescriptionsListHtml", () => {
  test("parses own-record rows and nested medicines from data-*", () => {
    const html = readFileSync(join(fixtures, "prescriptions-list.html"), "utf8");
    const items = parsePrescriptionsListHtml(html);
    expect(items).toHaveLength(2);
    expect(items[0]!.prescriptionNo).toBe("opaqueRx1");
    expect(items[0]!.prescriptionDisplayNo).toBe("RX-OPAQUE-001");
    expect(items[0]!.prescriberName).toBe("Dr Example");
    expect(items[0]!.medicines).toHaveLength(2);
    expect(items[0]!.medicines[0]).toMatchObject({
      medicineId: "opaqueMed1",
      medicineFormName: "TAB",
      medicineStartDate: "01/01/2025",
      medicineName: "Example Drug Alpha",
    });
    expect(items[0]!.medicines[1]).toMatchObject({
      medicineId: "opaqueMed2",
      medicineFormName: "CAP",
      medicineStartDate: "01/01/2025",
      medicineName: "Example Drug Beta",
    });
    expect(items[1]!.prescriptionNo).toBe("opaqueRx2");
    expect(items[1]!.medicines[0]!.medicineName).toBe("Example Drug Gamma");
    expect(items[1]!.medicines[0]!.medicineStartDate).toBe("15/02/2025");
    expect(extractPrescriptionSectionId(html)).toBe("42");
  });

  test("returns empty array for empty prescriptions chrome", () => {
    const html = readFileSync(join(fixtures, "prescriptions-list-empty.html"), "utf8");
    expect(parsePrescriptionsListHtml(html)).toEqual([]);
  });

  test("Object moved + ReturnUrl PatientPrescriptions is reauth, not empty list", () => {
    const html = `<html><head><title>Object moved</title></head><body>
<h2>Object moved to <a href="/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fServices%2fMedicine%2fPatientPrescriptionsex.aspx">here</a>.</h2>
</body></html>`;
    expect(() => parsePrescriptionsListHtml(html)).toThrow(ReauthenticationRequired);
    try {
      parsePrescriptionsListHtml(html);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toMatchObject({ code: "REAUTHENTICATION_REQUIRED" });
    }
  });

  test("garbage HTML without chrome is parse error", () => {
    try {
      parsePrescriptionsListHtml("<html><body>nope</body></html>");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toMatchObject({ code: "PRESCRIPTIONS_LIST_SHAPE" });
    }
  });
});

describe("IssueDrugs helpers", () => {
  test("builds request JSON and parses double-encoded response", () => {
    const body = buildIssueDrugsRequestBody({
      prescriptionNo: "opaqueRx1",
      medicationID: "opaqueMed1",
      medicationFormName: "TAB",
      medicationStartDate: "01/01/2025",
      sectionId: "42",
    });
    expect(JSON.parse(body)).toEqual({
      prescriptionNo: "opaqueRx1",
      medicationID: "opaqueMed1",
      medicationFormName: "TAB",
      medicationStartDate: "01/01/2025",
      sectionId: "42",
      currStatusValue: "",
    });

    const wrapped = JSON.stringify(
      JSON.stringify({ statusCode_0: "0", statusDesc_0: "Example status only" }),
    );
    // simulate fetch.json() already parsing outer JSON once → string
    const once = JSON.parse(wrapped) as string;
    expect(parseIssueDrugsResponse(once)).toEqual({
      statusCode: "0",
      statusDesc: "Example status only",
    });
    // or raw object
    expect(parseIssueDrugsResponse({ statusCode_0: "1", statusDesc_0: "Other" })).toEqual({
      statusCode: "1",
      statusDesc: "Other",
    });
  });

  test("rejects incomplete request", () => {
    expect(() =>
      buildIssueDrugsRequestBody({
        prescriptionNo: "",
        medicationID: "x",
        medicationFormName: "TAB",
        medicationStartDate: "d",
        sectionId: "1",
      }),
    ).toThrow();
  });
});

describe("prescriptions gridPager helpers", () => {
  const page2Html = `<div class="OnlinePagerContainer">
    <input type="hidden" name="ctl00$ctl00$cphBody$bodyContent$gridPager$hiddenPager" id="ctl00_ctl00_cphBody_bodyContent_gridPager_hiddenPager" value="2" />
    <a class="PagerLink NextPrevLink" href="/OnlineWeb/Services/Medicine/PatientPrescriptionsex.aspx?a=1&page=1" onclick="document.getElementById('ctl00_ctl00_cphBody_bodyContent_gridPager_hiddenPager').value='1'; __doPostBack('ctl00$ctl00$cphBody$bodyContent$gridPager','1');return false;">הקודם</a>
    <a class="PagerLink PagerNumberLink" href="/OnlineWeb/Services/Medicine/PatientPrescriptionsex.aspx?a=1&page=1" title="1" onclick="__doPostBack('ctl00$ctl00$cphBody$bodyContent$gridPager','1');return false;">1</a>
    <span class="PagerDisabled ActivePage PagerNumberLink">2</span>
    <span class="PagerDisabled NextPrevLink">הבא</span>
  </div>`;

  const page1Html = `<div class="OnlinePagerContainer">
    <input type="hidden" name="ctl00$ctl00$cphBody$bodyContent$gridPager$hiddenPager" value="1" />
    <span class="PagerDisabled ActivePage PagerNumberLink">1</span>
    <a class="PagerLink PagerNumberLink" href="/OnlineWeb/Services/Medicine/PatientPrescriptionsex.aspx?a=1&page=2" title="2" onclick="__doPostBack('ctl00$ctl00$cphBody$bodyContent$gridPager','2');return false;">2</a>
    <a class="PagerLink NextPrevLink" href="/OnlineWeb/Services/Medicine/PatientPrescriptionsex.aspx?a=1&page=2" onclick="document.getElementById('ctl00_ctl00_cphBody_bodyContent_gridPager_hiddenPager').value='2'; __doPostBack('ctl00$ctl00$cphBody$bodyContent$gridPager','2');return false;">הבא</a>
  </div>`;

  test("reads current page and next from gridPager markup", () => {
    expect(currentPrescriptionPagerPage(page2Html)).toBe(2);
    expect(listVisiblePrescriptionPagerPages(page2Html)).toEqual([1, 2]);
    expect(nextPrescriptionPagerPage(page2Html, 2)).toBeUndefined();

    expect(currentPrescriptionPagerPage(page1Html)).toBe(1);
    expect(listVisiblePrescriptionPagerPages(page1Html)).toEqual([1, 2]);
    expect(nextPrescriptionPagerPage(page1Html, 1)).toBe(2);
  });
});
