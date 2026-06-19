# Ares Mega-Build — Design Specs (workflow wy6fc7wef, 2026-06-17)

## 1. Smart Memory + Reflection

Design a three-tier token-management system that replaces Ares's current "dump history" approach with durable, compacted memory. (1) Context-compaction policy: smart summaries + deterministic ledger in queryEngine (already exist); enhance to inject compact memory packets at turn start instead of raw history. (2) After-action reflection: at session end, extract durable facts (wins, failures, lessons, decisions) and write them to MemoryStore with dedup via synthesis/consolidation. (3) Cheap recall: blend living-memory recall (semantic/procedural only, not episodic replay) with context compiler's tier-budgeting to inject only high-signal fragments under a tight token cap. Wire into daemon via lifecycle hooks that debrief each session and feed distilled memory to the next one.

### File changes
**D:/Ares/packages/core/src/queryEngine.ts**
- Add interface MemoryInjectConfig to cfg (optional recall cue, living memory file, context budget)
- NEW: injectMemoryPacket() method that calls recall at turn start, compiles fragments via contextCompiler, and injects as system_reminder before budgetMessages runs
- Call injectMemoryPacket() inside streamTurn() BEFORE the first provider.stream() so compact memory reaches the model before history trimming
- Track injected memory ids in turn state so turn_end event carries them (for consequence wiring at session end)

**D:/Ares/packages/core/src/session.ts**
- Extend SessionOptions with memoryInjectConfig (optional) and afterActionFacts (optional RunFacts)
- Add memoryInjectionDetails field to Session to capture what was recalled this session
- NEW: session.reflectOnEnd() method that calls reflectOnRun (from @ares/mind) with facts from the session + tool-usage summary
- Call reflectOnEnd() in streamAndPersist() cleanup, after turn_end but before generator closes, to durably record what happened

**D:/Ares/packages/mind/src/memory/afterAction.ts**
- ADD new export reflectOnRunWithMemory(facts, memoryStore) that: (1) builds AfterActionRecord via summarizeRun, (2) extracts durable facts (wins, blockers, decisions), (3) writes episodic + semantic entries to MemoryStore with synthesis tags, (4) folds record into ProjectState.recentWins/risks/nextActions, (5) returns { record, project, memoryIds } for consequence wiring
- No changes to existing summarizeRun/reflectOnRun — add this as an export alongside them

**D:/Ares/packages/mind/src/memory/store.ts**
- ADD deduplicateBeforeAdd(content, kind) that: searches consolidate() output for semantic nodes matching content (title-level match), returns existing id if found (no write)
- NO changes to remember/consolidate/synthesize — dedup is an optional pre-filter in the caller

**D:/Ares/packages/cli/src/entry.ts**
- When creating a LiveSession, open the memory store and compile a MemoryInjectConfig
- Pass the config into Session options so queryEngine sees it
- Capture afterActionFacts from session history (turn counts, tool usage, touched files, commit summary if available)
- Call session.reflectOnEnd() when the session finishes, persist the result, and log the memory ids written
- Add command `ares memory inject --session <id>` to manually test memory injection from a stored session

**D:/Ares/packages/cli/src/terminalUi.ts**
- NEW: renderMemoryInjection(packet: ContextPacket) to show the memory packet being injected (optional debug line)
- Show injected memory ids at session end so the user knows what was remembered

**D:/Ares/packages/agent/src/memory/unifiedRecall.ts**
- NO changes — this is already correct (filters to semantic/procedural, dedup by content, builds reminder block)

**D:/Ares/packages/mind/src/memory/contextCompiler.ts**
- NO changes — this module is already a perfect fit (tier-budgeting, rendering, dropping by project)

### New files
- `D:/Ares/packages/core/src/memoryInject.ts` — Unified memory injection logic: fetch memory via recall, compile under budget, render as compact packet, inject as system_reminder before model sees history. Reusable by queryEngine + daemon workers.
- `D:/Ares/packages/mind/src/memory/sessionDebrief.ts` — Session-end debriefing: extract run facts from turn events (tool calls, errors, commits, files touched), fold into AfterActionRecord, synthesize into durable memory nodes, and return consequence-wiring ids. Pure, testable.
- `D:/Ares/packages/core/src/turnMemoryBridge.ts` — Carry memory injection metadata through a turn: recall cue, injected ids, memory packet text. Attached to queryEngine state so turn_end event can surface it for wiring and log output.

### Risks
- Memory injection adds latency to turn start (recall + compile + render) — mitigate with timeouts (300ms for embedder, 500ms for compilation total). Graceful fallback to pure history compaction if memory unavailable.
- Semantic dedup (title-level match) may miss close-but-not-identical facts — mitigation: synthesis idempotency tags already prevent major dupes; occasional duplicates cause re-reinforce, acceptable cost.
- After-action reflection must not block session end — run it async, log errors but never re-raise. Session ends successfully even if memory write fails.
- First session (no prior memory) will have empty recall — expected, not a regression. Recall grows over time as sessions debrief.
- Context compiler's tier-budgeting assumes fragments are pre-vetted (no episodic replay) — unifiedRecallForTurn already enforces this, but document the contract.

### Test plan
- Unit test contextCompiler with various tier budgets, cross-project fragments, and edge cases (budget 0, all ineligible, exact fit).
- Unit test sessionDebrief with mock turn events: verify it extracts tool calls, errors, touched files; handles missing commits gracefully.
- Unit test reflectOnRunWithMemory: verify it synthesizes episodic + semantic entries, dedupes against existing, returns ids, doesn't throw on memory unavailable.
- Integration: run a 3-turn session locally, inspect .ares/memory.jsonl after reflectOnEnd() to verify entries were written with correct tags/links.
- Integration: resume a session after reflection, verify memory injection at turn start shows semantic nodes from prior session, NOT episodic replay.
- Perf: measure memory injection latency (recall + compile + render) in realistic scenarios (100+ nodes in memory, various recall patterns); ensure sub-500ms p95.
- Daemon integration: run daemon with a goal that spans 2+ sessions, verify after-action records are written each session, memory grows over time, and each new session injects improved context.
- CLI test: `ares memory inject --session <id>` retrieves a stored session and shows what memory would be injected (dev/debug command).

## 2. Autonomy / Standing Orders

A durable, scheduler-agnostic standing-orders system allows the owner to queue recurring/durable missions that the background loop executes unattended during idle ticks. Standing orders live as JSON files alongside goals (~/.ares/operator/standingOrders/), register with an index for efficient retrieval, and are picked up by the loop's attention logic before it falls back to nextActions suggestions. Each execution spawns a fresh goal, records progress to the operator ledger, and reports via Telegram. The system reuses existing pieces: Goal + control loop for execution, the unattended policy gate for safety, and the Telegram reporter for visibility.

### File changes
**packages/operator/src/standingOrder.ts**
- New file: Standing order model, lifecycle (active/paused/archived), schedule metadata (hourly/daily/weekly/cron), and creation functions
- Export types: StandingOrder, StandingOrderStatus, StandingOrderSchedule, StandingOrderRecurrence
- Export functions: createStandingOrder(), pauseStandingOrder(), resumeStandingOrder(), archiveStandingOrder(), isEligibleToRun()

**packages/operator/src/standingOrderStore.ts**
- New file: Persistence layer for standing orders (~/.ares/operator/standingOrders/*.json), mirrors goal storage pattern
- Export: newStandingOrderId(), saveStandingOrder(), loadStandingOrder(), listStandingOrders(), listActive(), nextDueOrders()
- recordExecution() to update lastRunAt + runLog for wear tracking

**packages/operator/src/index.ts**
- Export all standing-order functions alongside goal/store exports
- Add to exports: createStandingOrder, pauseStandingOrder, resumeStandingOrder, archiveStandingOrder, isEligibleToRun
- Add to exports: newStandingOrderId, saveStandingOrder, loadStandingOrder, listStandingOrders, listActive, nextDueOrders, recordExecution

**packages/operator/src/backgroundLoop.ts**
- Update OperatorBackgroundLoopOptions: add standingOrdersDir?: string for constructor pass-through
- tickOnce() loop: after activeGoals fetch, check nextDueOrders() BEFORE falling back to nextActions
- If standing order due: spawn fresh Goal via createGoalFromStandingOrder(), run it via dispatcher, recordExecution() on completion
- Emit new event type: operator_standing_order_start (order id, goal id) and operator_standing_order_complete (goal id, result)

**packages/operator/src/attention.ts**
- attentionItemsFromStandingOrders(): factory to convert due standing orders into AttentionItem[] (kind: 'standing_order', priority based on age/backlog)
- decideAttention(): fold standing orders into the ranking alongside goals/capabilities (they are HIGH priority if overdue)

**packages/operator/src/paths.ts**
- OperatorPaths interface: add standingOrdersDir: string
- operatorPaths(): initialize standingOrdersDir = path.join(operatorDir, 'standingOrders')

**packages/cli/src/entry.ts**
- Wire standingOrdersDir into OperatorBackgroundLoop constructor options
- Add daemon commands: /standing-order add, /standing-order list, /standing-order pause, /standing-order resume, /standing-order delete
- Add entry.ts command: ares operator standing [add|list|pause|resume|cancel]
- Telegram command handler: respond to /standing_mission add/list/pause/resume/cancel with inline keyboards for standing order mgmt

**packages/channels/src/telegram/operatorReport.ts**
- OperatorEventLike interface: add 'operator_standing_order_start' | 'operator_standing_order_complete' event types
- formatOperatorReport(): add cases for standing-order start/complete with order name, goal reference, and result summary
- Include standing order execution in war-map briefing (recent runs, next due)

**packages/channels/src/telegram/commands.ts**
- TelegramCommandKind: add 'standing_mission_add' | 'standing_mission_list' | 'standing_mission_pause' | 'standing_mission_resume' | 'standing_mission_cancel'
- handleTelegramCommand(): route /standing_mission_* commands to standing-order handlers
- Render standing order list with inline keyboard (pause/resume/delete buttons per order)

### New files
- `packages/operator/src/standingOrder.ts` — Standing order domain model: definition, status lifecycle, schedule metadata, and creation factories
- `packages/operator/src/standingOrderStore.ts` — Durable storage and retrieval for standing orders; mirrors goal persistence pattern
- `packages/operator/src/standingOrderAttention.ts` — Convert due standing orders into attention items and rank them against active goals

## 3. HELM UI — winner: Spartan Oracle — The Scrying Basin of Ares

### Synthesis
BUILD: "The Scrying Basin of Ares" (Spartan Oracle) as the HELM, with three grafts from the runners-up. Ground truth verified against the codebase: three@0.184 and framer-motion@12 are ALREADY in tauri/package.json and three.js already renders in this WebView (the holotable/MECH_SPEC Forge), so the molten-pool shader is de-risked. Data is real and present in App.tsx state: daemon: DaemonState, opStatus:{activeCount, goals:[{id,statement,status,progress}], autotick}, usageStats (with .daily[]), keyStatus: Record<string,boolean>; the room already exposes the .ares[data-working='1'] driver attribute and the daemon pill's data-state — bind to THOSE, add no new wiring.

STRUCTURE — render the HELM as a new view inside .stage (a `.helm-root` that reuses grid-area: stage), NOT a new top-level region, so .backdrop/.embers/.workGlow/.ares::after stay live underneath and the existing rage-veil already covers it. 12x12 CSS grid, three concentric zones exactly as the Oracle spec: (1) THE OMPHALOS — 420px molten scrying basin dead-center (cols 5-8/rows 4-9), the signature surface; (2) THE INNER RING — six trapezoidal augury slates radial at 60deg steps, 4deg inward skew (Omen of War=missions, Pythia's Plan=live activity+todos, Entrails of Cost=usage, Auguries Connected=services, Stelae context); (3) THE OUTER WALL — Lintel ticker (top), Stelae of Memory (left), Favor Gauge (right), Omen Ledger frieze (bottom). Narrow-width collapse: ring → single vertical scroll, pool pinned top.

GRAFT 1 (from War Table) — SINGLE-DRIVER STATE. Adopt the `--heat` (0..1) custom property as the ONE numeric driver, written once on .helm-root from daemon+busy state, and let every molten thing (pool temperature, gauge mercury, oracle-bone fill, slate rim-light) read it via color-mix()/opacity. This replaces ad-hoc per-panel state with one interpolation point and makes the whole room re-theme + cool/heat in lockstep. Also graft the POINTER-PARALLAX: pointermove → --tilt-x/--tilt-y (±2.5deg) on the slate ring + a subtle pool-light shift, smoothed by transition, so the temple has the War Table's "lean over a real surface" depth — but keep the Oracle's flat radial layout (do NOT adopt the rotateX(14deg) global rake; it crushes slate legibility/hit-targets — that was the War Table's main feasibility cost).

GRAFT 2 (from Living Forge) — ACTION-AS-HEARTBEAT. The Oracle's omen-strike on tool_start is good but passive; graft the Forge's hammer rhythm reframed for the temple: on every tool_start the basin STIRS — a hard ripple impulse spikes the shader noise-amplitude uniform for ~160ms, the center PointLight flares, a concentric SVG shockwave ring expands (r:0→max, opacity 1→0), and the existing @keyframes shake fires scoped to .helm-root (3px). Sustained work becomes a visible cadence of stirs, exactly like the forge's beat, so the user FEELS each action, not just sees a glow.

GRAFT 3 (from Living Forge) — `--draft` AMBIENT GATE + color-mix HEAT RAMP. Add a room-wide `--draft` (0..1) written from daemon state (running=1, starting=0.5 pulsing, stopped/error=0) that multiplies ember opacity and animation-speed across .embers/.depthField, so daemon health drives ambient aliveness with one signal (the Forge's cleanest idea). For all molten fills use the Forge's explicit color-mix(in oklch, …) heat ramp white-hot(--ember-hi)→hot(--ember)→work(--accent)→blood(--blood)→done(--steel), keyed off --heat/progress — this is more controllable than raw gradient stops.

SIGNATURE MOMENT (keep the Oracle's, it scored highest): THE ORACLE SPEAKS on turn_end-with-result / mission→completed — (1) embers reverse and converge on the pool ~300ms; (2) basin surges into a standing bronze dome, center PointLight flares white-hot casting hard caustics across all six slates; (3) result text rises OUT of the pool as carved bronze letters etching mid-air (drawOn) with the verdict glyph (steel ✓ / crimson ✕) stamping; (4) dome collapses to glassy swells, one deep shake punctuates. Orchestrated by a framer-motion timeline + a three.js uniform spike + the existing shake/ember CSS.

CSS LAW (all three agreed, enforce it): ZERO new color values — prophetic glow=--accent/--accent-hi via --accent-rgb alphas (re-themes across all six warbands), success/favorable=--steel, ill-omen/failure=--crimson, molten=--ember/--ember-hi/--blood, surfaces=--panel/--panel-2 with --line/--line-strong rune-borders, temple relief=--god-uri at low opacity. Gate all particles/shake/shader-boil behind prefers-reduced-motion (the system already nukes animation there). WebGL fallback for the pool: pure-SVG feTurbulence+feDisplacementMap + radial gradient + spin360 rings if the WebGL context fails — never a blank center.

### Animation language
A reusable, app-wide God-of-War motion vocabulary. Each named effect has ONE canonical technique so every surface (HELM, chat, rail, Forge) feels alive the same way. All gated behind prefers-reduced-motion (the system already disables animation/transition globally there).

RUNE IGNITION — an outline etches then fills. SVG stroke-only path with stroke-dasharray=path-length, animate stroke-dashoffset→0 via the existing @keyframes drawOn, then flip fill via a 200ms CSS color transition. Use for: live activity inscription (Pythia's Plan), todo runes flipping in_progress→done, memory stelae etching. Single shared keyframe, per-glyph animation-delay for the chisel-by-chisel read.

EMBER DRIFT — ambient rising sparks, depth via parallax layers. Reuse the existing .embers + .embers::after + .depthField (radial-gradient sprites animated by @keyframes emberRise at differing durations). Density + speed multiplied by the new --draft var (daemon-gated) and --working. This is the room's resting heartbeat.

BLADE SWEEP (specular glint) — a hot highlight band travels across metal. Background-image linear-gradient highlight, animated background-position via the existing @keyframes forgeSweep / shimmer. Use for: rune-blade/oracle-bone edges, the .primary button shine (already present), gauge mercury surface. Pure CSS, GPU-cheap.

MOLTEN-BRONZE FILL — a value fills with cooling metal. clip-path: inset() (or an animated gradient-stop / clipped rect height) transitioned over 600ms with chartGrow easing; color via the color-mix heat ramp (--ember-hi→--ember→--accent→--blood→--steel) keyed off --heat/progress. Use for: oracle-bone mission progress, Favor gauge mercury, Blood/Entrails ledger fills. The mercury gets a wobbling SVG meniscus.

SCREEN-SHAKE ON ACTION (the omen-strike / scrying-stir) — every tool_start: fire the existing @keyframes shake (3px, ~140ms) SCOPED to .helm-root (never document-wide), + an expanding concentric SVG shockwave ring (r:0→max, stroke-opacity 0.6→0, ~560ms via framer-motion AnimatePresence), + on WebGL a one-shot noise-amplitude uniform spike on the pool and a PointLight intensity flare. This is the felt 'the god acts' beat.

PARALLAX DEPTH — the room reacts to the cursor. pointermove → CSS vars --tilt-x/--tilt-y (clamped ±2.5deg) on the slate-ring wrapper + a small pool-light offset, smoothed by a transition on transform. Cheap, no per-frame React renders (write vars directly to the node). Optional idle micro-orbit reusing spin360 on the astrolabe lip.

MOLTEN-POOL BOIL (the Omphalos core) — three.js displacement-mapped plane, custom fragment shader mixing --blood→--ember-hi by radius + fresnel rim, driven by a 0.2Hz simplex-noise uniform; a real PointLight at center casts caustics on the slates. Idle=glassy 0.2Hz swells; --working ramps noise amplitude+frequency and PointLight pulse (rageBreath cadence). SVG fallback (feTurbulence+feDisplacementMap + radialGradient + spin360 rings) when WebGL is unavailable — same for SERVICE VOTIVE FLAMES (feTurbulence/feDisplacementMap flicker).

GLYPH ETCHING (chisel-strike) — a one-shot 'something was written/remembered' punch: localized scoped shake on the target element + 3–8 particle chips (framer-motion gravity tween, or SVG <circle>s via WAAPI cx/cy+opacity) bursting outward, then the new line flashes --ember-hi and cools to --faint/--bronze over ~1.4s via color transition. Use for: durable-fact write (stelae), recent-win tablet stamp (Omen Ledger), service connect/disconnect (flame light/snuff with crimson smoke puff).

STATE-CRUST (death/error) — the cold inversion: an SVG <mask> crust of dark polygons grows inward from the rim (animated mask/clip-path), crimson cracks glowing in seams; the whole HELM desaturates via a CSS filter transition; votive flames snuff to grey; --draft→0 so embers nearly stop. Reuses/inverts the existing .ares::after rage-veil into a 'dying coals' tint. Recovery reverses (crust melts back, ring re-lights from center out). Use for daemon stopped/error anywhere in the app.

PANEL ENTRANCE (forge-in) — each panel arrives like metal set from the fire: a white-hot flash cooling to its resting tone (color-mix transition) + the existing @keyframes fadeUp/forgeIn, staggered ~80ms. Use for all HELM zone mounts and chat turn entrances (chat already uses fadeUp — unify on this).

GLOBAL DRIVERS (write once, read everywhere): --heat (0..1, molten temperature), --draft (0..1, daemon-gated ambient ember intensity/speed), plus the existing .ares[data-working='1'] and daemon pill data-state. Every effect above reads these rather than holding its own state, so the entire app heats, cools, boils, and dies in lockstep from a tiny number of signals.
