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

The default long-horizon coding benchmark is `ares eval coding --suite coding-v2`.
It records integrity, proof, false-green, token, prompt, task-manifest, and
tool-schema data under the Ares home. Real-model runs execute candidate code;
run them in a disposable VM/container and pass `--allow-unsafe-process-eval`.

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

`pnpm test` is one of those times. Parts of the suite exercise code that writes to
the durable home, so a full run leaves a real `~/.ares` behind — on a clean machine
it creates one. Redirect `HOME` (or `ARES_HOME`) to keep your own out of it:

```bash
HOME=$(mktemp -d) pnpm test        # POSIX
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
