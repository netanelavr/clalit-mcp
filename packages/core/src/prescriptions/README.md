# Prescriptions (מרשמים)

Implemented read surfaces (HAR-backed):

| Role | Method | Path |
| --- | --- | --- |
| List | GET | `/OnlineWeb/Services/Medicine/PatientPrescriptionsex.aspx` |
| Issue status (read only) | POST | `/onlineweb/api/PatientPrescriptions/IssueDrugsByPatientReceiptId` |

- Parsers: `list.ts`, `issue-status.ts`
- Detail UX is client-side expand — no separate detail ASPX
- **Out:** print/PDF (`PatientPrescriptionsExPrint.aspx`), purchase writes, family switch
