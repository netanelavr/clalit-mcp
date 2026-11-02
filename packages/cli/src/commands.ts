import { PACKAGE_VERSION } from "@clalit/core";

export const VERSION = PACKAGE_VERSION;

export interface Command {
  usage: string;
  summary: string;
  description: string;
  options: string[];
  notes?: string;
}

export const COMMANDS: Record<string, Command> = {
  login: {
    usage: "login [--id ID] [--port PORT] [--no-open] | login --browser [--record] [--url URL] [--keep-open]",
    summary: "Sign in (own machine): loopback CAPTCHA + SMS page, or your own browser handed over.",
    description:
      "Default: a loopback browser page (127.0.0.1) where you enter Israeli ID, CAPTCHA, and SMS OTP; nothing is solved automatically; session cookies are stored locally. --browser: Chrome opens on a profile of its own at Clalit Online's sign-in page, you sign in there by any road the site offers (permanent password, or SMS; CAPTCHA by hand), and once your personal page shows (or you press Enter) the browser's portal cookies are checked with one labs-list request and saved as the session. --record also writes login-record-<time>.json in the config directory: the sign-in's request shapes (paths, field names, value lengths and classes, cookie names) with no values, for building a sign-in that needs no browser. --keep-open leaves the browser window open afterwards (the CLI exits either way; close the window yourself).",
    options: ["id", "port", "no-open", "browser", "record", "url", "keep-open"],
    notes:
      "Requires residential/user IP. Datacenter hosts hit Imperva Error 16. No bot / Imperva / CAPTCHA bypass. --browser needs Node 22+ and Chrome, Chromium or Edge (CHROME_PATH picks one); its profile lives under the config directory. `--http` is accepted as a no-op alias.",
  },
  logout: {
    usage: "logout",
    summary: "Delete the local session file.",
    description: "Removes saved cookies from the config directory. Does not call upstream logout.",
    options: [],
  },
  labs: {
    usage: "labs [--from DATE] [--to DATE] [--json]",
    summary: "List own laboratory history rows.",
    description: "Reads LabsTestList.aspx for the authenticated owner only.",
    options: ["from", "to", "json"],
    notes: "Date format is dd.MM.yyyy. listLabs walks every pager page. Never switches family members.",
  },
  lab: {
    usage: "lab --ref TOKEN [--json]",
    summary: "Read one lab result detail.",
    description: "Fetches LabTestDetails.aspx using a ref token from `labs`.",
    options: ["ref", "json"],
  },
  "lab-document": {
    usage: "lab-document --ref TOKEN --out FILE",
    summary: "Download the lab result PDF.",
    description: "POSTs the detail page download control and writes PDF bytes.",
    options: ["ref", "out"],
  },
  prescriptions: {
    usage: "prescriptions [--from DATE] [--to DATE] [--include-expired] [--json]",
    summary: "List own prescriptions (מרשמים).",
    description: "Reads PatientPrescriptionsex.aspx for the authenticated owner only.",
    options: ["from", "to", "include-expired", "json"],
    notes: "No PDF/print. listPrescriptions walks every gridPager page. Never switches family members.",
  },
  "prescription-status": {
    usage:
      "prescription-status --prescription NO --medication ID --form NAME --start DATE --section ID [--json]",
    summary: "Read pharmacy issue status for one medicine row.",
    description:
      "POSTs IssueDrugsByPatientReceiptId with values from a prescriptions list row (read status only).",
    options: ["prescription", "medication", "form", "start", "section", "json"],
    notes: "Never invent keys/values. Not a purchase write.",
  },
  "lab-orders": {
    usage: "lab-orders [--json]",
    summary: "List own lab orders (הפניות לבדיקות מעבדה).",
    description: "Reads LabOrderList.aspx for the authenticated owner only. Not MedicalReferrals.",
    options: ["json"],
  },
  "lab-order": {
    usage: "lab-order --ref TOKEN [--json]",
    summary: "Read one lab-order detail.",
    description: "Fetches LabOrderDetails.aspx?ord= using a ref token from `lab-orders`.",
    options: ["ref", "json"],
    notes: "No PDF/print download.",
  },
  documents: {
    usage: "documents --source (visit_summaries|hospital_summaries|medical_approvals|form17) [--from dd.MM.yyyy] [--to dd.MM.yyyy] [--json]",
    summary: "List own PDF documents from one portal source.",
    description:
      "Searches one documents page for the authenticated owner: visit_summaries (סיכומי ביקור רפואה יועצת), hospital_summaries (סיכומים מבתי חולים, searched per hospital), medical_approvals (אישורים רפואיים) or form17 (התחייבויות, last year only). The whole date range the portal allows is searched unless --from/--to say otherwise; a search that fills the portal's 10-row page is split until every row is found.",
    options: ["source", "from", "to", "json"],
    notes: "Rows carry an opaque ref token for `document`. Never invent action URLs.",
  },
  document: {
    usage: "document --ref TOKEN --out FILE",
    summary: "Download one document's PDF.",
    description: "Selects the document through the row's own portal action URL, then streams the source's PDF, using a ref token from `documents`.",
    options: ["ref", "out"],
  },
  records: {
    usage: "records --source ID [--from dd.MM.yyyy] [--to dd.MM.yyyy] [--json]",
    summary: "List one record source: diagnoses, sensitivities, medications, imaging, hospital visits and labs, referrals.",
    description:
      "Sources: diagnoses (האבחנות שלי), sensitivities (הרגישויות שלי), appointments (תורים עתידיים, from the home page), recommendations (המלצות רפואיות, the portal's own), vaccinations (החיסונים שעשיתי) and blood_type (סוג הדם) from the endpoints the portal's React pages read, chronic_medications (תרופות קבועות), medicines_purchased (תרופות שנקנו, since 08.2008), medication_approvals (אישורי תרופות), imaging_clinics / imaging_hospitals / imaging_external (פענוחי דימות, with the report PDF), hospital_visits (ביקורים בבתי החולים של כללית), hospital_labs (בדיקות מעבדה מבתי חולים), referrals (הפניות, last year only, with the PDF). Rows are kept as the portal shows them: the grid's Hebrew headers are the keys. Pages with a date-range search are asked for their whole range unless --from/--to say otherwise; per-hospital pages are searched once per hospital; a pager is walked, and a full page without one is split by date.",
    options: ["source", "from", "to", "json"],
    notes: "Rows with a PDF carry an opaque ref token for `record-document`. Never invent action URLs.",
  },
  "record-document": {
    usage: "record-document --ref TOKEN --out FILE",
    summary: "Download one record's PDF (an imaging report, a referral).",
    description: "Selects the document through the row's own portal action URL, then streams the source's PDF, using a ref token from `records`.",
    options: ["ref", "out"],
  },
  "hospital-lab-result": {
    usage: "hospital-lab-result (--link PATH | --hospital VALUE --test NUMBER) [--date dd.MM.yyyy] [--json]",
    summary: "Read one hospital lab result page (from a hospital_labs row's link).",
    description: "Fetches HospitalsLabTestDetails.aspx with the s/d/h query a `records --source hospital_labs` row carries in `links`, and reads it with the lab-detail parser: analytes, values, units, ranges, flags. The links the list hands out expire with that render of the list, so with --hospital (the row's context.value) and --test (its מספר הבדיקה) the hospital's search is replayed, the pager walked to the row, and its fresh link followed. A bare --link is tried as is.",
    options: ["link", "hospital", "test", "date", "json"],
    notes: "Links only from the owner's own list; nothing is invented.",
  },
  export: {
    usage: "export [--out DIR] [--from dd.MM.yyyy] [--to dd.MM.yyyy] [--no-documents] [--current-only] [--only SECTION,…]",
    summary: "Save everything this client can read into one folder.",
    description:
      "Writes ./clalit-export-<today>/ (or under --out): labs/ (list, one file per result, the PDFs), prescriptions/, lab-orders/, documents/ (visit summaries, hospital summaries, medical approvals, Form 17: a list and the PDFs per source), records/ (diagnoses, sensitivities, chronic medications, purchased medicines, medication approvals, imaging from clinics, hospitals and external institutes, hospital visits and labs with each draw's results, referrals, upcoming appointments, the portal's recommendations, vaccinations, blood type: a list per source, the imaging and referral PDFs), plus README.md (the export's data dictionary, written for an AI assistant), export-errors.json, CLAUDE.md and AGENTS.md. The labs list is asked for from 01.01.1990 to today unless --from/--to say otherwise (they filter labs only; prescriptions, lab orders, documents and records are always exported in full). A rerun into the same folder writes nothing it already has.",
    options: ["out", "from", "to", "no-documents", "current-only", "only"],
    notes:
      "Requests go one at a time, 300 ms apart. An item that fails is listed in export-errors.json and the export goes on (a result the portal has no PDF for is skipped, not listed); an ended session stops it and keeps what was collected. --current-only leaves expired prescriptions out; --no-documents skips every PDF (lab results and documents) and keeps the lists. Read-only, own record only.",
  },
  "keep-alive": {
    usage: "keep-alive [--every MINUTES]",
    summary: "Hold the session open while you work in another terminal.",
    description:
      "Requests RefreshSession.aspx every few minutes (default 4; the portal ends a session after about ten idle minutes), checks that a signed-in page still opens, and saves the refreshed cookies, until Ctrl-C. Run it in a second terminal beside `export` or `tools/sitemap.mts` so a long run does not end on an expired session. Exits with 3 when the portal ended the session.",
    options: ["every"],
    notes: "Does not extend a session beyond the portal's own policy; it only keeps an existing one from idling out. The MCP server does this on its own while it runs.",
  },
  "refresh-session": {
    usage: "refresh-session",
    summary: "Optional soft keep-alive via RefreshSession.aspx.",
    description: "Hits the observed keep-alive endpoint. Does not extend beyond portal policy.",
    options: [],
  },
  mcp: {
    usage: "mcp",
    summary: "Run the stdio MCP server.",
    description:
      "Exposes list_labs, get_lab_result, get_lab_document, list_prescriptions, get_prescription_issue_status, list_lab_orders, get_lab_order, list_documents, get_document, list_records, get_record_document, get_hospital_lab_result, plus clalit_login, clalit_session_status and clalit_logout. While it runs it keeps the Clalit session alive and serves its own sign-in page (see docs/MCP.md).",
    options: [],
  },
  help: {
    usage: "help [COMMAND]",
    summary: "Show help.",
    description: "Print command index or one command's reference.",
    options: [],
  },
};

export function help(name?: string): string {
  if (name && COMMANDS[name]) {
    const c = COMMANDS[name]!;
    return [
      `Usage: clalit-mcp ${c.usage}`,
      "",
      c.description,
      c.notes ? `\nNotes: ${c.notes}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const lines = [
    `clalit-mcp ${VERSION} — own-account Clalit reads (unofficial)`,
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([k, c]) => `  ${k.padEnd(20)} ${c.summary}`),
    "",
    "Unaffiliated with Clalit. Own records only. No CAPTCHA/Imperva bypass.",
  ];
  return lines.join("\n");
}
