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
npx tsx packages/cli/src/main.ts refresh-session
npx tsx packages/cli/src/main.ts logout
npx tsx packages/cli/src/main.ts mcp
```

`login` opens a loopback browser page for CAPTCHA + SMS OTP. `--http` is accepted as a no-op alias.

Exit codes: `0` success, `1` operation failure, `2` usage, `3` login / Imperva block.
