// Cold-start capability seeding.
//
// A fresh Operator graph should not claim Ares has zero capability when the
// harness already gives it a real body. These native nodes are not learned by
// the acquisition loop; they are the verified floor the loop builds on.

import { addMethod, createCapability, type CapabilityNode, type MethodRung } from "./capability.js";
import { loadCapability, saveCapability } from "./graphStore.js";

export interface NativeCapabilitySeed {
  id: string;
  name: string;
  methods: MethodRung[];
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
