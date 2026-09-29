# Changelog

## Unreleased

- `login --http`: fix CAPTCHA Continue race (PRG 303, durable answer buffer, no meta-refresh spam, soft step-mismatch errors). Exclusive lock against a second browser login clearing in-flight state. Loopback + soft idle TTL raised to ~30 minutes.
- `login --http`: loopback browser page for ID + CAPTCHA image + SMS OTP (same session file as terminal login). No Imperva/CAPTCHA bypass.

## 0.1.0 — 2026-09-29

- Initial public scaffold: `@clalit/core`, `@clalit/cli`, `@clalit/mcp`.
- Labs MVP parsers: `listLabs`, `getLabResult`, `getLabDocument` against WebForms HTML fixtures.
- Interactive login design (CAPTCHA + SMS OTP); live verify documented for Mac/residential only.
- Roadmap stubs documented for מרשמים / הפניות (no invented endpoints).
