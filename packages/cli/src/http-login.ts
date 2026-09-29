/**
 * Loopback browser login (maccabi-health style).
 *
 * Starts http://127.0.0.1:<port>/ where the member enters Israeli ID, CAPTCHA
 * (image proxied from the portal when available), and SMS OTP. Writes the same
 * session.json as terminal `login`. Never bypasses Imperva or solves CAPTCHA.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { login, type CaptchaChallenge, type LoginPrompts, type OtpChallenge } from "@clalit/core";
import { saveSession } from "./store.js";

const LOCAL_HOST = "127.0.0.1" as const;
export const HTTP_LOGIN_TTL_MS = 10 * 60 * 1000;
const BODY_LIMIT = 32 * 1024;
const CLIENT_LABEL = "clalit-mcp";

const LOCK_SCRIPT =
  'addEventListener("submit",function(e){var f=e.target;if(f.dataset.sent){e.preventDefault();return}f.dataset.sent="1";var b=f.querySelector("button");setTimeout(function(){if(b)b.disabled=true})});addEventListener("pageshow",function(){for(var f of document.forms){delete f.dataset.sent;var b=f.querySelector("button");if(b)b.disabled=false}})';
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

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
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
<p class="note">Idle sessions expire quickly (~10 minutes). Re-run login when reads fail.</p>`,
  );
}

export function errorPage(message: string): string {
  return layout(
    "Sign-in stopped",
    `<h1>Sign-in stopped</h1>
<p>${escapeHtml(message)}</p>
<p class="note">Close this window and run <code>clalit-mcp login --http</code> again. Never bypass Imperva.</p>`,
  );
}

function sendHtml(res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...PAGE_HEADERS, ...extra });
  res.end(html);
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

type Phase = "id" | "captcha" | "otp" | "done" | "failed";

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

export interface RunLoginHttpOptions {
  idNumber?: string;
  port?: number;
  open?: boolean;
  ttlMs?: number;
}

/**
 * Run interactive login via a loopback HTTP page. Returns a process-style exit code.
 */
export async function runLoginHttp(options: RunLoginHttpOptions = {}): Promise<number> {
  const csrf = randomBytes(16).toString("hex");
  const ttlMs = options.ttlMs ?? HTTP_LOGIN_TTL_MS;
  let phase: Phase = "id";
  let lastError: string | undefined;
  let captchaMeta: { hasImage: boolean; fieldHint?: string } = { hasImage: false };
  let captchaBytes: Uint8Array | undefined;
  let captchaType = "image/png";
  let otpMessage = "Enter the SMS one-time code from Clalit.";
  let idNumber = options.idNumber?.trim() ?? "";

  let idPending: Pending<string> | undefined;
  let captchaPending: Pending<string> | undefined;
  let otpPending: Pending<string> | undefined;
  let settleExit!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    settleExit = resolve;
  });

  const fail = (message: string, code = 1): void => {
    phase = "failed";
    lastError = message;
    idPending?.reject(new Error(message));
    captchaPending?.reject(new Error(message));
    otpPending?.reject(new Error(message));
    idPending = captchaPending = otpPending = undefined;
    settleExit(code);
  };

  const prompts: LoginPrompts = {
    async solveCaptcha(challenge: CaptchaChallenge) {
      captchaBytes = challenge.captchaImage?.bytes;
      captchaType = challenge.captchaImage?.contentType ?? "image/png";
      captchaMeta = {
        hasImage: Boolean(captchaBytes && captchaBytes.byteLength > 0),
        ...(challenge.captchaFieldName ? { fieldHint: challenge.captchaFieldName } : {}),
      };
      phase = "captcha";
      lastError = undefined;
      return new Promise<string>((resolve, reject) => {
        captchaPending = { resolve, reject };
      });
    },
    async readOtp(challenge: OtpChallenge) {
      otpMessage = challenge.message;
      phase = "otp";
      lastError = undefined;
      return new Promise<string>((resolve, reject) => {
        otpPending = { resolve, reject };
      });
    },
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
          if (phase === "done") sendHtml(res, 200, donePage());
          else if (phase === "failed") sendHtml(res, 200, errorPage(lastError ?? "Sign-in failed."));
          else if (phase === "captcha") sendHtml(res, 200, captchaPage(csrf, { ...captchaMeta, error: lastError }));
          else if (phase === "otp") sendHtml(res, 200, otpPage(csrf, otpMessage, lastError));
          else sendHtml(res, 200, idPage(csrf, lastError, idNumber || undefined));
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
          sendHtml(res, 400, errorPage("This sign-in form expired. Close the tab and run login --http again."));
          return;
        }
        const step = fields.get("step");

        if (step === "id") {
          const id = (fields.get("id") ?? "").trim();
          if (!/^\d{1,9}$/.test(id)) {
            lastError = "Enter a valid Israeli ID number (digits only).";
            sendHtml(res, 200, idPage(csrf, lastError));
            return;
          }
          idNumber = id;
          lastError = undefined;
          if (idPending) {
            const p = idPending;
            idPending = undefined;
            p.resolve(id);
          }
          // Show a waiting page while portal login + captcha fetch runs.
          sendHtml(
            res,
            200,
            layout(
              "Loading CAPTCHA",
              `<h1>Loading CAPTCHA…</h1><p class="note">Fetching the Clalit login page on this machine. If Imperva blocks this host, sign-in will stop.</p><meta http-equiv="refresh" content="1"/>`,
            ),
          );
          return;
        }

        if (step === "captcha") {
          const text = (fields.get("captcha") ?? "").trim();
          if (!text) {
            lastError = "Enter the CAPTCHA text.";
            sendHtml(res, 200, captchaPage(csrf, { ...captchaMeta, error: lastError }));
            return;
          }
          if (!captchaPending || phase !== "captcha") {
            sendHtml(res, 200, errorPage("CAPTCHA step is not active. Restart login --http."));
            return;
          }
          const p = captchaPending;
          captchaPending = undefined;
          lastError = undefined;
          p.resolve(text);
          sendHtml(
            res,
            200,
            layout(
              "Sending…",
              `<h1>Checking CAPTCHA…</h1><p class="note">Waiting for Clalit. Next: SMS OTP.</p><meta http-equiv="refresh" content="1"/>`,
            ),
          );
          return;
        }

        if (step === "otp") {
          const code = (fields.get("otp") ?? "").trim();
          if (!/^\d{4,8}$/.test(code)) {
            lastError = "Enter the SMS code (4–8 digits).";
            sendHtml(res, 200, otpPage(csrf, otpMessage, lastError));
            return;
          }
          if (!otpPending || phase !== "otp") {
            sendHtml(res, 200, errorPage("OTP step is not active. Restart login --http."));
            return;
          }
          const p = otpPending;
          otpPending = undefined;
          lastError = undefined;
          p.resolve(code);
          sendHtml(
            res,
            200,
            layout(
              "Finishing…",
              `<h1>Finishing sign-in…</h1><p class="note">Saving the session file.</p><meta http-equiv="refresh" content="1"/>`,
            ),
          );
          return;
        }

        sendHtml(res, 400, errorPage("Unknown form step."));
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
  console.error(`Loopback only (${LOCAL_HOST}). Expires in ${Math.round(ttlMs / 60000)} minutes. No Imperva/CAPTCHA bypass.`);
  if (options.open !== false) openBrowser(url);

  const timeout = setTimeout(() => {
    fail("No browser sign-in finished within the time limit.", 1);
  }, ttlMs);

  // Drive portal login once we have an ID (from --id or the form).
  const loginTask = (async () => {
    try {
      if (!idNumber) {
        idNumber = await new Promise<string>((resolve, reject) => {
          idPending = { resolve, reject };
        });
      } else if (!idPending) {
        // Preset id: still wait until the user submits the id form (or auto-kick).
        // Auto-start immediately when --id was provided and user may skip re-entry:
        // still show the page; submission resolves idPending if waiting.
        // If id already set via --id, start login right away without waiting for form.
      }

      const client = await login(idNumber, prompts);
      const session = await client.exportSession();
      await saveSession(session);
      phase = "done";
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
      fail(err instanceof Error ? err.message : "Login failed.", 1);
    }
  })();

  try {
    const code = await finished;
    clearTimeout(timeout);
    await loginTask.catch(() => undefined);
    // Brief pause so the browser can refresh to the done/error page.
    await new Promise((r) => setTimeout(r, 800));
    if (code === 0) {
      console.log("Signed in. Session saved under the clalit-mcp config directory (mode 0600).");
    }
    return code;
  } finally {
    clearTimeout(timeout);
    server.closeIdleConnections?.();
    await closeServer(server).catch(() => undefined);
  }
}
