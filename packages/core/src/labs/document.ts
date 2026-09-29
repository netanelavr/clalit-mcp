import { ParseError, UpstreamError } from "../errors.js";
import type { LabDetailRef, LabDocument } from "./types.js";

const PDF_MAGIC = Buffer.from("%PDF");

export function assertPdfBytes(bytes: Uint8Array): void {
  if (bytes.byteLength < 5 || !Buffer.from(bytes.subarray(0, 4)).equals(PDF_MAGIC)) {
    throw new UpstreamError("NOT_PDF");
  }
}

export function filenameFromContentDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const utf = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (utf?.[1]) {
    try {
      return decodeURIComponent(utf[1].trim().replace(/["']/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(header);
  if (plain?.[2]) return plain[2].trim();
  return fallback;
}

export function buildLabDocument(
  ref: LabDetailRef,
  bytes: Uint8Array,
  contentType: string,
  contentDisposition: string | null,
): LabDocument {
  if (!ref.s || !ref.d || !ref.ls) throw new ParseError("INVALID_REF");
  assertPdfBytes(bytes);
  return {
    ref,
    contentType: contentType || "application/pdf",
    filename: filenameFromContentDisposition(contentDisposition, `clalit-lab-${ref.d}.pdf`),
    bytes,
  };
}
