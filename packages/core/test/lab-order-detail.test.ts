import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseLabOrderDetailHtml } from "../src/lab-orders/detail.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const ref = { ord: "opaqueOrdToken1" };

describe("parseLabOrderDetailHtml", () => {
  test("extracts items grid and header chrome", () => {
    const html = readFileSync(join(fixtures, "lab-order-detail.html"), "utf8");
    const detail = parseLabOrderDetailHtml(html, ref);
    expect(detail.ref).toEqual(ref);
    expect(detail.labOrderId).toBe("opaqueLabOrderId1");
    expect(detail.validFrom).toBe("10/03/2025");
    expect(detail.validTo).toBe("10/06/2025");
    expect(detail.items).toHaveLength(2);
    expect(detail.items[0]).toMatchObject({
      section: "דם",
      testName: "ספירת דם כללית",
    });
    expect(detail.items[1]!.testName).toContain("כימיה");
  });
});
