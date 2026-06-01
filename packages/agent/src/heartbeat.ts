import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentPaths, crixAgentHome } from "./paths.js";
import { nonCommentLines, readTextIfExists, writeFileAtomic } from "./files.js";
import type { CrixAgentConfig } from "./config.js";
import { emitLifecycle } from "./lifecycle/bus.js";
import { loadSelfModel } from "./self/store.js";
import { reflect } from "./self/reflect.js";
import { gainForTarget } from "./voice.js";

const execFileAsync = promisify(execFile);

export interface HeartbeatResult {
  status: "ok" | "skipped" | "alert" | "error";
  text: string;
  tasks: string[];
}

export async function runHeartbeatTick(opts: {
  home?: string;
  workspace: string;
  config: CrixAgentConfig;
  reason?: string;
  now?: Date;
}): Promise<HeartbeatResult> {
  const home = crixAgentHome(opts.home);
  const paths = agentPaths(home);
  emitLifecycle({ type: "heartbeat_tick", reason: opts.reason ?? "interval" });
  const text = await readTextIfExists(paths.heartbeat);
  const tasks = text ? nonCommentLines(text) : [];
  const now = opts.now ?? new Date();
  if (!withinActiveHours(now, opts.config.heartbeat.activeHours)) {
    return { status: "skipped", text: "HEARTBEAT_OK outside active hours", tasks };
  }

  const findings: string[] = [];
  for (const task of tasks) {
    const finding = await evaluateHeartbeatTask(task, opts.workspace);
    if (finding) findings.push(finding);
  }
  // Autonomous self-reflection: no HEARTBEAT.md required. An idle tick that
  // finds a broken or failing capability surfaces it as an alert.
  findings.push(...(await reflectHeartbeat(home)));

  if (tasks.length > 0) await writeHeartbeatState(paths.heartbeatState, now, tasks);
  if (findings.length === 0) return { status: tasks.length > 0 ? "ok" : "skipped", text: "HEARTBEAT_OK", tasks };
  return { status: "alert", text: findings.join("\n").slice(0, opts.config.heartbeat.ackMaxChars), tasks };
}

export function startHeartbeatLoop(opts: {
  home?: string;
  workspace: string;
  config: CrixAgentConfig;
  onAlert: (text: string) => void;
}): () => void {
  const everyMs = parseDurationMs(opts.config.heartbeat.every, 30 * 60_000);
  const timer = setInterval(() => {
    void runHeartbeatTick({ ...opts, reason: "interval" })
      .then((result) => {
        if (result.status === "alert") opts.onAlert(result.text);
      })
      .catch((err) => opts.onAlert(`Heartbeat failed: ${err instanceof Error ? err.message : String(err)}`));
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function reflectHeartbeat(home: string): Promise<string[]> {
  try {
    const directives = reflect(await loadSelfModel(home));
    if (directives.length === 0) return [];
    emitLifecycle({
      type: "self_reflected",
      directives: directives.length,
      topKind: directives[0].kind,
      gain: gainForTarget("SELF", directives.length, "reflected"),
    });
    // Only urgent directives (failing/broken capabilities) interrupt as alerts;
    // acquire/stale hints wait for the agent to call Self reflect deliberately.
    return directives
      .filter((d) => d.severity >= 50)
      .slice(0, 3)
      .map((d) => `Self-directive [${d.kind}] ${d.capabilityName}: ${d.reason} -> ${d.suggestion}`);
  } catch {
    return [];
  }
}

async function evaluateHeartbeatTask(task: string, workspace: string): Promise<string | null> {
  const lower = task.toLowerCase();
  if (lower.includes("git status")) {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: workspace, windowsHide: true, timeout: 5_000 });
      const trimmed = stdout.trim();
      return trimmed ? `git status has changes:\n${trimmed}` : null;
    } catch {
      return null;
    }
  }
  if (lower.includes("todo")) {
    return await scanTodos(workspace);
  }
  return `Heartbeat task needs attention: ${task}`;
}

async function scanTodos(workspace: string): Promise<string | null> {
  const candidates = ["TODO", "FIXME"];
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".crix") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && found.length < 5) {
        const text = await readFile(full, "utf8").catch(() => "");
        if (candidates.some((candidate) => text.includes(candidate))) {
          found.push(path.relative(workspace, full));
        }
      }
    }
  }
  await walk(workspace);
  return found.length > 0 ? `TODO markers found: ${found.join(", ")}` : null;
}

async function writeHeartbeatState(file: string, now: Date, tasks: readonly string[]): Promise<void> {
  await writeFileAtomic(file, JSON.stringify({ lastRunAt: now.toISOString(), tasks }, null, 2) + "\n")
    .catch(async () => {
      await writeFile(file, JSON.stringify({ lastRunAt: now.toISOString(), tasks }, null, 2) + "\n", "utf8");
    });
}

function parseDurationMs(value: string, fallback: number): number {
  const match = value.trim().match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  if (unit === "h") return amount * 60 * 60_000;
  if (unit === "m") return amount * 60_000;
  if (unit === "s") return amount * 1_000;
  return amount;
}

function withinActiveHours(now: Date, hours: { start: string; end: string }): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = parseClock(hours.start);
  const end = parseClock(hours.end);
  if (start <= end) return minutes >= start && minutes <= end;
  return minutes >= start || minutes <= end;
}

function parseClock(value: string): number {
  const [h, m] = value.split(":").map((part) => Number(part));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

