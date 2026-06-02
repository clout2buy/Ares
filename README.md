# Crix

Crix is a TypeScript-first coding-agent harness. It combines a streaming CLI, tool runtime, persistent agent identity, living memory, durable goals, browser connectors, and audited effect rails.

The repository is a pnpm workspace. Source lives under `packages/`; the optional desktop companion lives under `tauri/`.

## Quick Start

```powershell
cd D:\Crix
pnpm install
pnpm build
.\crix.bat help
```

Common commands:

```powershell
.\crix.bat                         # provider/model launcher
.\crix.bat chat --provider mock     # interactive terminal chat
.\crix.bat run --goal "fix failing tests"
.\crix.bat doctor                  # provider/runtime health
.\crix.bat agent doctor            # identity and agent runtime health
.\crix.bat mind doctor             # living-memory integrity report
.\crix.bat mind consolidate        # prune, dedupe, and crystallize memory
.\crix.bat operator attention      # inspect current Operator work queue
.\crix.bat operator add --goal "ship a feature"
.\crix.bat operator run --ticks 1
```

## Packages

- `@crix/protocol`: shared event, provider, reasoning, and tool-call shapes.
- `@crix/core`: sessions, query engine, providers, checkpoints, subagents, verifier, hooks.
- `@crix/tools`: local tool catalog and executors.
- `@crix/agent`: identity files, bootstrap, recall, heartbeat, dreaming, skills, self-reflection.
- `@crix/mind`: living memory, cognition, intent classification, memory diagnostics.
- `@crix/operator`: durable goals, control loop, capability graph, acquisition, attention, background loop.
- `@crix/effects`: budgets, ledger, kill switch, and side-effect rails.
- `@crix/connectors`: browser connector, browser effects, filmstrip proof.
- `@crix/cli`: command-line and terminal UI entrypoint.

## Repository Layout

```text
docs/                 Project docs and roadmap specs
packages/             Workspace packages
tauri/                Optional desktop companion
tests/                Node test suite
crix.bat, crix.ps1    Windows launchers
```

Runtime state belongs outside source control. The default durable home is `%USERPROFILE%\.crix`; repo-local `.crix/`, package `dist/`, Tauri build output, and smoke screenshots are ignored.

Interactive sessions are owner-local by default: Crix starts in bypass mode unless `dangerousBypass: false` is set in the UI settings file. See `docs/DEVELOPMENT.md` for the permission modes and verification workflow.

## Development

```powershell
pnpm lint     # TypeScript project check
pnpm test     # build + node --test
pnpm verify   # check + test
pnpm clean    # remove generated build/log artifacts
```

The main quality rule is simple: changes should be backed by focused tests and reality checks. Build success is not enough for user-facing behavior; verify commands, files, HTTP probes, browser state, or logs as appropriate.

## Docs

- `docs/ARCHITECTURE.md`: current package architecture and runtime flow.
- `docs/DEVELOPMENT.md`: setup, scripts, generated output, and verification policy.
- `docs/PACKAGE_BOUNDARIES.md`: intended package dependency direction and known boundary debt.
- `docs/AGENT.md`: agent layer and identity scaffold.
- `docs/BLUEPRINT.md`: original architecture blueprint.
- `docs/CODEX_BUILD_SPEC.md`: implementation reference.
- `docs/CLEANUP.md`: cleanup and move/removal log.
- `docs/roadmap/`: historical NEXT specs and future-roadmap notes.
