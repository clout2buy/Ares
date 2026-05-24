# Crix v2 — Blueprint

> "Don't build a harness that *describes* tools.
> Build a harness that *runs* them."

This document replaces `HARNESS_TARGET.md`, `ARCHITECTURE.md`, `PROMPT_PACK.md`, `REFERENCE_INSIGHTS.md`, and `SELF_UPGRADE_LOOP.md`. Those drift; this is the source of truth.

---

## 1. North Star

**Crix is a streaming coding-agent harness that beats Claude Code on cost, Codex on UX, and Cursor on extensibility — in a TypeScript codebase a single dev can hold in their head.**

It runs natively on Windows PowerShell, ships OpenAI ChatGPT OAuth + Ollama out of the box, and lets you bring your own model and your own tools without touching the core.

Three non-negotiables:

1. **Streaming everything.** No `UpgradePlan` blob. The model reasons, calls tools inline, sees results, calls more. The terminal renders the stream as it arrives.
2. **Per-tool sovereignty.** Each tool is one file: its zod schema, its permission check, its execution, its UI rendering. No more 58KB `toolRuntime.ts`. No more `JsonRecord`.
3. **Continuous verification.** After every edit, the narrowest affected test/typecheck/lint runs in the background. Failures land in the next turn as `system-reminder` items the model must address. The agent never claims "done" while CI is red.

---

## 2. Crix v1 Was the Wrong Shape

Roasted in detail elsewhere. The five fatal mistakes:

| # | What v1 did | Why it's broken |
|---|---|---|
| 1 | Provider returns `UpgradePlan` JSON, kernel executes it | Pre-streaming pattern. Kills inline reasoning, kills interruption-mid-step, kills cost optimization. |
| 2 | `toolRuntime.ts` is 58KB; `toolCatalog.ts` lists them separately | Schema/impl drift. New tools take a day. Permission checks live in policy, not tool. |
| 3 | `cli/src/index.ts` is 116KB | Unsplittable monolith. Every feature touches it. |
| 4 | Provider layer is 7 files reinventing function calling | OpenAI/Anthropic SDKs already do this. The wrapper hides the streaming primitives. |
| 5 | `promptPack.ts` is 19KB of cited prose | The model reads "be good" and continues being itself. Behavior must come from tools and policy, not bullet points. |

Cut bait. Start over with a small kernel and grow it.

---

## 3. What We Steal And From Whom

Honest attribution. Patterns only — no copied prose.

| Source | What we take | Why |
|---|---|---|
| **Claude Code 2.0** | Streaming loop shape; per-tool files; TodoWrite `content`/`activeForm`; `<example>`-driven prompt; `system-reminder` out-of-band channel; SlashCommand-as-tool; WebFetch with embedded sub-model; Git Safety Protocol | The gold standard for terminal coding agents. |
| **Codex (Rust)** | Apply-patch discipline; thread/rollout file format; native sandboxing primitives; code-mode (model writes JS that calls tools); app/server split; `execpolicy` per-program rules | Strongest correctness story; the only harness with real OS-level sandboxing. |
| **Cursor Agent 2.0** | Two-tier edit (intent model + apply model); `codebase_search` as primary exploration tool with good/bad query examples; `multi_tool_use.parallel` wrapper; `LINE_NUMBER|LINE_CONTENT` read format | Cheapest cost-per-edit. Apply-model pattern is a 70% token win on multi-line edits. |
| **Augment Code** | `codebase-retrieval` *mandatory* before edits; `git-commit-retrieval` for similar past changes; 20-minute-granularity tasks | Best context discipline. |
| **Devin** | Explicit `planning` vs `standard` mode toggle; `<think>` private scratchpad with enumerated must-use triggers; `find_and_edit` regex→per-location LLM; first-class LSP tools (`go_to_definition`, `go_to_references`, `hover_symbol`); `report_environment_issue` | `find_and_edit` is the killer refactor tool nobody else exposes well. |
| **Manus** | Event stream model (Message/Action/Observation/Plan/Knowledge); `notify` vs `ask` (non-blocking vs blocking) message tools; `todo.md` as user-visible plan file | Best clean separation of concerns inside a long-running loop. |
| **Amp / Augment** | Process management primitives (`launch_process`, `read_process`, `write_process`, `kill_process`, `list_processes`); diagnostics tool | Best long-running process surface. |
| **VSCode Agent** | IDE-grade diagnostics integration; chat-titles tool | Best LSP usage patterns. |
| **Windsurf / Junie / Trae** | Plan-mode UI ergonomics | Editable plans the user confirms. |

What we **do not** copy: any tool's prompt prose verbatim, any tool's branding, any tool's hidden instructions. Patterns and architecture only.

---

## 4. The Agent Loop

The whole agent in one diagram:

```
┌─────────────────────────────────────────────────────────────────┐
│  user input  ──►  Session.send(msg)                            │
│                       │                                         │
│                       ▼                                         │
│            QueryEngine.stream() ── AsyncGenerator<Event>       │
│              │                                                  │
│              │  yield: text_delta                              │
│              │  yield: tool_use_start { name, input_partial }  │
│              │  yield: tool_use_input_delta                    │
│              │  yield: tool_use_input_done { input }           │
│              │                                                  │
│              │  ┌── checkPermissions(tool, input, ctx)        │
│              │  │     ─► allow / deny / ask-user             │
│              │  │                                              │
│              │  ├── tool.call(input, ctx, signal)             │
│              │  │     ─► ToolResult<Output>                   │
│              │  │                                              │
│              │  ├── runBackgroundVerify(touchedFiles)          │
│              │  │     ─► future system-reminder injection      │
│              │  │                                              │
│              │  └── yield: tool_use_result { id, output }     │
│              │                                                  │
│              │  ► loop: feed result back to model              │
│              │                                                  │
│              ▼                                                  │
│         turn complete; persist to rollout                       │
└─────────────────────────────────────────────────────────────────┘
```

Code shape:

```ts
// packages/core/src/queryEngine.ts
export class QueryEngine {
  async *stream(req: TurnRequest): AsyncGenerator<TurnEvent> {
    const ctx = await this.buildContext(req);

    for await (const block of this.provider.stream({
      system: this.systemPrompt,
      messages: ctx.messages,
      tools: this.tools.map(t => t.schema),
    })) {
      switch (block.type) {
        case "text_delta":
          yield { type: "text_delta", text: block.text };
          continue;

        case "tool_use":
          const tool = findToolByName(this.tools, block.name);
          if (!tool) { yield this.toolNotFound(block); continue; }

          const decision = await tool.checkPermissions(block.input, ctx);
          if (decision.kind === "ask") {
            const verdict = await ctx.requestPrompt(decision.prompt);
            if (verdict !== "allow") { yield this.toolDenied(block, verdict); continue; }
          } else if (decision.kind === "deny") {
            yield this.toolDenied(block, decision.reason); continue;
          }

          yield { type: "tool_start", id: block.id, name: tool.name, input: block.input };

          try {
            const result = await tool.call(block.input, ctx, ctx.signal);
            yield { type: "tool_end", id: block.id, output: result.data };
            this.verifier.scheduleFor(result.touchedFiles ?? []);
          } catch (error) {
            yield { type: "tool_error", id: block.id, error };
          }
          continue;
      }
    }

    yield { type: "turn_end" };
  }
}
```

That's the whole core. ~150 lines once written. Everything else is tools and rendering.

---

## 5. File Layout

```
packages/
├── protocol/                       # Wire types only. Zero runtime deps.
│   ├── events.ts                  # TurnEvent union
│   ├── messages.ts                # Message types (text, tool_use, tool_result, system_reminder)
│   ├── tools.ts                   # Tool interface + ToolResult
│   ├── permissions.ts             # PermissionContext, PermissionDecision, Rule
│   ├── memory.ts                  # MemoryRecord
│   ├── todo.ts                    # Todo with content/activeForm
│   └── rollout.ts                 # Persistent session format
│
├── core/
│   ├── queryEngine.ts             # The loop (see §4)
│   ├── session.ts                 # Session lifecycle: rollout, compact, fork
│   ├── context.ts                 # System prompt assembly, message history, file state cache
│   ├── permissions/
│   │   ├── engine.ts              # Match input against rules → decision
│   │   ├── rules.ts               # Rule patterns: "Bash(git *)", "Edit(packages/secrets/**)"
│   │   ├── hooks.ts               # PreToolUse / PostToolUse shell hooks
│   │   └── promptFlow.ts          # Ask-user flow with persistence
│   ├── verifier/
│   │   ├── scheduler.ts           # Debounced background runner
│   │   ├── narrow.ts              # File-touched → minimal verify command
│   │   └── reminder.ts            # Inject failures as system-reminder
│   ├── memory/
│   │   ├── store.ts               # ~/.crix/memory/ file-based
│   │   └── search.ts              # Tag + simple full-text
│   ├── providers/
│   │   ├── provider.ts            # Provider interface (stream-only)
│   │   ├── openaiResponses.ts     # ChatGPT OAuth + Responses API
│   │   ├── openaiAuth.ts          # Device-code OAuth flow
│   │   ├── ollama.ts              # Local + Cloud Ollama
│   │   └── mock.ts                # Deterministic for tests
│   ├── sandbox/
│   │   ├── windows.ts             # JobObject + restricted token
│   │   ├── unix.ts                # bwrap (Linux) / seatbelt (mac)
│   │   └── policy.ts              # Per-program execpolicy
│   ├── workspace/
│   │   ├── fileCache.ts           # Last-read-stamp invariant
│   │   ├── checkpoint.ts          # Reversible writes via content-addressed store
│   │   └── apply.ts               # Apply intent / apply patch / multi-edit
│   ├── skills/
│   │   ├── loader.ts              # ~/.crix/skills/ + project-local
│   │   └── runtime.ts             # Skill invocation contract
│   └── lsp/
│       ├── client.ts              # tree-sitter + LSP-as-a-library
│       └── tools.ts               # go_to_definition / references / hover composite
│
├── tools/                          # ONE FILE PER TOOL.
│   ├── _shared.ts                 # Tool<Input,Output> helpers, buildTool()
│   ├── Read.ts
│   ├── Write.ts
│   ├── Edit.ts
│   ├── MultiEdit.ts
│   ├── ApplyPatch.ts
│   ├── ApplyIntent.ts             # ★ Cursor-style intent edit + apply-model
│   ├── Bash.ts
│   ├── PowerShell.ts              # Windows-first
│   ├── BashOutput.ts
│   ├── KillShell.ts
│   ├── Glob.ts
│   ├── Grep.ts
│   ├── CodebaseSearch.ts          # ★ Embedding-backed semantic search
│   ├── FindAndEdit.ts             # ★ Regex match → per-location apply-model
│   ├── Lints.ts                   # LSP diagnostics
│   ├── LSP.ts                     # go_to_definition / references / hover
│   ├── Task.ts                    # Spawn subagent
│   ├── TodoWrite.ts               # content/activeForm
│   ├── WebSearch.ts
│   ├── WebFetch.ts                # Fetch + sub-model summary
│   ├── Memory.ts                  # create/update/delete
│   ├── Skill.ts                   # Invoke skill by name
│   ├── CodeMode.ts                # ★ Model writes JS that calls tools as fns
│   ├── EnterPlanMode.ts
│   ├── ExitPlanMode.ts
│   ├── Verify.ts                  # Manual narrow verify
│   ├── Checkpoint.ts              # Explicit save point
│   ├── Rollback.ts                # Restore to checkpoint
│   ├── Notify.ts                  # Non-blocking user message
│   ├── Ask.ts                     # Blocking user question
│   ├── Browser.ts                 # Playwright-backed
│   ├── ReportEnvIssue.ts          # Structured env-issue report
│   └── ToolSearch.ts              # Deferred-tool loader (cost win)
│
├── cli/
│   ├── entry.ts                   # `crix` binary
│   ├── commands/
│   │   ├── run.ts                 # `crix run`
│   │   ├── login.ts               # `crix login`
│   │   ├── memory.ts              # `crix memory`
│   │   ├── sessions.ts            # `crix sessions ...`
│   │   ├── doctor.ts              # `crix doctor`
│   │   └── verify.ts              # `crix verify`
│   └── tui/                        # Ink-based.
│       ├── App.tsx                # Root REPL
│       ├── components/
│       │   ├── ToolUseRow.tsx
│       │   ├── DiffView.tsx       # Side-by-side, hunk-accept
│       │   ├── TodoPanel.tsx
│       │   ├── PermissionDialog.tsx
│       │   ├── PlanModeBanner.tsx
│       │   └── SpinnerLine.tsx
│       ├── hooks/
│       │   ├── useStream.ts       # Subscribe to QueryEngine.stream()
│       │   ├── useKeybindings.ts
│       │   └── useInterruptions.ts
│       └── theme.ts
│
└── skills/                         # Bundled skills (markdown + JSON spec)
    ├── git-commit/
    ├── git-pr/
    ├── code-review/
    ├── verify-and-fix/
    └── upgrade-dependency/
```

No `java/`. Deleted.
No `agentRuntime.ts`, no `kernel.ts`, no `turnEngine.ts`, no `providerToolLoop.ts`. Replaced by `queryEngine.ts`.

---

## 6. The Tool Surface

| Tool | Category | Safety | Concurrency | Key trait |
|---|---|---|---|---|
| `Read` | context | read-only | parallel | line range, image, PDF, notebook; tracks read-stamp |
| `Write` | edit | workspace-write | exclusive | requires prior Read; checkpoint |
| `Edit` | edit | workspace-write | exclusive | exact-string replace, requires unique match |
| `MultiEdit` | edit | workspace-write | exclusive | atomic batched edits in one file |
| `ApplyPatch` | edit | workspace-write | exclusive | unified diff, cross-file |
| **`ApplyIntent`** | edit | workspace-write | exclusive | model writes intent + `// ... existing ...`, apply-model materializes |
| `Bash` / `PowerShell` | shell | varies | exclusive | sandbox, timeout, background |
| `BashOutput` / `KillShell` | shell | read-only / destructive | parallel | manage backgrounded shells |
| `Glob` | context | read-only | parallel | sorted by mtime |
| `Grep` | context | read-only | parallel | ripgrep with context lines |
| **`CodebaseSearch`** | context | read-only | parallel | embedding index, semantic queries |
| **`FindAndEdit`** | edit | workspace-write | exclusive | regex match → per-location apply-model |
| `Lints` | context | read-only | parallel | LSP diagnostics per file |
| `LSP` | context | read-only | parallel | go_to_definition / references / hover |
| `Task` | agent | scoped | exclusive | subagent with tool whitelist |
| `TodoWrite` | task | workspace-write | parallel | content + activeForm |
| `WebSearch` / `WebFetch` | web | external-state | parallel | fetch summarizes with cheap model |
| `Memory` | memory | workspace-write | parallel | create/update/delete; tag search |
| `Skill` | skill | varies | exclusive | invoke discoverable workflow |
| **`CodeMode`** | meta | workspace-write | exclusive | model writes JS using tools as functions |
| `EnterPlanMode` / `ExitPlanMode` | meta | read-only | exclusive | plan-mode toggle (read-only enforced) |
| `Verify` | verification | read-only | exclusive | narrow verify on touched files |
| `Checkpoint` / `Rollback` | safety | workspace-write | exclusive | DAG node + restore |
| `Notify` / `Ask` | comms | read-only | parallel | non-blocking + blocking user msg |
| `Browser` | browser | external-state | exclusive | Playwright with `crixid` attrs |
| `ReportEnvIssue` | comms | read-only | parallel | structured "your env is broken" |
| `ToolSearch` | meta | read-only | parallel | load deferred tools by query |

Tools marked **★** are Crix's differentiators (see §7).

---

## 7. The Five Killer Differentiators

### 7.1 ApplyIntent — Two-Tier Edit (the cost win)

**Pattern from Cursor.** Most edits to existing files cost a fortune because the model has to emit the whole edited region. Cursor's trick: the main expensive model emits a sketch with `// ... existing code ...` markers, and a cheap fast apply-model materializes the real edit.

```ts
// tools/ApplyIntent.ts
inputSchema: z.object({
  target_file: z.string(),
  instructions: z.string(),  // first-person, single sentence
  code_edit: z.string(),     // sketch with `// ... existing code ...` markers
})
```

In Crix we use a small Ollama model (`qwen3-coder` or `qwen2.5-coder:7b`) locally for the apply step. **Zero cloud cost.** First-token-latency under 200ms. Net effect: edits cost the same as reads.

Fallback: if apply-model fails or diff is ambiguous, fall back to `Edit` with a forced re-read.

### 7.2 FindAndEdit — Regex → Per-Location LLM

**Pattern from Devin.** Refactors that touch 30 files become one tool call. Model gives a regex and a single-paragraph instruction. Crix matches the regex repo-wide, dispatches each match location to a cheap apply-model with the surrounding context, and reports a manifest.

```ts
// tools/FindAndEdit.ts
inputSchema: z.object({
  dir: z.string(),
  regex: z.string(),
  instructions: z.string(),
  exclude_glob: z.string().optional(),
  file_extension_glob: z.string().optional(),
})
```

Returns: `{ edited: string[], skipped: Array<{path,reason}>, total_matches: number }`. The dispatch LLM can decline to edit a location ("doesn't match the intent"), so false positives in the regex are fine.

### 7.3 CodeMode — Model Writes JS That Calls Tools

**Pattern from Codex (`code-mode/`).** Instead of N `tool_use` JSON blocks, the model writes one JavaScript snippet that calls tools as plain functions. For batched operations the token savings are enormous.

```ts
// model emits:
const files = await glob({ pattern: "src/**/*.ts" });
const results = await Promise.all(
  files.map(f => read({ path: f }))
);
const matches = results.filter(r => r.content.includes("deprecated"));
return matches.map(m => m.path);
```

Crix evaluates this in a hardened Deno/V8 isolate with the tool API injected as globals. Each tool call inside the snippet **still goes through `checkPermissions`** — the sandbox just removes the per-call streaming overhead.

When to use: tool calls with cardinality > 3, or any branching/aggregation logic.

### 7.4 Continuous Verification (the signature)

After every successful edit tool call, the verifier:

1. Computes the *narrowest* affected verify command:
   - touched `.ts` → `tsc --noEmit <those files>`
   - touched `*.test.*` → `node --test <that file>` (or `vitest run <that file>`)
   - touched `*.py` → `ruff check <that file>` + `pytest <that file>` if importable
   - touched anything → `git diff --check` (whitespace)
2. Runs it in the background (debounced 800ms; cancellable).
3. On failure, queues a `system-reminder` to be injected **at the top of the next user/model turn**:

```
<system-reminder>
Verification failed after your last edits. Address before continuing.

  tsc: packages/core/src/queryEngine.ts:42:18
    Type 'string' is not assignable to type 'TurnEvent'.

The relevant change was:
  packages/core/src/queryEngine.ts L40-50
</system-reminder>
```

The model literally cannot claim "done" while red. The harness enforces it.

No competitor does this. Claude Code requires manual `npm test`; Codex requires you to ask. Crix makes it the default.

### 7.5 Conversation as a DAG (rollouts with branches)

Every checkpoint is a node. The session log isn't a list, it's a graph.

```
session-root
├── turn-1 ──► chk-A
│              ├── turn-2a ──► chk-B  (you tried approach A, abandoned)
│              └── turn-2b ──► chk-C ──► turn-3 ──► chk-D  (current)
```

Commands:

```powershell
crix session log                       # show DAG (current branch highlighted)
crix session fork --from chk-B         # branch off an old checkpoint
crix session diff chk-D chk-B          # diff proofs/files between nodes
crix session compact                   # collapse linear runs, keep DAG shape
crix session rollback chk-C            # restore workspace to a node
```

Storage: content-addressed (blake3). Same file content across forks shares storage. A 500-turn session with 50 branches is ~80MB instead of 5GB.

Codex has rollouts (linear). Claude Code has compaction (linear). Nobody has the branching primitive at the harness level.

---

## 8. Provider Integration

### 8.1 OpenAI ChatGPT OAuth + Responses API

Keep the device-code OAuth flow Crix v1 has — that part actually worked. Rip out the JSON-envelope wrappers and use **native streaming function calling** via the Responses API.

```ts
// packages/core/src/providers/openaiResponses.ts
async *stream(req: ProviderRequest): AsyncGenerator<ProviderBlock> {
  const res = await fetch(this.endpoint, {
    method: "POST",
    headers: { ...this.auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      input: req.messages,
      tools: req.tools.map(toResponsesToolSchema),
      stream: true,
      reasoning: { effort: req.reasoningEffort ?? "medium" },
    }),
    signal: req.signal,
  });
  for await (const event of parseSSE(res.body)) {
    yield translateResponsesEvent(event);
  }
}
```

Model list — **real models only.** Drop the fake `gpt-5.x-codex-spark` lineup. Source the actual list from the Responses API `/models` endpoint at startup and cache for 24h. If the list ships, it ships; we don't hallucinate it.

Token storage: `%USERPROFILE%\.crix\auth.json` (per v1). Refresh on 401.

### 8.2 Ollama Cloud (the 3-slot architecture)

Routed through local `http://127.0.0.1:11434` which proxies to Ollama Cloud. Ollama Cloud allows **3 concurrent model invocations per account**, which we exploit as three distinct roles:

| Slot | Default model | Purpose | Cost/Latency profile |
|---|---|---|---|
| **REASONER** | user choice: `qwen3-coder:480b-cloud`, `kimi-k2:cloud`, `deepseek-v3.1:cloud`, `gpt-oss:120b-cloud` | Main agent loop. Streams text + tool calls. | Most capable, slowest. |
| **APPLY** | `qwen3-coder:30b-cloud` (smaller cloud) or `qwen2.5-coder:32b-cloud` | Materialize `ApplyIntent` sketches; per-location LLM for `FindAndEdit`. | Fast, cheap, code-focused. |
| **SUMMARIZE** | `gpt-oss:20b-cloud` or `qwen2.5:7b` | WebFetch page summary, tool-result compaction, todo-derivation, commit messages. | Tiny, instant. |

```ts
// packages/core/src/providers/ollamaCloud.ts
export class OllamaCloudPool {
  private slots = new Map<SlotName, { model: string; inFlight: Promise<unknown> | null }>();

  constructor(host = "http://127.0.0.1:11434") {
    this.slots.set("reasoner", { model: env.CRIX_REASONER, inFlight: null });
    this.slots.set("apply",    { model: env.CRIX_APPLY    ?? "qwen3-coder:30b-cloud", inFlight: null });
    this.slots.set("summarize",{ model: env.CRIX_SUMMARIZE ?? "gpt-oss:20b-cloud",     inFlight: null });
  }

  async *stream(slot: SlotName, req: ProviderRequest): AsyncGenerator<ProviderBlock> {
    // Ollama Cloud caps at 3 concurrent. If this slot is busy, await.
    const s = this.slots.get(slot)!;
    if (s.inFlight) await s.inFlight;
    const work = this.dispatch(s.model, req);
    s.inFlight = work.done;
    try { yield* work.stream; } finally { s.inFlight = null; }
  }
}
```

The pool means the agent can do all three in parallel: REASONER produces the next instruction while APPLY materializes the previous edit and SUMMARIZE compresses an oversized tool result. **End-to-end latency drops below single-model harnesses** because the slow steps overlap.

Discovery: at startup, `GET /api/tags` lists what's actually available. We never hard-code a fake lineup. If the user's account doesn't have a cloud model, we surface a clear error pointing at `ollama.com/search?c=cloud`.

### 8.3 Provider Routing Per Tool

Each tool declares which slot it wants. The route table is the single biggest cost lever and nobody else exposes it cleanly.

```ts
// packages/tools/_shared.ts — Tool interface adds:
export type ProviderHint = "reasoner" | "apply" | "summarize" | "user-main";

// per tool:
ApplyIntent.providerHint = "apply"
FindAndEdit.providerHint = "apply"      // dispatched per-location
WebFetch.providerHint    = "summarize"
TodoWrite.providerHint   = "summarize"  // for auto-derive-todos
CodeMode.providerHint    = "user-main"
Task.providerHint        = "reasoner"   // subagents get cheap reasoner by default
```

If the user is on **ChatGPT OAuth for the main loop**, the apply/summarize slots can *still* run in parallel on Ollama Cloud — best of both worlds. If they're fully on Ollama Cloud, all three slots are utilized.

---

## 9. TUI Design (Ink)

Why Ink: React for the terminal. Grouped tool calls, inline diffs, expandable results, all become components instead of ANSI string-fu.

### 9.1 Screens

- **REPL** (default): streaming chat, tool calls inline as collapsible rows, todo panel on the right, spinner on active tool.
- **Plan-mode banner**: yellow border, "READ-ONLY · plan mode active · /accept to execute".
- **Permission dialog**: full-width overlay; `[a]llow once / [s]ession / [d]eny`.
- **Diff view**: hunk-accept (`j`/`k` to navigate, `y`/`n` per hunk, `Y`/`N` for whole file).
- **Session DAG** (`/sessions`): tree-drawn graph of branches, navigate with arrows, enter to load.
- **Doctor** (`/doctor`): provider auth, ollama reachable, sandbox capability, LSP servers detected.

### 9.2 Key Bindings (defaults)

| Key | Action |
|---|---|
| `Ctrl+C` | Interrupt current tool (queues "stop" intervention) |
| `Ctrl+D` | Exit |
| `Esc Esc` | Hard cancel current turn |
| `/` | Slash command picker (fuzzy) |
| `Ctrl+R` | Browse session DAG |
| `Ctrl+Y` | Accept current pending diff |
| `Ctrl+N` | Reject current pending diff |
| `Shift+Tab` | Cycle: ask → auto-safe → workspace-write → ask |
| `Up`/`Down` (in input) | History |

### 9.3 Tool Call Rendering

Grouped collapsed by default:

```
● Read (3)
  src/queryEngine.ts · 412 lines
  src/session.ts · 89 lines
  src/permissions/engine.ts · 134 lines

● Edit
  src/queryEngine.ts:42
  ─ const event: string  →  const event: TurnEvent

⠋ Verify  tsc --noEmit src/queryEngine.ts ... (2.1s)
```

After verify finishes:

```
✓ Verify  tsc clean (2.4s)
```

After verify fails:

```
✗ Verify  tsc: 1 error  [↵ expand]
```

---

## 10. Safety & Permissions

### 10.1 Modes

| Mode | Default for | Behavior |
|---|---|---|
| `ask` | Interactive REPL | Every workspace-write or external-state tool prompts |
| `auto-safe` | After 3 successful asks of same pattern | Auto-approve matching tools, ask for novel ones |
| `workspace-write` | `crix run --auto` non-interactive | Allow workspace-write without ask; deny external |
| `bypass` | Explicit `--bypass` flag | Allow everything in current workspace, no prompts |
| `plan` | Inside EnterPlanMode | Reject any non-read tool |

### 10.2 Rules

Pattern-based, JSON, persisted to `~/.crix/permissions.json` and `<workspace>/.crix/permissions.json` (project override).

```jsonc
{
  "alwaysAllow": [
    "Bash(git status)", "Bash(git diff*)", "Bash(git log*)",
    "Bash(npm test)", "Bash(npm run *)",
    "Read(*)", "Glob(*)", "Grep(*)",
    "Edit(src/**)"
  ],
  "alwaysAsk": [
    "Bash(git push*)", "Bash(rm -rf *)",
    "Write(.env*)", "Write(**/credentials*)"
  ],
  "alwaysDeny": [
    "Bash(curl * | sh)", "Bash(sudo *)",
    "Read(**/.ssh/**)", "Read(**/.aws/**)"
  ]
}
```

Match order: deny > ask > allow > mode default.

### 10.3 Hooks

Shell commands triggered on tool events. From `.crix/hooks.json`:

```jsonc
{
  "PreToolUse": [
    { "match": "Bash(git commit*)", "command": "npm run lint" }
  ],
  "PostToolUse": [
    { "match": "Edit(**)", "command": "npm run format -- $CRIX_TOOL_PATH" }
  ],
  "SessionStart": [
    { "command": "git fetch origin" }
  ]
}
```

If the hook exits non-zero, the tool is blocked (PreToolUse) or warned about (PostToolUse).

### 10.4 Sandboxing

- **Windows**: spawned shells run inside a Job Object with a restricted token (no write outside workspace dir tree, no network unless `--allow-network`).
- **Linux**: `bwrap` chroot to workspace + read-only system bins.
- **macOS**: `sandbox-exec` with a generated profile.

Sandboxing is on by default for `Bash`/`PowerShell` in `workspace-write` mode and below. `bypass` mode disables sandboxing per shell call (with banner warning in TUI).

---

## 11. Skills, Hooks, MCP

### 11.1 Skills

A skill is a discoverable workflow the model can invoke by name. Located in `~/.crix/skills/<name>/` or `<workspace>/.crix/skills/<name>/`.

```
~/.crix/skills/
├── git-commit/
│   ├── skill.json           # { name, description, trigger_hint, tools_required }
│   └── SKILL.md             # the actual instructions the model reads
├── code-review/
│   └── ...
└── verify-and-fix/
    └── ...
```

The model sees skills as a single tool: `Skill({name: "git-commit"})`. The harness loads `SKILL.md` into the conversation as a `system-reminder`. The model then executes the workflow using its normal tool set.

Bundled skills:
- `git-commit` — diff, message, commit (matches Claude Code's commit protocol)
- `git-pr` — branch, push, gh pr create
- `code-review` — diff vs base, structured findings
- `verify-and-fix` — run verifier, address each failure
- `upgrade-dependency` — find usages, update, run tests
- `init-onboarding` — write CLAUDE.md / AGENTS.md analogue

### 11.2 Hooks

See §10.3. Same shape as Claude Code's hooks — intentional, so users with `.claude/settings.json` muscle memory can migrate.

### 11.3 MCP

`Tool` interface accepts MCP servers as tool sources. Each MCP tool becomes a `Tool<>` with the MCP `inputSchema` translated to zod via `json-schema-to-zod`.

```jsonc
// ~/.crix/mcp.json
{
  "servers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "linear": { "command": "uvx", "args": ["mcp-linear"] }
  }
}
```

MCP tools are added to the catalog at session start. They count toward the `defer_loading` cap and are loadable via `ToolSearch` to keep initial prompt small.

---

## 12. What We Cut

| Cut | Why |
|---|---|
| `packages/core/src/kernel.ts` | Replaced by `queryEngine.ts` |
| `packages/core/src/turnEngine.ts` | Same |
| `packages/core/src/agentRuntime.ts` | Replaced by `Task` tool + `Session.fork()` |
| `packages/core/src/providerToolLoop.ts` | Native function calling does this |
| `packages/core/src/providerResponse.ts` | Same |
| `packages/core/src/providerNativeTools.ts` | Same |
| `packages/core/src/promptPack.ts` (19KB cited prose) | Replaced by short layered prompt + per-tool descriptions |
| `packages/core/src/skillProcesses.ts` (12KB JSON) | Replaced by file-based skills (§11.1) |
| `packages/core/src/toolCatalog.ts` (separate catalog) | Tools own their schema; no separate catalog |
| `packages/core/src/toolRuntime.ts` (58KB monolith) | One file per tool |
| `packages/cli/src/index.ts` (116KB monolith) | Split into commands/ + tui/ |
| `java/` | Dead weight. Cut. |
| `UpgradePlan` type | Replaced by streaming tool-call loop |
| `JsonRecord` everywhere | Replaced by per-tool zod types |
| `OPENAI_CHAT_MODELS` hardcoded fake lineup | Fetched from API at startup |
| `.crix/sessions/` UUID-named with no GC | Replaced by content-addressed rollouts with auto-compact |
| `.crix/tool-checkpoints/` per-write folders | Replaced by single content-addressed checkpoint store |
| `crix.bat - Shortcut.lnk` | Remove from repo |

Net code: Crix v1 is **~340KB of source** across `packages/`. v2 target: **~120KB** with more functionality.

---

## 13. Delivery Plan

Six milestones. Each one ships a real working binary.

### M0 — Wipe & Foundation (Day 1-2)

- Delete `java/`, `packages/core/src/{kernel,turnEngine,agentRuntime,providerToolLoop,providerResponse,providerNativeTools,promptPack,skillProcesses,toolCatalog,toolRuntime}.ts`, `packages/cli/src/index.ts`
- Move `protocol/` to the new event/tool/permission types
- Stub `queryEngine.ts` with a synchronous echo provider — proves the loop shape compiles
- New `crix run --goal "x"` headless command that prints stream events as JSON

**Ship criteria:** `crix run --goal "list files"` echoes events; `pnpm verify` green.

### M1 — Real Provider + Five Tools (Day 3-7)

- `openaiResponses.ts` streaming with native function calling
- `ollama.ts` streaming
- Tools: `Read`, `Write`, `Edit`, `Bash`/`PowerShell`, `Glob`, `Grep`
- Per-tool zod schemas, `Tool<I,O>` interface, `buildTool()` helper
- `crix login` device-code OAuth (port from v1)

**Ship criteria:** `crix run --goal "find all TODO comments and write them to TODOS.md"` works end-to-end against GPT and Ollama.

### M2 — Ink TUI + Permissions (Day 8-12)

- Ink REPL with streaming text + tool rows
- `checkPermissions` flow with prompt dialog
- Rule engine + `~/.crix/permissions.json`
- `Ctrl+C` interrupt, queue-during-active-turn
- Spinner-per-tool with present-continuous descriptions

**Ship criteria:** Interactive coding session feels like Claude Code. Tool prompts work. Interruption works.

### M3 — Differentiators Round 1 (Day 13-19)

- `TodoWrite` with content/activeForm + todo panel
- `Task` (subagent) with scoped tools and isolated context
- `ApplyIntent` with local Ollama apply-model
- `CodebaseSearch` with embedding index (built on first use, kept hot)
- `LSP` tools (`go_to_definition`, `references`, `hover`)
- Continuous verifier scheduler + `system-reminder` injection

**Ship criteria:** Run a real refactor end-to-end. Verifier injects failures into next turn. Subagent executes parallel research without context bloat in main thread.

### M4 — Differentiators Round 2 (Day 20-26)

- `FindAndEdit` with per-location apply-model dispatch
- `CodeMode` with Deno-isolate JS execution
- DAG rollouts with `crix session fork|diff|rollback`
- Hooks engine (PreToolUse, PostToolUse, SessionStart)
- Plan mode (EnterPlanMode/ExitPlanMode) with yellow banner
- Diff view with hunk-accept

**Ship criteria:** A 30-file refactor as a single `FindAndEdit` call. A multi-tool plan executed inside `CodeMode` with 10x token savings demonstrated.

### M5 — Skills, MCP, Sandboxing (Day 27-34)

- Skills loader + 6 bundled skills
- MCP client integration
- Windows JobObject sandbox + bwrap on Linux + sandbox-exec on macOS
- `ToolSearch` deferred loading
- `crix doctor` polish

**Ship criteria:** Run `crix run --goal "open a PR" --skill git-pr` end-to-end. MCP servers from `~/.crix/mcp.json` appear as tools. Bash inside sandbox cannot escape workspace.

### M6 — Polish + Public 0.3.0 (Day 35-40)

- Real docs (replace this blueprint with USER_GUIDE.md)
- Telemetry opt-in (anonymous tool-use counts only)
- Benchmark suite vs Claude Code + Codex on a fixed task set
- Marketing site / README rewrite

**Ship criteria:** A first-time user pastes `npm i -g @crix/cli && crix login && crix` and is productive in 30 seconds.

---

## 14. First Day of Work — Concrete First Commits

1. `git init` (Crix isn't even a git repo right now — fix that).
2. Delete the dead weight in one commit:
   ```
   rm -r java/ packages/core/src/{kernel,turnEngine,agentRuntime,providerToolLoop,providerResponse,providerNativeTools,promptPack,skillProcesses,toolCatalog,toolRuntime}.ts
   rm packages/cli/src/index.ts
   rm "crix.bat - Shortcut.lnk"
   rm docs/{HARNESS_TARGET,ARCHITECTURE,PROMPT_PACK,REFERENCE_INSIGHTS,SELF_UPGRADE_LOOP,REFERENCE_BOUNDARIES,PROVIDERS,PROVIDER_INTEGRATION,AGENTS,TYPESCRIPT_ARCHITECTURE}.md
   ```
3. Replace `packages/protocol/src/types.ts` with the new event/tool/permission types per §5.
4. Write `packages/core/src/queryEngine.ts` with the echo provider per §4.
5. Write `packages/core/src/providers/mock.ts` returning a fixed event stream.
6. Write `packages/cli/src/entry.ts` (~40 lines) wiring `crix run --goal "x"` to the engine and printing events as NDJSON.
7. `pnpm verify` should pass with these three files.

That's day one. Real tools and the real provider start day three. By day 40 we ship 0.3.0 to the world.

---

## 15. Naming, Versioning, Repo

- Project: **Crix** (keep).
- Binary: `crix` (single command, subcommands via Commander or `clipanion`).
- Versioning: SemVer; v1 ends at `0.2.x`. v2 starts at `0.3.0-alpha.1`. Public 0.3.0 at M6.
- License: **MIT** (was unstated in v1; pick now).
- Repo: GitHub `crix-cli/crix` (recommend) — make it public at M2 when there's something demoable.
- Distribution: npm `@crix/cli` + a `crix` GitHub Release artifact (Node 22 bundled via `esbuild` + `pkg`).

---

## 16. The One-Line Pitch

> *"Crix: a coding agent that runs your edits cheap, verifies them automatically, and lets you branch your conversation like git."*

Three things, all real. No fake models. No Java worker. No 116KB monoliths.

Let's build it.
