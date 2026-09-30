import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  summarizeLoginHtmlShape,
  summarizePostBodyKeys,
} from "../src/login-diagnostics.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("login diagnostics", () => {
  test("summarizes live-shaped login fixture without values", () => {
    const html = readFileSync(join(fixtures, "login-page.html"), "utf8");
    const shape = summarizeLoginHtmlShape(html);
    expect(shape.resolved.userIdField).toBe("ctl00$cphBody$tbUserId");
    expect(shape.resolved.captchaField).toBe("ctl00$cphBody$tbCaptchaLogin");
    expect(shape.resolved.loginEventTarget).toBe("ctl00$cphBody$btnSendOTP");
    expect(shape.botDetectFields.some((f) => f.name.startsWith("LBD_VCID"))).toBe(true);
    expect(shape.botDetectFields.every((f) => f.valueEmpty === false || f.valueEmpty === true)).toBe(
      true,
    );
    expect(shape.captchaImage?.queryKeys).toEqual(expect.arrayContaining(["get", "c", "t"]));
    expect(shape.captchaImage?.hasT).toBe(true);
    expect(JSON.stringify(shape)).not.toContain("fixture-instance-id");
  });

  test("post body summary is keys only", () => {
    const body =
      "__VIEWSTATE=SECRET&ctl00%24cphBody%24tbUserId=123456789&ctl00%24cphBody%24tbCaptchaLogin=AB12&__EVENTTARGET=ctl00%24cphBody%24btnSendOTP";
    const summary = summarizePostBodyKeys(body);
    expect(summary.keys).toContain("ctl00$cphBody$tbUserId");
    expect(summary.keys).toContain("__EVENTTARGET");
    expect(summary.sensitiveKeysRedacted).toEqual(
      expect.arrayContaining(["__VIEWSTATE", "ctl00$cphBody$tbUserId", "ctl00$cphBody$tbCaptchaLogin"]),
    );
    expect(JSON.stringify(summary)).not.toContain("SECRET");
    expect(JSON.stringify(summary)).not.toContain("123456789");
    expect(JSON.stringify(summary)).not.toContain("AB12");
  });
});
