// The desktop pings the daemon out of band. A pong must arrive even while a
// turn is wedged, and it must say what that turn last did, so a stuck chat
// names its own cause and a missing pong means the daemon itself is down.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmTemp } from "./_rmTemp.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "..", "packages", "cli", "dist", "entry.js");

test("a ping mid-turn gets a pong describing the stuck turn, and a stall report captures it", { timeout: 60_000 }, async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-ping-ws-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-ping-home-"));
  writeFileSync(path.join(home, "ui.json"), JSON.stringify({ dangerousBypass: false, routingMode: "manual" }) + "\n");
  const child = spawn(process.execPath, [cliEntry, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"], {
    cwd: workspace,
    env: { ...process.env, ARES_HOME: home, ARES_AGENT_ENABLED: "0", ARES_OPERATOR_AUTOTICK: "0", ARES_CODING_PROOF_GATE: "0", ARES_STREAM_STALL_MS: "999999" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const write = (c) => child.stdin.write(JSON.stringify(c) + "\n");
  let buffer = "";
  let pong;
  let gotPong;
  let saved;
  let report;
  try {
    pong = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("no pong")), 40_000);
      let sentPing = false;
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.type === "daemon_ready") write({ type: "send", sessionId: "stuck-chat", inputId: "hang", goal: "__mock_stall__ hang" });
          if (e.type === "provider_attempt_started" && !sentPing) {
            sentPing = true;
            setTimeout(() => write({ type: "ping", nonce: "n1" }), 1_200);
          }
          if (e.type === "pong") { gotPong = e; write({ type: "stall_report", sessionId: "stuck-chat" }); }
          if (e.type === "stall_report_saved") { saved = e; clearTimeout(deadline); resolve(gotPong); }
        }
      });
      child.once("exit", (code) => reject(new Error(`exited ${code}`)));
    });
    report = JSON.parse(readFileSync(saved.path, "utf8"));
  } finally {
    write({ type: "interrupt", sessionId: "stuck-chat" });
    try { write({ type: "exit" }); } catch {}
    await new Promise((r) => setTimeout(r, 800));
    if (child.exitCode === null) child.kill();
    rmTemp(workspace);
    rmTemp(home);
  }
  assert.equal(pong.nonce, "n1");
  const turn = pong.turns.find((t) => t.sessionId === "stuck-chat");
  assert.ok(turn, "the running turn is reported");
  assert.equal(turn.inputId, "hang");
  assert.ok(turn.lastEventMs >= 1_000, `time since the last event is reported (${turn.lastEventMs}ms)`);
  assert.equal(typeof turn.lastEvent, "string");
  assert.equal(pong.loop, null, "the command loop is free while the turn runs detached");
  assert.equal(pong.turns.filter((t) => t.inputId === "hang").length, 1, "each turn is listed once");
  assert.equal(report.kind, "ares-stall-report");
  assert.equal(report.session.turnActive, true);
  assert.equal(report.session.activeInputId, "hang");
  assert.ok(report.events.some((e) => e.sid === "stuck-chat" && e.type === "provider_attempt_started" && typeof e.at === "number"), "timestamped events of the stuck chat are in the report");
  assert.ok(!JSON.stringify(report.events).includes("__mock_stall__"), "message text stays out of the report");
});

test("desktop health: a missing pong reads as unresponsive, and quiet turns explain themselves", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-health-ui-"));
  try {
    const outfile = path.join(tmp, "health.mjs");
    await esbuild({ entryPoints: [path.join(here, "..", "tauri", "src", "state", "health.ts")], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
    const h = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
    assert.equal(h.daemonHealth(0, 0, 1e6), "ok");
    assert.equal(h.daemonHealth(1_000, 2_000, 60_000), "ok", "answered");
    assert.equal(h.daemonHealth(10_000, 2_000, 15_000), "ok");
    assert.equal(h.daemonHealth(10_000, 2_000, 19_000), "slow");
    assert.equal(h.daemonHealth(10_000, 2_000, 36_000), "unresponsive");
    assert.equal(h.turnStatusNote({ sessionId: "s", lastEvent: "tool_start", lastEventMs: 30_000, activeTools: 1, stopping: false }), null);
    assert.equal(
      h.turnStatusNote({ sessionId: "s", lastEvent: "tool_start", lastEventMs: 185_000, activeTools: 1, stopping: false }),
      "last activity: starting a tool, 3m 5s ago, a tool is still running",
    );
    assert.equal(h.loopStuckNote({ at: 0, queued: 0, loop: { busyWith: "send", forMs: 5_000 }, turns: [] }), null);
    assert.match(h.loopStuckNote({ at: 0, queued: 3, loop: { busyWith: "session_open", forMs: 31_000 }, turns: [] }), /"session_open" for 31s; 3 requests waiting/);
  } finally {
    rmTemp(tmp);
  }
});
