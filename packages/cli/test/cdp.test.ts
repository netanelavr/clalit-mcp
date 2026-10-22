import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { BROWSERS, isFile } from "../src/cdp.js";

/** Needs a Chrome, Chromium or Edge on this machine and Node's WebSocket (22+); skipped otherwise. */
const canRun = BROWSERS.some(isFile) && typeof WebSocket !== "undefined";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CHILD = fileURLToPath(new URL("./helpers/cdp-child.ts", import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

/** Runs the helper as the CLI would run: it must exit by itself within the timeout. Returns the browser's pid. */
async function runChild(mode: "close" | "detach", profileDir: string): Promise<number> {
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", CHILD, profileDir, mode], { cwd: ROOT, timeout: 15_000 });
  const pid = Number(/pid (\d+)/.exec(stdout)?.[1]);
  expect(pid).toBeGreaterThan(0);
  return pid;
}

describe.skipIf(!canRun)("DevTools client (headless browser)", () => {
  const profiles: string[] = [];
  const browsers: number[] = [];
  afterEach(async () => {
    for (const pid of browsers.splice(0)) {
      // The browser has a process group of its own; its helpers can outlive it and keep writing to the profile.
      const group = process.platform === "win32" ? pid : -pid;
      if (alive(group)) process.kill(group, "SIGTERM");
      await until(() => !alive(group), 5000);
    }
    for (const dir of profiles.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const profile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "clalit-cdp-"));
    profiles.push(dir);
    return dir;
  };

  test("close() ends the browser and the process exits", async () => {
    const pid = await runChild("close", profile());
    browsers.push(pid);
    expect(await until(() => !alive(pid), 5000)).toBe(true);
  });

  test("detach() lets the process exit while the browser stays open (--keep-open)", async () => {
    const pid = await runChild("detach", profile());
    browsers.push(pid);
    await new Promise((r) => setTimeout(r, 1000));
    expect(alive(pid)).toBe(true);
  });
});
