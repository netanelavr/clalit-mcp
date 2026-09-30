import { Cookie, CookieJar, type SerializedCookieJar } from "tough-cookie";
import {
  ALLOWED_ORIGINS,
  DEFAULT_IDLE_TTL_MS,
  MIN_REQUEST_GAP_MS,
  PORTAL_ORIGIN,
} from "./constants.js";
import { ClalitError, ReauthenticationRequired, UpstreamError } from "./errors.js";
import type { ClalitSession } from "./session.js";
import {
  isLoginRedirectTarget,
  looksLikeBotChallenge,
  looksLikeLoginPage,
} from "./webforms.js";

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

/** Browser / Playwright cookie shape (values never logged). */
export interface BrowserCookieSeed {
  name: string;
  value: string;
  domain: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None" | string;
  expires?: number;
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

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Build https URL for tough-cookie setCookie from a Domain attribute / cookie.domain. */
export function urlForCookieDomain(domain: string, path = "/"): string {
  const host = domain.replace(/^\./, "") || "e-services.clalit.co.il";
  const p = path.startsWith("/") ? path : `/${path}`;
  return `https://${host}${p}`;
}

/** Cookie name from a raw Set-Cookie line — never the value. */
export function setCookieHeaderName(raw: string): string | undefined {
  const m = /^([^=;\s]+)\s*=/.exec(raw.trim());
  return m?.[1];
}

/**
 * Imperva / Glassbox / TS cookies observed on a real Mac browser jar.
 * Presence (names only) indicates the login hop retained portal defense cookies.
 */
export function isPortalDefenseCookieName(name: string): boolean {
  return (
    /^visid_incap_/i.test(name) ||
    /^incap_ses_/i.test(name) ||
    /^TS[0-9a-f]/i.test(name) ||
    /^_cls_/i.test(name)
  );
}

function createLooseJar(): CookieJar {
  // looseMode + allowSpecialUseDomain: persist Domain=.clalit.co.il Imperva cookies.
  return new CookieJar(undefined, {
    looseMode: true,
    allowSpecialUseDomain: true,
    rejectPublicSuffixes: true,
  });
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
    this.#jar = createLooseJar();
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#minGapMs = options.minGapMs ?? MIN_REQUEST_GAP_MS;
    this.#idleTtlMs = options.session?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.#authenticatedAt = options.session?.authenticatedAt;
    // Await restore before any request: enqueue on the same serial queue (not fire-and-forget).
    if (options.session?.cookies) {
      this.#queue = this.#restoreCookies(options.session.cookies);
    }
  }

  async #restoreCookies(serialized: SerializedCookieJar): Promise<void> {
    await this.#jar.removeAllCookies();
    const restored = await CookieJar.deserialize(serialized);
    const data = await restored.serialize();
    for (const json of data.cookies ?? []) {
      const cookie = Cookie.fromJSON(json);
      if (!cookie || !cookie.key) continue;
      const domain = cookie.domain || "e-services.clalit.co.il";
      const url = urlForCookieDomain(domain, cookie.path || "/");
      try {
        await this.#jar.setCookie(cookie, url, { loose: true });
      } catch {
        /* ignore malformed restore entries */
      }
    }
  }

  /** Set a raw Set-Cookie line on the portal jar (e.g. mirror browser HasOTP). */
  async setCookie(raw: string, url = PORTAL_ORIGIN): Promise<void> {
    await this.#putRawCookie(raw, url);
  }

  /**
   * Merge browser/Playwright cookies into the jar, preserving Domain=.clalit.co.il.
   * Values are never logged.
   */
  async importBrowserCookies(cookies: BrowserCookieSeed[]): Promise<number> {
    let imported = 0;
    for (const c of cookies) {
      if (!c?.name || c.value === undefined || c.value === null) continue;
      const domain = (c.domain || "e-services.clalit.co.il").trim();
      if (!domain) continue;
      const path = c.path || "/";
      const parts = [`${c.name}=${c.value}`, `Path=${path}`, `Domain=${domain.startsWith(".") ? domain : domain}`];
      if (c.httpOnly) parts.push("HttpOnly");
      if (c.secure) parts.push("Secure");
      if (c.sameSite) parts.push(`SameSite=${c.sameSite}`);
      if (typeof c.expires === "number" && Number.isFinite(c.expires) && c.expires > 0) {
        parts.push(`Expires=${new Date(c.expires * 1000).toUTCString()}`);
      }
      const url = urlForCookieDomain(domain, path);
      try {
        const stored = await this.#jar.setCookie(parts.join("; "), url, { loose: true });
        if (stored) imported += 1;
      } catch {
        /* ignore one bad cookie */
      }
    }
    return imported;
  }

  /** Cookie names currently in the jar (never values). */
  async listCookieNames(): Promise<string[]> {
    const data = await this.#jar.serialize();
    return (data.cookies ?? [])
      .map((c) => c.key)
      .filter((k): k is string => Boolean(k))
      .sort();
  }

  async cookieCount(): Promise<number> {
    const data = await this.#jar.serialize();
    return (data.cookies ?? []).length;
  }

  async clearSession(): Promise<void> {
    await this.#jar.removeAllCookies();
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

        if (!init.allowLoginHtml) {
          const location = response.headers.get("location");
          if (
            isRedirectStatus(response.status) &&
            location &&
            isLoginRedirectTarget(location)
          ) {
            throw new ReauthenticationRequired(response.status);
          }

          // Soft login detection on HTML (200 labs page OR 302 Object-moved body)
          const ct = response.headers.get("content-type") ?? "";
          const checkHtml =
            ct.includes("text/html") &&
            (response.status === 200 || isRedirectStatus(response.status));
          if (checkHtml) {
            const peek = await response.clone().text();
            if (looksLikeBotChallenge(peek, response.status)) {
              throw new UpstreamError("BOT_CHALLENGE", response.status);
            }
            if (looksLikeLoginPage(peek)) {
              throw new ReauthenticationRequired(response.status);
            }
            if (response.status === 200) {
              // Re-wrap peeked body for callers
              return new Response(peek, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            }
          }
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

  async #putRawCookie(raw: string, url: string): Promise<void> {
    try {
      const stored = await this.#jar.setCookie(raw, url, { loose: true });
      if (stored) return;
    } catch {
      /* try Domain fallback below */
    }
    // Domain=.clalit.co.il (or similar) sometimes rejects against a deep path URL —
    // retry against the cookie's Domain host root.
    const domainMatch = /(?:^|;\s*)domain\s*=\s*([^;]+)/i.exec(raw);
    if (!domainMatch?.[1]) return;
    const domain = domainMatch[1].trim();
    if (!domain) return;
    try {
      await this.#jar.setCookie(raw, urlForCookieDomain(domain, "/"), { loose: true });
    } catch {
      /* ignore malformed */
    }
  }

  async #storeSetCookies(url: string, response: Response): Promise<void> {
    const anyHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    let setCookies: string[] =
      typeof anyHeaders.getSetCookie === "function" ? anyHeaders.getSetCookie() : [];
    // Fallback when getSetCookie is missing or empty but a single header exists.
    if (setCookies.length === 0) {
      const single = response.headers.get("set-cookie");
      if (single) setCookies = [single];
    }
    for (const raw of setCookies) {
      // loose + Domain fallback; never log cookie values.
      await this.#putRawCookie(raw, url);
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

/** Extract Set-Cookie header names from a Response (never values). */
export function responseSetCookieNames(response: Response): string[] {
  const anyHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  let setCookies: string[] =
    typeof anyHeaders.getSetCookie === "function" ? anyHeaders.getSetCookie() : [];
  if (setCookies.length === 0) {
    const single = response.headers.get("set-cookie");
    if (single) setCookies = [single];
  }
  return setCookies
    .map(setCookieHeaderName)
    .filter((n): n is string => Boolean(n));
}
