// The friction gate + weekly self-audit — closing the measure-the-batch loop.
//
//   1. buildFrictionReport metric math, incl. the null guards (<10 coding
//      turns, <20 Edit calls, <20 turns) and graceful omission of fields the
//      summary doesn't carry (images, diagnostics, workStatus).
//   2. judgeFrictionGate verdicts: pass / regress / insufficient (and the
//      no-regression-but-target-unmet middle case → insufficient, exit 0).
//   3. CLI `ares friction --gate` exit codes against a temp telemetry dir with
//      synthetic friction-*.jsonl (0 pass, 3 regress, 0 insufficient+warning).
//   4. Weekly self-audit: install is idempotent, and materialization through
//      the standing-orders machinery yields a PLAN-ONLY goal carrying the
//      report + gate verdict as its evidence payload.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  buildFrictionReport,
  judgeFrictionGate,
  installWeeklySelfAudit,
  loadStandingOrders,
  materializeDueStandingOrders,
  WEEKLY_SELF_AUDIT_ID,
  FRICTION_AUDIT_PAYLOAD_KIND,
} from "../packages/operator/dist/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "packages", "cli", "dist", "entry.js");

// ── 1. metric math + null guards ─────────────────────────────────────────────

const richSummary = (over = {}) => ({
  turns: 100,
  completed: 90,
  failed: 10,
  tools: { Edit: { calls: 50, errors: 5 }, Bash: { calls: 40, errors: 1 } },
  editTiers: { exact: 30, whitespace: 5, anchor: 5, normalized: 5, miss: 5 },
  workStatus: { verified: 30, unverified: 10, blocked: 2, not_applicable: 58 },
  diagnostics: [
    { signature: "a", sample: "old_string not found", count: 12, kind: "tool_error", tool: "Edit" },
    { signature: "b", sample: "stream stall", count: 3, kind: "stream_error" },
  ],
  images: { blocks: 20, approxBytes: 1_000_000 },
  ...over,
});

test("buildFrictionReport: the three headline rates from a rich summary", () => {
  const r = buildFrictionReport(richSummary());
  const byName = Object.fromEntries(r.metrics.map((m) => [m.name, m]));
  assert.equal(byName.unverifiedRate.value, 0.25); // 10 / (30+10)
  assert.equal(byName.editErrorRate.value, 0.1); // 5 / 50
  assert.equal(byName.providerFailRate.value, 0.1); // 10 / 100
  // Baselines ride along as provenance.
  assert.equal(byName.unverifiedRate.baseline, 0.79);
  assert.equal(byName.editErrorRate.baseline, 0.23);
  assert.equal(byName.providerFailRate.baseline, 0.22);
  assert.match(byName.unverifiedRate.provenance, /49 of 62/);
  // Supporting color.
  assert.equal(r.topDiagnostics[0].sample, "old_string not found");
  assert.equal(r.imageBytesPerTurn, 10_000);
});

test("buildFrictionReport: null guards for thin samples and absent fields", () => {
  const thin = buildFrictionReport({
    turns: 5, completed: 5, failed: 0,
    tools: { Edit: { calls: 3, errors: 1 } },
    workStatus: { verified: 4, unverified: 2 }, // 6 coding turns < 10
  });
  for (const m of thin.metrics) assert.equal(m.value, null, `${m.name} must be null on thin data`);
  assert.ok(thin.metrics.every((m) => m.note), "every null metric explains itself");

  // A summary with NO workStatus / diagnostics / images field (older dist) still reports.
  const legacy = buildFrictionReport({ turns: 50, completed: 45, failed: 5, tools: { Edit: { calls: 40, errors: 2 } } });
  const byName = Object.fromEntries(legacy.metrics.map((m) => [m.name, m]));
  assert.equal(byName.unverifiedRate.value, null);
  assert.match(byName.unverifiedRate.note, /workStatus/);
  assert.equal(byName.editErrorRate.value, 0.05);
  assert.equal(byName.providerFailRate.value, 0.1);
  assert.equal(legacy.imageBytesPerTurn, null);
  assert.deepEqual(legacy.topDiagnostics, []);
});

// ── 2. verdicts ──────────────────────────────────────────────────────────────

test("judgeFrictionGate: pass when every computable metric hits target or beats baseline by 30%", () => {
  // unverifiedRate 0.5 misses target 0.3 but beats 0.79 by >30% (≤ 0.553).
  const r = buildFrictionReport(richSummary({
    failed: 2, // 0.02 ≤ 0.05 target
    tools: { Edit: { calls: 100, errors: 3 } }, // 0.03 ≤ 0.05 target
    workStatus: { verified: 10, unverified: 10 }, // 0.5 — the 30%-better leg
  }));
  const g = judgeFrictionGate(r);
  assert.equal(g.verdict, "pass");
  assert.ok(g.lines.some((l) => /verdict: pass/.test(l)), g.lines.join("\n"));
});

test("judgeFrictionGate: regress when any metric is >10% worse than baseline — even if others pass", () => {
  const r = buildFrictionReport(richSummary({
    failed: 40, // 0.4 > 0.22 * 1.1 → regressed
    tools: { Edit: { calls: 100, errors: 0 } }, // passing
    workStatus: { verified: 20, unverified: 1 }, // passing
  }));
  const g = judgeFrictionGate(r);
  assert.equal(g.verdict, "regress");
  assert.ok(g.lines.some((l) => /REGRESSED/.test(l)));
});

test("judgeFrictionGate: insufficient when nothing computable, and for the improving-but-unmet middle", () => {
  const none = judgeFrictionGate(buildFrictionReport({ turns: 3, completed: 3, failed: 0, tools: {} }));
  assert.equal(none.verdict, "insufficient");

  // Better than baseline+10% but neither at target nor 30% better → no regression, no pass.
  const middle = judgeFrictionGate(buildFrictionReport(richSummary({
    failed: 20, // 0.2: below 0.242, above 0.154 (30% better) and 0.05 target
    tools: { Edit: { calls: 100, errors: 20 } }, // 0.2: below 0.253, above target/0.161
    workStatus: { verified: 30, unverified: 22 }, // ~0.42: below .553? 0.423 ≤ 0.553 → passes; fine
  })));
  assert.equal(middle.verdict, "insufficient");
  assert.ok(middle.lines.some((l) => /no regression/.test(l)), middle.lines.join("\n"));
});

// ── 3. CLI --gate exit codes against synthetic telemetry ─────────────────────

function frictionRow(over = {}) {
  return JSON.stringify({
    schemaVersion: 2,
    recordType: "friction_turn",
    at: new Date().toISOString(),
    sessionId: "sess_gate",
    status: "completed",
    workStatus: "verified",
    durationMs: 1000,
    tools: { Edit: { calls: 2, errors: 0 } },
    editTiers: { exact: 2, whitespace: 0, anchor: 0, normalized: 0, miss: 0 },
    stalls: 0, reasoningStalls: 0, verifyReminders: 0, compactions: 0,
    images: { blocks: 0, approxBytes: 0 },
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 },
    cacheReadRatio: 0.8,
    ...over,
  });
}

async function seedTelemetry(home, rows) {
  const dir = path.join(home, "telemetry");
  await mkdir(dir, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  await writeFile(path.join(dir, `friction-${month}.jsonl`), rows.join("\n") + "\n");
}

function runGate(home) {
  const res = spawnSync(process.execPath, [CLI, "friction", "--gate"], {
    env: { ...process.env, ARES_HOME: home, NODE_TEST_CONTEXT: "" },
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}

test("CLI friction --gate: pass → exit 0, regress → exit 3, insufficient → exit 0 with warning", async (t) => {
  const passHome = await mkdtemp(path.join(tmpdir(), "ares-gate-pass-"));
  const regressHome = await mkdtemp(path.join(tmpdir(), "ares-gate-regress-"));
  const thinHome = await mkdtemp(path.join(tmpdir(), "ares-gate-thin-"));
  t.after(async () => {
    for (const h of [passHome, regressHome, thinHome]) await rm(h, { recursive: true, force: true });
  });

  // 30 clean turns: providerFailRate 0, editErrorRate 0 → pass regardless of
  // whether the built dist aggregates workStatus yet (then unverifiedRate=0 too).
  await seedTelemetry(passHome, Array.from({ length: 30 }, () => frictionRow()));
  const pass = runGate(passHome);
  assert.equal(pass.code, 0, pass.out);
  assert.match(pass.out, /verdict: pass/);

  // 30 turns, 15 failed → providerFailRate 0.5 >> baseline*1.1 → exit 3.
  await seedTelemetry(
    regressHome,
    Array.from({ length: 30 }, (_, i) => frictionRow(i < 15 ? { status: "failed", workStatus: null } : {})),
  );
  const regress = runGate(regressHome);
  assert.equal(regress.code, 3, regress.out);
  assert.match(regress.out, /verdict: regress/);

  // 5 turns → nothing computable → exit 0 but the verdict says insufficient.
  await seedTelemetry(thinHome, Array.from({ length: 5 }, () => frictionRow({ tools: {} })));
  const thin = runGate(thinHome);
  assert.equal(thin.code, 0, thin.out);
  assert.match(thin.out, /insufficient/);

  // --report prints the metrics without judging (and exits 0).
  const report = spawnSync(process.execPath, [CLI, "friction", "--report"], {
    env: { ...process.env, ARES_HOME: passHome, NODE_TEST_CONTEXT: "" },
    encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  assert.equal(report.status, 0, `${report.stdout}\n${report.stderr}`);
  assert.match(report.stdout, /editErrorRate/);
  assert.doesNotMatch(report.stdout, /verdict:/);
});

// ── 4. weekly self-audit standing order ──────────────────────────────────────

test("weekly self-audit: idempotent install + materialization carries the report as a plan-only goal", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-audit-"));
  try {
    await seedTelemetry(home, Array.from({ length: 30 }, (_, i) => frictionRow(i < 15 ? { status: "failed" } : {})));

    const order = await installWeeklySelfAudit(home);
    assert.equal(order.id, WEEKLY_SELF_AUDIT_ID);
    assert.equal(order.payloadKind, FRICTION_AUDIT_PAYLOAD_KIND);
    assert.equal(order.cadenceMs, 7 * 86_400_000);

    // Re-install is idempotent — still exactly one order, history preserved.
    await installWeeklySelfAudit(home);
    const orders = await loadStandingOrders(home);
    assert.equal(orders.filter((o) => o.id === WEEKLY_SELF_AUDIT_ID).length, 1);

    // The GENERIC standing-orders materializer routes through the payload
    // builder: the goal is plan-only and carries this week's evidence.
    const { goals, fired } = await materializeDueStandingOrders(home, new Date());
    assert.equal(fired.length, 1);
    assert.equal(goals.length, 1);
    const goal = goals[0];
    assert.equal(goal.mode, "plan", "the audit goal must never auto-execute");
    assert.match(goal.statement, /plan ONLY/i);
    assert.match(goal.statement, /Friction report/);
    assert.match(goal.statement, /providerFailRate/);
    assert.match(goal.statement, /verdict: regress/); // 15/30 failed → regress evidence attached
    assert.match(goal.statement, /baseline 0\.22/); // provenance rides into the goal

    // Cadence respected: an immediate second tick does not re-fire.
    const again = await materializeDueStandingOrders(home, new Date(Date.now() + 1000));
    assert.equal(again.fired.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
