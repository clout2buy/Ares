# TypeScript Mainline Architecture

Crix is TypeScript-first for fast dogfooding and model-driven self-upgrade.

## Packages

- `packages/protocol`: shared message, plan, tool, agent, memory, proof, and provider types.
- `packages/core`: agent kernel, context builder, memory store, provider router, subagents, policy, execution, reversible editor, Java bridge.
- `packages/cli`: simple local CLI.
- `java/crix-java-worker`: Java 8-compatible worker for future static-analysis/scoring tasks.

## Runtime Loop

```text
user goal / intervention
-> context builder loads repo + memory
-> system prompt advertises tools and agents
-> provider creates structured plan
-> policy checks each step
-> editor checkpoints before writes
-> subagents run through AgentOrchestrator
-> verification commands pass allowlist
-> proof.json + events.jsonl are written
```

## Design Rules

- Providers plan. Crix executes.
- Subagents are first-class, scoped, and recorded.
- Memory is durable JSONL under `.crix/memory`.
- Sessions are durable JSONL under `.crix/sessions`.
- External state changes stay denied by default.
- User interventions become messages and affect the run context.

