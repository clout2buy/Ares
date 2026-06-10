// Verifies the reflection engine + the Self tool:
//   1. reflect() flags a failing skill as a "fix" directive.
//   2. reflect() flags an always-fail skill as "prune".
//   3. reflect() flags a wanted capability as "acquire".
//   4. a healthy model yields no directives.
//   5. Self tool: status summarizes, want declares a gap, reflect emits event.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  reflect,
  recordOutcome,
  upsertCapability,
  loadSelfModel,
  SelfTool,
  onLifecycle,
} from "../packages/agent/dist/index.js";

const ctx = { workspace: process.cwd(), signal: new AbortController().signal };

async function makeHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ares-reflect-"));
}

test("reflect flags a failing skill as fix", async () => {
  const home = await makeHome();
  await recordOutcome(home, { id: "skill/f", kind: "skill", name: "f", ok: true, ms: 5 });
  await recordOutcome(home, { id: "skill/f", kind: "skill", name: "f", ok: false, error: "e1" });
  await recordOutcome(home, { id: "skill/f", kind: "skill", name: "f", ok: false, error: "e2" });
  const dirs = reflect(await loadSelfModel(home));
  const fix = dirs.find((d) => d.capabilityId === "skill/f");
  assert.ok(fix, "directive produced");
  assert.equal(fix.kind, "fix");
  assert.match(fix.reason, /failing/);
});

test("reflect flags an always-fail skill as prune", async () => {
  const home = await makeHome();
  for (let i = 0; i < 3; i++) await recordOutcome(home, { id: "skill/dead", kind: "skill", name: "dead", ok: false, error: "broken" });
  const dirs = reflect(await loadSelfModel(home));
  const d = dirs.find((x) => x.capabilityId === "skill/dead");
  assert.equal(d.kind, "prune");
  assert.match(d.reason, /never succeeded/);
});

test("reflect flags a wanted capability as acquire", async () => {
  const home = await makeHome();
  await upsertCapability(home, { id: "skill/browse", kind: "skill", name: "browse", status: "want" });
  const dirs = reflect(await loadSelfModel(home));
  const d = dirs.find((x) => x.capabilityId === "skill/browse");
  assert.equal(d.kind, "acquire");
});

test("a healthy model yields no directives", async () => {
  const home = await makeHome();
  for (let i = 0; i < 4; i++) await recordOutcome(home, { id: "skill/ok", kind: "skill", name: "ok", ok: true, ms: 5 });
  const dirs = reflect(await loadSelfModel(home));
  assert.equal(dirs.length, 0);
});

test("prune (always-fail) outranks fix in severity ordering", async () => {
  const home = await makeHome();
  // a fix-worthy skill (50% fail)
  await recordOutcome(home, { id: "skill/half", kind: "skill", name: "half", ok: true });
  await recordOutcome(home, { id: "skill/half", kind: "skill", name: "half", ok: false, error: "x" });
  await recordOutcome(home, { id: "skill/half", kind: "skill", name: "half", ok: false, error: "x" });
  // an always-fail skill
  for (let i = 0; i < 3; i++) await recordOutcome(home, { id: "skill/never", kind: "skill", name: "never", ok: false, error: "x" });
  const dirs = reflect(await loadSelfModel(home));
  assert.equal(dirs[0].kind, "prune");
  assert.equal(dirs[0].capabilityId, "skill/never");
});

test("Self tool: status, want, and reflect emit a lifecycle event", async () => {
  const home = await makeHome();
  process.env.ARES_HOME = home;
  const seen = [];
  const off = onLifecycle((e) => {
    if (e.type === "self_reflected") seen.push(e);
  });
  try {
    await recordOutcome(home, { id: "skill/a", kind: "skill", name: "a", ok: false, error: "boom" });
    await recordOutcome(home, { id: "skill/a", kind: "skill", name: "a", ok: false, error: "boom" });
    await recordOutcome(home, { id: "skill/a", kind: "skill", name: "a", ok: false, error: "boom" });

    const status = await SelfTool.call({ action: "status" }, ctx);
    assert.ok(status.output.summary.total >= 1);
    assert.ok(Array.isArray(status.output.capabilities));

    const want = await SelfTool.call({ action: "want", name: "Send Email", description: "reach inboxes" }, ctx);
    assert.equal(want.output.capability.status, "want");
    assert.equal(want.output.capability.id, "skill/send_email");

    const refl = await SelfTool.call({ action: "reflect" }, ctx);
    assert.ok(refl.output.directives.length >= 2); // fix skill/a + acquire skill/send_email
    assert.equal(seen.length, 1);
    assert.equal(seen[0].directives, refl.output.directives.length);
  } finally {
    off();
    delete process.env.ARES_HOME;
  }
});
