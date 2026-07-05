// V10 — the multi-session daemon. Two concurrent chats must NOT bleed into
// each other: each send is tagged with its own sessionId, runs in its own
// isolated Session, and its events come back tagged. This is the fix for the
// "send to one chat, another responds" bug.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "packages", "cli", "dist", "entry.js");

// Resolves once `expectedTurnEnds` turn_end events arrive (the daemon is
// kill-on-resolve), with a generous ceiling for loaded CI machines — a fixed
// short window flakes when the full suite runs in parallel.
function runDaemon(workspace, commands, expectedTurnEnds, ms = 60000) { // CLI cold boot is 6-10s on Windows; two sessions + agent runtime need real headroom
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"], {
      env: { ...process.env, ARES_AGENT_ENABLED: "1", ARES_HOME: path.join(workspace, "home"), ARES_OPERATOR_AUTOTICK: "0" },
    });
    const lines = [];
    let ends = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.kill();
      resolve(lines);
    };
    const deadline = setTimeout(finish, ms);
    child.stdout.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          lines.push(evt);
          if (evt.type === "turn_end" && ++ends >= expectedTurnEnds) {
            // small grace so trailing events (session metadata) flush
            setTimeout(finish, 250);
          }
        } catch {
          /* non-JSON */
        }
      }
    });
    for (const c of commands) child.stdin.write(JSON.stringify(c) + "\n");
  });
}

test("multi-session: two chats stream concurrently without bleed-over", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-multi-"));
  const events = await runDaemon(ws, [
    { type: "send", sessionId: "chatA", goal: "ALPHA-ONLY" },
    { type: "send", sessionId: "chatB", goal: "BRAVO-ONLY" },
  ], 2);

  const textBy = { chatA: "", chatB: "" };
  for (const e of events) {
    if (e.type === "text_delta") textBy[e.sessionId] = (textBy[e.sessionId] ?? "") + (e.text ?? "");
  }
  // mock-echo replies with the goal — each chat sees ONLY its own.
  assert.match(textBy.chatA, /ALPHA/, "chatA must contain its own message");
  assert.ok(!/BRAVO/.test(textBy.chatA), "chatA must NOT contain chatB's message");
  assert.match(textBy.chatB, /BRAVO/, "chatB must contain its own message");
  assert.ok(!/ALPHA/.test(textBy.chatB), "chatB must NOT contain chatA's message");

  // both turns end, each tagged with its own session
  const endsA = events.filter((e) => e.type === "turn_end" && e.sessionId === "chatA");
  const endsB = events.filter((e) => e.type === "turn_end" && e.sessionId === "chatB");
  assert.ok(endsA.length >= 1, "chatA turn must complete");
  assert.ok(endsB.length >= 1, "chatB turn must complete");

  // the second chat spawned its own isolated session
  assert.ok(events.some((e) => e.type === "session_opened" && e.sessionId === "chatB"), "chatB should open a fresh session");
});
