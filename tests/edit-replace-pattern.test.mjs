// Regression: Edit must insert new_string as LITERAL text, never as a
// String.prototype.replace substitution pattern.
//
// Field failure (2026-09-12, Mistique dashboard): a new_string containing $'
// made the single-replace branch splice the remainder of the file back in,
// duplicating the tail and corrupting server.js. The agent burned three turns
// diagnosing it and worked around it by routing the insert through a file.
// $& $` $' $1..$9 and $$ are all replace-pattern tokens and all appear in
// ordinary source: bash quoting, regex replacement strings, shell snippets.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EditTool, ReadTool } from "../packages/tools/dist/index.js";

function ctx(workspace) {
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

async function tmpFile(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-editpat-"));
  const file = path.join(dir, "f.txt");
  await fs.writeFile(file, contents, "utf8");
  return file;
}

const BEFORE = `header line
TARGET
tail line one
tail line two
`;

const PATTERNS = [
  ["dollar-quote", "const nl = $'0a';"],
  ["whole-match", "const m = $& ;"],
  ["prefix", "const p = $` ;"],
  ["capture-group", "const g = $1 + $2;"],
  ["escaped-dollar", "const d = $$;"],
];

for (const [name, payload] of PATTERNS) {
  test(`Edit: new_string with a replace pattern (${name}) lands verbatim`, async () => {
    const file = await tmpFile(BEFORE);
    const c = ctx(path.dirname(file));
    await ReadTool.call({ file_path: file }, c);
    await EditTool.call({ file_path: file, old_string: "TARGET", new_string: payload }, c);

    const after = await fs.readFile(file, "utf8");
    assert.ok(after.includes(payload), `new_string must appear verbatim, got: ${after}`);
    assert.equal(
      after.split("tail line two").length - 1,
      1,
      "the file tail must not be duplicated",
    );
    assert.equal(after, BEFORE.replace("TARGET", () => payload));
  });
}

test("Edit: replace_all keeps literal semantics too", async () => {
  const file = await tmpFile(`a TARGET b
c TARGET d
tail
`);
  const c = ctx(path.dirname(file));
  await ReadTool.call({ file_path: file }, c);
  await EditTool.call(
    { file_path: file, old_string: "TARGET", new_string: "$' $& $1", replace_all: true },
    c,
  );
  const after = await fs.readFile(file, "utf8");
  assert.equal(after, `a $' $& $1 b
c $' $& $1 d
tail
`);
});
