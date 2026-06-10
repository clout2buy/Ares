// Verifies O4 — the compounding capability graph (the centerpiece):
//   1. THE HEADLINE: novel delta SHRINKS as sub-skills are reused. Mastering
//      "make-email" factors out its sub-skills, so "make-shopify" only has to
//      learn the one genuinely new piece. That shrinking curve is the literal
//      proof that a 500-session Ares beats a fresh one on the same model.
//   2. Crystallization requires N verified successes, never a single lucky run.
//   3. factor() only creates sub-skills that don't already exist.
//   4. driveLearning walks the loop to mastery and writes a REAL runnable skill.
//   5. A flaky worker still reaches mastery once it accrues enough successes.
//   6. nextLearningPhase walks research → attempt → drill → crystallize → done.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createCapability,
  recordOutcome,
  reliabilityOf,
  crystallize,
  markRotted,
  novelDelta,
  factor,
  nextLearningPhase,
  driveLearning,
  saveCapability,
  listCapabilities,
} from "../packages/operator/dist/index.js";

import { exists } from "../packages/agent/dist/index.js";

async function makeHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ares-o4-"));
}

const SUCCESS_HANDLER = "export default async () => ({ ok: true });\n";

// ── 1. THE HEADLINE: the novel-delta curve trends down ───────────────────────

test("graph: novel delta shrinks as sub-skills are reused (the smarter-over-time proof)", async () => {
  const home = await makeHome();

  // Encounter A ("make-email") on an EMPTY graph — everything is novel.
  const reqA = ["research", "browser-form-fill", "credential-vault", "verification-link"];
  const deltaA = novelDelta(reqA, await listCapabilities(home));
  assert.equal(deltaA, 4, "on an empty graph, every sub-skill is novel");

  let a = createCapability({ id: "make-email", name: "make-email", requires: reqA, novelDeltaAtBirth: deltaA });
  await saveCapability(home, a);

  // Drive A to mastery with a worker that verifies + hands over a runnable skill.
  a = await driveLearning(a, {
    home,
    attempt: async () => ({ ok: true, skill: { name: "make-email", handler: SUCCESS_HANDLER } }),
  });
  assert.equal(a.status, "mastered");
  assert.ok(a.skillRef, "a skill was crystallized");

  // The crystallized skill is a REAL artifact on disk (runnable by the skill runtime).
  assert.ok(await exists(path.join(home, "skills", "make-email", "handler.js")), "handler.js written");

  // Factoring created the four reusable sub-skills.
  const afterA = await listCapabilities(home);
  for (const sub of reqA) {
    assert.ok(afterA.some((n) => n.id === sub && (n.status === "mastered" || n.status === "have")), `sub-skill "${sub}" now owned`);
  }

  // Encounter B ("make-shopify") — reuses 4, only "shopify-specifics" is new.
  const reqB = ["research", "browser-form-fill", "credential-vault", "verification-link", "shopify-specifics"];
  const deltaB = novelDelta(reqB, await listCapabilities(home));
  assert.equal(deltaB, 1, "only the genuinely new sub-skill is novel");
  assert.ok(deltaB < deltaA, `the novel-delta curve trends DOWN (${deltaA} → ${deltaB}) — Ares got smarter`);
});

// ── 2. crystallization needs repeated success ────────────────────────────────

test("capability: crystallization requires N verified successes, not one lucky run", () => {
  let node = createCapability({ id: "x", name: "x" });
  node = recordOutcome(node, true); // 1 success
  assert.throws(() => crystallize(node, { minSuccesses: 3, skillRef: "x" }), /needs 3 verified successes/);
  node = recordOutcome(recordOutcome(node, true), true); // 3 successes
  const mastered = crystallize(node, { minSuccesses: 3, skillRef: "x" });
  assert.equal(mastered.status, "mastered");
  assert.equal(mastered.skillRef, "x");
});

test("capability: reliability is tracked and a failing skill can be marked rotted (O13 hook)", () => {
  let node = createCapability({ id: "y", name: "y" });
  node = recordOutcome(node, true);
  node = recordOutcome(node, false, { error: "boom" });
  assert.equal(reliabilityOf(node), 0.5);
  assert.equal(node.outcomes.lastError, "boom");
  node = markRotted(node, "fixture now fails");
  assert.equal(node.status, "rotted");
});

// ── 3. factoring is idempotent over existing nodes ───────────────────────────

test("graph: factor only creates sub-skills that do not already exist", () => {
  const existing = [createCapability({ id: "research", name: "research", status: "mastered" })];
  const parent = createCapability({ id: "p", name: "p", requires: ["research", "new-thing"] });
  const created = factor(parent, existing);
  assert.equal(created.length, 1);
  assert.equal(created[0].id, "new-thing");
  assert.equal(created[0].status, "mastered");
});

// ── 4 & 6. the learning loop ─────────────────────────────────────────────────

test("learn: nextLearningPhase walks research → attempt → drill → crystallize → done", () => {
  let n = createCapability({ id: "z", name: "z", status: "want" });
  assert.equal(nextLearningPhase(n, 3), "research");
  n = { ...n, status: "learning" };
  assert.equal(nextLearningPhase(n, 3), "attempt");
  n = recordOutcome(n, true); // ok 1 → "have"
  assert.equal(nextLearningPhase(n, 3), "drill");
  n = recordOutcome(recordOutcome(n, true), true); // ok 3
  assert.equal(nextLearningPhase(n, 3), "crystallize");
  n = crystallize(n, { minSuccesses: 3, skillRef: "z" });
  assert.equal(nextLearningPhase(n, 3), "done");
});

// ── 5. flaky-but-eventually-reliable still masters ───────────────────────────

test("driveLearning: a flaky worker still reaches mastery once it accrues enough verified successes", async () => {
  const home = await makeHome();
  let node = createCapability({ id: "flaky", name: "flaky" });
  await saveCapability(home, node);

  let n = 0;
  const final = await driveLearning(node, {
    home,
    minSuccesses: 3,
    maxAttempts: 40,
    attempt: async (_node, phase) => {
      n++;
      if (phase === "crystallize") return { ok: true, skill: { name: "flaky", handler: SUCCESS_HANDLER } };
      return { ok: n % 2 === 0 }; // succeeds every other attempt
    },
  });

  assert.equal(final.status, "mastered", "flakiness delays but does not prevent mastery");
  assert.ok(final.outcomes.ok >= 3);
  assert.ok(final.outcomes.fail >= 1, "the flaky failures were honestly recorded");
});
