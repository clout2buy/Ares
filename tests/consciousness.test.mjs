// Consciousness — pure-logic regression tests (no network, no model, no screen).
// Guards the decide/speak policy + vision-engine arg/clean helpers so the
// "mostly silent watcher" behavior can't silently regress.

import { test } from "node:test";
import assert from "node:assert/strict";

import { decideSpeak, jaccard } from "../packages/cli/dist/watch.js";
import { buildVisionArgs, cleanVisionOutput } from "../packages/cli/dist/visionEngine.js";
import { CONSCIOUSNESS_MODELS, modelsDir } from "../packages/cli/dist/consciousness.js";

const NOW = 1_000_000;

test("jaccard: identical = 1, disjoint = 0, partial in between", () => {
  assert.equal(jaccard("alpha beta gamma", "alpha beta gamma"), 1);
  assert.equal(jaccard("alpha beta", "gamma delta"), 0);
  const partial = jaccard("alpha beta gamma", "alpha beta delta");
  assert.ok(partial > 0 && partial < 1);
});

test("decideSpeak: speaks on a notable, changed screen after cooldown", () => {
  const state = { lastSpokeAt: 0, lastObservation: "" };
  const d = decideSpeak(state, "A terminal showing a failed test with an exception stack trace", NOW);
  assert.equal(d.speak, true);
});

test("decideSpeak: stays silent on a short / unremarkable read", () => {
  const d = decideSpeak({ lastSpokeAt: 0, lastObservation: "" }, "a window", NOW);
  assert.equal(d.speak, false);
  assert.equal(d.reason, "not notable");
});

test("decideSpeak: respects cooldown", () => {
  const d = decideSpeak(
    { lastSpokeAt: NOW - 1000, lastObservation: "" },
    "an exception was thrown while building the project again",
    NOW,
  );
  assert.equal(d.speak, false);
  assert.equal(d.reason, "cooldown");
});

test("decideSpeak: silent when the screen hasn't meaningfully changed", () => {
  const obs = "code editor open with a failed unit test and an exception trace";
  const d = decideSpeak({ lastSpokeAt: 0, lastObservation: obs }, obs, NOW);
  assert.equal(d.speak, false);
  assert.equal(d.reason, "nothing changed");
});

test("decideSpeak: empty observation never speaks", () => {
  assert.equal(decideSpeak({ lastSpokeAt: 0, lastObservation: "" }, "   ", NOW).speak, false);
});

test("buildVisionArgs: includes model, mmproj, image and the prompt flag", () => {
  const args = buildVisionArgs({ model: "m.gguf", mmproj: "p.gguf", ready: true }, "shot.png");
  assert.ok(args.includes("-m") && args[args.indexOf("-m") + 1] === "m.gguf");
  assert.ok(args.includes("--mmproj") && args[args.indexOf("--mmproj") + 1] === "p.gguf");
  assert.ok(args.includes("--image") && args[args.indexOf("--image") + 1] === "shot.png");
  assert.ok(args.includes("-p"));
});

test("cleanVisionOutput: strips llama.cpp diagnostics, keeps the description", () => {
  const raw = "llama_model_loader: loaded\nclip_init: ok\nmtmd_init: ok\nA code editor with a terminal showing a failing test.\nggml_backend: cpu";
  assert.equal(cleanVisionOutput(raw), "A code editor with a terminal showing a failing test.");
});

test("cleanVisionOutput: strips an echoed prompt when builds don't suppress it", () => {
  const prompt = "Describe what the user is doing.";
  const raw = `main: build\n${prompt} A browser open to a banking dashboard.`;
  assert.equal(cleanVisionOutput(raw, prompt), "A browser open to a banking dashboard.");
});

test("manifest: three models, models dir resolves under home", () => {
  assert.equal(CONSCIOUSNESS_MODELS.length, 3);
  assert.ok(CONSCIOUSNESS_MODELS.some((m) => m.role === "vision"));
  assert.ok(CONSCIOUSNESS_MODELS.some((m) => m.role === "vision-projector"));
  assert.ok(CONSCIOUSNESS_MODELS.some((m) => m.role === "embedding"));
  assert.ok(modelsDir("/home/x").replace(/\\/g, "/").endsWith("/home/x/models"));
});
