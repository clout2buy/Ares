// Tool<I, O> — the per-file tool contract used across @crix/tools.
//
// Every tool lives in its own file and is built via buildTool(). The shape
// is structurally compatible with @crix/core's EngineTool (the engine only
// needs `schema` and `call`), so tools plug straight in.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  ToolSchema,
  SafetyClass,
  Concurrency,
  ProviderHint,
  PermissionDecision,
  PermissionMode,
} from "@crix/protocol";
import type { ToolCallContext, EngineToolResult } from "@crix/core";

// ─── Context exposed to tool implementations ───────────────────────────

export interface FileReadStamp {
  mtimeMs: number;
  size: number;
}

/**
 * Extended context. EngineTool sees only ToolCallContext; tools that need
 * the richer surface (file stamps, sub-model pool) cast this in their
 * call() implementation. The engine populates it via the harness adapter.
 */
export interface RichToolContext extends ToolCallContext {
  permissionMode: PermissionMode;
  /** Files Read this session — used by Edit/Write to enforce read-before-write. */
  fileReadStamps: Map<string, FileReadStamp>;
  /** Sub-model pool for Apply / Summarize slots (Ollama Cloud). M3+. */
  subModel?: SubModelPool;
}

/** Forward decl for the 3-slot Ollama Cloud pool. Implemented in @crix/core M1.5. */
export interface SubModelPool {
  apply(req: { file: string; original: string; instructions: string; sketch: string }): Promise<string>;
  summarize(req: { input: string; instructions?: string }): Promise<string>;
}

// ─── Tool result ───────────────────────────────────────────────────────

export interface ToolResult<O> extends EngineToolResult {
  output: O;
  /** Absolute paths touched by this call; the verifier subscribes. */
  touchedFiles?: string[];
  /** Short human-readable summary for inline rendering. */
  display?: string;
}

// ─── Tool interface ────────────────────────────────────────────────────

export interface Tool<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  readonly schema: ToolSchema;
  readonly inputZod: I;

  /** Validate-then-decide. Called before call(); engine respects ask/deny. */
  checkPermissions(input: z.infer<I>, ctx: RichToolContext): Promise<PermissionDecision>;

  /** Execute the tool. Throw to signal failure; return ToolResult on success. */
  call(input: z.infer<I>, ctx: RichToolContext): Promise<ToolResult<O>>;

  /** Present-continuous label for the TUI spinner ("Reading foo.ts"). */
  activityDescription(input: z.infer<I>): string;
}

// ─── buildTool() factory ───────────────────────────────────────────────

export interface ToolDef<I extends z.ZodTypeAny, O> {
  name: string;
  description: string;
  safety: SafetyClass;
  concurrency: Concurrency;
  providerHint?: ProviderHint;
  deferLoading?: boolean;
  inputZod: I;
  checkPermissions?: (input: z.infer<I>, ctx: RichToolContext) => Promise<PermissionDecision>;
  call: (input: z.infer<I>, ctx: RichToolContext) => Promise<ToolResult<O>>;
  activityDescription: (input: z.infer<I>) => string;
}

export function buildTool<I extends z.ZodTypeAny, O>(def: ToolDef<I, O>): Tool<I, O> {
  const inputJsonSchema = zodToJsonSchema(def.inputZod, {
    target: "openApi3",
    $refStrategy: "none",
  }) as object;

  const schema: ToolSchema = {
    name: def.name,
    description: def.description,
    inputJsonSchema,
    safety: def.safety,
    concurrency: def.concurrency,
    providerHint: def.providerHint,
    deferLoading: def.deferLoading,
  };

  const checkPermissions =
    def.checkPermissions ??
    (async (_input: z.infer<I>, _ctx: RichToolContext): Promise<PermissionDecision> => ({
      kind: "allow",
    }));

  return {
    schema,
    inputZod: def.inputZod,
    checkPermissions,
    call: def.call,
    activityDescription: def.activityDescription,
  };
}

// ─── Engine adapter ────────────────────────────────────────────────────
// Tools implement RichToolContext; the engine only knows ToolCallContext.
// adaptToolForEngine wraps the rich call so the engine can invoke it with
// just its narrower context. The harness provides the rich fields when
// constructing the adapter.

export function adaptToolForEngine<I extends z.ZodTypeAny, O>(
  tool: Tool<I, O>,
  enrich: (base: ToolCallContext) => RichToolContext,
): { schema: ToolSchema; call: (input: unknown, ctx: ToolCallContext) => Promise<EngineToolResult> } {
  return {
    schema: tool.schema,
    async call(input, ctx) {
      const parsed = tool.inputZod.parse(input);
      const rich = enrich(ctx);
      const decision = await tool.checkPermissions(parsed, rich);
      if (decision.kind === "deny") {
        throw new Error(decision.reason);
      }
      // 'ask' is handled by the engine's permission flow (M2). For now,
      // a tool that returns 'ask' will still be executed — M2 wires the
      // prompt loop. We document this explicitly so it doesn't bite later.
      const result = await tool.call(parsed, rich);
      return {
        output: result.output,
        touchedFiles: result.touchedFiles,
        display: result.display,
      };
    },
  };
}

// ─── Common zod helpers ────────────────────────────────────────────────

export const zPath = z.string().min(1).describe("Absolute or workspace-relative path.");
export const zAbsPath = z.string().min(1).describe("Absolute filesystem path.");
