import { describe, expect, test } from "vitest";
import {
  adoptBrowserSession,
  pageLooksSignedIn,
  safePath,
  shapeBody,
  shapeHeaders,
  summarizeHtml,
  valueShape,
  worthRecording,
} from "../src/browser-session.js";
import { PATHS, PORTAL_ORIGIN } from "../src/constants.js";
import type { BrowserCookieSeed } from "../src/transport.js";

const LABS_HTML = `<html><body><form id="aspnetForm" action="LabsTestList.aspx"><table id="ctl00_ctl00_cphBody_bodyContent_LabsHistory1_gvTestListInDateRange"></table></form></body></html>`;
const LOGIN_HTML = `<html><body><form action="./infootplogin.aspx"><input name="ctl00$cphBody$tbUserId" type="text"/><input name="ctl00$cphBody$tbCaptchaLogin" type="text"/></form></body></html>`;

const browserCookies: BrowserCookieSeed[] = [
  { name: "visid_incap_123", value: "vvv", domain: ".clalit.co.il", path: "/", secure: true },
  { name: "incap_ses_1_123", value: "sss", domain: ".clalit.co.il", path: "/" },
  { name: "ASP.NET_SessionId", value: "abc", domain: "e-services.clalit.co.il", path: "/", httpOnly: true },
  { name: "PostOtpAuth", value: "xyz", domain: "e-services.clalit.co.il", path: "/", httpOnly: true, secure: true },
  { name: "unrelated", value: "no", domain: "example.com", path: "/" },
];

describe("adoptBrowserSession", () => {
  test("saves the browser's portal cookies as the session when the labs list opens, under the browser's user agent", async () => {
    const seen: { url: string; cookie: string; ua: string }[] = [];
    const fetchMock = async (input: string | Request | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), cookie: headers.get("cookie") ?? "", ua: headers.get("user-agent") ?? "" });
      return new Response(LABS_HTML, { status: 200, headers: { "content-type": "text/html" } });
    };
    const { session, cookieNames } = await adoptBrowserSession(browserCookies, { fetch: fetchMock, minGapMs: 0, userAgent: "TestBrowser/1.0" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(PORTAL_ORIGIN + PATHS.labsList);
    expect(seen[0]!.ua).toBe("TestBrowser/1.0");
    expect(seen[0]!.cookie).toContain("PostOtpAuth=xyz");
    expect(seen[0]!.cookie).toContain("visid_incap_123=vvv");
    expect(seen[0]!.cookie).not.toContain("unrelated");
    expect(cookieNames).toEqual(["ASP.NET_SessionId", "PostOtpAuth", "incap_ses_1_123", "visid_incap_123"]);
    expect(session.version).toBe(1);
    expect(session.userAgent).toBe("TestBrowser/1.0");
    expect(session.authenticatedAt).toBeTruthy();
    expect(session.cookies.cookies?.map((c) => c.key).sort()).toEqual(["ASP.NET_SessionId", "PostOtpAuth", "incap_ses_1_123", "visid_incap_123"]);
  });

  test("refuses, saving nothing, when the labs list redirects to login", async () => {
    const fetchMock = async () =>
      new Response("", { status: 302, headers: { location: `${PATHS.login}?ReturnUrl=%2fOnlineWeb%2fServices%2fLabs%2fLabsTestList.aspx` } });
    await expect(adoptBrowserSession(browserCookies, { fetch: fetchMock, minGapMs: 0 })).rejects.toMatchObject({
      code: "BROWSER_SESSION_INCOMPLETE",
      status: 302,
    });
  });

  test("refuses a login page served as 200, and a jar without Imperva cookies", async () => {
    const fetchMock = async () => new Response(LOGIN_HTML, { status: 200, headers: { "content-type": "text/html" } });
    await expect(adoptBrowserSession(browserCookies, { fetch: fetchMock, minGapMs: 0 })).rejects.toMatchObject({ code: "BROWSER_SESSION_INCOMPLETE" });
    const noImperva = browserCookies.filter((c) => !c.name.includes("incap"));
    await expect(adoptBrowserSession(noImperva, { fetch: fetchMock, minGapMs: 0 })).rejects.toMatchObject({ code: "BROWSER_SESSION_INCOMPLETE" });
    await expect(adoptBrowserSession([], { fetch: fetchMock, minGapMs: 0 })).rejects.toMatchObject({ code: "BROWSER_SESSION_INCOMPLETE" });
  });
});

describe("pageLooksSignedIn", () => {
  test("a portal page past the sign-in, and nothing else", () => {
    expect(pageLooksSignedIn({ host: "e-services.clalit.co.il", path: "/OnlineWeb/General/PersonalDetails.aspx", inputs: [{ name: "ctl00$search", type: "text" }] })).toBe(true);
    expect(pageLooksSignedIn({ host: "e-services.clalit.co.il", path: "/OnlineWeb/General/Login.aspx", inputs: [] })).toBe(false);
    expect(pageLooksSignedIn({ host: "e-services.clalit.co.il", path: "/onlineweb/general/InfoFullLogin.aspx", inputs: [] })).toBe(false);
    expect(pageLooksSignedIn({ host: "e-services.clalit.co.il", path: "/OnlineWeb/General/OTPSMSVerification.aspx", inputs: [] })).toBe(false);
    expect(pageLooksSignedIn({ host: "e-services.clalit.co.il", path: "/OnlineWeb/Home.aspx", inputs: [{ name: "ctl00$cphBody$tbPassword", type: "password" }] })).toBe(false);
    expect(pageLooksSignedIn({ host: "e-services.clalit.co.il", path: "/OnlineWeb/Home.aspx", inputs: [{ name: "ctl00$cphBody$tbUserId", type: "text" }] })).toBe(false);
    expect(pageLooksSignedIn({ host: "e-services.clalit.co.il", path: "/OnlineWeb/Home.aspx", inputs: [{ name: "LBD_VCID_c_general_login_ctl00_cphbody__loginview_captchalogin", type: "hidden" }] })).toBe(false);
    // The live landing page (FamilyHomePage.aspx) carries a "ResetPasswordPopupReminder" button and a log-out form: signed in.
    expect(
      pageLooksSignedIn({
        host: "e-services.clalit.co.il",
        path: "/OnlineWeb/Services/FamilyHomePage.aspx",
        inputs: [
          { name: "__VIEWSTATE", type: "hidden" },
          { name: "ctl00$ctl00$cphBody$bodyContent$ResetPasswordPopupReminder1$btnShow", type: "submit" },
          { name: "ctl00$ctl00$LogOutTimeOut$logOut", type: "submit" },
        ],
      }),
    ).toBe(true);
    expect(pageLooksSignedIn({ host: "www.clalit.co.il", path: "/OnlineWeb/Home.aspx", inputs: [] })).toBe(false);
    expect(pageLooksSignedIn({ host: "example.com", path: "/OnlineWeb/Home.aspx", inputs: [] })).toBe(false);
  });
});

describe("shapes carry no values", () => {
  test("valueShape", () => {
    expect(valueShape("123456789")).toBe("digits(9)");
    expect(valueShape("Secr3tPass")).toBe("alnum(10)");
    expect(valueShape("abcdef")).toBe("letters(6)");
    expect(valueShape("")).toBe("empty");
    expect(valueShape(undefined)).toBe("none");
    expect(valueShape("/wEPDwUKMTIzNDU2Nzg5MGRk".repeat(3))).toMatch(/^base64\(\d+\)$/);
    expect(valueShape("14.10.2026")).toBe("date-like(10)");
    expect(valueShape("סיסמה סודית")).toBe("text(11)");
    expect(valueShape("/OnlineWeb/General/Login.aspx?ReturnUrl=x")).toBe("path(/OnlineWeb/General/Login.aspx?…)");
  });

  test("safePath keeps the path and query keys, not query values", () => {
    expect(safePath("https://e-services.clalit.co.il/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fx&t=abc123")).toBe(
      "/OnlineWeb/General/Login.aspx?ReturnUrl=path(/OnlineWeb/x)&t=alnum(6)",
    );
    expect(safePath("/relative/page.aspx")).toBe("/relative/page.aspx");
  });

  test("shapeBody reduces a WebForms post to field names and shapes", () => {
    const body = "__VIEWSTATE=" + encodeURIComponent("/wEPDw".padEnd(80, "A")) + "&ctl00%24cphBody%24tbUserId=123456789&ctl00%24cphBody%24tbPassword=Hunter2%21&__EVENTTARGET=ctl00%24cphBody%24btnLogin";
    const shaped = shapeBody(body, "application/x-www-form-urlencoded") as Record<string, string>;
    expect(shaped).toEqual({
      __VIEWSTATE: "base64(80)",
      "ctl00$cphBody$tbUserId": "digits(9)",
      "ctl00$cphBody$tbPassword": "text(8)",
      __EVENTTARGET: "text(22)",
    });
    expect(JSON.stringify(shaped)).not.toContain("123456789");
    expect(JSON.stringify(shaped)).not.toContain("Hunter2");
    expect(shapeBody('{"id":"123456789","otp":"4242"}', "application/json")).toEqual({ id: "digits(9)", otp: "digits(4)" });
    expect(shapeBody(undefined)).toBeUndefined();
  });

  test("shapeHeaders keeps a few headers and reduces the referer to a path", () => {
    expect(shapeHeaders({ Cookie: "a=b", Referer: "https://e-services.clalit.co.il/OnlineWeb/General/Login.aspx?x=1", "Content-Type": "application/x-www-form-urlencoded", Authorization: "Bearer zzz" })).toEqual({
      referer: "/OnlineWeb/General/Login.aspx?x=digits(1)",
      "content-type": "application/x-www-form-urlencoded",
    });
  });

  test("summarizeHtml keeps a page's structure and none of its text or values", () => {
    const html = `<html><head><title>כללית - דני ישראלי</title></head><body>
      <form method="post" action="./InfoFullLogin.aspx?ReturnUrl=%2fOnlineWeb%2f" id="aspnetForm">
      <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${"/wEPDw".padEnd(120, "B")}" />
      <input name="ctl00$cphBody$tbUserId" type="text" value="123456789" />
      <input name="ctl00$cphBody$tbPassword" type="password" />
      <input name="ctl00$cphBody$tbCaptchaLogin" type="text" /><input type="text" name="LBD_VCID_c_login_captcha" value="abc123def456" />
      <a id="ctl00_cphBody_btnLogin" href="javascript:__doPostBack(&#39;ctl00$cphBody$btnLogin&#39;,&#39;&#39;)">כניסה</a>
      <a href="/onlineweb/general/infootplogin.aspx?x=1">כניסה עם קוד</a>
      <script>setCookie('HasOTP', '-otp-sms', 90); redirectInfoToOnline('/OnlineWeb/General/Login.aspx');</script>
      </form></body></html>`;
    const s = summarizeHtml(html);
    expect(s.forms).toEqual([{ action: "/InfoFullLogin.aspx?ReturnUrl=path(/OnlineWeb/)", method: "post" }]);
    expect(s.inputs).toEqual([
      { name: "__VIEWSTATE", type: "hidden", value: "base64(120)" },
      { name: "ctl00$cphBody$tbUserId", type: "text", value: "digits(9)" },
      { name: "ctl00$cphBody$tbPassword", type: "password", value: "none" },
      { name: "ctl00$cphBody$tbCaptchaLogin", type: "text", value: "none" },
      { name: "LBD_VCID_c_login_captcha", type: "text", value: "alnum(12)" },
    ]);
    expect(s.postBackTargets).toEqual(["ctl00$cphBody$btnLogin"]);
    expect(s.cookiesSetByScript).toEqual(["HasOTP"]);
    expect(s.redirects).toEqual(["/OnlineWeb/General/Login.aspx"]);
    expect(s.signInLinks).toEqual(["/onlineweb/general/infootplogin.aspx?x=digits(1)"]);
    expect(s.has).toEqual({ userId: true, password: true, captcha: true, otp: false });
    const text = JSON.stringify(s);
    for (const secret of ["123456789", "abc123def456", "דני", "BBBB", "-otp-sms"]) expect(text).not.toContain(secret);
  });

  test("worthRecording: portal documents, XHR, posts and the CAPTCHA image; not assets or other hosts", () => {
    expect(worthRecording("https://e-services.clalit.co.il/OnlineWeb/General/Login.aspx", "Document", "GET")).toBe(true);
    expect(worthRecording("https://e-services.clalit.co.il/x.aspx", "XHR", "GET")).toBe(true);
    expect(worthRecording("https://e-services.clalit.co.il/x.aspx", "Other", "POST")).toBe(true);
    expect(worthRecording("https://e-services.clalit.co.il/BotDetectCaptcha.ashx?get=image", "Image", "GET")).toBe(true);
    expect(worthRecording("https://e-services.clalit.co.il/logo.png", "Image", "GET")).toBe(false);
    expect(worthRecording("https://e-services.clalit.co.il/app.js", "Script", "GET")).toBe(false);
    expect(worthRecording("https://www.google-analytics.com/collect", "XHR", "POST")).toBe(false);
    expect(worthRecording("https://gb.clalit.co.il/glassbox/reporting/x/cls_report?pv=1", "XHR", "POST")).toBe(false);
  });
});
