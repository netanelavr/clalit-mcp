# Live verify (residential machine)

Datacenter and cloud IPs typically cannot complete Clalit login (Imperva Error 16). First live proof must happen on a residential or normal user network.

## Checklist

1. Clone `https://github.com/netanelavr/clalit-mcp`, `npm install`, `npm test` (all offline tests green).
2. On your own machine (home/residential network, normal browser already works for Clalit). Prefer the loopback HTTP UI so you can see the CAPTCHA image:
   ```sh
   npx tsx packages/cli/src/main.ts login --http
   ```
   Or terminal prompts only:
   ```sh
   npx tsx packages/cli/src/main.ts login
   ```
3. In the browser page (or terminal): enter Israeli ID, type the CAPTCHA shown from the portal (not solved automatically), then the SMS OTP. Same `session.json` either way.
4. Confirm session file exists: `~/.config/clalit-mcp/session.json` (mode `0600`).
5. Run:
   ```sh
   npx tsx packages/cli/src/main.ts labs --json | head
   ```
6. Pick one `ref`, fetch detail and PDF:
   ```sh
   npx tsx packages/cli/src/main.ts lab --ref '…' --json
   npx tsx packages/cli/src/main.ts lab-document --ref '…' --out /tmp/clalit-lab.pdf
   file /tmp/clalit-lab.pdf   # expect PDF
   ```
7. If HTML shape differs from fixtures, save a **sanitized** HTML sample (strip names/IDs/values) and open a PR to adjust parsers.
8. Delete `/tmp/clalit-lab.pdf` when done. Never commit it.

## Blockers to expect

| Symptom | Meaning |
| --- | --- |
| Imperva Error 16 / `BOT_CHALLENGE` | Wrong network or automation fingerprint — use a residential network, no VPN datacenter. `login --http` does **not** bypass Imperva |
| Stuck on **Checking CAPTCHA…** / `CAPTCHA_CHECK_TIMEOUT` / `TIMEOUT` | Portal POST hung or CAPTCHA rejected; UI should error within ~30s and auto-refresh. Retry `login --http`, or terminal fallback: `npx tsx packages/cli/src/main.ts login` |
| `CAPTCHA_REJECTED` / `OTP_PAGE_MISSING` | Wrong CAPTCHA or unexpected portal HTML — refresh image and retry. On reject, check `~/.config/clalit-mcp/captcha-rejected-*.json` (redacted field/POST keys) |
| `REAUTHENTICATION_REQUIRED` | Idle/session expired — `login` again |
| Empty labs list | Account has no rows in range, or date filter format mismatch |
| `NO_DOCUMENT` / `NOT_PDF` | Portal control id differs — capture sanitized detail HTML |

## HAR hygiene

If you capture a new HAR for מרשמים / הפניות:

- Redact cookies, tokens, IDs, phone numbers, clinical values
- Keep only path + field **names** (like `docs/research/redacted-endpoint-map.json`)
- Delete the raw HAR from disk after extracting the map
- Never commit `*.har`
