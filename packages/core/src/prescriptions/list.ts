import * as cheerio from "cheerio";
import { ParseError, ReauthenticationRequired } from "../errors.js";
import { looksLikeLoginPage, looksLikePrescriptionsListChrome } from "../webforms.js";
import type { PrescriptionListItem, PrescriptionMedicine } from "./types.js";

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function attrOpaque(value: string | undefined): string | undefined {
  const v = (value ?? "").trim();
  return v || undefined;
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
    const medicineStartDate =
      attrOpaque(node.attr("data-medicineStartDate")) ??
      attrOpaque(node.attr("data-medicinestartdate"));

    if (!prescriptionNo || !medicineId || !medicineFormName || !medicineStartDate) continue;

    const localName = cleanText(
      node.find("[id*='colMedicineName'], [id*='MedicineName']").first().text(),
    );

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
