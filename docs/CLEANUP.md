# Cleanup Log

This file records source-tree cleanup decisions so removed or moved material is auditable.

## 2026-06-02

### Moved

- `NEXT.md` -> `docs/roadmap/NEXT.md`
- `NEXT-AGENT.md` -> `docs/roadmap/NEXT-AGENT.md`
- `NEXT-MIND.md` -> `docs/roadmap/NEXT-MIND.md`
- `NEXT-OPERATOR.md` -> `docs/roadmap/NEXT-OPERATOR.md`

Reason: roadmap/spec documents are project documentation, not root-level launch/config files. The content is preserved under `docs/roadmap/`.

### Removed From Source Control

- `.claude/launch.json`
- `.claude/settings.local.json`
- `demos/mario-game.html`
- `mario-game.bat`
- `tauri/target-native-smoke.png`
- `tauri/target-ui-smoke.png`
- `tauri/target-ui-smoke-frost.png`
- `tauri/target-ui-smoke-matrix.png`
- `tauri/target-ui-smoke-storm.png`

Reason: local tool settings, throwaway demo artifacts, launchers for deleted demos, and generated smoke screenshots do not belong in the repository.

### Removed From Local Working Folder

- `.ares/`
- `.scan-openclaw/`
- `packages/*/dist/`
- `packages/*/*.tsbuildinfo`
- `tauri/dist/`
- `tauri/src-tauri/target/`
- `tauri/*.log`
- `tauri/target-*.png`

Reason: ignored runtime state, local research checkout, and generated build/test output. These are recreated by normal commands (`pnpm build`, `pnpm test`, Tauri builds) and should not define the project structure.

### Optimized

- `README.md`: replaced stale command/reference list with a concise current project overview.
- `package.json`: added `lint` and expanded `clean` to remove generated output consistently.
- `packages/cli/package.json`: declared direct CLI dependencies on `@ares/connectors` and `@ares/effects`.
- `ares.ps1`: removed stale demo/game launcher path.
- `packages/mind/src/memory/store.ts`: repaired memory graph integrity and duplicate consolidation.
- `packages/mind/src/memory/doctor.ts`: added memory-health reporting.
- `packages/operator/src/attention.ts`: added deterministic attention selection.
- `packages/operator/src/backgroundLoop.ts`: added bounded background goal driver.

### Verification

- `pnpm lint`
- `pnpm test`

## 2026-06-02 Second Pass

### Added

- `docs/ARCHITECTURE.md`
- `docs/DEVELOPMENT.md`
- `docs/PACKAGE_BOUNDARIES.md`
- `scripts/clean.mjs`

Reason: current architecture, development flow, package dependency rules, and cleanup behavior now have dedicated docs and an auditable cleanup script.

### Optimized

- `package.json`: root build/check scripts now use the root TypeScript project references instead of repeating package order inline.
- `package.json`: root clean script now delegates to `scripts/clean.mjs`.
- `scripts/clean.mjs`: removes package build output, TypeScript build-info files, Tauri build output, Tauri generated schemas, logs, and smoke-test screenshots.

### Removed Dependencies

- `@ares/protocol` from `packages/agent/package.json`
- `@ares/protocol` from `packages/operator/package.json`

Reason: source import scan found no usage in either package.

## 2026-06-02 Stabilization

### Optimized

- Aligned workspace package manifests and TypeScript references with actual `@ares/*` imports.
- Documented the default owner-operated permission posture, including persisted bypass mode.
- Confirmed `pnpm clean` as the generated-output baseline, including repo-local `.ares/`, and documented that durable Ares home data is not deleted by cleanup.

### Added

- Minimal smoke tests for the clean/startup contract, root CLI launch behavior, and Tauri daemon launch expectation.

Reason: this pass keeps the repository ready for feature work without changing core logic or large runtime files.
