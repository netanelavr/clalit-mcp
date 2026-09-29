import { connect, decodeLabRef } from "@clalit/core";
import { writeFile } from "node:fs/promises";
import { help } from "./commands.js";
import { runLogin } from "./login.js";
import { clearSession, loadSession } from "./store.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--")) return args[i + 1];
  return undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

async function requireClient() {
  const session = await loadSession();
  if (!session) {
    console.error("Not signed in. Run: clalit-health login");
    return undefined;
  }
  return connect(session);
}

export async function runCli(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(help(rest[0]));
    return 0;
  }

  switch (cmd) {
    case "login":
      return runLogin(flag(rest, "id"));
    case "logout":
      await clearSession();
      console.log("Local session deleted.");
      return 0;
    case "labs": {
      const client = await requireClient();
      if (!client) return 3;
      try {
        const data = await client.listLabs({
          fromDate: flag(rest, "from"),
          toDate: flag(rest, "to"),
        });
        if (has(rest, "json")) console.log(JSON.stringify({ data }, null, 2));
        else {
          for (const row of data) {
            const token = row.refToken ?? "";
            console.log(`${row.date}\t${row.name}\t${row.summary ?? ""}\t${token}`);
          }
        }
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "labs failed");
        return 1;
      }
    }
    case "lab": {
      const ref = flag(rest, "ref");
      if (!ref) {
        console.error("Usage: clalit-health lab --ref TOKEN");
        return 2;
      }
      const client = await requireClient();
      if (!client) return 3;
      try {
        const data = await client.getLabResult(ref);
        if (has(rest, "json")) console.log(JSON.stringify({ data }, null, 2));
        else {
          console.log(data.title);
          if (data.date) console.log(data.date);
          for (const a of data.analytes) {
            console.log(
              [a.name, a.result, a.units ?? "", a.referenceRange ?? "", a.flag ?? ""]
                .filter(Boolean)
                .join("\t"),
            );
          }
          for (const n of data.notes) console.log(n);
          if (data.hasDocument) console.log("(document available — use lab-document)");
        }
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "lab failed");
        return 1;
      }
    }
    case "lab-document": {
      const ref = flag(rest, "ref");
      const out = flag(rest, "out");
      if (!ref || !out) {
        console.error("Usage: clalit-health lab-document --ref TOKEN --out FILE");
        return 2;
      }
      // Validate token early for clearer errors
      decodeLabRef(ref);
      const client = await requireClient();
      if (!client) return 3;
      try {
        const doc = await client.getLabDocument(ref);
        await writeFile(out, doc.bytes);
        console.log(`Wrote ${out} (${doc.filename}, ${doc.bytes.byteLength} bytes)`);
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "lab-document failed");
        return 1;
      }
    }
    case "refresh-session": {
      const client = await requireClient();
      if (!client) return 3;
      try {
        await client.refreshSession();
        const session = await client.exportSession();
        const { saveSession } = await import("./store.js");
        await saveSession(session);
        console.log("RefreshSession.aspx OK; session file updated.");
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "refresh failed");
        return 1;
      }
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.log(help());
      return 2;
  }
}
