import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { ClalitAuth, CAPTCHA_CHECK_BUDGET_MS } from "../src/auth.js";
import { AuthenticationError, otpSessionIncompleteMessage } from "../src/errors.js";
import { extractOtpEventTarget } from "../src/captcha.js";
import { ClalitTransport } from "../src/transport.js";
import { PATHS, PORTAL_ORIGIN } from "../src/constants.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const loginHtml = readFileSync(join(fixtures, "login-page.html"), "utf8");
const otpHtml = readFileSync(join(fixtures, "otp-page.html"), "utf8");
const otpContinueHtml = readFileSync(join(fixtures, "otp-continue.html"), "utf8");
const otpContinueEntitiesHtml = readFileSync(join(fixtures, "otp-continue-entities.html"), "utf8");

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
    ...init,
  });
}

/** Response with multiple Set-Cookie lines (Headers.append — not a plain object). */
function responseWithSetCookies(
  body: string | null,
  init: { status?: number; location?: string; cookies: string[]; contentType?: string },
): Response {
  const headers = new Headers();
  if (init.contentType ?? body !== null) {
    headers.set("content-type", init.contentType ?? "text/html; charset=utf-8");
  }
  if (init.location) headers.set("location", init.location);
  for (const raw of init.cookies) {
    headers.append("set-cookie", raw);
  }
  return new Response(body, { status: init.status ?? 200, headers });
}



const DEFENSE_COOKIES = [
  "visid_incap_2919800=visid-fixture; Domain=.clalit.co.il; Path=/; HttpOnly",
  "incap_ses_1168_2919800=incap-fixture; Domain=.clalit.co.il; Path=/",
  "TS21fa3c30027=ts-fixture; Path=/",
];

const LABS_OK_HTML =
  "<html><body>LabsTestList LabsHistory __VIEWSTATE gvTestListInDateRange בדיקות מעבדה</body></html>";

/** Ensure successful login mocks satisfy fail-closed (defense cookies + Labs OK). */
function withFailClosedComplete(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("LabsTestList.aspx")) {
      return htmlResponse(LABS_OK_HTML);
    }
    const res = await inner(input, init);
    // Attach defense cookies on OTP POST if the mock did not already set Imperva/TS names.
    if (url.includes("OTPSMSVerification.aspx") && init?.method === "POST") {
      const existing = (() => {
        const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
        return typeof anyHeaders.getSetCookie === "function" ? anyHeaders.getSetCookie() : [];
      })();
      const names = existing.map((r) => r.split("=")[0] ?? "");
      const hasDefense = names.some(
        (n) =>
          /^visid_incap_/i.test(n) ||
          /^incap_ses_/i.test(n) ||
          /^TS[0-9a-f]/i.test(n) ||
          /^_cls_/i.test(n),
      );
      if (!hasDefense) {
        const headers = new Headers(res.headers);
        for (const raw of DEFENSE_COOKIES) headers.append("set-cookie", raw);
        const body = await res.arrayBuffer();
        return new Response(body, { status: res.status, statusText: res.statusText, headers });
      }
    }
    return res;
  };
}

function sessionCookieNames(session: { cookies: { cookies?: Array<{ key?: string }> } }): string[] {
  const list = session.cookies.cookies ?? [];
  return list.map((c) => c.key).filter((k): k is string => Boolean(k));
}

const prevConfigDir = process.env.CLALIT_CONFIG_DIR;

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLALIT_CONFIG_DIR;
  else process.env.CLALIT_CONFIG_DIR = prevConfigDir;
});

describe("loginInteractive after CAPTCHA", () => {
  test("CAPTCHA_CHECK_BUDGET_MS is ~30s", () => {
    expect(CAPTCHA_CHECK_BUDGET_MS).toBe(30_000);
  });

  test("login fixture POST uses UniqueIDs, LBD_VCID, and btnSendOTP event target", async () => {
    let posted = "";
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
    const auth = new ClalitAuth(new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }));
    await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "123456",
    });
    const params = new URLSearchParams(posted);
    expect(params.get("ctl00$cphBody$tbCaptchaLogin")).toBe("AB12");
    expect(params.get("ctl00$cphBody$tbUserId")).toBe("123456789");
    expect(params.get("tbCaptchaLogin")).toBeNull();
    expect(params.get("tbUserId")).toBeNull();
    expect(params.get("LBD_VCID_c_general_infootplogin_ctl00_cphbody_captchalogin")).toBe(
      "fixture-instance-id",
    );
    expect(params.get("__EVENTTARGET")).toBe("ctl00$cphBody$btnSendOTP");
    expect(params.get("ctl00$BottomMenuModalDialog$MyButtonCtrl")).toBeNull();
    expect(params.get("btnLogin")).toBeNull();
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

    const auth = new ClalitAuth(new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }));
    const session = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "123456",
    });
    expect(session.version).toBe(1);
    expect(calls.some((c) => c.startsWith("POST") && c.includes("infootplogin"))).toBe(true);
    expect(calls.some((c) => c.includes("OTPSMSVerification"))).toBe(true);
  });

  test("posts the answer only in captcha field and keeps BotDetect id (legacy short names)", async () => {
    const html = `<!DOCTYPE html><html><body><form>
      <input type="hidden" name="__VIEWSTATE" value="VS" />
      <input type="hidden" name="__VIEWSTATEGENERATOR" value="G" />
      <input type="hidden" name="__EVENTVALIDATION" value="EV" />
      <input type="hidden" name="BDC_VCID_c_onlineweb_general_infootplogin_captchaLogin" value="captcha-instance-id" />
      <input type="text" name="tbUserId" id="tbUserId" />
      <input type="text" name="tbCaptchaLogin" id="tbCaptchaLogin" />
      <input type="submit" name="btnLogin" value="Go" />
      <img src="/BotDetectCaptcha.ashx?get=image&amp;c=captchaLogin&amp;d=captcha-instance-id" alt="CAPTCHA" />
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
    const auth = new ClalitAuth(new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }));
    await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "123456",
    });
    const params = new URLSearchParams(posted);
    expect(params.get("tbCaptchaLogin")).toBe("AB12");
    expect(params.get("BDC_VCID_c_onlineweb_general_infootplogin_captchaLogin")).toBe(
      "captcha-instance-id",
    );
    expect(params.get("btnLogin")).toBe("Go");
  });

  test("throws CAPTCHA_REJECTED and writes redacted diagnostic dump", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "clalit-dump-"));
    process.env.CLALIT_CONFIG_DIR = dumpDir;

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

    const auth = new ClalitAuth(new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }));
    await expect(
      auth.loginInteractive("123456789", {
        solveCaptcha: async () => "WRONG",
        readOtp: async () => "000000",
      }),
    ).rejects.toMatchObject({ code: "CAPTCHA_REJECTED" });

    const dumps = readdirSync(dumpDir).filter((f) => f.startsWith("captcha-rejected-"));
    expect(dumps.length).toBe(1);
    const dump = JSON.parse(readFileSync(join(dumpDir, dumps[0]!), "utf8")) as {
      postBody: { keys: string[] };
      loginHtmlShape: { resolved: { userIdField?: string; loginEventTarget?: string } };
      captchaRejectHints: {
        hasHasOtpSetCookie: boolean;
        hasRedirectInfoToOnlineLogin: boolean;
        cvCaptchaDisplayNone: boolean;
        cvCaptchaVisibleRed: boolean;
      };
    };
    expect(dump.postBody.keys).toContain("ctl00$cphBody$tbUserId");
    expect(dump.postBody.keys).toContain("__EVENTTARGET");
    expect(dump.loginHtmlShape.resolved.userIdField).toBe("ctl00$cphBody$tbUserId");
    expect(dump.loginHtmlShape.resolved.loginEventTarget).toBe("ctl00$cphBody$btnSendOTP");
    expect(dump.captchaRejectHints.hasHasOtpSetCookie).toBe(false);
    expect(dump.captchaRejectHints.hasRedirectInfoToOnlineLogin).toBe(false);
    expect(dump.captchaRejectHints.cvCaptchaVisibleRed).toBe(false);
    const raw = readFileSync(join(dumpDir, dumps[0]!), "utf8");
    expect(raw).not.toContain("WRONG");
    expect(raw).not.toContain("123456789");
    expect(raw).not.toContain("/wEPDwUKLOGINVIEWSTATE");
  });


  test("HasOTP setCookie + redirectInfoToOnline follows Login.aspx to OTP", async () => {
    const hasOtpHtml = `<!DOCTYPE html><html><body><form>
      <input type="text" name="ctl00$cphBody$tbUserId" id="tbUserId" />
      <input type="text" name="ctl00$cphBody$tbCaptchaLogin" id="tbCaptchaLogin" />
      <img src="/BotDetectCaptcha.ashx?get=image&amp;c=x" alt="CAPTCHA" />
      <span id="cvClalitInfoCaptchaLogin" style="color:Red;display:none;">התווים לא זהים</span>
      <script>
      setCookie('HasOTP', '-otp-sms', 90);redirectInfoToOnline('/OnlineWeb/General/Login.aspx');
      </script>
    </form></body></html>`;
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
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
        // Success misclassified historically: 200 + captcha markup + HasOTP JS
        return htmlResponse(hasOtpHtml);
      }
      if (url.includes("Login.aspx") && (init?.method ?? "GET") === "GET") {
        // First Login.aspx after HasOTP → OTP; later (post-OTP) → portal home.
        if (!calls.some((c) => c.includes("OTPSMSVerification"))) {
          return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
        }
        return htmlResponse("<html><body>portal</body></html>");
      }
      if (url.includes("OTPSMSVerification.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(otpHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && init?.method === "POST") {
        return new Response(null, { status: 302, headers: { location: PATHS.login } });
      }
      return new Response("unexpected", { status: 500 });
    };

    const auth = new ClalitAuth(new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }));
    const session = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "OKOK",
      readOtp: async () => "123456",
    });
    expect(session.version).toBe(1);
    expect(calls).toContain(`GET ${PATHS.login}`);
    expect(calls.some((c) => c.includes("OTPSMSVerification"))).toBe(true);
    expect(calls.filter((c) => c.startsWith("POST") && c.includes("infootplogin")).length).toBe(1);
  });

  test("real captcha mismatch with visible Red validator throws CAPTCHA_REJECTED", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "clalit-dump-"));
    process.env.CLALIT_CONFIG_DIR = dumpDir;

    const mismatchHtml = `<!DOCTYPE html><html><body><form>
      <input type="text" name="ctl00$cphBody$tbUserId" id="tbUserId" />
      <input type="text" name="ctl00$cphBody$tbCaptchaLogin" id="tbCaptchaLogin" />
      <img src="/BotDetectCaptcha.ashx?get=image&amp;c=x" alt="CAPTCHA" />
      <span id="cvClalitInfoCaptchaLogin" role="alert" style="color:Red;">התווים לא זהים</span>
    </form></body></html>`;

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
        return htmlResponse(mismatchHtml);
      }
      return new Response("unexpected", { status: 500 });
    };

    const auth = new ClalitAuth(new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }));
    await expect(
      auth.loginInteractive("123456789", {
        solveCaptcha: async () => "WRONG",
        readOtp: async () => "000000",
      }),
    ).rejects.toMatchObject({ code: "CAPTCHA_REJECTED" });

    const dumps = readdirSync(dumpDir).filter((f) => f.startsWith("captcha-rejected-"));
    expect(dumps.length).toBe(1);
    const dump = JSON.parse(readFileSync(join(dumpDir, dumps[0]!), "utf8")) as {
      captchaRejectHints: {
        hasHasOtpSetCookie: boolean;
        hasRedirectInfoToOnlineLogin: boolean;
        cvCaptchaDisplayNone: boolean;
        cvCaptchaVisibleRed: boolean;
      };
    };
    expect(dump.captchaRejectHints.hasHasOtpSetCookie).toBe(false);
    expect(dump.captchaRejectHints.hasRedirectInfoToOnlineLogin).toBe(false);
    expect(dump.captchaRejectHints.cvCaptchaDisplayNone).toBe(false);
    expect(dump.captchaRejectHints.cvCaptchaVisibleRed).toBe(true);
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
      new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0, timeoutMs: 50 }),
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

    const auth = new ClalitAuth(new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }));
    await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "OK",
      readOtp: async () => "654321",
    });
    expect(calls).toContain(`GET ${PATHS.otpSms}`);
    expect(PORTAL_ORIGIN).toContain("clalit");
  });
});

describe("OTP Set-Cookie merge into exportSession", () => {
  test("fixture Set-Cookie on OTP POST + Login.aspx hops appear in exported session", async () => {
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
        return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(otpHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && init?.method === "POST") {
        // Live bug: auth cookies arrive on OTP POST Set-Cookie + redirect to Login.aspx
        return responseWithSetCookies(null, {
          status: 302,
          location: PATHS.login,
          cookies: [
            "ASP.NET_SessionId=session-from-otp; Path=/; HttpOnly; Secure; SameSite=Lax",
            "languageCode=he; Path=/; HttpOnly; Secure; SameSite=Lax",
            "HasOTP=-otp-sms; Path=/; Max-Age=7776000",
            "PortalAuth=portal-auth-token; Path=/; HttpOnly; Secure",
          ],
        });
      }
      if (url.includes("Login.aspx")) {
        return responseWithSetCookies("<html><body>portal home</body></html>", {
          status: 302,
          location: "/OnlineWeb/Services/Home/Default.aspx",
          cookies: [
            "ClalitPortal=portal-hop-cookie; Path=/; HttpOnly; Secure",
            "TS21fa3c30027=ts-token; Path=/",
          ],
        });
      }
      if (url.includes("Default.aspx")) {
        return responseWithSetCookies("<html><body>signed in</body></html>", {
          status: 200,
          cookies: ["ExtraPortal=extra; Path=/"],
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    const auth = new ClalitAuth(new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }));
    const session = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "123456",
    });

    const names = sessionCookieNames(session);
    expect(names.length).toBeGreaterThan(2);
    expect(names).toContain("HasOTP");
    expect(names).toContain("PortalAuth");
    expect(names).toContain("ClalitPortal");
    expect(names).toContain("TS21fa3c30027");
    expect(names).toContain("ExtraPortal");
    expect(names).toContain("ASP.NET_SessionId");
    // Never assert or print cookie values — names only.
  });

  test("OTP 200 Object-moved + Set-Cookie follows href and keeps cookies", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("infootplogin.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(loginHtml);
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && init?.method === "POST") {
        return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(otpHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && init?.method === "POST") {
        const body = `<html><head><title>Object moved</title></head><body>
<h2>Object moved to <a href="${PATHS.login}">here</a>.</h2></body></html>`;
        return responseWithSetCookies(body, {
          status: 200,
          cookies: [
            "ASP.NET_SessionId=otp-sess; Path=/",
            "languageCode=he; Path=/",
            "PostOtpAuth=from-object-moved; Path=/; HttpOnly",
          ],
        });
      }
      if (url.includes("Login.aspx")) {
        return responseWithSetCookies("<html><body>portal</body></html>", {
          status: 200,
          cookies: ["AfterLogin=1; Path=/"],
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    const auth = new ClalitAuth(new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }));
    const session = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "999999",
    });
    const names = sessionCookieNames(session);
    expect(names.length).toBeGreaterThan(2);
    expect(names).toContain("PostOtpAuth");
    expect(names).toContain("AfterLogin");
  });
});


describe("OTP fail-closed incomplete session", () => {
  test("rejects export when jar lacks Imperva/TS cookies after OTP", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "clalit-hops-"));
    process.env.CLALIT_CONFIG_DIR = dumpDir;

    // Bypass withFailClosedComplete — deliberately omit defense cookies.
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("infootplogin.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(loginHtml);
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && init?.method === "POST") {
        return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(otpHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && init?.method === "POST") {
        return responseWithSetCookies(null, {
          status: 302,
          location: PATHS.login,
          cookies: [
            "ASP.NET_SessionId=only-session; Path=/; HttpOnly; Secure",
            "languageCode=he; Path=/; HttpOnly; Secure",
          ],
        });
      }
      if (url.includes("Login.aspx")) {
        return htmlResponse("<html><body>portal</body></html>");
      }
      if (url.includes("LabsTestList.aspx")) {
        return htmlResponse(LABS_OK_HTML);
      }
      return new Response("unexpected", { status: 500 });
    };

    const auth = new ClalitAuth(new ClalitTransport({ fetch: fetchMock, minGapMs: 0 }));
    const thrown = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "123456",
    }).then(
      () => {
        throw new Error("expected OTP_SESSION_INCOMPLETE");
      },
      (err: unknown) => err,
    );
    expect(thrown).toMatchObject({ code: "OTP_SESSION_INCOMPLETE" });
    expect((thrown as Error).message).toMatch(/missing Imperva\/TS cookies/);
    expect((thrown as Error).message).not.toMatch(/LabsTestList still redirects/);

    const dumps = readdirSync(dumpDir).filter((f) => f.startsWith("login-hops-"));
    expect(dumps.length).toBe(1);
    const dump = JSON.parse(readFileSync(join(dumpDir, dumps[0]!), "utf8")) as {
      finalJarNames: string[];
      reason: string;
      hops: Array<{ setCookieNames: string[]; jarCookieNames: string[] }>;
    };
    expect(dump.reason).toBe("missing_portal_defense_cookies");
    expect(dump.finalJarNames).toEqual(
      expect.arrayContaining(["ASP.NET_SessionId", "languageCode"]),
    );
    expect(dump.finalJarNames.some((n) => /^visid_incap_/i.test(n))).toBe(false);
    const raw = readFileSync(join(dumpDir, dumps[0]!), "utf8");
    expect(raw).not.toContain("only-session");
    expect(raw).not.toContain("123456");
  });

  test("rejects when LabsTestList still 302→Login despite defense cookies", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "clalit-hops-"));
    process.env.CLALIT_CONFIG_DIR = dumpDir;

    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("infootplogin.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(loginHtml);
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && init?.method === "POST") {
        return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(otpHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && init?.method === "POST") {
        return responseWithSetCookies(null, {
          status: 302,
          location: PATHS.login,
          cookies: [
            "ASP.NET_SessionId=sess; Path=/",
            "languageCode=he; Path=/",
            ...DEFENSE_COOKIES,
          ],
        });
      }
      if (url.includes("Login.aspx")) {
        return htmlResponse("<html><body>portal</body></html>");
      }
      if (url.includes("LabsTestList.aspx")) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fServices%2fLabs%2fLabsTestList.aspx",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    const auth = new ClalitAuth(new ClalitTransport({ fetch: fetchMock, minGapMs: 0 }));
    const thrown = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "123456",
    }).then(
      () => {
        throw new Error("expected OTP_SESSION_INCOMPLETE");
      },
      (err: unknown) => err,
    );
    expect(thrown).toMatchObject({ code: "OTP_SESSION_INCOMPLETE" });
    expect((thrown as Error).message).toMatch(/LabsTestList still redirects/);
    expect((thrown as Error).message).toMatch(/PostOtpAuth/);
    expect((thrown as Error).message).not.toMatch(/missing Imperva/i);

    const dumps = readdirSync(dumpDir).filter((f) => f.startsWith("login-hops-"));
    expect(dumps.length).toBe(1);
    const dump = JSON.parse(readFileSync(join(dumpDir, dumps[0]!), "utf8")) as {
      reason: string;
      labsProbe: { loginRedirect: boolean; status: number };
    };
    expect(dump.reason).toBe("labs_login_redirect");
    expect(dump.labsProbe.loginRedirect).toBe(true);
    expect(dump.labsProbe.status).toBe(302);
  });

  test("Domain=.clalit.co.il defense cookies from OTP Set-Cookie appear in session", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("infootplogin.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(loginHtml);
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && init?.method === "POST") {
        return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && (init?.method ?? "GET") === "GET") {
        return htmlResponse(otpHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && init?.method === "POST") {
        return responseWithSetCookies(null, {
          status: 302,
          location: PATHS.login,
          cookies: [
            "ASP.NET_SessionId=sess; Path=/; HttpOnly; Secure",
            "languageCode=he; Path=/",
            "visid_incap_2919800=v; Domain=.clalit.co.il; Path=/; HttpOnly",
            "incap_ses_1168_2919800=i; Domain=.clalit.co.il; Path=/",
            "TS21fa3c30027=t; Path=/",
            "_cls_v=1; Domain=.clalit.co.il; Path=/; Secure; SameSite=None",
          ],
        });
      }
      if (url.includes("Login.aspx")) {
        return htmlResponse("<html><body>portal</body></html>");
      }
      if (url.includes("LabsTestList.aspx")) {
        return htmlResponse(LABS_OK_HTML);
      }
      return new Response("unexpected", { status: 500 });
    };

    const auth = new ClalitAuth(new ClalitTransport({ fetch: fetchMock, minGapMs: 0 }));
    const session = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "123456",
    });
    const names = sessionCookieNames(session);
    expect(names).toContain("visid_incap_2919800");
    expect(names).toContain("incap_ses_1168_2919800");
    expect(names).toContain("TS21fa3c30027");
    expect(names).toContain("_cls_v");
    const domains = (session.cookies.cookies ?? []).map((c) => ({
      key: (c as { key?: string }).key,
      domain: (c as { domain?: string }).domain,
    }));
    expect(domains.some((c) => c.key === "visid_incap_2919800" && c.domain === "clalit.co.il")).toBe(
      true,
    );
  });
});

describe("AuthenticationError messages", () => {
  test("CAPTCHA_REJECTED has actionable message", () => {
    const err = new AuthenticationError("CAPTCHA_REJECTED");
    expect(err.message).toMatch(/CAPTCHA was rejected/i);
  });
});

/** Live failure shape: OTP form still shown, embedded Login.aspx redirect, no auth cookies. */
const otpRedisplayHtml = `${otpContinueHtml}
<script>redirectInfoToOnline('/OnlineWeb/General/Login.aspx');</script>`;

describe("post-OTP hop patterns", () => {
  test("extractOtpEventTarget reads HTML-entity-encoded doPostBack quotes", () => {
    const html = `<a href="javascript:__doPostBack(&#39;ctl00$cphBody$btnContinue$lnkSubButton&#39;,&#39;&#39;)">x</a>`;
    expect(extractOtpEventTarget(html)).toBe("ctl00$cphBody$btnContinue$lnkSubButton");
    expect(extractOtpEventTarget(otpContinueEntitiesHtml)).toBe(
      "ctl00$cphBody$btnContinue$lnkSubButton",
    );
  });

  test("extractOtpEventTarget reads btnContinue LinkButton", () => {
    expect(extractOtpEventTarget(otpContinueHtml)).toBe("ctl00$cphBody$btnContinue$lnkSubButton");
    // Bare OTP page (txtClientOTP only) still falls back to the live LinkButton UniqueID.
    expect(extractOtpEventTarget(otpHtml)).toBe("ctl00$cphBody$btnContinue$lnkSubButton");
  });

  test("extractOtpEventTarget prefers btnContinue over modal &#39;-encoded lnkSubButton", () => {
    expect(extractOtpEventTarget(otpContinueEntitiesHtml)).toBe(
      "ctl00$cphBody$btnContinue$lnkSubButton",
    );
  });

  test("labs_login_redirect copy does not blame Imperva; missing-defense copy does", () => {
    expect(otpSessionIncompleteMessage("labs_login_redirect")).not.toMatch(/missing Imperva/i);
    expect(otpSessionIncompleteMessage("labs_login_redirect")).toMatch(/PostOtpAuth/);
    expect(otpSessionIncompleteMessage("missing_portal_defense_cookies")).toMatch(/Imperva/);
  });

  test("OTP form redisplay (200, no PostOtpAuth) does not cold-GET Login.aspx", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "clalit-hops-"));
    process.env.CLALIT_CONFIG_DIR = dumpDir;
    const requested: string[] = [];

    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requested.push(`${method} ${url}`);
      if (url.includes("infootplogin.aspx") && method === "GET") {
        return responseWithSetCookies(loginHtml, { cookies: DEFENSE_COOKIES });
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && method === "POST") {
        return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && method === "GET") {
        return htmlResponse(otpContinueHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && method === "POST") {
        // Failing live hop: 200, no Set-Cookie, form still present, chrome redirect.
        return htmlResponse(otpRedisplayHtml);
      }
      if (url.includes("Login.aspx")) {
        return responseWithSetCookies("<html><body>anonymous login</body></html>", {
          cookies: [
            ".ONLINEAUTH=cleared; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
            ".ONLINEAUTH=anon; Path=/; HttpOnly",
          ],
        });
      }
      if (url.includes("LabsTestList.aspx")) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fServices%2fLabs%2fLabsTestList.aspx",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    const auth = new ClalitAuth(new ClalitTransport({ fetch: fetchMock, minGapMs: 0 }));
    const thrown = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "123456",
    }).then(
      () => {
        throw new Error("expected OTP_SESSION_INCOMPLETE");
      },
      (err: unknown) => err,
    );
    expect(thrown).toMatchObject({ code: "OTP_SESSION_INCOMPLETE" });
    expect((thrown as Error).message).not.toMatch(/missing Imperva/i);
    expect((thrown as Error).message).toMatch(/PostOtpAuth/);
    expect(requested.some((r) => r.includes("Login.aspx"))).toBe(false);

    const dumps = readdirSync(dumpDir).filter((f) => f.startsWith("login-hops-"));
    expect(dumps.length).toBe(1);
    const dump = JSON.parse(readFileSync(join(dumpDir, dumps[0]!), "utf8")) as {
      reason: string;
      hops: Array<{ url: string; status: number; setCookieNames: string[] }>;
      finalJarNames: string[];
    };
    expect(dump.reason).toBe("labs_login_redirect");
    expect(dump.hops).toHaveLength(1);
    expect(dump.hops[0]!.status).toBe(200);
    expect(dump.hops[0]!.url).toMatch(/OTPSMSVerification/);
    expect(dump.hops[0]!.setCookieNames).not.toContain("PostOtpAuth");
    expect(dump.hops[0]!.setCookieNames).not.toContain("AfterLogin");
    expect(dump.finalJarNames).not.toContain(".ONLINEAUTH");
    expect(dump.finalJarNames).not.toContain("PostOtpAuth");
    const raw = readFileSync(join(dumpDir, dumps[0]!), "utf8");
    expect(raw).not.toContain("123456");
    expect(raw).not.toContain("anon");
  });

  test("btnContinue postback: Object-moved Set-Cookie PostOtpAuth then Login AfterLogin", async () => {
    process.env.CLALIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), "clalit-hops-"));
    let otpPosted = "";
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("infootplogin.aspx") && method === "GET") {
        return htmlResponse(loginHtml);
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && method === "POST") {
        return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && method === "GET") {
        return htmlResponse(otpContinueHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && method === "POST") {
        otpPosted = String(init?.body ?? "");
        const params = new URLSearchParams(otpPosted);
        if (params.get("__EVENTTARGET") !== "ctl00$cphBody$btnContinue$lnkSubButton") {
          return htmlResponse(otpRedisplayHtml);
        }
        const body = `<html><head><title>Object moved</title></head><body>
<h2>Object moved to <a href="${PATHS.login}">here</a>.</h2></body></html>`;
        return responseWithSetCookies(body, {
          status: 200,
          cookies: [
            "ASP.NET_SessionId=otp-sess; Path=/",
            "PostOtpAuth=from-object-moved; Path=/; HttpOnly",
          ],
        });
      }
      if (url.includes("Login.aspx")) {
        return responseWithSetCookies("<html><body>portal</body></html>", {
          cookies: ["AfterLogin=1; Path=/"],
        });
      }
      return new Response("unexpected " + url, { status: 500 });
    };

    const auth = new ClalitAuth(new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }));
    const session = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "654321",
    });
    const params = new URLSearchParams(otpPosted);
    expect(params.get("__EVENTTARGET")).toBe("ctl00$cphBody$btnContinue$lnkSubButton");
    expect(params.get("ctl00$cphBody$txtClientOTP")).toBe("654321");
    expect(params.get("ctl00$cphBody$hdnRegExp")).toBe("^[0-9]{6,6}$");
    const names = sessionCookieNames(session);
    expect(names).toContain("PostOtpAuth");
    expect(names).toContain("AfterLogin");
    // Values stay out of assertions beyond the round-trip field check above.
    expect(names).not.toContain("654321");
  });

  test("document.cookie PostOtpAuth on Object-moved is kept, then AfterLogin", async () => {
    process.env.CLALIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), "clalit-hops-"));
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("infootplogin.aspx") && method === "GET") return htmlResponse(loginHtml);
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && method === "POST") {
        return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && method === "GET") return htmlResponse(otpContinueHtml);
      if (url.includes("OTPSMSVerification.aspx") && method === "POST") {
        const body = `<html><head><title>Object moved</title></head><body>
<h2>Object moved to <a href="${PATHS.login}">here</a>.</h2>
<script>document.cookie="PostOtpAuth=from-js; Path=/";</script>
</body></html>`;
        return htmlResponse(body);
      }
      if (url.includes("Login.aspx")) {
        return responseWithSetCookies("<html><body>portal</body></html>", {
          cookies: ["AfterLogin=1; Path=/"],
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    const auth = new ClalitAuth(new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }));
    const session = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "111111",
    });
    const names = sessionCookieNames(session);
    expect(names).toContain("PostOtpAuth");
    expect(names).toContain("AfterLogin");
  });

  test("PostOtpAuth without a redirect still GETs Login.aspx for AfterLogin", async () => {
    process.env.CLALIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), "clalit-hops-"));
    const requested: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requested.push(`${method} ${url}`);
      if (url.includes("infootplogin.aspx") && method === "GET") return htmlResponse(loginHtml);
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && method === "POST") {
        return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && method === "GET") return htmlResponse(otpContinueHtml);
      if (url.includes("OTPSMSVerification.aspx") && method === "POST") {
        return responseWithSetCookies("", {
          status: 200,
          contentType: "text/html",
          cookies: ["PostOtpAuth=header-only; Path=/; HttpOnly"],
        });
      }
      if (url.includes("Login.aspx")) {
        return responseWithSetCookies("<html><body>portal</body></html>", {
          cookies: ["AfterLogin=1; Path=/"],
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    const auth = new ClalitAuth(new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }));
    const session = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "222222",
    });
    expect(requested.some((r) => r.includes("Login.aspx"))).toBe(true);
    const names = sessionCookieNames(session);
    expect(names).toContain("PostOtpAuth");
    expect(names).toContain("AfterLogin");
  });

  test("successful OTP 302 → PersonalDetails.aspx (live HAR) — no cold Login", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "clalit-hops-"));
    process.env.CLALIT_CONFIG_DIR = dumpDir;
    const requested: string[] = [];
    let otpPosted = "";
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requested.push(`${method} ${url}`);
      if (url.includes("infootplogin.aspx") && method === "GET") {
        return responseWithSetCookies(loginHtml, { cookies: DEFENSE_COOKIES });
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && method === "POST") {
        return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && method === "GET") {
        return htmlResponse(otpContinueEntitiesHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && method === "POST") {
        otpPosted = String(init?.body ?? "");
        return responseWithSetCookies("<html><body>personal</body></html>", {
          status: 302,
          location: "/OnlineWeb/General/PersonalDetails.aspx",
          cookies: ["PostOtpAuth=har; Path=/; HttpOnly", "AfterLogin=1; Path=/"],
        });
      }
      if (url.includes("PersonalDetails.aspx")) {
        return responseWithSetCookies("<html><body>details</body></html>", {
          cookies: ["AfterLogin=1; Path=/"],
        });
      }
      if (url.includes("Login.aspx")) {
        return new Response("should-not-cold-get-login", { status: 500 });
      }
      return new Response("unexpected " + url, { status: 500 });
    };
    const auth = new ClalitAuth(
      new ClalitTransport({ fetch: withFailClosedComplete(fetchMock), minGapMs: 0 }),
    );
    const session = await auth.loginInteractive("123456789", {
      solveCaptcha: async () => "AB12",
      readOtp: async () => "333333",
    });
    const params = new URLSearchParams(otpPosted);
    expect(params.get("__EVENTTARGET")).toBe("ctl00$cphBody$btnContinue$lnkSubButton");
    expect(params.get("ctl00$cphBody$hdnRegExp")).toBe("^[0-9]{6,6}$");
    expect(requested.some((r) => r.includes("PersonalDetails.aspx"))).toBe(true);
    expect(requested.some((r) => r.includes("Login.aspx"))).toBe(false);
    const names = sessionCookieNames(session);
    expect(names).toContain("PostOtpAuth");
    expect(names).toContain("AfterLogin");
  });

  test("OTP 200 redisplay writes redacted field-name dump", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "clalit-hops-"));
    process.env.CLALIT_CONFIG_DIR = dumpDir;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("infootplogin.aspx") && method === "GET") {
        return responseWithSetCookies(loginHtml, { cookies: DEFENSE_COOKIES });
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("infootplogin.aspx") && method === "POST") {
        return new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && method === "GET") {
        return htmlResponse(otpContinueEntitiesHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && method === "POST") {
        return htmlResponse(otpRedisplayHtml);
      }
      if (url.includes("LabsTestList.aspx")) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fServices%2fLabs%2fLabsTestList.aspx",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    const auth = new ClalitAuth(new ClalitTransport({ fetch: fetchMock, minGapMs: 0 }));
    await expect(
      auth.loginInteractive("123456789", {
        solveCaptcha: async () => "AB12",
        readOtp: async () => "444444",
      }),
    ).rejects.toMatchObject({ code: "OTP_SESSION_INCOMPLETE" });

    const dumps = readdirSync(dumpDir).filter((f) => f.startsWith("otp-redisplay-"));
    expect(dumps.length).toBe(1);
    const dump = JSON.parse(readFileSync(join(dumpDir, dumps[0]!), "utf8")) as {
      fieldNames: string[];
      eventTarget: string;
      validationMessagePresent: boolean;
      httpStatus: number;
    };
    expect(dump.httpStatus).toBe(200);
    expect(dump.eventTarget).toBe("ctl00$cphBody$btnContinue$lnkSubButton");
    expect(dump.fieldNames).toEqual(
      expect.arrayContaining([
        "__EVENTTARGET",
        "ctl00$cphBody$txtClientOTP",
        "ctl00$cphBody$hdnRegExp",
      ]),
    );
    expect(JSON.stringify(dump)).not.toMatch(/444444/);
    // Field *names* may include __VIEWSTATE; values must never appear.
    expect(JSON.stringify(dump)).not.toMatch(/wEPDwUK/);
  });
});

describe("OTP failure diagnostics (redacted, one-attempt)", () => {
  /** Minimal portal mock: captcha → OTP page (configurable) → OTP POST (configurable) → labs 302. */
  function portalMock(opts: {
    otpGetHtml?: string;
    captchaPost?: () => Response;
    otpPost: () => Response;
  }): typeof fetch {
    return async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("infootplogin.aspx") && method === "GET") {
        return responseWithSetCookies(loginHtml, { cookies: DEFENSE_COOKIES });
      }
      if (url.includes("BotDetectCaptcha")) {
        return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png" } });
      }
      if (url.includes("infootplogin.aspx") && method === "POST") {
        return opts.captchaPost?.() ?? new Response(null, { status: 302, headers: { location: PATHS.otpSms } });
      }
      if (url.includes("OTPSMSVerification.aspx") && method === "GET") {
        return htmlResponse(opts.otpGetHtml ?? otpContinueEntitiesHtml);
      }
      if (url.includes("OTPSMSVerification.aspx") && method === "POST") {
        return opts.otpPost();
      }
      if (url.includes("LabsTestList.aspx")) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fServices%2fLabs%2fLabsTestList.aspx",
          },
        });
      }
      if (url.includes("Login.aspx")) {
        return htmlResponse("<html><body>anonymous login</body></html>");
      }
      return new Response("unexpected", { status: 500 });
    };
  }

  const wrongCodeHtml = otpContinueEntitiesHtml.replace(
    "</form>",
    `<span id="ctl00_cphBody_cvOTP" style="color:Red;">הקוד שהוזן שגוי 987654</span></form>`,
  );

  test("wrong-code redisplay: rich otp-redisplay dump, hop kinds, why on error, progress lines", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "clalit-diag-"));
    process.env.CLALIT_CONFIG_DIR = dumpDir;
    const progress: string[] = [];
    const auth = new ClalitAuth(
      new ClalitTransport({
        fetch: portalMock({ otpPost: () => htmlResponse(wrongCodeHtml) }),
        minGapMs: 0,
      }),
    );
    const thrown = (await auth
      .loginInteractive(
        "123456789",
        { solveCaptcha: async () => "AB12", readOtp: async () => "444444" },
        { onProgress: (e) => progress.push(`${e.stage}: ${e.message}`) },
      )
      .then(
        () => {
          throw new Error("expected OTP_SESSION_INCOMPLETE");
        },
        (err: unknown) => err,
      )) as AuthenticationError;

    expect(thrown).toMatchObject({ code: "OTP_SESSION_INCOMPLETE" });
    expect(thrown.message).toMatch(/LabsTestList still redirects/);
    expect(thrown.message).toMatch(/otp_redisplayed_with_error/);
    expect(thrown.diagnostics?.why).toBe("otp_redisplayed_with_error");
    expect(thrown.diagnostics?.he).toMatch(/שגוי/);
    expect(thrown.diagnostics?.dumpPaths).toHaveLength(2);
    expect(thrown.diagnostics?.dumpPaths?.[0]).toMatch(/otp-redisplay-.*\.json$/);
    expect(thrown.diagnostics?.dumpPaths?.[1]).toMatch(/login-hops-.*\.json$/);

    const redisplayFile = readdirSync(dumpDir).find((f) => f.startsWith("otp-redisplay-"))!;
    const redisplay = JSON.parse(readFileSync(join(dumpDir, redisplayFile), "utf8"));
    expect(redisplay).toMatchObject({
      version: 2,
      httpStatus: 200,
      validationMessagePresent: true,
      otpPost: {
        status: 200,
        requestPath: "/OnlineWeb/General/OTPSMSVerification.aspx",
        pageKind: "otp",
        setCookieNames: [],
        responseForm: { txtClientOTP: true, hdnRegExp: true, btnContinue: true },
        post: {
          eventTarget: "ctl00$cphBody$btnContinue$lnkSubButton",
          eventTargetEmpty: false,
          missingExpectedKeys: [],
          unexpectedLoginKeys: [],
        },
        source: {
          path: "/OnlineWeb/General/OTPSMSVerification.aspx",
          pageKind: "otp",
          formActionMatchesPost: true,
          eventTargetSource: "extracted",
          resolvedOtpField: "ctl00$cphBody$txtClientOTP",
        },
      },
    });
    expect(redisplay.otpPost.validationSnippets[0].text).toBe("הקוד שהוזן שגוי #");
    expect(typeof redisplay.otpPost.timingMs.captchaToOtpPageMs).toBe("number");
    expect(typeof redisplay.otpPost.timingMs.otpPageToCodeMs).toBe("number");
    expect(redisplay.otpPost.jarCookieNamesBefore).toEqual(
      expect.arrayContaining(["visid_incap_2919800", "TS21fa3c30027"]),
    );

    const hopsFile = readdirSync(dumpDir).find((f) => f.startsWith("login-hops-"))!;
    const hops = JSON.parse(readFileSync(join(dumpDir, hopsFile), "utf8"));
    expect(hops).toMatchObject({
      version: 2,
      reason: "labs_login_redirect",
      why: { why: "otp_redisplayed_with_error" },
      pageKinds: ["otp"],
      labsProbe: { status: 302, locationPath: "/OnlineWeb/General/Login.aspx", loginRedirect: true },
    });
    expect(hops.hops[0]).toMatchObject({ pageKind: "otp", contentType: "text/html" });

    const stages = progress.map((l) => l.split(":")[0]);
    expect(stages).toEqual(
      expect.arrayContaining([
        "login_page",
        "captcha_submit",
        "captcha_ok",
        "otp_page",
        "otp_post",
        "otp_redisplay",
        "hop",
        "labs_probe",
        "dump",
        "result",
      ]),
    );
    const all = [progress.join("\n"), ...readdirSync(dumpDir).map((f) => readFileSync(join(dumpDir, f), "utf8"))].join(
      "\n",
    );
    expect(all).not.toContain("444444"); // OTP
    expect(all).not.toContain("123456789"); // ID
    expect(all).not.toContain("AB12"); // CAPTCHA answer
    expect(all).not.toContain("987654"); // digits inside portal validation text
    expect(all).not.toMatch(/wEPDwUK/); // VIEWSTATE
    expect(all).not.toContain("visid-fixture"); // cookie values
    expect(all).not.toContain("ts-fixture");
  });

  test("OTP posted from a Login.aspx page state (live shape) → otp_source_not_otp_form", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "clalit-diag-"));
    process.env.CLALIT_CONFIG_DIR = dumpDir;
    // Captcha-accepted HasOTP redirect → Login.aspx whose HTML only *mentions*
    // OTPSMSVerification (no SMS input) — what the 2026-10-05 live dump suggests.
    const hasOtpHtml = `${loginHtml}<script>setCookie('HasOTP', '-otp-sms', 90);redirectInfoToOnline('/OnlineWeb/General/Login.aspx');</script>`;
    const loginWithOtpMention = loginHtml.replace(
      "</form>",
      `<input type="hidden" name="__PREVIOUSPAGE" value="pp" /><script>var otpUrl='/OnlineWeb/General/OTPSMSVerification.aspx';</script></form>`,
    );
    const base = portalMock({
      captchaPost: () => htmlResponse(hasOtpHtml),
      otpPost: () => htmlResponse(wrongCodeHtml),
    });
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (/\/OnlineWeb\/General\/Login\.aspx$/i.test(url) && (init?.method ?? "GET") === "GET") {
        return htmlResponse(loginWithOtpMention);
      }
      return base(input, init);
    };
    const auth = new ClalitAuth(new ClalitTransport({ fetch: fetchMock, minGapMs: 0 }));
    const thrown = (await auth
      .loginInteractive("123456789", { solveCaptcha: async () => "AB12", readOtp: async () => "555555" })
      .then(
        () => {
          throw new Error("expected OTP_SESSION_INCOMPLETE");
        },
        (err: unknown) => err,
      )) as AuthenticationError;
    expect(thrown.code).toBe("OTP_SESSION_INCOMPLETE");
    expect(thrown.diagnostics?.why).toBe("otp_source_not_otp_form");
    expect(thrown.diagnostics?.signals).toEqual(
      expect.arrayContaining([
        "source_page_without_otp_input",
        "source_page_has_captcha_login_fields",
        "unexpected_login_keys_in_otp_post",
        "otp_field_short_name_fallback",
        "hdnRegExp_missing",
      ]),
    );
    const redisplayFile = readdirSync(dumpDir).find((f) => f.startsWith("otp-redisplay-"))!;
    const redisplay = JSON.parse(readFileSync(join(dumpDir, redisplayFile), "utf8"));
    expect(redisplay.otpPost.source).toMatchObject({
      path: "/OnlineWeb/General/Login.aspx",
      presence: { txtClientOTP: false, captchaLoginFields: true, previousPageField: true },
    });
    // Whatever target was picked from the wrong page is visible (control id only).
    expect(typeof redisplay.otpPost.post.eventTarget).toBe("string");
    expect(redisplay.otpPost.post.missingExpectedKeys).toContain("*hdnRegExp");
    expect(JSON.stringify(redisplay)).not.toContain("555555");
  });

  test("OTP 302 without PostOtpAuth → missing_post_otp_auth with hop kinds", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "clalit-diag-"));
    process.env.CLALIT_CONFIG_DIR = dumpDir;
    const auth = new ClalitAuth(
      new ClalitTransport({
        fetch: portalMock({
          otpPost: () =>
            new Response(null, {
              status: 302,
              headers: { location: "/OnlineWeb/General/PersonalDetails.aspx?x=1" },
            }),
        }),
        minGapMs: 0,
      }),
    );
    const thrown = (await auth
      .loginInteractive("123456789", { solveCaptcha: async () => "AB12", readOtp: async () => "666666" })
      .catch((err: unknown) => err)) as AuthenticationError;
    expect(thrown.diagnostics?.why).toBe("missing_post_otp_auth");
    expect(readdirSync(dumpDir).some((f) => f.startsWith("otp-redisplay-"))).toBe(false);
    const hopsFile = readdirSync(dumpDir).find((f) => f.startsWith("login-hops-"))!;
    const hops = JSON.parse(readFileSync(join(dumpDir, hopsFile), "utf8"));
    expect(hops.hops[0]).toMatchObject({
      status: 302,
      pageKind: "object_moved",
      locationPath: "/OnlineWeb/General/PersonalDetails.aspx",
    });
    expect(hops.otpPost).toMatchObject({ pageKind: "object_moved", finalPath: "/OnlineWeb/General/PersonalDetails.aspx" });
  });
});

