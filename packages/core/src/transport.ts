import { CookieJar, type SerializedCookieJar } from "tough-cookie";
import {
  ALLOWED_ORIGINS,
  DEFAULT_IDLE_TTL_MS,
  MIN_REQUEST_GAP_MS,
  PORTAL_ORIGIN,
} from "./constants.js";
import { ClalitError, ReauthenticationRequired, UpstreamError } from "./errors.js";
import type { ClalitSession } from "./session.js";
import { looksLikeBotChallenge, looksLikeLoginPage } from "./webforms.js";

export type FetchFunction = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

export interface TransportOptions {
  fetch?: FetchFunction;
  session?: ClalitSession;
  timeoutMs?: number;
  now?: () => number;
  minGapMs?: number;
}

export interface TransportRequestInit extends RequestInit {
  /** When true, do not treat login-shaped HTML as session expiry (auth flows). */
  allowLoginHtml?: boolean;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function assertAllowed(url: string): void {
  const origin = originOf(url);
  if (!ALLOWED_ORIGINS.has(origin)) {
    throw new ClalitError("ORIGIN_NOT_ALLOWED", "Request target is outside the Clalit allowlist.");
  }
}

export class ClalitTransport {
  readonly #fetch: FetchFunction;
  readonly #jar: CookieJar;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #minGapMs: number;
  #lastRequestAt = 0;
  #authenticatedAt: string | undefined;
  #idleTtlMs: number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: TransportOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#jar = new CookieJar();
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#minGapMs = options.minGapMs ?? MIN_REQUEST_GAP_MS;
    this.#idleTtlMs = options.session?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.#authenticatedAt = options.session?.authenticatedAt;
    if (options.session?.cookies) {
      void this.#restoreCookies(options.session.cookies);
    }
  }

  async #restoreCookies(serialized: SerializedCookieJar): Promise<void> {
    const restored = await CookieJar.deserialize(serialized);
    const cookies = await restored.getCookies(PORTAL_ORIGIN);
    for (const cookie of cookies) {
      await this.#jar.setCookie(cookie, PORTAL_ORIGIN);
    }
  }

  async clearSession(): Promise<void> {
    const cookies = await this.#jar.getCookies(PORTAL_ORIGIN);
    for (const cookie of cookies) {
      await this.#jar.setCookie(
        `${cookie.key}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=${cookie.path || "/"}`,
        PORTAL_ORIGIN,
      );
    }
    this.#authenticatedAt = undefined;
  }

  markAuthenticated(at = new Date(this.#now()).toISOString()): void {
    this.#authenticatedAt = at;
  }

  async exportSession(): Promise<ClalitSession> {
    if (!this.#authenticatedAt) {
      throw new ReauthenticationRequired();
    }
    return {
      version: 1,
      cookies: await this.#jar.serialize(),
      authenticatedAt: this.#authenticatedAt,
      idleTtlMs: this.#idleTtlMs,
    };
  }

  /** Soft idle check. Portal TTL is unmeasured; treat long idle as needing login. */
  assertNotIdleExpired(): void {
    if (!this.#authenticatedAt) return;
    const age = this.#now() - Date.parse(this.#authenticatedAt);
    // Track last activity via #lastRequestAt when available.
    const idleBase = this.#lastRequestAt || Date.parse(this.#authenticatedAt);
    const idle = this.#now() - idleBase;
    if (idle > this.#idleTtlMs || age < 0) {
      throw new ReauthenticationRequired();
    }
  }

  async request(input: string | URL, init: TransportRequestInit = {}): Promise<Response> {
    const run = async (): Promise<Response> => {
      const url = String(input);
      assertAllowed(url.startsWith("http") ? url : PORTAL_ORIGIN + url);
      const absolute = url.startsWith("http") ? url : PORTAL_ORIGIN + url;

      const gap = this.#minGapMs - (this.#now() - this.#lastRequestAt);
      if (this.#lastRequestAt && gap > 0) {
        await new Promise((r) => setTimeout(r, gap));
      }

      const cookieHeader = await this.#jar.getCookieString(absolute);
      const headers = new Headers(init.headers);
      if (cookieHeader && !headers.has("cookie")) headers.set("cookie", cookieHeader);
      if (!headers.has("user-agent")) {
        // Ordinary browser UA; Imperva rejects datacenter/bot fingerprints.
        headers.set(
          "user-agent",
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        );
      }
      if (!headers.has("accept-language")) headers.set("accept-language", "he-IL,he;q=0.9,en;q=0.8");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(absolute, {
          ...init,
          headers,
          redirect: init.redirect ?? "manual",
          signal: controller.signal,
        });
        this.#lastRequestAt = this.#now();
        await this.#storeSetCookies(absolute, response);

        if (response.status === 401 || response.status === 403) {
          const peek = await response.clone().text().catch(() => "");
          if (looksLikeBotChallenge(peek, response.status)) {
            throw new UpstreamError("BOT_CHALLENGE", response.status);
          }
          throw new ReauthenticationRequired(response.status);
        }

        // Soft login detection on HTML
        const ct = response.headers.get("content-type") ?? "";
        if (!init.allowLoginHtml && ct.includes("text/html") && response.status === 200) {
          const peek = await response.clone().text();
          if (looksLikeBotChallenge(peek)) {
            throw new UpstreamError("BOT_CHALLENGE", response.status);
          }
          if (looksLikeLoginPage(peek)) {
            throw new ReauthenticationRequired(response.status);
          }
          // Re-wrap peeked body for callers
          return new Response(peek, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }

        return response;
      } catch (err) {
        if (err instanceof ClalitError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          throw new UpstreamError("TIMEOUT");
        }
        throw new UpstreamError("NETWORK_ERROR");
      } finally {
        clearTimeout(timer);
      }
    };

    const queued = this.#queue.then(run, run);
    this.#queue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async #storeSetCookies(url: string, response: Response): Promise<void> {
    const anyHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies =
      typeof anyHeaders.getSetCookie === "function"
        ? anyHeaders.getSetCookie()
        : response.headers.get("set-cookie")
          ? [response.headers.get("set-cookie")!]
          : [];
    for (const raw of setCookies) {
      try {
        await this.#jar.setCookie(raw, url);
      } catch {
        /* ignore malformed */
      }
    }
  }
}

export async function readText(response: Response, maxBytes = 2_000_000): Promise<string> {
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new UpstreamError("RESPONSE_TOO_LARGE");
  return buf.toString("utf8");
}

export async function readBytes(response: Response, maxBytes = 15_000_000): Promise<Uint8Array> {
  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new UpstreamError("RESPONSE_TOO_LARGE");
  return buf;
}
