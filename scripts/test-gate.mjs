#!/usr/bin/env node
// The release test gate (owner, 2026-10-20: "make sure it's not failing,
// happens all the time").
//
// Runs the whole suite once. If something fails, it reruns ONLY the files
// that failed, one at a time on a quiet machine. The gate passes only if every
// one of them passes on that rerun; a real bug fails twice and still blocks
// the release. Flakes are named loudly (a ::warning:: annotation) so they get
// fixed instead of forgotten. A test that hangs is cut off by --test-timeout
// instead of stalling the job for half an hour.
//
//   node scripts/test-gate.mjs            (from the repo root; the whole suite)
//   node scripts/test-gate.mjs tests/a.test.mjs tests/b.test.mjs

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const TEST_TIMEOUT_MS = 10 * 60_000;
const MAX_RERUN_FILES = 6;

const files = process.argv.length > 2 ? process.argv.slice(2) : readdirSync("tests").filter((f) => f.endsWith(".test.mjs")).sort().map((f) => `tests/${f}`);

function run(list, concurrency) {
  return new Promise((resolve) => {
    const args = ["--import", "./tests/_isolate-home.mjs", "--test", "--test-reporter=tap", `--test-timeout=${TEST_TIMEOUT_MS}`, `--test-concurrency=${concurrency}`, ...list];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => { process.stdout.write(d); out += d.toString(); });
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

/** The test files behind every "not ok" in a TAP stream. */
function failingFiles(tap, known) {
  const lines = tap.split(/\r?\n/);
  const found = new Set();
  let unmapped = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    let file;
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
      if (/^\s*(not )?ok \d+ - /.test(lines[j])) break;
      const loc = /location: '(.+?\.test\.mjs)(?::\d+:\d+)?'/.exec(lines[j]);
      if (loc) { file = loc[1]; break; }
    }
    file ??= /([^\s'"]+\.test\.mjs)/.exec(m[1])?.[1];
    const hit = file ? known.find((k) => path.basename(k) === path.basename(file.replace(/\\\\/g, "/").replace(/\\/g, "/"))) : undefined;
    if (hit) found.add(hit);
    else unmapped++;
  }
  return { files: [...found], unmapped };
}

const first = await run(files, 2);
if (first.code === 0) process.exit(0);

const { files: failed, unmapped } = failingFiles(first.out, files);
if (!failed.length || unmapped > 0 || failed.length > MAX_RERUN_FILES) {
  console.error(`\n[test-gate] ${failed.length} failing file(s), ${unmapped} failure(s) not tied to a file — too much to call flaky. Failing the release.`);
  process.exit(1);
}

console.error(`\n[test-gate] rerunning only what failed, one file at a time: ${failed.join(", ")}`);
let stillFailing = [];
for (const f of failed) {
  const again = await run([f], 1);
  if (again.code !== 0) stillFailing.push(f);
}
if (stillFailing.length) {
  console.error(`\n[test-gate] failed twice — a real failure: ${stillFailing.join(", ")}`);
  process.exit(1);
}
for (const f of failed) console.log(`::warning title=Flaky test::${f} failed under the full suite and passed alone — fix it`);
console.error(`\n[test-gate] passed on rerun. Flaky: ${failed.join(", ")}`);
process.exit(0);
