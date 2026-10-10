// ares-verify + ares-deploy against a throwaway git forge, a fake gateway and a stub systemctl.
// Proves: success, failed smoke -> auto rollback, build failure -> rollback without a restart, a
// deploy that cannot restart, concurrent-deploy refusal, unsigned / red / tampered result refusal,
// high-risk gating, idle gate + drain, dry run changes nothing, branch and fast-forward refusals.
// Never touches a real ~/Ares, ~/.ares or service.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fsp, existsSync, statSync } from "node:fs";

import { makeForge, git, FAST_COMMANDS, NODE_OK } from "./_elite-fixture.mjs";
import { verifyChange, parseTestSummary } from "../scripts/elite/lib/verify.mjs";
import { deployChange, acquireLock, EXIT } from "../scripts/elite/lib/deploy.mjs";
import { canonical, hmac, loadKey, resultsDir, sign, verifySignature, lockFile } from "../scripts/elite/lib/common.mjs";
import { classifyChange, scanDiffForSecrets } from "../scripts/elite/lib/risk.mjs";

async function verified(f, branch, files, extra = {}) {
  const sha = f.commit(branch, files);
  const v = await verifyChange(f.verifyOpts(sha, { branch, ...extra }));
  return { sha, v };
}

// ---------------------------------------------------------------- verify

test("verify: green change writes a signed result and cleans up its worktree and TMPDIR", async (t) => {
  const f = await makeForge(t);
  const { sha, v } = await verified(f, "auto/2026-10-01-ok", { "app.js": "export const x = 2;\n" });
  assert.equal(v.green, true);
  assert.equal(v.payload.tests.pass, 3);
  assert.equal(v.payload.risk.class, "low");
  assert.ok(verifySignature(v.doc, loadKey({ home: f.home })));
  assert.equal(path.basename(v.file), `${sha}.json`);
  assert.deepEqual(await fsp.readdir(f.work), [], "worktree removed");
  assert.deepEqual(await fsp.readdir(f.tmp), [], "TMPDIR removed");
  if (process.platform !== "win32") assert.equal(statSync(path.join(f.home, "elite", "verify.key")).mode & 0o777, 0o600);
});

test("verify: failing tests make a signed RED result naming the failure", async (t) => {
  const f = await makeForge(t);
  const { v } = await verified(f, "auto/red", { VERSION: "v2 FAILTEST\n" });
  assert.equal(v.green, false);
  assert.equal(v.payload.tests.fail, 1);
  assert.ok(verifySignature(v.doc, loadKey({ home: f.home })), "a red result is still signed, so the Maintainer can read it");
  assert.ok(v.payload.steps.find((s) => s.name === "test" && !s.ok));
});

test("verify: a secret in the added lines is red even when every test passes", async (t) => {
  const f = await makeForge(t);
  const fake = "gh" + "p_" + "A".repeat(36);
  const { v } = await verified(f, "auto/secret", { "notes.txt": `token is ${fake}\n` });
  assert.equal(v.green, false);
  assert.ok(v.payload.steps.find((s) => s.name === "secret-scan" && !s.ok));
  assert.ok(!JSON.stringify(v.doc).includes(fake), "the secret itself never lands in the result");
});

test("verify: touching a policy file is flagged HIGH-RISK and requires owner approval", async (t) => {
  const f = await makeForge(t);
  const { v } = await verified(f, "auto/policy", { "packages/cli/src/policyGate.ts": "export const gate = false;\n" });
  assert.equal(v.green, true);
  assert.equal(v.payload.risk.class, "high");
  assert.equal(v.payload.risk.requiresOwnerApproval, true);
  assert.ok(v.payload.risk.protectedFiles.includes("packages/cli/src/policyGate.ts"));
});

test("verify: a later step is not run on a red build, and the result says so", async (t) => {
  const f = await makeForge(t);
  const sha = f.commit("auto/buildbroken", { "app.js": "export const y = 1;\n" });
  const v = await verifyChange(f.verifyOpts(sha, { commands: { ...FAST_COMMANDS, build: 'node -e "process.exit(1)"' } }));
  assert.equal(v.green, false);
  const names = v.payload.steps.filter((s) => !s.ok).map((s) => s.name);
  assert.ok(names.includes("build") && names.includes("lint") && names.includes("test"));
});

test("parseTestSummary reads tap and spec output", () => {
  assert.deepEqual(
    (({ total, pass, fail, skipped, parsed }) => ({ total, pass, fail, skipped, parsed }))(parseTestSummary("# tests 3567\n# pass 3539\n# fail 0\n# skipped 28\n")),
    { total: 3567, pass: 3539, fail: 0, skipped: 28, parsed: true },
  );
  const spec = parseTestSummary("✖ the broken thing (3.1ms)\nℹ tests 5\nℹ pass 4\nℹ fail 1\nℹ skipped 0\n");
  assert.equal(spec.fail, 1);
  assert.deepEqual(spec.failedNames, ["the broken thing"]);
  assert.equal(parseTestSummary("crashed").parsed, false);
});

test("risk: dependency, deleted-test and weakened-test changes are high risk; plain edits are not", () => {
  const f = (p, status = "M") => ({ path: p, status, added: 1, deleted: 1 });
  assert.equal(classifyChange([f("packages/tools/src/x.ts")]).class, "low");
  assert.equal(classifyChange([f("packages/core/src/queryEngine.ts")]).class, "medium");
  assert.equal(classifyChange([f("pnpm-lock.yaml")]).class, "high");
  assert.equal(classifyChange([f("tests/a.test.mjs", "D")]).class, "high");
  assert.equal(classifyChange([f("packages/garrison/src/token.ts")]).class, "high");
  assert.equal(classifyChange([f("packages/core/src/ownerPause.ts")]).class, "high");
  assert.equal(classifyChange([f("packages/garrison/src/approvals.ts")]).class, "high");
  assert.equal(classifyChange([f("scripts/elite/lib/deploy.mjs")]).class, "high");
  assert.equal(classifyChange([f("docs/oauth.md")]).class, "low", "a doc that mentions oauth is not an auth change");
  const weak = "diff --git a/tests/a.test.mjs b/tests/a.test.mjs\n@@ -1,2 +1 @@\n-test('a', () => {});\n-test('b', () => {});\n+test('a', () => {});\n";
  assert.equal(classifyChange([f("tests/a.test.mjs")], weak).class, "high");
  const pkg = "diff --git a/packages/x/package.json b/packages/x/package.json\n@@ -3 +3 @@\n-    \"left-pad\": \"^1.0.0\",\n+    \"left-pad\": \"^1.3.0\",\n";
  assert.equal(classifyChange([f("packages/x/package.json")], pkg).class, "high");
  assert.equal(classifyChange([f("packages/x/package.json")], "diff --git a/packages/x/package.json b/packages/x/package.json\n@@ -2 +2 @@\n-  \"description\": \"a\"\n+  \"description\": \"b\"\n").class, "low");
});

test("risk: the secret scanner reports file and line, never the value, and honours the ignore marker", () => {
  const key = "sk-" + "a1B2c3D4".repeat(4);
  const diff = `+++ b/src/a.ts\n@@ -0,0 +1,3 @@\n+const a = 1;\n+const k = "${key}";\n+const ok = "${key}"; // ares-secret-scan: ignore\n`;
  const found = scanDiffForSecrets(diff);
  assert.deepEqual(found, [{ file: "src/a.ts", line: 2, rule: "API secret key" }]);
});

// ---------------------------------------------------------------- signing

test("signing: canonical form ignores key order; any change to the payload or the key breaks the signature", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  const key = "ab".repeat(32);
  const doc = sign({ sha: "x", green: false }, key);
  assert.ok(verifySignature(doc, key));
  assert.ok(!verifySignature({ ...doc, payload: { ...doc.payload, green: true } }, key), "flipped green");
  assert.ok(!verifySignature(doc, "cd".repeat(32)), "wrong key");
  assert.ok(!verifySignature({ ...doc, sig: doc.sig.slice(0, -2) + "00" }, key), "mangled sig");
  assert.ok(!verifySignature({ payload: doc.payload }, key), "missing sig");
  assert.ok(!verifySignature(doc, null), "no key");
  assert.equal(hmac({ a: 1 }, key), hmac({ a: 1 }, key));
});

// ---------------------------------------------------------------- deploy

test("deploy: verified change goes live, restarts once, passes smoke, records and notifies", async (t) => {
  const f = await makeForge(t);
  const before = f.head();
  const { sha } = await verified(f, "auto/2026-10-01-good", { VERSION: "v2\n" });
  const out = await deployChange(f.deployOpts(sha, { title: "Fix the thing", proposalId: "prop_1" }));
  assert.equal(out.status, "success");
  assert.equal(out.exitCode, EXIT.ok);
  assert.equal(f.head(), sha);
  assert.equal(f.restarts(), 1);
  assert.equal(f.running(), "v2");
  assert.equal(out.record.previousSha, before);
  assert.equal(out.record.proposalId, "prop_1");
  assert.ok(out.record.smoke.before.every((c) => c.ok) && out.record.smoke.after.every((c) => c.ok));
  assert.ok(out.record.smoke.after.find((c) => c.name === "ask"), "a scripted /gateway/ask ran");
  assert.ok(existsSync(out.recordFile));
  assert.ok(!existsSync(lockFile(f.home)), "lock released");
  assert.equal(f.calls.notify.at(-1).title, "Ares updated");
  assert.ok(!JSON.stringify(out.record).includes("0123456789abcdef0123456789abcdef"), "no token in the record");
  assert.deepEqual(await fsp.readdir(path.join(f.home, "elite", "outbox")).catch(() => []), [], "delivered notifications leave the outbox");
});

test("deploy: smoke fails after restart -> automatic rollback to the recorded sha, rebuilt and restarted", async (t) => {
  const f = await makeForge(t);
  const before = f.head();
  const { sha } = await verified(f, "auto/break", { VERSION: "v2 BREAK\n" });
  const out = await deployChange(f.deployOpts(sha));
  assert.equal(out.status, "rolled-back");
  assert.equal(out.exitCode, EXIT.rolledBack);
  assert.equal(f.head(), before, "live tree is back on the previous commit");
  assert.equal(f.restarts(), 2, "restarted onto the change, then again onto the rollback");
  assert.equal(f.running(), "v1");
  assert.equal(out.record.rollback.ok, true);
  assert.ok(out.record.rollback.steps.some((s) => s.name === "ready" && s.ok));
  assert.match(f.calls.notify.at(-1).title, /rolled back/i);
});

test("deploy: a regression in a non-health check (/gateway/health/deep) also rolls back", async (t) => {
  const f = await makeForge(t);
  const before = f.head();
  const { sha } = await verified(f, "auto/deepbad", { VERSION: "v2 DEEPBAD\n" });
  const out = await deployChange(f.deployOpts(sha));
  assert.equal(out.status, "rolled-back");
  assert.match(out.record.reason, /health-deep/);
  assert.equal(f.head(), before);
});

test("deploy: a check that was already failing before the deploy does not blame the new code", async (t) => {
  const f = await makeForge(t);
  await fsp.writeFile(path.join(f.state, "running-version"), "v1 GOALS500\n");
  // The live tree's VERSION is v1 but the running process is the "already broken" one; the new
  // version keeps /gateway/goals broken the same way, so it must not be rolled back for it.
  const { sha } = await verified(f, "auto/same", { VERSION: "v2 GOALS500\n" });
  const out = await deployChange(f.deployOpts(sha));
  assert.equal(out.status, "success");
  assert.ok(out.record.smoke.before.find((c) => c.name === "goals" && !c.ok));
});

test("deploy: a build failure rolls back WITHOUT restarting the service", async (t) => {
  const f = await makeForge(t);
  const before = f.head();
  const { sha } = await verified(f, "auto/buildfail", { VERSION: "v2 BUILDFAIL\n" }, { commands: { ...FAST_COMMANDS, build: NODE_OK } });
  const out = await deployChange(f.deployOpts(sha));
  assert.equal(out.status, "rolled-back");
  assert.equal(f.restarts(), 0);
  assert.equal(f.head(), before);
});

test("deploy: a failed restart rolls back and tries to bring the old version up", async (t) => {
  const f = await makeForge(t);
  const before = f.head();
  const { sha } = await verified(f, "auto/restartfail", { VERSION: "v2\n" });
  await fsp.writeFile(path.join(f.state, "restart-fails"), "1");
  const out = await deployChange(f.deployOpts(sha));
  // The shim keeps failing, so the rollback's own restart fails too: that must be reported loudly.
  assert.equal(out.status, "rollback-failed");
  assert.equal(out.exitCode, EXIT.rollbackFailed);
  assert.equal(f.head(), before, "the tree was still restored");
  assert.match(f.calls.notify.at(-1).title, /ROLLBACK FAILED/);
});

test("deploy: a concurrent deploy is refused while the lock is held, and a dead holder's lock is reclaimed", async (t) => {
  const f = await makeForge(t);
  const { sha } = await verified(f, "auto/lock", { VERSION: "v2\n" });
  const held = await acquireLock(f.home, { id: "other", sha });
  assert.ok(held.ok);
  const refused = await deployChange(f.deployOpts(sha));
  assert.equal(refused.status, "refused-locked");
  assert.equal(refused.exitCode, EXIT.locked);
  assert.equal(f.restarts(), 0);
  await held.release();
  await fsp.writeFile(lockFile(f.home), JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
  const ok = await deployChange(f.deployOpts(sha));
  assert.equal(ok.status, "success", "a lock left by a dead process does not wedge deploys");
});

test("deploy: two deploys started together -> exactly one runs", async (t) => {
  const f = await makeForge(t);
  const { sha } = await verified(f, "auto/race", { VERSION: "v2\n" });
  const [a, b] = await Promise.all([deployChange(f.deployOpts(sha)), deployChange(f.deployOpts(sha))]);
  assert.deepEqual([a.status, b.status].sort(), ["refused-locked", "success"]);
  assert.equal(f.restarts(), 1);
});

test("deploy: no result, a red result, a tampered result and another commit's result are all refused", async (t) => {
  const f = await makeForge(t);
  // no result
  const sha0 = f.commit("auto/noresult", { VERSION: "v2\n" });
  let out = await deployChange(f.deployOpts(sha0));
  assert.equal(out.status, "refused");
  assert.match(out.record.reason, /no verification result/);

  // red
  const red = await verified(f, "auto/red2", { VERSION: "v2 FAILTEST\n" });
  out = await deployChange(f.deployOpts(red.sha));
  assert.match(out.record.reason, /RED/);

  // tampered: flip green by hand
  const green = await verified(f, "auto/tamper", { VERSION: "v2\n" });
  const file = path.join(resultsDir(f.home), `${green.sha}.json`);
  const doc = JSON.parse(await fsp.readFile(file, "utf8"));
  doc.payload.risk = { class: "low", reasons: [], requiresOwnerApproval: false };
  doc.payload.tests.pass = 9999;
  await fsp.writeFile(file, JSON.stringify(doc));
  out = await deployChange(f.deployOpts(green.sha));
  assert.match(out.record.reason, /signature is invalid/);

  // a hand-forged red -> green flip on a red result
  const doc2 = JSON.parse(await fsp.readFile(path.join(resultsDir(f.home), `${red.sha}.json`), "utf8"));
  doc2.payload.green = true;
  await fsp.writeFile(path.join(resultsDir(f.home), `${red.sha}.json`), JSON.stringify(doc2));
  out = await deployChange(f.deployOpts(red.sha));
  assert.match(out.record.reason, /signature is invalid/);

  // a green result copied from another commit
  const a = await verified(f, "auto/a", { VERSION: "v3\n" });
  const b = f.commit("auto/b", { VERSION: "v4\n" });
  await fsp.copyFile(path.join(resultsDir(f.home), `${a.sha}.json`), path.join(resultsDir(f.home), `${b}.json`));
  out = await deployChange(f.deployOpts(b));
  assert.match(out.record.reason, /different commit/);

  // signed with another key
  const other = await verified(f, "auto/otherkey", { VERSION: "v5\n" });
  await fsp.writeFile(path.join(f.home, "elite", "verify.key"), "ff".repeat(32) + "\n");
  out = await deployChange(f.deployOpts(other.sha));
  assert.match(out.record.reason, /signature is invalid/);
  assert.equal(f.restarts(), 0, "nothing was restarted by any refused deploy");
  assert.equal(f.head(), git(f.live, "rev-parse", "HEAD"));
});

test("deploy: high-risk change needs an explicit acknowledgement, not just --yes", async (t) => {
  const f = await makeForge(t);
  const { sha } = await verified(f, "auto/policy2", { "packages/cli/src/policyGate.ts": "export const gate = false;\n" });
  let out = await deployChange(f.deployOpts(sha));
  assert.equal(out.status, "refused");
  assert.match(out.record.reason, /HIGH-RISK/);
  assert.equal(f.restarts(), 0);
  out = await deployChange(f.deployOpts(sha, { ackHighRisk: true }));
  assert.equal(out.status, "success");
  assert.equal(out.record.risk.class, "high");
});

test("deploy: a stale 'low' in the result cannot hide a high-risk diff (risk is recomputed from the live tree)", async (t) => {
  const f = await makeForge(t);
  const sha = f.commit("auto/liar", { "packages/garrison/src/token.ts": "export const t = 1;\n" });
  // A verifier that lied about risk, but signed correctly with the real key.
  const key = loadKey({ home: f.home, create: true });
  const tree = git(f.author, "rev-parse", `${sha}^{tree}`);
  const doc = sign({ schema: 1, sha, tree, branch: "auto/liar", base: f.head(), baseKnown: true, verifiedAt: new Date().toISOString(), green: true, steps: [], tests: { total: 1, pass: 1, fail: 0, skipped: 0 }, risk: { class: "low", reasons: [], requiresOwnerApproval: false } }, key);
  await fsp.mkdir(resultsDir(f.home), { recursive: true });
  await fsp.writeFile(path.join(resultsDir(f.home), `${sha}.json`), JSON.stringify(doc));
  const out = await deployChange(f.deployOpts(sha));
  assert.equal(out.status, "refused");
  assert.match(out.record.reason, /HIGH-RISK/);
});

test("deploy: approval receipt must be signed, for this commit, from the owner, and acknowledge high risk", async (t) => {
  const f = await makeForge(t);
  const key = loadKey({ home: f.home, create: true });
  const low = await verified(f, "auto/r1", { VERSION: "v2\n" });
  const receipt = (sha, extra = {}) => sign({ kind: "deploy-approval", proposalId: "p1", sha, approvedBy: "owner", approvedAt: new Date().toISOString(), ackHighRisk: false, ...extra }, key);
  const put = async (name, doc) => { const p = path.join(f.root, name); await fsp.writeFile(p, JSON.stringify(doc)); return p; };

  const forged = receipt(low.sha); forged.payload.approvedBy = "owner"; forged.sig = forged.sig.slice(0, -1) + "0";
  let out = await deployChange(f.deployOpts(low.sha, { yes: false, receiptFile: await put("forged.json", forged) }));
  assert.match(out.record.reason, /signature/);
  out = await deployChange(f.deployOpts(low.sha, { yes: false, receiptFile: await put("other.json", receipt("0".repeat(40))) }));
  assert.match(out.record.reason, /different commit/);
  out = await deployChange(f.deployOpts(low.sha, { yes: false, receiptFile: await put("agent.json", receipt(low.sha, { approvedBy: "agent" })) }));
  assert.match(out.record.reason, /owner/);
  out = await deployChange(f.deployOpts(low.sha, { yes: false, receiptFile: await put("old.json", receipt(low.sha, { approvedAt: new Date(Date.now() - 48 * 3_600_000).toISOString() })) }));
  assert.match(out.record.reason, /stale/);
  out = await deployChange(f.deployOpts(low.sha, { yes: false }));
  assert.match(out.record.reason, /owner approval required/, "no flag, no receipt, no TTY: refused");

  const high = await verified(f, "auto/r2", { "packages/garrison/src/approvals.ts": "export const q = 1;\n" });
  out = await deployChange(f.deployOpts(high.sha, { yes: false, receiptFile: await put("noack.json", receipt(high.sha)) }));
  assert.match(out.record.reason, /does not acknowledge/);
  assert.equal(f.restarts(), 0);

  out = await deployChange(f.deployOpts(high.sha, { yes: false, receiptFile: await put("ok.json", receipt(high.sha, { ackHighRisk: true })) }));
  assert.equal(out.status, "success");
  assert.equal(out.record.approval.via, "receipt");
});

test("deploy: sessions mid-turn -> refused (busy); --drain waits for idle and tells the phone; a drain that times out changes nothing", async (t) => {
  const f = await makeForge(t);
  const { sha } = await verified(f, "auto/busy", { VERSION: "v2\n" });
  f.setTurns(2);
  let out = await deployChange(f.deployOpts(sha));
  assert.equal(out.status, "refused-busy");
  assert.equal(out.exitCode, EXIT.busy);
  assert.equal(f.restarts(), 0);
  assert.match(f.calls.notify.at(-1).title, /waiting/i);

  // drain times out
  out = await deployChange(f.deployOpts(sha, { drainMin: 0.002 })); // ~120ms
  assert.equal(out.status, "refused-busy");
  assert.equal(f.restarts(), 0);
  assert.equal(f.calls.notify.at(-1).data.reason, "drain-timeout");

  // drain succeeds once the turns finish
  const seen = f.calls.notify.length;
  const release = setInterval(() => { if (f.calls.notify.slice(seen).some((n) => n.data.reason === "draining")) { f.setTurns(0); clearInterval(release); } }, 10);
  t.after(() => clearInterval(release));
  out = await deployChange(f.deployOpts(sha, { drainMin: 1 }));
  assert.equal(out.status, "success");
  assert.ok(f.calls.notify.some((n) => n.data.reason === "draining"), "the phone was told it is waiting");
  assert.ok(out.record.drained);
});

test("deploy: --dry-run decides everything and changes nothing", async (t) => {
  const f = await makeForge(t);
  const before = f.head();
  const { sha } = await verified(f, "auto/dry", { VERSION: "v2\n" });
  const out = await deployChange(f.deployOpts(sha, { dryRun: true }));
  assert.equal(out.status, "dry-run");
  assert.equal(out.recordFile, null);
  assert.equal(f.head(), before);
  assert.equal(f.restarts(), 0);
  assert.ok(out.record.steps.some((s) => s.name === "plan"));
  assert.ok(!existsSync(path.join(f.home, "elite", "deploys")), "no record, no notification");
  assert.equal(f.calls.notify.length, 0);
  // and it still refuses what a real deploy would refuse
  const none = f.commit("auto/dry-noresult", { VERSION: "v9\n" });
  assert.equal((await deployChange(f.deployOpts(none, { dryRun: true }))).status, "refused");
});

test("deploy: refuses a branch that is not approved, a non-fast-forward, a dirty live tree, and a commit already live", async (t) => {
  const f = await makeForge(t);
  let r = await verified(f, "wip/scratch", { VERSION: "v2\n" });
  let out = await deployChange(f.deployOpts(r.sha));
  assert.match(out.record.reason, /not on an approved branch/);

  // live moves under the change: not a fast-forward any more
  r = await verified(f, "auto/ffbase", { VERSION: "v3\n" });
  git(f.author, "checkout", "-q", "main");
  await fsp.writeFile(path.join(f.author, "other.txt"), "x");
  git(f.author, "add", "-A"); git(f.author, "commit", "-q", "-m", "main moved"); git(f.author, "push", "-q", "origin", "main");
  git(f.live, "pull", "-q", "--ff-only", "origin", "main");
  out = await deployChange(f.deployOpts(r.sha));
  assert.match(out.record.reason, /not a fast-forward/);

  // dirty live tree
  const r2 = await verified(f, "auto/dirty", { VERSION: "v4\n" }, {});
  await fsp.writeFile(path.join(f.live, "VERSION"), "hand edit\n");
  out = await deployChange(f.deployOpts(r2.sha));
  assert.match(out.record.reason, /uncommitted changes/);
  git(f.live, "checkout", "--", "VERSION");

  // already live
  const live = f.head();
  git(f.author, "checkout", "-q", "-B", "release/x", live); git(f.author, "push", "-q", "-f", "origin", "release/x");
  const key = loadKey({ home: f.home, create: true });
  const tree = git(f.live, "rev-parse", `${live}^{tree}`);
  await fsp.writeFile(path.join(resultsDir(f.home), `${live}.json`), JSON.stringify(sign({ schema: 1, sha: live, tree, green: true, verifiedAt: new Date().toISOString(), risk: { class: "low", reasons: [] }, tests: {} }, key)));
  out = await deployChange(f.deployOpts(live));
  assert.equal(out.status, "already-live");
  assert.equal(f.restarts(), 0);
});
