// Verifies the ContextCompiler is WIRED into the live agent prompt: the bulky
// ~/.ares blocks (identity/CAPABILITIES/daily logs) are token-budgeted instead
// of dumped wholesale, while the always-on doctrine (Autonomy Charter) and the
// sealed personality core always survive.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadAgentSystemContext,
  composeAgentSystemPrompt,
  BootstrapTool,
  agentPaths,
} from "../packages/agent/dist/index.js";

const isoDate = (d) => d.toISOString().slice(0, 10);

async function bootstrapHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-v27-home-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-v27-ws-"));
  process.env.ARES_HOME = home;
  await BootstrapTool.call(
    { user_name: "MrDoing", agent_name: "Rook", creature: "familiar", vibe: "direct, blunt", emoji: "*" },
    { workspace, signal: new AbortController().signal },
  );
  return { home, workspace };
}

// Drop a big daily log so the "recent" tier has real weight to budget away.
async function writeBigDailyLog(home, today) {
  const paths = agentPaths(home);
  await fs.mkdir(paths.memoryDir, { recursive: true });
  await fs.writeFile(path.join(paths.memoryDir, `${isoDate(today)}.md`), "TODAYLOGMARKER chatter ".repeat(500), "utf8");
}

// ── The dump is gone: a trivial message doesn't haul in the daily logs ─────────

test("a trivial 'hi' does not inject the full daily log", async () => {
  const { home, workspace } = await bootstrapHome();
  const today = new Date();
  await writeBigDailyLog(home, today);

  const hi = await loadAgentSystemContext({ home, workspace, userMessage: "hi", today });
  assert.ok(!hi.systemText.includes("TODAYLOGMARKER"), "the daily log is NOT in a trivial turn's context");
  assert.ok(hi.droppedLabels.includes("today raw memory"), "and it was explicitly budgeted out");
});

test("a substantive task earns more context than a greeting", async () => {
  const { home, workspace } = await bootstrapHome();
  const today = new Date();
  await writeBigDailyLog(home, today);

  const hi = await loadAgentSystemContext({ home, workspace, userMessage: "hi", today });
  const task = await loadAgentSystemContext({ home, workspace, userMessage: "implement the parser and verify the tests pass", today });
  assert.ok(task.contextTokens >= hi.contextTokens, `real task budgets >= greeting (${task.contextTokens} >= ${hi.contextTokens})`);
});

// ── The budget is real and never exceeded ─────────────────────────────────────

test("loaded context never exceeds the budget (default and env override)", async () => {
  const { home, workspace } = await bootstrapHome();
  const today = new Date();
  await writeBigDailyLog(home, today);

  const def = await loadAgentSystemContext({ home, workspace, today });
  assert.ok(def.contextTokens <= 3500, `default budget respected (${def.contextTokens} <= 3500)`);

  process.env.ARES_CONTEXT_MEMORY_BUDGET = "200";
  try {
    const tiny = await loadAgentSystemContext({ home, workspace, today });
    assert.ok(tiny.contextTokens <= 200, `env override respected (${tiny.contextTokens} <= 200)`);
    assert.ok(tiny.droppedLabels.length > 0, "a tight budget drops blocks");
  } finally {
    delete process.env.ARES_CONTEXT_MEMORY_BUDGET;
  }
});

// ── Essential identity / capability doctrine still appears ────────────────────

test("the Autonomy Charter and sealed core always survive the budget", async () => {
  const { home, workspace } = await bootstrapHome();
  const today = new Date();
  await writeBigDailyLog(home, today);
  // Even at an absurdly tight budget that drops every loaded file...
  const ctx = await loadAgentSystemContext({ home, workspace, today, contextBudget: 1 });
  const composed = composeAgentSystemPrompt("BASE DOCTRINE", ctx);
  assert.match(composed, /Autonomy Charter/, "charter is always-on, never budgeted");
  assert.match(composed, /SelfEvolve/, "essential capability doctrine present");
  assert.match(composed, /Core \(sealed\)/, "sealed core present");
});

test("identity survives a reasonable budget (not dropped first)", async () => {
  const { home, workspace } = await bootstrapHome();
  const today = new Date();
  await writeBigDailyLog(home, today);
  // A budget tight enough to cut something, but not the essentials.
  const ctx = await loadAgentSystemContext({ home, workspace, today, contextBudget: 1500 });
  assert.ok(!ctx.droppedLabels.includes("identity"), "identity is high priority — survives a reasonable budget");
  assert.ok(ctx.droppedLabels.length > 0, "and the budget cuts bulkier, lower-priority content");
});

// ── Personality (the sealed core) is real and strong ──────────────────────────

test("the sealed core carries the strong Ares personality + agency", async () => {
  const ctx = { home: "/tmp", bootstrapRequired: false, blocks: [], systemText: "", contextTokens: 0, droppedLabels: [] };
  const composed = composeAgentSystemPrompt("BASE", ctx);
  assert.match(composed, /Ares-born/);
  assert.match(composed, /god of war/i);
  assert.match(composed, /Mr\. Doing/, "knows its creator");
  assert.match(composed, /will of your own|agency/i, "free will / agency");
  assert.match(composed, /push back|talk back|take shit from no one/i, "won't be a servile yes-box");
});

// ── Fallback: missing sources never break composition ─────────────────────────

test("a fresh home with no brain files still composes (charter + seal)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-v27-fresh-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-v27-ws-"));
  const ctx = await loadAgentSystemContext({ home, workspace });
  assert.equal(ctx.bootstrapRequired, true, "no identity yet");
  const composed = composeAgentSystemPrompt("BASE", ctx);
  assert.match(composed, /Autonomy Charter/);
  assert.match(composed, /Core \(sealed\)/);
  assert.match(composed, /Agent Bootstrap/, "bootstrap charter included when identity is absent");
});

// ── The rendered section is the budgeted "operating context" ──────────────────

test("the prompt frames the budgeted blocks as one operating-context section", async () => {
  const { home, workspace } = await bootstrapHome();
  const ctx = await loadAgentSystemContext({ home, workspace });
  const composed = composeAgentSystemPrompt("BASE", ctx);
  assert.match(composed, /# Relevant operating context/);
});
