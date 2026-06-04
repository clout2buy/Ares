# Crix v3 — The Elite Tier

This is the executable spec for GPT to take Crix from "solid" to "the coding harness people quit Cursor for."

Every section follows the same shape so you can't get lost:
- **WHY** — what changes for the user when this ships
- **WHAT** — exact deliverable, no ambiguity
- **WHERE** — file paths in the existing repo
- **HOW** — code shape, key APIs, dependencies
- **TEST** — acceptance criteria (write the test FIRST)
- **GOTCHAS** — the traps that will burn you if you don't read this
- **OP UPGRADE** — the move that makes this *elite*, not just done

## Ship Order (do them in this order, do not reorder)

1. **T1** — Parallel tool execution                 (engine surgery, unlocks everything below)
2. **T2** — Real prompt caching wired into bodies   (cost regression fix; cheap to ship)
3. **T3** — Auto-checkpoint + `/undo` `/branch`     (the differentiator)
4. **T4** — Live diff rendering in TUI              (the dopamine)
5. **T5** — Image input + paste                     (unlocks UI/screenshot workflows)
6. **T6** — Real LSP (multi-language pool)          (credibility move)
7. **T7** — Thinking-trace rendering                (model feels smart visibly)
8. **T8** — Streaming tool output (`tool_progress`) (UI feels alive)
9. **T9** — Persistent memory (Memory tool + auto-summarize)
10. **T10** — CRIX.md / AGENTS.md auto-load + hierarchical walk
11. **T11** — Cost meter (per-session, per-day, per-month, cache-hit rate)
12. **T12** — Slash commands inside the Ink TUI
13. **T13** — Smart slot routing (REASONER/APPLY/SUMMARIZE auto-pick)
14. **T14** — Conversation-aware `/compact` via SUMMARIZE slot
15. **T15** — Predictive Read + speculative parallelism
16. **T16** — Background watcher agents
17. **T17** — Eval harness (`crix eval`)
18. **T18** — Telemetry + `crix stats`
19. **T19** — Inline JS hooks (`.crix/hooks.js`)
20. **T20** — Visual mode (Playwright screenshot loop)

**Build/test cadence:** after every T*, run `pnpm verify`. Do not move to the next T until 100% green. Add a new test file `tests/v3-<short>.test.mjs` per task. Aim for 200+ tests total when done (currently 96).

---

# T1 — Parallel tool execution

### WHY
The model fires 5 Reads at once. We currently serialize them. Cuts multi-file-turn latency 3–5x. This is the single biggest user-felt win in this whole list.

### WHAT
- Honor `schema.concurrency` (`parallel-safe` | `exclusive`) in `QueryEngine.streamTurn()`.
- Run all `parallel-safe` tools in a single batch via `Promise.all` up to a cap.
- Run `exclusive` tools one at a time, BEFORE any parallel batch in the same iteration (they often mutate state others depend on).
- Yield events as each tool completes, NOT after the batch — UI must see live progress.
- Cap concurrency at `MAX_PARALLEL_TOOLS = 8` (configurable via env `CRIX_MAX_PARALLEL`).

### WHERE
- `packages/core/src/queryEngine.ts` — replace the sequential `for (const use of pendingToolUses)` loop at ~line 250.
- `packages/protocol/src/types.ts` — add `Concurrency = "parallel-safe" | "exclusive" | "exclusive-write"` if not present.

### HOW
Pseudocode for the new tool dispatch phase:

```ts
const exclusives = pendingToolUses.filter(u => toolByName(u.name).schema.concurrency !== "parallel-safe");
const parallels  = pendingToolUses.filter(u => toolByName(u.name).schema.concurrency === "parallel-safe");

// 1) Run exclusives serially (existing logic)
for (const use of exclusives) yield* this.runOneTool(use, toolResults);

// 2) Run parallels in capped batches, yielding events as they complete
const cap = Number(process.env.CRIX_MAX_PARALLEL ?? 8);
const queue = [...parallels];
const inFlight = new Set<Promise<ToolFinish>>();
const finishStream = new AsyncQueue<ToolFinish>(); // small impl below

while (queue.length || inFlight.size) {
  while (inFlight.size < cap && queue.length) {
    const use = queue.shift()!;
    const p = this.runToolToFinish(use).then(f => { inFlight.delete(p); finishStream.push(f); return f; });
    inFlight.add(p);
  }
  const finish = await finishStream.shift();
  for (const ev of finish.events) yield ev;   // tool_start, tool_end / tool_error
  toolResults.push(finish.result);
}
```

Where `runToolToFinish(use)` returns `{ events: TurnEvent[], result: ToolResultBlock }`. The trick is buffering tool-internal events (permission_request/response, tool_progress) into the `events` array so they yield in coherent order.

### TEST
`tests/v3-parallel-tools.test.mjs`:
1. Mock provider emits 5 parallel-safe `tool_use` blocks (5x Read of different files).
2. Each Read sleeps 100ms.
3. Total turn time must be < 250ms (proves parallel). Sequential would be > 500ms.
4. Second test: 2 exclusive (Write) + 3 parallel (Read). Order: Writes serial, then Reads parallel. Verify via timestamps in tool_end events.
5. Third test: 12 parallel Reads with cap=4 — max in-flight at any moment is 4, all 12 complete.

### GOTCHAS
- `tool_use_id` ordering MUST match the order assistant emitted them in. Don't reorder `toolResults` — push by index, not by completion.
- Permission prompts in parallel are a UX nightmare. Serialize permission requests via a mutex inside the engine (one prompt visible at a time), even if tools run parallel.
- Bash/PowerShell are `exclusive-write` not `parallel-safe`. ApplyIntent too. Verify the schemas in `packages/tools/src/*.ts`.
- The verifier scheduler must not race tools — debounce wakes are fine, but the `drainSystemReminders()` call must stay single-threaded at turn boundary.

### OP UPGRADE
**Dependency-aware batching.** Before parallelizing, build a quick dep graph: if tool A writes file F and tool B reads F, B serializes after A. Cheap heuristic: scan `input.file_path` / `input.path` / `input.command` across the pending batch. Falls back gracefully if no overlap. This means the model can fire `Edit(a.ts) + Read(a.ts) + Read(b.ts)` and we run Edit→Read(a) serial, Read(b) in parallel. Nobody else does this.

---

# T2 — Real prompt caching

### WHY
`buildPromptCacheKey` exists, returns a hash, nobody sends it. Long sessions pay full input cost every turn. Wire cache breakpoints into provider bodies and cut input cost ~70%.

### WHAT
- OpenAI Responses: send `prompt_cache_key: <key>` field (auto-uses OpenAI's automatic caching).
- Anthropic-compat (`/v1/messages`): add `cache_control: { type: "ephemeral" }` to system block AND last tool definition AND first user message if "stable" (older than 5 turns).
- Track cache hits via provider response (`usage.cache_read_input_tokens` for Anthropic, `usage.prompt_tokens_details.cached_tokens` for OpenAI). Surface in `Usage` type.

### WHERE
- `packages/core/src/providers/openaiResponses.ts` — add `prompt_cache_key` to request body.
- `packages/core/src/providers/ollamaCloud.ts` — `callAnthropicMessages` payload builder: add cache_control breakpoints.
- `packages/protocol/src/types.ts` — extend `Usage` with `cacheReadTokens`, `cacheWriteTokens` (already there per the grep).
- `packages/core/src/promptCache.ts` — add `chooseCacheBreakpoints(messages)` helper that picks where to put the breakpoints.

### HOW
Anthropic-compat strategy: up to **4 breakpoints** (Anthropic limit).
1. After system prompt (always cacheable).
2. After tools array (always cacheable — same per session).
3. After first user message if conversation has > 5 turns (rarely-changing context).
4. After last assistant message that's > 5 turns old (long-tail cache).

```ts
function chooseCacheBreakpoints(req: ProviderRequest): CacheBreakpoint[] {
  const breaks: CacheBreakpoint[] = [
    { target: "system" },
    { target: "tools" },
  ];
  if (req.messages.length > 5) breaks.push({ target: "message", index: 0 });
  if (req.messages.length > 10) breaks.push({ target: "message", index: req.messages.length - 6 });
  return breaks;
}
```

OpenAI Responses: just pass `prompt_cache_key: buildPromptCacheKey(req).key`. OpenAI auto-caches anything ≥ 1024 tokens that matches a previously-seen prefix; the key just helps routing.

### TEST
`tests/v3-prompt-cache.test.mjs`:
1. Anthropic-compat: capture outbound body, assert `system[0].cache_control = {type:"ephemeral"}` AND last tool has same marker.
2. With 12 messages: assert breakpoint at messages[0] and messages[6].
3. Mock response with `usage.cache_read_input_tokens: 5000` → assert `Usage.cacheReadTokens = 5000`.
4. OpenAI: assert request body contains `prompt_cache_key` matching `buildPromptCacheKey(req).key`.
5. Two turns back-to-back with identical system: `prompt_cache_key` must be identical (proves cache locality).

### GOTCHAS
- Anthropic-compat cache_control MUST be on the LAST content block of the target message, not the message itself.
- Tools array gets cache_control on the LAST tool definition's spot — the marker applies to all preceding tools.
- Don't cache `tool_result` blocks — they're volatile. Cache breakpoint must be BEFORE the recent tool_result chunks.
- Ollama Cloud's `/v1/messages` may not support cache_control at all. Detect by error response and gracefully strip on retry.

### OP UPGRADE
**Cache hit rate displayed in TUI cost meter.** After every turn, compute `cacheReadTokens / (cacheReadTokens + inputTokens) * 100`. Show in footer: `⚡ 87% cached`. If < 30%, hint to user "/compact would improve this". Drives behavior change.

---

# T3 — Auto-checkpoint + `/undo` + `/branch`

### WHY
Checkpoints exist but are manual. Make them automatic before any write, then expose `/undo` and `/branch` as one-key recovery. The agent moves 3x faster because mistakes are free. **This is the differentiator nobody else has** — Cursor doesn't, Codex doesn't, Claude Code doesn't.

### WHAT
- Before every `safety: "workspace-write"` or `safety: "external-write"` tool execution, take an *incremental* checkpoint (only changed files since last checkpoint).
- Run checkpointing on a worker so it doesn't block the turn (use `worker_threads` or background promise queue).
- `/undo` — restore the last checkpoint, append a system_reminder telling the model "the user undid your last write tool".
- `/undo N` — restore N checkpoints back.
- `/branch <name>` — fork current state as a named branch; future checkpoints belong to that branch.
- `/diff` — show diff between current and last checkpoint.
- `/diff <checkpoint-id>` — show diff vs specific checkpoint.

### WHERE
- `packages/core/src/checkpoints.ts` — add `createIncrementalCheckpoint`, `getLastCheckpoint`, branch tracking.
- `packages/core/src/queryEngine.ts` — wire auto-checkpoint hook before write-safety tools.
- `packages/cli/src/inkTui.ts` — slash command handlers for `/undo`, `/branch`, `/diff`.
- `packages/cli/src/entry.ts` — checkpoint commands for headless `crix` CLI.

### HOW
Incremental checkpoint: compute file hashes against the workspace, compare to manifest of the previous checkpoint, only write changed blobs. Manifest still complete (full snapshot semantics).

```ts
export async function createIncrementalCheckpoint(opts: {
  workspace: string;
  sessionId: string;
  turnSeq: number;
  parentCheckpointId: string;
  branch?: string;
}): Promise<CheckpointMeta> {
  const parent = await loadWorkspaceCheckpoint(opts.workspace, opts.parentCheckpointId);
  const parentMap = new Map(parent.fileManifest.map(b => [b.path, b.blobHash]));
  // ...scan workspace, hash, only writeBlob if hash differs from parentMap
}
```

`/undo` impl:
```ts
async function handleUndo(session, n = 1): Promise<string> {
  const checkpoints = await listWorkspaceCheckpoints(session.workspace);
  const target = checkpoints.at(-1 - n);
  if (!target) return "no checkpoint that far back";
  const result = await restoreWorkspaceCheckpoint(session.workspace, target.id);
  session.appendSystemReminder(`User invoked /undo. Restored ${result.restored} files from checkpoint ${target.id}. Re-Read affected files before editing.`);
  return `↶ undid to ${target.label ?? target.id} (${result.restored} files)`;
}
```

Background worker pattern — spawn a single `worker_thread` per session that owns checkpoint creation, communicate via MessagePort:
```ts
const worker = new Worker(new URL("./checkpointWorker.js", import.meta.url));
worker.postMessage({ kind: "checkpoint", opts });  // fire-and-forget, < 1ms
```

### TEST
`tests/v3-undo.test.mjs`:
1. Write file A, write file B, `/undo` — file B reverts but file A keeps changes.
2. `/undo 2` — both files revert.
3. `/branch experimental` then more writes — `/diff` shows only branch changes.
4. Auto-checkpoint runs in < 5ms on a 100-file repo (worker offload proof).
5. Incremental checkpoint: 100 files unchanged + 1 changed → only 1 blob written (not 100).
6. After `/undo`, next turn injects system_reminder mentioning the undo.

### GOTCHAS
- File mtimes after restore can confuse the read-stamp invariant. Update `fileReadStamps` on undo, OR drop them so the agent must Re-Read.
- Worker thread must NOT inherit large parent memory — keep its bootstrap small.
- Concurrent writes during checkpoint = race. Snapshot must lock or use copy-on-read.
- `.crix/` dir itself must be excluded from checkpoints (it IS the checkpoints).

### OP UPGRADE
**`/branch` makes Crix git-like at the agent level.** Combined with DAG sessions, you get parallel experimental branches: "try fix A on `main`, try fix B on `branch-alt`, `/diff` between them to pick the winner." Multi-agent + multi-branch = exploratory coding that nobody else supports. Build `/branches` listing + `/checkout <branch>` to round out the model.

---

# T4 — Live diff rendering in TUI

### WHY
When Edit / ApplyIntent / Write fires, render a colored unified diff inline. This is the moment in Cursor where you *feel* the agent working. Currently we just print "Edited foo.ts".

### WHAT
- Capture `before` content in Edit/Write/ApplyIntent, emit `display.diffPreview` in the tool result.
- Ink TUI renders the diff with green `+` / red `-` lines and 3 lines of context.
- Big diffs (>40 lines) auto-collapse with `[ + 23 more lines ]`; user toggles with `<Tab>`.
- Syntax-aware coloring (extension → lightweight tokenizer; skip for unknown extensions).

### WHERE
- `packages/tools/src/Edit.ts`, `Write.ts`, `ApplyIntent.ts`, `FindAndEdit.ts` — return `display.diffPreview: string` (unified diff text).
- `packages/protocol/src/types.ts` — extend tool_end event with optional `diffPreview?: string`.
- `packages/cli/src/inkTui.ts` — new `<DiffBlock>` component.
- New `packages/cli/src/diffRender.ts` — diff parser + colorizer.

### HOW
Use a tiny inline myers-diff (don't pull a 100KB diff lib). Implementation:
```ts
// diffRender.ts — under 200 LOC
export function computeUnifiedDiff(before: string, after: string, contextLines = 3): DiffLine[] {
  // standard Myers, return [{ kind: "add" | "del" | "ctx", text, lineNumber }]
}
```

Ink rendering: each line is a `<Text color={kind === "add" ? "green" : kind === "del" ? "red" : "gray"}>{prefix} {text}</Text>`.

Collapse logic: when total `add + del > 40`, render first 10 + `[ + N more ]` + last 10. Tab key toggles full view (use Ink's `useInput` + state).

### TEST
`tests/v3-diff-render.test.mjs`:
1. Edit replacing 1 line → diffPreview contains `- old\n+ new\n`.
2. Write new file → diffPreview is all `+` lines.
3. ApplyIntent with full-file sketch → diffPreview only shows actual changed lines, not all of them.
4. 100-line diff → preview marker `[+ 80 more lines]` present.

### GOTCHAS
- Don't compute diff for files > 1MB — show "binary or huge file change" instead.
- ANSI color codes in diffPreview will mess up the rollout JSONL. Store raw diff text, color at render time.
- ApplyIntent's "full-file-sketch" engine writes the whole file; diff must compare against the ORIGINAL contents loaded before write, not the sketch.

### OP UPGRADE
**Inline edit-mode for the user.** When a diff shows, user can hit `e` to edit the proposed change before it commits (open in $EDITOR, Crix re-applies the edited version). Turns the agent from "automatic" to "co-pilot with the wheel." Massive trust unlock for skeptical engineers.

---

# T5 — Image input + clipboard paste

### WHY
`ImageBlock` is defined in the protocol, no provider parses it. User screenshots a broken UI → drops in TUI → agent sees it. Unlocks UI debugging, design feedback, error-screenshot workflows. GPT-5 and Claude both ready.

### WHAT
- TUI accepts:
  - `<Ctrl-V>` clipboard paste (image) → encode base64 → add as `image` content block in next user message.
  - Drag-and-drop file (where terminal supports it via OSC 52, or just typed path `@./foo.png` syntax).
  - Slash command `/image <path>` for explicit attach.
- Providers serialize `image` blocks correctly:
  - OpenAI Responses: `{type: "input_image", image_url: "data:image/png;base64,..."}`
  - Anthropic-compat: `{type: "image", source: {type: "base64", media_type: "image/png", data: "..."}}`
- Auto-resize images > 1MB to ≤ 1568px longest edge (Claude's limit) before sending.

### WHERE
- `packages/cli/src/inkTui.ts` — clipboard read via `node:child_process` calling `powershell Get-Clipboard -Format Image` (Win) / `pbpaste -Prefer image` (mac) / `xclip -selection clipboard -t image/png -o` (linux).
- `packages/cli/src/imageInput.ts` — new module: clipboard read, resize, base64 encode.
- `packages/core/src/providers/openaiResponses.ts` — serialize ImageBlock in user message content.
- `packages/core/src/providers/ollamaCloud.ts` — same for Anthropic-compat path. (Ollama native may not support vision — log warning.)
- `packages/tools/src/_shared.ts` — `messageBlocks` builder updated.

### HOW
Resize without imagemagick: use the `sharp` npm package OR call out to `ffmpeg` (more likely already installed). Resize impl:
```ts
import sharp from "sharp";
async function resizeImage(buf: Buffer): Promise<{buf: Buffer, mime: string}> {
  const meta = await sharp(buf).metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (longest <= 1568) return { buf, mime: `image/${meta.format}` };
  const out = await sharp(buf).resize({ width: longest === meta.width ? 1568 : undefined, height: longest === meta.height ? 1568 : undefined }).png().toBuffer();
  return { buf: out, mime: "image/png" };
}
```

Decline gracefully if `sharp` not installed (optional dep) — send original at full size with warning.

### TEST
`tests/v3-image-input.test.mjs`:
1. Construct user message with image block, send through OpenAI provider mock, assert body has `input_image` with `data:image/png;base64,...`.
2. Same through Anthropic-compat path, assert `{type:"image", source:{type:"base64",...}}`.
3. Resize: input 3000x2000 → output longest dim 1568.
4. CLI: `crix run --goal "what's in @./test.png"` reads file, sends as image block.

### GOTCHAS
- Some terminals (Windows Terminal) handle Ctrl-V paste by writing literal text. Detect: if pasted text matches `data:image/...` or is binary garbage, treat as image attempt.
- Anthropic limits to 5 images per request and 100 over a conversation. Track and reject 6th gracefully.
- Don't base64-encode the same image twice across turns. Cache by SHA256 → reuse.

### OP UPGRADE
**Auto-screenshot mode for verifier loop.** When agent edits a CSS / HTML / React file AND the workspace has a `playwright.config` OR a `dev` script in package.json, optionally fire a headless Playwright screenshot of `localhost:<detected port>/` after the edit, attach as system_reminder image: "Here's what your change rendered as." The agent SEES its own work and iterates. This is what kills Cursor for UI work.

---

# T6 — Real LSP (multi-language pool)

### WHY
Current LSP is regex cosplay. Real `typescript-language-server` knows about imports, generics, JSDoc, code actions. Multi-language pool means py/rust/go too. This is the credibility move — what makes Crix feel like a senior dev's tool.

### WHAT
- Replace `LspTool` static fallback with real LSP-over-stdio child processes.
- Auto-detect language from file extension; spawn matching server lazily.
- Servers stay alive per session (long-lived, cached).
- New actions: `find_implementations`, `get_diagnostics`, `code_actions` (autoimport!), `rename_symbol` (atomic multi-file).
- Keep current schema/output shape so callers unchanged.
- Graceful fallback to static when server not installed.

### WHERE
- `packages/tools/src/LSP.ts` — keep, but route through new layer.
- `packages/tools/src/lsp/client.ts` — new JSON-RPC client over stdio.
- `packages/tools/src/lsp/pool.ts` — server lifecycle: spawn, init, shutdown.
- `packages/tools/src/lsp/servers.ts` — registry of known servers per language.

### HOW
Server registry:
```ts
export const LSP_SERVERS: Record<string, LspServerSpec> = {
  typescript: {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    command: "typescript-language-server",
    args: ["--stdio"],
    initOptions: { hostInfo: "crix" },
  },
  python:   { extensions: [".py"],  command: "pyright-langserver", args: ["--stdio"] },
  rust:     { extensions: [".rs"],  command: "rust-analyzer",      args: [] },
  go:       { extensions: [".go"],  command: "gopls",              args: ["serve"] },
};
```

Client impl: spawn child, write `Content-Length: N\r\n\r\n<json>`, parse server messages, route by `id`. Implement only the methods we use:
- `initialize`, `initialized`, `shutdown`
- `textDocument/didOpen`, `didChange`, `didClose`
- `textDocument/definition`, `references`, `hover`, `implementation`
- `textDocument/codeAction`, `rename`
- `textDocument/publishDiagnostics` (server-pushed)

Pool: one `LspClient` per language per workspace. Lazy init on first request. Kill on session end.

New action: `get_diagnostics(file_path)` — pass to client.didOpen, wait up to 500ms for `publishDiagnostics`, return errors/warnings. **The agent can now see TypeScript errors BEFORE writing files** — tightens the verifier loop massively.

### TEST
`tests/v3-lsp-real.test.mjs`:
1. Skip if no `typescript-language-server` on PATH (it's the most commonly available).
2. Write a TS file with a deliberate type error, call `get_diagnostics` → assert error returned with message and line.
3. `go_to_definition` on an imported symbol from another file → returns the actual import target, not just regex hit.
4. `rename_symbol` across 2 files → both files modified atomically (use checkpoint, restore on failure).
5. Server crash mid-request → pool restarts cleanly, request retried once.

### GOTCHAS
- LSP servers want files to be `didOpen`'d before queries. Maintain an open-set per client; close when session ends.
- File URIs must be `file:///` with proper Windows drive letter handling (`file:///D:/Crix/foo.ts`).
- `rename_symbol` returns `WorkspaceEdit` with multi-file changes — apply atomically (all or nothing, via a transient checkpoint).
- Don't await server startup synchronously on EVERY tool call — pool's `acquire(language)` should return a Promise<Client> that resolves after init.
- typescript-language-server is HUGE on first init for big repos (10s+). Show a `tool_progress` event during init.

### OP UPGRADE
**`get_diagnostics` is a system_reminder before every Write.** When agent calls `Write(foo.ts, ...)`, automatically run `get_diagnostics(foo.ts)` AFTER the write, and if there are errors, inject as a system_reminder before the next turn. Effectively: "you broke the types, here's what." Now the agent self-corrects without a separate verifier round-trip. This + parallel tools = agent that writes typecheck-clean code on the first pass.

---

# T7 — Thinking-trace rendering

### WHY
ThinkingBlock exists in protocol. Neither provider parses reasoning items. The TUI never shows them. Showing reasoning makes the model feel *smart* visibly — dimmed italic, collapsible. Claude Code does this, Codex does this. We don't, yet.

### WHAT
- OpenAI Responses: parse `response.reasoning_summary_text.delta` SSE events → emit `thinking_delta` stream event.
- Anthropic-compat: parse `content_block_start { type: "thinking" }` + `content_block_delta { delta: { type: "thinking_delta", thinking: "..." } }` → same.
- TUI renders thinking inline, dimmed italic, collapsible via `Ctrl-R`.
- Persisted to rollout but excluded by default from /compact.

### WHERE
- `packages/protocol/src/types.ts` — add `thinking_delta` to `StreamEvent` union.
- `packages/core/src/providers/openaiResponses.ts` — handle reasoning SSE.
- `packages/core/src/providers/ollamaCloud.ts` — handle thinking blocks in Anthropic-compat parser.
- `packages/cli/src/inkTui.ts` — render thinking as a dimmed italic block.

### HOW
Stream event:
```ts
export interface ThinkingDeltaEvent { type: "thinking_delta"; text: string; }
```

OpenAI Responses event names to watch:
- `response.reasoning_summary_text.delta` → `{ delta: "..." }`
- `response.reasoning_summary_text.done`

Anthropic-compat: already in spec — `delta.type === "thinking_delta"` carries `.thinking`.

TUI: keep a `[currentThinking, setCurrentThinking]` state. While `thinking_delta` events stream, append to a folded panel; on `text_delta`, finalize and tuck above the assistant text.

### TEST
`tests/v3-thinking.test.mjs`:
1. OpenAI mock SSE with reasoning summary deltas → engine yields `thinking_delta` events with concatenated text.
2. Anthropic-compat mock with thinking content_block → same.
3. Message_done message.content includes a `{type:"thinking", text:"..."}` block.
4. `/compact` strips thinking blocks from history (default).

### GOTCHAS
- Reasoning tokens cost money. Track separately in `Usage.reasoningTokens` (already in type).
- OpenAI reasoning summaries can be empty when `reasoning_effort` is minimal/low. Don't yield empty deltas.
- Don't show thinking traces in the rollout NDJSON by default if they contain user-private info — make `CRIX_PERSIST_THINKING=1` opt-in.

### OP UPGRADE
**Reasoning-aware turn budgeting.** Track `reasoningTokens / outputTokens` ratio per session. If it climbs > 3:1 the model is overthinking — auto-lower `reasoning_effort` from "medium" to "low" for the next turn. Self-tuning cost control nobody else has.

---

# T8 — Streaming tool output (`tool_progress`)

### WHY
`emitProgress` is in the type, engine swallows. Bash output appears only at the end. Live grep doesn't show match count climbing. The UI feels dead during long tools.

### WHAT
- Engine forwards `emitProgress(data)` calls as `tool_progress` TurnEvents.
- Bash/PowerShell stream stdout/stderr lines as progress.
- Grep streams match counts per file.
- Verifier streams `[1/12] tsc passed` style updates.
- TUI renders a live tail (last 3-5 lines) below the active tool row.

### WHERE
- `packages/core/src/queryEngine.ts` — `ctx.emitProgress` no longer swallows; wraps in `yield { type: "tool_progress", id, data }`. **Tricky** — generators don't allow non-engine code to yield. Pattern: emitProgress pushes into a shared queue the engine drains.
- `packages/tools/src/Bash.ts`, `PowerShell.ts` — emit per chunk.
- `packages/tools/src/Grep.ts`, `CodebaseSearch.ts`, `FindAndEdit.ts` — emit progress.
- `packages/cli/src/inkTui.ts` — render live tail per active tool.

### HOW
Emit queue pattern:
```ts
const progressQueue = new AsyncQueue<{ id: string, data: unknown }>();
const ctx: ToolCallContext = {
  ...,
  emitProgress: (data) => progressQueue.push({ id: use.id, data }),
};
// In engine: race tool completion vs progress drain
const finalP = tool.call(use.input, ctx);
while (true) {
  const next = await Promise.race([finalP.then(r => ({ kind: "done", r })), progressQueue.shift().then(p => ({ kind: "prog", p }))]);
  if (next.kind === "prog") yield { type: "tool_progress", id: next.p.id, data: next.p.data };
  else { result = next.r; break; }
}
```

### TEST
`tests/v3-tool-progress.test.mjs`:
1. Mock tool that emits 5 progress events then returns → engine yields 5 `tool_progress` then 1 `tool_end`.
2. Bash with `for i in 1 2 3; do echo $i; sleep 0.1; done` → at least 3 progress events with text content.
3. Order preserved: progress events for a given id strictly precede that id's tool_end.

### GOTCHAS
- AsyncQueue must support multiple producers (parallel tools) keyed by id; consumer is the engine generator.
- Don't emit > 100 progress events per tool — coalesce. Bash should buffer lines for 50ms.
- Memory leak risk: queue shifts must not block forever. Use a timeout or signal.

### OP UPGRADE
**Structured progress, not just strings.** `emitProgress({ kind: "grep_match", file: "x.ts", line: 42, total: 13 })`. TUI renders a live counter. Bash emits `{ kind: "bash_line", text }`. Verifier emits `{ kind: "step", current: 3, total: 12, label: "ruff" }` → TUI shows a real progress bar. Stops looking like a chat, starts looking like an IDE.

---

# T9 — Persistent memory

### WHY
The "actual senior colleague" move. After a week of use, Crix knows your codebase like a teammate who's been there 6 months. Nobody nails this — Claude Code's memory is opt-in clunky, Cursor doesn't have it.

### WHAT
- `Memory` tool with actions: `add`, `update`, `search`, `forget`, `list`.
- Storage: `~/.crix/memory.md` (global) + `<workspace>/.crix/memory.md` (project).
- Categories: `preferences`, `conventions`, `project-facts`, `decisions`, `gotchas`.
- Auto-summarize at end of session: SUMMARIZE slot reads the rollout, proposes 1-3 new memories, agent confirms via TodoWrite-style review.
- Loaded as system_reminder on every session start (project memory) and chat start (global).

### WHERE
- `packages/tools/src/Memory.ts` — new tool.
- `packages/core/src/memory.ts` — store + parser (MD with category headings).
- `packages/cli/src/entry.ts` — wire load on session start; auto-summarize on session end.
- System prompt — instructs model about memory tool's purpose.

### HOW
Memory file format:
```md
# Crix Memory — D:\Crix

## Preferences
- tabs not spaces
- biome not eslint
- bun for /tools scripts
- always run pnpm verify before commit

## Conventions
- Per-tool files in packages/tools/src/
- Tests in tests/ as .test.mjs
- buildTool<I,O> factory

## Project facts
- 96 tests at commit a64aeb
- DEFAULT_OLLAMA_SLOTS exported from @crix/core
- HookManager loads ~/.crix/hooks.json + .crix/hooks.json

## Gotchas
- LF→CRLF warnings on Windows are harmless
- pnpm link --global needs admin first time
```

Tool schema:
```ts
{
  action: "add" | "update" | "forget" | "search" | "list",
  scope: "global" | "project",
  category: "preferences" | "conventions" | "project-facts" | "decisions" | "gotchas",
  content: string,  // for add/update
  query: string,    // for search
  id: string,       // for update/forget (line hash)
}
```

Auto-summarize: at session-end, call SUMMARIZE slot with rollout digest. Prompt:
```
You just observed this Crix session. Identify 0-3 NEW facts worth remembering
permanently. Output JSON: { proposals: [{category, content, reason}] }.
Skip anything trivial or session-specific. Only propose if confident.
```

If proposals exist, queue them as system_reminder at start of next session: "I learned: X, Y, Z. Reply '/memory accept all' or '/memory reject' or '/memory edit'."

### TEST
`tests/v3-memory.test.mjs`:
1. Memory.add({category: "preferences", content: "tabs"}) → file contains under "## Preferences" bullet.
2. Memory.search({query: "tab"}) → returns the bullet.
3. Memory.forget by id → bullet gone, others intact.
4. Auto-summarize end-of-session with mock SUMMARIZE returning 2 proposals → next session.start() injects system_reminder mentioning both.
5. Project memory and global memory both load on chat start.

### GOTCHAS
- Memory becomes stale. `Memory.update` MUST replace not append.
- Don't let memory grow unbounded — cap at 64KB per file; agent must `forget` before `add` if at cap.
- Prompt-inject risk: a malicious file in workspace adding fake memories. Project memory loaded from `<workspace>/.crix/memory.md` only — never from arbitrary text.
- SUMMARIZE auto-proposals run in the background, don't block session-end.

### OP UPGRADE
**Memory diff in the cost meter.** Show `📒 +2 / -1` in footer when this session's auto-summarize produced changes. Subtle but communicates "I'm learning." After a week the user can `crix memory diff --since 7d` and see what they've taught the agent. Builds trust.

---

# T10 — CRIX.md / AGENTS.md auto-load + hierarchical walk

### WHY
Standard convention now. Claude Code → `CLAUDE.md`. Codex → `AGENTS.md`. Cursor → `.cursor/rules/`. Teams encode project conventions there. Crix should pick up all of them.

### WHAT
- On session start, walk from `cwd` up to `$HOME`, collecting:
  - `CRIX.md`, `AGENTS.md`, `CLAUDE.md` (each, if present)
  - `.cursor/rules/*.mdc`
  - `~/.crix/instructions.md` (user-global)
- Concatenate in order: home → root → ... → cwd (most-specific last so it wins).
- Inject as system_reminder labeled by source.
- Agent can `/init` to scaffold a `CRIX.md` template.
- Agent has tool `RecordDecision(text)` that appends to nearest `CRIX.md`.

### WHERE
- `packages/core/src/instructions.ts` — new: `loadProjectInstructions(cwd)`.
- `packages/cli/src/entry.ts` — call on session start, inject via session.appendSystemReminder.
- `packages/tools/src/RecordDecision.ts` — new tool.
- Slash command `/init` — scaffolds `CRIX.md`.

### HOW
```ts
export async function loadProjectInstructions(cwd: string): Promise<InstructionsBundle> {
  const sources: InstructionSource[] = [];
  // 1) global
  const home = path.join(os.homedir(), ".crix", "instructions.md");
  if (await exists(home)) sources.push({ path: home, scope: "global", text: await fs.readFile(home, "utf8") });
  // 2) walk up
  let dir = cwd;
  const collected: InstructionSource[] = [];
  while (dir !== path.dirname(dir)) {
    for (const name of ["CRIX.md", "AGENTS.md", "CLAUDE.md"]) {
      const p = path.join(dir, name);
      if (await exists(p)) collected.push({ path: p, scope: "project", text: await fs.readFile(p, "utf8") });
    }
    const cursorDir = path.join(dir, ".cursor", "rules");
    if (await exists(cursorDir)) {
      for (const f of await fs.readdir(cursorDir)) {
        if (f.endsWith(".mdc") || f.endsWith(".md")) {
          collected.push({ path: path.join(cursorDir, f), scope: "project", text: await fs.readFile(path.join(cursorDir, f), "utf8") });
        }
      }
    }
    dir = path.dirname(dir);
  }
  // root-first, cwd-last
  sources.push(...collected.reverse());
  return { sources, combinedReminder: formatBundle(sources) };
}
```

### TEST
`tests/v3-instructions.test.mjs`:
1. Create CRIX.md in workspace → injected as system_reminder.
2. Create CRIX.md in workspace AND parent dir → both injected, workspace LAST.
3. `.cursor/rules/style.mdc` → injected.
4. None present → no reminder, no error.
5. `/init` scaffolds `CRIX.md` with template.

### GOTCHAS
- Don't walk past mount roots; cap at 8 levels.
- Skip if home dir matches workspace dir (don't double-load).
- Format the reminder so model knows which file each chunk came from (`[from CRIX.md] ...`).
- Files > 32KB → truncate with `[... truncated, run crix instructions show for full]`.

### OP UPGRADE
**`RecordDecision` tool.** When the user says "always use tabs" or "from now on use bun" mid-conversation, the agent fires `RecordDecision("Use tabs not spaces")` and it auto-appends to the nearest CRIX.md under `## Decisions`. The agent updates its own playbook in real-time. Persistent learning AT THE PROJECT LEVEL not just memory layer. Combined with T9 = self-improving harness.

---

# T11 — Cost meter

### WHY
Usage is tracked, never shown. OAuth users on rate-limited plans need real-time spend visibility.

### WHAT
- Ink TUI footer: `🪙 $0.0231 / 31s / 12 tools / ⚡ 87% cached`
- Per-session, per-day, per-month totals stored in `~/.crix/usage.jsonl`.
- Slot breakdown: `REASONER $0.018 / APPLY $0.003 / SUMMARIZE $0.002`.
- Price table per model in `packages/core/src/pricing.ts` (updateable).
- Slash `/cost` shows detailed breakdown.

### WHERE
- `packages/core/src/pricing.ts` — new: model → $/MTok in/out/cache.
- `packages/core/src/session.ts` — accumulate Usage across turns; emit `usage_updated` events.
- `packages/cli/src/inkTui.ts` — footer component.
- `packages/cli/src/entry.ts` — write `~/.crix/usage.jsonl` after each session end.

### HOW
Pricing (illustrative):
```ts
export const MODEL_PRICING: Record<string, ModelPrice> = {
  "gpt-5.5":               { inputMTok: 1.25, outputMTok: 10.00, cachedReadMTok: 0.125 },
  "qwen3-coder:480b-cloud":{ inputMTok: 0.00, outputMTok: 0.00, cachedReadMTok: 0.00 }, // Ollama Cloud free tier
  "devstral-small-2:24b-cloud": { inputMTok: 0.00, outputMTok: 0.00, cachedReadMTok: 0.00 },
  ...
};
```

Cost = `inputTokens * pricing.inputMTok / 1e6 + outputTokens * pricing.outputMTok / 1e6 + cacheReadTokens * pricing.cachedReadMTok / 1e6`.

`~/.crix/usage.jsonl` rows:
```json
{"ts":"2026-05-25T12:30:00Z","session":"sess_x","model":"gpt-5.5","slot":"reasoner","input":1234,"output":567,"cacheRead":890,"costUsd":0.0019}
```

`/cost` queries last 30 days from JSONL.

### TEST
`tests/v3-cost.test.mjs`:
1. Mock provider returning specific usage → cost computed against known pricing.
2. `~/.crix/usage.jsonl` row written after session end.
3. `/cost` returns aggregates matching JSONL contents.
4. Unknown model → falls back to 0 cost with warning.

### GOTCHAS
- Don't double-count usage across providers (REASONER and APPLY both have Usage; sum carefully).
- Pricing changes — make `MODEL_PRICING` overridable via `~/.crix/pricing.json`.
- Ollama Cloud is "free" in tokens but rate-limited. Don't claim $0 — claim "0 (Ollama Cloud)" with a slot meter for rate budget.

### OP UPGRADE
**Budget guards.** User sets `CRIX_DAILY_BUDGET_USD=5`. When 80% consumed, agent gets a system_reminder "your daily budget is 80% used, lean on Ollama Cloud slots for cheap tasks." At 100%, switch to confirmation-required for any OpenAI call. Real cost discipline.

---

# T12 — Slash commands inside the Ink TUI

### WHY
Currently the user has to exit the TUI to switch sessions, change theme, etc. Slash commands inline like Claude Code.

### WHAT
- `/help`, `/clear`, `/compact`, `/resume`, `/undo`, `/branch`, `/diff`, `/cost`, `/memory`, `/todo`, `/skill`, `/workspace`, `/model`, `/theme`, `/init`, `/instructions`, `/image`, `/plan`, `/bypass`, `/exit`
- Slash command parser intercepts BEFORE messages go to the agent.
- Completion: typing `/` shows menu; `<Tab>` accepts.
- Some commands change session state (`/model`, `/theme`, `/workspace`) — re-render.

### WHERE
- `packages/cli/src/inkTui.ts` — input handler intercepts leading `/`.
- `packages/cli/src/slashCommands.ts` — new: command registry, handlers.
- `packages/cli/src/entry.ts` — non-TUI commands (when piping headlessly via `crix run`).

### HOW
Registry pattern:
```ts
export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
  handler(args: string, ctx: SlashContext): Promise<SlashResult>;
}
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "Show available commands", handler: helpCmd },
  { name: "undo", args: "[N]", description: "Restore last N checkpoints", handler: undoCmd },
  ...
];
```

Ink: render menu when input starts with `/` and cursor not yet pressed Enter. Filter by prefix match. `<Tab>` autocompletes.

### TEST
`tests/v3-slash.test.mjs`:
1. `/help` returns help text without contacting provider.
2. `/cost` returns cost summary, doesn't bump turn count.
3. `/model qwen3-coder:480b-cloud` switches active model.
4. Unknown `/foo` returns "unknown command".

### GOTCHAS
- `/clear` must NOT delete the rollout — just hide visible history.
- `/exit` should checkpoint before quitting.
- Don't let slash commands consume credits.

### OP UPGRADE
**User-defined slash commands.** `.crix/commands/<name>.md` files become callable slash commands. The MD content is appended as a user message. So a team can ship `/review-pr` that injects their custom review checklist. Claude Code has this — match it. Even better: include `<args>` interpolation so `/review-pr 123` substitutes the issue number.

---

# T13 — Smart slot routing

### WHY
The agent always uses REASONER. But "summarize this 5k token blob" should hit SUMMARIZE (cheap, fast). "Rewrite this whole file from sketch" should hit APPLY. Routing at the tool level cuts cost 40%+.

### WHAT
- Tool schemas already have `providerHint` field — wire it.
- Engine picks slot based on hint + payload size heuristic.
- REASONER for: planning, multi-step, decision-making.
- APPLY for: ApplyIntent marker sketches (already done), FindAndEdit replacements, large rewrites.
- SUMMARIZE for: WebFetch summarization, /compact, memory auto-summarize, error log digestion.

### WHERE
- `packages/core/src/queryEngine.ts` — when a tool has `providerHint`, fire the call through the sub-model pool instead of the main provider.
- `packages/tools/src/_shared.ts` — `subModel` already in ctx; add `route(hint, input)` helper.

### HOW
Already partially wired via `ctx.subModel.apply()` and `ctx.subModel.summarize()`. T13 extends:
- New `ctx.subModel.route({ hint, prompt, maxTokens })`.
- WebFetch's summarization path uses this.
- New `ctx.subModel.classify({ text, labels })` — quick zero-shot classification on SUMMARIZE slot for routing decisions inside CodeMode etc.

### TEST
`tests/v3-routing.test.mjs`:
1. WebFetch with summarize prompt → calls SUMMARIZE pool slot, not main provider.
2. ApplyIntent marker sketch → APPLY slot.
3. FindAndEdit large dispatch → APPLY slot for each match (not main).
4. Engine main provider stays untouched during sub-slot calls.

### GOTCHAS
- Don't change provider mid-turn — sub-slot calls are INSIDE tool execution, not at message-stream boundary.
- Sub-slot failures must fall back to main provider with system_reminder noting degradation.

### OP UPGRADE
**Latency-aware routing.** Track p95 latency per slot. If APPLY slot is currently slow (model loading), route to REASONER as fallback. Self-healing pool. Combined with parallelism: if APPLY is busy on a long ApplyIntent, the next ApplyIntent waits OR uses REASONER. Smart degradation.

---

# T14 — Conversation-aware `/compact`

### WHY
Current `/compact` is dumb truncation. Real compaction summarizes old turns into a single system_reminder preserving file paths and decisions. Claude Code calls this "conversation summarization."

### WHAT
- `/compact` invokes SUMMARIZE slot with prompt to digest messages[0..N-10] into ≤ 800 tokens.
- Summary replaces those messages; keep last 10 verbatim.
- Auto-trigger when context > 80% of model's window.
- Summary format preserves: files mentioned, decisions made, errors hit, current goal.

### WHERE
- `packages/core/src/session.ts` — `compact()` method invokes SUMMARIZE.
- System prompt for SUMMARIZE: strict format guide.
- TUI `/compact` slash + auto-trigger on token threshold.

### HOW
SUMMARIZE prompt template:
```
You are compacting a coding session for context window management.
Summarize the following N messages into <800 tokens of structured notes:

# Files touched
- path/foo.ts: <one-line state>
# Decisions
- ...
# Current goal
- ...
# Outstanding errors
- ...

Preserve enough that the agent can resume without re-reading prior turns.
Drop verbose tool output. Keep file paths, function names, error messages verbatim.
```

Replace `messages[0..N-10]` with one user-role message containing the summary as a `system_reminder` block.

### TEST
`tests/v3-compact.test.mjs`:
1. 30-message conversation → compact → first message contains "Files touched" structure.
2. Last 10 messages preserved verbatim.
3. Auto-trigger when input tokens > 80% threshold (mock the threshold low).
4. Compacted history still produces coherent next turn (mock provider validates structure).

### GOTCHAS
- Tool_result blocks include big outputs — strip those in the summary.
- Don't compact if last message is a pending tool_result (would orphan the tool_use).
- Preserve ALL file_path references — agent needs them to resume.

### OP UPGRADE
**Selective compaction.** User picks `/compact tools` (just collapse tool_result blocks, keep messages), `/compact old` (compact pre-N), `/compact verbose` (aggressive 400-token summary). Different surgery for different states. Combined with auto-trigger: power-user control without losing autopilot.

---

# T15 — Predictive Read + speculative parallelism

### WHY
When agent fires Read(A), we KNOW it'll likely want Read(B) and Read(C) if they're imports of A. Pre-fetch and cache. Next tool call is instant. Same model — 30% perceived latency drop on multi-file flows.

### WHAT
- On every Read of a TS/JS/Py file, parse imports, pre-fetch up to 5 imported files into an in-memory cache.
- Subsequent Read(imported) hits the cache (still counts as a Read, still updates fileReadStamps).
- TTL: 60s or until file mtime changes.
- Off by default; opt-in via `CRIX_PREDICTIVE_READ=1` (until proven safe).

### WHERE
- `packages/tools/src/Read.ts` — post-call: extract imports, queue background reads.
- `packages/tools/src/readCache.ts` — new: LRU cache, TTL, mtime invalidation.

### HOW
Import extraction (cheap regex, not real parser):
- TS/JS: `/^import .* from ['"](.*?)['"]/gm`
- Python: `/^from (.*) import|^import (.*)/gm`

Resolve relative paths; ignore node_modules / packages without proper resolution.

```ts
// In Read.call, after successful read:
const imports = extractImports(filePath, content);
const resolved = await Promise.all(imports.map(i => resolveImport(filePath, i)).slice(0, 5));
for (const p of resolved) backgroundReadCache.warm(p);  // fire-and-forget
```

### TEST
`tests/v3-predictive-read.test.mjs`:
1. Read a.ts that imports b.ts → assert b.ts is in cache within 50ms.
2. Read of b.ts → returns cached content, no disk read (mock fs).
3. File mtime changed → cache invalidated.
4. Disabled by default; enable via env, then test.

### GOTCHAS
- Don't warm files that resolve outside workspace.
- Don't blow memory — cap cache at 5MB total.
- Pre-fetch must not bypass permission checks (don't warm a file the user hasn't approved).

### OP UPGRADE
**Speculative grep.** When agent runs Grep, also prefetch the first 3 hit files into Read cache. Most grep → read flows complete instantly. Same idea, different vector.

---

# T16 — Background watcher agents

### WHY
While the user types, run silent background work: verifier, recent git diff summary, prefetch likely files. Means when the user hits Enter, the agent already has context. Feels supernatural.

### WHAT
- Spawn 1-3 background tasks at session start that run continuously:
  - **GitWatcher**: every 30s, summarize `git diff HEAD` into a stash. Inject as system_reminder on next turn.
  - **VerifierLoop**: continuously runs `pnpm check` in a worker. Inject errors as reminders.
  - **PromptPrefetcher**: when user starts typing in TUI, no-op (later: speculate top-k likely tools).
- All cancellable on session end.

### WHERE
- `packages/core/src/watchers/gitWatcher.ts`
- `packages/core/src/watchers/verifierLoop.ts`
- `packages/core/src/session.ts` — wire start/stop.

### HOW
GitWatcher pseudocode:
```ts
async function gitWatch(workspace, onReminder, signal) {
  while (!signal.aborted) {
    await new Promise(r => setTimeout(r, 30_000));
    const diff = await exec("git diff --stat HEAD", { cwd: workspace });
    if (diff.trim()) onReminder(`git status: ${diff}`);
  }
}
```

### TEST
`tests/v3-watchers.test.mjs`:
1. Modify a tracked file → GitWatcher reminder includes the file within 35s (use small interval for test).
2. Session.close() → all watchers cancelled (no hanging tasks).
3. Reminders accumulate via drainSystemReminders, surface in next turn_start.

### GOTCHAS
- Don't watch in non-git repos.
- Reminders flood risk: dedupe — if same content as last reminder, skip.
- Verifier loop uses LOTS of CPU. Throttle to once per 60s by default.

### OP UPGRADE
**Smart pre-warm.** When user types `>` 3 characters in TUI input, run a SUMMARIZE-slot zero-shot classifier on the partial text → predict likely tools → pre-warm read cache for likely files (using current workspace's recent edits). By the time user hits Enter, context is already cached. Sub-second first-tool latency.

---

# T17 — Eval harness (`crix eval`)

### WHY
"Best harness of 2026" is vibes without a benchmark. Build one. Run nightly. PRs that regress get blocked.

### WHAT
- `crix eval [--suite default|swe-mini|user-defined]`
- Eval suite = directory of task folders:
  - `tasks/001-fix-typecheck-error/`
    - `repo/` (the starting workspace)
    - `goal.txt` (the prompt)
    - `verify.sh` (returns 0 if task complete)
    - `oracle.diff` (optional: expected diff for soft scoring)
- Runs each task in an isolated workspace copy with a deterministic seed.
- Outputs JSON report: per-task pass/fail/cost/turns/tools/duration.
- Compares against previous run, flags regressions.

### WHERE
- `packages/cli/src/eval.ts` — runner.
- `eval/` — new top-level dir with sample tasks.
- `tests/v3-eval-harness.test.mjs` — meta-test the harness.

### HOW
Tasks are git-cloned snapshots OR generated fixtures. Start with 10 small tasks:
1. Fix a deliberate TS type error.
2. Add a function matching a test that exists.
3. Refactor: rename variable across 3 files.
4. Find the bug in a Sudoku solver.
5. Add a CLI flag and update its help text.
... (the user can grow this over time)

Runner:
```ts
for (const task of tasks) {
  const tmp = await fs.mkdtemp(...);
  await copyDir(task.dir + "/repo", tmp);
  const result = await runCrix({ workspace: tmp, goal: task.goal, maxTurns: 30 });
  const passed = (await exec(task.verifyScript, { cwd: tmp })).code === 0;
  results.push({ task: task.id, passed, cost: result.cost, turns: result.turns });
}
```

Report:
```json
{ "rev": "0a64aeb", "ts": "...", "results": [...], "passRate": 0.8, "avgCost": 0.034 }
```

### TEST
`tests/v3-eval-harness.test.mjs`:
1. One fixture task with goal "create hello.txt with text hi", verify `[ -f hello.txt ]` — runs end-to-end with mock provider that simulates Write call → passes.
2. Failing task (mock won't produce expected output) → reported as fail.
3. Report JSON shape matches schema.

### GOTCHAS
- Each task isolated — never share state.
- Cap per-task budget (default 30 turns, $1) to prevent runaway.
- Use the mock provider for CI; gate real-model eval behind `CRIX_EVAL_LIVE=1`.

### OP UPGRADE
**`crix eval --diff <rev>` compares against any past commit.** PR template includes the diff output. Combined with a GitHub Action, every PR auto-runs the eval and posts results as a check. No regressions ship without notice. This is what makes "best harness" objectively defensible.

---

# T18 — Telemetry + `crix stats`

### WHY
Sessions saved, never analyzed. `crix stats` shows tools-used-most, avg turns/session, error rate, cost trends. Closes the feedback loop.

### WHAT
- All events from rollouts indexed into a local SQLite (`~/.crix/stats.db`).
- `crix stats` subcommand with views: `tools`, `cost`, `errors`, `latency`, `models`.
- Optional time range filters.
- 100% local; no upload.

### WHERE
- `packages/cli/src/stats.ts`
- `packages/core/src/statsIndex.ts` — on session-end, append to SQLite.
- New devDep: `better-sqlite3`.

### HOW
Schema:
```sql
CREATE TABLE turns (
  id TEXT PRIMARY KEY, session TEXT, model TEXT, ts TEXT,
  input INT, output INT, cache_read INT, tools INT, errors INT, duration_ms INT, cost_usd REAL
);
CREATE TABLE tools (
  turn_id TEXT, name TEXT, duration_ms INT, error INT
);
```

Queries:
- `SELECT name, COUNT(*) as uses, AVG(duration_ms) FROM tools GROUP BY name ORDER BY uses DESC`
- `SELECT DATE(ts), SUM(cost_usd) FROM turns GROUP BY DATE(ts) ORDER BY ts DESC LIMIT 30`

### TEST
`tests/v3-stats.test.mjs`:
1. Run 3 mock sessions, then `crix stats tools` lists used tools by frequency.
2. `crix stats cost --since 7d` returns daily aggregates.
3. SQLite file at `~/.crix/stats.db` after first session.

### GOTCHAS
- `better-sqlite3` is native — provide a no-sqlite fallback that just scans rollouts on the fly (slower but works without compile).

### OP UPGRADE
**`crix stats anomalies`** uses recent stats to surface unusual sessions: 3σ outliers on cost, error rate, turns. "Yesterday's session sess_xyz spent $4.20 (avg $0.30). Top tool: Bash (47 uses)." Helps catch runaway loops post-hoc, drives prompt improvements.

---

# T19 — Inline JS hooks (`.crix/hooks.js`)

### WHY
Hooks are exec-string only. Ergonomics suck for anything beyond `echo x`. JS hooks unlock everything.

### WHAT
- `.crix/hooks.js` exports `{ preToolUse?, postToolUse?, sessionStart? }`.
- Loaded via dynamic import; merged with `.json` hooks.
- Hooks receive `{ event, toolName, input, output, workspace }` and return `{ block?: boolean, reminder?: string }`.

### WHERE
- `packages/core/src/hooks.ts` — extend `load()` to try `.js` first, then `.json`.

### HOW
```ts
// .crix/hooks.js
export async function preToolUse(ctx) {
  if (ctx.toolName === "Bash" && /\bgit push\b/.test(ctx.input.command)) {
    return { block: true, reminder: "Don't push from Crix — ask the human." };
  }
}
```

Loaded:
```ts
const jsPath = path.join(workspace, ".crix", "hooks.js");
if (await exists(jsPath)) {
  const mod = await import(pathToFileURL(jsPath).href);
  if (mod.preToolUse) jsHooks.push({ event: "PreToolUse", fn: mod.preToolUse });
  // ...
}
```

### TEST
`tests/v3-js-hooks.test.mjs`:
1. Write `.crix/hooks.js` that blocks `Bash(rm -rf *)` → HookManager.run blocks with reminder.
2. JS hook + JSON hook both fire on same event.
3. Async hook (returns Promise) awaited properly.

### GOTCHAS
- JS hooks run in the same process — bugs can crash the session. Wrap in try/catch.
- Don't allow JS hooks from arbitrary path — only `<workspace>/.crix/hooks.js` and `~/.crix/hooks.js`. Skip if `<workspace>` is outside user's typical project root.

### OP UPGRADE
**`PostToolUse` hooks can return `injectMessage: string`** — let JS hooks inject feedback as a synthetic system_reminder for next turn. E.g. a post-write hook that runs `prettier --check` and if it fails, injects "prettier failed: ...". Custom verifiers per project.

---

# T20 — Visual mode (Playwright screenshot loop)

### WHY
Crix kills Cursor for UI work when the agent SEES its own rendered output. Edit CSS → screenshot → see → iterate.

### WHAT
- New tool `Screenshot(url, selector?)` returns image block.
- Auto-detects dev server (reads package.json `scripts.dev`, starts via background shell, polls port).
- Headless Chromium via Playwright (optional dep).
- Engine recognizes ImageBlock in tool result, injects as image content for next provider call.

### WHERE
- `packages/tools/src/Screenshot.ts`
- `packages/tools/src/devServer.ts` — detect + manage.
- `packages/core/src/queryEngine.ts` — tool_result with image block path → re-encode as image_url for next turn.

### HOW
Optional dep: `playwright-core`. Graceful skip when not installed.

```ts
import { chromium } from "playwright-core";
export async function takeScreenshot(url: string, selector?: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url, { waitUntil: "networkidle" });
  const buf = selector ? await page.locator(selector).screenshot() : await page.screenshot();
  await browser.close();
  return buf;
}
```

Tool output structure:
```ts
return {
  output: { url, byteLength: buf.length, mime: "image/png" },
  display: `📸 screenshot of ${url}`,
  imageBlocks: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: buf.toString("base64") } }],
};
```

Engine: when result has `imageBlocks`, prepend them to the tool_result content as image blocks (most providers accept image blocks inside tool_result).

### TEST
`tests/v3-screenshot.test.mjs`:
1. Skip if no playwright-core; assert tool errors helpfully.
2. With a tiny local HTTP server returning `<h1>hi</h1>`, Screenshot returns a non-empty PNG buffer.
3. Engine receives tool_result with image block → next provider request body contains image.

### GOTCHAS
- Playwright is HEAVY (~300MB on install). Make it explicitly opt-in: `CRIX_ENABLE_PLAYWRIGHT=1` to install + use.
- Dev server detection is fragile — fall back to user-supplied URL.
- Screenshot diffs: provide `before` and `after` URLs, return both, agent compares.

### OP UPGRADE
**Pixel diff in the agent's vision.** After an edit, screenshot BEFORE (from checkpoint) + AFTER, compute pixel diff, attach the diff image as a 3rd block. The agent literally sees "you changed THIS region." Turns the model into a designer with eyes. Nobody — not Cursor, not Codex, not Claude Code — has this.

---

# Cross-cutting work

### Type system
- `tests/v3-types.test.mjs` — round-trip protocol types through JSON, assert no loss.
- All new tools export their Output interface (TS4023 trap).

### Performance
- Add `crix bench` subcommand: measures startup ms, first-turn latency, parallel-batch throughput.
- Track in stats.

### Docs
- Update README with v3 capability matrix vs Cursor / Codex / Claude Code.
- Per-tool docs auto-generated from schema descriptions.

### Backwards compat
- Every change MUST keep existing tests green.
- New env flags default to OFF unless explicitly safer.

---

# Definition of Done

When all 20 ship:
- 200+ tests, all green
- Real LSP works on TS/Python/Rust/Go for users with the servers installed
- Cache hit rate visible and > 60% on long sessions
- /undo restores in < 100ms, even on large repos
- Live diff renders for every Edit/Write/ApplyIntent
- Image input works (paste + drag + /image)
- Memory layer survives 30 sessions without bloat
- Eval suite runs nightly with regression gating
- p95 turn latency < 4s on a 100-file repo
- Cost meter accurate to ±2%
- No regressions vs current 96 passing tests

When this list is done, Crix is the most capable open-source coding harness on the market. The user gets a tool that:
1. Sees its own work (images, diffs)
2. Learns over time (memory, CRIX.md)
3. Never serializes work it doesn't have to (parallel tools, predictive read)
4. Recovers from mistakes instantly (undo, branch)
5. Costs 70% less than the obvious alternative (caching, routing)
6. Catches its own errors before shipping (LSP diagnostics, hooks)
7. Has an objective scoreboard (eval)

That's not "cool." That's legendary.

---

## Execution rules for GPT

1. **One T at a time. In order.** Don't batch unrelated changes.
2. **Test-first.** Write `tests/v3-<short>.test.mjs` BEFORE implementation.
3. **Commit per T** with format: `Tn: <short title>` matching this doc.
4. **`pnpm verify` must pass before every commit. No exceptions.**
5. **If a T is bigger than expected, split into Tn.1, Tn.2.** Don't blob.
6. **Update this doc** when scope evolves. The doc is the source of truth.
7. **Read `D:\Crix\packages\cli\src\entry.ts` and `packages/core/src/queryEngine.ts` in full before starting T1.** They're the spinal cord.
8. **Don't add new top-level deps without justifying in the commit body.** Native deps (sharp, better-sqlite3, playwright-core) must be OPTIONAL.
9. **Windows-first.** The user runs Windows. Test paths, shells, clipboard there primarily.
10. **No silent fallbacks that hide failures.** If LSP isn't installed, say so loudly with a one-line fix hint.
