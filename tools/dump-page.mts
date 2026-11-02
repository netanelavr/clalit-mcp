/**
 * Save the HTML the portal answers for a page — after its date-range search
 * when it has one, and once more after the first grid row's own postback
 * (a detail view) — so a reader can be written against what the portal
 * actually sends. Also fetches a React page's script bundles and lists the
 * API paths they contain.
 *
 *   npx tsx tools/dump-page.mts --out DIR --source hospital_labs
 *   npx tsx tools/dump-page.mts --out DIR --path /OnlineWeb/Services/Measures/Measures.aspx
 *   npx tsx tools/dump-page.mts --out DIR --path /OnlineWeb/Services/Vaccinations/Vaccinations.aspx --scripts
 *
 * DIR holds your record and must stay private. The terminal shows only
 * statuses, sizes and (with --scripts) the API paths found.
 */
import * as cheerio from "cheerio";
import { connect, extractWebFormsState, buildPostBackBody, PORTAL_ORIGIN, recordSource, selectOptions } from "@clalit/core";
import { loadSession } from "@clalit/cli/store";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = flag("out");
const sourceId = flag("source");
const pathArg = flag("path");
if (!out || (!sourceId && !pathArg)) {
  console.error("Usage: npx tsx tools/dump-page.mts --out DIR (--source ID | --path /OnlineWeb/...aspx) [--scripts]");
  process.exit(2);
}
const session = await loadSession();
if (!session) {
  console.error("Not signed in.");
  process.exit(3);
}
const client = await connect(session);
const transport = (client as unknown as { transport: { request(url: string, init?: object): Promise<Response> } }).transport;
await mkdir(out, { recursive: true, mode: 0o700 });

const save = async (name: string, body: string): Promise<void> => {
  await writeFile(join(out, name.replace(/[^\w.-]+/g, "_")), body, { mode: 0o600 });
};
const get = async (path: string): Promise<{ res: Response; text: string }> => {
  const res = await transport.request(PORTAL_ORIGIN + path, { allowLoginHtml: true });
  const text = await res.text();
  console.error(`GET ${path}: ${res.status} ${text.length}B`);
  return { res, text };
};
const post = async (path: string, html: string, fields: Record<string, string>, target: string): Promise<string> => {
  const state = extractWebFormsState(html);
  const hidden = Object.fromEntries(Object.entries(state.hidden).filter(([k]) => !/FamilySlider/i.test(k)));
  const res = await transport.request(PORTAL_ORIGIN + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: buildPostBackBody({ ...state, hidden }, fields, target, ""),
    allowLoginHtml: true,
  });
  const text = await res.text();
  console.error(`POST ${path} → ${target.split("$").slice(-2).join("$")}: ${res.status} ${text.length}B`);
  return text;
};

/** The first grid row's own postback (a "show" link), if the page has one. */
function firstRowPostback(html: string): string | undefined {
  const $ = cheerio.load(html);
  let found: string | undefined;
  $("tr.ClalitGridRow a[href*='__doPostBack'], tr.ClalitGridAltRow a[href*='__doPostBack']").each((_, a) => {
    if (found) return;
    const m = /__doPostBack\((?:&#39;|&apos;|'|")([^'"&]+)/.exec($(a).attr("href") ?? "");
    if (m) found = m[1]!;
  });
  return found;
}

/** The first grid row's own same-origin page link (a detail page), as a portal path. */
function firstRowLink(html: string, pagePath: string): string | undefined {
  const $ = cheerio.load(html);
  let found: string | undefined;
  $("tr.ClalitGridRow a[href], tr.ClalitGridAltRow a[href]").each((_, a) => {
    if (found) return;
    const href = $(a).attr("href") ?? "";
    if (/^\s*javascript:/i.test(href)) return;
    try {
      const url = new URL(href, PORTAL_ORIGIN + pagePath);
      if (url.origin === PORTAL_ORIGIN && /\.aspx$/i.test(url.pathname)) found = url.pathname + url.search;
    } catch {
      /* not a link */
    }
  });
  return found;
}

const today = (() => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
})();

if (sourceId) {
  const source = recordSource(sourceId);
  if (!source) {
    console.error("Unknown source.");
    process.exit(2);
  }
  const page = await get(source.path);
  await save(`${source.id}.get.html`, page.text);
  if (source.search) {
    const s = source.search;
    const options = s.fanOutSelect ? selectOptions(page.text, s.fanOutSelect) : [undefined];
    let shown = 0;
    for (const option of options) {
      const fields = {
        ...s.fields,
        ...(option && s.fanOutSelect ? { [s.fanOutSelect]: option[0] } : {}),
        [s.fromField]: s.minDate || "01.01.2000",
        [s.toField]: today,
      };
      const fresh = await get(source.path);
      const result = await post(source.path, fresh.text, fields, s.submit);
      const rows = cheerio.load(result)("tr.ClalitGridRow, tr.ClalitGridAltRow").length;
      console.error(`  ${option ? option[1] : "all"}: ${rows} grid rows`);
      if (rows === 0 && shown > 0) continue;
      await save(`${source.id}.search${option ? "." + option[0] : ""}.html`, result);
      shown++;
      const target = firstRowPostback(result);
      if (target && rows > 0) {
        const detail = await post(source.path, result, fields, target);
        await save(`${source.id}.detail${option ? "." + option[0] : ""}.html`, detail);
      }
      const link = firstRowLink(result, source.path);
      if (link && rows > 0) {
        const detail = await get(link);
        await save(`${source.id}.linked${option ? "." + option[0] : ""}.html`, detail.text);
      }
      if (rows > 0 && shown >= 2) break;
    }
  } else {
    const target = firstRowPostback(page.text);
    if (target) await save(`${source.id}.detail.html`, await post(source.path, page.text, {}, target));
  }
} else if (pathArg) {
  const page = await get(pathArg);
  await save(`${pathArg.replace(/^\/OnlineWeb\//i, "")}.html`, page.text);
  if (args.includes("--scripts")) {
    const $ = cheerio.load(page.text);
    const scripts = $("script[src]")
      .map((_, el) => $(el).attr("src") ?? "")
      .get()
      .filter((src) => !/jquery|bootstrap|slick|dhtml|Common\.js|Clalit\.js|mainmenu|FamilySlider|Notification|Validation|CheckUser|GlobalFetch/i.test(src));
    const api = new Set<string>();
    for (const src of scripts) {
      const path = src.startsWith("/") ? src : new URL(src, PORTAL_ORIGIN + pathArg).pathname + new URL(src, PORTAL_ORIGIN + pathArg).search;
      try {
        const { text } = await get(path);
        await save(`${path.replace(/^\/OnlineWeb\//i, "").replace(/\?.*$/, "")}.txt`, text);
        for (const m of text.matchAll(/["'`](\/[Oo]nline[Ww]eb\/api\/[^"'`\s?]+)/g)) api.add(m[1]!);
        for (const m of text.matchAll(/["'`](api\/[\w/]+)/g)) api.add("/OnlineWeb/" + m[1]!);
      } catch (err) {
        console.error(`  ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.error(`API paths in the bundles: ${[...api].sort().join(", ") || "none found"}`);
  }
}
console.error(`Saved under ${out} (private).`);
