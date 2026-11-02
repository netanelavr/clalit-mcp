/**
 * Portal pages that list PDF documents behind the shared
 * DownloadPdfBtnBinder flow: each grid row carries `data-actionurl` (a
 * DoesPdfExists-style API call that also selects the document server-side),
 * then `<page>PDF.ashx?show=true` streams the selected PDF.
 */
export interface DocumentSource {
  /** Stable id used by CLI/MCP (`visit_summaries`, …). */
  id: string;
  /** Hebrew portal title, for display. */
  title: string;
  /** English description for tool help. */
  description: string;
  /** List page path. */
  path: string;
  /** PDF stream path (from the page's DownloadPdfBtnBinder). */
  pdfPath: string;
  /** Date-range search form, when the page has one. */
  search?: DocumentSearch;
}

export interface DocumentSearch {
  /** WebForms field names for the date range (`dd.MM.yyyy`). */
  fromField: string;
  toField: string;
  /** Earliest date the portal datepicker accepts (`dd.MM.yyyy`). */
  minDate: string;
  /** __EVENTTARGET of the "show" button. */
  submit: string;
  /** Fixed extra fields (e.g. "all areas" dropdown). */
  fields?: Record<string, string>;
  /**
   * A required dropdown that only searches one value at a time (hospital).
   * Listing walks every non-zero option.
   */
  fanOutSelect?: string;
}

/** Opaque coordinates of one document: the source and its row's action URL. */
export interface DocumentRef {
  source: string;
  actionUrl: string;
  /** Row's `data-actiondata` JSON; when present the action URL is POSTed with it. */
  actionData?: string;
}

export interface DocumentListItem {
  source: string;
  /** Row date as shown (`dd.MM.yyyy`), when present. */
  date?: string;
  /** Remaining row cells as shown (doctor, specialty, hospital, …). */
  details: string[];
  ref: DocumentRef;
  refToken: string;
}

export interface ListDocumentsOptions {
  /** Inclusive from-date (`dd.MM.yyyy`). Defaults to the source's earliest date. */
  fromDate?: string;
  /** Inclusive to-date (`dd.MM.yyyy`). Defaults to today. */
  toDate?: string;
}

export interface ClalitDocument {
  ref: DocumentRef;
  contentType: string;
  filename: string;
  bytes: Uint8Array;
}
