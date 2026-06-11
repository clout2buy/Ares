# ARES C-phases — First-Class Coding (the harness carries the model)

The directive: **whatever model sits in Ares, it codes like a senior engineer** — full-stack apps, whole repos, big-company projects. Model quality varies; harness quality is ours. Every C-phase below exists to remove one way a model fails at real coding, and every one is measured, not vibed (C6 is the referee).

The ARES laws still bind: deterministic spine, LLM judgment, deterministic verification. Tests-first, `pnpm verify` green per commit, commit format `Cn: <title>`.

---

## Why models fail at repo-scale coding (the six failure modes)

1. **Disorientation** — doesn't know where anything lives; greps blindly; edits the wrong layer.
2. **Unverified edits** — writes code, declares victory; the diagnostic/test feedback never reaches it.
3. **No plan pressure** — dives into multi-file work without decomposition; loses the thread mid-task.
4. **Context starvation** — the file it needs was trimmed; it re-reads or hallucinates.
5. **Amnesia across tasks** — re-derives the same repo conventions every session.
6. **One brain for everything** — burns the strong model on file searches, or worse, lets the weak model design architecture.

## C1 — The verified edit loop (kills #2)
**WHAT:** After EVERY Edit/Write/ApplyIntent, the harness automatically: runs LSP diagnostics on touched files, runs the nearest test file when one maps to the change, and feeds failures back as a system reminder the model cannot miss ("your edit broke X — fix before proceeding"). The ContinuousVerifier exists; this makes it mandatory, fast (debounced per batch), and loud. A turn cannot claim completion with red diagnostics on files it touched — the engine appends a convergence reminder instead.
**TEST:** edit introducing a type error → next model turn receives the diagnostic reminder; clean edit → no noise.

## C2 — Repo cartography (kills #1)
**WHAT:** At session start in a repo, inject a compact repo map: tree (depth-capped), package/module boundaries, entry points, build/test commands (from package.json/Makefile), and conventions (detected: ESM/CJS, test framework, formatter). Cached per repo + git-hash, rebuilt when stale. Plus: CodebaseSearch upgraded with the V4 embed index over symbols/file summaries — semantic code search for "where is auth handled".
**TEST:** map under 2k tokens for this repo; stale-hash rebuild; semantic hit on a paraphrase query.

## C3 — Plan pressure scaled by complexity (kills #3)
**WHAT:** The intent classifier already grades complexity. "Substantial" coding turns get forced scaffolding: a todo plan BEFORE the first edit (TodoWrite), per-step verification notes, and a final self-review step diffing the work against the stated plan. Trivial turns stay instant — no ceremony tax on "fix this typo".
**TEST:** substantial prompt → plan exists before first write tool call; trivial prompt → zero scaffolding.

## C4 — Model routing for coding lanes (kills #6)
**WHAT:** The modelRouter lanes get coding-aware assignments: exploration/search/summarize → cheap fast lane; edit/design/review → strong lane; the Task subagent runner routes per task type. One session, several brains, each where it pays.
**TEST:** route assignments resolve per lane; subagent dispatch uses the configured lane.

## C5 — The Crucible codes (kills #5, our unfair advantage)
**WHAT:** Witness candidates of kind `procedure` from successful coding turns carry repo-scoped tags (`domain:coding`, `repo:<name>`); recall surfaces them next session in the same repo ("last time, the installer needed build:runtime first"). Confirmed coding procedures with records feed C2's conventions block. No other harness remembers *what worked in this exact repo* with evidence attached.
**TEST:** a confirmed repo procedure surfaces in the next session's startup context for that repo only.

## C6 — The coding gauntlet (the referee — kills vibing)
**WHAT:** A benchmark harness (`ares eval coding`): a suite of real repo tasks (fix-the-failing-test, add-an-endpoint, refactor-without-breaking, cross-file bug) run headless against any provider/model, scored by probes (tests pass, build green, diff scope). The Garrison runs it on schedule; per-model batting averages land in the same evidence system as everything else. "Ares makes any model code better" becomes a NUMBER per model, tracked over time — and every C1–C5 change must move it.
**TEST:** gauntlet runs against mock + one real lane; report persists; regression in score flags red.

---

Definition of done: pick a mid-tier model, point Ares at a real repo, and watch it ship a multi-file feature with green tests — then read the gauntlet scoreboard proving the harness, not the model, did the carrying.
