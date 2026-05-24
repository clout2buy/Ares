# Crix Prompt Pack

Crix uses an original layered prompt pack. The goal is not to copy public prompts. The goal is to distill the best operating patterns into a prompt/runtime contract that Crix can execute and improve.

## Reference Inputs

- OpenAI Codex local repo: protocol boundaries, terminal flow, session state, safety policy, provider routing, and verification discipline.
- Friend-authored TypeScript CLI repo: TypeScript agent loop, tool contracts, shell safety, permissions, hooks, skills, memory, and CLI UX.
- Public prompt archive: pattern reference for agent behavior, tool schemas, planning, browser/process control, memory, and safety wording.

## Layers

- `identity`: Crix role, quality bar, small recoverable changes.
- `communication`: concise CLI updates, intervention handling, final proof.
- `context`: repo inspection before edits, targeted reads/searches, no guessing.
- `planning`: phase control for coding tasks, verification-first plans.
- `tool-catalog`: fully executable tool surface with policy gates.
- `tool-contract`: strict tool contracts and no invented capabilities.
- `edits`: checkpoints, focused patches, no unrelated churn.
- `verification`: narrow checks first, broader verification when needed.
- `memory`: durable architecture/user/provider facts only, no secrets.
- `subagents`: scoped delegation, clear ownership, integration proof.
- `skill-processes`: reusable processes for context, tools, QA, memory, browser, and proof.
- `safety`: credential, external-state, destructive-action, and approval boundaries.
- `output-contract`: Crix `UpgradePlan` JSON constraints for coding-task execution.

## Tool Runtime

Every catalog tool is implemented by `ToolRuntime`. Some tools are policy-gated because they touch external state or destructive local state. In those cases the tool returns a clear approval-required result unless the caller explicitly enables that class.

Providers see the full catalog. They should use the tools that match the task and improve weak tool behavior through scoped harness-improvement slices when needed.

## Skill Processes

Skill processes define how Crix should use its powers:

- `context-scout`: understand code before editing.
- `spec-plan-implement`: requirements, design, phases, then implementation.
- `safe-edit-checkpoint`: reversible writes and focused tests.
- `quality-gate`: diagnostics, type checks, tests, proof.
- `process-control`: managed long-running commands.
- `subagent-split-review`: safe delegation.
- `tasklist-control`: active task tracking for multi-step work.
- `memory-capture`: durable memory without secrets.
- `skill-orchestration`: load and run specialized Crix workflows.
- `browser-runtime-qa`: browser evidence for local UI/runtime changes.
- `external-research`: official-source research when facts may have changed.
- `repo-state-control`: local status/diff awareness without reverting user work.
- `artifact-proof`: durable proof and diagrams.
- `approval-gate`: explicit user approval for unsafe/external actions.

## Inspect Locally

```powershell
.\crix.bat prompt --summary
.\crix.bat tools
.\crix.bat skills --full
.\crix.bat tool run read_file --path README.md
```
