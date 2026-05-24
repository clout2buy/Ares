# Crix v2 — Codex Build Spec

> **You are GPT-5.5 running in Codex.**
> Your job is to build Crix v2 inside `D:\Crix` from this spec.
> Read `docs/BLUEPRINT.md` first for design context; this doc is the *executable* plan.
> Work in tight commits. Verify after every step. Do not invent scope.

---

## 0. Operating Contract

### 0.1 You have these references locally — *read them, don't guess*

| Reference | Local path | What it's for |
|---|---|---|
| **Claude Code source** | `C:\Users\Clout\Downloads\claude-code-main\claude-code-main\src` | Patterns: streaming query, per-tool files, permission flow, Ink TUI, hooks |
| **Codex source (Rust)** | `C:\Users\Clout\Downloads\codex-main\codex-main\codex-rs` | **Vendor-with-attribution**: `apply-patch/`, `code-mode/`. Patterns: rollouts, sandbox, app-server split |
| **System-prompt archive** | `C:\Users\Clout\Downloads\system-prompts-and-models-of-ai-tools-main\system-prompts-and-models-of-ai-tools-main` | Pattern reference for tool schemas and prompt behavior. **Never copy verbatim prose into Crix.** |

**Rule:** before designing a subsystem, Read the equivalent file in the reference. Cite the path in the commit message (e.g. `// ported from claude-code-main/src/Tool.ts buildTool() pattern`). This keeps Crix grounded.

### 0.2 The platform

- **OS:** Windows 11. Use PowerShell syntax in scripts. Bash is available via `bash.exe` for cross-platform POSIX bits but PowerShell is default.
- **Node:** 22.x. **pnpm** package manager.
- **TypeScript:** 5.7+. Strict mode. ESM only (`"type": "module"`).
- **No Java. No bat shortcuts. No `JsonRecord`.**

### 0.3 Providers (day-one)

Only two:
1. **OpenAI ChatGPT OAuth + Responses API** (port the device-code flow from `packages/core/src/openaiAuth.ts` — that part of v1 works).
2. **Ollama Cloud** (via local Ollama at `http://127.0.0.1:11434`, which proxies to cloud). **3 concurrent model slots** — see Blueprint §8.2.

**Do not add Anthropic SDK provider.** User explicitly excluded it.

### 0.4 The contract you must hold

- **No `UpgradePlan` blob.** All model output is a streaming function-call loop.
- **One file per tool.** No 58KB monoliths.
- **Real zod schemas.** No `JsonRecord` typed `any`.
- **Real models only.** No `gpt-5.x-codex-spark`. Fetch from API at startup; if it fails, fail loud.
- **`pnpm verify` must pass after every commit.** No "WIP" commits that don't compile.

### 0.5 Per-commit checklist

Before `git commit`, verify ALL of:

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm check          # tsc --noEmit
pnpm test           # node --test
```

If any fails, fix before committing. If you can't fix, stop and ask.

---

## 1. Repo Reset (M0 — Day 1)

### 1.1 Initialize git (CRITICAL — repo is currently un-versioned)

```powershell
cd D:\Crix
git init
git config user.name "Crix Builder"
git config user.email "clout2buy@gmail.com"
```

Add comprehensive `.gitignore`:

```gitignore
node_modules/
dist/
*.tsbuildinfo
.crix/
java/
*.log
.DS_Store
Thumbs.db
*.lnk
.env*
!.env.example
```

Stage current state for posterity:

```powershell
git add -A
git commit -m "snapshot: Crix v1 before v2 rebuild"
git tag v1-archive
```

### 1.2 Delete dead weight

```powershell
Remove-Item -Recurse -Force java
Remove-Item "crix.bat - Shortcut.lnk"
Remove-Item -Recurse -Force .crix      # 86 stale sessions + 100 checkpoints
Remove-Item -Recurse -Force packages\core\src\kernel.ts, `
                            packages\core\src\turnEngine.ts, `
                            packages\core\src\turnIntent.ts, `
                            packages\core\src\agentRuntime.ts, `
                            packages\core\src\agents.ts, `
                            packages\core\src\providerToolLoop.ts, `
                            packages\core\src\providerResponse.ts, `
                            packages\core\src\providerNativeTools.ts, `
                            packages\core\src\promptPack.ts, `
                            packages\core\src\skillProcesses.ts, `
                            packages\core\src\toolCatalog.ts, `
                            packages\core\src\toolRuntime.ts, `
                            packages\core\src\toolScheduler.ts, `
                            packages\core\src\planPrompt.ts, `
                            packages\core\src\evidence.ts, `
                            packages\core\src\executor.ts, `
                            packages\core\src\editor.ts, `
                            packages\core\src\eventStore.ts, `
                            packages\core\src\pluginMarketplace.ts, `
                            packages\core\src\mcpClient.ts, `
                            packages\core\src\policy.ts, `
                            packages\core\src\systemPrompt.ts, `
                            packages\core\src\javaBridge.ts, `
                            packages\core\src\context.ts, `
                            packages\core\src\shellSafety.ts, `
                            packages\core\src\memory.ts, `
                            packages\cli\src\index.ts, `
                            packages\cli\src\fullscreenRenderer.ts, `
                            packages\cli\src\tuiRenderer.ts

Remove-Item docs\HARNESS_TARGET.md, docs\ARCHITECTURE.md, docs\PROMPT_PACK.md, `
            docs\REFERENCE_INSIGHTS.md, docs\REFERENCE_BOUNDARIES.md, `
            docs\PROVIDERS.md, docs\PROVIDER_INTEGRATION.md, docs\AGENTS.md, `
            docs\TYPESCRIPT_ARCHITECTURE.md, docs\SELF_UPGRADE_LOOP.md
```

Keep: `packages/core/src/{openaiAuth.ts, openaiResponses.ts, ollamaCloud.ts, paths.ts, util.ts}` for now — they have working pieces we'll refactor in M1.

Keep: `packages/protocol/src/types.ts` — will be rewritten in M0.3.

```powershell
git add -A
git commit -m "M0: delete v1 dead weight (kernel, turnEngine, monolithic CLI, java worker)"
```

### 1.3 Rewrite the protocol package

Replace `packages/protocol/src/types.ts` entirely. New shape:

```ts
// packages/protocol/src/types.ts
// Zero runtime deps. Pure types.

// ─── Messages ──────────────────────────────────────────────────────────
export type Role = "system" | "user" | "assistant" | "tool";

export interface TextBlock { type: "text"; text: string; }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown; }
export interface ToolResultBlock {
  type: "tool_result"; tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}
export interface ImageBlock { type: "image"; source: { kind: "url"; url: string } | { kind: "base64"; mediaType: string; data: string }; }
export interface SystemReminderBlock { type: "system_reminder"; text: string; }
export interface ThinkingBlock { type: "thinking"; text: string; signature?: string; }

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | SystemReminderBlock | ThinkingBlock;

export interface Message {
  id: string;
  role: Role;
  content: ContentBlock[];
  createdAt: string;
  metadata?: { source?: string; tokenCount?: number };
}

// ─── Stream Events (what providers yield) ──────────────────────────────
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; deltaJson: string }
  | { type: "tool_use_input_done"; id: string; input: unknown }
  | { type: "message_done"; message: Message; usage: Usage }
  | { type: "error"; error: { code: string; message: string; retriable: boolean } };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

// ─── Turn Events (what QueryEngine yields to CLI/TUI) ──────────────────
export type TurnEvent =
  | StreamEvent
  | { type: "turn_start"; turnId: string; sessionId: string }
  | { type: "tool_start"; id: string; name: string; input: unknown; providerHint?: ProviderHint }
  | { type: "tool_progress"; id: string; data: unknown }
  | { type: "tool_end"; id: string; output: unknown; touchedFiles?: string[]; durationMs: number }
  | { type: "tool_error"; id: string; error: string; durationMs: number }
  | { type: "permission_request"; id: string; toolName: string; input: unknown; reason: string }
  | { type: "permission_response"; id: string; decision: "allow_once" | "allow_session" | "deny" }
  | { type: "verify_scheduled"; files: string[] }
  | { type: "verify_finished"; ok: boolean; output: string }
  | { type: "system_reminder_injected"; text: string }
  | { type: "todo_updated"; todos: Todo[] }
  | { type: "checkpoint_created"; checkpointId: string; label?: string }
  | { type: "turn_end"; status: "completed" | "interrupted" | "failed"; usage: Usage; durationMs: number };

// ─── Tool Interface (per-tool contract) ────────────────────────────────
export type SafetyClass = "read-only" | "workspace-write" | "destructive" | "external-state";
export type Concurrency = "exclusive" | "parallel-safe";
export type ProviderHint = "reasoner" | "apply" | "summarize" | "user-main";

export interface ToolSchema {
  name: string;
  description: string;
  inputJsonSchema: object;   // JSON Schema for the provider
  safety: SafetyClass;
  concurrency: Concurrency;
  providerHint?: ProviderHint;
}

// (Tool<I,O> implementation interface lives in core, not protocol — keep protocol dep-free)

// ─── Permissions ───────────────────────────────────────────────────────
export type PermissionMode = "ask" | "auto-safe" | "workspace-write" | "bypass" | "plan";
export type PermissionDecision =
  | { kind: "allow"; reason?: string }
  | { kind: "ask"; prompt: string; suggestion?: "allow_once" | "allow_session" | "deny" }
  | { kind: "deny"; reason: string };

export interface PermissionRule {
  pattern: string;            // e.g. "Bash(git *)", "Edit(packages/secrets/**)"
  effect: "allow" | "ask" | "deny";
  source: "user-global" | "project" | "session";
}

// ─── Todos (TodoWrite tool format) ─────────────────────────────────────
export interface Todo {
  id: string;
  content: string;            // imperative ("Run tests")
  activeForm: string;         // present continuous ("Running tests")
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

// ─── Sessions / Rollouts ───────────────────────────────────────────────
export interface SessionMeta {
  id: string;
  workspace: string;
  provider: { name: string; model: string };
  createdAt: string;
  parentSessionId?: string;
  parentCheckpointId?: string;
}

export interface RolloutEntry {
  // One per stream event; appended live; replayable.
  ts: string;
  seq: number;
  event: TurnEvent;
}

export interface CheckpointMeta {
  id: string;                 // content-addressed: blake3 of manifest
  sessionId: string;
  turnSeq: number;
  parentCheckpointId?: string;
  label?: string;
  createdAt: string;
  fileManifest: Array<{ path: string; blobHash: string; mode: number }>;
}

// ─── Memory ────────────────────────────────────────────────────────────
export interface MemoryRecord {
  id: string;
  title: string;
  body: string;
  tags: string[];
  scope: "user" | "project";
  source: "user" | "agent" | "imported";
  createdAt: string;
  updatedAt: string;
}
```

Then `packages/protocol/src/index.ts`:

```ts
export * from "./types.js";
```

Drop `packages/protocol/src/schema.ts` entirely — schemas live with their tools now.

```powershell
git add -A
git commit -m "M0: rewrite protocol package with streaming-first types

- TurnEvent stream replaces UpgradePlan blob model
- ContentBlock matches Anthropic/OpenAI native shape for easy translation
- PermissionDecision is per-tool, not coarse mode-only
- CheckpointMeta is content-addressed for DAG rollouts"
```

### 1.4 Top-level pnpm workspace

Update `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/protocol"
  - "packages/core"
  - "packages/tools"
  - "packages/cli"
```

Create `packages/tools/package.json`:

```json
{
  "name": "@crix/tools",
  "version": "0.3.0-alpha.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc -b" },
  "dependencies": {
    "@crix/protocol": "workspace:*",
    "@crix/core": "workspace:*",
    "zod": "^3.23.0"
  }
}
```

Update root `package.json`:

```json
{
  "name": "crix",
  "version": "0.3.0-alpha.1",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "scripts": {
    "build": "tsc -b packages/protocol packages/core packages/tools packages/cli",
    "check": "tsc -b packages/protocol packages/core packages/tools packages/cli --pretty false",
    "test": "pnpm build && node --test tests/*.test.mjs",
    "crix": "node packages/cli/dist/entry.js",
    "verify": "pnpm check && pnpm test"
  }
}
```

```powershell
pnpm install
pnpm verify   # protocol-only build; should pass

git add -A
git commit -m "M0: add @crix/tools package, drop java verify step"
```

### 1.5 Stub the QueryEngine + mock provider

Create `packages/core/src/queryEngine.ts`:

```ts
import type { StreamEvent, TurnEvent, Message, Usage } from "@crix/protocol";

export interface Provider {
  name: string;
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent>;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: Array<{ name: string; description: string; input_schema: object }>;
  signal?: AbortSignal;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

export interface QueryEngineConfig {
  provider: Provider;
  model: string;
  systemPrompt: string;
  tools: Array<{ schema: { name: string; description: string; inputJsonSchema: object }; call: (input: unknown, signal: AbortSignal) => Promise<{ output: unknown; touchedFiles?: string[] }> }>;
  signal?: AbortSignal;
}

export class QueryEngine {
  private messages: Message[] = [];
  constructor(private readonly cfg: QueryEngineConfig, private readonly sessionId: string) {}

  appendUserMessage(text: string): void {
    this.messages.push({
      id: crypto.randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      createdAt: new Date().toISOString(),
    });
  }

  async *streamTurn(): AsyncGenerator<TurnEvent> {
    const turnId = crypto.randomUUID();
    const startedAt = Date.now();
    yield { type: "turn_start", turnId, sessionId: this.sessionId };

    let totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };

    // Per-turn loop: keep going until the assistant produces a message with no tool_use blocks.
    while (true) {
      const pendingToolUses: Array<{ id: string; name: string; input: unknown }> = [];
      let assistantMessage: Message | null = null;

      for await (const ev of this.cfg.provider.stream({
        model: this.cfg.model,
        system: this.cfg.systemPrompt,
        messages: this.messages,
        tools: this.cfg.tools.map(t => ({
          name: t.schema.name,
          description: t.schema.description,
          input_schema: t.schema.inputJsonSchema,
        })),
        signal: this.cfg.signal,
      })) {
        yield ev;
        if (ev.type === "tool_use_input_done") {
          pendingToolUses.push({ id: ev.id, name: this.findToolName(ev.id), input: ev.input });
        }
        if (ev.type === "message_done") {
          assistantMessage = ev.message;
          totalUsage = addUsage(totalUsage, ev.usage);
        }
      }

      if (!assistantMessage) throw new Error("provider closed stream without message_done");
      this.messages.push(assistantMessage);

      if (pendingToolUses.length === 0) {
        yield { type: "turn_end", status: "completed", usage: totalUsage, durationMs: Date.now() - startedAt };
        return;
      }

      // Execute tool calls (parallel-safe ones together; exclusive ones serial).
      const toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];
      for (const use of pendingToolUses) {
        const tool = this.cfg.tools.find(t => t.schema.name === use.name);
        if (!tool) {
          toolResults.push({ tool_use_id: use.id, content: `unknown tool: ${use.name}`, is_error: true });
          yield { type: "tool_error", id: use.id, error: "unknown tool", durationMs: 0 };
          continue;
        }
        const t0 = Date.now();
        yield { type: "tool_start", id: use.id, name: use.name, input: use.input };
        try {
          const { output, touchedFiles } = await tool.call(use.input, this.cfg.signal ?? new AbortController().signal);
          const durationMs = Date.now() - t0;
          yield { type: "tool_end", id: use.id, output, touchedFiles, durationMs };
          toolResults.push({ tool_use_id: use.id, content: typeof output === "string" ? output : JSON.stringify(output) });
        } catch (err) {
          const durationMs = Date.now() - t0;
          const message = err instanceof Error ? err.message : String(err);
          yield { type: "tool_error", id: use.id, error: message, durationMs };
          toolResults.push({ tool_use_id: use.id, content: message, is_error: true });
        }
      }

      this.messages.push({
        id: crypto.randomUUID(),
        role: "tool",
        content: toolResults.map(r => ({ type: "tool_result", tool_use_id: r.tool_use_id, content: r.content, is_error: r.is_error })),
        createdAt: new Date().toISOString(),
      });
      // loop continues; provider sees the new tool_result message.
    }
  }

  private findToolName(toolUseId: string): string {
    // Provider impls should have stashed the name on tool_use_start; this is a fallback.
    return "unknown";
  }
}

function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}
```

Create `packages/core/src/providers/mock.ts`:

```ts
import type { Provider, ProviderRequest } from "../queryEngine.js";
import type { StreamEvent, Message } from "@crix/protocol";

/** Deterministic mock for tests. Emits a single text response then ends. */
export class MockEchoProvider implements Provider {
  name = "mock";
  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const last = req.messages[req.messages.length - 1];
    const text = last?.role === "user" && last.content[0]?.type === "text"
      ? `echo: ${last.content[0].text}`
      : "echo";
    for (const chunk of text.match(/.{1,8}/g) ?? []) {
      yield { type: "text_delta", text: chunk };
    }
    const message: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: [{ type: "text", text }],
      createdAt: new Date().toISOString(),
    };
    yield { type: "message_done", message, usage: { inputTokens: 0, outputTokens: text.length } };
  }
}
```

Update `packages/core/src/index.ts`:

```ts
export * from "./queryEngine.js";
export * from "./providers/mock.js";
```

Create `packages/cli/src/entry.ts` (~50 lines):

```ts
#!/usr/bin/env node
import { QueryEngine, MockEchoProvider } from "@crix/core";

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "run") {
  const goalIdx = args.indexOf("--goal");
  const goal = goalIdx >= 0 ? args[goalIdx + 1] : "hello";
  const engine = new QueryEngine(
    { provider: new MockEchoProvider(), model: "mock", systemPrompt: "You are Crix.", tools: [] },
    crypto.randomUUID(),
  );
  engine.appendUserMessage(goal);
  for await (const ev of engine.streamTurn()) {
    process.stdout.write(JSON.stringify(ev) + "\n");
  }
} else {
  process.stderr.write("usage: crix run --goal \"<text>\"\n");
  process.exit(2);
}
```

Add `packages/cli/package.json`:

```json
{
  "name": "@crix/cli",
  "version": "0.3.0-alpha.1",
  "private": true,
  "type": "module",
  "main": "dist/entry.js",
  "bin": { "crix": "dist/entry.js" },
  "scripts": { "build": "tsc -b" },
  "dependencies": {
    "@crix/protocol": "workspace:*",
    "@crix/core": "workspace:*"
  }
}
```

Add `tests/m0-engine.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("M0: crix run emits turn_start, text_delta, message_done, turn_end", () => {
  const r = spawnSync("node", ["packages/cli/dist/entry.js", "run", "--goal", "ping"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  const events = r.stdout.trim().split("\n").map(JSON.parse);
  const types = events.map(e => e.type);
  assert.deepEqual(types[0], "turn_start");
  assert.ok(types.includes("text_delta"));
  assert.ok(types.includes("message_done"));
  assert.equal(types[types.length - 1], "turn_end");
});
```

```powershell
pnpm verify
git add -A
git commit -m "M0: stub QueryEngine + mock provider + crix run NDJSON output

- Streaming loop yields TurnEvent union (turn_start, text_delta, message_done, turn_end)
- Mock provider proves the loop shape without network
- pnpm verify green"
```

**M0 ship criteria** — all of these pass:
- [x] `git log` shows 4-5 commits with the v2 reset
- [x] `pnpm verify` exits 0
- [x] `node packages/cli/dist/entry.js run --goal hello` prints NDJSON ending with `turn_end`
- [x] `Get-ChildItem packages/core/src` shows no `kernel.ts`, no `turnEngine.ts`, no `toolRuntime.ts`

Stop. Confirm M0 with the user before starting M1.

---

## 2. Real Provider + Six Tools (M1 — Days 2-6)

### 2.1 Vendor Codex's `apply-patch` parser

Path to source: `C:\Users\Clout\Downloads\codex-main\codex-main\codex-rs\apply-patch\src\parser.rs`.

Port it to TypeScript at `packages/core/src/applyPatch/parser.ts`. The grammar:

```
*** Begin Patch
*** Update File: path/to/file
@@ optional context line
- old line
+ new line
*** End Patch
```

Also supports `*** Add File: path` (with `+lines`) and `*** Delete File: path`. See `parser.rs` lines 1-25 for the official grammar comment.

```ts
// packages/core/src/applyPatch/parser.ts
// Ported from codex-main/codex-rs/apply-patch/src/parser.rs (Apache-2.0).
// Original grammar:
//   start: begin_patch hunk+ end_patch
//   hunk: add_hunk | delete_hunk | update_hunk
//   ...

export type Hunk =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; movePath?: string; chunks: UpdateChunk[] };

export interface UpdateChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

export class ParseError extends Error { constructor(msg: string, public line?: number) { super(msg); } }

export function parsePatch(text: string): Hunk[] {
  // ... (implement strictly per parser.rs, including the lenient `<<'EOF' ... EOF` stripping)
}
```

Add `tests/m1-applyPatch.test.mjs` with at least 8 cases:
1. Add file
2. Delete file
3. Update file single chunk
4. Update file multi-chunk with `@@ class Foo` contexts
5. Update file at EOF (`*** End of File`)
6. Update + move (`*** Move to: newpath`)
7. Malformed: missing `*** End Patch` → ParseError
8. Lenient: `<<'EOF'\n*** Begin Patch ...\nEOF\n` → strips, parses successfully

Commit:

```
git commit -m "M1: vendor Codex apply-patch parser to TS with strict + lenient modes

Ported from codex-rs/apply-patch/src/parser.rs (Apache-2.0).
Handles GPT-4.1's heredoc-quoting bug via lenient mode."
```

### 2.2 Implement `Tool<I,O>` interface and shared helpers

Create `packages/tools/src/_shared.ts`:

```ts
import { z } from "zod";
import type { SafetyClass, Concurrency, ProviderHint, PermissionDecision, ToolSchema } from "@crix/protocol";

export interface ToolContext {
  workspace: string;
  signal: AbortSignal;
  permissionMode: import("@crix/protocol").PermissionMode;
  /** Per-tool callbacks. */
  fileReadStamps: Map<string, { mtimeMs: number; size: number }>;
  /** Provider pool, for tools that need a sub-model call. */
  subModel: import("@crix/core").OllamaCloudPool;
}

export interface ToolResult<O> {
  output: O;
  touchedFiles?: string[];
  /** Plain-text summary for inline display. */
  display?: string;
}

export interface Tool<I extends z.ZodTypeAny, O> {
  readonly schema: ToolSchema;
  readonly inputZod: I;
  checkPermissions(input: z.infer<I>, ctx: ToolContext): Promise<PermissionDecision>;
  call(input: z.infer<I>, ctx: ToolContext): Promise<ToolResult<O>>;
  /** Human-readable for the TUI spinner: "Reading foo.ts", "Running git status". */
  activityDescription(input: z.infer<I>): string;
}

export function buildTool<I extends z.ZodTypeAny, O>(def: {
  name: string;
  description: string;
  safety: SafetyClass;
  concurrency: Concurrency;
  providerHint?: ProviderHint;
  inputZod: I;
  checkPermissions?: (input: z.infer<I>, ctx: ToolContext) => Promise<PermissionDecision>;
  call: (input: z.infer<I>, ctx: ToolContext) => Promise<ToolResult<O>>;
  activityDescription: (input: z.infer<I>) => string;
}): Tool<I, O> {
  return {
    schema: {
      name: def.name,
      description: def.description,
      inputJsonSchema: zodToJsonSchema(def.inputZod),
      safety: def.safety,
      concurrency: def.concurrency,
      providerHint: def.providerHint,
    },
    inputZod: def.inputZod,
    checkPermissions: def.checkPermissions ?? (async () => ({ kind: "allow" })),
    call: def.call,
    activityDescription: def.activityDescription,
  };
}

function zodToJsonSchema(schema: z.ZodTypeAny): object { /* use `zod-to-json-schema` package */ }
```

Add `zod-to-json-schema` to `packages/tools/package.json` dependencies.

### 2.3 Build the six day-1 tools

One file each. **Patterns to reference:**

| New tool | Pattern from |
|---|---|
| `Read.ts` | `claude-code-main/src/tools/FileReadTool/` |
| `Write.ts` | `claude-code-main/src/tools/FileWriteTool/` |
| `Edit.ts` | `claude-code-main/src/tools/FileEditTool/` |
| `Bash.ts` | `claude-code-main/src/tools/BashTool/` |
| `Glob.ts` | `claude-code-main/src/tools/GlobTool/` |
| `Grep.ts` | `claude-code-main/src/tools/GrepTool/` |

Plus a Windows-first `PowerShell.ts` (no Claude Code equivalent — model after Bash but use `pwsh.exe` and emit PowerShell-specific guidance).

**Critical invariants:**

- `Read`: tracks `fileReadStamps` so `Edit` can verify the file hasn't changed since the model last saw it. If it has, return `is_error: true` with "file changed since last Read".
- `Edit`: rejects when `oldString` is not unique unless `replaceAll: true`.
- `Bash` / `PowerShell`: timeout default 120000ms, max 600000ms. Support `runInBackground`. Return a `shellId` for `BashOutput` / `KillShell` (M3).
- All file-touching tools: emit `touchedFiles` in result so the verifier scheduler can react.

Example skeleton for `Edit.ts`:

```ts
// packages/tools/src/Edit.ts
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool } from "./_shared.js";

const input = z.object({
  file_path: z.string().describe("Absolute path to the file to modify."),
  old_string: z.string().describe("Exact text to replace. Must be unique unless replace_all is true."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z.boolean().default(false),
});

export const EditTool = buildTool({
  name: "Edit",
  description: "Performs exact string replacements in files. Requires that you Read the file first in this session.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: input,
  activityDescription: (i) => `Editing ${path.basename(i.file_path)}`,
  async checkPermissions(i, ctx) {
    if (!ctx.fileReadStamps.has(i.file_path)) {
      return { kind: "deny", reason: `Read ${i.file_path} before editing it.` };
    }
    return { kind: "allow" };
  },
  async call(i, ctx) {
    const stat = await fs.stat(i.file_path);
    const stamp = ctx.fileReadStamps.get(i.file_path)!;
    if (stat.mtimeMs > stamp.mtimeMs + 5) {
      throw new Error(`${i.file_path} was modified on disk since last Read. Re-Read and retry.`);
    }
    const content = await fs.readFile(i.file_path, "utf8");
    const occurrences = content.split(i.old_string).length - 1;
    if (occurrences === 0) throw new Error(`old_string not found in ${i.file_path}`);
    if (occurrences > 1 && !i.replace_all) {
      throw new Error(`old_string is not unique in ${i.file_path} (${occurrences} matches). Provide more context or set replace_all: true.`);
    }
    const updated = i.replace_all ? content.split(i.old_string).join(i.new_string) : content.replace(i.old_string, i.new_string);
    await fs.writeFile(i.file_path, updated, "utf8");
    const newStat = await fs.stat(i.file_path);
    ctx.fileReadStamps.set(i.file_path, { mtimeMs: newStat.mtimeMs, size: newStat.size });
    return {
      output: { ok: true, replacements: i.replace_all ? occurrences : 1 },
      touchedFiles: [i.file_path],
      display: `Edited ${i.file_path}`,
    };
  },
});
```

### 2.4 Real providers

Refactor `packages/core/src/openaiResponses.ts` to expose a `Provider` interface per `queryEngine.ts`. It should:

- Use the Responses API (`POST /v1/responses` with `stream: true`)
- Pass tools as `tools: [{ type: "function", name, description, parameters }]`
- Translate Responses API SSE events to `StreamEvent` events
- Support `reasoning: { effort }` for o-series-and-up models
- Source model list from `GET /v1/models` at startup; cache 24h in `~/.crix/models.json`

Refactor `packages/core/src/ollamaCloud.ts` to expose `OllamaCloudPool` per Blueprint §8.2. Three slots: reasoner / apply / summarize. Each call awaits its slot's `inFlight` promise to respect the 3-concurrent cap.

### 2.5 Wire it up

Create `packages/core/src/session.ts`:

```ts
export class Session {
  constructor(
    readonly id: string,
    readonly workspace: string,
    readonly engine: QueryEngine,
    readonly rollout: Rollout,        // appends every TurnEvent to events.jsonl
  ) {}

  static async create(opts: { workspace: string; provider: Provider; model: string; tools: Tool<any, any>[] }): Promise<Session> { /* ... */ }

  async *send(text: string): AsyncGenerator<TurnEvent> {
    this.engine.appendUserMessage(text);
    for await (const ev of this.engine.streamTurn()) {
      await this.rollout.append(ev);
      yield ev;
    }
  }
}
```

Create `packages/core/src/rollout.ts`: append-only JSONL at `<workspace>/.crix/sessions/<id>/events.jsonl`.

Wire `packages/cli/src/entry.ts` to a real flow:

```ts
const provider = cmd === "--ollama"
  ? new OllamaCloudPool().reasoner()
  : new OpenAIResponsesProvider(await loadOAuthToken());
const session = await Session.create({ workspace: process.cwd(), provider, model, tools: [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool] });
for await (const ev of session.send(goal)) {
  process.stdout.write(JSON.stringify(ev) + "\n");
}
```

### 2.6 M1 ship criteria

```powershell
crix login                                              # device-code OAuth completes
crix run --goal "find all TODO comments and write them to TODOS.md"
# Output: NDJSON stream showing Glob, Grep, Write tool calls. TODOS.md exists at end.

crix run --provider ollama-cloud --model qwen3-coder:480b-cloud --goal "list all .ts files in packages/core"
# Output: NDJSON with Glob tool call result.
```

Add `tests/m1-realflow.test.mjs` using the mock provider plus a scripted tool-call sequence (no real network in tests).

Commit each tool separately + provider + session + integration. Final commit:

```
git commit -m "M1: ship streaming agent with 6 tools, OpenAI + Ollama Cloud providers

- Tools: Read, Write, Edit, Bash, PowerShell, Glob, Grep (one file each, zod schemas)
- OpenAI Responses API native function calling
- Ollama Cloud 3-slot pool (reasoner/apply/summarize)
- Sessions persist to .crix/sessions/<id>/events.jsonl
- Real model lists fetched from provider APIs at startup"
```

Stop. Confirm M1 with the user.

---

## 3. Ink TUI + Permissions (M2 — Days 7-11)

### 3.1 Install Ink

```powershell
pnpm add ink react @types/react -F @crix/cli
pnpm add -D @types/node -F @crix/cli
```

Use Ink 5.x. Module type: ESM. JSX runtime: React 18 automatic.

### 3.2 Build the REPL

`packages/cli/src/tui/App.tsx`:

```tsx
import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Session, type TurnEvent } from "@crix/core";

export const App: React.FC<{ session: Session }> = ({ session }) => {
  const [events, setEvents] = useState<TurnEvent[]>([]);
  const [input, setInput] = useState("");
  const [active, setActive] = useState(false);
  const { exit } = useApp();

  useInput((str, key) => {
    if (key.ctrl && str === "c") {
      if (active) session.interrupt();
      else exit();
      return;
    }
    if (key.return) {
      const text = input.trim();
      setInput("");
      if (!text) return;
      void runTurn(text);
      return;
    }
    if (key.backspace || key.delete) setInput(p => p.slice(0, -1));
    else if (str) setInput(p => p + str);
  });

  async function runTurn(text: string) {
    setActive(true);
    for await (const ev of session.send(text)) {
      setEvents(p => [...p, ev]);
    }
    setActive(false);
  }

  return (
    <Box flexDirection="column">
      {events.map((ev, i) => <EventRow key={i} event={ev} />)}
      <Box>
        <Text color={active ? "yellow" : "cyan"}>{active ? "⠋ " : "› "}</Text>
        <Text>{input}</Text>
        <Text color="gray">{active ? "  (Ctrl+C to interrupt)" : ""}</Text>
      </Box>
    </Box>
  );
};
```

Build per-event-type renderers in `packages/cli/src/tui/components/`:
- `TextDelta.tsx` — accumulates text_delta into a paragraph
- `ToolUseRow.tsx` — collapsible row with tool name + activity + status icon
- `ToolGroupRow.tsx` — when N consecutive Read/Grep/Glob calls, group into one expandable row
- `DiffView.tsx` — for Edit/Write results, show ± diff
- `PermissionDialog.tsx` — modal overlay with `[a]llow once / [s]ession / [d]eny`
- `SpinnerLine.tsx` — animated spinner with current activity description

### 3.3 Permission engine

Create `packages/core/src/permissions/`:

```
permissions/
├── engine.ts        # Match input against rules, return PermissionDecision
├── rules.ts         # Pattern parsing: "Bash(git *)", "Edit(packages/**)"
├── store.ts         # Load/save ~/.crix/permissions.json + project override
└── promptFlow.ts    # Bridge between tool's checkPermissions and TUI dialog
```

Rule matcher:

```ts
// "Bash(git *)" matches { tool: "Bash", args: { command: "git status" } }
// Use micromatch for glob in the inner pattern.
```

Wire into `QueryEngine.streamTurn()`: before calling each tool, run `engine.checkPermissions(toolName, input, mode, rules)`. If `ask`, yield `permission_request`, await `permission_response`. TUI handles the response by calling `session.respondToPermission(id, decision)`.

### 3.4 Hooks

Read `claude-code-main/src/hooks/` for pattern. Implement:

```ts
// packages/core/src/permissions/hooks.ts
export interface Hook { event: "PreToolUse" | "PostToolUse" | "SessionStart"; match?: string; command: string; }
// Load from `<workspace>/.crix/hooks.json` and `~/.crix/hooks.json`
// Run with env: { CRIX_TOOL_NAME, CRIX_TOOL_INPUT (JSON), CRIX_TOOL_PATH, CRIX_SESSION_ID }
// Non-zero exit on PreToolUse blocks the tool. Block messages surface to model as system_reminder.
```

### 3.5 M2 ship criteria

- `crix` (no args) launches the TUI REPL
- Type a goal, hit enter, see streaming output
- Run a Bash command — get a permission dialog
- `[a]llow once`, `[s]` for session, `[d]eny` all work
- `Ctrl+C` mid-tool interrupts the current turn (model sees an interruption tool_result)
- Hooks file with `PreToolUse: Bash(git push*) → exit 1` blocks `git push`

```
git commit -m "M2: Ink-based TUI REPL + per-tool permission engine + hooks"
```

---

## 4. Differentiators Round 1 (M3 — Days 12-18)

Tools to add: `TodoWrite`, `Task`, `ApplyIntent`, `CodebaseSearch`, `LSP`, `Verify` + continuous verifier.

### 4.1 TodoWrite

Match Claude Code's signature exactly (content + activeForm). Render in a side panel. Auto-derive from natural-language plans using the SUMMARIZE slot.

### 4.2 Task (subagent)

Pattern: `claude-code-main/src/tools/AgentTool/`. Scoped tool whitelist. Isolated `QueryEngine` instance. Persist transcript to `<workspace>/.crix/agents/<id>/`. Use the REASONER slot (or cheaper, configurable).

### 4.3 ApplyIntent (★)

Two-step: main model emits intent + `// ... existing code ...` sketch; APPLY slot materializes:

```ts
// packages/tools/src/ApplyIntent.ts
export const ApplyIntentTool = buildTool({
  name: "ApplyIntent",
  description: "Edit a file by describing the change in natural language plus a code sketch with `// ... existing code ...` markers for unchanged regions. Cheaper than Edit for large edits.",
  safety: "workspace-write",
  concurrency: "exclusive",
  providerHint: "apply",
  inputZod: z.object({
    target_file: z.string(),
    instructions: z.string().describe("First-person, single sentence describing the change."),
    code_edit: z.string().describe("The sketch with `// ... existing code ...` markers."),
  }),
  activityDescription: (i) => `Applying intent to ${path.basename(i.target_file)}`,
  async call(i, ctx) {
    const original = await fs.readFile(i.target_file, "utf8");
    const merged = await ctx.subModel.applyEdit({
      file: i.target_file,
      original,
      instructions: i.instructions,
      sketch: i.code_edit,
    });
    await fs.writeFile(i.target_file, merged, "utf8");
    return { output: { ok: true }, touchedFiles: [i.target_file], display: `Applied intent to ${i.target_file}` };
  },
});
```

The `subModel.applyEdit` method calls the APPLY slot with a system prompt:

```
You are an apply-model. Given an original file, an instruction, and a sketch using "// ... existing code ..." markers,
output ONLY the final file content. No commentary. No code fences.
```

Validate the output: must be longer than 50% of original (or have explicit Add markers); must not contain literal `// ... existing code ...`. On failure, raise a clear error so the model retries with `Edit`.

### 4.4 CodebaseSearch (★)

Build an embedding index of the workspace. Use Ollama Cloud's embedding model (`nomic-embed-text` is widely available). Persist to `<workspace>/.crix/index/` as:
- `embeddings.f32` — fp32 flat array
- `chunks.jsonl` — { path, startLine, endLine, hash, text } per row
- `meta.json` — { embedModel, dim, totalChunks }

Chunk strategy: tree-sitter for `.ts/.js/.py/.go/.rs/.java` (function and class granularity). For other text: 60-line windows with 10-line overlap. Re-index dirty chunks on file change (watch via `chokidar`).

Query: embed query → cosine top-k → return chunk text with path:line metadata. Tool schema with good/bad query examples from Cursor's `codebase_search`.

### 4.5 LSP tool

Bundle `typescript-language-server` and `vscode-json-languageserver` as optional deps. Detect more on workspace (`.tsconfig.json` → ts-ls, `pyproject.toml` → pyright, etc.). Expose composite tool:

```ts
inputZod: z.object({
  operation: z.enum(["go_to_definition", "go_to_references", "hover", "rename_symbol"]),
  file: z.string(),
  line: z.number(),
  column: z.number(),
  symbol: z.string().optional(),
  newName: z.string().optional(),    // for rename
})
```

### 4.6 Continuous Verifier (★ signature feature)

```ts
// packages/core/src/verifier/scheduler.ts
export class VerifierScheduler {
  private pending = new Set<string>();
  private debounce = setTimeout as any;
  private currentRun: { promise: Promise<VerifyResult>; abort: AbortController } | null = null;

  scheduleFor(files: string[], emit: (ev: TurnEvent) => void): void {
    files.forEach(f => this.pending.add(f));
    if (this.currentRun) this.currentRun.abort.abort();
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.run(emit), 800);
  }

  private async run(emit: (ev: TurnEvent) => void) {
    const files = [...this.pending];
    this.pending.clear();
    const cmds = this.deriveNarrowVerify(files);
    emit({ type: "verify_scheduled", files });
    const abort = new AbortController();
    const promise = runCommands(cmds, abort.signal);
    this.currentRun = { promise, abort };
    const result = await promise;
    this.currentRun = null;
    emit({ type: "verify_finished", ok: result.ok, output: result.output });
    if (!result.ok) {
      // Stash for next turn's system-reminder injection.
      this.pendingReminder = `Verification failed after recent edits:\n${result.output.slice(-2000)}`;
    }
  }

  drainReminder(): string | null { const r = this.pendingReminder; this.pendingReminder = null; return r; }

  private deriveNarrowVerify(files: string[]): Command[] {
    const cmds: Command[] = [];
    const tsFiles = files.filter(f => /\.(ts|tsx)$/.test(f));
    if (tsFiles.length) cmds.push({ program: "pnpm", args: ["tsc", "--noEmit", ...tsFiles] });
    const testFiles = files.filter(f => /\.test\.(ts|js|mjs)$/.test(f));
    if (testFiles.length) cmds.push({ program: "node", args: ["--test", ...testFiles] });
    // ... per-language rules
    return cmds;
  }
}
```

`QueryEngine.streamTurn()`: before yielding `turn_start`, check `verifier.drainReminder()`. If non-null, inject as a `system_reminder` content block on the assistant's first input. This is THE killer feature — the model **cannot** ignore CI failures.

### 4.7 M3 ship criteria

- `TodoWrite` populates a side panel; `[in_progress]` items get a spinner
- `Task({subagent_type: "general-purpose", prompt: "..."})` spawns isolated agent, returns summary
- `ApplyIntent` reduces token spend on multi-line edits by >50% vs `Edit` for the same change (measure with usage)
- `CodebaseSearch` returns relevant chunks in <500ms after warm index
- `LSP({operation: "go_to_definition", ...})` returns correct location
- Continuous verifier: edit a file with a type error → next user turn opens with `<system-reminder>` describing the failure

```
git commit -m "M3: TodoWrite, Task, ApplyIntent, CodebaseSearch, LSP, continuous verifier"
```

---

## 5. Differentiators Round 2 (M4 — Days 19-25)

### 5.1 FindAndEdit (★)

Spec from Devin's `find_and_edit`. Match regex → for each match, dispatch to APPLY slot with surrounding context (10 lines above/below) and the user instruction. Aggregate results.

```ts
inputZod: z.object({
  directory: z.string(),
  pattern: z.string().describe("Regex to find candidate locations."),
  instructions: z.string().describe("Plain-English description of the change. Per-location LLM may decline."),
  include_glob: z.string().optional(),
  exclude_glob: z.string().optional(),
})
```

Returns: `{ edited: string[]; skipped: Array<{path: string; reason: string}>; total_matches: number }`.

Parallelism: dispatch up to N parallel calls (default 5) but respect APPLY slot's single-concurrency from the pool — use a semaphore.

### 5.2 CodeMode (★)

Vendor from `codex-main/codex-rs/code-mode/src/description.rs` (read it for the exact prompt pattern). Implementation:

```ts
// packages/tools/src/CodeMode.ts
import { runInDeno } from "../runtime/denoIsolate.js";

export const CodeModeTool = buildTool({
  name: "exec",                    // match Codex's name
  description: CODE_MODE_DESCRIPTION,    // adapted from description.rs, but original prose
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: z.object({ code: z.string() }),
  activityDescription: () => "Running JavaScript orchestration",
  async call(i, ctx) {
    const pragma = parsePragma(i.code);  // { yield_time_ms, max_output_tokens }
    const toolApi = buildToolApi(ctx);   // exposes all other tools as `await tools.foo(...)`
    const result = await runInDeno(i.code, { globals: { tools: toolApi, text, image, store, load, notify }, timeoutMs: pragma.yield_time_ms ?? 10000 });
    return { output: result, display: `Ran ${result.toolCallCount} tool calls in ${result.durationMs}ms` };
  },
});
```

`packages/core/src/runtime/denoIsolate.ts` spawns a sandboxed Deno child process (`--no-net --no-write` except via injected tool API), communicates via stdin/stdout JSON-RPC. **Every tool call from inside the script still goes through `checkPermissions`.**

Pragma at top of input:

```js
// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}
const files = await tools.Glob({ pattern: "src/**/*.ts" });
const reads = await Promise.all(files.map(f => tools.Read({ file_path: f })));
return reads.filter(r => r.content.includes("TODO")).map(r => r.path);
```

### 5.3 DAG Rollouts

Switch rollout storage to content-addressed:

```
~/.crix/sessions/                  (global session index)
  └── <session-id>/
      ├── meta.json                 (SessionMeta)
      ├── events.jsonl              (TurnEvent stream, append-only)
      ├── checkpoints/
      │   ├── <ckpt-id>.json        (CheckpointMeta with blobHash list)
      │   └── ...
      └── parents.json              (optional: parent session/checkpoint refs)

~/.crix/blobs/                      (content-addressed blob store, shared across sessions)
  └── ab/cd/<blake3-hash>           (file blob content)
```

Commands:

```
crix session log                # current branch as text tree
crix session log --graph        # full DAG
crix session fork --from <ckpt> # new session branching off
crix session diff <a> <b>       # file-by-file diff between checkpoints
crix session rollback <ckpt>    # restore workspace files
```

### 5.4 Plan Mode

`EnterPlanMode` / `ExitPlanMode` tools. Activating Plan Mode sets `permissionMode = "plan"`, which denies every workspace-write/external-state tool. TUI shows yellow banner. `/accept` (slash command) exits plan mode and executes the proposed plan.

### 5.5 Diff View with hunk accept

When `Edit` / `Write` / `ApplyIntent` runs in `ask` mode, instead of binary allow/deny show a diff with per-hunk acceptance (`j`/`k` to navigate, `y`/`n`/`Y`/`N` keys). Accepted hunks compose into a new ApplyPatch.

### 5.6 M4 ship criteria

- One `FindAndEdit({pattern: "console\\.log\\(", instructions: "Replace with logger.debug()"})` call edits 30+ files in one tool invocation
- `exec({code: "..."})` runs JS with `await tools.Read(...)`; isolated; permissions enforced
- `crix session log --graph` shows multiple branches with current highlighted
- `crix session fork` creates a new branch; `crix session diff` shows file deltas
- Plan mode banner appears; non-read tools are denied with helpful messages

```
git commit -m "M4: FindAndEdit + CodeMode + DAG rollouts + Plan mode + hunk-accept diffs"
```

---

## 6. Skills, MCP, Sandboxing (M5 — Days 26-33)

### 6.1 Skills

Pattern: `claude-code-main/src/skills/` and the system-prompt archive's Kiro/Augment skill docs.

```
~/.crix/skills/<name>/
├── skill.json       { name, description, trigger_hints, tools_required, version }
└── SKILL.md         markdown the model reads when invoked
```

Bundled with `@crix/cli`:
- `git-commit`
- `git-pr`
- `code-review`
- `verify-and-fix`
- `upgrade-dependency`
- `init-onboarding`

Model invokes via `Skill({name: "git-commit"})`. Harness loads `SKILL.md` as a `system_reminder` for the rest of the turn.

### 6.2 MCP

Use `@modelcontextprotocol/sdk` for the client. Load from `~/.crix/mcp.json`:

```json
{
  "servers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  }
}
```

MCP tools translate to `Tool<I, O>` via JSON-Schema-to-zod. Deferred-loading: tools with `_meta['anthropic/alwaysLoad'] !== true` are hidden until `ToolSearch({query: "..."})` reveals them.

### 6.3 Sandboxing

Windows-first since this is the user's OS:

```ts
// packages/core/src/sandbox/windows.ts
import { spawn } from "node:child_process";

export function spawnSandboxed(cmd: string, args: string[], cwd: string, mode: "workspace-write" | "read-only" | "bypass") {
  if (mode === "bypass") return spawn(cmd, args, { cwd, env: process.env });
  // Use job-object via a tiny helper exe we ship (or `start /B` with cmd /C "icacls ... && cmd ...")
  // For v0.3 first cut: just spawn normally but enforce cwd boundary at the file-tool level.
  // Real JobObject sandbox is a stretch goal — file an issue if not done in M5.
}
```

For Linux/macOS sandboxing (when the day comes): `bwrap` and `sandbox-exec` respectively. Don't block M5 on it — Windows-first is fine.

### 6.4 ToolSearch

```ts
inputZod: z.object({
  query: z.string().describe("Either 'select:<name>[,<name>...]' for exact selection or keywords for fuzzy search."),
  max_results: z.number().default(5),
})
```

Returns the deferred tools' full schemas. Becomes callable for the rest of the session.

### 6.5 `crix doctor`

```
crix doctor
─ Provider auth
   OpenAI ChatGPT OAuth: ✓ token valid (expires 2026-06-15)
   Ollama Cloud: ✓ reachable at http://127.0.0.1:11434 (3 cloud models available)
─ Slots
   REASONER:   qwen3-coder:480b-cloud  ✓ ready
   APPLY:      qwen3-coder:30b-cloud   ✓ ready
   SUMMARIZE:  gpt-oss:20b-cloud       ✓ ready
─ Workspace
   .crix/: ✓ writable
   Workspace size: 14,328 files (~120MB) — embedding index ready
   Index status: ✓ warm (last updated 3min ago)
─ LSP
   typescript-language-server: ✓ v4.3.0
   pyright: not installed (optional)
─ Sandbox
   Windows JobObject support: ✓ (sandbox enabled for Bash/PowerShell in workspace-write mode)
```

### 6.6 M5 ship criteria

- `crix run --goal "open a PR for these changes" --skill git-pr` creates a real branch + PR
- `~/.crix/mcp.json` with a github server makes `mcp__github__*` tools appear
- `crix doctor` returns 0 with green checks on a freshly-set-up box
- `ToolSearch({query: "notebook"})` reveals deferred notebook tools

```
git commit -m "M5: skills + MCP + Windows sandbox + ToolSearch + crix doctor"
```

---

## 7. Polish + 0.3.0 (M6 — Days 34-40)

### 7.1 Public docs

Replace `docs/BLUEPRINT.md` and `docs/CODEX_BUILD_SPEC.md` references in `README.md` with a real user-facing `README.md`:

- One-line pitch
- 30-second quickstart (install, login, run)
- Provider section (OpenAI / Ollama Cloud)
- Tool reference
- Permissions / hooks
- Skills
- DAG sessions
- Comparison table vs Claude Code, Cursor, Codex, Continue

Move the build spec + blueprint to `docs/internal/`.

### 7.2 Benchmark suite

`benchmarks/` with fixed tasks comparable to other agents:
- `fix-failing-test.json` — repo with one failing test
- `add-feature.json` — implement a small feature against a spec
- `refactor-rename.json` — rename a symbol across 20 files
- `find-bug.json` — locate a bug given a stack trace

Run each task with Claude Code, Cursor agent, Codex, and Crix. Report tokens, wall time, and pass/fail per agent. **Publish results in the README.**

### 7.3 Distribution

```json
// packages/cli/package.json
{
  "files": ["dist/", "bin/", "skills/"],
  "bin": { "crix": "bin/crix.mjs" }
}
```

`bin/crix.mjs`:

```js
#!/usr/bin/env node
import("../dist/entry.js");
```

Publish:

```powershell
pnpm -F @crix/cli publish --access public
```

Also produce a single-file `crix.exe` via `pkg` or `node --experimental-sea-config` for users without Node.

### 7.4 Telemetry (opt-in)

Anonymous tool-use counts only. POST to a stats endpoint. **Off by default.** Enable via `~/.crix/config.json: { telemetry: true }`.

### 7.5 M6 ship criteria

- `npm i -g @crix/cli` → `crix login` → `crix` → working REPL on a clean Windows box
- README has a 30-second quickstart that *actually works* when followed verbatim
- Benchmark results published with at least one task where Crix wins on cost AND wall time
- Public GitHub repo at `crix-cli/crix` with releases page

```
git commit -m "M6: README, benchmarks, npm publish, single-file binary"
git tag v0.3.0
git push --tags
```

---

## 8. Patterns To Vendor (with attribution)

### From `codex-main` (Apache-2.0 — vendor-OK)

| Crix file | Codex source | What to port |
|---|---|---|
| `packages/core/src/applyPatch/parser.ts` | `codex-rs/apply-patch/src/parser.rs` | Whole parser: `*** Begin Patch` grammar, lenient mode for GPT-4.1 heredoc bug |
| `packages/core/src/applyPatch/apply.ts` | `codex-rs/apply-patch/src/lib.rs` | Hunk application logic with fuzzy context matching |
| `packages/tools/src/CodeMode.ts` | `codex-rs/code-mode/src/description.rs` and `runtime.rs` | The `exec` tool concept, pragma syntax, helper globals (text, image, store, load, notify, yield_control) |
| `packages/core/src/sandbox/policy.ts` | `codex-rs/execpolicy/` | Per-program shell command policy (read-only commands skip permission, etc.) |
| `packages/core/src/rollout.ts` | `codex-rs/rollout/` and `rollout-trace/` | Append-only JSONL rollout format |
| `packages/core/src/session.ts` (thread/turn) | `codex-rs/core/src/codex_thread.rs` and `thread_manager.rs` | Thread/turn item lifecycle |

**Every ported file must have a comment header:**

```ts
// Ported from codex-main/codex-rs/<path> (Apache-2.0).
// Original copyright: OpenAI, 2025.
// Adapted for TypeScript and Crix's tool interface.
```

Also add a `NOTICE` file at repo root crediting Codex.

### From `claude-code-main` (no public license file)

**Pattern reference only — do not copy code or prompt prose.** OK to reference design patterns:
- Per-tool file shape (Tool<Input, Output> with checkPermissions + call + render methods)
- TodoWrite content/activeForm semantics
- Permission rule patterns
- Hook events (PreToolUse/PostToolUse/SessionStart)
- DAG-of-todos thinking
- system-reminder injection pattern

When porting an idea, cite in commit message: "shape inspired by claude-code-main/src/<file>".

### From the system-prompt archive

**Patterns only — never paste prose.** Useful sources:
- Cursor's `codebase_search` good/bad query examples
- Augment's `codebase-retrieval` mandatory-before-edit discipline
- Devin's `<think>` enumerated must-use triggers
- Manus's event-stream module separation
- Amp's process management surface

---

## 9. What NOT To Do

Hard list. If you find yourself about to do any of these, stop.

1. **Don't add an `UpgradePlan` type.** The streaming loop is the contract.
2. **Don't create `toolRuntime.ts` or `toolCatalog.ts`.** Tools own their schema.
3. **Don't write a `JsonRecord` interface.** Use zod or proper types.
4. **Don't hardcode model names like `gpt-5.5`.** Fetch from API.
5. **Don't add a Java worker.** It's gone, leave it gone.
6. **Don't write a 12KB `promptPack.ts`.** The system prompt is ~2KB + per-tool descriptions.
7. **Don't write a `crix.bat - Shortcut.lnk`.** No desktop refugee artifacts.
8. **Don't create files in `.crix/` without GC.** Every persistent dir needs a `clean` strategy.
9. **Don't add subagents that share the parent's tool context.** Subagents get a scoped whitelist.
10. **Don't make permission decisions in `policy.ts`.** Per-tool `checkPermissions`.
11. **Don't write a 100-line system prompt that says "be good."** Use system-reminders, tool descriptions, and example-driven sections.
12. **Don't copy prompt prose verbatim from the system-prompt archive.** Patterns only.
13. **Don't `console.log` from inside `QueryEngine`.** Yield events. The CLI/TUI decides what to print.
14. **Don't add features mid-milestone.** Ship the milestone, then propose new work.
15. **Don't commit if `pnpm verify` fails.**

---

## 10. Stop-and-Ask Triggers

You **must** stop and ask the user when:

1. A milestone's ship criteria pass — confirm before starting the next.
2. You realize a tool/feature would need cross-milestone scope creep.
3. The reference source (codex/claude-code) does something differently from this spec, and you think their way is better.
4. An MVP shortcut would meaningfully delay a killer differentiator.
5. You hit a real platform issue (Windows JobObject, V8 isolate spawn, Ollama Cloud rate limit).
6. The user's intent for a specific tool is ambiguous after re-reading both this spec and BLUEPRINT.md.

When stopping, post a short note + the next 1-2 questions. Don't dump the whole status.

---

## 11. The Definition of Done for v0.3.0

A new user on a fresh Windows 11 box:

```powershell
winget install OpenJS.NodeJS.LTS pnpm Ollama.Ollama
ollama signin
ollama pull qwen3-coder:480b-cloud
npm install -g @crix/cli
crix login              # device-code OAuth in 30 seconds
crix                    # opens REPL
```

Then they ask: *"refactor the auth middleware in `src/middleware/auth.ts` to use the new sessions API in `src/sessions/`, run the tests, and open a PR."*

Crix:
1. Reads both files (REASONER streaming, visible in TUI).
2. Drafts a TodoWrite (3 items).
3. Calls `FindAndEdit` to update call sites (APPLY slot, parallel).
4. Verifier auto-runs `pnpm test src/middleware/__tests__/auth.test.ts` in the background.
5. Verifier fails → `system-reminder` next turn.
6. Model fixes failure, verifier passes.
7. Invokes `Skill({name: "git-pr"})` which creates branch, pushes, opens PR.
8. Returns the PR URL in 4 sentences.

End-to-end: under 90 seconds. Token cost: ~30% of what Claude Code spends on the same task (due to APPLY + SUMMARIZE slot offload). Visible in real-time in the TUI.

**That's v0.3.0.** Ship it.

---

## 12. One-Line Summary For Each Phase

| Phase | One-line goal |
|---|---|
| M0 | Burn it down. Get a streaming echo agent compiling. |
| M1 | Real streaming with 6 tools against OpenAI + Ollama Cloud. |
| M2 | Real TUI + real permissions. Feels like Claude Code. |
| M3 | Subagents + ApplyIntent + CodebaseSearch + continuous verifier. Feels better. |
| M4 | FindAndEdit + CodeMode + DAG sessions. Feels different. |
| M5 | Skills + MCP + sandbox + doctor. Feels complete. |
| M6 | README + benchmarks + npm publish. Feels shippable. |

Now build it.
