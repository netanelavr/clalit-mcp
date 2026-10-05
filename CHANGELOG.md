# Changelog

## Unreleased

- Public repo cleanup: agent skill, docs, CI, GitHub-only install (no npm publish).
- **CLI + MCP only** — `@clalit/core` stays a private workspace package, not a public SDK.
- **Reads:** prescriptions list + issue status; lab orders list + detail (fixtures; no PDFs).
- **Login:** browser-only loopback `login` (CAPTCHA + SMS OTP); CAPTCHA/WebForms fixes, OTP diagnostics, session save race fix.
- **Still out:** `MedicalReferrals.aspx`, prescription/lab-order PDFs.

## 0.1.0 — 2026-09-29

- Initial scaffold: `@clalit/core`, `@clalit/cli`, `@clalit/mcp`.
- Labs MVP: `listLabs`, `getLabResult`, `getLabDocument` (WebForms HTML fixtures).
- Interactive login (CAPTCHA + SMS OTP); live verify on a residential machine.
- Roadmap notes for מרשמים / הפניות (no invented endpoints).
