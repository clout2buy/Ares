# Crix

Crix is a TypeScript-first coding-agent harness with a Java worker bridge. The codebase is intentionally TypeScript + Java only.

## Simple Run

Open PowerShell:

```powershell
cd D:\Crix
.\crix.bat help
```

Main commands:

```powershell
.\crix.bat           # launch interactive TUI (provider/model picker, then chat)
.\crix.bat run --goal "fix failing tests in auth module"  # coding task run
.\crix.bat dry       # safe dry-run (sample plan), writes proof only
.\crix.bat apply     # applies sample plan through policy/checkpoints
.\crix.bat test      # runs TypeScript tests
.\crix.bat verify    # TS check + tests + Java worker build
.\crix.bat doctor    # runtime/provider status
.\crix.bat java      # build and probe Java worker
.\crix.bat login      # OpenAI ChatGPT OAuth device-code login
.\crix.bat ollama use kimi-k2.6:cloud # save preferred Ollama Cloud model
.\crix.bat ollama models # show Ollama Cloud suggestions
.\crix.bat upgrade    # alias for run with harness-improvement default goal
.\crix.bat ask "What should we build next?"
.\crix.bat prompt --summary # inspect prompt pack
.\crix.bat sessions       # list recent Crix run sessions
.\crix.bat sessions show latest # inspect latest run events/proof
.\crix.bat sessions history latest # inspect rehydrated events + turn items
.\crix.bat sessions compact latest # write a compact resume summary
.\crix.bat sessions fork latest # fork a prior session directory
.\crix.bat turns          # list structured tool/agent turn artifacts
.\crix.bat turns show latest # inspect latest turn items
.\crix.bat tools       # inspect functional tool catalog
.\crix.bat tool run read_file --path README.md # execute one tool directly
.\crix.bat skills --full    # inspect skill processes
```

Inside the TUI:

```text
/provider openai      # switch provider without restart
/model 2              # switch selected model by number
/model list           # show model choices for active provider
/agents               # show available subagent roles
/agents notifications # show durable subagent completion notifications
/agent researcher inspect current harness # run one visible subagent
/tools run            # execute ToolRuntime calls with inputs, timing, proof
inspect the tool runtime # natural chat trigger for live tool execution
inspect agent orchestration # natural chat trigger for visible agent runs
make me an html then open it # runs a toolcard task, writes HTML, opens browser
learn this repo D:\Repo and pitch improvements # read-only repo scout
D:\Repo is u!        # set active TUI workspace
inspect              # scout the active workspace read-only
learn it             # scout the active workspace read-only
deep scan it         # bounded read-only deep scan of active workspace
/status               # show active provider/model/auth state
```

Memory:

```powershell
.\crix.bat memory add "Prefer TypeScript for the main Crix harness" --tag architecture
.\crix.bat memory search architecture
```

## What It Does Now

- Builds context from repo files and durable memory.
- Uses a strong Claude-Code-style prompt discipline for coding-agent behavior.
- Uses an original layered prompt pack with tool catalog, skill processes, subagent rules, memory rules, and proof discipline.
- Provides live slash-style TUI controls for provider, model, agents, tool runs, and status.
- Runs local tool and agent turns through the core `TurnEngine`, including call inputs, timing, output previews, queued interventions, and a proof artifact.
- Routes supported task requests through compact visible toolcards instead of letting the chat model merely describe intended actions.
- Queues messages typed during active local work, records them as `user_intervention` turn items, and processes queued commands after the current turn reaches a safe checkpoint.
- Records provider chat turns as structured `assistant_message` artifacts, and provider chat can run bounded Crix tool-use rounds before the final answer.
- Records one-shot `ask` provider calls as structured turn artifacts too, without changing the simple answer-only command output.
- Records model-planned `run` executions as structured turn artifacts too: plan creation, policy decisions, file changes, command executions, agent calls, and proof.
- Derives effective step safety from the actual step type before applying policy, so mislabeled write steps are still blocked in read-only modes.
- Persists subagent transcripts under `.crix/agents`, including scoped tools, interventions, completion, failure, or cancellation state.
- Writes durable subagent completion notifications under `.crix/agents/notifications.jsonl`, visible through `/agents notifications` and the `agent_notifications` tool.
- Runs visible TUI subagents through the active provider when `/provider openai` or `/provider ollama` is selected, falling back to mock only when no live provider is selected/configured.
- Propagates provider abort signals for cancellable subagent runs.
- Supports bounded provider planning and chat tool calls, so GPT can request read-only Crix context tools before returning the final answer or `UpgradePlan`.
- Supports session compaction, forking, resume markers, and full thread-history rehydration through `crix sessions compact|fork|resume|history`.
- Supports read-only repo scout requests for local paths, producing grounded findings and an improvement pitch without edits.
- Keeps provider-chat tool use visible as assistant/tool/result events in the TUI; simple direct OpenAI/Ollama stream parsers remain available in core.
- Supports provider routing boundaries for mock, plan-file, OpenAI OAuth, and Ollama Cloud through local Ollama.
- Supports natural subagent roles: architect, coder, reviewer, researcher, toolsmith, and qa.
- Tracks a Crix tool catalog backed by runtime executors. External/destructive tools are functional but policy-gated.
- Applies plan steps through policy, checkpoints, verification, and proof reports.
- Lets you pass interventions with `--intervention "new instruction"` during model-directed runs.
- Uses Java as a worker bridge for future static-analysis/scoring capabilities.

Core operating loop:
- Inspect context
- Plan scoped patch
- Apply reversible edits
- Run focused verification
- Summarize with proof

## Provider Status

OpenAI ChatGPT OAuth is wired through a device-code login flow:

```powershell
.\crix.bat login
.\crix.bat status
.\crix.bat ask "hello"
.\crix.bat run --goal "make Crix better"
```

OAuth tokens are stored outside the repo at `%USERPROFILE%\.crix\auth.json` unless `CRIX_HOME` is set. ChatGPT OAuth routes through the Codex backend; `OPENAI_API_KEY` routes through the OpenAI Platform Responses API.

Ollama Cloud is routed through your local Ollama app/server at `http://127.0.0.1:11434` by default:

```powershell
.\crix.bat ollama status
.\crix.bat ollama list
.\crix.bat ollama use kimi-k2.6:cloud
.\crix.bat ollama ask kimi-k2.6:cloud "hello"
.\crix.bat run --provider ollama --model kimi-k2.6:cloud --goal "fix the parser bug"
```

Crix does not perform Ollama login. It sends selected Ollama Cloud model IDs to the local Ollama API. Preferred model and host settings are stored outside the repo at `%USERPROFILE%\.crix\ollama.json` unless `CRIX_HOME` is set.

## Reference Boundary

The friend-authored TypeScript repo and local OpenAI Codex repo are references. This TypeScript implementation is original work that ports the architecture ideas without copying wholesale.

Prompt archive content is used only as pattern inspiration. Do not copy external prompt text directly into Crix. See `docs\PROMPT_PACK.md`.

