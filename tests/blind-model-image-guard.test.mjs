// A pasted image must never permanently kill a session on a text-only model.
//
// Field incident (sess_76b38ed3): a user on glm-5.2/ollama attached a
// screenshot mid-session. glm-5.2 is blind, the daemon's vision escalation had
// nothing to escalate TO (ollama was the only configured provider), and the
// image shipped anyway. Ollama rejected the request. Because the image stayed
// in history, EVERY later turn re-sent it and failed identically — the user
// typed "ares", "ares stop", "ares" into a dead session and got silence.
//
// The guard is at serialization time, so it also RETROACTIVELY heals a session
// that was already poisoned: history keeps the real image, the wire never sees
// it while a blind model is active.

import test from "node:test";
import assert from "node:assert/strict";
import {
  modelLikelyHasVision,
  stripImagesForBlindModel,
  historyHasImages,
} from "../packages/core/dist/index.js";

const IMAGE = {
  type: "image",
  source: { kind: "base64", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" },
};

/** The shape Mike's session was in: an image sitting in the middle of history. */
function poisonedHistory() {
  return [
    { id: "m1", role: "user", content: [{ type: "text", text: "ares my vm is a black screen" }], createdAt: "" },
    { id: "m2", role: "assistant", content: [{ type: "text", text: "let me look" }], createdAt: "" },
    { id: "m3", role: "user", content: [{ type: "text", text: "how do i fullscreen?" }, IMAGE], createdAt: "" },
    { id: "m4", role: "user", content: [{ type: "text", text: "where do i find wireshark etc" }], createdAt: "" },
  ];
}

test("glm-5.2 is correctly classified blind, and vision models are not", () => {
  assert.equal(modelLikelyHasVision("glm-5.2"), false, "glm-5.2 cannot see images");
  assert.equal(modelLikelyHasVision("deepseek-v4-pro"), false);
  assert.equal(modelLikelyHasVision("claude-opus-5"), true);
  assert.equal(modelLikelyHasVision("gpt-4o"), true);
  // Unknown ids default to blind — never ship pixels on a guess.
  assert.equal(modelLikelyHasVision("some-model-nobody-has-heard-of"), false);
});

test("the poisoned history is stripped of every image for a blind model", () => {
  const history = poisonedHistory();
  assert.equal(historyHasImages(history), true, "precondition: history carries the image");

  const outbound = stripImagesForBlindModel(history);
  assert.equal(historyHasImages(outbound), false, "no image block survives to the wire");
});

test("the user's own text on the image turn is preserved", () => {
  const outbound = stripImagesForBlindModel(poisonedHistory());
  const turn = outbound.find((m) => m.content.some((b) => b.type === "text" && b.text === "how do i fullscreen?"));
  assert.ok(turn, "the question survives — only the pixels are replaced");
});

test("the placeholder explains itself, so the model answers honestly instead of guessing", () => {
  const outbound = stripImagesForBlindModel(poisonedHistory());
  const placeholder = outbound
    .flatMap((m) => m.content)
    .find((b) => b.type === "text" && /cannot see images/.test(b.text));
  assert.ok(placeholder, "a self-describing placeholder replaced the image");
  assert.match(placeholder.text, /vision-capable/, "it names the way out for the user");
});

test("STORED history is untouched — the image comes back on a vision model", () => {
  const history = poisonedHistory();
  stripImagesForBlindModel(history);
  // This is what un-bricks the session non-destructively: the strip is a
  // rewrite of the OUTBOUND copy only. Switch to Claude and the pixels return.
  assert.equal(historyHasImages(history), true, "the real image is still in stored history");
  assert.deepEqual(history[2].content[1], IMAGE, "byte-identical, not degraded");
});

test("images inside tool_result blocks are stripped too (ComputerUse screenshots)", () => {
  const history = [
    {
      id: "m1",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "shot" }, IMAGE] }],
      createdAt: "",
    },
  ];
  assert.equal(historyHasImages(history), true);
  assert.equal(historyHasImages(stripImagesForBlindModel(history)), false);
});

test("an image-free history is returned untouched (no needless copying)", () => {
  const clean = [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "" }];
  assert.equal(stripImagesForBlindModel(clean), clean, "same reference — nothing to do");
});
