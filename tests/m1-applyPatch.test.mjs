// M1.1 — apply-patch parser tests.
//
// Ported test cases from codex-rs/apply-patch/src/parser.rs#tests plus
// Crix-specific cases for lenient heredoc, multi-chunk updates, and move.

import test from "node:test";
import assert from "node:assert/strict";
import { parsePatch, parsePatchText, PatchParseError } from "../packages/core/dist/index.js";

// ─── boundaries ────────────────────────────────────────────────────────

test("parsePatchText strict: missing Begin Patch", () => {
  assert.throws(
    () => parsePatchText("bad", "strict"),
    (e) => e instanceof PatchParseError && /first line.*Begin Patch/.test(e.message),
  );
});

test("parsePatchText strict: missing End Patch", () => {
  assert.throws(
    () => parsePatchText("*** Begin Patch\nbad", "strict"),
    (e) => e instanceof PatchParseError && /last line.*End Patch/.test(e.message),
  );
});

// ─── add file ──────────────────────────────────────────────────────────

test("parsePatch: add file with multiple lines", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Add File: hello.txt\n" +
    "+line one\n" +
    "+line two\n" +
    "+line three\n" +
    "*** End Patch";
  const result = parsePatch(patch);
  assert.equal(result.hunks.length, 1);
  const h = result.hunks[0];
  assert.equal(h.kind, "add");
  assert.equal(h.path, "hello.txt");
  assert.equal(h.contents, "line one\nline two\nline three\n");
});

test("parsePatch: add file with empty line", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Add File: empty.txt\n" +
    "+\n" +
    "+after blank\n" +
    "*** End Patch";
  const result = parsePatch(patch);
  assert.equal(result.hunks[0].contents, "\nafter blank\n");
});

// ─── delete file ───────────────────────────────────────────────────────

test("parsePatch: delete file", () => {
  const patch = "*** Begin Patch\n" + "*** Delete File: dead.ts\n" + "*** End Patch";
  const result = parsePatch(patch);
  assert.equal(result.hunks.length, 1);
  assert.deepEqual(result.hunks[0], { kind: "delete", path: "dead.ts" });
});

// ─── update file ───────────────────────────────────────────────────────

test("parsePatch: update file single chunk with context", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Update File: src/foo.ts\n" +
    "@@ class Foo\n" +
    " function bar() {\n" +
    "-  return 1;\n" +
    "+  return 2;\n" +
    " }\n" +
    "*** End Patch";
  const result = parsePatch(patch);
  assert.equal(result.hunks.length, 1);
  const h = result.hunks[0];
  assert.equal(h.kind, "update");
  assert.equal(h.path, "src/foo.ts");
  assert.equal(h.chunks.length, 1);
  const c = h.chunks[0];
  assert.equal(c.changeContext, "class Foo");
  assert.deepEqual(c.oldLines, ["function bar() {", "  return 1;", "}"]);
  assert.deepEqual(c.newLines, ["function bar() {", "  return 2;", "}"]);
  assert.equal(c.isEndOfFile, false);
});

test("parsePatch: update file first chunk may omit @@ context", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Update File: a.ts\n" +
    "-old\n" +
    "+new\n" +
    "*** End Patch";
  const result = parsePatch(patch);
  const c = result.hunks[0].chunks[0];
  assert.equal(c.changeContext, undefined);
  assert.deepEqual(c.oldLines, ["old"]);
  assert.deepEqual(c.newLines, ["new"]);
});

test("parsePatch: update file with @@ alone (no context text)", () => {
  const patch =
    "*** Begin Patch\n" + "*** Update File: a.ts\n" + "@@\n" + "+added\n" + "*** End Patch";
  const result = parsePatch(patch);
  const c = result.hunks[0].chunks[0];
  assert.equal(c.changeContext, undefined);
  assert.deepEqual(c.newLines, ["added"]);
});

test("parsePatch: update file with End of File marker", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Update File: a.ts\n" +
    "@@\n" +
    "+trailing\n" +
    "*** End of File\n" +
    "*** End Patch";
  const result = parsePatch(patch);
  const c = result.hunks[0].chunks[0];
  assert.equal(c.isEndOfFile, true);
  assert.deepEqual(c.newLines, ["trailing"]);
});

test("parsePatch: update file with move (rename)", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Update File: old/path.ts\n" +
    "*** Move to: new/path.ts\n" +
    "@@\n" +
    " unchanged\n" +
    "*** End Patch";
  const result = parsePatch(patch);
  const h = result.hunks[0];
  assert.equal(h.kind, "update");
  assert.equal(h.path, "old/path.ts");
  assert.equal(h.movePath, "new/path.ts");
});

test("parsePatch: update file multi-chunk with context", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Update File: multi.ts\n" +
    "@@ first section\n" +
    "-a\n" +
    "+b\n" +
    "@@ second section\n" +
    "-c\n" +
    "+d\n" +
    "*** End Patch";
  const result = parsePatch(patch);
  assert.equal(result.hunks[0].chunks.length, 2);
  assert.equal(result.hunks[0].chunks[0].changeContext, "first section");
  assert.equal(result.hunks[0].chunks[1].changeContext, "second section");
});

// ─── errors ────────────────────────────────────────────────────────────

test("parsePatch: invalid hunk header throws", () => {
  const patch = "*** Begin Patch\n" + "*** Bogus: foo\n" + "*** End Patch";
  assert.throws(
    () => parsePatch(patch),
    (e) => e instanceof PatchParseError && /valid hunk header/i.test(e.message),
  );
});

test("parsePatch: update with junk first line throws", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Update File: a.ts\n" +
    "junk\n" +
    "*** End Patch";
  assert.throws(
    () => parsePatch(patch),
    (e) => e instanceof PatchParseError && /context line|@@ context/.test(e.message),
  );
});

test("parsePatch: empty update file hunk throws", () => {
  const patch = "*** Begin Patch\n" + "*** Update File: a.ts\n" + "*** End Patch";
  assert.throws(
    () => parsePatch(patch),
    (e) => e instanceof PatchParseError && /empty/.test(e.message),
  );
});

// ─── lenient mode (GPT-4.1 heredoc bug) ─────────────────────────────────

test("parsePatch (lenient default): strips <<'EOF' heredoc", () => {
  const inner =
    "*** Begin Patch\n" +
    "*** Add File: hi.txt\n" +
    "+hello\n" +
    "*** End Patch";
  const wrapped = "<<'EOF'\n" + inner + "\nEOF";
  const result = parsePatch(wrapped);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].contents, "hello\n");
});

test("parsePatch (lenient default): strips bare <<EOF heredoc", () => {
  const inner = "*** Begin Patch\n" + "*** Delete File: x\n" + "*** End Patch";
  const wrapped = "<<EOF\n" + inner + "\nEOF";
  const result = parsePatch(wrapped);
  assert.deepEqual(result.hunks[0], { kind: "delete", path: "x" });
});

test("parsePatch strict mode: heredoc NOT stripped (errors)", () => {
  const inner = "*** Begin Patch\n" + "*** Delete File: x\n" + "*** End Patch";
  const wrapped = "<<'EOF'\n" + inner + "\nEOF";
  assert.throws(
    () => parsePatchText(wrapped, "strict"),
    (e) => e instanceof PatchParseError,
  );
});

// ─── environment_id preamble ────────────────────────────────────────────

test("parsePatch: optional environment_id preamble", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Environment ID: env-abc-123\n" +
    "*** Delete File: trash\n" +
    "*** End Patch";
  const result = parsePatch(patch);
  assert.equal(result.environmentId, "env-abc-123");
  assert.deepEqual(result.hunks[0], { kind: "delete", path: "trash" });
});

test("parsePatch: empty environment_id throws", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Environment ID: \n" +
    "*** Delete File: x\n" +
    "*** End Patch";
  assert.throws(
    () => parsePatch(patch),
    (e) => e instanceof PatchParseError && /environment_id.*empty/.test(e.message),
  );
});

// ─── empty/blank lines in chunks ────────────────────────────────────────

test("parsePatch: empty line inside chunk is context blank line", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Update File: a.ts\n" +
    "@@\n" +
    " line1\n" +
    "\n" +
    " line3\n" +
    "*** End Patch";
  const result = parsePatch(patch);
  const c = result.hunks[0].chunks[0];
  assert.deepEqual(c.oldLines, ["line1", "", "line3"]);
  assert.deepEqual(c.newLines, ["line1", "", "line3"]);
});

// ─── multi-hunk patches ────────────────────────────────────────────────

test("parsePatch: multiple hunks in one patch", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Add File: new.ts\n" +
    "+hello\n" +
    "*** Update File: existing.ts\n" +
    "@@\n" +
    "-x\n" +
    "+y\n" +
    "*** Delete File: gone.ts\n" +
    "*** End Patch";
  const result = parsePatch(patch);
  assert.equal(result.hunks.length, 3);
  assert.equal(result.hunks[0].kind, "add");
  assert.equal(result.hunks[1].kind, "update");
  assert.equal(result.hunks[2].kind, "delete");
});
