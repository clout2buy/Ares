// Owner, 2026-11-03: a finished TRELLIS weight load showed up as a chat bubble
// of ~200 "Loading weights: 97%|####| 401/415 ..." lines. The tail a background
// job hands the model keeps only the last redraw of each progress bar.
import test from "node:test";
import assert from "node:assert/strict";
import { collapseProgressLines } from "../packages/tools/dist/ShellRegistry.js";

test("a run of progress redraws collapses to its last line; other output is kept", () => {
  const bar = (n) => `Loading weights:  ${Math.floor((n / 415) * 100)}%|#########6| ${n}/415 [00:00<00:00, 3176.81it/s, Materializing param=layer.${n}.weight]`;
  const text = [
    "[stdout] starting",
    ...Array.from({ length: 200 }, (_, i) => bar(200 + i)),
    "Downloading model.safetensors:  10%|#  | 1/10",
    "Downloading model.safetensors:  100%|#####| 10/10",
    "done: outputs/cactus.glb",
    "done: outputs/cactus.glb",
  ].join("\r\n");
  const out = collapseProgressLines(text).split("\n");
  assert.deepEqual(out, [
    "[stdout] starting",
    bar(399),
    "Downloading model.safetensors:  100%|#####| 10/10",
    "done: outputs/cactus.glb",
  ]);
});

test("carriage-return redraws on one physical line collapse too", () => {
  const text = "a:  10%|#| 1/10\ra:  50%|###| 5/10\ra: 100%|#####| 10/10\nok";
  assert.equal(collapseProgressLines(text), "a: 100%|#####| 10/10\nok");
});

test("plain output without progress bars is untouched", () => {
  const text = "line one\nline two\n\nline four";
  assert.equal(collapseProgressLines(text), text);
});
