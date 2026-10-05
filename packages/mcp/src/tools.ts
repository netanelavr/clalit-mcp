import { connect, type ClalitClient } from "@clalit/core";
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
] as const;

export async function getClient(): Promise<ClalitClient> {
  const session = await loadSession();
  if (!session) {
    throw new Error(
      "Not signed in. On your Mac run: npx clalit-mcp login (CAPTCHA + SMS OTP). Cloud/datacenter IPs are blocked by Imperva.",
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
