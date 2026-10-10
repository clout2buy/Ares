// Connect-hub verifiers for the local stdio catalog (core/mcpStdioCatalog.ts).
//
// "Connected" for a stdio server means it was LAUNCHED with the owner's values
// and answered tools/list. On success the verifier registers it in
// ~/.ares/mcp.json (secrets go to the vault via the hub's `store`, never the
// file) and hands back the typed values plus the marker credential that makes
// the service read as connected.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MCP_STDIO_CATALOG,
  installStdioConnector,
  renderStaticEnv,
  renderStdioArgs,
  resolveStdioValues,
  stdioFieldCredential,
  stdioMarkerCredential,
  type McpStdioEntry,
} from "@ares/core";
import type { VerifyOutcome } from "./connectVerifiersLife.js";
import { probeStdioServer } from "./mcpProbe.js";

type Verify = (values: Record<string, string>, signal: AbortSignal) => Promise<VerifyOutcome>;

export function stdioVerifier(entry: McpStdioEntry, home?: string): Verify {
  return async (credValues) => {
    // The form posts values keyed by credential name; the entry works in field names.
    const byName: Record<string, string> = {};
    for (const f of entry.fields ?? []) byName[f.name] = (credValues[stdioFieldCredential(entry, f)] ?? "").trim();
    const { env, envVault, missing } = resolveStdioValues(entry, byName);
    if (missing.length) throw new Error(`${missing.join(", ")} is required`);

    for (const f of entry.fields ?? []) {
      if (!("arg" in f.target) || f.secret || !byName[f.name]) continue;
      // A path argument must exist (or, for a database file, its folder must).
      const v = byName[f.name]!;
      if (path.isAbsolute(v) || v.startsWith("~")) {
        const p = v.startsWith("~") ? path.join(os.homedir(), v.slice(1)) : v;
        const target = entry.id === "sqlite" ? path.dirname(p) : p;
        const st = await fs.stat(target).catch(() => null);
        if (!st?.isDirectory()) throw new Error(`${target} is not a folder on this machine`);
      } else {
        throw new Error(`${f.label} must be an absolute path`);
      }
    }

    // Probe with the REAL values (secrets included) so a bad token that the
    // server validates at startup is caught now; evidence is scrubbed.
    const scratchHome = home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
    const secretEnv: Record<string, string> = { ...renderStaticEnv(entry, { aresHome: scratchHome }), ...env };
    if (entry.staticEnv) await fs.mkdir(path.join(scratchHome, "mcp-data"), { recursive: true });
    for (const f of entry.fields ?? []) {
      if ("env" in f.target && f.secret && byName[f.name]) secretEnv[f.target.env] = byName[f.name]!;
    }
    const args = entry.args.map((a) =>
      a.replace(/\{([a-z0-9-]+)\}/gi, (_m, k: string) => {
        const field = (entry.fields ?? []).find((x) => "arg" in x.target && x.target.arg === k);
        return field ? byName[field.name] ?? "" : "";
      }),
    );
    void envVault;
    void renderStdioArgs;
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ares-stdio-verify-"));
    try {
      const secrets = (entry.fields ?? []).filter((f) => f.secret).map((f) => byName[f.name] ?? "");
      const probe = await probeStdioServer(
        { command: entry.command, args, env: secretEnv },
        { scratchDir: scratch, timeoutMs: entry.coldStartMs ?? 75_000, secrets, keepHome: true },
      );
      if (!probe.ok) {
        const why = probe.error ?? "it did not start";
        throw new Error(`${entry.name} didn't start: ${why}`);
      }
      await installStdioConnector(entry, byName, home);
      return {
        detail: `${entry.name} is running locally — ${probe.toolCount ?? 0} tool${probe.toolCount === 1 ? "" : "s"}.`,
        store: { ...credValues, [stdioMarkerCredential(entry.id)]: new Date().toISOString() },
      };
    } finally {
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export function stdioVerifiers(home?: string): Record<string, Verify> {
  return Object.fromEntries(MCP_STDIO_CATALOG.map((e) => [e.id, stdioVerifier(e, home)]));
}
