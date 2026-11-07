# DevoEngine — design document

A from-scratch Python runtime for long-horizon coding projects and general
agent work, built from everything the Ares garrison learned the hard way.

Status: design, v1. Nothing here is implemented yet. Every mechanism carried
over from Ares cites the incident that justified it; every new mechanism says
what Ares weakness it removes.

---

## 0. Verdict first: why this is better than the garrison, not just newer

The garrison is excellent at long work because of roughly forty small
mechanisms that each exist because something broke in production. Those
mechanisms are the asset. DevoEngine keeps every one of them that matters for
coding and agent work, and changes the one thing the garrison never changed:
**the unit of memory is the transcript.**

Everything hard about long horizons in Ares traces back to that. Compaction
summarises chat and loses the how (46 of 49 post-compaction Edit failures were
edits against remembered content). Microcompact fires every eight tool results
and wipes the reads the model is coding against. The plan lives in a TodoWrite
list that is re-sent wholesale. Constraints are "the first thing lost across
repeated compactions". A 2-hour session carries 4 to 14 million input tokens per
turn. Subagents are depth 1 because deeper trees have nowhere to put their
results except prose.

DevoEngine makes **structured working state** the source of truth and the
transcript a short, disposable window onto it. Concretely:

| Garrison weakness (with evidence) | DevoEngine answer |
|---|---|
| Compaction loses constraints and edit details (summariser incidents, "generational amnesia", 7000-token recap cap) | The **Mission Ledger** holds objective, verbatim constraints, plan tree, decisions, file knowledge and check results as structured records. Compaction drops rounds, never knowledge. Narrative summary is a small fallback, not the carrier. |
| Microcompact wipes the working set every ~8 results, each a full cache miss | The ledger's **file knowledge** carries path, last hash, and a model-written note per file. Old Read bodies can be dropped without the model losing what it knows; it re-reads a region by hash-checked offset when it needs bytes. |
| One giant turn is the only long-horizon unit; 5000 tool-call ceiling, 10,000 iteration backstop | A **Run** is the durable goal-level unit, made of **Steps** (model calls) grouped into **Task scopes**. Each task has its own message window; finishing a task collapses its window into a structured handoff. A 400-step project never accumulates 400 steps of transcript. |
| Subagent depth 1 ("children cannot spawn"); results return as prose | Task scopes are in-process delegation with no model handoff cost. Subagents remain for parallelism, at configurable depth, and return **journal-derived handoffs** (what they touched), never only what they claim. |
| Crash recovery exists but is spread over kernel, garrison, CLI (two lease TTL waits, 21 s boot stalls, bounded replays added later) | **Step-level checkpoints** are the core model, not a recovery path. Every step's full state (ledger, window, stamps, pending tools) is committed before the next provider call. A kill -9 resumes at the step boundary, by design. |
| Loop guards are 30 locals extracted into a class after the fact | **GuardSet** is a first-class, unit-tested component with a documented table of thresholds. Same guards, same thresholds, one place. |
| Host wiring is 1,500 lines mixing the brain with phone, Telegram, personas, Oricle | **Kernel + plugins.** The runtime has no surface baked in. A gateway, an SDK and a scheduler are the only hosts. Everything else is a plugin on documented seams. |
| Single owner per home directory | **Agents are tenants.** Each agent has its own home, memory, credentials, policy and runs. One process hosts many. |
| Permission answering is wired to one phone with three disagreeing timeouts | One **Approver** interface, one timeout, pluggable. Auto-deny on timeout and circuit-breaker on repeat denial are kept. |

What does not change, because it is already right: the Anthropic-shaped wire
contract, the tool execution pipeline (write-ahead admission, settlement,
effect_unknown), the Edit tool's matching tiers and hash stamps, the shell's
process-group kill and durable background jobs, prompt-cache discipline, the
retry and stall ladders, learned context ceilings, the loop-guard thresholds,
dep-aware parallel tool batches, keyed reminders, and deferred tool loading.

The claim "better at long-horizon coding and general agent work" rests on:
(1) every incident-proven mechanism is kept; (2) the structural cause of the
remaining long-horizon failures (transcript as memory) is removed; (3) the host
is small enough to reason about. Nothing here depends on a smarter model.

---

## 1. Goals and non-goals

### Goals

1. **Long-horizon coding projects.** Hours to days of autonomous work in one
   repository without context rot, with the plan, constraints and file
   knowledge intact across hundreds of steps and process restarts.
2. **General agent work.** Research, multi-step tool use, web, shell, file
   handling, with the same loop and the same guards.
3. **Durability as the default.** No in-flight work is lost to a restart. Every
   effect is admitted before it runs and settled after, with crash
   reconciliation that never re-executes blindly.
4. **Embeddable.** A Python library first (`import devoengine`), a gateway
   second. Oruna embeds the library.
5. **Multi-agent hosting.** Many agents, each isolated, in one process.
6. **Simplicity.** The whole runtime should be readable by one engineer in a
   day. Target under 25k lines of Python including tools and tests.

### Non-goals (deliberately left out)

- Telegram, iPhone app, phone APIs, personas, rooms, family relay, Oricle,
  life surfaces, Forge/3D studio, browser bridge, desktop control, marketplace,
  payments, email, calendars, connectors gallery, voice.
- The `ContinuousVerifier` subsystem and its reminders. (Project checks are
  ordinary shell tools the agent runs; the ledger records their outcome. See
  §6.6 for completion honesty without a verifier.)
- Living-memory spreading-activation graph, dreaming, witness, reflection
  scheduler. Replaced by a much smaller memory (§12).
- Windows-first. DevoEngine is POSIX-first; Windows is supported through the
  same abstractions later (§18).

---

## 2. What we learned from Ares: the carry-over register

This section is the contract with the past. Each row is a mechanism, the
incident behind it, and its fate in DevoEngine. "Kept" means same behaviour and
thresholds unless stated.

### 2.1 Turn loop and context

| Mechanism | Incident / reason | Fate |
|---|---|---|
| Abort controller armed before turn_start, reminders and compaction | Stop looked dead during prep | Kept (run-level cancel token, checked at every boundary) |
| Reminders inserted after the last tool_result block | Anthropic 400 "tool_use ids without tool_result", re-sent every retry, bricked session | Kept |
| Keyed reminders replace their previous instance anywhere in history | Reminders stacked | Kept |
| Microcompact commits projection before the informational reminder | Crash resumed at the larger footprint | Kept |
| Context is a loop invariant (compaction checked every iteration) | Context grew mid-turn | Kept |
| Sticky top-rung cut (re-cut only when the tail no longer fits, to 75 %) | Exact-to-budget trimming moved the cache front every call, re-billing ~120k | Kept |
| Descent rungs floored at overhead + 12k | 8k/4k rungs below system+tools overhead: model saw only the pending message | Kept |
| minKeep 4 messages, never lead with an orphan tool_result | Sub-overhead budget erased the conversation | Kept |
| Deterministic context ledger on trimmed prompts (prior recap, last 8 directions, top tools, 24 most recent files) | Summariser failures erased the mission; "first 24 files" kept abandoned early work | Kept as a fallback; the Mission Ledger supersedes it in normal operation |
| Image fit [8,4,2,1,0] and payload cap 3 MB | Gateway 413 over ~4.5 MB with no retry | Kept |
| Blind-model image strip on the outbound copy only | Local text model failed every turn on a pasted image with no error shown | Kept |
| Compaction threshold ratio 0.6 | At 0.8, prompts sat at 130–175k and sessions reported 4–14M input tokens per turn | Kept as a default; the ledger design means heavy compaction is rare |
| File pins (head 70 % / tail 30 %, 10k each, 30k total) and re-read nudge for edited-but-unpinned files | Old recap pinned 120k of whole files; 46/49 Edit failures were post-compaction | Replaced by ledger file knowledge + forced hash check on Edit (§7.3) |
| Repository instructions re-pinned after compaction | Rules erased by compaction | Kept |
| Recap never clipped in the summariser input | Generational amnesia | Kept for the narrative fallback |
| Edit/Write diff digests in the summariser input | "edited x.ts" without the how | Not needed: ledger records each edit's hunk digest at commit time |
| Compaction cancellable as "maintenance" phase | Stop during summariser did nothing | Kept |
| Token estimator: content-aware ratios, EWMA calibration, per-block memo | Flat 4 chars/token overflowed on code; re-estimation created gigabytes of garbage and an exit-134 | Kept |
| Learned context ceilings persisted per provider+model, 30-day TTL, floor 16k | Subagent re-learned an 85k ceiling for six minutes | Kept |
| Never learn a ceiling from a stall or a 413 | Sessions ratcheted to a few thousand tokens after one outage | Kept |
| Refusal self-heal: strip recalled-memory reminders once and retry | Memory text triggered refusals | Kept (generalised to any injected block tagged `strippable`) |

### 2.2 Tool execution

| Mechanism | Incident / reason | Fate |
|---|---|---|
| Write-ahead admission barrier before the tool runs, settlement barrier before tool_end is exposed | Lost commits, replayed effects | Kept, as the kernel's core contract |
| `effect_unknown` state; reconciliation is observational and never re-executes | Double charge / double send risk | Kept |
| Dep-aware batches: parallel across disjoint targets, serialized on shared paths or writers; solo tools (shell, kill, plan) | Overlapping writers ran concurrently | Kept |
| Bounded worker pool, default 5 | 20-way provider storm from Task fan-out | Kept |
| Watchdog precedence: input-derived, tool-declared, env, class default (external 20 s, write 60 s, read 30 s); 0 means 13-minute ceiling | "Every freeze this daemon has had was one shape: a tool promise that could never settle" | Kept |
| Watchdog paused during permission wait; 10-minute cap resolves to deny | 23-minute hang behind a painted-over prompt | Kept, single timeout (§13) |
| Pre-tool checkpoint for writes, degrade on failure | A Write died on checkpoint EPERM | Kept |
| Deterministic mutation transaction id (sha of run + tool_use id) | Stable across crash replay | Kept |
| Result spill: head 2000 + marker + tail 600, pageable on disk, computed once | Read of a spill could show 4000 chars; "bricked chat" 2026-10-21 | Kept, with Read self-bounded |
| Lenient input parsing: strip invented keys, parse JSON-encoded arrays/objects, field aliases | "Most tool calls failing" on strict schemas; glm failed TodoWrite twice; dropped `-i` | Kept |
| Tool name resolution by canonical key and aliases | `functions.read_file` etc. | Kept |
| Truncated tool_use reconciliation and withholding (C3 cap of 3) | A single large Write truncated forever | Kept |
| Repository-instruction pre-effect deny until rules are read; provably read-only shell commands exempt | 68 of 186 first `ls` commands rejected | Kept |
| Grants per directory, not per file | Fleets died on their second file | Kept |

### 2.3 Guards

All thresholds in §8 are the garrison's. Specific incidents: a build re-ran 14
times over two hours (grind breaker), sleep-polling burned 26 browser calls,
`sed -i` no-op cost 15 rounds, a 200-char signature truncation collided two
full-file Writes (full FNV hash), ten distinct Browser evals looked like
re-runs without payload in the key (gather signature includes payload), an
owner asked to keep going and found a stopped agent with a to-do list (promise
gate).

### 2.4 Providers and resilience

| Mechanism | Incident / reason | Fate |
|---|---|---|
| Three cache breakpoints (system, last tool, rolling last message) | Without the rolling one every turn re-bills the transcript | Kept |
| Adjacency-checked tool pairing; unpaired blocks become text placeholders | A pair split by an intervening message bricked a session | Kept |
| Tool JSON repair, "split into smaller writes" on unterminated large payloads | Lost Write; 28 s on three malformed calls | Kept |
| Byte-level stall guard 180 s; event-level idle 90 s + 1.2 s/1k over 16k, max 300 s; active idle 360 s; think ceiling 180 s | An 85k prompt cut at a flat 90 s four times; a Write cut mid-tool | Kept |
| Retry ladders: transient 4, capacity 8, network 6; backoff capped 12 s / 20 s; max of backoff and Retry-After | Five Overloadeds in 20 s killed a turn; 23 turns lost in 12 s | Kept |
| Zero-output stall breaker at 4 → non-retriable `provider_unresponsive` | 996 seconds against a dead endpoint | Kept |
| Stall-driven shrink at most 2 rungs, never to the last | Huge prompts stall silently | Kept |
| Rate-limit failover when Retry-After > 5 s | 76 errors of dead air while another provider sat idle | Kept (hook for the host to supply a fallback) |
| Context errors never fail over; overloaded fails over only after the capacity ladder | Cascade | Kept |
| 404 removed-model is permanent poison; quota errors are not | Three weeks of failed recovery, 315 MB audit log | Kept |
| Refusal text committed but not streamed | Dead-end reply flashed before retry | Kept |
| `no_message_done` synthesised when the stream closes clean with nothing | Gateways closing healthy SSE early | Kept |

### 2.5 Durability and host

| Mechanism | Incident / reason | Fate |
|---|---|---|
| Idempotent input ids; same id different bytes = conflict | Duplicate sends | Kept |
| Synthetic turn_end for a retried, already-settled input | "send.ack then silence, forever" | Kept |
| Failed-turn input retirement | Poison queue head blocked every later message | Kept |
| Dead-pid lease expiry at boot; clean-shutdown lease release | 21 s and 30 s boot stalls | Kept (lease carries pid; boot probes it) |
| Detached replay cap of 2 per input, then cancel | Replay that kept dying replayed on every boot | Kept |
| Detached-replay mirror to subscribers | Owner saw silence and called it bricked | Kept |
| Rollout `tool_progress` capped at 2000 chars; streaming reader; corrupt lines skipped | 224 MB of Bash progress, heap OOM on read-back | Kept (progress is not persisted at all) |
| `turn_end` emitted only after rollout flush | Reboot/rehydration race | Kept |
| Empty-session prune | 613 of 739 registry entries were never typed into | Kept (meta written lazily on first input) |
| Stuck-turn watchdog 15 min: interrupt ×2, abort ×2, evict | Hung `docker exec` pipe froze a turn forever | Kept as defence in depth; a run-level stall detector is added (§4.5) |
| Bounded preparation (20 s) with Stop honoured | Recall that never settled wedged the chat | Kept and made universal: every pre-step hook is bounded |
| Health endpoint reports running turns; safe-restart waits for 0 | Deploy under a live turn | Kept |
| WebSocket backpressure: per-client queue 1000, gap marker, 1 MiB pause | Slow clients | Kept |
| Constant-time token compare, read-scope token | Timing | Kept |
| Scheduler hooks never overlap; results recorded honestly, not masked "ok" | A heartbeat alert hidden for weeks behind 378 "ok" lines | Kept for the minimal scheduler |

### 2.6 Known garrison gaps DevoEngine closes

From the forensic reads, these are bugs or inconsistencies in the current
system that the rewrite fixes by construction:

1. `beforeSend` is awaited unbounded and the watchdog is armed only after it.
2. Three permission timeouts disagree (5 min, 10 min, a comment saying 20 s).
3. The stuck-turn watchdog sees only its own stream; detached replays have none.
4. Eviction can race the hung send's `finally`.
5. Remote turns never received recall injection.
6. Several doc comments are stale against the code (compaction 80 % vs 0.6,
   image keep 3 vs 2, empty-turn nudge 1 vs 3, conductor concurrency 3 vs 6).

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Hosts (thin)                                                        │
│   devoengine.sdk  (in-process Python API)                            │
│   devoengine.gateway (WS + HTTP, protocol v1)                        │
│   devoengine.scheduler (heartbeat, housekeeping, standing orders)    │
├──────────────────────────────────────────────────────────────────────┤
│  Runtime                                                             │
│   AgentHost ── manages Agents (tenants) ── each owns Runs            │
│   Run ── Steps ── Task scopes ── Rounds (tool batches)               │
├─────────────┬───────────────┬───────────────┬────────────────────────┤
│  Context    │  Tools        │  Policy       │  Memory                │
│  Ledger     │  Belt, batch, │  Approver,    │  Project notes,        │
│  Window     │  watchdog,    │  grants,      │  learned fixes,        │
│  Budgeter   │  spill, stamps│  classifiers  │  episodic log          │
│  Renderer   │  shell, edit  │               │                        │
├─────────────┴───────────────┴───────────────┴────────────────────────┤
│  Kernel (SQLite, write-ahead): inputs, leases, steps, tool runs,     │
│  effects, checkpoints, ledger versions, events                       │
├──────────────────────────────────────────────────────────────────────┤
│  Providers: Anthropic (first-class), OpenAI-compatible, mock         │
└──────────────────────────────────────────────────────────────────────┘
```

Layer rules:

- **Kernel** knows nothing about models or tools. It stores records and
  enforces leases and idempotency.
- **Runtime** (`engine/`) owns the step loop. It never writes to stdout; it
  yields events.
- **Tools** depend on the tool contract only. They never import the engine.
- **Hosts** compose everything and are the only place with I/O surfaces.
- **No plugin may reach into another layer's state.** Plugins get seams: hooks
  (§15), approvers (§13), event taps (§16), tool contributions (§7.1), prompt
  layers (§15).

---

## 4. Core model

### 4.1 Entities

```
Agent       a tenant: id, home dir, config, memory, policy, credentials ref
Workspace   a directory the agent works in; owns a kernel DB and checkpoints
Run         a durable unit of goal-level work inside a workspace
Input       a user or system message admitted to a run (queue | steer)
Step        one provider call and its consequences (rounds of tool calls)
Task        a node in the run's plan tree; may own a context scope
Round       one assistant tool_use batch plus its results
Event       anything observable; persisted and streamed
```

A **Run** replaces the garrison's "session" for work and keeps "session" only
as a UI grouping (a chat thread). A run has: objective, status, the Mission
Ledger, a message window, a budget contract, a lease, and a step counter. A
chat thread may spawn many runs; a run may outlive the thread's client.

### 4.2 Run lifecycle

```
created ──admit input──► admitted ──lease──► running ──┐
   ▲                                     │             │ step boundary
   │                                     ├─ waiting (permission / approval)
   │                                     ├─ paused (owner)
   │                                     ├─ interrupted
   │                                     ├─ failed (resumable: input stays claimed)
   │                                     └─ completed | needs_verification
   └───────────── resume (same run id, same ledger) ◄──┘
```

Status axes stay separate, exactly as in Ares: **execution status**
(completed, needs_verification, interrupted, failed) and **work status**
(verified, unverified, blocked, not_applicable). Failover never treats red work
as a provider outage.

### 4.3 Inputs: queue vs steer

- `queue` inputs run after the current step finishes the run's work (FIFO).
- `steer` inputs land at the next **safe boundary**: every tool_use paired,
  nothing in flight. Steering during a provider call aborts that attempt (it is
  speculative); steering during tool execution waits for tools to settle;
  steering during maintenance (compaction summariser) aborts the summariser.
- Every steer gets its own provider slot (the step counter does not advance).
- Idempotency key is the input id. Same id + different bytes is a conflict.
  A replayed, already-settled input gets a synthetic terminal event.

### 4.4 Steps and checkpoints

A step is: (prepare) → (provider call) → (commit assistant message) →
(tool rounds) → (post-round guards) → **(step checkpoint)**.

The step checkpoint is the heart of durability. It atomically persists:

- the ledger version (content-addressed),
- the message window as a list of message ids (bodies are already stored),
- file read stamps,
- guard state (streaks, signatures, one-shot flags),
- token calibration and learned ceiling,
- the pending tool runs' settlement states,
- the step number and the inputs consumed.

A restart loads the latest checkpoint and resumes at the next step. Tool runs
that were `executing` at the crash become `effect_unknown` and are reconciled
(§10.3) before any new provider call.

### 4.5 Run supervisor

A per-run supervisor watches three things the garrison watched at most
partially:

1. **Silence**: no event for `DEVO_STEP_SILENCE_MS` (default 15 min). Escalates
   interrupt → abort → evict, as the garrison does. Detached replays are
   watched too (closes gap 2.6.3).
2. **Progress**: no ledger change (no task status change, no file knowledge
   update, no new decision, no new check result) for
   `DEVO_RUN_STALL_STEPS` (default 12) steps. Injects one "no ledger progress"
   reminder, then at 2× pauses the run with status `blocked` and reason
   `no_progress`. This is the run-level version of the gather-stall guard.
3. **Budget**: tokens, wall clock and cost against the run's contract. At 85 %
   a reminder; at 100 % the run ends gracefully at the next boundary with a
   ledger entry saying so.

---

## 5. The step loop, in exact order

This is the garrison's loop with the ledger and task scopes added. Order
matters; the garrison's incidents were almost all ordering bugs.

```
step(run):
  1  cancel token checked                       (Stop must be visible everywhere)
  2  apply steering at boundary                 (install steer inputs into window)
  3  pre-step hooks, each bounded by DEVO_PREP_TIMEOUT_MS (20 s), cancel-aware
       - memory recall (project notes, learned fixes)       -> keyed reminders
       - repository instructions discovery                 -> claims
       - repo map refresh (every N coding steps or boundary file touched)
  4  drain keyed reminders into the pending user message, after any tool_result
  5  maintenance: image rung -> text rung (microcompact) -> heavy compaction
       (commit projection first; cancellable; skipped if a steer just landed)
  6  cancel token checked
  7  select tool catalog for this step (core tier, transient extras, loaded tier)
  8  render context: system prompt (cache-stable) + ledger block + window
  9  budget ladder: [B, .5B, .25B, 8k, 4k], floors, sticky cut, images, blind strip
 10  arm provider attempt (if a steer raced, go to 2)
 11  wire-log the request (awaited), stream with merged signal
       (cancel | steering abort | stall abort)
 12  hold message_done; yield deltas live; on stream end:
       - superseded by steering -> discard, go to 2
       - no message and no error -> synthesised retriable no_message_done
       - rate-limit failover probe
       - transient retry ladder / stall shrink / unresponsive breaker
       - context-limit -> learn ceiling (not from stalls or 413) -> next rung
 13  reconcile truncated tool_use blocks; withhold partial calls (C3 cap 3)
 14  refusal self-heal (strip strippable blocks once, retry)
 15  commit assistant message; yield message_done
 16  no tools:
       - max_tokens continue (C3) | empty-turn nudge (3, 1 for children)
       - todo/plan gate (once) | promise gate (once)
       - run-level: open task scope with status running but no handoff -> remind
       - close at boundary; compute work status; step checkpoint; yield turn_end
 17  tools: resolve, normalise, classify, authority check
       dep-aware batches -> worker pool (5) -> per call:
         pause check -> pre-tool checkpoint -> admit (write-ahead) -> pre-hook
         -> tool_start -> watchdog(call) -> post-hooks -> settle -> tool_end
       ordered tool_result message appended; skipped-by-steering reported
 18  ledger auto-update from outcomes (files touched, commands run, failures,
       check results, task status from `plan` tool calls)
 19  post-round guards in order (§8)
 20  step checkpoint
 21  loop to 1
```

Iteration cap is the garrison's 10,000 backstop; guards are the terminators.

---

## 6. Context system

### 6.1 The Mission Ledger

The ledger is a versioned, structured record set per run. It is the model's
long-term working memory and the runtime's progress sensor.

```python
class Ledger(BaseModel):
    objective: str                      # the ask, verbatim, never rewritten
    constraints: list[Constraint]       # verbatim quotes; source: user|repo|runtime
    plan: PlanTree                      # tasks with status, scope, acceptance
    decisions: list[Decision]           # what was chosen and why, dated by step
    files: dict[str, FileKnowledge]     # path -> note, last_hash, last_read_step,
                                        #         last_edit_step, edit_digests[]
    checks: list[CheckResult]           # command, ok, step, output_tail
    blockers: list[Blocker]             # open questions, missing access
    learned: list[LearnedFix]           # failure signature -> fix applied
    narrative: str                      # small summary fallback (<= 1200 tokens)
    version: int
```

Who writes it:

- **The model**, through the `ledger` tool (replaces TodoWrite):
  `plan.set/update`, `decide`, `constraint.add`, `file.note`, `blocker.open/close`,
  `objective.clarify` (appends, never replaces). Plan tasks carry `status`
  (pending, in_progress, done, cancelled, blocked), optional `scope` (globs)
  and `acceptance` (free text or a check command).
- **The runtime**, automatically, from tool outcomes: touched files get
  `last_edit_step` and a hunk digest; Reads update `last_hash` and
  `last_read_step`; check-grammar commands (§6.6) append `checks`; the failure
  breaker appends `learned` on a recalled fix; compaction appends to
  `narrative`.

Rendering: a compact block, budgeted (`DEVO_LEDGER_TOKENS`, default 6000),
placed as a keyed reminder on the pending user message so the system prompt
prefix stays byte-stable. Rendering order: objective, constraints, current task
(and its parent chain), blockers, next 8 plan items, recent decisions (8),
file knowledge for files in the current task's scope plus the 12 most recently
touched, last 5 checks, narrative. Items past budget are elided with counts.

Why this is the key change: every piece of state the garrison's summariser was
asked to preserve ("constraints verbatim", "all user messages", "files and
code", "errors and fixes", "pending tasks", "next step") is now written at the
moment it is known, by the component that knows it, in a form that survives
any window operation untouched.

### 6.2 The window

The window is the list of messages actually sent. It holds:

- the last `DEVO_WINDOW_ROUNDS` complete rounds (default 24), always;
- older rounds until the budget forces a drop;
- compaction never summarises inside the current task scope's rounds.

Dropping a round is a **projection change**, persisted as a context epoch, so a
crash resumes at the same footprint. The garrison's sticky-cut rule applies to
where the window starts.

### 6.3 Task scopes

When the model marks a plan task `in_progress` with `scope: true` (or the
runtime detects a task with more than `DEVO_SCOPE_AUTO_ROUNDS` (default 10)
rounds of work), the run opens a **task scope**:

- a fresh sub-window begins; the parent window is frozen;
- the rendered context is: system prompt, ledger block (with the task's
  acceptance and scope emphasised), a one-paragraph handoff from the parent
  ("you are inside task X; the parent's last state is ..."), the sub-window;
- tools, stamps and guards continue (same run, same process, same model);
- when the task is marked `done`/`blocked`/`cancelled`, the runtime builds a
  **handoff** from the journal (files touched, commands run, checks, errors,
  the model's closing note) and appends it to the parent window as one
  message, and the sub-window is archived.

The effect is subagent-shaped context hygiene without a model handoff, a new
system prompt, or a prose summary. The handoff is derived from events, "what
the task touched, not what it claims".

### 6.4 Compaction tiers

Same three tiers as the garrison, re-aimed at the window:

1. **Image rung**: age-gated (keep last 2 rounds of images), batch ≥ 6, placeholder.
2. **Text rung (micro)**: clear bodies of compactable tool results oldest first
   when calibrated estimate > threshold × 1.0, down to 0.5 ×. Keep the last 6
   compactable results and the newest 3 Reads of each of the last 8 edited
   files. Batch gate: 8 candidates or 16k tokens. Invalidate stamps for cleared
   reads only. Thrash escalation at 3 ineffective passes.
3. **Heavy**: drop whole rounds from the front of the window (outside the
   current scope) down to the keep window; write a narrative paragraph via a
   bounded side query (`DEVO_COMPACTION_TIMEOUT_MS` 30 s, max 2000 tokens) and
   append it to `ledger.narrative`; on summariser failure, no narrative is
   written and the ledger alone carries state. Re-pin repository instructions.

Because the ledger carries constraints, plan and file knowledge, heavy
compaction is lossless for work state. The narrative is only for
conversational nuance.

### 6.5 Cache discipline

Prompt cache stability is an invariant, enforced by one module:

- The system prompt is composed once per run and only recomposed on an
  explicit event (mode change, tool catalog change); its hash is recorded.
- Tool schemas are ordered: core tier fixed order, loaded tier appended in load
  order. Catalog flips are logged with expected re-bill.
- Every history mutation goes through `Window.mutate(reason)`, which records
  the earliest changed index. The friction log reports `cache_front_moves` per
  step so re-bill regressions are visible immediately.
- Volatile per-step content (ledger block, reminders, date) rides the pending
  user message, never the system prompt.
- Three Anthropic breakpoints as in Ares.

### 6.6 Completion honesty without a verifier

Out of scope: the verifier subsystem. In scope: not lying about done.

- The runtime recognises **check commands** by the garrison's anchored grammar
  (pnpm/npm/yarn test|build|lint|typecheck, pytest, cargo, go test, make,
  gradle, mvn, tsc, eslint, ruff, mypy, node --test, etc.; no chains, pipes,
  redirects, `--help`, `--dry-run`, background).
- A check counts as **current** if it ran after the last mutation (monotonic
  evidence tick, not wall-clock) and is whole-suite or scoped to a changed
  file stem, directory, package or test root.
- Work status at run end: `verified` if the last mutation has a current green
  check; `unverified` if mutations exist with no current check; `blocked` if
  the last current check was red; `not_applicable` if nothing mutated.
- `unverified` and `blocked` yield execution status `needs_verification`, not
  `completed` (`DEVO_STRICT_VERIFY=0` disables).
- There is **no** end-of-turn re-verification push. The 2026-10-15 owner
  decision stands: it caused 3 to 4 unprompted re-test passes per deliverable.

### 6.7 Token estimation and budgets

Carried verbatim from Ares: content-aware ratios (prose 4, code 3, base64 2.5,
CJK 1, indent 12, newline 0.25), image estimate from dimensions, EWMA
calibration 0.7/0.3 clamped [0.5, 2.5], per-block memo invalidated on
mutation, 8 tokens per message.

Budget: `min(0.75 × window, DEVO_CONTEXT_BUDGET_CAP (192k))`, overridable;
ladder `[B, .5B, .25B, 8k, 4k]` with floors; learned ceilings persisted at
`<agent home>/telemetry/context-ceilings.json`.

Max output tokens: 128k for models that support it, else by window size
(32k ≥ 200k, 16k ≥ 100k, 8k ≥ 32k, else 4k). Incident: a 32k cap thought six
minutes and wrote nothing.

---

## 7. Tool system

### 7.1 Contract

```python
class Tool(Protocol):
    name: str
    description: str
    input_model: type[BaseModel]            # pydantic v2 -> JSON schema
    safety: Literal["read-only", "workspace-write", "external-state", "destructive"]
    concurrency: Literal["parallel-safe", "exclusive"]
    defer: bool = False                      # deferred tier, loaded via ToolSearch
    max_result_chars: int | None = None      # None = engine default, 0 = self-bounded
    watchdog_ms: int | None = None           # None = class default, 0 = 13-min ceiling

    def watchdog_for(self, inp) -> int | None: ...     # input-derived deadline
    def classify(self, inp) -> SafetyClass | None: ... # per-input safety
    def validate(self, inp, ctx) -> str | None: ...    # semantic error, pre-effect
    def command_for(self, inp) -> str | None: ...      # for grant persistence
    def activity(self, inp) -> str: ...                # "Reading app.py"
    async def call(self, inp, ctx: ToolContext) -> ToolResult: ...
    effect_policy: EffectPolicy | None       # reconcile() for remote effects
```

Schema emission strips `default`, converts exclusive bounds to numbers,
collapses unions for OpenAI-shaped endpoints. Lenient parsing: strip unknown
keys and retry; parse JSON-encoded strings for array/object fields; per-tool
aliases (`path`→`file_path`, `old`→`old_string`, `cmd`→`command`, Grep flags).

`ToolContext` carries: workspace, run id, step, tool_use id, cancel token,
`request_permission`, `emit_progress`, `pause_watchdog`, the run's
`read_stamps`, a deterministic `mutation_tx_id`, repository instruction
claims, and the ledger (read-only view plus `note_file`).

### 7.2 Execution pipeline

Per call, in order (all from Ares, see §2.2):

1. owner pause wait (bounded by the tool's watchdog budget)
2. pre-tool checkpoint for write/destructive (git shadow index; blob store
   outside git; degrade on failure; 20 s cap)
3. steering epoch check
4. **admit** (kernel write-ahead: tool run `executing`, tx id)
5. pre-hook (bounded; block → failed or effect_unknown)
6. `tool_start` (only after durable admission)
7. `watchdog(call)` with merged signal
8. post-hooks (each its own synthetic run)
9. **settle** (succeeded / failed / effect_unknown, touched files)
10. `tool_end` / `tool_error`
11. result cap and spill
12. ledger auto-update

Batching: `build_batches()` in model order; new batch on solo, on shared
target with a writer, on exclusive tools without analysable targets. Pool of
`DEVO_MAX_TOOL_CONCURRENCY` (5). A permission denial interrupts the run
(interactive) or is a per-call error (children, `denial_interrupts=False`).

### 7.3 The belt

Core tier, fixed order (part of the cache key):

```
Read, Edit, Write, ApplyPatch, Glob, Grep, Bash, BashOutput, KillShell,
Ledger, Memory, WebSearch, WebFetch, CodebaseSearch, Task, TaskOutput, KillTask,
EnterPlanMode, UpdatePlanDraft, ExitPlanMode, ToolSearch
```

Deferred tier (loaded by `ToolSearch`): Diff, Bisect, Symbols (symbol index),
Conductor, McpListTools/McpCallTool and live `mcp_<server>_<tool>`, Skills,
Checkpoint (list/rewind), ImageSearch, plus plugin-contributed tools.

Key rules per core tool, all carried from Ares with the incident that set them:

**Read**
- `cat -n` numbering, 2000 lines default, 4000 chars per line, 50 KB per page,
  continuation hint. Self-bounded (`max_result_chars=0`) so it is never spilled
  (the spill-of-a-spill brick).
- Streams the whole file once for exact line count and sha256; stat re-checked
  after read ("changed while being read").
- Records the stamp `{mtime, size, sha256, lines}`. PDFs by page, images as
  attachments, directories as listings.
- Ledger: updates `files[path].last_hash/last_read_step`.

**Edit**
- `old_string` must match exactly once unless `replace_all`.
- Tiers: exact → whitespace-insensitive line block → anchor (first/last
  significant lines, interior modulo whitespace) → normalised (NFC, homoglyph
  fold, whitespace collapse, uniform indent delta re-applied). The weakest tier
  used is reported for telemetry.
- Replacement via function, never `str.replace` with `$` semantics.
- Rejects line-number-prefixed `old_string`, empty, identical, mixed
  range+text batches, glob characters in paths.
- **Auto-read** when no stamp exists (62 of 68 Edit errors were "Read first").
  **Stale** stamp (hash mismatch) is retried against current bytes; a miss
  throws stale. Line-range edits refuse on auto-read or stale.
- Batches are all-or-nothing on a working copy. `new_string_from_file` for
  large replacements.
- Syntax gate blocks only valid→invalid transitions (json, js via `node --check`,
  py via `ast.parse`, sh via `bash -n`, ts via project `tsc`), 8 s cap.
- Commit through the mutation service (CAS on expected hash, path locks,
  fsync, journal); readback after write; stamp updated as `written_not_read`.
- Returns a `cat -n` excerpt of the changed region (≤ 60 lines) and a
  near-miss hint on not-found.
- Ledger: appends an edit digest (path, −/+ line counts, first changed line)
  to `files[path].edit_digests`.
- **New**: when the file's `last_hash` in the ledger differs from disk and the
  file's Read body is no longer in the window, Edit forces a bounded re-read of
  the match region before matching (the structural fix for the 46/49
  post-compaction failures).

**Write**
- Refuses empty content unless `allow_full_replace`. Auto-reads an existing
  file and echoes the first 20 lines replaced. Hash staleness is a hard error.
- Shrink guard on substantial files (≥ 40 lines or ≥ 2 KB): new < 10 % bytes,
  or < 34 % bytes and ≥ 25 fewer lines → refuse unless `allow_full_replace`
  (the 1,251-line file replaced by a 23-line fragment).
- Backups under `.devo/backups/` with an index.

**ApplyPatch**: the only editor advertised to OpenAI-family models; one edit
protocol per model, the alternate kept only if recently used or named.

**Glob / Grep**: mtime-sorted glob with 500 results and 15 s cap; ripgrep with
Python fallback, 200 results, 20k match cap, 4 MB file skip, 30 s cap, inline
flag stripping, `-A/-B/-C`, multiline, gitignore respect.

**Bash**
- `bash -lc`, new session (process group), stdin closed. Kill path: SIGTERM to
  the group, SIGKILL after 2 s, force-settle at 5 s; 1.5 s pipe grace after
  natural exit (the 656-second port check; the `docker exec` pipe).
- Timeout default 120 s, max 600 s; watchdog = timeout + 20 s grace.
- Output: per-stream tails capped at 30k chars; full interleaved log under
  `.devo/shell-output/<run>/` kept only when truncated.
- Test/build logs ≥ 8000 chars collapse to counts, first error, failures.
- Leftover processes that outlive the command (dev servers, `&`, `nohup`) are
  adopted into the registry and named in the result.
- Refused even in bypass mode: `git clean -x/-X` without `-n` (197 files
  destroyed, then run again), killing the host runtime, launching the owner's
  browser or a headed Playwright.
- Permission order: repository-instruction block → stored deny/ask → stored
  allow → destructive classifier (delete, history rewrite, publish, remote
  code; unwraps `sh -c`, `python -c` once) → allowlist policy → allow.
- Grants: "always" stores program + up to two subcommands, or interpreter +
  script; destructive and chained commands stored literally; chains allowed
  only if every segment is allowed; explicit deny always wins.

**Background jobs**: a detached supervisor process owns the command, appends
tagged output to a log, writes a heartbeat state file every 1 s; heartbeat
older than 30 s or dead pid → `orphaned` after one re-read. Job id is a stable
hash of run + tool_use id (replay addresses the same job). Poll by byte cursor,
200 KB max, UTF-8 safe. Settlement injects a completion `steer` input (latest
16k of tail). No job outlives its run; stopped jobs are resumable but never
auto-resumed ("Ares keeps launching Minecraft").

**Ledger**: see §6.1. Also hosts the todo gate: at turn end with `in_progress`
or `pending` tasks in the current scope, one reminder listing up to 8.

**Memory**: §12.

**WebFetch / WebSearch**: SSRF guard (private, link-local, CGNAT, metadata,
`.internal`, `.local`; re-run on redirects; DNS-rebinding shape blocked),
30 s, 8 MB, binary refused, HTML→text, `max_chars` 20k default / 120k max with
offset, optional summarisation by a cheaper model, untrusted-content framing.
Search provider chain configurable.

**Task / TaskOutput / KillTask**: §11.

**ToolSearch**: term scoring (exact +10, substring +5, body +1), `select:A,B`,
result lists `loaded`; the loaded set is recovered from the transcript and from
the run record so it survives restart and compaction.

**Plan tools**: plan mode blocks writes and effectful shell at the kernel
(`PlanConflict`), `UpdatePlanDraft` is allowed only in plan mode,
`ExitPlanMode` always asks the approver. Durable workflow mode is the only
source of truth; drafts never re-enter plan mode by inference.

### 7.4 Result spill

Budget `DEVO_TOOL_RESULT_CHARS` (24k) unless the tool self-bounds. Over budget:
full output to `.devo/tool-results/<run>/<tool_use>.txt` in a line-pageable
form; the model sees head (2000), a marker naming the file and the omitted
count, a per-tool hint, and a tail (600). Computed once, stored in history.

### 7.5 Checkpoints and rewind

Git shadow index trees under `refs/devo/checkpoints/` inside repositories;
blob store elsewhere (2 MB cap, skips are reported). Home and drive roots are
refused as too broad. Pre-tool checkpoints for writes; `Checkpoint rewind`
restores files and cuts the window before the anchoring tool_use id (indices
shift under compaction; ids do not), invalidates stamps, persists an epoch.

---

## 8. Guards (GuardSet)

One class, one instance per step, every threshold from the garrison:

| Guard | Trigger | Action | Default |
|---|---|---|---|
| max_tokens continue | stop reason max_tokens | resume reminder; shared cap with withheld truncated calls | 3 |
| empty turn | end_turn with no text, thinking or tools | nudge | 3 (1 for children) |
| todo/plan gate | open tasks in scope at turn end | reminder, once per turn | once |
| promise gate | last paragraph promises more work | "do that work now", once | once |
| plan-before-edit | first call of a substantial coding step, no plan | force `Ledger plan.set` as the first tool | on |
| shell-regex edit hint | `sed -i` / in-place replace | prefer Edit, once | once |
| sleep-poll hint | ≥ 3 sleeps per turn | drive the logic instead | 3 |
| failure breaker | same failure signature 3× consecutively | "approach is dead, change strategy"; re-arms | 3 |
| failure recall | 2nd identical failure | inject learned fix if known | 2 |
| grind | cumulative failures per (signature + command head) | alert at 4, stop at 8 | 4 / 8 |
| dead loop kill | failure streak ≥ limit | `loop_detected`, run failed | 8 (min 4) |
| identical call | same tool + full-arg FNV hash ≥ limit | nudge; 3× limit kills | 3 / 9 |
| oscillation | A/B/A/B over last 6 round signatures | nudge; sustained kills | 6 |
| gather stall | N rounds with no progress tool and no novel gather signature | "stop gathering and act" | 10 |
| run stall (new) | no ledger progress for N steps | reminder; 2N → blocked | 12 |
| tool-call ceiling | calls per turn | nudge at 85 %, graceful end | 5000 |
| iteration backstop | steps per turn | failed | 10,000 |

Failure signature: tool + first error line, lowercased, digits/hex → `#`,
quoted strings → `_`, 80 chars. Gather signature includes offset and payload.
Progress tools: Write, Edit, Bash, BashOutput, KillShell, Task*, Ledger,
Memory.

Reasoning dials: adaptive level never exceeds the configured ceiling; deep-work
verbs keep it; short greetings go to off; a failed round restores full effort.
Tactical downshift on routine continuations is opt-in.

---

## 9. Providers

### 9.1 Interface

```python
class Provider(Protocol):
    name: str
    def stream(self, req: ProviderRequest) -> AsyncIterator[StreamEvent]: ...

@dataclass
class ProviderRequest:
    model: str
    system: str
    messages: list[Message]
    tools: list[ToolDescriptor]
    cancel: CancelToken
    reasoning: ReasoningLevel            # off|low|medium|high|max; provider maps it
    max_output_tokens: int
    tool_choice: Literal["auto","any","none"] | ToolName
    reasoning_phase: Literal["deep","routine"]
```

Stream events: `text_delta`, `thinking_delta(signature?)`, `tool_use_start`,
`tool_use_input_delta`, `tool_use_input_done`, `message_done(message, usage,
stop_reason)`, `heartbeat`, `error(code, message, retriable, retry_after_ms)`.

Usage normalises `input_tokens` to the total prompt including cache so
providers are comparable.

### 9.2 Anthropic

Three cache breakpoints; adaptive thinking + effort for Claude 5 models ("off"
still sends adaptive + low effort: an omitted field ran 26k thinking tokens
before a single Read); `budget_tokens` for budget models with
`max_tokens = min(budget + allowance, 128k)`; unsigned thinking dropped on
replay; 400 self-heals (strip unsupported effort, strip thinking from history,
strip cross-model signatures); forced tool choice yields to thinking; OAuth
429 plan-limit → non-retriable `plan_limit`; refusal text committed, not
streamed. Adjacency pairing sanitiser, tool JSON repair, "split into smaller
writes" coercion.

### 9.3 OpenAI-compatible

Chat Completions and Responses shapes; `function_call_output` translation;
schema narrowing (collapse `anyOf`/`oneOf`, multi-type) because one upstream
422 on union schemas killed the whole belt.

### 9.4 Resilience ladders

Exactly §2.4. Host-supplied hooks: `rate_limit_failover_probe()` and
`pick_fallback(error) -> Provider | None`. Failover rules: a pinned model is
rescued for this run only and restored next step; never persist a fallback as
the default; never fail onto a blind model for image steps; capacity errors
move to a sibling at the same provider first.

---

## 10. Durability and recovery

### 10.1 Kernel schema (SQLite, WAL, one DB per workspace)

```
runs(id, agent_id, workspace, status, work_status, objective, created_at, ...)
inputs(id, run_id, delivery, state, bytes_hash, admitted_at, consumed_at)
leases(run_id, owner, pid, token, expires_at)
steps(run_id, n, checkpoint_id, started_at, ended_at, usage_json)
checkpoints(id, run_id, step, ledger_version, window_json, stamps_json,
            guards_json, calibration_json, created_at)
ledger_versions(id, run_id, version, body_json, parent_id)
messages(id, run_id, ordinal, role, body_json, epoch)
context_epochs(id, run_id, kind, from_ordinal, created_at)
tool_runs(id, run_id, step, tool_use_id, name, state, tx_id, touched_json,
          result_hash, started_at, settled_at)
effects(tx_id, kind, state, journal_json)
jobs(id, run_id, kind, state, pid, heartbeat_at, log_path)
events(seq, run_id, ts, kind, body_json)         # tool_progress excluded
```

All writes go through one serialised writer per DB. The `events` table is the
rollout; a JSONL mirror per run is written for forensics and for the gateway's
history frames (streamed reader, corrupt lines skipped, boot never fails on a
damaged file).

### 10.2 Leases

TTL `DEVO_LEASE_TTL_MS` (30 s), heartbeat TTL/3. The lease carries the holder
pid; at boot, leases whose pid is dead are expired immediately (no 21-second
wait). Clean shutdown releases leases. Lease loss interrupts the run.

### 10.3 Crash reconciliation

On resume, before any provider call:

1. tool runs in `executing` → `effect_unknown`;
2. mutation journal replay/rollback for transactional tools;
3. `effect_policy.reconcile()` for remote tools (observational, idempotent,
   30 s cap); never re-execute;
4. synthesise tool_results for dangling tool_use blocks from the ledger:
   succeeded → stored result; failed → error; effect_unknown → "interrupted
   with unknown effect, do not retry blindly"; no record → "may be planned
   again";
5. if history ends on an assistant message with tools all settled, append a
   "RECOVERY BOUNDARY, do not repeat tool calls" reminder instead of replaying.

Orphaned inputs are replayed detached at most 2 times, then cancelled with
`recovery_exhausted`. Control inputs (job completion, plan handoff) are never
replayed. A failed replay cancels the input (never leave a poison queue head).

### 10.4 Rollout hygiene

`tool_progress` is never persisted. Compaction and rewind rows do not carry
message bodies (290 MiB in one session). Meta is written on first input, not
on create. Empty runs older than 24 h with no content are pruned to a ledger.

---

## 11. Delegation

Three mechanisms, cheapest first.

1. **Task scopes** (§6.3): same agent, same model, fresh window. For sequential
   decomposition. Zero handoff cost. Default for long projects.
2. **Subagents** (`Task` tool): a child run with its own window, type-scoped
   tools, bounded turns, journal-derived handoff. For parallel fan-out and for
   read-only exploration on a cheaper model. Built-in types: explorer
   (read-only, 20 turns, fast lane), researcher (read-only + web, 25),
   code-reviewer (read + shell, 20), general (full belt, 40). Child id is a
   stable hash of parent run + tool_use id (replay reconnects). Children get a
   fresh stamp map, `denial_interrupts=False`, the trimmed child prompt, their
   own tool registries. `DEVO_SUBAGENT_MAX_DEPTH` default 2 (not 1: task scopes
   mean a child rarely needs to spawn, but a planner child coordinating
   explorers is legitimate). A silent child gets one tool-less answer nudge,
   then a step-by-step account from its journal.
3. **Fleets** (`Conductor`, deferred): deterministic spec execution for weak
   models and large fan-out. Kept at reduced scope: `parallel` and `pipeline`
   phases, concat/first/judge reducers, typed `{{prev.field}}` handoff,
   schema-by-example barriers, copy-on-write worktrees per writer with CAS
   merge, token and wall-clock budgets (2 min per leaf, clamped 2–30 min),
   resume by fleet id. Caps: 32 per phase, 64 per fleet, concurrency 8.

Every child reports through the **journal**: fed from events, last 50 entries,
40 files, 4 errors, flushed on every tool_start (crash evidence), rendered at
≤ 700 chars.

---

## 12. Memory (small by design)

Three stores per agent, all plain files plus one SQLite FTS index:

1. **Project notes** (`<agent home>/projects/<workspace hash>/NOTES.md` and
   `<workspace>/.devo/NOTES.md`): curated markdown the model edits through the
   `Memory` tool with optimistic versioning (sha). Always pinned into the
   system prompt up to 10k chars (dropping it to fit made Ares forget what it
   had decided to keep).
2. **Learned fixes** (`learned_fixes.jsonl`, per project and global): failure
   signature → fix text, written automatically when a failure streak clears
   after a change of approach, and by the model via `Memory learn`. Surfaced
   by the failure-recall guard at the second identical failure. This is the
   single most valuable piece of Ares memory for coding and it costs nothing.
3. **Episodic log** (`episodes.jsonl`): one line per run end with objective,
   outcome, files, checks; FTS-indexed; recalled as at most 5 items, 420 chars
   each, under `DEVO_MEMORY_TOKENS` (700), framed as background context "from
   earlier, separate runs; not requests". Raw turn text is never injected
   (the "why are you talking about my vault" bug). Guest/tenant scopes are
   isolated.

No consolidation, dreaming, witness or spreading activation. If a richer memory
is wanted later it plugs into the pre-step hook seam.

---

## 13. Policy and approvals

```python
class Approver(Protocol):
    async def ask(self, req: PermissionRequest, cancel: CancelToken) -> Decision
    # Decision: allow_once | allow_always | deny
```

- Default permission matrix by mode: `default` asks for everything but reads;
  `workspace-write` allows workspace writes, asks for external-state (suggest
  allow) and destructive (suggest deny); `auto-safe` allows workspace writes
  only; `plan` denies all effects; `bypass` allows all, except the irrecoverable
  shell refusals and `owner_decision` prompts (plan→build crossing, payments),
  which always reach a human.
- **One timeout**: `DEVO_PERMISSION_WAIT_MS` (5 min) → deny (closes gap 2.6.2).
  The tool watchdog is paused during the wait.
- **Repeat-denial circuit breaker**: a denied canonical action key
  (tool + input minus cosmetic keys, sorted, 4k cap) is rejected immediately
  for the rest of the step with a `PermissionDenied` error that tells the model
  not to re-ask or rephrase.
- **Unattended decision gate**: when no approver is attached, "ask" becomes
  deny, `owner_decision` is deny, and the gate can only make decisions stricter.
- Grants persist per agent and per project (command rules, path grants per
  directory, tool-wide grants); destructive "always" never outlives the process.
- Approvers are plugins: CLI prompt, gateway `permission.respond`, webhook,
  policy-as-code (a Python callable). Several can be chained; the first
  non-abstain wins.

---

## 14. Hosts

### 14.1 Python SDK (primary)

```python
from devoengine import AgentHost, Agent, RunRequest

host = AgentHost(data_dir="~/.devo")
agent = host.agent("oruna-coder", provider="anthropic", model="claude-opus-5-5",
                   approver=MyApprover(), tools=default_belt() + my_tools)

run = await agent.start_run(RunRequest(
    workspace="/srv/repos/acme",
    objective="Migrate the billing service to the v3 API and get CI green.",
    budget=Budget(max_tokens=20_000_000, max_wall_clock=timedelta(hours=6)),
))

async for ev in run.events():          # TurnEvents, resumable by seq
    ...
await run.send("Also keep the old endpoints behind a flag.", delivery="steer")
await run.wait()                       # completed | needs_verification | ...
print(run.ledger.plan, run.work_status)
```

Everything the gateway can do, the SDK can do in-process. Embedders may run
one `AgentHost` with hundreds of agents; each agent's runs share a worker pool
with per-agent concurrency limits.

### 14.2 Gateway

WebSocket + HTTP on one port, protocol v1 kept frame-compatible with the
garrison so existing clients can attach:

- client → server: `hello{token, client, proto}`, `session.create`,
  `session.attach`, `session.send{inputId, delivery, attachments}`,
  `session.interrupt`, `sessions.list`, `session.history{limit}`, `status`,
  `permission.respond`, `approval.respond`;
- server → client: `welcome`, `session.created`, `event`, `sessions`,
  `session.history`, `status`, `send.ack{duplicate}`, `approval.pending`,
  `error`.

Plus run-level additions: `run.create` (objective + budget), `run.list`,
`run.ledger`. `GET /health` reports running steps for safe restarts. Tokens
(control and read-only) are 32 hex, mode 0600, constant-time compared. Hello
timeout 10 s, ping 30 s, per-client queue 1000 with gap marker, 1 MiB pause.
Workspace must exist as a directory; provider must be known (both were zombie
session incidents).

### 14.3 Scheduler (minimal)

Interval hooks that never overlap themselves, with injectable clocks, results
recorded honestly: `housekeeping` (hourly: rotate logs, prune spills, expire
checkpoints, sweep orphaned jobs), `heartbeat` (30 min: a host callback), and
`standing_orders` (cron-like objectives that create runs). Nothing else.

### 14.4 Multi-agent hosting

`AgentHost` owns a registry of agents. Each agent has a home directory with
config, credentials reference, memory, grants, telemetry. Workspaces may be
shared between agents; the kernel DB is per workspace and the lease table
prevents two runs from executing effects in the same workspace at once unless
they are in disjoint worktrees. Cross-agent messaging is a host plugin, not a
kernel feature.

---

## 15. Prompt composition

Order, cache-stable, composed once per run:

1. **Craft core**: how work is done. Act first; minimum complexity; diagnose
   before retry; batch reads; exact-match edits and re-Read on not-found; never
   rewrite with Write; plan in the ledger for 3+ steps; blast-radius thinking
   for irreversible actions; `file:line` references; proof contract (report
   faithfully, a red check is blocking, "good" means works). Every rule traces
   to a real failure; no persona.
2. **Provider overlay**: one short correction per model family's known failure
   mode (over-explaining, over-engineering, describing instead of acting,
   looping, summarising instead of working, small steps for local models).
3. **Standing rules**: the agent's owner rules file, re-read on compose, never
   budgeted.
4. **Tool doctrine**: entries keyed by tool, included only for the core tier
   (deferred tools carry their doctrine in their own description).
5. **Project notes** (pinned memory) and **repository instructions** (root →
   leaf, first convention file per directory, bounded walk).
6. **Workflow surfaces**: plan mode boundary; hooks.
7. **Environment** (last): workspace, platform, date, permission mode,
   detected project checks, repo map summary.

Per-step volatile content (ledger block, reminders, recall) rides the pending
user message. Children get: type prompt, trimmed craft by capability,
repository instructions capped at 6000 chars, environment, "you are a
subagent". Target: under 12k tokens for the default core catalog, enforced by
a test.

---

## 16. Observability

- **Events**: every TurnEvent persisted (except progress) and streamable by
  sequence number; `turn_end` carries `context{prompt_tokens, window_tokens}`,
  provider, model, usage, work status, and the structural verification gap.
- **Friction log**: one JSONL line per step under
  `<agent home>/telemetry/friction-YYYY-MM.jsonl`: per-tool calls and errors,
  edit tiers, stalls, compactions by method and tokens freed, cache read ratio,
  `cache_front_moves`, ledger deltas, usage. Counts only, never content.
- **Wire log**: every outbound request, awaited before dispatch, rolled at
  8 MB, `DEVO_WIRE_LOG=0` to disable.
- **Compaction archive**: every narrative written, with the rounds it replaced.
- **Run trace**: `devo trace <run>` renders steps, tool runs, ledger versions
  and guard firings as a timeline. The ledger's version history is itself the
  best debugging artefact: you can diff what the agent knew at step 40 and 41.
- **Heap and crash**: a heap sampler with elevated/critical thresholds; a crash
  log written on unhandled exceptions and on SIGTERM.

---

## 17. Configuration

All knobs are environment variables with `DEVO_` prefix and documented
defaults; a `devo.toml` per agent may set the same keys. The garrison's values
are kept unless a row says otherwise.

| Knob | Default | Notes |
|---|---|---|
| `DEVO_CONTEXT_BUDGET_CAP` | 192000 | budget = min(0.75 × window, cap) |
| `DEVO_SUBAGENT_CONTEXT_BUDGET` | 128000 | |
| `DEVO_MAX_OUTPUT_TOKENS` | by model | 128k for Claude 5 |
| `DEVO_COMPACTION_RATIO` | 0.6 | heavy compaction threshold |
| `DEVO_MICROCOMPACT_TRIGGER_RATIO` / `TARGET_RATIO` | 1.0 / 0.5 | |
| `DEVO_MICROCOMPACT_WORKING_SET` | 8 | edited files whose reads are kept |
| `DEVO_WINDOW_ROUNDS` | 24 | rounds always kept in the window |
| `DEVO_LEDGER_TOKENS` | 6000 | rendered ledger block budget |
| `DEVO_SCOPE_AUTO_ROUNDS` | 10 | auto-open a task scope after this many rounds |
| `DEVO_COMPACTION_TIMEOUT_MS` / `MAX_TOKENS` | 30000 / 2000 | narrative side query |
| `DEVO_IMAGE_KEEP_ROUNDS` / `CLEAR_BATCH` | 2 / 6 | |
| `DEVO_MAX_IMAGE_PAYLOAD_BYTES` | 3000000 | |
| `DEVO_TOOL_RESULT_CHARS` | 24000 | |
| `DEVO_TOOL_WATCHDOG_MS` | by class | 20 s / 60 s / 30 s |
| `DEVO_MAX_TOOL_CONCURRENCY` | 5 | |
| `DEVO_CHECKPOINT_TIMEOUT_MS` | 20000 | |
| `DEVO_PERMISSION_WAIT_MS` | 300000 | the one permission timeout |
| `DEVO_PREP_TIMEOUT_MS` | 20000 | every pre-step hook |
| `DEVO_STEP_SILENCE_MS` | 900000 | run supervisor silence |
| `DEVO_RUN_STALL_STEPS` | 12 | no ledger progress |
| `DEVO_PROVIDER_RETRIES` / `CAPACITY_RETRIES` / `NETWORK_RETRIES` | 4 / 8 / 6 | |
| `DEVO_CAPACITY_BACKOFF_MS` / `MAX_MS` | 1500 / 20000 | |
| `DEVO_RATE_LIMIT_WAIT_MS` | 5000 | failover probe threshold |
| `DEVO_STREAM_IDLE_MS` / `IDLE_MAX_MS` / `IDLE_ACTIVE_MS` / `THINK_CEILING_MS` | 90000 / 300000 / 360000 / 180000 | |
| `DEVO_STREAM_STALL_MS` | 180000 | byte-level |
| `DEVO_GATHER_STALL_ROUNDS` | 10 | |
| `DEVO_REPEAT_CALL_LIMIT` / `LOOP_KILL_LIMIT` | 3 / 8 | |
| `DEVO_MAX_TURN_TOOL_CALLS` / `MAX_TURN_ITERS` | 5000 / 10000 | |
| `DEVO_SUBAGENT_MAX_DEPTH` / `TURN_LIMIT` | 2 / 40 | |
| `DEVO_FLEET_WALL_MS` | 2 min/leaf, 2–30 min | |
| `DEVO_LEASE_TTL_MS` | 30000 | |
| `DEVO_EFFECT_RECONCILE_TIMEOUT_MS` | 30000 | |
| `DEVO_EDIT_AUTO_READ` / `EDIT_STALE_RETRY` / `EDIT_SYNTAX_GATE` | 1 / 1 / block | |
| `DEVO_READ_MAX_LINES` / `READ_MAX_BYTES` | 2000 / 51200 | |
| `DEVO_SHELL_POLICY` | default | `allowlist` asks for non-read-only |
| `DEVO_TEST_SUMMARY_MIN_CHARS` | 8000 | |
| `DEVO_MEMORY_TOKENS` | 700 | episodic recall budget |
| `DEVO_STRICT_VERIFY` | 1 | needs_verification instead of completed |
| `DEVO_PLAN_BEFORE_EDIT` | 1 | |
| `DEVO_ADAPTIVE_REASONING` / `TACTICAL_REASONING` | 1 / 0 | |
| `DEVO_WIRE_LOG` / `TELEMETRY` | 1 / 1 | |
| `DEVO_WEBFETCH_ALLOW_PRIVATE` | 0 | |

---

## 18. Package layout

```
devoengine/
  kernel/        sqlite store, writer, leases, idempotency, epochs, events
  engine/        run.py (lifecycle), step.py (the loop), steering.py,
                 guards.py (GuardSet), supervisor.py, scopes.py
  context/       ledger.py, window.py, budget.py (ladder, sticky cut, images),
                 compaction.py (3 tiers), tokens.py (estimator, calibration),
                 render.py (ledger block, reminders), cache.py (front tracking)
  tools/         contract.py, pipeline.py (admit/settle/watchdog/spill),
                 batches.py, belt/ (read, edit, write, applypatch, glob, grep,
                 bash, jobs, ledger_tool, memory, web, tasksearch, plan),
                 shell/ (runner, supervisor process, registry, classifiers),
                 mutation.py (CAS journal), checkpoints.py (git shadow, blobs),
                 repo.py (map, instructions, project checks, symbol index)
  providers/     base.py, anthropic.py, openai_compat.py, mock.py,
                 pairs.py (adjacency, json repair), stall.py, retry.py,
                 ceilings.py, schema.py
  delegation/    subagents.py, journal.py, conductor.py, worktrees.py
  memory/        notes.py, learned.py, episodes.py
  policy/        matrix.py, grants.py, approver.py, classifiers.py
  prompt/        craft.py, overlays.py, doctrine.py, compose.py, child.py
  hosts/         sdk.py, gateway/ (server, protocol, tokens), scheduler.py
  telemetry/     friction.py, wirelog.py, trace.py, heap.py, crash.py
  cli.py         devo run | attach | trace | serve
tests/
  unit/          per module, mock provider with scripted streams
  conformance/   the garrison suite ported: crash recovery boot, detached
                 recovery visible, idempotent send, guest prompt isolation,
                 lazy prune, history, approvals, production verifier-free
                 completion honesty
  chaos/         kill -9 mid-tool, mid-stream, mid-compaction; disk full;
                 provider hangs; clock skew
```

Dependencies, deliberately few: `pydantic`, `anyio` (asyncio with structured
cancellation), `httpx`, `websockets`, `sqlite3` (stdlib) behind a thread
writer, `pathspec` for gitignore, `tomllib`. Optional: `uvloop`, `tiktoken`
(estimator calibration only), ripgrep binary.

Platform: POSIX first. Process groups via `start_new_session=True`; Windows
uses Job Objects behind the same `ProcessOwner` interface and PowerShell
behind the same shell contract, later.

---

## 19. Testing and acceptance

The rewrite is accepted when all of these hold:

1. **Conformance**: every ported garrison test passes against DevoEngine.
2. **Chaos**: a run killed with SIGKILL at any of 12 instrumented points
   (mid-admission, mid-tool, mid-stream, mid-compaction, mid-checkpoint,
   mid-settlement, ...) resumes and finishes the same objective with no
   duplicated effect and no lost edit, 100 of 100 times.
3. **Long-horizon benchmark**: a scripted 300-step coding scenario on the mock
   provider (plan, edit 40 files, run checks, hit 6 injected failures, change
   approach, finish) completes with: constraints present verbatim in the final
   rendered context; every edited file's hash correct in the ledger; prompt
   tokens per step bounded by budget throughout; `cache_front_moves` ≤ 1 per
   compaction event; total input tokens at most 25 % of the same scenario run
   through the garrison's transcript model (measured by replaying the garrison
   loop on the same mock).
4. **Guard matrix**: each guard has a test that drives the exact trigger and a
   test that drives the near-miss.
5. **Prompt budget**: default core catalog under 12k tokens.
6. **Cache**: a 50-step mock run with Anthropic cache accounting shows
   ≥ 85 % cache read ratio on steps without compaction.

---

## 20. Positioning against the garrison, and what Crix keeps

- The garrison stays as Crix's product host (Telegram, phone, personas,
  Forge). Nothing in this design asks it to change.
- DevoEngine is the engine Oruna embeds. It shares the garrison's wire
  protocol so a phone client could attach to either; that is a convenience, not
  a goal.
- If later desired, the garrison could host DevoEngine behind its
  `SessionFactory` seam, since the request shape (provider, model, workspace,
  signal, requestPermission, initialMessages) maps onto `RunRequest` directly.
  That migration is out of scope here.

---

## 21. Risks and open questions

1. **Ledger discipline depends on the model using the `ledger` tool.** The
   runtime auto-fills files, checks and failures, and plan-before-edit forces a
   first plan, but decisions and constraints need the model. Mitigation: the
   craft core makes it doctrine; the run-stall guard notices when it lapses;
   the narrative fallback catches the rest. Measure in the benchmark.
2. **Task scope boundaries can be chosen badly.** Auto-opening after 10 rounds
   is a heuristic. Mitigation: scopes are cheap to open and close, and the
   parent window keeps the handoff, so a bad boundary costs one message, not
   state.
3. **Python process model.** asyncio plus subprocesses plus SQLite in a thread
   is well-trodden, but a CPU-heavy tool (symbol index over a 50k-file repo)
   must run in a worker process or it stalls the event loop. Mitigation: a
   `cpu_bound` executor in the tool context; the index is cached by git HEAD.
4. **Anthropic cache accounting with a per-step ledger block.** The ledger
   rides the pending user message, so it never breaks the system/tool prefix,
   but it does change the last message every step. That is already true of
   every user turn. The rolling breakpoint handles it.
5. **Windows.** Deferred. Oruna's deployment target is Linux.
6. **Licence.** Ares is AGPL-3.0-only. DevoEngine as described is a new
   implementation informed by Ares's design and incident history, not a port of
   its source. If any Ares source is copied, the AGPL applies to the result.
   Decide before the first commit.

---

## Appendix A. Event kinds

`input_admitted`, `run_start`, `step_start`, `provider_attempt_started`,
`provider_attempt_superseded`, `provider_attempt_effects_skipped`,
`steer_routed`, `text_delta`, `thinking_delta`, `tool_use_start`,
`tool_use_input_delta`, `tool_use_input_done`, `message_done`, `tool_start`,
`tool_progress` (not persisted), `tool_end`, `tool_error`,
`permission_request`, `permission_response`, `approval_pending`,
`reminder_injected{source}`, `compaction{method, before, after}`,
`ledger_updated{version, delta}`, `scope_opened`, `scope_closed{handoff}`,
`checkpoint_created{reason}`, `rewound`, `workspace_diff`, `subagent_start`,
`subagent_end`, `guard_fired{name}`, `budget_warning`, `run_paused{reason}`,
`turn_end{status, work_status, usage, context, provider, model}`,
`run_end{status, work_status}`.

## Appendix B. Garrison source map used for this design

- Engine loop, budgeting, compaction, guards: `packages/core/src/queryEngine.ts`,
  `turnGuards.ts`, `tokenEstimate.ts`, `contextCeilings.ts`, `promptCache.ts`.
- Durability: `packages/core/src/session.ts`, `sessionKernel/`,
  `workspaceMutation.ts`, `checkpoints.ts`, `checkpointGit.ts`.
- Delegation: `subagents.ts`, `subagentJournal.ts`, `forkedTurn.ts`,
  `conductor.ts`.
- Tools: `packages/tools/src/_shared.ts`, `Read.ts`, `Edit.ts`, `Write.ts`,
  `Bash.ts`, `ShellRegistry.ts`, `ShellSupervisor.ts`, `Task.ts`,
  `Conductor.ts`, `ToolSearch.ts`, `Mcp.ts`, `WebFetch.ts`.
- Host: `packages/garrison/src/{sessions,server,scheduler,approvals,
  ownerGuards,sessionPrune,protocol,token}.ts`,
  `packages/cli/src/entry/{garrisonCmd,sessionFactory,turnPipeline,
  planPressure,sessionPlanModes,permissions,garrisonRecovery}.ts`,
  `packages/cli/src/policyGate.ts`, `packages/cli/src/entry/prompt/`.
- Memory: `packages/agent/src/memory/unifiedRecall.ts`,
  `packages/mind/src/memory/{router,recall,store}.ts`,
  `packages/agent/src/dreaming.ts`.
