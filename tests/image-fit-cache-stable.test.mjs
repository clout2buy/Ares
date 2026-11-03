// Live test 2026-11-03: one turn re-billed ~506k fresh input tokens. The wire
// log showed fitImagesToBudget (a per-request, on-a-copy fit to the image
// payload cap) keeping only the newest K images: every new screenshot pushed one
// more old image to a placeholder, and a wobble pulled one back, each time
// rewriting history behind the rolling cache point. Drops now persist in one
// batch down to a low-water mark, so a screenshot loop breaks the cache rarely.

import test from "node:test";
import assert from "node:assert/strict";

// 3000 decoded bytes per shot; cap of 10k bytes means at most 3 fit.
process.env.ARES_MAX_IMAGE_PAYLOAD_BYTES = "10000";
process.env.ARES_IMAGE_KEEP_ROUNDS = "0"; // isolate the fit from age-based clearing
const { QueryEngine } = await import("../packages/core/dist/index.js");

const IMAGE_DATA = "A".repeat(4000);
const ROUNDS = 12;

function recordingProvider(requests) {
  let calls = 0;
  return {
    name: "fit-recorder",
    async *stream(req) {
      calls += 1;
      // Which tool results still carry their image, in this request.
      const withImage = new Set();
      for (const m of req.messages) for (const b of m.content) {
        if (b.type === "tool_result" && Array.isArray(b.content) && b.content.some((c) => c.type === "image")) withImage.add(b.tool_use_id);
      }
      requests.push(withImage);
      if (calls <= ROUNDS) {
        const id = `r${calls - 1}`;
        yield { type: "tool_use_start", id, name: "Shot" };
        yield { type: "tool_use_input_done", id, input: { n: calls } };
        yield { type: "message_done", message: { id: `m${calls}`, role: "assistant", content: [{ type: "tool_use", id, name: "Shot", input: { n: calls } }], createdAt: new Date().toISOString() }, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "tool_use" };
        return;
      }
      yield { type: "message_done", message: { id: "done", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() }, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" };
    },
  };
}

const shotTool = {
  schema: { name: "Shot", description: "fake screenshot", inputJsonSchema: { type: "object", properties: {} }, safety: "read-only", concurrency: "parallel-safe" },
  async call() { return { output: "captured", images: [{ mediaType: "image/png", data: IMAGE_DATA }] }; },
};

test("a screenshot loop past the payload cap rewrites old history in rare batches, never per request, and never brings an image back", async () => {
  const requests = [];
  const engine = QueryEngine.forTesting({
    provider: recordingProvider(requests),
    model: "claude-opus-5-5", // a vision model: a text-only one strips images before the wire
    systemPrompt: "s",
    tools: [shotTool],
    workspace: process.platform === "win32" ? "D:\\Ares" : "/tmp",
    maxTurns: ROUNDS + 4,
  }, "sess_fit_stable");
  engine.appendUserMessage("take screenshots");
  for await (const _ of engine.streamTurn()) { /* drain */ }

  let rewrites = 0;
  for (let i = 1; i < requests.length; i++) {
    const lost = [...requests[i - 1]].filter((id) => !requests[i].has(id));
    const regained = [...requests[i]].filter((id) => !requests[i - 1].has(id) && Number(id.slice(1)) < i - 1);
    assert.deepEqual(regained, [], `request ${i}: an image dropped earlier must never come back (${regained})`);
    if (lost.length) rewrites++;
  }
  // 12 shots into a 3-image cap: the old per-request fit rewrote history on
  // ~9 requests; batched persistence needs only a few.
  assert.ok(rewrites <= 4, `history rewritten on ${rewrites} requests; expected rare batches`);
  for (const r of requests) assert.ok(r.size <= 3, "never over the payload cap");
  assert.ok(requests.at(-1).has(`r${ROUNDS - 1}`), "the newest screenshot is always kept");
});
