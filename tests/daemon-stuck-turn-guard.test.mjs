import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "..", "packages", "cli", "dist", "entry.js");

/**
 * Remove a temp dir a spawned daemon was using. Windows keeps directory
 * handles open for a moment after the child exits, so a plain rmSync races the
 * OS and throws EBUSY — from inside `finally`, which replaced the test's real
 * outcome with a cleanup error and hid whether the watchdog actually worked.
 * Retry briefly, then leave it: an abandoned temp dir is the runner's to reap,
 * and must never decide a test.
 */
async function removeTemp(dir) {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

test("stuck-turn watchdog auto-cancels a silent turn and frees the session", { timeout: 60_000 }, async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-stuck-turn-guard-workspace-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-stuck-turn-guard-home-"));
  const sessionId = "stuck-turn-guard";
  const stallInputId = "stall-owner";
  const recoveryInputId = "after-stall-recovery";
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
        // Short silence threshold so the watchdog fires fast in tests.
        ARES_TURN_SILENCE_MS: "3000",
        // Disable the engine's own stall guards so only the daemon watchdog fires.
        ARES_STREAM_IDLE_MS: "999999",
        ARES_STREAM_STALL_MS: "999999",
        ARES_THINK_CEILING_MS: "999999",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  const events = [];
  let stdoutBuffer = "";
  let stderr = "";
  let stallSent = false;
  let stallSettled = false;
  let recoverySent = false;
  let recoverySettled = false;
  const writeCommand = (command) => child.stdin.write(JSON.stringify(command) + "\n");

  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(
          `stuck-turn watchdog test timed out\nstdout=${stdoutBuffer}\nstderr=${stderr}\n` +
          `events=${JSON.stringify(events.slice(-60))}`,
        ));
      }, 50_000);

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

          if (event.type === "daemon_ready" && !stallSent) {
            stallSent = true;
            writeCommand({
              type: "send",
              sessionId,
              inputId: stallInputId,
              goal: "__mock_stall__ please hang forever",
            });
          }

          // The stalled turn should be freed by the watchdog.
          if (
            event.type === "turn_settled" &&
            event.inputId === stallInputId &&
            !recoverySent
          ) {
            stallSettled = true;
            recoverySent = true;
            writeCommand({
              type: "send",
              sessionId,
              inputId: recoveryInputId,
              goal: "RECOVERY-AFTER-STALL hello",
            });
          }

          // The recovery turn should complete normally.
          if (
            event.type === "turn_settled" &&
            event.inputId === recoveryInputId
          ) {
            recoverySettled = true;
            clearTimeout(deadline);
            resolve();
          }
        }
      });
      child.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      child.once("exit", (code) => {
        if (recoverySettled) return;
        clearTimeout(deadline);
        reject(new Error(`daemon exited before recovery completed: ${code}\nstderr=${stderr}`));
      });
    });
  } finally {
    if (child.exitCode === null) {
      try { writeCommand({ type: "exit" }); } catch {}
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    await removeTemp(workspace);
    await removeTemp(home);
  }

  assert.ok(stallSettled, "the stalled turn was auto-settled by the watchdog");
  assert.ok(recoverySettled, "a follow-up message completed after the stuck turn was freed");

  // The watchdog should have triggered at least one interrupt.
  const interruptEvents = events.filter(
    (e) => e.inputId === stallInputId && (e.type === "interrupt_requested" || e.type === "interrupt_forced"),
  );
  assert.ok(interruptEvents.length > 0, "the watchdog injected at least one synthetic interrupt");

  // The watchdog's diagnostic should appear in stderr.
  assert.ok(
    stderr.includes("stuck-turn watchdog"),
    `expected watchdog diagnostic in stderr, got: ${stderr.slice(0, 500)}`,
  );

  // The recovery turn should have produced text — text_delta events don't
  // carry inputId, so check that some arrived between the two turn_settled's.
  const stallSettledIdx = events.findIndex(
    (e) => e.type === "turn_settled" && e.inputId === stallInputId,
  );
  const recoverySettledIdx = events.findIndex(
    (e) => e.type === "turn_settled" && e.inputId === recoveryInputId,
  );
  const recoveryText = events
    .slice(stallSettledIdx + 1, recoverySettledIdx)
    .filter((e) => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
  assert.ok(
    recoveryText.includes("RECOVERY-AFTER-STALL"),
    `recovery turn should have echoed normally, got: ${recoveryText.slice(0, 200)}`,
  );
});
