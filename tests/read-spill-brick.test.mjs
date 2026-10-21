// The 2026-10-21 bricked chat ("did u get bricked"): the owner asked Ares to
// rework a 340-line parkour.html. Read returned a ~40 KB page, the engine's
// 24k default budget spilled it to .ares/tool-results/<session>/<id>.txt as ONE
// line of JSON, and Read of that spill could only ever show its first 4,000
// chars ("1/1 lines"). The model could not see the file it had to rewrite, so
// the turn went nowhere until the owner hit Stop. Two guards:
//   1. Read is self-bounded (50 KB page, 4k-char lines), so the engine never
//      caps it again: a whole file Read stays inline.
//   2. Any spill is written in a form Read can page by line (the text body with
//      real newlines, or pretty JSON) — never one giant JSON line.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QueryEngine } from "../packages/core/dist/index.js";
import { ReadTool } from "../packages/tools/dist/index.js";

function toolThenDone(name, input) {
  let calls = 0;
  return {
    name: "spill-provider",
    async *stream() {
      calls += 1;
      if (calls > 1) {
        yield {
          type: "message_done",
          message: { id: "done", role: "assistant", content: [{ type: "text", text: "done" }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
        return;
      }
      yield { type: "tool_use_start", id: "t1", name };
      yield { type: "tool_use_input_done", id: "t1", input };
      yield {
        type: "message_done",
        message: {
          id: "tools",
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name, input }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      };
    },
  };
}

async function runOne(ws, sessionId, tool, input) {
  const engine = QueryEngine.forTesting(
    { provider: toolThenDone(tool.schema.name, input), model: "m", systemPrompt: "s", tools: [tool], workspace: ws, maxTurns: 2, fileReadStamps: new Map() },
    sessionId,
  );
  engine.appendUserMessage("go");
  for await (const _ of engine.streamTurn()) { /* drain */ }
  for (const m of engine.history()) {
    for (const b of m.content) if (b.type === "tool_result" && b.tool_use_id === "t1") return b;
  }
  return null;
}

/** A dense 340-line page like the parkour map: ~40 KB, over the 24k default. */
function parkourLike() {
  const lines = [];
  for (let i = 0; i < 340; i++) {
    lines.push(`  const part${i} = (w, h, d, m, x, y) => { const g = new THREE.Group(); g.position.set(x, y, "${i}"); return g; };`);
  }
  return lines.join("\n");
}

test("a whole-file Read over the engine's default budget stays inline (Read is self-bounded)", async () => {
  assert.equal(ReadTool.schema.maxResultSizeChars, 0);
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-read-spill-"));
  const source = parkourLike();
  assert.ok(source.length > 24_000, "fixture must exceed the 24k engine default");
  writeFileSync(path.join(ws, "parkour.html"), source);

  const r = await runOne(ws, "sess_read_inline", ReadTool, { file_path: "parkour.html" });
  assert.ok(r);
  assert.equal(typeof r.content, "string");
  assert.doesNotMatch(r.content, /tool result truncated for context/);
  assert.match(r.content, /part339/, "the last line of the file reaches the model");
});

test("a spilled structured result is written so Read can page it by line", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-read-spill-"));
  const body = parkourLike();
  const structured = {
    schema: {
      name: "Structured",
      description: "returns a Read-shaped object",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "read-only",
      concurrency: "parallel-safe",
      maxResultSizeChars: 2_000,
    },
    async call() {
      return { output: { path: "x", totalLines: 340, content: body, truncated: false } };
    },
  };
  const sessionId = "sess_read_spill";
  const r = await runOne(ws, sessionId, structured, {});
  assert.ok(r);
  assert.match(r.content, /FULL output saved to/);

  const spill = path.join(ws, ".ares", "tool-results", sessionId, "t1.txt");
  const onDisk = await readFile(spill, "utf8");
  assert.ok(onDisk.split("\n").length > 300, "spill keeps real newlines, not one JSON line");
  assert.ok(onDisk.includes(body), "the body is on disk verbatim");

  // The exact move from the bricked chat: Read the spill with offset/limit.
  const c = { workspace: ws, signal: new AbortController().signal, permissionMode: "workspace-write", fileReadStamps: new Map() };
  const page = await ReadTool.call({ file_path: spill, offset: 300, limit: 5 }, c);
  assert.match(page.output.content, /part29\d/);
  assert.doesNotMatch(page.output.content, /line truncated/);
});

test("plain string results still spill byte-for-byte", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-read-spill-"));
  const payload = "a\nb\n".repeat(400);
  const plain = {
    schema: {
      name: "Plain",
      description: "returns a string",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "read-only",
      concurrency: "parallel-safe",
      maxResultSizeChars: 100,
    },
    async call() {
      return { output: payload };
    },
  };
  const sessionId = "sess_plain_spill";
  await runOne(ws, sessionId, plain, {});
  const onDisk = await readFile(path.join(ws, ".ares", "tool-results", sessionId, "t1.txt"), "utf8");
  assert.equal(onDisk, payload);
});
