# API sources

Evidence base: redacted Gate 2 HAR map (`docs/research/gate2-redacted-map.json`).

## Surface

- ASP.NET WebForms (`__VIEWSTATE` / `__EVENTVALIDATION` / `__doPostBack`)
- Mostly `text/html`
- PDF via POST returning `application/octet-stream`

## Hosts

- `e-services.clalit.co.il` (primary)
- `accessibility.clalit.co.il` (allowlisted; not required for labs MVP)

## Labs

| Operation | Method / path |
| --- | --- |
| List | `GET /OnlineWeb/Services/Labs/LabsTestList.aspx` |
| Date fields | `…LabsHistory1$datepickerRangeCalendar$txtFromDate` / `$txtToDate` |
| Grid | `LabsHistory1$gvTestListInDateRange` |
| Detail | `GET /OnlineWeb/Services/Labs/LabTestDetails.aspx` query `s`, `d`, `ls` |
| Document | `POST` detail with `__EVENTTARGET` download control |

## Auth

| Step | Path |
| --- | --- |
| Login + CAPTCHA | `/onlineweb/general/infootplogin.aspx` |
| SMS OTP | `/OnlineWeb/General/OTPSMSVerification.aspx` |
| Login redirect | `/OnlineWeb/General/Login.aspx` |

## Session

- `GET /OnlineWeb/ServicesForAll/RefreshSession.aspx`
- TTL unmeasured

## Not in HAR (do not invent)

- Stable JSON schemas
- Silent renewal proof
- Owner-id bootstrap field name
- Prescription / referral endpoints
