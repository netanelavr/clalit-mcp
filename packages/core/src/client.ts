import { ClalitAuth, type LoginOptions, type LoginPrompts } from "./auth.js";
import { ClalitReaders } from "./readers.js";
import type { ClalitSession } from "./session.js";
import { ClalitTransport } from "./transport.js";

export type ClalitClient = ClalitReaders & {
  exportSession(): Promise<ClalitSession>;
  refreshSession(): Promise<void>;
};

async function open(session: ClalitSession): Promise<ClalitClient> {
  const transport = new ClalitTransport({ session });
  const readers = new ClalitReaders(transport);
  const auth = new ClalitAuth(transport);
  return Object.assign(readers, {
    exportSession: () => transport.exportSession(),
    refreshSession: () => auth.refreshSession(),
  });
}

/** Interactive CAPTCHA + SMS OTP login on the caller's machine. */
export async function login(
  idNumber: string,
  prompts: LoginPrompts,
  options: LoginOptions = {},
): Promise<ClalitClient> {
  const auth = new ClalitAuth();
  const session = await auth.loginInteractive(idNumber, prompts, options);
  return open(session);
}

/** Opens a session previously returned by `client.exportSession()`. */
export function connect(session: ClalitSession): Promise<ClalitClient> {
  return open(session);
}
