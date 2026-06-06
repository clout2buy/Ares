// Verifies the Model Router foundation (Nexus Phase 1) — pure, explainable
// routing with no network/model calls.

import test from "node:test";
import assert from "node:assert/strict";

import { routeModel, DEFAULT_PROVIDER_PROFILES } from "../packages/core/dist/index.js";

const policy = (profiles = DEFAULT_PROVIDER_PROFILES) => ({ profiles });

test("router: a private low-risk summary routes local", () => {
  const d = routeModel({ kind: "summarization", privacy: "local-preferred", risk: "low" }, policy());
  assert.ok(d.selected);
  assert.equal(d.selected.locality, "local");
});

test("router: high-complexity planning routes cloud/best when cloud is allowed", () => {
  const d = routeModel({ kind: "planning" }, policy()); // defaults: quality best, privacy cloud-ok
  assert.ok(d.selected);
  assert.equal(d.selected.locality, "cloud");
  assert.equal(d.task.quality, "best");
});

test("router: returns a fallback, and skips an unavailable preferred provider", () => {
  const profiles = [
    { family: "ollama-cloud", label: "OC", locality: "cloud", private: false, costTier: 1, latencyTier: 1, available: false, capability: { strengths: ["planning"], ceiling: "best", maxContextTokens: 200000 } },
    { family: "openrouter", label: "OR", locality: "cloud", private: false, costTier: 2, latencyTier: 1, available: true, capability: { strengths: ["planning"], ceiling: "best", maxContextTokens: 200000 } },
    { family: "ollama-local", label: "OL", locality: "local", private: true, costTier: 0, latencyTier: 1, available: true, capability: { strengths: ["chat"], ceiling: "balanced", maxContextTokens: 32000 } },
  ];
  const d = routeModel({ kind: "planning" }, { profiles });
  assert.equal(d.selected.family, "openrouter", "unavailable ollama-cloud is skipped");
  assert.ok(d.fallback, "a fallback exists");
  assert.equal(d.fallback.locality, "local", "fallback prefers a different locality");
});

test("router: a sensitive task warns when the top route is cloud", () => {
  const d = routeModel({ kind: "planning", touches: ["credentials"] }, policy());
  assert.equal(d.selected.locality, "cloud"); // planning needs best; local can't reach it
  assert.ok(d.warnings.some((w) => w.includes("cloud")), "warns about cloud for a credentials task");
});

test("router: cost/quality preferences change the recommendation", () => {
  const cheap = routeModel({ kind: "chat", cost: "cheap", privacy: "cloud-ok" }, policy());
  const premium = routeModel({ kind: "chat", cost: "premium-ok", quality: "best", privacy: "cloud-ok" }, policy());
  assert.equal(cheap.selected.locality, "local", "cheap chat stays local");
  assert.equal(premium.selected.locality, "cloud", "premium best chat goes cloud");
});

test("router: a local-required task never routes cloud (and warns if none local)", () => {
  const cloudOnly = [
    { family: "openrouter", label: "OR", locality: "cloud", private: false, costTier: 2, latencyTier: 1, available: true, capability: { strengths: ["planning"], ceiling: "best" } },
  ];
  const d = routeModel({ kind: "planning", privacy: "local-required" }, { profiles: cloudOnly });
  assert.equal(d.selected, null);
  assert.ok(d.warnings.some((w) => /local/.test(w)));
});

test("router: an unknown task kind still gets a safe default route", () => {
  const d = routeModel({ kind: "frobnicate" }, policy());
  assert.ok(d.selected, "still returns a route");
  assert.ok(d.confidence >= 0);
});

test("router: output is deterministic for the same input", () => {
  const a = routeModel({ kind: "code", privacy: "local-preferred" }, policy());
  const b = routeModel({ kind: "code", privacy: "local-preferred" }, policy());
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("router: v1 decisions are advisory-only (never force a switch)", () => {
  const d = routeModel({ kind: "planning" }, policy());
  assert.equal(d.executable, false);
});

test("router: pure — inputs (task + profiles) are not mutated", () => {
  const task = { kind: "code", touches: ["files"] };
  const taskBefore = JSON.stringify(task);
  const profilesBefore = JSON.stringify(DEFAULT_PROVIDER_PROFILES);
  routeModel(task, policy());
  assert.equal(JSON.stringify(task), taskBefore);
  assert.equal(JSON.stringify(DEFAULT_PROVIDER_PROFILES), profilesBefore);
});
