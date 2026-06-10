# ARES — The Rebirth (Crix → Ares: the battle-tested agent)

This is the executable spec for the full rebrand and architectural rebirth. Crix becomes **Ares** — named for the Greek god of war. The positioning writes itself against the field: *Hermes is the messenger god — an agent that talks everywhere. Ares is the war god — the agent whose every skill is battle-tested.*

The lineage:
- **v3** gave Crix a **body** — parallel tools, LSP, checkpoints, diffs.
- **v4** gave the body a **mind** — identity, memory, heartbeat, dreaming.
- **v5** gave the mind a **will** — durable goals, effects rails, capability graph.
- **v6–v9** deepened the mind — living memory, cognition, approvals, synthesis.
- **ARES (this doc)** gives the whole entity three things it has never had:
  1. **Continuity** — it stops being a process you visit and becomes a daemon that is always alive.
  2. **Empiricism** — the Crucible loop: everything it learns is a hypothesis that must survive contact with reality.
  3. **A face** — the desktop app becomes the primary surface, with an ancient-bronze war-room design language (faint god-statue backdrop, the way the Hermes app wears its namesake).

Read this entire file before writing a line. Ship **V0–V10 in order**, tests-first, `pnpm verify` green before every commit, per-task commit format `Vn: <short title>`. Add `tests/ares-<short>.test.mjs` per task.

---

## The one-sentence north star

> **Ares is the battle-tested agent: every skill it earns, every belief it holds, and every liberty it takes must carry evidence — a win-loss record earned against reality, not a vibe written down once and trusted forever.**

The v5 law still binds: competence and trust must climb together. ARES adds the third curve that makes the first two honest: **evidence**. No competence claim without a record. No trust grant without proof.

---

## Why this rebirth — what the field taught us

Read alongside Hermes-Agent and OpenClaw, three structural truths emerged:

1. **The references are gateways; Crix is a CLI process.** Hermes and OpenClaw are always-on control planes with clients attached (desktop, Telegram, WhatsApp, voice). Crix's heartbeat, dreaming, and operator loop all die when the terminal closes. The "living entity" architecture has been spiritually correct and physically impossible since v4. **The daemon is not a feature; it is the precondition for everything v4–v9 promised.**
2. **There is no intelligence in our learning loop.** Hermes forks the full agent after every turn to decide what to learn ("a pass that does nothing is a missed learning opportunity"). OpenClaw flushes memory through the model before compaction. Crix extracts session signals with *regexes* and classifies intent with *patterns overfit to the owner's texting style*. The most sophisticated memory dynamics in the field, fed by the dumbest capture in the field.
3. **Nobody verifies what they learn — and we own the machinery to.** Hermes saves a skill if a fork thinks it's good. OpenClaw promotes on frequency thresholds. Every reference can confidently learn something false and never find out. Ares has reality probes, fingerprints, an effects ledger, an eval harness, and a trust leash. Pointing the verification religion at the learning loop is the move nobody else can copy cheaply. **That is the moat.**

The deterministic-spine instinct stays. The rule going forward:
> **Deterministic spine. LLM judgment. Deterministic verification.**
Control flow and safety never ask a model. Judgment (what to learn, what's relevant, what a session meant) never trusts a regex. Truth (did it work) never trusts the model's say-so.

---

## Identity & naming

- **Name:** Ares. **Tagline:** *the battle-tested agent — it proves what it learns.*
- **Vocabulary (used sparingly — in UI surface names, never in code identifiers beyond these):**
  - **The Garrison** — the daemon (`aresd`). Always standing watch.
  - **The Crucible** — the learning loop (Witness → hypothesis → consequence → trial).
  - **The Gate** — the approval surface (subsumes the Containment Core panel).
  - Everything else keeps boring engineering names. Lore is seasoning, not structure.
- **Packages:** `@crix/*` → `@ares/*`. Bin: `ares` (+ `aresd`). Home: `~/.ares`.
- **Palette:** bronze-on-obsidian — near-black `#121013`, panel `#1b1715`, bronze `#c79a4e`, polished bronze `#e3b86a` (active/streaming), dim text `#8a7d6b`, bright text `#e9dfd0`, success = tempered steel `#7fa6a3`, danger = war crimson `#b03a3a`. One warm monochrome plus two semantic colors. No other accents anywhere.
- **Imagery:** faint ancient iconography in the app background — a bronze-relief / marble-fresco Ares (helm, spear) at very low opacity behind the conversation pane, the Hermes-app move with our god. Decorative only, never competing with content; one asset, not a gallery.

---

## Architecture after ARES

```
aresd (the Garrison — always-on daemon)
├── entity runtime      identity, living memory, self-model      (from @ares/agent, /mind)
├── session manager     N concurrent QueryEngine sessions        (from @ares/core)
├── operator loop       goals, ticks, probes — runs continuously (from @ares/operator)
├── crucible            witness forks, consequence ledger, trials (NEW)
├── effects + Gate      rails, ledger, kill switch, approval queue (from @ares/effects)
├── scheduler           heartbeat, dreams, curator — cron, real   (from @ares/agent)
└── gateway API         WebSocket + HTTP on localhost, token-auth (NEW)

clients (all thin — render events, send intents, hold zero entity state)
├── desktop (Tauri)     PRIMARY face — sessions inbox, Gate, telemetry
├── cli                 `ares chat` — attaches to a daemon session
└── channels (later)    Telegram/Discord bridge = just another client
```

**What gets deleted (the honest kill list):**
- `packages/cli/src/entry.ts` (4,280 lines) — dissolves into daemon composition + thin client.
- Regex cognition: `mind/cognition/intent.ts` capture/classify paths, `extractSessionSignals`, heuristic salience — replaced by Witness calls (V5). The *deterministic* fast-paths (low-signal greeting skip) may stay as a pre-filter only.
- `agent/memory/vectorStore.ts` as a separate substrate — embeddings move inside living memory (V4); the v4 store becomes a migration source, then dies.

**What ports untouched (~80%):** queryEngine, providers, tools, effects rails, operator spine, living-memory store/strength/consolidation, mission/self/skills runtimes, the test suite.

---

## Phases

### V0 — Rebrand mechanics
**WHY:** Identity first so every new file is born with the right name; mechanical, zero-risk, reversible.
**WHAT:** Rename scope `@crix/*` → `@ares/*`; bins `crix`/`crix.bat`/`crix.ps1` → `ares*` (+ `aresd` stub); durable home resolves `~/.ares`, with one-time copy-migration from `~/.crix` (never move/delete the original — leave a `MIGRATED.md` breadcrumb); env prefix `CRIX_` → `ARES_` with legacy fallback reads; README/docs/ARCHITECTURE rewritten under the new identity.
**TEST:** `ares-rebrand.test.mjs` — home migration is copy-not-move, idempotent, and a fresh home needs no `~/.crix`; legacy env vars still honored.
**GOTCHAS:** pnpm workspace protocol references; Tauri `productName`/identifier; the launcher bats hardcode paths. Grep for `crix` case-insensitively at the end — the encyclopedia HTML and NOTICE will surface; rename deliberately, not blindly.

### V1 — The Garrison (daemon + gateway API)
**WHY:** Continuity. Heartbeat, dreams, and the operator loop become real because something is awake to run them.
**WHAT:** New package `@ares/garrison`: a single long-lived process owning the entity runtime, a session manager (spawn/attach/list/kill QueryEngine sessions), the scheduler (heartbeat/dream/curator intervals — replace `setInterval`-in-CLI with daemon cron), and a localhost WebSocket+HTTP gateway (token auth from a file in `~/.ares`, loopback-only by default). Every TurnEvent streams over the socket; every client intent (send message, approve effect, change reasoning level) arrives through it. Windows: ship as tray-managed background process started by the desktop app or `aresd start`; auto-start optional via registry run key.
**TEST:** `ares-garrison.test.mjs` — boot daemon on a random port, attach two clients to one session, both receive identical event streams; kill a client, session survives; scheduler fires a heartbeat tick with no client attached.
**GOTCHAS:** The approval flow becomes *async by nature* — a staged effect must persist in the approval queue and survive daemon restart (the v9 approval-resume work is the foundation; wire it, don't rebuild it). Backpressure: a slow client must never stall the engine — per-client bounded event buffers, drop-and-mark-stale.
**OP UPGRADE:** Sessions outlive clients *and* the daemon: on restart, the Garrison rehydrates open sessions from rollout files, so a reboot mid-mission resumes instead of forgetting.

### V2 — Thin clients
**WHY:** The CLI stops being the composition root; the desktop stops shelling into a CLI.
**WHAT:** `ares chat` becomes a websocket client (attach, render, send). The Tauri app drops its shell-out and speaks the gateway protocol natively. `entry.ts` is dismantled: composition moves to `@ares/garrison`, command handlers become gateway calls.
**TEST:** `ares-clients.test.mjs` — CLI attach/detach against a mock gateway; protocol round-trip for every TurnEvent type.
**GOTCHAS:** Permission prompts are now remote: the request must render on *whichever* client is attached, with a daemon-side timeout → auto-stage to the Gate rather than hang the engine forever.

### V3 — Anthropic provider + prompt caching
**WHY:** Cheap forked side-calls are the economic engine of the Crucible; caching makes a Witness fork cost cents.
**WHAT:** Native `anthropic.ts` provider (messages API, streaming, tool use, interleaved thinking, cache-control breakpoints on system prompt + tool block). ReasoningLevel maps to thinking budgets. Add to launcher/model router.
**TEST:** `ares-anthropic.test.mjs` — shape tests against recorded fixtures (the m1-* provider tests are the template).
**OP UPGRADE:** A `sideQuery()` helper in core: fire a cheap one-shot judgment call (Haiku-class) reusing the session's cached prefix — the primitive Witness, memory selection, and titling all share.

### V4 — One memory, semantic seeds
**WHY:** Spreading activation is only as good as its seeds; token overlap misses every paraphrase.
**WHAT:** Embedding index inside living memory (local embeddings via the existing Ollama path, or provider API when configured; store vectors in a sidecar SQLite, not in memory.jsonl). `recall()` seeds = embedding similarity blended with IDF overlap; spreading activation unchanged on top. Migrate v4 vector-store rows into living memory (kind: semantic, provenance tagged), then retire the substrate and `unifiedRecall`'s two-store merge.
**TEST:** `ares-recall.test.mjs` — "auth flow" cue surfaces a "login handler" memory with zero token overlap; migration is idempotent; classic path still works with embeddings absent.
**GOTCHAS:** Never block a turn on embedding latency — embed at write time, recall reads the index; a missing vector falls back to lexical for that node.

### V5 — The Witness (LLM enters the learning loop)
**WHY:** Kills reason #2. The learning decision finally has a brain.
**WHAT:** After each substantive turn (deterministic pre-filter keeps "lmao" turns out), the Garrison forks a background reviewer — conversation snapshot, cheap model via V3's sideQuery, whitelisted to memory/skill/hypothesis tools only — that proposes: user facts, beliefs, procedures, skill patches, or *nothing*. Replaces regex capture and dream signal extraction. Each proposal lands as a **candidate** hypothesis: `{claim, kind, check?: VerificationSpec | EvalCase, evidence: []}`. Skills proposed by the Witness get an eval-harness case authored in the same fork or they don't land.
**TEST:** `ares-witness.test.mjs` — mock provider: a correction-bearing transcript yields a feedback candidate; a trivial transcript yields nothing; a multi-step success yields a procedure candidate WITH a check attached.
**GOTCHAS:** The Witness writes to stores, never to the live session. Its tool whitelist is enforced at the engine layer (deny-by-default), not by prompt. Rate-limit: one fork per turn max, skip when the queue is hot.

### V6 — Consequence wiring (the part nobody else has)
**WHY:** Closes the loop. Strength stops meaning "often recalled" and starts meaning "present when reality moved."
**WHAT:** When recall injects artifacts into a turn, the turn is tagged with their IDs (engine-level, flows through TurnEvents). When an outcome lands — operator probe verdict, verifier pass/fail, effect committed-vs-rolled-back, explicit user correction — every artifact in play is credited or debited in its `evidence` array, and living-memory `reinforce()` keys on outcome credit, not recall frequency. Unproven candidates are marked as such when injected ("acting on a hypothesis").
**TEST:** `ares-consequence.test.mjs` — artifact recalled into a turn whose probe says moved → strength up + evidence appended; same artifact riding three failed turns → decays despite frequent recall.
**GOTCHAS:** Credit assignment is honest-but-blunt: presence ≠ causation. Keep deltas small and let volume converge; never let one outcome swing strength more than one consolidation epoch could.
**OP UPGRADE:** Evidence entries carry the probe fingerprint — a belief's record links to *verifiable world-states*, auditable from the ledger like effects are.

### V7 — Crucible dreams (trial by evidence)
**WHY:** Promotion gates on proof, not thresholds set at write time.
**WHAT:** Deep dreams become the trial: an idle-triggered curator fork (Hermes-curator shape, our gate) reviews candidates — runs each skill candidate's eval case via `evalHarness`, runs each belief's probe via `runProbe`, reads the win-loss record. Survivors promote (candidate → confirmed; feeds soul/identity). Losers archive *with the failure reason as a new memory*. Confirmed knowledge with a decaying record gets demoted back to candidate — beliefs can lose tenure.
**TEST:** `ares-crucible.test.mjs` — candidate with passing eval + positive record promotes; failing eval archives with reason; stale confirmed belief whose probe now fails demotes.
**GOTCHAS:** Probes in dreams run against the real world — they go through the effects rails like everything else (read-only probes are reversible-tier; anything else stages to the Gate).

### V8 — The leash dividend
**WHY:** Learning and safety become one system — the unique endgame.
**WHAT:** The TrustGovernor's `leashOf(domain)` reads the Crucible: domains where confirmed procedures hold strong records earn longer leashes; domains running on hypotheses stay short. Trust changes are ledger entries with the evidence that justified them.
**TEST:** `ares-leash.test.mjs` — domain leash rises only after N confirmed-with-record procedures; a debited record drops it; every change has a ledger trail.

### V9 — The face (desktop redesign, war-room design language)
**WHY:** The primary surface should look like what Ares is: a window into a standing garrison — a war room, not a chat app.
**WHAT:** Tauri app rebuilt on the gateway protocol with the anatomy the field validated, in our palette (Identity §): left rail = sessions inbox (auto-titled via sideQuery, pinned section, search) + Skills, Goals, the Gate, Artifacts; center = conversation with thinking as dim inline text and tool runs as collapsed step-cards ("4 steps · 40s") expanding to command/output; footer = ambient telemetry (Garrison status, agents running, next dream, token bar, model + reasoning level). The Gate panel shows staged effects with simulate-previews and approve/deny. **Ares-only surfaces no reference has:** skill cards with batting averages, beliefs with evidence trails, the leash level per domain — the Crucible made visible.
**TEST:** Component tests for event→render mapping; smoke screenshot per panel (the existing tauri smoke rig).
**GOTCHAS:** Don't chase their pixels; steal restraint — one warm monochrome, progressive disclosure, telemetry passive in the footer, zero accent sprawl.

### V10 — First channel (proof of the gateway)
**WHY:** Validates that channels are "just clients" and gives the entity reach.
**WHAT:** Telegram bridge as a gateway client: DM ↔ session, approvals render as inline keyboards (Gate over Telegram), long outputs summarized via sideQuery.
**TEST:** `ares-channel.test.mjs` — bridge round-trip against a mock gateway + mock Telegram API.

---

## What ARES does NOT do

- No clean-room rewrite. The engine, rails, operator, and living-memory dynamics port as-is. Burning proven organs to repaint the body is the failure mode, not the goal.
- No new lore-nouns beyond Garrison/Crucible/Gate. Mechanism count is not capability. Every phase above must make Ares close a real task it couldn't close before, or it gets cut.
- No multi-channel sprawl before V10 proves one channel cleanly.

## Definition of done

A stranger installs Ares, the Garrison takes post on boot, and within a week their instance demonstrably *knows things it has proven*: skills with win-loss records visible in the app, a belief that got demoted when the world changed, an effect that waited at the Gate until they approved it from their phone. That's the demo no other agent can give.
