// Tool<I, O> is the per-file tool contract used across @ares/tools.
//
// Every tool owns its schema, permission check, execution, and display text.

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  ToolSchema,
  SafetyClass,
  Concurrency,
  ProviderHint,
  PermissionDecision,
  PermissionMode,
} from "@ares/protocol";
import type { ToolCallContext, EngineToolEffectPolicy, EngineToolResult } from "@ares/core";
import {
  renderRepositoryInstructions,
  type ResolvedRepositoryInstruction,
} from "@ares/core";

export interface FileReadStamp {
  mtimeMs: number;
  size: number;
  /** sha256 of the file content at Read time. The mtime/size guard races on
   *  coarse-granularity filesystems (Windows mtime can be ~16ms); the hash is
   *  the exact "did this change since I last saw it" check Edit/Write use. */
  hash?: string;
  /** Total line count at Read time, used for early offset validation. */
  lines?: number;
  /** Legacy provenance bit set by mutation tools when the stamp describes
   *  bytes they wrote rather than bytes returned by Read. Read now always
   *  returns requested bytes, but older integrations may still inspect it. */
  writtenNotRead?: boolean;
}

/** Cheap, stable content hash for read-stamp staleness checks. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * ARES_EDIT_AUTO_READ — whether Edit/Write may read an un-Read file themselves
 * instead of refusing with "Read <path> before editing it." Default ON.
 *
 * WHY: the read-before-write rule exists so the model never clobbers bytes it
 * hasn't seen. But the CONTENT-HASH staleness check plus unique-match
 * enforcement already carry that guarantee for Edit — the refusal only added a
 * round-trip. Field telemetry: 62 of 68 Edit errors in a month were this
 * refusal, each burning a turn to Read a file the model then edited exactly as
 * it had proposed. Set ARES_EDIT_AUTO_READ=0 to restore the hard deny.
 */
export function editAutoReadEnabled(): boolean {
  const raw = (process.env.ARES_EDIT_AUTO_READ ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/**
 * Read `filePath` on behalf of a mutation tool and stamp it EXACTLY as Read
 * would (mtime/size/hash/lines), so the staleness tracking downstream is
 * indistinguishable from a real Read. Returns the content so the caller does
 * not read twice. `writtenNotRead` is set because the model never saw these
 * bytes — the same provenance bit a post-write stamp carries.
 *
 * Throws a toolError (not a bare Error) on a missing/unreadable file: that is
 * the ONE case where the old deny is still the right answer, phrased so the
 * model reaches for Read (or Write, for a new file) instead of retrying Edit.
 */
export async function autoReadForMutation(
  ctx: Pick<RichToolContext, "fileReadStamps">,
  filePath: string,
  verb: "editing" | "overwriting",
): Promise<{ content: string; stamp: FileReadStamp }> {
  let content: string;
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(filePath);
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw toolError(
      code === "ENOENT"
        ? `${filePath} does not exist — Edit needs an existing file; use Write to create it.`
        : `Could not auto-read ${filePath} before ${verb} (${code ?? String(error)}). Read it explicitly and retry.`,
    );
  }
  const stamp: FileReadStamp = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash: contentHash(content),
    lines: content.split("\n").length,
    writtenNotRead: true,
  };
  ctx.fileReadStamps.set(filePath, stamp);
  return { content, stamp };
}

export interface RichToolContext extends ToolCallContext {
  permissionMode: PermissionMode;
  fileReadStamps: Map<string, FileReadStamp>;
  pathPermissions?: PathPermissionStore;
  commandPermissions?: CommandPermissionStore;
  subModel?: SubModelPool;
  /** Optional shell process registry — required for run_in_background. */
  shellRegistry?: import("./ShellRegistry.js").ShellRegistry;
  /** Optional todo store — used by TodoWrite. */
  todoStore?: import("./TodoWrite.js").TodoStore;
  /** Per-session registry of deferred (ToolSearch-loadable) tools. */
  deferredTools?: import("./ToolSearch.js").DeferredToolRegistry;
}

export const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
export const SHELL_MAX_TIMEOUT_MS = 600_000;

/** One model-facing command contract for every platform shell. Bash and
 * PowerShell differ only in interpreter selection; cwd, timeout, detached-job
 * behavior, permission semantics, and output recovery stay identical. */
export function shellInputSchema(commandDescription: string) {
  return z
    .object({
      command: z.string().min(1).describe(commandDescription),
      description: z.string().describe("5-10 word active-voice summary."),
      timeout: z
        .number()
        .int()
        .positive()
        .max(SHELL_MAX_TIMEOUT_MS)
        .default(SHELL_DEFAULT_TIMEOUT_MS)
        .describe(`Timeout in milliseconds (max ${SHELL_MAX_TIMEOUT_MS}, foreground only).`),
      cwd: z.string().optional().describe("Working directory. Defaults to workspace."),
      target_paths: z
        .array(z.string().min(1))
        .max(64)
        .default([])
        .describe(
          "Concrete files/directories the command will access outside cwd. Declare them so nested repository rules and path permissions load before execution.",
        ),
      run_in_background: z
        .boolean()
        .default(false)
        .describe(
          "When true, run as a durable background job and return a shell_id immediately. Poll with BashOutput and stop with KillShell.",
        ),
    })
    .strict();
}

/** Resolve and atomically claim path-scoped repository instructions in target
 * order. The resolver itself serializes concurrent calls within one Session. */
export async function repositoryInstructionsForTargets(
  ctx: RichToolContext,
  targets: readonly string[],
): Promise<ResolvedRepositoryInstruction[]> {
  if (!ctx.repositoryInstructions) return [];
  const instructions: ResolvedRepositoryInstruction[] = [];
  const seenTargets = new Set<string>();
  for (const target of targets) {
    const absolute = path.resolve(ctx.workspace, target);
    const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    instructions.push(...await ctx.repositoryInstructions.resolve(absolute));
  }
  return instructions;
}

/** A newly encountered rule must be model-visible before any mutation. Return
 * a correctable pre-effect denial; because the files are now claimed, retrying
 * after reviewing the rules proceeds without a deny loop. */
export async function mutationInstructionBlock(
  ctx: RichToolContext,
  targets: readonly string[],
): Promise<string | null> {
  const instructions = await repositoryInstructionsForTargets(ctx, targets);
  if (instructions.length === 0) return null;
  return [
    "Repository instructions were loaded before this mutation. No files were changed.",
    "Review the broad-to-specific rules below, adjust the change if needed, then retry the mutation.",
    renderRepositoryInstructions(instructions),
  ].join("\n\n");
}

/** Discover cwd-scoped repository rules before a shell process can start.
 * Returning a permission denial makes the adapter mark this as a known
 * pre-effect correction; the next call proceeds because the exact rule hashes
 * are now claimed in the Session context. */
export async function shellRepositoryInstructionDecision(
  ctx: RichToolContext,
  cwdInput: string | undefined,
  targetInputs: readonly string[] = [],
): Promise<PermissionDecision | null> {
  const cwd = await resolveWorkspacePath(ctx, cwdInput, "cwd", "execute");
  const targets = [cwd];
  for (const [index, target] of targetInputs.entries()) {
    // target_paths describe what the command will touch, so their relative
    // base is the command's effective cwd—not the Session's original
    // workspace. Passing an absolute candidate through resolveWorkspacePath
    // preserves the normal approved/bypass authority checks.
    const candidate = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    targets.push(await resolveWorkspacePath(ctx, candidate, `target_paths[${index}]`, "all"));
  }
  const instructions = await mutationInstructionBlock(ctx, targets);
  return instructions ? { kind: "deny", reason: instructions } : null;
}

export function appendRepositoryInstructions(
  content: string,
  instructions: readonly ResolvedRepositoryInstruction[],
): string {
  const rendered = renderRepositoryInstructions(instructions);
  return rendered ? `${content}\n\n${rendered}` : content;
}

export type PathAccess = "read" | "write" | "execute" | "all";
export type PathGrantScope = "once" | "always";

export interface PathPermissionStore {
  isAllowed(absPath: string, access: PathAccess): boolean;
  grant(absPath: string, access: PathAccess, scope: PathGrantScope): Promise<void> | void;
}

export interface CommandPermissionStore {
  decide(toolName: string, command: string): PermissionDecision | null;
  /** Persist an "always allow this command" grant chosen at the prompt, so the
   *  next session doesn't re-ask. Optional: hosts without a writable store omit
   *  it and `allow_always` simply behaves like `allow_once` (the prior behavior). */
  grant?(toolName: string, command: string, scope: PathGrantScope): Promise<void> | void;
}

export interface SubModelPool {
  apply(req: { file: string; original: string; instructions: string; sketch: string }): Promise<string>;
  /** `signal` lets a Stop during compaction abort the summarizer instead of
   *  running the sub-model to completion against an already-dead turn. */
  summarize(req: { input: string; instructions?: string; signal?: AbortSignal }): Promise<string>;
}

export interface ToolResult<O> extends EngineToolResult {
  output: O;
  touchedFiles?: string[];
  display?: string;
  /** Images for the model to see (screenshots). See EngineToolResult.images. */
  images?: Array<{ mediaType: string; data: string }>;
}

/**
 * Result of a tool's semantic input check ({@link Tool.validateInput}). `ok:false`
 * carries a model-facing message the loop wraps as a correctable
 * `<tool_use_error>` so the model fixes the call on its next turn instead of the
 * tool throwing an opaque error. Wired in Phase 4 (tool-contract hardening).
 */
export type ToolInputValidation = { ok: true } | { ok: false; message: string };

export interface Tool<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  readonly schema: ToolSchema;
  /** Whether any valid input can resolve above read-only. This is explicit
   * host-composition metadata; `classifyInput` existing by itself says nothing
   * because every adapted tool exposes that function. */
  readonly mayHaveEffects: boolean;
  /** Optional observational recovery contract for non-file effects. Ares never
   * treats this as authority to replay an ambiguous call automatically. */
  readonly effectPolicy?: EngineToolEffectPolicy;
  readonly inputZod: I;
  /** Optional semantic check run AFTER zod parse, BEFORE call(). See {@link ToolInputValidation}.
   *  Method syntax (not an arrow property) so the parameter stays bivariant —
   *  otherwise `Tool<ConcreteSchema>` would not be assignable to `Tool<ZodTypeAny>`. */
  validateInput?(input: z.infer<I>, ctx: RichToolContext): Promise<ToolInputValidation>;
  checkPermissions(input: z.infer<I>, ctx: RichToolContext): Promise<PermissionDecision>;
  call(input: z.infer<I>, ctx: RichToolContext): Promise<ToolResult<O>>;
  activityDescription(input: z.infer<I>): string;
  /** Command string for `allow_always` persistence (Bash/PowerShell); see ToolDef. */
  commandFor?(input: z.infer<I>): string | undefined;
  /** Effective per-call safety shared by scheduling, plan gating, durable
   * admission, permission checks, checkpoints, and effect recovery. */
  effectiveSafety(input: z.infer<I>): SafetyClass;
}

export interface ToolDef<I extends z.ZodTypeAny, O> {
  name: string;
  description: string;
  safety: SafetyClass;
  concurrency: Concurrency;
  providerHint?: ProviderHint;
  deferLoading?: boolean;
  /** Per-tool execution watchdog (ms). 0 = uncapped (self-capping tools);
   *  omitted = engine picks a class default from `safety`. */
  watchdogTimeoutMs?: number;
  /** Max chars of result kept inline before the engine spills to disk (Phase 4). */
  maxResultSizeChars?: number;
  inputZod: I;
  /** Observational crash reconciliation and explicit retry guidance for
   * remote/external effects. Transactional file tools normally omit this. */
  effectPolicy?: EngineToolEffectPolicy;
  /** Optional semantic input check (Phase 4). See {@link ToolInputValidation}. */
  validateInput?: (input: z.infer<I>, ctx: RichToolContext) => Promise<ToolInputValidation>;
  /** Per-INPUT effective safety for the permission decision (e.g. ComputerUse's
   *  screenshot is read-only while its click is external-state). Affects ONLY the
   *  permission gate — `schema.safety` stays the static class, so watchdog
   *  defaults and conductor tool filtering remain conservative. */
  dynamicSafety?: (input: z.infer<I>) => SafetyClass;
  checkPermissions?: (input: z.infer<I>, ctx: RichToolContext) => Promise<PermissionDecision>;
  call: (input: z.infer<I>, ctx: RichToolContext) => Promise<ToolResult<O>>;
  activityDescription: (input: z.infer<I>) => string;
  /** For command tools (Bash/PowerShell): the command string from the input, so
   *  the permission gate can persist an `allow_always` grant. Tools that aren't
   *  command-shaped omit this — then `allow_always` is honored for the turn but,
   *  as before, nothing is written. */
  commandFor?: (input: z.infer<I>) => string | undefined;
}

export function buildTool<I extends z.ZodTypeAny, O>(def: ToolDef<I, O>): Tool<I, O> {
  const inputJsonSchema = normalizeProviderJsonSchema(zodToJsonSchema(def.inputZod, {
    target: "openApi3",
    $refStrategy: "none",
  })) as object;

  const schema: ToolSchema = {
    name: def.name,
    description: def.description,
    inputJsonSchema,
    safety: def.safety,
    concurrency: def.concurrency,
    providerHint: def.providerHint,
    deferLoading: def.deferLoading,
    watchdogTimeoutMs: def.watchdogTimeoutMs,
    maxResultSizeChars: def.maxResultSizeChars,
  };

  const checkPermissions = async (
    input: z.infer<I>,
    ctx: RichToolContext,
  ): Promise<PermissionDecision> => {
    const base = defaultPermissionDecision(def, ctx, def.dynamicSafety?.(input));
    if (base.kind !== "allow") return base;
    return def.checkPermissions ? def.checkPermissions(input, ctx) : base;
  };

  return {
    schema,
    mayHaveEffects: def.safety !== "read-only" || def.dynamicSafety !== undefined,
    effectPolicy: def.effectPolicy,
    inputZod: def.inputZod,
    validateInput: def.validateInput,
    checkPermissions,
    call: def.call,
    activityDescription: def.activityDescription,
    commandFor: def.commandFor,
    effectiveSafety: (input) => def.dynamicSafety?.(input) ?? def.safety,
  };
}

/**
 * Parse tool input, tolerating extra keys the model invented. Tool schemas are
 * `.strict()`, so a single plausible-but-unknown param (e.g. `max_results` on a
 * tool that doesn't take it) made Zod reject the WHOLE call — a dominant cause
 * of "most tool calls failing" with models that habitually add params. We strip
 * unrecognized keys and retry; only GENUINE validation errors (missing/typed-
 * wrong fields) still throw, with a readable message the model can correct from.
 */
export function parseToolInputLenient<S extends z.ZodTypeAny>(schema: S, input: unknown, toolName: string): z.infer<S> {
  const first = schema.safeParse(input);
  if (first.success) return first.data;

  const unknownKeyIssues = first.error.issues.filter(
    (i): i is z.ZodIssue & { keys: string[] } => i.code === "unrecognized_keys",
  );
  if (unknownKeyIssues.length > 0) {
    const stripped = stripUnknownKeys(input, unknownKeyIssues);
    const retry = schema.safeParse(stripped);
    if (retry.success) return retry.data;
    return retryWithParsedJsonStrings(schema, stripped, retry.error, toolName);
  }
  return retryWithParsedJsonStrings(schema, input, first.error, toolName);
}

/**
 * Second repair pass: weaker models emit structured args as JSON-ENCODED
 * STRINGS ("todos": "[{...}]") — zod reports invalid_type expected array/object,
 * received string. Parse the string at each such path and retry once. Only
 * fields the SCHEMA declares non-scalar are touched, so free-text params that
 * happen to start with "[" are never mangled.
 */
function retryWithParsedJsonStrings<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  error: z.ZodError,
  toolName: string,
): z.infer<S> {
  const coercible = error.issues.filter(
    (i) =>
      i.code === "invalid_type" &&
      (i as { expected?: string }).expected !== undefined &&
      ["array", "object"].includes((i as { expected: string }).expected) &&
      (i as { received?: string }).received === "string",
  );
  if (coercible.length === 0 || input === null || typeof input !== "object") {
    return throwToolInputError(error, toolName);
  }
  const clone: unknown = structuredClone(input);
  let repaired = false;
  for (const issue of coercible) {
    let node: unknown = clone;
    for (const seg of issue.path.slice(0, -1)) {
      if (node && typeof node === "object") node = (node as Record<string | number, unknown>)[seg];
    }
    const leaf = issue.path[issue.path.length - 1];
    if (!node || typeof node !== "object" || leaf === undefined) continue;
    const value = (node as Record<string | number, unknown>)[leaf];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") {
        (node as Record<string | number, unknown>)[leaf] = parsed;
        repaired = true;
      }
    } catch {
      // not valid JSON — leave it; the original error stands
    }
  }
  if (!repaired) return throwToolInputError(error, toolName);
  const retry = schema.safeParse(clone);
  if (retry.success) return retry.data;
  return throwToolInputError(retry.error, toolName);
}

function stripUnknownKeys(input: unknown, issues: Array<{ path: (string | number)[]; keys: string[] }>): unknown {
  if (input === null || typeof input !== "object") return input;
  const clone: unknown = structuredClone(input);
  for (const issue of issues) {
    let node: unknown = clone;
    for (const seg of issue.path) {
      if (node && typeof node === "object") node = (node as Record<string | number, unknown>)[seg];
    }
    if (node && typeof node === "object") {
      for (const key of issue.keys) delete (node as Record<string, unknown>)[key];
    }
  }
  return clone;
}

function throwToolInputError(error: z.ZodError, toolName: string): never {
  const detail = error.issues
    .map((i) => `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`)
    .join("; ");
  throw new Error(`${toolName}: invalid arguments — ${detail}`);
}

/**
 * Wrap a model-facing, correctable message in a recognizable envelope. The engine
 * surfaces a thrown error's `.message` as an `is_error` tool_result, so the model
 * sees `<tool_use_error>…</tool_use_error>` and learns to fix the CALL rather than
 * treating it as a runtime failure to retry blindly. Exported so individual tools
 * can throw correctable domain errors (e.g. Edit "old_string not found") in the
 * same recognizable shape as the loop's input-validation gate.
 */
export function toolError(message: string): Error {
  return new Error(`<tool_use_error>${message}</tool_use_error>`);
}

/** Adapter-only form. Exported tool implementations must use toolError(),
 * which deliberately carries no effect-phase claim because a runtime caller
 * may already have committed bytes before discovering a correctable problem. */
function preEffectToolError(message: string): Error {
  return markPreEffectError(toolError(message));
}

/**
 * Mark a failure that is known to have happened before the wrapped tool's
 * implementation was entered. QueryEngine uses this narrow, non-enumerable
 * signal to distinguish a correctable validation/permission rejection from a
 * writer that threw after an effect may already have happened.
 */
function markPreEffectError(error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(normalized, "aresToolEffectPhase", {
    value: "pre-effect",
    configurable: true,
  });
  return normalized;
}

/** Tool names the user clicked "Allow always" on this process run. Backs the
 *  non-command allow_always path in adaptToolForEngine — session-scoped on
 *  purpose (a fresh daemon starts guarded again). */
const toolAlwaysGrants = new Set<string>();

export function adaptToolForEngine(
  tool: Tool<z.ZodTypeAny, unknown>,
  enrich: (base: ToolCallContext) => RichToolContext,
): {
  schema: ToolSchema;
  mayHaveEffects: boolean;
  effectPolicy?: EngineToolEffectPolicy;
  classifyInput: (input: unknown) => { safety: SafetyClass };
  call: (input: unknown, ctx: ToolCallContext) => Promise<EngineToolResult>;
} {
  return {
    schema: tool.schema,
    mayHaveEffects: tool.mayHaveEffects,
    effectPolicy: tool.effectPolicy,
    classifyInput(input) {
      try {
        return { safety: tool.effectiveSafety(input as z.infer<typeof tool.inputZod>) };
      } catch {
        return { safety: tool.schema.safety };
      }
    },
    async call(input, ctx) {
      // Two-stage input validation BEFORE the tool runs (CC pattern). Bad model
      // input becomes a recognizable, correctable <tool_use_error> the model fixes
      // on its next turn — instead of an opaque throw that reads like a tool crash
      // (a dominant cause of tool-call failures and dead-loop retries).
      let parsed: z.infer<typeof tool.inputZod>;
      try {
        // Stage 1 — shape: zod parse (lenient on extra keys), throws on genuine
        // type/required errors with a readable, field-level message.
        parsed = parseToolInputLenient(tool.inputZod, input, tool.schema.name);
      } catch (e) {
        throw preEffectToolError(e instanceof Error ? e.message : String(e));
      }
      let rich: RichToolContext;
      try {
        rich = enrich(ctx);
      } catch (error) {
        throw markPreEffectError(error);
      }
      // Stage 2 — semantics: optional tool-specific check (e.g. "old_string not
      // found", "path escapes workspace") AFTER parse, BEFORE permission/exec.
      if (tool.validateInput) {
        let verdict: Awaited<ReturnType<NonNullable<typeof tool.validateInput>>>;
        try {
          verdict = await tool.validateInput(parsed, rich);
        } catch (error) {
          throw markPreEffectError(error);
        }
        if (!verdict.ok) throw preEffectToolError(verdict.message);
      }
      let decision: PermissionDecision;
      try {
        decision = await tool.checkPermissions(parsed, rich);
      } catch (error) {
        throw markPreEffectError(error);
      }
      // "Allow always" for non-command tools (ComputerUse, Browser, …) grants
      // the TOOL for the rest of the process. Before this, allow_always was a
      // silent no-op for any tool without commandFor — the user clicked Always
      // and got re-prompted on the very next action (mid-automation, moving
      // their mouse to the dialog and wrecking the run).
      if (decision.kind === "ask" && toolAlwaysGrants.has(tool.schema.name)) {
        decision = { kind: "allow" };
      }
      if (decision.kind === "deny") {
        // A policy deny ("Read the file first", "disabled in plan mode") is a
        // correctable signal — envelope it like the validation gate so the model
        // treats it as "fix the call", not an opaque crash.
        throw preEffectToolError(decision.reason);
      }
      if (decision.kind === "ask") {
        if (!ctx.requestPermission) {
          throw markPreEffectError(new Error(`permission required: ${decision.prompt}`));
        }
        let answer: Awaited<ReturnType<NonNullable<typeof ctx.requestPermission>>>;
        try {
          answer = await ctx.requestPermission({
            toolName: tool.schema.name,
            input: parsed,
            reason: decision.prompt,
            suggestion: decision.suggestion,
          });
        } catch (error) {
          throw markPreEffectError(error);
        }
        if (answer === "deny") {
          const err = new Error(`permission denied: ${tool.schema.name}`);
          err.name = "PermissionDeniedError";
          throw markPreEffectError(err);
        }
        // Persist an explicit "always allow this command" so the next session
        // doesn't re-ask. Path tools self-persist inside call() via
        // resolveWorkspacePath; command tools (Bash/PowerShell) route through
        // here. Non-command tools get a process-lifetime tool-name grant.
        if (answer === "allow_always") {
          const command = tool.commandFor?.(parsed);
          if (command !== undefined) {
            try {
              await rich.commandPermissions?.grant?.(tool.schema.name, command, "always");
            } catch (error) {
              throw markPreEffectError(error);
            }
          } else {
            toolAlwaysGrants.add(tool.schema.name);
          }
        }
      }
      const result = await tool.call(parsed, rich);
      return {
        output: result.output,
        failure: result.failure,
        touchedFiles: result.touchedFiles,
        display: result.display,
        images: result.images,
      };
    },
  };
}

export const zPath = z.string().min(1).describe("Absolute or workspace-relative path.");
export const zAbsPath = zPath;

/**
 * Cheap, synchronous file-path sanity for validateInput hooks. Returns a
 * model-facing "how to fix it" sentence, or null when the path looks concrete.
 * Catches the burns that otherwise fail deep in fs: glob metacharacters (the
 * model pasted a pattern where a single path belongs), embedded newlines
 * (a copy-paste of two lines), and NUL bytes. `workspace` (optional) also flags
 * a RELATIVE path whose `..` segments climb out of the workspace — those calls
 * always fail or mis-prompt; an absolute path is the intentional form.
 */
export function pathInputProblem(inputPath: string, workspace?: string): string | null {
  if (inputPath.trim() === "") {
    return "file path is empty — pass an absolute or workspace-relative path.";
  }
  if (/[\n\r\0]/.test(inputPath)) {
    return "file path contains a newline or NUL — pass a single path with no line breaks.";
  }
  if (/[*?"<>|]/.test(inputPath.replace(/^[A-Za-z]:/, ""))) {
    return `"${inputPath}" contains glob/wildcard characters — pass ONE concrete file path (use Glob to find files by pattern).`;
  }
  if (workspace !== undefined && !path.isAbsolute(inputPath) && inputPath.split(/[\\/]/).includes("..")) {
    const resolved = path.resolve(workspace, inputPath);
    const rel = path.relative(path.resolve(workspace), resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return `"${inputPath}" climbs out of the workspace via '..' — pass the absolute path (${resolved}) if you really mean that location.`;
    }
  }
  return null;
}

/**
 * Topic-first narration for a shell command ("Switching to main", "Running
 * tests", "Committing changes"). Mirrors the engine's narrator so the CLI strip
 * and the desktop card read identically. Shared by Bash + PowerShell.
 */
export function describeShellActivity(rawCommand: string, background: boolean): string {
  const cmd = rawCommand.trim().replace(/\s+/g, " ");
  const lead = (verb: string) => (background ? `${verb} in the background` : verb);
  const branch = /git\s+(?:checkout|switch)\s+(?:-b\s+)?([^\s&|;]+)/.exec(cmd);
  if (branch) return lead(`Switching to ${branch[1]}`);
  if (/git\s+commit/i.test(cmd)) return lead("Committing changes");
  if (/git\s+push/i.test(cmd)) return lead("Pushing to remote");
  if (/git\s+pull/i.test(cmd)) return lead("Pulling from remote");
  if (/git\s+status/i.test(cmd)) return lead("Checking git status");
  if (/git\s+(diff|log|show)/i.test(cmd)) return lead("Inspecting git history");
  if (/(pnpm|npm|yarn).*(test|vitest|jest)|node --test|\bpytest\b|cargo test/i.test(cmd)) return lead("Running tests");
  if (/(pnpm|npm|yarn).*(build|lint|tsc)|cargo build|vite build/i.test(cmd)) return lead("Building the project");
  if (/(pnpm|npm|yarn)\s+(install|i|add)|cargo add/i.test(cmd)) return lead("Installing dependencies");
  const program = cmd.split(" ")[0]?.split(/[\\/]/).pop() || "command";
  return lead(`Running ${program}`);
}

/**
 * Commands whose damage git CANNOT undo, refused outright — regardless of
 * permission mode, including bypass/YOLO.
 *
 * Everything else in the destructive list is recoverable in principle: a
 * `reset --hard` or `checkout --` throws away work git still has objects for,
 * and the owner accepted that risk when they turned prompting off. `git clean`
 * with -x/-X is different in kind: it deletes IGNORED files, i.e. exactly the
 * files git never tracked and therefore cannot restore. In a repo that keeps
 * local-only state behind .gitignore — env files, vault databases, an
 * untracked docs tree — that is unrecoverable data loss, and the ignore rule
 * that protects those files from being published is precisely what leaves
 * them unprotected here.
 *
 * This is not hypothetical: an agent run cleaning up 16 test artifacts reached
 * for `git clean -fdX`, destroyed 197 local-only files including the .env, the
 * vault DBs and the entire docs corpus (plus the backup directory that existed
 * to survive this exact accident), and then — after detecting and reporting
 * the loss — ran the same command again.
 *
 * A preview (-n/--dry-run) is always allowed: seeing the kill list first is
 * the whole remedy. Deleting a known set of files by name is also unaffected.
 * Returns a refusal message, or null when the command is fine.
 */
export function irrecoverableShellRefusal(command: string): string | null {
  const normalized = command.replace(/\s+/g, " ").trim();
  // every `git clean` invocation in the line, including chained ones
  // Pre-subcommand git options may take a VALUE (`git -C <path> clean …`,
  // `git --git-dir=… clean …`), so a flag may be followed by a bare argument
  // before `clean` appears. Missing that form would leave the most explicit
  // spelling — the one that names another repository — unguarded.
  const cleans = normalized.match(/(?:^|[;&|]\s*)git\s+(?:-[^\s]+\s+(?:[^-\s][^\s]*\s+)?)*clean\b[^;&|]*/gi);
  if (!cleans) return null;
  for (const clean of cleans) {
    const flags = clean.slice(clean.toLowerCase().indexOf("clean") + 5);
    // -x / -X anywhere in a short cluster (-fdX) or as a long option
    const removesIgnored = /(?:^|\s)-[a-wyz]*x[a-wyz]*(?:\s|$)/i.test(flags) || /--(?:force-)?x\b/.test(flags);
    if (!removesIgnored) continue;
    const isPreview = /(?:^|\s)-[a-z]*n[a-z]*(?:\s|$)/i.test(flags) || /--dry-run\b/.test(flags);
    if (isPreview) continue;
    return (
      "Refused: `git clean` with -x/-X deletes IGNORED files, which git cannot restore — " +
      "in this kind of repository that usually means .env files, local databases, and untracked " +
      "documentation. This refusal holds even in bypass/YOLO mode because the loss is permanent.\n\n" +
      "Do one of these instead:\n" +
      "  1. Preview it first: `git clean -ndX` — read the list, then delete what you actually meant to.\n" +
      "  2. Delete the files you created BY NAME (`rm path/a path/b`). If you made them, you have the list.\n" +
      "  3. Write throwaway/probe files to a scratch directory OUTSIDE the repo, so cleanup can never touch it."
    );
  }
  return null;
}

/**
 * What a flagged shell command can do. Distinct categories get distinct
 * prompts so the person at the keyboard reads WHY they're being asked ("can
 * delete data" is a very different decision from "publishes to a registry").
 */
export type ShellHazard = "delete" | "history" | "publish" | "remote-code";

const SHELL_HAZARD_PROMPTS: Record<ShellHazard, string> = {
  delete: "This shell command can delete data or discard uncommitted work.",
  history: "This shell command rewrites shared git history or discards git refs/stashes (force-push, branch -D, stash drop/clear).",
  publish: "This shell command publishes to a package registry.",
  "remote-code": "This shell command executes remote code (downloaded script piped into a shell / Invoke-Expression).",
};

/**
 * Peel ONE layer of "run this string in another interpreter" wrapping so the
 * hazard patterns see the real command. Every wrapper below was a live bypass:
 * `sh -c 'rm -rf x'`, `bash -c`, `pwsh -Command Remove-Item …`,
 * `powershell -c`, `cmd /c rd /s /q …`, and `python -c "shutil.rmtree(…)"` all
 * sailed past a matcher that only looked at the outer line. One level is
 * enough in practice; deeper nesting is rare and the unwrapped text is scanned
 * as a whole (quotes included), so a doubly-wrapped `rm -rf` still matches.
 */
export function unwrapShellWrappers(command: string): string[] {
  const out: string[] = [];
  const wrappers = [
    /(?:^|[;&|]\s*)(?:sh|bash|zsh|dash|ksh)(?:\.exe)?\s+(?:-[a-z]+\s+)*-l?c\s+(.+)$/i,
    /(?:^|[;&|]\s*)(?:pwsh|powershell)(?:\.exe)?\s+(?:-\w+(?:\s+\w+)?\s+)*-(?:Command|c|Comm|Com)\s+(.+)$/i,
    /(?:^|[;&|]\s*)cmd(?:\.exe)?\s+(?:\/\w+\s+)*\/[ck]\s+(.+)$/i,
    /(?:^|[;&|]\s*)(?:python3?|py|node)(?:\.exe)?\s+(?:-\w+\s+)*-[ce]\s+(.+)$/i,
  ];
  for (const re of wrappers) {
    const m = re.exec(command);
    if (!m) continue;
    let inner = m[1].trim();
    // Strip ONE matching pair of surrounding quotes; the body keeps its own.
    if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
      inner = inner.slice(1, -1);
    }
    if (inner.length > 0) out.push(inner);
  }
  return out;
}

/** Which hazard (if any) a single already-normalized command line carries. */
function shellHazardOf(normalized: string): ShellHazard | null {
  const deletes =
    /(?:^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/i.test(normalized) ||
    /(?:^|[;&|]\s*)(?:rmdir|unlink|shred)\b/i.test(normalized) ||
    /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--)\b/i.test(normalized) ||
    // `format(?!-)` matches the disk-format command ("format C:") but NOT the
    // benign PowerShell Format-* cmdlets (Format-Table/List/Hex/…) — `\bformat\b`
    // alone fired on every `... | Format-Table`, falsely prompting "can delete
    // data" on read-only commands. The destructive Format-Volume is caught below.
    /\b(?:mkfs(?:\.\w+)?|wipefs|format(?!-))\b/i.test(normalized) ||
    /\bRemove-Item\b/i.test(normalized) ||
    /(?:^|[;|]\s*)(?:del|erase|rd|rmdir)\s+(?:\/[a-z]+\s+)*/i.test(normalized) ||
    /\b(?:Clear-Disk|Format-Volume|Remove-Partition)\b/i.test(normalized) ||
    // Interpreter one-liners that delete: python's shutil/os/pathlib removers,
    // node's fs.rm*/rimraf. Scanned on the whole line so quoting doesn't matter.
    /\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)|\.unlink\(|\.rmdir\(|fs\.rm(?:Sync)?\(|fs\.rmdir(?:Sync)?\(|fs\.unlink(?:Sync)?\(|\brimraf\b)/.test(normalized) ||
    // find's own deleter and its exec-into-rm form; xargs feeding rm.
    (/(?:^|[;&|]\s*)find\b/i.test(normalized) && /\s-delete\b|\s-exec\s+rm\b|\s-execdir\s+rm\b/i.test(normalized)) ||
    /\bxargs\s+(?:-[^\s]+\s+)*rm\b/i.test(normalized) ||
    // truncate zeroes a file in place; dd of= overwrites whatever it points at.
    /(?:^|[;&|]\s*)truncate\s/i.test(normalized) ||
    /(?:^|[;&|]\s*)dd\s+[^;&|]*\bof=/i.test(normalized);
  if (deletes) return "delete";

  const history =
    /\bgit\s+(?:-[^\s]+\s+)*push\b[^;&|]*\s(?:-f|--force|--force-with-lease(?:=[^\s]*)?)(?:\s|$)/i.test(normalized) ||
    /\bgit\s+(?:-[^\s]+\s+)*branch\s+(?:-[^\s]+\s+)*-D\b/.test(normalized) ||
    /\bgit\s+(?:-[^\s]+\s+)*stash\s+(?:drop|clear)\b/i.test(normalized);
  if (history) return "history";

  if (/\b(?:npm|pnpm|yarn|cargo)\s+publish\b/i.test(normalized)) return "publish";

  const remoteCode =
    /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|pwsh|powershell)\b/i.test(normalized) ||
    /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(?:iex|Invoke-Expression)\b/i.test(normalized) ||
    /\bInvoke-Expression\b/i.test(normalized) ||
    /(?:^|[;&|(]\s*)iex\s/i.test(normalized);
  if (remoteCode) return "remote-code";

  return null;
}

/**
 * Commands that can erase data, rewrite shared history, publish, or run code
 * pulled off the network. Returns an "ask" decision with a category-specific
 * prompt, or null when the command is fine. Wrapped forms (`sh -c '…'`,
 * `powershell -Command …`, `cmd /c …`, `python -c "…"`) are unwrapped one level
 * before matching — see unwrapShellWrappers for why.
 */
export function destructiveShellDecision(command: string): PermissionDecision | null {
  const normalized = command.replace(/\s+/g, " ").trim();
  const candidates = [normalized, ...unwrapShellWrappers(normalized)];
  for (const candidate of candidates) {
    const hazard = shellHazardOf(candidate);
    if (hazard) {
      return { kind: "ask", prompt: SHELL_HAZARD_PROMPTS[hazard], suggestion: "deny" };
    }
  }
  return null;
}

/**
 * ARES_SHELL_POLICY=allowlist — when set, any shell command that is not
 * provably read-only (isReadOnlyShellCommand) returns {kind:"ask"} instead of
 * silently allowing. Default (unset/"default") keeps the existing behaviour:
 * only hazard-matched commands prompt. This is the knob for running Ares
 * against a workspace you don't fully trust the model with yet.
 */
export function shellPolicyDecision(command: string): PermissionDecision | null {
  const policy = (process.env.ARES_SHELL_POLICY ?? "").trim().toLowerCase();
  if (policy !== "allowlist") return null;
  if (isReadOnlyShellCommand(command)) return null;
  return {
    kind: "ask",
    prompt: "ARES_SHELL_POLICY=allowlist: this command is not on the read-only allowlist.",
    suggestion: "allow_once",
  };
}

// First tokens that only ever read. Deliberately SMALL: the cost of a missing
// entry is one extra prompt; the cost of a wrong entry is a silent write.
const READ_ONLY_PROGRAMS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "wc", "echo", "pwd", "which", "where", "whoami",
  "hostname", "date", "printenv", "file", "stat", "du", "df", "tree", "less", "more", "grep",
  "rg", "fd", "fdfind", "true", "uname", "id", "realpath", "basename", "dirname", "nproc",
]);
// PowerShell cmdlets/aliases that only read or format.
const READ_ONLY_CMDLETS = /^(?:Get-\w+|Select-String|Select-Object|Format-\w+|Measure-Object|Where-Object|Sort-Object|Group-Object|Test-Path|Resolve-Path|Out-String|Write-Output|Write-Host|ConvertTo-Json|ConvertFrom-Json|Compare-Object|Split-Path|Join-Path|Out-Host|gci|gc|gi|gl|gp|gsv|gps|gm|sls|select|where|sort|measure|ft|fl|fw|echo|pwd|cat|ls|dir|type)$/i;
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe",
  "shortlog", "cat-file", "reflog", "grep", "name-rev", "for-each-ref", "count-objects", "var",
]);
const VERSION_FLAG = /^(?:-v|-V|--version|-version)$/;

/**
 * True when EVERY segment of the command (split on `;`, `&&`, `||`, `|`,
 * newlines) starts with a known read-only program and carries no output
 * redirection. Conservative by design — anything it doesn't recognise counts
 * as NOT read-only, so `git push`, `pnpm build`, `sed -i`, `> file` all fall
 * through to the policy prompt. `find` is allowed only without -delete/-exec.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const line = command.trim();
  if (line.length === 0) return false;
  // Any redirection (incl. PowerShell's) can create/truncate a file.
  if (/(?:^|[^<])>|<\(/.test(line.replace(/'[^']*'|"[^"]*"/g, ""))) return false;
  const segments = line.split(/\r?\n|;|&&|\|\||\|/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    const tokens = seg.split(/\s+/);
    // Skip leading VAR=value assignments (bash) — they don't run anything.
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    if (tokens.length === 0) return false;
    const program = tokens[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
    const rest = tokens.slice(1);
    if (READ_ONLY_PROGRAMS.has(program.toLowerCase()) || READ_ONLY_CMDLETS.test(program)) continue;
    if (/^(?:node|npm|pnpm|npx|yarn|python3?|py|cargo|rustc|tsc|git|go|java|dotnet|pwsh|powershell|bash)$/i.test(program) && rest.length === 1 && VERSION_FLAG.test(rest[0])) continue;
    if (program.toLowerCase() === "git") {
      // Skip pre-subcommand options (`git -C path status`, `--no-pager log`).
      let k = 0;
      while (k < rest.length && rest[k].startsWith("-")) k += /^-[Cc]$|^--git-dir$|^--work-tree$/.test(rest[k]) ? 2 : 1;
      const sub = rest[k]?.toLowerCase();
      if (sub && READ_ONLY_GIT_SUBCOMMANDS.has(sub)) continue;
      if (sub === "branch" && !rest.slice(k + 1).some((t) => /^-(?:[dDmMcC]|-delete|-move|-copy|-set-upstream-to|-unset-upstream|-edit-description)$/.test(t))) continue;
      if (sub === "stash" && rest[k + 1]?.toLowerCase() === "list") continue;
      if (sub === "remote" && (rest.length === k + 1 || rest[k + 1] === "-v" || rest[k + 1] === "show" || rest[k + 1] === "get-url")) continue;
      if (sub === "config" && (rest[k + 1] === "--get" || rest[k + 1] === "--list" || rest[k + 1] === "-l")) continue;
      if (sub === "tag" && (rest.length === k + 1 || rest[k + 1] === "-l" || rest[k + 1] === "--list")) continue;
      return false;
    }
    if (program.toLowerCase() === "find") {
      if (rest.some((t) => /^-(?:delete|exec|execdir|ok|okdir|fprint\w*)$/.test(t))) return false;
      continue;
    }
    if (/^(?:npm|pnpm|yarn)$/i.test(program) && /^(?:ls|list|why|view|outdated|root)$/i.test(rest[0] ?? "")) continue;
    if (program.toLowerCase() === "sed" && !rest.some((t) => /^-[a-zA-Z]*i/.test(t) || t === "--in-place")) continue;
    return false;
  }
  return true;
}

function defaultPermissionDecision<I extends z.ZodTypeAny, O>(
  def: ToolDef<I, O>,
  ctx: RichToolContext,
  safetyOverride?: SafetyClass,
): PermissionDecision {
  const safety = safetyOverride ?? def.safety;
  // The living plan artifact is the one narrowly scoped write admitted while
  // planning. It cannot edit user files: the tool delegates only to the
  // Session-owned SQLite revision + .ares/plans projection.
  if (def.name === "UpdatePlanDraft") {
    return ctx.permissionMode === "plan"
      ? { kind: "allow" }
      : { kind: "deny", reason: "UpdatePlanDraft is available only in plan mode." };
  }
  if (safety === "read-only") return { kind: "allow" };

  if (ctx.permissionMode === "plan") {
    return { kind: "deny", reason: `${def.name} is disabled in plan mode.` };
  }

  if (ctx.permissionMode === "bypass") return { kind: "allow" };

  if (ctx.permissionMode === "workspace-write") {
    if (safety === "workspace-write") return { kind: "allow" };
    if (safety === "external-state" || safety === "destructive") {
      return {
        kind: "ask",
        prompt: `${def.name} wants to perform a ${safety} action.`,
        suggestion: safety === "external-state" ? "allow_once" : "deny",
      };
    }
    return {
      kind: "deny",
      reason: `${def.name} is ${safety}; workspace-write mode only allows workspace edits.`,
    };
  }

  if (ctx.permissionMode === "auto-safe") {
    if (safety === "workspace-write") return { kind: "allow" };
    return {
      kind: "ask",
      prompt: `${def.name} wants to perform a ${safety} action.`,
      suggestion: safety === "external-state" ? "allow_once" : "deny",
    };
  }

  return {
    kind: "ask",
    prompt: `${def.name} wants to perform a ${safety} action.`,
    suggestion: safety === "workspace-write" ? "allow_once" : "deny",
  };
}

export function workspaceRoot(ctx: Pick<RichToolContext, "workspace">): string {
  return path.resolve(ctx.workspace);
}

export async function resolveWorkspacePath(
  ctx: Pick<RichToolContext, "workspace" | "pathPermissions" | "requestPermission" | "permissionMode">,
  inputPath: string | undefined,
  label = "path",
  access: PathAccess = "read",
): Promise<string> {
  const root = workspaceRoot(ctx);
  const candidate = path.resolve(root, inputPath ?? ".");
  if (!isInsideWorkspace(root, candidate) && !ctx.pathPermissions?.isAllowed(candidate, access)) {
    // Unleashed (bypass): the owner runs Ares on their own machine and points it
    // wherever they like (their Desktop, home dir, another repo). No
    // out-of-workspace permission ritual — that's exactly the friction the owner
    // posture drops. Mutation tools choose the target project's own transaction
    // root, so they edit there directly while retaining CAS/journal recovery.
    if (ctx.permissionMode === "bypass") return candidate;
    if (!ctx.requestPermission) {
      throw permissionDenied(`${label} escapes workspace and no permission prompt is available: ${candidate}`);
    }
    const decision = await ctx.requestPermission({
      toolName: "Filesystem",
      input: { path: candidate, access },
      reason: `${label} is outside the workspace: ${candidate}`,
      suggestion: "allow_once",
    });
    if (decision === "deny") {
      throw permissionDenied(`${label} denied outside workspace: ${candidate}`);
    }
    // Grant the containing DIRECTORY (for read/write), not just the one file,
    // even for allow_once. Rationale: when the owner points Ares at an
    // out-of-workspace project and approves it, they mean "work on this project"
    // — not "this single file." File-level once-grants are why fleets/subagents
    // died instantly on the SECOND file: leaves share this store but have no
    // prompt (deny-stub), so a sibling read they never individually approved was
    // hard-denied. Dir-scope makes an approved project usable by the whole
    // session incl. leaves. once vs always now differs only in persistence, not
    // breadth; execute stays file-level (grantRootFor returns the file for exec).
    const grantPath = await grantRootFor(candidate, access);
    const grantAccess = decision === "allow_always" && access === "execute" ? "all" : access;
    await ctx.pathPermissions?.grant(grantPath, grantAccess, decision === "allow_always" ? "always" : "once");
    if (!ctx.pathPermissions?.isAllowed(candidate, access)) {
      throw permissionDenied(`${label} not granted outside workspace: ${candidate}`);
    }
  }
  return candidate;
}

const MUTATION_ROOT_MARKERS = [
  ".git",
  ".hg",
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
] as const;

/** Choose the journal root for concrete files. Explicitly approved absolute
 * paths resolve to their own nearest project, so Ares mutates that project in
 * place instead of writing in one workspace and copying elsewhere. */
export async function mutationWorkspaceForPaths(
  activeWorkspace: string,
  targets: readonly string[],
): Promise<string> {
  if (targets.length === 0) return path.resolve(activeWorkspace);
  const active = path.resolve(activeWorkspace);
  const resolved = targets.map((target) => path.resolve(target));
  if (resolved.every((target) => containsMutationPath(active, target))) return active;

  const discovered = await Promise.all(resolved.map((target) => nearestMutationProjectRoot(target)));
  const markedRoots = [...new Set(
    discovered.filter((root): root is string => Boolean(root)).map(normalizeMutationRootKey),
  )];
  if (markedRoots.length === 1) {
    const root = discovered.find(
      (candidate) => candidate && normalizeMutationRootKey(candidate) === markedRoots[0],
    )!;
    if (resolved.every((target) => containsMutationPath(root, target))) return root;
  }
  if (markedRoots.length > 1) {
    throw new Error(
      `One atomic mutation cannot span multiple projects (${[...new Set(discovered.filter(Boolean))].join(", ")}). ` +
        "Run one edit/patch per project so each has its own recovery journal.",
    );
  }

  const common = commonMutationDirectory(resolved.map((target) => path.dirname(target)));
  if (!common || common === path.parse(common).root) {
    throw new Error("One atomic mutation cannot span unrelated filesystem roots. Run one edit per target project.");
  }
  return common;
}

async function nearestMutationProjectRoot(target: string): Promise<string | null> {
  const info = await fs.stat(target).catch(() => null);
  let current = info?.isDirectory() ? target : path.dirname(target);
  const home = path.resolve(os.homedir());
  for (let depth = 0; depth <= 4; depth++) {
    // A package/config marker in the owner's home does not make every Desktop
    // or temp file part of one giant project. Explicit files fall back to their
    // containing directory when no nearby repository marker exists.
    if (depth > 0 && normalizeMutationRootKey(current) === normalizeMutationRootKey(home)) return null;
    for (const marker of MUTATION_ROOT_MARKERS) {
      if (await fs.lstat(path.join(current, marker)).then(() => true, () => false)) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function commonMutationDirectory(directories: readonly string[]): string | null {
  if (directories.length === 0) return null;
  const roots = new Set(directories.map((directory) => normalizeMutationRootKey(path.parse(directory).root)));
  if (roots.size !== 1) return null;
  let candidate = path.resolve(directories[0]);
  while (!directories.every((directory) => containsMutationPath(candidate, path.resolve(directory)))) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

function normalizeMutationRootKey(candidate: string): string {
  const normalized = path.resolve(candidate);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function containsMutationPath(root: string, candidate: string): boolean {
  return normalizeMutationRootKey(root) === normalizeMutationRootKey(candidate) ||
    isInsideWorkspace(root, candidate);
}

async function grantRootFor(candidate: string, access: PathAccess): Promise<string> {
  const info = await fs.stat(candidate).catch(() => null);
  if (info?.isDirectory()) return candidate;
  if (access === "write" || access === "read") return path.dirname(candidate);
  return candidate;
}

function permissionDenied(message: string): Error {
  const err = new Error(message);
  err.name = "PermissionDeniedError";
  return err;
}

export function assertInsideWorkspace(root: string, candidate: string, label = "path"): void {
  if (isInsideWorkspace(root, candidate)) return;
  throw new Error(`${label} escapes workspace: ${candidate}`);
}

function isInsideWorkspace(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return true;
  }
  return false;
}

function normalizeProviderJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeProviderJsonSchema);
  if (!value || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (key === "default") continue;
    output[key] = normalizeProviderJsonSchema(child);
  }

  if (output.exclusiveMinimum === true && typeof output.minimum === "number") {
    output.exclusiveMinimum = output.minimum;
    delete output.minimum;
  } else if (output.exclusiveMinimum === false) {
    delete output.exclusiveMinimum;
  }

  if (output.exclusiveMaximum === true && typeof output.maximum === "number") {
    output.exclusiveMaximum = output.maximum;
    delete output.maximum;
  } else if (output.exclusiveMaximum === false) {
    delete output.exclusiveMaximum;
  }

  return output;
}
