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
