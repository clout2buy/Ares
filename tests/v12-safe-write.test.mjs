// v12 — destructive-write safety: shrink guard + per-file pre-write backups.
//
// Regression coverage for the incident where an ApplyIntent full-file sketch
// (a fragment) overwrote a 1251-line file with 23 lines, unrecoverable because
// the file lived outside the workspace.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ApplyIntentTool, WriteTool, assessShrink } from "../packages/tools/dist/index.js";

async function makeTmp() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ares-safewrite-"));
}

function ctx(workspace) {
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

async function stamp(c, file) {
  const stat = await fs.stat(file);
  c.fileReadStamps.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
}

function bigFile(lines) {
  return Array.from({ length: lines }, (_, i) => `const line${i} = ${i}; // some content on each line`).join("\n") + "\n";
}

test("assessShrink: flags a fragment replacing a substantial file", () => {
  const v = assessShrink(bigFile(1251), "body { color: red; }\n");
  assert.equal(v.catastrophic, true);
});

test("assessShrink: allows an ordinary refactor that roughly halves a file", () => {
  const v = assessShrink(bigFile(200), bigFile(110));
  assert.equal(v.catastrophic, false);
});

test("assessShrink: ignores tiny originals", () => {
  const v = assessShrink("export const value = 1;\n", "");
  assert.equal(v.catastrophic, false);
});

test("ApplyIntent: refuses a fragment that would collapse a large file", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "village.html");
  const original = bigFile(1251);
  await fs.writeFile(file, original, "utf8");
  const c = ctx(tmp);
  await stamp(c, file);

  await assert.rejects(
    ApplyIntentTool.call(
      { file_path: file, instructions: "Add a loading screen.", sketch: "<style>body{}</style>\n" },
      c,
    ),
    /refusing to replace/i,
  );

  // The file must be untouched.
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("ApplyIntent: allow_full_replace lets a deliberate rewrite through, with a backup", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "a.ts");
  const original = bigFile(200);
  await fs.writeFile(file, original, "utf8");
  const c = ctx(tmp);
  await stamp(c, file);

  const result = await ApplyIntentTool.call(
    {
      file_path: file,
      instructions: "Gut the file down to a stub.",
      sketch: "export const stub = true;\n",
      allow_full_replace: true,
    },
    c,
  );

  assert.equal(await fs.readFile(file, "utf8"), "export const stub = true;");
  assert.ok(result.output.backupPath, "a backup path is returned");
  assert.equal(await fs.readFile(result.output.backupPath, "utf8"), original);
});

test("Write: backs up prior contents before overwriting an existing file", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "notes.md");
  const original = "# Notes\n\nfirst version\n";
  await fs.writeFile(file, original, "utf8");
  const c = ctx(tmp);
  await stamp(c, file);

  const result = await WriteTool.call(
    { file_path: file, content: "# Notes\n\nsecond version\n" },
    c,
  );

  assert.equal(result.output.created, false);
  assert.ok(result.output.backupPath, "a backup path is returned");
  assert.equal(await fs.readFile(result.output.backupPath, "utf8"), original);

  // Backup index records the overwrite.
  const index = await fs.readFile(path.join(tmp, ".ares", "backups", "index.jsonl"), "utf8");
  const entry = JSON.parse(index.trim().split("\n").pop());
  assert.equal(entry.tool, "Write");
  assert.equal(entry.original, file);
});

test("Write: creating a new file takes no backup", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "fresh.txt");
  const c = ctx(tmp);

  const result = await WriteTool.call({ file_path: file, content: "hello\n" }, c);
  assert.equal(result.output.created, true);
  assert.equal(result.output.backupPath, undefined);
});

test("Write: backup survives even for an out-of-workspace target", async () => {
  const workspace = await makeTmp();
  const elsewhere = await makeTmp(); // simulates the Desktop — outside the workspace
  const file = path.join(elsewhere, "Village.html");
  const original = bigFile(300);
  await fs.writeFile(file, original, "utf8");

  // bypass mode mirrors the "unleashed owner" posture that skips path prompts.
  const c = { ...ctx(workspace), permissionMode: "bypass" };
  await stamp(c, file);

  const result = await WriteTool.call(
    { file_path: file, content: bigFile(305) },
    c,
  );

  assert.ok(result.output.backupPath?.startsWith(path.join(workspace, ".ares", "backups")));
  assert.equal(await fs.readFile(result.output.backupPath, "utf8"), original);
});
