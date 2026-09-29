# Live verify (Netanel's Mac)

The shared agent box **cannot** complete Clalit login (Imperva Error 16). First live proof must happen on a residential/user machine.

## Checklist

1. Clone `https://github.com/netanelavr/clalit-health`, `npm install`, `npm test` (all offline tests green).
2. On your Mac (home/residential network, normal browser already works for Clalit):
   ```sh
   npx tsx packages/cli/src/main.ts login
   ```
3. Solve CAPTCHA when prompted; enter SMS OTP.
4. Confirm session file exists: `~/.config/clalit-health/session.json` (mode `0600`).
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
| Imperva Error 16 / `BOT_CHALLENGE` | Wrong network or automation fingerprint — use Mac UI network, no VPN datacenter |
| `REAUTHENTICATION_REQUIRED` | Idle/session expired — `login` again |
| Empty labs list | Account has no rows in range, or date filter format mismatch |
| `NO_DOCUMENT` / `NOT_PDF` | Portal control id differs — capture sanitized detail HTML |

## HAR hygiene

If you capture a new HAR for מרשמים / הפניות:

- Redact cookies, tokens, IDs, phone numbers, clinical values
- Keep only path + field **names** (like `docs/research/gate2-redacted-map.json`)
- Delete the raw HAR from disk after extracting the map
- Never commit `*.har`
