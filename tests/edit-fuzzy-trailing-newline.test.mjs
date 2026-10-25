// Edit — fuzzy tiers must keep the file's line structure (issue #35).
//
// When old_string misses verbatim (trailing spaces in the file the model did
// not reproduce) and both strings end in "\n", the anchor/normalized tiers
// dropped the needle's trailing blank element but kept the replacement's,
// planting a blank line after the edit: "x  \ny\nz\n" edited with
// old="x\ny\n" new="X\ny\n" came back as "X\ny\n\nz\n". Silent corruption.
//
// Style mirrors tests/edit-diff-anchor.test.mjs: real temp dirs, an inline
// RichToolContext, tools invoked through their dist build.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ReadTool, EditTool } from "../packages/tools/dist/index.js";
import { replaceResilient } from "../packages/tools/dist/Edit.js";

async function makeTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ares-edit-nl-"));
}

function ctx(workspace) {
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

test("the issue's repro: whitespace-drifted block with trailing newlines, no blank line added", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "a.txt");
  const c = ctx(tmp);
  await fs.writeFile(file, "x  \ny\nz\n", "utf8");
  await ReadTool.call({ file_path: file }, c);
  const res = await EditTool.call({ file_path: file, old_string: "x\ny\n", new_string: "X\ny\n" }, c);
  assert.notEqual(res.output.layer, "exact", "the fuzzy fallback must have fired for this to prove anything");
  assert.equal(await fs.readFile(file, "utf8"), "X\ny\nz\n");
});

test("every fuzzy tier preserves line structure with trailing newlines", () => {
  // Layer 2 (trailing whitespace only).
  const ws = replaceResilient("x  \ny\nz\n", "x\ny\n", "X\ny\n", false);
  assert.deepEqual([ws.ok, ws.matchedBy, ws.text], [true, "whitespace", "X\ny\nz\n"]);

  // Layer 3 (anchor: an interior blank line drifted).
  const anchor = replaceResilient("a\n\nb\nc\nz\n", "a\nb\nc\n", "A\nB\nC\n", false);
  assert.deepEqual([anchor.ok, anchor.matchedBy, anchor.text], [true, "anchor", "A\nB\nC\nz\n"]);

  // Layer 4 (normalized: curly quotes + indent drift on a single line, which
  // exact/whitespace/anchor all decline).
  const norm = replaceResilient("  say(“hi”)\nz\n", 'say("hi")\n', 'say("bye")\n', false);
  assert.deepEqual([norm.ok, norm.matchedBy, norm.text], [true, "normalized", '  say("bye")\nz\n']);
});

test("a new_string that adds a trailing newline the old one lacked still adds it (matches exact semantics)", () => {
  // Exact tier: "x\ny" → "X\ny\n" inside "x\ny\nz" yields a blank line. The
  // whitespace tier on the drifted file must agree, not silently differ.
  const exact = replaceResilient("x\ny\nz", "x\ny", "X\ny\n", false);
  assert.equal(exact.text, "X\ny\n\nz");
  const fuzzy = replaceResilient("x  \ny\nz", "x\ny", "X\ny\n", false);
  assert.equal(fuzzy.matchedBy, "whitespace");
  assert.equal(fuzzy.text, "X\ny\n\nz");
});

test("a real blank line after the block survives the edit", () => {
  const res = replaceResilient("x  \ny\n\nz\n", "x\ny\n", "X\ny\n", false);
  assert.equal(res.ok, true);
  assert.equal(res.text, "X\ny\n\nz\n");
});
