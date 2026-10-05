/** One row from LabsTestList.aspx (own history only). */
export interface LabListItem {
  /** Opaque portal link query (s, d, ls) — never invent; only from list HTML. */
  ref: LabDetailRef;
  /** Display date as shown in the portal (Hebrew locale strings preserved). */
  date: string;
  /** Test / panel name as shown. */
  name: string;
  /** Optional status / result summary cell text. */
  summary?: string;
  /** Whether a detail link was present. */
  hasDetail: boolean;
}

/** Opaque detail coordinates from list links. Values are portal-issued. */
export interface LabDetailRef {
  s: string;
  d: string;
  ls: string;
}

export interface LabAnalyte {
  name: string;
  result: string;
  units?: string;
  referenceRange?: string;
  flag?: string;
}

export interface LabResultDetail {
  ref: LabDetailRef;
  title: string;
  date?: string;
  analytes: LabAnalyte[];
  /** Raw notes / narratives preserved as portal text. */
  notes: string[];
  /** True when a download postback control was detected. */
  hasDocument: boolean;
  /** Observed __EVENTTARGET candidate for PDF download, if any. */
  documentEventTarget?: string;
}

export interface LabDocument {
  ref: LabDetailRef;
  contentType: string;
  filename: string;
  bytes: Uint8Array;
}

export interface ListLabsOptions {
  /** Inclusive from-date as the portal datepicker expects (`dd.MM.yyyy`). */
  fromDate?: string;
  /** Inclusive to-date (`dd.MM.yyyy`). */
  toDate?: string;
}
