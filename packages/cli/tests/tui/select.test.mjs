// Phase 3 — provider grid + model picker snapshots.
import test from "node:test";
import assert from "node:assert/strict";
import { h, frame, strip, fg, bg } from "./helpers.mjs";

import { SLATE } from "../../dist/ui/theme.js";
import { ProviderSelect } from "../../dist/ui/ProviderSelect.js";
import { ModelSelect, modelWindow } from "../../dist/ui/ModelSelect.js";

const PROVIDERS = [
  { id: "ollama", title: "Ollama", body: "local + cloud", readiness: "ready" },
  { id: "openai", title: "OpenAI", body: "gpt-5.5", readiness: "oauth" },
  { id: "anthropic", title: "Anthropic", body: "claude", readiness: "needs-key" },
  { id: "deepseek", title: "DeepSeek", body: "v4-pro", readiness: "needs-key" },
  { id: "openrouter", title: "OpenRouter", body: "340 models", readiness: "ready" },
  { id: "mock", title: "Mock", body: "echo", readiness: "ready" },
];

test("ProviderSelect: renders all 6 cards in a grid with readiness dots", () => {
  const f = frame(h(ProviderSelect, { theme: SLATE, providers: PROVIDERS, selectedIndex: 0, tick: 0, width: 96, version: "0.15.0" }));
  const s = strip(f);
  for (const p of PROVIDERS) assert.match(s, new RegExp(p.title), `${p.title} card present`);
  assert.match(s, /● ready/, "ready dot");
  assert.match(s, /○ no key/, "needs-key dot");
  assert.match(s, /◐ sign in/, "oauth dot");
  assert.ok(f.includes(fg(SLATE.success)), "ready dot in success color");
  assert.ok(f.includes(fg(SLATE.danger)), "no-key dot in danger color");
  assert.match(s, /Select a provider/);
  assert.match(s, /v0\.15\.0/);
});

test("ProviderSelect: the selected card gets the surface bg + pulsing border", () => {
  const sel0 = frame(h(ProviderSelect, { theme: SLATE, providers: PROVIDERS, selectedIndex: 0, tick: 0, width: 96 }));
  assert.ok(sel0.includes(bg(SLATE.surface)), "selected card has surface bg");
  assert.ok(sel0.includes(fg(SLATE.primary)), "selected card border pulses primary at tick 0");
});

test("modelWindow: centers on selection, clamps at ends", () => {
  assert.deepEqual(modelWindow(5, 0, 12), { start: 0, end: 5 }, "all fit");
  assert.deepEqual(modelWindow(100, 0, 12), { start: 0, end: 12 }, "clamp start");
  assert.deepEqual(modelWindow(100, 99, 12), { start: 88, end: 100 }, "clamp end");
  const mid = modelWindow(100, 50, 12);
  assert.ok(mid.start <= 50 && mid.end > 50, "selection inside window");
});

test("ModelSelect: modal with search, windowed rows, ▲/▼ affordances", () => {
  const models = Array.from({ length: 40 }, (_, i) => ({ id: `vendor/model-${i}`, hint: `${i}k` }));
  const f = frame(h(ModelSelect, { theme: SLATE, title: "Select model", models, selectedIndex: 20, query: "mod", tick: 0 }));
  const s = strip(f);
  assert.match(s, /╴ Select model ╶/, "title tab");
  assert.match(s, /› mod/, "search query shown");
  assert.match(s, /▲ more above/, "more-above affordance");
  assert.match(s, /▼ more below/, "more-below affordance");
  assert.match(s, /model-20/, "the selected row is in the window");
  assert.match(s, /▸ model-20/, "selected row has the indicator");
  assert.doesNotMatch(s, /vendor\//, "id vendor prefix stripped in display");
});

test("ModelSelect: empty list shows a no-match line", () => {
  const s = strip(frame(h(ModelSelect, { theme: SLATE, title: "Select model", models: [], selectedIndex: 0, query: "zzz", tick: 0 })));
  assert.match(s, /no models match/);
});
