// Opening a chat card loads the session (hooks, memory, recovery checks) on
// the daemon's serial command loop. A slow load held every other chat's
// commands behind it, so one card freezing looked like the whole app bricked.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmTemp } from "./_rmTemp.mjs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "..", "packages", "cli", "dist", "entry.js");

test("a slow chat load does not hold other chats, and a send to the slow chat waits for its own load", { timeout: 60_000 }, async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-open-ws-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-open-home-"));
  writeFileSync(path.join(home, "ui.json"), JSON.stringify({ dangerousBypass: false, routingMode: "manual" }) + "\n");
  const child = spawn(process.execPath, [cliEntry, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"], {
    cwd: workspace,
    env: { ...process.env, ARES_HOME: home, ARES_AGENT_ENABLED: "0", ARES_OPERATOR_AUTOTICK: "0", ARES_CODING_PROOF_GATE: "0", ARES_TEST_DAEMON_OPEN_DELAY_MS: "6000" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const at = {};
  const opened = [];
  let buffer = "";
  let stderr = "";
  const write = (c) => child.stdin.write(JSON.stringify(c) + "\n");
  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`timed out\n${stderr}`)), 50_000);
      child.stderr.on("data", (d) => { stderr += d; });
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.type === "daemon_ready" && !at.ready) {
            at.ready = Date.now();
            write({ type: "session_open", sessionId: "slow-open-a" });
            write({ type: "send", sessionId: "slow-open-a", inputId: "to-slow", goal: "SLOW-CHAT" });
            write({ type: "send", sessionId: "fast-b", inputId: "to-fast", goal: "FAST-CHAT" });
          }
          if (e.type === "session_opened") opened.push(e.sessionId);
          if (e.type === "turn_settled" && e.inputId === "to-fast") at.fast = Date.now();
          if (e.type === "turn_settled" && e.inputId === "to-slow") at.slow = Date.now();
          if (at.fast && at.slow) { clearTimeout(deadline); resolve(); }
        }
      });
      child.once("exit", (code) => reject(new Error(`exited ${code}\n${stderr}`)));
    });
  } finally {
    try { write({ type: "exit" }); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode === null) child.kill();
    rmTemp(workspace);
    rmTemp(home);
  }
  assert.ok(at.fast - at.ready < 4_000, `the other chat answered in ${at.fast - at.ready}ms, not behind the 6s load`);
  assert.ok(at.slow - at.ready >= 5_500, "the slow chat's own send waited for its load");
  assert.equal(opened.filter((sid) => sid === "slow-open-a").length, 1, "the slow chat was built once, not twice");
});
