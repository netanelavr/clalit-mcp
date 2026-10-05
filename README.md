# Clalit Health

**Read your own Clalit laboratory results from a CLI or an AI assistant (MCP).**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Unofficial **CLI and MCP server** for reading **your own** Clalit Health Services (שירותי בריאות כללית) e-services records (labs, prescriptions, lab orders).

> **Not affiliated with Clalit.** This is an independent open-source project. It is not a Clalit product, not endorsed by Clalit, and not a substitute for the official portal or clinical advice.

## Getting started with an AI assistant

Copy and paste this to your agent:

```
Read my Clalit lab results from the last year and summarize anything out of range.

https://raw.githubusercontent.com/netanelavr/clalit-mcp/main/skills/clalit-mcp/SKILL.md
```

Or install the skill locally:

```sh
npx skills add netanelavr/clalit-mcp
```

## What works in v0.1 (MVP)

| Capability | Status |
| --- | --- |
| `listLabs` — laboratory history list | Implemented (HTML parse + fixtures) |
| `getLabResult` — one result detail | Implemented (HTML parse + fixtures) |
| `getLabDocument` — original PDF | Implemented (POST download + fixtures) |
| Interactive login (CAPTCHA + SMS OTP) | Implemented; **requires your own residential machine** |
| `listPrescriptions` / issue status (מרשמים) | Implemented (HTML + IssueDrugs read; no PDF) |
| `listLabOrders` / `getLabOrder` (הפניות לבדיקות מעבדה) | Implemented (HTML parse + fixtures; no PDF) |
| `MedicalReferrals.aspx` / prescription·lab-order PDFs | Still out |

Offline unit tests parse synthetic ASP.NET WebForms HTML fixtures. Live portal calls require a residential/user machine session (see below).

## Soft-amber terms of use

- **Own account only.** Never use this against someone else's record. Family / linked-member switching is refused.
- **Read-only.** No booking, payments, profile writes, or prescription requests.
- **No CAPTCHA / bot / Imperva bypass.** You solve CAPTCHA and enter the SMS OTP yourself. Datacenter and many cloud IPs get Imperva **Error 16**; that is expected.
- **Rate limits.** The client spaces requests (~750ms+). Do not hammer `e-services.clalit.co.il`.
- **Session cookies are PHI-adjacent secrets.** Stored mode `0600` under your config dir. Never commit them, paste them into issues, or share them with an assistant indiscriminately.
- Portal terms (for awareness): Clalit's online terms PDF is linked from the portal nav (observed path hint `clalit_on_line_terms_2025.pdf`). Read Clalit's own terms; this project does not grant extra rights.

## Why login must be on your machine

Clalit e-services sit behind **Imperva**. Interactive login is:

1. ID + **CAPTCHA** (`infootplogin.aspx`)
2. **SMS OTP** (`OTPSMSVerification.aspx`)
3. Portal session cookies

Datacenter and cloud IPs typically fail at step 0 with Imperva Error 16. **There is no supported workaround** in this package. Log in on your own machine / home network, then use the saved session for CLI/MCP reads on that same machine.

Optional soft keep-alive: `RefreshSession.aspx` (observed in HAR). Idle TTL is **unmeasured**; treat ~30 minutes idle as "may need login again."

## Install

```sh
git clone https://github.com/netanelavr/clalit-mcp.git
cd clalit-mcp
npm install
npm test
```

Run the CLI from the checkout:

```sh
npx tsx packages/cli/src/main.ts help
```

## Sign in (residential)

```sh
# Prefer HTTP UI so the CAPTCHA image is visible in the browser:
npx tsx packages/cli/src/main.ts login --http
# Or terminal prompts:
npx tsx packages/cli/src/main.ts login
npx tsx packages/cli/src/main.ts labs --json
npx tsx packages/cli/src/main.ts lab --ref <token-from-labs> --json
npx tsx packages/cli/src/main.ts lab-document --ref <token> --out result.pdf
```

See [docs/LIVE-VERIFY.md](docs/LIVE-VERIFY.md) for the first live login checklist.

## MCP

```json
{
  "mcpServers": {
    "clalit-mcp": {
      "command": "npx",
      "args": ["tsx", "packages/cli/src/main.ts", "mcp"],
      "cwd": "/absolute/path/to/clalit-mcp"
    }
  }
}
```

Tools: `list_labs`, `get_lab_result`, `get_lab_document`, `list_prescriptions`, `get_prescription_issue_status`, `list_lab_orders`, `get_lab_order`. You must already have a local session from `login`.


## Architecture

```
packages/
  core/   # private shared client (parsers, transport) — used by CLI/MCP only
  cli/    # login prompts, session store, commands
  mcp/    # stdio MCP tools
```

User-facing surfaces are the **CLI** and **MCP server**. `@clalit/core` stays a private workspace package (not a published SDK).

Upstream surface is **ASP.NET WebForms HTML** (`__VIEWSTATE` / `__EVENTVALIDATION` / `__doPostBack`), not a public JSON API. Provenance: [docs/API-SOURCES.md](docs/API-SOURCES.md).

## Roadmap

1. **Done:** labs + prescriptions list/status + lab-orders list/detail (offline fixtures; residential live optional).
2. **Still out:** prescription / lab-order PDFs; `MedicalReferrals.aspx`.
3. Harden session TTL measurement, keep-alive policy, and richer table heuristics from live HTML samples (sanitized fixtures welcome).

## Privacy

Every record is real medical data once you log into a live account. Anything you hand to an assistant becomes part of that model's context.

## Something not working?

Prefer a pull request with a **sanitized** HTML fixture over an issue that pastes PHI. Never paste ID numbers, cookies, session files, SMS codes, or full HAR files into GitHub.

Security problems → [SECURITY.md](SECURITY.md).

## Docs

See [docs/README.md](docs/README.md) for the full index. Highlights:

- [Authentication](docs/AUTH.md)
- [Capabilities](docs/CAPABILITIES.md)
- [CLI](docs/CLI.md)
- [MCP](docs/MCP.md)
- [Live verify (residential)](docs/LIVE-VERIFY.md)
- [API sources](docs/API-SOURCES.md)
- [Contributing](CONTRIBUTING.md)
- [MIT license](LICENSE)

Package layout (private core → CLI → MCP) is similar in spirit to [orenyomtov/maccabi-health](https://github.com/orenyomtov/maccabi-health); Clalit uses a different upstream (WebForms HTML vs Maccabi's JSON APIs). This repo ships CLI + MCP only — not a public core library.
