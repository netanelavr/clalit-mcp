# Clalit Health

**Read your own Clalit records (lab results, prescriptions, lab orders) from a CLI or an AI assistant (MCP).**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Unofficial. Not affiliated with Clalit. Not a substitute for the official portal or clinical advice.

The MCP server runs locally on your machine: you log in through your own browser, the session is stored only on your computer, and this project has no hosted backend and collects nothing. Note that whatever results your AI client (such as Claude) requests are passed to that client and are handled under its provider's privacy terms.

![Ask Claude about your own Clalit records (read-only)](docs/assets/chat-demo.png)

## Getting started with an AI assistant

Copy and paste this to your agent:

```
Read my Clalit lab results from the last year and summarize anything out of range, then list my active prescriptions.

https://raw.githubusercontent.com/netanelavr/clalit-mcp/main/skills/clalit-mcp/SKILL.md
```

Or install the skill locally:

```sh
npx skills add netanelavr/clalit-mcp
```

## Terms of use

- **Own account only.** Never use this against someone else's record.
- **Read-only.** No booking, payments, profile writes, or prescription requests.
- **No CAPTCHA / bot / Imperva bypass.** You solve CAPTCHA and enter the SMS OTP yourself.
- **Residential machine.** Datacenter and many cloud IPs get Imperva Error 16; log in on your own Mac / home network.
- **Session file is secret.** Stored mode `0600` under `~/.config/clalit-mcp/`. Never commit or paste it.

## Install

```sh
git clone https://github.com/netanelavr/clalit-mcp.git
cd clalit-mcp
npm install
npm test
```

## Sign in and CLI

```sh
npx tsx packages/cli/src/main.ts login
npx tsx packages/cli/src/main.ts labs --json
npx tsx packages/cli/src/main.ts lab --ref <token-from-labs> --json
npx tsx packages/cli/src/main.ts lab-document --ref <token> --out result.pdf
npx tsx packages/cli/src/main.ts prescriptions --json
npx tsx packages/cli/src/main.ts lab-orders --json
npx tsx packages/cli/src/main.ts lab-order --ref <token-from-lab-orders> --json
npx tsx packages/cli/src/main.ts documents --source visit_summaries --json   # or hospital_summaries | medical_approvals | form17
npx tsx packages/cli/src/main.ts document --ref <token-from-documents> --out summary.pdf
npx tsx packages/cli/src/main.ts records --source diagnoses --json         # sensitivities | chronic_medications | medicines_purchased | medication_approvals | imaging_clinics | imaging_hospitals | imaging_external | hospital_visits | hospital_labs | referrals | appointments | recommendations | vaccinations | blood_type
npx tsx packages/cli/src/main.ts hospital-lab-result --link <link-from-hospital_labs-row> --hospital <its-context.value> --json
npx tsx packages/cli/src/main.ts record-document --ref <token-from-records> --out report.pdf
npx tsx packages/cli/src/main.ts export --out ~/health
npx tsx packages/cli/src/main.ts help
```

`login` opens a loopback browser page for ID, CAPTCHA, and SMS OTP. See [docs/LIVE-VERIFY.md](docs/LIVE-VERIFY.md). `login --browser` opens your own Chrome at Clalit Online's sign-in page instead: sign in there as you usually do — with your permanent password if you have one, so no SMS — and the signed-in cookies become the session ([docs/AUTH.md](docs/AUTH.md)).

## Keep a copy of everything: `export`

```sh
npx tsx packages/cli/src/main.ts export                 # ./clalit-export-<today>/: labs (every result and its PDF), prescriptions, lab orders, documents, records
npx tsx packages/cli/src/main.ts export --out ~/health  # under that directory; --no-documents skips the PDFs
```

One folder: labs (one JSON per result, plus its PDF), prescriptions, lab orders, documents (visit summaries, hospital
summaries, medical approvals and Form 17 — a list and the PDFs per source), records (diagnoses, sensitivities, the
regular-medication list, pharmacy purchases, medication approvals, imaging reports with their PDFs, hospital visits and
labs with every draw's results, referrals with their PDFs, upcoming appointments, the portal's own recommendations,
vaccinations, blood type), and a root `README.md` that describes each folder for an AI assistant (layout in [docs/CLI.md](docs/CLI.md)). `--from`/`--to` (`dd.MM.yyyy`) filter labs only, default 01.01.1990 to today; a rerun skips what it already has.
Layout modeled on [Health Records Export for Maccabi](https://github.com/RoniRachmani/health-records-export-for-maccabi); [liberate-labs](https://github.com/Urigo/liberate-labs) can load it into SQLite.
The folder is not encrypted, and anything you open in an AI app is sent to that provider (see the privacy note at the top).

## MCP

Sign in first (`login` above); the MCP server reuses that local session.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS). Use **absolute paths** (Dock-launched Claude does not see `nvm` / shell `PATH`):

```json
{
  "mcpServers": {
    "clalit": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/clalit-mcp/node_modules/.bin/tsx",
        "/absolute/path/to/clalit-mcp/packages/cli/src/main.ts",
        "mcp"
      ]
    }
  }
}
```

Find your node path with `which node`. Quit Claude fully (Cmd+Q) and reopen.

![Claude Desktop: seven Clalit tools](docs/assets/connectors.png)

### Other MCP clients (Cursor, Claude Code, …)

```json
{
  "mcpServers": {
    "clalit": {
      "command": "npx",
      "args": ["tsx", "packages/cli/src/main.ts", "mcp"],
      "cwd": "/absolute/path/to/clalit-mcp"
    }
  }
}
```

### Signing in from the assistant

A session made with `login` is picked up. Without one, the tools answer with a link to a sign-in page the server serves itself on `http://localhost:8765/` (`clalit_login` returns the same link): open it, pick how long to stay signed in (1 hour to 1 week), and enter the ID, the CAPTCHA and the SMS code there — only ever on that page, never in the chat. While the server runs it keeps the session alive and signs out at the end of the length you picked ([docs/MCP.md](docs/MCP.md)).

### Tools

| Tool | What it reads |
| --- | --- |
| `list_labs`, `get_lab_result`, `get_lab_document` | Lab history, one result, the original lab PDF |
| `list_prescriptions`, `get_prescription_issue_status` | Prescriptions and their pharmacy issue status |
| `list_lab_orders`, `get_lab_order` | Lab orders and one order's detail |
| `list_documents`, `get_document` | Visit summaries, hospital summaries, medical approvals, Form 17, and their PDFs |
| `list_records`, `get_record_document`, `get_hospital_lab_result` | Diagnoses, sensitivities, chronic medications, purchased medicines, medication approvals, imaging reports (clinics, hospitals, external) with their PDFs, hospital visits, hospital labs and their result pages, referrals with their PDFs, upcoming appointments, the portal's recommendations, vaccinations, blood type |
| `clalit_login`, `clalit_session_status`, `clalit_logout` | The sign-in link, whether a session is live and until when, and sign-out |

## Mapping the portal: `tools/sitemap.mts`

```sh
npx tsx tools/sitemap.mts --out ./clalit-sitemap          # sitemap.json: which pages your account has and what they are made of
npx tsx tools/sitemap.mts --out ./clalit-sitemap --raw    # also keeps each page's HTML under raw/ (private) for writing parsers
```

A GET-only, paced walk over the signed-in portal's own links. `sitemap.json` records titles, headings, form field names,
dropdown labels and grid headers — never a value — so a page nobody reads yet can be turned into a reader from evidence.
The record sources above were built from one such map.

## License

[MIT](LICENSE)
