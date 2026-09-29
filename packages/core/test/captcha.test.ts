import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  extractBotDetectFields,
  extractCaptchaImageUrl,
  extractSubmitFields,
  resolveBotDetectInstanceId,
} from "../src/captcha.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("extractCaptchaImageUrl", () => {
  test("resolves BotDetect image from login fixture", () => {
    const html = readFileSync(join(fixtures, "login-page.html"), "utf8");
    const url = extractCaptchaImageUrl(html);
    expect(url).toBe(
      "https://e-services.clalit.co.il/BotDetectCaptcha.ashx?get=image&c=captchaLogin&d=fixture-instance-id",
    );
  });

  test("returns undefined when no captcha image is present", () => {
    expect(extractCaptchaImageUrl("<html><body>no peektures</body></html>")).toBeUndefined();
  });
});

describe("BotDetect form fields", () => {
  test("extracts type=text BDC_VCID and submit button", () => {
    const html = `<form>
      <input type="text" name="BDC_VCID_c_onlineweb_general_infootplogin_captchaLogin" value="abc" />
      <input type="submit" name="btnLogin" value="Go" />
      <img src="/BotDetectCaptcha.ashx?get=image&amp;c=captchaLogin&amp;d=abc" />
    </form>`;
    expect(extractBotDetectFields(html)).toEqual({
      BDC_VCID_c_onlineweb_general_infootplogin_captchaLogin: "abc",
    });
    expect(extractSubmitFields(html)).toEqual({ btnLogin: "Go" });
    expect(
      resolveBotDetectInstanceId(
        html,
        "https://e-services.clalit.co.il/BotDetectCaptcha.ashx?get=image&c=captchaLogin&d=abc",
      ),
    ).toBe("abc");
  });
});
