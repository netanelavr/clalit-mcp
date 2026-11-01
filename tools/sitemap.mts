/**
 * Walk the signed-in portal read-only and record which pages exist for this
 * account and what each one is made of — so new readers can be built from
 * evidence instead of guesses.
 *
 *   npx tsx tools/sitemap.mts --out DIR [--max 120] [--raw]
 *
 * Starts from the portal's home pages and follows same-origin links to
 * `*.aspx` pages under /OnlineWeb, GET only, paced. It never follows sign-out,
 * family-member switching, download handlers (`.ashx`), API paths or
 * `__doPostBack` links, and never submits a form.
 *
 * Writes DIR/sitemap.json: for each page its path, title, headings, nav
 * links, forms (field names and types, never values), dropdowns (option
 * count and labels) and grid headers — a value-free map that is safe to share.
 * With --raw it also keeps every page's HTML under DIR/raw/ for building
 * parsers; that folder holds your record and must stay private.
 */
import { connect, PORTAL_ORIGIN } from "@clalit/core";
import { loadSession } from "@clalit/cli/store";
import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const out = flag("out");
if (!out) {
  console.error("Usage: npx tsx tools/sitemap.mts --out DIR [--max 120] [--raw]");
  process.exit(2);
}
const max = Number(flag("max") ?? 120);
const keepRaw = has("raw");

const SEEDS = [
  "/OnlineWeb/Services/FamilyHomePage.aspx",
  "/OnlineWeb/General/PersonalDetails.aspx",
  "/OnlineWeb/Services/Labs/LabsTestList.aspx",
  "/OnlineWeb/Services/Medicine/PatientPrescriptionsex.aspx",
  "/OnlineWeb/Services/LabOrders/LabOrderList.aspx",
  "/OnlineWeb/Services/VisitSummaries/VisitSummaries.aspx",
  "/OnlineWeb/Services/SummaryLetter/SummaryLetter.aspx",
  "/OnlineWeb/Services/MedicalApproval/MedicalApproval.aspx",
  "/OnlineWeb/Services/Form17/Form17.aspx",
];

/** Links we never follow: anything that changes who is signed in or what is selected. */
const SKIP = /logout|logoff|signout|sign-out|exitsystem|familyslider|changeuser|switchuser|\.ashx|\/api\/|__dopostback|javascript:|mailto:|tel:|refreshsession|otpsms|infootplogin|login\.aspx/i;

interface PageShape {
  path: string;
  status: number;
  title: string;
  headings: string[];
  links: string[];
  forms: Array<{ action: string; fields: Array<{ name: string; type: string }> }>;
  selects: Array<{ name: string; options: number; labels: string[] }>;
  grids: Array<{ id: string; headers: string[]; rows: number }>;
  postBackTargets: string[];
  bytes: number;
}

function normalize(href: string, from: string): string | undefined {
  try {
    const url = new URL(href, PORTAL_ORIGIN + from);
    if (url.origin !== PORTAL_ORIGIN) return undefined;
    if (!/^\/onlineweb\/.*\.aspx$/i.test(url.pathname)) return undefined;
    if (SKIP.test(url.pathname + url.search)) return undefined;
    // Query strings carry record ids; the page itself is what we map.
    return url.pathname;
  } catch {
    return undefined;
  }
}

function shape(path: string, status: number, html: string): PageShape {
  const $ = cheerio.load(html);
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const links = new Set<string>();
  $("a[href]").each((_, a) => {
    const p = normalize($(a).attr("href") ?? "", path);
    if (p) links.add(p);
  });
  const forms = $("form")
    .map((_, f) => ({
      action: $(f).attr("action") ?? "",
      fields: $(f)
        .find("input,select,textarea")
        .map((_, el) => ({ name: $(el).attr("name") ?? "", type: $(el).attr("type") ?? el.tagName }))
        .get()
        .filter((x) => x.name && !/^__(VIEWSTATE|EVENTVALIDATION|VIEWSTATEGENERATOR|EVENTTARGET|EVENTARGUMENT|PREVIOUSPAGE)/.test(x.name)),
    }))
    .get();
  const selects = $("select")
    .map((_, s) => ({
      name: $(s).attr("name") ?? "",
      options: $(s).find("option").length,
      labels: $(s)
        .find("option")
        .map((_, o) => clean($(o).text()))
        .get()
        .slice(0, 40),
    }))
    .get();
  const grids = $("table")
    .map((_, t) => ({
      id: $(t).attr("id") ?? "",
      headers: $(t)
        .find("th")
        .map((_, th) => clean($(th).text()))
        .get(),
      rows: $(t).find("tr").length,
    }))
    .get()
    .filter((g) => g.headers.length > 0 || g.id);
  const postBackTargets = new Set<string>();
  const re = /__doPostBack\((?:&#39;|&apos;|'|")([^'"&]+)/g;
  for (const m of html.matchAll(re)) postBackTargets.add(m[1]!);
  return {
    path,
    status,
    title: clean($("title").first().text()),
    headings: $("h1,h2,h3")
      .map((_, h) => clean($(h).text()))
      .get()
      .filter(Boolean)
      .slice(0, 30),
    links: [...links].sort(),
    forms,
    selects,
    grids,
    postBackTargets: [...postBackTargets].sort(),
    bytes: html.length,
  };
}

const session = await loadSession();
if (!session) {
  console.error("Not signed in: run `login` first (CLALIT_CONFIG_DIR respected).");
  process.exit(3);
}
const client = await connect(session);
const transport = (client as unknown as { transport: { request(url: string, init?: object): Promise<Response> } }).transport;

await mkdir(out, { recursive: true });
if (keepRaw) await mkdir(join(out, "raw"), { recursive: true, mode: 0o700 });

const queue = [...SEEDS];
const seen = new Set<string>(SEEDS.map((p) => p.toLowerCase()));
const pages: PageShape[] = [];
const errors: Array<{ path: string; error: string }> = [];

while (queue.length && pages.length + errors.length < max) {
  const path = queue.shift()!;
  try {
    const res = await transport.request(PORTAL_ORIGIN + path, { allowLoginHtml: true });
    const html = await res.text();
    const location = res.headers.get("location") ?? "";
    if ((res.status === 301 || res.status === 302) && /login|otp|infootp/i.test(location)) {
      console.error(`${res.status} ${path} → ${location}\nThe Clalit session has ended (it idles out after ~10 minutes). Sign in again, keep it alive with \`keep-alive\` in a second terminal, and rerun.`);
      process.exit(3);
    }
    const s = shape(path, res.status, html);
    pages.push(s);
    if (keepRaw) {
      const file = path.replace(/^\/OnlineWeb\//i, "").replace(/[^\w.-]+/g, "_") + ".html";
      await writeFile(join(out, "raw", file), html, { mode: 0o600 });
    }
    for (const l of s.links) {
      if (!seen.has(l.toLowerCase())) {
        seen.add(l.toLowerCase());
        queue.push(l);
      }
    }
    console.error(`${res.status} ${path}  (${s.grids.length} grids, ${s.forms.reduce((n, f) => n + f.fields.length, 0)} fields, ${s.links.length} links)`);
    await new Promise((r) => setTimeout(r, 400));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ path, error: message });
    console.error(`ERR ${path}: ${message}`);
    if (/sign in|session|Reauthentication/i.test(message) && errors.length > 3) break;
  }
}

await writeFile(
  join(out, "sitemap.json"),
  JSON.stringify({ origin: PORTAL_ORIGIN, mappedAt: new Date().toISOString(), pages, notVisited: queue, errors }, null, 2),
);
console.error(`\n${pages.length} pages mapped, ${errors.length} errors, ${queue.length} not visited (--max ${max}). Written to ${out}/sitemap.json${keepRaw ? " and raw/" : ""}.`);
