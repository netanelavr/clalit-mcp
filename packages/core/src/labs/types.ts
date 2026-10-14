/** One row from LabsTestList.aspx (own history only). */
export interface LabListItem {
  /** Opaque portal link query (s, d, ls) — never invent; only from list HTML. */
  ref: LabDetailRef;
  /** Display date as shown in the portal (Hebrew locale strings preserved). */
  date: string;
  /** The lab section (תחום המעבדה: המטולוגיה, כימיה, מיקרוביולוגיה…) as the list shows it. */
  name: string;
  /** "referring doctor · test number", for display. */
  summary?: string;
  /** The referring doctor's name as shown. */
  doctor?: string;
  /** The portal's number for this test (מספר הבדיקה). */
  testNumber?: string;
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
  /** The result as the page shows it: "113 %", "0.91", "Negative", "0.52 Negative", "FEW". */
  result: string;
  /** The leading number of `result`, when it has one. */
  value?: number;
  /** What follows the number when it is a unit: "%", "Sec", "mg/dL", "/HPF". */
  units?: string;
  /** What follows the number when it is a word: "Negative", "Positive". */
  qualifier?: string;
  /** "min-max" when the page draws a range bar for the test. */
  referenceRange?: string;
  rangeMin?: number;
  rangeMax?: number;
  /** "L" or "H" when the value is outside the range (as the page's own script decides); absent otherwise. */
  flag?: string;
  /** The page's turnaround column ("1 ימי עבודה"). */
  turnaround?: string;
  /** Clalit's explanation of the test, from the row's "הערות והסבר" panel. */
  explanation?: string;
  /** Opaque query of the row's LabTestCompare.aspx link (the test's history), as issued by the portal. */
  compare?: { labId: string; labName: string };
}

export interface LabResultDetail {
  ref: LabDetailRef;
  /** The lab section (המטולוגיה, כימיה, מיקרוביולוגיה…) as the page heads it. */
  title: string;
  /** The sample's date as shown ("dd.MM.yyyy"). */
  date?: string;
  /** The sample's time as shown ("HH:MM"), when the page gives one. */
  time?: string;
  /** The portal's number for this test (the list's "מספר הבדיקה"). */
  testNumber?: string;
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
