# CLI

```sh
npx tsx packages/cli/src/main.ts help
npx tsx packages/cli/src/main.ts login
npx tsx packages/cli/src/main.ts labs --json
npx tsx packages/cli/src/main.ts lab --ref TOKEN --json
npx tsx packages/cli/src/main.ts lab-document --ref TOKEN --out file.pdf
npx tsx packages/cli/src/main.ts prescriptions --json
npx tsx packages/cli/src/main.ts prescription-status --prescription NO --medication ID --form NAME --start DATE --section ID --json
npx tsx packages/cli/src/main.ts lab-orders --json
npx tsx packages/cli/src/main.ts lab-order --ref TOKEN --json
npx tsx packages/cli/src/main.ts export [--out DIR] [--from dd.MM.yyyy] [--to dd.MM.yyyy] [--no-documents] [--current-only]
npx tsx packages/cli/src/main.ts refresh-session
npx tsx packages/cli/src/main.ts logout
npx tsx packages/cli/src/main.ts mcp
```

`login` opens a loopback browser page for CAPTCHA + SMS OTP. `--http` is accepted as a no-op alias.

Exit codes: `0` success, `1` operation failure, `2` usage, `3` login / Imperva block.

`export` writes `clalit-export-<today>/` (Israel's calendar) with `labs/`, `prescriptions/`, `lab-orders/` and the
root files `README.md` (the export's data dictionary, for an assistant), `export-errors.json`, `CLAUDE.md`, `AGENTS.md`.
Requests are paced 300 ms apart; a failed item is filed and the export continues; an ended session stops it with
exit `3` and keeps what was collected (rerun into the same folder to continue). Reads only, own record only.
