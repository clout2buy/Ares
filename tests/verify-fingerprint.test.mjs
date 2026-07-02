// Fingerprint caching for the continuous verifier.
//
// The verifier re-derives the same narrow check command on every edit. Before
// this change it re-spawned that command every time even when nothing relevant
// changed. Now: a fingerprint = hash(command identity + content of the files it
// covers). If a command with that exact fingerprint already PASSED, the pass is
// served from cache and the command is NOT re-run.
//
// These tests inject a fake command runner (the `runCommand` seam) that counts
// invocations, so we can prove hit/miss/eviction behavior without spawning real
// processes.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContinuousVerifier } from "../packages/core/dist/index.js";

/** Fresh tmp workspace with a single .js file (derives one `node --check` cmd). */
async function makeWorkspace(fileName = "src.js", content = "const x = 1;\n") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-fp-"));
  const file = path.join(dir, fileName);
  await fs.writeFile(file, content, "utf8");
  return { dir, file };
}

/** A runner that counts calls and returns a canned ok/fail per invocation. */
function countingRunner(planner) {
  const runner = async (cmd) => {
    runner.calls++;
    const ok = planner(runner.calls, cmd);
    return {
      ok,
      command: cmd,
      exitCode: ok ? 0 : 1,
      stdoutTail: "",
      stderrTail: ok ? "" : "boom",
      durationMs: 1,
    };
  };
  runner.calls = 0;
  return runner;
}

/** Schedule an edit and wait for the debounced run to fully settle. */
async function runAndSettle(verifier, files) {
  verifier.scheduleFor(files);
  await verifier.settle(5000);
}

test("(a) same files + same command twice → second call is a cache HIT (not re-run)", async () => {
  const { dir, file } = await makeWorkspace();
  const runner = countingRunner(() => true); // always passes
  const verifier = new ContinuousVerifier({ workspace: dir, debounceMs: 10, runCommand: runner });

  await runAndSettle(verifier, [file]);
  assert.equal(runner.calls, 1, "first run executes the command");
  let stats = verifier.cacheStats();
  assert.equal(stats.misses, 1);
  assert.equal(stats.hits, 0);
  assert.equal(stats.stores, 1, "the pass was cached");

  // Nothing changed → second schedule must be served from cache, no new run.
  await runAndSettle(verifier, [file]);
  assert.equal(runner.calls, 1, "second run is a cache hit — command NOT re-run");
  stats = verifier.cacheStats();
  assert.equal(stats.hits, 1, "one cache hit recorded");
  assert.equal(stats.misses, 1, "still only one miss");

  await fs.rm(dir, { recursive: true, force: true });
});

test("(b) changing a covered file busts the cache and RE-RUNS", async () => {
  const { dir, file } = await makeWorkspace();
  const runner = countingRunner(() => true);
  const verifier = new ContinuousVerifier({ workspace: dir, debounceMs: 10, runCommand: runner });

  await runAndSettle(verifier, [file]);
  assert.equal(runner.calls, 1);

  // Edit the file → its content hash changes → fingerprint differs → re-run.
  await fs.writeFile(file, "const x = 2;\nconsole.log(x);\n", "utf8");
  await runAndSettle(verifier, [file]);
  assert.equal(runner.calls, 2, "changed content busts the cache and re-runs");

  const stats = verifier.cacheStats();
  assert.equal(stats.hits, 0, "no hit — content differed");
  assert.equal(stats.misses, 2);

  await fs.rm(dir, { recursive: true, force: true });
});

test("(c) a FAILING check is NOT cached — it re-runs next time", async () => {
  const { dir, file } = await makeWorkspace();
  // Fail on the first run, pass on the second — same unchanged file both times.
  const runner = countingRunner((n) => n > 1);
  const verifier = new ContinuousVerifier({ workspace: dir, debounceMs: 10, runCommand: runner });

  await runAndSettle(verifier, [file]);
  assert.equal(runner.calls, 1, "first run executed (and failed)");
  let stats = verifier.cacheStats();
  assert.equal(stats.stores, 0, "a failure is never stored in the cache");

  // Same file, unchanged. Because the prior run FAILED, it must re-run.
  await runAndSettle(verifier, [file]);
  assert.equal(runner.calls, 2, "failing check re-runs — not cached");
  stats = verifier.cacheStats();
  assert.equal(stats.hits, 0, "no cache hit for the previously-failing command");
  assert.equal(stats.stores, 1, "the now-passing run gets cached");

  // Third run with the same unchanged file: NOW it's a cached pass.
  await runAndSettle(verifier, [file]);
  assert.equal(runner.calls, 2, "third run is a cache hit — the pass stuck");
  assert.equal(verifier.cacheStats().hits, 1);

  await fs.rm(dir, { recursive: true, force: true });
});

test("cache eviction is bounded (oldest evicted past cacheMax)", async () => {
  const { dir } = await makeWorkspace();
  const runner = countingRunner(() => true);
  const verifier = new ContinuousVerifier({ workspace: dir, debounceMs: 10, runCommand: runner, cacheMax: 2 });

  // Three DISTINCT files → three distinct fingerprints, each a stored pass.
  for (const name of ["a.js", "b.js", "c.js"]) {
    const f = path.join(dir, name);
    await fs.writeFile(f, `// ${name}\n`, "utf8");
    await runAndSettle(verifier, [f]);
  }

  const stats = verifier.cacheStats();
  assert.equal(stats.stores, 3, "three passes stored");
  assert.ok(stats.evictions >= 1, "at least one eviction past the bound of 2");
  assert.ok(stats.size <= 2, `cache size stays within bound (was ${stats.size})`);

  await fs.rm(dir, { recursive: true, force: true });
});
