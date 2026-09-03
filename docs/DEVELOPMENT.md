# Ares Development

## Setup

```bash
cd /path/to/Ares      # Windows: cd D:\Ares
pnpm install
pnpm build
```

The workspace uses `pnpm` and TypeScript project references. The root `tsconfig.json` defines the package build order.

## Common Commands

```bash
pnpm build          # compile all TypeScript packages
pnpm check          # compile all packages with concise TypeScript output
pnpm lint           # alias for pnpm check
pnpm test           # build, then run the Node test suite
pnpm verify         # lint, build, and test through the standard scripts
pnpm clean          # remove generated build, Tauri, log, and smoke-test output
pnpm install:cli    # put `ares` on PATH from this checkout
pnpm uninstall:cli  # remove it again
```

`install:cli` and `uninstall:cli` go through `scripts/install-cli.mjs` and
`scripts/uninstall-cli.mjs`, which dispatch per platform: on Windows they run the
existing `scripts/install.ps1` / `scripts/uninstall.ps1` unchanged; everywhere else
they write (and remove) a launcher in `${XDG_BIN_HOME:-$HOME/.local/bin}`. Neither
touches your PATH, your shell config, or the Ares home. `docs/PLATFORM-SUPPORT.md`
records the exact contract and which platforms it is tested on.

The default long-horizon coding benchmark is `ares eval coding --suite coding-v3`
(coding-v2 saturated at 100% for deepseek-v4-pro with and without the harness on
2026-08-15; it remains available for trend continuity).
It records integrity, proof, false-green, token, prompt, task-manifest, and
tool-schema data under the Ares home. Real-model runs execute candidate code;
run them in a disposable VM/container and pass `--allow-unsafe-process-eval`.

`ares eval trend` reads the append-only scoreboard those runs write and prints
one line per comparable cell plus the harness on/off A/B. Two runs are only ever
compared when the suite, task manifest, provider, model, and harness setting all
match — the system-prompt and tool-schema hashes are deliberately excluded from
that key, because they change exactly when the harness changes and the harness is
what is under test.

`ares eval coding --gate` exits 3 when a run regresses against its own history.
It gates on tokens per score point, verified rate, false-green rate, wall-clock,
and score — **not** score alone, which coding-v3 proved saturates at frontier
tier. One prior run is reported as advisory; the gate needs two or more, because
a single baseline is too noisy to fail a build on.

The CLI entrypoint is built to `packages/cli/dist/entry.js`. Use `pnpm build` before running `pnpm ares` or before launching the desktop companion after a clean.

## Permission Posture

Ares is currently tuned as a local owner-operated agent. Interactive CLI sessions start in `bypass` mode unless `~/.ares/ui.json` (`%USERPROFILE%\.ares\ui.json` on Windows) or `$ARES_HOME/ui.json` contains `dangerousBypass: false`.

Permission modes:

- `bypass`: tool prompts are auto-allowed. This is powerful and should be used only in trusted local workspaces.
- `workspace-write`: normal guarded editing mode. Workspace writes are allowed through the permission engine; external or risky operations still need explicit handling.
- `plan`: write tools are blocked so the agent can inspect and propose changes without modifying files.

Use `/plan` or `/code` to return to guarded modes. Use `/danger` or `/bypass` to toggle bypass mode. The toggle persists through `dangerousBypass` in the Ares UI settings file.

## Runtime State

Do not store runtime state in the repository. The default durable Ares home is:

```text
~/.ares                 # %USERPROFILE%\.ares on Windows
```

`$ARES_HOME` overrides it. Point it at a throwaway directory when you need to run
the CLI without touching your real home.

**One vault, both surfaces.** The desktop resolves the same `~/.ares` the CLI
does. It used to resolve `<config dir>/Ares/home` instead — `~/.config/Ares/home`
on Linux, `%APPDATA%\Ares\home` on Windows — so on a default install the terminal
and the app were two agents over two vaults with separate sessions, memory, and
encrypted keys. On first launch after the change the desktop adopts a pre-split
vault automatically (a rename where it can, a copy where the paths sit on
different filesystems). If BOTH homes hold state it never merges them: it uses
`~/.ares`, leaves the old directory untouched, and logs where it is. Nothing is
ever deleted.

`pnpm test` used to be one of those times: parts of the suite exercise code that
writes to the durable home, so a full run left a real `~/.ares` behind and created
one on a clean machine. The `test` script now preloads `tests/_isolate-home.mjs`,
which points `ARES_HOME` at a fresh temp directory per test-file process and
removes it on exit — no manual `HOME` redirection needed.

Setting `ARES_HOME` yourself still wins, so a run against a specific home works
exactly as before:

```bash
ARES_HOME=/path/to/scratch pnpm test
```

Two traps if you isolate the environment further. `ARES_SELF_TRIAGE=0` fails
`tests/reliability-triage.test.mjs`, which asserts the default `cadence` review
state. And `tests/z-stabilization-smoke.test.mjs` spawns `pnpm` itself, so `pnpm`
has to stay on PATH inside whatever environment you hand the runner.

Ignored generated output includes package `dist/`, TypeScript build-info files, Tauri build output, Tauri generated schemas, logs, and smoke-test screenshots.

`pnpm clean` removes generated repository outputs, including repo-local `.ares/` session artifacts created by tests or local runs. It intentionally does not delete the durable Ares home because that can contain user memory, permissions, and identity state.

Markdown memory transactions use an adjacent cross-process lease plus exact-byte
compare-and-swap. `ARES_MEMORY_LOCK_TIMEOUT_MS` controls the bounded wait for a
live writer (default `10000`, clamped to `100..300000`), and
`ARES_MEMORY_LOCK_STALE_MS` controls when a dead writer's lease may be reclaimed
(default `60000`, clamped to `1000..3600000`). A live local PID is never reclaimed
solely because its lease is old.

## Verification Policy

For cleanup and package-boundary changes, run:

```bash
pnpm lint
pnpm build
pnpm test
pnpm clean
```

For user-facing CLI behavior, also run the relevant `pnpm ares ...` command (on Windows, `.\ares.bat ...` works too) or an equivalent smoke test. For desktop UI changes, take screenshots before and after the change.

## Env knobs (tuning surface, 2026-09 batch)

Every threshold added by the September 2026 coding + assistant batch is an `ARES_*`
variable, documented at its definition site. Quick index (default in parentheses):

| Knob | Effect |
|---|---|
| `ARES_EDIT_AUTO_READ=0` | Restore the old "Read before editing" deny; default auto-reads and edits when the match is unique. |
| `ARES_SHELL_POLICY=allowlist` | Every non-read-only shell command asks; default keeps the destructive-only prompt. |
| `ARES_STRICT_VERIFY=0` | Legacy `completed` turn status even with unverified changes (default emits `needs_verification`). |
| `ARES_VERIFY_SUBAGENT=0`, `ARES_VERIFY_SUBAGENT_MIN_FILES` (3) | Adversarial verifier subagent auto-spawn for turns touching N+ files. |
| `ARES_SUBAGENT_MAX_DEPTH` (1) | Subagent nesting cap; at the cap children lose Task/Conductor/CodingBackend. |
| `ARES_PLAN_BEFORE_EDIT=0` | Disable forcing TodoWrite as the first call of a substantial coding turn. |
| `ARES_PINNED_FAILOVER=0`, `ARES_ROUTING_BACKUP` (comma list) | Failover chain for a pinned model (also `routingBackup` in ui.json). |
| `ARES_COMPACT_CLIP_CHARS` (1500) | Compaction clip for tool bodies; edit diffs and paths are never clipped. |
| `ARES_TURN_MEMORY_SIM` (0.85), `ARES_MEMORY_RECENCY_WEIGHT` (0.5) | Near-duplicate collapse for captured turns; liveness ranking of live-mind nodes. |
| `ARES_CONSOLIDATE_EVERY_MIN` (90, 0 off), `ARES_CONSOLIDATE_MIN_NEW` (12) | Periodic memory consolidation in a long-lived daemon. |
| `ARES_GAUNTLET_SCHEDULE=0`, `ARES_GAUNTLET_HOUR` (3), `ARES_GAUNTLET_WINDOW_HOURS` (3), `ARES_GAUNTLET_SUITE` (coding-v3) | Nightly gauntlet in the Garrison idle window. |
| `ARES_BRIEF_SOURCE_TIMEOUT_MS` (8000), `ARES_BRIEFING_HOUR`, `ARES_OWNER_LOCATION` | Day brief sources (weather, calendar, reminders, email, missions). |
| `ARES_HEAP_PROFILE=0`, `ARES_HEAP_PROFILE_INTERVAL_BYTES` (262144) | Sampling heap profiler feeding `heapAllocTop` into heap-critical crash artifacts. |
| `ARES_SYMBOL_INDEX_MAX_FILES` (20000), `ARES_CODESEARCH_EMBED=0`, `ARES_CODESEARCH_EMBED_BUDGET_MS` (1500), `ARES_EMBED_MODEL` (nomic-embed-text) | Symbol index and optional hybrid embedding ranking for CodebaseSearch. |
| `ARES_CROSS_SURFACE=0`, `ARES_CROSS_SURFACE_HOURS` (24), `ARES_CROSS_SURFACE_CHARS` (1200) | "Elsewhere today" digest of the owner's other sessions. |
| `ARES_CHECKPOINT_GIT=0`, `ARES_CHECKPOINT_MAX_AGE_DAYS` (14, 0 off), `ARES_CHECKPOINT_GC_DELAY_MS` (5000) | Git-tree checkpoint layer inside repos (blobs elsewhere); age-based retention that finally lets blob GC reclaim; deferred first sweep. `/rewind` restores files AND truncates the conversation to the checkpoint. |
| `ARES_TOOL_TIER=legacy`, `ARES_DYNAMIC_TOOLS=0` | Restore the keyword tool router / send every tool schema. |
