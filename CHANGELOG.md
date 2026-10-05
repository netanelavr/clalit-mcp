# Changelog

## Unreleased

- Docs / packaging: position the product as **CLI + MCP only**. `@clalit/core` remains a private workspace package shared by CLI/MCP — not advertised as a public Node library/SDK.
- Prescriptions list: parse human-readable `medicineName` from `colMedicineName` (sibling of the data-* panel) and strip trailing `;` from `medicineStartDate`.

- Prescriptions (מרשמים): `listPrescriptions` + optional `getPrescriptionIssueStatus` (IssueDrugsByPatientReceiptId read status only). CLI `prescriptions` / `prescription-status`; MCP `list_prescriptions` / `get_prescription_issue_status`. Zero-PHI fixtures. No PDF/print.
- Lab orders (הפניות לבדיקות מעבדה): `listLabOrders` + `getLabOrder`. CLI `lab-orders` / `lab-order`; MCP `list_lab_orders` / `get_lab_order`. Zero-PHI fixtures. Not `MedicalReferrals.aspx`; no PDF/print.
- Docs: CAPABILITIES / API-SOURCES / README / MCP / CLI updated; MedicalReferrals + PDFs remain out.

- Session save race: `ClalitTransport` cookie restore ran on `#queue` but `exportSession` / `listCookieNames` / `cookieCount` did not await it, so `login()` → `open(session)` → immediate `exportSession` + `saveSession` often wrote a truncated `session.json` (e.g. only `ASP.NET_SessionId`) while the live jar still had ~18 auth + defense cookies. Fix: session reads enqueue on the transport queue; `open`/`connect` await `whenReady()`; `login()` keeps the authenticated transport instead of serialize→deserialize. Re-run `clalit-mcp login --http` once after upgrading (truncated files cannot be repaired).

- Login OTP: after CAPTCHA/`HasOTP`, do not treat Login.aspx HTML that only *mentions* `OTPSMSVerification` as the OTP page. Require a real `txtClientOTP` input; follow Object-moved / GET `OTPSMSVerification.aspx` before collecting OTP fields. Fail closed with `OTP_PAGE_MISSING` (no SMS prompt / no OTP POST from Login.aspx ViewState). Fixes live `otp_source_not_otp_form` (2026-10-05).

- Login diagnostics: OTP failures explain themselves in one attempt. `otp-redisplay-*.json` / `login-hops-*.json` are now version 2 and still redacted: OTP POST status, Location path, content-type, page kind (`otp` | `login` | `personal_details` | `labs` | `object_moved` | `unknown`), Set-Cookie names, jar cookie names before and after, presence flags (`txtClientOTP` / `hdnRegExp` / `btnContinue` / CAPTCHA fields), missing or unexpected POST keys, the source page the OTP POST was built from (path, form action vs POST URL), validation text with digits stripped, and timings (CAPTCHA→OTP page, OTP page→code, POST). `OTP_SESSION_INCOMPLETE` carries a `why` reason code, Hebrew and English explanations, and dump paths. The `login --http` error page shows them. `login` and `login --http` print one redacted `[clalit login] <stage>: …` line per stage on stderr. Never prints the OTP, ID, cookie values, VIEWSTATE, or clinical data.

- OTP `__doPostBack` parsing accepts HTML entities (`&#39;` / `&apos;` / `&quot;`). Matching only raw quotes left `__EVENTTARGET` empty so OTPSMSVerification redisplayed (HTTP 200, no `PostOtpAuth`). Fallback UniqueID `ctl00$cphBody$btnContinue$lnkSubButton` when the OTP page is detected; round-trip hidden `hdnRegExp` when present. Successful live HAR lands on `PersonalDetails.aspx` (302), not cold Login. On OTP 200 redisplay, write redacted `otp-redisplay-*.json` (field names + event target only).

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
