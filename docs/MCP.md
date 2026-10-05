# MCP

Stdio server tools:

1. `list_labs` — optional `fromDate` / `toDate`
2. `get_lab_result` — required `ref` from list
3. `get_lab_document` — required `ref`; returns base64 PDF
4. `list_prescriptions` — optional `fromDate` / `toDate` / `includeExpired`
5. `get_prescription_issue_status` — medicine row keys + `sectionId` (read status only)
6. `list_lab_orders` — lab orders (הפניות לבדיקות מעבדה); not MedicalReferrals
7. `get_lab_order` — required `ref` from list_lab_orders; no PDF

Sign in first with the CLI on the same machine. HTTP/OAuth MCP transport is not in v0.1.
