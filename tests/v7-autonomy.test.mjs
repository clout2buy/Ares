import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OperatorBackgroundLoop,
  attentionItemsFromCapabilities,
  attentionItemsFromGoals,
  createCapability,
  createGoal,
  decideAttention,
  loadGoal,
  saveGoal,
} from "../packages/operator/dist/index.js";
import { diagnoseMemory } from "../packages/mind/dist/index.js";

async function makeHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "crix-v7-"));
}

test("attention: foreground work outranks stale background goals", () => {
  const decision = decideAttention(
    [
      {
        id: "goal:old",
        kind: "active_goal",
        title: "background objective",
        priority: 100,
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      {
        id: "turn:user",
        kind: "foreground",
        title: "answer the current user turn",
        priority: 10,
      },
    ],
    { now: new Date("2026-06-02T00:00:00.000Z") },
  );

  assert.equal(decision.selected.id, "turn:user");
  assert.match(decision.summary, /foreground/);
});

test("attention: blocked goals are parked unless explicitly included", () => {
  const active = createGoal({ id: "active", statement: "ship a useful change" });
  const blocked = { ...createGoal({ id: "blocked", statement: "waiting on external API" }), status: "blocked", verdict: "needs token" };

  const decision = decideAttention(attentionItemsFromGoals([blocked, active]));
  assert.equal(decision.selected.id, "goal:active");
  assert.equal(decision.parked.length, 1);
  assert.equal(decision.parked[0].id, "goal:blocked");
});

test("attention: capability gaps enter the queue ahead of routine maintenance", () => {
  const want = createCapability({ id: "cap/email", name: "send email", status: "want" });
  const rotted = { ...createCapability({ id: "cap/browser", name: "browser smoke check", status: "mastered" }), status: "rotted" };
  const decision = decideAttention([
    ...attentionItemsFromCapabilities([want, rotted]),
    { id: "maint:memory", kind: "maintenance", title: "consolidate memory", priority: 5 },
  ]);

  assert.equal(decision.queue[0].id, "capability:cap/email");
  assert.ok(decision.queue.some((item) => item.id === "capability:cap/browser"));
});

test("background loop: one wake advances the selected active goal once", async () => {
  const home = await makeHome();
  const goal = createGoal({ id: "g1", statement: "finish background work" });
  await saveGoal(home, goal);

  const loop = new OperatorBackgroundLoop({
    home,
    dispatcher: {
      async runStep() {
        return { moved: true, goalMet: true, evidence: "done" };
      },
    },
  });

  const tick = await loop.tickOnce();
  assert.equal(tick.ran.length, 1);
  assert.equal(tick.ran[0].status, "done");
  assert.equal((await loadGoal(home, "g1")).status, "done");

  await fs.rm(home, { recursive: true, force: true });
});

test("memory doctor: reports duplicate, orphaned, noisy, and faded memory shape", () => {
  const now = new Date("2026-06-02T00:00:00.000Z");
  const old = new Date("2026-01-01T00:00:00.000Z").toISOString();
  const fresh = now.toISOString();
  const report = diagnoseMemory(
    [
      {
        id: "a",
        kind: "episodic",
        content: "same durable fact",
        at: old,
        strength: 1,
        activations: 0,
        lastActivatedAt: old,
        links: ["missing"],
      },
      {
        id: "b",
        kind: "episodic",
        content: "same durable fact",
        at: fresh,
        strength: 1,
        activations: 0,
        lastActivatedAt: fresh,
        links: [],
      },
      {
        id: "theme",
        kind: "semantic",
        content: 'Recurring theme "lmao" observed across 5 episodes.',
        at: fresh,
        strength: 1,
        activations: 0,
        lastActivatedAt: fresh,
        links: [],
        tags: ["theme:lmao"],
      },
    ],
    { now },
  );

  assert.equal(report.duplicateGroups.length, 1);
  assert.equal(report.orphanLinks.length, 1);
  assert.equal(report.noisyThemeSemantics, 1);
  assert.equal(report.lowStrengthEpisodes, 1);
  assert.ok(report.recommendations.some((line) => /consolidate/.test(line)));
});
