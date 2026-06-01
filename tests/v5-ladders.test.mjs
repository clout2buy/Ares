// Verifies O5 — the two ladders (figure out HOW, no hardcoded paths):
//   1. Method ladder picks the highest AVAILABLE rung and falls back when one
//      is missing (api → cli → browser → null).
//   2. acquire(): when nothing resolves, research + install registers a new
//      rung and the retry resolves to it.
//   3. Perception ladder: API > DOM > vision (vision is the last-resort fallback).
//   4. addMethod attaches rungs to a capability's ladder, deduped.

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveMethod,
  acquireMethod,
  routePerception,
  createCapability,
  addMethod,
} from "../packages/operator/dist/index.js";

function fakeEnv({ api = false, mcp = false, cli = false, skill = false, browser = false } = {}) {
  return {
    hasApiKey: async () => api,
    hasMcp: async () => mcp,
    hasCli: async () => cli,
    hasSkill: async () => skill,
    browserAvailable: async () => browser,
  };
}

// ── 1. method ladder + fallback ──────────────────────────────────────────────

test("method: picks the highest available rung and falls back as rungs disappear", async () => {
  const rungs = [
    { kind: "browser", ref: "playwright" },
    { kind: "api", ref: "stripe" },
    { kind: "cli", ref: "gh" },
  ];

  const all = await resolveMethod(rungs, fakeEnv({ api: true, cli: true, browser: true }));
  assert.equal(all.chosen.kind, "api", "API wins when available (highest rung)");
  assert.deepEqual(all.chain.map((r) => r.kind), ["api", "cli", "browser"], "chain is best→worst");

  const noApi = await resolveMethod(rungs, fakeEnv({ api: false, cli: true, browser: true }));
  assert.equal(noApi.chosen.kind, "cli", "no API key → fall to CLI");

  const onlyBrowser = await resolveMethod(rungs, fakeEnv({ browser: true }));
  assert.equal(onlyBrowser.chosen.kind, "browser", "nothing else → the universal browser fallback");

  const nothing = await resolveMethod(rungs, fakeEnv({}));
  assert.equal(nothing.chosen, null, "no rung available → must acquire");
  assert.equal(nothing.unavailable.length, 3);
});

// ── 2. acquire a missing rung ────────────────────────────────────────────────

test("acquire: research + install registers a new rung, and the retry resolves to it", async () => {
  const cap = createCapability({ id: "post-to-shopify", name: "post-to-shopify" });
  let installed = false;
  const env = {
    hasApiKey: async () => false,
    hasCli: async () => false,
    hasSkill: async () => false,
    browserAvailable: async () => false,
    hasMcp: async (ref) => installed && ref === "shopify-mcp",
  };

  const result = await acquireMethod(cap, {
    env,
    research: async () => [{ kind: "mcp", ref: "shopify-mcp" }], // figuring out HOW → candidate rungs
    install: async (rung) => {
      if (rung.ref === "shopify-mcp") {
        installed = true;
        return true;
      }
      return false;
    },
  });

  assert.equal(result.rung.kind, "mcp");
  assert.equal(result.rung.ref, "shopify-mcp");

  const retry = await resolveMethod(result.rungs, env);
  assert.equal(retry.chosen.kind, "mcp", "after acquiring, the capability now resolves");
});

test("acquire: returns null when research yields nothing installable", async () => {
  const cap = createCapability({ id: "impossible", name: "impossible" });
  const result = await acquireMethod(cap, {
    env: fakeEnv({}),
    research: async () => [{ kind: "cli", ref: "nonexistent-tool" }],
    install: async () => false, // can't install
  });
  assert.equal(result.rung, null);
});

// ── 3. perception ladder ─────────────────────────────────────────────────────

test("perception: API > DOM > vision", () => {
  assert.equal(routePerception({ hasApi: true, inAccessibilityTree: true }), "api");
  assert.equal(routePerception({ inAccessibilityTree: true }), "dom", "a form field in the a11y tree → DOM");
  assert.equal(routePerception({}), "vision", "a captcha (no api, not in tree) → vision");
});

// ── 4. attach methods to a capability ────────────────────────────────────────

test("capability: addMethod attaches rungs to the ladder, deduped by kind+ref", () => {
  let cap = createCapability({ id: "c", name: "c" });
  cap = addMethod(cap, { kind: "api", ref: "stripe" });
  cap = addMethod(cap, { kind: "api", ref: "stripe" }); // duplicate
  cap = addMethod(cap, { kind: "browser", ref: "playwright" });
  assert.equal(cap.methods.length, 2);
  assert.deepEqual(
    cap.methods.map((m) => m.kind).sort(),
    ["api", "browser"],
  );
});
