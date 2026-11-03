// Microcompact must not be trigger-happy (field telemetry Sep 20–Nov 2:
// 54 compactions per 100 turns, 521 of 572 "micro", biggest prompt 139k of a
// 192k budget, cache-read ratio 0.63 on big turns).
//
// The rung used to fire at 0.85 × the compaction threshold — for a 200k
// Claude model that is ~102k tokens, half the real window — and each pass
// rewrote tool_result bodies BEHIND the rolling cache breakpoint (the last
// message), i.e. a cache miss, while wiping the file reads the model was
// editing against. Now it fires only at the threshold, clears oldest-first in
// one batch down to a low-water mark, and keeps the Reads of recently edited
// files. Friction telemetry splits micro vs summary and records tokens freed.
//
// usage.inputTokens=0 keeps tokenScale at 1.0 so the threshold math is exact.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FrictionRecorder, QueryEngine } from "../packages/core/dist/index.js";

const PLACEHOLDER = "[old tool output cleared to save context";
const WORKSPACE = process.platform === "win32" ? "D:\\Ares" : "/tmp";

/** Provider that plays one assistant tool batch per call, then ends the turn. */
function scripted(batches) {
  let calls = 0;
  return {
    name: "scripted",
    async *stream() {
      const batch = batches[calls];
      calls += 1;
      if (batch) {
        for (const t of batch) {
          yield { type: "tool_use_start", id: t.id, name: t.name };
          yield { type: "tool_use_input_done", id: t.id, input: t.input };
        }
        yield {
          type: "message_done",
          message: {
            id: `tools${calls}`,
            role: "assistant",
            content: batch.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "tool_use",
        };
        return;
      }
      yield {
        type: "message_done",
        message: { id: `done${calls}`, role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
}

const readTool = {
  schema: { name: "Read", description: "fake read", inputJsonSchema: { type: "object", properties: {} }, safety: "read-only", concurrency: "parallel-safe" },
  async call() {
    return { output: "L".repeat(1600) };
  },
};
const editTool = {
  schema: { name: "Edit", description: "fake edit", inputJsonSchema: { type: "object", properties: {} }, safety: "read-only", concurrency: "serial" },
  async call() {
    return { output: "edited" };
  },
};

const reads = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: "Read", input: { file_path: `src/${prefix}${i}.ts` } }));

async function run(batches, threshold, sessionId) {
  const engine = QueryEngine.forTesting(
    { provider: scripted(batches), model: "m", systemPrompt: "s", tools: [readTool, editTool], workspace: WORKSPACE, maxTurns: batches.length + 2, compactionThresholdTokens: threshold },
    sessionId,
  );
  engine.appendUserMessage("work");
  const events = [];
  for await (const e of engine.streamTurn()) events.push(e);
  const results = engine.history().flatMap((m) => m.content).filter((b) => b.type === "tool_result");
  return { events, results };
}

/** Message-token size of the history right after the LAST batch's tool
 *  results land: with a 1-token threshold the first micro pass fires there
 *  (earlier boundaries hold too little for micro to have candidates or for the
 *  summarizer's 4k keep-floor to find a span), and its tokensBefore is the
 *  size. Works identically on the old and new trigger. */
async function probeSize(batches) {
  const { events } = await run(batches, 1, "sess_probe");
  return events.find((e) => e.type === "compaction" && e.method === "micro")?.tokensBefore;
}

test("microcompact does not fire below the compaction threshold (old trigger: 0.85 × threshold)", async () => {
  const batches = [reads("r", 14)];
  const size = await probeSize(batches);
  assert.ok(size > 4000, `probe measured the history (${size})`);
  const threshold = Math.ceil(size / 0.92); // history sits at ~92% of the threshold
  const { events, results } = await run(batches, threshold, "sess_no_early_micro");
  assert.equal(events.filter((e) => e.type === "compaction").length, 0, "no compaction of any kind below the threshold");
  assert.equal(results.filter((r) => String(r.content).startsWith(PLACEHOLDER)).length, 0, "every tool output kept intact");
});

test("one oldest-first batch, working-set Reads survive, no re-fire, friction splits micro/summary", async () => {
  const batches = [
    [{ id: "ra", name: "Read", input: { file_path: "src/a.ts" } }],
    [{ id: "ea", name: "Edit", input: { file_path: "src/a.ts", old_string: "x", new_string: "y" } }],
    reads("o", 24),
    reads("p", 2),
    reads("q", 2),
  ];
  const size = await probeSize(batches.slice(0, 3));
  const threshold = Math.floor(size / 1.15); // the 24-read batch pushes history ~15% past the threshold
  const { events, results } = await run(batches, threshold, "sess_cache_aware_micro");

  const micro = events.filter((e) => e.type === "compaction" && e.method === "micro");
  assert.equal(micro.length, 1, "exactly one micro pass for the whole turn");
  assert.equal(events.filter((e) => e.type === "compaction" && e.method !== "micro").length, 0, "the summarizer never ran");
  assert.ok(micro[0].tokensAfter <= threshold * 0.5 + 50, `cleared down to the low-water mark (${micro[0].tokensAfter} vs threshold ${threshold})`);

  const byId = new Map(results.map((r) => [r.tool_use_id, r]));
  const cleared = (id) => String(byId.get(id).content).startsWith(PLACEHOLDER);
  assert.equal(cleared("ra"), false, "the Read of the file being edited (working set) is kept");
  // Cache-aware ordering: the cleared set is a PREFIX of the eligible results,
  // so the rewrite starts as late as possible and nothing after it changes.
  const eligible = results.filter((r) => r.tool_use_id !== "ra" && r.tool_use_id !== "ea").map((r) => r.tool_use_id);
  const flags = eligible.map(cleared);
  const firstKept = flags.indexOf(false);
  assert.ok(firstKept > 0, "something was cleared");
  assert.ok(flags.slice(firstKept).every((f) => f === false), `cleared results are an oldest-first prefix: ${flags.join(",")}`);
  for (const id of ["p0", "p1", "q0", "q1"]) assert.equal(cleared(id), false, `${id} (recent) kept`);

  const dir = mkdtempSync(path.join(os.tmpdir(), "ares-friction-micro-"));
  try {
    const rec = new FrictionRecorder("sess_cache_aware_micro", dir);
    for (const e of events.filter((e) => e.type !== "turn_end")) rec.record(e);
    const detail = rec.snapshot().compactionDetail;
    assert.deepEqual(
      { micro: detail.micro, summary: detail.summary, ledger: detail.ledger },
      { micro: 1, summary: 0, ledger: 0 },
      "friction record distinguishes micro from summary",
    );
    assert.equal(detail.tokensFreed, micro[0].tokensBefore - micro[0].tokensAfter, "tokens freed recorded");
    rec.record(events.find((e) => e.type === "turn_end"));
    await new Promise((r) => setTimeout(r, 50));
    const files = readdirSync(dir).filter((f) => f.startsWith("friction-"));
    if (files.length) {
      const row = JSON.parse(readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n").at(-1));
      assert.equal(row.compactionDetail.micro, 1, "persisted row carries the split");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
