import { describe, expect, test, vi } from "vitest";
import { ReauthenticationRequired, type ClalitClient, type ClalitSession } from "@clalit/core";
import { LENGTH_ENDED, SessionKeeper, SignInRequired } from "../src/keeper.js";

const session: ClalitSession = { version: 1, cookies: { cookies: [] } as never, authenticatedAt: "2026-10-15T10:00:00.000Z" };

function fakeClient(overrides: Partial<ClalitClient> = {}): ClalitClient {
  return {
    refreshSession: vi.fn(async () => undefined),
    checkSession: vi.fn(async () => undefined),
    exportSession: vi.fn(async () => session),
    ...overrides,
  } as unknown as ClalitClient;
}

function fakeStore(initial?: ClalitSession) {
  let saved = initial;
  return {
    load: vi.fn(async () => saved),
    save: vi.fn(async (s: ClalitSession) => {
      saved = s;
    }),
    clear: vi.fn(async () => {
      saved = undefined;
    }),
  };
}

describe("SessionKeeper", () => {
  test("no saved session: signed out, tools get the sign-in hint", async () => {
    const keeper = new SessionKeeper({ store: fakeStore(), log: () => undefined });
    keeper.signInHint = "go sign in";
    await keeper.reload();
    expect(keeper.status().state).toBe("signed_out");
    await expect(keeper.use(async () => 1)).rejects.toThrow(new SignInRequired("go sign in"));
  });

  test("saved session that still works: signed in and saved back", async () => {
    const store = fakeStore(session);
    const client = fakeClient();
    const keeper = new SessionKeeper({ store, open: async () => client, log: () => undefined });
    await keeper.reload();
    expect(keeper.status().state).toBe("signed_in");
    expect(client.checkSession).toHaveBeenCalledOnce();
    expect(store.save).toHaveBeenCalled();
    expect(await keeper.use(async () => 42)).toBe(42);
  });

  test("tick pings every time and checks a page only when due", async () => {
    let now = 0;
    const client = fakeClient();
    const keeper = new SessionKeeper({
      store: fakeStore(session),
      open: async () => client,
      checkMs: 1000,
      now: () => now,
      log: () => undefined,
    });
    await keeper.reload();
    now = 500;
    await keeper.tick();
    expect(client.refreshSession).toHaveBeenCalledTimes(1);
    expect(client.checkSession).toHaveBeenCalledTimes(1);
    now = 1500;
    await keeper.tick();
    expect(client.refreshSession).toHaveBeenCalledTimes(2);
    expect(client.checkSession).toHaveBeenCalledTimes(2);
  });

  test("portal ends the session: expired, file cleared, listeners told", async () => {
    const store = fakeStore(session);
    const client = fakeClient({
      refreshSession: vi.fn(async () => {
        throw new ReauthenticationRequired(302);
      }),
    });
    const keeper = new SessionKeeper({ store, open: async () => client, log: () => undefined });
    await keeper.reload();
    const changes: string[] = [];
    keeper.onChange = (s) => changes.push(s.state);
    await keeper.tick();
    expect(keeper.status().state).toBe("expired");
    expect(store.clear).toHaveBeenCalled();
    expect(changes).toEqual(["expired"]);
    await expect(keeper.use(async () => 1)).rejects.toBeInstanceOf(SignInRequired);
  });

  test("a network error keeps the session for the next round", async () => {
    const client = fakeClient({
      refreshSession: vi.fn(async () => {
        throw new Error("NETWORK_ERROR");
      }),
    });
    const keeper = new SessionKeeper({ store: fakeStore(session), open: async () => client, log: () => undefined });
    await keeper.reload();
    await keeper.tick();
    expect(keeper.status().state).toBe("signed_in");
    expect(keeper.status().lastError).toBe("NETWORK_ERROR");
  });

  test("a tool call that hits the sign-in page expires the session", async () => {
    const client = fakeClient();
    const keeper = new SessionKeeper({ store: fakeStore(session), open: async () => client, log: () => undefined });
    await keeper.reload();
    await expect(
      keeper.use(async () => {
        throw new ReauthenticationRequired(302);
      }),
    ).rejects.toBeInstanceOf(SignInRequired);
    expect(keeper.status().state).toBe("expired");
  });

  test("the chosen session length runs out: signed out on the next round", async () => {
    let now = 0;
    const store = fakeStore(session);
    const client = fakeClient();
    const keeper = new SessionKeeper({ store, open: async () => client, now: () => now, log: () => undefined });
    keeper.setEndsAt(1000);
    await keeper.reload();
    expect(keeper.status()).toMatchObject({ state: "signed_in", endsAt: new Date(1000).toISOString() });
    now = 999;
    await keeper.tick();
    expect(keeper.status().state).toBe("signed_in");
    now = 1000;
    await keeper.tick();
    expect(keeper.status()).toMatchObject({ state: "expired", lastError: LENGTH_ENDED });
    expect(store.clear).toHaveBeenCalled();
    expect(client.refreshSession).toHaveBeenCalledTimes(1);
  });

  test("a tool call after the length ran out signs out instead of using Clalit", async () => {
    let now = 0;
    const keeper = new SessionKeeper({ store: fakeStore(session), open: async () => fakeClient(), now: () => now, log: () => undefined });
    keeper.setEndsAt(1000);
    await keeper.reload();
    now = 2000;
    const fn = vi.fn(async () => 1);
    await expect(keeper.use(fn)).rejects.toBeInstanceOf(SignInRequired);
    expect(fn).not.toHaveBeenCalled();
    expect(keeper.status().state).toBe("expired");
  });

  test("a saved session past its length is not reopened after a restart", async () => {
    const store = fakeStore(session);
    const open = vi.fn(async () => fakeClient());
    const keeper = new SessionKeeper({ store, open, now: () => 5000, log: () => undefined });
    keeper.setEndsAt(1000);
    await keeper.reload();
    expect(open).not.toHaveBeenCalled();
    expect(keeper.status()).toMatchObject({ state: "expired", lastError: LENGTH_ENDED });
    expect(store.clear).toHaveBeenCalled();
  });

  test("a sign-in written by another process is picked up on the next tool call", async () => {
    const store = fakeStore();
    const keeper = new SessionKeeper({ store, open: async () => fakeClient(), log: () => undefined });
    await keeper.reload();
    expect(keeper.status().state).toBe("signed_out");
    await store.save(session);
    expect(await keeper.use(async () => 7)).toBe(7);
    expect(keeper.status().state).toBe("signed_in");
  });

  test("sign out forgets the session and its end time", async () => {
    const store = fakeStore(session);
    const keeper = new SessionKeeper({ store, open: async () => fakeClient(), log: () => undefined });
    keeper.setEndsAt(Date.parse("2099-01-01T00:00:00.000Z"));
    await keeper.reload();
    await keeper.signOut();
    expect(keeper.status()).toEqual({ state: "signed_out" });
    expect(store.clear).toHaveBeenCalled();
    await expect(keeper.use(async () => 1)).rejects.toBeInstanceOf(SignInRequired);
  });
});

describe("SessionKeeper keeps the session on anything but a sign-in demand", () => {
  test("reload: a network error while checking keeps session.json and the client", async () => {
    const store = fakeStore(session);
    const client = fakeClient({
      checkSession: vi.fn(async () => {
        throw new Error("The Clalit request could not be completed (network error).");
      }),
    });
    const keeper = new SessionKeeper({ store, open: async () => client, log: () => undefined });
    await keeper.reload();
    expect(store.clear).not.toHaveBeenCalled();
    expect(keeper.status().state).toBe("signed_in");
    expect(keeper.status().lastError).toMatch(/network error/);
    // The client is usable meanwhile.
    expect(await keeper.use(async () => 7)).toBe(7);
  });

  test("reload: the portal demanding a sign-in does end the session", async () => {
    const store = fakeStore(session);
    const client = fakeClient({
      checkSession: vi.fn(async () => {
        throw new ReauthenticationRequired(302);
      }),
    });
    const keeper = new SessionKeeper({ store, open: async () => client, log: () => undefined });
    await keeper.reload();
    expect(store.clear).toHaveBeenCalledOnce();
    expect(keeper.status().state).toBe("expired");
  });

  test("reload: a session file that cannot be opened is left on disk", async () => {
    const store = fakeStore(session);
    const keeper = new SessionKeeper({
      store,
      open: async () => {
        throw new Error("bad cookie jar");
      },
      log: () => undefined,
    });
    await keeper.reload();
    expect(store.clear).not.toHaveBeenCalled();
    expect(keeper.status().state).toBe("signed_out");
    expect(keeper.status().lastError).toBe("bad cookie jar");
  });
});
