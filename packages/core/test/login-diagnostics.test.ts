import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  checkOtpPostKeys,
  classifyLoginPageKind,
  explainOtpFailure,
  extractRedactedValidationSnippets,
  formActionPaths,
  formatLoginProgress,
  redactValidationText,
  summarizeCaptchaRejectHints,
  summarizeLoginHtmlShape,
  summarizeOtpFormPresence,
  summarizeOtpPostResponse,
  summarizeOtpSourcePage,
  summarizePostBodyKeys,
  urlPathOnly,
  writeLoginHopDump,
  writeOtpRedisplayDump,
  OTP_SLOW_ENTRY_MS,
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

  test("captcha reject hints: HasOTP success vs visible Red mismatch", () => {
    const success = `<span id="cvClalitInfoCaptchaLogin" style="color:Red;display:none;">x</span>
<script>setCookie('HasOTP', '-otp-sms', 90);redirectInfoToOnline('/OnlineWeb/General/Login.aspx');</script>`;
    const successHints = summarizeCaptchaRejectHints(success);
    expect(successHints.hasHasOtpSetCookie).toBe(true);
    expect(successHints.hasRedirectInfoToOnlineLogin).toBe(true);
    expect(successHints.cvCaptchaDisplayNone).toBe(true);
    expect(successHints.cvCaptchaVisibleRed).toBe(false);

    const mismatch = `<span id="cvClalitInfoCaptchaLogin" style="color:Red;">התווים לא זהים</span>`;
    const mismatchHints = summarizeCaptchaRejectHints(mismatch);
    expect(mismatchHints.hasHasOtpSetCookie).toBe(false);
    expect(mismatchHints.hasRedirectInfoToOnlineLogin).toBe(false);
    expect(mismatchHints.cvCaptchaDisplayNone).toBe(false);
    expect(mismatchHints.cvCaptchaVisibleRed).toBe(true);
  });

});

const otpPageFixture = readFileSync(join(fixtures, "otp-continue-entities.html"), "utf8");
const loginPageFixture = readFileSync(join(fixtures, "login-page.html"), "utf8");
const OTP_URL = "https://e-services.clalit.co.il/OnlineWeb/General/OTPSMSVerification.aspx";

/** Redisplayed OTP page with a visible red validator carrying digits. */
const otpRedisplayWithError = otpPageFixture.replace(
  "</form>",
  `<span id="ctl00_cphBody_cvOTP" style="color:Red;">הקוד שהוזן שגוי. נותרו 2 ניסיונות (054-1234567)</span>
<span id="ctl00_cphBody_rfvOTP" style="color:Red;display:none;">חובה להזין קוד</span>
</form>`,
);

const prevConfigDir = process.env.CLALIT_CONFIG_DIR;
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLALIT_CONFIG_DIR;
  else process.env.CLALIT_CONFIG_DIR = prevConfigDir;
});

describe("page-kind helpers", () => {
  test("urlPathOnly strips host, query, fragment", () => {
    expect(
      urlPathOnly(
        "/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fServices%2fLabs%2fLabsTestList.aspx",
      ),
    ).toBe("/OnlineWeb/General/Login.aspx");
    expect(urlPathOnly(`${OTP_URL}?x=1#y`)).toBe("/OnlineWeb/General/OTPSMSVerification.aspx");
    expect(urlPathOnly(undefined)).toBeUndefined();
    expect(urlPathOnly("PersonalDetails.aspx", OTP_URL)).toBe("/OnlineWeb/General/PersonalDetails.aspx");
  });

  test("classifyLoginPageKind covers otp/login/personal_details/labs/object_moved/unknown", () => {
    expect(classifyLoginPageKind({ url: OTP_URL, status: 200, html: otpPageFixture })).toBe("otp");
    expect(
      classifyLoginPageKind({
        url: OTP_URL,
        status: 302,
        html: "<html><head><title>Object moved</title></head><body><h2>Object moved to <a href=\"/OnlineWeb/General/PersonalDetails.aspx\">here</a>.</h2></body></html>",
        location: "/OnlineWeb/General/PersonalDetails.aspx",
      }),
    ).toBe("object_moved");
    expect(
      classifyLoginPageKind({
        url: "https://e-services.clalit.co.il/OnlineWeb/General/PersonalDetails.aspx",
        status: 200,
        html: "<html><body>details</body></html>",
      }),
    ).toBe("personal_details");
    expect(
      classifyLoginPageKind({
        url: "https://e-services.clalit.co.il/OnlineWeb/Services/Labs/LabsTestList.aspx",
        status: 200,
        html: "<form action=\"./LabsTestList.aspx\"><table id=\"LabsHistory1_gvTestListInDateRange\"></table></form>",
      }),
    ).toBe("labs");
    expect(
      classifyLoginPageKind({
        url: "https://e-services.clalit.co.il/onlineweb/general/infootplogin.aspx",
        status: 200,
        html: loginPageFixture,
      }),
    ).toBe("login");
    expect(
      classifyLoginPageKind({
        url: "https://e-services.clalit.co.il/OnlineWeb/General/Login.aspx",
        status: 200,
        html: "<html><body>anonymous login</body></html>",
      }),
    ).toBe("login");
    expect(classifyLoginPageKind({ url: "https://e-services.clalit.co.il/x.aspx", status: 200, html: "<p>hi</p>" })).toBe(
      "unknown",
    );
  });

  test("form presence + form action paths", () => {
    const p = summarizeOtpFormPresence(otpPageFixture);
    expect(p).toEqual({
      txtClientOTP: true,
      hdnRegExp: true,
      btnContinue: true,
      captchaLoginFields: false,
      previousPageField: false,
    });
    const lp = summarizeOtpFormPresence(loginPageFixture);
    expect(lp.txtClientOTP).toBe(false);
    expect(lp.captchaLoginFields).toBe(true);
    expect(formActionPaths(otpPageFixture, OTP_URL)).toEqual([
      "/OnlineWeb/General/OTPSMSVerification.aspx",
    ]);
  });
});

describe("redacted validation text", () => {
  test("strips digits, emails, tokens; keeps Hebrew/English copy", () => {
    const r = redactValidationText(
      "<b>קוד&nbsp;שגוי</b> 123456 for a@b.co token AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA &#49;&#50;",
    );
    expect(r.text).toBe("קוד שגוי # for [email] token [token] #");
    expect(r.digitsRedacted).toBe(8);
    expect(r.rawLength).toBeGreaterThan(r.text.length);
    expect(r.text).not.toMatch(/\d/);
  });

  test("extracts only visible validator / red snippets", () => {
    const snippets = extractRedactedValidationSnippets(otpRedisplayWithError);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toMatchObject({
      source: "validator",
      elementId: "ctl00_cphBody_cvOTP",
      text: "הקוד שהוזן שגוי. נותרו # ניסיונות (#-#)",
    });
    expect(snippets.map((x) => x.text).join(" ")).not.toMatch(/\d/);
    expect(snippets[0]?.digitsRedacted).toBe(11);
    // Hidden validator (display:none) must not appear.
    expect(JSON.stringify(snippets)).not.toContain("חובה להזין קוד");
  });

  test("script alert messages are captured redacted", () => {
    const html = `<script>alert('Your code 987654 is wrong');</script>`;
    const snippets = extractRedactedValidationSnippets(html);
    expect(snippets[0]).toMatchObject({ source: "script_message", text: "Your code # is wrong" });
  });
});

describe("OTP POST summary", () => {
  test("checkOtpPostKeys flags missing hdnRegExp, empty EVENTTARGET, login keys", () => {
    const live = checkOtpPostKeys(
      "__VIEWSTATE=V&__VIEWSTATEGENERATOR=G&__EVENTVALIDATION=E&__EVENTTARGET=&__EVENTARGUMENT=&__PREVIOUSPAGE=P&LBD_VCID_c_general_login=abc&txtClientOTP=111111",
    );
    expect(live.eventTargetEmpty).toBe(true);
    expect(live.otpFieldKey).toBe("txtClientOTP");
    expect(live.otpFieldShortNameFallback).toBe(true);
    expect(live.missingExpectedKeys).toEqual(["__EVENTTARGET(empty)", "*hdnRegExp"]);
    expect(live.unexpectedLoginKeys).toEqual(["__PREVIOUSPAGE", "LBD_VCID_c_general_login"]);
    expect(JSON.stringify(live)).not.toContain("111111");

    const good = checkOtpPostKeys(
      "__VIEWSTATE=V&__EVENTVALIDATION=E&__EVENTTARGET=ctl00%24cphBody%24btnContinue%24lnkSubButton&ctl00%24cphBody%24hdnRegExp=x&ctl00%24cphBody%24txtClientOTP=222222",
    );
    expect(good.missingExpectedKeys).toEqual([]);
    expect(good.eventTarget).toBe("ctl00$cphBody$btnContinue$lnkSubButton");
    expect(good.otpFieldShortNameFallback).toBe(false);
  });

  test("summarizeOtpPostResponse dump shape is redacted and complete", () => {
    const source = summarizeOtpSourcePage({
      html: otpPageFixture,
      url: OTP_URL,
      postUrl: OTP_URL,
      eventTargetSource: "extracted",
      resolvedOtpField: "ctl00$cphBody$txtClientOTP",
    });
    const diag = summarizeOtpPostResponse({
      status: 200,
      requestUrl: OTP_URL,
      contentType: "text/html; charset=utf-8",
      html: otpRedisplayWithError,
      setCookieNames: [],
      jarBefore: ["ASP.NET_SessionId", "HasOTP"],
      jarAfter: ["ASP.NET_SessionId", "HasOTP", "TS21fa3c30027"],
      postBody:
        "__VIEWSTATE=%2FwEPDwUKSECRET&__EVENTVALIDATION=E&__EVENTTARGET=ctl00%24cphBody%24btnContinue%24lnkSubButton&ctl00%24cphBody%24hdnRegExp=x&ctl00%24cphBody%24txtClientOTP=333333",
      source,
      timingMs: { captchaToOtpPageMs: 900, otpPageToCodeMs: 40_000, otpPostMs: 300 },
    });
    expect(diag).toMatchObject({
      status: 200,
      requestPath: "/OnlineWeb/General/OTPSMSVerification.aspx",
      finalPath: "/OnlineWeb/General/OTPSMSVerification.aspx",
      contentType: "text/html",
      pageKind: "otp",
      setCookieNames: [],
      jarCookieNamesAdded: ["TS21fa3c30027"],
      portalAuthCookieSet: false,
      bodyLooksLike: { objectMoved: false, otp: true, personalDetails: false, labs: false },
      responseForm: { txtClientOTP: true, hdnRegExp: true, btnContinue: true },
      validationMessagePresent: true,
      post: {
        eventTarget: "ctl00$cphBody$btnContinue$lnkSubButton",
        eventTargetEmpty: false,
        missingExpectedKeys: [],
      },
      source: {
        path: "/OnlineWeb/General/OTPSMSVerification.aspx",
        pageKind: "otp",
        formActionMatchesPost: true,
        eventTargetSource: "extracted",
      },
      timingMs: { captchaToOtpPageMs: 900, otpPageToCodeMs: 40_000, otpPostMs: 300 },
    });
    expect(diag.validationSnippets[0]?.text).toContain("שגוי");
    const raw = JSON.stringify(diag);
    expect(raw).not.toContain("333333");
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toContain("1234567");
  });
});

describe("explainOtpFailure", () => {
  const base = (over: Partial<Parameters<typeof summarizeOtpPostResponse>[0]> = {}) =>
    summarizeOtpPostResponse({
      status: 200,
      requestUrl: OTP_URL,
      html: otpPageFixture,
      setCookieNames: [],
      jarBefore: [],
      jarAfter: [],
      postBody:
        "__VIEWSTATE=V&__EVENTVALIDATION=E&__EVENTTARGET=ctl00%24cphBody%24btnContinue%24lnkSubButton&ctl00%24cphBody%24hdnRegExp=x&ctl00%24cphBody%24txtClientOTP=1",
      ...over,
    });
  const flags = { hasDefenseCookies: true, portalAuthCookieSeen: false, labsLoginRedirect: true };

  test("redisplay with validator → likely wrong/expired code (Hebrew + English)", () => {
    const e = explainOtpFailure({ otpPost: base({ html: otpRedisplayWithError }), ...flags });
    expect(e.why).toBe("otp_redisplayed_with_error");
    expect(e.en).toMatch(/wrong or expired/);
    expect(e.he).toMatch(/שגוי/);
    expect(e.signals).toContain("validation_text_present");
  });

  test("redisplay without error → silent", () => {
    expect(explainOtpFailure({ otpPost: base(), ...flags }).why).toBe("otp_redisplayed_silent");
  });

  test("source page without OTP input → wrong page state", () => {
    const source = summarizeOtpSourcePage({
      html: loginPageFixture,
      url: "https://e-services.clalit.co.il/OnlineWeb/General/Login.aspx",
      postUrl: OTP_URL,
      eventTargetSource: "fallback",
    });
    const e = explainOtpFailure({ otpPost: base({ source }), ...flags });
    expect(e.why).toBe("otp_source_not_otp_form");
    expect(e.signals).toEqual(
      expect.arrayContaining(["source_page_without_otp_input", "source_page_has_captcha_login_fields"]),
    );
  });

  test("form action mismatch and empty event target", () => {
    const mismatch = summarizeOtpSourcePage({
      html: otpPageFixture.replace("./OTPSMSVerification.aspx", "./Login.aspx"),
      url: "https://e-services.clalit.co.il/OnlineWeb/General/Login.aspx",
      postUrl: OTP_URL,
      eventTargetSource: "extracted",
    });
    expect(explainOtpFailure({ otpPost: base({ source: mismatch }), ...flags }).why).toBe(
      "otp_post_form_action_mismatch",
    );
    const empty = base({ postBody: "__VIEWSTATE=V&__EVENTTARGET=&txtClientOTP=1" });
    const e = explainOtpFailure({ otpPost: empty, ...flags });
    expect(e.why).toBe("otp_event_target_empty");
    expect(e.signals).toEqual(expect.arrayContaining(["otp_field_short_name_fallback", "hdnRegExp_missing"]));
  });

  test("left OTP form: defense → post-otp-auth → labs ordering; slow entry signal", () => {
    const moved = base({
      status: 302,
      location: "/OnlineWeb/General/PersonalDetails.aspx",
      html: "",
      timingMs: { otpPageToCodeMs: OTP_SLOW_ENTRY_MS + 1 },
    });
    expect(explainOtpFailure({ otpPost: moved, ...flags, hasDefenseCookies: false }).why).toBe(
      "missing_portal_defense_cookies",
    );
    const noAuth = explainOtpFailure({ otpPost: moved, ...flags });
    expect(noAuth.why).toBe("missing_post_otp_auth");
    expect(noAuth.signals).toContain("otp_entry_slow");
    expect(explainOtpFailure({ otpPost: moved, ...flags, portalAuthCookieSeen: true }).why).toBe(
      "labs_login_redirect",
    );
  });

  test("progress lines are prefixed", () => {
    expect(formatLoginProgress({ stage: "otp_post", message: "→ 200 kind=otp" })).toBe(
      "[clalit login] otp_post: → 200 kind=otp",
    );
  });
});

describe("dump files", () => {
  test("otp-redisplay v2 and login-hops v2 shapes (0600, redacted)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clalit-diag-"));
    process.env.CLALIT_CONFIG_DIR = dir;
    const otpPost = summarizeOtpPostResponse({
      status: 200,
      requestUrl: OTP_URL,
      html: otpRedisplayWithError,
      setCookieNames: [],
      jarBefore: ["HasOTP"],
      jarAfter: ["HasOTP"],
      postBody:
        "__VIEWSTATE=%2FwEPDwUKSECRET&__EVENTTARGET=ctl00%24cphBody%24btnContinue%24lnkSubButton&txtClientOTP=555555",
    });
    const redisplayPath = await writeOtpRedisplayDump({
      fieldNames: otpPost.post.keys,
      eventTarget: otpPost.post.eventTarget,
      validationMessagePresent: otpPost.validationMessagePresent,
      status: 200,
      otpPost,
    });
    expect(redisplayPath).toBeTruthy();
    expect(statSync(redisplayPath!).mode & 0o777).toBe(0o600);
    const redisplay = JSON.parse(readFileSync(redisplayPath!, "utf8"));
    expect(redisplay).toMatchObject({
      version: 2,
      kind: "otp-redisplay",
      httpStatus: 200,
      eventTarget: "ctl00$cphBody$btnContinue$lnkSubButton",
      otpPost: { pageKind: "otp", post: { missingExpectedKeys: ["__EVENTVALIDATION", "*hdnRegExp"] } },
    });

    const why = explainOtpFailure({
      otpPost,
      hasDefenseCookies: true,
      portalAuthCookieSeen: false,
      labsLoginRedirect: true,
    });
    const hopsPath = await writeLoginHopDump({
      hops: [
        {
          url: OTP_URL,
          status: 200,
          setCookieNames: [],
          jarCookieNames: ["HasOTP"],
          jarCount: 1,
          contentType: "text/html",
          pageKind: "otp",
        },
      ],
      finalJarNames: ["HasOTP"],
      finalJarCount: 1,
      reason: "labs_login_redirect",
      labsProbe: { status: 302, locationPath: "/OnlineWeb/General/Login.aspx", loginRedirect: true },
      why,
      otpPost,
      relatedDumps: [redisplayPath!],
    });
    const hops = JSON.parse(readFileSync(hopsPath!, "utf8"));
    expect(hops).toMatchObject({
      version: 2,
      reason: "labs_login_redirect",
      why: { why: "otp_redisplayed_with_error" },
      pageKinds: ["otp"],
      hops: [{ pageKind: "otp", contentType: "text/html" }],
      relatedDumps: [redisplayPath],
    });
    for (const f of readdirSync(dir)) {
      const raw = readFileSync(join(dir, f), "utf8");
      expect(raw).not.toContain("555555");
      expect(raw).not.toContain("SECRET");
      expect(raw).not.toContain("1234567");
    }
  });
});

