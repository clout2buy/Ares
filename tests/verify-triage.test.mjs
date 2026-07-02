// Failure triage — a wall of red collapses into named root causes.
import test from "node:test";
import assert from "node:assert/strict";
import { triageVerifyOutput } from "../packages/core/dist/index.js";

test("triage: repeated TS error collapses into one bucket with file list", () => {
  const out = [
    "packages/cli/src/entry/daemon.ts(97,54): error TS2304: Cannot find name 'lastShot'.",
    "packages/cli/src/entry/daemon.ts(114,50): error TS2304: Cannot find name 'lastShot'.",
    "packages/cli/src/entry/chat.ts(78,11): error TS2304: Cannot find name 'lastShot'.",
    "packages/cli/src/entry/chat.ts(80,11): error TS2304: Cannot find name 'printHelp'.",
  ].join("\n");
  const t = triageVerifyOutput(out);
  assert.ok(t, "triage fires");
  assert.match(t, /4 failure line\(s\), 2 distinct root cause\(s\)/);
  assert.match(t, /×3 TS2304: Cannot find name 'lastShot'/);
  assert.match(t, /daemon\.ts, chat\.ts/);
});

test("triage: node:test failures group as failing tests", () => {
  const out = [
    "not ok 1 - guard cuts dead streams",
    "not ok 2 - guard cuts thinking",
    "  AssertionError: expected 'stream_stall' to equal 'reasoning_stall'",
  ].join("\n");
  const t = triageVerifyOutput(out);
  assert.ok(t);
  assert.match(t, /failing test/);
  assert.match(t, /AssertionError/);
});

test("triage: distinct messages with only numbers/idents changed still collapse", () => {
  const out = [
    "a.ts(1,1): error TS2551: Property 'foo1' does not exist on type 'Bar'.",
    "b.ts(9,2): error TS2551: Property 'foo2' does not exist on type 'Baz'.",
  ].join("\n");
  const t = triageVerifyOutput(out);
  assert.ok(t);
  assert.match(t, /×2 TS2551/);
});

test("triage: no signal returns null so callers keep the raw tail", () => {
  assert.equal(triageVerifyOutput("Segmentation fault (core dumped)"), null);
  assert.equal(triageVerifyOutput(""), null);
  // one lone error line is not worth a triage header
  assert.equal(triageVerifyOutput("x.ts(1,1): error TS1005: ';' expected."), null);
});
