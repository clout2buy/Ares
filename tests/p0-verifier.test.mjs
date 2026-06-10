// P0.6 — continuous verifier behavior.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContinuousVerifier, deriveNarrowVerify } from "../packages/core/dist/index.js";

test("deriveNarrowVerify: ts files in a tsconfig workspace use tsc -b", () => {
  const cmds = deriveNarrowVerify(
    ["/repo/src/a.ts", "/repo/src/b.ts"],
    "/repo",
    { hasTsconfig: true, hasPackageJson: true, hasPnpm: true, hasNpm: false, hasPyproject: false, hasRuff: false, hasPytest: false, hasCargo: false, hasGoMod: false },
  );
  assert.ok(cmds.some((c) => c.label === "typescript" && c.args.includes("tsc")));
});

test("deriveNarrowVerify: test files trigger narrow node --test on just those files", () => {
  const cmds = deriveNarrowVerify(
    ["/repo/tests/foo.test.mjs", "/repo/tests/bar.test.mjs"],
    "/repo",
    { hasTsconfig: false, hasPackageJson: true, hasPnpm: false, hasNpm: true, hasPyproject: false, hasRuff: false, hasPytest: false, hasCargo: false, hasGoMod: false },
  );
  const test = cmds.find((c) => c.label.startsWith("tests"));
  assert.ok(test);
  assert.equal(test.program, "node");
  assert.deepEqual(test.args[0], "--test");
  assert.ok(test.args.some((a) => a.includes("foo.test")));
  assert.ok(test.args.some((a) => a.includes("bar.test")));
});

test("deriveNarrowVerify: python ruff + pytest", () => {
  const cmds = deriveNarrowVerify(
    ["/repo/src/x.py", "/repo/tests/test_x.py"],
    "/repo",
    { hasTsconfig: false, hasPackageJson: false, hasPnpm: false, hasNpm: false, hasPyproject: true, hasRuff: true, hasPytest: true, hasCargo: false, hasGoMod: false },
  );
  assert.ok(cmds.some((c) => c.program === "ruff"));
  assert.ok(cmds.some((c) => c.program === "pytest"));
});

test("deriveNarrowVerify: no touched files → no commands", () => {
  const cmds = deriveNarrowVerify([], "/repo", { hasTsconfig: true, hasPackageJson: true, hasPnpm: true, hasNpm: false, hasPyproject: false, hasRuff: false, hasPytest: false, hasCargo: false, hasGoMod: false });
  assert.equal(cmds.length, 0);
});

// Use plain .js + node --check for deterministic syntax-error checks.
// (node --test on Windows has cold-spawn timing variance.)

test("ContinuousVerifier: schedules a run, stashes a reminder on failure", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ares-verify-"));
  const brokenJs = path.join(tmp, "broken.js");
  await fs.writeFile(brokenJs, "this is not ( valid javascript", "utf8");

  const verifier = new ContinuousVerifier({ workspace: tmp, debounceMs: 50 });
  verifier.scheduleFor([brokenJs]);
  await new Promise((r) => setTimeout(r, 4000));
  const reminders = verifier.drainReminders();
  assert.equal(reminders.length, 1, "expected one verifier reminder");
  assert.equal(reminders[0].source, "verifier");
  assert.match(reminders[0].text, /verifier detected failures/);
});

test("ContinuousVerifier: passing run leaves no reminder", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ares-verify-"));
  const okJs = path.join(tmp, "ok.js");
  await fs.writeFile(okJs, "const x = 1;\nconsole.log(x);\n", "utf8");
  const verifier = new ContinuousVerifier({ workspace: tmp, debounceMs: 50 });
  verifier.scheduleFor([okJs]);
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(verifier.drainReminders().length, 0);
});

test("ContinuousVerifier: drainReminders returns then clears", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ares-verify-"));
  const brokenJs = path.join(tmp, "again.js");
  await fs.writeFile(brokenJs, "function ( {", "utf8");
  const v = new ContinuousVerifier({ workspace: tmp, debounceMs: 50 });
  v.scheduleFor([brokenJs]);
  await new Promise((r) => setTimeout(r, 4000));
  const first = v.drainReminders();
  assert.equal(first.length, 1);
  // Second drain should be empty (already consumed).
  assert.equal(v.drainReminders().length, 0);
});
