# Architecture

Crix is a TypeScript-first coding-agent harness with a Java worker bridge.

## Packages

- `packages/protocol`: Stable serialized types for plans, events, tools, agents, verification reports, and proof reports.
- `packages/core`: Trusted runtime: `TurnEngine`, provider abstraction, prompt pack, tool catalog, skill processes, safety policy, reversible edits, verification, event store, memory, Java bridge, and self-upgrade orchestration.
- `packages/cli`: Interactive/headless CLI entrypoint for chat, self-upgrade execution, provider auth, memory, prompt inspection, tool inspection, and verification.
- `java/crix-java-worker`: Java worker bridge for heavier local analysis and future static scoring.

## Runtime Loop

```text
user/model goal
-> Crix classifies the turn intent before local execution or provider chat
-> TurnEngine owns local tool/agent execution, provider-chat artifacts, turn items, artifacts, and queued interventions
-> Crix builds context from repo files and durable memory
-> layered prompt pack describes behavior, tools, skills, safety, and proof
-> provider creates an UpgradePlan
-> if the provider asks for read-only tool calls first, Crix runs them through the evented provider tool loop and sends results back
-> plan is written to event log
-> plan creation is recorded as a structured turn artifact
-> each step is policy checked
-> every allow/deny decision is recorded as a `policy_decision` turn item
-> state-changing steps get a checkpoint
-> edits are applied inside workspace only
-> verification commands run through allowlist
-> proof.json records applied/denied steps, agents, and verification result
```

## Prompt And Tool Spine

Crix separates three things:

- Turn intent: whether a message should run local harness tools, scout a repo, create an artifact, ask a provider, or only update local state.
- Turn engine: the core runtime primitive for structured tool/agent calls, user interventions, turn artifacts, and CLI/TUI rendering callbacks.
- Prompt pack: how the model should think and collaborate.
- Tool catalog: functional Crix functions, safety class, process mapping, and execution contract.
- Skill processes: repeatable methods for context scouting, safe edits, self-upgrade, QA, subagents, memory, browser checks, and proof.

The provider sees all three. Every catalog tool is runtime-backed; unsafe classes are policy-gated instead of fake.

## Invariants

- Every session has an append-only `events.jsonl`.
- Session history is inspectable with `crix sessions` and `crix sessions show latest`.
- Local tool/agent turns write structured artifacts inspectable with `crix turns` and `crix turns show latest`.
- Model-planned `run` executions also write structured turn artifacts with plan, policy, edit, command, agent, and proof items.
- Policy uses effective safety derived from the step type, so a provider cannot make a write safe by labeling it `read-only`.
- Subagent runs persist transcript JSON under `.crix/agents`.
- Subagent completion notifications persist under `.crix/agents/notifications.jsonl`.
- Subagent cancellation propagates `AbortSignal` to provider requests when supported by the provider client.
- Sessions can be compacted, forked, marked resumed, and rehydrated with `crix sessions compact|fork|resume|history`.
- User messages arriving during active local work are queued, recorded as `user_intervention` turn items, and drained at safe checkpoints between calls.
- Every write has a checkpoint manifest before mutation.
- Workspace-write mode cannot edit outside the workspace.
- Verification commands are direct argv commands, not arbitrary shell strings.
- External state changes are denied by default regardless of permission mode.
- A model provider returns plans; it does not directly mutate files.
- Weak tools must be improved through scoped, tested self-upgrade slices.
