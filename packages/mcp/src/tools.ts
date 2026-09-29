import { connect, type ClalitClient } from "@clalit/core";
import { loadSession } from "@clalit/cli/store";
import { z } from "zod";

export const TOOL_NAMES = ["list_labs", "get_lab_result", "get_lab_document"] as const;

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
