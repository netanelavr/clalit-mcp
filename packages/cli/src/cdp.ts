/**
 * The member's own Chrome, Chromium or Edge, opened on a profile of its own and driven over the
 * DevTools Protocol with nothing but Node's WebSocket — no Playwright, no automation flag, so the
 * browser is the ordinary one Imperva already lets in. Used by `login --browser`: the member signs
 * in by hand in this window; the CLI only watches the page and reads the cookies afterwards.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const BROWSERS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((p): p is string => Boolean(p));

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const REPLY_MS = 30_000;

type Params = Record<string, unknown>;
type Handler = (params: Params, sessionId?: string) => void;

export interface BrowserPage {
  /** A protocol command on the page's session (or the browser's when `browser` is true). */
  send(method: string, params?: Params, opts?: { browser?: boolean; timeoutMs?: number }): Promise<Params>;
  /** Subscribes to a protocol event (enable its domain first); returns the unsubscribe. */
  on(method: string, handler: Handler): () => void;
  /** Evaluates an expression in the page; a page between documents throws. */
  evaluate<T>(expression: string): Promise<T>;
  navigate(url: string): Promise<void>;
  sessionId: string;
  close(): void;
}

export function defaultProfileDir(configDir: string): string {
  return join(configDir, "browser-profile");
}

/**
 * Opens the browser on `startUrl` with `profileDir` as its profile and attaches to the page.
 * `extraArgs` (CLALIT_BROWSER_ARGS, space-separated) go to the browser as given — a test's --headless=new.
 */
export async function openBrowser(startUrl: string, profileDir: string, extraArgs: string[] = (process.env.CLALIT_BROWSER_ARGS ?? "").split(" ").filter(Boolean)): Promise<BrowserPage> {
  if (typeof WebSocket === "undefined") {
    throw new Error("login --browser needs Node 22 or newer (its WebSocket).");
  }
  const exe = BROWSERS.find(isFile);
  if (!exe) throw new Error("No Chrome, Chromium or Edge found; set CHROME_PATH to the browser's executable.");
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const browser: ChildProcess = spawn(exe, [
    "--remote-debugging-port=0",
    "--user-data-dir=" + profileDir,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1100,900",
    ...extraArgs,
    startUrl,
  ]);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    browser.kill();
  };
  process.once("exit", close);

  const wsUrl = await new Promise<string>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(
      () => reject(new Error(`The browser did not start. Is a window on ${profileDir} already open? Close it and run again.\n${log}`)),
      30_000,
    );
    browser.stderr?.on("data", (d: Buffer) => {
      log += d.toString();
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    browser.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("The browser exited before it could be reached.\n" + log));
    });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Could not connect to the browser's DevTools socket."));
  });
  let lastId = 0;
  const pending = new Map<number, { resolve: (v: Params) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<Handler>>();
  ws.onmessage = (e: MessageEvent) => {
    const m = JSON.parse(String(e.data)) as { id?: number; method?: string; params?: Params; sessionId?: string; error?: { message: string }; result?: Params };
    if (m.method) {
      for (const f of listeners.get(m.method) ?? []) f(m.params ?? {}, m.sessionId);
      return;
    }
    const p = m.id !== undefined ? pending.get(m.id) : undefined;
    if (!p || m.id === undefined) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result ?? {});
  };
  const raw = (method: string, params: Params = {}, sessionId?: string, timeoutMs = REPLY_MS): Promise<Params> => {
    const id = ++lastId;
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<Params>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: no reply in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  };

  // The first page target, once the browser has one on https://.
  let target: { targetId: string } | undefined;
  for (let i = 0; !target; i += 1) {
    const { targetInfos } = (await raw("Target.getTargets")) as { targetInfos: { type: string; url: string; targetId: string }[] };
    target = targetInfos.find((t) => t.type === "page" && t.url.startsWith(startUrl)) ?? (i > 20 ? targetInfos.find((t) => t.type === "page") : undefined);
    if (!target) await new Promise((r) => setTimeout(r, 500));
  }
  const { sessionId } = (await raw("Target.attachToTarget", { targetId: target.targetId, flatten: true })) as { sessionId: string };

  const page: BrowserPage = {
    send: (method, params = {}, opts = {}) => raw(method, params, opts.browser ? undefined : sessionId, opts.timeoutMs),
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(handler);
      return () => listeners.get(method)!.delete(handler);
    },
    async evaluate<T>(expression: string): Promise<T> {
      const { result, exceptionDetails } = (await raw("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)) as {
        result: { value: T };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      };
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    },
    async navigate(url) {
      await raw("Page.navigate", { url }, sessionId);
    },
    sessionId,
    close() {
      try {
        ws.close();
      } catch {
        /* closing anyway */
      }
      close();
    },
  };
  return page;
}
