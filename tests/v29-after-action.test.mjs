// Verifies after-action reflection records — the recursive loop's bones:
// store a compact structured record, deterministically fold success into the
// project war map (never promote a failure to a win), keep receipts, stay tiny.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  saveAfterAction,
  loadRecentAfterActions,
  applyAfterActionToProjectState,
  recordAfterAction,
  renderAfterActionFragment,
  afterActionDir,
  loadProjectState,
  defaultAresProject,
  renderProjectFragment,
  estimateTokensDefault,
  compileContext,
} from "../packages/mind/dist/index.js";

const makeHome = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-v29-"));

const record = (over = {}) => ({
  schemaVersion: 1,
  timestamp: "2026-06-16T14:30:05.000Z",
  projectId: "ares",
  task: "wire ContextCompiler into prompts",
  result: "success",
  summary: "ContextCompiler now budgets the ~/.ares blocks in agent prompts",
  importantChanges: ["budgeted identity/CAPABILITIES/daily logs"],
  commits: ["15567a74"],
  tests: ["596/596"],
  ciStatus: "596/596, CI green",
  lessons: ["essential identity must live outside budget trimming"],
  nextActions: ["add project state packets"],
  sourcePointers: ["15567a74", "rollouts/session-xyz.jsonl"],
  ...over,
});

// ── Save / load round-trip ────────────────────────────────────────────────────

test("after-action save/load round-trips and filters by project, newest first", async () => {
  const home = await makeHome();
  await saveAfterAction(record({ timestamp: "2026-06-15T10:00:00.000Z", summary: "older win", commits: ["aaa"] }), home);
  await saveAfterAction(record({ timestamp: "2026-06-16T14:30:05.000Z", summary: "newer win", commits: ["bbb"] }), home);
  await saveAfterAction(record({ projectId: "other", summary: "different project" }), home);

  const recent = await loadRecentAfterActions("ares", 10, home);
  assert.equal(recent.length, 2, "only the ares records");
  assert.equal(recent[0].summary, "newer win", "newest first");
  assert.equal(recent[1].summary, "older win");
  assert.deepEqual(recent[0].sourcePointers, ["15567a74", "rollouts/session-xyz.jsonl"], "receipts preserved");
});

// ── Graceful degradation ──────────────────────────────────────────────────────

test("missing / corrupt after-action files degrade gracefully", async () => {
  const home = await makeHome();
  assert.deepEqual(await loadRecentAfterActions("ares", 10, home), [], "no dir → empty, no throw");

  const day = path.join(afterActionDir(home), "2026-06-16");
  await fs.mkdir(day, { recursive: true });
  await fs.writeFile(path.join(day, "broken.json"), "<<not json>>", "utf8");
  await saveAfterAction(record({ summary: "valid one" }), home);
  const recent = await loadRecentAfterActions("ares", 10, home);
  assert.equal(recent.length, 1, "the corrupt file is skipped, the valid one loads");
  assert.equal(recent[0].summary, "valid one");
});

// ── Deterministic project-state update ────────────────────────────────────────

test("a success record promotes a win, moves the gate, and updates next actions", () => {
  const before = defaultAresProject();
  const after = applyAfterActionToProjectState(before, record());
  assert.match(after.recentWins[0], /ContextCompiler now budgets/, "summary became the newest win");
  assert.match(after.recentWins[0], /15567a74/, "win carries its commit receipt");
  assert.equal(after.lastGate, "596/596, CI green", "gate moved forward");
  assert.ok(after.recentCommits.includes("15567a74"), "commit recorded");
  assert.deepEqual(after.nextActions, ["add project state packets"], "next actions updated");
  assert.notDeepEqual(after.recentWins, before.recentWins, "state actually changed");
});

test("a FAILED record logs risk/lesson but never becomes a win or moves the gate", () => {
  const before = defaultAresProject();
  const failed = record({ result: "failed", summary: "the wiring broke the bootstrap path", commits: ["deadbeef"], lessons: ["charter must stay always-on"], ciStatus: "RED" });
  const after = applyAfterActionToProjectState(before, failed);
  assert.deepEqual(after.recentWins, before.recentWins, "wins untouched by a failure");
  assert.equal(after.lastGate, before.lastGate, "gate NOT moved by a failure");
  assert.ok(after.risks.some((r) => /Failed: the wiring broke/.test(r)), "failure recorded as a risk");
  assert.ok(after.risks.some((r) => /charter must stay always-on/.test(r)), "lesson recorded");
});

// ── recordAfterAction (save + on-success disk update) ─────────────────────────

test("recordAfterAction: a successful Ares commit is reflected in the project packet on disk", async () => {
  const home = await makeHome();
  const { project } = await recordAfterAction(record({ summary: "added mission state packets", commits: ["e3325c4a"], ciStatus: "607/607, CI green", nextActions: ["after-action reflection loop"] }), home);
  assert.ok(project, "project packet returned");
  assert.match(project.recentWins[0], /added mission state packets/);
  assert.equal(project.lastGate, "607/607, CI green");

  // And it actually persisted — a fresh load sees the update.
  const reloaded = await loadProjectState("ares", home);
  assert.match(reloaded.recentWins[0], /added mission state packets/);
  assert.ok(reloaded.recentCommits.includes("e3325c4a"));
});

test("recordAfterAction: a failed run is stored but does NOT update the packet", async () => {
  const home = await makeHome();
  const { project } = await recordAfterAction(record({ result: "failed", summary: "broke something" }), home);
  assert.equal(project, undefined, "no packet update on failure");
  const recent = await loadRecentAfterActions("ares", 10, home);
  assert.equal(recent.length, 1, "but the failure IS recorded for the timeline");
  assert.equal(recent[0].result, "failed");
});

// ── Compact rendering + budget ────────────────────────────────────────────────

test("the rendered after-action fragment stays compact and keeps receipts", () => {
  const frag = renderAfterActionFragment([record(), record({ summary: "second thing", commits: ["cafe123"] })]);
  assert.equal(frag.tier, "recent");
  assert.equal(frag.project, "ares", "gated to the project");
  assert.ok(estimateTokensDefault(frag.content) < 200, `compact (${estimateTokensDefault(frag.content)}t)`);
  assert.match(frag.content, /\[15567a74\]/, "commit receipt kept");
  assert.equal(renderAfterActionFragment([]), null, "no records → nothing to inject");
});

test("the project packet stays compact and under budget after several updates", () => {
  // Fold in a handful of wins — the caps must keep the war map from bloating.
  let project = defaultAresProject();
  for (let i = 0; i < 12; i++) {
    project = applyAfterActionToProjectState(project, record({ summary: `win number ${i} with some detail`, commits: [`c${i}`] }));
  }
  const frag = renderProjectFragment(project);
  assert.ok(estimateTokensDefault(frag.content) < 500, `still a dagger after 12 updates (${estimateTokensDefault(frag.content)}t)`);
  assert.ok(project.recentWins.length <= 8, "recentWins capped");
  assert.ok(project.recentCommits.length <= 8, "recentCommits capped");

  const packet = compileContext({ userMessage: "work on ares", activeProject: "ares", tokenBudget: 600, fragments: [frag] });
  assert.ok(packet.tokens <= 600 && packet.included.length === 1, "fits a tight budget");
});
