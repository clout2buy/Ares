// The CLI without a terminal (issue #14).
//
// `ares --version` and bare `ares` under cron, CI, `ares | tee` or `< /dev/null`
// used to exit 1 under a react-reconciler stack trace: the parser left any
// unknown leading `--flag` on the "launcher" command, and the launch deck
// mounted Ink unconditionally, which throws when stdin can't go raw. Now every
// version spelling prints the product version and exits 0, and the deck
// declines with a one-line hint instead of a crash.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repoRoot, "packages", "cli", "dist", "entry.js");
const supervise = path.join(repoRoot, "packages", "cli", "dist", "supervise.js");
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

// stdin from the null device, stdout/stderr piped: no TTY on any end, exactly
// the cron/CI shape from the report.
function run(script, args) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

for (const spelling of ["--version", "-v", "-V", "version"]) {
  test(`ares ${spelling} prints the version and exits 0 without a TTY`, () => {
    const res = run(entry, [spelling]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), `ares v${version}`);
    assert.ok(!/react-reconciler|Raw mode/.test(res.stderr), res.stderr);
  });
}

test("the supervisor front door passes --version straight through", () => {
  const res = run(supervise, ["--version"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), `ares v${version}`);
});

test("bare `ares` without a TTY prints a one-line hint, exit 2, no stack trace", () => {
  const res = run(entry, []);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /needs an interactive terminal/);
  assert.match(res.stderr, /ares chat/);
  assert.ok(!/react-reconciler|Raw mode|fatal:/.test(res.stderr), res.stderr);
  assert.equal(res.stderr.trim().split("\n").length, 1, "one line, not a dump");
});

test("an unknown leading flag is not a crash either", () => {
  const res = run(entry, ["--bogus"]);
  assert.notEqual(res.status, 0);
  assert.ok(!/react-reconciler|Raw mode/.test(res.stderr), res.stderr);
});

test("`ares help` lists the version command", () => {
  const res = run(entry, ["help"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /--version/);
});
