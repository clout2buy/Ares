// Verifies O3 — reality-grounded verification:
//   1. runProbe: always / file / command / http each measure reality correctly.
//   2. WorldModel.refresh re-derives state from sources; fingerprint changes
//      when reality changes (never trusts a cached/remembered value).
//   3. THE HEADLINE: the control loop gates completion on the probe, not the
//      Worker's claim. A Worker can insist "done" — the goal only completes
//      when reality (the probe) is actually green.
//   4. A Worker that claims done but never changes reality diverges.
//   5. A goal whose probe is already green completes with no wasted step.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createGoal,
  newGoalId,
  saveGoal,
  tickGoal,
  runGoalToCompletion,
  runProbe,
  WorldModel,
} from "../packages/operator/dist/index.js";

async function makeDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "crix-o3-"));
}

// ── 1. probes measure reality ───────────────────────────────────────────────

test("probe: always reflects its flag", async () => {
  assert.equal((await runProbe({ kind: "always", met: true })).met, true);
  assert.equal((await runProbe({ kind: "always", met: false })).met, false);
});

test("probe: file is red when absent, green when present (+contains)", async () => {
  const dir = await makeDir();
  const f = path.join(dir, "artifact.txt");
  assert.equal((await runProbe({ kind: "file", path: f })).met, false);
  await fs.writeFile(f, "hello world");
  assert.equal((await runProbe({ kind: "file", path: f })).met, true);
  assert.equal((await runProbe({ kind: "file", path: f, contains: "world" })).met, true);
  assert.equal((await runProbe({ kind: "file", path: f, contains: "absent-text" })).met, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("probe: command is green on the expected exit code", async () => {
  const ok = await runProbe({ kind: "command", cmd: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(ok.met, true);
  const bad = await runProbe({ kind: "command", cmd: process.execPath, args: ["-e", "process.exit(1)"] });
  assert.equal(bad.met, false);
});

test("probe: http checks live status + body", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.statusCode = 200;
      res.end("alive and well");
    } else {
      res.statusCode = 500;
      res.end("boom");
    }
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const ok = await runProbe({ kind: "http", url: `http://127.0.0.1:${port}/ok`, expectStatus: 200, contains: "alive" });
    assert.equal(ok.met, true);
    const bad = await runProbe({ kind: "http", url: `http://127.0.0.1:${port}/down`, expectStatus: 200 });
    assert.equal(bad.met, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── 2. WorldModel re-derives reality ────────────────────────────────────────

test("worldModel: refresh re-derives from sources and the fingerprint tracks change", async () => {
  const dir = await makeDir();
  const f = path.join(dir, "state.txt");
  const wm = new WorldModel([{ name: "artifact", spec: { kind: "file", path: f } }]);

  const before = await wm.refresh();
  assert.equal(before.sources.artifact.met, false);

  await fs.writeFile(f, "now it exists");
  const after = await wm.refresh();
  assert.equal(after.sources.artifact.met, true);
  assert.notEqual(before.fingerprint, after.fingerprint, "fingerprint changed because reality changed");
  await fs.rm(dir, { recursive: true, force: true });
});

// ── 3. THE HEADLINE: reality gates completion, not the worker's claim ────────

test("loop: a goal completes only when the probe is green — the worker's claim alone cannot", async () => {
  const home = await makeDir();
  const artifactDir = await makeDir();
  const target = path.join(artifactDir, "artifact.txt");
  const goal = createGoal({
    id: newGoalId(),
    statement: "produce the artifact",
    verification: { kind: "file", path: target },
  });
  await saveGoal(home, goal);

  let calls = 0;
  const dispatcher = {
    async runStep(g) {
      calls++;
      const index = g.stepLog.length;
      if (index >= 1) await fs.writeFile(target, "done"); // only the 2nd step actually changes reality
      return { moved: true, goalMet: true, evidence: "worker insists it is done" }; // worker ALWAYS claims done
    },
  };

  const final = await runGoalToCompletion({ home, dispatcher }, goal.id, { maxTicks: 10 });
  assert.equal(final.status, "done");
  assert.equal(calls, 2, "tick 1 claim ignored (file absent); tick 2 created it → probe green");
  assert.match(final.verdict, /exists/, "completion verdict came from the reality probe");
  assert.ok(!final.verdict.includes("insists"), "the worker's false claim did not become the verdict");
  await fs.rm(artifactDir, { recursive: true, force: true });
});

// ── 4. a lying worker diverges ───────────────────────────────────────────────

test("loop: a worker that claims done but never changes reality diverges", async () => {
  const home = await makeDir();
  const target = path.join(await makeDir(), "never.txt");
  const goal = createGoal({
    id: newGoalId(),
    statement: "never satisfied",
    maxNoProgress: 3,
    verification: { kind: "file", path: target },
  });
  await saveGoal(home, goal);

  let calls = 0;
  const dispatcher = { async runStep() { calls++; return { moved: true, goalMet: true, evidence: "trust me" }; } };
  const final = await runGoalToCompletion({ home, dispatcher }, goal.id, { maxTicks: 50 });
  assert.equal(final.status, "blocked", "reality overrode the worker's repeated false claim");
  assert.equal(calls, 3, "diverged at the threshold instead of believing the worker forever");
});

// ── 5. already-met short-circuit ─────────────────────────────────────────────

test("loop: a goal already satisfied by reality completes with no wasted step", async () => {
  const home = await makeDir();
  const artifactDir = await makeDir();
  const target = path.join(artifactDir, "present.txt");
  await fs.writeFile(target, "exists");
  const goal = createGoal({
    id: newGoalId(),
    statement: "already done",
    verification: { kind: "file", path: target },
  });
  await saveGoal(home, goal);

  let calls = 0;
  const dispatcher = { async runStep() { calls++; return { moved: true, goalMet: false }; } };
  const final = await tickGoal({ home, dispatcher }, goal);
  assert.equal(final.status, "done");
  assert.equal(calls, 0, "no worker step dispatched — reality already satisfied the goal");
  await fs.rm(artifactDir, { recursive: true, force: true });
});
