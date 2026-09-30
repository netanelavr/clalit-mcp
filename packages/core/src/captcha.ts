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
      /bdc_|lbd_/i.test(hint) ||
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

/**
 * Resolve the ASP.NET UniqueID (`name`) for a control client id.
 * Live Clalit uses id="tbUserId" with name="ctl00$cphBody$tbUserId".
 */
export function resolveInputName(pageHtml: string, clientId: string): string | undefined {
  const re = /<input\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  let byExactName: string | undefined;
  let byId: string | undefined;
  let bySuffix: string | undefined;
  while ((match = re.exec(pageHtml)) !== null) {
    const tag = match[0]!;
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!name) continue;
    if (name === clientId) byExactName = name;
    if (id === clientId) byId = name;
    if (name.endsWith(`$${clientId}`)) bySuffix = name;
  }
  // Prefer id match (UniqueID + client id), then exact name, then $suffix.
  return byId ?? byExactName ?? bySuffix;
}

/** BotDetect instance-id fields: BDC_* (older) or LBD_* (current Libre BotDetect). */
export function extractBotDetectFields(pageHtml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pageHtml)) !== null) {
    const tag = match[0]!;
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!name || !/^(?:BDC_|LBD_)/i.test(name)) continue;
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    out[name] = value;
  }
  return out;
}

/**
 * Instance id for BotDetect form round-trip.
 * Prefer a non-empty BDC_/LBD_ VCID already in the HTML. Only fall back to image
 * query `d` or `i` — never `t=`, which Libre BotDetect uses as a cache-buster and
 * must not overwrite LBD_VCID (that caused live CAPTCHA_REJECTED after correct reads).
 */
export function resolveBotDetectInstanceId(
  pageHtml: string,
  captchaImageUrl?: string,
): string | undefined {
  const fields = extractBotDetectFields(pageHtml);
  for (const [name, value] of Object.entries(fields)) {
    if (/VCID/i.test(name) && value.trim()) return value.trim();
  }
  for (const url of [captchaImageUrl].filter(Boolean) as string[]) {
    try {
      const u = new URL(url);
      const id = u.searchParams.get("d") ?? u.searchParams.get("i");
      if (id && id.trim()) return id.trim();
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * ASP.NET LinkButton / PostBackOptions target for the primary login action.
 * Live Clalit: ctl00$cphBody$btnSendOTP (not a type=submit input).
 */
export function extractLoginEventTarget(pageHtml: string): string | undefined {
  const targets = [
    ...pageHtml.matchAll(/WebForm_PostBackOptions\(\s*(?:&quot;|")([^"&]+)(?:&quot;|")/gi),
  ].map((m) => m[1]!);

  const sendOtp = targets.find(
    (t) => /btnSendOTP$/i.test(t) && !/Voice/i.test(t) && !/VoiceOTP/i.test(t),
  );
  if (sendOtp) return sendOtp;

  const loginBtn = targets.find((t) => /btnLogin$/i.test(t) || /\$btnLogin$/i.test(t));
  if (loginBtn) return loginBtn;

  // Fallback: visible LinkButton id → UniqueID ($ separators).
  const idMatch =
    /\bid\s*=\s*["']([^"']*btnSendOTP)["']/i.exec(pageHtml) ??
    /\bid\s*=\s*["']([^"']*btnLogin)["']/i.exec(pageHtml);
  if (idMatch?.[1] && !/Voice/i.test(idMatch[1])) {
    return idMatch[1].replace(/_/g, "$");
  }

  return undefined;
}

/**
 * ASP.NET submit / image-button name=value pairs from the login form.
 * Skips hidden modal chrome (e.g. BottomMenuModalDialog) that is not the login action.
 */
export function extractSubmitFields(pageHtml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<(?:input|button)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pageHtml)) !== null) {
    const tag = match[0]!;
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!name) continue;
    if (/BottomMenuModalDialog|ModalDialog|HelpDialog/i.test(name)) continue;
    const type = (/\btype\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "").toLowerCase();
    const style = /\bstyle\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    if (/display\s*:\s*none/i.test(style)) continue;
    const isButton =
      /^button$/i.test(tag.slice(1, 7)) || type === "submit" || type === "image" || type === "button";
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
