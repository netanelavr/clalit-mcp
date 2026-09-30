/** Issue tracker for defects and feature requests. Security → SECURITY.md. */
export const ISSUES_URL = "https://github.com/netanelavr/clalit-mcp/issues";

/** Safe errors never retain upstream URLs, bodies, headers, or fetch error causes. */
export class ClalitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ReauthenticationRequired extends ClalitError {
  constructor(status?: number) {
    super("REAUTHENTICATION_REQUIRED", "Sign in to Clalit again.", status);
  }
}

/**
 * Copy for OTP_SESSION_INCOMPLETE. labs_login_redirect must not blame Imperva:
 * live dumps can already hold visid_incap_/incap_ses_/TS/_cls_ and still 302.
 */
export function otpSessionIncompleteMessage(
  reason: "missing_portal_defense_cookies" | "labs_login_redirect",
): string {
  if (reason === "labs_login_redirect") {
    return (
      "OTP finished but LabsTestList still redirects to login. " +
      "Imperva cookies are present; portal auth cookies (PostOtpAuth / AfterLogin) were not established, so the session was not saved."
    );
  }
  return (
    "OTP finished but the session jar is missing Imperva/TS cookies. " +
    "Session was not saved. Retry on your Mac; Playwright cookie warm runs automatically when available."
  );
}

const AUTH_MESSAGES: Record<string, string> = {
  INVALID_ID_FORMAT: "Enter a valid Israeli ID number (digits only).",
  INVALID_OTP_FORMAT: "Enter the SMS code (4–8 digits).",
  BOT_CHALLENGE:
    "Imperva blocked this host (often Error 16 on datacenter/cloud IPs). Run login on your Mac / home network. Never bypass Imperva.",
  CAPTCHA_REJECTED:
    "CAPTCHA was rejected by Clalit. Go back, refresh the image, and try again.",
  OTP_PAGE_MISSING:
    "Clalit did not open the SMS OTP step after CAPTCHA. The CAPTCHA may be wrong, or the portal response changed. Try again.",
  CAPTCHA_CHECK_TIMEOUT:
    "Checking CAPTCHA timed out. Clalit did not reach the SMS OTP step in time. Try again, or use terminal login: clalit-mcp login",
  AUTHENTICATION_FAILED: "Clalit sign-in did not complete. Check the login step and try again.",
  OTP_SESSION_INCOMPLETE: otpSessionIncompleteMessage("missing_portal_defense_cookies"),
};

export class AuthenticationError extends ClalitError {
  constructor(code = "AUTHENTICATION_FAILED", status?: number, message?: string) {
    super(code, message ?? AUTH_MESSAGES[code] ?? AUTH_MESSAGES.AUTHENTICATION_FAILED!, status);
  }
}

const UPSTREAM_MESSAGES: Record<string, string> = {
  TIMEOUT: "The Clalit request timed out (~30s). Try again on a stable network.",
  NETWORK_ERROR: "The Clalit request could not be completed (network error).",
  BOT_CHALLENGE:
    "Imperva blocked this host (often Error 16 on datacenter/cloud IPs). Never bypass Imperva.",
  RESPONSE_TOO_LARGE: "The Clalit response was too large to process.",
  UPSTREAM_ERROR: "The Clalit request could not be completed.",
};

export class UpstreamError extends ClalitError {
  constructor(code = "UPSTREAM_ERROR", status?: number, message?: string) {
    super(code, message ?? UPSTREAM_MESSAGES[code] ?? UPSTREAM_MESSAGES.UPSTREAM_ERROR!, status);
  }
}

export class ParseError extends ClalitError {
  constructor(code = "PARSE_ERROR", message = "Upstream HTML did not match the expected portal shape.") {
    super(code, message);
  }
}

export class OwnerScopeError extends ClalitError {
  constructor(message = "Refusing to follow a family/linked-member switch. Own-record only.") {
    super("OWNER_SCOPE", message);
  }
}
