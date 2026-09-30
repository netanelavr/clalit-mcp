import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  buildPostBackBody,
  extractWebFormsState,
  isLoginRedirectTarget,
  looksLikeBotChallenge,
  looksLikeLabsListChrome,
  looksLikeLoginPage,
} from "../src/webforms.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("webforms", () => {
  test("extracts VIEWSTATE and hidden fields from labs list", () => {
    const html = readFileSync(join(fixtures, "labs-list.html"), "utf8");
    const state = extractWebFormsState(html);
    expect(state.viewState.length).toBeGreaterThan(10);
    expect(state.viewStateGenerator).toBe("ABC123");
    expect(state.hidden["FamilySliderControl21$au"]).toBe("");
    const body = buildPostBackBody(state, { tbUserId: "123" }, "target", "arg");
    expect(body).toContain("__VIEWSTATE=");
    expect(body).toContain("__EVENTTARGET=target");
    expect(body).toContain("tbUserId=123");
    // Family slider must be round-tripped only if caller passes it — default hidden is included;
    // readers must never set au/cu to a different member.
    expect(body).toContain("FamilySliderControl21%24au=");
  });

  test("detects login and bot challenge pages", () => {
    const login = readFileSync(join(fixtures, "login-page.html"), "utf8");
    expect(looksLikeLoginPage(login)).toBe(true);
    expect(looksLikeBotChallenge("Imperva Error 16 — request rejected")).toBe(true);
    expect(looksLikeBotChallenge("<html>ok labs</html>")).toBe(false);
  });

  test("isLoginRedirectTarget recognizes Login / InfoFullLogin / infootplogin", () => {
    expect(
      isLoginRedirectTarget(
        "/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fServices%2fLabs%2fLabsTestList.aspx",
      ),
    ).toBe(true);
    expect(isLoginRedirectTarget("/onlineweb/general/infootplogin.aspx")).toBe(true);
    expect(isLoginRedirectTarget("/OnlineWeb/General/InfoFullLogin.aspx")).toBe(true);
    expect(isLoginRedirectTarget("/OnlineWeb/Services/Labs/LabsTestList.aspx")).toBe(false);
  });

  test("Object moved ReturnUrl body is login, not labs chrome", () => {
    const html = `<html><head><title>Object moved</title></head><body>
<h2>Object moved to <a href="/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fServices%2fLabs%2fLabsTestList.aspx">here</a>.</h2>
</body></html>`;
    expect(looksLikeLoginPage(html)).toBe(true);
    expect(looksLikeLabsListChrome(html)).toBe(false);
  });
});
