import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExportSink } from "@clalit/core";

/** The export folder on disk. A file takes its name only once it is whole, so a run cut off mid-write leaves no half document. */
export function folderSink(dir: string): ExportSink {
  const write = async (rel: string, data: string | Uint8Array) => {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.part`;
    await writeFile(tmp, data);
    await rename(tmp, path);
  };
  return {
    async exists(rel) {
      return existsSync(join(dir, rel));
    },
    putJson: (rel, value) => write(rel, JSON.stringify(value, null, 2) + "\n"),
    putBytes: (rel, bytes) => write(rel, bytes),
    putText: (rel, text) => write(rel, text),
  };
}
