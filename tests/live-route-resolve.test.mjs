// The live route — @ares/core resolveRoute() finally has a caller. The
// daemon's Auto-routing path goes through resolveLiveRoute(), which merges
// the owner's per-lane assignments with the scored heuristic over the
// providers ACTUALLY configured, cites reasons, warns on sensitive surfaces,
// and marks routes executable only when their provider is configured + alive.
// Pure + offline.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLiveProfiles,
  detectSensitiveSurface,
  isExploreOrSummarizeGoal,
  laneTask,
  resolveLiveRoute,
} from "../packages/cli/dist/entry/liveRoute.js";

// A machine with a Claude key and a local Ollama (no cloud key, no OLLAMA_HOST).
const settings = {
  anthropicKey: "sk-ant-test",
  lastAnthropicModel: "claude-fable-5",
  lastOllamaModel: "qwen3:8b",
  favoriteOllamaModels: [],
  favoriteOpenAIModels: [],
};
const env = {}; // no env keys, no OLLAMA_HOST → ollama is local/private
const current = { family: "anthropic", model: "claude-fable-5" };

test("profiles come from what is configured: keyed families available, others not, ollama locality follows its host", () => {
  const profiles = buildLiveProfiles(settings, { env });
  const by = Object.fromEntries(profiles.map((p) => [p.family, p]));
  assert.equal(by.anthropic.available, true);
  assert.equal(by.ollama.available, true);
  assert.equal(by.ollama.locality, "local");
  assert.equal(by.ollama.private, true);
  assert.equal(by.deepseek.available, false, "no key → unavailable");
  assert.equal(by.openrouter.available, false);
  assert.equal(by.anthropic.modelClass, "claude-fable-5", "the heuristic resolves to a concrete default model");
  // A retired family is unavailable even with a key; extraAuthed adds one the settings can't see (OAuth).
  const dead = buildLiveProfiles(settings, { env, dead: new Set(["anthropic"]), extraAuthed: ["openai"] });
  assert.equal(dead.find((p) => p.family === "anthropic").available, false);
  assert.equal(dead.find((p) => p.family === "openai").available, true);
  // Ollama cloud key without OLLAMA_HOST → cloud locality, not private.
  const cloud = buildLiveProfiles({ ...settings, ollamaApiKey: "k" }, { env }).find((p) => p.family === "ollama");
  assert.equal(cloud.locality, "cloud");
  assert.equal(cloud.private, false);
});

test("an unassigned coding lane gets a scored pick with cited reasons and is executable", () => {
  const r = resolveLiveRoute({ goal: "refactor the retry loop in queryEngine.ts", lane: "coding", routingMode: "auto", current: { family: "ollama", model: "qwen3:8b" }, assignments: {}, settings, env });
  assert.equal(r.source, "heuristic");
  assert.equal(r.family, "anthropic", "quality-best coding goes to the frontier cloud model");
  assert.equal(r.model, "claude-fable-5");
  assert.equal(r.executable, true);
  assert.equal(r.switch, true);
  assert.ok(r.reasons.length > 0 && r.reasons.some((x) => /Anthropic/.test(x)), `reasons cite the pick: ${r.reasons}`);
  assert.ok(r.reasons.some((x) => /fallback/.test(x)), "a fallback is named for resilience");
});

test("an owner assignment wins over the heuristic; an unconfigured assignment is advisory (not executable)", () => {
  const assigned = resolveLiveRoute({ goal: "fix the failing test", lane: "coding", routingMode: "auto", current, assignments: { coding: { family: "ollama", model: "qwen3-coder:30b" } }, settings, env });
  assert.equal(assigned.source, "assigned");
  assert.equal(assigned.family, "ollama");
  assert.equal(assigned.model, "qwen3-coder:30b");
  assert.equal(assigned.executable, true);
  assert.ok(assigned.reasons.some((x) => /owner assigned coding/.test(x)), assigned.reasons.join("|"));

  const ghost = resolveLiveRoute({ goal: "fix the failing test", lane: "coding", routingMode: "auto", current, assignments: { coding: { family: "deepseek", model: "deepseek-v4-pro" } }, settings, env });
  assert.equal(ghost.source, "assigned");
  assert.equal(ghost.family, "deepseek");
  assert.equal(ghost.executable, false, "no DeepSeek key → the daemon keeps the current model");
  assert.ok(ghost.warnings.some((w) => /not configured|unavailable/.test(w)), ghost.warnings.join("|"));

  const retired = resolveLiveRoute({ goal: "fix the failing test", lane: "coding", routingMode: "auto", current, assignments: { coding: { family: "anthropic", model: "claude-fable-5" } }, settings, env, dead: new Set(["anthropic"]) });
  assert.equal(retired.executable, false, "a session-retired provider is never acted on");
});

test("a pinned (manual) selection wins over every lane — no router runs", () => {
  const r = resolveLiveRoute({ goal: "refactor everything", lane: "coding", routingMode: "manual", current: { family: "ollama", model: "qwen3:8b" }, assignments: { coding: { family: "anthropic", model: "claude-fable-5" } }, settings, env });
  assert.equal(r.source, "pinned");
  assert.equal(r.family, "ollama");
  assert.equal(r.model, "qwen3:8b");
  assert.equal(r.switch, false);
  assert.match(r.reasons[0], /pin/);
});

test("sensitive data prefers the local, private provider when one is available", () => {
  const plain = resolveLiveRoute({ goal: "tell me a joke about routers", lane: "chat", routingMode: "auto", current, assignments: {}, settings, env });
  assert.equal(plain.family, "anthropic", "plain chat stays on the frontier model");
  assert.equal(plain.sensitive, false);

  const secret = resolveLiveRoute({ goal: "here is my bank account password, store it in the vault: hunter2", lane: "chat", routingMode: "auto", current, assignments: {}, settings, env });
  assert.equal(secret.sensitive, true);
  assert.equal(secret.family, "ollama", "credentials route to the local model");
  assert.equal(secret.locality, "local");
  assert.equal(secret.executable, true);
  assert.ok(secret.reasons.some((x) => /sensitive data detected/.test(x)), secret.reasons.join("|"));

  // Same message, no local provider at all → cloud pick WITH a warning.
  const noLocal = resolveLiveRoute({ goal: "here is my bank account password, store it in the vault: hunter2", lane: "chat", routingMode: "auto", current, assignments: {}, settings: { ...settings, lastOllamaModel: undefined, lastProvider: "anthropic" }, env });
  assert.equal(noLocal.family, "anthropic");
  assert.ok(noLocal.warnings.some((w) => /cloud/.test(w)), `a sensitive cloud route warns: ${noLocal.warnings}`);

  // An assignment to a cloud provider still wins, but the warning is attached.
  const assignedCloud = resolveLiveRoute({ goal: "rotate my api key and update .env", lane: "coding", routingMode: "auto", current, assignments: { coding: { family: "anthropic", model: "claude-fable-5" } }, settings, env });
  assert.equal(assignedCloud.source, "assigned");
  assert.equal(assignedCloud.family, "anthropic");
  assert.ok(assignedCloud.warnings.some((w) => /sensitive data detected/.test(w)), assignedCloud.warnings.join("|"));
});

test("explore/summarize research is cost-aware: fast, cheap, local when available", () => {
  assert.equal(isExploreOrSummarizeGoal("summarize what this repo does"), true);
  assert.equal(isExploreOrSummarizeGoal("design a migration strategy for the auth service"), false);
  const t = laneTask("research", "give me a quick overview of the folder structure");
  assert.equal(t.kind, "summarization");
  assert.equal(t.cost, "cheap");
  const r = resolveLiveRoute({ goal: "give me a quick overview of the folder structure", lane: "research", routingMode: "auto", current, assignments: {}, settings, env });
  assert.equal(r.family, "ollama", "a skim goes to the free local model");
  assert.ok(r.reasons.some((x) => /cost-aware/.test(x)), r.reasons.join("|"));
  // Real planning research still wants the best model.
  const deep = resolveLiveRoute({ goal: "design a migration strategy for the auth service and weigh the trade-offs", lane: "research", routingMode: "auto", current, assignments: {}, settings, env });
  assert.equal(deep.family, "anthropic");
  // The OWNER's research assignment still wins even when the goal is scored as a summary.
  const owned = resolveLiveRoute({ goal: "give me a quick overview of the folder structure", lane: "research", routingMode: "auto", current, assignments: { research: { family: "anthropic", model: "claude-fable-5" } }, settings, env });
  assert.equal(owned.source, "assigned");
  assert.equal(owned.family, "anthropic");
});

test("sensitive-surface detection: credentials, identity, health, explicit requests", () => {
  assert.deepEqual(detectSensitiveSurface("paste this API key into the config").touches, ["credentials"]);
  assert.deepEqual(detectSensitiveSurface("my SSN is on the form").touches, ["user-data"]);
  assert.equal(detectSensitiveSurface("keep this local please, it's my medical history").sensitive, true);
  assert.equal(detectSensitiveSurface("write a haiku about autumn").sensitive, false);
});
