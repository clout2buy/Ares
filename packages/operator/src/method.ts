// The method ladder — "knowing how to do shit" (Ares v5 / O5 / concept C6).
//
// Every capability can be satisfied by multiple METHODS, ranked best→worst:
//   api → mcp → cli → skill → browser → (acquire)
// Ares never asks "should I use an MCP?" — it asks "what's the highest rung on
// this capability's ladder that's AVAILABLE right now?" and climbs down until
// one works. If nothing is available, it ACQUIRES a new rung (research →
// install an MCP / write a skill / scaffold a tool) and retries. MCP is not
// special; it's one rung. This is what makes Ares figure things out instead of
// following hardcoded paths.

import type { CapabilityNode, MethodKind, MethodRung } from "./capability.js";

/** Best (0) → most general/fragile (4). Browser works on anything but is slowest. */
export const METHOD_RANK: Record<MethodKind, number> = {
  api: 0,
  mcp: 1,
  cli: 2,
  skill: 3,
  browser: 4,
};

/** What the environment can tell us about which rungs are actually usable. */
export interface MethodEnvironment {
  hasApiKey(ref: string): boolean | Promise<boolean>;
  hasMcp(ref: string): boolean | Promise<boolean>;
  hasCli(ref: string): boolean | Promise<boolean>;
  hasSkill(ref: string): boolean | Promise<boolean>;
  browserAvailable(): boolean | Promise<boolean>;
}

export async function isAvailable(rung: MethodRung, env: MethodEnvironment): Promise<boolean> {
  switch (rung.kind) {
    case "api":
      return Boolean(await env.hasApiKey(rung.ref));
    case "mcp":
      return Boolean(await env.hasMcp(rung.ref));
    case "cli":
      return Boolean(await env.hasCli(rung.ref));
    case "skill":
      return Boolean(await env.hasSkill(rung.ref));
    case "browser":
      return Boolean(await env.browserAvailable());
    default:
      return false;
  }
}

export interface MethodResolution {
  /** Highest-ranked rung that is available right now, or null → must acquire. */
  chosen: MethodRung | null;
  /** Every available rung, best→worst — the fallback chain. */
  chain: MethodRung[];
  /** Rungs that exist on the ladder but aren't usable right now. */
  unavailable: MethodRung[];
}

/** Climb the ladder: pick the highest available rung, expose the fallback chain. */
export async function resolveMethod(rungs: readonly MethodRung[], env: MethodEnvironment): Promise<MethodResolution> {
  const sorted = [...rungs].sort((a, b) => METHOD_RANK[a.kind] - METHOD_RANK[b.kind]);
  const chain: MethodRung[] = [];
  const unavailable: MethodRung[] = [];
  for (const rung of sorted) {
    if (await isAvailable(rung, env)) chain.push(rung);
    else unavailable.push(rung);
  }
  return { chosen: chain[0] ?? null, chain, unavailable };
}

export interface AcquireDeps {
  env: MethodEnvironment;
  /** Study how this capability could be done → candidate rungs (the seed skill). */
  research?: (capability: CapabilityNode) => Promise<MethodRung[]>;
  /** Make a candidate actually available (install an MCP, write a skill, …). */
  install?: (rung: MethodRung) => Promise<boolean>;
}

export interface AcquireResult {
  rung: MethodRung | null;
  rungs: MethodRung[];
}

/**
 * The floor of the ladder isn't "give up" — it's "acquire a method". Research
 * candidate rungs, try to install them best-first, and return the first one
 * that becomes genuinely available. The new ladder is returned so the caller
 * can persist it on the capability and retry resolveMethod().
 */
export async function acquireMethod(capability: CapabilityNode, deps: AcquireDeps): Promise<AcquireResult> {
  const candidates = deps.research ? await deps.research(capability) : [];
  const ordered = [...candidates].sort((a, b) => METHOD_RANK[a.kind] - METHOD_RANK[b.kind]);
  for (const candidate of ordered) {
    const installed = deps.install ? await deps.install(candidate) : false;
    if (installed && (await isAvailable(candidate, deps.env))) {
      const rungs = [...(capability.methods ?? []).filter((m) => !(m.kind === candidate.kind && m.ref === candidate.ref)), candidate];
      return { rung: candidate, rungs };
    }
  }
  return { rung: null, rungs: capability.methods ?? [] };
}
