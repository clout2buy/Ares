// Tolerant tool-argument repair: the slips models really make no longer cost a
// regeneration (three malformed Browser calls = ~28s before any visual, 2026-10-16).
import test from "node:test";
import assert from "node:assert/strict";
import { coerceToolArgs, repairToolJson } from "../packages/core/dist/providers/_toolPairs.js";

test("unescaped inner quotes in a string are repaired", () => {
  const got = coerceToolArgs('{"action":"explain","title":"Greek "Demonic" Deities: How They Work","blocks":[]}', "Browser");
  assert.equal(got.title, 'Greek "Demonic" Deities: How They Work');
  assert.deepEqual(got.blocks, []);
});

test("raw newlines/tabs inside strings and trailing commas are repaired", () => {
  const got = coerceToolArgs('{"action":"explain","blocks":[{"type":"text","text":"line one\nline\ttwo"},],}', "Browser");
  assert.equal(got.blocks[0].text, "line one\nline\ttwo");
});

test("a cut-off non-file payload is closed so the structure parses", () => {
  const got = coerceToolArgs('{"action":"explain","title":"T","blocks":[{"type":"text","text":"half a sen', "Browser");
  assert.equal(got.action, "explain");
  assert.equal(got.blocks[0].type, "text");
});

test("a cut-off FILE-content payload is never auto-closed (a half file must not land)", () => {
  assert.equal(repairToolJson('{"file_path":"a.txt","content":"half of a fi', false), null);
  assert.throws(() => coerceToolArgs('{"file_path":"a.txt","content":"' + "x".repeat(2500), "Write"), /cut off mid-value/);
});

test("valid JSON is untouched and hopeless input still gives the correctable error", () => {
  assert.deepEqual(coerceToolArgs('{"a":1,"b":"x, \\"q\\""}', "Browser"), { a: 1, b: 'x, "q"' });
  assert.throws(() => coerceToolArgs("not json at all {{{", "Browser"), /malformed or truncated/);
});
