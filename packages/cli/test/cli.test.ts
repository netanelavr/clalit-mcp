import { describe, expect, test } from "vitest";
import { COMMANDS, help, VERSION } from "../src/commands.js";

describe("CLI command catalog", () => {
  test("exposes labs MVP commands", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    for (const name of [
      "login",
      "labs",
      "lab",
      "lab-document",
      "prescriptions",
      "prescription-status",
      "lab-orders",
      "lab-order",
      "mcp",
      "logout",
    ]) {
      expect(COMMANDS[name]).toBeTruthy();
    }
    expect(help()).toContain("clalit-mcp");
    expect(help("labs")).toContain("LabsTestList");
    expect(help("prescriptions")).toContain("PatientPrescriptionsex");
    expect(help("lab-orders")).toContain("LabOrderList");
  });
});

describe("login --http help", () => {
  test("documents loopback browser login", () => {
    const text = help("login");
    expect(text).toContain("--http");
    expect(COMMANDS.login.options).toContain("http");
    expect(COMMANDS.login.usage).toContain("--http");
  });
});

describe("http-login pages", () => {
  test("escapeHtml and captcha page include CAPTCHA field", async () => {
    const { escapeHtml, captchaPage, idPage, otpPage } = await import("../src/http-login.js");
    expect(escapeHtml("<x>")).toBe("&lt;x&gt;");
    expect(idPage("csrf-token")).toContain("Israeli ID");
    expect(idPage("csrf-token")).toContain('name="id"');
    expect(captchaPage("csrf-token", { hasImage: true })).toContain("/captcha.png");
    expect(captchaPage("csrf-token", { hasImage: false })).toContain("CAPTCHA");
    expect(otpPage("csrf-token", "Enter SMS")).toContain('name="otp"');
  });
});
