// Field report 2026-09-09 (verify subagent, ollama-cloud glm-5.2): the engine
// re-learned the provider's ~85k ceiling on every resume, burned 90s stall
// watchdogs at each oversized rung, and a birth-conversation bootstrap was
// injected into the child on "ares continue". Three fixes, each pinned here:
//  1. Learned ceilings persist per provider+model and seed the next engine so
//     the ladder starts at a rung that fits (no rejection round trip).
//  2. The pre-output stall window scales with prompt size.
//  3. A session whose id starts with agent_ is a subagent even when resumed
//     as a chat: no identity/memory injection, no witness.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const {
  QueryEngine,
  streamIdleMs,
  loadContextCeiling,
  rememberContextCeiling,
  forgetContextCeiling,
  contextCeilingsFile,
  CONTEXT_CEILING_TTL_MS,
} = await import("../packages/core/dist/index.js");
const { isSubagentSession } = await import("../packages/cli/dist/entry/turnPipeline.js");

const now = () => new Date().toISOString();

// ── 1a. the store ───────────────────────────────────────────────────────────

test("context ceilings: remember, load, lower-wins, expiry, floor, forget", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-ceil-"));
  try {
    assert.equal(await loadContextCeiling("ollama-cloud:reasoner", "glm-5.2", { home }), null);
    assert.equal(await rememberContextCeiling("ollama-cloud:reasoner", "glm-5.2", 85_000, { home, evidence: "rejected at 128k" }), 85_000);
    assert.equal(await loadContextCeiling("Ollama-Cloud:Reasoner", "GLM-5.2", { home }), 85_000, "key is case-insensitive");
    // evidence only tightens
    assert.equal(await rememberContextCeiling("ollama-cloud:reasoner", "glm-5.2", 120_000, { home }), 85_000);
    assert.equal(await rememberContextCeiling("ollama-cloud:reasoner", "glm-5.2", 64_000, { home }), 64_000);
    // a different model is unaffected
    assert.equal(await loadContextCeiling("ollama-cloud:reasoner", "glm-5.1", { home }), null);
    // below the floor is never stored
    assert.equal(await rememberContextCeiling("x", "tiny", 8_000, { home }), 8_000);
    assert.equal(await loadContextCeiling("x", "tiny", { home }), null);
    // expiry: a stale entry reads as unknown, and a fresh remember replaces it
    const later = Date.now() + CONTEXT_CEILING_TTL_MS + 1;
    assert.equal(await loadContextCeiling("ollama-cloud:reasoner", "glm-5.2", { home, now: later }), null);
    assert.equal(await rememberContextCeiling("ollama-cloud:reasoner", "glm-5.2", 100_000, { home, now: later }), 100_000, "expired lower value does not win");
    const file = JSON.parse(await readFile(contextCeilingsFile(home), "utf8"));
    assert.equal(file.version, 1);
    assert.ok(file.entries["ollama-cloud:reasoner::glm-5.2"].learnedAt);
    assert.equal(await forgetContextCeiling("ollama-cloud:reasoner", "glm-5.2", { home }), true);
    assert.equal(await loadContextCeiling("ollama-cloud:reasoner", "glm-5.2", { home }), null);
    // a corrupt file is "empty", never a thrown turn
    await rm(contextCeilingsFile(home));
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(contextCeilingsFile(home)), { recursive: true });
    await writeFile(contextCeilingsFile(home), "{not json", "utf8");
    assert.equal(await loadContextCeiling("a", "b", { home }), null);
    assert.equal(await rememberContextCeiling("a", "b", 50_000, { home }), 50_000);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── 1b. the engine: learn once, start under the ceiling next time ───────────

/** Rejects any request whose messages total more than `maxChars`; else answers. */
function ceilingProvider(maxChars) {
  let calls = 0;
  const sizes = [];
  return {
    name: "ceiling-mock",
    calls: () => calls,
    sizes: () => sizes,
    async *stream(req) {
      calls++;
      const chars = req.messages.reduce((s, m) => s + JSON.stringify(m.content).length, 0);
      sizes.push(chars);
      if (chars > maxChars) {
        yield { type: "error", error: { code: "context_length_exceeded", message: "prompt is too long for this model", retriable: false } };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "a1", role: "assistant", content: [{ type: "text", text: "fits" }], createdAt: now() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function bigHistory(pairs, charsPer) {
  const msgs = [];
  for (let i = 0; i < pairs; i++) {
    msgs.push({ id: `u${i}`, role: "user", content: [{ type: "text", text: `user ${i} ` + "x".repeat(charsPer) }], createdAt: now() });
    msgs.push({ id: `a${i}`, role: "assistant", content: [{ type: "text", text: `assistant ${i} ` + "y".repeat(charsPer) }], createdAt: now() });
  }
  return msgs;
}

async function runWith(provider, extra) {
  const engine = QueryEngine.forTesting(
    { provider, model: "glm-5.2", systemPrompt: "t", tools: [], workspace: "D:\\Ares", maxTurns: 2, contextBudgetTokens: 128_000, ...extra },
    "sess_ceiling",
  );
  // ~75k estimated tokens of history: the 128k rung sends it all, the 64k rung trims.
  engine.hydrate(bigHistory(15, 10_000));
  engine.appendUserMessage("continue");
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
}

test("engine: a rejected rung teaches the ceiling to the host; a seeded ceiling skips the rejection", async () => {
  const learned = [];
  const p1 = ceilingProvider(260_000);
  const ev1 = await runWith(p1, { onContextCeilingLearned: (t) => learned.push(t) });
  assert.ok(ev1.some((e) => e.type === "system_reminder_injected" && /rejected the prompt as too large/.test(e.text)), "first session hits the rejection");
  assert.equal(p1.calls(), 2, "one rejection, one fit");
  // The learned ceiling is the LARGER of the rung that fit and 90% of the
  // refused prompt — a refusal at 75k must not teach "64k" and strand 11k of
  // window for the rest of the session (long-project decay fix).
  assert.equal(learned.length, 1, "the host is told once");
  assert.ok(learned[0] >= 64_000 && learned[0] < 260_000, `learned ceiling ${learned[0]} is at least the rung that fit`);
  const taught = learned[0];
  assert.ok(ev1.some((e) => e.type === "turn_end" && e.status === "completed"));

  const p2 = ceilingProvider(260_000);
  const ev2 = await runWith(p2, { knownContextCeilingTokens: taught, onContextCeilingLearned: (t) => learned.push(t) });
  assert.equal(p2.calls(), 1, "seeded ceiling: the ladder starts at a rung that fits");
  assert.ok(!ev2.some((e) => e.type === "system_reminder_injected" && /rejected the prompt/.test(e.text)));
  assert.deepEqual(learned, [taught], "nothing new learned");
  assert.ok(p2.sizes()[0] <= 260_000);

  // a ceiling below the floor is ignored, never trusted
  const p3 = ceilingProvider(260_000);
  await runWith(p3, { knownContextCeilingTokens: 8_000 });
  assert.equal(p3.calls(), 2, "an implausible seed does not shrink the prompt");
});

// ── 2. the stall window ─────────────────────────────────────────────────────

test("stall window: flat 90s for small prompts, grows with prefill size, capped", () => {
  const prevBase = process.env.ARES_STREAM_IDLE_MS;
  const prevMax = process.env.ARES_STREAM_IDLE_MAX_MS;
  delete process.env.ARES_STREAM_IDLE_MS;
  delete process.env.ARES_STREAM_IDLE_MAX_MS;
  try {
    assert.equal(streamIdleMs(), 90_000);
    assert.equal(streamIdleMs(16_000), 90_000);
    assert.equal(streamIdleMs(85_000), 90_000 + 69 * 1_200, "the field report's prompt gets ~173s, not 90s");
    assert.equal(streamIdleMs(42_000), 90_000 + 26 * 1_200);
    assert.equal(streamIdleMs(1_000_000), 300_000, "capped at five minutes");
    process.env.ARES_STREAM_IDLE_MS = "30000";
    process.env.ARES_STREAM_IDLE_MAX_MS = "60000";
    assert.equal(streamIdleMs(0), 30_000);
    assert.equal(streamIdleMs(200_000), 60_000);
  } finally {
    if (prevBase === undefined) delete process.env.ARES_STREAM_IDLE_MS;
    else process.env.ARES_STREAM_IDLE_MS = prevBase;
    if (prevMax === undefined) delete process.env.ARES_STREAM_IDLE_MAX_MS;
    else process.env.ARES_STREAM_IDLE_MAX_MS = prevMax;
  }
});

// ── 3. subagent gating ──────────────────────────────────────────────────────

test("subagent sessions stay subagents when resumed as a chat", () => {
  assert.equal(isSubagentSession({ session: { meta: { id: "agent_b5451aa614e4e80d34d2446d0eec87c3" } } }), true);
  assert.equal(isSubagentSession({ session: { meta: { id: "sess_a56e9446-cf7f-439e-a854-17de880c6810" } } }), false);
});
