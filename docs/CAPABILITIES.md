# Capabilities

## Implemented

| Read | Library | CLI | MCP |
| --- | --- | --- | --- |
| Lab history list | `client.listLabs()` | `labs` | `list_labs` |
| Lab result detail | `client.getLabResult(ref)` | `lab --ref` | `get_lab_result` |
| Lab PDF | `client.getLabDocument(ref)` | `lab-document` | `get_lab_document` |
| Prescriptions list (מרשמים) | `client.listPrescriptions()` | `prescriptions` | `list_prescriptions` |
| Prescription issue status (read) | `client.getPrescriptionIssueStatus(...)` | `prescription-status` | `get_prescription_issue_status` |
| Lab orders list (הפניות לבדיקות מעבדה) | `client.listLabOrders()` | `lab-orders` | `list_lab_orders` |
| Lab order detail | `client.getLabOrder(ref)` | `lab-order --ref` | `get_lab_order` |

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
