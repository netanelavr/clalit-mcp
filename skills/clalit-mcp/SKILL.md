---
name: clalit-mcp
description: Reads the user's own Clalit Health Services records (lab results, prescriptions, lab orders). Use when the user mentions Clalit, כללית, their Israeli health-fund records, blood tests, lab results, or asks an agent to look at those records. Asks the user for their תעודת זהות, the portal CAPTCHA, and the SMS OTP code.
license: MIT
compatibility: Shell and internet, on the user's own residential machine. Use the clalit-mcp CLI from a git checkout (not npm).
metadata:
  version: "0.1.0"
---

# Clalit Health (clalit-mcp)

Read the user's own Clalit e-services records. Unofficial. Read-only.

Use the CLI when you can run shell commands on the **user's machine** with a normal residential network. Clalit sits behind Imperva; datacenter and cloud agent hosts usually get Error 16 and cannot log in.

## Setup (checkout)

```sh
git clone https://github.com/netanelavr/clalit-mcp.git
cd clalit-mcp
npm install
npm test
```

Every command below is run from the repo root:

```sh
npx tsx packages/cli/src/main.ts help
```

`npx skills add netanelavr/clalit-mcp` installs this skill for Cursor, Claude Code, Codex, and other agents that support skills.

## Login

The user must solve the portal CAPTCHA and enter the SMS OTP. Nothing is solved automatically.

Prefer browser login so the CAPTCHA image is visible:

```sh
npx tsx packages/cli/src/main.ts login --http
```

Or terminal prompts:

```sh
npx tsx packages/cli/src/main.ts login
```

Session cookies are stored at `~/.config/clalit-mcp/session.json` (mode `0600`). Never commit or paste that file.

ID, CAPTCHA, and OTP may appear in the conversation when the user provides them — that is how interactive login works.

## Reads (after login)

Use `--json` for machine-readable output.

```sh
npx tsx packages/cli/src/main.ts labs --json
npx tsx packages/cli/src/main.ts lab --ref TOKEN --json
npx tsx packages/cli/src/main.ts lab-document --ref TOKEN --out /tmp/clalit-lab.pdf
npx tsx packages/cli/src/main.ts prescriptions --json
npx tsx packages/cli/src/main.ts prescription-status --prescription NO --medication ID --form NAME --start DATE --section ID --json
npx tsx packages/cli/src/main.ts lab-orders --json
npx tsx packages/cli/src/main.ts lab-order --ref TOKEN --json
npx tsx packages/cli/src/main.ts refresh-session
npx tsx packages/cli/src/main.ts logout
```

Take `ref` and prescription row fields from list output. Do not invent tokens.

Exit codes: `0` success, `1` operation failure, `2` usage, `3` login / Imperva block.

## MCP

Only when clalit-mcp MCP tools are already configured in the host. From a checkout, stdio MCP:

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

Tools: `list_labs`, `get_lab_result`, `get_lab_document`, `list_prescriptions`, `get_prescription_issue_status`, `list_lab_orders`, `get_lab_order`. Session must exist from `login` first.

## Privacy

Every record is real medical data. Anything you send to a model becomes part of that model's context.

Never paste ID numbers, cookies, session files, SMS codes, captcha images, lab PDFs, or HAR files into GitHub issues. Prefer a PR with a **sanitized** HTML fixture.

Security: see the repo [SECURITY.md](https://github.com/netanelavr/clalit-mcp/blob/main/SECURITY.md).
