// The 2026-10-21 bricked chat: after a Stop, the next message ("did u get
// bricked") showed turn_started, recall_surfaced, then nothing: no reply, no
// error, no turn end. Everything between recall and the model call (memory,
// estate, cross-surface digest, repo map, git delta, Forge note) is optional
// context with no deadline; Stop only recorded a pending cancel there and the
// stuck-turn watchdog was not armed yet. This drives the real daemon with a
// preparation step that never settles and proves:
//   1. Stop during preparation settles the turn promptly (not at the deadline);
//   2. the next message still gets a reply, after the prep deadline, with a
//      visible note that context was skipped.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "..", "packages", "cli", "dist", "entry.js");

const PREP_TIMEOUT_MS = 3_000;

test("a turn whose preparation never settles can be stopped, and the next message still gets a reply", { timeout: 90_000 }, async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-prep-workspace-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-daemon-prep-home-"));
  const sessionId = "prep-bounded-daemon";
  const stoppedInputId = "owner-stopped-during-prep";
  const nextInputId = "owner-after-prep-stop";
  writeFileSync(
    path.join(home, "ui.json"),
    JSON.stringify({ dangerousBypass: false, routingMode: "manual" }, null, 2) + "\n",
    "utf8",
  );

  const child = spawn(
    process.execPath,
    [cliEntry, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"],
    {
      cwd: workspace,
      env: {
        ...process.env,
        ARES_HOME: home,
        ARES_AGENT_ENABLED: "0",
        ARES_OPERATOR_AUTOTICK: "0",
        ARES_CODING_PROOF_GATE: "0",
        ARES_TEST_DAEMON_PREP_HANG_MS: "600000",
        ARES_TURN_PREP_TIMEOUT_MS: String(PREP_TIMEOUT_MS),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const events = [];
  let stdoutBuffer = "";
  let stderr = "";
  let firstSentAt = 0;
  let stopSentAt = 0;
  let stopSettledAt = 0;
  let nextSentAt = 0;
  let nextSettledAt = 0;
  let interruptTimer;
  const writeCommand = (command) => child.stdin.write(JSON.stringify(command) + "\n");

  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(
          `daemon prep flow timed out\nstderr=${stderr}\nevents=${JSON.stringify(events.slice(-60))}`,
        ));
      }, 75_000);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          events.push(event);
          if (event.type === "daemon_ready" && !firstSentAt) {
            firstSentAt = Date.now();
            writeCommand({ type: "send", sessionId, inputId: stoppedInputId, goal: "STOPPED-DURING-PREP" });
            // Let the turn get into its (hung) preparation, then Stop until
            // the daemon binds it to this exact input.
            setTimeout(() => {
              stopSentAt = Date.now();
              interruptTimer = setInterval(() => writeCommand({ type: "interrupt", sessionId }), 50);
            }, 500);
          }
          if (event.type === "interrupt_requested" && event.inputId === stoppedInputId) {
            clearInterval(interruptTimer);
            interruptTimer = undefined;
          }
          if (event.type === "turn_settled" && event.inputId === stoppedInputId && !nextSentAt) {
            stopSettledAt = Date.now();
            nextSentAt = Date.now();
            writeCommand({ type: "send", sessionId, inputId: nextInputId, goal: "NEXT-AFTER-PREP-STOP" });
          }
          if (event.type === "turn_settled" && event.inputId === nextInputId) {
            nextSettledAt = Date.now();
            clearTimeout(deadline);
            resolve();
          }
        }
      });
      child.once("error", (error) => { clearTimeout(deadline); reject(error); });
      child.once("exit", (code) => {
        if (nextSettledAt) return;
        clearTimeout(deadline);
        reject(new Error(`daemon exited early: ${code}\nstderr=${stderr}`));
      });
    });
  } finally {
    if (interruptTimer) clearInterval(interruptTimer);
    if (child.exitCode === null) {
      try { writeCommand({ type: "exit" }); } catch { /* closing */ }
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (child.exitCode === null) child.kill();
  }

  try {
    assert.ok(stopSettledAt - stopSentAt < PREP_TIMEOUT_MS - 500,
      `Stop settled the hung turn in ${stopSettledAt - stopSentAt}ms, before the ${PREP_TIMEOUT_MS}ms prep deadline`);
    const mine = events.filter((event) => event.sessionId === sessionId);
    assert.equal(
      mine.some((event) => event.type === "turn_end" && event.inputId === stoppedInputId && event.status === "completed"),
      false,
      "the stopped turn did not complete",
    );
    assert.equal(
      mine.some((event) => event.type === "text_delta" && /STOPPED-DURING-PREP/.test(event.text ?? "")),
      false,
      "the stopped request never reached the provider",
    );
    assert.ok(nextSettledAt - nextSentAt >= PREP_TIMEOUT_MS - 200, "the next turn waited for the prep deadline, not forever");
    assert.ok(
      mine.some((event) => event.type === "system_reminder_injected" && /took over \d+s to gather/.test(event.text ?? "")),
      "the owner is told context was skipped",
    );
    assert.match(
      mine.filter((event) => event.type === "text_delta").map((event) => event.text ?? "").join(""),
      /NEXT-AFTER-PREP-STOP/,
      "the message after the hung turn got its reply",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
