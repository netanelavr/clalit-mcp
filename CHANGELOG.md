# Changelog

## Unreleased

- Terminal `login`: when CAPTCHA is requested, print the portal URL on its own line (`https://e-services.clalit.co.il/onlineweb/general/infootplogin.aspx`) so terminals can make it clickable.
- `login --http` / `login()`: after CAPTCHA submit, advance to OTP or show a clear failure within ~30s (per-request transport timeout + overall captcha-check budget). Follow redirects / OTP GET; detect CAPTCHA rejected vs missing OTP page. Waiting UI gently auto-refreshes so OTP/errors appear without a manual reload. Terminal fallback: `clalit-mcp login`.
- `login --http`: fix CAPTCHA Continue race (PRG 303, durable answer buffer, soft step-mismatch errors). Exclusive lock against a second browser login clearing in-flight state. Loopback + soft idle TTL raised to ~30 minutes.
- `login --http`: loopback browser page for ID + CAPTCHA image + SMS OTP (same session file as terminal login). No Imperva/CAPTCHA bypass.

## 0.1.0 — 2026-09-29

- Initial public scaffold: `@clalit/core`, `@clalit/cli`, `@clalit/mcp`.
- Labs MVP parsers: `listLabs`, `getLabResult`, `getLabDocument` against WebForms HTML fixtures.
- Interactive login design (CAPTCHA + SMS OTP); live verify documented for Mac/residential only.
- Roadmap stubs documented for מרשמים / הפניות (no invented endpoints).
