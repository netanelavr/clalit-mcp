import { describe, expect, test } from "vitest";
import {
  TOOL_NAMES,
  listLabsSchema,
  listPrescriptionsSchema,
  prescriptionIssueStatusSchema,
  labOrderRefSchema,
  refSchema,
} from "../src/tools.js";

describe("MCP tool surface", () => {
  test("tools include labs + prescriptions + lab-orders", () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      [
        "get_lab_document",
        "get_lab_order",
        "get_lab_result",
        "get_prescription_issue_status",
        "list_lab_orders",
        "list_labs",
        "list_prescriptions",
      ].sort(),
    );
    expect(listLabsSchema.parse({})).toEqual({});
    expect(refSchema.parse({ ref: "abc" }).ref).toBe("abc");
    expect(listPrescriptionsSchema.parse({ includeExpired: true }).includeExpired).toBe(true);
    expect(
      prescriptionIssueStatusSchema.parse({
        prescriptionNo: "rx",
        medicationID: "med",
        medicationFormName: "TAB",
        medicationStartDate: "d",
        sectionId: "42",
      }).sectionId,
    ).toBe("42");
    expect(labOrderRefSchema.parse({ ref: "tok" }).ref).toBe("tok");
  });
});
