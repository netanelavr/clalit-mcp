/** Issue tracker for defects and feature requests. Security → SECURITY.md. */
export const ISSUES_URL = "https://github.com/netanelavr/clalit-health/issues";

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

export class AuthenticationError extends ClalitError {
  constructor(code = "AUTHENTICATION_FAILED", status?: number) {
    super(code, "Clalit sign-in did not complete. Check the login step and try again.", status);
  }
}

export class UpstreamError extends ClalitError {
  constructor(code = "UPSTREAM_ERROR", status?: number) {
    super(code, "The Clalit request could not be completed.", status);
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
