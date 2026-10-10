// `ares connectors` — prove, list and monitor every connector.
//
//   ares connectors doctor [--json] [--only id,id] [--kind k,k] [--offline]
//                          [--timeout SEC] [--stdio-timeout SEC] [--concurrency N]
//                          [--no-configured] [--record]
//   ares connectors list   [--json]        the inventory, no probes
//   ares connectors clients list | set <service> <client_id> [secret] | clear <service>
//   ares connectors health [--run] [--json] [--only id]   last stored health (or re-check connected servers now)
//
// Exit: 0 clean, 1 when any connector is broken, 2 usage.

import { promises as fs } from "node:fs";
import { OAUTH_PROVIDERS, OFFICIAL_OAUTH_CLIENTS, forgetOAuthClient, listOAuthClients, saveOAuthClient, matrixFor, resolveConnectService } from "@ares/core";
import type { ParsedArgs } from "./args.js";
import { listInventory, renderDoctorText, runDoctor, type InventoryKind } from "../connectorsDoctor.js";
import { connectorHealthAll, recordDoctorReport, runConnectorHealthCheck } from "../connectorHealth.js";

function csv(v: string | undefined): string[] | undefined {
  if (!v || v === "true") return undefined;
  const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function secs(v: string | undefined): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined;
}

function intFlag(v: string | undefined): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

export async function connectorsCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "doctor";
  const json = args.flags.has("json");
  const out = (s: string): void => void process.stdout.write(s);

  if (sub === "list" || sub === "inventory") {
    const inv = await listInventory({ includeConfigured: !args.flags.has("no-configured") });
    if (json) out(JSON.stringify({ schema: "ares.connectors.inventory/1", count: inv.length, inventory: inv }, null, 2) + "\n");
    else for (const e of inv) out(`${e.kind.padEnd(15)} ${e.id.padEnd(34)} ${e.free.padEnd(13)} ${e.auth.padEnd(13)} ${e.launch.url ?? e.launch.command ?? e.launch.transport}\n`);
    return 0;
  }

  if (sub === "clients") {
    const action = args.positionals[1] ?? "list";
    const NL = "\n";
    const providerOf = (q: string | undefined): string | undefined => {
      if (!q) return undefined;
      const svc = resolveConnectService(q);
      return matrixFor(svc?.id ?? q)?.provider ?? svc?.oauthProvider ?? (OAUTH_PROVIDERS[q] ? q : svc?.id);
    };
    if (action === "list") {
      const providers = [...new Set([...Object.keys(OAUTH_PROVIDERS), ...Object.keys(OFFICIAL_OAUTH_CLIENTS)])].sort();
      const rows = await listOAuthClients(providers);
      for (const r of rows) out(`${r.provider.padEnd(14)} ${r.source.padEnd(9)} ${r.hasSecret ? "id+secret" : r.source === "none" ? "-" : "id only"}${NL}`);
      return 0;
    }
    const provider = providerOf(args.positionals[2]);
    if (!provider) { process.stderr.write("error: usage: ares connectors clients set <service> <client_id> [secret] | clear <service>" + NL); return 2; }
    if (action === "set") {
      const id = args.positionals[3];
      if (!id) { process.stderr.write("error: client_id required" + NL); return 2; }
      try { await saveOAuthClient(provider, { clientId: id, ...(args.positionals[4] ? { clientSecret: args.positionals[4] } : {}) }); } catch (e) { process.stderr.write(`error: ${(e as Error).message}${NL}`); return 2; }
      out(`stored client for ${provider} (encrypted vault)${NL}`);
      return 0;
    }
    if (action === "clear") { out((await forgetOAuthClient(provider)) ? `cleared ${provider}${NL}` : `nothing stored for ${provider}${NL}`); return 0; }
    process.stderr.write("error: clients subcommand is list | set | clear" + NL);
    return 2;
  }

  if (sub === "health") {
    if (args.flags.has("run")) {
      const file = await runConnectorHealthCheck({ force: true, ...(csv(args.flags.get("only")) ? { only: csv(args.flags.get("only"))! } : {}) });
      if (json) out(JSON.stringify(file, null, 2) + "\n");
      else out(`checked ${file.lastRun?.checked ?? 0} connected server(s) in ${file.lastRun?.ms ?? 0}ms\n`);
    }
    const all = await connectorHealthAll();
    if (json) out(JSON.stringify(all, null, 2) + "\n");
    else for (const h of Object.values(all)) out(`${h.state.padEnd(6)} ${h.id.padEnd(28)} ${h.detail}${h.stale ? "  (stale)" : ""}\n`);
    return Object.values(all).some((h) => h.state === "red") ? 1 : 0;
  }

  if (sub !== "doctor") {
    process.stderr.write(`error: unknown connectors subcommand "${sub}". Use doctor | list | health | clients.\n`);
    return 2;
  }

  const kinds = csv(args.flags.get("kind")) as InventoryKind[] | undefined;
  const report = await runDoctor({
    only: csv(args.flags.get("only")),
    kinds,
    offline: args.flags.has("offline"),
    timeoutMs: secs(args.flags.get("timeout")),
    stdioTimeoutMs: secs(args.flags.get("stdio-timeout")),
    concurrency: intFlag(args.flags.get("concurrency")),
    stdioConcurrency: intFlag(args.flags.get("stdio-concurrency")),
    includeConfigured: !args.flags.has("no-configured"),
    onResult: json || args.flags.has("quiet") ? undefined : (r) => process.stderr.write(`  ${r.verdict.padEnd(24)} ${r.id}\n`),
  });
  if (args.flags.has("record")) await recordDoctorReport(report).catch(() => undefined);
  const outFile = args.flags.get("out");
  if (outFile && outFile !== "true") await fs.writeFile(outFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  if (json) out(JSON.stringify(report, null, 2) + "\n");
  else out(renderDoctorText(report));
  return report.totals.byVerdict.broken > 0 ? 1 : 0;
}
