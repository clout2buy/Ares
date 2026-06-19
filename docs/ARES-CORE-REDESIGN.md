# Ares Core Redesign — One Loop, One Memory, One Reflection

> Source: multi-agent audit (14 agents, 7 Ares subsystems + 5 Claude Code areas, synthesis +
> adversarial critique), 2026-06-19. Reference architecture: a de-obfuscated Claude Code
> source tree (studied for *shape*, reimplemented Ares-native — see CLAUDE-CODE-PORT-STUDY.md).
> Critic verdict: **go-ahead = true**, with the high-severity fixes below folded in.

---

## 0. The headline (this reverses our assumption)

We thought Ares was "three loops fighting for the wheel." **It isn't.** The audit found:

- **There is already ONE loop.** `packages/core/queryEngine.ts → streamTurn()` is the single
  tool-calling loop, and **every path already funnels into it** — desktop chat (via daemon),
  Telegram (via garrison SessionManager), autonomous ticks (operator dispatcher), and
  subagents (subagents.ts) all call `streamTurn()`. `@ares/core` depends only on
  `@ares/protocol`; it imports none of agent/operator/mind. It's the clean leaf.
- The "other two brains" don't have their own loop engine — they **instantiate fresh
  QueryEngines and drive the same primitive**, each re-implementing iteration policy *above*
  it. So we have **three drivers of one loop**, not three loops.
- The real sprawl is **NOT the loop. It's memory and reflection:**
  - **FOUR memory stores**: `mind/memory` (the good one), `agent/memory` (v4 vector store),
    `operator/worldModel+graph`, and the `Memory.ts` tool's `.ares/memory.md`.
  - **SIX reflection writers**: agent dreaming, agent self/reflect, agent Witness, mind
    consolidate/synthesize, mind conversationReflect, operator learn/crucible.
  - **One Crix chat-assumption** baked into the loop: `streamTurn()` hard-requires a pending
    *user message* (queryEngine.ts:608), so operator/agent fake user turns to drive it.

**So this is not a rewrite. It's a consolidation onto a spine that already exists.** The good
news is bigger than expected: the kernel is sound, multi-provider, crash-safe, and already
CC-shaped. We keep it and collapse everything else onto it.

---

## 1. The single spine

| Layer | Keeper | What changes |
|-------|--------|--------------|
| **Loop** | `core/queryEngine.streamTurn()` | Generalize the "pending user message required" throw (l.608) into a **goal/work-item input**. Add ONE `runForkedTurn` primitive (CC `createSubagentContext`+`runForkedAgent`): subagents, operator workers, Consciousness actions, Telegram missions all **re-enter this loop as forks** instead of running parallel control flow. Every fork inherits the existing guards (watchdog, oscillation/ceiling/stall, identity anchor) for free. |
| **Memory** | `@ares/mind` MemoryStore (`memory.jsonl` + `.vec` sidecar) | The one durable substrate — a true leaf, schema-versioned, crash-safe, already declared source-of-truth. Fold the other three stores in. Layer CC discipline on top: MEMORY.md-as-index, 4-type taxonomy, `contextCompiler` as the relevance selector over headers, mtime freshness. Add `MemoryNode.scope/tenant` **now** for multi-user Telegram. |
| **Reflection** | one gated, read-only, single-flight **fork** | Fired from one post-turn hook (CC `stopHooks` + `autoDream` + `consolidationLock` mtime-lock). Substrate ops = `mind.consolidate()/synthesize()`. Keep **agent Witness** (LLM turn-review + UNSAFE_CMD guard) and **self/reflect** (capability stats) as the two distinct judgment inputs. Delete the rest. |
| **Tool contract** | `@ares/tools/_shared.ts` (`buildTool`/`adaptToolForEngine`/`parseToolInputLenient`/`fileReadStamps`/`safeOverwrite`) | Already CC-shaped. Add the **three missing CC pieces**: (1) two-stage validation (zod `safeParse` → `validateInput` → `<tool_use_error>` envelope **before** `call()`); (2) result **disk-spill** (full output to file + ~2KB preview + path) replacing the lossy 24k truncation; (3) `maxResultSizeChars` on the contract. Add the **microcompact rung** beneath `compactIfNeeded` (cheap no-model tool-body clearing + reserve-output headroom + circuit breaker). |

---

## 2. Module verdicts (condensed)

**KEEP_AS_SPINE** — core (queryEngine/session/providers), sideQuery, tools `_shared`/buildTool,
safeWrite + fileReadStamps, mind store/recall/strength/types, mind contextCompiler, mind
synthesis/consolidate, mind embedIndex, agent identity/context (persona + name anchor), agent
Witness, agent self/store+reflect, agent runtime/persistence, agent paths/files (atomic write),
operator controlLoop, operator backgroundLoop, operator probe, operator goal/store/standingOrders/
attention/control, operator leash (TrustGovernor), operator worldGraph/briefing/continuity/ledger
(read-only views), garrison, effects rails, connectors+ComputerUse, tauri, protocol.

**COLLAPSE_INTO** — subagents.ts → `runForkedTurn`; operator dispatcher → `runForkedTurn`;
agent mission/loop → one mission/goal engine; agent dreaming → reflection fork; agent heartbeat
→ one scheduler; mind missionState/afterAction → unified goal state; mind conversationReflect →
reflection fork (as extractor); operator capability/graphStore/learningCard/seed → mind nodes;
operator crucible/learn/learningEmit → reflection fork; operator missionContract/missionExecution
→ one mission model; cli/entry.ts → split into modules.

**ADAPTER** — modelRouter (make executable as the one selector *incl. failover* — see §5),
Memory.ts tool (→ mind), channels/telegram bridge (I/O transport), Consciousness watcher
(perception source that forks read-only), operator gauntlet/evalHarness (dev-only, out of hot path).

**DELETE** — agent v4 vector store + unifiedRecall + embed; mind cognition/* (dead parallel
"second loop"); mind migrateVectorStore + .crix shims (after a release); operator worldModel.ts
(never instantiated), method.ts, perception.ts (unwired); agent runRemDream; Stripe/Deploy/Email
tools (Crix SaaS-builder leftovers); dead config model slots.

---

## 3. Phased migration (strangler-fig — app keeps running throughout)

> **Critic fixes are folded in.** Five items changed from the raw blueprint — flagged 🔧.

**Phase 0 — Freeze contracts & characterize (no behavior change)**
- Add `MemoryNode.scope/tenant` (default `'owner'`) under the existing forward-compat quarantine.
- Add optional `maxResultSizeChars` + `validateInput` hook to the tool contract / `@ares/protocol`
  ToolSchema (no consumers yet). 🔧 These are **net-new contract fields**, not "centralize existing."
- **Characterization tests** for every load-bearing invariant later phases threaten:
  tool_use↔tool_result pairing, JSONL rollout replay, Anthropic prompt-cache breakpoint placement,
  unifiedRecall output — **plus** 🔧 (a) the silent-degrade `try/catch` around the
  prepareUserTurn/finishTurn fan-out (entry.ts:3947), (b) the UNATTENDED permission-gate behavior,
  (c) read-before-write **fork isolation**, (d) cross-process reflection double-fire.
- Snapshot all on-disk stores so migrations are reversible.

**Phase 1 — Unify loop drivers behind one fork primitive**
- Implement `core/runForkedTurn`: clone the **messages prefix** + child AbortController + no-op
  parent callbacks. 🔧 **fileReadStamps = fresh empty Map per fork — NOT cloned** (matches
  subagents.ts:246; cloning would grant a fork write-before-read on files it never read, breaking
  the data-safety invariant). Add a test asserting a fork can't Edit/Write a file only the parent read.
- Generalize `streamTurn()`'s pending-user-message requirement into a goal/work-item input
  (chat path stays byte-identical as the default).
- Rebuild `subagents.ts` and `operator/dispatcher.ts` on `runForkedTurn`; replace dispatcher's
  regex `defaultEvaluate` with `probe.ts` verification.
- Collapse the **two autonomy drivers** to one `OperatorBackgroundLoop`. 🔧 **Before deleting the
  daemon's inline autotick (entry.ts:3272), assert the surviving loop is constructed with the
  `attended:false` UNATTENDED gate in the daemon context** (the autotick carries its own inlined
  gate at l.3298 — dropping it silently un-gates unattended autonomy). Ship risk-#8 test here, not later.
- 🔧 **Build the cross-process `consolidationLock` HERE** (not Phase 3): daemon *and* garrison both
  run on `~/.ares`, so the migration window itself is exposed to double-writes.

**Phase 2 — Collapse memory to one substrate**
- Run `migrateVectorStore` once at boot (idempotent, provenance-tagged) to fold agent v4 rows into mind.
- Rewrite `unifiedRecallForTurn` as a thin `mind` wrapper; **recall-parity test must pass BEFORE
  deleting** agent vectorStore/recall/embed.
- Make `Memory.ts` an adapter over mind. Fold operator capability-graph/lessons into mind nodes
  (keep seed's tool→capability registry as a read-only planner view).
- Layer CC discipline (MEMORY.md index, 4-type frontmatter, contextCompiler selector, mtime caveats).
- Enforce tenant filtering at recall/write call sites + cross-tenant isolation tests.

**Phase 3 — Collapse reflection to one gated fork**
- One post-turn/sessionEnded reflection hook (runtime.ts) using the Phase-1 lock + CC cheapest-first
  gate (time/session count) + read-only `canUseTool` (memory-dir writes only) + 3-failure breaker.
- Body = `mind.consolidate()/synthesize()` with Witness + self/reflect as judgment inputs.
- Delete runRemDream; reduce dreaming to a thin caller; fold operator crucible/learn/learningEmit in.
- Collapse the four timers (heartbeat/operator scheduler/garrison/autotick) into one Scheduler.

**Phase 4 — Tool contract hardening**
- Centralize two-stage validation in `executeToolUse`: `safeParse` → `validateInput` →
  `<tool_use_error>` **before** `call()`. (Keep `parseToolInputLenient` as the lenient pre-parse.)
- `toolResultStorage` disk-spill (full output + 2KB preview + path), 🔧 **freezing spill decisions
  by `tool_use_id`** so the wire prefix stays byte-stable for the prompt cache. Critical for
  ComputerUse/Consciousness vision dumps. Keep old truncation as initial fallback.
- Microcompact rung beneath `compactIfNeeded` + reserve-output headroom + circuit breaker.

**Phase 5 — Mission/goal unification** 🔧 *(its own phase — NOT a cleanup line item)*
- This is **net-new capability, not a collapse**: agent Mission is LLM-driven (the chat model calls
  the Mission tool turn-by-turn); operator Goal is a deterministic tick with **no planning ability**.
  Operator Goal must **absorb** agent Mission's planning (planMission/nextDirective), not just replace
  it. Keep the live Mission tool surface until the operator path can plan.

**Phase 6 — entry.ts split & dead-code excision** 🔧 *(split is its own phase)*
- Split the 7549-line `cli/entry.ts` composition root (dispatch / daemon / garrison-wiring /
  turn-fan-out), gated on an NDJSON-wire-contract characterization test **and** an assertion that the
  silent-degrade `try/catch` around the fan-out survives.
- Delete confirmed-dead code (worldModel/method/perception, mind cognition, runRemDream,
  Stripe/Deploy/Email, dead config slots) — grep-verify each symbol against entry.ts/garrison/channels
  first. Excise `.crix`/`CRIX_*` shims after a release window. Add the first-class goal/mission UI surface.

---

## 4. Load-bearing invariants (must survive every phase — verbatim)

- **Multi-provider routing + self-healing failover** (`deadProviders` set, entry.ts:3905) — chat stays
  alive when a provider runs out of balance.
- **tool_use↔tool_result pairing** (every pending use → exactly one result, in order; orphans 400 on
  Anthropic; `sanitizeToolPairs` is the net) — must survive every fork/abort/error exit.
- **JSONL session rollout + replay** — all existing sessions encode this way; resume dies if a
  migration stops reading it.
- **Anthropic prompt-cache breakpoint placement** (system + last-tool + rolling) — the cost model;
  forks/spill must keep byte-stable prefixes or token spend silently multiplies.
- **fileReadStamps read-before-write + safeOverwrite backup ledger** — the data-safety gate (a real
  fragment-overwrites-file incident); forks get a **fresh empty** stamp map.
- **UNATTENDED permission gate** (`attended:false`: hard-deny payments/credentials/send-mail/destructive
  shell when nobody's watching) + leash + effects rails — the autonomy-safety boundary.
- **Silent-degrade fan-out** (`try/catch .catch(()=>{})` at entry.ts:3947) — a reflection/brain fork that
  throws must NOT break the chat turn.
- **Consciousness model independence** — it runs no provider/API key; perception must not route through
  the chat provider. The read-only-fork wiring needs a test that the watcher never spins a chat turn itself.
- **agent identity/context** ARES_CORE_SEAL persona + name-drift anchor; **Witness UNSAFE_CMD guard**;
  garrison file-token auth + protocol v1 frames + SessionManager rehydrate; Tauri two-process NDJSON
  spawn contract; Tauri auto-updater + signing keys; mind schema-version quarantine; env knob names
  (ARES_MAX_TOOL_CONCURRENCY, ARES_TOOL_WATCHDOG_MS, etc.).

---

## 5. Crix legacy to excise

The chat-turn as the load-bearing unit (streamTurn requiring a user message); "one streamTurn per USER
MESSAGE" framing; single-owner assumptions (no tenant on MemoryNode/Goal/LearningCard);
conversationReflect's "Ares:/Owner:" transcript shape; intent.ts chat-turn gating (greeting/"wyd"/"lol"
suppression); Memory.ts as a "jot a note" store; Stripe/Deploy/Email SaaS-builder tools; the hard-coded
"Claude Code" OAuth identity block + `claude-fable-5` default leak; `.crix`→`.ares` migration + `CRIX_*`
bridge; "streaming coding-agent harness" help text + chat/coding/research lane taxonomy; operator
`defaultEvaluate` regex verdict (trust-the-chat-reply inside a supposedly reality-first loop); desktop UI
modeling every request as a linear chat transcript with no goal/mission surface.

---

## 6. The five critic fixes (high-signal — do not lose these)

1. **`runForkedTurn` uses a FRESH EMPTY `fileReadStamps`, never a clone** (data-safety; high).
2. **Preserve the UNATTENDED gate** when collapsing the daemon autotick into OperatorBackgroundLoop;
   ship the unattended-can't-execute-destructive test in Phase 1 (high).
3. **Build the cross-process consolidationLock in Phase 1**, not Phase 3 — Phases 1–2 already run two
   memory-writing drivers on one `~/.ares` (medium).
4. **Mission unification is net-new planning capability**, its own phase — operator Goal has no planner
   to inherit agent Mission's behavior (medium).
5. **entry.ts split is its own phase**, gated on the NDJSON contract + silent-degrade `try/catch`
   surviving (medium). Phase 4 validation/spill fields are **net-new**, not "centralize existing" (low).

---

## 7. Recommended first move

**Phase 0 only.** It's pure insurance: a schema field nobody reads yet, two unused contract hooks, the
characterization-test harness, and on-disk snapshots. Zero behavior change, fully reversible, and it
builds the safety net (pairing/replay/cache/recall/gate/fork-isolation tests) that gates every dangerous
step after it. Nothing else should start until those tests are green.

*Audit + blueprint + critique captured 2026-06-19. Raw audit JSON archived in the workflow transcript.*

---

## 8. Inventory corrections (grep-verified — these OVERRIDE §2/§5 where they conflict)

A second fan-out grep-verified every removal target. It **disproved six DELETE calls** — these
are LIVE and must NOT be deleted:

- **`mind/cognition/*` is NOT wholesale dead.** `consider()`/`ConsiderDeps`/`ReasonOption` are
  live (agent `advisory.ts` → `deliberateForTurn` at entry.ts:4436 & 5800, both live turn paths).
  Only `cognition/stream.ts` (ThoughtStream) and `cognition.ts::detectDrives`+`CapabilityGap` are
  dead. Surgical removal only — a blanket `cognition/*` delete breaks the live advisory path.
- **"Dead config model slots" is a NAME-COLLISION TRAP.** `agent/config.ts` slots
  `{reasoner,apply,summarize}` are dead, but `core/providers/ollamaCloud.ts` `DEFAULT_OLLAMA_SLOTS`
  with the *same names* are LIVE (reasoner entry.ts:1055, apply ApplyIntent.ts:50, summarize
  entry.ts:2312 / WebFetch.ts:116). Keep `slots.embed` (live in recall). Only the agent/config ones die.
- **modelRouter `routeModel`/`taskDefaults`/`DEFAULT_PROVIDER_PROFILES` are reachable** via the
  `ares models route` diagnostic. Only `resolveRoute`+`laneForTask` are dead — and even those are
  blocked by §5 (the "make modelRouter executable" decision may revive them).
- **The edit tools are NOT duplicates.** `ApplyIntent` is the only `providerHint:'apply'` path
  (sketch → Ollama APPLY slot; deleting strands ollamaCloud.ts:1127); `FindAndEdit` is N-file regex
  replace with dry-run; `CodeMode` is the only vm-sandboxed JS-over-workspace path. Do NOT collapse
  into Edit/Write. (`CodeMode` flagged to owner as an *optional* cut, not a merge.)
- **Stripe/Deploy/Email are LIVE end-to-end**, not "barrel+tests only" — in `DEFAULT_TOOLS` +
  `policyGate` + operator `seed.ts` capability graph (5-touchpoint blast radius each). If removed,
  seed rows die in the *same* commit. **Owner decision on Email:** collapse into the shipped Gmail
  connector (retiring `RESEND_API_KEY`/`ARES_EMAIL_FROM`) rather than delete, if Ares should still mail.
- **`ANTHROPIC_OAUTH_IDENTITY` ("You are Claude Code…", anthropicAuth.ts:43 → anthropic.ts:118) is a
  HARD UPSTREAM CONTRACT** — must stay byte-identical or the Pro/Max OAuth token is rejected (tested
  ares-anthropic.test.mjs:243,270). This **reverses** the §5 "neutralize the Claude Code identity
  block" item: do NOT touch it at the transport layer. Agent-name correctness is already owned by the
  identity anchor (v44-identity-anchor.test). `claude-fable-5` is the intended flagship alias, not
  residue — only de-duplicate it via the model-catalog single-sourcing step below.
- **`queryEngine.ts:607-608` guard: GENERALIZE, do not delete.** The "a pending foreground item must
  exist" invariant is real; only the chat-only `role==="user"` framing is residue (the runForkedTurn
  ADAPTER replaces it; fork callers at subagents.ts:251 / dispatcher.ts:57 / gauntlet.ts:137 currently
  fake a user turn and must migrate first).

**New prerequisite — P6-UNIFY-1 (must precede the CRIX_HOME removal):** there are TWO `aresHome()`
implementations. `mind/paths.ts:29` honors `ARES_HOME`+`CRIX_HOME`+migration; `core/providers/openaiAuth.ts:56`
reads ONLY `ARES_HOME` (no bridge, no migration) and is imported by startupContext/credentials/anthropicAuth
— so auth/credentials/startup paths already silently bypass the bridge. Consolidate onto one resolver
first. **Constraint:** `@ares/core` depends only on `@ares/protocol` (zero core↔mind imports), so the
fix is either a verified-acyclic new core→mind dep or a thin local delegating wrapper — not a re-export.

**Phase-0-safe excisions available NOW** (no release window, no core dep): delete the spent
`scripts/rename-root-to-ares.ps1` (references the gone `D:\Crix`); rebrand/retire `docs/roadmap/NEXT.md`.
Everything else is Phase 6, gated.

---

## 9. Front-end unification (the "terminal feels old, make both identical" workstream)

**Root cause:** there is **no shared command registry in core.** The terminal and desktop command
vocabularies are *fully disjoint* — the CLI has ~25 slash-commands + ~20 subcommands; the desktop has
**zero** slash-commands and remaps a subset to GUI panels, omitting the rest. Plus two non-overlapping
theme namespaces, **three** REPLs (Ink TUI, a legacy readline loop behind `ARES_LEGACY_TUI`, the
WebView), per-surface model catalogs, and a per-package version/identity. The terminal still
self-describes as **"ares v0.9.1 — streaming coding-agent harness"** (the old Crix coding-tool identity,
version-skewed vs desktop 0.10.2); `ares.ps1` is the "old as fuck" build-on-every-launch dev deck that
only offers GPT-OAuth + Ollama. The desktop carries the god-of-war agent identity; the terminal never got it.

**Unification plan (order matters):**
1. **ONE command/intent registry in core** `{id, description, args, handler→daemon command}` covering
   plan/code/danger/model/models/routing/reasoning/resume/workspace/undo/checkpoints/sessions/world/
   today/recap/forge/missions/consciousness/theme/settings. Ink TUI `handleCommand` and the desktop
   composer/palette both render+dispatch FROM it → vocabularies identical by construction. **Lands FIRST.**
2. Desktop composer parses leading-`/` through that registry; terminal gains `/forge`, `/missions`,
   `/watch` driving the daemon commands the desktop already uses. (blockedBy #1)
3. Promote the daemon to the single capability backplane: add daemon read-model commands for the
   CLI-only navigator views (world/today/recap), agent dream/snapshot/restore, mind crucible/consolidate,
   eval. Both surfaces call these instead of re-implementing. (gates desktop showing them)
4. Unify steer: add `onSteer` to Ink so the terminal sends the daemon `steer` command mid-turn like the desktop.
5. **ONE theme token set** keyed by the god-of-war names (rage/bronze/crimson/steel/nightfall/verdant),
   default `rage` on both; generate the Ink colors from it; retire the terminal cyberpunk/matrix/amber set.
   (independent — parallelizable)
6. Single-source the provider/model catalog + the **one agent default** (kill the `qwen3-coder` coding-tool
   default leak in App.tsx; single-source the `claude-fable-5` alias across entry/inkLauncher/App). One catalog feeds all surfaces.
7. **ONE identity + version**: replace "streaming coding-agent harness" with the mission-agent framing;
   source the version from one workspace version so CLI/desktop/release never skew. (3 tests assert the
   tagline substring — update in lockstep)
8. ONE permission-policy contract in core (the attended auto-approve gate is daemon-only; plan/code/danger
   prompting is CLI-only — define the posture once, surface-specific prompting on top).
9. Retire the redundant terminal front-ends (Phase 6, after the registry lands, gated on the NDJSON
   characterization test): delete the legacy readline loop (after porting its unique /world //today //recap
   into Ink via the registry), drop `ARES_LEGACY_TUI`, demote `ares.ps1`/`ares.bat` to a thin
   `ares launcher` shim (or regenerate its provider list from the core registry).

Outcome: type `/plan` or open the Forge from *either* surface; same themes, same models, same identity,
same version, same permission posture — both thin clients of the one core. The terminal finally looks and
behaves like Ares, not like the old coding harness.

---

## 10. Execution log (branch `feat/core-consolidation`)

**Phase 0 — COMPLETE.**
- Contract fields (inert): `ToolSchema.maxResultSizeChars` (protocol), `Tool.validateInput` hook +
  `ToolInputValidation` type + `ToolDef` plumbing (tools/_shared), `MemoryNode.scope` (mind). Typecheck clean.
- Characterization harness — `tests/c0-consolidation-invariants.test.mjs`: normal-path tool_use↔tool_result
  pairing+ordering under out-of-order parallel completion, mixed success/error pairing, orphan-set equality.
  Coverage map (rest already pinned): fork-isolation→`v24`, UNATTENDED gate→`v16`, cache-breakpoints +
  orphan-sanitization + OAuth contract→`ares-anthropic`, JSONL replay + compaction→`m0`/`v14`.
- First excision: deleted spent `scripts/rename-root-to-ares.ps1` (zero callers, D:\Crix gone).

**Coding-win #0 — validation gate: LANDED.** `adaptToolForEngine` now runs two stages before a tool
executes — stage 1 lenient zod `safeParse`, stage 2 optional `validateInput` — surfacing malformed or
semantically-invalid model input as a correctable `<tool_use_error>` envelope and short-circuiting before
permission/exec. `tests/c0-validation-gate.test.mjs`. This is the core "tool calls fail / bad at editing"
fix; tool-specific `validateInput` impls (Edit/Write etc.) build on it next.

**Coding-win #0b — Edit/Write hardening: LANDED.** All model-facing editing errors now route through the
`<tool_use_error>` envelope (the `adaptToolForEngine` policy-deny path + Edit's not-found/not-unique/stale
throws + Write's read-first/stale throws). `Edit` gained a `validateInput` catching an empty `old_string`
early (the first real tool to use the Phase-0 hook). `tests/c0-validation-gate` extended with the live-Edit case.

**Suite:** 766 tests, 764 pass, 1 pre-existing holotable red (owner WIP, unrelated), 1 skip. No regressions.
**Committed:** `7a0dfbaa` on `feat/core-consolidation` — 10 files (mine only); owner WIP left unstaged.

**Coding-win #1 — result disk-spill: LANDED.** `queryEngine.capToolResultText` spills over-budget tool
output to `<workspace>/.ares/tool-results/<session>/<id>.txt` and hands the model a head preview + the
re-readable path, instead of the old silent truncate-and-lose. Per-tool budget via `maxResultSizeChars`
(0 = uncapped for self-bounding tools); computed once → cache-stable. `tests/c1-result-spill`.

**Coding-win #2 — microcompact rung: LANDED.** `queryEngine.microcompactIfNeeded` runs before the heavy
summarizer: past ~60% of the compaction threshold it clears OLD compactable tool_result bodies (keeps the
last 6) in place with NO model call, preserving all reasoning/user messages — so heavy compaction fires far
later. `tests/c1-microcompact`.

**Suite:** 770 tests, 768 pass, 1 pre-existing holotable red, 1 skip. No regressions (v14-compaction/m0 green).
**Caveat:** these live in `queryEngine.ts`, which already carried owner WIP — so this batch is NOT yet
committed (can't hunk-split owner WIP from my changes in one file). Test files + this doc are clean.

**Phase 1 (loop unification) — CORE LANDED.** The structural "three drivers → one primitive" change:
- New core primitive `runForkedTurn` (`packages/core/src/forkedTurn.ts`): the ONE way to spawn a child run
  of the loop. Centralizes the two fork invariants — a FRESH empty `fileReadStamps` (the option type omits
  it so a call site *cannot* break isolation; critic fix #1) and a tagged work-item seed (not a faked chat
  turn). Child inherits every guard (watchdog/oscillation/ceiling/stall/identity-anchor/microcompact/spill).
- New engine seed `appendWorkItem` — a trailing user-role message tagged `metadata.source="work-item"`, so
  chat-only consumers can tell autonomous work from a real user turn (the one Crix entry-assumption, generalized).
- Collapsed BOTH duplicate drivers onto it: `subagents.ts` (AresSubagentRunner) and `operator/dispatcher.ts`
  (QueryEngineDispatcher) no longer hand-roll `new QueryEngine + appendUserMessage + streamTurn` — they call
  `runForkedTurn`. Behavior preserved (v24/v25/v31 green); read-stamp isolation now centralized, not copy-pasted.
- `tests/c2-forked-turn`: work-item tagging, per-fork stamp isolation, result propagation.

**Suite:** 773 tests, 771 pass, 1 pre-existing holotable red, 1 skip. Typecheck clean across all packages.
**Still uncommitted** (same blocker): the engine pieces live in `queryEngine.ts`, which carries owner WIP.
The clean new files (forkedTurn/subagents/dispatcher/index/tests/doc) depend on `appendWorkItem` in that
file, so they can't be committed atomically without it.

**Next:** migrate the remaining loop drivers (Consciousness actions, Telegram missions) onto `runForkedTurn`;
then the shared command/intent registry — the front-end unification that makes terminal + desktop identical (§9).
