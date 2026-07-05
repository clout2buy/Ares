// Click-geometry truth test — the zone math must land on the PIXELS the
// renderer actually paints (the old hardcoded zones were tuned for a layout
// that no longer exists; clicks landed "under, far" from the cards).
//
// Method: render the REAL provider screen (same wrapper the launcher uses),
// find each card's title text in the frame, and assert providerHitTest maps
// that exact (x, y) back to the right card index — empirical, rounding-proof.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { h, strip } from "./helpers.mjs";
import { SLATE } from "../../dist/ui/theme.js";
import { ProviderSelect, providerHitTest } from "../../dist/ui/ProviderSelect.js";

const PROVIDERS = [
  { id: "ares", title: "In-House", body: "The Ares account.", readiness: "oauth" },
  { id: "ollama", title: "Ollama Cloud", body: "Cloud and local.", readiness: "ready" },
  { id: "openai", title: "OpenAI", body: "Responses backend.", readiness: "oauth" },
  { id: "anthropic", title: "Anthropic", body: "Claude API models.", readiness: "needs-key" },
  { id: "deepseek", title: "DeepSeek", body: "Official DeepSeek.", readiness: "ready" },
  { id: "openrouter", title: "OpenRouter", body: "Any OpenRouter id.", readiness: "ready" },
];

function renderScreen(columns, rows, withVersion) {
  const { lastFrame } = render(
    h(
      Box,
      { flexDirection: "column", width: columns, height: rows, justifyContent: "center" },
      h(ProviderSelect, {
        theme: SLATE,
        providers: PROVIDERS,
        selectedIndex: 0,
        tick: 0,
        width: columns,
        version: withVersion ? "0.19.0" : undefined,
      }),
    ),
  );
  return strip(lastFrame() ?? "");
}

/** 1-based (x, y) of the first occurrence of `text` in the frame. */
function locate(frame, text) {
  const lines = frame.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].indexOf(text);
    if (col >= 0) return { x: col + 1, y: i + 1 };
  }
  return null;
}

for (const [columns, rows, withVersion] of [[100, 30, true], [120, 40, true], [90, 26, false]]) {
  test(`hit-test lands on every card title at ${columns}x${rows}${withVersion ? "" : " (no version line)"}`, () => {
    const frame = renderScreen(columns, rows, withVersion);
    for (const [i, p] of PROVIDERS.entries()) {
      const pos = locate(frame, p.title);
      assert.ok(pos, `${p.title} not found in frame`);
      const hit = providerHitTest(pos.x, pos.y, columns, rows, PROVIDERS.length, withVersion);
      assert.equal(hit, i, `clicking "${p.title}" at (${pos.x},${pos.y}) must select card ${i}, got ${hit}`);
    }
  });
}

test("hit-test rejects the gaps: logo, title line, dead space between rows", () => {
  const columns = 100, rows = 30;
  const frame = renderScreen(columns, rows, true);
  const logo = locate(frame, "█");
  assert.ok(logo);
  assert.equal(providerHitTest(logo.x, logo.y, columns, rows, PROVIDERS.length, true), null, "logo is not a card");
  const title = locate(frame, "Select a provider");
  assert.ok(title);
  assert.equal(providerHitTest(title.x, title.y, columns, rows, PROVIDERS.length, true), null, "title line is not a card");
  assert.equal(providerHitTest(1, 1, columns, rows, PROVIDERS.length, true), null, "top-left corner dead");
});
