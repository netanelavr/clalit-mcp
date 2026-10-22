# Changelog

## Unreleased

- **`export`**: a lab result the portal offers no PDF for is skipped (counted in the README), no longer filed in `export-errors.json`; on a first run it costs no request. `NO_DOCUMENT` has a message of its own.
- **`login --browser`**: sign in in your own Chrome (permanent password or SMS; CAPTCHA by hand) and hand the signed-in cookies to the CLI, checked with one labs-list request before `session.json` is written; the browser's user agent stays with the session. `--keep-open` leaves the window open after the CLI exits. `--record` writes a value-free record of the sign-in's request shapes for building a browserless sign-in.
- **`export`**: everything the client reads into one folder — labs (every result and its PDF), prescriptions, lab orders — with a `README.md` data dictionary for assistants, `export-errors.json`, `CLAUDE.md`/`AGENTS.md`; paced, resumable into the same folder, stops cleanly on an ended session. Layout modeled on Health Records Export for Maccabi.
- **Labs parsers read the live pages.** `LabsTestList.aspx` rows are date | lab section | referring doctor | test number | "הצגה": the section is now the row's name (it was the link's text) and `doctor`/`testNumber` are kept. `LabTestDetails.aspx` is read from its real grid (`tr[trtype=labData]`): one analyte per row with the shown `result`, its leading `value`, `units` or a `qualifier` (Negative), the reference range from the bar (`referenceRange`, `rangeMin`, `rangeMax`), a `flag` (L/H) computed as the page's own script does, `turnaround`, Clalit's `explanation`, and the opaque `compare` link; the lab's remarks become `notes`; microbiology results come from their own grid; the sample's `date`/`time` and the `testNumber` are read from the header, the member's name and ID are not. The old column heuristic had read the range bar's numbers as rows and the explanation's close button as units. Fixtures are now the live layouts (redacted captures), plus `lab-detail-micro.html`.
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
