// Grep — multiline, -C context, respect_gitignore.
//
// Runs against whichever engine is present (ripgrep on PATH → ripgrep, else the
// native JS fallback); assertions hold for both except where noted.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { GrepTool } from "../packages/tools/dist/index.js";

async function makeTmp() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ares-grep-ml-"));
}

function ctx(workspace) {
  return {
    workspace,
    sessionId: "sess_grep_ml",
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

const base = { case_insensitive: false, max_results: 200, context_before: 0, context_after: 0 };

test("Grep: multiline lets a pattern span lines; default mode stays line-scoped", async () => {
  const tmp = await makeTmp();
  await fs.writeFile(
    path.join(tmp, "types.rs"),
    "struct Point {\n    x: i32,\n    y: i32,\n}\nstruct Other {\n    z: i32,\n}\n",
    "utf8",
  );
  const c = ctx(tmp);
  const pattern = "struct \\w+ \\{[^}]*y: i32";

  const single = await GrepTool.call({ ...base, pattern, output_mode: "content" }, c);
  assert.equal(single.totalMatches ?? single.output.totalMatches, 0, "line-scoped search cannot see across the brace");

  const multi = await GrepTool.call({ ...base, pattern, output_mode: "content", multiline: true }, c);
  assert.equal(multi.output.totalMatches, 1);
  assert.equal(multi.output.matches[0].line, 1);
  assert.match(multi.output.matches[0].text, /struct Point/);
  assert.match(multi.output.matches[0].text, /y: i32/);
  assert.ok(!/Other/.test(multi.output.matches[0].text), "match must stop at the first struct");

  const files = await GrepTool.call({ ...base, pattern, output_mode: "files_with_matches", multiline: true }, c);
  assert.equal(files.output.files.length, 1);
});

test("Grep: context (-C) returns surrounding lines flagged as context", async () => {
  const tmp = await makeTmp();
  await fs.writeFile(path.join(tmp, "log.txt"), "one\ntwo\nERROR here\nfour\nfive\n", "utf8");
  const c = ctx(tmp);
  const r = await GrepTool.call({ ...base, pattern: "ERROR", output_mode: "content", context: 1 }, c);
  assert.equal(r.output.totalMatches, 1);
  const lines = r.output.matches.map((m) => [m.line, m.context === true]);
  assert.deepEqual(lines, [[2, true], [3, false], [4, true]]);

  const after = await GrepTool.call({ ...base, pattern: "ERROR", output_mode: "content", context_after: 2 }, c);
  assert.deepEqual(after.output.matches.map((m) => m.line), [3, 4, 5]);
});

test("Grep: respect_gitignore=false includes ignored files", async (t) => {
  const gitOk = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
  if (!gitOk) {
    t.skip("git not on PATH");
    return;
  }
  const tmp = await makeTmp();
  spawnSync("git", ["init", "-q"], { cwd: tmp, windowsHide: true, stdio: "ignore" });
  await fs.writeFile(path.join(tmp, ".gitignore"), "secret.txt\n", "utf8");
  await fs.writeFile(path.join(tmp, "secret.txt"), "needle hidden\n", "utf8");
  await fs.writeFile(path.join(tmp, "plain.txt"), "needle visible\n", "utf8");
  const c = ctx(tmp);

  const strict = await GrepTool.call({ ...base, pattern: "needle", output_mode: "files_with_matches" }, c);
  const strictNames = strict.output.files.map((f) => path.basename(f));
  assert.ok(strictNames.includes("plain.txt"));
  if (strict.output.engine === "ripgrep") {
    assert.ok(!strictNames.includes("secret.txt"), "ripgrep honors .gitignore by default");
  }

  const loose = await GrepTool.call({ ...base, pattern: "needle", output_mode: "files_with_matches", respect_gitignore: false }, c);
  const looseNames = loose.output.files.map((f) => path.basename(f));
  assert.ok(looseNames.includes("secret.txt"), "respect_gitignore=false must search ignored files");
  assert.ok(looseNames.includes("plain.txt"));
});
