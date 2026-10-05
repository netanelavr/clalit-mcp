import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ReauthenticationRequired } from "../src/errors.js";
import {
  decodeLabRef,
  encodeLabRef,
  listVisibleLabPagerPages,
  nextLabPagerPage,
  parseLabsListHtml,
} from "../src/labs/list.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("parseLabsListHtml", () => {
  test("parses own-record rows and opaque refs", () => {
    const html = readFileSync(join(fixtures, "labs-list.html"), "utf8");
    const items = parseLabsListHtml(html);
    expect(items).toHaveLength(2);
    expect(items[0]!.name).toContain("ספירת דם");
    expect(items[0]!.date).toBe("15/03/2025");
    expect(items[0]!.hasDetail).toBe(true);
    expect(items[0]!.ref).toEqual({ s: "opaqueS1", d: "20250315", ls: "opaqueLS1" });
    const token = encodeLabRef(items[0]!.ref);
    expect(decodeLabRef(token)).toEqual(items[0]!.ref);
  });

  test("returns empty array for empty history chrome", () => {
    const html = `<html><body><form>בדיקות מעבדה LabsTestList
      <input type="hidden" name="__VIEWSTATE" value="x" />
      <table id="ctl00_ctl00_cphBody_bodyContent_LabsHistory1_gvTestListInDateRange">
        <tr><th>תאריך</th></tr>
      </table></form></body></html>`;
    expect(parseLabsListHtml(html)).toEqual([]);
  });

  test("Object moved + ReturnUrl LabsTestList is reauth, not empty list", () => {
    const html = `<html><head><title>Object moved</title></head><body>
<h2>Object moved to <a href="/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fServices%2fLabs%2fLabsTestList.aspx">here</a>.</h2>
</body></html>`;
    expect(() => parseLabsListHtml(html)).toThrow(ReauthenticationRequired);
    try {
      parseLabsListHtml(html);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toMatchObject({ code: "REAUTHENTICATION_REQUIRED" });
    }
  });

  test("does not treat ReturnUrl LabsTestList path alone as empty chrome", () => {
    const html =
      `<html><body>Object moved to Login.aspx?ReturnUrl=/OnlineWeb/Services/Labs/LabsTestList.aspx</body></html>`;
    expect(() => parseLabsListHtml(html)).toThrow(ReauthenticationRequired);
  });
});

describe("labs list pager helpers", () => {
  test("reads PagerLink ids with $ or _ separators", () => {
    const html = `
      <a id="ctl00_ctl00_cphBody_bodyContent_LabsHistory1_gvTestListInDateRange_PagerLink-2">2</a>
      <a href="javascript:__doPostBack('ctl00$ctl00$cphBody$bodyContent$LabsHistory1$gvTestListInDateRange$PagerLink-3','')">3</a>
    `;
    expect(listVisibleLabPagerPages(html)).toEqual([2, 3]);
    expect(nextLabPagerPage(html, 1)).toBe(2);
    expect(nextLabPagerPage(html, 2)).toBe(3);
    expect(nextLabPagerPage(html, 3)).toBeUndefined();
  });

  test("parses short grid id gvTestListInDateRange", () => {
    const html = `<html><body><form>
      <input type="hidden" name="__VIEWSTATE" value="x" />
      <table id="gvTestListInDateRange">
        <tr><th>תאריך</th><th>בדיקה</th></tr>
        <tr><td>01.02.2026</td><td><a href="/OnlineWeb/Services/Labs/LabTestDetails.aspx?s=opaqueS9&amp;d=20260201&amp;ls=opaqueLS9">בדיקה</a></td></tr>
      </table>
    </form></body></html>`;
    const items = parseLabsListHtml(html);
    expect(items).toHaveLength(1);
    expect(items[0]!.ref).toEqual({ s: "opaqueS9", d: "20260201", ls: "opaqueLS9" });
  });
});
