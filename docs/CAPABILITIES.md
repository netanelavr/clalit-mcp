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

## Still out / roadmap

| Surface | Status |
| --- | --- |
| Prescription print / PDF (`PatientPrescriptionsExPrint.aspx`) | **Out** — referenced in UI, not fetched |
| Lab-order print / PDF / email download | **Out** — UI present, not fetched |
| `MedicalReferrals.aspx` (general הפניות) | **Blocked** — nav-only in HAR; do not invent |
| Rentgen / chronic drugs / medicine-to-door | Out |
| Family / linked-member switch | Refused (never post FamilySlider `au`/`cu`) |

## Explicitly out of scope

- CAPTCHA / Imperva / SMS bypass
- Family member switching
- Booking, payments, profile updates, prescription purchase writes
- Clinical advice
- Publishing `@clalit/core` as a public Node library / SDK
