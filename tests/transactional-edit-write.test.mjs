import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EditTool } from "../packages/tools/dist/Edit.js";
import { ReadTool } from "../packages/tools/dist/Read.js";
import { WriteTool } from "../packages/tools/dist/Write.js";

async function context(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-transactional-tools-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

async function mutationReceipts(workspace) {
  const root = path.join(workspace, ".ares", "mutations");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const receipts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const receiptPath = path.join(root, entry.name, "receipt.json");
    const raw = await fs.readFile(receiptPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (raw !== null) receipts.push(JSON.parse(raw));
  }
  return receipts;
}

test("Write routes an in-workspace overwrite through a durable CAS transaction", async (t) => {
  const ctx = await context(t);
  const file = path.join(ctx.workspace, "write.txt");
  await fs.writeFile(file, "before\n");
  await ReadTool.call({ file_path: file }, ctx);

  const result = await WriteTool.call({ file_path: file, content: "after\n" }, ctx);
  assert.equal(await fs.readFile(file, "utf8"), "after\n");
  assert.ok(result.output.backupPath, "legacy user-visible backup remains available");
  assert.equal(await fs.readFile(result.output.backupPath, "utf8"), "before\n");

  const receipts = await mutationReceipts(ctx.workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].label, "Write");
  assert.equal(receipts[0].status, "committed");
  assert.equal(receipts[0].operations[0].kind, "update");
  assert.equal(receipts[0].operations[0].path, file);
});

test("Edit routes the final resilient replacement through one durable transaction", async (t) => {
  const ctx = await context(t);
  const file = path.join(ctx.workspace, "edit.txt");
  await fs.writeFile(file, "alpha\nbeta\ngamma\n");
  await ReadTool.call({ file_path: file }, ctx);

  const result = await EditTool.call(
    { file_path: file, old_string: "beta", new_string: "BETA", replace_all: false },
    ctx,
  );
  assert.equal(result.output.replacements, 1);
  assert.equal(await fs.readFile(file, "utf8"), "alpha\nBETA\ngamma\n");

  const receipts = await mutationReceipts(ctx.workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].label, "Edit");
  assert.equal(receipts[0].operations.length, 1);
  assert.equal(receipts[0].operations[0].kind, "update");
});

test("a stale Edit is rejected before a mutation journal or project write", async (t) => {
  const ctx = await context(t);
  const file = path.join(ctx.workspace, "stale.txt");
  await fs.writeFile(file, "version one\n");
  await ReadTool.call({ file_path: file }, ctx);
  await fs.writeFile(file, "external version\n");

  await assert.rejects(
    EditTool.call(
      { file_path: file, old_string: "version one", new_string: "agent version", replace_all: false },
      ctx,
    ),
    /modified on disk since the last Read/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "external version\n");
  assert.deepEqual(await mutationReceipts(ctx.workspace), []);
});

test("Write add uses create-if-absent transaction semantics and emits an add receipt", async (t) => {
  const ctx = await context(t);
  const file = path.join(ctx.workspace, "new", "file.txt");
  await WriteTool.call({ file_path: file, content: "created\n" }, ctx);

  const receipts = await mutationReceipts(ctx.workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].label, "Write");
  assert.equal(receipts[0].operations[0].kind, "add");
  assert.equal(await fs.readFile(file, "utf8"), "created\n");
});
