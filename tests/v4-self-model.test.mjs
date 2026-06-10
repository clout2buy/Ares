// Verifies the self-model store — the substrate that lets Ares know itself:
//   1. Empty/missing model loads as empty, never throws.
//   2. recordOutcome upserts a new capability and folds run stats.
//   3. Repeated outcomes accumulate runs/ok/fail + rolling avgMs.
//   4. upsertCapability sets status; want -> have on first real outcome.
//   5. dropCapability removes a node.
//   6. summarizeSelf reports reliability, top + flaky lists.
//   7. Persisted to ~/.ares/self/model.json and reloads identically.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadSelfModel,
  recordOutcome,
  upsertCapability,
  dropCapability,
  summarizeSelf,
  getCapability,
} from "../packages/agent/dist/index.js";

async function makeHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ares-self-"));
}

test("empty model loads when nothing on disk", async () => {
  const home = await makeHome();
  const model = await loadSelfModel(home);
  assert.equal(model.version, 1);
  assert.deepEqual(model.capabilities, {});
});

test("recordOutcome upserts a new capability and folds the first run", async () => {
  const home = await makeHome();
  const cap = await recordOutcome(home, { id: "skill/double", kind: "skill", name: "double", ok: true, ms: 120 });
  assert.equal(cap.status, "have");
  assert.equal(cap.outcomes.runs, 1);
  assert.equal(cap.outcomes.ok, 1);
  assert.equal(cap.outcomes.fail, 0);
  assert.equal(cap.outcomes.avgMs, 120);
});

test("repeated outcomes accumulate and track last error", async () => {
  const home = await makeHome();
  await recordOutcome(home, { id: "skill/x", kind: "skill", ok: true, ms: 100 });
  await recordOutcome(home, { id: "skill/x", kind: "skill", ok: false, ms: 200, error: "boom" });
  const cap = await recordOutcome(home, { id: "skill/x", kind: "skill", ok: true, ms: 300 });
  assert.equal(cap.outcomes.runs, 3);
  assert.equal(cap.outcomes.ok, 2);
  assert.equal(cap.outcomes.fail, 1);
  assert.equal(cap.outcomes.lastError, "boom"); // sticky until next failure
  assert.ok(cap.outcomes.avgMs > 100 && cap.outcomes.avgMs <= 300);
});

test("upsertCapability sets want, then a real outcome promotes to have", async () => {
  const home = await makeHome();
  await upsertCapability(home, { id: "skill/send_email", kind: "skill", name: "send_email", status: "want" });
  let model = await loadSelfModel(home);
  assert.equal(getCapability(model, "skill/send_email").status, "want");

  await recordOutcome(home, { id: "skill/send_email", kind: "skill", ok: true, ms: 50 });
  model = await loadSelfModel(home);
  assert.equal(getCapability(model, "skill/send_email").status, "have");
});

test("dropCapability removes a node", async () => {
  const home = await makeHome();
  await recordOutcome(home, { id: "skill/temp", kind: "skill", ok: true });
  assert.equal(await dropCapability(home, "skill/temp"), true);
  const model = await loadSelfModel(home);
  assert.equal(getCapability(model, "skill/temp"), undefined);
  assert.equal(await dropCapability(home, "skill/temp"), false);
});

test("summarizeSelf reports reliability, top + flaky", async () => {
  const home = await makeHome();
  // reliable skill
  for (let i = 0; i < 4; i++) await recordOutcome(home, { id: "skill/solid", kind: "skill", name: "solid", ok: true, ms: 10 });
  // flaky skill
  await recordOutcome(home, { id: "skill/flak", kind: "skill", name: "flak", ok: true, ms: 10 });
  await recordOutcome(home, { id: "skill/flak", kind: "skill", name: "flak", ok: false, error: "nope" });
  await recordOutcome(home, { id: "skill/flak", kind: "skill", name: "flak", ok: false, error: "again" });
  // a wanted capability with no runs
  await upsertCapability(home, { id: "skill/wish", kind: "skill", name: "wish", status: "want" });

  const s = summarizeSelf(await loadSelfModel(home));
  assert.equal(s.total, 3);
  assert.equal(s.want, 1);
  assert.equal(s.skills, 3);
  assert.ok(s.reliability > 0 && s.reliability < 1);
  assert.equal(s.topReliable[0].id, "skill/solid");
  assert.equal(s.flaky[0].id, "skill/flak");
});

test("model persists to ~/.ares/self/model.json", async () => {
  const home = await makeHome();
  await recordOutcome(home, { id: "skill/p", kind: "skill", ok: true, ms: 5 });
  const onDisk = JSON.parse(await fs.readFile(path.join(home, "self", "model.json"), "utf8"));
  assert.equal(onDisk.version, 1);
  assert.ok(onDisk.capabilities["skill/p"]);
});
