/** One medicine nested under a prescription list row (own list only). */
export interface PrescriptionMedicine {
  /** Opaque portal value from data-medicineId. */
  medicineId: string;
  /** Opaque / form name from data-medicineFormName. */
  medicineFormName: string;
  /** Portal start-date string from data-medicineStartDate. */
  medicineStartDate: string;
  /** Display name as shown (colMedicineName), if present. */
  medicineName?: string;
}

/** One prescription group from PatientPrescriptionsex.aspx. */
export interface PrescriptionListItem {
  /** Opaque prescription number from data-prescription on nested medicines. */
  prescriptionNo: string;
  /** Display text from colPrescriptionFullNo when present. */
  prescriptionDisplayNo?: string;
  /** Display type / category cell text. */
  prescriptionType?: string;
  /** Prescriber display name as portal text. */
  prescriberName?: string;
  medicines: PrescriptionMedicine[];
}

/** Optional list filters mirroring observed WebForms field names. */
export interface ListPrescriptionsOptions {
  /** Inclusive from-date as the portal datepicker expects (often dd/MM/yyyy). */
  fromDate?: string;
  toDate?: string;
  /** Maps to chkIncludeExpiredPrescriptions when true. */
  includeExpired?: boolean;
}

/**
 * IssueDrugsByPatientReceiptId request keys (values only from list row attrs +
 * page sectionId — never invent).
 */
export interface PrescriptionIssueStatusRequest {
  prescriptionNo: string;
  medicationID: string;
  medicationFormName: string;
  medicationStartDate: string;
  sectionId: string;
  /** Observed empty in HAR; pass "" when unknown. */
  currStatusValue?: string;
}

/** Parsed read-only issue/purchase status (statusCode_0 / statusDesc_0). */
export interface PrescriptionIssueStatus {
  statusCode: string;
  statusDesc: string;
}
