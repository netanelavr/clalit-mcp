#!/usr/bin/env node
import { runCli } from "./cli.js";

const args = process.argv.slice(2);
if (args[0] === "mcp") {
  const { runMcp } = await import("../../mcp/src/main.js");
  process.exitCode = await runMcp(args.slice(1));
} else {
  process.exitCode = await runCli(args);
}
