# Oruna rewrite: the build document

How to build Oruna on DevoEngine, module by module, with signatures, schemas,
tests and gates. `DEVOENGINE.md` says what and why; this says how, in the
order to do it. An engineer or an agent should be able to work from this file
alone, opening the design only for rationale.

Target: Oruna finishes multi-hour coding tasks on real repositories that the
Ares garrison cannot, measured by the benchmark in §9, with the same model.

Language: Python 3.12+. Dependencies: `pydantic>=2`, `anyio`, `httpx`,
`websockets`, `pathspec`. Stdlib `sqlite3` and `tomllib`. Optional:
`uvloop`, `tiktoken`, ripgrep on PATH. Nothing else without a written reason
in the PR.

Repository: a new `oruna` repository. The old `core/` is kept under
`legacy/` until phase 4 ships, then deleted. Nothing is imported from
`legacy/` and nothing is copied from Ares source (licence: see
`DEVOENGINE.md` §21.6).

---

## 0. Ground rules for the build

1. **Tests before code for every module.** Each module section below lists
   the tests it must pass. Write them first against the signatures; they are
   the contract.
2. **Incidents are tests.** Every carried-over Ares rule (DEVOENGINE Appendix
   B) that touches a module becomes a named test there. The test name cites
   the incident, e.g. `test_edit_does_not_truncate_large_files`.
3. **No stdout from the engine.** Only hosts print. The engine yields events.
4. **Every history mutation goes through `Window.mutate(reason)`.** Tests
   assert `cache_front_moves` per step.
5. **Every effect goes through `tools.pipeline.execute`.** No module calls a
   tool's `call()` directly, tests included (use the mock tool fixture).
6. **Every subprocess is owned.** `workspace.process.ProcessOwner` is the
   only place `subprocess` or `asyncio.create_subprocess_*` is imported.
7. **Env knobs** are read once at startup into `Config`, never from
   `os.environ` elsewhere. Names in §8.
8. **Line budget**: 25k lines of Python including tests. Over that, stop and
   cut.

---

## 1. Repository layout

```
oruna/
  pyproject.toml
  oruna/
    __init__.py            __version__, AgentHost re-export
    config.py              Config (pydantic), load_config(path|env)
    types.py               Message, ContentBlock, Usage, StopReason, Event kinds
    kernel/
      log.py               EventLog (append, read, seq), Writer thread
      store.py             SQLite schema + migrations
      projections.py       fold(events) -> State; one class per projection
      snapshot.py          Snapshot save/load, content-addressed
      lease.py             Lease acquire/heartbeat/release, dead-pid expiry
      outbox.py            Outbox relay
    engine/
      run.py               Run: create/admit/resume/wait; status machine
      scheduler.py         WorkGraph ready-set, worker assignment, parallel
      worker.py            step(): the loop (§4.2)
      steering.py          boundaries, epochs, apply_steering
      guards.py            GuardSet
      supervisor.py        silence / progress / budget watchdog
      waits.py             Wait registry, due(), wake inputs
      failure.py           failure protocol (learned fix / diagnose frame)
      handoff.py           handoff from events
      lanes.py             lane -> provider+model resolution
    context/
      tokens.py            estimate(), Calibration
      window.py            Window (messages, epochs, mutate, rungs, demotion)
      knowledge.py         KnowledgeStore (SQLite FTS + content store)
      retrieval.py         select(task, query, budget) -> facts
      compiler.py          compile(run, task) -> (system, messages)
      budget.py            ladder, floors, sticky cut, images, blind strip
      render.py            section renderers (goal, graph, knowledge, reminders)
      cache.py             front tracking, breakpoint placement
    workspace/
      process.py           ProcessOwner (POSIX groups; Windows stub)
      shell.py             run_shell(cmd, timeout, cwd) -> ShellResult
      jobs.py              durable background jobs + supervisor process
      mutation.py          MutationService (CAS, locks, journal, fsync)
      shadow.py            shadow git history; blob fallback
      worktrees.py         git worktree fork / merge
      repo.py              repo map, project checks, instructions, symbols
    tools/
      contract.py          Tool protocol, ToolContext, ToolResult, errors
      pipeline.py          execute(): admit→hook→watchdog→settle→spill
      batches.py           dep-aware batching
      spill.py             cap + spill to disk
      parse.py             lenient input parsing, aliases, name resolution
      belt/
        read.py edit.py write.py applypatch.py glob.py grep.py
        bash.py jobs.py plan.py note.py recall.py memory.py
        waitfor.py askuser.py web.py codesearch.py task.py
        toolsearch.py planmode.py
      skills.py            Oruna skills loader (tool contribution plugin)
    providers/
      base.py              Provider protocol, ProviderRequest, StreamEvent
      openai_compat.py     chat completions (DeepSeek, OpenRouter, any)
      anthropic.py         messages API, caching, thinking, self-heals
      mock.py              scripted provider for tests
      pairs.py             adjacency sanitiser, JSON repair
      stall.py             byte and event stall guards
      retry.py             ladders, backoff, Retry-After
      ceilings.py          learned context ceilings
      schema.py            JSON schema narrowing
    delegation/
      children.py          child runs (Task tool)
      journal.py           flight recorder
    memory/
      base.py              MemoryBackend protocol
      local.py             files + FTS (no Oricle)
      oricle.py            Oricle door: pack/attest/commit/recall/tasks/episode
      learned.py           learned fixes
    policy/
      modes.py             permission matrix
      laws.py              Oruna laws: text, hash, classifier
      grants.py            command/path/tool grants
      approver.py          Approver protocol, chain, timeout, repeat-denial
    prompt/
      craft.py overlays.py doctrine.py compose.py child.py
    hosts/
      sdk.py               AgentHost, Agent, Run handles
      cli.py               oruna run|attach|trace|diff|replay|serve|pulse
      serve.py             POST /turn, GET /inbox, /health (token)
      gateway.py           WS protocol v1 (phase 6)
      scheduler.py         standing orders (pulse)
    telemetry/
      friction.py wirelog.py trace.py replay.py crash.py
  tests/
    unit/ conformance/ chaos/ benchmark/
    fixtures/              mock scripts, sample repos
  legacy/                  old core/, read-only, deleted after phase 4
  docs/                    DEVOENGINE.md, this file, laws.md, pulse.md
```

---

## 2. Shared types (`oruna/types.py`)

```python
Role = Literal["system", "user", "assistant"]          # tool results are user-role blocks (Anthropic shape)

class TextBlock(BaseModel):        type: Literal["text"]; text: str
class ThinkingBlock(BaseModel):    type: Literal["thinking"]; text: str; signature: str | None = None
class ToolUseBlock(BaseModel):     type: Literal["tool_use"]; id: str; name: str; input: dict
class ToolResultBlock(BaseModel):  type: Literal["tool_result"]; tool_use_id: str
                                   content: str | list[TextBlock | ImageBlock]; is_error: bool = False
class ImageBlock(BaseModel):       type: Literal["image"]; media_type: str; data: str | None; url: str | None
class ReminderBlock(BaseModel):    type: Literal["reminder"]; key: str; text: str; strippable: bool = False
ContentBlock = Annotated[Union[...], Field(discriminator="type")]

class Message(BaseModel):
    id: str                        # stable; tool_result messages get "tr_<assistant id>"
    role: Role
    content: list[ContentBlock]
    step: int                      # step that produced it
    epoch: int                     # context epoch it belongs to

class Usage(BaseModel):
    input_tokens: int = 0          # TOTAL prompt incl. cache
    output_tokens: int = 0
    cache_read: int = 0
    cache_write: int = 0
    reasoning_tokens: int = 0
    calls: int = 0

StopReason = Literal["end_turn", "tool_use", "max_tokens", "stop_sequence", "interrupted", "refusal", "error"]
ExecStatus = Literal["completed", "needs_verification", "interrupted", "failed"]
WorkStatus = Literal["verified", "unverified", "blocked", "not_applicable"]
Safety = Literal["read-only", "workspace-write", "external-state", "destructive"]

class Event(BaseModel):
    seq: int; run_id: str; ts: float; kind: str; actor: str
    body: dict; causation: int | None = None
```

Event kinds: the list in `DEVOENGINE.md` Appendix A, as a `Literal` in
`types.py`, so a typo is a type error.

---

## 3. Kernel

### 3.1 Schema (`kernel/store.py`)

```sql
CREATE TABLE events (run_id TEXT, seq INTEGER, ts REAL, kind TEXT, actor TEXT,
                     body TEXT, causation INTEGER, PRIMARY KEY (run_id, seq));
CREATE TABLE runs (id TEXT PRIMARY KEY, agent_id TEXT, workspace TEXT, status TEXT,
                   work_status TEXT, objective TEXT, created_at REAL, updated_at REAL, meta TEXT);
CREATE TABLE inputs (id TEXT PRIMARY KEY, run_id TEXT, delivery TEXT, state TEXT,
                     bytes_hash TEXT, admitted_at REAL, consumed_at REAL);
CREATE TABLE leases (run_id TEXT PRIMARY KEY, owner TEXT, pid INTEGER, token TEXT, expires_at REAL);
CREATE TABLE snapshots (id TEXT PRIMARY KEY, run_id TEXT, seq INTEGER, step INTEGER,
                        body BLOB, created_at REAL);
CREATE TABLE content (hash TEXT PRIMARY KEY, bytes BLOB, created_at REAL);   -- bodies for knowledge/rounds
CREATE TABLE tool_runs (run_id TEXT, tool_use_id TEXT, step INTEGER, name TEXT, state TEXT,
                        tx_id TEXT, touched TEXT, result_hash TEXT, started_at REAL, settled_at REAL,
                        PRIMARY KEY (run_id, tool_use_id));
CREATE TABLE jobs (id TEXT PRIMARY KEY, run_id TEXT, kind TEXT, state TEXT, pid INTEGER,
                   heartbeat_at REAL, log_path TEXT, meta TEXT);
CREATE TABLE waits (id TEXT PRIMARY KEY, run_id TEXT, task_id TEXT, kind TEXT, spec TEXT,
                    until REAL, state TEXT, payload TEXT);
CREATE TABLE outbox (id INTEGER PRIMARY KEY, run_id TEXT, kind TEXT, body TEXT,
                     created_at REAL, delivered_at REAL);
CREATE VIRTUAL TABLE knowledge USING fts5(run_id, task_id, kind, step, title, body_hash, text);
```

One DB per workspace at `<workspace>/.oruna/kernel.sqlite`, WAL mode,
`synchronous=NORMAL`, one writer thread per DB (`kernel/log.py:Writer`), all
writes through it. Reads are direct with their own connection.

### 3.2 API

```python
class EventLog:
    def append(self, run_id, kind, body, actor="runtime", causation=None) -> Event   # sync, through Writer
    def read(self, run_id, after_seq=0, kinds=None, limit=None) -> Iterator[Event]
    def last_seq(self, run_id) -> int
    def subscribe(self, run_id) -> AsyncIterator[Event]                              # live tail

class Projections:
    @staticmethod
    def fold(events: Iterable[Event], base: State | None = None) -> State
    # State has: window, graph, knowledge_index, tools, guards, calibration, stamps, budget, waits, status

class Snapshots:
    def save(self, run_id, step, seq, state: State) -> str          # returns id (sha of body)
    def load_latest(self, run_id) -> tuple[State, int] | None      # (state, seq)

class Leases:
    def acquire(self, run_id, owner, ttl_ms) -> Lease | None
    def heartbeat(self, lease) -> bool
    def release(self, lease) -> None
    def expire_dead(self) -> int                                   # pid probe; EPERM counts alive

class Outbox:
    def enqueue(self, run_id, kind, body) -> int                   # same transaction as caller's event
    def relay(self, handlers: dict[str, Callable]) -> None         # idempotent delivery
```

### 3.3 Tests (`tests/unit/kernel/`)

- `test_append_is_monotonic_and_durable`: 10k appends, reopen, `last_seq`.
- `test_fold_is_pure`: fold(events) twice gives equal State; fold(snapshot+tail) == fold(all).
- `test_snapshot_roundtrip_every_projection`.
- `test_dead_pid_lease_expires_at_once` (Ares: 21 s boot stall).
- `test_live_pid_lease_is_kept`.
- `test_outbox_survives_crash_between_decide_and_send` (kill writer thread after enqueue, relay on reopen delivers once).
- `test_progress_and_deltas_are_never_persisted` (Ares: 224 MB rollout).
- `test_corrupt_tail_row_is_skipped_not_fatal`.

---

## 4. Engine

### 4.1 Run (`engine/run.py`)

```python
class RunRequest(BaseModel):
    workspace: Path; objective: str; budget: Budget = Budget()
    mode: PermissionMode = "workspace-write"; unattended: bool = False
    parallel_workers: int = 1; lanes: dict[str, str] | None = None
    tags: list[str] = []

class Run:
    id: str; status: ExecStatus | Literal["created","queued","running","waiting","paused"]
    async def admit(self, text: str, delivery: Literal["queue","steer","wake"]="queue",
                    input_id: str | None = None, attachments: list[ImageBlock] = []) -> AdmitResult  # duplicate|conflict|admitted
    async def start(self) -> None                       # acquires lease, starts workers
    async def interrupt(self, input_id: str | None = None) -> bool
    async def pause(self) / resume(self)
    async def wait(self) -> RunResult                   # exec status, work status, usage
    def events(self, since=0) -> AsyncIterator[Event]
    @property graph -> WorkGraph; knowledge -> KnowledgeView; ledger -> ToolLedgerView
```

Rules (each a test):
- Same `input_id` + different bytes → `conflict` (`test_input_conflict`).
- Replayed settled input → synthetic `turn_end` on the subscriber, no new work (`test_replay_gets_terminal_event`: "ack then silence").
- A failed step leaves the input `claimed`; `resume()` continues it; a second failure in a row cancels it (`test_failed_input_is_resumable_then_retired`).
- Startup drains orphaned inputs detached, at most 2 replays each (`test_orphan_replay_cap`).
- `turn_end` is emitted only after the snapshot is written (`test_turn_end_after_snapshot`).

### 4.2 Worker step (`engine/worker.py`)

```python
async def step(ctx: StepContext) -> StepOutcome:
    """One provider call and its tool rounds. Exactly the order in DEVOENGINE §5.1."""
```

`StepContext` carries: run, task, window, knowledge, graph, guards,
calibration, stamps, cancel token, steering inbox, provider for the lane,
tool belt, policy, config, event log.

Order inside `step` is fixed and tested with a recording mock provider and
mock tools (`tests/unit/engine/test_step_order.py` asserts the exact event
sequence for: plain reply; one tool round; steer during provider; steer
during tools; abort during compaction; context-limit descent; refusal
self-heal; truncated tool_use; max_tokens continue).

Specific tests, each citing its incident:
- `test_cancel_visible_at_every_boundary` (Stop looked dead).
- `test_reminders_after_tool_results` (Anthropic 400 brick).
- `test_compaction_projection_committed_before_reminder`.
- `test_steer_gets_own_provider_slot_with_max_turns_1`.
- `test_superseded_attempt_never_exposes_events`.
- `test_no_message_done_is_synthesised_retriable`.
- `test_truncated_tool_use_gets_paired_error`.
- `test_withheld_partial_calls_cap_three_then_hint`.
- `test_refusal_strips_strippable_once`.
- `test_abort_after_stream_is_interrupted_not_failed`.

### 4.3 Guards (`engine/guards.py`)

```python
class GuardSet:
    def __init__(self, cfg: Config, is_child: bool)
    def on_message_done(self, msg, stop_reason) -> list[GuardAction]     # continue / nudge / plan gate / promise gate
    def on_round(self, calls: list[ToolUseBlock], results: list[ToolResultBlock]) -> list[GuardAction]
    def on_step_end(self, graph_changed: bool, knowledge_changed: bool) -> list[GuardAction]
    # GuardAction: Remind(key, text) | ForceTool(name) | Block(reason) | Fail(reason) | EndGracefully(reason)
```

Thresholds and signatures per `DEVOENGINE.md` §9. Tests: one trigger and one
near-miss per guard, plus `test_failure_signature_normalisation`,
`test_call_signature_uses_full_hash` (200-char collision),
`test_gather_signature_includes_payload` (Browser eval incident),
`test_grind_key_includes_command_head` (build vs test pooling),
`test_todo_gate_fires_once_per_turn`.

### 4.4 Scheduler and work graph (`engine/scheduler.py`)

```python
class Task(BaseModel): ...        # DEVOENGINE §4, plus `check_origin: Literal["project","model_new_test","model_existing"]`
class WorkGraph:
    def apply(self, op: GraphOp) -> list[Event]        # set/add/update/split/cancel/loosen_acceptance
    def ready(self) -> list[Task]
    def parallelisable(self, ready, max_workers) -> list[list[Task]]   # disjoint scopes, no deps
    def render(self, current: str | None, budget_tokens: int) -> str

class Acceptance:
    async def evaluate(self, task, run) -> AcceptanceResult   # runs check via pipeline as actor "runtime"
    def validate_check(self, cmd, project_checks) -> str | None   # grammar + known runner, else reason
    def scan_weakening(self, diff: Diff) -> list[str]            # deleted tests, skip markers, removed asserts
```

Tests: `test_ready_respects_deps`, `test_parallel_only_with_disjoint_scopes`,
`test_unscoped_tasks_never_parallel`, `test_done_requires_green_check`,
`test_red_twice_blocks`, `test_model_new_test_is_provisional_until_judge`,
`test_weakened_test_marks_suspect`, `test_worker_cannot_loosen_acceptance`,
`test_render_caps_at_40_tasks`.

### 4.5 Steering (`engine/steering.py`)

Phases `idle|boundary|maintenance|provider|effect|terminal`; epochs;
`apply_at_boundary()` installs steer inputs with upsert-by-id and conflict
detection; `arm_attempt()` loops until no wake raced the snapshot. Tests from
§4.2 cover behaviour; unit tests cover epoch arithmetic and phase
transitions.

### 4.6 Supervisor, waits, failure, handoff, lanes

- `supervisor.py`: silence (15 min, escalate interrupt×2 → abort×2 → evict),
  progress (12 steps → remind, 24 → blocked), budget (85 % → remind, 100 %
  → graceful end). Tests use an injectable clock.
- `waits.py`: `register(run, task, kind, spec, until)`, `due(now) ->
  list[Wake]`; kinds `timer|job|path|webhook|user`. A wake is admitted as a
  `wake` input with payload. Tests: each kind, timeout → `timed_out`, a wait
  releases the worker and drops the lease when nothing is ready
  (`test_waiting_run_holds_no_lease_and_spends_no_tokens`).
- `failure.py`: at the 2nd identical signature: learned fix (project then
  global) → inject; else diagnose frame. When a streak clears after a change
  of approach: write learned-fix candidate `{signature, diff_digest, note}`.
  Tests: both branches, and `test_candidate_written_only_after_approach_changed`.
- `handoff.py`: build from events of a task's span: files (final hashes),
  commands (exit codes), checks, errors, closing note ≤ 700 chars. Test:
  `test_handoff_from_events_not_prose` (model lies in its note; handoff shows truth).
- `lanes.py`: `resolve(lane) -> (Provider, model, reasoning)`; defaults
  worker=planner=judge, reader cheaper.

---

## 5. Context

### 5.1 Tokens (`context/tokens.py`)

`estimate(block) -> int` with per-line class ratios (prose 4, code 3,
base64 2.5, CJK 1/char, indent 12, newline 0.25), images by dimension or
bytes/900 in [256, 2000], URL images 256. `Calibration.update(est, real)`
EWMA 0.7/0.3 clamped [0.5, 2.5], ignore under 500, reset on provider change.
Per-block memo keyed by `id(block)`, invalidated via `Window.mutate`. Tests:
each ratio, the memo invalidation, `test_code_is_never_underestimated_vs_prose`.

### 5.2 Window (`context/window.py`)

```python
class Window:
    messages: list[Message]; epoch: int; front: int      # front = earliest index changed since last step
    def mutate(self, reason: str) -> ContextManager        # records earliest changed index; emits window_* events
    def rounds(self) -> list[Round]                        # assistant msg + its tool_result msg
    def clear_images(self, keep_rounds=2, batch=6) -> int
    def clear_text(self, threshold, target_ratio, keep_recent=6, working_set=8) -> int   # returns tokens freed
    def demote(self, keep_rounds) -> list[Round]           # removes from front; caller stores as knowledge
    def cache_front_moves(self) -> int
```

Tests: `test_demotion_never_splits_a_round` (adjacency brick),
`test_text_rung_keeps_working_set_reads`, `test_text_rung_batch_gate`,
`test_image_rung_age_gated_not_watermark`, `test_cache_front_only_moves_on_front_ops`,
`test_three_ineffective_text_passes_force_demotion`.

### 5.3 Knowledge (`context/knowledge.py`, `context/retrieval.py`)

```python
class Fact(BaseModel): id: str; run_id: str; task_id: str | None; kind: FactKind; step: int
                       title: str; text: str; body_hash: str | None; tags: list[str]
class KnowledgeStore:
    def add(self, fact, body: str | None = None) -> str
    def get(self, id) -> tuple[Fact, str | None]
    def search(self, run_id, query, kinds=None, task=None, limit=20) -> list[tuple[Fact, float]]   # BM25
    def ingest_round(self, run_id, task_id, round: Round, step) -> str            # full body to content store
    def ingest_outcome(self, run_id, task_id, call, result, step) -> list[str]  # file/check/failure facts
def select(store, run, task, cues: list[str], budget_tokens) -> list[Fact]       # §6.3 always + ranked
```

Tests: `test_demoted_round_is_fully_recoverable_by_id`,
`test_always_set_present_regardless_of_rank`, `test_rank_weights_by_kind`,
`test_dedupe_by_content_hash`, `test_render_is_stable_when_set_is_stable`
(byte-equal section across two compiles with the same facts).

### 5.4 Compiler (`context/compiler.py`)

```python
def compile(run, task, window, knowledge, graph, reminders, pending_text, cfg) -> Compiled
# Compiled: system (str, hash), messages (list[Message]) where the last is the tail message:
#   [tool_results of last round] + [ReminderBlock(key=...) sections] + [TextBlock(pending_text)]
```

Rules: sections only on the tail; never stored; `context_compiled` event with
section hashes; sections after tool_results. Tests:
`test_sections_only_on_tail_and_not_in_history`,
`test_system_prompt_hash_constant_across_steps`,
`test_sections_after_tool_results`, `test_date_not_in_system_prompt`.

### 5.5 Budget (`context/budget.py`)

`ladder(B, overhead, ceiling) -> list[int]` with floors and dedupe;
`budget_messages(msgs, limit, min_keep=4, sticky: StickyCut | None)`;
`fit_images(msgs, keep_counts=[8,4,2,1,0], payload_cap)`; `blind_strip`.
Tests: `test_descent_floored_at_overhead_plus_12k` (model saw only pending
message), `test_min_keep_four`, `test_never_lead_with_orphan_tool_result`,
`test_sticky_cut_reuses_anchor`, `test_images_dropped_attached_last`,
`test_blind_strip_outbound_only`.

---

## 6. Workspace and tools

### 6.1 Process owner and shell (`workspace/process.py`, `shell.py`)

```python
class ProcessOwner:
    async def spawn(self, argv_or_cmd, *, shell: bool, cwd, env, stdin_closed=True) -> Owned
    async def kill_tree(self, owned, grace_s=2.0) -> None     # TERM group → KILL → force-settle 5 s
    async def wait_pipes(self, owned, grace_s=1.5) -> None    # after natural exit

class ShellResult(BaseModel): exit_code: int | None; timed_out: bool; stdout_tail: str; stderr_tail: str
                              full_log: Path | None; leftovers: list[int]; duration_ms: int
async def run_shell(cmd, *, timeout_s=120, cwd, cap=30_000, cancel) -> ShellResult
```

Tests: `test_grandchild_holding_pipe_does_not_wedge` (spawn `sh -c 'sleep 30 &'`
then exit; call returns within grace), `test_timeout_kills_group`,
`test_tail_cap_and_full_log_when_truncated`, `test_leftovers_reported`.

### 6.2 Jobs (`workspace/jobs.py`)

Durable: `jobs` table row, detached supervisor process (`oruna/workspace/_jobsup.py`)
that owns the command, appends to `<ws>/.oruna/jobs/<id>.log`, writes a
heartbeat state file every 1 s. `poll(id, cursor, max_bytes=200_000)`;
`orphaned` after 30 s silence confirmed by a re-read; stable id =
`sha(run, tool_use_id)[:16]`; completion → `wake` input with the last 16k
tail. Never auto-resumed. Tests: `test_job_outlives_engine_process`,
`test_replay_addresses_same_job`, `test_orphan_detected_after_reread`,
`test_completion_arrives_as_wake`, `test_no_auto_resume_after_restart`.

### 6.3 Mutation service and shadow history (`workspace/mutation.py`, `shadow.py`)

```python
class MutationService:
    async def apply(self, tx_id, ops: list[FileOp], expected: dict[Path, str | None]) -> Receipt
    # path locks (in-proc + lock files), CAS on sha256, stage+fsync+rename, journal, readback
    async def reconcile(self, tx_id) -> Literal["applied","not_applied","unknown"]
class ShadowHistory:
    def commit(self, run_id, paths: list[Path], label) -> str          # tree sha; shadow index; 20 s bound
    def diff(self, a: str, b: str | None = None) -> Diff                # None = working tree
    def restore(self, tree, paths=None) -> list[Path]
    def too_broad(self, path) -> bool                                   # home / drive root
```

Tests: `test_cas_conflict_detected`, `test_interrupted_apply_reconciles`,
`test_shadow_never_touches_real_index_or_head`, `test_restore_exact_paths`,
`test_home_dir_refused`, `test_checkpoint_failure_degrades_not_fatal`
(EPERM Write incident).

### 6.4 Repo intelligence (`workspace/repo.py`)

`repo_map(ws) -> RepoMap` deterministic and fingerprinted;
`project_checks(ws) -> list[CheckCommand]` from manifests, cached 5 min;
`instructions(ws, path) -> list[RuleFile]` root→leaf, first convention file
per dir, bounded walk; `symbols(ws) -> SymbolIndex` regex per language,
cached by HEAD. Tests: determinism, bounded walk, cache invalidation.

### 6.5 Tool contract and pipeline (`tools/contract.py`, `pipeline.py`)

Protocol per `DEVOENGINE.md` §8.1. Pipeline order per §8.2. Watchdog
precedence; permission wait pauses watchdog; `PermissionDenied` interrupts
interactive workers, is a per-call error for children.

Tests: `test_admit_before_start_event`, `test_settle_before_end_event`,
`test_watchdog_precedence`, `test_watchdog_paused_during_permission`,
`test_effect_unknown_when_killed_mid_call`, `test_pre_effect_errors_are_correctable`,
`test_denial_interrupts_only_interactive`, `test_posthook_is_own_run`.

### 6.6 Batches, spill, parse

- `batches.build(calls) -> list[list[ToolUseBlock]]`: tests for solo tools,
  shared-target-with-writer, exclusive-without-target, model order kept.
- `spill.cap(result, budget, path) -> str`: head 2000 + marker + hint + tail
  600; line-pageable file; computed once. Test: `test_spill_is_pageable_by_read`
  (the spill-of-a-spill brick).
- `parse.lenient(model, raw) -> dict`: strip unknown keys and retry; parse
  JSON-encoded arrays; aliases. `resolve_name(name, belt)`. Tests for each.

### 6.7 The belt (`tools/belt/`)

Each file implements one Tool. The rules and their tests:

**read.py**: `cat -n`, 2000 lines, 4000 chars/line, 50 KB/page, one streaming
pass for exact count + sha256, stat re-check, self-bounded, PDF/image/dir.
Stamp `{mtime, size, sha, lines}`. Tests: paging, line cap, race detection,
`test_read_is_never_spilled`.

**edit.py**: unique match or `replace_all`; tiers exact → whitespace → anchor
→ normalised, with the tier reported; function replacement; reject numbered
`old_string`, empty, identical, mixed batches, glob chars; auto-read when no
stamp; stale stamp → retry on current bytes, miss → stale error; batches
all-or-nothing; `new_string_from_file`; syntax gate valid→invalid only (json,
js via `node --check`, py via `ast.parse`, sh via `bash -n`); CAS commit via
MutationService; excerpt ≤ 60 lines; near-miss hint; **hash-drift re-read**:
if knowledge `last_hash` != disk and the Read body is demoted, re-read the
match region first. Tests include `test_edit_does_not_truncate_large_files`
(the legacy bug, 30k chars), `test_tiers_in_order`, `test_auto_read_when_no_stamp`,
`test_stale_retry_then_error`, `test_hash_drift_forces_reread`,
`test_syntax_gate_blocks_only_valid_to_invalid`, `test_replacement_not_dollar_expanded`.

**write.py**: refuse empty without `allow_full_replace`; auto-read + echo 20
lines; hash staleness hard error; shrink guard (<10 % bytes, or <34 % and
≥25 fewer lines) on files ≥40 lines or ≥2 KB; backups + index. Tests:
`test_shrink_guard_blocks_1251_to_23_lines`, `test_backup_written`.

**applypatch.py**: `*** Begin Patch` multi-file atomic; the only editor for
OpenAI-family models.

**glob.py / grep.py**: mtime sort, 500 results, 15 s; ripgrep with Python
fallback, 200 results, 20k match cap, 4 MB skip, 30 s, inline flags
stripped, `-A/-B/-C`, multiline, gitignore.

**bash.py**: via `run_shell`; 120 s default, 600 s max, watchdog +20 s;
`description` optional; `exit N` first line; test-log summariser ≥ 8k;
leftovers; **refusals even in bypass**: `git clean -x/-X` without `-n`,
killing the host (`systemctl .* oruna`, `pkill -f oruna`), launching the
owner's browser or a headed Playwright. Permission order: instructions →
stored deny/ask → stored allow → destructive classifier (unwrap `sh -c`,
`python -c` once) → allowlist policy → allow. Tests for every refusal and
the classifier table.

**jobs.py** (tool): `Bash run_in_background`, `BashOutput`, `KillShell` over
`workspace/jobs.py`.

**plan.py**: `set/add/update/split/cancel`; validates `check` against the
grammar and project checks; `check_origin` recorded. **note.py**: constraint,
decision, file note. **recall.py**: `recall(query, kinds, task, limit)` and
`recall(id)` paged like Read. **memory.py**: project notes with sha
versioning, `learn(signature, fix)`. **waitfor.py**: ends the step, registers
the wait. **askuser.py**: a `user` wait with a structured question.
**web.py**: WebFetch (SSRF guard with redirect re-check, 30 s, 8 MB, binary
refused, `max_chars`/offset, untrusted framing, optional reader-lane
summary) and WebSearch (provider chain). **codesearch.py**: TF-IDF over the
repo. **task.py**: child runs. **toolsearch.py**: term scoring, `select:`,
loaded set recovered from the log. **planmode.py**: enter/update/exit.

### 6.8 Skills (`tools/skills.py`)

Oruna's own contract, kept: `~/.oruna/skills/<name>.py` with a docstring,
`ARGS`, `run(...)`, optional `test()`; compiled and tested before acceptance;
a broken file never blocks the others; names cannot shadow belt tools. Loaded
into the deferred tier. `write_skill`/`remove_skill`/`list_skills` are tools
in the belt. Tests: port the four from `legacy/core/tests/test_oruna.py`
Skills class.

---

## 7. Providers, policy, memory, prompt, hosts

### 7.1 Providers

- `base.py`: protocol per DEVOENGINE §13; `StreamEvent` union.
- `openai_compat.py`: chat completions with streaming; tool calls; `tool`
  role translation to/from the Anthropic-shaped history; schema narrowing;
  works for DeepSeek and OpenRouter (the models Oruna uses today). Tests
  with a recorded-fixture HTTP server.
- `anthropic.py`: messages API; three cache breakpoints; adaptive thinking +
  effort; 400 self-heals; adjacency sanitiser; refusal not streamed; OAuth
  plan-limit. Tests: `test_three_breakpoints_placement`,
  `test_cache_control_absent_for_deepseek_dialect`, `test_400_self_heals`,
  `test_refusal_text_not_streamed`.
- `pairs.py`: adjacency check, placeholders, JSON repair, split-writes
  coercion. Tests: `test_split_pair_is_repaired` (brick), `test_unterminated_large_write_gets_hint`.
- `stall.py`: byte stall 180 s; event idle 90 s + 1.2 s/1k over 16k (max
  300 s); active idle 360 s; think ceiling 180 s; interrupt raced. Tests with
  a slow fake stream.
- `retry.py`: ladders 4/8/6; backoffs; Retry-After cap 60 s; zero-output
  breaker at 4; stall shrink ≤2 rungs never last; rate-limit failover probe.
- `ceilings.py`: per provider+model, 30-day TTL, floor 16k, never from
  stall/413.
- `mock.py`: scripted responses keyed by step and by regex over the compiled
  tail; records every request; supports injected 429/503/stall/context-limit
  and tool-call scripts. This is the backbone of every engine test and the
  benchmark.

### 7.2 Policy (`policy/`)

- `modes.py`: matrix per DEVOENGINE §12 plus `oruna-unattended`: deny
  destructive shell, deny writes outside the agent home and the run's
  workspace, deny money/accounts/credentials, deny `message_*` to anyone but
  the owner; everything else as `workspace-write`.
- `laws.py`: `LAWS` text loaded from `docs/laws.md`, `LAWS_SHA` 16 hex,
  `classify(tool, input, unattended) -> Decision | None`, STOP file check.
  Tests: port the Laws class from legacy tests, plus `test_laws_hash_in_system_prompt`.
- `grants.py`: command prefix rules, literal for destructive/chained, chains
  all-allowed-or-deny, explicit deny wins, path grants per directory,
  tool-wide grants, destructive "always" not persisted.
- `approver.py`: protocol, chain (first non-abstain), one timeout
  (`permission_wait_ms`, default 300000 → deny), repeat-denial breaker on
  canonical action key, unattended gate. Tests: `test_one_timeout_everywhere`,
  `test_repeat_denial_rejected_without_prompt`, `test_unattended_ask_is_deny`.

### 7.3 Memory (`memory/`)

- `base.py`: `MemoryBackend` with `pack(query, budget) -> (text, pack_id)`,
  `attest(pack_id, cited, result)`, `commit(kind, text, title, tags) -> id`,
  `recall(query, kinds, limit)`, `get(id)`, `tasks()`, `episode(...)`.
- `oricle.py`: the door, ported from `legacy/core/oricle.py` with retries
  bounded (10 s), token rotation retry, `STATE` watcher, and `commit_round`.
- `local.py`: files + FTS when Oricle is absent; same interface.
- `learned.py`: signature → fix, project and global; written by the failure
  protocol.
- Carry-forward: on run start in a known workspace, import `file` notes and
  `decision` facts from the last 3 runs at reduced rank weight.

### 7.4 Prompt (`prompt/`)

`compose(agent, run, tools_core) -> str` with the order in DEVOENGINE §15.
Oruna's standing rules (`docs/rules.md`) ride as the "standing rules" block;
`LAWS` with hash follow. Test: `test_default_catalog_under_12k_tokens`,
`test_system_prompt_has_no_date_or_pack`.

### 7.5 Hosts (`hosts/`)

- `sdk.py`: `AgentHost(data_dir)`, `host.agent(name, **profile) -> Agent`,
  `agent.start_run(RunRequest) -> Run`. In-process.
- `cli.py`: `oruna run <workspace> "<objective>"`, `attach <run>`, `trace`,
  `diff`, `replay`, `serve`, `pulse`. Terminal greeting from Oricle (last
  episode + open tasks) as legacy did.
- `serve.py`: `POST /turn {text} → {reply}` continues the agent's current
  interactive run or creates one; `GET /inbox`; `/health` reports running
  steps; `ORUNA_TOKEN`. One run per owner thread; the lock is the run's
  lease, not a Python lock.
- `scheduler.py`: standing orders from config; `pulse` = unattended run with
  `docs/pulse.md` as objective, 40 tool calls, 30 min, interrupt budget 3;
  never overlapping; results recorded honestly.
- `gateway.py`: WS protocol v1 (phase 6).

### 7.6 Telemetry

`friction.py` one line per step; `wirelog.py` awaited before dispatch, 8 MB
roll; `trace.py` timeline from events; `replay.py` re-run a run's log
against the mock provider that serves recorded assistant messages;
`crash.py` on unhandled exceptions and SIGTERM.

---

## 8. Configuration (`oruna/config.py`)

`Config` is a pydantic model loaded from `~/.oruna/oruna.toml`, overridden by
`ORUNA_*` environment variables (same names as DEVOENGINE §17 with the
`ORUNA_` prefix). The Oruna profile from `DEVOENGINE.md` §22.2 is the
default config shipped in `docs/oruna.toml`. Provider selection keeps the
legacy behaviour: `OPENROUTER_API_KEY` wins, then `DEEPSEEK_API_KEY`, then
`ANTHROPIC_API_KEY`; `ORUNA_API`/`ORUNA_MODEL` override.

---

## 9. Benchmark: Oruna versus the garrison on long-horizon coding

`tests/benchmark/` runs on the mock provider so it is deterministic, and
optionally on a real provider for the final comparison.

### 9.1 The scenario (`fixtures/scenario_billing/`)

A synthetic repository (about 60 files, Python, with a test suite) and a
scripted model behaviour that does, over 300 steps: plan 9 tasks; explore;
write a client; migrate three modules (parallelisable); add a flag; hit six
injected failures (two identical, one needing a learned fix, one weakened-test
attempt); run checks; wait 10 minutes on a fake CI job; finish.

### 9.2 Metrics recorded per step

prompt tokens, output tokens, `cache_front_moves`, demotions, knowledge
facts, graph state, work status, wall clock.

### 9.3 Pass criteria

1. Constraints present verbatim in the final compiled tail.
2. Every edited file's hash in knowledge equals disk.
3. Prompt tokens never exceed budget; p95 under 40k on a 192k budget.
4. `cache_front_moves` ≤ 1 per demotion.
5. `recall(id)` returns the full body for 50 random demoted rounds.
6. The weakened-test attempt is marked `suspect` and the task does not close
   until the judge step.
7. The wait spends zero tokens for 10 simulated minutes.
8. Total input tokens ≤ 25 % of the **baseline**: the same scripted scenario
   driven through `tests/benchmark/baseline_transcript.py`, a 150-line loop
   that accumulates the transcript and summarises at 60 % (the garrison's
   shape, reimplemented minimally; no Ares code).
9. SIGKILL at each of 12 instrumented points, 100 runs: same final graph,
   same file hashes, no duplicated effect.

### 9.4 The real-provider comparison (manual, once per release)

Run the scenario's human-readable objective against the live Ares garrison
on doingbox and against Oruna, same model (the garrison's default), same
repository checkout, 6-hour budget. Record: finished or not, tests green,
input tokens, wall clock, number of owner interventions. Publish the table in
`docs/BENCHMARKS.md`. This is the claim the project makes; keep it honest.

---

## 10. Phases and gates

Each gate is a command that must pass before the next phase starts.

| Phase | Weeks | Builds | Gate |
|---|---|---|---|
| 1 | 1–2 | `types`, `config`, `kernel/*`, `providers/mock`, `engine/run` (admit/resume only), `hosts/cli run` with a no-tool belt | `pytest tests/unit/kernel tests/chaos/test_kill_resume_basic.py` green; a run survives SIGKILL at admit, step, snapshot |
| 2 | 3–7 | `engine/worker`, `steering`, `guards`, `providers/openai_compat`, `providers/anthropic`, `pairs`, `stall`, `retry`, `ceilings`, `workspace/process`, `shell`, `jobs`, `mutation`, `shadow`, `tools/*`, belt: read edit write applypatch glob grep bash jobs toolsearch planmode, `policy/*` with laws | `pytest tests/unit` green; guard matrix green; `tests/conformance` subset (idempotent send, crash recovery, approvals, completion honesty) green; `oruna run` completes a 20-step real task on DeepSeek |
| 3 | 8–12 | `context/*` (tokens, window, knowledge, retrieval, compiler, budget, cache), belt: note recall memory, `memory/local`, `memory/oricle`, `memory/learned` | **Benchmark §9.3 criteria 1–5 and 8 pass on the mock.** Stop and review here. |
| 4 | 13–16 | `engine/scheduler`, acceptance + judge, `handoff`, `failure`, `supervisor`, belt: plan, `shadow.diff` in the compiled tail on red checks, `telemetry/trace`, `telemetry/replay` | Criteria 6 and 9; a 50-task scripted run completes with evidence-derived status; rewind works; `legacy/` deleted |
| 5 | 17–19 | parallel workers, `worktrees`, `waits`, belt: waitfor askuser, `hosts/scheduler` (pulse), `hosts/serve` | Criterion 7; parallel merge tests; the pulse runs unattended under the laws on doingbox for a week with honest results |
| 6 | 20–24 | `delegation/*`, belt: task web codesearch, `hosts/gateway`, carry-forward, friction and wire logs, Windows `ProcessOwner` and PowerShell shell | Full conformance suite; §9.4 table published; `oruna-serve` on doingbox replaced |

Until phase 2 ships, apply `ORUNA-LEGACY.md` §1 to the live legacy deploy.

---

## 11. Definition of done for the rewrite

- Every test in §3–§7 exists and passes; every incident-named test exists.
- `pytest` under 90 s on the mock; chaos suite under 10 min.
- Benchmark §9.3 all nine criteria pass on the mock.
- §9.4 comparison published with Oruna finishing a task the garrison did
  not, or finishing the same task at a quarter of the input tokens.
- `legacy/` is gone. The repository is under 25k lines including tests.
- `docs/laws.md` hash appears in every system prompt; STOP works in every
  door; the pulse has run unattended for a week.
