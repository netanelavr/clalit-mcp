import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extractCaptchaImageUrl } from "../src/captcha.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("extractCaptchaImageUrl", () => {
  test("resolves BotDetect image from login fixture", () => {
    const html = readFileSync(join(fixtures, "login-page.html"), "utf8");
    const url = extractCaptchaImageUrl(html);
    expect(url).toBe(
      "https://e-services.clalit.co.il/BotDetectCaptcha.ashx?get=image&c=captchaLogin",
    );
  });

  test("returns undefined when no captcha image is present", () => {
    expect(extractCaptchaImageUrl("<html><body>no peektures</body></html>")).toBeUndefined();
  });
});
