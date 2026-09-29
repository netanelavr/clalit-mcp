export const VERSION = "0.1.0";

export interface Command {
  usage: string;
  summary: string;
  description: string;
  options: string[];
  notes?: string;
}

export const COMMANDS: Record<string, Command> = {
  login: {
    usage: "login [--id ID] [--http] [--port PORT] [--no-open]",
    summary: "Interactive CAPTCHA + SMS OTP sign-in (own machine).",
    description:
      "Sign in to Clalit e-services on this machine. Solves nothing automatically: you type CAPTCHA and SMS OTP. Session cookies are stored locally. With --http, opens a loopback browser page (127.0.0.1) for ID, CAPTCHA image, and SMS OTP — same session file as terminal login.",
    options: ["id", "http", "port", "no-open"],
    notes:
      "Requires residential/user IP. Datacenter hosts hit Imperva Error 16. No bot / Imperva / CAPTCHA bypass. Prefer `login --http` when the terminal cannot show the CAPTCHA image.",
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
    notes: "Date format follows the portal datepicker (often dd/MM/yyyy). Never switches family members.",
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
  "refresh-session": {
    usage: "refresh-session",
    summary: "Optional soft keep-alive via RefreshSession.aspx.",
    description: "Hits the observed keep-alive endpoint. Does not extend beyond portal policy.",
    options: [],
  },
  mcp: {
    usage: "mcp",
    summary: "Run the stdio MCP server.",
    description: "Exposes list_labs, get_lab_result, get_lab_document for local agents.",
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
    `clalit-mcp ${VERSION} — own-account Clalit lab reads (unofficial)`,
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([k, c]) => `  ${k.padEnd(16)} ${c.summary}`),
    "",
    "Unaffiliated with Clalit. Own records only. No CAPTCHA/Imperva bypass.",
  ];
  return lines.join("\n");
}
