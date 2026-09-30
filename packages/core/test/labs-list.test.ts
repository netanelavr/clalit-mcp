import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ReauthenticationRequired } from "../src/errors.js";
import { decodeLabRef, encodeLabRef, parseLabsListHtml } from "../src/labs/list.js";

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
