// Gauntlet round 2 — more of the long tail: newline-edge files, literal
// regex chars, vanished/readonly files, deep paths, tabs, empty files.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ReadTool, EditTool, WriteTool, GlobTool } from "../packages/tools/dist/index.js";

async function makeTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ares-gauntlet2-"));
}

function ctx(workspace) {
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

async function seedAndRead(c, file, content) {
  await fs.writeFile(file, content, "utf8");
  await ReadTool.call({ file_path: file }, c);
}

test("gauntlet2: a file WITHOUT a trailing newline keeps not having one", async () => {
  const ws = await makeTmp();
  const c = ctx(ws);
  const file = path.join(ws, "no-eol.txt");
  await seedAndRead(c, file, "first\nlast line no eol");
  await EditTool.call({ file_path: file, old_string: "first", new_string: "FIRST" }, c);
  const bytes = await fs.readFile(file, "utf8");
  assert.equal(bytes, "FIRST\nlast line no eol", "must not grow a trailing newline");
});

test("gauntlet2: regex-special characters in old_string are treated literally", async () => {
  const ws = await makeTmp();
  const c = ctx(ws);
  const file = path.join(ws, "rx.js");
  await seedAndRead(c, file, "const re = /a.*b($1)[x]/;\nconst other = 1;\n");
  await EditTool.call({ file_path: file, old_string: "/a.*b($1)[x]/", new_string: "/a.+b($2)[y]/" }, c);
  assert.equal(await fs.readFile(file, "utf8"), "const re = /a.+b($2)[y]/;\nconst other = 1;\n");
});

test("gauntlet2: editing a file deleted after Read fails helpfully, not with a crash", async () => {
  const ws = await makeTmp();
  const c = ctx(ws);
  const file = path.join(ws, "gone.txt");
  await seedAndRead(c, file, "content\n");
  await fs.rm(file);
  const res = await EditTool.call({ file_path: file, old_string: "content", new_string: "x" }, c).catch((e) => ({ failed: e.message }));
  assert.ok(res.failed, "must fail");
  assert.ok(!/undefined is not|cannot read propert/i.test(res.failed), `must be a real error message, got: ${res.failed}`);
});

test("gauntlet2: editing a read-only file fails cleanly and leaves it untouched", async () => {
  const ws = await makeTmp();
  const c = ctx(ws);
  const file = path.join(ws, "locked.txt");
  await seedAndRead(c, file, "keep me\n");
  await fs.chmod(file, 0o444);
  try {
    const res = await EditTool.call({ file_path: file, old_string: "keep me", new_string: "changed" }, c).catch((e) => ({ failed: e.message }));
    if (res.failed) {
      assert.equal(await fs.readFile(file, "utf8"), "keep me\n", "refused edit must not half-write");
    } else {
      // Some environments allow the write despite the attribute — then it must be complete.
      assert.equal(await fs.readFile(file, "utf8"), "changed\n");
    }
  } finally {
    await fs.chmod(file, 0o666).catch(() => undefined);
  }
});

test("gauntlet2: Write creates deep non-existent directory chains", async () => {
  const ws = await makeTmp();
  const c = ctx(ws);
  const file = path.join(ws, "a", "b", "c", "d", "e", "new.txt");
  await WriteTool.call({ file_path: file, content: "deep\n" }, c);
  assert.equal(await fs.readFile(file, "utf8"), "deep\n");
});

test("gauntlet2: a ~200-char nested relative path round-trips on Windows", async () => {
  const ws = await makeTmp();
  const c = ctx(ws);
  const seg = "subdir-with-a-rather-long-name";
  const file = path.join(ws, seg, seg, seg, seg, seg, "leaf-file-with-long-name.txt");
  await WriteTool.call({ file_path: file, content: "v=1\n" }, c);
  await ReadTool.call({ file_path: file }, c);
  await EditTool.call({ file_path: file, old_string: "v=1", new_string: "v=2" }, c);
  assert.equal(await fs.readFile(file, "utf8"), "v=2\n");
});

test("gauntlet2: tab indentation survives an edit byte-for-byte", async () => {
  const ws = await makeTmp();
  const c = ctx(ws);
  const file = path.join(ws, "makefile.mk");
  await seedAndRead(c, file, "build:\n\tgcc -o out main.c\n\techo done\n");
  await EditTool.call({ file_path: file, old_string: "\tgcc -o out main.c", new_string: "\tgcc -O2 -o out main.c" }, c);
  assert.equal(await fs.readFile(file, "utf8"), "build:\n\tgcc -O2 -o out main.c\n\techo done\n", "tabs must not become spaces");
});

test("gauntlet2: empty file reads cleanly and Glob on an empty dir is calm", async () => {
  const ws = await makeTmp();
  const c = ctx(ws);
  const file = path.join(ws, "empty.txt");
  await fs.writeFile(file, "");
  const read = await ReadTool.call({ file_path: file }, c);
  const text = typeof read.output === "string" ? read.output : JSON.stringify(read.output);
  assert.ok(text.length < 2000, "empty-file read stays small");
  const emptyDir = path.join(ws, "nothing-here");
  await fs.mkdir(emptyDir);
  const globRes = await GlobTool.call({ pattern: "**/*.zig", path: emptyDir }, c).catch((e) => ({ failed: e.message }));
  assert.ok(!globRes.failed, `glob on empty dir must not throw: ${globRes.failed}`);
});

test("gauntlet2: Write into a workspace folder that does not exist yet creates it", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "ares-g2-noworkspace-"));
  const ws = path.join(parent, "Ares Workspace");
  const c = { workspace: ws, signal: new AbortController().signal, permissionMode: "workspace-write", fileReadStamps: new Map() };
  const r = await WriteTool.call({ file_path: "game/index.html", content: "<p>hi</p>\n" }, c);
  assert.equal(r.output.created, true);
  assert.equal(await fs.readFile(path.join(ws, "game", "index.html"), "utf8"), "<p>hi</p>\n");
});
