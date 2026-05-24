# Harness Target

Crix should become a coding-agent harness runtime, not a collection of CLI demos.

## Reference Roles

- `C:\Users\Clout\Downloads\claude-code-main\claude-code-main\src`: primary runtime reference for query lifecycle, agent spawning, tool permission flow, task state, interactive interruption, and terminal rendering patterns.
- `C:\Users\Clout\Downloads\codex-main\codex-main`: primary reference for thread/turn/item protocol shape, sandbox and approval boundaries, session inspection, apply-patch discipline, and app/server separation.
- `C:\Users\Clout\Downloads\system-prompts-and-models-of-ai-tools-main\system-prompts-and-models-of-ai-tools-main`: comparative reference for tool schemas, prompt behaviors, agent rules, and terminal coding-agent ergonomics. Use patterns, not copied prompt text.

## Product Bar

The harness needs these primitives before adding more surface features:

- Turn engine: every user message becomes an explicit turn intent with streamed thread items.
- Tool engine: tools run through typed schemas, permission checks, progress events, and durable results.
- Agent engine: agents are used naturally for independent research, review, and isolated implementation, with scoped tools and visible summaries.
- Interrupt engine: user messages can arrive during a run, be queued, and steer the next safe checkpoint.
- Session engine: sessions can be listed, resumed, inspected, forked, compacted, and rolled back.
- Renderer: terminal output shows reasoning summaries, tool calls, agent progress, diffs, and proofs without hard-coded demo copy.
- Prompt engine: prompts are layered from original Crix rules distilled from the references, with no verbatim prompt archive copying.

## Near-Term Build Sequence

1. Move local chat branching into `turnIntent` and make CLI only execute planned intents.
2. Replace direct `console.log` toolcard rendering with structured turn items. Local toolcards now route through `TurnEngine`; terminal output is a callback layer over structured items.
3. Move provider chat and plan execution under one `TurnEngine`. Provider chat records `assistant_message` artifacts, and model-planned `run` executions now record plan, policy, edit, command, agent, and proof items.
4. Give subagents persistent task state, abort controllers, scoped tools, and result notifications. Subagents now persist transcripts, support cancellation state, propagate provider abort signals, and write durable completion notifications.
5. Add a message queue for user interruptions during active turns. The TUI now queues lines during active local and provider-chat turns, records chat interruptions as `user_intervention` items, and keeps slash commands as queued control commands; steering an in-flight model stream before the next checkpoint is still pending.
6. Add session resume/compact using Crix events plus proof artifacts. Sessions now support compact summaries, forked directories, resume markers, and rehydrated history built from events plus turn artifacts.
7. Split `packages/cli/src/index.ts` into command modules and a TUI renderer. Toolcard rendering now lives in `packages/cli/src/tuiRenderer.ts`; command-module splitting remains future cleanup.

## Copy Policy

Codex is Apache-2.0 and can be copied with proper attribution if we intentionally vendor code. Friend-authored and prompt-archive content should be treated as pattern references unless explicit license and provenance are recorded in `docs/REFERENCE_BOUNDARIES.md`.
