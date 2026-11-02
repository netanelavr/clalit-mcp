/**
 * Try the portal's download flow for the first row of a record source and
 * report only what each step answered (status, content type, size, PDF or
 * not) — never the content. For working out a source's `pdfPath`.
 *
 *   npx tsx tools/probe-record-pdf.mts --source imaging_clinics [--candidates a.ashx,b.aspx]
 */
import { connect, PORTAL_ORIGIN, recordSource } from "@clalit/core";
import { loadSession } from "@clalit/cli/store";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const sourceId = flag("source");
const source = sourceId ? recordSource(sourceId) : undefined;
if (!source) {
  console.error("Usage: npx tsx tools/probe-record-pdf.mts --source ID [--candidates path,path]");
  process.exit(2);
}
const session = await loadSession();
if (!session) {
  console.error("Not signed in.");
  process.exit(3);
}
const client = await connect(session);
const transport = (client as unknown as { transport: { request(url: string, init?: object): Promise<Response> } }).transport;

const describe = async (label: string, res: Response): Promise<string> => {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const head = Buffer.from(bytes.slice(0, 5)).toString("latin1");
  const text = head.startsWith("%PDF") ? "" : Buffer.from(bytes.slice(0, 120)).toString("utf8").replace(/\s+/g, " ");
  const kind = head.startsWith("%PDF") ? "PDF" : /html/i.test(res.headers.get("content-type") ?? "") ? "html" : text.length < 60 ? `text:${text}` : "other";
  return `${label}: ${res.status} ${res.headers.get("content-type") ?? "-"} ${bytes.length}B ${kind}`;
};

const rows = await client.listRecords(source.id);
const row = rows.find((r) => r.ref);
if (!row?.ref) {
  console.error(`${source.id}: ${rows.length} rows, none with a PDF action.`);
  process.exit(0);
}
console.error(`${source.id}: ${rows.length} rows; probing the first row's action (${row.ref.actionUrl.replace(/\d{4,}/g, "N")})`);
const action = await transport.request(PORTAL_ORIGIN + row.ref.actionUrl, { allowLoginHtml: true });
console.error(await describe("action GET", action));

const dir = source.path.replace(/\/[^/]*$/, "");
const candidates = (flag("candidates")?.split(",") ?? [])
  .concat(source.pdfPath ? [source.pdfPath] : [])
  .concat(source.pdfPath ? [source.pdfPath.replace(/Print=false/i, "Print=true")] : [])
  .concat([`${dir}/RentgenView.aspx`]);
for (const path of [...new Set(candidates)]) {
  try {
    const res = await transport.request(`${PORTAL_ORIGIN}${path}${path.includes("?") ? "&" : "?"}v=${Date.now()}`, { allowLoginHtml: true });
    console.error(await describe(`GET ${path}`, res));
  } catch (err) {
    console.error(`GET ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
