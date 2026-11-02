/** Opaque coordinates of one record's PDF: the source and its row's action URL. */
export interface RecordRef {
  source: string;
  actionUrl: string;
  /** Row's `data-actiondata` JSON; when present the action URL is POSTed with it. */
  actionData?: string;
}

/** One row of a record source's grid, kept as the portal shows it. */
export interface RecordRow {
  source: string;
  /** The row's first `dd.MM.yyyy` cell, when there is one. */
  date?: string;
  /** Header → cell text, for the headed columns; keys are the portal's Hebrew headers. */
  fields: Record<string, string>;
  /** Every cell's text, in column order (action columns included, usually empty). */
  cells: string[];
  /** Same-origin page links found in the row (a detail page, say), as portal paths. */
  links?: string[];
  /** Sub-rows of a composite record (a referral's services). */
  items?: Record<string, string>[];
  /** Present when the row has a PDF behind the portal's download flow. */
  ref?: RecordRef;
  refToken?: string;
  /**
   * The search this row came out of, when the page searches one dropdown value at a time (the hospital):
   * the select's field name and the option's value. A detail page opens only while that search is the
   * portal's current one, so readers of a row's detail replay it first.
   */
  context?: { select: string; value: string };
}

export interface ListRecordsOptions {
  /** Inclusive from-date (`dd.MM.yyyy`). Defaults to the source's earliest date. */
  fromDate?: string;
  /** Inclusive to-date (`dd.MM.yyyy`). Defaults to today. */
  toDate?: string;
  /**
   * Called with each page of rows as soon as the portal has rendered it, before the next page or
   * hospital is asked for. Links in the rows are valid only until the list is rendered again, so
   * anything that follows them (a result page) has to happen here.
   */
  onPage?: (rows: RecordRow[]) => Promise<void>;
}

export interface RecordDocument {
  ref: RecordRef;
  contentType: string;
  filename: string;
  bytes: Uint8Array;
}
