import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  addMissionBlocker,
  addMissionEvidence,
  assessPromotionReadiness,
  capabilityEvidence,
  createGoal,
  createMissionContract,
  draftCapability,
  loadMissionContract,
  missionContractFromGoal,
  missionContractSummary,
  promoteCapability,
  parseEvalReportJson,
  recordOutcome,
  rejectCapabilityDraft,
  resolveMissionBlocker,
  runEvalSuite,
  saveMissionContract,
  listMissionContracts,
} from "../packages/operator/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

async function makeHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "crix-v8-"));
}

test("mission contract: tracks intent, criteria, blockers, next action, and proof log", async () => {
  const home = await makeHome();
  const goal = createGoal({ id: "g_contract", statement: "stabilize startup path" });
  let contract = missionContractFromGoal(goal, {
    acceptanceCriteria: ["CLI help launches", "clean removes generated output"],
    constraints: ["do not touch Tauri UI"],
    nextAction: "run eval smoke",
  });

  assert.equal(contract.goalId, goal.id);
  assert.equal(contract.intent, goal.statement);
  assert.equal(contract.progress.status, "active");
  assert.equal(contract.progress.percent, 0);

  contract = addMissionEvidence(contract, {
    kind: "verification",
    summary: "CLI help launched through built entrypoint",
    passed: true,
    criterionIds: ["ac_1"],
  });
  assert.equal(contract.progress.completedCriteria, 1);
  assert.equal(contract.progress.percent, 50);
  assert.equal(contract.acceptanceCriteria[0].evidenceIds.length, 1);
  assert.equal(contract.evidenceLog.length, 1);

  contract = addMissionBlocker(contract, { reason: "clean target missed repo-local session state" });
  assert.equal(contract.progress.status, "blocked");
  assert.match(missionContractSummary(contract), /blocker/);

  contract = resolveMissionBlocker(contract, contract.blockers[0].id, "clean now removes repo-local .crix");
  assert.equal(contract.progress.status, "active");

  contract = addMissionEvidence(contract, {
    kind: "verification",
    summary: "pnpm clean removed generated package dist and .crix",
    passed: true,
    criterionIds: ["ac_2"],
  });
  assert.equal(contract.progress.status, "satisfied");
  assert.equal(contract.progress.percent, 100);

  const file = await saveMissionContract(home, contract);
  assert.ok(file.endsWith(`${contract.id}.json`));
  assert.equal((await loadMissionContract(home, contract.id)).progress.status, "satisfied");

  await fs.rm(home, { recursive: true, force: true });
});

test("mission contract: creates standalone contracts with probes and constraints", () => {
  const contract = createMissionContract({
    intent: "ship a reliable eval harness",
    acceptanceCriteria: ["JSON report is parseable"],
    constraints: ["no generated output left behind"],
    verificationProbes: [{ kind: "always", met: true, summary: "unit fixture" }],
  });

  assert.equal(contract.acceptanceCriteria.length, 1);
  assert.equal(contract.constraints[0].required, true);
  assert.equal(contract.verificationProbes[0].kind, "always");
});

test("eval harness: returns regression-friendly pass/fail report with score", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crix-eval-harness-"));
  const report = await runEvalSuite(
    [
      {
        id: "pass",
        name: "passing task",
        category: "unit",
        async run() {
          return { evidence: ["passed fixture"] };
        },
      },
      {
        id: "returned-fail",
        name: "returned failure",
        category: "unit",
        async run() {
          return { passed: false, error: "explicit fail" };
        },
      },
      {
        id: "throw",
        name: "throwing task",
        category: "unit",
        async run() {
          throw new Error("boom");
        },
      },
    ],
    { suite: "phase1", workspace },
  );

  assert.equal(report.total, 3);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 2);
  assert.equal(report.results[0].id, "pass");
  assert.equal(report.results[0].status, "passed");
  assert.equal(report.results[1].error, "explicit fail");
  assert.equal(report.results[2].error, "boom");
  assert.equal(JSON.parse(JSON.stringify(report)).suite, "phase1");

  await fs.rm(workspace, { recursive: true, force: true });
});

test("capability promotion: requires verified outcomes, evidence, and eval success", () => {
  let node = draftCapability({ name: "summarize pull request" });
  assert.equal(node.status, "want");

  const evidence = [capabilityEvidence({ kind: "verification", summary: "fixture proved output matched expectation" })];
  const evalReport = {
    schemaVersion: 1,
    suite: "capability-fixture",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    total: 1,
    passed: 1,
    failed: 0,
    score: 1,
    results: [
      {
        id: "summarize-pr",
        name: "summarize PR fixture",
        category: "capability",
        status: "passed",
        score: 1,
        durationMs: 0,
        evidence: ["fixture passed"],
      },
    ],
  };

  let result = promoteCapability(node, { evidence, evalReport, skillRef: "summarize-pr" });
  assert.equal(result.promoted, false);
  assert.match(result.readiness.reasons.join("\n"), /verified success/);

  node = recordOutcome(recordOutcome(recordOutcome(node, true), true), true);
  assert.equal(assessPromotionReadiness(node, { evidence, evalReport }).ready, true);
  result = promoteCapability(node, { evidence, evalReport, skillRef: "summarize-pr" });
  assert.equal(result.promoted, true);
  assert.equal(result.node.status, "mastered");
  assert.equal(result.node.skillRef, "summarize-pr");
});

test("capability promotion: zero-threshold policy cannot bypass proof requirements", () => {
  const node = draftCapability({ name: "zero proof bypass attempt" });
  const result = promoteCapability(node, {
    policy: {
      minVerifiedSuccesses: 0,
      minEvidence: 0,
      minEvalPasses: 0,
      minEvalScore: 0,
    },
  });

  assert.equal(result.promoted, false);
  assert.match(result.readiness.reasons.join("\n"), /verified success/);
  assert.match(result.readiness.reasons.join("\n"), /evidence/);
  assert.match(result.readiness.reasons.join("\n"), /eval report/);
});

test("capability promotion: failed eval report blocks promotion", () => {
  let node = draftCapability({ name: "blocked by failed eval" });
  node = recordOutcome(recordOutcome(recordOutcome(node, true), true), true);
  const evidence = [capabilityEvidence({ kind: "verification", summary: "manual proof exists" })];
  const failedReport = {
    schemaVersion: 1,
    suite: "failed-fixture",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    total: 1,
    passed: 0,
    failed: 1,
    score: 0,
    results: [
      {
        id: "failed-task",
        name: "failed task",
        category: "capability",
        status: "failed",
        score: 0,
        durationMs: 0,
        evidence: [],
        error: "fixture failed",
      },
    ],
  };

  const result = promoteCapability(node, { evidence, evalReport: failedReport });
  assert.equal(result.promoted, false);
  assert.match(result.readiness.reasons.join("\n"), /failed task/);
});

test("eval report validation: forged or invalid JSON is rejected", () => {
  assert.throws(() => parseEvalReportJson("{ nope"), /invalid eval report JSON/);
  assert.throws(
    () => parseEvalReportJson(JSON.stringify({ suite: "fake", total: 1, passed: 1, failed: 0, score: 1, results: [] })),
    /schemaVersion/,
  );
  assert.throws(
    () => parseEvalReportJson(JSON.stringify({
      schemaVersion: 1,
      suite: "fake",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      total: 1,
      passed: 1,
      failed: 0,
      score: 1,
      results: [],
    })),
    /results length/,
  );
});

test("mission contract: unknown criterionId evidence is rejected", () => {
  const contract = createMissionContract({
    intent: "guard evidence IDs",
    acceptanceCriteria: ["known criterion"],
  });

  assert.throws(
    () => addMissionEvidence(contract, { summary: "bad id", criterionIds: ["missing"], passed: true }),
    /unknown mission criterion id/,
  );
});

test("eval harness: empty suite is valid and scores as complete", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "crix-empty-eval-"));
  const report = await runEvalSuite([], { suite: "empty", workspace });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.total, 0);
  assert.equal(report.passed, 0);
  assert.equal(report.failed, 0);
  assert.equal(report.score, 1);
  assert.deepEqual(report.results, []);

  await fs.rm(workspace, { recursive: true, force: true });
});

test("mission contract store: corrupt JSON is skipped when listing", async () => {
  const home = await makeHome();
  const contract = createMissionContract({ intent: "survive corrupt neighbor", acceptanceCriteria: ["ok"] });
  await saveMissionContract(home, contract);
  await fs.mkdir(path.join(home, "operator", "contracts"), { recursive: true });
  await fs.writeFile(path.join(home, "operator", "contracts", "corrupt.json"), "{not-json", "utf8");

  const contracts = await listMissionContracts(home);
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].id, contract.id);

  await fs.rm(home, { recursive: true, force: true });
});

test("capability promotion: failed drafts can be rejected or forbidden", () => {
  const draft = draftCapability({ name: "unsafe payment automation" });
  const rejected = rejectCapabilityDraft(draft, { reason: "fixture failed repeatedly" });
  assert.equal(rejected.status, "rotted");
  assert.equal(rejected.outcomes.lastError, "fixture failed repeatedly");

  const forbidden = rejectCapabilityDraft(draft, { reason: "requires unsafe credential handling", forbidden: true });
  assert.equal(forbidden.status, "forbidden");
});

test("cli eval: --json returns a parseable eval report", () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "crix-v8-cli-"));
  const result = spawnSync(process.execPath, [path.join(root, "packages", "cli", "dist", "entry.js"), "eval", "--json"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, CRIX_HOME: testHome, CRIX_AGENT_ENABLED: "0" },
  });

  assert.equal(result.status, 0, `crix eval --json failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.suite, "crix builtin");
  assert.equal(report.failed, 0);
  assert.equal(report.passed, report.total);
  assert.ok(report.results.every((item) => item.id && item.status === "passed"));
});
