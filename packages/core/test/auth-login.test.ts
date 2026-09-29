import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ClalitAuth, CAPTCHA_CHECK_BUDGET_MS } from "../src/auth.js";
import { AuthenticationError } from "../src/errors.js";
import { ClalitTransport } from "../src/transport.js";
import { PATHS, PORTAL_ORIGIN } from "../src/constants.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const loginHtml = readFileSync(join(fixtures, "login-page.html"), "utf8");
const otpHtml = readFileSync(join(fixtures, "otp-page.html"), "utf8");

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
    ...init,
  });
}

describe("loginInteractive after CAPTCHA", () => {
  test("CAPTCHA_CHECK_BUDGET_MS is ~30s", () => {
    expect(CAPTCHA_CHECK_BUDGET_MS).toBe(30_000);
  });

  test("advances to OTP after captcha POST (redirect to OTP)", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("infootplogin.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(loginHtml);
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && init?.method === "POST") {
        return new Response(null, {
          status: 302,
          headers: { location: PATHS.otpSms },
        });
      }
      if (url.includes("OTPSMSVerification.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(otpHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && init?.method === "POST") {
        return new Response(null, {
          status: 302,
          headers: { location: PATHS.login },
        });
      }
      if (url.includes("Login.aspx")) {
        return htmlResponse("<html><body>portal</body></html>");
      }
      return new Response("unexpected", { status: 500 });
    };

    const auth = new ClalitAuth(new ClalitTransport({ fetch: fetchMock, minGapMs: 0 }));
    const session = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "123456",
    });
    expect(session.version).toBe(1);
    expect(calls.some((c) => c.startsWith("POST") && c.includes("infootplogin"))).toBe(true);
    expect(calls.some((c) => c.includes("OTPSMSVerification"))).toBe(true);
  });

  test("posts the answer only in tbCaptchaLogin and keeps BotDetect id", async () => {
    const html = `<!DOCTYPE html><html><body><form>
      <input type="hidden" name="__VIEWSTATE" value="VS" />
      <input type="hidden" name="__VIEWSTATEGENERATOR" value="G" />
      <input type="hidden" name="__EVENTVALIDATION" value="EV" />
      <input type="hidden" name="BDC_VCID_c_onlineweb_general_infootplogin_captchaLogin" value="captcha-instance-id" />
      <input type="text" name="tbUserId" />
      <input type="text" name="tbCaptchaLogin" />
      <img src="/BotDetectCaptcha.ashx?get=image&amp;c=captchaLogin" alt="CAPTCHA" />
    </form></body></html>`;
    let posted = "";
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("infootplogin.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(html);
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && init?.method === "POST") {
        posted = String(init.body ?? "");
        return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(otpHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && init?.method === "POST") {
        return new Response(null, { status: 302, headers: { location: PATHS.login } });
      }
      if (url.includes("Login.aspx")) return htmlResponse("<html><body>portal</body></html>");
      return new Response("unexpected", { status: 500 });
    };
    const auth = new ClalitAuth(new ClalitTransport({ fetch: fetchMock, minGapMs: 0 }));
    await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "123456",
    });
    const params = new URLSearchParams(posted);
    expect(params.get("tbCaptchaLogin")).toBe("AB12");
    expect(params.get("BDC_VCID_c_onlineweb_general_infootplogin_captchaLogin")).toBe(
      "captcha-instance-id",
    );
  });

  test("throws CAPTCHA_REJECTED when POST redisplays login CAPTCHA", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("infootplogin.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(loginHtml);
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && init?.method === "POST") {
        return htmlResponse(loginHtml); // wrong captcha → same form
      }
      return new Response("unexpected", { status: 500 });
    };

    const auth = new ClalitAuth(new ClalitTransport({ fetch: fetchMock, minGapMs: 0 }));
    await expect(
      auth.loginInteractive("123456789", {
        solveCaptcha: async () => "WRONG",
        readOtp: async () => "000000",
      }),
    ).rejects.toMatchObject({ code: "CAPTCHA_REJECTED" });
  });

  test("throws TIMEOUT when captcha POST hangs past transport abort", async () => {
    const hangUntilAbort = (signal?: AbortSignal | null): Promise<Response> =>
      new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
      });

    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("infootplogin.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(loginHtml);
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && init?.method === "POST") {
        return hangUntilAbort(init.signal);
      }
      return new Response("unexpected", { status: 500 });
    };

    const fast = new ClalitAuth(
      new ClalitTransport({ fetch: fetchMock, minGapMs: 0, timeoutMs: 50 }),
    );
    try {
      await fast.loginInteractive("123456789", {
        solveCaptcha: async () => "AB12",
        readOtp: async () => "123456",
      });
      throw new Error("expected timeout");
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
      // Transport TIMEOUT (50ms abort) or overall CAPTCHA_CHECK_TIMEOUT both acceptable.
      expect(["TIMEOUT", "CAPTCHA_CHECK_TIMEOUT"]).toContain(code);
    }
  });

  test("GET OTP page when POST body has no OTP markers", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.includes("infootplogin.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(loginHtml);
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([9]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && init?.method === "POST") {
        // Non-OTP HTML without captcha fields (e.g. interstitial)
        return htmlResponse("<html><body>please wait</body></html>");
      }
      if (url.includes("OTPSMSVerification.aspx")) {
        if (init?.method === "POST") {
          return new Response(null, { status: 302, headers: { location: PATHS.login } });
        }
        return htmlResponse(otpHtml);
      }
      if (url.includes("Login.aspx")) {
        return htmlResponse("<html><body>ok</body></html>");
      }
      return new Response("nope", { status: 404 });
    };

    const auth = new ClalitAuth(new ClalitTransport({ fetch: fetchMock, minGapMs: 0 }));
    await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "OK",
      readOtp: async () => "654321",
    });
    expect(calls).toContain(`GET ${PATHS.otpSms}`);
    expect(PORTAL_ORIGIN).toContain("clalit");
  });
});

describe("AuthenticationError messages", () => {
  test("CAPTCHA_REJECTED has actionable message", () => {
    const err = new AuthenticationError("CAPTCHA_REJECTED");
    expect(err.message).toMatch(/CAPTCHA was rejected/i);
  });
});
