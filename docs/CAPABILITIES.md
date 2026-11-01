# Capabilities

## Implemented

| Read | CLI | MCP | Internal (`@clalit/core`, private) |
| --- | --- | --- | --- |
| Lab history list | `labs` | `list_labs` | `listLabs()` |
| Lab result detail | `lab --ref` | `get_lab_result` | `getLabResult(ref)` |
| Lab PDF | `lab-document` | `get_lab_document` | `getLabDocument(ref)` |
| Prescriptions list (מרשמים) | `prescriptions` | `list_prescriptions` | `listPrescriptions()` |
| Prescription issue status (read) | `prescription-status` | `get_prescription_issue_status` | `getPrescriptionIssueStatus(...)` |
| Lab orders list (הפניות לבדיקות מעבדה) | `lab-orders` | `list_lab_orders` | `listLabOrders()` |
| Lab order detail | `lab-order --ref` | `get_lab_order` | `getLabOrder(ref)` |
| Documents list (visit summaries, hospital summaries, medical approvals, Form 17) | `documents --source` | `list_documents` | `listDocuments(source)` |
| Document PDF | `document --ref` | `get_document` | `getDocument(ref)` |
| Records: diagnoses, sensitivities, chronic medications, purchased medicines, medication approvals, imaging (clinics / hospitals / external), hospital visits, hospital labs, referrals, appointments, recommendations, vaccinations, blood type | `records --source` | `list_records` | `listRecords(source)` |
| Record PDF (imaging report, referral) | `record-document --ref` | `get_record_document` | `getRecordDocument(ref)` |
| Hospital lab result page | `hospital-lab-result --link` | `get_hospital_lab_result` | `getHospitalLabResult(link, context)` |
| Export everything to a folder (documents and records included) | `export` | — | `exportAll(client, sink)` |
| Sign in / status / sign out | `login` / `logout` | `clalit_login` / `clalit_session_status` / `clalit_logout` | n/a |
| Map the portal's pages (value-free) | `tools/sitemap.mts` | — | n/a |

`@clalit/core` is a **private** workspace package shared by the CLI and MCP server. It is not a published SDK — do not advertise or document installing it as a library.

Upstream pages:

### Labs

- List: `GET /OnlineWeb/Services/Labs/LabsTestList.aspx`
- Detail: `GET /OnlineWeb/Services/Labs/LabTestDetails.aspx?s&d&ls`
- Document: `POST` same detail URL with `__EVENTTARGET` download control → `application/octet-stream` PDF

### Prescriptions (מרשמים)

- List: `GET /OnlineWeb/Services/Medicine/PatientPrescriptionsex.aspx`
- Issue status (read only): `POST /onlineweb/api/PatientPrescriptions/IssueDrugsByPatientReceiptId`
- Detail UX is client-side expand — no separate detail ASPX

### Lab orders (הפניות לבדיקות מעבדה)

- List: `GET /OnlineWeb/Services/LabOrders/LabOrderList.aspx`
- Detail: `GET /OnlineWeb/Services/LabOrders/LabOrderDetails.aspx?ord=`

### Documents

Pages sharing the portal's DownloadPdfBtnBinder flow: each grid row carries `data-actionurl` (a DoesPdfExists-style API call that also selects the document server-side), then `<page>PDF.ashx?show=true` streams the selected PDF. The grids show only their first page (10 rows), so a date-range search that fills a page is split in two until every half fits.

- Visit summaries: `GET/POST /OnlineWeb/Services/VisitSummaries/VisitSummaries.aspx` → `VisitSummariesPDF.ashx?show=true`
- Hospital summaries: `GET/POST /OnlineWeb/Services/SummaryLetter/SummaryLetter.aspx` (one search per hospital in the dropdown) → `SummaryLetterPDF.ashx?show=true`
- Medical approvals: `GET/POST /OnlineWeb/Services/MedicalApproval/MedicalApproval.aspx` → `MedicalApprovalPDFHandler.ashx?Print=false`
- Form 17: `GET /OnlineWeb/Services/Form17/Form17.aspx` (last year only) → `Form17PdfHandler.ashx?print=false`

### Records

One grid per page, all in Clalit Online's grid markup (`table.ClalitGridTable`, `th` headers, `tr.ClalitGridRow` / `ClalitGridAltRow`; the hidden `DescBlockRow` rows are skipped). Rows are kept as shown, keyed by the Hebrew headers. Pages with a date-range search get `txtFromDate` / `txtToDate` + the page's "show" link button (`__EVENTTARGET`); per-hospital pages are searched once per dropdown option; a pager (`PagerLink-N`) is walked, and a full page without one is split by date as the document grids are. Observed with `tools/sitemap.mts` (Oct 2026):

- Diagnoses: `GET /OnlineWeb/Services/Diagnosis/Diagnosis.aspx` (grid `gvDiagnosis`)
- Sensitivities: `GET /OnlineWeb/Services/Sensitivities/Sensitivities.aspx` (grid `gvSensitivities`)
- Chronic medications: `GET /OnlineWeb/Services/Medicine/PatientChronicDrugs.aspx` (grid `gvChronicMedications`)
- Medicines purchased: `GET/POST /onlineweb/Services/Medicine/MedicineSearch.aspx` (`dateRange$txtFromDate/To`, `btnShow`, pager `MedicineSearchCustomGrid$PagerLink-N`; since 01.08.2008)
- Medication approvals: `GET/POST /OnlineWeb/Services/Medicine/PatientExceptionMedRequests.aspx` (`DatepickerRangeCalendar$…`, `btnRequestsSearch`)
- Imaging, clinics: `GET/POST /OnlineWeb/Services/Rentgen/Rentgen.aspx` (`DatepickerRangeCalendar1$…`, `btnShow`; row action `/OnlineWeb/api/Rentgen/GetPDFDocument/…` (answers 200, empty: it selects the report) → `GET RentgenView.aspx`, which answers with the PDF; `RentgenPDFHandler.ashx` is the app's route and answers HTML on the web)
- Imaging, Clalit hospitals: `GET/POST /OnlineWeb/ServicesForAll/HospitalsVisits/RentgenHospitals.aspx` (+ `ddlHospitalName` fan-out → `HospitalsVisits/RentgenView.aspx`)
- Imaging, external institutes: `GET/POST /OnlineWeb/Services/rentgen/rentgenmor.aspx` (row action `/OnlineWeb/api/Fetoprotein/DoesPdfExists?documentId=…` → `Fetoprotein/AFPDisplayPDF.ashx?print=false`)
- Hospital visits: `GET/POST /OnlineWeb/ServicesForAll/HospitalsVisits/HospitalsVisitsList.aspx` (`LabsHistory1$datepickerRangeCalendar$…`, `LabsHistory1$ddlHospitalName` fan-out, `LabsHistory1$btnGetTestsAcc`)
- Hospital labs: `GET/POST /OnlineWeb/Services/HospitalsLabs/HospitalsLabsTestList.aspx` (same controls; grid `gvTestListInDateRange` with pager `LabsHistory1$gvTestListInDateRange$PagerLink-N`). Each row links to `HospitalsLabTestDetails.aspx?s&d&h`, the same `DetailedTestsResult1` control as the clinic labs' `LabTestDetails.aspx`, read with the lab-detail parser. The page answers only while its hospital is the portal's current search, so the row's search is replayed before it is opened.
- Appointments: `GET /OnlineWeb/Services/FamilyHomePage.aspx` — upcoming visits are `PopUpVisit('<doctor>','<member>','<id>','<guid>','<service>','<dd.MM.yyyy>','<HH:mm>')` calls; only doctor, service, date and time are kept.
- Recommendations: `GET /OnlineWeb/Services/Measures/Measures.aspx` — one accordion panel per recommendation (`*_ShowMeasure` title, panel text, "מעודכנת לתאריך dd.MM.yyyy").
- Vaccinations: `GET /OnlineWeb/api/Vaccins/GetVaccins` (what `/OnlineWeb/JSX/Vaccination/vaccineTable.jsx` reads) → `{ Results: "<JSON array>", Status }`; fields ExaminationName, ExaminationNameId, ExaminationDate, ExaminationLocation, ReportSource, GilYomiMonth.
- Blood type: `POST /OnlineWeb/api/BloodType/GetBloodTypeData` with body `null` (what `ReactBundles/BloodType.bundle.js` does) → the record, or status 10206 for "no data".
- Referrals: `GET/POST /OnlineWeb/Services/MedicalReferrals/MedicalReferrals.aspx` (`dateRange$…`, `MedicalReferralsList$chkNotValid` on, `btnShow`, pager `MedicalReferralsList$btnNext`; a repeater of `.dataHead` blocks each with a services table; action `/OnlineWeb/api/MedicalReferral/DoesPdfExists/…` → `MedicalReferralPDFHandler.ashx?Print=false`). The portal searches the last year only.

## Still out / roadmap

| Surface | Status |
| --- | --- |
| Prescription print / PDF (`PatientPrescriptionsExPrint.aspx`) | **Out** — referenced in UI, not fetched |
| Lab-order print / PDF / email download | **Out** — UI present, not fetched |
| Billing reports (`BillingReport/SearchReport.aspx`, `Billing/ReportingPage.aspx`), genetic tests | Out — pages mapped, no reader yet |
| Hospital visit detail pages | Out — rows keep their `links`; not read (the one account mapped had no visits) |
| Requests to the clinic (`ClinicAltor.aspx`), the appointments application, pharmacy stock | Out — write-oriented or separate applications |
| Medicine-to-door, pharmacy consultation | Out |
| Family / linked-member switch | Refused (never post FamilySlider `au`/`cu`) |

## Explicitly out of scope

- CAPTCHA / Imperva / SMS bypass
- Family member switching
- Booking, payments, profile updates, prescription purchase writes
- Clinical advice
- Publishing `@clalit/core` as a public Node library / SDK
