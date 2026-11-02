import {
  LABS_LIST_FIELDS,
  LABS_LIST_MAX_PAGES,
  PATHS,
  PORTAL_ORIGIN,
  PRESCRIPTIONS_LIST_FIELDS,
  PRESCRIPTIONS_LIST_MAX_PAGES,
} from "./constants.js";
import { OwnerScopeError, ParseError, UpstreamError } from "./errors.js";
import {
  decodeLabOrderRef,
  encodeLabOrderRef,
  parseLabOrderDetailHtml,
  parseLabOrdersListHtml,
  type LabOrderDetail,
  type LabOrderListItem,
  type LabOrderRef,
} from "./lab-orders/index.js";
import {
  buildLabDocument,
  decodeLabRef,
  encodeLabRef,
  nextLabPagerPage,
  parseLabDetailHtml,
  parseLabsListHtml,
  type LabDetailRef,
  type LabDocument,
  type LabListItem,
  type LabResultDetail,
  type ListLabsOptions,
} from "./labs/index.js";
import {
  buildIssueDrugsRequestBody,
  currentPrescriptionPagerPage,
  extractPrescriptionSectionId,
  nextPrescriptionPagerPage,
  parseIssueDrugsResponse,
  parsePrescriptionsListHtml,
  type ListPrescriptionsOptions,
  type PrescriptionIssueStatus,
  type PrescriptionIssueStatusRequest,
  type PrescriptionListItem,
} from "./prescriptions/index.js";
import {
  decodeDocumentRef,
  documentSource,
  encodeDocumentRef,
  parseDocumentsListHtml,
  selectOptions,
  type ClalitDocument,
  type DocumentListItem,
  type DocumentRef,
  type ListDocumentsOptions,
} from "./documents/index.js";
import {
  decodeRecordRef,
  encodeRecordRef,
  nextRecordPagerPage,
  parseApiJson,
  parseAppointmentsHtml,
  parseRecommendationsHtml,
  parseRecordGridHtml,
  parseReferralsHtml,
  recordSource,
  referralsHaveNextPage,
  REFERRALS_NEXT_TARGET,
  REFERRALS_SOURCE_ID,
  type ListRecordsOptions,
  type RecordDocument,
  type RecordRef,
  type RecordRow,
} from "./records/index.js";
import { assertPdfBytes, filenameFromContentDisposition } from "./labs/document.js";
import type { ClalitTransport } from "./transport.js";
import { readBytes, readText } from "./transport.js";
import { buildPostBackBody, extractWebFormsState, looksLikeLoginPage } from "./webforms.js";

export interface ListedLab extends LabListItem {
  /** Opaque token for CLI/MCP follow-up calls. */
  refToken?: string;
}

export interface ListedLabOrder extends LabOrderListItem {
  /** Opaque token for CLI/MCP follow-up calls. */
  refToken?: string;
}

function detailUrl(ref: LabDetailRef): string {
  const u = new URL(PORTAL_ORIGIN + PATHS.labDetail);
  u.searchParams.set("s", ref.s);
  u.searchParams.set("d", ref.d);
  u.searchParams.set("ls", ref.ls);
  return u.toString();
}

function labOrderDetailUrl(ref: LabOrderRef): string {
  const u = new URL(PORTAL_ORIGIN + PATHS.labOrderDetail);
  u.searchParams.set("ord", ref.ord);
  return u.toString();
}

function assertOwnRef(ref: LabDetailRef): void {
  // Family slider must never be set by this client. Refs only from own list.
  if (!ref.s || !ref.d || !ref.ls) throw new ParseError("INVALID_REF");
}

function assertOwnLabOrderRef(ref: LabOrderRef): void {
  if (!ref.ord) throw new ParseError("INVALID_REF");
}


function omitFamilySliderFields(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/FamilySliderControl\d+\$(au|cu)$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function labsDateFieldsFromOptions(options: ListLabsOptions): Record<string, string> {
  const fields: Record<string, string> = {};
  if (options.fromDate) fields[LABS_LIST_FIELDS.fromDate] = options.fromDate;
  if (options.toDate) fields[LABS_LIST_FIELDS.toDate] = options.toDate;
  return fields;
}

/** Round-trip datepicker values from the current list HTML (portal keeps them on pager POSTs). */
function labsDateFieldsFromHtml(html: string): Record<string, string> {
  const fromEsc = LABS_LIST_FIELDS.fromDate.replace(/\$/g, "\\$");
  const toEsc = LABS_LIST_FIELDS.toDate.replace(/\$/g, "\\$");
  const fromAlt =
    html.match(new RegExp(`name="${fromEsc}"[^>]*value="([^"]*)"`, "i")) ??
    html.match(new RegExp(`value="([^"]*)"[^>]*name="${fromEsc}"`, "i"));
  const toAlt =
    html.match(new RegExp(`name="${toEsc}"[^>]*value="([^"]*)"`, "i")) ??
    html.match(new RegExp(`value="([^"]*)"[^>]*name="${toEsc}"`, "i"));
  const fields: Record<string, string> = {};
  if (fromAlt?.[1]) fields[LABS_LIST_FIELDS.fromDate] = fromAlt[1];
  if (toAlt?.[1]) fields[LABS_LIST_FIELDS.toDate] = toAlt[1];
  return fields;
}

function labListItemKey(item: LabListItem): string {
  if (item.hasDetail && item.ref.s && item.ref.d && item.ref.ls) {
    return `${item.ref.s}|${item.ref.d}|${item.ref.ls}`;
  }
  return `${item.date}|${item.name}|${item.summary ?? ""}`;
}

export class ClalitReaders {
  constructor(private readonly transport: ClalitTransport) {}

  /**
   * listLabs — GET LabsTestList.aspx, optional date filter via btnGetTestsAcc,
   * then walk PagerLink-N until the last page (~5 rows/page).
   */
  async listLabs(options: ListLabsOptions = {}): Promise<ListedLab[]> {
    this.transport.assertNotIdleExpired();
    const listUrl = PORTAL_ORIGIN + PATHS.labsList;
    let response = await this.transport.request(listUrl);
    let html = await readText(response);

    const optionDates = labsDateFieldsFromOptions(options);
    if (Object.keys(optionDates).length > 0) {
      const state = extractWebFormsState(html);
      const cleanState = { ...state, hidden: omitFamilySliderFields(state.hidden) };
      response = await this.transport.request(listUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: buildPostBackBody(cleanState, optionDates, LABS_LIST_FIELDS.filterSubmit, ""),
      });
      html = await readText(response);
    }

    const collected: ListedLab[] = [];
    const seen = new Set<string>();
    let currentPage = 1;
    let pagesFetched = 0;

    while (true) {
      pagesFetched += 1;
      for (const item of parseLabsListHtml(html)) {
        const key = labListItemKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push({
          ...item,
          ...(item.hasDetail ? { refToken: encodeLabRef(item.ref) } : {}),
        });
      }

      if (pagesFetched >= LABS_LIST_MAX_PAGES) break;
      const nextPage = nextLabPagerPage(html, currentPage);
      if (nextPage === undefined) break;

      const state = extractWebFormsState(html);
      const cleanState = { ...state, hidden: omitFamilySliderFields(state.hidden) };
      const fields = {
        ...labsDateFieldsFromHtml(html),
        ...optionDates,
      };
      response = await this.transport.request(listUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: buildPostBackBody(
          cleanState,
          fields,
          `${LABS_LIST_FIELDS.pagerLinkPrefix}${nextPage}`,
          "",
        ),
      });
      html = await readText(response);
      currentPage = nextPage;
    }

    return collected;
  }

  /** getLabResult — GET LabTestDetails.aspx?s&d&ls from a list-issued ref only. */
  async getLabResult(refOrToken: LabDetailRef | string): Promise<LabResultDetail> {
    this.transport.assertNotIdleExpired();
    const ref = typeof refOrToken === "string" ? decodeLabRef(refOrToken) : refOrToken;
    assertOwnRef(ref);
    const response = await this.transport.request(detailUrl(ref));
    const html = await readText(response);
    if (/FamilySliderControl\d+\$au/i.test(html) && /selected|switch/i.test(html)) {
      // Soft guard: if page indicates a non-self member context, fail closed.
      // Without a stable owner-id field name, we rely on list-only refs.
    }
    return parseLabDetailHtml(html, ref);
  }

  /**
   * getLabDocument — POST LabTestDetails.aspx with __EVENTTARGET download control
   * → application/octet-stream / PDF. Uses event target from a fresh detail parse.
   */
  async getLabDocument(refOrToken: LabDetailRef | string): Promise<LabDocument> {
    this.transport.assertNotIdleExpired();
    const ref = typeof refOrToken === "string" ? decodeLabRef(refOrToken) : refOrToken;
    assertOwnRef(ref);
    const detail = await this.getLabResult(ref);
    if (!detail.hasDocument || !detail.documentEventTarget) {
      throw new UpstreamError("NO_DOCUMENT");
    }

    // Re-GET for fresh VIEWSTATE before POST
    const page = await this.transport.request(detailUrl(ref));
    const html = await readText(page);
    const state = extractWebFormsState(html);
    const post = await this.transport.request(detailUrl(ref), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: buildPostBackBody(state, {}, detail.documentEventTarget, ""),
    });

    const ct = post.headers.get("content-type") ?? "";
    if (!/octet-stream|pdf|application\/download/i.test(ct) && post.status === 200) {
      // Some portals return PDF without content-type; check magic later.
    }
    const bytes = await readBytes(post);
    return buildLabDocument(ref, bytes, ct, post.headers.get("content-disposition"));
  }

  /**
   * listPrescriptions — GET PatientPrescriptionsex.aspx (optional date filter),
   * then walk gridPager via __EVENTARGUMENT until the last page.
   */
  async listPrescriptions(options: ListPrescriptionsOptions = {}): Promise<PrescriptionListItem[]> {
    this.transport.assertNotIdleExpired();
    const listUrl = PORTAL_ORIGIN + PATHS.prescriptionsList;
    let response = await this.transport.request(listUrl);
    let html = await readText(response);

    const optionFields: Record<string, string> = {};
    if (options.fromDate) optionFields[PRESCRIPTIONS_LIST_FIELDS.fromDate] = options.fromDate;
    if (options.toDate) optionFields[PRESCRIPTIONS_LIST_FIELDS.toDate] = options.toDate;
    if (options.includeExpired) optionFields[PRESCRIPTIONS_LIST_FIELDS.includeExpired] = "on";

    if (Object.keys(optionFields).length > 0) {
      const state = extractWebFormsState(html);
      const cleanState = { ...state, hidden: omitFamilySliderFields(state.hidden) };
      response = await this.transport.request(listUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: buildPostBackBody(cleanState, optionFields),
      });
      html = await readText(response);
    }

    const byPrescriptionNo = new Map<string, PrescriptionListItem>();
    let currentPage = currentPrescriptionPagerPage(html);
    let pagesFetched = 0;

    while (true) {
      pagesFetched += 1;
      for (const item of parsePrescriptionsListHtml(html)) {
        if (byPrescriptionNo.has(item.prescriptionNo)) continue;
        byPrescriptionNo.set(item.prescriptionNo, item);
      }

      if (pagesFetched >= PRESCRIPTIONS_LIST_MAX_PAGES) break;
      const nextPage = nextPrescriptionPagerPage(html, currentPage);
      if (nextPage === undefined) break;

      const state = extractWebFormsState(html);
      const cleanState = { ...state, hidden: omitFamilySliderFields(state.hidden) };
      const fields = {
        ...optionFields,
        [PRESCRIPTIONS_LIST_FIELDS.hiddenPager]: String(nextPage),
      };
      response = await this.transport.request(listUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: buildPostBackBody(
          cleanState,
          fields,
          PRESCRIPTIONS_LIST_FIELDS.gridPager,
          String(nextPage),
        ),
      });
      html = await readText(response);
      currentPage = nextPage;
    }

    return [...byPrescriptionNo.values()];
  }

  /**
   * getPrescriptionIssueStatus — POST IssueDrugsByPatientReceiptId (read status only).
   * Keys must come from a list row's data-* + page sectionId; never invent values.
   */
  async getPrescriptionIssueStatus(
    req: PrescriptionIssueStatusRequest,
  ): Promise<PrescriptionIssueStatus> {
    this.transport.assertNotIdleExpired();

    // If sectionId omitted, pull from a fresh list page (hdnSectionID).
    let sectionId = req.sectionId;
    if (!sectionId) {
      const listUrl = PORTAL_ORIGIN + PATHS.prescriptionsList;
      const page = await this.transport.request(listUrl);
      const html = await readText(page);
      sectionId = extractPrescriptionSectionId(html) ?? "";
    }

    const body = buildIssueDrugsRequestBody({ ...req, sectionId });
    const response = await this.transport.request(PORTAL_ORIGIN + PATHS.prescriptionIssueStatus, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
    });
    const text = await readText(response);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as string; parseIssueDrugsResponse will fail closed
    }
    return parseIssueDrugsResponse(parsed);
  }

  /** listLabOrders — GET LabOrderList.aspx (הפניות לבדיקות מעבדה). */
  async listLabOrders(): Promise<ListedLabOrder[]> {
    this.transport.assertNotIdleExpired();
    const listUrl = PORTAL_ORIGIN + PATHS.labOrdersList;
    const response = await this.transport.request(listUrl);
    const html = await readText(response);

    if (/FamilySliderControl\d+\$au|FamilySliderControl\d+\$cu/i.test(html)) {
      // Presence OK; never POST au/cu.
    }

    const items = parseLabOrdersListHtml(html);
    return items.map((item) => ({
      ...item,
      ...(item.hasDetail ? { refToken: encodeLabOrderRef(item.ref) } : {}),
    }));
  }

  /** getLabOrder — GET LabOrderDetails.aspx?ord= from a list-issued ref only. */
  async getLabOrder(refOrToken: LabOrderRef | string): Promise<LabOrderDetail> {
    this.transport.assertNotIdleExpired();
    const ref = typeof refOrToken === "string" ? decodeLabOrderRef(refOrToken) : refOrToken;
    assertOwnLabOrderRef(ref);
    const response = await this.transport.request(labOrderDetailUrl(ref));
    const html = await readText(response);
    return parseLabOrderDetailHtml(html, ref);
  }

  /**
   * listDocuments — GET a document source's page, POST its date-range search
   * (once per dropdown option for fan-out sources), parse data-actionurl rows.
   */
  async listDocuments(sourceId: string, options: ListDocumentsOptions = {}): Promise<DocumentListItem[]> {
    this.transport.assertNotIdleExpired();
    const source = documentSource(sourceId);
    if (!source) throw new ParseError("UNKNOWN_SOURCE", "Unknown document source.");
    const listUrl = PORTAL_ORIGIN + source.path;
    const page = await readText(await this.transport.request(listUrl));
    const search = source.search;
    if (!search) return parseDocumentsListHtml(page, source.id);

    const fanOut = search.fanOutSelect ? selectOptions(page, search.fanOutSelect) : [undefined];
    const from = options.fromDate ?? search.minDate;
    const to = options.toDate ?? todayPortalDate();

    const collected: DocumentListItem[] = [];
    const seen = new Set<string>();
    for (const option of fanOut) {
      const searchOnce = async (rangeFrom: string, rangeTo: string): Promise<DocumentListItem[]> => {
        const fields = { ...search.fields, [search.fromField]: rangeFrom, [search.toField]: rangeTo };
        const html = await readText(await this.transport.request(listUrl));
        const state = extractWebFormsState(html);
        const cleanState = { ...state, hidden: omitFamilySliderFields(state.hidden) };
        const response = await this.transport.request(listUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: buildPostBackBody(
            cleanState,
            option && search.fanOutSelect ? { ...fields, [search.fanOutSelect]: option[0] } : fields,
            search.submit,
            "",
          ),
        });
        return parseDocumentsListHtml(await readText(response), source.id);
      };
      for (const item of await searchSplitting(searchOnce, from, to)) {
        if (seen.has(item.refToken)) continue;
        seen.add(item.refToken);
        // The hospital is the search, not a grid column; keep it with the row.
        collected.push(option ? { ...item, details: [option[1], ...item.details] } : item);
      }
    }
    return collected;
  }

  /**
   * getDocument — GET the row's action URL (selects the document server-side),
   * then GET the source's PDF stream. Refs only from listDocuments.
   */
  async getDocument(refOrToken: DocumentRef | string): Promise<ClalitDocument> {
    this.transport.assertNotIdleExpired();
    // Decode even a passed ref: it validates the source and action URL.
    const ref = decodeDocumentRef(
      typeof refOrToken === "string" ? refOrToken : encodeDocumentRef(refOrToken),
    );
    const source = documentSource(ref.source)!;
    const exists = await this.transport.request(PORTAL_ORIGIN + ref.actionUrl, {
      allowLoginHtml: true,
      ...(ref.actionData
        ? { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: ref.actionData }
        : {}),
    });
    await exists.arrayBuffer();
    if (exists.status === 404) throw new UpstreamError("NO_DOCUMENT", 404);
    if (!exists.ok) throw new UpstreamError("DOCUMENT_CHECK_FAILED", exists.status);

    const sep = source.pdfPath.includes("?") ? "&" : "?";
    const pdf = await this.transport.request(`${PORTAL_ORIGIN}${source.pdfPath}${sep}v=${Date.now()}`, {
      allowLoginHtml: true,
    });
    const bytes = await readBytes(pdf);
    assertPdfBytes(bytes);
    return {
      ref,
      contentType: pdf.headers.get("content-type") || "application/pdf",
      filename: filenameFromContentDisposition(pdf.headers.get("content-disposition"), `clalit-${ref.source}.pdf`),
      bytes,
    };
  }

  /**
   * listRecords — one record source (diagnoses, sensitivities, chronic
   * medications, purchases, medication approvals, imaging, hospital visits
   * and labs, referrals): GET the page, POST its date-range search when it has
   * one (once per dropdown option for fan-out sources), walk the pager when
   * there is one, and otherwise split a full page by date as the document
   * grids are. Rows are kept as shown; refs only for rows the portal gives a
   * PDF action to.
   */
  async listRecords(sourceId: string, options: ListRecordsOptions = {}): Promise<RecordRow[]> {
    this.transport.assertNotIdleExpired();
    const source = recordSource(sourceId);
    if (!source) throw new ParseError("UNKNOWN_SOURCE", "Unknown record source.");
    if (source.kind === "referrals" || source.id === REFERRALS_SOURCE_ID) return this.#listReferrals(options);
    if (source.kind === "api") {
      const res = await this.transport.request(PORTAL_ORIGIN + source.api!, {
        headers: { accept: "application/json, text/plain, */*", ...(source.apiMethod === "POST" ? { "content-type": "application/json" } : {}) },
        ...(source.apiMethod === "POST" ? { method: "POST", body: source.apiBody ?? "null" } : {}),
      });
      return parseApiJson(await readText(res), source.id);
    }
    const url = PORTAL_ORIGIN + source.path;
    if (source.kind === "appointments") return parseAppointmentsHtml(await readText(await this.transport.request(url)));
    if (source.kind === "recommendations") return parseRecommendationsHtml(await readText(await this.transport.request(url)));
    const parse = (html: string) => parseRecordGridHtml(html, source.id);
    const page = await readText(await this.transport.request(url));
    const search = source.search;
    if (!search) return this.#walkRecordPager(url, source, page, {}, parse, options.onPage);

    const fanOut = search.fanOutSelect ? selectOptions(page, search.fanOutSelect) : [undefined];
    const from = options.fromDate ?? search.minDate;
    const to = options.toDate ?? todayPortalDate();
    const collected: RecordRow[] = [];
    const seen = new Set<string>();
    for (const option of fanOut) {
      const fixed = {
        ...search.fields,
        ...(option && search.fanOutSelect ? { [search.fanOutSelect]: option[0] } : {}),
      };
      // The hospital is the search, not a grid column; keep it with the row, and keep which search it was.
      const decorate = (row: RecordRow): RecordRow =>
        option && search.fanOutSelect
          ? { ...row, fields: { "בית חולים": option[1], ...row.fields }, cells: [option[1], ...row.cells], context: { select: search.fanOutSelect, value: option[0] } }
          : row;
      const onPage = options.onPage ? async (rows: RecordRow[]) => options.onPage!(rows.map(decorate)) : undefined;
      const searchOnce = async (rangeFrom: string, rangeTo: string): Promise<RecordRow[]> => {
        const fields = { ...fixed, [search.fromField]: rangeFrom, [search.toField]: rangeTo };
        const fresh = await readText(await this.transport.request(url));
        const state = extractWebFormsState(fresh);
        const cleanState = { ...state, hidden: omitFamilySliderFields(state.hidden) };
        const response = await this.transport.request(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: buildPostBackBody(cleanState, fields, search.submit, ""),
        });
        const html = await readText(response);
        return this.#walkRecordPager(url, source, html, fields, parse, onPage);
      };
      // A pager source is asked for its whole range at once (its pager is walked); when the portal answers its
      // own "temporary fault" for a range that wide, the range is halved until it answers.
      const rows = source.pagerLinkPrefix
        ? await searchSplittingOnFault(searchOnce, from, to)
        : await searchSplittingRows(searchOnce, from, to);
      for (const row of rows) {
        const key = JSON.stringify([row.cells, row.ref?.actionUrl ?? ""]);
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(decorate(row));
      }
    }
    return collected;
  }

  /** Follows a grid's pager links, re-posting the search fields each time. */
  async #walkRecordPager(
    url: string,
    source: NonNullable<ReturnType<typeof recordSource>>,
    firstHtml: string,
    fields: Record<string, string>,
    parse: (html: string) => RecordRow[],
    onPage?: (rows: RecordRow[]) => Promise<void>,
  ): Promise<RecordRow[]> {
    const rows = parse(firstHtml);
    if (onPage) await onPage(rows);
    let html = firstHtml;
    let current = 1;
    for (let pages = 1; pages < LABS_LIST_MAX_PAGES; pages++) {
      const next = nextRecordPagerPage(html, source, current);
      if (next === undefined) break;
      const state = extractWebFormsState(html);
      const cleanState = { ...state, hidden: omitFamilySliderFields(state.hidden) };
      const response = await this.transport.request(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: buildPostBackBody(cleanState, fields, `${source.pagerLinkPrefix}${next}`, ""),
      });
      html = await readText(response);
      const pageRows = parse(html);
      if (onPage) await onPage(pageRows);
      rows.push(...pageRows);
      current = next;
    }
    return rows;
  }

  /** Referrals: a repeater with its own "next" pager; the portal keeps the last year only. */
  async #listReferrals(options: ListRecordsOptions): Promise<RecordRow[]> {
    const source = recordSource(REFERRALS_SOURCE_ID)!;
    const search = source.search!;
    const url = PORTAL_ORIGIN + source.path;
    const page = await readText(await this.transport.request(url));
    const to = options.toDate ?? todayPortalDate();
    const from = options.fromDate ?? yearBeforePortalDate(to);
    const fields = { ...search.fields, [search.fromField]: from, [search.toField]: to };
    let state = extractWebFormsState(page);
    let response = await this.transport.request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: buildPostBackBody({ ...state, hidden: omitFamilySliderFields(state.hidden) }, fields, search.submit, ""),
    });
    let html = await readText(response);
    const rows = parseReferralsHtml(html);
    const seen = new Set(rows.map((r) => r.ref?.actionUrl ?? JSON.stringify(r.fields)));
    for (let pages = 1; pages < LABS_LIST_MAX_PAGES && referralsHaveNextPage(html); pages++) {
      state = extractWebFormsState(html);
      response = await this.transport.request(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: buildPostBackBody({ ...state, hidden: omitFamilySliderFields(state.hidden) }, fields, REFERRALS_NEXT_TARGET, ""),
      });
      html = await readText(response);
      let added = 0;
      for (const row of parseReferralsHtml(html)) {
        const key = row.ref?.actionUrl ?? JSON.stringify(row.fields);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
        added++;
      }
      if (added === 0) break;
    }
    return rows;
  }

  /**
   * getHospitalLabResult — a hospital lab row's result page
   * (HospitalsLabTestDetails.aspx?s&d&h), read with the clinic lab detail
   * parser: the page is the same control.
   *
   * The links the list hands out live only as long as that render of the list:
   * the portal re-issues them on every search and answers an old one with a
   * redirect. So, given the row's hospital (its `context`) and a way to tell
   * it apart (the test number, or its date and section), the hospital's
   * search is replayed, the pager walked until the row is found, and that
   * fresh link followed — as a person would: pick the hospital, show, open.
   * With a bare link and no row to match, the link is tried as is.
   */
  async getHospitalLabResult(
    row: { link?: string; context?: { select: string; value: string }; testNumber?: string; date?: string; section?: string },
  ): Promise<LabResultDetail> {
    this.transport.assertNotIdleExpired();
    const source = recordSource("hospital_labs")!;
    const search = source.search!;
    let link = row.link;
    if (row.context?.select && (row.testNumber || row.date)) {
      const listUrl = PORTAL_ORIGIN + source.path;
      const page = await readText(await this.transport.request(listUrl));
      const fields = {
        ...search.fields,
        [row.context.select]: row.context.value,
        [search.fromField]: search.minDate,
        [search.toField]: todayPortalDate(),
      };
      const state = extractWebFormsState(page);
      let html = await readText(
        await this.transport.request(listUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: buildPostBackBody({ ...state, hidden: omitFamilySliderFields(state.hidden) }, fields, search.submit, ""),
        }),
      );
      const matches = (r: RecordRow) =>
        (row.testNumber && Object.values(r.fields).includes(row.testNumber)) ||
        (!row.testNumber && row.date && r.date === row.date && (!row.section || Object.values(r.fields).includes(row.section)));
      let found = parseRecordGridHtml(html, source.id).find(matches);
      let current = 1;
      for (let pages = 1; !found && pages < LABS_LIST_MAX_PAGES; pages++) {
        const next = nextRecordPagerPage(html, source, current);
        if (next === undefined) break;
        const st = extractWebFormsState(html);
        html = await readText(
          await this.transport.request(listUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: buildPostBackBody({ ...st, hidden: omitFamilySliderFields(st.hidden) }, fields, `${source.pagerLinkPrefix}${next}`, ""),
          }),
        );
        current = next;
        found = parseRecordGridHtml(html, source.id).find(matches);
      }
      const fresh = found?.links?.find((l) => /HospitalsLabTestDetails\.aspx/i.test(l));
      if (!fresh) throw new UpstreamError("DETAIL_NOT_FOUND", 404);
      link = fresh;
    }
    if (!link) throw new ParseError("INVALID_REF", "A hospital lab result needs the row's link, or its hospital and test number.");
    const url = new URL(link, PORTAL_ORIGIN);
    if (url.origin !== PORTAL_ORIGIN || !/^\/OnlineWeb\/Services\/HospitalsLabs\/HospitalsLabTestDetails\.aspx$/i.test(url.pathname)) {
      throw new OwnerScopeError("Only a hospital lab result page linked from the owner's own list may be read.");
    }
    const s = url.searchParams.get("s") ?? "";
    const d = url.searchParams.get("d") ?? "";
    const h = url.searchParams.get("h") ?? "";
    if (!s || !d || !h) throw new ParseError("INVALID_REF", "Hospital lab link is missing its parameters.");
    const html = await readText(await this.transport.request(url.pathname + url.search, { allowLoginHtml: true }));
    if (/object\s+moved/i.test(html.slice(0, 2000)) || looksLikeLoginPage(html)) {
      throw new UpstreamError("DETAIL_REDIRECTED", 302);
    }
    return parseLabDetailHtml(html, { s, d, ls: h });
  }

  /**
   * getRecordDocument — GET (or POST, with the row's action data) the row's
   * action URL, which selects the document server-side, then GET the source's
   * PDF stream. Refs only from listRecords.
   */
  async getRecordDocument(refOrToken: RecordRef | string): Promise<RecordDocument> {
    this.transport.assertNotIdleExpired();
    const ref = decodeRecordRef(typeof refOrToken === "string" ? refOrToken : encodeRecordRef(refOrToken));
    const source = recordSource(ref.source)!;
    if (!source.pdfPath) throw new ParseError("NO_PDF_SOURCE", "This record source has no PDFs.");
    const exists = await this.transport.request(PORTAL_ORIGIN + ref.actionUrl, {
      allowLoginHtml: true,
      ...(ref.actionData
        ? { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: ref.actionData }
        : {}),
    });
    const peek = await exists.text();
    if (exists.status === 404 || /^\s*(false|0|null)\s*$/i.test(peek)) throw new UpstreamError("NO_DOCUMENT", exists.status);
    if (!exists.ok) throw new UpstreamError("DOCUMENT_CHECK_FAILED", exists.status);
    const sep = source.pdfPath.includes("?") ? "&" : "?";
    const pdf = await this.transport.request(`${PORTAL_ORIGIN}${source.pdfPath}${sep}v=${Date.now()}`, {
      allowLoginHtml: true,
    });
    const bytes = await readBytes(pdf);
    assertPdfBytes(bytes);
    return {
      ref,
      contentType: pdf.headers.get("content-type") || "application/pdf",
      filename: filenameFromContentDisposition(pdf.headers.get("content-disposition"), `clalit-${ref.source}.pdf`),
      bytes,
    };
  }
}

/**
 * The document grids show only their first page (10 rows, newest first) and
 * the pager is not walked, so a search that fills a page is split in two
 * halves until every half fits. Splitting stops at one day.
 */
export const DOCUMENT_PAGE_ROWS = 10;

async function searchSplitting(
  searchOnce: (from: string, to: string) => Promise<DocumentListItem[]>,
  from: string,
  to: string,
): Promise<DocumentListItem[]> {
  const rows = await searchOnce(from, to);
  const start = parsePortalDate(from);
  const end = parsePortalDate(to);
  if (rows.length < DOCUMENT_PAGE_ROWS || start === undefined || end === undefined || end <= start) return rows;
  const day = 86_400_000;
  const mid = start + Math.floor((end - start) / day / 2) * day;
  const older = await searchSplitting(searchOnce, from, formatPortalDate(mid));
  const newer = await searchSplitting(searchOnce, formatPortalDate(mid + day), to);
  return [...newer, ...older];
}

/** The same split, for record grids without a pager. */
async function searchSplittingRows(
  searchOnce: (from: string, to: string) => Promise<RecordRow[]>,
  from: string,
  to: string,
): Promise<RecordRow[]> {
  const rows = await searchOnce(from, to);
  const start = parsePortalDate(from);
  const end = parsePortalDate(to);
  if (rows.length < DOCUMENT_PAGE_ROWS || start === undefined || end === undefined || end <= start) return rows;
  const day = 86_400_000;
  const mid = start + Math.floor((end - start) / day / 2) * day;
  const older = await searchSplittingRows(searchOnce, from, formatPortalDate(mid));
  const newer = await searchSplittingRows(searchOnce, formatPortalDate(mid + day), to);
  return [...newer, ...older];
}

/** Halve a range the portal cannot answer at once (PORTAL_TEMPORARY_FAULT), down to about two months. */
async function searchSplittingOnFault(
  searchOnce: (from: string, to: string) => Promise<RecordRow[]>,
  from: string,
  to: string,
): Promise<RecordRow[]> {
  try {
    return await searchOnce(from, to);
  } catch (e) {
    const start = parsePortalDate(from);
    const end = parsePortalDate(to);
    const day = 86_400_000;
    if (!(e instanceof UpstreamError && e.code === "PORTAL_TEMPORARY_FAULT") || start === undefined || end === undefined || end - start < 60 * day) throw e;
    const mid = start + Math.floor((end - start) / day / 2) * day;
    const older = await searchSplittingOnFault(searchOnce, from, formatPortalDate(mid));
    const newer = await searchSplittingOnFault(searchOnce, formatPortalDate(mid + day), to);
    return [...newer, ...older];
  }
}

/** `dd.MM.yyyy` one year before the given portal date (the referrals page's whole range). */
function yearBeforePortalDate(to: string): string {
  const ms = parsePortalDate(to) ?? Date.now();
  const d = new Date(ms);
  return formatPortalDate(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate()));
}

function parsePortalDate(value: string): number | undefined {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  return m ? Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : undefined;
}

function formatPortalDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
}

function todayPortalDate(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

/** Explicit refusal helper for any future family-member API. */
export function refuseFamilySwitch(): never {
  throw new OwnerScopeError();
}
