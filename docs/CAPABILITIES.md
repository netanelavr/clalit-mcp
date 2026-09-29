# Capabilities

## Implemented (v0.1 MVP)

| Read | Library | CLI | MCP |
| --- | --- | --- | --- |
| Lab history list | `client.listLabs()` | `labs` | `list_labs` |
| Lab result detail | `client.getLabResult(ref)` | `lab --ref` | `get_lab_result` |
| Lab PDF | `client.getLabDocument(ref)` | `lab-document` | `get_lab_document` |

Upstream pages:

- List: `GET /OnlineWeb/Services/Labs/LabsTestList.aspx`
- Detail: `GET /OnlineWeb/Services/Labs/LabTestDetails.aspx?s&d&ls`
- Document: `POST` same detail URL with `__EVENTTARGET` download control → `application/octet-stream` PDF

## Roadmap (stubs only — no endpoints invented)

### Prescriptions (מרשמים)

- Status: **not implemented**
- Blocker: no HAR-mapped list/detail/PDF endpoints yet
- When evidence exists: add `packages/core/src/prescriptions/` parsers + fixtures, then CLI/MCP

### Referrals (הפניות)

- Status: **not implemented**
- Blocker: same — needs redacted HAR / HTML
- Same extension pattern as labs

## Explicitly out of scope

- CAPTCHA / Imperva / SMS bypass
- Family member switching
- Booking, payments, profile updates
- Clinical advice
