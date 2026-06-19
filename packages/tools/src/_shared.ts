// Tool<I, O> is the per-file tool contract used across @ares/tools.
//
// Every tool owns its schema, permission check, execution, and display text.

import path from "node:path";
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
import type { ToolCallContext, EngineToolResult } from "@ares/core";

export interface FileReadStamp {
  mtimeMs: number;
  size: number;
  /** sha256 of the file content at Read time. The mtime/size guard races on
   *  coarse-granularity filesystems (Windows mtime can be ~16ms); the hash is
   *  the exact "did this change since I last saw it" check Edit/Write use. */
  hash?: string;
  /** Total line count at Read time, so the re-read guard can report the real
   *  size instead of returning something indistinguishable from an empty file. */
  lines?: number;
}

/** Cheap, stable content hash for read-stamp staleness checks. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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
}

export type PathAccess = "read" | "write" | "execute" | "all";
export type PathGrantScope = "once" | "always";

export interface PathPermissionStore {
  isAllowed(absPath: string, access: PathAccess): boolean;
  grant(absPath: string, access: PathAccess, scope: PathGrantScope): Promise<void> | void;
}

export interface CommandPermissionStore {
  decide(toolName: string, command: string): PermissionDecision | null;
}

export interface SubModelPool {
  apply(req: { file: string; original: string; instructions: string; sketch: string }): Promise<string>;
  summarize(req: { input: string; instructions?: string }): Promise<string>;
}

export interface ToolResult<O> extends EngineToolResult {
  output: O;
  touchedFiles?: string[];
  display?: string;
  /** Images for the model to see (screenshots). See EngineToolResult.images. */
  images?: Array<{ mediaType: string; data: string }>;
}

export interface Tool<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  readonly schema: ToolSchema;
  readonly inputZod: I;
  checkPermissions(input: z.infer<I>, ctx: RichToolContext): Promise<PermissionDecision>;
  call(input: z.infer<I>, ctx: RichToolContext): Promise<ToolResult<O>>;
  activityDescription(input: z.infer<I>): string;
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
  inputZod: I;
  checkPermissions?: (input: z.infer<I>, ctx: RichToolContext) => Promise<PermissionDecision>;
  call: (input: z.infer<I>, ctx: RichToolContext) => Promise<ToolResult<O>>;
  activityDescription: (input: z.infer<I>) => string;
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
  };

  const checkPermissions = async (
    input: z.infer<I>,
    ctx: RichToolContext,
  ): Promise<PermissionDecision> => {
    const base = defaultPermissionDecision(def, ctx);
    if (base.kind !== "allow") return base;
    return def.checkPermissions ? def.checkPermissions(input, ctx) : base;
  };

  return {
    schema,
    inputZod: def.inputZod,
    checkPermissions,
    call: def.call,
    activityDescription: def.activityDescription,
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
    return throwToolInputError(retry.error, toolName);
  }
  return throwToolInputError(first.error, toolName);
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

export function adaptToolForEngine(
  tool: Tool<z.ZodTypeAny, unknown>,
  enrich: (base: ToolCallContext) => RichToolContext,
): { schema: ToolSchema; call: (input: unknown, ctx: ToolCallContext) => Promise<EngineToolResult> } {
  return {
    schema: tool.schema,
    async call(input, ctx) {
      const parsed = parseToolInputLenient(tool.inputZod, input, tool.schema.name);
      const rich = enrich(ctx);
      const decision = await tool.checkPermissions(parsed, rich);
      if (decision.kind === "deny") {
        throw new Error(decision.reason);
      }
      if (decision.kind === "ask") {
        if (!ctx.requestPermission) {
          throw new Error(`permission required: ${decision.prompt}`);
        }
        const answer = await ctx.requestPermission({
          toolName: tool.schema.name,
          input: parsed,
          reason: decision.prompt,
          suggestion: decision.suggestion,
        });
        if (answer === "deny") {
          const err = new Error(`permission denied: ${tool.schema.name}`);
          err.name = "PermissionDeniedError";
          throw err;
        }
      }
      const result = await tool.call(parsed, rich);
      return {
        output: result.output,
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

/** Commands that can erase data or discard uncommitted work. */
export function destructiveShellDecision(command: string): PermissionDecision | null {
  const normalized = command.replace(/\s+/g, " ").trim();
  const destructive =
    /(?:^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/i.test(normalized) ||
    /(?:^|[;&|]\s*)(?:rmdir|unlink|shred)\b/i.test(normalized) ||
    /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--)\b/i.test(normalized) ||
    /\b(?:mkfs(?:\.\w+)?|wipefs|format)\b/i.test(normalized) ||
    /\bRemove-Item\b/i.test(normalized) ||
    /(?:^|[;|]\s*)(?:del|erase|rd|rmdir)\s+(?:\/[a-z]+\s+)*/i.test(normalized) ||
    /\b(?:Clear-Disk|Format-Volume|Remove-Partition)\b/i.test(normalized);

  return destructive
    ? {
        kind: "ask",
        prompt: "This shell command can delete data or discard uncommitted work.",
        suggestion: "deny",
      }
    : null;
}

function defaultPermissionDecision<I extends z.ZodTypeAny, O>(
  def: ToolDef<I, O>,
  ctx: RichToolContext,
): PermissionDecision {
  if (def.safety === "read-only") return { kind: "allow" };

  if (ctx.permissionMode === "plan") {
    return { kind: "deny", reason: `${def.name} is disabled in plan mode.` };
  }

  if (ctx.permissionMode === "bypass") return { kind: "allow" };

  if (ctx.permissionMode === "workspace-write") {
    if (def.safety === "workspace-write") return { kind: "allow" };
    if (def.safety === "external-state" || def.safety === "destructive") {
      return {
        kind: "ask",
        prompt: `${def.name} wants to perform a ${def.safety} action.`,
        suggestion: def.safety === "external-state" ? "allow_once" : "deny",
      };
    }
    return {
      kind: "deny",
      reason: `${def.name} is ${def.safety}; workspace-write mode only allows workspace edits.`,
    };
  }

  if (ctx.permissionMode === "auto-safe") {
    if (def.safety === "workspace-write") return { kind: "allow" };
    return {
      kind: "ask",
      prompt: `${def.name} wants to perform a ${def.safety} action.`,
      suggestion: def.safety === "external-state" ? "allow_once" : "deny",
    };
  }

  return {
    kind: "ask",
    prompt: `${def.name} wants to perform a ${def.safety} action.`,
    suggestion: def.safety === "workspace-write" ? "allow_once" : "deny",
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
    // posture drops. Workspace checkpoints only cover files under the workspace,
    // so out-of-workspace targets rely on safeOverwrite's per-file pre-write
    // backup (.ares/backups) to stay reversible — plus the effects ledger.
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
    const grantPath = decision === "allow_always" ? await grantRootFor(candidate, access) : candidate;
    const grantAccess = decision === "allow_always" && access === "execute" ? "all" : access;
    await ctx.pathPermissions?.grant(grantPath, grantAccess, decision === "allow_always" ? "always" : "once");
    if (!ctx.pathPermissions?.isAllowed(candidate, access)) {
      throw permissionDenied(`${label} not granted outside workspace: ${candidate}`);
    }
  }
  return candidate;
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
