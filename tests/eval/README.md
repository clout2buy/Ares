# Ares Coding-Agent Eval Harness

The **shipped, committed** scoreboard for Ares's coding ability. Unlike the
ephemeral `ares gauntlet` command (which reads tasks from `~/.ares/gauntlet/`),
these benchmark tasks live in the repo and the runner reports real metrics.

- **Tasks:** `tests/eval/tasks/*.json` — small, deterministic coding problems.
- **Runner:** `tests/eval/runner.mjs` — seeds a temp workspace per task, drives
  the **real `QueryEngine` loop** with real `Write`/`Edit` tools, then grades
  the resulting workspace with **real probes**.
- **Self-test:** `tests/eval-harness.test.mjs` — proves the harness plumbing +
  grading + scoreboard math are correct (`node --test tests/eval-harness.test.mjs`).

## Quick start

```bash
# Mock mode (default) — deterministic, no network, no API key.
node tests/eval/runner.mjs

# One task, machine-readable output.
node tests/eval/runner.mjs --task fix-off-by-one --json

# A REAL model — this is what produces real quality numbers.
ANTHROPIC_API_KEY=sk-... node tests/eval/runner.mjs --provider anthropic
OPENAI_API_KEY=sk-...    node tests/eval/runner.mjs --provider openai

# Pick the model for the real run.
ARES_EVAL_MODEL=claude-... ANTHROPIC_API_KEY=... node tests/eval/runner.mjs --provider anthropic
```

Exit code is `0` if every task passed, `1` otherwise — CI-friendly.

## What the scoreboard reports

Per task: **PASS/FAIL**, tool-call count, input/output tokens (from the
engine's usage), wall-clock time, and a grading detail line. In aggregate:

- **SUCCESS RATE** — passed / total.
- **TOKENS** — total input / output across the suite.
- **WALL CLOCK** — total run time.

The `runEval()` function returns this as a structured object
(`{ schemaVersion, suite, provider, taskCount, passed, failed, successRate,
totalInputTokens, totalOutputTokens, totalDurationMs, tasks: [...] }`) so it can
be diffed across models or plotted over time.

## Grading is real (three probe types)

- `fileContains` — the produced file must contain an exact substring.
- `fileEquals` — the produced file must match expected bytes exactly.
- `command` — a shell command (usually `node -e "..."` / `node --test`) must
  exit `0`. This actually runs the code the agent wrote.

No credit is given for prose. A no-op agent scores 0 — the self-test asserts
this explicitly.

## ⚠️ HONEST DISCLAIMER: mock mode validates the harness, not agent skill

The default `--provider mock` uses a **scripted provider that solves each known
task by construction**. It exists so the harness is deterministic and runnable
in CI with no network. A 100% success rate in mock mode means only that:

> the engine loop, the tools, the grading probes, and the scoreboard math all
> work correctly.

It says **nothing** about how good the real agent is. Mock mode cannot fail a
task for skill reasons because the "skill" is hard-coded. **Real quality numbers
require a real provider** (`--provider anthropic|openai`, with an API key). Only
those runs measure whether Ares can actually solve the tasks.

To add a benchmark task, drop a new `tests/eval/tasks/NN-name.json`. Real
providers pick it up automatically. If you also want it covered in mock mode's
plumbing check, add a scripted solution under `SOLUTIONS` in `runner.mjs`
(optional — tasks without one deterministically fail in mock mode, which is
itself a useful negative control).

## Task spec format

```jsonc
{
  "id": "fix-off-by-one",
  "title": "Fix an off-by-one bug in a range function",
  "prompt": "…what the agent is asked to do…",
  "seedFiles": { "range.mjs": "…starting content…" },   // optional
  "grade": { "type": "command", "command": "node -e \"…\"" }
  // or { "type": "fileContains", "path": "x", "value": "…" }
  // or { "type": "fileEquals",   "path": "x", "value": "…" }
}
```
