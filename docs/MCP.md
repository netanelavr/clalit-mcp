# MCP

`npx tsx packages/cli/src/main.ts mcp` runs the stdio server. Client setup is in the [README](../README.md#mcp).

## Tools

1. `list_labs`: optional `fromDate` / `toDate`
2. `get_lab_result`: required `ref` from `list_labs`
3. `get_lab_document`: required `ref`; returns a base64 PDF
4. `list_prescriptions`: optional `fromDate` / `toDate` / `includeExpired`
5. `get_prescription_issue_status`: medicine row keys + `sectionId` (read status only)
6. `list_lab_orders`: lab orders (הפניות לבדיקות מעבדה); not MedicalReferrals
7. `get_lab_order`: required `ref` from `list_lab_orders`; no PDF
8. `list_documents`: required `source` (`visit_summaries`, `hospital_summaries`, `medical_approvals`, `form17`), optional `fromDate` / `toDate`
9. `get_document`: required `ref` from `list_documents`; returns a base64 PDF
10. `list_records`: required `source` (`diagnoses`, `sensitivities`, `chronic_medications`, `medicines_purchased`, `medication_approvals`, `imaging_clinics`, `imaging_hospitals`, `imaging_external`, `hospital_visits`, `hospital_labs`, `referrals`, `appointments`, `recommendations`, `vaccinations`, `blood_type`), optional `fromDate` / `toDate`; rows keyed by the portal's Hebrew headers (the API-backed sources by the portal's field names)
11. `get_record_document`: required `ref` from `list_records` (imaging reports, referrals); returns a base64 PDF
12. `get_hospital_lab_result`: required `link` and the row's `hospital` (its `context.value`) from a `hospital_labs` row; the draw's analytes
13. `clalit_login`: the sign-in link, or the status when already signed in
14. `clalit_session_status`: `state` (`signed_in`, `signed_out`, `expired`), `signedInAt`, `endsAt`, `lastCheckedAt`, `lastError`, and `signInUrl` when not signed in
15. `clalit_logout`: forgets the saved session

## Sign-in page

The server starts a small page on `CLALIT_LOGIN_HOST:CLALIT_LOGIN_PORT` (default `127.0.0.1:8765`) the first time someone needs to sign in. The page:

- asks how long the session should last (1 hour, 6 hours, 12 hours, 1 day, 2 days, 1 week; default 1 day);
- then runs the same ID, CAPTCHA and SMS code steps as `login` in the CLI ([AUTH.md](AUTH.md));
- shows the session's state afterwards, with "Sign in again" and "Sign out".

It answers only to `localhost`, `127.0.0.1` and the host in `CLALIT_LOGIN_URL`, and every form carries a per-process token, so another website cannot drive it from your browser. Anyone who can open the page can sign in or out, so keep it on loopback, or behind your own authentication when hosted ([HOSTING.md](HOSTING.md)).

A session made with the CLI (`login` or `login --browser`) is picked up too: the server and the CLI share the session file.

## Keep-alive

Clalit has no refresh token: a sign-in gives a cookie session that the portal drops after roughly ten minutes without a request. While signed in, the server:

- requests `RefreshSession.aspx` every 4 minutes (the page the portal's own pages load in a hidden frame);
- checks every 20 minutes that a signed-in page still opens;
- saves the cookies after each round, so a restart picks the session back up;
- signs out when the chosen length runs out, and reports `expired` when Clalit ends the session sooner.

A network error keeps the session and retries on the next round. If another copy of the server or the CLI signs in, the next tool call picks that session up from the file.
