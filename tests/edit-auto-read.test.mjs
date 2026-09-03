// Edit/Write auto-read instead of "Read <path> before editing it."
//
// Field telemetry: 62 of 68 Edit errors in a month were the read-first
// refusal. The content-hash staleness check + unique-match rule already carry
// the safety that refusal was for, so Edit now reads the file itself, stamps
// it exactly as Read would, and proceeds. The deny survives only behind
// ARES_EDIT_AUTO_READ=0, or when the file is missing / the match is not unique.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EditTool, WriteTool, ReadTool } from "../packages/tools/dist/index.js";

function ctx(workspace) {
  return { workspace, signal: new AbortController().signal, permissionMode: "workspace-write", fileReadStamps: new Map() };
}
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-autoread-"));

async function withKnob(value, fn) {
  const prev = process.env.ARES_EDIT_AUTO_READ;
  if (value === undefined) delete process.env.ARES_EDIT_AUTO_READ;
  else process.env.ARES_EDIT_AUTO_READ = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ARES_EDIT_AUTO_READ;
    else process.env.ARES_EDIT_AUTO_READ = prev;
  }
}

test("Edit: without a prior Read, auto-reads, edits, and reports autoRead", async () => {
  await withKnob(undefined, async () => {
    const dir = await tmp();
    const file = path.join(dir, "a.txt");
    await fs.writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const c = ctx(dir);

    const decision = await EditTool.checkPermissions({ file_path: file, old_string: "beta", new_string: "BETA" }, c);
    assert.equal(decision.kind, "allow", "checkPermissions no longer denies an un-Read file");

    const r = await EditTool.call({ file_path: file, old_string: "beta", new_string: "BETA" }, c);
    assert.equal(r.output.autoRead, true);
    assert.equal(r.output.replacements, 1);
    assert.match(r.display, /\(auto-read .*a\.txt before editing\)/);
    assert.equal(await fs.readFile(file, "utf8"), "alpha\nBETA\ngamma\n");
    // The stamp is now current, so a follow-up Edit passes staleness too.
    assert.ok(c.fileReadStamps.has(file));
    const r2 = await EditTool.call({ file_path: file, old_string: "gamma", new_string: "GAMMA" }, c);
    assert.equal(r2.output.autoRead, undefined, "second edit had a stamp — no auto-read");
  });
});

test("Edit: after a real Read, autoRead is not reported", async () => {
  await withKnob(undefined, async () => {
    const dir = await tmp();
    const file = path.join(dir, "b.txt");
    await fs.writeFile(file, "one\ntwo\n", "utf8");
    const c = ctx(dir);
    await ReadTool.call({ file_path: file }, c);
    const r = await EditTool.call({ file_path: file, old_string: "two", new_string: "2" }, c);
    assert.equal(r.output.autoRead, undefined);
    assert.equal(r.output.replacements, 1);
  });
});

test("Edit: auto-read + ambiguous old_string still errors (nothing written)", async () => {
  await withKnob(undefined, async () => {
    const dir = await tmp();
    const file = path.join(dir, "c.txt");
    const original = "dup\nx\ndup\n";
    await fs.writeFile(file, original, "utf8");
    const c = ctx(dir);
    await assert.rejects(
      () => EditTool.call({ file_path: file, old_string: "dup", new_string: "D" }, c),
      /not unique .*2 matches.*auto-read/s,
    );
    assert.equal(await fs.readFile(file, "utf8"), original);
  });
});

test("Edit: auto-read + missing old_string errors with a Read hint (nothing written)", async () => {
  await withKnob(undefined, async () => {
    const dir = await tmp();
    const file = path.join(dir, "d.txt");
    await fs.writeFile(file, "hello world\n", "utf8");
    const c = ctx(dir);
    await assert.rejects(
      () => EditTool.call({ file_path: file, old_string: "goodbye", new_string: "x" }, c),
      /old_string not found.*Read the region/s,
    );
    assert.equal(await fs.readFile(file, "utf8"), "hello world\n");
  });
});

test("Edit: a missing file still refuses (the one case the deny got right)", async () => {
  await withKnob(undefined, async () => {
    const dir = await tmp();
    const c = ctx(dir);
    await assert.rejects(
      () => EditTool.call({ file_path: path.join(dir, "nope.txt"), old_string: "a", new_string: "b" }, c),
      /does not exist.*use Write/s,
    );
  });
});

test("Edit: auto-read stamp keeps staleness tracking honest", async () => {
  await withKnob(undefined, async () => {
    const dir = await tmp();
    const file = path.join(dir, "e.txt");
    await fs.writeFile(file, "v1\n", "utf8");
    const c = ctx(dir);
    // First edit auto-reads and stamps; an out-of-band change afterwards must be caught.
    await EditTool.call({ file_path: file, old_string: "v1", new_string: "v2" }, c);
    await fs.writeFile(file, "SOMEONE ELSE\n", "utf8");
    await assert.rejects(
      () => EditTool.call({ file_path: file, old_string: "v2", new_string: "v3" }, c),
      /modified on disk since the last Read/,
    );
  });
});

test("Edit: ARES_EDIT_AUTO_READ=0 restores the deny", async () => {
  await withKnob("0", async () => {
    const dir = await tmp();
    const file = path.join(dir, "f.txt");
    await fs.writeFile(file, "alpha\n", "utf8");
    const c = ctx(dir);
    const decision = await EditTool.checkPermissions({ file_path: file, old_string: "alpha", new_string: "A" }, c);
    assert.equal(decision.kind, "deny");
    assert.match(decision.reason, /Read .* before editing it/);
    await assert.rejects(
      () => EditTool.call({ file_path: file, old_string: "alpha", new_string: "A" }, c),
      /Read .* before editing it/,
    );
    assert.equal(await fs.readFile(file, "utf8"), "alpha\n");
  });
});

test("Write: overwrite without a prior Read auto-reads and previews the old content", async () => {
  await withKnob(undefined, async () => {
    const dir = await tmp();
    const file = path.join(dir, "g.txt");
    const old = Array.from({ length: 30 }, (_, i) => `old line ${i + 1}`).join("\n") + "\n";
    await fs.writeFile(file, old, "utf8");
    const c = ctx(dir);

    const decision = await WriteTool.checkPermissions({ file_path: file, content: "x" }, c);
    assert.equal(decision.kind, "allow");

    const replacement = Array.from({ length: 30 }, (_, i) => `new line ${i + 1}`).join("\n") + "\n";
    const r = await WriteTool.call({ file_path: file, content: replacement }, c);
    assert.equal(r.output.autoRead, true);
    assert.equal(r.output.created, false);
    assert.ok(r.output.previousContentPreview, "old content preview is present");
    assert.match(r.output.previousContentPreview, /old line 1\b/);
    assert.match(r.output.previousContentPreview, /old line 20\b/);
    assert.doesNotMatch(r.output.previousContentPreview, /old line 21\b/, "preview is capped at ~20 lines");
    assert.match(r.output.previousContentPreview, /10 more lines/);
    assert.match(r.display, /\(auto-read .*g\.txt before overwriting\)/);
    assert.match(r.display, /Replaced content began with:/);
    assert.equal(await fs.readFile(file, "utf8"), replacement);
  });
});

test("Write: auto-read overwrite of an EMPTY file carries no preview", async () => {
  await withKnob(undefined, async () => {
    const dir = await tmp();
    const file = path.join(dir, "h.txt");
    await fs.writeFile(file, "", "utf8");
    const c = ctx(dir);
    const r = await WriteTool.call({ file_path: file, content: "fresh body\n" }, c);
    assert.equal(r.output.autoRead, true);
    assert.equal(r.output.previousContentPreview, undefined);
  });
});

test("Write: ARES_EDIT_AUTO_READ=0 restores the overwrite deny", async () => {
  await withKnob("0", async () => {
    const dir = await tmp();
    const file = path.join(dir, "i.txt");
    await fs.writeFile(file, "original", "utf8");
    const c = ctx(dir);
    const decision = await WriteTool.checkPermissions({ file_path: file, content: "new" }, c);
    assert.equal(decision.kind, "deny");
    assert.match(decision.reason, /Read .* before overwriting/);
    await assert.rejects(() => WriteTool.call({ file_path: file, content: "new" }, c), /Read .* before overwriting/);
    assert.equal(await fs.readFile(file, "utf8"), "original");
  });
});
