import {
  connect,
  decodeDocumentRef,
  decodeRecordRef,
  decodeLabOrderRef,
  decodeLabRef,
  documentSource,
  DOCUMENT_SOURCE_IDS,
  recordSource,
  RECORD_SOURCE_IDS,
  exportAll,
  exportName,
  ReauthenticationRequired,
} from "@clalit/core";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { help } from "./commands.js";
import { runBrowserLogin } from "./browser-login.js";
import { folderSink } from "./export-sink.js";
import { runLoginHttp } from "./http-login.js";
import { clearSession, loadSession } from "./store.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--")) return args[i + 1];
  return undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

async function requireClient() {
  const session = await loadSession();
  if (!session) {
    console.error("Not signed in. Run: clalit-mcp login");
    return undefined;
  }
  return connect(session);
}

export async function runCli(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(help(rest[0]));
    return 0;
  }

  switch (cmd) {
    case "login": {
      if (has(rest, "browser")) {
        const url = flag(rest, "url");
        return runBrowserLogin({
          ...(url ? { url } : {}),
          record: has(rest, "record"),
          keepOpen: has(rest, "keep-open"),
        });
      }
      // --http is a harmless no-op alias (loopback login is the default mode).
      const portRaw = flag(rest, "port");
      const port = portRaw ? Number(portRaw) : undefined;
      if (portRaw && (!Number.isInteger(port) || port! < 0 || port! > 65535)) {
        console.error("Usage: clalit-mcp login [--id ID] [--port PORT] [--no-open] | login --browser [--record] [--url URL] [--keep-open]");
        return 2;
      }
      return runLoginHttp({
        idNumber: flag(rest, "id"),
        ...(port !== undefined ? { port } : {}),
        open: !has(rest, "no-open"),
      });
    }
    case "logout":
      await clearSession();
      console.log("Local session deleted.");
      return 0;
    case "labs": {
      const client = await requireClient();
      if (!client) return 3;
      try {
        const data = await client.listLabs({
          fromDate: flag(rest, "from"),
          toDate: flag(rest, "to"),
        });
        if (has(rest, "json")) console.log(JSON.stringify({ data }, null, 2));
        else {
          for (const row of data) {
            const token = row.refToken ?? "";
            console.log(`${row.date}\t${row.name}\t${row.summary ?? ""}\t${token}`);
          }
        }
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "labs failed");
        return 1;
      }
    }
    case "lab": {
      const ref = flag(rest, "ref");
      if (!ref) {
        console.error("Usage: clalit-mcp lab --ref TOKEN");
        return 2;
      }
      const client = await requireClient();
      if (!client) return 3;
      try {
        const data = await client.getLabResult(ref);
        if (has(rest, "json")) console.log(JSON.stringify({ data }, null, 2));
        else {
          console.log(data.title);
          if (data.date) console.log(data.date);
          for (const a of data.analytes) {
            // The result already carries its unit ("13.5 g/dL"), so print units only when it is missing.
            const units = a.units && !a.result.endsWith(a.units) ? a.units : "";
            console.log(
              [a.name, a.result, units, a.referenceRange ?? "", a.flag ?? ""]
                .filter(Boolean)
                .join("\t"),
            );
          }
          for (const n of data.notes) console.log(n);
          if (data.hasDocument) console.log("(document available — use lab-document)");
        }
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "lab failed");
        return 1;
      }
    }
    case "lab-document": {
      const ref = flag(rest, "ref");
      const out = flag(rest, "out");
      if (!ref || !out) {
        console.error("Usage: clalit-mcp lab-document --ref TOKEN --out FILE");
        return 2;
      }
      // Validate token early for clearer errors
      decodeLabRef(ref);
      const client = await requireClient();
      if (!client) return 3;
      try {
        const doc = await client.getLabDocument(ref);
        await writeFile(out, doc.bytes);
        console.log(`Wrote ${out} (${doc.filename}, ${doc.bytes.byteLength} bytes)`);
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "lab-document failed");
        return 1;
      }
    }
    case "prescriptions": {
      const client = await requireClient();
      if (!client) return 3;
      try {
        const data = await client.listPrescriptions({
          fromDate: flag(rest, "from"),
          toDate: flag(rest, "to"),
          includeExpired: has(rest, "include-expired"),
        });
        if (has(rest, "json")) console.log(JSON.stringify({ data }, null, 2));
        else {
          for (const row of data) {
            const meds = row.medicines
              .map((m) => m.medicineName ?? m.medicineId)
              .join(", ");
            console.log(
              `${row.prescriptionDisplayNo ?? row.prescriptionNo}\t${row.prescriberName ?? ""}\t${meds}`,
            );
          }
        }
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "prescriptions failed");
        return 1;
      }
    }
    case "prescription-status": {
      const prescriptionNo = flag(rest, "prescription");
      const medicationID = flag(rest, "medication");
      const medicationFormName = flag(rest, "form");
      const medicationStartDate = flag(rest, "start");
      const sectionId = flag(rest, "section");
      if (!prescriptionNo || !medicationID || !medicationFormName || !medicationStartDate || !sectionId) {
        console.error(
          "Usage: clalit-mcp prescription-status --prescription NO --medication ID --form NAME --start DATE --section ID",
        );
        return 2;
      }
      const client = await requireClient();
      if (!client) return 3;
      try {
        const data = await client.getPrescriptionIssueStatus({
          prescriptionNo,
          medicationID,
          medicationFormName,
          medicationStartDate,
          sectionId,
        });
        if (has(rest, "json")) console.log(JSON.stringify({ data }, null, 2));
        else console.log(`${data.statusCode}\t${data.statusDesc}`);
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "prescription-status failed");
        return 1;
      }
    }
    case "lab-orders": {
      const client = await requireClient();
      if (!client) return 3;
      try {
        const data = await client.listLabOrders();
        if (has(rest, "json")) console.log(JSON.stringify({ data }, null, 2));
        else {
          for (const row of data) {
            const token = row.refToken ?? "";
            console.log(
              `${row.issuanceDate ?? ""}\t${row.referer ?? ""}\t${row.validTo ?? ""}\t${row.section ?? ""}\t${token}`,
            );
          }
        }
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "lab-orders failed");
        return 1;
      }
    }
    case "lab-order": {
      const ref = flag(rest, "ref");
      if (!ref) {
        console.error("Usage: clalit-mcp lab-order --ref TOKEN");
        return 2;
      }
      decodeLabOrderRef(ref);
      const client = await requireClient();
      if (!client) return 3;
      try {
        const data = await client.getLabOrder(ref);
        if (has(rest, "json")) console.log(JSON.stringify({ data }, null, 2));
        else {
          if (data.title) console.log(data.title);
          if (data.validFrom || data.validTo) {
            console.log(`valid: ${data.validFrom ?? "?"} → ${data.validTo ?? "?"}`);
          }
          for (const item of data.items) {
            console.log([item.section ?? "", item.testName ?? ""].filter(Boolean).join("\t"));
          }
        }
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "lab-order failed");
        return 1;
      }
    }
    case "documents": {
      const source = flag(rest, "source");
      if (!source || !documentSource(source)) {
        console.error(`Usage: clalit-mcp documents --source (${DOCUMENT_SOURCE_IDS.join("|")}) [--from dd.MM.yyyy] [--to dd.MM.yyyy] [--json]`);
        return 2;
      }
      const client = await requireClient();
      if (!client) return 3;
      try {
        const data = await client.listDocuments(source, { fromDate: flag(rest, "from"), toDate: flag(rest, "to") });
        if (has(rest, "json")) console.log(JSON.stringify({ data }, null, 2));
        else for (const row of data) console.log(`${row.date ?? ""}\t${row.details.join("\t")}\t${row.refToken}`);
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "documents failed");
        return 1;
      }
    }
    case "document": {
      const ref = flag(rest, "ref");
      const out = flag(rest, "out");
      if (!ref || !out) {
        console.error("Usage: clalit-mcp document --ref TOKEN --out FILE");
        return 2;
      }
      decodeDocumentRef(ref);
      const client = await requireClient();
      if (!client) return 3;
      try {
        const doc = await client.getDocument(ref);
        await writeFile(out, doc.bytes);
        console.log(`Wrote ${out} (${doc.bytes.byteLength} bytes)`);
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "document failed");
        return 1;
      }
    }
    case "records": {
      const source = flag(rest, "source");
      if (!source || !recordSource(source)) {
        console.error(`Usage: clalit-mcp records --source (${RECORD_SOURCE_IDS.join("|")}) [--from dd.MM.yyyy] [--to dd.MM.yyyy] [--json]`);
        return 2;
      }
      const client = await requireClient();
      if (!client) return 3;
      try {
        const data = await client.listRecords(source, { fromDate: flag(rest, "from"), toDate: flag(rest, "to") });
        if (has(rest, "json")) console.log(JSON.stringify({ data }, null, 2));
        else for (const row of data) console.log([...row.cells, row.refToken ?? ""].join("\t"));
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "records failed");
        return 1;
      }
    }
    case "record-document": {
      const ref = flag(rest, "ref");
      const out = flag(rest, "out");
      if (!ref || !out) {
        console.error("Usage: clalit-mcp record-document --ref TOKEN --out FILE");
        return 2;
      }
      decodeRecordRef(ref);
      const client = await requireClient();
      if (!client) return 3;
      try {
        const doc = await client.getRecordDocument(ref);
        await writeFile(out, doc.bytes);
        console.log(`Wrote ${out} (${doc.bytes.byteLength} bytes)`);
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "record-document failed");
        return 1;
      }
    }
    case "hospital-lab-result": {
      const link = flag(rest, "link");
      if (!link && !(flag(rest, "hospital") && (flag(rest, "test") || flag(rest, "date")))) {
        console.error("Usage: clalit-mcp hospital-lab-result (--link PATH | --hospital VALUE --test NUMBER) [--date dd.MM.yyyy] [--json]   (from a `records --source hospital_labs --json` row: its links, context.value and מספר הבדיקה)");
        return 2;
      }
      const client = await requireClient();
      if (!client) return 3;
      try {
        const hospital = flag(rest, "hospital");
        const data = await client.getHospitalLabResult({
          link,
          ...(hospital ? { context: { select: "ctl00$ctl00$cphBody$bodyContent$LabsHistory1$ddlHospitalName", value: hospital } } : {}),
          testNumber: flag(rest, "test"),
          date: flag(rest, "date"),
        });
        if (has(rest, "json")) console.log(JSON.stringify({ data }, null, 2));
        else {
          console.log(data.title);
          if (data.date) console.log(data.date);
          for (const a of data.analytes) {
            const units = a.units && !a.result.endsWith(a.units) ? a.units : "";
            console.log([a.name, a.result, units, a.referenceRange ?? "", a.flag ?? ""].filter(Boolean).join("\t"));
          }
        }
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "hospital-lab-result failed");
        return 1;
      }
    }
    case "export": {
      const client = await requireClient();
      if (!client) return 3;
      const dir = join(resolve(flag(rest, "out") ?? "."), exportName(Date.now()));
      try {
        const report = await exportAll(client, folderSink(dir), {
          fromDate: flag(rest, "from"),
          toDate: flag(rest, "to"),
          documents: !has(rest, "no-documents"),
          includeExpired: !has(rest, "current-only"),
          ...(flag(rest, "only") ? { only: flag(rest, "only")!.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
          log: (line) => console.log(line),
        });
        const width = Math.max(0, ...Object.keys(report.folders).map((k) => k.length));
        for (const [folder, n] of Object.entries(report.folders).sort()) console.log(`  ${folder.padEnd(width)}  ${String(n).padStart(4)} ${n === 1 ? "file" : "files"}`);
        for (const p of report.problems) console.log(`  problem: ${p.where}: ${p.what}`);
        console.log(`${report.problems.length ? report.problems.length + " problems; " : ""}export in ${dir}`);
        return report.stopped ? 3 : 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "export failed");
        return 1;
      }
    }
    case "keep-alive": {
      // Hold the session open from a second terminal while the first one works (export, sitemap, …).
      const everyRaw = flag(rest, "every");
      const everyMin = everyRaw ? Number(everyRaw) : 4;
      if (!Number.isFinite(everyMin) || everyMin < 1 || everyMin > 9) {
        console.error("Usage: clalit-mcp keep-alive [--every MINUTES]   (1–9; the portal drops a session after ~10 idle minutes)");
        return 2;
      }
      const client = await requireClient();
      if (!client) return 3;
      const { saveSession } = await import("./store.js");
      let stop = false;
      process.once("SIGINT", () => {
        stop = true;
      });
      console.error(`Keeping the Clalit session alive every ${everyMin} min; Ctrl-C to stop.`);
      while (!stop) {
        try {
          await client.refreshSession();
          await client.checkSession();
          await saveSession(await client.exportSession());
          console.error(`${new Date().toLocaleTimeString("en-GB")} alive`);
        } catch (err) {
          console.error(err instanceof Error ? err.message : "keep-alive failed");
          if (err instanceof ReauthenticationRequired) return 3;
        }
        await new Promise<void>((r) => {
          const t = setTimeout(r, everyMin * 60_000);
          process.once("SIGINT", () => {
            clearTimeout(t);
            r();
          });
        });
      }
      console.error("Stopped; the session itself is left as it is.");
      return 0;
    }
    case "refresh-session": {
      const client = await requireClient();
      if (!client) return 3;
      try {
        await client.refreshSession();
        const session = await client.exportSession();
        const { saveSession } = await import("./store.js");
        await saveSession(session);
        console.log("RefreshSession.aspx OK; session file updated.");
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : "refresh failed");
        return 1;
      }
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.log(help());
      return 2;
  }
}
