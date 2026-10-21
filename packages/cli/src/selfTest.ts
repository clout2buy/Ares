// Self-test: run a throwaway daemon (offline mock model, temp home and
// workspace) through the paths that have bricked chats before, on THIS
// machine. Nothing touches the owner's sessions, keys or memory, and no model
// is called, so it costs nothing to run nightly.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface SelfTestResult {
  ok: boolean;
  at: string;
  ms: number;
  checks: SelfTestCheck[];
}

interface Daemon {
  send(command: Record<string, unknown>): void;
  waitFor(match: (event: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>>;
  text(): string;
  stop(): Promise<void>;
}

/**
 * The throwaway daemon must not reach anything of the owner's: no inherited
 * ARES_* settings, its home folders all point at the temp dir (paths built
 * from os.homedir() included), the shared Mnemosyne memory server and the
 * garrison port are off limits, and it never schedules a self-test itself.
 */
export function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^ARES_/i.test(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    ARES_HOME: home,
    ARES_MNEMOSYNE: "0",
    ARES_GARRISON_PORT: "1",
    ARES_SELFTEST_DAILY: "0",
    ARES_AGENT_ENABLED: "0",
    ARES_OPERATOR_AUTOTICK: "0",
    ARES_CODING_PROOF_GATE: "0",
    ARES_STREAM_STALL_MS: "999999",
  };
}

function startDaemon(entry: string, home: string, workspace: string): Promise<Daemon> {
  const child = spawn(
    process.execPath,
    [entry, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"],
    {
      cwd: workspace,
      env: isolatedEnv(home),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const events: Array<Record<string, unknown>> = [];
  const waiters: Array<{ match: (e: Record<string, unknown>) => boolean; resolve: (e: Record<string, unknown>) => void }> = [];
  let buffer = "";
  let replies = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      events.push(event);
      if (event.type === "text_delta" && typeof event.text === "string") replies += event.text;
      for (const waiter of [...waiters]) {
        if (waiter.match(event)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    }
  });
  child.stderr.resume();
  const daemon: Daemon = {
    send: (command) => { child.stdin.write(JSON.stringify(command) + "\n"); },
    waitFor: (match, timeoutMs) => new Promise((resolve, reject) => {
      const seen = events.find(match);
      if (seen) return resolve(seen);
      const waiter = { match, resolve: (e: Record<string, unknown>) => { clearTimeout(timer); resolve(e); } };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      waiters.push(waiter);
    }),
    text: () => replies,
    stop: async () => {
      try { child.stdin.write(JSON.stringify({ type: "exit" }) + "\n"); } catch { /* closing */ }
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 4_000)),
      ]);
      if (child.exitCode === null) child.kill();
    },
  };
  return daemon.waitFor((e) => e.type === "daemon_ready", 60_000).then(() => daemon, async (error) => {
    await daemon.stop();
    throw error;
  });
}

async function check(name: string, run: () => Promise<string | void>): Promise<SelfTestCheck> {
  const started = Date.now();
  try {
    const detail = await run();
    return { name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) };
  } catch (error) {
    return { name, ok: false, ms: Date.now() - started, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Run every check. `entry` is the CLI script (dist/entry.js). */
export async function runSelfTest(entry: string): Promise<SelfTestResult> {
  const started = Date.now();
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-selftest-home-"));
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-selftest-ws-"));
  writeFileSync(path.join(home, "ui.json"), JSON.stringify({ dangerousBypass: false, routingMode: "manual" }) + "\n", "utf8");
  const checks: SelfTestCheck[] = [];
  let daemon: Daemon | undefined;
  try {
    const boot = await check("the engine starts", async () => {
      daemon = await startDaemon(entry, home, workspace);
    });
    checks.push(boot);
    if (!daemon) return { ok: false, at: new Date().toISOString(), ms: Date.now() - started, checks };
    const d = daemon;
    checks.push(await check("a message gets a reply", async () => {
      d.send({ type: "send", sessionId: "selftest-a", inputId: "st-reply", goal: "SELFTEST-REPLY" });
      await d.waitFor((e) => e.type === "turn_settled" && e.inputId === "st-reply", 20_000);
      if (!d.text().includes("SELFTEST-REPLY")) throw new Error("the turn ended without the reply");
    }));
    checks.push(await check("a ping is answered while a turn is stuck", async () => {
      d.send({ type: "send", sessionId: "selftest-b", inputId: "st-stall", goal: "__mock_stall__ selftest" });
      await d.waitFor((e) => e.type === "provider_attempt_started" && e.sessionId === "selftest-b", 20_000);
      d.send({ type: "ping", nonce: "selftest" });
      const pong = await d.waitFor((e) => e.type === "pong" && e.nonce === "selftest", 5_000);
      const turns = Array.isArray(pong.turns) ? pong.turns as Array<{ inputId?: string }> : [];
      if (!turns.some((t) => t.inputId === "st-stall")) throw new Error("the pong did not list the stuck turn");
    }));
    checks.push(await check("another chat answers while one is stuck", async () => {
      d.send({ type: "send", sessionId: "selftest-c", inputId: "st-other", goal: "SELFTEST-OTHER" });
      await d.waitFor((e) => e.type === "turn_settled" && e.inputId === "st-other", 20_000);
    }));
    checks.push(await check("Stop frees the stuck chat and it answers again", async () => {
      d.send({ type: "interrupt", sessionId: "selftest-b" });
      await d.waitFor((e) => e.type === "turn_settled" && e.inputId === "st-stall", 30_000);
      d.send({ type: "send", sessionId: "selftest-b", inputId: "st-after", goal: "SELFTEST-AFTER-STOP" });
      await d.waitFor((e) => e.type === "turn_settled" && e.inputId === "st-after", 20_000);
      if (!d.text().includes("SELFTEST-AFTER-STOP")) throw new Error("no reply after Stop");
    }));
  } finally {
    await daemon?.stop().catch(() => undefined);
    // Windows can hold the folders a moment after the child exits; a leftover
    // temp dir must never turn a passing self-test into a crash.
    for (const dir of [home, workspace]) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the OS reaps temp */ }
    }
  }
  return { ok: checks.every((c) => c.ok), at: new Date().toISOString(), ms: Date.now() - started, checks };
}

export function formatSelfTest(result: SelfTestResult): string {
  const lines = result.checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name} (${(c.ms / 1000).toFixed(1)}s)${c.ok || !c.detail ? "" : ` — ${c.detail}`}`);
  lines.push(result.ok ? `All ${result.checks.length} checks passed.` : `${result.checks.filter((c) => !c.ok).length} of ${result.checks.length} checks failed.`);
  return lines.join("\n");
}
