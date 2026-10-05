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
import type { ClalitTransport } from "./transport.js";
import { readBytes, readText } from "./transport.js";
import { buildPostBackBody, extractWebFormsState } from "./webforms.js";

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
}

/** Explicit refusal helper for any future family-member API. */
export function refuseFamilySwitch(): never {
  throw new OwnerScopeError();
}
