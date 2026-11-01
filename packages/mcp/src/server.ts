import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ALL_RECORD_SOURCES, DOCUMENT_SOURCES, DOCUMENT_SOURCE_IDS, PACKAGE_VERSION, RECORD_SOURCE_IDS } from "@clalit/core";
import {
  documentRefSchema,
  getDocumentTool,
  getRecordDocumentTool,
  getHospitalLabResultTool,
  hospitalLabLinkSchema,
  listRecordsSchema,
  listRecordsTool,
  recordRefSchema,
  getLabDocumentTool,
  listDocumentsSchema,
  listDocumentsTool,
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
  "Tools: list_labs → get_lab_result / get_lab_document; list_prescriptions → get_prescription_issue_status; list_lab_orders → get_lab_order; list_documents → get_document (visit summaries, hospital summaries, …); list_records → get_record_document / get_hospital_lab_result (diagnoses, sensitivities, medications, imaging, hospital visits and labs, referrals, appointments, recommendations, vaccinations, blood type).",
  "Never invent portal query params. Never switch family members.",
  "Sign-in is interactive CAPTCHA+SMS on the user's machine; Imperva blocks datacenter IPs.",
  "Preserve Hebrew source text, units, ranges, and dates. Lab PDFs are original bytes; prescription/lab-order PDFs are out of scope.",
  "Lab PDFs, document PDFs, imaging reports and referrals are original bytes; prescription/lab-order PDFs are out of scope.",
].join(" ");

/** Tools a host adds next to the Clalit readers (e.g. the sign-in and session tools). */
export interface ExtraTools {
  instructions?: string;
  tools: Tool[];
  /** Returns the result, or undefined when the name is not one of these tools. */
  call(name: string, args: Record<string, unknown>): Promise<unknown | undefined>;
}

/** The MCP server with every Clalit tool, not yet connected to a transport. */
export function createMcpServer(extra?: ExtraTools): Server {
  const server = new Server(
    { name: "clalit-mcp", version: PACKAGE_VERSION },
    {
      instructions: extra?.instructions ? `${INSTRUCTIONS} ${extra.instructions}` : INSTRUCTIONS,
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_labs",
        description:
          "List the authenticated owner's Clalit laboratory history (LabsTestList.aspx), walking every pager page.",
        inputSchema: {
          type: "object",
          properties: {
            fromDate: { type: "string", description: "Optional from-date (dd.MM.yyyy). list_labs walks all pager pages." },
            toDate: { type: "string", description: "Optional to-date (dd.MM.yyyy)." },
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
          "List the authenticated owner's lab orders / הפניות לבדיקות מעבדה (LabOrderList.aspx). General referrals are list_records with source referrals.",
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
      {
        name: "list_documents",
        description:
          "List the authenticated owner's PDF documents from one portal source, searching its full date range by default.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              enum: DOCUMENT_SOURCE_IDS,
              description: DOCUMENT_SOURCES.map((s) => `${s.id}: ${s.description}`).join(" "),
            },
            fromDate: { type: "string", description: "Optional from-date (dd.MM.yyyy)." },
            toDate: { type: "string", description: "Optional to-date (dd.MM.yyyy)." },
          },
          required: ["source"],
        },
      },
      {
        name: "get_document",
        description: "Download the original PDF for a list_documents ref.",
        inputSchema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Opaque refToken from list_documents." },
          },
          required: ["ref"],
        },
      },
      {
        name: "list_records",
        description:
          "List one record source for the authenticated owner: diagnoses, sensitivities, chronic medications, purchased medicines, medication approvals, imaging reports (clinics, hospitals, external institutes), hospital visits, hospital labs, referrals. Rows keep the portal's Hebrew column headers as keys.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              enum: RECORD_SOURCE_IDS,
              description: ALL_RECORD_SOURCES.map((s) => `${s.id}: ${s.description}`).join(" "),
            },
            fromDate: { type: "string", description: "Optional from-date (dd.MM.yyyy)." },
            toDate: { type: "string", description: "Optional to-date (dd.MM.yyyy)." },
          },
          required: ["source"],
        },
      },
      {
        name: "get_hospital_lab_result",
        description: "Read one hospital lab result page using a hospital_labs row's link from list_records (analytes, values, units, ranges, flags).",
        inputSchema: {
          type: "object",
          properties: {
            link: { type: "string", description: "The row's link (HospitalsLabTestDetails.aspx?s&d&h); it expires with the list's render." },
            hospital: { type: "string", description: "The row's context.value (hospital option): with testNumber, the search is replayed and the row's fresh link followed." },
            testNumber: { type: "string", description: "The row's מספר הבדיקה." },
            date: { type: "string", description: "The row's date (dd.MM.yyyy), when there is no test number." },
          },
        },
      },
      {
        name: "get_record_document",
        description: "Download the original PDF for a list_records ref (an imaging report, a referral).",
        inputSchema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Opaque refToken from list_records." },
          },
          required: ["ref"],
        },
      },
      ...(extra?.tools ?? []),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      let result: unknown = await extra?.call(name, args);
      if (result !== undefined) {
        /* answered by an extra tool */
      } else if (name === "list_labs") result = await listLabsTool(listLabsSchema.parse(args));
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
      else if (name === "list_documents")
        result = await listDocumentsTool(listDocumentsSchema.parse(args));
      else if (name === "get_document") result = await getDocumentTool(documentRefSchema.parse(args));
      else if (name === "list_records") result = await listRecordsTool(listRecordsSchema.parse(args));
      else if (name === "get_record_document") result = await getRecordDocumentTool(recordRefSchema.parse(args));
      else if (name === "get_hospital_lab_result") result = await getHospitalLabResultTool(hospitalLabLinkSchema.parse(args));
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

  return server;
}
