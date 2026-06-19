// Verifies the operator capability-graph remediation (register existing tools
// and skills as durable nodes):
//   1. Native seeds still load as the mastered floor (ok:3).
//   2. Tool capabilities seed `available`/ok:0 — NEVER mastered just for existing.
//   3. Money / prod / live-email capabilities carry requiresHumanApproval.
//   4. The tool→capability registry and the seeds stay in lockstep.
//   5. Skills are registered from DISK, not a wish list (no artifact → no node).
//   6. Seeding is idempotent and never resets earned progress.
//   7. A verified success is the only door from `available` → `have`.
//   8. CAPABILITIES.md is GENERATED from the graph and is free of dead ~/.crix paths.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  seedNativeCapabilities,
  seedToolCapabilities,
  seedSkillCapabilities,
  seedAllCapabilities,
  listCapabilities,
  loadCapability,
  saveCapability,
  recordOutcome,
  renderCapabilitiesDoc,
  writeCapabilitiesDoc,
  TOOL_CAPABILITY_SEEDS,
  TOOL_CAPABILITY_MAP,
} from "../packages/operator/dist/index.js";

async function freshHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-v36-"));
  process.env.ARES_HOME = home;
  return home;
}

// ── 1. native floor unchanged ────────────────────────────────────────────────

test("seed: native primitives still seed as the mastered floor (ok:3)", async () => {
  const home = await freshHome();
  await seedNativeCapabilities(home);
  const browser = await loadCapability(home, "native/use-browser");
  assert.equal(browser.status, "mastered");
  assert.equal(browser.outcomes.ok, 3);
  assert.equal(browser.source, "native");
});

// ── 2 & 3. tools register available, never mastered; sensitive ones gated ─────

test("seed: tool capabilities are `available`/ok:0 — existing is not proof", async () => {
  const home = await freshHome();
  await seedToolCapabilities(home);

  const send = await loadCapability(home, "email.send");
  assert.equal(send.status, "available", "a wired tool is available, NOT mastered");
  assert.equal(send.outcomes.ok, 0, "no synthetic success record for unproven tools");
  assert.equal(send.source, "business");
  assert.equal(send.domain, "communications");
  assert.deepEqual(send.evidence, [], "evidence starts empty");

  // Nothing seeded by the tool layer is mastered.
  const tools = (await listCapabilities(home)).filter((n) => n.source === "tool" || n.source === "business");
  assert.ok(tools.length >= TOOL_CAPABILITY_SEEDS.length);
  assert.ok(tools.every((n) => n.status === "available"), "no tool is mastered on seed");
});

test("seed: charging money / prod deploy / live email all require human approval", async () => {
  const home = await freshHome();
  await seedToolCapabilities(home);
  for (const id of ["stripe.create-checkout", "deploy.production", "email.send"]) {
    const node = await loadCapability(home, id);
    assert.equal(node.requiresHumanApproval, true, `${id} must require approval`);
  }
  // Read-only siblings do not demand approval.
  for (const id of ["stripe.list-payments", "deploy.preview", "email.read", "web.research"]) {
    const node = await loadCapability(home, id);
    assert.notEqual(node.requiresHumanApproval, true, `${id} should not require approval`);
  }
});

// ── 4. registry and seeds agree ──────────────────────────────────────────────

test("seed: every capability named in the tool registry has a matching seed", async () => {
  const seedIds = new Set(TOOL_CAPABILITY_SEEDS.map((s) => s.id));
  for (const entry of TOOL_CAPABILITY_MAP) {
    for (const cap of entry.capabilities) {
      assert.ok(seedIds.has(cap), `registry references ${cap} but no seed defines it`);
    }
  }
});

// ── 5. skills come from disk, not vibes ──────────────────────────────────────

test("seed: skills are registered from disk — an empty dir yields no node", async () => {
  const home = await freshHome();
  const skillsDir = path.join(home, "skills");
  await fs.mkdir(path.join(skillsDir, "vault"), { recursive: true });
  await fs.writeFile(path.join(skillsDir, "vault", "SKILL.md"), "# vault\n");
  await fs.mkdir(path.join(skillsDir, "stray-empty-dir"), { recursive: true });

  await seedSkillCapabilities(home);

  const vault = await loadCapability(home, "skill/vault");
  assert.equal(vault.status, "available");
  assert.equal(vault.source, "skill");
  assert.equal(await loadCapability(home, "skill/stray-empty-dir"), null, "no artifact → no node");
});

// ── 6. idempotent; never resets earned progress ──────────────────────────────

test("seed: re-seeding keeps existing nodes and preserves earned progress", async () => {
  const home = await freshHome();
  await seedToolCapabilities(home);

  // Simulate the tool getting verified into `have`.
  let node = await loadCapability(home, "web.research");
  node = recordOutcome(node, true);
  assert.equal(node.status, "have");
  await saveCapability(home, node);

  const second = await seedToolCapabilities(home);
  assert.equal(second.created, 0, "nothing re-created");
  assert.ok(second.kept >= TOOL_CAPABILITY_SEEDS.length);
  const after = await loadCapability(home, "web.research");
  assert.equal(after.status, "have", "earned progress survives re-seed");
  assert.equal(after.outcomes.ok, 1);
});

// ── 7. available → have only via verified success ────────────────────────────

test("capability: a verified success is the only door from available → have", async () => {
  const home = await freshHome();
  await seedToolCapabilities(home);
  let node = await loadCapability(home, "stripe.list-payments");
  assert.equal(node.status, "available");
  node = recordOutcome(node, false, { error: "no api key" });
  assert.equal(node.status, "available", "a failure does not promote");
  node = recordOutcome(node, true);
  assert.equal(node.status, "have", "first verified success promotes");
});

// ── 8. the ledger is generated from the graph and is crix-free ───────────────

test("ledger: CAPABILITIES.md is generated from the graph with no dead ~/.crix paths", async () => {
  const home = await freshHome();
  await seedAllCapabilities(home);
  const caps = await listCapabilities(home);
  const file = await writeCapabilitiesDoc(home, caps);
  const doc = await fs.readFile(file, "utf8");

  // Source of truth: every graph node id appears in the generated doc.
  for (const node of caps) assert.ok(doc.includes(node.id), `doc missing ${node.id}`);

  // No radioactive legacy paths in the generated active doc.
  for (const ghost of [".crix", "CRIX_HOME", "D:\\Crix", "~/.crix"]) {
    assert.ok(!doc.includes(ghost), `generated ledger leaked a stale path: ${ghost}`);
  }
  // The generated doc declares itself generated (not hand-authoritative).
  assert.match(doc, /GENERATED FROM the operator capability graph/);
});

test("ledger: renderCapabilitiesDoc is a pure projection (empty graph → empty ledger)", () => {
  const doc = renderCapabilitiesDoc([]);
  assert.match(doc, /empty graph/);
  assert.ok(!doc.includes(".crix"));
});
