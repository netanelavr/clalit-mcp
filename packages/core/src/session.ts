import type { SerializedCookieJar } from "tough-cookie";

/** Sensitive session material. Store with a protected adapter, never in logs. */
export interface ClalitSession {
  version: 1;
  cookies: SerializedCookieJar;
  authenticatedAt: string;
  /** Soft idle TTL hint (ms). Portal TTL is unmeasured; ~30m idle is a safe default. */
  idleTtlMs?: number;
  /** The browser's user agent when the session was handed over from one (`login --browser`). */
  userAgent?: string;
  /**
   * When this session last reached the portal (ISO). A keep-alive saves the session after each
   * round, so a fresh process measures idleness from here rather than from the sign-in.
   */
  lastUsedAt?: string;
}
