import test from "node:test";
import assert from "node:assert/strict";

import { buildForegroundReminder, classifyUserIntent } from "../packages/mind/dist/index.js";

test("intent governor: greeting/status checks stay low-signal", () => {
  const intent = classifyUserIntent("hey homie u working lmao?");
  assert.equal(intent.kind, "status_check");
  assert.equal(intent.lowSignal, true);
  assert.equal(intent.shouldRecall, false);
  assert.equal(intent.shouldCapture, false);
});

test("intent governor: architecture questions recall without becoming housekeeping", () => {
  const intent = classifyUserIntent("what do u think about Crix memory and operator architecture?");
  assert.equal(intent.kind, "self_architecture");
  assert.equal(intent.lowSignal, false);
  assert.equal(intent.shouldRecall, true);
  assert.equal(intent.shouldCapture, true);

  const reminder = buildForegroundReminder("what do u think about Crix memory and operator architecture?");
  assert.match(reminder, /Foreground request \(self_architecture\)/);
  assert.match(reminder, /Do not replace this request with self-diagnostics/);
});

test("intent governor: long autonomous upgrades are foreground missions", () => {
  const intent = classifyUserIntent("go all out and make Crix the best no matter how long it takes");
  assert.equal(intent.kind, "autonomous_mission");
  assert.equal(intent.shouldRecall, true);
  assert.equal(intent.shouldCapture, true);
});
