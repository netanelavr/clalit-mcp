import { connect, ReauthenticationRequired, type ClalitClient, type ClalitSession } from "@clalit/core";

/**
 * Keeps one Clalit session alive for as long as the portal allows.
 *
 * Clalit has no refresh token: a sign-in (ID, CAPTCHA, SMS code) gives a
 * cookie session that the portal drops after roughly ten minutes without a
 * request. The keeper holds the signed-in client, pings RefreshSession.aspx
 * (the same page the portal's own pages load in a hidden frame) well inside
 * that window, checks now and then that a signed-in page still opens, and
 * saves the cookies after every request so a restart picks the session up.
 * When the portal ends the session anyway, the keeper drops it and reports
 * that a person has to sign in again. It also drops it at the end of the
 * session length the person chose when signing in (setEndsAt), so a session
 * never lives longer than they meant it to.
 */

export type KeeperState = "signed_out" | "signed_in" | "expired";

export interface KeeperStatus {
  state: KeeperState;
  signedInAt?: string;
  lastCheckedAt?: string;
  /** When the keeper signs out on its own: the end of the chosen length. */
  endsAt?: string;
  endedAt?: string;
  lastError?: string;
}

export interface SessionStore {
  load(): Promise<ClalitSession | undefined>;
  save(session: ClalitSession): Promise<void>;
  clear(): Promise<void>;
}

export interface KeeperOptions {
  store: SessionStore;
  /** Between keep-alive pings. */
  keepAliveMs?: number;
  /** Between checks that a signed-in page still opens. */
  checkMs?: number;
  open?: (session: ClalitSession) => Promise<ClalitClient>;
  now?: () => number;
  log?: (line: string) => void;
}

export const DEFAULT_KEEP_ALIVE_MS = 4 * 60_000;
export const DEFAULT_CHECK_MS = 20 * 60_000;

/** What the status says once the chosen session length has run out. */
export const LENGTH_ENDED = "The session length chosen at sign-in ran out.";

export class SignInRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRequired";
  }
}

export class SessionKeeper {
  readonly #store: SessionStore;
  readonly #keepAliveMs: number;
  readonly #checkMs: number;
  readonly #open: (session: ClalitSession) => Promise<ClalitClient>;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  #client: ClalitClient | undefined;
  #status: KeeperStatus = { state: "signed_out" };
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastCheck = 0;
  #endsAt: number | undefined;
  #busy: Promise<void> = Promise.resolve();
  /** Told whenever the state changes, e.g. to start a sign-in page. */
  onChange?: (status: KeeperStatus) => void;
  /** Text tool calls see when nobody is signed in. */
  signInHint = "Sign in to Clalit again.";

  constructor(options: KeeperOptions) {
    this.#store = options.store;
    this.#keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
    this.#checkMs = options.checkMs ?? DEFAULT_CHECK_MS;
    this.#open = options.open ?? connect;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.error(`[keeper] ${line}`));
  }

  status(): KeeperStatus {
    return { ...this.#status };
  }

  /** Picks up the saved session, if any, and starts the keep-alive loop. */
  async start(): Promise<void> {
    await this.reload();
    this.#timer = setInterval(() => void this.tick(), this.#keepAliveMs);
    this.#timer.unref?.();
  }

  /**
   * Sets when the session ends regardless of Clalit (epoch ms), or clears it.
   * Checked on every keep-alive round and every tool call.
   */
  setEndsAt(endsAt: number | undefined): void {
    this.#endsAt = endsAt;
    if (endsAt === undefined) delete this.#status.endsAt;
    else this.#status = { ...this.#status, endsAt: new Date(endsAt).toISOString() };
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Re-reads the saved session, e.g. right after a sign-in wrote it. */
  async reload(): Promise<void> {
    await this.#serial(async () => {
      const session = await this.#store.load();
      if (!session) {
        this.#client = undefined;
        this.#set({ ...this.#ends(), state: this.#status.state === "expired" ? "expired" : "signed_out" });
        return;
      }
      if (this.#pastEnd()) {
        this.#client = undefined;
        await this.#lost(new Error(LENGTH_ENDED));
        return;
      }
      try {
        this.#client = await this.#open(session);
        // A session saved before a restart may already be gone: check it now.
        await this.#client.checkSession();
        await this.#save();
        this.#lastCheck = this.#now();
        this.#set({
          ...this.#ends(),
          state: "signed_in",
          signedInAt: session.authenticatedAt,
          lastCheckedAt: new Date(this.#now()).toISOString(),
        });
        this.#log("session is signed in");
      } catch (err) {
        // Only the portal saying "sign in again" ends the session. A network error or an Imperva
        // hiccup here keeps session.json and the client, as tick() does: the next round retries,
        // and a tool call meanwhile uses the client as it is.
        if (err instanceof ReauthenticationRequired) {
          await this.#lost(err);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (this.#client) {
          this.#set({
            ...this.#ends(),
            state: "signed_in",
            signedInAt: session.authenticatedAt,
            ...(this.#status.lastCheckedAt ? { lastCheckedAt: this.#status.lastCheckedAt } : {}),
            lastError: message,
          });
          this.#log(`could not check the saved session, keeping it: ${message}`);
        } else {
          // The session file could not even be opened (unreadable cookies): nothing to keep alive,
          // but nothing is deleted either; the person decides.
          this.#set({ ...this.#ends(), state: "signed_out", lastError: message });
          this.#log(`could not open the saved session, left as it is: ${message}`);
        }
      }
    });
  }

  /** One keep-alive round: a ping, plus a signed-in page check when due. */
  async tick(): Promise<void> {
    await this.#serial(async () => {
      const client = this.#client;
      if (!client) return;
      if (this.#pastEnd()) {
        await this.#lost(new Error(LENGTH_ENDED));
        return;
      }
      try {
        await client.refreshSession();
        if (this.#now() - this.#lastCheck >= this.#checkMs) {
          await client.checkSession();
          this.#lastCheck = this.#now();
        }
        await this.#save();
        this.#status = { ...this.#status, lastCheckedAt: new Date(this.#now()).toISOString() };
        delete this.#status.lastError;
      } catch (err) {
        if (err instanceof ReauthenticationRequired) {
          await this.#lost(err);
          return;
        }
        // A network error or an Imperva hiccup: keep the session and retry
        // on the next round, which is still inside the portal's window.
        const message = err instanceof Error ? err.message : String(err);
        this.#status = { ...this.#status, lastError: message };
        this.#log(`keep-alive failed, will retry: ${message}`);
      }
    });
  }

  /**
   * Runs fn with the signed-in client and saves the cookies it changed.
   * Throws SignInRequired when there is no session or the portal ended it.
   */
  async use<T>(fn: (client: ClalitClient) => Promise<T>): Promise<T> {
    // Another process (a second client, or the CLI) may have signed in since.
    if (!this.#client) await this.reload();
    if (this.#client && this.#pastEnd()) await this.#serial(() => this.#lost(new Error(LENGTH_ENDED)));
    const client = this.#client;
    if (!client) throw new SignInRequired(this.signInHint);
    try {
      const result = await fn(client);
      await this.#serial(() => this.#save());
      return result;
    } catch (err) {
      if (err instanceof ReauthenticationRequired) {
        await this.#serial(() => this.#lost(err));
        throw new SignInRequired(this.signInHint);
      }
      throw err;
    }
  }

  /** Forgets the session here and in the store, as if nobody had signed in. */
  async signOut(): Promise<void> {
    await this.#serial(async () => {
      this.#client = undefined;
      this.#endsAt = undefined;
      await this.#store.clear();
      this.#set({ state: "signed_out" });
      this.#log("signed out");
    });
  }

  #pastEnd(): boolean {
    return this.#endsAt !== undefined && this.#now() >= this.#endsAt;
  }

  #ends(): Pick<KeeperStatus, "endsAt"> {
    return this.#endsAt === undefined ? {} : { endsAt: new Date(this.#endsAt).toISOString() };
  }

  async #save(): Promise<void> {
    if (!this.#client) return;
    await this.#store.save(await this.#client.exportSession());
  }

  async #lost(err: unknown): Promise<void> {
    const had = this.#client !== undefined || this.#status.state === "signed_in";
    this.#client = undefined;
    await this.#store.clear();
    const message = err instanceof Error ? err.message : String(err);
    const byLength = message === LENGTH_ENDED;
    if (!(err instanceof ReauthenticationRequired) && !byLength) {
      this.#log(`could not open the saved session: ${message}`);
    }
    this.#set({
      ...this.#ends(),
      state: "expired",
      ...(this.#status.signedInAt ? { signedInAt: this.#status.signedInAt } : {}),
      endedAt: new Date(this.#now()).toISOString(),
      lastError: message,
    });
    if (byLength) this.#log("the chosen session length ran out; signed out");
    else if (had) this.#log("Clalit ended the session; a new sign-in is needed");
  }

  #set(status: KeeperStatus): void {
    const changed = status.state !== this.#status.state;
    this.#status = status;
    if (changed) this.onChange?.(this.status());
  }

  /** Keep-alive rounds, reloads and saves never overlap. */
  #serial(fn: () => Promise<void>): Promise<void> {
    const run = this.#busy.then(fn, fn);
    this.#busy = run.catch(() => undefined);
    return run;
  }
}
