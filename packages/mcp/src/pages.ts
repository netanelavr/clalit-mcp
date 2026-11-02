import { LENGTH_ENDED, type KeeperStatus } from "./keeper.js";

export const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:1rem}
main{max-width:30rem;width:100%}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:.25rem 0 1rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem;margin:0 0 1rem}
dt{opacity:.7}
dd{margin:0}
form{display:inline-block;margin:0 .5rem .5rem 0}
button{padding:.6rem 1.1rem;font:inherit;border:0;border-radius:.4rem;background:#0b6e4f;color:#fff;cursor:pointer}
button.secondary{background:#8884;color:inherit}
label{display:block;margin:0 0 1rem}
select{font:inherit;padding:.4rem;margin-left:.5rem;border-radius:.4rem}
.note{font-size:.85rem;opacity:.7}
.err{color:#b00020}`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

function when(iso?: string): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Jerusalem" });
}

/** How long a sign-in lasts, as offered at sign-in: value => [label, ms]. */
export const SESSION_LENGTHS: Record<string, [string, number]> = {
  "1h": ["1 hour", 3_600_000],
  "6h": ["6 hours", 6 * 3_600_000],
  "12h": ["12 hours", 12 * 3_600_000],
  "1d": ["1 day", 24 * 3_600_000],
  "2d": ["2 days", 48 * 3_600_000],
  "1w": ["1 week", 7 * 24 * 3_600_000],
};
export const DEFAULT_SESSION_LENGTH = "1d";

function signInForm(csrf: string, label: string, secondary: boolean): string {
  const options = Object.entries(SESSION_LENGTHS)
    .map(([value, [text]]) => `<option value="${value}"${value === DEFAULT_SESSION_LENGTH ? " selected" : ""}>${text}</option>`)
    .join("");
  return `<form method="post" action="sign-in"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/>
<label>Stay signed in for<select name="length">${options}</select></label>
<button type="submit"${secondary ? ' class="secondary"' : ""}>${escapeHtml(label)}</button></form>`;
}

/** Before a sign-in: how long it should last, then the Clalit sign-in page. */
export function signInPage(status: KeeperStatus, csrf: string): string {
  let why = "Nobody is signed in to Clalit yet.";
  if (status.state === "expired") {
    why =
      status.lastError === LENGTH_ENDED
        ? `The session length you chose ran out at ${when(status.endedAt)}.`
        : `Clalit ended the session at ${when(status.endedAt)}.`;
  }
  return layout(
    "Sign in to Clalit",
    `<h1>Sign in to Clalit</h1>
<p>${escapeHtml(why)} Signing in takes your ID, a CAPTCHA and an SMS code. While the MCP server runs it keeps the session alive for as long as you choose, and signs out at the end of it.</p>
${signInForm(csrf, "Sign in", false)}`,
  );
}

export function statusPage(status: KeeperStatus, csrf: string): string {
  return layout(
    "Clalit MCP",
    `<h1>Clalit MCP</h1>
<p>Signed in to Clalit. While the MCP server runs it keeps the session alive, so your assistant can read your records until the session ends (or Clalit ends it sooner).</p>
<dl>
<dt>Signed in</dt><dd>${escapeHtml(when(status.signedInAt))}</dd>
<dt>Ends</dt><dd>${escapeHtml(status.endsAt ? when(status.endsAt) : "when Clalit ends it")}</dd>
<dt>Last checked</dt><dd>${escapeHtml(when(status.lastCheckedAt))}</dd>
</dl>
${status.lastError ? `<p class="err">Last keep-alive error: ${escapeHtml(status.lastError)}</p>` : ""}
${signInForm(csrf, "Sign in again", true)}
<form method="post" action="sign-out"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/><button type="submit" class="secondary">Sign out</button></form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
