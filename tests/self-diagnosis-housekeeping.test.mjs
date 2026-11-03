// Self-diagnosis the owner sees, and housekeeping that acts:
//   - the triage digest collapses near-duplicates and ranks by cost,
//   - "What keeps breaking" lands in the morning briefing (not the evening),
//   - not-connected sources become ONE weekly "connect" line,
//   - the briefing clock stays off the disk between slots,
//   - the Maintainer takes the collapsed top items,
//   - checkpoints are held under a byte cap (newest per session kept), and
//     housekeeping runs that cap under disk pressure,
//   - a dead legacy home becomes one owner card and is removed only on Approve,
//   - an unimplemented heartbeat check never alerts; the uncommitted check works,
//   - the desktop's daily triage task stays out of a live turn.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { capWorkspaceCheckpoints, digestReliabilityFindings, formatDigestLine } from "../packages/core/dist/index.js";
import { staleUncommitted, runHeartbeatTick, defaultAgentConfig } from "../packages/agent/dist/index.js";
import { BriefingService, DEFAULT_BRIEFING_SETTINGS, gatherFacts, quietUntil } from "../packages/cli/dist/phoneBriefings.js";
import { zonedTimeToMs } from "../packages/cli/dist/phoneCommon.js";
import { createTelemetryCollector } from "../packages/cli/dist/maintainer/telemetry.js";
import { Housekeeping } from "../packages/cli/dist/systemHousekeeping.js";
import { LegacyHomeOffer, detectLegacyHomes, legacyCardText } from "../packages/cli/dist/legacyHome.js";
import { dailyTriageTask } from "../packages/cli/dist/entry/daemon/triageDaily.js";

const DAY = 86_400_000;
const NY = "America/New_York";
const at = (y, m, d, h, mi) => zonedTimeToMs(y, m, d, h, mi, NY);
const NOW = at(2026, 11, 2, 7, 30);
const iso = (ms) => new Date(ms).toISOString();
const exists = (p) => fsp.lstat(p).then(() => true, () => false);

async function tmp(t, prefix = "ares-selfdiag-") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }));
  return dir;
}

let n = 0;
const finding = (over = {}) => ({
  schemaVersion: 1,
  id: `rel_${String(++n).padStart(16, "0")}`,
  fingerprint: `fp${n}`,
  kind: "tool_error",
  title: "Edit repeated tool failures",
  category: "product",
  severity: "medium",
  confidence: "low",
  status: "candidate",
  occurrences: 3,
  distinctSessions: 1,
  firstSeenAt: iso(NOW - 3 * DAY),
  lastSeenAt: iso(NOW - DAY),
  evidence: [{ source: "session", at: iso(NOW - DAY), summary: "Read C:\\x\\a.ts before editing it.", sourceRef: "src_1", tool: "Edit" }],
  suggestedAction: "Confirm recurrence.",
  sessionIds: [],
  observationKeys: [],
  ...over,
});

// ── the digest ───────────────────────────────────────────────────────────

test("digest: 103 near-duplicate Edit findings are ONE item with a count; dismissed, task and stale findings stay out", () => {
  const edits = Array.from({ length: 103 }, () => finding());
  const crash = finding({
    kind: "crash", title: "garrison uncaughtException crash", severity: "critical", occurrences: 6, distinctSessions: 0,
    evidence: [{ source: "crash", at: iso(NOW - 8 * DAY), summary: "listen EADDRINUSE: address already in use 127.0.0.1:7421", sourceRef: "src_2", tool: "garrison", code: "uncaughtException" }],
    lastSeenAt: iso(NOW - 8 * DAY),
  });
  const rate = finding({ kind: "engine_error", title: "Engine http_429 failures", occurrences: 40, distinctSessions: 5, evidence: [{ source: "friction", at: iso(NOW - DAY), summary: "429 too many requests", sourceRef: "s", code: "http_429" }] });
  const items = digestReliabilityFindings([
    ...edits, crash, rate,
    finding({ status: "dismissed", title: "dismissed", occurrences: 999 }),
    finding({ category: "task", occurrences: 999 }),
    finding({ lastSeenAt: iso(NOW - 90 * DAY), occurrences: 999, title: "Bash repeated tool failures", evidence: [{ source: "session", at: iso(NOW - 90 * DAY), summary: "exit 1", sourceRef: "s", tool: "Bash" }] }),
  ], { now: NOW });
  const edit = items.find((i) => i.key === "edit-unread");
  assert.ok(edit, JSON.stringify(items.map((i) => i.key)));
  assert.equal(edit.findings, 103);
  assert.equal(edit.count, 309);
  assert.equal(items.filter((i) => i.key.startsWith("edit")).length, 1, "one item, not 103");
  assert.ok(!items.some((i) => i.key === "tool:bash"), "a finding last seen 90 days ago is not 'keeps breaking'");
  assert.ok(items.every((i) => i.count < 999), "dismissed and task findings are left out");
  // Ranking by cost: 309 recent Edit failures, then the rate limit (40x, felt in 5 chats), then the
  // critical crash that was last seen 8 days ago (severity alone does not win).
  assert.deepEqual(items.map((i) => i.key), ["edit-unread", "rate-limit", "port-in-use"]);
  assert.ok(items[1].ownerFelt);
  assert.equal(items.find((i) => i.key === "port-in-use").what.includes("port was already taken"), true);
  assert.match(formatDigestLine(edit), /^Edits failed because the file had not been read first \(309x\)\. Fix: /);
});

test("digest: recency and owner friction move an item up", () => {
  const old = finding({ title: "Glob repeated tool failures", occurrences: 10, lastSeenAt: iso(NOW - 14 * DAY), evidence: [{ source: "session", at: iso(NOW - 14 * DAY), summary: "bad pattern", sourceRef: "s", tool: "Glob" }] });
  const fresh = finding({ title: "Grep repeated tool failures", occurrences: 4, lastSeenAt: iso(NOW - 3_600_000), evidence: [{ source: "session", at: iso(NOW), summary: "regex parse error", sourceRef: "s", tool: "Grep" }] });
  const felt = finding({ title: "Read repeated tool failures", occurrences: 2, distinctSessions: 3, lastSeenAt: iso(NOW - 3_600_000), evidence: [{ source: "session", at: iso(NOW), summary: "turn interrupted by the owner", sourceRef: "s", tool: "Read" }] });
  const keys = digestReliabilityFindings([old, fresh, felt], { now: NOW }).map((i) => i.key);
  assert.deepEqual(keys, ["tool:read", "tool:grep", "tool:glob"]);
});

// ── the briefing ─────────────────────────────────────────────────────────

const BREAKING = [
  { what: "Edits failed because the file had not been read first", fix: "Let Edit read the file itself.", count: 103 },
  { what: "The model provider rate-limited Ares", fix: "Back off longer.", count: 82 },
  { what: "Subagents kept failing the same way", fix: "Fix the shared cause once.", count: 75 },
  { what: "A fourth thing", fix: "x", count: 2 },
];

function service(home, over = {}) {
  const calls = { turns: 0, settingsReads: 0 };
  let nowMs = over.nowMs ?? NOW;
  const svc = new BriefingService({
    home,
    sources: over.sources ?? { agents: async () => ({ agents: [{ id: "ares", name: "Ares", last: "Did a thing." }] }), breaking: async () => BREAKING },
    runTurn: async () => { calls.turns++; return "not json"; },
    now: () => nowMs,
  });
  const read = svc.getSettings.bind(svc);
  svc.getSettings = async () => { calls.settingsReads++; return read(); };
  return { svc, calls, setNow: (v) => { nowMs = v; } };
}

test("briefing: the morning card carries 'What keeps breaking' (top 3, count + fix), written by the garrison, not the model", async (t) => {
  const home = await tmp(t);
  const { svc } = service(home);
  await svc.updateSettings({ timezone: NY });
  const out = await svc.generate("morning", { manual: false });
  assert.equal(out.ok, true);
  const breaking = out.card.sections.find((s) => s.id === "breaking");
  assert.equal(breaking.title, "What keeps breaking");
  assert.deepEqual(breaking.items.map((i) => i.text), [
    "Edits failed because the file had not been read first (103x)",
    "The model provider rate-limited Ares (82x)",
    "Subagents kept failing the same way (75x)",
  ]);
  assert.equal(breaking.items[0].detail, "Fix: Let Edit read the file itself.");
  const evening = await svc.generate("evening", { manual: false });
  assert.ok(!evening.card.sections.some((s) => s.id === "breaking"), "morning only");
});

test("briefing: the model never sees or writes the fixed sections", async () => {
  const facts = await gatherFacts({ kind: "morning", settings: DEFAULT_BRIEFING_SETTINGS, sources: { breaking: async () => BREAKING }, nowMs: NOW, timeZone: NY });
  assert.equal(facts.packets.breaking.status, "ok");
  assert.equal(facts.packets.breaking.data.items.length, 3);
});

test("briefing: not-connected sources are one 'connect' line at most once a week, never missing markers", async (t) => {
  const home = await tmp(t);
  const { svc, setNow } = service(home);
  await svc.updateSettings({ timezone: NY });
  const first = await svc.generate("morning", { manual: false });
  assert.deepEqual(first.card.missing, []);
  assert.equal(first.card.sections.filter((s) => s.id === "setup").length, 1);
  assert.equal(first.card.sections.find((s) => s.id === "setup").body, "Connect calendar, weather, mail to see them in your briefing.");
  const evening = await svc.generate("evening", { manual: false });
  assert.ok(!evening.card.sections.some((s) => s.id === "setup"), "not on every card");
  setNow(NOW + 8 * DAY);
  const nextWeek = await svc.generate("morning", { manual: false });
  assert.ok(nextWeek.card.sections.some((s) => s.id === "setup"), "a week later it shows again");
});

test("briefing clock: between slots the tick touches nothing; inside a window it checks every tick", async (t) => {
  const settings = DEFAULT_BRIEFING_SETTINGS;
  assert.equal(quietUntil(settings, at(2026, 11, 2, 12, 0), NY), at(2026, 11, 2, 18, 30), "lunchtime: quiet until the evening slot");
  assert.equal(quietUntil(settings, at(2026, 11, 2, 8, 0), NY), at(2026, 11, 2, 8, 0), "inside the morning catch-up window: no skipping");
  const home = await tmp(t);
  const { svc, calls, setNow } = service(home, { nowMs: at(2026, 11, 2, 11, 0) });
  await svc.updateSettings({ timezone: NY });
  calls.settingsReads = 0;
  assert.equal(await svc.tick(), undefined);
  const afterFirst = calls.settingsReads;
  for (let m = 1; m < 60; m++) {
    setNow(at(2026, 11, 2, 11, m));
    assert.equal(await svc.tick(), undefined);
  }
  assert.equal(calls.settingsReads, afterFirst, "59 no-op ticks read nothing");
  setNow(at(2026, 11, 2, 18, 30));
  assert.equal(await svc.tick(), "evening", "and the slot still fires on time");
});

// ── the Maintainer ───────────────────────────────────────────────────────

test("maintainer: triage arrives as the collapsed, ranked top items", async (t) => {
  const home = await tmp(t);
  const now = Date.now();
  const collect = createTelemetryCollector({
    home,
    now: () => now,
    findings: async () => Array.from({ length: 20 }, () => finding({ lastSeenAt: iso(now - 3_600_000) })),
  });
  const triage = (await collect(now - 3 * DAY)).filter((i) => i.source === "triage");
  assert.equal(triage.length, 1);
  assert.equal(triage[0].occurrences, 60);
  assert.equal(triage[0].title, "Edits failed because the file had not been read first");
  assert.ok(triage[0].evidence.some((e) => e.startsWith("suggested fix:")));
});

// ── checkpoints ──────────────────────────────────────────────────────────

async function seedCheckpoints(ws, rows) {
  const meta = path.join(ws, ".ares", "checkpoints", "meta");
  const blobs = path.join(ws, ".ares", "checkpoints", "blobs");
  await fsp.mkdir(meta, { recursive: true });
  const old = new Date(Date.now() - 3_600_000);
  for (const r of rows) {
    const hash = (r.id.replace(/[^0-9a-f]/g, "") + "a".repeat(64)).slice(0, 64);
    await fsp.mkdir(path.join(blobs, hash.slice(0, 2)), { recursive: true });
    const blob = path.join(blobs, hash.slice(0, 2), hash);
    await fsp.writeFile(blob, Buffer.alloc(r.bytes, 1));
    await fsp.utimes(blob, old, old);
    await fsp.writeFile(path.join(meta, `${r.id}.json`), JSON.stringify({ id: r.id, sessionId: r.session, createdAt: r.createdAt, fileManifest: [{ path: "f", blobHash: hash }] }));
  }
}

test("checkpoints: the byte cap removes the oldest first and keeps every session's newest", async (t) => {
  const ws = await tmp(t, "ares-ckpt-cap-");
  const base = Date.now() - 2 * 3_600_000;
  const rows = [
    { id: "c01", session: "s1", createdAt: iso(base + 1000), bytes: 100_000 },
    { id: "c02", session: "s1", createdAt: iso(base + 2000), bytes: 100_000 },
    { id: "c03", session: "s2", createdAt: iso(base + 3000), bytes: 100_000 },
    { id: "c04", session: "s1", createdAt: iso(base + 4000), bytes: 100_000 },
    { id: "c05", session: "s2", createdAt: iso(base + 5000), bytes: 100_000 },
  ];
  await seedCheckpoints(ws, rows);
  const under = await capWorkspaceCheckpoints(ws, { maxBytes: 10_000_000 });
  assert.equal(under.skipped, "under-cap");
  const r = await capWorkspaceCheckpoints(ws, { maxBytes: 250_000 });
  assert.equal(r.removedCheckpoints, 3, JSON.stringify(r));
  assert.ok(r.freedBytes >= 300_000);
  assert.ok(r.afterBytes <= 250_000);
  const left = (await fsp.readdir(path.join(ws, ".ares", "checkpoints", "meta"))).sort();
  assert.deepEqual(left, ["c04.json", "c05.json"], "the newest of each session survives");
  // Even a cap of one byte never removes a session's latest checkpoint.
  const floor = await capWorkspaceCheckpoints(ws, { maxBytes: 1 });
  assert.equal(floor.skipped, "nothing-removable");
});

test("housekeeping: under disk pressure the checkpoint cap runs and what it freed is reported and ledgered", async (t) => {
  const root = await tmp(t, "ares-hk-cap-");
  const home = path.join(root, "home", ".ares");
  const ws = path.join(root, "ws");
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(path.join(ws, ".ares", "checkpoints", "blobs"), { recursive: true });
  const capped = [];
  const make = (pct) => new Housekeeping({
    home, workspaces: [ws], tmpDir: path.join(root, "tmp"), instancesRoot: path.join(root, "inst"),
    diskUsedPct: () => pct, docker: async () => null, processes: async () => [],
    gcCheckpoints: async () => {},
    capCheckpoints: async (w) => { capped.push(w); return { capBytes: 200 * 1_048_576, beforeBytes: 900 * 1_048_576, freedBytes: 700 * 1_048_576, removedCheckpoints: 2400 }; },
  });
  await make(40).run();
  assert.equal(capped.length, 0, "no pressure: count and age retention only");
  const report = await make(86).run();
  assert.equal(report.pressure, true);
  assert.ok(capped.some((w) => path.resolve(w) === path.resolve(ws)));
  assert.ok(report.jobs.checkpoints.acted >= 2400);
  assert.ok(report.jobs.checkpoints.bytes >= 700 * 1_048_576);
  assert.match(report.jobs.checkpoints.notes.join(" "), /removed 2400 oldest checkpoints, freed 700\.0 MB/);
  const ledger = (await fsp.readFile(path.join(home, "housekeeping", "ledger.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(ledger.some((e) => e.job === "checkpoints" && /byte cap/.test(e.detail)));
});

// ── the legacy home ──────────────────────────────────────────────────────

async function legacyFixture(t, ageDays) {
  const root = await tmp(t, "ares-legacy-");
  const legacy = path.join(root, "Roaming", "Ares", "home");
  const active = path.join(root, ".ares");
  await fsp.mkdir(path.join(legacy, "sessions"), { recursive: true });
  await fsp.mkdir(active, { recursive: true });
  const when = new Date(Date.UTC(2026, 7, 16, 12));
  for (const [rel, size] of [["sessions/a.jsonl", 4096], ["memory.md", 2048]]) {
    const file = path.join(legacy, rel);
    await fsp.writeFile(file, Buffer.alloc(size, 1));
    const t2 = ageDays === undefined ? when : new Date(Date.now() - ageDays * DAY);
    await fsp.utimes(file, t2, t2);
  }
  return { root, legacy, active };
}

test("legacy home: detected only when stale and not the active home; the card says what and how big", async (t) => {
  const f = await legacyFixture(t);
  const found = await detectLegacyHomes({ candidates: [f.legacy], activeHome: f.active });
  assert.equal(found.length, 1);
  assert.equal(found[0].bytes, 6144);
  assert.equal(legacyCardText(found[0]), "Old Ares data from before August, 1 MB, safe to remove?");
  assert.deepEqual(await detectLegacyHomes({ candidates: [f.legacy], activeHome: f.legacy }), [], "the active home is never legacy");
  assert.deepEqual(await detectLegacyHomes({ candidates: [path.dirname(f.active)], activeHome: f.active }), [], "nor anything that contains it");
  const fresh = await legacyFixture(t, 2);
  assert.deepEqual(await detectLegacyHomes({ candidates: [fresh.legacy], activeHome: fresh.active }), [], "a file from two days ago means it is alive");
});

test("legacy home: one card; Keep is remembered and removes nothing; Remove happens only on Approve", async (t) => {
  const f = await legacyFixture(t);
  const cards = [];
  let answer;
  const approvals = { requestApproval: (staged) => { cards.push(staged); return new Promise((r) => { answer = r; }); } };
  const offer = new LegacyHomeOffer({ home: f.active, activeHome: f.active, candidates: [f.legacy], approvals, recycle: async () => false });
  assert.equal((await offer.check()).length, 1);
  assert.equal((await offer.check()).length, 0, "a card already waiting is not staged twice");
  assert.equal(cards.length, 1);
  assert.match(cards[0].reason, /^Old Ares data from before August, 1 MB, safe to remove\?/);
  answer({ verb: "deny", note: "approval timed out" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await exists(f.legacy), true, "a timeout removes nothing");
  assert.equal((await offer.check()).length, 1, "and is not a Keep: it asks again");
  answer({ verb: "deny" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await exists(f.legacy), true, "Keep removes nothing");
  assert.equal((await offer.check()).length, 0, "Keep is final");

  const g = await legacyFixture(t);
  const recycled = [];
  const offer2 = new LegacyHomeOffer({ home: g.active, activeHome: g.active, candidates: [g.legacy], approvals: { requestApproval: async () => ({ verb: "allow_once" }) }, recycle: async (dir) => { recycled.push(dir); return false; } });
  await offer2.check();
  for (let i = 0; i < 50 && (await exists(g.legacy)); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await exists(g.legacy), false, "removed after the owner approved");
  assert.deepEqual(recycled, [path.resolve(g.legacy)], "the Recycle Bin is tried first");
  assert.equal(await exists(path.dirname(g.legacy)), true, "only the home itself, not its parent");
});

// ── the heartbeat ────────────────────────────────────────────────────────

test("heartbeat: an unimplemented check never alerts; the uncommitted-changes check is real", async (t) => {
  const home = await tmp(t, "ares-hb-home-");
  const ws = await tmp(t, "ares-hb-ws-");
  const git = (...args) => execFileSync("git", args, { cwd: ws, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  await fsp.writeFile(path.join(ws, "old.txt"), "work\n");
  await fsp.writeFile(path.join(ws, "new.txt"), "work\n");
  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000);
  await fsp.utimes(path.join(ws, "old.txt"), threeHoursAgo, threeHoursAgo);
  assert.equal(await staleUncommitted(ws, new Date(), 2), "Uncommitted changes older than 2h: old.txt");
  assert.equal(await staleUncommitted(ws, new Date(), 4), null);
  assert.equal(await staleUncommitted(home, new Date(), 2), null, "not a repo is not a finding");

  const config = defaultAgentConfig(home);
  config.heartbeat.activeHours = { start: "00:00", end: "23:59" };
  await fsp.writeFile(path.join(home, "HEARTBEAT.md"), "- Are there uncommitted changes older than 2 hours? Surface them.\n- Is anything in SOUL.md visibly out of sync?\n", "utf8");
  const r = await runHeartbeatTick({ home, workspace: ws, config, now: new Date() });
  assert.equal(r.status, "alert");
  assert.deepEqual(r.findings.filter((x) => !x.startsWith("Self-directive")), ["Uncommitted changes older than 2h: old.txt"]);
  assert.ok(!r.findings.some((x) => /not implemented/i.test(x)));
  const state = JSON.parse(await fsp.readFile(path.join(home, "memory", "heartbeat-state.json"), "utf8").catch(async () => fsp.readFile(path.join(home, "heartbeat-state.json"), "utf8")));
  assert.deepEqual(state.unimplemented, ["Is anything in SOUL.md visibly out of sync?"]);
});

// ── the desktop's daily triage ───────────────────────────────────────────

test("daily triage (desktop): never during a turn; runs with a daily interval; a throttled run is silent", async () => {
  const runs = [];
  let busy = true;
  let skipped;
  const task = dailyTriageTask({ home: "H", workspace: () => "W", busy: () => busy, run: async (o) => { runs.push(o); return { skipped, newCandidates: ["a"], coverage: { files: 7 } }; } });
  assert.equal(await task(), undefined);
  assert.equal(runs.length, 0);
  busy = false;
  assert.equal(await task(), "triage: 7 files, 1 new candidates");
  assert.equal(runs[0].home, "H");
  assert.equal(runs[0].minimumIntervalMs, 20 * 3_600_000);
  skipped = "cadence";
  assert.equal(await task(), undefined);
});
