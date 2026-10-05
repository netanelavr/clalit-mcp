import { connect, decodeLabOrderRef, decodeLabRef } from "@clalit/core";
import { writeFile } from "node:fs/promises";
import { help } from "./commands.js";
import { runLogin } from "./login.js";
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
    case "login":
      if (has(rest, "http")) {
        const portRaw = flag(rest, "port");
        const port = portRaw ? Number(portRaw) : undefined;
        if (portRaw && (!Number.isInteger(port) || port! < 0 || port! > 65535)) {
          console.error("Usage: clalit-mcp login --http [--id ID] [--port PORT] [--no-open]");
          return 2;
        }
        return runLoginHttp({
          idNumber: flag(rest, "id"),
          ...(port !== undefined ? { port } : {}),
          open: !has(rest, "no-open"),
        });
      }
      return runLogin(flag(rest, "id"));
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
            console.log(
              [a.name, a.result, a.units ?? "", a.referenceRange ?? "", a.flag ?? ""]
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
