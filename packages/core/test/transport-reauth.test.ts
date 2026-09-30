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
