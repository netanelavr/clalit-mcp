/**
 * Loopback browser login (maccabi-health style).
 *
 * Starts http://127.0.0.1:<port>/ where the member enters Israeli ID, CAPTCHA
 * (image proxied from the portal when available), and SMS OTP. Writes the same
 * session.json as terminal `login`. Never bypasses Imperva or solves CAPTCHA.
 *
 * Flow uses Post/Redirect/Get (303) so Continue never double-POSTs into a
 * cleared pending slot. CAPTCHA/OTP answers are buffered durably so a submit
 * that races ahead of solveCaptcha/readOtp still counts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { open, unlink, mkdir, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CAPTCHA_CHECK_BUDGET_MS,
  login,
  type CaptchaChallenge,
  type LoginPrompts,
  type OtpChallenge,
} from "@clalit/core";
import { saveSession } from "./store.js";
import { warmPortalCookiesViaPlaywright } from "./playwright-cookies.js";

const LOCAL_HOST = "127.0.0.1" as const;
/** Browser login wall-clock budget (ID + CAPTCHA + SMS). */
export const HTTP_LOGIN_TTL_MS = 30 * 60 * 1000;
/** After CAPTCHA Continue: show OTP or a clear error within this budget. */
export const CAPTCHA_CHECK_TIMEOUT_MS = CAPTCHA_CHECK_BUDGET_MS;
const BODY_LIMIT = 32 * 1024;
const CLIENT_LABEL = "clalit-mcp";

const LOCK_SCRIPT =
  'addEventListener("submit",function(e){var f=e.target;if(!(f instanceof HTMLFormElement))return;if(f.dataset.sent==="1"){e.preventDefault();return}f.dataset.sent="1";var b=f.querySelector("button");if(b){b.disabled=true}});addEventListener("pageshow",function(ev){if(ev.persisted){for(var f of document.forms){delete f.dataset.sent;var b=f.querySelector("button");if(b)b.disabled=false}}})';
const SCRIPT_HASH = createHash("sha256").update(LOCK_SCRIPT).digest("base64");

export const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; form-action 'self'`,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:1rem}
main{max-width:26rem;width:100%}
h1{font-size:1.25rem;margin:0 0 .25rem}
p{margin:.25rem 0 1rem;opacity:.8}
label{display:block;margin:.75rem 0 .25rem;font-weight:600}
input[type=text]{width:100%;box-sizing:border-box;padding:.6rem;font:inherit;border:1px solid #8888;border-radius:.4rem}
button{margin-top:1rem;padding:.6rem 1.1rem;font:inherit;border:0;border-radius:.4rem;background:#0b6e4f;color:#fff;cursor:pointer}
button:disabled,form[data-sent] button{opacity:.6;cursor:default;pointer-events:none}
.note{font-size:.85rem;opacity:.7}
.err{color:#b00020;margin:0 0 1rem}
img.captcha{max-width:100%;height:auto;border:1px solid #8884;border-radius:.4rem;margin:.5rem 0;background:#fff}`;

function layout(title: string, body: string, opts?: { refreshSeconds?: number }): string {
  const refresh =
    opts?.refreshSeconds && opts.refreshSeconds > 0
      ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}"/>`
      : "";
  return `<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${refresh}<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main><script>${LOCK_SCRIPT}</script></body></html>`;
}

function errorBlock(error?: string): string {
  return error ? `<p class="err">${escapeHtml(error)}</p>` : "";
}

export function idPage(csrf: string, error?: string, presetId?: string): string {
  const idVal = presetId ? escapeHtml(presetId) : "";
  return layout(
    "Sign in to Clalit",
    `<h1>Sign in to Clalit</h1>
<p>${escapeHtml(CLIENT_LABEL)} needs your own Clalit session on this machine.</p>
${errorBlock(error)}
<form method="post" action="/">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/>
<input type="hidden" name="step" value="id"/>
<label for="id">Israeli ID number (תעודת זהות)</label>
<input id="id" name="id" type="text" inputmode="numeric" autocomplete="username" required pattern="\\d{1,9}" value="${idVal}"/>
<p class="note">CAPTCHA and SMS OTP come next. Nothing is solved automatically. Imperva is not bypassed.</p>
<button type="submit">Continue</button>
</form>`,
  );
}

export function captchaPage(
  csrf: string,
  opts: { hasImage: boolean; fieldHint?: string; error?: string },
): string {
  const img = opts.hasImage
    ? `<p><img class="captcha" src="/captcha.png" alt="CAPTCHA from Clalit portal"/></p>`
    : `<p class="note">CAPTCHA image could not be loaded here. Open the Clalit portal in another tab on this machine if needed, then type the characters below.</p>`;
  const hint = opts.fieldHint ? `<p class="note">Captcha field: ${escapeHtml(opts.fieldHint)}</p>` : "";
  return layout(
    "Enter CAPTCHA",
    `<h1>Enter CAPTCHA</h1>
<p>Type the characters from the Clalit BotDetect image. This tool does not solve or bypass CAPTCHA.</p>
${errorBlock(opts.error)}
${img}
${hint}
<form method="post" action="/">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/>
<input type="hidden" name="step" value="captcha"/>
<label for="captcha">CAPTCHA text</label>
<input id="captcha" name="captcha" type="text" autocomplete="off" required autofocus/>
<button type="submit">Continue</button>
</form>`,
  );
}

export function otpPage(csrf: string, message: string, error?: string): string {
  return layout(
    "Enter SMS code",
    `<h1>Enter SMS code</h1>
<p>${escapeHtml(message)}</p>
${errorBlock(error)}
<form method="post" action="/">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/>
<input type="hidden" name="step" value="otp"/>
<label for="otp">SMS OTP</label>
<input id="otp" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" required pattern="\\d{4,8}" autofocus/>
<button type="submit">Sign in</button>
</form>`,
  );
}

export function donePage(): string {
  return layout(
    "Signed in",
    `<h1>Signed in</h1>
<p>Session saved under the clalit-mcp config directory (mode 0600). You can close this tab.</p>
<p class="note">Idle sessions expire after ~30 minutes of inactivity. Re-run login when reads fail.</p>`,
  );
}

export function errorPage(message: string): string {
  return layout(
    "Sign-in stopped",
    `<h1>Sign-in stopped</h1>
<p>${escapeHtml(message)}</p>
<p class="note">Close this window and run <code>clalit-mcp login --http</code> again. Or use terminal prompts: <code>clalit-mcp login</code>. Never bypass Imperva.</p>`,
  );
}

/** Waiting / intermediate UI. Gentle head refresh so phase changes (OTP / error) appear without a manual reload. */
export function waitingPage(title: string, body: string, refreshSeconds = 2): string {
  return layout(
    title,
    `<h1>${escapeHtml(title)}</h1><p class="note">${escapeHtml(body)}</p>`,
    { refreshSeconds },
  );
}

function sendHtml(res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...PAGE_HEADERS, ...extra });
  res.end(html);
}

/** PRG: POST → 303 → GET so Refresh/double-Continue cannot replay the POST. */
function redirectSeeOther(res: ServerResponse, location = "/"): void {
  res.writeHead(303, {
    location,
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  res.end("Redirecting…\n");
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > BODY_LIMIT) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

type Phase =
  | "id"
  | "loading_captcha"
  | "captcha"
  | "submitting_captcha"
  | "otp"
  | "submitting_otp"
  | "done"
  | "failed";

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function openBrowser(url: string): void {
  try {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* best-effort */
  }
}

function configDir(): string {
  if (process.env.CLALIT_CONFIG_DIR) return process.env.CLALIT_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "clalit-mcp");
  return join(homedir(), ".config", "clalit-mcp");
}

function httpLoginLockPath(): string {
  return join(configDir(), "http-login.lock");
}

/**
 * Exclusive lock so a second `login --http` cannot open another loopback
 * server that races the same browser tabs / clears in-flight CAPTCHA state.
 */
async function tryAcquireLockFile(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, "wx", 0o600);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
    if (code === "EEXIST") return null;
    throw err;
  }
}

export async function acquireHttpLoginLock(): Promise<{ release: () => Promise<void> } | null> {
  const path = httpLoginLockPath();
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  let handle = await tryAcquireLockFile(path);
  if (!handle) {
    // Stale lock from a crashed previous login --http: reclaim if pid is gone.
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(path, "utf8");
      const pid = Number(raw.split("\n")[0]);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return null; // still alive
        } catch {
          await unlink(path).catch(() => undefined);
          handle = await tryAcquireLockFile(path);
        }
      } else {
        await unlink(path).catch(() => undefined);
        handle = await tryAcquireLockFile(path);
      }
    } catch {
      return null;
    }
  }
  if (!handle) return null;
  await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await handle!.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
    },
  };
}

/**
 * Deliver a buffered answer to a waiter, or store it until the waiter arrives.
 * Used so CAPTCHA/OTP Continue can win a race against solveCaptcha/readOtp.
 */
export function takeOrWait(
  slot: { value?: string; pending?: Pending<string> },
  next: string,
): void {
  if (slot.pending) {
    const p = slot.pending;
    slot.pending = undefined;
    slot.value = undefined;
    p.resolve(next);
    return;
  }
  slot.value = next;
}

export function waitForAnswer(slot: { value?: string; pending?: Pending<string> }): Promise<string> {
  if (slot.value !== undefined) {
    const v = slot.value;
    slot.value = undefined;
    return Promise.resolve(v);
  }
  return new Promise<string>((resolve, reject) => {
    slot.pending = { resolve, reject };
  });
}

export interface RunLoginHttpOptions {
  idNumber?: string;
  port?: number;
  open?: boolean;
  ttlMs?: number;
  /** Test seam: skip the exclusive lockfile. */
  skipLock?: boolean;
}

/**
 * Run interactive login via a loopback HTTP page. Returns a process-style exit code.
 */
export async function runLoginHttp(options: RunLoginHttpOptions = {}): Promise<number> {
  const lock = options.skipLock ? { release: async () => undefined } : await acquireHttpLoginLock();
  if (!lock) {
    console.error(
      "Another clalit-mcp login --http is already running on this machine.",
    );
    console.error(
      "Finish or cancel that sign-in first. A second browser login would clear the CAPTCHA/OTP step.",
    );
    return 1;
  }

  try {
    return await runLoginHttpUnlocked(options);
  } finally {
    await lock.release();
  }
}

async function runLoginHttpUnlocked(options: RunLoginHttpOptions = {}): Promise<number> {
  const csrf = randomBytes(16).toString("hex");
  const ttlMs = options.ttlMs ?? HTTP_LOGIN_TTL_MS;
  let phase: Phase = "id";
  let lastError: string | undefined;
  let captchaMeta: { hasImage: boolean; fieldHint?: string } = { hasImage: false };
  let captchaBytes: Uint8Array | undefined;
  let captchaType = "image/png";
  let otpMessage = "Enter the SMS one-time code from Clalit.";
  let idNumber = options.idNumber?.trim() ?? "";
  let browserOpened = false;

  const idSlot: { value?: string; pending?: Pending<string> } = {};
  const captchaSlot: { value?: string; pending?: Pending<string> } = {};
  const otpSlot: { value?: string; pending?: Pending<string> } = {};

  let settleExit!: (code: number) => void;
  let exitSettled = false;
  const finished = new Promise<number>((resolve) => {
    settleExit = (code) => {
      if (exitSettled) return;
      exitSettled = true;
      resolve(code);
    };
  });

  let phaseWatchdog: ReturnType<typeof setTimeout> | undefined;
  const clearPhaseWatchdog = (): void => {
    if (phaseWatchdog !== undefined) {
      clearTimeout(phaseWatchdog);
      phaseWatchdog = undefined;
    }
  };

  const fail = (message: string, code = 1): void => {
    clearPhaseWatchdog();
    phase = "failed";
    lastError = message;
    idSlot.pending?.reject(new Error(message));
    captchaSlot.pending?.reject(new Error(message));
    otpSlot.pending?.reject(new Error(message));
    idSlot.pending = captchaSlot.pending = otpSlot.pending = undefined;
    settleExit(code);
  };

  /** Fail with a clear UI error if a waiting phase never advances (e.g. hung portal POST). */
  const startPhaseWatchdog = (expected: Phase, ms: number, message: string): void => {
    clearPhaseWatchdog();
    phaseWatchdog = setTimeout(() => {
      if (phase === expected) {
        fail(message, 1);
      }
    }, ms);
  };

  const prompts: LoginPrompts = {
    async solveCaptcha(challenge: CaptchaChallenge) {
      captchaBytes = challenge.captchaImage?.bytes;
      captchaType = challenge.captchaImage?.contentType ?? "image/png";
      captchaMeta = {
        hasImage: Boolean(captchaBytes && captchaBytes.byteLength > 0),
        ...(challenge.captchaFieldName ? { fieldHint: challenge.captchaFieldName } : {}),
      };
      // If Continue already buffered an answer, consume it without flipping UI back.
      if (captchaSlot.value !== undefined) {
        phase = "submitting_captcha";
        lastError = undefined;
        const answer = await waitForAnswer(captchaSlot);
        phase = "submitting_captcha";
        startPhaseWatchdog(
          "submitting_captcha",
          CAPTCHA_CHECK_TIMEOUT_MS,
          "Checking CAPTCHA timed out. Clalit did not reach the SMS OTP step within ~30s. Try again, or use terminal login: clalit-mcp login",
        );
        return answer;
      }
      phase = "captcha";
      lastError = undefined;
      const answer = await waitForAnswer(captchaSlot);
      phase = "submitting_captcha";
      startPhaseWatchdog(
        "submitting_captcha",
        CAPTCHA_CHECK_TIMEOUT_MS,
        "Checking CAPTCHA timed out. Clalit did not reach the SMS OTP step within ~30s. Try again, or use terminal login: clalit-mcp login",
      );
      return answer;
    },
    async readOtp(challenge: OtpChallenge) {
      clearPhaseWatchdog();
      otpMessage = challenge.message;
      if (otpSlot.value !== undefined) {
        phase = "submitting_otp";
        lastError = undefined;
        return waitForAnswer(otpSlot);
      }
      phase = "otp";
      lastError = undefined;
      return waitForAnswer(otpSlot);
    },
  };

  const renderCurrent = (res: ServerResponse): void => {
    if (phase === "done") {
      sendHtml(res, 200, donePage());
      return;
    }
    if (phase === "failed") {
      sendHtml(res, 200, errorPage(lastError ?? "Sign-in failed."));
      return;
    }
    if (phase === "loading_captcha") {
      sendHtml(
        res,
        200,
        waitingPage(
          "Loading CAPTCHA…",
          "Fetching the Clalit login page on this machine. If Imperva blocks this host, sign-in will stop.",
        ),
      );
      return;
    }
    if (phase === "submitting_captcha") {
      sendHtml(
        res,
        200,
        waitingPage(
          "Checking CAPTCHA…",
          "Waiting for Clalit (auto-refreshes). Next: SMS OTP — or a clear error within ~30s.",
        ),
      );
      return;
    }
    if (phase === "submitting_otp") {
      sendHtml(res, 200, waitingPage("Finishing sign-in…", "Saving the session file."));
      return;
    }
    if (phase === "captcha") {
      sendHtml(res, 200, captchaPage(csrf, { ...captchaMeta, error: lastError }));
      return;
    }
    if (phase === "otp") {
      sendHtml(res, 200, otpPage(csrf, otpMessage, lastError));
      return;
    }
    sendHtml(res, 200, idPage(csrf, lastError, idNumber || undefined));
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const host = req.headers.host ?? `${LOCAL_HOST}`;
        const url = new URL(req.url ?? "/", `http://${host}`);
        const method = req.method ?? "GET";

        if (url.pathname === "/captcha.png" && method === "GET") {
          if (!captchaBytes?.byteLength) {
            res.writeHead(404, { "cache-control": "no-store" });
            res.end();
            return;
          }
          res.writeHead(200, {
            "content-type": captchaType,
            "cache-control": "no-store",
            "content-length": String(captchaBytes.byteLength),
          });
          res.end(Buffer.from(captchaBytes));
          return;
        }

        if (url.pathname !== "/") {
          res.writeHead(404, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
          res.end("Not found.\n");
          return;
        }

        if (method === "GET") {
          renderCurrent(res);
          return;
        }

        if (method !== "POST") {
          res.writeHead(405, { allow: "GET, POST", "cache-control": "no-store" });
          res.end();
          return;
        }

        const body = await readBody(req);
        if (body === null) {
          sendHtml(res, 413, errorPage("That form submission was too large."));
          return;
        }
        const fields = new URLSearchParams(body);
        if (fields.get("csrf") !== csrf) {
          lastError = "This sign-in form expired (CSRF mismatch). Start login --http again.";
          phase = "failed";
          redirectSeeOther(res);
          return;
        }
        const step = fields.get("step");

        if (step === "id") {
          const id = (fields.get("id") ?? "").trim();
          if (!/^\d{1,9}$/.test(id)) {
            lastError = "Enter a valid Israeli ID number (digits only).";
            phase = "id";
            redirectSeeOther(res);
            return;
          }
          idNumber = id;
          lastError = undefined;
          // Idempotent: already past ID (e.g. second tab / double Continue).
          if (
            phase === "loading_captcha" ||
            phase === "captcha" ||
            phase === "submitting_captcha" ||
            phase === "otp" ||
            phase === "submitting_otp" ||
            phase === "done"
          ) {
            redirectSeeOther(res);
            return;
          }
          phase = "loading_captcha";
          takeOrWait(idSlot, id);
          redirectSeeOther(res);
          return;
        }

        if (step === "captcha") {
          const text = (fields.get("captcha") ?? "").trim();
          if (!text) {
            lastError = "Enter the CAPTCHA text.";
            if (phase !== "captcha" && phase !== "submitting_captcha") phase = "captcha";
            redirectSeeOther(res);
            return;
          }
          // Already accepted / in flight — PRG back to waiting UI (not fatal).
          if (phase === "submitting_captcha" || phase === "otp" || phase === "submitting_otp" || phase === "done") {
            redirectSeeOther(res);
            return;
          }
          if (phase === "failed") {
            redirectSeeOther(res);
            return;
          }
          // Buffer even if solveCaptcha has not installed a waiter yet (race),
          // or if a prior Continue already stored the same answer.
          if (phase === "captcha" || phase === "loading_captcha" || phase === "id") {
            lastError = undefined;
            phase = "submitting_captcha";
            takeOrWait(captchaSlot, text);
            redirectSeeOther(res);
            return;
          }
          // Wrong step (e.g. OTP screen): stay on current step with a soft error.
          lastError =
            "CAPTCHA Continue was ignored because that step is not waiting for input anymore. Use the form shown on this page, or restart login --http.";
          redirectSeeOther(res);
          return;
        }

        if (step === "otp") {
          const code = (fields.get("otp") ?? "").trim();
          if (!/^\d{4,8}$/.test(code)) {
            lastError = "Enter the SMS code (4–8 digits).";
            if (phase !== "otp" && phase !== "submitting_otp") phase = "otp";
            redirectSeeOther(res);
            return;
          }
          if (phase === "submitting_otp" || phase === "done") {
            redirectSeeOther(res);
            return;
          }
          if (phase === "failed") {
            redirectSeeOther(res);
            return;
          }
          if (phase === "otp" || phase === "submitting_captcha" || phase === "captcha") {
            lastError = undefined;
            phase = "submitting_otp";
            takeOrWait(otpSlot, code);
            redirectSeeOther(res);
            return;
          }
          lastError =
            "SMS OTP Continue was ignored because that step is not waiting for input anymore. Use the form shown on this page, or restart login --http.";
          redirectSeeOther(res);
          return;
        }

        lastError = "Unknown form step.";
        redirectSeeOther(res);
      } catch {
        if (!res.headersSent) sendHtml(res, 500, errorPage("The sign-in step could not be completed."));
        else res.end();
      }
    })();
  });

  const listenPort = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, LOCAL_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server).catch(() => undefined);
    console.error("Browser login server did not bind a TCP port.");
    return 1;
  }
  const url = `http://${LOCAL_HOST}:${address.port}/`;
  console.error(`Open this page on this machine to sign in (CAPTCHA + SMS OTP):`);
  console.error(url);
  console.error(
    `Loopback only (${LOCAL_HOST}). Expires in ${Math.round(ttlMs / 60000)} minutes. No Imperva/CAPTCHA bypass.`,
  );
  if (options.open !== false && !browserOpened) {
    browserOpened = true;
    openBrowser(url);
  }

  const timeout = setTimeout(() => {
    fail("No browser sign-in finished within the time limit. Run login --http again.", 1);
  }, ttlMs);

  const loginTask = (async () => {
    try {
      if (!idNumber) {
        phase = "id";
        idNumber = await waitForAnswer(idSlot);
      } else {
        // Preset --id: start portal login immediately; UI may still show ID briefly.
        phase = "loading_captcha";
      }

      const seedCookies = await warmPortalCookiesViaPlaywright();
      const client = await login(
        idNumber,
        prompts,
        seedCookies?.length ? { seedCookies } : {},
      );
      const session = await client.exportSession();
      await saveSession(session);
      clearPhaseWatchdog();
      phase = "done";
      lastError = undefined;
      settleExit(0);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
      if (code === "BOT_CHALLENGE") {
        fail(
          "Imperva blocked this host (often Error 16 on datacenter/cloud IPs). Run login --http on your Mac / home network. Never bypass Imperva.",
          3,
        );
        return;
      }
      if (code === "TIMEOUT" || code === "CAPTCHA_CHECK_TIMEOUT") {
        fail(
          "Checking CAPTCHA timed out. Clalit did not respond in time (~30s). Try again, or use terminal login: clalit-mcp login",
          1,
        );
        return;
      }
      if (code === "CAPTCHA_REJECTED") {
        fail(
          "CAPTCHA was rejected by Clalit. Run login --http again (or terminal: clalit-mcp login), refresh the image, and retry.",
          1,
        );
        return;
      }
      if (code === "OTP_PAGE_MISSING") {
        fail(
          "Clalit did not open the SMS OTP step after CAPTCHA. Try again, or use terminal login: clalit-mcp login",
          1,
        );
        return;
      }
      if (code === "OTP_SESSION_INCOMPLETE") {
        fail(
          (err instanceof Error ? err.message : "OTP session incomplete.") +
            " See ~/.config/clalit-mcp/login-hops-*.json (cookie names only).",
          1,
        );
        return;
      }
      fail(err instanceof Error ? err.message : "Login failed.", 1);
    }
  })();

  try {
    const code = await finished;
    clearTimeout(timeout);
    await loginTask.catch(() => undefined);
    // Brief pause so the browser can follow the last 303 to done/error.
    await new Promise((r) => setTimeout(r, 800));
    if (code === 0) {
      console.log("Signed in. Session saved under the clalit-mcp config directory (mode 0600).");
    }
    return code;
  } finally {
    clearTimeout(timeout);
    clearPhaseWatchdog();
    server.closeIdleConnections?.();
    await closeServer(server).catch(() => undefined);
  }
}
