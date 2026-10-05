# API sources

Evidence from **redacted HAR notes** (path and field **names** only; raw HARs are never committed). Status: partial pass from captured traffic plus later live HTML checks. Prescriptions and lab orders follow the same process.

## Surface

- ASP.NET WebForms (`__VIEWSTATE` / `__EVENTVALIDATION` / `__doPostBack`)
- Mostly `text/html`
- Labs PDF via POST returning `application/octet-stream`
- Prescriptions issue status via JSON POST (read status only)

## Hosts

- `e-services.clalit.co.il` (primary)
- `accessibility.clalit.co.il` (allowlisted; not required for MVP reads)

## Owner scope

- Family switch controls exist in HTML (`FamilySliderControl21$au`, `FamilySliderControl21$cu`). **MVP rule:** never set family switch; only follow detail links from the authenticated owner's own list pages.

## Labs

| Operation | Method / path |
| --- | --- |
| List | `GET /OnlineWeb/Services/Labs/LabsTestList.aspx` |
| Date fields | `ctl00$ctl00$cphBody$bodyContent$LabsHistory1$datepickerRangeCalendar$txtFromDate` / `$txtToDate` |
| Grid | `LabsHistory1$gvTestListInDateRange` (pager/sort via `__doPostBack`) |
| Detail | `GET /OnlineWeb/Services/Labs/LabTestDetails.aspx` query `s`, `d`, `ls` |
| Document | `POST` same detail page with `__EVENTTARGET` (left-menu download control) → `application/octet-stream` PDF |
| Compare links (param names) | `labId`, `labName`, `t` |

## Prescriptions (מרשמים)

| Operation | Method / path |
| --- | --- |
| List | `GET /OnlineWeb/Services/Medicine/PatientPrescriptionsex.aspx` |
| Date / filter fields | `dateRange$txtFromDate` / `$txtToDate`, `chkIncludeExpiredPrescriptions`, `hdnSectionID` |
| Repeaters | `rptPatientPrescriptions$ctlNN` → nested `rptMedicine$ctlNN` |
| Row `data-*` | `data-prescription`, `data-medicineId`, `data-medicineFormName`, `data-medicineStartDate` |
| Issue status (read) | `POST /onlineweb/api/PatientPrescriptions/IssueDrugsByPatientReceiptId` |
| Issue request keys | `prescriptionNo`, `medicationID`, `medicationFormName`, `medicationStartDate`, `sectionId`, `currStatusValue` |
| Issue response keys | `statusCode_0`, `statusDesc_0` (JSON-encoded string wrapper) |
| Print / PDF | `PatientPrescriptionsExPrint.aspx` — **not fetched** |

## Lab orders (הפניות לבדיקות מעבדה)

| Operation | Method / path |
| --- | --- |
| List | `GET /OnlineWeb/Services/LabOrders/LabOrderList.aspx` |
| Grid | `gvLabOrdersList` (`lnkOrderDetails`, `dcLabSectionList`, date/referer/valid fields) |
| Empty marker | `NoLabOrdersFound` (may appear alongside rows) |
| Detail | `GET /OnlineWeb/Services/LabOrders/LabOrderDetails.aspx?ord=` |
| Detail items | `gvLabOrdersItem` (`dcLabSection`, `dcTestName`) |
| Print / PDF | UI only — **not fetched** |

## Auth

Interactive user + CAPTCHA + SMS OTP. No JSON auth API observed.

| Step | Path / notes |
| --- | --- |
| Login + CAPTCHA | `POST /onlineweb/general/infootplogin.aspx` — fields include `tbUserId`, `tbCaptchaLogin`, BotDetect captcha id |
| SMS OTP | `GET/POST /OnlineWeb/General/OTPSMSVerification.aspx` — field `txtClientOTP` |
| Login redirect | `GET /OnlineWeb/General/Login.aspx` (302 observed) |

## Session

- `GET /OnlineWeb/ServicesForAll/RefreshSession.aspx` (observed in traffic; small HTML)
- TTL **unmeasured**

## Portal terms (nav hint)

Observed link path: `/he/info/services/Documents/clalit_on_line_terms_2025.pdf`

## Not observed / still blocked (do not invent)

- `MedicalReferrals.aspx` flow (nav link only)
- Prescription / lab-order PDF bytes
- Stable OpenAPI schemas beyond IssueDrugs key names
- Silent renewal proof
- Session TTL measurement
- Owner-id bootstrap field name
- Cross-account enumerability tests
