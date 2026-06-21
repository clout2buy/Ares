// conductor.ts — the deterministic FleetSpec orchestration runtime.
//
// THE GAP THIS FILLS: Task fan-out is MODEL-driven (adjacent parallel-safe Task
// calls batch) — the topology lives in the model's turn choices, so a weak model
// can stop early, skip a phase, or mis-thread a result. The Conductor instead
// takes ONE flat FleetSpec the model emits and executes it start-to-finish in
// deterministic TypeScript: capped fan-out, typed pipeline hand-off, budget
// abort, schema-validated leaf outputs — on ANY provider.
//
// Provider-agnostic BY CONSTRUCTION: every leaf re-enters the ONE QueryEngine
// loop via runForkedTurn, inheriting the parent's provider/model. This module
// never names a provider and never assumes Anthropic JSON-mode/tool-choice.
//
// This file is intentionally ZOD-FREE (@ares/core has no zod dep). Schema
// enforcement is delegated to a pluggable `LeafValidator` the @ares/tools layer
// derives from a shape-example object. Orchestration runs over an INJECTED
// runAgent fn (defaults to runForkedTurn) so the whole runtime is unit-testable
// with a mock runner — no live provider required.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { PermissionPromptDecision, TurnEndStatus, TurnEvent, Usage } from "@ares/protocol";
import { runForkedTurn } from "./forkedTurn.js";
import type { EngineTool, Provider, ToolPermissionRequest } from "./queryEngine.js";
import { extractFirstJson } from "./sideQuery.js";

// ─── Hard ceilings (defence against an adversarial/weak-model spec) ────────

/** Max agents in a single phase. */
export const MAX_AGENTS_PER_PHASE = 32;
/** Max agents summed across the whole fleet. */
export const MAX_AGENTS_PER_FLEET = 64;
/** Max in-flight forks, regardless of the spec's `concurrency`. */
export const MAX_CONCURRENCY = 8;
/** Tool names a fleet child may NEVER be scoped — blocks recursive fleets. */
export const FORBIDDEN_CHILD_TOOLS = new Set(["Conductor", "Task", "Operator"]);

/** Non-read-only tools that are nonetheless SAFE for an unattended leaf: pure
 *  research/inspection that reads the world but has no outward effect. Without
 *  this, the read-only-only strip silently removed WebFetch/WebSearch from
 *  research leaves — the real-world cause of a research fleet returning all
 *  failures ("WebFetch is getting stripped"). (W2 revamp) */
export const SAFE_RESEARCH_TOOLS = new Set(["WebFetch", "WebSearch", "ImageSearch", "CodebaseSearch", "LSP"]);

// ─── Public spec types (what the model authors; the tool layer validates) ──

/** One leaf agent: a single bounded fork. `tools` is a name whitelist filtered
 *  against the parent catalog; `schema` forces a validated JSON leaf output. */
export interface FleetAgentSpec {
  /** Short role label shown in the HUD and journal (e.g. "security-angle"). */
  role: string;
  /** Self-contained instructions. The child sees NONE of the parent context.
   *  May contain {{field}} templates resolved from the prior pipeline stage. */
  prompt: string;
  /** Tool-name whitelist. Undefined → the full parent catalog. */
  tools?: readonly string[];
  /** Shape-example object. When present, the leaf output is parsed+validated to
   *  match it (reprompt + coercion on mismatch). Resolved by the LeafValidator. */
  schema?: Record<string, unknown>;
  /** Per-leaf turn ceiling. Defaults to deps.defaultMaxTurns. */
  maxTurns?: number;
  /** Per-leaf model override — e.g. cheap leaves + a strong judge. Omit to
   *  inherit the fleet model. (Provider is host runtime, never model-authored.) */
  model?: string;
}

export type FleetReduce = "concat" | "first" | "judge";

export interface FleetPhaseSpec {
  /** Stable id used for {{phaseId.index.field}} templates and journaling. */
  id: string;
  kind: "parallel" | "pipeline";
  agents: FleetAgentSpec[];
  /** parallel only: how N leaf outputs collapse into the phase result.
   *  "judge" runs ONE extra synthesis fork seeded with every sibling output —
   *  the difference between a review/options PANEL and a raw dump of N opinions. */
  reduce?: FleetReduce;
  /** "judge" only: how the synthesis fork should weigh the candidates. */
  judgeInstruction?: string;
}

export interface FleetSpec {
  /** Optional human label for the fleet. */
  goal?: string;
  phases: FleetPhaseSpec[];
  /** Max in-flight forks across a parallel phase. Default 3; go lower for local.
   *  Hard-clamped to [1, MAX_CONCURRENCY]. */
  concurrency?: number;
  /** Hard ceiling on summed (input+output) tokens across ALL forks. When omitted
   *  the runtime DERIVES a ceiling from the fleet size (never truly unbounded —
   *  an unattended fleet must always have a backstop). The runtime stops ADMITTING
   *  new forks once the running total is at/over this ceiling (pre-flight gate),
   *  so the overshoot is bounded by the work already in flight rather than by
   *  `concurrency × maxTurns`. */
  maxTotalTokens?: number;
  /** Wall-clock backstop in ms. When omitted the runtime derives one from the
   *  fleet size. Independent of the token budget: catches a wedged/hung fork that
   *  never returns usage (so the token ledger never trips) — the watchdog is off
   *  for fleets, so without this a hung await would run forever. */
  maxWallClockMs?: number;
  /** Resume a prior fleet by id: COMPLETED leaves (matched by phase id + index)
   *  are reused from disk and not re-run; only failed/aborted/missing leaves fork
   *  again. Makes a budget-abort or crash on leaf 60-of-64 non-catastrophic. */
  resumeFleetId?: string;
}

// ─── Result types ──────────────────────────────────────────────────────────

export interface LeafResult {
  agentId: string;
  role: string;
  phaseId: string;
  status: TurnEndStatus; // raw fork status — 'completed' | 'interrupted' | 'failed'
  /** Raw last-assistant text. */
  text: string;
  /** Validated structured payload when a schema was supplied AND it passed. */
  structured?: unknown;
  /** Did the leaf satisfy its schema? Always true when no schema was required. */
  schemaValid: boolean;
  usage: Usage;
  toolCallCount: number;
  /** Count of {{template}} refs in this leaf's prompt that did NOT resolve —
   *  a non-zero value means an upstream hand-off silently broke (finding #6). */
  unresolvedTemplates: number;
  /** Tools requested by the spec but stripped before the fork ran (e.g. a
   *  human-gated write tool removed under the unattended posture). The leaf would
   *  otherwise deny-loop on them (finding #8). */
  strippedTools: string[];
  /** Per-leaf transcript path under .ares/agents/<id>/, or '' if not (yet) written. */
  transcriptPath: string;
  /** True when this leaf was admitted-as-completed without real work because the
   *  fleet was over its soft budget — a graceful degrade, never an abort (W2). */
  degraded?: boolean;
}

export interface PhaseResult {
  id: string;
  kind: FleetPhaseSpec["kind"];
  leaves: LeafResult[];
  /** The reduced text handed to the next phase / returned to the model. */
  reduced: string;
  /** For pipeline phases: the last stage's validated structured output, if any. */
  structured?: unknown;
  /** Total unresolved {{template}} refs across the phase's leaves (finding #6). */
  unresolvedTemplates: number;
  /** A pipeline phase that fails its schema barrier is marked failed and its
   *  remaining stages are skipped (finding #5). */
  status: "completed" | "failed" | "aborted";
  /** Human-readable reason when status !== 'completed'. */
  failureReason?: string;
}

export interface FleetResult {
  fleetId: string;
  phases: PhaseResult[];
  /** Final answer: the last phase's reduced text. */
  summary: string;
  usage: Usage;
  status: "completed" | "aborted" | "failed";
  /** True if the run tripped the token budget (independent of `status` — a fleet
   *  can finish every phase and still be over budget; finding #9). */
  budgetExceeded: boolean;
  manifestPath: string;
}

// ─── Validation seam (kept zod-free in core) ───────────────────────────────

export interface ValidatorResult {
  ok: boolean;
  value?: unknown;
  /** Human-readable issues used to seed a reprompt fork. */
  issues?: string;
}

/** Validates an already-parsed JSON value against the agent's shape-example.
 *  The tools layer implements this with zod; tests pass a trivial one. */
export type LeafValidator = (
  schema: Record<string, unknown>,
  parsed: unknown,
) => ValidatorResult;

/** Renders a shape-example into a compact prompt hint the weak child can follow. */
export type SchemaHinter = (schema: Record<string, unknown>) => string;

// ─── Injected agent runner (so the runtime is testable) ────────────────────

export interface RunAgentArgs {
  role: string;
  prompt: string;
  tools: readonly EngineTool[];
  maxTurns: number;
  signal: AbortSignal;
  /** Live child-event hook for HUD re-emission. */
  onEvent?: (event: TurnEvent) => void;
  /** Optional per-leaf provider override (defaults to deps.provider). */
  provider?: Provider;
  /** Optional per-leaf model override (defaults to deps.model). */
  model?: string;
}

export interface RunAgentResult {
  finalText: string;
  events: TurnEvent[];
  usage: Usage;
  status: TurnEndStatus;
}

/** The one primitive the runtime spawns a child through. Defaults to a
 *  runForkedTurn adapter; tests inject a mock. */
export type RunAgentFn = (args: RunAgentArgs) => Promise<RunAgentResult>;

// ─── Dependencies the host supplies (mirrors SubagentRunnerOptions) ────────

export interface ConductorDeps {
  provider: Provider;
  model: string;
  parentTools: readonly EngineTool[];
  baseSystemPrompt: string;
  workspace: string;
  /** Parent abort signal — forwarded into EVERY fork; aborting it cancels all. */
  signal: AbortSignal;
  /** HUD progress sink (the tool forwards ctx.emitProgress here). */
  emitProgress?: (data: unknown) => void;
  /** Optional cheap-model coercion for the last-ditch structured-output step. */
  subModel?: { summarize(req: { input: string; instructions?: string }): Promise<string> };
  defaultMaxTurns?: number;
  /** Reprompt attempts on a schema miss before falling back to coercion. */
  schemaRetries?: number;
  validate: LeafValidator;
  schemaHint: SchemaHinter;
  /** Unattended posture: by default the runtime strips any tool that is NOT
   *  read-only from a leaf's scoped catalog, because nobody is present to approve
   *  a human-gated/destructive call and the leaf would burn all its turns hitting
   *  a permission-deny (finding #8). Set true ONLY when the host has arranged a
   *  non-interactive auto-approve for writers (and accepts parallel writers share
   *  one workspace). */
  allowWriteTools?: boolean;
  /** Test seam: override the spawn primitive. Defaults to a runForkedTurn adapter. */
  runAgent?: RunAgentFn;
  /** Internal: completed leaves reused on resume, keyed `${phaseId}#${index}`.
   *  Populated by runFleet from spec.resumeFleetId; never set by callers. */
  resume?: ReadonlyMap<string, LeafResult>;
  /** Soft-budget multiplier: a fleet keeps ADMITTING leaves until the running
   *  total reaches budget * this. Past the soft budget, further leaves are marked
   *  degraded+completed (skipped, zero tokens) — peers are never aborted. The hard
   *  ceiling is still the wall-clock. Defaults to 4. (W2) */
  budgetOvershootGrace?: number;
}

// ─── Small async semaphore (caps in-flight forks) ──────────────────────────
//
// HAND-OFF semaphore: the cap is enforced by construction, not by arrival
// timing. `active` is incremented exactly once on the fast path. On release,
// if a waiter is queued the slot is HANDED to it directly (active is NOT
// decremented and the waiter does NOT re-increment) — so there is never a window
// where a fast-path caller observes a transiently-low `active` and over-admits
// (the old bug: the slow path unconditionally did `active++` after being woken,
// and the cap check only ran on the fast path).

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.makeRelease();
    }
    // Wait for a slot to be HANDED to us. The releaser keeps the count steady
    // (it does not decrement when handing off), so we must not increment here.
    await new Promise<void>((resolve) => this.queue.push(resolve));
    return this.makeRelease();
  }
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent — double-release can't free a phantom slot
      released = true;
      this.release();
    };
  }
  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand our slot straight to the next waiter: count stays at `active`.
      next();
    } else {
      this.active--;
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    modelCalls: (a.modelCalls ?? 0) + (b.modelCalls ?? 0),
  };
}

function totalTokens(u: Usage): number {
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
}

/** True when a non-zero budget has been reached/breached by the running total. */
function budgetSpent(ledger: { usage: Usage }, budget: number): boolean {
  return budget > 0 && totalTokens(ledger.usage) >= budget;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Resolve {{field}} / {{phaseId.index.field}} templates against a context object
 *  IN-HOST so the weak child only ever sees fully-resolved text. Unknown refs are
 *  left verbatim (never throw a fleet over a typo) BUT counted — a non-zero
 *  `unresolved` tells the caller a hand-off silently broke (finding #6). */
export function resolveTemplates(
  text: string,
  ctx: Record<string, unknown>,
): { text: string; unresolved: number } {
  let unresolved = 0;
  const out = text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr: string) => {
    const segs = String(expr).split(".").map((s) => s.trim()).filter(Boolean);
    let cur: unknown = ctx;
    for (const seg of segs) {
      if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[seg];
      } else {
        unresolved++;
        return whole; // leave unresolved refs untouched
      }
    }
    if (cur == null) {
      unresolved++;
      return whole;
    }
    return typeof cur === "string" ? cur : JSON.stringify(cur);
  });
  return { text: out, unresolved };
}

/** Validate the spec structurally and against the parent catalog. Throws loudly
 *  on a typo (a silently-dropped whitelisted tool is worse than a hard error the
 *  model can correct) AND on adversarial spec sizes (finding #7) / a child that
 *  would re-open recursive fleets (finding from the "correct" section). */
export function validateSpec(spec: FleetSpec, parentTools: readonly EngineTool[]): void {
  const known = new Set(parentTools.map((t) => t.schema.name));
  if (!Array.isArray(spec.phases) || spec.phases.length === 0) {
    throw new Error("FleetSpec.phases must be a non-empty array.");
  }
  const seenPhaseIds = new Set<string>();
  let totalAgents = 0;
  for (const phase of spec.phases) {
    if (!phase.id) throw new Error("every phase needs an id.");
    if (seenPhaseIds.has(phase.id)) throw new Error(`duplicate phase id: ${phase.id}`);
    seenPhaseIds.add(phase.id);
    if (!Array.isArray(phase.agents) || phase.agents.length === 0) {
      throw new Error(`phase '${phase.id}' has no agents.`);
    }
    if (phase.agents.length > MAX_AGENTS_PER_PHASE) {
      throw new Error(
        `phase '${phase.id}' has ${phase.agents.length} agents; the per-phase cap is ${MAX_AGENTS_PER_PHASE}.`,
      );
    }
    totalAgents += phase.agents.length;
    if (phase.kind !== "parallel" && phase.kind !== "pipeline") {
      throw new Error(`phase '${phase.id}' kind must be 'parallel' or 'pipeline'.`);
    }
    for (const agent of phase.agents) {
      // An empty/primitive schema-example silently disables enforcement AND the
      // fail-closed pipeline barrier (matchShape over no keys = always valid).
      // Reject loudly so the model fixes the spec instead of feeding garbage on.
      if (agent.schema !== undefined) {
        const s = agent.schema as unknown;
        const isPlainObject = typeof s === "object" && s !== null && !Array.isArray(s);
        if (!isPlainObject || Object.keys(s as Record<string, unknown>).length === 0) {
          throw new Error(
            `phase '${phase.id}' agent '${agent.role}' has an invalid 'schema': it must be a ` +
              `NON-EMPTY shape-example object whose values illustrate the types, e.g. ` +
              `{"summary":"...","score":0}. An empty object or a primitive silently disables ` +
              `schema enforcement. Drop 'schema' for a free-text leaf, or give a real shape.`,
          );
        }
      }
      for (const name of agent.tools ?? []) {
        if (FORBIDDEN_CHILD_TOOLS.has(name)) {
          throw new Error(
            `phase '${phase.id}' agent '${agent.role}' whitelists '${name}', which would let a ` +
              `fleet child spawn another fleet/subagent. Orchestration tools cannot be delegated.`,
          );
        }
        if (!known.has(name)) {
          throw new Error(
            `phase '${phase.id}' agent '${agent.role}' whitelists unknown tool '${name}'. ` +
              `Known: ${[...known].join(", ")}`,
          );
        }
      }
    }
  }
  if (totalAgents > MAX_AGENTS_PER_FLEET) {
    throw new Error(
      `fleet has ${totalAgents} agents across ${spec.phases.length} phases; the per-fleet cap is ${MAX_AGENTS_PER_FLEET}.`,
    );
  }
}

// ─── The runForkedTurn adapter (the real spawn primitive) ──────────────────

function defaultRunAgent(deps: ConductorDeps): RunAgentFn {
  // Unattended permission posture: hard-deny anything that would need a human
  // mid-fleet (payments/credentials/destructive). Mirrors the operator
  // dispatcher — nobody is there to approve. NOTE: the runtime also strips
  // non-read-only tools from the scoped catalog up-front (scopeTools) so a leaf
  // never burns turns deny-looping on a tool it can't use (finding #8); this
  // hard-deny is the belt-and-braces backstop.
  const requestPermission = async (
    _req: ToolPermissionRequest,
  ): Promise<PermissionPromptDecision> => "deny";

  return async (args: RunAgentArgs): Promise<RunAgentResult> => {
    const systemPrompt =
      `You are the '${args.role}' agent in a deterministic fleet. Complete ONLY your assigned task, ` +
      `then stop. Be concise.\n\n---\n\n${deps.baseSystemPrompt}`;
    const result = await runForkedTurn({
      config: {
        provider: args.provider ?? deps.provider,
        model: args.model ?? deps.model,
        systemPrompt,
        tools: args.tools,
        workspace: deps.workspace,
        signal: args.signal,
        maxTurns: args.maxTurns,
        requestPermission,
      },
      sessionId: newId("agent"),
      seed: { kind: "work-item", text: args.prompt },
      onEvent: args.onEvent,
    });
    return {
      finalText: result.finalText,
      events: result.events,
      usage: result.usage,
      status: result.status,
    };
  };
}

// ─── Structured-output forcing (parse → validate → reprompt → coerce) ──────
//
// MVP ships only the weak-model-safe FALLBACK path: extractFirstJson over the
// leaf's finalText, validate against the shape-example, bounded reprompt
// re-forks, then a null-guarded subModel coercion. Returns { value, valid } —
// never throws into the fleet.
//
// WEAK-MODEL HARDENING (finding #4): the reprompt re-fork carries the ORIGINAL
// task context (the leaf's resolved prompt + its own prior reply), not just a
// bare "reply with JSON" instruction. Stripping context made a weak model
// fabricate type-correct-but-empty JSON; re-anchoring it on what it was actually
// computing keeps the reformatted answer tied to real work. Each re-fork is also
// budget-gated so a schema-heavy phase cannot multiply spend past the ceiling.

async function forceStructured(
  schema: Record<string, unknown>,
  firstText: string,
  originalPrompt: string,
  reFork: (instruction: string) => Promise<{ text: string; usage: Usage; events: TurnEvent[] }>,
  deps: ConductorDeps,
  ledger: { usage: Usage },
  budget: number,
): Promise<{ value: unknown; valid: boolean }> {
  const hint = deps.schemaHint(schema);
  const tryParse = (text: string): ValidatorResult => {
    const extracted = extractFirstJson(text);
    if (!extracted.ok) return { ok: false, issues: "no JSON object found in the reply" };
    return deps.validate(schema, extracted.value);
  };

  let verdict = tryParse(firstText);
  if (verdict.ok) return { value: verdict.value, valid: true };

  const retries = Math.max(0, deps.schemaRetries ?? 2);
  for (let attempt = 0; attempt < retries; attempt++) {
    if (deps.signal.aborted) break;
    // Do NOT spend another fork if we've already hit the budget — the reprompt is
    // billed to the same ledger and must respect the ceiling (finding #3 + #4).
    if (budgetSpent(ledger, budget)) break;
    const instruction =
      `Your task was:\n${originalPrompt}\n\n` +
      `Your previous reply (below) did not match the required output shape.\n` +
      `--- previous reply ---\n${firstText}\n--- end ---\n\n` +
      `Issues: ${verdict.issues ?? "invalid"}\n` +
      `Re-express the SAME answer as ONLY a JSON object (no prose, no code fence) ` +
      `matching this shape — keep your real values, only fix the format:\n${hint}`;
    const re = await reFork(instruction);
    ledger.usage = addUsage(ledger.usage, re.usage);
    verdict = tryParse(re.text);
    if (verdict.ok) return { value: verdict.value, valid: true };
    firstText = re.text;
  }

  // Last-ditch: route the prose through the cheap sub-model (provider-agnostic,
  // null-guarded — some providers have no subModel). Skipped once over budget.
  if (deps.subModel && !budgetSpent(ledger, budget)) {
    try {
      const coerced = await deps.subModel.summarize({
        input: firstText,
        instructions: `Extract a JSON object matching this shape and output JSON ONLY:\n${hint}`,
      });
      const v = tryParse(coerced);
      if (v.ok) return { value: v.value, valid: true };
    } catch {
      // coercion is best-effort; fall through to invalid.
    }
  }

  return { value: firstText, valid: false };
}

// ─── Leaf execution ────────────────────────────────────────────────────────

/** Scope the parent catalog to the agent's whitelist, then (unless the host
 *  opted into write tools) drop everything that is NOT read-only — so an
 *  unattended leaf can't deny-loop on a human-gated tool (finding #8). Returns
 *  the surviving tools plus the names that were stripped, for the journal/HUD. */
function scopeTools(
  parentTools: readonly EngineTool[],
  whitelist: readonly string[] | undefined,
  allowWriteTools: boolean,
): { tools: readonly EngineTool[]; stripped: string[] } {
  const stripped: string[] = [];
  // 1) Whitelist filter (undefined -> full catalog).
  const whitelisted = whitelist
    ? parentTools.filter((t) => whitelist.includes(t.schema.name))
    : parentTools;
  // 2) CATALOG-LEVEL recursion guard (finding #1): NEVER let an orchestration
  //    tool reach a leaf, even when `tools` is omitted (full-catalog inheritance)
  //    or the host forgot to exclude it from parentTools. validateSpec's explicit
  //    whitelist reject is the loud first gate; this is the silent-default backstop.
  const base = whitelisted.filter((t) => {
    if (FORBIDDEN_CHILD_TOOLS.has(t.schema.name)) {
      stripped.push(t.schema.name);
      return false;
    }
    return true;
  });
  if (allowWriteTools) return { tools: base, stripped };
  // 3) Unattended posture: drop everything that is NOT read-only.
  const tools: EngineTool[] = [];
  for (const t of base) {
    if (t.schema.safety === "read-only" || SAFE_RESEARCH_TOOLS.has(t.schema.name)) tools.push(t);
    else stripped.push(t.schema.name);
  }
  return { tools, stripped };
}

async function runLeaf(
  agent: FleetAgentSpec,
  phaseId: string,
  resolvedPrompt: string,
  unresolvedTemplates: number,
  deps: ConductorDeps,
  run: RunAgentFn,
  ledger: { usage: Usage },
  budget: number,
): Promise<LeafResult> {
  const agentId = newId("agent");
  const { tools, stripped } = scopeTools(deps.parentTools, agent.tools, deps.allowWriteTools ?? false);
  const maxTurns = agent.maxTurns ?? deps.defaultMaxTurns ?? 12;
  const collected: TurnEvent[] = [];

  const onEvent = (ev: TurnEvent) => {
    collected.push(ev);
    if (ev.type === "tool_start") {
      // Zero-protocol-change HUD surfacing — rides the existing tool_progress
      // transport AresSubagentRunner already uses.
      deps.emitProgress?.({
        kind: "fleet_activity",
        event: "tool",
        agentId,
        role: agent.role,
        phase: phaseId,
        tool: (ev as { name?: string }).name,
        activity: (ev as { activityDescription?: string }).activityDescription,
      });
    }
  };

  // Leaf lifecycle for the desktop fleet board: a "start" so the agent appears
  // the moment it's admitted, then per-tool ticks, then "done" with its status.
  deps.emitProgress?.({ kind: "fleet_activity", event: "start", agentId, role: agent.role, phase: phaseId });

  const first = await run({
    role: agent.role,
    prompt: resolvedPrompt,
    tools,
    maxTurns,
    signal: deps.signal,
    onEvent,
    model: agent.model,
  });
  deps.emitProgress?.({ kind: "fleet_activity", event: "done", agentId, role: agent.role, phase: phaseId, status: first.status });
  ledger.usage = addUsage(ledger.usage, first.usage);

  let structured: unknown;
  let schemaValid = true;
  if (agent.schema) {
    const reFork = async (instruction: string) => {
      const r = await run({
        role: agent.role,
        prompt: instruction,
        tools,
        maxTurns: 1,
        signal: deps.signal,
        onEvent,
        model: agent.model,
      });
      return { text: r.finalText, usage: r.usage, events: r.events };
    };
    const forced = await forceStructured(
      agent.schema,
      first.finalText,
      resolvedPrompt,
      reFork,
      deps,
      ledger,
      budget,
    );
    structured = forced.value;
    schemaValid = forced.valid;
  }

  const toolCallCount = collected.filter((e) => e.type === "tool_start").length;
  const transcriptPath = path.join(deps.workspace, ".ares", "agents", agentId, "transcript.jsonl");
  // Fire-and-forget (finding #10) — does NOT hold the concurrency slot. Writes the
  // transcript the manifest will reference so the path is never dangling.
  void writeTranscript(transcriptPath, collected, first.finalText);

  return {
    agentId,
    role: agent.role,
    phaseId,
    status: first.status,
    text: first.finalText,
    structured,
    schemaValid,
    usage: first.usage,
    toolCallCount,
    unresolvedTemplates,
    strippedTools: stripped,
    transcriptPath,
  };
}

// ─── Phase execution ───────────────────────────────────────────────────────

async function runParallelPhase(
  phase: FleetPhaseSpec,
  pipelineCtx: Record<string, unknown>,
  deps: ConductorDeps,
  run: RunAgentFn,
  ledger: { usage: Usage },
  concurrency: number,
  controller: AbortController,
  budget: number,
): Promise<PhaseResult> {
  const sem = new Semaphore(Math.max(1, Math.min(concurrency, MAX_CONCURRENCY)));
  const journalTasks: Array<Promise<void>> = [];
  // Count leaves the pre-flight gate actually SKIPPED, so the phase is only
  // reported 'aborted' when real work was cut — not merely because the budget
  // latched after the last leaf finished (finding #9). A phase whose every leaf
  // ran is 'completed' even if the running total is now over the ceiling.
  let skipped = 0;
  // Soft budget (W2): keep ADMITTING leaves until the running total reaches
  // budget*grace; past that, degrade-skip (completed, zero tokens) rather than
  // abort peers. A reasoner fleet is no longer guillotined at 1/N done — the only
  // hard stops are the wall-clock and a parent interrupt.
  const grace = deps.budgetOvershootGrace ?? 4;
  const hardStop = budget > 0 ? budget * grace : 0;
  const admitBlocked = () => hardStop > 0 && totalTokens(ledger.usage) >= hardStop;
  // Promise.allSettled so one failed/interrupted leaf never rejects the phase —
  // we inspect each result.status, never rely on try/catch around the batch.
  const settled = await Promise.allSettled(
    phase.agents.map(async (agent, i) => {
      // RESUME: a completed leaf from a prior fleet is reused verbatim — no slot,
      // no fork, no fresh tokens. Only failed/missing leaves fall through to run.
      const resumed = deps.resume?.get(`${phase.id}#${i}`);
      if (resumed && resumed.role === agent.role) {
        deps.emitProgress?.({ kind: "fleet_activity", event: "resumed", agentId: resumed.agentId, role: agent.role, phase: phase.id, status: "completed" });
        return resumedLeaf(resumed);
      }
      const release = await sem.acquire();
      try {
        // PRE-FLIGHT gate (findings #2 + #3): refuse to START a fork once the
        // controller is aborted OR the budget is already spent. This is what
        // makes the budget a real ceiling — the overshoot is bounded by work
        // already in flight, not by concurrency × maxTurns, because no NEW leaf
        // is admitted after the running total reaches the cap.
        if (controller.signal.aborted) {
          skipped++;
          return invalidLeaf(agent, phase.id, "(aborted before start)", 0);
        }
        if (admitBlocked()) {
          // Soft-budget skip: degrade (completed), do NOT abort peers or the fleet.
          return invalidLeaf(agent, phase.id, "(skipped: over soft budget)", 0, true);
        }
        const { text: prompt, unresolved } = resolveTemplates(agent.prompt, pipelineCtx);
        const leaf = await runLeaf(agent, phase.id, prompt, unresolved, deps, run, ledger, budget);
        return leaf;
      } finally {
        // Release the slot BEFORE journaling so a slow .ares write never gates
        // the next queued fork (finding #10).
        release();
      }
    }),
  );

  const leaves: LeafResult[] = settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : invalidLeaf(phase.agents[i], phase.id, String(s.reason), 0),
  );
  // Fire-and-forget the per-leaf transcripts (off the critical path).
  for (const leaf of leaves) {
    if (leaf.status !== "failed" || leaf.text) journalTasks.push(journalLeaf(deps.workspace, leaf));
  }
  await Promise.allSettled(journalTasks);

  const mode = phase.reduce ?? "concat";
  let reduced: string;
  let structured: unknown;
  if (mode === "judge") {
    const j = await judgeReduce(phase, leaves, deps, run, ledger, budget);
    reduced = j.reduced;
    structured = j.structured;
  } else {
    reduced = reduceLeaves(leaves, mode);
  }
  const unresolvedTemplates = leaves.reduce((n, l) => n + l.unresolvedTemplates, 0);
  const anyCompleted = leaves.some((l) => l.status === "completed");
  const phaseStatus: PhaseResult["status"] = skipped > 0 ? "aborted" : anyCompleted ? "completed" : "failed";
  return {
    id: phase.id,
    kind: "parallel",
    leaves,
    reduced,
    structured,
    unresolvedTemplates,
    status: phaseStatus,
    failureReason:
      phaseStatus === "failed"
        ? "every leaf in this parallel phase failed; its reduced text is error output, not a result."
        : undefined,
  };
}

async function runPipelinePhase(
  phase: FleetPhaseSpec,
  pipelineCtx: Record<string, unknown>,
  deps: ConductorDeps,
  run: RunAgentFn,
  ledger: { usage: Usage },
  controller: AbortController,
  budget: number,
): Promise<PhaseResult> {
  const leaves: LeafResult[] = [];
  const journalTasks: Array<Promise<void>> = [];
  // Stage K is seeded with stage K-1's VALIDATED structured output (not the raw
  // transcript), exposed to templates as {{prev}} plus {{prev.field}}.
  let prevStructured: unknown;
  let prevText = "";
  let status: PhaseResult["status"] = "completed";
  let failureReason: string | undefined;
  // Soft budget (W2): degrade-skip a stage past budget*grace instead of aborting.
  const grace = deps.budgetOvershootGrace ?? 4;
  const hardStop = budget > 0 ? budget * grace : 0;
  const admitBlocked = () => hardStop > 0 && totalTokens(ledger.usage) >= hardStop;

  for (let idx = 0; idx < phase.agents.length; idx++) {
    const agent = phase.agents[idx];
    // RESUME: a completed stage from a prior fleet is reused and its validated
    // output feeds the next stage — free, so it runs regardless of budget/abort.
    const resumed = deps.resume?.get(`${phase.id}#${idx}`);
    if (resumed && resumed.role === agent.role) {
      const leaf = resumedLeaf(resumed);
      leaves.push(leaf);
      prevStructured = leaf.structured;
      prevText = leaf.text;
      deps.emitProgress?.({ kind: "fleet_activity", event: "resumed", agentId: leaf.agentId, role: agent.role, phase: phase.id, status: "completed" });
      continue;
    }
    if (controller.signal.aborted) {
      leaves.push(invalidLeaf(agent, phase.id, "(aborted)", 0));
      status = "aborted";
      continue;
    }
    // Soft-budget gate (W2): past budget*grace, degrade-skip this stage rather
    // than abort the pipeline. It's recorded completed-but-degraded; the barrier
    // is skipped for it, and downstream stages still proceed seeded from the last
    // stage that really ran. Only the wall-clock / parent interrupt hard-stop.
    if (admitBlocked()) {
      leaves.push(invalidLeaf(agent, phase.id, "(skipped: over soft budget)", 0, true));
      continue;
    }
    const localCtx: Record<string, unknown> = {
      ...pipelineCtx,
      prev: prevStructured ?? prevText,
      prevText,
    };
    const { text: prompt, unresolved } = resolveTemplates(agent.prompt, localCtx);
    const leaf = await runLeaf(agent, phase.id, prompt, unresolved, deps, run, ledger, budget);
    leaves.push(leaf);
    journalTasks.push(journalLeaf(deps.workspace, leaf));

    // BARRIER (finding #5 + #6): a stage that declared a schema and failed it
    // produced raw, unvalidated prose — seeding it into {{prev.field}} downstream
    // silently corrupts the rest of the pipeline. Fail closed instead of marching
    // forward. Likewise, if THIS stage's prompt had unresolved {{prev.x}} refs the
    // upstream hand-off already broke — stop rather than prompt the next stage with
    // literal mustache tokens.
    if (agent.schema && !leaf.schemaValid) {
      status = "failed";
      failureReason = `stage '${agent.role}' failed its schema; downstream stages cannot consume its output.`;
      break;
    }
    if (leaf.unresolvedTemplates > 0) {
      status = "failed";
      failureReason =
        `stage '${agent.role}' had ${leaf.unresolvedTemplates} unresolved {{template}} ref(s); ` +
        `the prior stage's hand-off did not provide the referenced field(s).`;
      break;
    }

    prevStructured = leaf.schemaValid ? (leaf.structured ?? leaf.text) : leaf.text;
    prevText = leaf.text;
    // No hard budget latch here (W2): soft-budget skipping is handled by the
    // admit gate at the top of the loop; a finished stage never aborts the rest.
  }

  await Promise.allSettled(journalTasks);

  // Reduced/structured come from the LAST stage that actually ran (a barrier-
  // failed stage's output is not promoted as the phase result).
  const completed = leaves.filter((l) => l.status === "completed");
  const last = (status === "failed" ? leaves[leaves.length - 1] : completed[completed.length - 1]) ?? leaves[leaves.length - 1];
  const unresolvedTemplates = leaves.reduce((n, l) => n + l.unresolvedTemplates, 0);
  return {
    id: phase.id,
    kind: "pipeline",
    leaves,
    reduced: status === "failed" ? (failureReason ?? "") : (last?.text ?? ""),
    structured: status === "failed" ? undefined : last?.structured,
    unresolvedTemplates,
    status,
    failureReason,
  };
}

function reduceLeaves(leaves: LeafResult[], reduce: FleetReduce): string {
  const ok = leaves.filter((l) => l.status === "completed");
  const pool = ok.length > 0 ? ok : leaves;
  if (reduce === "first") return pool[0]?.text ?? "";
  // "judge" collapses to concat for the synchronous fallback; the real judge is
  // an extra fork run by judgeReduce (only the async phase path can spawn it).
  return pool
    .map((l) => `### ${l.role}${l.schemaValid ? "" : " (schema-invalid)"}\n${l.text}`)
    .join("\n\n");
}

/** "judge" reduce: one extra synthesis fork seeded with every sibling output.
 *  Falls back to concat when the budget is spent / fleet aborted (never spawns a
 *  fork it can't afford), so a panel degrades gracefully instead of failing. */
async function judgeReduce(
  phase: FleetPhaseSpec,
  leaves: LeafResult[],
  deps: ConductorDeps,
  run: RunAgentFn,
  ledger: { usage: Usage },
  budget: number,
): Promise<{ reduced: string; structured?: unknown }> {
  const fallback = reduceLeaves(leaves, "concat");
  if (deps.signal.aborted || budgetSpent(ledger, budget)) return { reduced: fallback };
  const pool = leaves.filter((l) => l.status === "completed");
  if (pool.length === 0) return { reduced: fallback };
  if (pool.length === 1) return { reduced: pool[0].text }; // nothing to judge
  const corpus = pool
    .map((l, i) => `### Candidate ${i + 1} — ${l.role}\n${l.text}`)
    .join("\n\n");
  const instruction =
    phase.judgeInstruction ??
    "Synthesize the candidate outputs below into ONE strongest result. Weigh them against each " +
      "other, resolve contradictions, keep the best of each, and discard the weak. Output only the " +
      "synthesized result — not a meta-commentary about the candidates.";
  try {
    const r = await run({
      role: `${phase.id}-judge`,
      prompt: `${instruction}\n\n${corpus}`,
      tools: [],
      maxTurns: 2,
      signal: deps.signal,
      onEvent: () => {},
    });
    ledger.usage = addUsage(ledger.usage, r.usage);
    return { reduced: r.finalText || fallback };
  } catch {
    return { reduced: fallback };
  }
}

/** Build a LeafResult from a reused (resumed) leaf — no fork, no fresh usage. */
function resumedLeaf(prior: LeafResult): LeafResult {
  return { ...prior, usage: { inputTokens: 0, outputTokens: 0 }, toolCallCount: 0 };
}

/** Per-leaf transcript — the manifest references <id>/transcript.jsonl, so it must
 *  actually exist (a dangling path is worse than none). Best-effort, off the hot
 *  path: every collected child event + the final text, one JSON object per line. */
async function writeTranscript(transcriptPath: string, events: TurnEvent[], finalText: string): Promise<void> {
  if (!transcriptPath) return;
  try {
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    const lines = events.map((e) => JSON.stringify(e));
    lines.push(JSON.stringify({ type: "final_text", text: finalText }));
    await writeFile(transcriptPath, lines.join("\n") + "\n", "utf8");
  } catch {
    // best-effort — the manifest still records the run even if this write fails
  }
}

/** Load a prior fleet's completed leaves for resume, keyed `${phaseId}#${index}`. */
async function loadResume(workspace: string, fleetId: string): Promise<ReadonlyMap<string, LeafResult>> {
  const map = new Map<string, LeafResult>();
  try {
    const raw = await readFile(path.join(workspace, ".ares", "fleets", fleetId, "leaves.json"), "utf8");
    const arr = JSON.parse(raw) as Array<LeafResult & { index: number }>;
    for (const leaf of arr) {
      if (leaf.status === "completed") map.set(`${leaf.phaseId}#${leaf.index}`, leaf);
    }
  } catch {
    // no prior fleet (or unreadable) → nothing to resume; every leaf runs fresh
  }
  return map;
}

/** Persist every leaf (with its index) so a later resumeFleetId can reuse the
 *  completed ones. Written alongside the manifest, best-effort. */
async function persistLeaves(workspace: string, fleetId: string, phases: PhaseResult[]): Promise<void> {
  const flat: Array<LeafResult & { index: number }> = [];
  for (const phase of phases) phase.leaves.forEach((l, index) => flat.push({ ...l, index }));
  try {
    const dir = path.join(workspace, ".ares", "fleets", fleetId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "leaves.json"), JSON.stringify(flat, null, 2) + "\n", "utf8");
  } catch {
    // best-effort
  }
}

function invalidLeaf(
  agent: FleetAgentSpec,
  phaseId: string,
  reason: string,
  unresolvedTemplates: number,
  degraded = false,
): LeafResult {
  return {
    agentId: newId("agent"),
    role: agent.role,
    phaseId,
    status: degraded ? "completed" : "failed",
    text: reason,
    structured: undefined,
    schemaValid: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    toolCallCount: 0,
    unresolvedTemplates,
    strippedTools: [],
    transcriptPath: "",
    degraded: degraded || undefined,
  };
}

// ─── Journaling (best-effort, mirrors subagents.ts convention) ─────────────
//
// Fire-and-forget: the caller does NOT hold a semaphore slot while these run
// (finding #10). The transcript path stamped on the LeafResult is the intended
// location; if the write fails the manifest still records the run.

async function journalLeaf(_workspace: string, leaf: LeafResult): Promise<void> {
  if (!leaf.transcriptPath) return;
  const dir = path.dirname(leaf.transcriptPath);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          id: leaf.agentId,
          role: leaf.role,
          phase: leaf.phaseId,
          status: leaf.status,
          schemaValid: leaf.schemaValid,
          unresolvedTemplates: leaf.unresolvedTemplates,
          strippedTools: leaf.strippedTools,
          usage: leaf.usage,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  } catch {
    // best-effort
  }
}

async function journalFleet(workspace: string, fleetId: string, result: FleetResult): Promise<string> {
  const dir = path.join(workspace, ".ares", "fleets", fleetId);
  const manifestPath = path.join(dir, "manifest.json");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          fleetId,
          status: result.status,
          budgetExceeded: result.budgetExceeded,
          usage: result.usage,
          phases: result.phases.map((p) => ({
            id: p.id,
            kind: p.kind,
            status: p.status,
            failureReason: p.failureReason,
            unresolvedTemplates: p.unresolvedTemplates,
            agents: p.leaves.map((l) => ({
              id: l.agentId,
              role: l.role,
              status: l.status,
              schemaValid: l.schemaValid,
              unresolvedTemplates: l.unresolvedTemplates,
              strippedTools: l.strippedTools,
              transcriptPath: l.transcriptPath,
            })),
          })),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    return manifestPath;
  } catch {
    return "";
  }
}

// ─── The orchestrator entrypoint ───────────────────────────────────────────

export async function runFleet(spec: FleetSpec, deps: ConductorDeps): Promise<FleetResult> {
  validateSpec(spec, deps.parentTools);

  const fleetId = newId("fleet");
  const run = deps.runAgent ?? defaultRunAgent(deps);
  // Announce the fleet (carries the id the desktop needs to offer "resume").
  deps.emitProgress?.({ kind: "fleet_activity", event: "fleet_start", fleetId });
  // Resume: load the prior fleet's completed leaves so they're reused, not re-run.
  const resume = spec.resumeFleetId
    ? await loadResume(deps.workspace, spec.resumeFleetId)
    : undefined;
  const reqC = Number(spec.concurrency);
  const concurrency = Math.max(
    1,
    Math.min(Number.isFinite(reqC) && reqC > 0 ? Math.floor(reqC) : 6, MAX_CONCURRENCY),
  );
  // Total leaf count drives both derived backstops below.
  const totalAgents = spec.phases.reduce((n, p) => n + p.agents.length, 0);
  const perLeafTurns = deps.defaultMaxTurns ?? 12;
  // An unattended fleet must ALWAYS have a token backstop. If the model omits one,
  // derive a generous-but-finite ceiling from the fleet size (~50k tokens per
  // leaf-turn) so a runaway can't spend without bound; an explicit spec value wins.
  const reqBudget = Number(spec.maxTotalTokens);
  const budget = Number.isFinite(reqBudget) && reqBudget > 0
    ? reqBudget
    : totalAgents * perLeafTurns * 50_000;
  const ledger = { usage: { inputTokens: 0, outputTokens: 0 } as Usage };

  // A shared controller, chained to the parent signal, that the budget guard and
  // any parent interrupt both feed. Every fork already receives deps.signal; the
  // controller lets the budget guard cut the whole fleet without touching the
  // parent's signal.
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (deps.signal.aborted) controller.abort();
  else deps.signal.addEventListener("abort", onParentAbort, { once: true });
  // Wall-clock backstop: the per-tool watchdog is intentionally OFF for fleets
  // (they legitimately run minutes), so a fork that hangs mid-await would never
  // return usage and never trip the token budget. Cap total wall-time — derived
  // from fleet size (2 min/leaf), clamped to [2 min, 30 min], unless the spec sets it.
  const reqWall = Number(spec.maxWallClockMs);
  const wallClockMs = Number.isFinite(reqWall) && reqWall > 0
    ? reqWall
    : Math.min(30 * 60_000, Math.max(2 * 60_000, totalAgents * 2 * 60_000));
  // The deadline races each phase so a leaf wedged in a NON-abortable await can
  // never hang the fleet (finding #3). It resolves ONLY when the wall-clock timer
  // fires — NOT on a budget latch or parent interrupt, which the phase runners
  // handle gracefully (the phase still completes; racing those would mislabel a
  // finished-but-over-budget phase as aborted).
  const ABORT_SENTINEL = Symbol("fleet-abort");
  let fireDeadline: () => void = () => {};
  const deadline = new Promise<typeof ABORT_SENTINEL>((resolve) => {
    fireDeadline = () => resolve(ABORT_SENTINEL);
  });
  // NOT unref'd: the deadline race must be able to fire even in an otherwise-idle
  // loop (that's the whole point — catching a hung fork). The clearTimeout in the
  // finally cancels it the instant the fleet finishes normally, so it never lingers.
  const wallClockTimer = setTimeout(() => {
    fireDeadline();
    controller.abort();
  }, wallClockMs);
  // Forks see the chained signal so the budget abort cascades to in-flight leaves
  // (they cooperatively check the signal at their own await points).
  const fleetDeps: ConductorDeps = { ...deps, signal: controller.signal, resume };

  const phases: PhaseResult[] = [];
  // Cross-phase template context: each completed phase is exposed under its id.
  const pipelineCtx: Record<string, unknown> = {};

  // Track whether work was actually CUT (skipped/halted), independent of the
  // budget flag — a fleet can finish every phase and still be over budget without
  // anything being aborted (finding #9).
  let aborted = false;
  let failed = false;

  try {
    for (const phase of spec.phases) {
      if (controller.signal.aborted) {
        aborted = true;
        break;
      }
      const phaseRun =
        phase.kind === "pipeline"
          ? runPipelinePhase(phase, pipelineCtx, fleetDeps, run, ledger, controller, budget)
          : runParallelPhase(
              phase,
              pipelineCtx,
              fleetDeps,
              run,
              ledger,
              concurrency,
              controller,
              budget,
            );
      // Swallow the abandoned phase's eventual outcome BEFORE racing so a
      // hung-then-throwing leaf can't surface as an unhandled rejection.
      void phaseRun.catch(() => {});
      const raced = await Promise.race([phaseRun, deadline]);
      if (raced === ABORT_SENTINEL) {
        aborted = true;
        phases.push({
          id: phase.id,
          kind: phase.kind,
          leaves: [],
          reduced: "",
          structured: undefined,
          unresolvedTemplates: 0,
          status: "aborted",
          failureReason: "fleet wall-clock backstop fired (a fork likely hung); phase not run",
        });
        break;
      }
      const result = raced;
      phases.push(result);
      if (result.status === "aborted") aborted = true;
      pipelineCtx[phase.id] = {
        reduced: result.reduced,
        structured: result.structured,
        leaves: result.leaves.map((l) => ({ role: l.role, text: l.text, structured: l.structured })),
      };
      // A pipeline that fails its schema/template barrier stops the FLEET — the
      // downstream phases were meant to consume an output that never materialized
      // (finding #5). A parallel phase never barrier-fails (its leaves are
      // independent), so this only triggers on pipeline barrier failures.
      if (result.status === "failed") {
        failed = true;
        break;
      }
    }
  } catch {
    failed = true;
  } finally {
    clearTimeout(wallClockTimer);
    deps.signal.removeEventListener("abort", onParentAbort);
  }

  const budgetExceeded = budget > 0 && totalTokens(ledger.usage) >= budget;

  // Status reflects what HAPPENED to the run, not merely whether it was
  // expensive (finding #9):
  //   - failed  : a pipeline barrier failed, or an exception escaped a phase.
  //   - aborted : a phase was cut short (budget latched / parent interrupt).
  //   - completed: every phase ran to completion (may still be over budget; that
  //                is carried separately by budgetExceeded).
  let status: FleetResult["status"] = "completed";
  if (failed) status = "failed";
  else if (aborted) status = "aborted";

  const summary = phases[phases.length - 1]?.reduced ?? "";
  const partial: FleetResult = {
    fleetId,
    phases,
    summary,
    usage: ledger.usage,
    status,
    budgetExceeded,
    manifestPath: "",
  };
  partial.manifestPath = await journalFleet(deps.workspace, fleetId, partial);
  // Persist every leaf (with index) so `resumeFleetId: <this fleetId>` can reuse
  // the completed ones after a crash/abort and only re-run what failed.
  await persistLeaves(deps.workspace, fleetId, phases);
  return partial;
}
