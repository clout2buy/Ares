# Ares

Ares (formerly Crix) is a TypeScript-first agent entity — *the battle-tested agent: it proves what it learns*. It combines a streaming engine, tool runtime, persistent identity, living memory, durable goals, browser connectors, and audited effect rails. The active directive is the ARES rebirth (`docs/roadmap/NEXT-ARES.md`): an always-on Garrison daemon, thin clients, and the Crucible empirical learning loop.

The repository is a pnpm workspace. Source lives under `packages/`; the optional desktop companion lives under `tauri/`.

## Quick Start

```powershell
cd D:\Ares
pnpm install
pnpm build
.\ares.bat help
```

Common commands:

```powershell
.\ares.bat                         # provider/model launcher
.\ares.bat chat --provider mock     # interactive terminal chat
.\ares.bat run --goal "fix failing tests"
.\ares.bat doctor                  # provider/runtime health
.\ares.bat agent doctor            # identity and agent runtime health
.\ares.bat mind doctor             # living-memory integrity report
.\ares.bat mind consolidate        # prune, dedupe, and crystallize memory
.\ares.bat operator attention      # inspect current Operator work queue
.\ares.bat operator add --goal "ship a feature"
.\ares.bat operator run --ticks 1
pnpm voice:tts                     # start the local Kokoro-82M voice sidecar
```

## Packages

- `@ares/protocol`: shared event, provider, reasoning, and tool-call shapes.
- `@ares/core`: sessions, query engine, providers, checkpoints, subagents, verifier, hooks.
- `@ares/tools`: local tool catalog and executors.
- `@ares/agent`: identity files, bootstrap, recall, heartbeat, dreaming, skills, self-reflection.
- `@ares/mind`: living memory, cognition, intent classification, memory diagnostics.
- `@ares/operator`: durable goals, control loop, capability graph, acquisition, attention, background loop.
- `@ares/effects`: budgets, ledger, kill switch, and side-effect rails.
- `@ares/connectors`: browser connector, browser effects, filmstrip proof.
- `@ares/cli`: command-line and terminal UI entrypoint.

## Repository Layout

```text
docs/                 Project docs and roadmap specs
packages/             Workspace packages
tauri/                Optional desktop companion
tests/                Node test suite
ares.bat, ares.ps1    Windows launchers
```

Runtime state belongs outside source control. The default durable home is `%USERPROFILE%\.ares`; repo-local `.ares/`, package `dist/`, Tauri build output, and smoke screenshots are ignored.

Interactive sessions are owner-local by default: Ares starts in bypass mode unless `dangerousBypass: false` is set in the UI settings file. See `docs/DEVELOPMENT.md` for the permission modes and verification workflow.

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
- `voice_service/`: optional local Kokoro-82M WebSocket sidecar for spoken replies.
