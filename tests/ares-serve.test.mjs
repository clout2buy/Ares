// V2 (slice) — end-to-end: `ares garrison serve` boots the REAL daemon from
// the real CLI entry, /health answers, and a websocket client runs a full
// hello → session.create → session.send → turn_end round trip against the
// mock provider. This is the wire protocol proven through the front door.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "packages", "cli", "dist", "entry.js");

function waitFor(check, timeoutMs, label) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch {
        // keep polling
      }
      if (Date.now() - startedAt > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 150);
    };
    void tick();
  });
}

test("garrison serve: boot, health, create, send, stream, detach-survival", { timeout: 90_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-serve-home-"));
  // Sessions are WORKSPACE-scoped (<cwd>/.ares), which ARES_HOME does not move.
  // Booting the daemon from the repo root wrote a "hello garrison" session into
  // the checkout's own .ares on every run — it showed up in the developer's
  // real `ares sessions`. Same "somebody else's test state" problem
  // _isolate-home.mjs exists for, one directory over.
  const workspace = await mkdtemp(path.join(tmpdir(), "ares-serve-ws-"));
  const port = 18_400 + Math.floor(Math.random() * 1_000);

  const daemon = spawn(
    process.execPath,
    [entry, "garrison", "serve", "--provider", "mock", "--port", String(port)],
    {
      cwd: workspace,
      env: { ...process.env, ARES_HOME: home, ARES_AGENT_ENABLED: "0", ARES_WITNESS: "0", NO_COLOR: "1" },
      windowsHide: true,
    },
  );
  let daemonOut = "";
  daemon.stdout.on("data", (d) => (daemonOut += String(d)));
  daemon.stderr.on("data", (d) => (daemonOut += String(d)));

  try {
    // 1. /health answers.
    const health = await waitFor(
      async () => {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        return res.ok ? res.json() : null;
      },
      30_000,
      "garrison /health",
    );
    assert.equal(health.ok, true);

    // 2. Authed socket round trip.
    const token = (await readFile(path.join(home, "garrison", "token"), "utf8")).trim();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const frames = [];
    const next = (type, timeoutMs = 20_000) =>
      waitFor(() => frames.find((f) => f.type === type), timeoutMs, `frame ${type}`);
    ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));

    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "hello", token, client: "smoke", proto: 1 }));
    await next("welcome");

    ws.send(JSON.stringify({ type: "session.create" }));
    const created = await next("session.created");
    const sessionId = created.session.id;
    assert.ok(sessionId);

    ws.send(JSON.stringify({ type: "session.send", sessionId, text: "hello garrison" }));
    await waitFor(
      () => frames.some((f) => f.type === "event" && f.event?.type === "turn_end"),
      30_000,
      "turn_end event",
    );
    const deltas = frames.filter((f) => f.type === "event" && f.event?.type === "text_delta");
    assert.ok(deltas.length > 0, "mock provider streamed text back over the wire");

    // 3. The client detaches; the daemon (and the session) survive.
    ws.close();
    const stillUp = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(stillUp.ok, true);
    assert.ok(stillUp.sessions >= 1, "session outlives the client");

    // 4. The rollout landed on disk — the session can be rehydrated after a reboot.
    const rollout = await readFile(path.join(home, "garrison", "sessions", `${sessionId}.jsonl`), "utf8");
    assert.match(rollout, /turn_start/);
    assert.match(rollout, /message_done/);
  } catch (err) {
    err.message += `\n--- daemon output ---\n${daemonOut.slice(-2_000)}`;
    throw err;
  } finally {
    daemon.kill();
    await new Promise((resolve) => daemon.once("close", resolve));
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
