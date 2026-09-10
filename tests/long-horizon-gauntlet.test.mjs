// Long-horizon coding gauntlet — the "good at first, worse over time" test.
//
// Drives a REAL QueryEngine through a multi-turn coding session with a scripted
// provider and fake tools, sized so the run crosses BOTH context-maintenance
// rungs (microcompact, then heavy compaction) and keeps working afterwards.
// It pins the mechanisms that field forensics showed decaying in long sessions:
//
//   • old shell/read output is cleared (microcompact), never re-sent whole
//   • heavy compaction produces a recap that names the files the model EDITED
//     in the summarized span but cannot see any more — the re-read nudge that
//     stops blind post-compaction edits (46 of 49 Edit failures in the field)
//   • files that still exist on disk are pinned with their CURRENT bytes
//   • keyed steady-state reminders never stack: at most one live copy per key
//     in any outbound request, even across compaction
//   • every outbound request stays bounded — the prompt never runs away
//   • the session keeps executing edits after compaction (no bricking)
//
// usage.inputTokens=0 pins tokenScale at 1.0 so the threshold math is exact.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { QueryEngine } from "../packages/core/dist/index.js";

const PLACEHOLDER = "[old tool output cleared to save context";
const BASH_OUT = (i) => `$ run step ${i}\n` + `log line ${i} `.repeat(220) + "\nexit 0";
const ESSAY = (i) => `Analysis pass ${i}: ` + "reasoning about the refactor in detail ".repeat(140);

function fakeTool(name, safety, make) {
  return {
    schema: {
      name,
      description: `fake ${name}`,
      inputJsonSchema: { type: "object", properties: {}, additionalProperties: true },
      safety,
      concurrency: safety === "read-only" ? "parallel-safe" : "exclusive",
    },
    async call(input) {
      return make(input);
    },
  };
}

const tools = [
  fakeTool("Bash", "read-only", (i) => ({ output: BASH_OUT(i.step ?? 0) })),
  fakeTool("Read", "read-only", (i) => ({ output: `1\tconst a = 1; // ${i.file_path}\n2\texport default a;\n` })),
  fakeTool("Edit", "workspace-write", (i) => ({ output: `edited ${i.file_path}`, touchedFiles: [i.file_path] })),
  fakeTool("Write", "workspace-write", (i) => ({ output: `wrote ${i.file_path}`, touchedFiles: [i.file_path] })),
];

let seq = 0;
const use = (name, input) => ({ type: "tool_use", id: `t${++seq}`, name, input });

/** A scripted provider: every assistant round is a list of blocks; a round
 *  with tool_use blocks stops for tools, a text-only round ends the turn. */
function scriptedProvider(script, onRequest) {
  let round = 0;
  return {
    name: "gauntlet-provider",
    async *stream(req) {
      onRequest(req);
      const blocks = script[Math.min(round, script.length - 1)];
      round += 1;
      const hasTools = blocks.some((b) => b.type === "tool_use");
      for (const b of blocks) {
        if (b.type === "tool_use") {
          yield { type: "tool_use_start", id: b.id, name: b.name };
          yield { type: "tool_use_input_done", id: b.id, input: b.input };
        }
      }
      yield {
        type: "message_done",
        message: { id: `a${round}`, role: "assistant", content: blocks, createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: hasTools ? "tool_use" : "end_turn",
      };
    },
  };
}

function reminderCopies(messages, key) {
  let n = 0;
  for (const m of messages) for (const b of m.content ?? []) if (b.type === "system_reminder" && b.key === key) n += 1;
  return n;
}

function approxTokens(req) {
  return Math.round(JSON.stringify(req.messages).length / 4);
}

test("long-horizon gauntlet: survives micro + heavy compaction and still edits safely", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-long-horizon-"));
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  // a.ts exists on disk → gets PINNED with live bytes. c.ts is never written to
  // disk → cannot be pinned → must be named by the re-read nudge.
  writeFileSync(path.join(workspace, "src", "a.ts"), "export const LIVE_BYTES_ON_DISK = 42;\n", "utf8");

  const bashRound = (base, extra = []) => [
    { type: "text", text: ESSAY(base) },
    ...Array.from({ length: 6 }, (_, i) => use("Bash", { command: `step ${base + i}`, step: base + i })),
    ...extra,
  ];

  const script = [
    // turn 1 — three tool rounds: heavy shell output + edits, then done
    bashRound(0, [use("Edit", { file_path: "src/a.ts", old_string: "1", new_string: "2" })]),
    bashRound(10, [use("Write", { file_path: "src/c.ts", content: "x" })]),
    bashRound(20, [use("Edit", { file_path: "src/c.ts", old_string: "x", new_string: "y" })]),
    [{ type: "text", text: "turn one done" }],
    // turn 2 — more shell output and an edit
    bashRound(30, [use("Edit", { file_path: "src/c.ts", old_string: "y", new_string: "z" })]),
    bashRound(40),
    [{ type: "text", text: "turn two done" }],
    // turn 3 — after compaction: read the region, then edit
    [use("Read", { file_path: "src/c.ts", offset: 1, limit: 40 }), use("Edit", { file_path: "src/c.ts", old_string: "z", new_string: "w" })],
    [{ type: "text", text: "turn three done" }],
    [{ type: "text", text: "idle" }],
  ];

  const requests = [];
  const provider = scriptedProvider(script, (req) => requests.push({ messages: req.messages, tokens: approxTokens(req) }));

  let summarizerCalls = 0;
  let turnNo = 0;
  const THRESHOLD = 9_000;
  const engine = QueryEngine.forTesting(
    {
      provider,
      model: "m",
      systemPrompt: "s",
      tools,
      workspace,
      maxTurns: 8,
      compactionThresholdTokens: THRESHOLD,
      summarizeSpan: async () => {
        summarizerCalls += 1;
        return [
          "1. PRIMARY REQUEST & INTENT: ship the feature.",
          "2. CONSTRAINTS: do not touch the input system.",
          "4. FILES & CODE: src/a.ts, src/c.ts edited.",
          "9. CURRENT WORK: editing src/c.ts.",
          "10. NEXT STEP: continue.",
        ].join("\n");
      },
      drainSystemReminders: () => [{ text: `CODING STATE: turn ${turnNo}`, source: "instructions", key: "coding-state" }],
    },
    "sess_long_horizon",
  );

  const events = [];
  for (const ask of ["build the feature", "continue", "finish it", "status?"]) {
    turnNo += 1;
    engine.appendUserMessage(ask);
    for await (const e of engine.streamTurn()) events.push(e);
  }

  if (process.env.GAUNTLET_DEBUG) {
    for (const c of events.filter((e) => e.type === "compaction")) console.log("COMPACTION", c.method, c.summarizedMessages, (c.messages?.[0]?.content?.[0]?.text ?? "").slice(0, 700).replaceAll("\n", " | "));
    console.log("REQ tokens", requests.map((r) => r.tokens).join(","));
  }
  // 1. both maintenance rungs fired
  const micro = events.filter((e) => e.type === "system_reminder_injected" && /microcompacted/.test(e.text));
  assert.ok(micro.length >= 1, "microcompact cleared old shell output at least once");
  const compactions = events.filter((e) => e.type === "compaction" && e.method !== "micro");
  assert.ok(compactions.length >= 1, "heavy compaction fired");
  assert.equal(compactions[0].method, "summary");
  assert.ok(summarizerCalls >= 1, "the host summarizer was used");

  // 2. recaps pin on-disk files with LIVE bytes and name the unpinned edited file.
  // Compaction fires several times across the run, each over a different span,
  // so the guarantees are checked across ALL recaps: every recap carries the
  // summary sections; a.ts (on disk) is pinned in the recap whose span edited
  // it; c.ts (edited, never on disk) is named by the re-read nudge in the recap
  // whose span edited it; a pinned file is never also in the nudge list.
  const recaps = compactions.map((c) => c.messages?.[0]?.content?.[0]).filter((b) => b && b.type === "system_reminder" && /^Compacted memory/.test(b.text)).map((b) => b.text);
  assert.equal(recaps.length, compactions.length, "every compaction event carries its recap first");
  assert.ok(engine.history().some((m) => m.content.some((b) => b.type === "system_reminder" && /^Compacted memory/.test(b.text))), "a recap leads history after compaction");
  for (const r of recaps) assert.match(r, /PRIMARY REQUEST & INTENT/, "summary sections carried into every recap");
  assert.ok(recaps.some((r) => /CURRENT content of src\/a\.ts[\s\S]*LIVE_BYTES_ON_DISK/.test(r)), "a.ts is pinned with its current bytes");
  const nudgeLine = (r) => (r.split("\n").find((l) => l.startsWith("FILES YOU EDITED BEFORE COMPACTION")) ?? "");
  assert.ok(recaps.some((r) => nudgeLine(r).includes("src/c.ts")), "c.ts (edited, not pinnable) is named by the re-read nudge");
  for (const r of recaps) {
    assert.ok(!nudgeLine(r).includes("src/a.ts"), "a pinned file is never in the nudge list");
    if (/FILES YOU EDITED BEFORE COMPACTION/.test(r)) assert.match(r, /Read the region you are about to change/);
  }

  // 3. keyed reminders never stack — in ANY outbound request, incl. after compaction
  for (const [i, r] of requests.entries()) {
    assert.ok(reminderCopies(r.messages, "coding-state") <= 1, `request ${i}: at most one live coding-state reminder`);
  }
  const last = requests.at(-1);
  assert.equal(reminderCopies(last.messages, "coding-state"), 1, "the newest reminder is present in the final request");
  const lastReminder = last.messages.flatMap((m) => m.content).find((b) => b.type === "system_reminder" && b.key === "coding-state");
  assert.match(lastReminder.text, /turn 4/, "the live copy is the NEWEST one");

  // 4. old shell output is placeholders, not re-sent bodies
  // (checked on the OUTBOUND requests: by the end heavy compaction has folded
  // the placeholders themselves into a recap, which is the point)
  const clearedPerRequest = requests.map((r) => r.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result" && typeof b.content === "string" && b.content.startsWith(PLACEHOLDER)).length);
  assert.ok(Math.max(...clearedPerRequest) >= 6, `old Bash results were sent as placeholders (per request: ${clearedPerRequest.join(",")})`);
  for (const r of requests) {
    const fullBodies = r.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result" && typeof b.content === "string" && b.content.startsWith("$ run step")).length;
    assert.ok(fullBodies <= 12, `no request re-sends more than two rounds of full shell output (got ${fullBodies})`);
  }

  // 5. the prompt never runs away: every request stays inside ~1.6× threshold
  const peak = Math.max(...requests.map((r) => r.tokens));
  assert.ok(peak < THRESHOLD * 1.6, `peak request ${peak} tokens stays bounded (threshold ${THRESHOLD})`);
  const first = requests[0].tokens;
  assert.ok(last.tokens < THRESHOLD, `final request (${last.tokens}) is under threshold after 4 turns (first was ${first})`);

  // 6. the post-compaction edit went through — no error events, no bricking
  const errors = events.filter((e) => e.type === "error");
  assert.equal(errors.length, 0, `no error events: ${JSON.stringify(errors.map((e) => e.error?.message)).slice(0, 300)}`);
  const postEdit = engine.history().flatMap((m) => m.content).filter((b) => b.type === "tool_result" && typeof b.content === "string" && /edited src\/c\.ts/.test(b.content));
  assert.ok(postEdit.length >= 1, "the edit after compaction produced a normal result");
  assert.equal(events.filter((e) => e.type === "turn_end").length, 4, "all four turns completed");
});
