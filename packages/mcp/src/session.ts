/**
 * The signed-in side of the stdio server: one live Clalit session kept alive
 * in this process, and a small sign-in page that starts it.
 *
 * Settings (environment):
 *   CLALIT_CONFIG_DIR  where the session is saved (default ~/.config/clalit-mcp)
 *   CLALIT_LOGIN_HOST  address the sign-in page listens on (default 127.0.0.1)
 *   CLALIT_LOGIN_PORT  its port (default 8765; a free port if that one is taken)
 *   CLALIT_LOGIN_URL   the link handed out, when the page is reached through a
 *                      reverse proxy (default http://localhost:<port>/); when
 *                      set, the page starts with the server instead of on the
 *                      first sign-in request
 *
 * The ID, CAPTCHA and SMS code are typed on that page only. The model is only
 * ever given its link.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { clearSession, loadSession, saveSession, sessionPath } from "@clalit/cli/store";
import { SessionKeeper, SignInRequired, type KeeperStatus } from "./keeper.js";
import { LoginPage } from "./login-page.js";
import { DEFAULT_SESSION_LENGTH, PAGE_HEADERS, SESSION_LENGTHS, messagePage, signInPage, statusPage } from "./pages.js";

const log = (line: string): void => console.error(`[clalit-mcp] ${line}`);

export interface SessionStatus extends KeeperStatus {
  /** Where the user signs in, once the sign-in page is up. */
  signInUrl?: string;
}

export class SessionManager {
  readonly keeper = new SessionKeeper({
    store: { load: loadSession, save: saveSession, clear: clearSession },
  });
  readonly #csrf = randomBytes(16).toString("hex");
  readonly #host = process.env.CLALIT_LOGIN_HOST || "127.0.0.1";
  readonly #port = Number(process.env.CLALIT_LOGIN_PORT || 8765);
  readonly #fixedUrl = process.env.CLALIT_LOGIN_URL || undefined;
  #server: Promise<string> | undefined;
  #http: Server | undefined;
  #pendingLengthMs = SESSION_LENGTHS[DEFAULT_SESSION_LENGTH]![1];
  readonly #login = new LoginPage({
    log,
    onSignedIn: async () => {
      const endsAt = Date.now() + this.#pendingLengthMs;
      await saveEndsAt(endsAt);
      this.keeper.setEndsAt(endsAt);
      await this.keeper.reload();
    },
  });

  /** Picks up a saved session and starts the keep-alive loop. */
  async start(): Promise<void> {
    this.keeper.setEndsAt(await loadEndsAt());
    await this.keeper.start();
    // Behind a reverse proxy the page is opened directly, so it is up from the start.
    if (this.#fixedUrl) await this.signInUrl();
  }

  stop(): void {
    this.keeper.stop();
    void this.#server?.then(() => this.#http?.close());
  }

  /** Starts the sign-in page if it is not up yet and returns its link. */
  signInUrl(): Promise<string> {
    this.#server ??= this.#listen().catch((err: unknown) => {
      this.#server = undefined;
      throw err;
    });
    return this.#server;
  }

  async status(): Promise<SessionStatus> {
    const status = this.keeper.status();
    if (status.state === "signed_in") return status;
    return { ...status, signInUrl: await this.signInUrl() };
  }

  async signOut(): Promise<void> {
    await this.keeper.signOut();
    await unlink(limitPath()).catch(() => undefined);
  }

  /** The signed-in client, or an error that carries the sign-in link. */
  async client() {
    // A sign-in in another process wrote its own end time beside the session.
    if (this.keeper.status().state !== "signed_in") this.keeper.setEndsAt(await loadEndsAt());
    try {
      return await this.keeper.use(async (client) => client);
    } catch (err) {
      if (err instanceof SignInRequired) {
        const url = await this.signInUrl();
        throw new SignInRequired(
          `Not signed in to Clalit (the session ended, or nobody has signed in yet). ` +
            `Ask the user to open ${url} and sign in there with their ID, the CAPTCHA and the SMS code, then try again. ` +
            `Never ask the user for these in the chat.`,
        );
      }
      throw err;
    }
  }

  async #listen(): Promise<string> {
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        log(`sign-in front failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) page(res, 500, messagePage("Something went wrong", "Reload the page and try again."));
        else res.end();
      });
    });
    const bind = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, this.#host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      });
    let port: number;
    try {
      port = await bind(this.#port);
    } catch (err) {
      // Another client's copy of this server holds the port: any free one will do locally.
      if ((err as { code?: string }).code !== "EADDRINUSE" || this.#fixedUrl) throw err;
      port = await bind(0);
    }
    server.unref();
    this.#http = server;
    const url = this.#fixedUrl ?? `http://localhost:${port}/`;
    log(`sign-in page on ${this.#host}:${port}, linked as ${url}`);
    return url;
  }

  /** Only the hosts the link names: a page another site rebinds to 127.0.0.1 gets nothing. */
  #hostAllowed(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    const name = host.replace(/:\d+$/, "");
    if (name === "localhost" || name === "127.0.0.1" || name === "[::1]") return true;
    if (!this.#fixedUrl) return false;
    return host === new URL(this.#fixedUrl).host.toLowerCase();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#hostAllowed(req)) {
      page(res, 421, messagePage("Wrong address", "Open the sign-in link exactly as it was given."));
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "POST" && (path === "/sign-in" || path === "/sign-out")) {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("csrf") !== this.#csrf) {
        page(res, 400, messagePage("Form expired", "Reload the page and try again."));
        return;
      }
      if (path === "/sign-out") {
        await this.signOut();
      } else {
        const length = SESSION_LENGTHS[form.get("length") ?? DEFAULT_SESSION_LENGTH];
        if (!length) {
          page(res, 400, messagePage("Unknown session length", "Reload the page and pick one of the lengths offered."));
          return;
        }
        if (!this.#login.running) this.#pendingLengthMs = length[1];
        this.#login.start();
      }
      res.writeHead(303, { location: "./", "cache-control": "no-store" }).end();
      return;
    }
    // While a sign-in runs, every other request is its page.
    if (this.#login.running) {
      try {
        await this.#login.proxy(req, res);
      } catch (err) {
        if (!res.headersSent) page(res, 502, messagePage("Sign-in page unavailable", err instanceof Error ? err.message : String(err)));
      }
      return;
    }
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, clalit: this.keeper.status().state }));
      return;
    }
    if (path !== "/" || req.method !== "GET") {
      res.writeHead(404).end();
      return;
    }
    const status = this.keeper.status();
    page(res, 200, status.state === "signed_in" ? statusPage(status, this.#csrf) : signInPage(status, this.#csrf));
  }
}

function page(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, PAGE_HEADERS).end(html);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 16 * 1024) throw new Error("form too large");
  }
  return body;
}

// When the current sign-in ends, as chosen on the page; kept beside the
// session so a restart keeps it. A session with none (signed in from the CLI)
// gets the default length from its sign-in time.
function limitPath(): string {
  return join(dirname(sessionPath()), "session-limit.json");
}

async function loadEndsAt(): Promise<number | undefined> {
  const saved = await readFile(limitPath(), "utf8").then(
    (text) => (JSON.parse(text) as { endsAt?: number }).endsAt,
    () => undefined,
  );
  if (typeof saved === "number") return saved;
  const session = await loadSession();
  return session ? Date.parse(session.authenticatedAt) + SESSION_LENGTHS[DEFAULT_SESSION_LENGTH]![1] : undefined;
}

async function saveEndsAt(endsAt: number): Promise<void> {
  const path = limitPath();
  await writeFile(`${path}.tmp`, JSON.stringify({ endsAt }), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
