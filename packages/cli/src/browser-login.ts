/**
 * `login --browser`: sign in to Clalit Online in your own browser, by whichever road the site gives
 * you (the permanent password, or the SMS code; the CAPTCHA solved by hand as on any visit), and
 * hand the signed-in session to this client.
 *
 * The CLI opens Chrome on a profile of its own (under the config directory) at the portal's login
 * page and waits. It watches only which page the browser is on. When a portal page past the sign-in
 * is showing — or you press Enter here — it reads the browser's cookies for the portal, checks them
 * with one request for the labs list, and saves them as the session (`session.json`, mode 0600).
 * Nothing is typed into the site for you, and nothing is solved or bypassed.
 *
 * `--record` also writes a value-free record of the sign-in (`login-record-<time>.json` in the config
 * directory): every portal request's method, path, query keys, field names with the *shape* of each
 * value (digits(9), text(12), base64(2316)…), the status, redirect paths, cookie names, and each
 * page's inputs and postback targets. No value of yours is in it — it is what someone needs to build
 * a sign-in that needs no browser at all, and it is safe to share.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  PATHS,
  PORTAL_ORIGIN,
  adoptBrowserSession,
  pageLooksSignedIn,
  shapeBody,
  shapeHeaders,
  safePath,
  shapeJson,
  summarizeHtml,
  worthRecording,
  type BrowserCookieSeed,
  type LoginRecord,
  type PageState,
  type RecordedRequest,
} from "@clalit/core";
import { defaultProfileDir, openBrowser, type BrowserPage } from "./cdp.js";
import { configDir, saveSession } from "./store.js";

export interface BrowserLoginOptions {
  /** Where to start; the portal's own login page unless given. */
  url?: string;
  record?: boolean;
  /** Leave the browser window open afterwards. */
  keepOpen?: boolean;
  /** How long to wait for the sign-in (default 15 minutes). */
  ttlMs?: number;
}

const POLL_MS = 1500;
const PAGE_STATE = `(() => ({ host: location.host, path: location.pathname, inputs: [...document.querySelectorAll('input')].map(i => ({ name: i.name || i.id || '', type: i.type || 'text' })) }))()`;

export async function runBrowserLogin(options: BrowserLoginOptions = {}): Promise<number> {
  const startUrl = options.url ?? PORTAL_ORIGIN + PATHS.login;
  const dir = configDir();
  let page: BrowserPage;
  try {
    // Opened blank so the recorder, when asked for, sees the login page's own request too.
    page = await openBrowser("about:blank", defaultProfileDir(dir));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const recorder = options.record ? await startRecorder(page) : undefined;
  await page.navigate(startUrl);

  console.error("A browser window opened on Clalit Online's sign-in page.");
  console.error("Sign in there the way you usually do (permanent password or SMS code; type the CAPTCHA yourself).");
  console.error("When your personal page is showing, this will notice — or press Enter here.");
  if (recorder) console.error("Recording the sign-in's request shapes (no values) for the login record.");

  const stdin = createInterface({ input: process.stdin });
  let forced = false;
  stdin.on("line", () => {
    forced = true;
  });
  const deadline = Date.now() + (options.ttlMs ?? 15 * 60_000);

  let landedOn = "";
  let signedInPolls = 0;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      let state: PageState | undefined;
      try {
        state = await page.evaluate<PageState>(PAGE_STATE);
      } catch {
        state = undefined; // between documents
      }
      if (state && pageLooksSignedIn(state)) signedInPolls += 1;
      else signedInPolls = 0;
      if (forced || signedInPolls >= 2) {
        landedOn = state ? safePath("https://" + state.host + state.path) : "?";
        break;
      }
    }
    if (!landedOn) {
      console.error("No sign-in finished within the time limit. Run login --browser again.");
      return 1;
    }

    const { cookies } = (await page.send("Network.getAllCookies", {}, { browser: false })) as {
      cookies: { name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite?: string; expires: number; session: boolean }[];
    };
    const { userAgent } = (await page.send("Browser.getVersion", {}, { browser: true })) as { userAgent: string };
    const seeds: BrowserCookieSeed[] = cookies
      .filter((c) => /clalit\.co\.il$/i.test(c.domain.replace(/^\./, "")))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        httpOnly: c.httpOnly,
        secure: c.secure,
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
        ...(typeof c.expires === "number" && c.expires > 0 ? { expires: c.expires } : {}),
      }));

    if (recorder) {
      const record = await recorder.finish(landedOn, cookies.filter((c) => /clalit\.co\.il$/i.test(c.domain.replace(/^\./, ""))));
      const path = join(dir, `login-record-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      await writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 });
      console.error(`Login record (${record.requests.length} requests, no values): ${path}`);
    }

    console.error(`Landed on ${landedOn}; checking the browser's ${seeds.length} portal cookies with one request for the labs list…`);
    try {
      const { session, cookieNames } = await adoptBrowserSession(seeds, { userAgent: userAgent.replace(/HeadlessChrome/, "Chrome") });
      await saveSession(session);
      console.error(`Session saved (cookies: ${cookieNames.join(", ")}).`);
      console.log("Signed in. Session saved under the clalit-mcp config directory (mode 0600).");
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : "The browser's session could not be adopted.");
      return 1;
    }
  } finally {
    stdin.close();
    if (!options.keepOpen) page.close();
  }
}

interface Recorder {
  finish(landedOn: string, cookies: { name: string; domain: string; path: string; httpOnly: boolean; secure: boolean; session: boolean }[]): Promise<LoginRecord>;
}

/** Watches the page's network traffic and keeps the shape of every portal request; values never leave the browser. */
async function startRecorder(page: BrowserPage): Promise<Recorder> {
  await page.send("Network.enable", {});
  type Rec = RecordedRequest & { hasPostData?: boolean; contentType?: string };
  const requests = new Map<string, Rec>();
  const order: Rec[] = [];
  const pendingBodies: Promise<void>[] = [];
  const noteResponse = (rec: Rec, status: number, mime: string, responseHeaders: Record<string, string>): void => {
    rec.status = status;
    if (mime) rec.mime = mime;
    const headers = Object.entries(responseHeaders);
    const location = headers.find(([k]) => k.toLowerCase() === "location")?.[1];
    if (location) rec.location = safePath(location);
    const setCookie = headers.filter(([k]) => k.toLowerCase() === "set-cookie").flatMap(([, v]) => v.split("\n"));
    if (setCookie.length) rec.setCookie = setCookie.map((c) => c.split("=")[0]!.trim()).filter(Boolean);
  };

  page.on("Network.requestWillBeSent", (ev, sid) => {
    if (sid !== page.sessionId) return;
    const { requestId, request, type, redirectResponse } = ev as {
      requestId: string;
      type?: string;
      request: { url: string; method: string; headers: Record<string, string>; postData?: string; hasPostData?: boolean };
      redirectResponse?: { status: number; headers: Record<string, string> };
    };
    // A redirect reuses the request id: the hop that answered 3xx is closed here with that answer
    // (the sign-in POST's own status, Location and Set-Cookie), and the next hop gets a record of its own.
    const previous = requests.get(requestId);
    if (previous && redirectResponse) {
      noteResponse(previous, redirectResponse.status, "", redirectResponse.headers);
      requests.set(`${requestId}:${previous.n}`, previous); // parked under a key no event will touch
      requests.delete(requestId);
    }
    if (!worthRecording(request.url, type ?? "", request.method)) return;
    const contentType = Object.entries(request.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    const rec: RecordedRequest & { hasPostData?: boolean; contentType?: string } = {
      n: order.length + 1,
      method: request.method,
      url: safePath(request.url),
      resourceType: type ?? "",
      headers: shapeHeaders(request.headers),
      ...(request.postData !== undefined ? { body: shapeBody(request.postData, contentType) } : {}),
      hasPostData: request.hasPostData,
      contentType,
    };
    requests.set(requestId, rec);
    order.push(rec);
  });
  page.on("Network.responseReceived", (ev, sid) => {
    if (sid !== page.sessionId) return;
    const { requestId, response } = ev as { requestId: string; response: { status: number; mimeType: string; headers: Record<string, string> } };
    const rec = requests.get(requestId);
    if (rec) noteResponse(rec, response.status, response.mimeType, response.headers);
  });
  page.on("Network.loadingFinished", (ev, sid) => {
    if (sid !== page.sessionId) return;
    const { requestId } = ev as { requestId: string };
    const rec = requests.get(requestId);
    if (!rec) return;
    pendingBodies.push(
      (async () => {
        if (rec.body === undefined && rec.hasPostData) {
          try {
            const { postData } = (await page.send("Network.getRequestPostData", { requestId })) as { postData: string };
            rec.body = shapeBody(postData, rec.contentType);
          } catch {
            rec.body = "unreadable";
          }
        }
        if (rec.mime && /html|json/i.test(rec.mime) && rec.method !== "OPTIONS") {
          try {
            const { body, base64Encoded } = (await page.send("Network.getResponseBody", { requestId })) as { body: string; base64Encoded: boolean };
            const text = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
            if (/json/i.test(rec.mime)) {
              try {
                rec.json = shapeJson(JSON.parse(text));
              } catch {
                rec.json = `unparsable json(${text.length})`;
              }
            } else {
              rec.page = summarizeHtml(text);
            }
          } catch {
            /* the body is gone (a redirect, or navigated away); the status and headers still tell the shape */
          }
        }
      })(),
    );
  });

  return {
    async finish(landedOn, cookies) {
      // Bodies still being fetched get a few seconds; the record is written after.
      await Promise.race([Promise.allSettled(pendingBodies), new Promise((r) => setTimeout(r, 5000))]);
      return {
        recordedAt: new Date().toISOString(),
        landedOn,
        requests: order.map(({ hasPostData: _h, contentType: _c, ...rest }) => rest),
        cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, session: c.session })),
      };
    },
  };
}
