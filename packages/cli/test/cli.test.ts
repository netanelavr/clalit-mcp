import { describe, expect, test } from "vitest";
import { COMMANDS, help, VERSION } from "../src/commands.js";

describe("CLI command catalog", () => {
  test("exposes labs MVP commands", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    for (const name of ["login", "labs", "lab", "lab-document", "mcp", "logout"]) {
      expect(COMMANDS[name]).toBeTruthy();
    }
    expect(help()).toContain("clalit-mcp");
    expect(help("labs")).toContain("LabsTestList");
  });
});
