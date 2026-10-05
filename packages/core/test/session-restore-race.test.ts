import { CookieJar } from "tough-cookie";
import { describe, expect, test } from "vitest";
import { connect } from "../src/client.js";
import type { ClalitSession } from "../src/session.js";
import { ClalitTransport, urlForCookieDomain } from "../src/transport.js";

async function buildSessionWithCookies(
  entries: Array<{ name: string; value: string; domain: string; path?: string }>,
): Promise<ClalitSession> {
  const jar = new CookieJar(undefined, {
    looseMode: true,
    allowSpecialUseDomain: true,
    rejectPublicSuffixes: true,
  });
  for (const e of entries) {
    const path = e.path ?? "/";
    const raw = `${e.name}=${e.value}; Path=${path}; Domain=${e.domain}`;
    await jar.setCookie(raw, urlForCookieDomain(e.domain, path), { loose: true });
  }
  return {
    version: 1,
    cookies: await jar.serialize(),
    authenticatedAt: new Date().toISOString(),
    idleTtlMs: 30 * 60_000,
  };
}

const FULL_JAR_ENTRIES = [
  { name: "ASP.NET_SessionId", value: "session-abc", domain: "e-services.clalit.co.il" },
  { name: ".ONLINEAUTH", value: "online-auth", domain: "e-services.clalit.co.il" },
  { name: "visid_incap_2919800", value: "visid-val", domain: ".clalit.co.il" },
  { name: "incap_ses_1168_2919800", value: "incap-val", domain: ".clalit.co.il" },
  { name: "TS01234567", value: "ts-val", domain: ".clalit.co.il" },
  { name: "_cls_s", value: "cls-val", domain: ".clalit.co.il" },
];

describe("session restore race (export mid-restore)", () => {
  test("race window: jar is empty after removeAllCookies (export without await would truncate)", async () => {
    const session = await buildSessionWithCookies(FULL_JAR_ENTRIES);
    const expected = (session.cookies.cookies ?? []).length;
    expect(expected).toBeGreaterThanOrEqual(6);

    let midRestoreCount = -1;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const transport = new ClalitTransport({
      session,
      minGapMs: 0,
      onAfterCookieClear: async (count) => {
        midRestoreCount = count;
        await gate;
      },
    });

    // Old bug: exportSession() did not await #queue, so it could serialize here
    // (after clear, before setCookie loop) and persist only 0–1 cookies.
    const exportPromise = transport.exportSession();

    // Wait until restore reaches the empty-jar window (proves the race existed).
    await viWaitFor(() => midRestoreCount === 0);
    expect(midRestoreCount).toBe(0);

    release();
    const exported = await exportPromise;
    expect((exported.cookies.cookies ?? []).length).toBe(expected);
    expect(await transport.cookieCount()).toBe(expected);
  });

  test("exportSession / listCookieNames / cookieCount await restore and keep all cookies", async () => {
    const session = await buildSessionWithCookies(FULL_JAR_ENTRIES);
    const expected = (session.cookies.cookies ?? []).length;

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const transport = new ClalitTransport({
      session,
      minGapMs: 0,
      onAfterCookieClear: async () => {
        await gate;
      },
    });

    const exportPromise = transport.exportSession();
    const namesPromise = transport.listCookieNames();
    const countPromise = transport.cookieCount();

    // Let microtasks schedule; exports must still be waiting on the gate.
    await new Promise((r) => setTimeout(r, 20));
    release();

    const [exported, names, count] = await Promise.all([exportPromise, namesPromise, countPromise]);
    expect((exported.cookies.cookies ?? []).length).toBe(expected);
    expect(count).toBe(expected);
    expect(names).toEqual(
      expect.arrayContaining([
        "ASP.NET_SessionId",
        ".ONLINEAUTH",
        "visid_incap_2919800",
        "incap_ses_1168_2919800",
        "TS01234567",
        "_cls_s",
      ]),
    );
  });

  test("connect(loadSession) awaits restore and keeps Domain=.clalit.co.il cookies", async () => {
    const session = await buildSessionWithCookies(FULL_JAR_ENTRIES);
    const expected = (session.cookies.cookies ?? []).length;

    const client = await connect(session);
    const exported = await client.exportSession();
    const cookies = exported.cookies.cookies ?? [];
    expect(cookies.length).toBe(expected);

    const domains = cookies.map((c) => c.domain);
    expect(domains.some((d) => d === "clalit.co.il" || d === ".clalit.co.il")).toBe(true);
    const keys = cookies.map((c) => c.key).filter(Boolean);
    expect(keys).toEqual(
      expect.arrayContaining([
        "ASP.NET_SessionId",
        ".ONLINEAUTH",
        "visid_incap_2919800",
        "incap_ses_1168_2919800",
      ]),
    );
  });

  test("whenReady resolves only after delayed restore finishes", async () => {
    const session = await buildSessionWithCookies(FULL_JAR_ENTRIES);
    let restored = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const transport = new ClalitTransport({
      session,
      minGapMs: 0,
      onAfterCookieClear: async () => {
        await gate;
        restored = true;
      },
    });

    const readyPromise = transport.whenReady();
    await new Promise((r) => setTimeout(r, 10));
    expect(restored).toBe(false);
    release();
    await readyPromise;
    expect(restored).toBe(true);
    expect(await transport.cookieCount()).toBe((session.cookies.cookies ?? []).length);
  });
});

/** Tiny poll helper (avoid pulling @vitest/expect waitFor quirks). */
async function viWaitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("viWaitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
