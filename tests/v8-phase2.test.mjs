import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  capabilityEvidence,
  capabilityReviewQueue,
  createGoal,
  draftCapability,
  listMissionContracts,
  loadGoal,
  loadMissionContract,
  markRotted,
  promoteCapability,
  recordOutcome,
  rejectCapabilityDraft,
  saveCapability,
  saveGoal,
  tickGoal,
} from "../packages/operator/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

async function makeHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "crix-phase2-home-"));
}

async function makeWorkspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "crix-phase2-workspace-"));
}

test("mission-aware loop: attaches contract, records probes, and gates completion on real verification", async () => {
  const home = await makeHome();
  const workspace = await makeWorkspace();
  const target = path.join(workspace, "result.txt");
  const goal = createGoal({
    id: "g_phase2_verified",
    statement: "create verified result",
    verification: { kind: "file", path: "result.txt", contains: "done" },
  });
  await saveGoal(home, goal);

  const firstDispatcher = {
    async runStep() {
      return { moved: true, goalMet: true, evidence: "worker claimed done without writing the file" };
    },
  };
  const first = await tickGoal({ home, workspace, dispatcher: firstDispatcher }, goal);
  assert.equal(first.status, "active", "worker claim cannot complete without passing the probe");

  const afterFirst = await loadGoal(home, goal.id);
  const firstContract = await loadMissionContract(home, afterFirst.missionIds[0]);
  assert.equal(firstContract.acceptanceCriteria[0].status, "pending");
  assert.equal(firstContract.verificationProbeResults[0].status, "failed");
  assert.ok(firstContract.evidenceLog.length >= 1);

  const secondDispatcher = {
    async runStep() {
      await fs.writeFile(target, "done\n", "utf8");
      return { moved: true, goalMet: true, evidence: "wrote result.txt" };
    },
  };
  const second = await tickGoal({ home, workspace, dispatcher: secondDispatcher }, afterFirst);
  assert.equal(second.status, "done");

  const finalContract = await loadMissionContract(home, second.missionIds[0]);
  assert.equal(finalContract.progress.status, "satisfied");
  assert.equal(finalContract.acceptanceCriteria[0].status, "met");
  assert.equal(finalContract.verificationProbeResults[0].status, "passed");
  assert.ok(finalContract.acceptanceCriteria[0].evidenceIds.length >= 1);

  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

test("mission-aware loop: records contract blockers when a goal diverges", async () => {
  const home = await makeHome();
  const goal = createGoal({ id: "g_phase2_blocked", statement: "detect divergence", maxNoProgress: 1 });
  await saveGoal(home, goal);

  const dispatcher = {
    async runStep() {
      return { moved: false, goalMet: false, evidence: "no observable progress" };
    },
  };
  const final = await tickGoal({ home, dispatcher }, goal);
  assert.equal(final.status, "blocked");

  const contract = await loadMissionContract(home, final.missionIds[0]);
  assert.equal(contract.blockers.length, 1);
  assert.match(contract.blockers[0].reason, /diverged/);

  await fs.rm(home, { recursive: true, force: true });
});

test("capability review queue: explains pending, promoted, rejected, rotted, and forbidden states", async () => {
  const home = await makeHome();
  await saveCapability(home, draftCapability({ name: "pending review fixture" }));

  const rejected = rejectCapabilityDraft(draftCapability({ name: "rejected review fixture" }), {
    reason: "eval failed repeatedly",
  });
  await saveCapability(home, rejected);

  const forbidden = rejectCapabilityDraft(draftCapability({ name: "forbidden review fixture" }), {
    reason: "unsafe credential flow",
    forbidden: true,
  });
  await saveCapability(home, forbidden);

  const rotted = markRotted(recordOutcome(draftCapability({ name: "rotted review fixture" }), true), "health check failed");
  await saveCapability(home, rotted);

  const evalReport = {
    schemaVersion: 1,
    suite: "phase2-review",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    total: 1,
    passed: 1,
    failed: 0,
    score: 1,
    results: [
      {
        id: "review-promotion",
        name: "review promotion",
        category: "operator",
        status: "passed",
        score: 1,
        durationMs: 0,
        evidence: ["fixture passed"],
      },
    ],
  };
  let promoted = draftCapability({ name: "promoted review fixture" });
  promoted = recordOutcome(recordOutcome(recordOutcome(promoted, true), true), true);
  promoted = promoteCapability(promoted, {
    evidence: [capabilityEvidence({ summary: "verified fixture" })],
    evalReport,
    skillRef: "review-fixture",
  }).node;
  await saveCapability(home, promoted);

  const queue = await capabilityReviewQueue(home);
  const statuses = new Map(queue.map((item) => [item.name, item.reviewStatus]));
  assert.equal(statuses.get("pending review fixture"), "pending");
  assert.equal(statuses.get("promoted review fixture"), "promoted");
  assert.equal(statuses.get("rejected review fixture"), "rejected");
  assert.equal(statuses.get("rotted review fixture"), "rotted");
  assert.equal(statuses.get("forbidden review fixture"), "forbidden");
  assert.ok(queue.every((item) => item.reasons.length > 0));

  await fs.rm(home, { recursive: true, force: true });
});

test("cli operator review: returns read-only JSON status for a capability", async () => {
  const home = await makeHome();
  const capability = draftCapability({ name: "cli review fixture" });
  await saveCapability(home, capability);

  const result = spawnSync(
    process.execPath,
    [path.join(root, "packages", "cli", "dist", "entry.js"), "operator", "review", "--home", home, "--capability", capability.id, "--json"],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CRIX_HOME: home, CRIX_AGENT_ENABLED: "0" },
    },
  );

  assert.equal(result.status, 0, `operator review failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const item = JSON.parse(result.stdout);
  assert.equal(item.id, capability.id);
  assert.equal(item.reviewStatus, "pending");
  assert.ok(item.reasons.length > 0);

  await fs.rm(home, { recursive: true, force: true });
});

test("cli operator add: explicit criteria and constraints create an authored mission contract", async () => {
  const home = await makeHome();
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages", "cli", "dist", "entry.js"),
      "operator",
      "add",
      "--home",
      home,
      "--goal",
      "ship authored mission",
      "--criteria",
      "CLI lists the mission; status shows evidence",
      "--constraint",
      "no desktop UI changes",
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CRIX_HOME: home, CRIX_AGENT_ENABLED: "0" },
    },
  );

  assert.equal(result.status, 0, `operator add failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const contracts = await listMissionContracts(home);
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].acceptanceCriteria.length, 2);
  assert.equal(contracts[0].acceptanceCriteria[0].description, "CLI lists the mission");
  assert.equal(contracts[0].acceptanceCriteria[1].description, "status shows evidence");
  assert.equal(contracts[0].constraints[0].description, "no desktop UI changes");

  await fs.rm(home, { recursive: true, force: true });
});

test("cli operator add: explicit file probe creates goal and mission verification", async () => {
  const home = await makeHome();
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages", "cli", "dist", "entry.js"),
      "operator",
      "add",
      "--home",
      home,
      "--goal",
      "verify a file",
      "--verify-file",
      "result.txt",
      "--verify-contains",
      "done",
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CRIX_HOME: home, CRIX_AGENT_ENABLED: "0" },
    },
  );

  assert.equal(result.status, 0, `operator add probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const contract = (await listMissionContracts(home))[0];
  const goal = await loadGoal(home, contract.goalId);
  assert.equal(contract.verificationProbeResults.length, 1);
  assert.equal(contract.verificationProbeResults[0].spec.kind, "file");
  assert.equal(contract.verificationProbeResults[0].spec.path, "result.txt");
  assert.equal(contract.verificationProbeResults[0].spec.contains, "done");
  assert.equal(goal.verification.kind, "file");
  assert.equal(goal.verification.path, "result.txt");

  await fs.rm(home, { recursive: true, force: true });
});

test("cli operator missions: JSON lists inspectable mission shape", async () => {
  const home = await makeHome();
  const add = spawnSync(
    process.execPath,
    [
      path.join(root, "packages", "cli", "dist", "entry.js"),
      "operator",
      "add",
      "--home",
      home,
      "--goal",
      "inspect mission JSON",
      "--criteria",
      "json shape exists",
      "--verify-always",
      "false",
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CRIX_HOME: home, CRIX_AGENT_ENABLED: "0" },
    },
  );
  assert.equal(add.status, 0, `operator add failed\nstdout:\n${add.stdout}\nstderr:\n${add.stderr}`);

  const result = spawnSync(
    process.execPath,
    [path.join(root, "packages", "cli", "dist", "entry.js"), "operator", "missions", "--home", home, "--json"],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CRIX_HOME: home, CRIX_AGENT_ENABLED: "0" },
    },
  );

  assert.equal(result.status, 0, `operator missions failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const missions = JSON.parse(result.stdout);
  assert.equal(missions.length, 1);
  assert.equal(missions[0].intent, "inspect mission JSON");
  assert.equal(missions[0].criteria.length, 1);
  assert.equal(missions[0].probes.length, 1);
  assert.ok(Array.isArray(missions[0].unmet));
  assert.equal(typeof missions[0].canComplete, "boolean");

  await fs.rm(home, { recursive: true, force: true });
});

test("cli operator mission status: text output shows mission sections", async () => {
  const home = await makeHome();
  const add = spawnSync(
    process.execPath,
    [
      path.join(root, "packages", "cli", "dist", "entry.js"),
      "operator",
      "add",
      "--home",
      home,
      "--goal",
      "inspect mission status",
      "--criteria",
      "status prints criteria",
      "--constraint",
      "stay read-only",
      "--verify-file",
      "status.txt",
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CRIX_HOME: home, CRIX_AGENT_ENABLED: "0" },
    },
  );
  assert.equal(add.status, 0, `operator add failed\nstdout:\n${add.stdout}\nstderr:\n${add.stderr}`);
  const contract = (await listMissionContracts(home))[0];

  const result = spawnSync(
    process.execPath,
    [path.join(root, "packages", "cli", "dist", "entry.js"), "operator", "mission", "status", contract.id, "--home", home],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CRIX_HOME: home, CRIX_AGENT_ENABLED: "0" },
    },
  );

  assert.equal(result.status, 0, `operator mission status failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /criteria:/);
  assert.match(result.stdout, /constraints:/);
  assert.match(result.stdout, /probes:/);
  assert.match(result.stdout, /blockers:/);
  assert.match(result.stdout, /evidence:/);
  assert.match(result.stdout, /next action:/);

  await fs.rm(home, { recursive: true, force: true });
});

test("cli operator run: blocked completion output names unmet criteria and probes", async () => {
  const home = await makeHome();
  const workspace = await makeWorkspace();
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages", "cli", "dist", "entry.js"),
      "operator",
      "run",
      "--home",
      home,
      "--goal",
      "do not fake complete",
      "--criteria",
      "missing file is verified",
      "--verify-file",
      "missing.txt",
      "--verify-contains",
      "done",
      "--provider",
      "mock",
      "--ticks",
      "1",
    ],
    {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CRIX_HOME: home, CRIX_AGENT_ENABLED: "0" },
    },
  );

  assert.equal(result.status, 0, `operator run failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /completion blocked:/);
  assert.match(result.stdout, /pending criterion ac_1: missing file is verified/);
  assert.match(result.stdout, /failed probe vp_1: file missing\.txt contains "done"/);
  assert.match(result.stdout, /next verification: run file missing\.txt contains "done"/);

  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});
