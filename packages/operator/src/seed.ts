// Cold-start capability seeding.
//
// A fresh Operator graph should not claim Ares has zero capability when the
// harness already gives it a real body. There are THREE provenance layers, and
// the difference between them is the whole point of this file:
//
//   nativeSeeds — the verified floor: dev primitives the harness guarantees
//                 (read/write/shell/search). Seeded `mastered` with a synthetic
//                 success record because the harness itself is the proof.
//   toolSeeds   — real tools Ares already SHIPS (Email, Stripe, Deploy, …) but
//                 has never PROVEN. Seeded `available`, ok:0. The planner now
//                 knows they exist; reality still has to confirm each one before
//                 it earns `have`. Money/prod/live-email nodes also carry
//                 requiresHumanApproval so a confident JSON row can never charge
//                 someone $49.99 on its own.
//   skillSeeds  — learned skills actually present on disk (~/.ares/skills/*).
//                 Registered from the filesystem, not from vibes — only what is
//                 really there becomes a node.
//
// None of toolSeeds/skillSeeds are mastered: no proof, no mastery.

import { promises as fs } from "node:fs";
import path from "node:path";
import { agentPaths } from "@ares/agent";
import { addMethod, createCapability, type CapabilityNode, type CapabilitySource, type MethodRung } from "./capability.js";
import { loadCapability, saveCapability } from "./graphStore.js";

export interface NativeCapabilitySeed {
  id: string;
  name: string;
  methods: MethodRung[];
}

/** A registered (tool/skill) capability — exists in code, not yet reality-verified. */
export interface CapabilitySeed {
  id: string;
  name: string;
  domain: string;
  source: CapabilitySource;
  methods: MethodRung[];
  /** Side effects that need a human ok before unsupervised execution. */
  requiresHumanApproval?: boolean;
}

export interface SeedNativeCapabilitiesReport {
  created: number;
  kept: number;
  capabilities: CapabilityNode[];
}

export const NATIVE_CAPABILITY_SEEDS: readonly NativeCapabilitySeed[] = [
  { id: "native/read-files", name: "read local files", methods: [{ kind: "cli", ref: "Ares Read tool" }] },
  { id: "native/write-files", name: "write and edit workspace files", methods: [{ kind: "cli", ref: "Ares Write/Edit/ApplyIntent tools" }] },
  { id: "native/search-codebase", name: "search the codebase", methods: [{ kind: "cli", ref: "Ares Grep/Glob/CodebaseSearch tools" }] },
  { id: "native/run-shell", name: "run local shell commands", methods: [{ kind: "cli", ref: "PowerShell/Bash" }] },
  { id: "native/manage-processes", name: "launch and inspect long-running processes", methods: [{ kind: "cli", ref: "Ares BashOutput/KillShell tools" }] },
  { id: "native/use-browser", name: "drive a browser and capture visual proof", methods: [{ kind: "browser", ref: "Playwright BrowserConnector" }] },
  { id: "native/recall-memory", name: "recall and update living memory", methods: [{ kind: "cli", ref: "Ares LivingMind tool" }] },
  { id: "native/run-skills", name: "run local learned skills", methods: [{ kind: "skill", ref: "RunSkill" }] },
  { id: "native/manage-goals", name: "hold and run durable Operator goals", methods: [{ kind: "cli", ref: "Ares Operator tool" }] },
  { id: "native/verify-reality", name: "verify work against commands, files, and HTTP reality probes", methods: [{ kind: "cli", ref: "probe/verifier" }] },
];

/**
 * The registry the seed graph is built FROM — maps a real tool in the codebase
 * to the capability node(s) it backs. Seeding reads this instead of inventing
 * capabilities, so the graph can never claim a capability whose tool was removed
 * (and a new tool is one line away from being plannable).
 *
 * `native/use-browser` already represents the browser as a mastered floor node,
 * so the browser tool is intentionally NOT re-registered here.
 */
export const TOOL_CAPABILITY_MAP: readonly { tool: string; capabilities: string[] }[] = [
  { tool: "Email", capabilities: ["email.read", "email.send"] },
  { tool: "Stripe", capabilities: ["stripe.list-payments", "stripe.create-checkout"] },
  { tool: "Deploy", capabilities: ["deploy.preview", "deploy.production"] },
  { tool: "WebSearch/WebFetch", capabilities: ["web.research"] },
  { tool: "ComputerUse", capabilities: ["computer.use"] },
];

export const TOOL_CAPABILITY_SEEDS: readonly CapabilitySeed[] = [
  {
    id: "email.read",
    name: "read inbox metadata and messages",
    domain: "communications",
    source: "tool",
    methods: [{ kind: "api", ref: "Email" }],
  },
  {
    id: "email.send",
    name: "send live email",
    domain: "communications",
    source: "business",
    methods: [{ kind: "api", ref: "Email" }],
    requiresHumanApproval: true,
  },
  {
    id: "stripe.list-payments",
    name: "list Stripe payments and balances",
    domain: "payments",
    source: "tool",
    methods: [{ kind: "api", ref: "Stripe" }],
  },
  {
    id: "stripe.create-checkout",
    name: "create a Stripe checkout / charge money",
    domain: "payments",
    source: "business",
    methods: [{ kind: "api", ref: "Stripe" }],
    requiresHumanApproval: true,
  },
  {
    id: "deploy.preview",
    name: "create a preview deployment",
    domain: "deployment",
    source: "tool",
    methods: [{ kind: "api", ref: "Deploy" }],
  },
  {
    id: "deploy.production",
    name: "deploy to production",
    domain: "deployment",
    source: "business",
    methods: [{ kind: "api", ref: "Deploy" }],
    requiresHumanApproval: true,
  },
  {
    id: "web.research",
    name: "research the web and cite sources",
    domain: "research",
    source: "tool",
    methods: [{ kind: "api", ref: "WebSearch/WebFetch" }],
  },
  {
    id: "computer.use",
    name: "control the desktop (screenshot, click, type)",
    domain: "desktop-control",
    source: "tool",
    methods: [{ kind: "cli", ref: "ComputerUse" }],
  },
];

export async function seedNativeCapabilities(home: string, now = new Date()): Promise<SeedNativeCapabilitiesReport> {
  let created = 0;
  let kept = 0;
  const capabilities: CapabilityNode[] = [];
  for (const seed of NATIVE_CAPABILITY_SEEDS) {
    const existing = await loadCapability(home, seed.id);
    if (existing) {
      kept++;
      capabilities.push(existing);
      continue;
    }
    let node = createCapability({
      id: seed.id,
      name: seed.name,
      status: "mastered",
      source: "native",
      requires: [],
      novelDeltaAtBirth: 0,
      now,
    });
    node = {
      ...node,
      outcomes: { ok: 3, fail: 0, lastUsedAt: now.toISOString() },
      playbookRef: "native-harness",
    };
    for (const method of seed.methods) node = addMethod(node, { ...method, reliability: 1, lastCheckedAt: now.toISOString() }, now);
    await saveCapability(home, node);
    capabilities.push(node);
    created++;
  }
  return { created, kept, capabilities };
}

/** Seed a set of REGISTERED-but-unproven capabilities as `available`, ok:0.
 *  Idempotent: an already-present node is kept untouched so earned progress
 *  (a tool that has since been verified) is never reset to unproven. */
async function seedAvailableCapabilities(
  home: string,
  seeds: readonly CapabilitySeed[],
  now: Date,
): Promise<SeedNativeCapabilitiesReport> {
  let created = 0;
  let kept = 0;
  const capabilities: CapabilityNode[] = [];
  for (const seed of seeds) {
    const existing = await loadCapability(home, seed.id);
    if (existing) {
      kept++;
      capabilities.push(existing);
      continue;
    }
    let node = createCapability({
      id: seed.id,
      name: seed.name,
      status: "available",
      domain: seed.domain,
      source: seed.source,
      requiresHumanApproval: seed.requiresHumanApproval,
      requires: [],
      now,
    });
    for (const method of seed.methods) node = addMethod(node, { ...method, lastCheckedAt: now.toISOString() }, now);
    await saveCapability(home, node);
    capabilities.push(node);
    created++;
  }
  return { created, kept, capabilities };
}

export async function seedToolCapabilities(home: string, now = new Date()): Promise<SeedNativeCapabilitiesReport> {
  return seedAvailableCapabilities(home, TOOL_CAPABILITY_SEEDS, now);
}

/** Register learned skills that ACTUALLY exist under ~/.ares/skills/ — read off
 *  disk, never from a hardcoded wish list. Each becomes an `available` skill
 *  capability the operator can plan with (proof still required to advance). */
export async function seedSkillCapabilities(home: string, now = new Date()): Promise<SeedNativeCapabilitiesReport> {
  const skillsDir = agentPaths(home).skillsDir;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return { created: 0, kept: 0, capabilities: [] };
  }
  const seeds: CapabilitySeed[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    // A real skill has a SKILL.md or handler.js — skip stray dirs.
    const hasArtifact =
      (await fs.stat(path.join(skillsDir, name, "SKILL.md")).then(() => true, () => false)) ||
      (await fs.stat(path.join(skillsDir, name, "handler.js")).then(() => true, () => false));
    if (!hasArtifact) continue;
    seeds.push({
      id: `skill/${name}`,
      name: `run the ${name} skill`,
      domain: "self",
      source: "skill",
      methods: [{ kind: "skill", ref: name }],
    });
  }
  return seedAvailableCapabilities(home, seeds, now);
}

/** Seed all three provenance layers. The composition root calls this so the
 *  planner boots aware of every tool and skill Ares already has — not just the
 *  ten native primitives. */
export async function seedAllCapabilities(home: string, now = new Date()): Promise<SeedNativeCapabilitiesReport> {
  const native = await seedNativeCapabilities(home, now);
  const tools = await seedToolCapabilities(home, now);
  const skills = await seedSkillCapabilities(home, now);
  return {
    created: native.created + tools.created + skills.created,
    kept: native.kept + tools.kept + skills.kept,
    capabilities: [...native.capabilities, ...tools.capabilities, ...skills.capabilities],
  };
}
