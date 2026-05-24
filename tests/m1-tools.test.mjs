// M1.3 — verify the seven core tools.
//
// Each tool is exercised against a real temp directory. RichToolContext
// is built inline; no provider/engine wiring needed at this stage.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ReadTool,
  WriteTool,
  EditTool,
  GlobTool,
  GrepTool,
  BashTool,
  PowerShellTool,
} from "../packages/tools/dist/index.js";

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crix-m1-"));
  return dir;
}

function ctx(workspace) {
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

// ─── Read ──────────────────────────────────────────────────────────────

test("Read: full file with line numbers", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "a.txt");
  await fs.writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
  const c = ctx(tmp);
  const r = await ReadTool.call({ file_path: file }, c);
  assert.equal(r.output.totalLines, 4); // 4 because trailing newline produces empty line
  assert.match(r.output.content, /^\s+1\talpha/);
  assert.match(r.output.content, /\s+3\tgamma/);
  assert.ok(c.fileReadStamps.has(file));
});

test("Read: offset/limit slice", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "big.txt");
  await fs.writeFile(file, Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n"), "utf8");
  const c = ctx(tmp);
  const r = await ReadTool.call({ file_path: file, offset: 10, limit: 5 }, c);
  assert.equal(r.output.startLine, 11);
  assert.equal(r.output.endLine, 15);
  assert.match(r.output.content, /\s+11\tline11/);
  assert.match(r.output.content, /\s+15\tline15/);
});

// ─── Write ─────────────────────────────────────────────────────────────

test("Write: create new file (no prior read required)", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "new.txt");
  const c = ctx(tmp);
  const decision = await WriteTool.checkPermissions({ file_path: file, content: "hello" }, c);
  assert.equal(decision.kind, "allow");
  const r = await WriteTool.call({ file_path: file, content: "hello" }, c);
  assert.equal(r.output.created, true);
  assert.equal(await fs.readFile(file, "utf8"), "hello");
  assert.ok(c.fileReadStamps.has(file));
});

test("Write: overwrite REQUIRES prior Read", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "existing.txt");
  await fs.writeFile(file, "original", "utf8");
  const c = ctx(tmp);
  const decision = await WriteTool.checkPermissions({ file_path: file, content: "new" }, c);
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /Read .* before overwriting/);
});

test("Write: overwrite OK after Read", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "existing.txt");
  await fs.writeFile(file, "original", "utf8");
  const c = ctx(tmp);
  await ReadTool.call({ file_path: file }, c);
  const decision = await WriteTool.checkPermissions({ file_path: file, content: "new" }, c);
  assert.equal(decision.kind, "allow");
});

// ─── Edit ──────────────────────────────────────────────────────────────

test("Edit: requires prior Read", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "e.txt");
  await fs.writeFile(file, "hello world", "utf8");
  const c = ctx(tmp);
  const decision = await EditTool.checkPermissions(
    { file_path: file, old_string: "hello", new_string: "hi", replace_all: false },
    c,
  );
  assert.equal(decision.kind, "deny");
});

test("Edit: rejects identical old/new strings", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "e.txt");
  await fs.writeFile(file, "x", "utf8");
  const c = ctx(tmp);
  await ReadTool.call({ file_path: file }, c);
  const decision = await EditTool.checkPermissions(
    { file_path: file, old_string: "x", new_string: "x", replace_all: false },
    c,
  );
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /identical/);
});

test("Edit: replaces unique match", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "e.txt");
  await fs.writeFile(file, "before middle after", "utf8");
  const c = ctx(tmp);
  await ReadTool.call({ file_path: file }, c);
  const r = await EditTool.call(
    { file_path: file, old_string: "middle", new_string: "MIDDLE", replace_all: false },
    c,
  );
  assert.equal(r.output.replacements, 1);
  assert.equal(await fs.readFile(file, "utf8"), "before MIDDLE after");
});

test("Edit: rejects non-unique match without replace_all", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "e.txt");
  await fs.writeFile(file, "foo foo foo", "utf8");
  const c = ctx(tmp);
  await ReadTool.call({ file_path: file }, c);
  await assert.rejects(
    EditTool.call(
      { file_path: file, old_string: "foo", new_string: "bar", replace_all: false },
      c,
    ),
    /not unique/,
  );
});

test("Edit: replace_all changes every occurrence", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "e.txt");
  await fs.writeFile(file, "foo foo foo", "utf8");
  const c = ctx(tmp);
  await ReadTool.call({ file_path: file }, c);
  const r = await EditTool.call(
    { file_path: file, old_string: "foo", new_string: "bar", replace_all: true },
    c,
  );
  assert.equal(r.output.replacements, 3);
  assert.equal(await fs.readFile(file, "utf8"), "bar bar bar");
});

// ─── Glob ──────────────────────────────────────────────────────────────

test("Glob: finds files by extension", async () => {
  const tmp = await makeTmp();
  await fs.mkdir(path.join(tmp, "src"), { recursive: true });
  await fs.writeFile(path.join(tmp, "src", "a.ts"), "", "utf8");
  await fs.writeFile(path.join(tmp, "src", "b.ts"), "", "utf8");
  await fs.writeFile(path.join(tmp, "src", "c.js"), "", "utf8");
  const c = ctx(tmp);
  const r = await GlobTool.call({ pattern: "**/*.ts", max_results: 500 }, c);
  assert.equal(r.output.matches.length, 2);
  assert.ok(r.output.matches.every((m) => m.path.endsWith(".ts")));
});

test("Glob: respects max_results", async () => {
  const tmp = await makeTmp();
  for (let i = 0; i < 10; i++) {
    await fs.writeFile(path.join(tmp, `f${i}.txt`), "", "utf8");
  }
  const c = ctx(tmp);
  const r = await GlobTool.call({ pattern: "*.txt", max_results: 3 }, c);
  assert.equal(r.output.matches.length, 3);
  assert.equal(r.output.truncated, true);
});

// ─── Grep ──────────────────────────────────────────────────────────────

test("Grep: files_with_matches", async () => {
  const tmp = await makeTmp();
  await fs.writeFile(path.join(tmp, "a.txt"), "needle in haystack\n", "utf8");
  await fs.writeFile(path.join(tmp, "b.txt"), "no match here\n", "utf8");
  await fs.writeFile(path.join(tmp, "c.txt"), "another needle\n", "utf8");
  const c = ctx(tmp);
  const r = await GrepTool.call(
    { pattern: "needle", output_mode: "files_with_matches", case_insensitive: false, max_results: 50, context_before: 0, context_after: 0 },
    c,
  );
  assert.equal(r.output.files.length, 2);
  assert.equal(r.output.totalMatches, 2);
});

test("Grep: content mode returns matching lines", async () => {
  const tmp = await makeTmp();
  await fs.writeFile(path.join(tmp, "log.txt"), "info: ok\nerror: bad\ninfo: yay\n", "utf8");
  const c = ctx(tmp);
  const r = await GrepTool.call(
    { pattern: "^error", output_mode: "content", case_insensitive: false, max_results: 50, context_before: 0, context_after: 0 },
    c,
  );
  assert.equal(r.output.matches.length, 1);
  assert.equal(r.output.matches[0].line, 2);
  assert.match(r.output.matches[0].text, /^error: bad$/);
});

// ─── Bash / PowerShell ─────────────────────────────────────────────────

test("Bash: runs echo and returns stdout", async () => {
  const tmp = await makeTmp();
  const c = ctx(tmp);
  try {
    const r = await BashTool.call(
      { command: "echo hello", description: "test echo", timeout: 30000 },
      c,
    );
    assert.equal(r.output.exitCode, 0);
    assert.match(r.output.stdout, /hello/);
  } catch (err) {
    // Bash not installed on this Windows runner — skip
    if (err.code === "ENOENT") return;
    throw err;
  }
});

test("PowerShell: runs Write-Output", async () => {
  if (process.platform !== "win32") return; // skip on non-Windows
  const tmp = await makeTmp();
  const c = ctx(tmp);
  const r = await PowerShellTool.call(
    { command: "Write-Output ok", description: "test write", timeout: 30000 },
    c,
  );
  assert.equal(r.output.exitCode, 0);
  assert.match(r.output.stdout, /ok/);
});
