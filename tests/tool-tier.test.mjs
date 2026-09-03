// Two-tier tool catalog — selectToolsForTurn() sends a STATIC core tier every
// turn and defers everything else behind ToolSearch.
//
// The retired keyword router (selectToolsForTurnLegacy) had two failure modes:
// a capability its regex missed was invisible (not merely unused), and the
// catalog flipped with user wording, which re-billed the prompt-cache prefix
// (tool schemas are part of it) on every flip. These cases pin the replacement:
// same names in the same order regardless of wording; deferred tools appear
// only after a ToolSearch load, an exact-name mention, or recent use; loaded
// tools append at the END in load order and stay.

import test from "node:test";
import assert from "node:assert/strict";
import {
  selectToolsForTurn,
  selectToolsForTurnLegacy,
  primaryEditProtocol,
  CORE_TOOL_NAMES,
  loadedToolsFromTranscript,
  explicitlyNamedTools,
} from "../packages/core/dist/queryEngine.js";

const NAMES = [
  "Read", "Write", "Edit", "ApplyPatch", "ApplyIntent", "FindAndEdit", "CodeMode", "Glob", "Grep",
  "CodebaseSearch", "LSP", "Bash", "PowerShell", "BashOutput", "KillShell",
  "TodoWrite", "Task", "TaskOutput", "KillTask", "Conductor", "EnterPlanMode", "UpdatePlanDraft", "ExitPlanMode",
  "WebSearch", "WebFetch", "ImageSearch", "ComputerUse", "Browser", "ToolSearch",
  "McpListTools", "McpCallTool", "SkillsList", "SkillRead", "Memory", "Connect",
  "RequestUserAction", "Deploy", "Stripe", "Email", "Gmail", "GoogleCalendar",
  "Spotify", "Weather", "Remind", "Mission", "Self", "SkillHub", "Operator", "Capability",
];
const WRITE_TOOLS = new Set([
  "Write", "Edit", "ApplyPatch", "ApplyIntent", "FindAndEdit", "CodeMode",
  "TodoWrite", "Task", "Conductor", "UpdatePlanDraft", "Spotify", "Deploy", "Stripe", "Email",
]);
const TOOLS = NAMES.map((name) => ({
  schema: { name, safety: WRITE_TOOLS.has(name) ? "workspace-write" : "read-only" },
}));

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const toolUse = (id, name, input = {}) => ({ role: "assistant", content: [{ type: "tool_use", id, name, input }] });
const toolResult = (id, content) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: typeof content === "string" ? content : JSON.stringify(content) }],
});
const names = (messages, context) => selectToolsForTurn(TOOLS, messages, context).map((t) => t.schema.name);

const withEnv = (key, value, fn) => {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
};

test("core catalog is byte-stable across turns with unrelated user texts", () => {
  const a = names([user("play some music")]);
  const b = names([user("add a dark mode toggle to the settings page")]);
  const c = names([user("what's the weather in Toronto and email it to Babe")]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  // Deterministic order = CORE_TOOL_NAMES order, minus the inactive edit protocol.
  const expected = CORE_TOOL_NAMES.filter((name) => name !== "ApplyPatch");
  assert.deepEqual(a, expected);
});

test("play some music without a ToolSearch load does NOT include Spotify", () => {
  const offered = names([user("play some music")]);
  assert.ok(!offered.includes("Spotify"));
  assert.ok(offered.includes("ToolSearch"), "the discovery tool is always on the belt");
  for (const deferred of ["Stripe", "Gmail", "GoogleCalendar", "Weather", "Remind", "Deploy", "ComputerUse", "Operator", "Mission"]) {
    assert.ok(!offered.includes(deferred), `${deferred} should be deferred`);
  }
});

test("a ToolSearch load in the transcript adds Spotify at the END and it stays on later turns", () => {
  const history = [
    user("play some music"),
    toolUse("s1", "ToolSearch", { query: "music" }),
    toolResult("s1", { query: "music", matches: [{ name: "Spotify", description: "..." }], loaded: ["Spotify"], unknown: [] }),
  ];
  const afterLoad = names(history);
  assert.equal(afterLoad[afterLoad.length - 1], "Spotify");
  const core = afterLoad.slice(0, -1);
  assert.deepEqual(core, names([user("unrelated")]), "prefix before the loaded segment is the unchanged core");

  // Many turns later, no further Spotify use: still loaded.
  const later = [...history];
  for (let i = 0; i < 20; i++) later.push(user(`turn ${i}`), { role: "assistant", content: [{ type: "text", text: "ok" }] });
  later.push(user("now what was that again"));
  assert.ok(names(later).includes("Spotify"));
});

test("loads accumulate in load order and the select: form counts even when the result is truncated", () => {
  const history = [
    user("hi"),
    toolUse("s1", "ToolSearch", { query: "music" }),
    toolResult("s1", { loaded: ["Spotify"] }),
    toolUse("s2", "ToolSearch", { query: "select:Weather,Gmail" }),
    toolResult("s2", "[tool result truncated]"),
  ];
  assert.deepEqual(loadedToolsFromTranscript(history), ["Spotify", "Weather", "Gmail"]);
  const offered = names(history);
  assert.deepEqual(offered.slice(-3), ["Spotify", "Weather", "Gmail"]);
});

test("host-supplied loadedDeferredTools (survives compaction) also count", () => {
  const offered = names([user("hi")], { loadedDeferredTools: ["Stripe"] });
  assert.equal(offered[offered.length - 1], "Stripe");
});

test("a tool used 5 messages ago stays advertised; one used 13+ messages ago ages out", () => {
  const recent = [
    user("create an invoice"),
    toolUse("t1", "Stripe"),
    toolResult("t1", "ok"),
    user("thanks"),
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    user("do that again"),
  ];
  assert.ok(names(recent).includes("Stripe"));
  const stale = [toolUse("t1", "Stripe"), toolResult("t1", "ok")];
  for (let i = 0; i < 7; i++) stale.push(user(`turn ${i}`), { role: "assistant", content: [{ type: "text", text: "ok" }] });
  assert.ok(!names(stale).includes("Stripe"), "recent-use window is 12 messages");
});

test("an exact-name mention includes the tool; keyword guessing does not", () => {
  assert.ok(names([user("use the Weather tool to check Toronto")]).includes("Weather"));
  assert.ok(names([user("ask @Spotify for a playlist")]).includes("Spotify"));
  assert.ok(!names([user("what's the forecast for Toronto?")]).includes("Weather"));
  assert.deepEqual(explicitlyNamedTools("use the weather tool and @gmail", new Set(["weather", "gmail", "read"])), ["weather", "gmail"]);
});

test("ARES_TOOL_TIER=legacy reproduces the keyword router", () => {
  const prompt = [user("Open YouTube and click that video")];
  const legacy = withEnv("ARES_TOOL_TIER", "legacy", () => names(prompt));
  assert.deepEqual(legacy, selectToolsForTurnLegacy(TOOLS, prompt).map((t) => t.schema.name));
  assert.ok(legacy.includes("ComputerUse"), "the regex router adds ComputerUse on a browser turn");
  assert.ok(!names(prompt).includes("ComputerUse"), "the tiered catalog defers it");
});

test("ARES_DYNAMIC_TOOLS=0 still means send everything", () => {
  const offered = withEnv("ARES_DYNAMIC_TOOLS", "0", () => names([user("play some music")]));
  assert.ok(offered.includes("Spotify"));
  assert.ok(offered.includes("Weather"));
});

test("provider protocol: ApplyPatch for gpt-*/codex, Edit+Write otherwise", () => {
  assert.equal(primaryEditProtocol("openai-responses", "gpt-5-codex"), "apply-patch");
  assert.equal(primaryEditProtocol("openai", "o3-mini"), "apply-patch");
  assert.equal(primaryEditProtocol("anthropic", "claude-fable-5-1"), "edit-write");
  assert.equal(primaryEditProtocol(undefined, undefined), "edit-write");
  const gpt = names([user("implement the feature")], { providerName: "openai-responses", model: "gpt-5-codex" });
  assert.ok(gpt.includes("ApplyPatch") && !gpt.includes("Edit") && !gpt.includes("Write"));
  const claude = names([user("implement the feature")], { providerName: "anthropic", model: "claude-fable-5-1" });
  assert.ok(claude.includes("Edit") && claude.includes("Write") && !claude.includes("ApplyPatch"));
});

test("plan and build workflow contracts hold on the tiered catalog", () => {
  const plan = names([user("let's think first")], { workflowMode: "plan" });
  assert.ok(plan.includes("ExitPlanMode") && plan.includes("UpdatePlanDraft") && plan.includes("Read") && plan.includes("Task"));
  for (const name of ["Write", "Edit", "ApplyPatch", "EnterPlanMode"]) assert.ok(!plan.includes(name), `${name} hidden in plan`);
  const build = names([user("go")], { workflowMode: "build" });
  assert.ok(build.includes("EnterPlanMode") && !build.includes("ExitPlanMode") && !build.includes("UpdatePlanDraft"));
});

test("a belt without ToolSearch is sent whole — nothing is hidden that cannot be discovered", () => {
  const belt = TOOLS.filter((t) => t.schema.name !== "ToolSearch");
  const offered = selectToolsForTurn(belt, [user("play some music")]).map((t) => t.schema.name);
  assert.ok(offered.includes("Spotify"));
  assert.ok(offered.includes("Weather"));
});
