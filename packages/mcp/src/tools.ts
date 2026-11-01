import { connect, ALL_RECORD_SOURCES, DOCUMENT_SOURCE_IDS, DOCUMENT_SOURCES, RECORD_SOURCE_IDS, type ClalitClient } from "@clalit/core";
import { loadSession } from "@clalit/cli/store";
import { z } from "zod";

export const TOOL_NAMES = [
  "list_labs",
  "get_lab_result",
  "get_lab_document",
  "list_prescriptions",
  "get_prescription_issue_status",
  "list_lab_orders",
  "get_lab_order",
  "list_documents",
  "get_document",
  "list_records",
  "get_record_document",
  "get_hospital_lab_result",
] as const;

/**
 * Where the tools get their signed-in client. The default opens the saved
 * session file on every call; the stdio server swaps in its one live,
 * kept-alive client (session.ts).
 */
let clientSource: () => Promise<ClalitClient> = clientFromSessionFile;

export function setClientSource(source: () => Promise<ClalitClient>): void {
  clientSource = source;
}

export function getClient(): Promise<ClalitClient> {
  return clientSource();
}

async function clientFromSessionFile(): Promise<ClalitClient> {
  const session = await loadSession();
  if (!session) {
    throw new Error(
      "Not signed in. On your computer run: npx tsx packages/cli/src/main.ts login (browser CAPTCHA + SMS OTP). Cloud/datacenter IPs are blocked by Imperva.",
    );
  }
  return connect(session);
}

export const listLabsSchema = z.object({
  fromDate: z
    .string()
    .optional()
    .describe("Optional portal from-date (often dd/MM/yyyy)."),
  toDate: z.string().optional().describe("Optional portal to-date (often dd/MM/yyyy)."),
});

export const refSchema = z.object({
  ref: z
    .string()
    .describe("Opaque refToken from list_labs. Never invent s/d/ls query values."),
});

export const documentSchema = refSchema.extend({
  // MCP returns base64; agents may write to disk themselves.
});

export const listPrescriptionsSchema = z.object({
  fromDate: z.string().optional().describe("Optional portal from-date (often dd/MM/yyyy)."),
  toDate: z.string().optional().describe("Optional portal to-date (often dd/MM/yyyy)."),
  includeExpired: z
    .boolean()
    .optional()
    .describe("When true, include expired prescriptions (chkIncludeExpiredPrescriptions)."),
});

export const prescriptionIssueStatusSchema = z.object({
  prescriptionNo: z.string().describe("Opaque data-prescription from list_prescriptions."),
  medicationID: z.string().describe("Opaque data-medicineId from list_prescriptions."),
  medicationFormName: z.string().describe("data-medicineFormName from list_prescriptions."),
  medicationStartDate: z.string().describe("data-medicineStartDate from list_prescriptions."),
  sectionId: z.string().describe("hdnSectionID from the prescriptions list page."),
  currStatusValue: z
    .string()
    .optional()
    .describe("Optional currStatusValue; pass empty string when unknown."),
});

export const labOrderRefSchema = z.object({
  ref: z
    .string()
    .describe("Opaque refToken from list_lab_orders. Never invent ord query values."),
});

export async function listLabsTool(args: z.infer<typeof listLabsSchema>) {
  const client = await getClient();
  const data = await client.listLabs({
    fromDate: args.fromDate,
    toDate: args.toDate,
  });
  return {
    data: data.map((row) => ({
      date: row.date,
      name: row.name,
      summary: row.summary,
      hasDetail: row.hasDetail,
      ref: row.refToken,
      next: row.refToken
        ? [
            { tool: "get_lab_result", arguments: { ref: row.refToken } },
            { tool: "get_lab_document", arguments: { ref: row.refToken } },
          ]
        : [],
    })),
    guidance:
      "Private owner lab list only. Preserve Hebrew labels, dates, and values. Do not invent refs. Family/linked-member switching is unsupported.",
  };
}

export async function getLabResultTool(args: z.infer<typeof refSchema>) {
  const client = await getClient();
  const data = await client.getLabResult(args.ref);
  return {
    data: {
      title: data.title,
      date: data.date,
      analytes: data.analytes,
      notes: data.notes,
      hasDocument: data.hasDocument,
      ref: args.ref,
      next: data.hasDocument
        ? [{ tool: "get_lab_document", arguments: { ref: args.ref } }]
        : [],
    },
  };
}

export async function getLabDocumentTool(args: z.infer<typeof documentSchema>) {
  const client = await getClient();
  const doc = await client.getLabDocument(args.ref);
  return {
    data: {
      filename: doc.filename,
      contentType: doc.contentType,
      byteLength: doc.bytes.byteLength,
      pdfBase64: Buffer.from(doc.bytes).toString("base64"),
    },
    guidance: "Original PDF bytes (base64). Not extracted text. Handle as medical PHI.",
  };
}

export async function listPrescriptionsTool(args: z.infer<typeof listPrescriptionsSchema>) {
  const client = await getClient();
  const data = await client.listPrescriptions({
    fromDate: args.fromDate,
    toDate: args.toDate,
    includeExpired: args.includeExpired,
  });
  return {
    data: data.map((row) => ({
      prescriptionNo: row.prescriptionNo,
      prescriptionDisplayNo: row.prescriptionDisplayNo,
      prescriptionType: row.prescriptionType,
      prescriberName: row.prescriberName,
      medicines: row.medicines,
      next: row.medicines.map((m) => ({
        tool: "get_prescription_issue_status",
        note: "Pass sectionId from the list page hdnSectionID; values from this medicine row only.",
        arguments: {
          prescriptionNo: row.prescriptionNo,
          medicationID: m.medicineId,
          medicationFormName: m.medicineFormName,
          medicationStartDate: m.medicineStartDate,
        },
      })),
    })),
    guidance:
      "Private owner prescriptions (מרשמים) only. Preserve Hebrew labels. Issue status is read-only — not a purchase. No PDF/print. Family switching unsupported.",
  };
}

export async function getPrescriptionIssueStatusTool(
  args: z.infer<typeof prescriptionIssueStatusSchema>,
) {
  const client = await getClient();
  const data = await client.getPrescriptionIssueStatus({
    prescriptionNo: args.prescriptionNo,
    medicationID: args.medicationID,
    medicationFormName: args.medicationFormName,
    medicationStartDate: args.medicationStartDate,
    sectionId: args.sectionId,
    currStatusValue: args.currStatusValue ?? "",
  });
  return {
    data,
    guidance: "Read-only pharmacy issue status. Do not treat as a purchase confirmation write.",
  };
}

export async function listLabOrdersTool() {
  const client = await getClient();
  const data = await client.listLabOrders();
  return {
    data: data.map((row) => ({
      issuanceDate: row.issuanceDate,
      referer: row.referer,
      validTo: row.validTo,
      section: row.section,
      hasDetail: row.hasDetail,
      ref: row.refToken,
      next: row.refToken
        ? [{ tool: "get_lab_order", arguments: { ref: row.refToken } }]
        : [],
    })),
    guidance:
      "Lab orders (הפניות לבדיקות מעבדה) only — not MedicalReferrals.aspx. Preserve Hebrew labels. Do not invent ord refs. No PDF/print. Family switching unsupported.",
  };
}

export async function getLabOrderTool(args: z.infer<typeof labOrderRefSchema>) {
  const client = await getClient();
  const data = await client.getLabOrder(args.ref);
  return {
    data: {
      title: data.title,
      validFrom: data.validFrom,
      validTo: data.validTo,
      labOrderId: data.labOrderId,
      items: data.items,
      ref: args.ref,
    },
    guidance: "Lab-order detail HTML only. Print/PDF/email download is not fetched.",
  };
}

export const listDocumentsSchema = z.object({
  source: z
    .enum(DOCUMENT_SOURCE_IDS as [string, ...string[]])
    .describe(DOCUMENT_SOURCES.map((s) => `${s.id}: ${s.description}`).join(" ")),
  fromDate: z.string().optional().describe("Optional from-date (dd.MM.yyyy). Defaults to the earliest the portal allows."),
  toDate: z.string().optional().describe("Optional to-date (dd.MM.yyyy). Defaults to today."),
});

export const documentRefSchema = z.object({
  ref: z.string().describe("Opaque refToken from list_documents. Never invent action URLs."),
});

export async function listDocumentsTool(args: z.infer<typeof listDocumentsSchema>) {
  const client = await getClient();
  const data = await client.listDocuments(args.source, {
    fromDate: args.fromDate,
    toDate: args.toDate,
  });
  return {
    data: data.map((row) => ({
      source: row.source,
      date: row.date,
      details: row.details,
      ref: row.refToken,
      next: [{ tool: "get_document", arguments: { ref: row.refToken } }],
    })),
    guidance:
      "Private owner documents only. Preserve Hebrew labels and dates. Do not invent refs. Family switching unsupported.",
  };
}

export async function getDocumentTool(args: z.infer<typeof documentRefSchema>) {
  const client = await getClient();
  const doc = await client.getDocument(args.ref);
  return {
    data: {
      source: doc.ref.source,
      filename: doc.filename,
      contentType: doc.contentType,
      byteLength: doc.bytes.byteLength,
      pdfBase64: Buffer.from(doc.bytes).toString("base64"),
    },
    guidance: "Original PDF bytes (base64). Not extracted text. Handle as medical PHI.",
  };
}

export const listRecordsSchema = z.object({
  source: z
    .enum(RECORD_SOURCE_IDS as [string, ...string[]])
    .describe(ALL_RECORD_SOURCES.map((s) => `${s.id}: ${s.description}`).join(" ")),
  fromDate: z.string().optional().describe("Optional from-date (dd.MM.yyyy). Defaults to the earliest the portal allows."),
  toDate: z.string().optional().describe("Optional to-date (dd.MM.yyyy). Defaults to today."),
});

export const recordRefSchema = z.object({
  ref: z.string().describe("Opaque refToken from list_records. Never invent action URLs."),
});

export async function listRecordsTool(args: z.infer<typeof listRecordsSchema>) {
  const client = await getClient();
  const data = await client.listRecords(args.source, { fromDate: args.fromDate, toDate: args.toDate });
  return {
    data: data.map((row) => ({
      source: row.source,
      date: row.date,
      fields: row.fields,
      ...(row.items ? { items: row.items } : {}),
      ...(row.links ? { links: row.links } : {}),
      ...(row.context ? { context: row.context } : {}),
      ...(row.refToken ? { ref: row.refToken, next: [{ tool: "get_record_document", arguments: { ref: row.refToken } }] } : {}),
    })),
    guidance:
      "Rows as the portal shows them; keys are the portal's Hebrew column headers. Private owner records only. Do not invent refs. Family switching unsupported.",
  };
}

export async function getRecordDocumentTool(args: z.infer<typeof recordRefSchema>) {
  const client = await getClient();
  const doc = await client.getRecordDocument(args.ref);
  return {
    data: {
      source: doc.ref.source,
      filename: doc.filename,
      contentType: doc.contentType,
      byteLength: doc.bytes.byteLength,
      pdfBase64: Buffer.from(doc.bytes).toString("base64"),
    },
    guidance: "Original PDF bytes (base64). Not extracted text. Handle as medical PHI.",
  };
}

export const hospitalLabLinkSchema = z.object({
  link: z.string().optional().describe("A hospital_labs row's link from list_records (HospitalsLabTestDetails.aspx?s&d&h). Never invent one."),
  hospital: z.string().optional().describe("The row's context.value from list_records (the hospital option). With testNumber, the search is replayed and the row's fresh link followed — links expire with each render of the list."),
  testNumber: z.string().optional().describe("The row's מספר הבדיקה field from list_records."),
  date: z.string().optional().describe("The row's date (dd.MM.yyyy), when there is no test number."),
});

export async function getHospitalLabResultTool(args: z.infer<typeof hospitalLabLinkSchema>) {
  const client = await getClient();
  const data = await client.getHospitalLabResult({
    link: args.link,
    ...(args.hospital ? { context: { select: "ctl00$ctl00$cphBody$bodyContent$LabsHistory1$ddlHospitalName", value: args.hospital } } : {}),
    testNumber: args.testNumber,
    date: args.date,
  });
  return { data, guidance: "Hospital lab result as parsed from the portal page. Preserve Hebrew names, units and ranges." };
}
