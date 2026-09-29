import { startStdioServer } from "./stdio.js";

export async function runMcp(_args: string[]): Promise<number> {
  await startStdioServer();
  // stdio server runs until stdin closes
  return 0;
}
