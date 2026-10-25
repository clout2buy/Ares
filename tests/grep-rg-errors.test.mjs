// Grep — a ripgrep failure is an error, not "0 matches" (issue #35).
//
// rg exits 2 with "unrecognized escape sequence" on `foo\qbar`, and the tool
// used to swallow stderr and the exit code and return a clean empty result,
// indistinguishable from "searched fine, found nothing". The model then
// concluded the symbol was absent. Exit 1 (no matches) stays a clean zero.
//
// Only meaningful when ripgrep is on PATH; the native fallback has its own
// RegExp error path. Skipped (not silently passed) otherwise.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { GrepTool } from "../packages/tools/dist/index.js";

const hasRg = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;

async function makeTmp() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ares-grep-err-"));
  await fs.writeFile(path.join(tmp, "a.ts"), "const foo = 1;\nconst bar: Array<string> = [];\n", "utf8");
  return tmp;
}

function ctx(workspace) {
  return {
    workspace,
    sessionId: "sess_grep_err",
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

const base = { output_mode: "content", case_insensitive: false, max_results: 200, context_before: 0, context_after: 0 };

test("an escape ripgrep rejects surfaces as a tool error with rg's stderr", { skip: !hasRg && "ripgrep not on PATH" }, async () => {
  const tmp = await makeTmp();
  // JS accepts `\q` as an identity escape, so validateInput lets it through;
  // only rg's exit code can tell us it was never searched.
  await assert.rejects(
    GrepTool.call({ ...base, pattern: "foo\\qbar" }, ctx(tmp)),
    (err) => {
      assert.match(err.message, /tool_use_error/);
      assert.match(err.message, /ripgrep failed \(exit 2\)/);
      assert.match(err.message, /escape/i, "rg's own stderr must be in the message");
      return true;
    },
  );
});

test("exit 1 (searched clean, nothing found) is still a plain zero result", async () => {
  const tmp = await makeTmp();
  const res = await GrepTool.call({ ...base, pattern: "definitely_not_here_zzz" }, ctx(tmp));
  assert.equal(res.output.totalMatches, 0);
  assert.equal(res.output.warning, undefined);
});
