# Crix Architecture

Crix is a TypeScript-first coding-agent harness. The CLI is the composition root; the packages under `packages/` provide focused runtime layers, and `tauri/` provides the optional desktop companion.

## Runtime Flow

1. `@crix/cli` parses commands, selects providers, loads permissions/settings, registers tools, and starts terminal or headless runs.
2. `@crix/core` owns sessions, streaming turn orchestration, provider adapters, checkpoints, hooks, verification helpers, and subagent execution.
3. `@crix/tools` exposes local tools used by the session engine.
4. `@crix/agent`, `@crix/mind`, `@crix/operator`, `@crix/effects`, and `@crix/connectors` add durable identity, living memory, goal execution, side-effect rails, and browser automation.
5. Durable state is stored outside the source tree by default under `%USERPROFILE%\.crix`.

## Packages

- `@crix/protocol`: shared message, event, tool-call, permission, checkpoint, and reasoning types.
- `@crix/core`: provider-neutral engine layer. Depends on protocol and should not depend on CLI, agent, operator, mind, effects, or connectors.
- `@crix/tools`: tool catalog and shared execution helpers. Depends on core/protocol contracts.
- `@crix/agent`: identity scaffold, persistence, recall, heartbeat, dreaming, missions, self-model, and skill runtime.
- `@crix/mind`: living memory store, cognition helpers, intent classification, and memory diagnostics.
- `@crix/operator`: durable goals, scheduler, capability acquisition, control loop, attention selection, and background execution.
- `@crix/effects`: budgets, ledger, kill switch, owner leash, and guarded effect execution.
- `@crix/connectors`: browser connector and browser effect integration.
- `@crix/cli`: command-line entrypoint, terminal UI, provider routing, command handlers, and tool registration.

## Desktop Companion

`tauri/` is a separate workspace package for the desktop UI. It shells into the built CLI entrypoint, so desktop runs require the TypeScript packages to be built first.

## Current Pressure Points

- `packages/cli/src/entry.ts` is intentionally left unchanged for now, but it is the largest composition file and should be split after this cleanup phase.
- `@crix/effects` and `@crix/operator` currently import path or file helpers from `@crix/agent`. That boundary should be fixed in a later pass by moving shared home/path/write helpers into a neutral layer.
- `packages/core/src/providers/ollamaCloud.ts`, `packages/core/src/queryEngine.ts`, and the Tauri UI files are large but should not be refactored until there are targeted regression checks.
