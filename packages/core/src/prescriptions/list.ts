import * as cheerio from "cheerio";
import { ParseError, ReauthenticationRequired } from "../errors.js";
import { looksLikeLoginPage, looksLikePrescriptionsListChrome } from "../webforms.js";
import type { PrescriptionListItem, PrescriptionMedicine } from "./types.js";


/** Current page from hiddenPager / ActivePage (OnlinePagerContainer). */
export function currentPrescriptionPagerPage(html: string): number {
  const hidden =
    html.match(
      /name="ctl00\$ctl00\$cphBody\$bodyContent\$gridPager\$hiddenPager"[^>]*value="(\d+)"/i,
    ) ??
    html.match(
      /value="(\d+)"[^>]*name="ctl00\$ctl00\$cphBody\$bodyContent\$gridPager\$hiddenPager"/i,
    );
  if (hidden?.[1]) return Number(hidden[1]);
  const active = html.match(/class=['"][^'"]*ActivePage[^'"]*['"][^>]*>\s*(\d+)\s*</i);
  if (active?.[1]) return Number(active[1]);
  return 1;
}

/** Page numbers offered by PatientPrescriptionsex gridPager controls. */
export function listVisiblePrescriptionPagerPages(html: string): number[] {
  const pages = new Set<number>();
  pages.add(currentPrescriptionPagerPage(html));
  for (const match of html.matchAll(
    /__doPostBack\(\s*['"]ctl00\$ctl00\$cphBody\$bodyContent\$gridPager['"]\s*,\s*['"](\d+)['"]\s*\)/g,
  )) {
    pages.add(Number(match[1]));
  }
  for (const match of html.matchAll(
    /__doPostBack\(&#39;ctl00\$ctl00\$cphBody\$bodyContent\$gridPager&#39;\s*,\s*&#39;(\d+)&#39;\)/g,
  )) {
    pages.add(Number(match[1]));
  }
  for (const match of html.matchAll(
    /PatientPrescriptionsex\.aspx[^"'\s>]*[?&]page=(\d+)/gi,
  )) {
    pages.add(Number(match[1]));
  }
  for (const match of html.matchAll(
    /class=['"][^'"]*PagerNumberLink[^'"]*['"][^>]*>\s*(\d+)\s*</gi,
  )) {
    pages.add(Number(match[1]));
  }
  return [...pages].sort((a, b) => a - b);
}

/** Next pager page after `currentPage`, or undefined when this is the last page. */
export function nextPrescriptionPagerPage(
  html: string,
  currentPage: number,
): number | undefined {
  return listVisiblePrescriptionPagerPages(html).find((page) => page > currentPage);
}

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function attrOpaque(value: string | undefined): string | undefined {
  const v = (value ?? "").trim();
  return v || undefined;
}

/** Portal often appends a trailing ";" on data-medicineStartDate — strip it. */
function cleanPortalDate(value: string | undefined): string | undefined {
  const v = (value ?? "").trim().replace(/;+\s*$/g, "").trim();
  return v || undefined;
}

/**
 * Medicine display name lives under colMedicineName. Live HTML often places that
 * control as a sibling of the data-* panel (pnlMedicalDetails), not a descendant.
 */
function looksLikeMedicineNameLabel(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  // Portal chrome: colMedicineName often holds only the Hebrew label.
  return !t || /^שם התרופה:?$/.test(t);
}

/**
 * Live portal: colMedicineName is the label ("שם התרופה:"); the display name is
 * the sibling #colMedicineLink (or [id*='colMedicineLink']). Fixtures may still
 * put the name inside colMedicineName — accept either.
 */
function extractMedicineDisplayName(
  $: cheerio.CheerioAPI,
  node: ReturnType<typeof $>,
): string | undefined {
  const nameFromScope = (scope: ReturnType<typeof $>) => {
    const link = cleanText(
      scope.find("[id*='colMedicineLink'], [id$='colMedicineLink'], #colMedicineLink").first().text(),
    );
    if (link && !looksLikeMedicineNameLabel(link)) return link;

    const labeled = cleanText(
      scope.find("[id*='colMedicineName'], [id*='MedicineName']").first().text(),
    );
    if (labeled && !looksLikeMedicineNameLabel(labeled)) return labeled;
    return undefined;
  };

  const direct = nameFromScope(node);
  if (direct) return direct;

  const medicineRoot = node
    .parents("[id*='rptMedicine_ctl']")
    .filter((_, el) => {
      const id = $(el).attr("id") ?? "";
      return /rptMedicine_ctl\d+/i.test(id);
    })
    .first();
  if (medicineRoot.length) {
    const named = nameFromScope(medicineRoot);
    if (named) return named;
  }

  const parent = node.parent();
  if (parent.length) {
    const named = nameFromScope(parent);
    if (named) return named;
  }
  return undefined;
}

/**
 * Parse PatientPrescriptionsex.aspx HTML into own prescription rows.
 * Uses rptPatientPrescriptions → nested rptMedicine with data-* attrs only.
 */
export function parsePrescriptionsListHtml(html: string): PrescriptionListItem[] {
  const $ = cheerio.load(html);

  // Medicine nodes carrying portal-issued opaque ids.
  const medicineNodes = $("[data-prescription][data-medicineId], [data-prescription][data-medicineid]").toArray();

  // Also match case variants cheerio lowercases in HTML5 mode for data-* lookups.
  const nodes =
    medicineNodes.length > 0
      ? medicineNodes
      : $("[data-prescription]").filter((_, el) => {
          const a = $(el).attr("data-medicineId") ?? $(el).attr("data-medicineid");
          return Boolean(a && a.trim());
        }).toArray();

  if (nodes.length === 0) {
    if (looksLikeLoginPage(html)) {
      throw new ReauthenticationRequired();
    }
    if (looksLikePrescriptionsListChrome(html)) return [];
    throw new ParseError("PRESCRIPTIONS_LIST_SHAPE", "Prescriptions list repeaters not found.");
  }

  const byRx = new Map<string, PrescriptionListItem>();

  for (const el of nodes) {
    const node = $(el);
    const prescriptionNo = attrOpaque(node.attr("data-prescription"));
    const medicineId =
      attrOpaque(node.attr("data-medicineId")) ?? attrOpaque(node.attr("data-medicineid"));
    const medicineFormName =
      attrOpaque(node.attr("data-medicineFormName")) ??
      attrOpaque(node.attr("data-medicineformname"));
    const medicineStartDate = cleanPortalDate(
      attrOpaque(node.attr("data-medicineStartDate")) ??
        attrOpaque(node.attr("data-medicinestartdate")),
    );

    if (!prescriptionNo || !medicineId || !medicineFormName || !medicineStartDate) continue;

    const localName = extractMedicineDisplayName($, node);

    const medicine: PrescriptionMedicine = {
      medicineId,
      medicineFormName,
      medicineStartDate,
      ...(localName ? { medicineName: localName } : {}),
    };

    let item = byRx.get(prescriptionNo);
    if (!item) {
      // Walk up to prescription repeater (exclude nested rptMedicine self/ancestors).
      const rxRoot = node
        .parents("[id*='rptPatientPrescriptions_ctl']")
        .filter((_, el) => !/rptMedicine/i.test($(el).attr("id") ?? ""))
        .first();
      const scope = rxRoot.length ? rxRoot : node.parent();
      const prescriptionDisplayNo =
        cleanText(scope.find("[id*='colPrescriptionFullNo']").first().text()) || undefined;
      const prescriptionType =
        cleanText(scope.find("[id*='colPrescriptionType']").first().text()) || undefined;
      const prescriberName =
        cleanText(
          scope.find("[id*='colPrescriperName'], [id*='colPrescriberName']").first().text(),
        ) || undefined;

      item = {
        prescriptionNo,
        ...(prescriptionDisplayNo ? { prescriptionDisplayNo } : {}),
        ...(prescriptionType ? { prescriptionType } : {}),
        ...(prescriberName ? { prescriberName } : {}),
        medicines: [],
      };
      byRx.set(prescriptionNo, item);
    }

    // Dedupe identical medicine rows
    const dup = item.medicines.some(
      (m) =>
        m.medicineId === medicine.medicineId &&
        m.medicineFormName === medicine.medicineFormName &&
        m.medicineStartDate === medicine.medicineStartDate,
    );
    if (!dup) item.medicines.push(medicine);
  }

  const items = [...byRx.values()].filter((i) => i.medicines.length > 0);
  if (items.length === 0) {
    if (looksLikeLoginPage(html)) throw new ReauthenticationRequired();
    if (looksLikePrescriptionsListChrome(html)) return [];
    throw new ParseError("PRESCRIPTIONS_LIST_SHAPE", "Prescriptions list repeaters not found.");
  }
  return items;
}

/** Read hdnSectionID (or similar) for IssueDrugs sectionId — opaque portal value. */
export function extractPrescriptionSectionId(html: string): string | undefined {
  const $ = cheerio.load(html);
  const fromName =
    $('input[name$="hdnSectionID"], input[name*="hdnSectionID"]').attr("value")?.trim() ||
    $('input[id$="hdnSectionID"], input[id*="hdnSectionID"]').attr("value")?.trim();
  return fromName || undefined;
}
