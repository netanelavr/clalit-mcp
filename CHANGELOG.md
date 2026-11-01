# Changelog

## Unreleased

- **Documents**: `documents` / `document` (CLI) and `list_documents` / `get_document` (MCP) read visit summaries (סיכומי ביקור רפואה יועצת), hospital summaries (סיכומים מבתי חולים, searched per hospital), medical approvals (אישורים רפואיים) and Form 17 (התחייבויות) with their PDFs; a search that fills the portal's 10-row page is split by date until every row is found. Ported from [tadnir/clalit-mcp](https://github.com/tadnir/clalit-mcp) by Michael Tadnir.
- **Records**: `records --source` / `record-document` (CLI) and `list_records` / `get_record_document` (MCP) read the portal's grid pages as they are shown, keyed by their Hebrew headers: diagnoses, sensitivities, chronic medications, medicines purchased (since 08.2008, pager walked), medication approvals, imaging reports from clinics, Clalit hospitals and external institutes (with the report PDF), hospital visits, hospital labs (with every draw's result page, read with the lab-detail parser), general referrals (last year only, with the PDF) — the page the roadmap had as "blocked" — plus upcoming appointments (home page), the portal's personalised recommendations (Measures), and vaccinations and blood type from the endpoints the portal's React pages read. Built from a `tools/sitemap.mts` map of a live account and `tools/dump-page.mts` dumps of its pages and bundles.
- **`export`**: the document and record sources too — `documents/<source>/` and `records/<source>/` with `list.json` and `files/*.pdf`; `--no-documents` skips every PDF and keeps the lists.
- **Session**: a saved session now records its last use (`lastUsedAt`), so a fresh process measures idleness from there and not from the sign-in — a session a keep-alive had held for 30+ minutes was being refused.
- **`keep-alive`** (CLI): holds the session open from a second terminal while `export` or the sitemap runs; the portal drops an idle session after ~10 minutes.
- **MCP server**: sign-in and keep-alive live in the server. The keeper ends a session only when the portal demands a sign-in (`ReauthenticationRequired`); a network error or an Imperva hiccup while opening or checking a saved session keeps `session.json` and retries on the next round, and `checkSession()` reports a 5xx as a retryable `UpstreamError`, not a sign-out. `clalit_login` returns a link to a sign-in page the server serves on `localhost:8765` (ID, CAPTCHA and SMS code are typed there, never in the chat, with a chosen session length of 1 hour to 1 week); the session is kept alive with `RefreshSession.aspx` while the server runs; `clalit_session_status`, `clalit_logout`. A session from the CLI is shared. Also from tadnir/clalit-mcp. The `login` pages use relative links, so they also work behind a path prefix ([docs/HOSTING.md](docs/HOSTING.md)).
- **`tools/sitemap.mts`**: a GET-only, paced walk over the signed-in portal that records which pages an account has and their shapes (titles, form field names, dropdown labels, grid headers — never a value), for building new readers from evidence; `--raw` keeps the HTML privately.

## 2026-10-22

- **`export`**: a lab result the portal offers no PDF for is skipped (counted in the README), no longer filed in `export-errors.json`; on a first run it costs no request. `NO_DOCUMENT` has a message of its own.
- **`login --browser`**: sign in in your own Chrome (permanent password or SMS; CAPTCHA by hand) and hand the signed-in cookies to the CLI, checked with one labs-list request before `session.json` is written; the browser's user agent stays with the session. `--keep-open` leaves the window open after the CLI exits. `--record` writes a value-free record of the sign-in's request shapes for building a browserless sign-in.

## 2026-10-21

- **`export`**: everything the client reads into one folder — labs (every result and its PDF), prescriptions, lab orders — with a `README.md` data dictionary for assistants, `export-errors.json`, `CLAUDE.md`/`AGENTS.md`; paced, resumable into the same folder, stops cleanly on an ended session. Layout modeled on Health Records Export for Maccabi.
- **Labs parsers read the live pages.** `LabsTestList.aspx` rows are date | lab section | referring doctor | test number | "הצגה": the section is now the row's name (it was the link's text) and `doctor`/`testNumber` are kept. `LabTestDetails.aspx` is read from its real grid (`tr[trtype=labData]`): one analyte per row with the shown `result`, its leading `value`, `units` or a `qualifier` (Negative), the reference range from the bar (`referenceRange`, `rangeMin`, `rangeMax`), a `flag` (L/H) computed as the page's own script does, `turnaround`, Clalit's `explanation`, and the opaque `compare` link; the lab's remarks become `notes`; microbiology results come from their own grid; the sample's `date`/`time` and the `testNumber` are read from the header, the member's name and ID are not. The old column heuristic had read the range bar's numbers as rows and the explanation's close button as units. Fixtures are now the live layouts (redacted captures), plus `lab-detail-micro.html`.

## 2026-10-05

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
