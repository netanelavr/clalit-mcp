import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  extractBotDetectFields,
  extractCaptchaImageUrl,
  extractLoginEventTarget,
  extractSubmitFields,
  resolveInputName,
} from "./captcha.js";

/** Same config-dir resolution as the CLI (never commit this directory). */
export function clalitConfigDir(): string {
  if (process.env.CLALIT_CONFIG_DIR) return process.env.CLALIT_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "clalit-mcp");
  return join(homedir(), ".config", "clalit-mcp");
}

export interface LoginFieldShape {
  tag: string;
  name?: string;
  id?: string;
  type: string;
  valueEmpty: boolean;
}

export interface CaptchaImageShape {
  path: string;
  queryKeys: string[];
  hasD: boolean;
  hasT: boolean;
  hasC: boolean;
  hasI: boolean;
}

export interface LoginHtmlShapeDump {
  fields: LoginFieldShape[];
  botDetectFields: Array<{ name: string; type: string; valueEmpty: boolean }>;
  submitButtons: LoginFieldShape[];
  eventTargets: string[];
  captchaImage?: CaptchaImageShape;
  resolved: {
    userIdField?: string;
    captchaField?: string;
    loginEventTarget?: string;
    botDetectVcidsEmpty: boolean;
  };
  htmlHints: {
    hasViewState: boolean;
    hasEventValidation: boolean;
    hasViewStateEncrypted: boolean;
    formActions: string[];
  };
}

const SENSITIVE_KEY =
  /(?:user|id|captcha|otp|password|viewstate|eventvalidation|cookie|token|secret|ssn|tz)/i;

/** Inventory login HTML without values (field names/types and captcha URL query keys only). */
export function summarizeLoginHtmlShape(pageHtml: string): LoginHtmlShapeDump {
  const fields: LoginFieldShape[] = [];
  const re = /<(input|button|select|textarea)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pageHtml)) !== null) {
    const tagName = match[1]!.toLowerCase();
    const tag = match[0]!;
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const type =
      (/\btype\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "").toLowerCase() || tagName;
    const rawValue = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    const valueEmpty = rawValue === undefined || rawValue.trim() === "";
    fields.push({
      tag: tagName,
      ...(name ? { name } : {}),
      ...(id ? { id } : {}),
      type,
      valueEmpty,
    });
  }

  const botDetectFields = fields
    .filter((f) => f.name && /^(?:BDC_|LBD_)/i.test(f.name))
    .map((f) => ({
      name: f.name!,
      type: f.type,
      valueEmpty: f.valueEmpty,
    }));

  const submitButtons = fields.filter((f) => {
    const isButton =
      f.tag === "button" || f.type === "submit" || f.type === "image" || f.type === "button";
    return isButton && Boolean(f.name);
  });

  const eventTargets = [
    ...pageHtml.matchAll(/WebForm_PostBackOptions\(\s*(?:&quot;|")([^"&]+)(?:&quot;|")/gi),
  ].map((m) => m[1]!);

  let captchaImage: CaptchaImageShape | undefined;
  const imageUrl = extractCaptchaImageUrl(pageHtml);
  if (imageUrl) {
    try {
      const u = new URL(imageUrl);
      captchaImage = {
        path: u.pathname,
        queryKeys: [...u.searchParams.keys()],
        hasD: u.searchParams.has("d"),
        hasT: u.searchParams.has("t"),
        hasC: u.searchParams.has("c"),
        hasI: u.searchParams.has("i"),
      };
    } catch {
      captchaImage = {
        path: "(unparseable)",
        queryKeys: [],
        hasD: false,
        hasT: false,
        hasC: false,
        hasI: false,
      };
    }
  }

  const extractedBd = extractBotDetectFields(pageHtml);
  const vcidEntries = Object.entries(extractedBd).filter(([n]) => /VCID/i.test(n));
  const botDetectVcidsEmpty =
    vcidEntries.length === 0 || vcidEntries.every(([, v]) => !String(v).trim());

  return {
    fields,
    botDetectFields,
    submitButtons,
    eventTargets,
    ...(captchaImage ? { captchaImage } : {}),
    resolved: {
      ...(resolveInputName(pageHtml, "tbUserId")
        ? { userIdField: resolveInputName(pageHtml, "tbUserId") }
        : {}),
      ...(resolveInputName(pageHtml, "tbCaptchaLogin")
        ? { captchaField: resolveInputName(pageHtml, "tbCaptchaLogin") }
        : {}),
      ...(extractLoginEventTarget(pageHtml)
        ? { loginEventTarget: extractLoginEventTarget(pageHtml) }
        : {}),
      botDetectVcidsEmpty,
    },
    htmlHints: {
      hasViewState: /name=["']__VIEWSTATE["']/i.test(pageHtml),
      hasEventValidation: /name=["']__EVENTVALIDATION["']/i.test(pageHtml),
      hasViewStateEncrypted: /name=["']__VIEWSTATEENCRYPTED["']/i.test(pageHtml),
      formActions: [...pageHtml.matchAll(/<form\b[^>]*\baction=["']([^"']*)["']/gi)].map(
        (m) => m[1]!,
      ),
    },
  };
}

/** POST body key list only; values are never retained. */
export function summarizePostBodyKeys(body: string): {
  keys: string[];
  sensitiveKeysRedacted: string[];
  submitKeys: string[];
  botDetectKeys: string[];
} {
  const params = new URLSearchParams(body);
  const keys = [...params.keys()];
  const sensitiveKeysRedacted = keys.filter((k) => SENSITIVE_KEY.test(k));
  const submitKeys = keys.filter(
    (k) => /btn|submit|\.x$|\.y$/i.test(k) || k === "__EVENTTARGET" || k === "__EVENTARGUMENT",
  );
  const botDetectKeys = keys.filter((k) => /^(?:BDC_|LBD_)/i.test(k));
  return { keys, sensitiveKeysRedacted, submitKeys, botDetectKeys };
}

/**
 * Best-effort redacted dump under ~/.config/clalit-mcp/ (mode 0600).
 * Never writes ID / captcha / viewstate values — keys and HTML shape only.
 */
export async function writeCaptchaRejectedDump(opts: {
  pageHtml: string;
  postBody: string;
  status?: number;
}): Promise<string | undefined> {
  try {
    const dir = clalitConfigDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `captcha-rejected-${stamp}.json`);
    const payload = {
      version: 1,
      reason: "CAPTCHA_REJECTED",
      at: new Date().toISOString(),
      ...(opts.status !== undefined ? { httpStatus: opts.status } : {}),
      loginHtmlShape: summarizeLoginHtmlShape(opts.pageHtml),
      // For comparison: what extractSubmitFields would have added (names only).
      extractSubmitFieldNames: Object.keys(extractSubmitFields(opts.pageHtml)),
      postBody: summarizePostBodyKeys(opts.postBody),
    };
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}
