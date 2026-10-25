// `ares daemon --json` must survive its clients (issues #32, #33, #34).
//
// One malformed stdin line used to take the whole daemon down — `null`,
// a numeric goal, a numeric reasoning level, a numeric sessionId — because
// the command loop had no per-command catch and the typed fields were never
// checked. Deleting the primary session reported ok:true and then every send
// failed "Session does not exist" until a restart. And two sends in quick
// succession wedged the chat: the second became a steer against a turn that
// had not been admitted yet, and the first never replied.
//
// Real daemon, real stdin, mock provider. One boot for all three.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "..", "packages", "cli", "dist", "entry.js");

test("malformed frames, primary delete and back-to-back sends never kill or wedge the daemon", { timeout: 90_000 }, async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-malformed-ws-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-malformed-home-"));
  writeFileSync(path.join(home, "ui.json"), JSON.stringify({ dangerousBypass: false, routingMode: "manual" }) + "\n");
  const child = spawn(process.execPath, [cliEntry, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"], {
    cwd: workspace,
    env: { ...process.env, ARES_HOME: home, ARES_AGENT_ENABLED: "0", ARES_OPERATOR_AUTOTICK: "0", ARES_CODING_PROOF_GATE: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const writeRaw = (line) => child.stdin.write(line + "\n");
  const write = (c) => writeRaw(JSON.stringify(c));
  const frames = [];
  let buffer = "";
  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal }; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try { frames.push(JSON.parse(line)); } catch { /* not a frame */ }
    }
  });
  const of = (type) => frames.filter((f) => f.type === type);
  const waitFor = async (cond, label, ms = 30_000) => {
    const start = Date.now();
    for (;;) {
      const v = cond();
      if (v) return v;
      if (exited) throw new Error(`daemon exited (${JSON.stringify(exited)}) while waiting for ${label}`);
      if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    const ready = await waitFor(() => of("daemon_ready")[0], "daemon_ready", 60_000);
    const primaryId = ready.sessionId;
    assert.ok(primaryId, "daemon_ready names the primary session");

    // #32 — every one of these used to exit the process.
    const bad = [
      "null",
      "42",
      '{"type":"send","goal":5}',
      '{"type":"reasoning","level":5}',
      '{"type":"workflow_mode","mode":"plan","sessionId":5}',
      '{"type":"send","goal":"x","sessionId":{"nope":1}}',
    ];
    for (const line of bad) {
      const before = of("daemon_error").length;
      writeRaw(line);
      await waitFor(() => of("daemon_error").length > before, `daemon_error for ${line}`);
    }
    assert.equal(exited, null, "the daemon is still running after the malformed lines");
    write({ type: "ping", nonce: "alive" });
    await waitFor(() => of("pong").some((p) => p.nonce === "alive"), "pong after the malformed lines");

    // #34 — the primary cannot be deleted, and sends keep working afterwards.
    write({ type: "session_delete", id: primaryId });
    const deleted = await waitFor(() => of("session_deleted").find((f) => f.id === primaryId), "session_deleted");
    assert.equal(deleted.ok, false);
    assert.match(deleted.error, /primary/);
    write({ type: "send", goal: "after-delete", inputId: "after-delete" });
    await waitFor(() => of("turn_settled").some((f) => f.inputId === "after-delete"), "a send after the refused delete still runs");
    assert.ok(!of("error").some((e) => /does not exist/.test(e.error?.message ?? "")), "no 'Session does not exist'");

    // #33 — two sends in one write: FIFO turns, both replied, nothing wedged.
    writeRaw(JSON.stringify({ type: "send", goal: "FIRST", inputId: "first" }) + "\n" + JSON.stringify({ type: "send", goal: "SECOND", inputId: "second" }));
    await waitFor(() => of("turn_settled").some((f) => f.inputId === "first"), "the first turn settles", 40_000);
    await waitFor(() => of("turn_settled").some((f) => f.inputId === "second"), "the second turn settles", 40_000);
    const settledOrder = of("turn_settled").map((f) => f.inputId).filter((id) => id === "first" || id === "second");
    assert.deepEqual(settledOrder, ["first", "second"], "sends on one session are FIFO turns");
    const queued = of("input_queued").find((f) => f.inputId === "second");
    assert.ok(queued, "the second send was queued as the next turn, not turned into a steer");
    assert.equal(queued.reason, "turn_preparing");
    assert.ok(of("message_done").length >= 3, `each turn produced a reply (${of("message_done").length} replies)`);
    const firstSettled = of("turn_settled").find((f) => f.inputId === "first");
    assert.equal(firstSettled.continuing, true, "the first turn's settlement announces the queued successor");
  } finally {
    try { write({ type: "exit" }); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 800));
    if (child.exitCode === null) child.kill();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
