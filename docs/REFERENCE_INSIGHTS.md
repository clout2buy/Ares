# Reference Insights

Crix uses the local references as product and architecture inputs. This file records distilled patterns only; it should not copy prompt text or source code from the prompt archive or friend-authored repo.

## Runtime References

`C:\Users\Clout\Downloads\claude-code-main\claude-code-main\src`

- Strongest reference for query lifecycle, task state, tool permission flow, agent task isolation, terminal rendering, background task handling, and interruption via abort controllers.
- The important shape is a long-lived query/session engine that owns messages, tool use context, permissions, task state, and renderer updates.
- Subagents are treated as task objects with identities, tool scopes, abort state, notifications, and resumable transcripts.

`C:\Users\Clout\Downloads\codex-main\codex-main`

- Strongest reference for thread/turn/item protocol boundaries, session inspection, sandbox and approval policy, apply-patch discipline, model/provider capabilities, and app/server separation.
- The important shape is structured events: turn started, item started, item completed, plan updated, tool call state, file change state, and error state.
- Crix should keep terminal behavior and app/server behavior downstream of the same structured runtime records.

## Prompt And Tool Archive

`C:\Users\Clout\Downloads\system-prompts-and-models-of-ai-tools-main\system-prompts-and-models-of-ai-tools-main`

Useful tool-shape patterns observed:

- Claude Code: compact core surface around task agents, shell/process control, glob/grep/read/edit/multiedit/write, todo tracking, web fetch/search, and shell output control.
- Augment: broader IDE-grade surface with range views, codebase retrieval, diagnostics, git commit retrieval, managed process IO, browser open, web search/fetch, tasklists, memories, and diagrams.
- Cursor: small practical agent tool set around codebase search, file reads, terminal commands, directory listing, grep, edits, search/replace, delete/reapply, web search, diagrams, and notebooks.
- v0: product/UI leaning surface around repo search/read, web fetch/search, site inspection, todo management, design inspiration, and integrations.
- Replit: runtime/platform leaning surface around workflows, packages, languages, database, shell, deployment, user feedback, VNC/app feedback, and secrets.
- Manus: long-running environment surface around user messaging, file ops, shell exec/view/wait/write/kill, and browser navigation/click/input/mouse primitives.

## Crix Design Decisions

- Keep Crix tool names original and stable, but cover the same capability families.
- Use structured turn items as the source of truth for terminal rendering, session replay, interruption, and proof. Crix now records local tool/agent calls and queued user interventions through `TurnEngine`.
- Keep agents as scoped tasks with explicit allowed tools and durable summaries; do not let agents become hidden generic chat calls.
- Prefer a small high-quality core tool set before expanding tool count.
- Distill prompt behavior into Crix-owned rules and tests. Do not paste archive prompt text into the harness.

## Current Gaps

- Crix now records local tool/agent calls, provider chat, one-shot provider asks, model-planned `run` execution, policy decisions, structured artifacts, bounded provider planning/chat tool calls, session compaction/fork/resume/history, and queued interventions.
- Agents are scoped, visible, transcript-backed, use the active explicit TUI provider for live runs, emit durable completion notifications, and cancellation propagates provider abort signals.
- Toolcard rendering is backed by turn items and isolated in `packages/cli/src/tuiRenderer.ts`; the remaining UI work is deeper layout/polish, not basic separation.
- Provider tool-call execution is now an evented reusable loop for planning and chat; a future improvement is native provider-specific function-call streaming rather than JSON-envelope rounds.
