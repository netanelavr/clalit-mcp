import { PORTAL_ORIGIN } from "./constants.js";

/**
 * Find the BotDetect / CAPTCHA <img> on the login page and return an absolute URL.
 * Never invents a solver — the human reads the image.
 */
export function extractCaptchaImageUrl(pageHtml: string, baseOrigin = PORTAL_ORIGIN): string | undefined {
  // Prefer images whose src or nearby attributes mention captcha / BotDetect.
  const imgRe = /<img\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  const candidates: string[] = [];
  while ((match = imgRe.exec(pageHtml)) !== null) {
    const tag = match[0]!;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    const hint = `${tag} ${src}`.toLowerCase();
    if (
      hint.includes("captcha") ||
      hint.includes("botdetect") ||
      /bdc_/i.test(hint) ||
      src.toLowerCase().includes("get=image")
    ) {
      candidates.push(src);
    }
  }
  const raw = candidates[0];
  if (!raw) return undefined;
  const decoded = raw.replace(/&amp;/g, "&");
  try {
    return new URL(decoded, baseOrigin).href;
  } catch {
    return undefined;
  }
}


/** BotDetect instance-id field names like BDC_VCID_…captchaLogin (any input type). */
export function extractBotDetectFields(pageHtml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pageHtml)) !== null) {
    const tag = match[0]!;
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!name || !/^BDC_/i.test(name)) continue;
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    out[name] = value;
  }
  return out;
}

/**
 * Instance id for BotDetect image URL / form round-trip.
 * Prefer an explicit `d=` (or `i=`) query on the image URL; else a non-empty BDC_VCID value.
 */
export function resolveBotDetectInstanceId(
  pageHtml: string,
  captchaImageUrl?: string,
): string | undefined {
  for (const url of [captchaImageUrl].filter(Boolean) as string[]) {
    try {
      const u = new URL(url);
      const d = u.searchParams.get("d") ?? u.searchParams.get("i");
      if (d && d.trim()) return d.trim();
    } catch {
      /* ignore */
    }
  }
  const fields = extractBotDetectFields(pageHtml);
  for (const [name, value] of Object.entries(fields)) {
    if (/VCID/i.test(name) && value.trim()) return value.trim();
  }
  return undefined;
}

/** ASP.NET submit / image-button name=value pairs from the login form. */
export function extractSubmitFields(pageHtml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<(?:input|button)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pageHtml)) !== null) {
    const tag = match[0]!;
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!name) continue;
    const type = (/\btype\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "").toLowerCase();
    const isButton = /^button$/i.test(tag.slice(1, 7)) || type === "submit" || type === "image" || type === "button";
    if (!isButton) continue;
    if (type === "image") {
      out[`${name}.x`] = "0";
      out[`${name}.y`] = "0";
    } else {
      const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
      out[name] = value;
    }
  }
  return out;
}
