export type EvalTaskStatus = "passed" | "failed";
export const EVAL_REPORT_SCHEMA_VERSION = 1;

export interface EvalContext {
  workspace: string;
  signal: AbortSignal;
  now: () => Date;
}

export interface EvalTaskOutcome {
  passed?: boolean;
  score?: number;
  evidence?: string[];
  error?: string;
}

export interface EvalTask {
  id?: string;
  name: string;
  category?: string;
  run(ctx: EvalContext): Promise<EvalTaskOutcome | void>;
}

export interface EvalTaskResult {
  id: string;
  name: string;
  category: string;
  status: EvalTaskStatus;
  score: number;
  durationMs: number;
  evidence: string[];
  error?: string;
}

export interface EvalReport {
  schemaVersion: number;
  suite: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  score: number;
  results: EvalTaskResult[];
}

export interface RunEvalSuiteOptions {
  suite?: string;
  workspace: string;
  signal?: AbortSignal;
  now?: () => Date;
}

export async function runEvalSuite(tasks: readonly EvalTask[], opts: RunEvalSuiteOptions): Promise<EvalReport> {
  const now = opts.now ?? (() => new Date());
  const started = now();
  const signal = opts.signal ?? new AbortController().signal;
  const results: EvalTaskResult[] = [];

  for (const task of tasks) {
    const taskStarted = Date.now();
    try {
      const outcome = await task.run({ workspace: opts.workspace, signal, now });
      const passed = outcome?.passed ?? true;
      const score = passed ? clampScore(outcome?.score ?? 1) : 0;
      results.push({
        id: task.id ?? stableTaskId(task.name),
        name: task.name,
        category: task.category ?? "general",
        status: passed ? "passed" : "failed",
        score,
        durationMs: Date.now() - taskStarted,
        evidence: outcome?.evidence ?? [],
        error: passed ? undefined : outcome?.error ?? "task returned passed=false",
      });
    } catch (err) {
      results.push({
        id: task.id ?? stableTaskId(task.name),
        name: task.name,
        category: task.category ?? "general",
        status: "failed",
        score: 0,
        durationMs: Date.now() - taskStarted,
        evidence: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const finished = now();
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;
  const score = results.length === 0
    ? 1
    : Number((results.reduce((sum, result) => sum + result.score, 0) / results.length).toFixed(4));
  return {
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    suite: opts.suite ?? "crix",
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.max(0, finished.getTime() - started.getTime()),
    total: results.length,
    passed,
    failed,
    score,
    results,
  };
}

export function parseEvalReportJson(text: string): EvalReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid eval report JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return assertEvalReport(parsed);
}

export function assertEvalReport(value: unknown): EvalReport {
  if (!isRecord(value)) throw new Error("invalid eval report: expected object");
  if (value.schemaVersion !== EVAL_REPORT_SCHEMA_VERSION) {
    throw new Error(`invalid eval report: schemaVersion must be ${EVAL_REPORT_SCHEMA_VERSION}`);
  }
  const suite = requireString(value.suite, "suite");
  const startedAt = requireString(value.startedAt, "startedAt");
  const finishedAt = requireString(value.finishedAt, "finishedAt");
  const durationMs = requireNonNegativeNumber(value.durationMs, "durationMs");
  const total = requireNonNegativeInteger(value.total, "total");
  const passed = requireNonNegativeInteger(value.passed, "passed");
  const failed = requireNonNegativeInteger(value.failed, "failed");
  const score = requireScore(value.score, "score");
  if (!Array.isArray(value.results)) throw new Error("invalid eval report: results must be an array");
  if (value.results.length !== total) throw new Error("invalid eval report: results length must equal total");
  if (passed + failed !== total) throw new Error("invalid eval report: passed + failed must equal total");

  const results = value.results.map((item, index) => assertEvalTaskResult(item, index));
  const actualPassed = results.filter((result) => result.status === "passed").length;
  const actualFailed = results.filter((result) => result.status === "failed").length;
  if (actualPassed !== passed || actualFailed !== failed) {
    throw new Error("invalid eval report: result statuses do not match passed/failed counts");
  }

  return { schemaVersion: EVAL_REPORT_SCHEMA_VERSION, suite, startedAt, finishedAt, durationMs, total, passed, failed, score, results };
}

export function stableTaskId(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "eval-task"
  );
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function assertEvalTaskResult(value: unknown, index: number): EvalTaskResult {
  if (!isRecord(value)) throw new Error(`invalid eval report: results[${index}] must be an object`);
  const id = requireString(value.id, `results[${index}].id`);
  const name = requireString(value.name, `results[${index}].name`);
  const category = requireString(value.category, `results[${index}].category`);
  const rawStatus = requireString(value.status, `results[${index}].status`);
  if (rawStatus !== "passed" && rawStatus !== "failed") {
    throw new Error(`invalid eval report: results[${index}].status must be passed or failed`);
  }
  const score = requireScore(value.score, `results[${index}].score`);
  const durationMs = requireNonNegativeNumber(value.durationMs, `results[${index}].durationMs`);
  const evidence = value.evidence;
  if (!Array.isArray(evidence) || !evidence.every((item) => typeof item === "string")) {
    throw new Error(`invalid eval report: results[${index}].evidence must be a string array`);
  }
  const error = value.error === undefined ? undefined : requireString(value.error, `results[${index}].error`);
  if (rawStatus === "failed" && !error) {
    throw new Error(`invalid eval report: results[${index}].error is required for failed tasks`);
  }
  return { id, name, category, status: rawStatus, score, durationMs, evidence, error };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid eval report: ${field} must be a non-empty string`);
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`invalid eval report: ${field} must be a non-negative integer`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid eval report: ${field} must be a non-negative number`);
  }
  return value;
}

function requireScore(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid eval report: ${field} must be a number between 0 and 1`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
