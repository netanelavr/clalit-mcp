import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { runLoginHttp } from "@clalit/cli/http-login";

/**
 * Runs the CLI's sign-in page (ID, CAPTCHA, SMS code) on demand.
 *
 * runLoginHttp serves its pages on a free 127.0.0.1 port and returns once the
 * sign-in finished or gave up; the sign-in front proxies to it while it runs.
 * Only one sign-in runs at a time.
 */
export class LoginPage {
  readonly #onSignedIn: () => Promise<void>;
  readonly #log: (line: string) => void;
  #running: Promise<number> | undefined;
  #port: number | undefined;

  constructor(options: { onSignedIn: () => Promise<void>; log?: (line: string) => void }) {
    this.#onSignedIn = options.onSignedIn;
    this.#log = options.log ?? ((line) => console.error(`[login] ${line}`));
  }

  get running(): boolean {
    return this.#running !== undefined;
  }

  start(): void {
    if (this.#running) return;
    this.#log("sign-in page started");
    this.#port = undefined;
    this.#running = runLoginHttp({
      open: false,
      onListening: (port) => {
        this.#port = port;
      },
    }).then(
      async (code) => {
        this.#log(code === 0 ? "signed in" : `sign-in page closed (exit ${code})`);
        this.#running = undefined;
        if (code === 0) await this.#onSignedIn();
        return code;
      },
      (err: unknown) => {
        this.#log(`sign-in page failed: ${err instanceof Error ? err.message : String(err)}`);
        this.#running = undefined;
        return 1;
      },
    );
  }

  /** Passes a request through to the sign-in page, waiting while it starts listening. */
  async proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readAll(req);
    for (let attempt = 0; ; attempt++) {
      const port = this.#port;
      try {
        if (port === undefined) throw Object.assign(new Error("sign-in page is starting"), { code: "ECONNREFUSED" });
        await forward(port, req, body, res);
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ECONNREFUSED" && attempt < 40 && this.#running) {
          await new Promise((r) => setTimeout(r, 150));
          continue;
        }
        throw err;
      }
    }
  }
}

function forward(port: number, req: IncomingMessage, body: Buffer, res: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, host: `127.0.0.1:${port}`, "content-length": String(body.length) };
    delete headers["transfer-encoding"];
    const upstream = httpRequest({ host: "127.0.0.1", port, method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
      up.on("end", resolve);
      up.on("error", reject);
    });
    upstream.on("error", reject);
    upstream.end(body);
  });
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
