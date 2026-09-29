import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function ask(question: string, opts: { mask?: boolean } = {}): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive terminal required for login prompts.");
  }
  const rl = createInterface({ input, output, terminal: true });
  try {
    if (opts.mask && typeof (rl as unknown as { stdoutMuted?: boolean }).stdoutMuted === "boolean") {
      // best-effort; Node readline has no built-in mask — still echo for OTP UX clarity
    }
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}
