# API sources

Evidence base: redacted Gate 2 HAR map (`docs/research/gate2-redacted-map.json`) plus prescriptions / LabOrders redacted map (field names only; HARs not committed).

## Surface

- ASP.NET WebForms (`__VIEWSTATE` / `__EVENTVALIDATION` / `__doPostBack`)
- Mostly `text/html`
- Labs PDF via POST returning `application/octet-stream`
- Prescriptions issue status via JSON POST (read status only)

## Hosts

- `e-services.clalit.co.il` (primary)
- `accessibility.clalit.co.il` (allowlisted; not required for MVP reads)

## Labs

| Operation | Method / path |
| --- | --- |
| List | `GET /OnlineWeb/Services/Labs/LabsTestList.aspx` |
| Date fields | `…LabsHistory1$datepickerRangeCalendar$txtFromDate` / `$txtToDate` |
| Grid | `LabsHistory1$gvTestListInDateRange` |
| Detail | `GET /OnlineWeb/Services/Labs/LabTestDetails.aspx` query `s`, `d`, `ls` |
| Document | `POST` detail with `__EVENTTARGET` download control |

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

| Step | Path |
| --- | --- |
| Login + CAPTCHA | `/onlineweb/general/infootplogin.aspx` |
| SMS OTP | `/OnlineWeb/General/OTPSMSVerification.aspx` |
| Login redirect | `/OnlineWeb/General/Login.aspx` |

## Session

- `GET /OnlineWeb/ServicesForAll/RefreshSession.aspx`
- TTL unmeasured

## Not in HAR / still blocked (do not invent)

- `MedicalReferrals.aspx` flow (nav link only)
- Prescription / lab-order PDF bytes
- Stable OpenAPI schemas beyond IssueDrugs key names
- Silent renewal proof
- Owner-id bootstrap field name
