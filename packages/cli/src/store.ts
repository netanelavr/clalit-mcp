import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ClalitSession } from "@clalit/core";

function configDir(): string {
  if (process.env.CLALIT_CONFIG_DIR) return process.env.CLALIT_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "clalit-mcp");
  return join(homedir(), ".config", "clalit-mcp");
}

export function sessionPath(): string {
  return join(configDir(), "session.json");
}

async function writePrivate(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function saveSession(session: ClalitSession): Promise<void> {
  await writePrivate(sessionPath(), JSON.stringify(session, null, 2));
}

export async function loadSession(): Promise<ClalitSession | undefined> {
  try {
    const raw = await readFile(sessionPath(), "utf8");
    const parsed = JSON.parse(raw) as ClalitSession;
    if (parsed?.version !== 1 || !parsed.cookies || !parsed.authenticatedAt) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function clearSession(): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  await unlink(sessionPath()).catch(() => undefined);
}
