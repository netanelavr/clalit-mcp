import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getLabDocumentTool,
  getLabResultTool,
  listLabsSchema,
  listLabsTool,
  documentSchema,
  refSchema,
} from "./tools.js";

const INSTRUCTIONS = [
  "Unofficial Clalit own-account lab reader (read-only).",
  "Unaffiliated with Clalit Health Services.",
  "Tools: list_labs → get_lab_result / get_lab_document using returned ref tokens only.",
  "Never invent portal query params. Never switch family members.",
  "Sign-in is interactive CAPTCHA+SMS on the user's machine; Imperva blocks datacenter IPs.",
  "Preserve Hebrew source text, units, ranges, and dates. PDFs are original bytes.",
  "Prescriptions (מרשמים) and referrals (הפניות) are roadmap-only until HAR-backed.",
].join(" ");

export async function startStdioServer(): Promise<void> {
  const server = new Server(
    { name: "clalit-mcp", version: "0.1.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_labs",
        description:
          "List the authenticated owner's Clalit laboratory history rows (LabsTestList.aspx).",
        inputSchema: {
          type: "object",
          properties: {
            fromDate: { type: "string", description: "Optional from-date (portal format)." },
            toDate: { type: "string", description: "Optional to-date (portal format)." },
          },
        },
      },
      {
        name: "get_lab_result",
        description:
          "Read one lab result detail using a ref token from list_labs (LabTestDetails.aspx).",
        inputSchema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Opaque refToken from list_labs." },
          },
          required: ["ref"],
        },
      },
      {
        name: "get_lab_document",
        description:
          "Download the original lab PDF for a list_labs ref (POST download control).",
        inputSchema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Opaque refToken from list_labs." },
          },
          required: ["ref"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      let result: unknown;
      if (name === "list_labs") result = await listLabsTool(listLabsSchema.parse(args));
      else if (name === "get_lab_result") result = await getLabResultTool(refSchema.parse(args));
      else if (name === "get_lab_document")
        result = await getLabDocumentTool(documentSchema.parse(args));
      else throw new Error(`Unknown tool: ${name}`);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "tool failed";
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
