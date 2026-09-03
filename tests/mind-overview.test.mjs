// The owner's memory surface — store.edit + store.overview, the `ares mind
// about`/`ares mind edit` CLI, and the mind_overview/mind_edit/mind_forget
// daemon commands.
//
// Why this exists: memory dedupes, decays, and consolidates on its own, but
// until this surface the owner could not SEE what Ares believes or fix it in
// place. The tests pin the three contracts that make the surface trustworthy:
// an owner edit lands verbatim (confidence 1, sidecar goes stale so the vector
// re-embeds), the overview never leaks guest:* pools, and the desktop's
// commands are actually routable end to end (the silent-allowlist failure
// class daemon-command-routing.test.mjs documents).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MemoryStore, EmbedIndex, contentHash } from "../packages/mind/dist/index.js";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(root, "packages", "cli", "dist", "entry.js");
const readSrc = (rel) => readFileSync(path.join(root, rel), "utf8");

const DAY = 86_400_000;

async function tempHome(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

// ─── store.edit ────────────────────────────────────────────────────────────

test("store.edit replaces content, bumps confidence to 1, stamps owner provenance, persists", async () => {
  const home = await tempHome("ares-mind-edit-");
  try {
    const store = await MemoryStore.open(home);
    const node = await store.add({ kind: "semantic", content: "the owner works night shifts", strength: 2 });
    const result = await store.edit(node.id, "the owner works DAY shifts now");
    assert.ok(result, "edit of a known id returns a before/after pair");
    assert.equal(result.before.content, "the owner works night shifts");
    assert.equal(result.after.content, "the owner works DAY shifts now");
    assert.equal(result.after.confidence, 1);
    assert.equal(result.after.editedBy, "owner");
    assert.ok(result.after.editedAt, "editedAt is stamped");
    // Persisted: a fresh open sees the correction, not the original.
    const reopened = await MemoryStore.open(home);
    const persisted = reopened.get(node.id);
    assert.equal(persisted.content, "the owner works DAY shifts now");
    assert.equal(persisted.confidence, 1);
    assert.equal(persisted.editedBy, "owner");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("store.edit: unknown id and blank content both refuse (undefined), nothing persisted", async () => {
  const store = MemoryStore.memory();
  const node = await store.add({ kind: "semantic", content: "keep me" });
  assert.equal(await store.edit("mem_nope", "x"), undefined);
  assert.equal(await store.edit(node.id, "   "), undefined);
  assert.equal(store.get(node.id).content, "keep me");
});

test("an owner edit makes the embed sidecar vector stale via the content hash", async () => {
  const home = await tempHome("ares-mind-sidecar-");
  try {
    const store = await MemoryStore.open(home);
    const node = await store.add({ kind: "semantic", content: "original belief" });
    const index = await EmbedIndex.open(path.join(home, "memory.jsonl.vec.jsonl"));
    index.upsert(node.id, contentHash("original belief"), [0.1, 0.2, 0.3]);
    assert.deepEqual(index.staleIds([{ id: node.id, content: "original belief" }]), [], "fresh vector is not stale");
    const result = await store.edit(node.id, "corrected belief");
    assert.deepEqual(
      index.staleIds([{ id: node.id, content: result.after.content }]),
      [node.id],
      "the edited content no longer matches the vector's hash — it re-embeds on the next refresh",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ─── store.overview ────────────────────────────────────────────────────────

test("overview groups by kind, ranks by liveness, and clips content", async () => {
  const store = MemoryStore.memory();
  const now = new Date();
  const old = new Date(now.getTime() - 45 * DAY);
  // Same stored strength — the fresh one must out-rank the stale one on liveness.
  await store.add({ kind: "semantic", content: "stale belief", strength: 3, at: old });
  await store.add({ kind: "semantic", content: "fresh belief", strength: 3, at: now });
  await store.add({ kind: "procedural", content: "how to deploy", at: now });
  await store.add({ kind: "episodic", content: "x".repeat(300), at: now });
  const groups = store.overview({ now });
  assert.equal(groups.semantic.length, 2);
  assert.equal(groups.semantic[0].content, "fresh belief", "liveness puts the fresh node first");
  assert.equal(groups.procedural.length, 1);
  assert.equal(groups.episodic.length, 1);
  assert.equal(groups.episodic[0].content.length, 200);
  assert.ok(groups.episodic[0].content.endsWith("…"), "long content is clipped with an ellipsis");
  const row = groups.semantic[0];
  for (const field of ["id", "kind", "content", "strength", "currentStrength", "activations", "ageDays"]) {
    assert.ok(field in row, `overview row carries ${field}`);
  }
  assert.ok(groups.semantic[1].ageDays > 40, "ageDays reflects when the memory formed");
});

test("overview respects the per-group limit", async () => {
  const store = MemoryStore.memory();
  for (let i = 0; i < 6; i++) await store.add({ kind: "semantic", content: `belief ${i}` });
  const groups = store.overview({ limit: 3 });
  assert.equal(groups.semantic.length, 3);
});

test("overview never returns guest:* nodes unless that scope is asked for", async () => {
  const store = MemoryStore.memory();
  await store.add({ kind: "semantic", content: "owner belief" });
  await store.add({ kind: "semantic", content: "owner-stamped belief", scope: "owner" });
  await store.add({ kind: "semantic", content: "guest secret", scope: "guest:tg1" });
  const groups = store.overview();
  const contents = groups.semantic.map((r) => r.content);
  assert.ok(contents.includes("owner belief"));
  assert.ok(contents.includes("owner-stamped belief"));
  assert.ok(!contents.includes("guest secret"), "guest pool never leaks into the default overview");
  // Asked for explicitly, an isolated scope sees ONLY its own pool.
  const guest = store.overview({ scope: "guest:tg1" });
  assert.deepEqual(guest.semantic.map((r) => r.content), ["guest secret"]);
});

// ─── CLI (dist, temp home) ─────────────────────────────────────────────────

test("ares mind about + edit against a temp home", async () => {
  const home = await tempHome("ares-mind-cli-");
  try {
    const memoryFile = path.join(home, "memory.jsonl");
    const store = await MemoryStore.open(memoryFile);
    const node = await store.add({ kind: "semantic", content: "the owner prefers tabs" });

    const about = await run(process.execPath, [ENTRY, "mind", "about", "--root", memoryFile, "--home", home, "--json"], { windowsHide: true });
    const groups = JSON.parse(about.stdout);
    assert.equal(groups.semantic[0].id, node.id);
    assert.equal(groups.semantic[0].content, "the owner prefers tabs");

    // Human rendering names the correction affordances.
    const pretty = await run(process.execPath, [ENTRY, "mind", "about", "--root", memoryFile, "--home", home], { windowsHide: true });
    assert.match(pretty.stdout, /what I believe about you and this work/);
    assert.match(pretty.stdout, /ares mind edit/);
    assert.match(pretty.stdout, /ares mind forget/);

    const edit = await run(
      process.execPath,
      [ENTRY, "mind", "edit", node.id, "the owner prefers spaces", "--root", memoryFile, "--home", home, "--json"],
      { windowsHide: true },
    );
    const result = JSON.parse(edit.stdout);
    assert.equal(result.before.content, "the owner prefers tabs");
    assert.equal(result.after.content, "the owner prefers spaces");
    assert.equal(result.after.confidence, 1);
    const raw = await readFile(memoryFile, "utf8");
    assert.match(raw, /the owner prefers spaces/, "the correction is on disk");

    // Unknown id fails loudly, not silently.
    const bad = await run(process.execPath, [ENTRY, "mind", "edit", "mem_nope", "text", "--root", memoryFile, "--home", home], { windowsHide: true }).catch((e) => e);
    assert.equal(bad.code, 1);
    assert.match(String(bad.stderr), /no memory found/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ─── daemon command routing (same static harness as daemon-command-routing) ─

test("mind_overview/mind_edit/mind_forget are implemented by the daemon and emit result frames", () => {
  const daemon = readSrc("packages/cli/src/entry/daemon.ts");
  for (const t of ["mind_overview", "mind_edit", "mind_forget"]) {
    assert.ok(daemon.includes(`command.type === "${t}"`), `daemon handles ${t}`);
  }
  for (const reply of ["mind_overview_result", "mind_edit_result", "mind_forget_result"]) {
    assert.ok(daemon.includes(`"${reply}"`), `daemon emits ${reply}`);
  }
});

test("the Mind pane's commands stay in the Rust allowlist (the silent chokepoint)", () => {
  const rs = readSrc("tauri/src-tauri/src/main.rs");
  const block = rs.match(/ALLOWED_DAEMON_COMMANDS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/);
  assert.ok(block, "ALLOWED_DAEMON_COMMANDS not found in main.rs");
  const allowed = new Set([...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  for (const t of ["mind_overview", "mind_edit", "mind_forget"]) {
    assert.ok(allowed.has(t), `${t} must stay in ALLOWED_DAEMON_COMMANDS or the pane's buttons die silently`);
  }
});

test("the desktop Mind pane actually sends the commands it renders buttons for", () => {
  const app = readSrc("tauri/src/App.tsx");
  for (const t of ["mind_overview", "mind_edit", "mind_forget"]) {
    assert.ok(new RegExp(`type:\\s*"${t}"`).test(app), `App.tsx sends ${t}`);
  }
  assert.ok(/mind_overview_result/.test(app), "App.tsx consumes mind_overview_result");
});
