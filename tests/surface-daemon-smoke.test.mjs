// Surfaces over the real daemon protocol (docs/CREATOR-MODE-DESIGN.md).
//
// The desktop never writes the ledger; it asks the daemon. So the thing worth
// pinning is the wire: a built daemon answers surfaces_list, forwards ledger
// changes as surface_* events tagged with the owning session, turns an
// in-surface intent into a turn of that session, and reports a bad command
// as daemon_error instead of dying. Same driver as daemon-roster-smoke.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSurface } from "../packages/tools/dist/index.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO, "packages", "cli", "dist", "entry.js");
const START_TIMEOUT_MS = 90_000;
const REPLY_TIMEOUT_MS = 30_000;

async function startDaemon() {
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-surface-home-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-surface-ws-"));
  const child = spawn(process.execPath, [ENTRY, "daemon", "--json"], {
    cwd: workspace,
    env: { ...process.env, ARES_HOME: home, ARES_PROVIDER: "mock", ARES_MODEL: "mock", ARES_AGENT_ENABLED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const events = () => stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const waitFor = async (pred, ms = REPLY_TIMEOUT_MS) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`daemon exited early (code ${child.exitCode}): ${stderr.slice(0, 400)}`);
      const hit = events().find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  };
  const send = (command) => child.stdin.write(JSON.stringify(command) + "\n");
  return { home, child, send, events, waitFor, stderr: () => stderr, stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

const PAGE = `<main data-ares-region="main"><h1>Hi</h1><p data-ares-region="status">ok</p></main>`;

test("the built daemon serves the surface ledger and routes intents", async (t) => {
  try {
    await access(ENTRY);
  } catch {
    t.skip("packages/cli/dist not built — run pnpm build");
    return;
  }
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  const ready = await daemon.waitFor((e) => e.type === "daemon_ready" || e.type === "ready", START_TIMEOUT_MS);
  assert.ok(ready, `the backend announced itself. stderr: ${daemon.stderr().slice(0, 600)}`);

  daemon.send({ type: "surfaces_list" });
  const empty = await daemon.waitFor((e) => e.type === "surfaces_list");
  assert.deepEqual(empty.surfaces, [], "a fresh home has no surfaces");

  // The ledger is files: a surface written by another process (here: the
  // tools package, as the Surface tool would) is visible on the next read.
  await createSurface({ name: "hello", title: "Hello", placement: "rail", document: { html: PAGE, css: "", js: "" }, feeds: [], actions: [], sessionId: "chat-1" }, daemon.home);
  daemon.send({ type: "surfaces_list" });
  const listed = await daemon.waitFor((e) => e.type === "surfaces_list" && e.surfaces.length === 1);
  assert.ok(listed, "surfaces_list sees the ledger");
  assert.equal(listed.surfaces[0].manifest.name, "hello");
  assert.equal(listed.surfaces[0].document.html, PAGE);

  daemon.send({ type: "surface_keep", surface: "hello" });
  const kept = await daemon.waitFor((e) => e.type === "surface_manifest" && e.name === "hello");
  assert.equal(kept.manifest.state, "kept");
  assert.equal(kept.sessionId, "chat-1", "ledger events are tagged with the owning session");

  daemon.send({ type: "surface_rollback", surface: "hello", revision: 1 });
  const rolled = await daemon.waitFor((e) => e.type === "surface_revision" && e.origin === "rollback");
  assert.equal(rolled.manifest.revision, 2);

  daemon.send({ type: "surface_intent", surface: "hello", text: "hello from the button" });
  const turn = await daemon.waitFor((e) => e.type === "turn_start" && e.sessionId === "chat-1", 60_000);
  assert.ok(turn, "an in-surface intent starts a turn in the surface's chat");

  daemon.send({ type: "surface_keep", surface: "nope" });
  const error = await daemon.waitFor((e) => e.type === "daemon_error" && /surface_keep/.test(e.error));
  assert.match(error.error, /no surface named "nope"/);

  daemon.send({ type: "surface_remove", surface: "hello" });
  const removed = await daemon.waitFor((e) => e.type === "surface_removed" && e.name === "hello");
  assert.ok(removed);
});
