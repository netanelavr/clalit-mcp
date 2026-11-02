import { CookieJar } from "tough-cookie";
import { describe, expect, test } from "vitest";
import { PATHS, PORTAL_ORIGIN } from "../src/constants.js";
import { ReauthenticationRequired } from "../src/errors.js";
import { ClalitReaders } from "../src/readers.js";
import type { ClalitSession } from "../src/session.js";
import { ClalitTransport } from "../src/transport.js";

const OBJECT_MOVED = `<html><head><title>Object moved</title></head><body>
<h2>Object moved to <a href="/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fServices%2fLabs%2fLabsTestList.aspx">here</a>.</h2>
</body></html>`;

describe("ClalitTransport login redirect → reauth", () => {
  test("302 Location to Login.aspx throws REAUTHENTICATION_REQUIRED", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(OBJECT_MOVED, {
        status: 302,
        headers: {
          "content-type": "text/html",
          location: `${PATHS.login}?ReturnUrl=${encodeURIComponent(PATHS.labsList)}`,
        },
      });
    const transport = new ClalitTransport({ fetch: fetchMock, minGapMs: 0 });
    transport.markAuthenticated();
    await expect(transport.request(PORTAL_ORIGIN + PATHS.labsList)).rejects.toMatchObject({
      code: "REAUTHENTICATION_REQUIRED",
      status: 302,
    });
  });

  test("200 Object-moved login HTML throws REAUTHENTICATION_REQUIRED", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(OBJECT_MOVED, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    const transport = new ClalitTransport({ fetch: fetchMock, minGapMs: 0 });
    transport.markAuthenticated();
    await expect(transport.request(PORTAL_ORIGIN + PATHS.labsList)).rejects.toMatchObject({
      code: "REAUTHENTICATION_REQUIRED",
    });
  });

  test("listLabs surfaces reauth instead of empty data for 302 Object-moved", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(OBJECT_MOVED, {
        status: 302,
        headers: {
          "content-type": "text/html",
          location:
            "/OnlineWeb/General/Login.aspx?ReturnUrl=%2fOnlineWeb%2fServices%2fLabs%2fLabsTestList.aspx",
        },
      });
    const transport = new ClalitTransport({ fetch: fetchMock, minGapMs: 0 });
    transport.markAuthenticated();
    const readers = new ClalitReaders(transport);
    await expect(readers.listLabs()).rejects.toBeInstanceOf(ReauthenticationRequired);
  });

  test("awaits cookie restore before first request", async () => {
    const jar = new CookieJar();
    await jar.setCookie("session=restored-value; Path=/", PORTAL_ORIGIN);
    const session: ClalitSession = {
      version: 1,
      cookies: await jar.serialize(),
      authenticatedAt: new Date().toISOString(),
      idleTtlMs: 30 * 60_000,
    };

    let sawCookie: string | undefined;
    const fetchMock: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      sawCookie = headers.get("cookie") ?? undefined;
      return new Response("<html><body>ok labs LabsHistory __VIEWSTATE</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    const transport = new ClalitTransport({ fetch: fetchMock, session, minGapMs: 0 });
    // Immediate request must not race ahead of deserialize.
    await transport.request(PORTAL_ORIGIN + PATHS.labsList, { allowLoginHtml: true });
    expect(sawCookie).toContain("session=restored-value");
  });
});

describe("ClalitTransport idle check with a saved session", () => {
  const cookies = new CookieJar().serializeSync()!;
  const hour = 3_600_000;
  const now = Date.parse("2026-10-31T14:00:00Z");

  test("a session signed in two hours ago but used a minute ago is not idle", () => {
    const session: ClalitSession = {
      version: 1,
      cookies,
      authenticatedAt: new Date(now - 2 * hour).toISOString(),
      lastUsedAt: new Date(now - 60_000).toISOString(),
    };
    const transport = new ClalitTransport({ session, now: () => now });
    expect(() => transport.assertNotIdleExpired()).not.toThrow();
  });

  test("the same session without a last use is idle since sign-in", () => {
    const session: ClalitSession = { version: 1, cookies, authenticatedAt: new Date(now - 2 * hour).toISOString() };
    const transport = new ClalitTransport({ session, now: () => now });
    expect(() => transport.assertNotIdleExpired()).toThrow(ReauthenticationRequired);
  });

  test("exportSession records the last use", async () => {
    const fetchMock: typeof fetch = async () => new Response("<html><body>ok</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const transport = new ClalitTransport({ fetch: fetchMock, minGapMs: 0, now: () => now });
    transport.markAuthenticated();
    await transport.request(PORTAL_ORIGIN + "/OnlineWeb/ServicesForAll/RefreshSession.aspx", { allowLoginHtml: true });
    expect((await transport.exportSession()).lastUsedAt).toBe(new Date(now).toISOString());
  });
});

describe("checkSession", () => {
  const saved: ClalitSession = { version: 1, cookies: new CookieJar().serializeSync()!, authenticatedAt: new Date().toISOString() };

  test("a 5xx from the labs page is a retryable upstream error, not a sign-out", async () => {
    const { connect } = await import("../src/client.js");
    const { UpstreamError } = await import("../src/errors.js");
    const fetchMock: typeof fetch = async () => new Response("down", { status: 503, headers: { "content-type": "text/html" } });
    const client = await connect(saved, { fetch: fetchMock });
    const err = await client.checkSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).not.toBeInstanceOf(ReauthenticationRequired);
    expect((err as { status?: number }).status).toBe(503);
  });

  test("a redirect to the sign-in page is a sign-out", async () => {
    const { connect } = await import("../src/client.js");
    const fetchMock: typeof fetch = async () =>
      new Response(OBJECT_MOVED, { status: 302, headers: { "content-type": "text/html", location: `${PATHS.login}?ReturnUrl=x` } });
    const client = await connect(saved, { fetch: fetchMock });
    await expect(client.checkSession()).rejects.toBeInstanceOf(ReauthenticationRequired);
  });
});
