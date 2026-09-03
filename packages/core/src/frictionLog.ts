// Friction telemetry — the "know exactly what to upgrade" spine.
//
// Every turn on every surface (chat, TUI, desktop daemon) folds its TurnEvents
// into one compact record and appends ONE JSONL line to
// ~/.ares/telemetry/friction-YYYY-MM.jsonl. This is the raw material for the
// gap-closing loop: which tools error, which Edit tier landed, how often turns
// stall or verify red, and how well the prompt cache is working. Local-only,
// no content — counts and ratios, never user text or file contents.
//
// Disable with ARES_TELEMETRY=0. Writes are best-effort and serialized; a
// telemetry failure can never affect a turn.

import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { aresHome } from "./providers/openaiAuth.js";
import { redactSecrets, type TurnEvent, type WorkStatus } from "@ares/protocol";
import { failureDigest, normalizeFailure } from "./codingJournal.js";
import {
  hashWorkspaceIdentity,
  registerSessionLocation,
  type SessionLocationSource,
  type SessionRolloutFormat,
} from "./sessionRegistry.js";

export type FrictionSource = SessionLocationSource | "unknown";

export interface FrictionDiagnostic {
  kind: "tool_error" | "stream_error" | "verification" | "subagent_error";
  signature: string;
  /** Secret-scrubbed, path/id/number-normalized and hard-bounded. */
  sample: string;
  count: number;
  tool?: string;
  code?: string;
}

export interface FrictionSessionLocation {
  rolloutPath: string;
  metaPath?: string;
  format: SessionRolloutFormat;
  /** Explicit isolation controls; also enable registry writes under node:test. */
  registryDir?: string;
  registryHome?: string;
}

export interface FrictionRecorderOptions {
  /** Explicit telemetry directory. String constructor arg remains supported. */
  dir?: string;
  source?: FrictionSource;
  workspace?: string;
  provider?: string;
  model?: string;
  location?: FrictionSessionLocation;
}

export interface FrictionTurn {
  /** Additive v2 envelope. Optional in the reader type for legacy JSONL rows. */
  schemaVersion?: 2;
  recordType?: "friction_turn";
  source?: FrictionSource;
  workspaceHash?: string | null;
  provider?: string | null;
  model?: string | null;
  workStatus?: WorkStatus | null;
  turnId?: string | null;
  diagnostics?: FrictionDiagnostic[];
  diagnosticsDropped?: number;
  at: string;
  sessionId: string;
  status: "completed" | "needs_verification" | "interrupted" | "failed" | "unknown";
  /** Structured verification gap from a needs_verification turn_end. */
  unverified?: { files: string[]; checksRun: string[]; missing: string[] } | null;
  durationMs: number;
  /** Per-tool call/error counts, keyed by tool name. */
  tools: Record<string, { calls: number; errors: number }>;
  /** Which Edit matching tier landed (exact/whitespace/anchor/normalized) or missed. */
  editTiers: { exact: number; whitespace: number; anchor: number; normalized: number; miss: number };
  /** Stream stalls cut by the effort dial this turn. */
  stalls: number;
  reasoningStalls: number;
  /** Verifier red-flag reminders injected (continuous verify + end gate). */
  verifyReminders: number;
  compactions: number;
  /** Screenshot payload that rode this turn's tool_results as image blocks.
   * Images are invisible to token usage attribution (they arrive inside
   * tool_result content, not text), so this is the only place the "image tax"
   * of a Browser/ComputerUse-heavy turn is measurable. approxBytes are decoded
   * bytes (base64 length × 3/4). Zero-defaulted; absent on legacy rows. */
  images: { blocks: number; approxBytes: number };
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  /** cacheRead / input — the prompt-cache health signal (null when no input). */
  cacheReadRatio: number | null;
}

export function telemetryDir(home = aresHome()): string {
  return path.join(home, "telemetry");
}

interface FrictionContext {
  source: FrictionSource;
  /** Kept only in memory so diagnostic samples can replace it before writing. */
  workspace: string | null;
  workspaceHash: string | null;
  provider: string | null;
  model: string | null;
}

const MAX_DIAGNOSTICS_PER_TURN = 8;
const MAX_DIAGNOSTIC_SAMPLE_CHARS = 240;

function emptyTurn(sessionId: string, context: FrictionContext): FrictionTurn {
  return {
    schemaVersion: 2,
    recordType: "friction_turn",
    source: context.source,
    workspaceHash: context.workspaceHash,
    provider: context.provider,
    model: context.model,
    workStatus: null,
    turnId: null,
    diagnostics: [],
    diagnosticsDropped: 0,
    at: new Date().toISOString(),
    sessionId,
    status: "unknown",
    durationMs: 0,
    tools: {},
    editTiers: { exact: 0, whitespace: 0, anchor: 0, normalized: 0, miss: 0 },
    stalls: 0,
    reasoningStalls: 0,
    verifyReminders: 0,
    compactions: 0,
    images: { blocks: 0, approxBytes: 0 },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    cacheReadRatio: null,
  };
}

export class FrictionRecorder {
  private turn: FrictionTurn;
  private readonly nameById = new Map<string, string>();
  private writeChain: Promise<void> = Promise.resolve();
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly context: FrictionContext;

  constructor(
    private readonly sessionId: string,
    dirOrOptions?: string | FrictionRecorderOptions,
  ) {
    const options: FrictionRecorderOptions =
      typeof dirOrOptions === "string" ? { dir: dirOrOptions } : (dirOrOptions ?? {});
    this.dir = options.dir ?? telemetryDir();
    this.context = {
      source: options.source ?? "unknown",
      workspace: options.workspace ? path.resolve(options.workspace) : null,
      workspaceHash: options.workspace ? hashWorkspaceIdentity(options.workspace) : null,
      provider: options.provider ?? null,
      model: options.model ?? null,
    };
    // `node --test` constructs many real Sessions. Those used to append their
    // fake tool failures into the owner's ~/.ares telemetry (190/190 Browser
    // failures in the live dashboard). Explicit test directories still record,
    // so FrictionRecorder itself remains fully testable.
    this.enabled = process.env.ARES_TELEMETRY !== "0" && (options.dir !== undefined || !process.env.NODE_TEST_CONTEXT);
    this.turn = emptyTurn(sessionId, this.context);

    // Registry writes are independent of telemetry opt-out: they contain only a
    // local source pointer + hash and are needed to find/delete session data.
    if (options.location && this.context.source !== "unknown" && options.workspace) {
      this.writeChain = registerSessionLocation(
        {
          sessionId,
          source: this.context.source,
          format: options.location.format,
          workspace: options.workspace,
          rolloutPath: options.location.rolloutPath,
          metaPath: options.location.metaPath,
        },
        { dir: options.location.registryDir, home: options.location.registryHome },
      ).then(() => undefined).catch(() => undefined);
    }
  }

  /** Provider/model can change in-place between turns. */
  updateContext(update: { workspace?: string; provider?: string; model?: string }): void {
    if (update.workspace) {
      this.context.workspace = path.resolve(update.workspace);
      this.context.workspaceHash = hashWorkspaceIdentity(update.workspace);
      this.turn.workspaceHash = this.context.workspaceHash;
    }
    if (update.provider !== undefined) {
      this.context.provider = update.provider || null;
      this.turn.provider = this.context.provider;
    }
    if (update.model !== undefined) {
      this.context.model = update.model || null;
      this.turn.model = this.context.model;
    }
  }

  /** Fold one TurnEvent. Cheap, synchronous, never throws. */
  record(ev: TurnEvent): void {
    if (!this.enabled) return;
    try {
      switch (ev.type) {
        case "turn_start": {
          // Timestamp the actual turn, not the recorder construction/previous
          // flush. Long-idle sessions otherwise age fresh failures out of the
          // triage lookback window before they are even written.
          this.turn.at = new Date().toISOString();
          this.turn.turnId = ev.turnId;
          break;
        }
        case "tool_use_start": {
          this.nameById.set(ev.id, ev.name);
          break;
        }
        case "tool_start": {
          this.nameById.set(ev.id, ev.name);
          break;
        }
        case "tool_end": {
          const name = this.nameById.get(ev.id) ?? "unknown";
          const t = (this.turn.tools[name] ??= { calls: 0, errors: 0 });
          t.calls++;
          this.addImageMetrics(ev.images, ev.output);
          if (name === "Edit") {
            const layer = (ev.output as { layer?: string } | undefined)?.layer;
            if (layer === "exact" || layer === "whitespace" || layer === "anchor" || layer === "normalized") this.turn.editTiers[layer]++;
          }
          break;
        }
        case "tool_error": {
          const name = this.nameById.get(ev.id) ?? "unknown";
          const t = (this.turn.tools[name] ??= { calls: 0, errors: 0 });
          t.calls++;
          t.errors++;
          this.addImageMetrics(ev.images, ev.output);
          if (name === "Edit") this.turn.editTiers.miss++;
          this.addDiagnostic("tool_error", ev.error, { tool: name });
          break;
        }
        case "error": {
          const code = ev.error?.code;
          if (code === "stream_stall") this.turn.stalls++;
          if (code === "reasoning_stall") {
            this.turn.stalls++;
            this.turn.reasoningStalls++;
          }
          this.addDiagnostic("stream_error", ev.error?.message ?? code ?? "stream error", { code });
          break;
        }
        case "system_reminder_injected": {
          if (ev.source === "verifier") {
            this.turn.verifyReminders++;
            this.addDiagnostic("verification", ev.text, { code: "verifier" });
          }
          if (ev.source === "compaction") this.turn.compactions++;
          break;
        }
        case "subagent_end": {
          if (ev.status !== "completed") {
            this.addDiagnostic("subagent_error", ev.summary || `subagent ${ev.status}`, { code: ev.status });
          }
          break;
        }
        case "turn_end": {
          this.turn.status = ev.status ?? "unknown";
          this.turn.workStatus = ev.workStatus ?? null;
          this.turn.unverified = ev.unverified ?? null;
          if (ev.provider) this.context.provider = ev.provider;
          if (ev.model) this.context.model = ev.model;
          this.turn.provider = this.context.provider;
          this.turn.model = this.context.model;
          this.turn.durationMs = ev.durationMs ?? 0;
          const u = ev.usage;
          if (u) {
            this.turn.usage = {
              inputTokens: u.inputTokens ?? 0,
              outputTokens: u.outputTokens ?? 0,
              cacheReadTokens: u.cacheReadTokens ?? 0,
            };
            this.turn.cacheReadRatio =
              this.turn.usage.inputTokens > 0
                ? Math.round((this.turn.usage.cacheReadTokens / this.turn.usage.inputTokens) * 1000) / 1000
                : null;
          }
          this.flushTurn();
          break;
        }
        default:
          break;
      }
    } catch {
      // telemetry never breaks a turn
    }
  }

  /** Snapshot of the CURRENT (unflushed) turn — for tests and live surfaces. */
  snapshot(): FrictionTurn {
    return JSON.parse(JSON.stringify(this.turn)) as FrictionTurn;
  }

  /** Fold one tool result's screenshot payload into the turn. The engine
   * reports its own count (from result.images); when absent — a foreign host
   * replaying events, or a tool that embeds image blocks directly in output —
   * fall back to a bounded scan of the output for {type:"image", source:{data}}
   * content blocks (the protocol ImageBlock shape). Never both, so an image
   * can't be counted twice. */
  private addImageMetrics(reported: { blocks: number; approxBytes: number } | undefined, output: unknown): void {
    const found = reported ?? scanImageBlocks(output);
    if (!found || found.blocks <= 0) return;
    const images = (this.turn.images ??= { blocks: 0, approxBytes: 0 });
    images.blocks += found.blocks;
    images.approxBytes += found.approxBytes;
  }

  private addDiagnostic(
    kind: FrictionDiagnostic["kind"],
    raw: string,
    context: Pick<FrictionDiagnostic, "tool" | "code"> = {},
  ): void {
    let scrubInput = String(raw ?? "");
    if (this.context.workspace) {
      for (const candidate of [this.context.workspace, this.context.workspace.replace(/\\/g, "/")]) {
        scrubInput = scrubInput.replace(new RegExp(escapeRegExp(candidate), "gi"), "<workspace>");
      }
    }
    const normalized = normalizeFailure(redactSecrets(scrubInput)) || `${kind} unavailable`;
    const sample = normalized.length > MAX_DIAGNOSTIC_SAMPLE_CHARS
      ? `${normalized.slice(0, MAX_DIAGNOSTIC_SAMPLE_CHARS - 1)}…`
      : normalized;
    const scope = `${kind}:${context.tool ?? ""}:${context.code ?? ""}`;
    const signature = failureDigest(scope, normalized, 16);
    const diagnostics = (this.turn.diagnostics ??= []);
    const existing = diagnostics.find((diagnostic) => diagnostic.signature === signature);
    if (existing) {
      existing.count++;
      return;
    }
    if (diagnostics.length >= MAX_DIAGNOSTICS_PER_TURN) {
      this.turn.diagnosticsDropped = (this.turn.diagnosticsDropped ?? 0) + 1;
      return;
    }
    diagnostics.push({ kind, signature, sample, count: 1, ...context });
  }

  /** Append the finished turn as one JSONL line and reset. Best-effort. */
  private flushTurn(): void {
    const line = JSON.stringify(this.turn) + "\n";
    const file = path.join(this.dir, `friction-${this.turn.at.slice(0, 7)}.jsonl`);
    this.turn = emptyTurn(this.sessionId, this.context);
    this.nameById.clear();
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, line, "utf8");
      })
      .catch(() => undefined);
  }

  /** Await pending writes (tests / clean shutdown). */
  settle(): Promise<void> {
    return this.writeChain;
  }
}

/** Bounded recursive scan for protocol-shaped image blocks. Depth-capped so a
 * pathological output object can't stall the (synchronous, per-event) record
 * path; base64 length × 3/4 approximates decoded bytes without decoding. */
function scanImageBlocks(value: unknown, depth = 0): { blocks: number; approxBytes: number } | null {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  let blocks = 0;
  let approxBytes = 0;
  const fold = (candidate: unknown): void => {
    const nested = scanImageBlocks(candidate, depth + 1);
    if (nested) {
      blocks += nested.blocks;
      approxBytes += nested.approxBytes;
    }
  };
  if (Array.isArray(value)) {
    for (const item of value) fold(item);
    return blocks > 0 ? { blocks, approxBytes } : null;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "image" && record.source && typeof record.source === "object") {
    const data = (record.source as Record<string, unknown>).data;
    return { blocks: 1, approxBytes: typeof data === "string" ? Math.floor((data.length * 3) / 4) : 0 };
  }
  for (const item of Object.values(record)) fold(item);
  return blocks > 0 ? { blocks, approxBytes } : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Aggregation for `ares friction` ─────────────────────────────────────

export interface FrictionSummary {
  turns: number;
  completed: number;
  /** Subset of `completed` that ended needs_verification (unproven coding work). */
  needsVerification: number;
  failed: number;
  tools: Record<string, { calls: number; errors: number }>;
  editTiers: FrictionTurn["editTiers"];
  stalls: number;
  reasoningStalls: number;
  verifyReminders: number;
  compactions: number;
  /** Aggregate screenshot payload across turns (zero for legacy rows). */
  images: { blocks: number; approxBytes: number };
  totalInputTokens: number;
  totalCacheReadTokens: number;
  avgCacheReadRatio: number | null;
  /** Per-workStatus turn counts (verified/unverified/blocked/not_applicable) —
   *  the friction gate's unverified-rate numerator/denominator. */
  workStatus: Record<string, number>;
  /** Diagnostics folded by signature across turns, count-descending. */
  diagnostics: Array<{ signature: string; kind: string; sample: string; count: number }>;
  /** Median completed-turn duration; null under 5 datapoints. */
  medianDurationMs: number | null;
}

/** Aggregate the last `days` of friction lines from a telemetry dir. */
export async function summarizeFriction(dir = telemetryDir(), days = 7): Promise<FrictionSummary> {
  const cutoff = Date.now() - days * 86_400_000;
  const summary: FrictionSummary = {
    turns: 0,
    completed: 0,
    needsVerification: 0,
    failed: 0,
    tools: {},
    editTiers: { exact: 0, whitespace: 0, anchor: 0, normalized: 0, miss: 0 },
    stalls: 0,
    reasoningStalls: 0,
    verifyReminders: 0,
    compactions: 0,
    images: { blocks: 0, approxBytes: 0 },
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    avgCacheReadRatio: null,
    workStatus: {},
    diagnostics: [],
    medianDurationMs: null,
  };
  const diagBySig = new Map();
  const durations = [];
  let ratioSum = 0;
  let ratioN = 0;
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const f of files.filter((f) => f.startsWith("friction-") && f.endsWith(".jsonl")).sort()) {
    const raw = await readFile(path.join(dir, f), "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let turn: FrictionTurn;
      try {
        turn = JSON.parse(line) as FrictionTurn;
      } catch {
        continue;
      }
      if (Date.parse(turn.at) < cutoff) continue;
      summary.turns++;
      if (turn.status === "completed" || turn.status === "needs_verification") summary.completed++;
      if (turn.status === "needs_verification") summary.needsVerification++;
      if (turn.status === "failed") summary.failed++;
      if (turn.workStatus) summary.workStatus[turn.workStatus] = (summary.workStatus[turn.workStatus] ?? 0) + 1;
      if (typeof turn.durationMs === "number" && turn.durationMs > 0) durations.push(turn.durationMs);
      for (const d of turn.diagnostics ?? []) {
        const key = `${d.kind}|${d.signature ?? d.sample ?? ""}`;
        const row = diagBySig.get(key) ?? { signature: String(d.signature ?? key), kind: d.kind, sample: String(d.sample ?? "").slice(0, 160), count: 0 };
        row.count += d.count ?? 1;
        diagBySig.set(key, row);
      }
      for (const [name, t] of Object.entries(turn.tools ?? {})) {
        const agg = (summary.tools[name] ??= { calls: 0, errors: 0 });
        agg.calls += t.calls;
        agg.errors += t.errors;
      }
      for (const k of ["exact", "whitespace", "anchor", "normalized", "miss"] as const) {
        summary.editTiers[k] += turn.editTiers?.[k] ?? 0;
      }
      summary.stalls += turn.stalls ?? 0;
      summary.reasoningStalls += turn.reasoningStalls ?? 0;
      summary.verifyReminders += turn.verifyReminders ?? 0;
      summary.compactions += turn.compactions ?? 0;
      summary.images.blocks += turn.images?.blocks ?? 0;
      summary.images.approxBytes += turn.images?.approxBytes ?? 0;
      summary.totalInputTokens += turn.usage?.inputTokens ?? 0;
      summary.totalCacheReadTokens += turn.usage?.cacheReadTokens ?? 0;
      if (typeof turn.cacheReadRatio === "number") {
        ratioSum += turn.cacheReadRatio;
        ratioN++;
      }
    }
  }
  summary.avgCacheReadRatio = ratioN > 0 ? Math.round((ratioSum / ratioN) * 1000) / 1000 : null;
  summary.diagnostics = [...diagBySig.values()].sort((a, b) => b.count - a.count).slice(0, 20);
  durations.sort((a, b) => a - b);
  summary.medianDurationMs = durations.length >= 5 ? durations[durations.length >> 1] : null;
  return summary;
}
