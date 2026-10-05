import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ReauthenticationRequired } from "../src/errors.js";
import {
  decodeLabOrderRef,
  encodeLabOrderRef,
  parseLabOrdersListHtml,
} from "../src/lab-orders/list.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("parseLabOrdersListHtml", () => {
  test("parses own-record rows and opaque ord refs", () => {
    const html = readFileSync(join(fixtures, "lab-orders-list.html"), "utf8");
    const items = parseLabOrdersListHtml(html);
    expect(items).toHaveLength(2);
    expect(items[0]!.issuanceDate).toBe("10/03/2025");
    expect(items[0]!.referer).toBe("Clinic Example");
    expect(items[0]!.validTo).toBe("10/06/2025");
    expect(items[0]!.section).toBe("דם");
    expect(items[0]!.hasDetail).toBe(true);
    expect(items[0]!.ref).toEqual({ ord: "opaqueOrdToken1" });
    const token = encodeLabOrderRef(items[0]!.ref);
    expect(decodeLabOrderRef(token)).toEqual(items[0]!.ref);
  });

  test("returns empty array for empty chrome (NoLabOrdersFound)", () => {
    const html = readFileSync(join(fixtures, "lab-orders-list-empty.html"), "utf8");
    expect(parseLabOrdersListHtml(html)).toEqual([]);
  });

  test("Object moved + ReturnUrl LabOrderList is reauth, not empty list", () => {
    const html = `<html><head><title>Object moved</title></head><body>
<h2>Object moved to <a href="/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fServices%2fLabOrders%2fLabOrderList.aspx">here</a>.</h2>
</body></html>`;
    expect(() => parseLabOrdersListHtml(html)).toThrow(ReauthenticationRequired);
    try {
      parseLabOrdersListHtml(html);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toMatchObject({ code: "REAUTHENTICATION_REQUIRED" });
    }
  });

  test("garbage HTML without chrome is parse error", () => {
    try {
      parseLabOrdersListHtml("<html><body>nope</body></html>");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toMatchObject({ code: "LAB_ORDERS_LIST_SHAPE" });
    }
  });
});
