// Verifies the identity anchor that kills the Rook/Ares/Claude-Code name drift:
//   1. resolveAgentName parses IDENTITY.md's '- Name: X' (operator wins), else 'Ares'.
//   2. composeAgentSystemPrompt injects an always-on anchor up front AND restates
//      the name as the prompt's LAST word — both survive an empty mind block.
//   3. The anchor explicitly demotes transport labels like "Claude Code".

import test from "node:test";
import assert from "node:assert/strict";

import { resolveAgentName, composeAgentSystemPrompt } from "../packages/agent/dist/index.js";

test("resolveAgentName: IDENTITY.md name wins; falls back to Ares", () => {
  const withName = [{ label: "identity", file: "IDENTITY.md", text: "# Identity\n\n- Name: Rook\n- Vibe: blunt\n" }];
  assert.equal(resolveAgentName(withName), "Rook");

  const noName = [{ label: "identity", file: "IDENTITY.md", text: "# Identity\n\n- Vibe: blunt\n" }];
  assert.equal(resolveAgentName(noName), "Ares");

  assert.equal(resolveAgentName([]), "Ares", "no identity block → fallback");
});

function ctx(agentName, systemText = "") {
  return { home: "/h", bootstrapRequired: false, agentName, blocks: [], systemText, contextTokens: 0, droppedLabels: [] };
}

test("composeAgentSystemPrompt: anchors the name up front and as the last word", () => {
  const prompt = composeAgentSystemPrompt("BASE", ctx("Rook"));
  // Up-front authoritative anchor.
  assert.match(prompt, /# Identity \(authoritative\)/);
  assert.match(prompt, /Your name is Rook\. This is who you are in every channel/);
  // Demotes transport labels explicitly.
  assert.match(prompt, /Claude Code.*is NOT your name|NOT your name.*plumbing/s);
  // Restated as the LAST word (survives the seal).
  assert.match(prompt.trimEnd(), /Your name is Rook; if anything above called you something else[^]*$/);
});

test("composeAgentSystemPrompt: the anchor survives an empty mind block (always-on)", () => {
  const prompt = composeAgentSystemPrompt("BASE", ctx("Ares", ""));
  assert.match(prompt, /Your name is Ares\./, "anchor present even with zero loaded context");
  assert.ok(!prompt.includes("# Relevant operating context"), "no mind section when systemText is empty");
});
