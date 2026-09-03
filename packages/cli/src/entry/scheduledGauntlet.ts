// The gauntlet, headless — one function the Garrison can call on a timer.
//
// `ares eval coding` had everything a nightly regression watch needs (the
// suites, the append-only scoreboard, `--gate` against its own history) and
// no way to run it without a terminal. runScheduledGauntlet() is the same
// pipeline with the printing removed: it runs the suite against a provider,
// writes the per-run report + scoreboard row under <home>/gauntlet, and
// returns the report, the regression verdict and the gate result so the
// caller (the CLI, or the Garrison's `gauntlet` scheduler hook) decides what
// to do with them. The schedule itself is persisted here too
// (<home>/gauntlet/schedule.json) so `ares eval coding --schedule 24h` and
// the Garrison read one source of truth.

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TodoStore, ShellRegistry } from "@ares/tools";
import { GAUNTLET_SUITES, detectRegression, parseScoreboard, parseScoreboardRow, runGauntlet, type GauntletReport, type GauntletTask, type RegressionVerdict, type ScoreboardRow } from "@ares/operator";
import type { SubModelPool } from "@ares/tools";
import { buildCodingTools } from "./engineTools.js";
import { AresCommandPermissionStore, AresPathPermissionStore } from "./permissions.js";
import { selectProvider, type ProviderSelection } from "./providers.js";
import { AresRuntimeState, cliRuntimeContext, cliVersion } from "./runtime.js";
import { buildSystemPrompt } from "./turnPipeline.js";

export interface ScheduledGauntletOptions {
  /** Suite name from GAUNTLET_SUITES (default "coding-v3"). */
  suite?: string;
  /** Provider id (default: the configured default provider). */
  provider?: string;
  /** Model id (default: the provider's configured default). */
  model?: string;
  /** Judge this run against its own history; `gated` is true on regression. */
  gate?: boolean;
  /** Ares home to write the report + scoreboard under (default ARES_HOME / ~/.ares). */
  home?: string;
  /** Verification harness on/off (default on). */
  harness?: boolean;
  keepWorkspaces?: boolean;
  /** Real-model runs execute candidate code in host processes. Default follows
   *  the CLI: allowed unless ARES_REQUIRE_ISOLATED_EVAL=1. */
  allowUnsafeProcessEval?: boolean;
  /** Task override (tests, smoke runs). Defaults to the suite's tasks. */
  tasks?: readonly GauntletTask[];
  /** Pre-resolved selection (tests inject fakes here instead of a provider id). */
  selection?: ProviderSelection;
  /** Source identity for the harness manifest; the CLI passes git facts. */
  sourceIdentity?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Who triggered the run — recorded in the harness manifest. */
  trigger?: "cli" | "schedule" | "garrison";
}

export interface ScheduledGauntletResult {
  report: GauntletReport;
  regression: RegressionVerdict | null;
  /** True when `gate` was requested and this run regressed vs its history. */
  gated: boolean;
  reportFile: string;
  scoreboardFile: string;
  /** Appended to the scoreboard (false when the run was incomplete). */
  recorded: boolean;
  /** One-paragraph human summary — what a Garrison notification would say. */
  summary: string;
  /** The Garrison's ledger shape (recordNightlyGauntlet's GauntletRunSummary):
   *  tasks fully solved / tasks run, and whether the regression gate held. */
  nightly: { passed: number; total: number; gateOk: boolean; suite: string; provider: string; model: string };
}

/** Run the gauntlet headless: score, persist, gate. Throws only on setup
 *  errors (unknown suite, unselectable provider); a failing suite returns. */
export async function runScheduledGauntlet(opts: ScheduledGauntletOptions = {}): Promise<ScheduledGauntletResult> {
  const suite = opts.suite ?? "coding-v3";
  const suiteTasks = opts.tasks ?? GAUNTLET_SUITES[suite];
  if (!suiteTasks) throw new Error(`unknown gauntlet suite "${suite}" — one of ${Object.keys(GAUNTLET_SUITES).join(", ")}`);
  const flags = new Map<string, string>();
  if (opts.provider) flags.set("provider", opts.provider);
  if (opts.model) flags.set("model", opts.model);
  const selection = opts.selection ?? await selectProvider(flags);
  const context = cliRuntimeContext({ home: opts.home ?? process.env.ARES_HOME });
  const runtime: AresRuntimeState = { permissionMode: "workspace-write" };
  const isMockProvider = selection.provider.name === "mock" || selection.provider.name.startsWith("mock-");
  const requireIsolation = process.env.ARES_REQUIRE_ISOLATED_EVAL === "1";
  const allowUnsafeProcessEval = opts.allowUnsafeProcessEval ?? (!requireIsolation || process.env.ARES_ALLOW_UNSAFE_PROCESS_EVAL === "1");
  if (!isMockProvider && !allowUnsafeProcessEval) {
    throw new Error("isolation required: real-model coding eval executes candidate code in host processes; run inside a VM/container and set ARES_ALLOW_UNSAFE_PROCESS_EVAL=1");
  }
  const isolatedHomes: string[] = [];
  const evalShellRegistries: ShellRegistry[] = [];

  const report = await runGauntlet({
    provider: selection.provider,
    model: selection.model,
    keepWorkspaces: opts.keepWorkspaces === true,
    suite,
    tasks: suiteTasks,
    signal: opts.signal,
    harness: opts.harness !== false,
    harnessManifest: {
      ...(opts.sourceIdentity ?? {}),
      aresVersion: await cliVersion(),
      providerSource: selection.source,
      subModel: (selection.subModel as SubModelPool | undefined) ?? null,
      reasoning: "provider/default",
      permissionMode: runtime.permissionMode,
      trigger: opts.trigger ?? "cli",
    },
    systemPrompt: (workspace) => buildSystemPrompt("workspace-write", cliRuntimeContext({ workspace, home: context.home })),
    tools: async (workspace) => {
      // Fresh harness per workspace — gauntlet runs must not share shell or
      // todo state across tasks.
      const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "ares-coding-eval-home-"));
      isolatedHomes.push(isolatedHome);
      const isolatedContext = cliRuntimeContext({ workspace, home: isolatedHome });
      const [pathPermissions, commandPermissions] = await Promise.all([
        AresPathPermissionStore.load(isolatedContext),
        AresCommandPermissionStore.load(isolatedContext),
      ]);
      const shellRegistry = new ShellRegistry();
      evalShellRegistries.push(shellRegistry);
      const todoStore = new TodoStore();
      const tools = await buildCodingTools(pathPermissions, commandPermissions, selection, runtime, isolatedContext, shellRegistry, todoStore, new Map(), { shell: !isMockProvider && allowUnsafeProcessEval });
      return {
        tools,
        dispose: async () => {
          await shellRegistry.killAll().catch(() => 0);
          await rm(isolatedHome, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    },
  }).finally(async () => {
    await Promise.all(evalShellRegistries.map((registry) => registry.killAll().catch(() => 0)));
    await Promise.all(isolatedHomes.map((home) => rm(home, { recursive: true, force: true }).catch(() => undefined)));
  });

  // Persist: one report per run, plus an append-only scoreboard for trends.
  const dir = path.join(context.home, "gauntlet");
  await mkdir(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const reportFile = path.join(dir, `${stamp}-${report.model.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  const scoreboardFile = path.join(dir, "scoreboard.jsonl");
  const scoreboardEntry = { at: report.startedAt, schemaVersion: report.schemaVersion, suite: report.suite, harness: report.harness, official: report.official, isolation: report.isolation, complete: report.complete, taskManifestHash: report.taskManifestHash, systemPromptHash: report.systemPromptHash, startupReminderHash: report.startupReminderHash, toolSchemaHash: report.toolSchemaHash, toolNames: report.toolNames, environment: report.environment, harnessManifest: report.harnessManifest, provider: report.provider, model: report.model, total: report.total, durationMs: report.durationMs, usage: report.usage, metrics: report.metrics, tasks: report.tasks.map((t) => ({ id: t.id, score: t.score, workStatus: t.workStatus, usage: t.usage })) };
  // Judge this run against its own history BEFORE appending it — a run must
  // never be part of the baseline it is measured against.
  const history = await readFile(scoreboardFile, "utf8").then(parseScoreboard).catch(() => [] as ScoreboardRow[]);
  const currentRow = report.complete ? parseScoreboardRow(scoreboardEntry) : null;
  const regression = currentRow ? detectRegression(currentRow, history) : null;
  if (report.complete) {
    await appendFile(scoreboardFile, JSON.stringify(scoreboardEntry) + "\n", "utf8");
  }
  // The score saturates at frontier tier (coding-v3, 2026-08-15) — a regression
  // gate that only watches `total` is a gate that never closes. `gate` fails on
  // the axes that still move: cost, verification, wall-clock.
  const gated = opts.gate === true && regression?.regressed === true;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const summary = [
    `Gauntlet ${report.suite}: ${pct(report.total)} on ${report.model} via ${report.provider} (${Math.round(report.durationMs / 1000)}s, ${report.usage.modelCalls} model calls)`,
    `verified ${pct(report.metrics.verifiedTaskRate)} · false-green ${pct(report.metrics.falseGreenRate)} · integrity ${pct(report.metrics.integrityRate)}`,
    regression && regression.findings.length > 0
      ? `REGRESSION vs ${regression.baselineRuns} prior run${regression.baselineRuns === 1 ? "" : "s"}: ${regression.findings.map((f) => f.summary).join("; ")}`
      : regression?.confidence === "none"
        ? "no comparable history yet — this run becomes the baseline"
        : regression
          ? `no regression vs ${regression.baselineRuns} prior run${regression.baselineRuns === 1 ? "" : "s"}`
          : "INCOMPLETE — excluded from trend history",
    gated ? "GATE: regressed" : "",
  ].filter(Boolean).join("\n");
  const nightly = {
    passed: report.tasks.filter((t) => t.score === 1).length,
    total: report.tasks.length,
    gateOk: !gated,
    suite: report.suite,
    provider: report.provider,
    model: report.model,
  };
  return { report, regression, gated, reportFile, scoreboardFile, recorded: report.complete, summary, nightly };
}

// ─── Schedule persistence ─────────────────────────────────────────────

export interface GauntletSchedule {
  /** Cadence in milliseconds (hours × 3.6e6). */
  everyMs: number;
  /** Original spec the owner typed ("24h", "nightly", "0 3 * * *"). */
  spec: string;
  /** Preferred wall-clock hour (0-23) when the spec named one; the Garrison
   *  aligns the first run to it. */
  atHour?: number;
  atMinute?: number;
  suite: string;
  provider?: string;
  model?: string;
  gate: boolean;
  updatedAt: string;
}

const HOUR_MS = 3_600_000;

/**
 * Parse a schedule spec into a cadence. Accepted: `off`, `nightly`/`daily`,
 * `weekly`, `<n>h`, `<n>d`, a bare number of hours, or a five-field cron
 * limited to the shapes a nightly watch needs (`M H * * *` → daily at H:M;
 * `M H * * 0-6` → weekly). Anything richer is rejected rather than misread.
 */
export function parseGauntletSchedule(spec: string): { everyMs: number; atHour?: number; atMinute?: number } | null {
  const s = spec.trim().toLowerCase();
  if (!s || s === "off" || s === "none" || s === "0") return null;
  if (s === "nightly" || s === "daily") return { everyMs: 24 * HOUR_MS, atHour: 3, atMinute: 0 };
  if (s === "weekly") return { everyMs: 7 * 24 * HOUR_MS, atHour: 3, atMinute: 0 };
  const hours = /^(\d+(?:\.\d+)?)\s*h(?:ours?)?$/.exec(s) ?? /^(\d+(?:\.\d+)?)$/.exec(s);
  if (hours) {
    const h = Number(hours[1]);
    return h > 0 ? { everyMs: Math.max(HOUR_MS, Math.round(h * HOUR_MS)) } : null;
  }
  const days = /^(\d+(?:\.\d+)?)\s*d(?:ays?)?$/.exec(s);
  if (days) {
    const d = Number(days[1]);
    return d > 0 ? { everyMs: Math.round(d * 24 * HOUR_MS) } : null;
  }
  const cron = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-6])$/.exec(s);
  if (cron) {
    const minute = Number(cron[1]);
    const hour = Number(cron[2]);
    if (minute > 59 || hour > 23) return null;
    return { everyMs: cron[3] === "*" ? 24 * HOUR_MS : 7 * 24 * HOUR_MS, atHour: hour, atMinute: minute };
  }
  return null;
}

/** Delay until the next aligned run — now + cadence, snapped to atHour:atMinute when set. */
export function nextGauntletRunDelayMs(schedule: Pick<GauntletSchedule, "everyMs" | "atHour" | "atMinute">, now: Date = new Date()): number {
  if (schedule.atHour === undefined) return schedule.everyMs;
  const next = new Date(now);
  next.setHours(schedule.atHour, schedule.atMinute ?? 0, 0, 0);
  while (next.getTime() <= now.getTime()) next.setTime(next.getTime() + schedule.everyMs);
  return next.getTime() - now.getTime();
}

export function gauntletSchedulePath(home: string): string {
  return path.join(home, "gauntlet", "schedule.json");
}

export async function loadGauntletSchedule(home: string): Promise<GauntletSchedule | null> {
  try {
    const parsed = JSON.parse(await readFile(gauntletSchedulePath(home), "utf8")) as Partial<GauntletSchedule>;
    if (!parsed || typeof parsed.everyMs !== "number" || parsed.everyMs <= 0 || typeof parsed.suite !== "string") return null;
    return { gate: true, spec: String(parsed.spec ?? ""), updatedAt: String(parsed.updatedAt ?? ""), ...parsed } as GauntletSchedule;
  } catch {
    return null;
  }
}

/** Persist (or with `null`, clear) the schedule. Returns what was written. */
export async function saveGauntletSchedule(home: string, schedule: GauntletSchedule | null): Promise<GauntletSchedule | null> {
  const file = gauntletSchedulePath(home);
  if (!schedule) {
    await rm(file, { force: true }).catch(() => undefined);
    return null;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(schedule, null, 2) + "\n", "utf8");
  return schedule;
}
