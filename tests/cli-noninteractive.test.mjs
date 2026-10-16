// Contract for the CLI front door when nobody is at the keyboard.
//
// parseArgs defaults the command to "launcher" — the Ink launch deck — whenever
// argv is empty OR begins with a --flag it does not know. With stdin/stdout
// piped, Ink throws "Raw mode is not supported" from inside React, so every one
// of these used to exit 1 under a react-reconciler stack trace:
//
//   ares                 (cron, CI, `ares | tee log`)
//   ares --version       (the first thing anyone types at an unfamiliar CLI)
//
// spawnSync's default stdio is pipes, which is exactly the no-TTY condition.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "packages", "cli", "dist", "entry.js");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

function ares(...args) {
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

for (const spelling of ["--version", "version", "-v", "-V"]) {
  test(`cli: \`ares ${spelling}\` prints the product version and exits 0`, () => {
    const result = ares(spelling);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `ares v${version}`);
    assert.equal(result.stderr, "");
  });
}

test("cli: bare `ares` without a TTY refuses in words, not a stack trace", () => {
  const result = ares();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /needs an interactive terminal/);
  assert.match(result.stderr, /ares help/);
  assert.doesNotMatch(result.stdout + result.stderr, /react-reconciler|Raw mode is not supported/);
});

test("cli: an unknown leading --flag without a TTY gets the same refusal", () => {
  const result = ares("--definitely-not-a-flag");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /needs an interactive terminal/);
  assert.doesNotMatch(result.stdout + result.stderr, /react-reconciler/);
});
