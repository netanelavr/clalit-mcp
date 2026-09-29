import type { SerializedCookieJar } from "tough-cookie";

/** Sensitive session material. Store with a protected adapter, never in logs. */
export interface ClalitSession {
  version: 1;
  cookies: SerializedCookieJar;
  authenticatedAt: string;
  /** Soft idle TTL hint (ms). Portal TTL is unmeasured; ~30m idle is a safe default. */
  idleTtlMs?: number;
}
