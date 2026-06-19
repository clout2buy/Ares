// Verifies Write's content-hash staleness guard (matches Edit's discipline):
//   1. A blind overwrite of a file changed on disk since the last Read is refused.
//   2. A brand-new file (no prior Read) writes fine — the new-file path is untouched.
//   3. A clean overwrite (Read, no external change) still succeeds.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { WriteTool, ReadTool } from "../packages/tools/dist/index.js";

function ctx(workspace) {
  return { workspace, signal: new AbortController().signal, permissionMode: "workspace-write", fileReadStamps: new Map() };
}
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-v45-"));

test("Write: refuses to clobber a file changed on disk since the last Read", async () => {
  const dir = await tmp();
  const file = path.join(dir, "doc.txt");
  await fs.writeFile(file, "original contents\n", "utf8");
  const c = ctx(dir);
  await ReadTool.call({ file_path: file }, c); // stamps the read hash

  await fs.writeFile(file, "SOMEONE ELSE CHANGED THIS\n", "utf8"); // out-of-band edit

  await assert.rejects(
    () => WriteTool.call({ file_path: file, content: "my full overwrite that would lose the other edit" }, c),
    /modified on disk since the last Read/,
  );
});

test("Write: a brand-new file writes without a prior Read", async () => {
  const dir = await tmp();
  const c = ctx(dir);
  const r = await WriteTool.call({ file_path: path.join(dir, "fresh.txt"), content: "hello" }, c);
  assert.equal(r.output.created, true);
});

test("Write: a clean overwrite (Read, no external change) still succeeds", async () => {
  const dir = await tmp();
  const file = path.join(dir, "ok.txt");
  await fs.writeFile(file, "v1 contents here\n", "utf8");
  const c = ctx(dir);
  await ReadTool.call({ file_path: file }, c);
  const r = await WriteTool.call({ file_path: file, content: "v2 contents here, replacing v1" }, c);
  assert.ok(r.output.bytesWritten > 0, "the up-to-date overwrite went through");
});
