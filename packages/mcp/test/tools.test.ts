import { describe, expect, test } from "vitest";
import { TOOL_NAMES, listLabsSchema, refSchema } from "../src/tools.js";

describe("MCP tool surface", () => {
  test("MVP tools match plan", () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      ["get_lab_document", "get_lab_result", "list_labs"].sort(),
    );
    expect(listLabsSchema.parse({})).toEqual({});
    expect(refSchema.parse({ ref: "abc" }).ref).toBe("abc");
  });
});
