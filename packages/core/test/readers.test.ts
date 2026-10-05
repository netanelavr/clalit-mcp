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

describe("ClalitReaders prescriptions + lab-orders fixtures", () => {
  test("listPrescriptions + getPrescriptionIssueStatus + listLabOrders + getLabOrder", async () => {
    const rxList = readFileSync(join(fixtures, "prescriptions-list.html"), "utf8");
    const loList = readFileSync(join(fixtures, "lab-orders-list.html"), "utf8");
    const loDetail = readFileSync(join(fixtures, "lab-order-detail.html"), "utf8");
    const issueJson = JSON.stringify(
      JSON.stringify({ statusCode_0: "0", statusDesc_0: "Example status only" }),
    );

    const transport = {
      assertNotIdleExpired(): void {},
      async request(input: string | URL, init?: RequestInit): Promise<Response> {
        const url = String(input);
        if (url.includes("IssueDrugsByPatientReceiptId")) {
          expect(init?.method).toBe("POST");
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
          expect(body.prescriptionNo).toBe("opaqueRx1");
          expect(body.medicationID).toBe("opaqueMed1");
          return new Response(JSON.parse(issueJson) as string, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("PatientPrescriptionsex.aspx")) {
          return new Response(rxList, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.includes("LabOrderDetails.aspx")) {
          return new Response(loDetail, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.includes("LabOrderList.aspx")) {
          return new Response(loList, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("missing", { status: 404 });
      },
    } as unknown as ClalitTransport;

    const readers = new ClalitReaders(transport);
    const rx = await readers.listPrescriptions();
    expect(rx).toHaveLength(2);
    expect(rx[0]!.medicines[0]!.medicineId).toBe("opaqueMed1");

    const status = await readers.getPrescriptionIssueStatus({
      prescriptionNo: "opaqueRx1",
      medicationID: "opaqueMed1",
      medicationFormName: "TAB",
      medicationStartDate: "01/01/2025xx",
      sectionId: "42",
    });
    expect(status).toEqual({ statusCode: "0", statusDesc: "Example status only" });

    const orders = await readers.listLabOrders();
    expect(orders).toHaveLength(2);
    expect(orders[0]!.refToken).toBeTruthy();

    const detail = await readers.getLabOrder(orders[0]!.refToken!);
    expect(detail.items[0]!.testName).toContain("ספירת דם");
  });
});

describe("ClalitReaders listLabs pagination", () => {
  function pageHtml(opts: {
    rows: Array<{ s: string; d: string; ls: string; name: string }>;
    pager: number[];
    viewState: string;
    from?: string;
    to?: string;
  }): string {
    const rows = opts.rows
      .map(
        (r) =>
          `<tr><td>01.01.2026</td><td><a href="/OnlineWeb/Services/Labs/LabTestDetails.aspx?s=${r.s}&amp;d=${r.d}&amp;ls=${r.ls}">${r.name}</a></td></tr>`,
      )
      .join("");
    const pager = opts.pager
      .map(
        (n) =>
          `<a id="ctl00_ctl00_cphBody_bodyContent_LabsHistory1_gvTestListInDateRange_PagerLink-${n}" href="javascript:__doPostBack('ctl00$ctl00$cphBody$bodyContent$LabsHistory1$gvTestListInDateRange$PagerLink-${n}','')">${n}</a>`,
      )
      .join("");
    const from = opts.from ?? "01.01.2026";
    const to = opts.to ?? "05.10.2026";
    return `<html><body><form>
      <input type="hidden" name="__VIEWSTATE" value="${opts.viewState}" />
      <input type="hidden" name="__VIEWSTATEGENERATOR" value="gen" />
      <input type="hidden" name="__EVENTVALIDATION" value="ev" />
      <input type="hidden" name="ctl00$ctl00$cphTopMenuRight$FamilySliderControl21$au" value="FAMILY_AU" />
      <input name="ctl00$ctl00$cphBody$bodyContent$LabsHistory1$datepickerRangeCalendar$txtFromDate" value="${from}" />
      <input name="ctl00$ctl00$cphBody$bodyContent$LabsHistory1$datepickerRangeCalendar$txtToDate" value="${to}" />
      <table id="gvTestListInDateRange">
        <tr><th>תאריך</th><th>בדיקה</th></tr>
        ${rows}
      </table>
      ${pager}
    </form></body></html>`;
  }

  test("walks LabsTestList pager and never posts family-slider fields", async () => {
    const bodies: string[] = [];
    const transport = {
      assertNotIdleExpired(): void {},
      async request(input: string | URL, init?: RequestInit): Promise<Response> {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return new Response(
            pageHtml({
              rows: [{ s: "s1", d: "d1", ls: "ls1", name: "A" }],
              pager: [2, 3],
              viewState: "vs1",
            }),
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        const body = String(init?.body ?? "");
        bodies.push(body);
        expect(body).not.toContain("FAMILY_AU");
        expect(body).not.toMatch(/FamilySliderControl\d+\$au/);
        const params = new URLSearchParams(body);
        const target = params.get("__EVENTTARGET") ?? "";
        if (target.endsWith("PagerLink-2")) {
          expect(params.get("__VIEWSTATE")).toBe("vs1");
          return new Response(
            pageHtml({
              rows: [{ s: "s2", d: "d2", ls: "ls2", name: "B" }],
              pager: [1, 3],
              viewState: "vs2",
            }),
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        if (target.endsWith("PagerLink-3")) {
          expect(params.get("__VIEWSTATE")).toBe("vs2");
          return new Response(
            pageHtml({
              rows: [{ s: "s3", d: "d3", ls: "ls3", name: "C" }],
              pager: [1, 2],
              viewState: "vs3",
            }),
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        throw new Error(`unexpected target ${target}`);
      },
    } as unknown as ClalitTransport;

    const labs = await new ClalitReaders(transport).listLabs();
    expect(labs.map((l) => l.name)).toEqual(["A", "B", "C"]);
    expect(bodies).toHaveLength(2);
  });

  test("date filter posts btnGetTestsAcc then pagers", async () => {
    const targets: string[] = [];
    const transport = {
      assertNotIdleExpired(): void {},
      async request(input: string | URL, init?: RequestInit): Promise<Response> {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return new Response(
            pageHtml({
              rows: [{ s: "s0", d: "d0", ls: "ls0", name: "old" }],
              pager: [],
              viewState: "vs0",
              from: "05.10.2024",
              to: "05.10.2026",
            }),
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        const params = new URLSearchParams(String(init?.body ?? ""));
        const target = params.get("__EVENTTARGET") ?? "";
        targets.push(target);
        expect(params.get("ctl00$ctl00$cphBody$bodyContent$LabsHistory1$datepickerRangeCalendar$txtFromDate")).toBe(
          "01.01.2026",
        );
        expect(params.get("ctl00$ctl00$cphBody$bodyContent$LabsHistory1$datepickerRangeCalendar$txtToDate")).toBe(
          "05.10.2026",
        );
        if (target.includes("btnGetTestsAcc")) {
          return new Response(
            pageHtml({
              rows: [{ s: "s1", d: "d1", ls: "ls1", name: "Jan" }],
              pager: [2],
              viewState: "vsFiltered",
              from: "01.01.2026",
              to: "05.10.2026",
            }),
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        if (target.endsWith("PagerLink-2")) {
          return new Response(
            pageHtml({
              rows: [{ s: "s2", d: "d2", ls: "ls2", name: "Feb" }],
              pager: [1],
              viewState: "vsLast",
              from: "01.01.2026",
              to: "05.10.2026",
            }),
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        throw new Error(`unexpected ${target}`);
      },
    } as unknown as ClalitTransport;

    const labs = await new ClalitReaders(transport).listLabs({
      fromDate: "01.01.2026",
      toDate: "05.10.2026",
    });
    expect(targets[0]).toContain("btnGetTestsAcc$lnkSubButton");
    expect(targets[1]).toContain("PagerLink-2");
    expect(labs.map((l) => l.name)).toEqual(["Jan", "Feb"]);
  });
});

describe("ClalitReaders listPrescriptions pagination", () => {
  function rxPage(opts: {
    rx: Array<{ no: string; med: string; form: string; start: string; name: string }>;
    page: number;
    pages: number[];
    viewState: string;
  }): string {
    const rows = opts.rx
      .map(
        (r, i) => `
      <div id="rptMedicine_ctl0${i}">
        <span id="colMedicineName">שם התרופה:</span><a id="colMedicineLink" href="#">${r.name}</a>
        <div data-prescription="${r.no}" data-medicineId="${r.med}" data-medicineFormName="${r.form}" data-medicineStartDate="${r.start}">
        </div>
      </div>`,
      )
      .join("");
    const links = opts.pages
      .map((n) =>
        n === opts.page
          ? `<span class="PagerDisabled ActivePage PagerNumberLink">${n}</span>`
          : `<a class="PagerLink PagerNumberLink" href="/OnlineWeb/Services/Medicine/PatientPrescriptionsex.aspx?page=${n}" onclick="__doPostBack('ctl00$ctl00$cphBody$bodyContent$gridPager','${n}');return false;">${n}</a>`,
      )
      .join(" ");
    return `<html><body><form>
      <input type="hidden" name="__VIEWSTATE" value="${opts.viewState}" />
      <input type="hidden" name="__VIEWSTATEGENERATOR" value="gen" />
      <input type="hidden" name="__EVENTVALIDATION" value="ev" />
      <input type="hidden" name="ctl00$ctl00$cphTopMenuRight$FamilySliderControl21$au" value="FAMILY_AU" />
      <input type="hidden" name="ctl00$ctl00$cphBody$bodyContent$gridPager$hiddenPager" value="${opts.page}" />
      <input type="hidden" name="ctl00$ctl00$cphBody$bodyContent$hdnSectionID" value="42" />
      ${rows}
      <div class="OnlinePagerContainer">${links}</div>
    </form></body></html>`;
  }

  test("walks gridPager with EVENTARGUMENT and skips family-slider fields", async () => {
    const bodies: string[] = [];
    const transport = {
      assertNotIdleExpired(): void {},
      async request(input: string | URL, init?: RequestInit): Promise<Response> {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return new Response(
            rxPage({
              rx: [{ no: "rx1", med: "m1", form: "TAB", start: "01/01/2025", name: "Alpha" }],
              page: 1,
              pages: [1, 2],
              viewState: "vs1",
            }),
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        const body = String(init?.body ?? "");
        bodies.push(body);
        expect(body).not.toContain("FAMILY_AU");
        const params = new URLSearchParams(body);
        expect(params.get("__EVENTTARGET")).toBe("ctl00$ctl00$cphBody$bodyContent$gridPager");
        expect(params.get("__EVENTARGUMENT")).toBe("2");
        expect(params.get("ctl00$ctl00$cphBody$bodyContent$gridPager$hiddenPager")).toBe("2");
        expect(params.get("__VIEWSTATE")).toBe("vs1");
        return new Response(
          rxPage({
            rx: [{ no: "rx2", med: "m2", form: "CAP", start: "02/02/2025", name: "Beta" }],
            page: 2,
            pages: [1, 2],
            viewState: "vs2",
          }),
          { status: 200, headers: { "content-type": "text/html" } },
        );
      },
    } as unknown as ClalitTransport;

    const items = await new ClalitReaders(transport).listPrescriptions();
    expect(items.map((i) => i.prescriptionNo)).toEqual(["rx1", "rx2"]);
    expect(bodies).toHaveLength(1);
  });
});
