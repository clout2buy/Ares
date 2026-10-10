// codingBackendRun - the durable, structured half of CodingBackend.
//
// CodingBackend used to be fire-and-forget: spawn the CLI, scrape a summary,
// hope. This module gives each delegated run an identity and a record so that
//   * a retried tool call (same toolUseId) after a crash/restart NEVER starts a
//     second CLI on top of the first (running -> refuse, completed -> replay,
//     interrupted -> resume the CLI session when it exposed a session id);
//   * the owner sees concise progress instead of raw stream-json;
//   * the end of every run (success, failure, timeout) carries a result card:
//     what changed (git numstat), and the project's own test command re-run by
//     Ares - not the CLI's say-so.
// Pure helpers + small file IO; the spawn/permission flow stays in CodingBackend.ts.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type RunStatus = "running" | "completed" | "failed" | "timed_out" | "interrupted";

export interface BackendRunRecord {
  key: string;
  backend: string;
  task: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  /** Ares process that owns the run. */
  ownerPid: number;
  /** The CLI's pid (process-group leader on POSIX). */
  childPid?: number;
  /** Claude Code session id captured from stream-json (enables --resume). */
  sessionId?: string;
  card?: BackendResultCard;
}

export interface BackendTestResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  /** Digest of the output (counts + first failures), never the whole log. */
  summary: string;
}

export interface BackendResultCard {
  backend: string;
  label: string;
  status: "completed" | "failed" | "timed_out";
  durationMs: number;
  model: string;
  effort?: string;
  sessionId?: string;
  resumed: boolean;
  isolation?: { branch: string; worktree: string; base: string };
  git?: {
    branch?: string;
    head?: string;
    filesChanged: number;
    added: number;
    removed: number;
    files: Array<{ path: string; added: number | null; removed: number | null }>;
    untracked: string[];
  };
  tests?: BackendTestResult;
  /** One honest line: verified / tests failed / not verified. */
  verification: "tests-passed" | "tests-failed" | "no-test-command" | "not-run" | "no-changes";
  summary: string;
}

const SAFE_KEY = /[^A-Za-z0-9_.-]/g;

/** Stable key for a run. A tool-call id wins (it survives a restart); without
 *  one the key is a hash of what makes two runs "the same task". */
export function runKeyFor(parts: { toolUseId?: string; workspace: string; backend: string; model: string; task: string }): { key: string; fromToolCall: boolean } {
  if (parts.toolUseId && parts.toolUseId.trim()) {
    return { key: `call_${parts.toolUseId.replace(SAFE_KEY, "_").slice(0, 80)}`, fromToolCall: true };
  }
  const h = createHash("sha256").update([path.resolve(parts.workspace), parts.backend, parts.model, parts.task].join("\u0000")).digest("hex").slice(0, 24);
  return { key: `task_${h}`, fromToolCall: false };
}

export function runDir(workspace: string): string {
  return path.join(workspace, ".ares", "backend-runs");
}

async function workspaceExists(workspace: string): Promise<boolean> {
  return fs.stat(workspace).then((s) => s.isDirectory()).catch(() => false);
}

export async function readRunRecord(workspace: string, key: string): Promise<BackendRunRecord | null> {
  try {
    const raw = await fs.readFile(path.join(runDir(workspace), `${key}.json`), "utf8");
    const parsed = JSON.parse(raw) as BackendRunRecord;
    return parsed && typeof parsed === "object" && parsed.key === key ? parsed : null;
  } catch {
    return null;
  }
}

/** Best-effort, atomic (tmp + rename). Never throws - persistence must not fail a run. */
export async function writeRunRecord(workspace: string, record: BackendRunRecord): Promise<void> {
  try {
    if (!(await workspaceExists(workspace))) return;
    const dir = runDir(workspace);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${record.key}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    await fs.rename(tmp, file);
  } catch {
    /* best effort */
  }
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** In-process guard: one delegated run per workspace at a time. */
const activeByWorkspace = new Map<string, string>();
export function claimWorkspace(workspace: string, key: string): { ok: true } | { ok: false; heldBy: string } {
  const k = path.resolve(workspace);
  const held = activeByWorkspace.get(k);
  if (held && held !== key) return { ok: false, heldBy: held };
  activeByWorkspace.set(k, key);
  return { ok: true };
}
export function releaseWorkspace(workspace: string, key: string): void {
  const k = path.resolve(workspace);
  if (activeByWorkspace.get(k) === key) activeByWorkspace.delete(k);
}

export type PriorRun =
  | { kind: "fresh" }
  | { kind: "replay"; card: BackendResultCard; record: BackendRunRecord }
  | { kind: "still-running"; record: BackendRunRecord }
  | { kind: "resume"; record: BackendRunRecord };

/** Decide what a (possibly retried) call should do given the on-disk record. */
export function classifyPriorRun(record: BackendRunRecord | null, fromToolCall: boolean): PriorRun {
  if (!record) return { kind: "fresh" };
  if (record.status === "completed" && record.card && fromToolCall) return { kind: "replay", card: record.card, record };
  if (record.status === "running") {
    // Our own process, or an orphaned CLI that is still editing the tree.
    if (pidAlive(record.childPid) || (record.ownerPid !== process.pid && pidAlive(record.ownerPid))) return { kind: "still-running", record };
    return { kind: "resume", record };
  }
  if (record.status === "interrupted" || record.status === "timed_out" || record.status === "failed") return { kind: "resume", record };
  return { kind: "fresh" };
}

/** Pull the Claude Code session id out of a stream-json line (system/init or result). */
export function extractSessionId(line: string): string | undefined {
  const t = line.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    const obj = JSON.parse(t) as Record<string, unknown>;
    const id = obj.session_id ?? obj.sessionId;
    return typeof id === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** One short human line for a stream-json event, or null when it is noise. */
export function summarizeBackendLine(backend: string, line: string): string | null {
  const t = line.trim();
  if (!t.startsWith("{")) return t ? t.slice(0, 160) : null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (backend === "claude") {
    const msg = obj.message as { content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? (msg!.content as Array<Record<string, unknown>>) : [];
    for (const block of content) {
      if (block?.type === "tool_use") {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const target = String(input.file_path ?? input.path ?? input.command ?? input.pattern ?? "").replace(/\s+/g, " ").slice(0, 100);
        return `${String(block.name ?? "tool")}${target ? ` ${target}` : ""}`;
      }
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) return block.text.trim().replace(/\s+/g, " ").slice(0, 140);
    }
    if (obj.type === "result") return `finished (${String(obj.subtype ?? "done")})`;
    return null;
  }
  const type = String(obj.type ?? obj.event ?? "");
  const item = (obj.item ?? {}) as Record<string, unknown>;
  const text = [item.command, item.message, item.text, obj.message].find((v) => typeof v === "string" && (v as string).trim()) as string | undefined;
  if (text) return `${type ? `${type}: ` : ""}${text.trim().replace(/\s+/g, " ").slice(0, 140)}`;
  return null;
}

/** Map an effort name to a Claude Code thinking-token budget (MAX_THINKING_TOKENS). */
export function thinkingBudgetFor(effort: string | undefined): number | undefined {
  switch (effort) {
    case "low": return 4_000;
    case "medium": return 10_000;
    case "high": return 31_999;
    default: return undefined;
  }
}

export function renderCard(card: BackendResultCard): string {
  const lines = [
    `Result card: ${card.label} ${card.status} in ${(card.durationMs / 1000).toFixed(1)}s (model ${card.model}${card.effort ? `, effort ${card.effort}` : ""}${card.resumed ? ", resumed" : ""})`,
  ];
  if (card.isolation) lines.push(`Isolation: branch ${card.isolation.branch} in ${card.isolation.worktree} (base ${card.isolation.base}) - review and merge it yourself.`);
  if (card.git) {
    lines.push(`Changes: ${card.git.filesChanged} file(s), +${card.git.added} -${card.git.removed}${card.git.untracked.length ? `, ${card.git.untracked.length} untracked` : ""}`);
    for (const f of card.git.files.slice(0, 20)) lines.push(`  ${f.path} (+${f.added ?? "?"} -${f.removed ?? "?"})`);
    for (const u of card.git.untracked.slice(0, 10)) lines.push(`  ${u} (new)`);
  }
  if (card.tests) {
    lines.push(`Tests (${card.tests.command}): ${card.tests.timedOut ? "TIMED OUT" : card.tests.exitCode === 0 ? "PASS" : `FAIL exit ${card.tests.exitCode}`} in ${(card.tests.durationMs / 1000).toFixed(1)}s`);
    if (card.tests.exitCode !== 0 || card.tests.timedOut) lines.push(card.tests.summary.split("\n").slice(0, 14).join("\n"));
  }
  lines.push(
    card.verification === "tests-passed"
      ? "Verification: Ares re-ran the project tests after the run and they pass."
      : card.verification === "tests-failed"
        ? "Verification: FAILED - the project tests do not pass after this run. Do not report it done; fix or revert."
        : card.verification === "no-changes"
          ? "Verification: the run changed nothing."
          : `Verification: UNVERIFIED (${card.verification === "no-test-command" ? "no test command detected" : "tests were not run"}).`,
  );
  return lines.join("\n");
}
