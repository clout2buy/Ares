# DevoEngine

A Python runtime for agents that work for hours or days on real codebases and
real tasks without losing the plot. Designed from first principles, checked
line by line against what the Ares garrison learned in production.

Status: design, v2 (complete redesign). Nothing is implemented. Appendix B is
the register of every garrison mechanism and where it lands in this design;
it is the proof that nothing was dropped by accident.

---

## 0. The thesis

Every agent harness in use today, Ares included, is built on one shape: a
transcript grows, a model reads it, tools append to it, and when it gets too
big something summarises it. Every long-horizon failure the garrison recorded
is a consequence of that shape:

- the summary lost the how (46 of 49 post-compaction edit failures);
- the cheap compaction wiped the working set every eight results;
- constraints were "the first thing lost across repeated compactions";
- the plan was a list re-sent wholesale; the goal was a string at the top;
- a 2-hour session carried 4 to 14 million input tokens per turn;
- subagents could not nest because results had nowhere to go but prose;
- recovery was layered on afterwards: kernel tables, a rollout file, a
  checkpoint store, three different lease waits, a replay cap added after the
  third incident.

DevoEngine starts from a different shape, built on ten principles:

1. **The log is the truth.** A run is an append-only event log. Every other
   piece of state is a fold over it. Recovery is replay. There is no second
   store that can disagree.
2. **Context is compiled, not accumulated.** Each model call receives a view
   assembled for that step from a knowledge store, a short attention window,
   and the work graph. The transcript is not the memory.
3. **Nothing is forgotten, only demoted.** Old rounds, old reads, old errors
   leave the window and enter the knowledge store, indexed. The model can
   recall them; the compiler can resurface them. Compaction destroys nothing.
4. **Work is a graph the runtime schedules.** The plan is a dependency graph
   with scopes and definitions of done. The runtime, not the model, decides
   what runs next and what runs in parallel.
5. **Every effect is a transaction.** Intent is recorded before a tool runs,
   outcome after. An interrupted effect is unknown, reconciled, never blindly
   repeated.
6. **The workspace has a history.** Every mutation is a commit in a shadow
   history. "What changed since the last green check" is a runtime fact.
7. **Guards terminate; the model does not.** Iteration caps are backstops.
   Loop, grind, oscillation and stall detectors are the real terminators.
8. **Done is defined before work starts.** Tasks carry acceptance. The
   runtime decides status from evidence, never from the model's claim.
9. **Prefix stability is an invariant.** Nothing volatile touches the system
   prompt or the tool list. Every history mutation is accounted for.
10. **The brain is pluggable; the kernel is not.** Providers, tools, approvers,
    memory and surfaces are plugins. The kernel, the step loop and the
    compiler are the product.

The claim: an engine built this way is better at long-horizon coding and
general agent work than the garrison, with the same model, because it removes
the structural cause of the remaining failures while keeping every
incident-proven defence. Section 17 defines how that claim is measured.

---

## 1. Scope

**In**: long-running autonomous coding in a repository; multi-step agent work
(research, web, shell, files, APIs); durable runs that survive restarts and
waits of hours; parallel work on one codebase; many agents per host; an
embeddable Python SDK; a gateway with the garrison's wire protocol.

**Out**: Telegram, phone, personas, rooms, Forge, browser bridge, desktop
control, payments, email, calendars, connectors gallery, voice, life
surfaces, Oricle; the continuous verifier subsystem; the living-memory graph
with dreaming and witness. Windows is deferred (POSIX first).

---

## 2. Core model

```
Agent        a tenant: home dir, config, credentials ref, memory, policy
Workspace    a directory; owns a kernel DB, a shadow history, an index
Run          durable, goal-level work in a workspace; one event log
  Goal       the root of the work graph; the ask, verbatim
  WorkGraph  tasks with deps, scope, acceptance, status
  Worker     a step loop bound to one task (one or many per run)
  Step       one provider call and its tool rounds
  Round      one assistant tool batch and its results
  Wait       a parked run awaiting timer, process, path, webhook or user
Input        a message admitted to a run: queue | steer | wake
Event        the unit of truth; persisted, numbered, streamed
Snapshot     a materialised fold of the log at a step boundary
```

### 2.1 Run lifecycle

```
created ─admit─► queued ─lease─► running ◄──────────────┐
                                  │  ├─ waiting(permission|approval|user|wait_for)
                                  │  ├─ paused(owner) ─────────────────────┤
                                  │  ├─ interrupted                        │
                                  │  ├─ failed (input stays claimed; resumable)
                                  │  └─ done: completed | needs_verification
                                  └─ step boundary: snapshot ──────────────┘
```

Two status axes, kept separate as in Ares so failover never mistakes red work
for a dead provider: **execution** (completed, needs_verification,
interrupted, failed) and **work** (verified, unverified, blocked,
not_applicable).

### 2.2 Inputs

- `queue`: runs after current work reaches a safe boundary (FIFO).
- `steer`: lands at the next safe boundary (all tool_use paired, nothing in
  flight). During a provider call it aborts the attempt (speculative). During
  tool execution it waits for settlement. During maintenance it aborts the
  summariser. Every steer gets its own provider slot.
- `wake`: generated by a Wait completing; carries the wake payload.
- Idempotency: input id is the key; same id + different bytes is a conflict;
  a replayed, settled input gets a synthetic terminal event (no "ack then
  silence").

---

## 3. Kernel: the event log

### 3.1 One log per run

```
events(run_id, seq, ts, kind, actor, body_json, causation_seq)
```

Appended by a single serialised writer per workspace DB (SQLite, WAL).
`actor` is `user | model | tool:<id> | worker:<task> | runtime | host`.
`causation_seq` links an event to the one that caused it (a tool_end to its
tool_start, a wake to its wait), which makes the log a tree you can trace.

Everything is an event: inputs admitted, steps started, provider attempts,
deltas (not persisted; see 3.4), messages committed, tool admitted and
settled, permissions asked and answered, graph changes, knowledge entries,
compaction, snapshots, waits, wakes, guard firings, run end.

### 3.2 Projections

State is derived by folding events. Projections are pure functions and are
unit-tested against event fixtures:

- `MessageWindow`: the current attention window (message ids and epochs).
- `WorkGraph`: tasks, statuses, dependencies, assignments.
- `Knowledge`: the knowledge store's index (bodies live in a content store).
- `ToolLedger`: tool runs by state, transaction ids, touched files.
- `Guards`: streaks, signatures, one-shot flags.
- `Calibration`: token scale, learned ceiling.
- `Stamps`: file read evidence.
- `Budget`: tokens, cost, wall clock consumed.

### 3.3 Snapshots

At every step boundary the kernel writes a snapshot: the serialised
projections plus the `seq` they fold to. Boot loads the latest snapshot and
folds the tail. Snapshots are content-addressed and deduplicated; the ledger
of snapshots is itself the run's "save game" history.

### 3.4 What is not persisted

Streaming deltas (`text_delta`, `thinking_delta`, `tool_use_input_delta`) and
`tool_progress` are streamed to subscribers but never written. Ares learned
this at 224 MB of Bash progress and 85 KB browser frames that grew a log to
355 MB. Committed messages carry the final text.

### 3.5 Leases and idempotency

One lease per run, TTL 30 s, heartbeat TTL/3, holder pid recorded. At boot,
leases whose pid is dead are expired at once (no 21-second wait). Clean
shutdown releases leases. Lease loss interrupts the worker. Tool runs are
keyed `generation:tool_use_id` so a replay addresses the same run.

### 3.6 Outbox

Side effects that leave the process (webhooks, host notifications, wake
timers) are written to an outbox table in the same transaction as the event
that caused them and delivered by a relay. A crash between "decided" and
"sent" cannot lose or duplicate a notification.

---

## 4. The work graph

The plan is data the runtime executes, not text the model re-reads.

```python
class Task(BaseModel):
    id: str
    title: str
    parent: str | None
    deps: list[str]                 # must be done before this starts
    scope: list[str] = []           # path globs this task may write
    acceptance: Acceptance | None   # how "done" is decided
    status: Literal["pending","ready","running","waiting","done",
                    "blocked","cancelled"]
    assignee: str | None            # worker id while running
    budget: Budget | None
    notes: str                      # model's running note, replaced not appended
    evidence: list[EvidenceRef]     # checks, diffs, handoffs that justify status

class Acceptance(BaseModel):
    check: str | None               # a command from the check grammar
    files_exist: list[str] = []
    assertion: str | None           # free text the model must address in its handoff
```

### 4.1 Who edits it

- **The model**, through the `plan` tool: `set` (whole graph on first plan),
  `add`, `update(status, notes, acceptance, scope, deps)`, `split` (replace a
  task with children), `cancel(reason)`. Plan-before-edit forces `plan.set`
  as the first call of a substantial coding step.
- **The runtime**: marks `ready` when deps are done; `running` when a worker
  takes it; `done` only when acceptance passes (or there is none and the
  worker closes it with a handoff); `blocked` when acceptance fails twice or
  a blocker is opened; records evidence.

### 4.2 Scheduling

Every step boundary the scheduler computes ready tasks. Rules:

- The root goal is implicit; the graph's leaves are what run.
- A worker runs one task at a time, depth-first along the current branch, so
  sequential work has the continuity of a single agent.
- Tasks with disjoint `scope` and no dependency between them are eligible for
  **parallel workers**, up to `DEVO_PARALLEL_WORKERS` (default 1; raise it
  for fan-out). Each parallel worker runs in a worktree (§7.4); merge is a
  CAS transaction at task close; a conflict reopens the task with the
  conflicting hunks in its notes.
- Tasks without `scope` are never parallelised (unknown blast radius).
- A task that is `waiting` (on a Wait or a user) releases its worker; the
  scheduler picks another ready task if one exists, else the run parks.

This is the Conductor's deterministic fleet idea folded into the plan itself.
The model declares structure; the runtime executes it on any model, including
weak ones that would otherwise stop early or mis-thread results.

### 4.3 Definition of done

When a worker marks a task done the runtime:

1. runs `acceptance.check` if present (bounded, through the shell tool
   pipeline, as a system actor); red → task stays `running` with the failure
   in notes; red twice → `blocked`;
2. checks `files_exist`;
3. requires a **handoff** (§5.6) that addresses `assertion` if present;
4. records evidence and emits `task_done`.

**Acceptance is not the worker's to weaken.** A model under grind pressure
will write a trivially green check. So:

- `acceptance.check` must be a command from the check grammar whose runner is
  one of the detected project checks (§7.3) or a known test runner; arbitrary
  shell is refused at `Plan` validation.
- A check that names a test file **created or modified by the same task** is
  `provisional`: it counts only after the `judge` lane reviews the test's
  diff against the task's title, notes and assertion and answers "tests the
  claim". The judge sees the diff, not the worker's prose.
- The task's shadow diff is scanned for weakened tests: deleted test files,
  added skip/xfail/`.only`/`it.skip` markers, assertions removed. Any hit
  marks the acceptance `suspect`; the task cannot close without the judge
  and a note explaining the change. Project-wide, the same scan feeds the
  run's work status (§6.7): a green suite after a weakened test is not
  `verified`.
- Acceptance can be **tightened** by a worker (adding a check) without
  review; it can only be **loosened** by the planner lane with a
  `graph_changed{op: loosen_acceptance, reason}` event, and never by the
  worker currently assigned to the task.

The run completes when every non-cancelled task is done and the root
acceptance (if any) passes. Work status for the run is derived from evidence
(§6.7), never from the final message.

### 4.4 Rendering

The graph renders into the compiled context as: the current task with its
parent chain, acceptance and notes; its siblings' statuses in one line each;
the next 6 ready tasks; counts of the rest. Never the whole tree past 40
tasks.

---

## 5. Workers and the step loop

A worker is the garrison's turn loop, re-homed: it runs one task's steps,
reads the compiled context, and reports through the event log. There is one
worker per run by default; parallel workers are the same code.

### 5.1 The step, in exact order

```
step(worker):
  1  cancel token checked (Stop visible at every boundary)
  2  apply steering at boundary
  3  bounded pre-step hooks (each ≤ DEVO_PREP_TIMEOUT_MS, cancel-aware):
       knowledge retrieval for this task -> compiled sections
       repository instructions discovery -> claims
       repo intelligence refresh if a boundary file changed
  4  maintenance (commit projection first, cancellable, skipped after a steer):
       image rung -> text rung -> window demotion
  5  cancel token checked
  6  tool catalog for this step (core tier fixed order + transient + loaded)
  7  COMPILE context (§6): system (stable) | compiled sections | window
  8  budget ladder [B, .5B, .25B, 8k, 4k] with floors; sticky cut; images; blind strip
  9  arm attempt (a racing steer restarts at 2)
 10  wire-log, then stream with merged signal (cancel | steer | stall)
 11  hold message_done; stream deltas live; on end:
       superseded -> discard, to 2
       clean close with nothing -> synthetic retriable no_message_done
       rate-limit failover probe
       transient / capacity / network ladders; stall shrink; unresponsive breaker
       context-limit -> learn ceiling (never from stalls or 413) -> next rung
 12  reconcile truncated tool_use; withhold partial calls (shared cap 3)
 13  refusal self-heal: strip strippable sections once and retry
 14  commit assistant message (event) ; yield message_done
 15  no tools:
       max_tokens continue | empty-turn nudge | plan gate | promise gate
       task close requested? -> acceptance (§4.3) -> handoff -> scheduler
       otherwise close step at boundary; snapshot; yield turn_end
 16  tools: resolve, normalise, classify, authority
       dep-aware batches -> pool(5) -> per call: pause check, pre-mutation
       commit (§7.1), admit, pre-hook, tool_start, watchdog(call), post-hooks,
       settle, tool_end, cap/spill
       ordered tool_result message; skipped-by-steering reported
 17  knowledge ingest from outcomes (§6.2)
 18  post-round guards in order (§9)
 19  snapshot
 20  to 1
```

### 5.2 Failure protocol

At the second identical failure signature in a step the worker enters
**diagnose mode** for that failure:

1. If a learned fix exists for the signature (project, then global), inject
   it: "RECALLED FIX, apply before anything else."
2. Otherwise inject the diagnose frame: state the exact error line, list
   evidence already gathered, write two hypotheses, test exactly one with a
   read-only action before any further mutation.
3. The failure breaker (3 consecutive) and grind guard (4 alert, 8 stop) run
   unchanged; at the kill limit the task becomes `blocked` with the failure
   history in its notes rather than the run failing outright, unless it is
   the only task.

When a failure streak clears after a change of approach, the runtime writes
a learned fix candidate (signature, the diff of what changed, the model's
note) to the agent's memory (§11).

### 5.3 Waits

`wait_for(kind, spec, timeout)` is a tool that parks the task:

- `timer`: wake at a time;
- `process`: wake when a background job exits;
- `path`: wake when a path changes (mtime/hash poll or inotify);
- `webhook`: wake on an inbound POST to a one-time URL issued by the host;
- `user`: wake when the user answers a structured question (`ask_user`).

The task becomes `waiting`, the worker is released, the lease is dropped if
no other task is ready, and no tokens are spent. The wake arrives as a `wake`
input with the payload. This replaces the sleep-poll anti-pattern (26 browser
calls and 24 s of sleeps for a pomodoro) and the garrison's watchers and
standing orders in one primitive. Timeouts wake with `timed_out`.

### 5.4 Model lanes

Each step is dispatched to a lane: `planner` (graph construction and
splitting), `worker` (default), `reader` (read-only exploration children,
knowledge summaries, context compile helpers), `judge` (reducers, acceptance
assertions). Lanes map to provider+model in agent config; default is one
strong model for all with `reader` on a cheaper one. Reasoning level per lane,
with the garrison's adaptive dial (never above the configured ceiling, deep
verbs keep it, greetings drop it, a failed round restores it).

### 5.5 Supervisor

Per run:

- **Silence**: no event for 15 min → interrupt ×2, abort ×2, evict. Detached
  replays are watched too.
- **Progress**: no graph or knowledge change for `DEVO_RUN_STALL_STEPS` (12)
  steps → one reminder; at 2× → run `blocked(no_progress)`.
- **Budget**: tokens, cost, wall clock per run and per task; 85 % warning;
  100 % graceful stop at the next boundary with a `budget_exhausted` task note.

### 5.6 Handoffs

Every task close, child return and parallel merge produces a handoff built by
the runtime from events, never from prose alone: files touched (with final
hashes), commands run with exit codes, checks and results, errors, the
model's closing note (≤ 700 chars). The handoff is appended to the parent
context as one message and stored as knowledge.

---

## 6. The context compiler

### 6.1 What the model sees

```
[system]  craft core | provider overlay | standing rules | tool doctrine (core tier)
          | project notes (pinned) | repository instructions | environment
          -- byte-stable for the whole run --
[window]  the last K rounds verbatim (assistant + tool results), oldest first
          -- mutated only by demotion / rung clears, from the front --
[tail]    the final user message of the prompt, rebuilt every step:
          ┌ tool_result blocks for the last round (if any)           ┐
          │ compiled sections (keyed):                                │
          │   goal + constraints (verbatim)                           │
          │   work graph view (§4.4)                                  │
          │   knowledge: relevant facts for this task (§6.3)          │
          │   recall: prior-run memory (§11)                          │
          │   reminders: guards, acceptance results, recovery notes   │
          │ the pending user text (if any)                            │
          └──────────────────────────────────────────────────────────┘
```

**Placement rule (this is what makes principle 9 hold).** Compiled sections
exist in exactly one place: the tail message of the outbound prompt. They are
rendered at compile time and are **not stored in history**; the committed
history holds only the tool_results and the user text. Nothing is ever
removed from earlier messages to make room for a new instance, so the
window's cache front moves only when demotion or a rung clear changes it
from the front. The tail message changes every step, which is exactly the
cost every harness already pays for a new user turn and is what the rolling
Anthropic breakpoint is for. Sections come after any tool_result blocks in
that message (the Anthropic 400 incident). For forensics the compiler logs a
`context_compiled{seq, section_hashes, tokens}` event, not the bodies; the
replay harness recompiles deterministically from the log.

The system prompt never changes mid-run.

### 6.2 The knowledge store

A per-run store of typed facts, each with a body in a content store and a
row in an FTS index, tagged by task and step:

| kind | written by | example |
|---|---|---|
| `constraint` | model (`plan`/`note`), runtime (repo rules) | "Keep old endpoints behind a flag." (verbatim) |
| `decision` | model | "Use v3 client; v2 lacks idempotency keys." |
| `file` | runtime on Read/Edit/Write; model via `note` | path, last hash, model note, edit digests |
| `symbol` | runtime (index) | `BillingClient.charge` at `billing/client.py:88` |
| `check` | runtime | `pytest tests/billing` red, step 41, first error line |
| `failure` | runtime | signature, count, last step, resolution |
| `round` | runtime on demotion | a demoted round: assistant text, tool calls, result heads |
| `handoff` | runtime | §5.6 |
| `doc` | runtime | repo map, README head, package manifests |
| `external` | model via `note`, WebFetch summaries | a fetched page's summary with URL |

Ingest happens at step 17 from tool outcomes. Nothing in the window is ever
deleted: when the window demotes a round (§6.4), the round becomes a
`round` fact with its full body in the content store.

### 6.3 Retrieval and ranking

Per step, the compiler selects facts for the current task under
`DEVO_KNOWLEDGE_TOKENS` (default 8000):

1. **Always**: constraints; the current task's `file` facts within its scope;
   the last 3 `check` facts; open `failure` facts for this task; the latest
   `handoff` from a child or dependency.
2. **Ranked**: FTS over the task title, notes, the last user message and the
   last assistant text, scored by BM25 × recency decay × kind weight
   (`decision` 1.5, `file` 1.3, `failure` 1.3, `round` 0.8, `doc` 0.6).
   Optional embeddings (`DEVO_EMBED=1`) blend 0.4 cosine.
3. **Dedupe** by content hash; render oldest-first within kind so the prefix
   of the section is stable across steps when the set is stable.

The model can pull more with the `recall` tool: `recall(query, kinds, task,
limit)` returns ranked facts with ids; `recall(id)` returns a full body (for
example, a demoted round or an old Read, paged like Read).

Why this beats summaries: the compiler is deterministic and cheap, the model
asks for what it needs, and what it needs is still there. The garrison's
summariser ran 30 s side queries whose 7000-token output became the only
copy of eighty thousand tokens of work.

### 6.4 The window and demotion

The window keeps the last `DEVO_WINDOW_ROUNDS` (default 20) rounds verbatim
within the current task, plus the task's opening message. Older rounds are
**demoted**: removed from the window, stored as `round` facts, and the
window's start is recorded as a context epoch (crash resumes at the same
footprint). Demotion is the only "compaction" of history. It is lossless by
construction.

Two cheaper tiers run before demotion, both from Ares:

- **Image rung**: images in tool results older than 2 rounds are cleared once
  at least 6 are stale, replaced by "[screenshot cleared, re-take]".
- **Text rung**: when the calibrated estimate exceeds the threshold, clear
  bodies of the oldest compactable tool results (reads, greps, shell output,
  web) down to 0.5× threshold, keeping the last 6 and the newest 3 reads of
  each of the last 8 edited files; batch gate 8 candidates or 16k tokens;
  cleared read stamps are invalidated so a recovery Read is not refused.
  Three ineffective passes force demotion.

Task scopes make this rarely matter: a task that closes collapses its whole
window into a handoff; the parent window grows by one message per task.

### 6.5 Budget ladder and cache discipline

Unchanged from Ares, because it is right: budget `min(0.75 × window,
192k cap)`; ladder `[B, .5B, .25B, 8k, 4k]`, descent rungs floored at
overhead + 12k, minimum 4 messages kept, never lead with an orphan
tool_result; sticky cut on the top rung (re-cut only when the tail no longer
fits, to 75 %); image fit `[8,4,2,1,0]` under a 3 MB payload cap with
attached images dropped last; blind-model image strip on the outbound copy
only; learned ceilings per provider+model persisted with 30-day TTL, floor
16k, never learned from stalls or 413s.

Cache invariants, enforced by one module: system prompt composed once per
run; tool schemas in fixed core order with loaded tools appended; every
window mutation passes through `Window.mutate(reason)` which records the
earliest changed index; `cache_front_moves` is a per-step metric; three
Anthropic breakpoints (system, last tool, rolling last message).

### 6.6 Token estimation

Content-aware ratios (prose 4, code 3, base64 2.5, CJK 1 per char, indent 12,
newline 0.25), images by dimension, EWMA calibration 0.7/0.3 clamped
[0.5, 2.5], per-block memo invalidated on mutation (the gigabytes-of-garbage
exit 134), 8 tokens per message. Max output tokens 128k where supported.

### 6.7 Work status from evidence

- **Check grammar** (anchored, single command, no chains/pipes/redirects/
  `--help`/`--dry-run`/background): test, build, lint, typecheck runners
  across ecosystems.
- A check is **current** if its evidence tick is newer than the last
  mutation's and it is whole-suite or scoped to a changed file stem,
  directory, package or test root.
- Run work status: `verified` if the last mutation has a current green check;
  `unverified` if mutations exist without one; `blocked` if the last current
  check is red; `not_applicable` if nothing mutated.
- `unverified`/`blocked` → execution status `needs_verification`.
- No end-of-turn re-verification push (the 2026-10-15 decision).

---

## 7. Workspace service

### 7.1 Shadow history

Every mutation (Edit, Write, ApplyPatch, patch merges, and any shell command
classified as a potential mutation) produces a **shadow commit**: a git tree
built through a shadow index (`GIT_INDEX_FILE` under `.devo/shadow`), anchored
under `refs/devo/runs/<run>/`. The user's index, HEAD and branches are never
touched. Outside a git repository, a blob store with 2 MB per-file cap is
used and skips are reported.

What this buys:

- pre-tool checkpoint for free (the commit before the mutation);
- `diff(step_a, step_b)` and `diff(last_green_check, now)` as runtime facts,
  rendered into the compiled context when a check goes red;
- rewind to any step (`Checkpoint rewind`), cutting the window before the
  anchoring tool_use id (ids, not indices, which shift under demotion) and
  invalidating stamps;
- opaque mutations (shell) get touched files from the diff, with a sentinel
  when the diff fails (unknown mutation scope, fail closed).

Home directories and drive roots are refused as too broad. Checkpointing is
bounded (20 s) and degrades to "proceeding without undo" rather than killing a
Write.

### 7.2 Mutation transactions

All file writes go through one service: path locks (in-process and
cross-process), CAS on expected content hash, staged bytes fsynced then
renamed, journal entries per transition, readback after write (cloud-sync
filesystems), rollback or reconcile on interruption. Transaction id is
`sha256(run, tool_use_id)`, stable across crash replay.

### 7.3 Repository intelligence

Runtime services the compiler and tools draw on:

- **Repo map**: deterministic, bounded, fingerprinted; packages, entry points,
  test roots, manifests; refreshed every N coding steps or when a boundary
  file changes. Never an LLM summary (no invented architecture).
- **Symbol index**: regex-per-language extractor, cached by git HEAD under
  `.devo/index/`, degrades to "missed a symbol", never crashes a step.
- **Project checks**: detected test/build/lint/typecheck commands from
  manifests, cached 5 minutes, rendered in the environment block.
- **Repository instructions**: first convention file per directory
  (`AGENTS.md`, `CLAUDE.md`, `.devo/RULES.md`), root → leaf, bounded walk;
  a newly seen nested rules file causes a pre-effect deny until read;
  provably read-only commands are exempt and carry the rules in their result.

### 7.4 Worktrees for parallel workers

Inside a git repository a parallel worker gets a **plain git worktree**
(`git worktree add --detach .devo/worktrees/<task> <base>`), which already
handles `.git` exclusion, ignores, and cleanup, and costs a checkout rather
than a copy. Dependency directories (`node_modules`, `.venv`, `target`) are
not tracked, so they are linked in per ecosystem: a symlink where the
toolchain tolerates it, a reflink copy where the filesystem supports it
(btrfs, xfs, APFS), and otherwise a fresh install in the worktree, which is
reported in the task's notes as a cost. Reflink is an optimisation, never a
requirement: on ext4 the design still works, it just copies or reinstalls.

Outside git, a copy-on-write directory copy is used, excluding `.devo`, with
external symlinks failing closed.

At task close, the worker's shadow diff is applied to the base as one CAS
transaction against the base hashes recorded at fork. A conflict reopens the
task with the conflicting paths in notes and the worker's diff kept as a
`handoff` fact. Worktrees are removed after a successful merge and kept (and
named in the run's end report) after a conflict.

---

## 8. Tools

### 8.1 Contract

```python
class Tool(Protocol):
    name: str; description: str
    input_model: type[BaseModel]
    safety: Literal["read-only","workspace-write","external-state","destructive"]
    concurrency: Literal["parallel-safe","exclusive"]
    defer: bool = False
    max_result_chars: int | None = None      # None engine default, 0 self-bounded
    watchdog_ms: int | None = None           # None class default, 0 = 13-min ceiling
    def watchdog_for(self, inp) -> int | None
    def classify(self, inp) -> SafetyClass | None
    def validate(self, inp, ctx) -> str | None         # pre-effect error
    def command_for(self, inp) -> str | None
    def activity(self, inp) -> str
    async def call(self, inp, ctx: ToolContext) -> ToolResult
    effect_policy: EffectPolicy | None                 # reconcile() for remote effects
```

Schema emission strips `default`, numeric exclusive bounds, collapses unions
for OpenAI-shaped endpoints. Lenient parsing: strip invented keys and retry;
parse JSON-encoded strings for array/object fields; field aliases
(`path→file_path`, `old→old_string`, `cmd→command`, Grep flags). Name
resolution by canonical key and aliases.

### 8.2 Execution pipeline

Per call: owner-pause wait (bounded by the watchdog budget) → shadow commit
for write/destructive → steering epoch check → **admit** (event) → pre-hook
→ steering check → `tool_start` (only after admission) → `watchdog(call)`
with merged signal → post-hooks (each its own synthetic run) → **settle**
(succeeded/failed/effect_unknown, touched files) → `tool_end`/`tool_error` →
cap and spill → knowledge ingest.

Watchdog precedence: `watchdog_for(input)` → `watchdog_ms` (0 = 13 min) →
`DEVO_TOOL_WATCHDOG_MS` → class default (external 20 s, write 60 s, read
30 s). Paused during permission waits. Never unref'd.

Batching: model order preserved; a new batch on a solo tool, on a shared
target with a writer, on exclusive tools without analysable targets. Pool of
5. A permission denial interrupts an interactive worker; it is a per-call
error for children (`denial_interrupts=False`).

Result cap: 24k chars unless self-bounded; over budget the full output is
spilled to `.devo/tool-results/<run>/<id>.txt` in a line-pageable form; the
model sees head 2000, a marker, a hint, tail 600; computed once.

### 8.3 The belt

Core tier, fixed order:

```
Read, Edit, Write, ApplyPatch, Glob, Grep, Bash, BashOutput, KillShell,
Plan, Note, Recall, Memory, WaitFor, AskUser, WebSearch, WebFetch,
CodebaseSearch, Task, TaskOutput, KillTask, EnterPlanMode, UpdatePlanDraft,
ExitPlanMode, ToolSearch
```

Deferred (via `ToolSearch`): Diff, Bisect, Symbols, Checkpoint, Worktree,
McpListTools/McpCallTool and live `mcp_*`, Skills, ImageSearch, plugins.

Rules carried from Ares with their incidents (full detail in Appendix B):

- **Read**: `cat -n`, 2000 lines, 4000 chars/line, 50 KB/page, exact line
  count and sha256 from one streaming pass, stat re-check, self-bounded (the
  spill-of-a-spill brick), PDF pages, images, directories.
- **Edit**: unique match or `replace_all`; tiers exact → whitespace → anchor →
  normalised; function replacement; rejects numbered `old_string`; auto-read
  when no stamp (62 of 68 errors were "Read first"); stale stamp retried
  against current bytes; all-or-nothing batches; `new_string_from_file`;
  syntax gate on valid→invalid only; CAS commit; excerpt back; near-miss hint.
  **New**: if the file's knowledge hash differs from disk and its Read body
  is demoted, Edit re-reads the match region first (the structural fix for
  post-compaction misses).
- **Write**: no empty content without `allow_full_replace`; auto-read and echo
  what it replaced; hash staleness hard error; shrink guard (<10 % bytes, or
  <34 % and ≥25 fewer lines) on substantial files; backups.
- **Bash**: `bash -lc`, own session/process group, stdin closed; SIGTERM
  group → SIGKILL 2 s → force settle 5 s; 1.5 s pipe grace; 120 s default,
  600 s max, +20 s watchdog grace; 30k tail per stream with full log on disk;
  test logs ≥ 8k summarised; leftovers adopted and named; refusals even in
  bypass (`git clean -x` without `-n`, killing the host, launching the owner's
  browser); permission order rules → vault → stored deny/ask → stored allow →
  destructive classifier → allowlist policy → allow.
- **Background jobs**: detached supervisor process, tagged log, 1 s heartbeat
  state file, orphan detection at 30 s after a re-read, stable job id from
  run + tool_use id, byte-cursor polls, completion as a `wake` input, never
  auto-resumed after a restart.
- **Plan / Note / Recall / WaitFor / AskUser**: §4, §6.2, §6.3, §5.3.
- **WebFetch / WebSearch**: SSRF guard with redirect re-check, 30 s, 8 MB,
  binary refused, untrusted framing, `max_chars` with offset, optional
  summarisation on the `reader` lane; configurable search chain.
- **Task**: child runs (§10). **ToolSearch**: term scoring, `select:`,
  loaded set recovered from the log.
- **Plan mode**: kernel-enforced `PlanConflict` for effects; durable workflow
  mode is the only truth; `ExitPlanMode` always asks the approver.

---

## 9. Guards

One `GuardSet` per step, the garrison's thresholds:

| Guard | Trigger | Action | Default |
|---|---|---|---|
| max_tokens continue | stop max_tokens | resume reminder; shared cap with withheld partial calls | 3 |
| empty turn | end_turn, nothing produced | nudge | 3 (1 child) |
| plan gate | open tasks in scope at turn end | reminder once | once |
| promise gate | last paragraph promises more work | "do it now" once | once |
| plan-before-edit | first call of a substantial coding step | force `Plan set` | on |
| shell-regex edit hint | `sed -i` style | prefer Edit, once | once |
| sleep-poll hint | ≥3 sleeps per turn | use `WaitFor` | 3 |
| failure breaker | same signature 3× | "approach is dead" | 3 |
| failure protocol | 2nd identical failure | learned fix or diagnose frame | 2 |
| grind | cumulative per signature+command head | alert 4, stop 8 | 4/8 |
| dead loop kill | streak ≥ limit | task blocked / run failed | 8 |
| identical call | same tool + full-arg hash | nudge; 3× kills | 3/9 |
| oscillation | A/B/A/B over 6 rounds | nudge; sustained kills | 6 |
| gather stall | N rounds, no progress tool, no novel gather | "act" | 10 |
| run stall | no graph/knowledge change in N steps | reminder; 2N blocks | 12 |
| tool-call ceiling | calls per turn | 85 % nudge; graceful end | 5000 |
| iteration backstop | steps per turn | failed | 10000 |

Signatures: failure = tool + first error line normalised (digits/hex → `#`,
strings → `_`, 80 chars); call = tool + FNV-1a of sorted full args; gather
includes offset and payload.

---

## 10. Delegation

Cheapest first:

1. **Tasks in the graph** (same worker, depth-first): the default for
   sequential decomposition; closing a task collapses its window.
2. **Parallel workers** (same run, worktrees): the default for fan-out over
   disjoint scopes; the scheduler decides, the model only declares scopes.
3. **Child runs** (`Task` tool): a separate run with a type-scoped belt,
   bounded turns, its own knowledge store, and a journal-derived handoff.
   Types: `explorer` (read-only, 20 turns, reader lane), `researcher`
   (read + web, 25), `reviewer` (read + shell, 20), `general` (full, 40).
   Child id = `sha(parent_run, tool_use_id)` so replay reconnects. Fresh
   stamps, `denial_interrupts=False`, trimmed child prompt, own registries,
   one tool-less answer nudge if silent, then a step-by-step account from the
   journal. Depth cap 2.

Fleets as a separate spec language are not needed: the work graph with
scopes, acceptance and parallel workers covers the Conductor's parallel and
pipeline phases; `judge`-lane reducers cover its synthesis step.

---

## 11. Cross-run memory

Per agent, deliberately small:

1. **Project notes**: curated markdown (`<home>/projects/<ws>/NOTES.md` and
   `<ws>/.devo/NOTES.md`) edited via `Memory` with sha-based optimistic
   versioning; pinned into the system prompt (10k cap; never dropped to fit).
2. **Learned fixes**: signature → fix, per project and global, written by the
   failure protocol and by `Memory learn`; surfaced at the second identical
   failure.
3. **Episodes**: one record per run end (objective, outcome, files, checks),
   FTS-indexed; at most 5 items under 700 tokens, framed as background from
   separate runs. Raw turn text is never injected.
4. **Knowledge carry-forward**: on a new run in the same workspace, `file`
   notes and `decision` facts from the last 3 runs are importable by `recall`
   and seed the compiler's ranked pool at reduced weight.

---

## 12. Policy and approvals

```python
class Approver(Protocol):
    async def ask(self, req: PermissionRequest, cancel: CancelToken) -> Decision
```

- Modes: `default` (ask for all effects), `workspace-write` (writes allowed;
  external-state asks with suggest-allow; destructive asks with suggest-deny),
  `auto-safe`, `plan` (effects denied at the kernel), `bypass` (all allowed
  except irrecoverable shell refusals and `owner_decision` prompts).
- **One timeout**: `DEVO_PERMISSION_WAIT_MS` (5 min) → deny. Watchdog paused
  during the wait.
- **Repeat-denial breaker**: canonical action key (tool + input minus
  cosmetic keys, sorted, 4k) denied once is rejected for the rest of the step
  with an error that says not to re-ask or rephrase.
- **Unattended gate**: no approver → ask becomes deny; `owner_decision` is
  deny; the gate only tightens.
- Grants per agent and project: command prefix rules (program + two
  subcommands, or interpreter + script), literal for destructive and chained,
  chains allowed only if every segment is, explicit deny wins; path grants per
  directory; tool-wide grants; destructive "always" never outlives the process.
- Approvers chain (CLI, gateway, webhook, policy-as-code); first non-abstain
  wins.

---

## 13. Providers

Interface as Ares: `stream(ProviderRequest) -> AsyncIterator[StreamEvent]`
with `reasoning`, `max_output_tokens`, `tool_choice` (auto | any | none |
named), `reasoning_phase`. Usage normalised to total prompt tokens.

**Anthropic**: three cache breakpoints; adaptive thinking + effort on Claude 5
("off" still sends adaptive + low); budget models with `max_tokens = min(budget
+ allowance, 128k)`; unsigned thinking dropped on replay; 400 self-heals
(unsupported effort, thinking in history, cross-model signatures); forced tool
choice yields to thinking; OAuth 429 → non-retriable `plan_limit`; refusal
text committed, not streamed; adjacency pairing sanitiser; tool JSON repair;
"split into smaller writes" on unterminated large payloads.

**OpenAI-compatible**: chat and responses shapes; schema narrowing for union
types.

**Resilience**: byte stall 180 s; idle 90 s + 1.2 s/1k over 16k (max 300 s);
active idle 360 s; think ceiling 180 s; transient 4, capacity 8, network 6
retries; backoff 800 ms ×2ⁿ cap 12 s, capacity 1.5 s ×2ⁿ cap 20 s, max with
Retry-After; zero-output stall breaker at 4 → `provider_unresponsive`;
stall shrink at most 2 rungs never to the last; rate-limit failover when
Retry-After > 5 s via a host probe; context errors never fail over;
overloaded fails over after the capacity ladder; removed-model 404 is
permanent poison, quota errors are not; a pinned model is rescued for this
run and restored next step; a fallback is never persisted as default; no
failover onto a blind model for image steps.

---

## 14. Hosts

### 14.1 SDK (primary)

```python
from devoengine import AgentHost, RunRequest, Budget

host = AgentHost(data_dir="~/.devo")
agent = host.agent("oruna-coder",
                   lanes={"worker": "anthropic:claude-opus-5-5",
                          "reader": "anthropic:claude-haiku-5-5"},
                   approver=MyApprover(), tools=default_belt() + my_tools)

run = await agent.start_run(RunRequest(
    workspace="/srv/repos/acme",
    objective="Migrate billing to the v3 API; CI green; old endpoints behind a flag.",
    budget=Budget(max_tokens=20_000_000, max_wall_clock="6h"),
    parallel_workers=3,
))
async for ev in run.events(since=0): ...
await run.send("Prefer the httpx client over requests.", delivery="steer")
await run.wait()
print(run.graph.render(), run.work_status)
```

### 14.2 Gateway

WebSocket + HTTP, protocol v1 frame-compatible with the garrison (`hello`,
`session.create/attach/send/interrupt`, `sessions.list`, `session.history`,
`status`, `permission.respond`, `approval.respond`; server `welcome`,
`session.created`, `event`, `send.ack{duplicate}`, `error`), plus
`run.create/list/graph/knowledge`. Health reports running steps; tokens are 32
hex, 0600, constant-time compared, with a read-only token; hello timeout
10 s; ping 30 s; per-client queue 1000 with gap marker; 1 MiB pause.
Workspace must be a directory; provider must be known.

### 14.3 Scheduler

Interval hooks that never overlap, injectable clocks, results recorded
honestly (never masked "ok"): `housekeeping` (hourly), `heartbeat`
(host callback), `standing_orders` (cron objectives that create runs). Waits
are driven by the kernel's outbox relay, not by this scheduler.

### 14.4 Multi-agent

`AgentHost` registers agents with separate homes, memory, grants and
telemetry. Workspaces can be shared; the lease table and worktrees keep
effects from colliding. Cross-agent messaging is a host plugin.

---

## 15. Prompt composition

System (composed once per run, byte-stable): craft core (act first, minimum
complexity, diagnose before retry, batch reads, exact edits and re-Read on
miss, never rewrite with Write, plan in the graph for 3+ steps, blast radius
for irreversible actions, `file:line` references, report faithfully) →
provider overlay (one correction per family's failure mode) → standing rules
(never budgeted) → tool doctrine for the core tier only → project notes →
repository instructions → workflow surfaces (plan mode, hooks) → environment
(workspace, platform, date, mode, detected checks, repo map summary).

Children: type prompt, craft trimmed by capability, instructions capped at
6000 chars, environment, "you are a subagent" (no 6.9k owner prompt per Grep
child). Target under 12k tokens for the default catalog, enforced by a test.

---

## 16. Observability

- The event log **is** the trace. `devo trace <run>` renders steps, tool runs,
  graph changes, knowledge ingests, guard firings and waits as a timeline;
  `devo diff <run> <step_a> <step_b>` shows the workspace diff and the
  knowledge diff between steps.
- **Replay harness**: any run can be replayed against a mock provider that
  serves the recorded assistant messages, so engine changes are tested on real
  histories.
- **Friction log**: one line per step (tool calls and errors, edit tiers,
  stalls, demotions and text-rung clears, cache read ratio,
  `cache_front_moves`, graph and knowledge deltas, usage). Counts, never
  content.
- **Wire log** per request, awaited before dispatch, 8 MB roll.
- Heap sampler with thresholds; crash log on unhandled exceptions and SIGTERM.

---

## 17. Acceptance: how "better" is measured

1. **Conformance**: the garrison test suite ported (crash recovery boot,
   detached recovery visible, idempotent send, guest isolation, lazy prune,
   history, approvals, completion honesty) passes.
2. **Chaos**: SIGKILL at 12 instrumented points resumes to the same outcome
   with no duplicated effect and no lost edit, 100/100.
3. **Long-horizon benchmark** (mock provider, 300 steps, 40 files, 6 injected
   failures, one parallel phase, one 10-minute wait): constraints present
   verbatim in the final compiled context; every edited file's hash correct in
   knowledge; prompt tokens bounded throughout; `cache_front_moves` ≤ 1 per
   demotion; total input tokens ≤ 25 % of the same scenario replayed through a
   transcript-accumulation loop on the same mock.
4. **Lossless recall**: after 200 steps, `recall` can return the full body of
   any earlier round or read; a scripted probe asks for 50 random ones.
5. **Guard matrix**: trigger and near-miss tests for every guard.
6. **Prompt budget**: default core catalog under 12k tokens.
7. **Cache**: ≥ 85 % cache read ratio on steps without demotion in a 50-step
   mock run with Anthropic accounting.
8. **Parallel merge**: 3 workers on disjoint scopes merge cleanly; 2 workers
   with an injected overlap produce a reopened task with the conflict named.

---

## 18. A day in the life

Objective: "Migrate billing to the v3 API; CI green; old endpoints behind a
flag." Budget 6 hours.

- **Step 1** (planner lane): `Plan set` produces 9 tasks: map the v2 surface;
  write the v3 client; migrate `charges`, `refunds`, `webhooks` (scopes
  disjoint); add the flag; update tests; run the suite; write the changelog.
  Constraints recorded verbatim: "CI green", "old endpoints behind a flag".
- **Steps 2–14** (worker): explorer child maps v2 (reader lane); its handoff
  lands as knowledge. Client written; 3 files; shadow commits per edit;
  `pytest tests/billing/test_client.py` green → check fact.
- **Steps 15–60**: three parallel workers take `charges`, `refunds`,
  `webhooks` in worktrees. `webhooks` hits the same `KeyError` twice; the
  failure protocol finds a learned fix from a prior run ("v3 signs with
  `X-Sig-V3`, not `X-Signature`") and injects it. `refunds` closes with a
  green scoped check; merge is clean. `charges` and `webhooks` merge clean.
  Each worker's window collapses into a handoff; the main window grows by
  three messages.
- **Step 61**: full suite red in `tests/legacy`. The compiler renders
  `diff(last_green_check, now)` next to the first error line. The worker adds
  the flag and the legacy fallback. Suite green.
- **Step 70**: `WaitFor(process: CI job)` parks the run for 11 minutes at zero
  tokens. Wake: CI green. Changelog task closes; root acceptance `pnpm test`
  passes; run `completed`, work `verified`.
- A SIGKILL at step 33 (mid-Edit in `refunds`) would have resumed from the
  step-32 snapshot: the Edit's tool run reconciles via the mutation journal
  (not applied), the worker re-issues it, and nothing else notices.

The final compiled context at step 70 is about 14k tokens of system prompt,
graph, knowledge and reminders plus the last 20 rounds. The garrison's
equivalent session would be carrying a 150k transcript and its fourth
narrative recap.

---

## 19. Package layout

```
devoengine/
  kernel/      log.py (append, writer), projections/ (window, graph,
               knowledge, tools, guards, calibration, stamps, budget),
               snapshots.py, leases.py, outbox.py, sqlite.py
  engine/      run.py, scheduler.py (work graph), worker.py (the step),
               steering.py, guards.py, supervisor.py, waits.py,
               failure_protocol.py, handoff.py, lanes.py
  context/     compiler.py, knowledge.py (store + FTS + embed), retrieval.py,
               window.py (demotion, rungs), budget.py (ladder, sticky, images),
               tokens.py, cache.py (front tracking), render.py
  workspace/   shadow.py (git shadow history, blob fallback), mutation.py (CAS),
               worktrees.py, repo/ (map, symbols, checks, instructions)
  tools/       contract.py, pipeline.py, batches.py, spill.py,
               belt/ (read, edit, write, applypatch, glob, grep, bash, jobs,
                      plan, note, recall, memory, waitfor, askuser, web,
                      codesearch, task, toolsearch, planmode),
               shell/ (runner, supervisor proc, registry, classifiers),
               mcp/ (stdio, http, sse clients; live tool adapter)
  providers/   base.py, anthropic.py, openai_compat.py, mock.py, pairs.py,
               stall.py, retry.py, ceilings.py, schema.py
  delegation/  children.py, journal.py
  memory/      notes.py, learned.py, episodes.py, carryforward.py
  policy/      matrix.py, grants.py, approver.py, classifiers.py
  prompt/      craft.py, overlays.py, doctrine.py, compose.py, child.py
  hosts/       sdk.py, gateway/, scheduler.py
  telemetry/   friction.py, wirelog.py, trace.py, replay.py, heap.py, crash.py
  cli.py       devo run | attach | trace | diff | replay | serve
tests/         unit/ (projections, guards, compiler, edit tiers, ...),
               conformance/, chaos/, benchmark/
```

Dependencies: `pydantic`, `anyio`, `httpx`, `websockets`, stdlib `sqlite3`
behind a thread writer, `pathspec`, `tomllib`. Optional: `uvloop`,
`tiktoken` (calibration only), ripgrep, a local embedding model.
CPU-heavy services (symbol index, large diffs) run in a worker process pool.

---

## 20. Build order

The order is chosen so each phase is independently useful and testable, and
so the riskiest claim (the compiler beats the transcript) is proven early.

1. **Kernel + projections + snapshots + mock provider** (weeks 1–2).
   Deliverable: a run that survives SIGKILL at any point with a trivial belt.
2. **Worker step loop + guards + providers + ladders + the coding belt**
   (weeks 3–7). This is most of a harness: Read/Edit/Write/Grep/Glob/Bash with
   every rule in §8.3, the shell runner and durable jobs, Anthropic with
   caching and self-heals, the retry and stall ladders, the full guard
   matrix. Deliverable: a single-task coding run on Anthropic; conformance
   subset green; guard matrix green.
3. **Context compiler + knowledge + demotion + recall** (weeks 8–12).
   Deliverable: the long-horizon benchmark's token and lossless-recall
   criteria met against the mock. **This is the milestone that proves the
   thesis; stop and evaluate here before committing to the rest.**
4. **Work graph + scheduler + acceptance + judge vetting + handoffs + shadow
   history** (weeks 13–16). Deliverable: a 50-task scripted run completes
   with evidence-derived status; rewind works.
5. **Parallel workers + worktrees + waits + failure protocol + learned fixes**
   (weeks 17–19). Deliverable: parallel merge tests; the 10-minute wait at
   zero tokens.
6. **Children, memory carry-forward, policy chain, gateway, SDK polish,
   telemetry and replay harness** (weeks 20–24).

About six months for one strong engineer with review, three to four with two.
The first twelve weeks deliver phases 1 to 3 and the benchmark, which is the
honest "is this better" answer; everything after is capability, not proof.

---

## 21. Risks

1. **The compiler's relevance ranking is a new component with no production
   history.** Mitigated by the "always" set (constraints, scoped files,
   recent checks, open failures), by `recall` as the model's escape hatch, and
   by the benchmark's lossless-recall probe. If ranking is weak the cost is a
   `recall` call, not lost state.
2. **Model discipline with `Plan` and `Note`.** The runtime auto-fills files,
   checks, failures and handoffs; only decisions depend on the model. The
   run-stall guard notices lapses. Craft core makes it doctrine.
   **Constraints are not extracted by the runtime.** A runtime cannot pull
   "old endpoints behind a flag" out of prose. Two things happen instead:
   (a) the objective and every later user message are kept **verbatim** as
   the base constraint set and always rendered; (b) on run start and on every
   admitted user input, a bounded `planner`-lane extraction step produces a
   `constraints_extracted{items, source_input}` event whose items are shown
   next to the verbatim text, each citing the sentence it came from. The
   extraction can be wrong; the verbatim text cannot. The model may add
   constraints via `Plan`; it may not delete extracted ones, only mark them
   `disputed` with a reason, which the planner lane resolves.
3. **Parallel workers on real repositories.** Scopes declared wrong cause
   merge conflicts; the design reopens the task rather than guessing.
   Default is 1 worker; fan-out is opt-in per run.
4. **Shadow commits per mutation on huge repos.** Git tree building through a
   shadow index is incremental per file; cost is proportional to the files
   touched, not the repo. Bounded at 20 s with degrade.
5. **Python event loop stalls.** CPU-bound services run in a process pool;
   tool subprocesses are asyncio-native; SQLite writes are on a thread.
6. **Licence.** Ares is AGPL-3.0-only. DevoEngine is a new implementation
   informed by Ares's design and incident history. If source is copied, AGPL
   applies to the result. Decide before the first commit.
7. **Windows.** Deferred, not ignored, and it matters because development
   happens on Windows. The abstractions that have to hold: `ProcessOwner`
   (POSIX process groups; Windows Job Objects with `KILL_ON_JOB_CLOSE`);
   the shell contract (bash on POSIX; PowerShell with the garrison's
   `-EncodedCommand` and `.ps1` spill rules on Windows); path normalisation
   (case-insensitive keys, separator folding) in stamps, knowledge and
   scopes; hash-based stamps rather than mtime (16 ms granularity); shadow
   commits through a shadow index, which git for Windows supports, with the
   20 s bound mattering more on NTFS; worktrees via `git worktree` (works)
   with symlinked dependency directories replaced by junctions or installs.
   None of this changes the design; it changes which implementation of each
   seam is loaded. Phase 2 should build the POSIX implementations with the
   Windows ones as explicit stubs so the seams are real from the start.

---

## 22. Oruna runs on DevoEngine

Oruna is the agent; DevoEngine is its runtime. The current `core/` (949
lines, one loop) is retired, not patched. What survives from it is the part
that was never engine: identity, laws, memory estate, self-written skills,
the daily pulse, the doors. Each becomes configuration or a plugin on a seam
this document already defines. Nothing in the kernel, the step loop or the
compiler is Oruna-specific.

### 22.1 What carries over, and where it plugs in

| Old Oruna | Engine seam | Notes |
|---|---|---|
| `laws.py`: five laws, pinned hash, STOP file, unattended guard | **Policy** (§12): an `Approver` chain and a permission mode `oruna-unattended` | Laws stay text with a hash printed in the system prompt. The guard becomes a classifier that returns deny for destructive shell and out-of-home writes when no approver is attached. STOP is the owner pause, checked at every boundary. |
| `oricle.py`: pack before, attest after, remember, recall, task cards, reflect, episodes | **Memory plugin** (§11) and a **knowledge store backend** (§6.2) | Oricle becomes the cross-run memory and the backend for demoted rounds and handoffs. The per-run knowledge index stays local (SQLite FTS) for speed; bodies are committed to the estate so they outlive the run. `pack` is the recall section of the compiled tail; `attest` runs at step end with the ids the model cited. |
| task cards | **Work graph** (§4) | A card is a task. `check` is acceptance. Status comes from evidence. Oricle keeps the durable copy so the greeting can say what is open. |
| `skills.py`: write_skill with a mandatory test, live on the next call | **Tool contribution plugin** (§8.1) | Same contract: one file, docstring, `ARGS`, `run`, `test`. Loaded into the deferred tier; discoverable through `ToolSearch`; never shadowing a core tool. The test still runs before acceptance, inside the tool pipeline so it is admitted and settled like any effect. |
| `prompt.py` rules | **Craft core overlay** (§15) | Oruna's voice and the lines about remembering and growing become the agent's standing rules layer. The engineering rules come from the craft core, which is stricter and incident-backed. |
| `--pulse` | **Standing order** (§14.3) | A daily run with objective `PULSE`, unattended mode, a budget, and the interrupt budget on `message_owner`. The "do not pick the same option three pulses in a row" rule reads the last three pulse episodes from Oricle at compile time. |
| `--serve` (`POST /turn`, `GET /inbox`) | **Host** (§14.2) | Kept as a thin adapter over the gateway: `/turn` creates or continues a run and returns the final text; `/inbox` reads the outbox of `message_owner` notes. The token stays. |
| terminal door and `theme.py` | **Host** | A CLI client of the SDK. Greeting comes from Oricle's last episode and open tasks, as now. |
| `update.py` | unchanged | Packaging concern, outside the engine. |
| `jobs.py`, `files.py`, `tools.run_shell` | **replaced** by the belt (§8.3) | The belt's Read/Edit/Write/Bash/jobs carry every incident rule; the old ones carry the 20,000-character truncation bug (see `ORUNA-LEGACY.md`). |
| `main.trim` | **replaced** by demotion (§6.4) | Nothing is deleted. |
| `main.ask` | **replaced** by providers (§13) | Retries, stall guard, ceilings, caching. |

### 22.2 Oruna profile (config, not code)

```toml
[agent]
name = "oruna"
home = "~/.oruna"
lanes.worker = "openrouter:anthropic/claude-sonnet-5-5"   # or deepseek; any OpenAI-compatible endpoint
lanes.reader = "openrouter:anthropic/claude-haiku-5-5"
rules = "laws.md"                                          # hash printed in the system prompt

[policy]
mode_attended = "workspace-write"
mode_unattended = "oruna-unattended"      # deny destructive shell, writes outside home, money, accounts, non-owner contact
stop_file = "~/.oruna/STOP"
permission_wait_ms = 300000

[memory]
backend = "oricle"                        # http://127.0.0.1:7441, token from ~/.oricle/net-token
pack_tokens = 3000
demote_to_estate = true

[standing_orders.pulse]
cron = "0 5 * * *"
objective_file = "pulse.md"
unattended = true
budget.max_tool_calls = 40
budget.max_wall_clock = "30m"
interrupts_per_run = 3

[hosts]
serve.port = 7442
serve.token_env = "ORUNA_TOKEN"
```

### 22.3 What Oruna gains on day one

Durable runs that survive a restart of `oruna-serve`; a work graph with
acceptance instead of self-reported task cards; demotion to Oricle instead of
deleting history at 400k characters; an Edit that cannot truncate a file;
shells that cannot wedge on an orphaned pipe; jobs that survive the process;
`wait_for` so the pulse can start a build and come back; provider retries and
learned ceilings; the guard table; prompt caching, because the pack rides the
tail message instead of rewriting the system prompt every turn.

### 22.4 Build order for Oruna specifically

Follow §20. The Oruna profile and the Oricle plugin are part of phase 3
(the compiler needs a backend to demote into) and the laws classifier is
part of phase 2 (the belt needs a policy). The `--serve` and terminal
adapters come last. Until phase 2 ships, the live `oruna-serve` on doingbox
should at least get the `edit_file` fix in `ORUNA-LEGACY.md`, because it is
destroying files today.

---

## Appendix A. Event kinds

`input_admitted`, `constraints_extracted`, `context_compiled`, `run_start`,
`step_start`, `provider_attempt_started`,
`provider_attempt_superseded`, `provider_attempt_effects_skipped`,
`steer_routed`, `message_done`, `tool_admitted`, `tool_start`,
`tool_settled`, `tool_end`, `tool_error`, `permission_request`,
`permission_response`, `approval_pending`, `reminder_injected{key, source}`,
`window_demoted{rounds, epoch}`, `window_cleared{tier, ids}`,
`knowledge_added{kind, id}`, `graph_changed{op, task}`, `task_ready`,
`task_started`, `task_done{evidence}`, `task_blocked{reason}`,
`acceptance_provisional{task}`, `acceptance_suspect{task, reason}`,
`handoff{task, body}`, `worker_started`, `worker_finished`,
`worktree_forked`, `worktree_merged{conflicts}`, `shadow_commit{tree}`,
`rewound`, `wait_started{kind}`, `wake{payload}`, `guard_fired{name}`,
`budget_warning`, `snapshot{seq}`, `run_paused{reason}`,
`turn_end{status, work_status, usage, context, provider, model}`,
`run_end{status, work_status}`. Streamed only: `text_delta`,
`thinking_delta`, `tool_use_start`, `tool_use_input_delta`,
`tool_use_input_done`, `tool_progress`.

## Appendix B. Garrison carry-over register

Every production mechanism found in the forensic read of Ares, the incident
behind it, and where it lives in DevoEngine. "Kept" means same behaviour and
threshold.

### B.1 Loop and context

| Mechanism | Incident / reason | DevoEngine |
|---|---|---|
| Abort armed before turn_start, reminders, compaction | Stop looked dead during prep | Kept: cancel token at every boundary (§5.1) |
| Reminders after the last tool_result block | Anthropic 400 re-sent every retry, bricked session | Kept (§6.1) |
| Keyed reminders replace, never stack | Reminders stacked | Strengthened: compiled sections live only on the outbound tail message and are never stored in history, so there is nothing to replace and no cache front to move (§6.1) |
| Projection committed before informational reminder | Crash resumed at larger footprint | Kept: demotion epoch first (§6.4) |
| Context checked every iteration | Mid-turn growth | Kept (§5.1 step 4) |
| Sticky top-rung cut | Exact trimming re-billed ~120k per call | Kept (§6.5) |
| Descent floors at overhead + 12k; minKeep 4; no orphan tool_result lead | Model saw only the pending message | Kept (§6.5) |
| Deterministic context ledger on trimmed prompts | Summariser failures erased the mission | Superseded by compiled sections; ladder still floors (§6.3) |
| Image fit [8,4,2,1,0], 3 MB payload, attached images last | Gateway 413 at ~4.5 MB | Kept (§6.5) |
| Blind-model strip on outbound copy | Text model failed every turn on a pasted image, silently | Kept (§6.5) |
| Compaction ratio 0.6 | 4–14M input tokens per turn at 0.8 | Kept as text-rung threshold; demotion replaces heavy compaction (§6.4) |
| File pins and re-read nudge after compaction | 46/49 Edit failures post-compaction | Replaced by file knowledge + Edit forced re-read (§8.3) |
| Repository instructions re-pinned after compaction | Rules erased | Kept: instructions live in the stable system prompt and are claims in knowledge (§7.3) |
| Recap never clipped; diff digests in summariser input | Generational amnesia; "edited x.ts" without the how | Not needed: nothing is summarised; edit digests are knowledge (§6.2) |
| Compaction cancellable as maintenance | Stop did nothing during summariser | Kept for the text rung and demotion (§5.1) |
| Content-aware tokens, EWMA, per-block memo | Overflow on code; gigabytes of garbage, exit 134 | Kept (§6.6) |
| Learned ceilings persisted, never from stalls/413 | Six-minute rediscovery; ratchet to a few thousand tokens | Kept (§6.5) |
| Refusal self-heal | Memory text triggered refusals | Kept, generalised to strippable sections (§5.1 step 13) |
| Max output 128k on Claude 5 | 32k cap thought six minutes and wrote nothing | Kept (§6.6) |
| Summariser 7000-token output, 30 s, archived recaps | 2048 turned 80k of work into a paragraph | Replaced; `reader`-lane summaries exist only for WebFetch (§8.3) |

### B.2 Tools

| Mechanism | Incident / reason | DevoEngine |
|---|---|---|
| Write-ahead admit, settle before tool_end | Lost commits, replayed effects | Kept: `tool_admitted`/`tool_settled` events (§8.2) |
| `effect_unknown`, observational reconcile, never re-execute | Double charge / send | Kept (§3, §8.1) |
| Dep-aware batches; solo tools; pool 5 | Overlapping writers; 20-way storm | Kept (§8.2) |
| Watchdog precedence and class defaults; 13-min ceiling | "Every freeze was a promise that could never settle" | Kept (§8.2) |
| Watchdog paused in permission wait; cap → deny | 23-minute hang behind a painted-over prompt | Kept, one 5-min timeout (§12) |
| Pre-tool checkpoint, degrade on failure, 20 s | Write died on EPERM | Kept as shadow commit (§7.1) |
| Deterministic mutation tx id | Stable across replay | Kept (§7.2) |
| Spill head/tail, pageable, once | Spill-of-a-spill brick | Kept (§8.2) |
| Lenient parsing, aliases, name resolution | Strict schemas failed most calls; glm; dropped `-i` | Kept (§8.1) |
| Truncated tool_use reconciliation and withholding cap 3 | Large Write truncated forever | Kept (§5.1 step 12) |
| Instruction pre-effect deny; read-only shell exempt | 68/186 first `ls` rejected | Kept (§7.3) |
| Grants per directory | Fleets died on the second file | Kept (§12) |
| Read self-bounded, exact count and hash, stat re-check | Bricked chat 2026-10-21 | Kept (§8.3) |
| Edit tiers, auto-read, stale retry, syntax gate, CAS, excerpt, near-miss | 62/68 "Read first"; stale edits | Kept + forced re-read on knowledge hash drift (§8.3) |
| Write shrink guard, backups, hash staleness | 1,251 lines replaced by 23 | Kept (§8.3) |
| Bash process group kill, pipe grace, tails, spill, test summary | `docker exec` pipe; 656-second port check | Kept (§8.3) |
| Irrecoverable refusals even in bypass | `git clean -x` destroyed 197 files; agent killed its host; owner's browser | Kept (§8.3) |
| Leftover adoption | Dev servers invisible for days | Kept (§8.3) |
| Durable jobs: supervisor, heartbeat, orphan after re-read, stable id, cursors, completion steer, no auto-resume | 14 stuck `running`; "keeps launching Minecraft" | Kept; completion is a `wake` (§8.3, §5.3) |
| Repo map deterministic, never LLM | Invented architecture | Kept (§7.3) |
| Symbol index regex, cached by HEAD | No native deps; crash safety | Kept (§7.3) |
| ToolSearch tiering; loaded set from transcript and host | Keyword router made capabilities invisible; catalog flips re-billed | Kept; loaded set from the log (§8.3) |
| One edit protocol per model | OpenAI family on ApplyPatch | Kept (§8.3) |
| MCP: stdio NDJSON/Content-Length switch, process groups, SSE endpoint timeout, auth error card | Connectors hung; crash loop 2026-09-11 | Kept (§19 `tools/mcp`) |
| WebFetch SSRF guard with redirect re-check | Rebinding shape | Kept (§8.3) |

### B.3 Guards

All thresholds in §9 are the garrison's. Incidents: 14 build re-runs over two
hours (grind), 26 browser calls and 24 s of sleeps (sleep-poll), 15 rounds on
a `sed -i` no-op, 200-char signature collision (full hash), Browser evals
keyed without payload (gather signature), stopped agent with a to-do list
(promise gate), "typing then nothing" (empty turn), 996 seconds against a dead
endpoint (unresponsive breaker, §13).

### B.4 Providers and resilience

All rows in §13 are kept with their incidents: three breakpoints; adjacency
pairing (split pair bricked a session); JSON repair (28 s on three malformed
calls); split-writes coercion (lost pomodoro Write); 180/90/300/360/180 s
stall windows (85k prompt cut four times; Write cut mid-tool); 4/8/6 retries
(five Overloadeds in 20 s; 23 turns lost in 12 s); rate-limit failover (76
errors of dead air); context never fails over (cascade); 404 permanent poison
(three weeks, 315 MB log); refusal not streamed; `no_message_done`
synthesis (gateways closing healthy SSE); plan-limit on OAuth 429; schema
narrowing (422 on unions killed the belt).

### B.5 Durability and host

| Mechanism | Incident / reason | DevoEngine |
|---|---|---|
| Idempotent inputs; conflict on different bytes; synthetic turn_end on settled replay | Duplicate sends; "ack then silence" | Kept (§2.2) |
| Failed-turn input retirement | Poison queue head | Kept: failed stays claimed and resumable; replay cap cancels (§3, §10) |
| Dead-pid lease expiry; clean-shutdown release | 21 s and 30 s boot stalls | Kept (§3.5) |
| Replay cap 2 per input | Endless unannounced replays | Kept (§3) |
| Detached-replay mirror | Owner saw silence | Kept: all events stream to subscribers regardless of sender |
| Progress not persisted; bodies dropped from compaction rows; streaming reader | 224 MB, 355 MB, 290 MiB logs; heap OOM | Kept (§3.4) |
| turn_end after flush | Reboot race | Kept: snapshot before `turn_end` (§5.1) |
| Lazy meta; empty-run prune | 613/739 never typed into | Kept (§3) |
| Stuck-turn watchdog 15 min escalation | Hung pipe froze a turn | Kept + run-level progress stall (§5.5) |
| Bounded preparation 20 s, Stop honoured | Recall that never settled wedged the chat | Kept for every pre-step hook (§5.1 step 3) |
| Health reports running turns | Deploy under a live turn | Kept (§14.2) |
| Backpressure, ping, constant-time tokens, read scope | Slow clients, half-open TCP, timing | Kept (§14.2) |
| Workspace must be a directory; provider must be known | Zombie sessions; wrong-provider audit | Kept (§14.2) |
| Scheduler hooks never overlap; honest results | Alert hidden behind 378 "ok" lines | Kept (§14.3) |
| Plan mode: durable mode is truth; drafts never re-enter plan; ExitPlanMode asks | Snapped back to plan after owner chose build | Kept (§8.3, §12) |
| Permission flow: engine id, pending list, LRU outcomes, sweep on abort, repeat-denial breaker | Tired thumb re-asked; stale lock-screen prompts | Kept (§12) |
| Subagents: stable child id, fresh stamps, denial doesn't interrupt, answer nudge, silent account, journal handoff, depth cap | Fleet died 8/8 and reported done; 5/5 died on a sibling folder; 16/26 "(no text output)" | Kept (§10, §5.6) |
| Conductor: deterministic phases, worktrees, CAS merge, budgets, resume | Weak models stop early or mis-thread | Folded into the work graph + parallel workers (§4, §7.4) |
| Memory: pinned curated notes never dropped; no raw episodic injection; learned-fix recall; tenant scoping | Forgot what it decided to keep; "why are you talking about my vault" | Kept in reduced form (§11) |

### B.6 Garrison gaps closed by construction

1. Unbounded `beforeSend` with the watchdog armed after it.
2. Three disagreeing permission timeouts.
3. Watchdog blind to detached replays.
4. Eviction racing a hung send's `finally`.
5. No recall injection for remote turns.
6. Stale comments (compaction 80 % vs 0.6; image keep 3 vs 2; empty-turn 1
   vs 3; conductor concurrency 3 vs 6).

## Appendix C. Ares source map used for this design

Engine: `packages/core/src/queryEngine.ts`, `turnGuards.ts`,
`tokenEstimate.ts`, `contextCeilings.ts`, `promptCache.ts`. Durability:
`session.ts`, `sessionKernel/`, `workspaceMutation.ts`, `checkpoints.ts`,
`checkpointGit.ts`. Delegation: `subagents.ts`, `subagentJournal.ts`,
`forkedTurn.ts`, `conductor.ts`. Tools: `packages/tools/src/_shared.ts`,
`Read.ts`, `Edit.ts`, `Write.ts`, `Bash.ts`, `ShellRegistry.ts`,
`ShellSupervisor.ts`, `Task.ts`, `Conductor.ts`, `ToolSearch.ts`, `Mcp.ts`,
`WebFetch.ts`. Host: `packages/garrison/src/*`,
`packages/cli/src/entry/{garrisonCmd,sessionFactory,turnPipeline,
planPressure,sessionPlanModes,permissions,garrisonRecovery}.ts`,
`packages/cli/src/policyGate.ts`, `packages/cli/src/entry/prompt/`. Memory:
`packages/agent/src/memory/unifiedRecall.ts`,
`packages/mind/src/memory/{router,recall,store}.ts`.
