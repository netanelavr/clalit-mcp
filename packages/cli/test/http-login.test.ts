import { describe, expect, test } from "vitest";
import {
  captchaPage,
  escapeHtml,
  HTTP_LOGIN_TTL_MS,
  idPage,
  otpPage,
  takeOrWait,
  waitForAnswer,
  waitingPage,
} from "../src/http-login.js";

describe("http-login helpers", () => {
  test("TTL is at least 30 minutes", () => {
    expect(HTTP_LOGIN_TTL_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });

  test("escapeHtml and pages render expected fields", () => {
    expect(escapeHtml("<x>")).toBe("&lt;x&gt;");
    expect(idPage("csrf-token")).toContain('name="id"');
    expect(captchaPage("csrf-token", { hasImage: true })).toContain("/captcha.png");
    expect(captchaPage("csrf-token", { hasImage: false })).toContain("CAPTCHA");
    expect(otpPage("csrf-token", "Enter SMS")).toContain('name="otp"');
    expect(waitingPage("Checking CAPTCHA…", "Waiting")).toContain("Checking CAPTCHA");
    expect(waitingPage("Checking CAPTCHA…", "Waiting")).not.toContain("http-equiv");
  });

  test("takeOrWait buffers answer when no waiter yet (CAPTCHA Continue race)", async () => {
    const slot: { value?: string; pending?: { resolve: (v: string) => void; reject: (e: Error) => void } } = {};
    takeOrWait(slot, "AB12");
    expect(slot.value).toBe("AB12");
    await expect(waitForAnswer(slot)).resolves.toBe("AB12");
    expect(slot.value).toBeUndefined();
  });

  test("takeOrWait resolves an existing waiter (normal order)", async () => {
    const slot: { value?: string; pending?: { resolve: (v: string) => void; reject: (e: Error) => void } } = {};
    const answered = waitForAnswer(slot);
    takeOrWait(slot, "XY99");
    await expect(answered).resolves.toBe("XY99");
    expect(slot.value).toBeUndefined();
    expect(slot.pending).toBeUndefined();
  });

  test("second takeOrWait while buffered keeps latest answer", async () => {
    const slot: { value?: string; pending?: { resolve: (v: string) => void; reject: (e: Error) => void } } = {};
    takeOrWait(slot, "first");
    takeOrWait(slot, "second");
    await expect(waitForAnswer(slot)).resolves.toBe("second");
  });
});
