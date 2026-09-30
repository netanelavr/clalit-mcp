import type { BrowserCookieSeed } from "@clalit/core";
import { PATHS, PORTAL_ORIGIN } from "@clalit/core";

const LOGIN_URL = `${PORTAL_ORIGIN}${PATHS.loginFoot}`;

/**
 * Warm Imperva / Glassbox cookies via Playwright (residential Mac).
 * Returns cookie seeds for the Node jar — never logs values.
 * Soft-fails (undefined) when Playwright is missing or the page is blocked.
 */
export async function warmPortalCookiesViaPlaywright(): Promise<BrowserCookieSeed[] | undefined> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return undefined;
  }

  let browser: import("playwright").Browser | undefined;
  try {
    try {
      browser = await chromium.launch({ headless: true, channel: "chrome" });
    } catch {
      browser = await chromium.launch({ headless: true });
    }
    const context = await browser.newContext({
      locale: "he-IL",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Allow Imperva / Glassbox scripts a brief moment to set Domain=.clalit.co.il cookies.
    await page.waitForTimeout(1500);
    const cookies = await context.cookies();
    const seeds: BrowserCookieSeed[] = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      httpOnly: c.httpOnly,
      secure: c.secure,
      ...(c.sameSite && c.sameSite !== "None"
        ? { sameSite: c.sameSite }
        : c.sameSite === "None"
          ? { sameSite: "None" as const }
          : {}),
      ...(typeof c.expires === "number" && c.expires > 0 ? { expires: c.expires } : {}),
    }));
    // Names only to stderr — never values.
    const names = [...new Set(seeds.map((s) => s.name))].sort();
    const defense = names.filter(
      (n) =>
        /^visid_incap_/i.test(n) ||
        /^incap_ses_/i.test(n) ||
        /^TS[0-9a-f]/i.test(n) ||
        /^_cls_/i.test(n),
    );
    if (defense.length === 0) {
      console.error(
        "Playwright cookie warm: no Imperva/TS cookies observed (page may be blocked). Continuing with Node jar only.",
      );
      return seeds.length ? seeds : undefined;
    }
    console.error(
      `Playwright cookie warm: seeded ${seeds.length} cookies (defense names: ${defense.join(", ")}).`,
    );
    return seeds;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "warm failed";
    console.error(`Playwright cookie warm skipped: ${msg}`);
    return undefined;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
