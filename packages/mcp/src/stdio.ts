import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getLabDocumentTool,
  getLabOrderTool,
  getLabResultTool,
  getPrescriptionIssueStatusTool,
  listLabsSchema,
  listLabsTool,
  listLabOrdersTool,
  listPrescriptionsSchema,
  listPrescriptionsTool,
  documentSchema,
  labOrderRefSchema,
  prescriptionIssueStatusSchema,
  refSchema,
} from "./tools.js";

const INSTRUCTIONS = [
  "Unofficial Clalit own-account reader (read-only).",
  "Unaffiliated with Clalit Health Services.",
  "Tools: list_labs → get_lab_result / get_lab_document; list_prescriptions → get_prescription_issue_status; list_lab_orders → get_lab_order.",
  "Never invent portal query params. Never switch family members.",
  "Sign-in is interactive CAPTCHA+SMS on the user's machine; Imperva blocks datacenter IPs.",
  "Preserve Hebrew source text, units, ranges, and dates. Lab PDFs are original bytes; prescription/lab-order PDFs are out of scope.",
  "MedicalReferrals.aspx is not implemented.",
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
      {
        name: "list_prescriptions",
        description:
          "List the authenticated owner's prescriptions / מרשמים (PatientPrescriptionsex.aspx).",
        inputSchema: {
          type: "object",
          properties: {
            fromDate: { type: "string", description: "Optional from-date (portal format)." },
            toDate: { type: "string", description: "Optional to-date (portal format)." },
            includeExpired: {
              type: "boolean",
              description: "Include expired prescriptions when true.",
            },
          },
        },
      },
      {
        name: "get_prescription_issue_status",
        description:
          "Read pharmacy issue status for one medicine row (IssueDrugsByPatientReceiptId). Values from list_prescriptions only; not a purchase write.",
        inputSchema: {
          type: "object",
          properties: {
            prescriptionNo: { type: "string" },
            medicationID: { type: "string" },
            medicationFormName: { type: "string" },
            medicationStartDate: { type: "string" },
            sectionId: { type: "string" },
            currStatusValue: { type: "string" },
          },
          required: [
            "prescriptionNo",
            "medicationID",
            "medicationFormName",
            "medicationStartDate",
            "sectionId",
          ],
        },
      },
      {
        name: "list_lab_orders",
        description:
          "List the authenticated owner's lab orders / הפניות לבדיקות מעבדה (LabOrderList.aspx). Not MedicalReferrals.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_lab_order",
        description:
          "Read one lab-order detail using a ref token from list_lab_orders (LabOrderDetails.aspx?ord=). No PDF.",
        inputSchema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Opaque refToken from list_lab_orders." },
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
      else if (name === "list_prescriptions")
        result = await listPrescriptionsTool(listPrescriptionsSchema.parse(args));
      else if (name === "get_prescription_issue_status")
        result = await getPrescriptionIssueStatusTool(prescriptionIssueStatusSchema.parse(args));
      else if (name === "list_lab_orders") result = await listLabOrdersTool();
      else if (name === "get_lab_order")
        result = await getLabOrderTool(labOrderRefSchema.parse(args));
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
