// Edit's structured output must carry `layer` at the top level — the edit-tier
// friction meter (packages/core/src/frictionLog.ts, tool_end handler) reads
// `output.layer` and recorded 0 successes across 301 Edit calls because the
// field was only ever exposed as `matchedBy`.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EditTool, ReadTool, weakestLayer } from "../packages/tools/dist/index.js";

function ctx(workspace) {
  return { workspace, signal: new AbortController().signal, permissionMode: "workspace-write", fileReadStamps: new Map() };
}
async function tmpFile(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-editlayer-"));
  const file = path.join(dir, "f.txt");
  await fs.writeFile(file, contents, "utf8");
  return file;
}

test("Edit: output.layer is 'exact' for an exact match", async () => {
  const file = await tmpFile("alpha\nbeta\ngamma\n");
  const c = ctx(path.dirname(file));
  await ReadTool.call({ file_path: file }, c);
  const r = await EditTool.call({ file_path: file, old_string: "beta", new_string: "BETA" }, c);
  assert.equal(r.output.layer, "exact");
  assert.deepEqual(r.output.layers, ["exact"]);
  assert.equal(r.output.matchedBy, "exact", "legacy field still present");
});

test("Edit: output.layer is 'whitespace' for a trailing-whitespace mismatch", async () => {
  // File has trailing spaces; the model reproduces the lines without them.
  const file = await tmpFile("function f() {   \n  return 1;  \n}\n");
  const c = ctx(path.dirname(file));
  await ReadTool.call({ file_path: file }, c);
  const r = await EditTool.call(
    { file_path: file, old_string: "function f() {\n  return 1;\n}", new_string: "function f() {\n  return 2;\n}" },
    c,
  );
  assert.equal(r.output.layer, "whitespace");
  assert.deepEqual(r.output.layers, ["whitespace"]);
  assert.equal(await fs.readFile(file, "utf8"), "function f() {\n  return 2;\n}\n");
});

test("Edit: batch output.layer is the WEAKEST tier used, layers lists all", async () => {
  const file = await tmpFile("one\ntwo   \nthree\n");
  const c = ctx(path.dirname(file));
  await ReadTool.call({ file_path: file }, c);
  const r = await EditTool.call({
    file_path: file,
    edits: [
      { old_string: "one", new_string: "1" }, // exact
      { old_string: "two\nthree", new_string: "2\n3" }, // whitespace (trailing spaces on 'two')
    ],
  }, c);
  assert.equal(r.output.layer, "whitespace");
  assert.deepEqual(r.output.layers, ["exact", "whitespace"]);
  assert.equal(r.output.matchedBy, "exact,whitespace");
});

test("weakestLayer orders exact < whitespace < anchor < normalized", () => {
  assert.equal(weakestLayer([]), "exact");
  assert.equal(weakestLayer(["exact"]), "exact");
  assert.equal(weakestLayer(["whitespace", "exact"]), "whitespace");
  assert.equal(weakestLayer(["exact", "anchor", "whitespace"]), "anchor");
  assert.equal(weakestLayer(["normalized", "exact"]), "normalized");
});
