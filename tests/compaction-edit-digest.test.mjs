// Compaction keeps the HOW, not just the WHAT. The summarizer transcript used
// to clip every tool input to 1500 chars, so after compaction the agent knew
// a file changed but not how. Edit/Write/MultiEdit/ApplyPatch now render a
// diff digest that is never clipped; the general clip is ARES_COMPACT_CLIP_CHARS
// (default 1500) and always keeps the file path. DeepSeek's dialect needs the
// model's own thinking echoed on kept-suffix turns, so the transcript records
// reasoning on that dialect and the kept suffix keeps its thinking blocks.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Session } from "../packages/core/dist/index.js";
import {
  compactClipChars,
  dialectKeepsThinking,
  makeSpanSummarizer,
  renderSpanForSummary,
  renderToolUseDigest,
} from "../packages/cli/dist/entry/sessionFactory.js";

const msg = (role, content, id = `m_${Math.random().toString(36).slice(2, 8)}`) => ({ id, role, content, createdAt: "now" });
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}: ${"x".repeat(100)}`).join("\n");

test("Edit renders file + -/+ lines, trimmed to ~12 lines per side, never clipped by the general limit", () => {
  const oldText = lines(40, "old");
  const newText = lines(3, "new");
  const digest = renderToolUseDigest("Edit", { file_path: "src/engine/retry.ts", old_string: oldText, new_string: newText, replace_all: true });
  assert.match(digest, /^  → Edit src\/engine\/retry\.ts/);
  assert.equal(digest.split("\n").filter((l) => l.startsWith("    - old line")).length, 12, "12 removed lines shown");
  assert.match(digest, /- …\(28 more lines\)/);
  assert.equal(digest.split("\n").filter((l) => l.startsWith("    + new line")).length, 3);
  assert.match(digest, /\(replace_all\)/);
  // The same call through the transcript, with the smallest legal clip: the
  // digest survives intact while a generic tool's JSON would have been cut.
  const transcript = renderSpanForSummary([msg("assistant", [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/engine/retry.ts", old_string: oldText, new_string: newText } }])], { clipChars: 200 });
  assert.ok(transcript.length > 1_500, "the digest is not subject to the clip");
  assert.match(transcript, /src\/engine\/retry\.ts/);
  assert.equal(transcript.split("\n").filter((l) => l.startsWith("    - old line")).length, 12);
  assert.doesNotMatch(transcript, /more chars\]/, "no generic clip marker on a digest");
});

test("Write renders file + line count + first 8 lines; batch edits render per-hunk one-liners; ApplyPatch keeps file headers", () => {
  const write = renderToolUseDigest("Write", { file_path: "app/index.html", content: lines(30, "html") });
  assert.match(write, /^  → Write app\/index\.html \(30 lines, \d+ chars\)/);
  assert.equal(write.split("\n").filter((l) => l.startsWith("    + html line")).length, 8);
  assert.match(write, /\(22 more lines\)/);

  const batch = renderToolUseDigest("Edit", {
    file_path: "src/a.ts",
    edits: [
      { old_string: "const a = 1;\nmore", new_string: "const a = 2;\nmore" },
      { old_string: "foo()", new_string: "bar()" },
      { old_string: "big", new_string_from_file: "vendor/lib.js" },
    ],
  });
  assert.match(batch, /^  → Edit src\/a\.ts \(3 hunks\)/);
  assert.match(batch, /#1 - const a = 1;  \|  \+ const a = 2;/);
  assert.match(batch, /#2 - foo\(\)  \|  \+ bar\(\)/);
  assert.match(batch, /#3 - big  \|  \+ <contents of vendor\/lib\.js>/);
  assert.doesNotMatch(batch, /\nmore/, "one line per hunk");

  const patch = renderToolUseDigest("ApplyPatch", {
    patch: "*** Begin Patch\n*** Update File: src/b.ts\n@@ export function b\n-  return 1;\n+  return 2;\n*** Add File: src/c.ts\n+export const c = 3;\n*** End Patch\n",
  });
  assert.match(patch, /^  → ApplyPatch Update File: src\/b\.ts; Add File: src\/c\.ts/);
  assert.match(patch, /-  return 1;/);
  assert.match(patch, /\+  return 2;/);
  assert.doesNotMatch(patch, /Begin Patch/);

  assert.equal(renderToolUseDigest("Bash", { command: "ls" }), null, "non-mutating tools fall back to clipped JSON");
});

test("ARES_COMPACT_CLIP_CHARS sets the general clip; a clipped generic input still keeps its file path", () => {
  assert.equal(compactClipChars({}), 1500);
  assert.equal(compactClipChars({ ARES_COMPACT_CLIP_CHARS: "4000" }), 4000);
  assert.equal(compactClipChars({ ARES_COMPACT_CLIP_CHARS: "12" }), 1500, "absurd values fall back");
  assert.equal(compactClipChars({ ARES_COMPACT_CLIP_CHARS: "nope" }), 1500);

  const big = { file_path: "docs/notes.md", extra: "y".repeat(5_000) };
  const small = renderSpanForSummary([msg("assistant", [{ type: "tool_use", id: "t", name: "Read", input: big }])], { clipChars: 300 });
  assert.match(small, /more chars\]/, "generic JSON is clipped");
  assert.match(small, /\[file: docs\/notes\.md\]/, "…but the path is appended after the clip");
  const large = renderSpanForSummary([msg("assistant", [{ type: "tool_use", id: "t", name: "Read", input: big }])], { clipChars: 6_000 });
  assert.doesNotMatch(large, /more chars\]/);
  assert.doesNotMatch(large, /\[file:/, "no redundant path tag when nothing was clipped");
  const result = renderSpanForSummary([msg("user", [{ type: "tool_result", tool_use_id: "t", content: "z".repeat(2_000) }])], { clipChars: 500 });
  assert.match(result, /result: z{500}…\[1500 more chars\]/);
});

test("thinking is recorded in the transcript only for dialects that must echo it", () => {
  const span = [msg("assistant", [{ type: "thinking", text: "I should edit retry.ts first, then run the tests" }, { type: "text", text: "On it." }])];
  assert.match(renderSpanForSummary(span, { keepThinking: true }), /\(thinking\) I should edit retry\.ts first/);
  assert.doesNotMatch(renderSpanForSummary(span, { keepThinking: false }), /thinking/);
  assert.doesNotMatch(renderSpanForSummary(span), /thinking/, "default: not recorded");
  const adapter = { name: "anthropic", async *stream() {} };
  assert.equal(dialectKeepsThinking({ provider: adapter, model: "deepseek-v4-pro", source: "explicit:deepseek", family: "deepseek" }), true);
  assert.equal(dialectKeepsThinking({ provider: { ...adapter, name: "ollama-cloud:reasoner" }, model: "qwen3:8b", source: "explicit:ollama", family: "ollama" }), true);
  assert.equal(dialectKeepsThinking({ provider: adapter, model: "claude-fable-5", source: "explicit:anthropic", family: "anthropic" }), false);
});

test("DeepSeek dialect: the kept suffix after compaction retains its thinking blocks and the recap knew reasoning happened", { timeout: 30_000 }, async () => {
  const seen = { summarizerPrompt: null };
  // One fake adapter plays both roles: the side-query summarizer (recognised
  // by the compaction instructions) and the main turn.
  const provider = {
    name: "anthropic",
    async *stream(req) {
      const isSummarizer = /compacting a long/i.test(req.system ?? "");
      if (isSummarizer) {
        seen.summarizerPrompt = req.messages.map((m) => m.content.map((b) => b.text ?? "").join("\n")).join("\n");
      }
      const reply = isSummarizer ? "GOAL: keep going\nDONE: edited retry.ts (replaced the retry loop)\nSTATE: green\nOPEN: none\nFACTS: retry.ts" : "ok";
      yield { type: "text_delta", text: reply };
      yield {
        type: "message_done",
        message: { id: `a_${Date.now()}`, role: "assistant", content: [{ type: "text", text: reply }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  const selection = { provider, model: "deepseek-v4-pro", source: "explicit:deepseek", family: "deepseek" };
  const fat = (role, tag) => msg(role, [{ type: "text", text: "x".repeat(20_000) }], tag);
  // Old span: fat messages + an Edit with a real diff + reasoning. Recent
  // tail: a thinking block that MUST survive as a block, not as prose.
  const history = [
    fat("user", "u0"), fat("assistant", "a0"), fat("user", "u1"),
    msg("assistant", [
      { type: "thinking", text: "the retry loop double-counts attempts; replace it" },
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/retry.ts", old_string: "for (let i = 0; i <= max; i++) {", new_string: "for (let i = 0; i < max; i++) {" } },
    ], "a1"),
    msg("user", [{ type: "tool_result", tool_use_id: "t1", content: "edited src/retry.ts" }], "u2"),
    fat("assistant", "a2"), fat("user", "u3"), fat("assistant", "a3"),
    msg("assistant", [{ type: "thinking", text: "KEPT-SUFFIX-REASONING: tests next" }, { type: "text", text: "Running the tests now." }], "a4"),
    msg("user", [{ type: "text", text: "go on" }], "u4"),
  ];
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-compact-digest-"));
  const session = new Session({
    workspace,
    provider,
    model: selection.model,
    systemPrompt: "s",
    tools: [],
    initialMessages: history,
    compactionThresholdTokens: 3_000,
    summarizeSpan: makeSpanSummarizer(selection),
  });
  const events = [];
  for await (const e of session.send("continue")) events.push(e);
  const compaction = events.find((e) => e.type === "compaction");
  assert.ok(compaction, "a compaction happened");
  assert.equal(compaction.method, "summary", "the model-written recap was used");
  assert.ok(seen.summarizerPrompt, "the summarizer ran on the deepseek selection");
  assert.match(seen.summarizerPrompt, /→ Edit src\/retry\.ts/, "the transcript carried the edit digest");
  assert.match(seen.summarizerPrompt, /- for \(let i = 0; i <= max; i\+\+\) \{/);
  assert.match(seen.summarizerPrompt, /\+ for \(let i = 0; i < max; i\+\+\) \{/);
  assert.match(seen.summarizerPrompt, /\(thinking\) the retry loop double-counts attempts/, "reasoning presence recorded for the deepseek dialect");
  const kept = session.engine.history();
  const keptThinking = kept.flatMap((m) => m.content).filter((b) => b.type === "thinking");
  assert.ok(keptThinking.some((b) => /KEPT-SUFFIX-REASONING/.test(b.text)), "the kept suffix still carries its thinking block as a block");
});
