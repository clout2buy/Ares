// Image rung of microcompact — the "864k-token Browser turn" fix.
//
// Screenshots ride tool_results as base64 image blocks that are re-sent (and
// re-charged) on EVERY subsequent provider request, yet the whitelist text
// microcompact never touched them and friction telemetry never counted them.
// This suite proves: (1) images older than the last ARES_IMAGE_KEEP_ROUNDS
// tool rounds are cleared in place (placeholder text, image gone) while recent
// rounds keep full fidelity and tool_use/tool_result pairing stays valid;
// (2) ARES_IMAGE_KEEP_ROUNDS=0 disables the rung entirely; (3) tool_end events
// stamp image block/byte metrics and FrictionRecorder folds them into the
// per-turn line + summary aggregation.
//
// usage.inputTokens=0 keeps tokenScale pinned at 1.0 (calibration skips
// realPrompt<=0), so any threshold math stays deterministic.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FrictionRecorder, QueryEngine, summarizeFriction } from "../packages/core/dist/index.js";

const PLACEHOLDER = "[screenshot cleared to save context — re-take with the Browser/ComputerUse tool if needed]";
// 4000 base64 chars, no padding → 3000 decoded bytes per screenshot.
const IMAGE_DATA = "A".repeat(4000);
const IMAGE_BYTES = 3000;

/** Six single-tool rounds (Shot r0..r5), then an idle end_turn. */
function sixShotRoundsThenIdle() {
  let calls = 0;
  return {
    name: "img-mc-provider",
    async *stream() {
      calls += 1;
      if (calls <= 6) {
        const id = `r${calls - 1}`;
        yield { type: "tool_use_start", id, name: "Shot" };
        yield { type: "tool_use_input_done", id, input: {} };
        yield {
          type: "message_done",
          message: {
            id: `tools${calls}`,
            role: "assistant",
            content: [{ type: "tool_use", id, name: "Shot", input: {} }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "tool_use",
        };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "done", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
}

/** Fake screenshot tool: text output + one base64 image riding the result. */
const shotTool = {
  schema: { name: "Shot", description: "fake screenshot", inputJsonSchema: { type: "object", properties: {} }, safety: "read-only", concurrency: "parallel-safe" },
  async call() {
    return { output: "captured", images: [{ mediaType: "image/png", data: IMAGE_DATA }] };
  },
};

function makeEngine(sessionId) {
  return QueryEngine.forTesting(
    {
      provider: sixShotRoundsThenIdle(),
      model: "m",
      systemPrompt: "s",
      tools: [shotTool],
      workspace: process.platform === "win32" ? "D:\\Ares" : "/tmp",
      maxTurns: 10,
      // No compaction threshold on purpose: the image rung must run age-gated,
      // independent of the text rung's token watermark.
    },
    sessionId,
  );
}

function toolResultsById(engine) {
  const out = new Map();
  for (const m of engine.history()) {
    for (const b of m.content) if (b.type === "tool_result") out.set(b.tool_use_id, b);
  }
  return out;
}

/** Every tool_use has exactly one tool_result and vice versa — the invariant
 *  behind the bricked-session 400s. */
function assertPairingValid(engine) {
  const useIds = [];
  const resultIds = [];
  for (const m of engine.history()) {
    for (const b of m.content) {
      if (b.type === "tool_use") useIds.push(b.id);
      if (b.type === "tool_result") resultIds.push(b.tool_use_id);
    }
  }
  assert.deepEqual([...useIds].sort(), [...resultIds].sort(), "tool_use/tool_result pairing intact");
}

test("images older than the keep window are cleared; recent rounds keep full fidelity", async () => {
  delete process.env.ARES_IMAGE_KEEP_ROUNDS; // default 3
  const engine = makeEngine("sess_img_micro");
  engine.appendUserMessage("look around");
  const events = [];
  for await (const e of engine.streamTurn()) events.push(e);

  const results = toolResultsById(engine);
  assert.equal(results.size, 6, "six screenshot results recorded");

  for (const old of ["r0", "r1", "r2"]) {
    const content = results.get(old).content;
    assert.ok(Array.isArray(content), `${old} content stays an array (mutated in place)`);
    assert.equal(content.filter((b) => b.type === "image").length, 0, `${old} image gone`);
    assert.ok(
      content.some((b) => b.type === "text" && b.text === PLACEHOLDER),
      `${old} carries the re-take placeholder`,
    );
    // The original text block survives — only the image was cleared.
    assert.ok(content.some((b) => b.type === "text" && b.text.includes("captured")), `${old} text output untouched`);
  }
  for (const recent of ["r3", "r4", "r5"]) {
    const content = results.get(recent).content;
    assert.equal(content.filter((b) => b.type === "image").length, 1, `${recent} keeps its screenshot`);
    assert.equal(content.find((b) => b.type === "image").source.data, IMAGE_DATA, `${recent} image intact`);
  }
  assertPairingValid(engine);

  const reminder = events.find((e) => e.type === "system_reminder_injected" && /stale screenshot/.test(e.text));
  assert.ok(reminder, "microcompact reminder names the cleared screenshots");
  assert.equal(reminder.source, "compaction");
  assert.match(reminder.text, /KB image payload freed/, "cleared bytes ride the microcompact accounting line");
  const projection = events.find((e) => e.type === "compaction" && e.method === "micro");
  assert.ok(projection, "image clearing commits a durable micro projection");
  assert.ok(projection.tokensAfter < projection.tokensBefore, "projection reflects the shrink");
});

test("ARES_IMAGE_KEEP_ROUNDS=0 disables the image rung entirely", async () => {
  process.env.ARES_IMAGE_KEEP_ROUNDS = "0";
  try {
    const engine = makeEngine("sess_img_micro_off");
    engine.appendUserMessage("look around");
    const events = [];
    for await (const e of engine.streamTurn()) events.push(e);

    const results = toolResultsById(engine);
    assert.equal(results.size, 6);
    for (const id of ["r0", "r1", "r2", "r3", "r4", "r5"]) {
      assert.equal(
        results.get(id).content.filter((b) => b.type === "image").length,
        1,
        `${id} keeps its screenshot when the knob is 0`,
      );
    }
    assert.ok(
      !events.some((e) => e.type === "system_reminder_injected" && /stale screenshot/.test(e.text)),
      "no image-clearing reminder when disabled",
    );
    assertPairingValid(engine);
  } finally {
    delete process.env.ARES_IMAGE_KEEP_ROUNDS;
  }
});

test("ARES_IMAGE_KEEP_ROUNDS=1 keeps only the newest round", async () => {
  process.env.ARES_IMAGE_KEEP_ROUNDS = "1";
  try {
    const engine = makeEngine("sess_img_micro_keep1");
    engine.appendUserMessage("look around");
    for await (const _ of engine.streamTurn()) void _;
    const results = toolResultsById(engine);
    for (const old of ["r0", "r1", "r2", "r3", "r4"]) {
      assert.equal(results.get(old).content.filter((b) => b.type === "image").length, 0, `${old} cleared`);
    }
    assert.equal(results.get("r5").content.filter((b) => b.type === "image").length, 1, "current round never touched");
    assertPairingValid(engine);
  } finally {
    delete process.env.ARES_IMAGE_KEEP_ROUNDS;
  }
});

test("tool_end stamps image metrics and FrictionRecorder folds blocks/bytes into the turn line", async () => {
  delete process.env.ARES_IMAGE_KEEP_ROUNDS;
  const dir = await mkdtemp(path.join(tmpdir(), "ares-friction-img-"));
  try {
    const engine = makeEngine("sess_img_friction");
    engine.appendUserMessage("look around");
    const rec = new FrictionRecorder("sess_img_friction", dir);
    const toolEnds = [];
    for await (const e of engine.streamTurn()) {
      if (e.type === "tool_end") toolEnds.push(e);
      rec.record(e);
    }
    await rec.settle();

    assert.equal(toolEnds.length, 6);
    for (const e of toolEnds) {
      assert.deepEqual(e.images, { blocks: 1, approxBytes: IMAGE_BYTES }, "each screenshot call reports its payload");
    }

    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const line = JSON.parse((await readFile(path.join(dir, files[0]), "utf8")).trim());
    assert.deepEqual(line.images, { blocks: 6, approxBytes: 6 * IMAGE_BYTES }, "per-turn image tax recorded");

    const summary = await summarizeFriction(dir, 1);
    assert.equal(summary.images.blocks, 6, "summary aggregates image blocks");
    assert.equal(summary.images.approxBytes, 6 * IMAGE_BYTES, "summary aggregates image bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recorder falls back to scanning output for protocol-shaped image blocks; legacy rows read as zero", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-friction-img-scan-"));
  try {
    const rec = new FrictionRecorder("sess_img_scan", dir);
    rec.record({ type: "tool_use_start", id: "s1", name: "McpShot" });
    // No engine-stamped images field — the image block hides inside output.
    rec.record({
      type: "tool_end",
      id: "s1",
      output: { content: [{ type: "text", text: "ok" }, { type: "image", source: { kind: "base64", mediaType: "image/png", data: "B".repeat(400) } }] },
      durationMs: 5,
    });
    rec.record({ type: "turn_end", status: "completed", durationMs: 10, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } });
    await rec.settle();
    const files = await readdir(dir);
    const line = JSON.parse((await readFile(path.join(dir, files[0]), "utf8")).trim());
    assert.equal(line.images.blocks, 1, "output scan found the embedded image block");
    assert.equal(line.images.approxBytes, 300, "base64 length × 3/4");

    // Old readers / old rows: summarize must tolerate rows without images.
    const legacy = new FrictionRecorder("sess_img_legacy", dir);
    legacy.record({ type: "turn_end", status: "completed", durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } });
    await legacy.settle();
    const summary = await summarizeFriction(dir, 1);
    assert.equal(summary.turns, 2);
    assert.equal(summary.images.blocks, 1, "legacy rows fold in as zero, not NaN");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
