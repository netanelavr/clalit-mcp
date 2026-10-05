import { ParseError } from "../errors.js";
import type { PrescriptionIssueStatus, PrescriptionIssueStatusRequest } from "./types.js";

/** Build the JSON body for IssueDrugsByPatientReceiptId (read status only). */
export function buildIssueDrugsRequestBody(req: PrescriptionIssueStatusRequest): string {
  if (
    !req.prescriptionNo ||
    !req.medicationID ||
    !req.medicationFormName ||
    !req.medicationStartDate ||
    !req.sectionId
  ) {
    throw new ParseError("INVALID_ISSUE_STATUS_REQUEST", "Issue status request is incomplete.");
  }
  return JSON.stringify({
    prescriptionNo: req.prescriptionNo,
    medicationID: req.medicationID,
    medicationFormName: req.medicationFormName,
    medicationStartDate: req.medicationStartDate,
    sectionId: req.sectionId,
    currStatusValue: req.currStatusValue ?? "",
  });
}

/**
 * Parse IssueDrugs response. Observed shape: JSON-encoded string wrapping an object
 * with statusCode_0 / statusDesc_0. Also accepts a bare object.
 */
export function parseIssueDrugsResponse(body: unknown): PrescriptionIssueStatus {
  let obj: unknown = body;

  if (typeof obj === "string") {
    const trimmed = obj.trim();
    try {
      obj = JSON.parse(trimmed);
    } catch {
      throw new ParseError("ISSUE_STATUS_SHAPE", "IssueDrugs response is not valid JSON.");
    }
    // Double-encoded string wrapper
    if (typeof obj === "string") {
      try {
        obj = JSON.parse(obj);
      } catch {
        throw new ParseError("ISSUE_STATUS_SHAPE", "IssueDrugs wrapped string is not valid JSON.");
      }
    }
  }

  if (!obj || typeof obj !== "object") {
    throw new ParseError("ISSUE_STATUS_SHAPE", "IssueDrugs response is not an object.");
  }

  const record = obj as Record<string, unknown>;
  const statusCode = record.statusCode_0;
  const statusDesc = record.statusDesc_0;
  if (typeof statusCode !== "string" || typeof statusDesc !== "string") {
    throw new ParseError("ISSUE_STATUS_SHAPE", "IssueDrugs missing statusCode_0 / statusDesc_0.");
  }
  return { statusCode, statusDesc };
}
