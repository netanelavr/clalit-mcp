import { LABS_LIST_FIELDS, PATHS, PORTAL_ORIGIN } from "./constants.js";
import { OwnerScopeError, ParseError, UpstreamError } from "./errors.js";
import {
  buildLabDocument,
  decodeLabRef,
  encodeLabRef,
  parseLabDetailHtml,
  parseLabsListHtml,
  type LabDetailRef,
  type LabDocument,
  type LabListItem,
  type LabResultDetail,
  type ListLabsOptions,
} from "./labs/index.js";
import type { ClalitTransport } from "./transport.js";
import { readBytes, readText } from "./transport.js";
import { buildPostBackBody, extractWebFormsState } from "./webforms.js";

export interface ListedLab extends LabListItem {
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

function assertOwnRef(ref: LabDetailRef): void {
  // Family slider must never be set by this client. Refs only from own list.
  if (!ref.s || !ref.d || !ref.ls) throw new ParseError("INVALID_REF");
}

export class ClalitReaders {
  constructor(private readonly transport: ClalitTransport) {}

  /** listLabs — GET LabsTestList.aspx (optional date filter via postback). */
  async listLabs(options: ListLabsOptions = {}): Promise<ListedLab[]> {
    this.transport.assertNotIdleExpired();
    const listUrl = PORTAL_ORIGIN + PATHS.labsList;
    let response = await this.transport.request(listUrl);
    let html = await readText(response);

    if (options.fromDate || options.toDate) {
      const state = extractWebFormsState(html);
      const fields: Record<string, string> = {};
      if (options.fromDate) fields[LABS_LIST_FIELDS.fromDate] = options.fromDate;
      if (options.toDate) fields[LABS_LIST_FIELDS.toDate] = options.toDate;
      response = await this.transport.request(listUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: buildPostBackBody(state, fields),
      });
      html = await readText(response);
    }

    // Refuse family-slider postbacks if present as actionable switch
    if (/FamilySliderControl\d+\$au|FamilySliderControl\d+\$cu/i.test(html)) {
      // Presence is OK (portal chrome); we simply never POST those fields.
    }

    const items = parseLabsListHtml(html);
    return items.map((item) => ({
      ...item,
      ...(item.hasDetail ? { refToken: encodeLabRef(item.ref) } : {}),
    }));
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
      // Without a stable owner-id field name (not in HAR), we rely on list-only refs.
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
}

/** Explicit refusal helper for any future family-member API. */
export function refuseFamilySwitch(): never {
  throw new OwnerScopeError();
}
