# Changelog

## Unreleased

- OTP postback sends `__EVENTTARGET=ctl00$cphBody$btnContinue$lnkSubButton` (live LinkButton). An empty event target redisplayed OTPSMSVerification with no `PostOtpAuth`; a cold `Login.aspx` GET then only set `.ONLINEAUTH` and labs stayed on the login redirect. Follow `Login.aspx` only after portal auth cookies (or a real redirect). `labs_login_redirect` no longer blames missing Imperva cookies.

- Login CAPTCHA: do not overwrite Libre BotDetect `LBD_VCID` with image query `t=` (cache-buster). Prefer the VCID already in the HTML.

- Login CAPTCHA POST: use live ASP.NET UniqueIDs (`ctl00$cphBody$tbUserId` / `tbCaptchaLogin`), Libre BotDetect `LBD_VCID_*` (and image `t=`), and `__EVENTTARGET=ctl00$cphBody$btnSendOTP` instead of short names / inventing `btnLogin`. Fixes CAPTCHA_REJECTED after a correct human reading. On reject, write a redacted shape dump under `~/.config/clalit-mcp/captcha-rejected-*.json` (keys only).
- Login CAPTCHA POST: round-trip BotDetect `BDC_*` fields even when they are `type="text"` (not hidden), include the login submit button, and set Referer/Origin. Previously the instance id never left the client, so Clalit redisplayed CAPTCHA after a correct reading.

- Terminal `login`: when CAPTCHA is requested, print the portal URL on its own line (`https://e-services.clalit.co.il/onlineweb/general/infootplogin.aspx`) so terminals can make it clickable.
- `login --http` / `login()`: after CAPTCHA submit, advance to OTP or show a clear failure within ~30s (per-request transport timeout + overall captcha-check budget). Follow redirects / OTP GET; detect CAPTCHA rejected vs missing OTP page. Waiting UI gently auto-refreshes so OTP/errors appear without a manual reload. Terminal fallback: `clalit-mcp login`.
- `login --http`: fix CAPTCHA Continue race (PRG 303, durable answer buffer, soft step-mismatch errors). Exclusive lock against a second browser login clearing in-flight state. Loopback + soft idle TTL raised to ~30 minutes.
- `login --http`: loopback browser page for ID + CAPTCHA image + SMS OTP (same session file as terminal login). No Imperva/CAPTCHA bypass.

## 0.1.0 — 2026-09-29

- Initial public scaffold: `@clalit/core`, `@clalit/cli`, `@clalit/mcp`.
- Labs MVP parsers: `listLabs`, `getLabResult`, `getLabDocument` against WebForms HTML fixtures.
- Interactive login design (CAPTCHA + SMS OTP); live verify documented for Mac/residential only.
- Roadmap stubs documented for מרשמים / הפניות (no invented endpoints).
