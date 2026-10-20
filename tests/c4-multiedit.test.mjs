// C4 — MultiEdit: atomic batched edits on the Edit tool (ultra-coding Phase 2).
//
// The Edit tool gains an `edits[]` batch mode applied ATOMICALLY in order to one
// file: all hunks resolve against an in-memory working copy and the file is
// written ONCE, only if every hunk matched. A failing hunk leaves the file
// untouched — killing the classic "edit 2's text is gone after edit 1" half-apply.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReadTool, EditTool } from "../packages/tools/dist/index.js";

function ctx(workspace) {
  return { workspace, signal: new AbortController().signal, permissionMode: "workspace-write", fileReadStamps: new Map() };
}
async function tmpFile(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-multiedit-"));
  const file = path.join(dir, "f.txt");
  await fs.writeFile(file, contents, "utf8");
  return file;
}

test("MultiEdit: single-edit mode still works (backward compatible)", async () => {
  const c = ctx(os.tmpdir());
  const file = await tmpFile("alpha\nbeta\ngamma\n");
  await ReadTool.call({ file_path: file }, c);
  const r = await EditTool.call({ file_path: file, old_string: "beta", new_string: "BETA" }, c);
  assert.equal(r.output.replacements, 1);
  assert.equal(await fs.readFile(file, "utf8"), "alpha\nBETA\ngamma\n");
});

test("MultiEdit: a batch applies all hunks atomically and in order", async () => {
  const c = ctx(os.tmpdir());
  const file = await tmpFile("one\ntwo\nthree\n");
  await ReadTool.call({ file_path: file }, c);
  const r = await EditTool.call({
    file_path: file,
    edits: [
      { old_string: "one", new_string: "1" },
      { old_string: "two", new_string: "2" },
      { old_string: "three", new_string: "3" },
    ],
  }, c);
  assert.equal(r.output.replacements, 3);
  assert.equal(await fs.readFile(file, "utf8"), "1\n2\n3\n");
});

test("MultiEdit: dependent hunks apply sequentially (hunk 2 sees hunk 1's result)", async () => {
  const c = ctx(os.tmpdir());
  const file = await tmpFile("const x = 1;\n");
  await ReadTool.call({ file_path: file }, c);
  const r = await EditTool.call({
    file_path: file,
    edits: [
      { old_string: "const x = 1;", new_string: "const y = 2;" },
      { old_string: "const y = 2;", new_string: "const y = 42;" }, // targets hunk 1's output
    ],
  }, c);
  assert.equal(r.output.replacements, 2);
  assert.equal(await fs.readFile(file, "utf8"), "const y = 42;\n");
});

test("MultiEdit: all-or-nothing — a failing hunk leaves the file UNCHANGED", async () => {
  const c = ctx(os.tmpdir());
  const original = "keep\nalso\n";
  const file = await tmpFile(original);
  await ReadTool.call({ file_path: file }, c);
  await assert.rejects(
    () => EditTool.call({
      file_path: file,
      edits: [
        { old_string: "keep", new_string: "KEPT" },         // would succeed
        { old_string: "NOT_PRESENT", new_string: "x" },      // fails -> abort whole batch
      ],
    }, c),
    (err) => {
      assert.match(err.message, /<tool_use_error>/);
      assert.match(err.message, /edit 2 of 2/);
      assert.match(err.message, /all-or-nothing/);
      return true;
    },
  );
  // The first hunk must NOT have been written — the file is byte-identical.
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("MultiEdit: validateInput rejects an empty/no-op hunk with its index", async () => {
  const empty = await EditTool.validateInput({ file_path: "f.txt", edits: [{ old_string: "a", new_string: "b" }, { old_string: "", new_string: "x" }] });
  assert.equal(empty.ok, false);
  assert.match(empty.message, /empty.*edit 2/s);

  const noop = await EditTool.validateInput({ file_path: "f.txt", edits: [{ old_string: "same", new_string: "same" }] });
  assert.equal(noop.ok, false);
  assert.match(noop.message, /identical/);

  const ok = await EditTool.validateInput({ file_path: "f.txt", edits: [{ old_string: "a", new_string: "b" }] });
  assert.equal(ok.ok, true);
});

test("Edit line ranges: replace a block by Read's line numbers — no need to echo the old text", async () => {
  const c = ctx(os.tmpdir());
  const file = await tmpFile("a\nb\nc\nd\ne\n");
  await ReadTool.call({ file_path: file }, c);
  const r = await EditTool.call({ file_path: file, start_line: 2, end_line: 4, new_string: "B\nC" }, c);
  assert.equal(r.output.replacements, 1);
  assert.equal(await fs.readFile(file, "utf8"), "a\nB\nC\ne\n");
});

test("Edit line ranges: a batch applies bottom-up against the numbers the model read; deleting with \"\"", async () => {
  const c = ctx(os.tmpdir());
  const file = await tmpFile("1\n2\n3\n4\n5\n6\n");
  await ReadTool.call({ file_path: file }, c);
  await EditTool.call({ file_path: file, edits: [
    { start_line: 1, end_line: 1, new_string: "one\nuno" },
    { start_line: 3, end_line: 4, new_string: "" },
    { start_line: 6, end_line: 6, new_string: "six" },
  ] }, c);
  assert.equal(await fs.readFile(file, "utf8"), "one\nuno\n2\n5\nsix\n");
});

test("Edit line ranges: refused on a file changed since the Read, past the end, overlapping, or mixed with text hunks", async () => {
  const c = ctx(os.tmpdir());
  const file = await tmpFile("x\ny\nz\n");
  await ReadTool.call({ file_path: file }, c);
  await assert.rejects(() => EditTool.call({ file_path: file, start_line: 2, end_line: 9, new_string: "Y" }, c), /past the end/);
  await assert.rejects(() => EditTool.call({ file_path: file, edits: [{ start_line: 1, end_line: 2, new_string: "q" }, { start_line: 2, end_line: 3, new_string: "r" }] }, c), /overlap/);
  const mixed = await EditTool.validateInput?.({ file_path: file, edits: [{ start_line: 1, end_line: 1, new_string: "q" }, { old_string: "z", new_string: "Z" }] }, c);
  assert.equal(mixed?.ok, false);
  await fs.writeFile(file, "inserted\nx\ny\nz\n", "utf8"); // someone else edits it
  await assert.rejects(() => EditTool.call({ file_path: file, start_line: 2, end_line: 2, new_string: "Y" }, c), /changed since your last Read/);
  assert.equal(await fs.readFile(file, "utf8"), "inserted\nx\ny\nz\n");
});
