# Crix v5 — The Operator (Will on top of the Mind)

This is the executable spec to take Crix from "a coding agent with a mind" to **an entity that acts in the world over long horizons, teaches itself new capabilities, and earns the right to act unsupervised.**

The lineage:
- **v3 (`docs/roadmap/NEXT.md`)** gave Crix a **body** — parallel tools, LSP, checkpoints, diffs, slot routing.
- **v4 (`docs/roadmap/NEXT-AGENT.md`)** gave that body a **mind** — identity, memory, heartbeat, dreaming, self-revision.
- **v5 (this doc)** gives the mind a **will** — a durable spine that survives the terminal closing, drives itself toward goals, reaches into the real world through audited effects, and compounds competence so it gets measurably smarter every week.

Read this entire file before writing a line. Then ship **O1–O14 in order**, tests-first, `pnpm verify` green before every commit, per-task commit format `On: <short title>`. Add `tests/v5-<short>.test.mjs` per task. Target **300+ tests** when O14 ships (currently 173).

Every task follows the same shape so you can't get lost:
- **WHY** — what changes when this ships
- **WHAT** — exact deliverable, no ambiguity
- **WHERE** — file paths in the existing repo
- **HOW** — code shape, key APIs, dependencies (included where a concrete sketch adds signal beyond WHAT/WHERE; the foundational tasks O1/O2/O4/O7 carry it, later tasks compose established patterns)
- **TEST** — acceptance criteria (write the test FIRST)
- **GOTCHAS** — the traps that will burn you
- **OP UPGRADE** — the move that makes this *elite*, not just done

---

## The one-sentence north star

> **Crix is a machine for converting irreversible uncertainty into reversible, verified, remembered competence — cheaply, legibly, in a world that is actively changing under it.**

Risk goes in. Reusable competence comes out. Everything in this spec serves that sentence.

---

## The two curves (the law everything obeys)

Crix has two quantities that compound:

- **Competence** — what it *can* do. The skill graph. Grows by learning.
- **Trust** — what it's *allowed* to do unsupervised. The leash. Grows by proving.

**They must climb together.** The single failure mode that kills autonomous agents is the two curves diverging:

- Trust climbs above competence → it's permitted to do things it isn't good at → **disaster** (expensive, irreversible mistakes).
- Competence climbs above trust → a capable agent on too short a leash → **caged genius** (wasted potential, slow, annoying).

Every subsystem below — verification, calibration, rails, the ladders, the estate, legibility — exists for exactly one purpose: **keep competence and trust matched while both rise, in a hostile world, without the user's constant attention.**

If you ever find yourself building something that doesn't serve that, stop.

---

## Why this exists — what breaks in current Crix

Six structural gaps, confirmed by reading the source:

1. **Autonomy dies when the terminal closes.** `packages/agent` contains zero references to `QueryEngine`/`streamTurn`. The mission loop (`mission/loop.ts`) is a pure state machine; the heartbeat (`heartbeat.ts`) can only *alert* via `onAlert(text)` — it cannot spawn a turn or run a tool. Nothing wakes up and drives work. There is no spine.
2. **No real-world effectors.** The entire outward surface is `Bash`/`PowerShell` + `WebFetch`/`WebSearch` + MCP. No first-class email, browser-driving, deploy, payments, or analytics.
3. **No rails.** The charter *talks about* "approval and budget rails." They do not exist in code. There is a per-tool safety gate but no spend ledger, no irreversibility model, no kill switch, no idempotency.
4. **Competence doesn't compound.** Skills (`agent/skills/runtime.ts`) execute, but there's no capability graph that factors a mastered skill into reusable sub-skills, so mastering "email" does nothing to accelerate "Shopify account."
5. **No eyes, no proof.** It can't perceive a GUI it's driving, can't verify visually, and produces no visual audit trail.
6. **No means-ends reasoning.** It can't reason "I'd do this via an API, or an MCP, or — can't? — then the browser," fall back across methods, and acquire a missing one.

v5 closes all six, in dependency order.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│  THE OPERATOR  (will — packages/operator/, always-on, durable, BORING)   │
│                                                                          │
│   GoalStore       long-horizon goals → missions → steps (survives reboot)│
│   Scheduler       cron ticks + event triggers; wakes the loop            │
│   WorldModel      reality, RE-DERIVED from sources — never "remembered"   │
│   ControlLoop     SENSE → ORIENT → DECIDE → ACT → VERIFY → LEARN → PERSIST│
│   TrustGovernor   per-(action-class,domain) leash; grows by calibration  │
│   Dispatcher      spawns ephemeral Workers, collects verified verdicts   │
│   Attention       executive function: what to think about right now      │
└────────────────────────────────────────────────────────────────────────┘
        │ dispatches ONE bounded, verifiable step at a time
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│  WORKERS  (hands — REUSE packages/core QueryEngine, ephemeral & clever)   │
│   Fresh context, scoped tools, sandboxed, dies after one verified step.   │
│   Builder + adversarial Critic pair for large work.                       │
└────────────────────────────────────────────────────────────────────────┘
        │ proposes Effects (never calls the world directly)
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│  EFFECTS + RAILS  (conscience — packages/effects/, build BEFORE connectors)│
│   Effect{ kind, args, cost, irreversibility, idempotencyKey, predict }    │
│   simulate → stage → commit   |   Ledger (append-only) | Budget | KillSwitch│
│   THE single choke point for every side effect that touches the world.    │
└────────────────────────────────────────────────────────────────────────┘
        │ committed effects only
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│  CONNECTORS  (reach — packages/connectors/, each starts at leash = 1)     │
│   browser · email · deploy · analytics · payments(test-mode last)         │
└────────────────────────────────────────────────────────────────────────┘

REUSE: core/queryEngine (Worker runtime) · agent/mission (mission model, extend) ·
       agent/self (calibration + reflect) · agent/skills (crystallized capability) ·
       core/verifier (promote to reality-grounded) · agent/memory (playbooks)
```

The pieces you already built **survive**. v5 builds a floor below `core` (Operator + Effects) and a reach beyond it (Connectors), and promotes `verifier` from "tsc passes" to "reality matches the goal."

---

## Core concepts (read before the tasks — the tasks assume these)

### C1 — The control loop is convergent by construction

A turn-based agent is a chain where each step has error rate ε; over N steps reliability is `(1−ε)^N → 0`. That's why naive long-horizon agents always die. We beat the curve with three commitments:

1. **Reality-grounded loop.** The setpoint is the goal; the measured variable is *reality* (the running app, the Stripe balance, the inbox); the error is the gap; the controller drives the gap to zero. The agent's *claims* are never trusted — only measured reality.
2. **Immortal will, mortal hands.** Drift accumulates inside long LLM contexts. So state lives in the **boring, durable Operator**, and every clever step runs in a **fresh, disposable Worker** that boots from durable state, does one small verifiable chunk, and is thrown away before it can rot. One impossible 10,000-step context becomes 10,000 fresh 5-step contexts.
3. **Every step shrinks a measurable gap or it doesn't count.** No "done" without a reality probe. A step that doesn't move the gap is *signal* (divergence), not a reason to keep swinging.

The loop:

```
every tick (and on every event — webhook, inbound email, deploy-finished):
  SENSE    re-derive WorldModel from reality (poll sources, drain event queue)
  ORIENT   for each active goal: gap = goalState − worldState
  DECIDE   pick highest-value unblocked action within budget AND trust leash
             gap closed?      → mark done; update calibration
             no progress × N? → DIVERGENCE → escalate to human; do NOT thrash
             exceeds leash?   → stage the Effect, request approval, move on
  ACT      spawn ephemeral Worker for ONE bounded step
             Worker proposes Effects → rails simulate/stage/commit
  VERIFY   re-measure reality. Did the Effect move the gap as PREDICTED?
  LEARN    crystallize what worked; factor sub-skills; score prediction→trust
  PERSIST  checkpoint durable state; sleep until next tick or event
```

The Operator never calls an LLM to decide *policy*. It runs deterministic control logic over durable state and spawns LLMs only to *execute bounded steps*. That is what keeps the always-on core from drifting.

### C2 — Machine A is Machine B with a software world

There is one machine, not two. "Build a feature" and "launch a landing page and get signups" are both **missions with a goal, a reality-grounded verification gate, effects, and a budget.** Coding is just the mission class where the effectors are code+deploy and reality is the running app — and it's the *most verifiable* class, which is why it's the proving ground for the whole spine (O1–O4 are coding-only on purpose).

### C3 — Competence compounds via a capability graph

A mastered capability is **not** stored flat. It is **factored into reusable sub-skills** hung on a DAG. Mastering email yields `research`, `browser-form-fill`, `credential-vault`, `handle-verification-link`. "Make a Shopify account" then reuses all four and only learns the **novel delta** (`shopify-specifics`). The novel-delta shrinking over time *is* "it gets smarter the more it does," and it's measurable.

The sharp truth from the email example: **the first account is the hardest thing it will ever do** (captcha, phone verify, no inbox to confirm against, zero priors). But succeeding forges verification-handling, form-filling, and the vault — so *every* later signup inherits them. **Difficulty goes down as the graph goes up.**

### C4 — The learning loop (how a capability is acquired and mastered)

```
ENCOUNTER  new capability (user asks, or a mission hits a gap)
           → check graph: which sub-skills exist? what's the novel delta?
RESEARCH   the seed skill and universal bootstrap — study the unknown,
           and POPULATE THE METHOD LADDER for this capability (see C6)
ATTEMPT    decompose; reuse known skills; improvise the novel part.
           First attempts on a SHORT leash (human watches/approves).
VERIFY     reality probe — did it actually work? (login succeeds? row exists?)
CRYSTALLIZE on verified, REPEATED success: write a reusable skill (handler.js)
           + a playbook. One-time success → permanent capability.
FACTOR     extract reusable sub-skills as independent graph nodes.
DRILL      repeat on varied instances until reliability crosses threshold → MASTERED.
```

### C5 — Crystallization: code vs. playbook (and the promotion path)

- **Skill (code)** — deterministic procedures become `handler.js`: *generate strong password*, *poll inbox for verification link*, *am I logged in?*. Fast, zero-token, perfectly reliable, composable.
- **Playbook (judgment)** — fuzzy procedures that need a brain become structured memory: *"how I pick a dropshipping product — trend, margin, shipping time; avoid saturated/seasonal."* Retrieved to prime the reasoner at the start of similar missions.
- **Promotion** — a playbook that proves stable over many runs gets promoted to code. Judgment hardens into reflex. That promotion is itself a mastery signal.

### C6 — The two ladders (the same shape: cheap+grounded first, general+fragile last, acquire if nothing fits)

**Perception ladder** (how it sees):
1. **Source data / API** — cheapest, exact.
2. **DOM / accessibility tree** — when driving a browser, tells it exactly where the field is. Use for form-filling whenever present.
3. **Screenshot + vision model** — captchas, canvas, native apps, "does this *look* right," and visual verification.

> Read structure when you can; look at pixels when you must. Pure pixel-clicking is the most general and the most fragile — last rung only.

**Method ladder** (how it acts):
1. **Official API** (have a key?) — most reliable, cheapest, most verifiable. Always prefer.
2. **MCP server** for the service.
3. **CLI tool** on the machine.
4. **Browser automation** — works on anything, slowest/most fragile.
5. **Can't yet** → **ACQUIRE a method** (research, install an MCP, write a skill, scaffold a tool), then retry.

> MCP is **not special — it's one rung.** Crix never asks "should I use an MCP?" It asks "what's the highest available rung on this capability's ladder right now?" Research's job is to *populate the ladder* ("Shopify has an Admin API → rung 1 exists"), and a working method gets crystallized so next time it starts higher.

### C7 — Trust is earned per domain, by calibration

Autonomy is a measurable, earned quantity: the **leash** — how far it acts before a human checkpoint — per **(action-class, domain)**. `trust["deploy:staging"]`, `trust["email:reply-known-contact"]`, `trust["spend:ads"]` are *separate dials*, each starting at **leash = 1** (approve every time).

The currency that buys leash is **calibration**: before committing an Effect, the Worker must **predict** its outcome ("this deploy passes health checks," p=0.9). After VERIFY, score prediction vs. reality (Brier score).
- predicted ≈ happened → that domain's leash grows.
- diverged, or harm/cost spiked → leash snaps short.

The agent **literally earns the right to act unsupervised, one domain at a time, by being demonstrably right about that domain.** "No limits eventually" is never *granted* — it's the limit pushed outward by a track record you can read in the ledger.

### C8 — Effects, the irreversibility gradient, and rails

Every outward action is a typed **Effect** that flows through **simulate → stage → commit**. The rails operate on Effects uniformly: that's where the ledger, budget, idempotency, and kill switch live, and it's the *single choke point* for everything that touches the world.

**The master risk axis is irreversibility, not cost.** The workspace has checkpoints; the world has no undo. Tag every Effect on the gradient:
- `reversible` (local file write, staging deploy) → act freely even on a short leash.
- `recoverable` (created account you can delete, draft saved) → moderate scrutiny.
- `irreversible` (sent email, charged card, public post, deleted prod) → **maximum scrutiny regardless of competence or leash.**

A cheap irreversible mistake (one bad public post under the user's name) can cost more than an expensive reversible one. Irreversibility dominates the rails *more than budget does*.

### C9 — Crix accumulates an *estate* (the crown jewels)

Once it owns email, accounts, API keys, deployed services, maybe money, it holds a **real-world identity + credential estate** more valuable and more dangerous than the code. Three hard constraints:
- **Legal/ToS** — automated signup is banned on many services; money triggers KYC. Some tasks aren't "hard," they're *not allowed* — Crix must know the difference and refuse.
- **Blast radius** — a leaked vault = email + payments + deploy compromised at once → least-privilege per Worker, mandatory.
- **Recovery & the persona question** — keep an auditable **estate ledger** (every identity/account/key it holds, and why), and make a *deliberate* choice: does Crix act **as the user** (their name, their liability) or **as its own persona**? This is decided in config, never emergent.

### C10 — The world fights back: mastery is really maintenance

The static-world assumption is false. DOMs change, APIs deprecate, captchas evolve *specifically* to stop bots, accounts get banned for automation, rate limits move. A skill crystallized today rots tomorrow. Consequences baked into the design:
- skills carry **health checks** and **auto-repair**;
- **"I'm being blocked/banned"** is a distinct detected signal that triggers back-off, not retry-into-a-ban;
- prefer the *stable* rung (API over scraping) even when slower — stability outvalues speed over time;
- the graph has a **carrying capacity**; prune ruthlessly. A small healthy graph beats a large rotting one.

### C11 — The Operator's hardest job is deciding what to think about

Always-on + many goals + finite budget/concurrency = an **attention economy**. The Operator is executive function, not a job queue: prioritize, prevent starvation of slow goals, do **opportunistic idle work** (drill a weak skill, maintain a rotting one, research a flagged gap), and know when to do *nothing*. Underneath sits **metacognition** — an honest self-model of its own competence boundary, to choose *attempt vs. research vs. ask*. The two hardest, first-class skills: **knowing when to ask for help**, and telling **"haven't figured it out yet"** apart from **"genuinely beyond me / a trap."**

### C12 — Legibility is a property of the agent, and it caps autonomy

**You can only extend the leash on what you can see and understand. An illegible agent caps its own autonomy** — nobody walks away from a black box. So observability is load-bearing, not cosmetic: live activity, the screenshot **filmstrip**, the goal tree, the estate ledger, and **decision traces** (why this method, this spend, this path). Plus the collaboration protocol: how the user's new instructions interrupt/redirect a running mission, and when Crix interrupts the user (**notify** vs **ask**) — modeling the user's attention too (don't spam; never go silent before an irreversible spend).

### C13 — The cold-start is the real threat (and how to survive it)

Compounding is **back-loaded**. An empty graph means *everything* is the hard novel-delta and *everything* is on a short leash → slow, supervised, unimpressive for weeks. That **valley of disappointment** is where most builders quit on their own creation. Two ways through, both in this spec:
- **Seed the graph** — pre-load common rungs (existing MCPs/CLIs/APIs as ready methods + a handful of starter skills) so it begins several floors up instead of relearning the obvious.
- **Builder + adversarial Critic** — for large work, don't wait on one smarter Worker; run a builder and a second Worker whose only job is to *break* it. Verification by an agent hunting the bug beats an agent grading its own homework. This is how Machine A builds something *large* and stays good across every change.

Design the early UX to make progress **visible** — the first month is an investment, not a payoff, and the user's faith has to survive it.

---

## Ship Order (do them in this order, do not reorder)

Phases group the gates. **Do not start a phase until the prior phase's gate is green.**

**Phase I — The spine, proven on a software world (coding only):**
1. **O1** — Operator spine (dry): GoalStore + Scheduler + ControlLoop + Dispatcher driving ephemeral Workers headlessly.
2. **O2** — Effects + rails (mock world): typed Effect, simulate/stage/commit, Ledger, Budget, KillSwitch, idempotency, irreversibility gradient.
3. **O3** — Reality-grounded verification + WorldModel re-derivation.
4. **O4** — Capability graph + crystallization + the learning loop (coding skills).

**Phase II — Seeing and figuring out how:**
5. **O5** — The two ladders: MethodResolver + PerceptionRouter (+ acquire-a-rung).
6. **O6** — Browser connector: DOM-first actions, screenshot, vision fallback, the filmstrip.
7. **O7** — TrustGovernor: predict→verify calibration, per-domain leash, adjustment.

**Phase III — The real world, on a short leash:**
8. **O8** — Estate: credential vault + estate ledger + persona policy.
9. **O9** — Email connector (first real capability, leash=1) — Crix teaches itself email end-to-end.
10. **O10** — Attention economy + metacognition (idle work, ask-for-help, competence boundary).
11. **O11** — Legibility + collaboration protocol (decision traces, goal tree, notify/ask, mid-mission redirect).

**Phase IV — Scale and durability:**
12. **O12** — Builder/Critic parallelism for large builds.
13. **O13** — Graph maintenance / immune system (health checks, auto-repair, ban-detection, dream-consolidation at scale).
14. **O14** — Cold-start seeding + connector expansion (deploy → analytics → payments test-mode last).

**Build/test cadence:** after every O*, run `pnpm verify`. Do not advance until 100% green and the phase gate (where one exists) passes. One commit per task, `On: <title>`.

---

# O1 — Operator spine (dry run, coding only)

### WHY
This is the whole dream's foundation: autonomy that **survives the terminal closing**. Until a goal can be driven to a verified result with no human present, nothing else in v5 is testable. Today autonomy *is* the user's attention; O1 makes it a process.

### WHAT
- New `packages/operator/` package. `core`/`tools` must not import it (same boundary discipline as `agent`).
- `GoalStore` — durable goals under `~/.crix/operator/goals/<id>.json`, each holding `missionIds[]`. Survives reboot.
- `Scheduler` — cron-style ticks (`every`, from config) **plus** an event queue (`enqueueEvent`) the wake-loop drains. `unref()` the timer.
- `ControlLoop` — the C1 loop, deterministic, no LLM in the policy. One tick = SENSE→ORIENT→DECIDE→ACT→VERIFY→LEARN→PERSIST.
- `Dispatcher.runStep(step)` — spawns an **ephemeral Worker**: a scoped `QueryEngine` (reuse `packages/core/src/queryEngine.ts`) with a fresh message history built from durable mission state, a scoped tool set, and `maxTurns` bounded. Returns a structured `StepVerdict { moved: boolean, evidence, prediction }`.
- `crix operator run` (foreground, for dev) and `crix operator start`/`stop` (durable background via a pidfile + detached process).

### WHERE
- `packages/operator/src/{index,goalStore,scheduler,controlLoop,dispatcher,worker}.ts`
- Reuse `packages/core/src/queryEngine.ts` for the Worker; reuse `packages/agent/src/mission/{loop,store,types}.ts` for the mission model (extend, don't fork).
- `packages/cli/src/entry.ts` — add the `operator` command family alongside the existing `daemon`.

### HOW
```ts
// controlLoop.ts (shape)
export async function tick(ctx: OperatorCtx): Promise<TickReport> {
  const world = await ctx.world.refresh();                 // SENSE (O3 makes this real)
  const goals = await ctx.goals.active();
  for (const goal of goals) {
    const gap = computeGap(goal, world);                   // ORIENT
    if (gap.closed) { await ctx.goals.complete(goal); continue; }
    const decision = decide(goal, gap, ctx.budget, ctx.trust); // DECIDE (deterministic)
    if (decision.kind === "diverged") { await ctx.escalate(goal, gap); continue; }
    if (decision.kind === "needs_approval") { await ctx.stageForApproval(decision); continue; }
    const verdict = await ctx.dispatcher.runStep(decision.step); // ACT (ephemeral Worker)
    const remeasured = await ctx.world.refresh();           // VERIFY
    await ctx.learn(goal, decision, verdict, remeasured);   // LEARN (O4/O7 fill in)
    await ctx.persist();                                    // PERSIST
  }
  return report;
}
```
Worker spawn reuses the existing engine; build its initial messages from `mission` state, NOT from a long-lived transcript (that's the anti-drift rule).

### TEST
`tests/v5-operator-spine.test.mjs`:
- A goal with a mock Worker that "moves the gap" after 2 steps completes in ≤2 ticks and persists `completed`.
- Killing and restarting the Operator mid-goal **resumes** from durable state (no lost progress, no duplicated step).
- A Worker that never moves the gap triggers `diverged` after `N` no-progress ticks and escalates instead of looping forever.

### GOTCHAS
- **Do not let mission context live in one growing window.** Each Worker boots fresh from durable state. If you thread a transcript through, you've rebuilt the drift problem.
- The Operator's `decide()` must be **deterministic** — no LLM. LLMs run *inside* Workers only.
- `unref()` every timer or the process won't exit in tests.
- Resume safety requires every step to be **idempotent at the mission level** (O2 gives you idempotency keys; until then, mark steps `in_flight` before ACT and reconcile on restart).

### OP UPGRADE
Make a tick **event-driven first, interval-second**: an inbound event (email, webhook, deploy-done) wakes the loop immediately; the interval is just the heartbeat fallback. This is the difference between a cron job and something that *reacts*.

---

# O2 — Effects + rails (mock world)

### WHY
This is the conscience, and it ships **before any real connector** so the safety layer is battle-tested before anything can touch the world. It's also what makes autonomy *auditable* — the precondition for ever extending a leash.

### WHAT
- New `packages/effects/`. A typed `Effect` and a uniform **simulate → stage → commit** lifecycle.
- `Ledger` — append-only JSONL under `~/.crix/operator/ledger/`, one entry per effect at every lifecycle transition. Never mutated.
- `Budget` — per-domain spend ceilings + daily/weekly caps; `commit` is refused past ceiling.
- `KillSwitch` — a single durable flag; when set, *all* `commit`s throw `HaltedError` and in-flight Workers are cancelled. `crix operator halt`.
- `Irreversibility` tag on every Effect (`reversible | recoverable | irreversible`) feeding the rails.
- `idempotencyKey` on every Effect; a committed key is never committed twice (survives resume).

### WHERE
- `packages/effects/src/{index,effect,ledger,budget,killSwitch,rails}.ts`
- `packages/operator/src/dispatcher.ts` — Workers propose Effects; the Dispatcher routes them through `rails.run(effect)`. Workers **never** touch the world directly.

### HOW
```ts
export interface Effect<A = unknown, R = unknown> {
  kind: string;                       // "email.send", "fs.write", "http.post"
  domain: string;                     // "email", "deploy", "spend:ads"
  args: A;
  cost: { tokens?: number; dollars?: number };
  irreversibility: "reversible" | "recoverable" | "irreversible";
  idempotencyKey: string;
  predict?: { outcome: string; p: number };   // feeds O7 calibration
  simulate(): Promise<R>;             // dry-run, no side effect
  commit(): Promise<R>;               // the real thing
}

export async function run(effect: Effect, ctx: RailsCtx): Promise<RailsResult> {
  if (ctx.killSwitch.engaged()) throw new HaltedError();
  ctx.ledger.append({ phase: "proposed", effect });
  const sim = await effect.simulate();
  ctx.ledger.append({ phase: "simulated", effect, sim });
  const verdict = ctx.gate(effect, ctx.trust, ctx.budget); // leash + irreversibility + budget
  if (verdict.kind !== "allow") { ctx.ledger.append({ phase: "staged", effect, verdict }); return staged(verdict); }
  if (ctx.ledger.committed(effect.idempotencyKey)) return alreadyDone();
  const res = await effect.commit();
  ctx.ledger.append({ phase: "committed", effect, res });
  return ok(res);
}
```

### TEST
`tests/v5-effects-rails.test.mjs`:
- A `reversible` effect under budget commits; the ledger shows proposed→simulated→committed.
- An `irreversible` effect on a leash-1 domain is **staged**, not committed, and surfaces an approval request.
- Re-running a committed `idempotencyKey` does **not** double-commit.
- Engaging the KillSwitch makes every subsequent `commit` throw `HaltedError`.
- Exceeding a daily cap refuses commit with a clear ledger entry.

### GOTCHAS
- **`simulate()` must never have a side effect** — it's the dry-run the whole safety story rests on.
- Irreversibility outranks budget in the gate: an `irreversible` effect always faces max scrutiny even if it's free.
- The ledger is the source of truth for "did this already happen" on resume — append-only, fsync, never rewrite.

### OP UPGRADE
Make every Effect **carry its own reversal** where one exists (`undo()`), and record it in the ledger. "Recoverable" becomes actionable: the Operator can roll back a created account or a draft automatically when a mission is abandoned.

---

# O3 — Reality-grounded verification + WorldModel

### WHY
"Done" must mean *reality matches the goal*, not "the model says so" and not "tsc passes." This is the antidote to hallucinated success and the thing that makes the control loop actually converge.

### WHAT
- Promote `packages/core/src/verifier.ts` from typecheck/test-on-touched-files to a **goal verifier** that runs the real thing: boot the app (`Bash run_in_background`), hit changed endpoints, render changed UI headless, assert.
- `WorldModel` in the Operator that **re-derives** state from sources every SENSE (health endpoint, git state, later: Stripe/inbox), never from the action log.
- A mission cannot transition to `completed` while its `verifyGoal()` probe is red.

### WHERE
- `packages/core/src/verifier.ts` (extend), `packages/operator/src/worldModel.ts` (new).
- Hook into `mission/loop.ts` `verifyMission` — `passed` now requires a real probe result, not a model claim.

### HOW
- A goal carries a `verification` spec: `{ kind: "http", url, expect }` | `{ kind: "process", cmd, expectExit }` | `{ kind: "selector", url, selector }` | `{ kind: "metric", source, expr }`.
- SENSE runs cheap probes every tick; VERIFY runs the goal's full probe after an ACT.

### TEST
`tests/v5-reality-verify.test.mjs`:
- A coding mission whose app fails to boot **cannot** be marked complete; the loop loops or escalates.
- WorldModel re-derives a changed value from the source even when the action log claims otherwise (reality wins).

### GOTCHAS
- Probes must be **cheap on SENSE, thorough on VERIFY** — don't boot the whole app every tick.
- Distinguish "probe failed because the change is wrong" from "probe failed because the environment is broken" (report-environment-issue path) — they need different responses.

### OP UPGRADE
Cache a **reality fingerprint** per goal and only run the expensive VERIFY when SENSE shows the fingerprint changed. Free convergence checks most ticks.

---

# O4 — Capability graph + crystallization + learning loop (coding)

### WHY
This is the engine of "gets smarter every week." Without it, every task starts from zero and there's no proof the agent improves. With it, novel-delta shrinks measurably and Crix's identity becomes the tree it grows.

### WHAT
- `CapabilityGraph` — a DAG of capability nodes under `~/.crix/operator/graph/`. Reuse and extend `agent/self` (the self-model already tracks reliability) — a capability node references its sub-skills and its method ladder (O5).
- The **learning loop** (C4) implemented as a mission template: ENCOUNTER→RESEARCH→ATTEMPT→VERIFY→CRYSTALLIZE→FACTOR→DRILL.
- **Crystallize** = on verified, repeated success, write a `handler.js` skill (reuse `agent/skills/runtime.ts`) and/or a playbook (reuse `agent/memory`), and register the node.
- **Factor** = split reusable sub-skills into their own nodes.
- Start with **coding skills only** (e.g. "scaffold a Vite app", "add an API route") so it's fully verifiable before the real world.

### WHERE
- `packages/operator/src/graph/{node,store,learn,factor}.ts`
- Reuse `packages/agent/src/self/{store,types,reflect}.ts`, `packages/agent/src/skills/runtime.ts`, `packages/agent/src/memory/*`.

### HOW
```ts
interface CapabilityNode {
  id: string; name: string;
  status: "want" | "learning" | "have" | "mastered" | "rotted" | "forbidden";
  subSkills: string[];          // node ids this composes (C3)
  methods: MethodRung[];        // the ladder (O5)
  skillRef?: string;            // crystallized handler.js
  playbookRef?: string;         // crystallized judgment
  outcomes: { ok: number; fail: number; lastError?: string; lastUsedAt?: string };
  novelDeltaHistory: number[];  // shrinking delta = the smarter-over-time proof
}
```

### TEST
`tests/v5-capability-graph.test.mjs`:
- Mastering capability A crystallizes a skill and factors a sub-skill node S.
- A later capability B that depends on S has a **smaller novel delta** (assert it reuses S instead of relearning) — this is the headline test of the whole project.
- Crystallization is refused after a single success; requires N verified successes.

### GOTCHAS
- **Crystallize only after reality-verified, repeated success.** One lucky run is not a lesson — it's the start of the immune-system problem (O13).
- Keep skills **narrow and composable** — a broken narrow skill is swapped; a broken god-skill poisons the graph.

### OP UPGRADE
Track and surface the **novel-delta curve** in `crix operator stats` — a literal graph of "effort to learn the Nth capability" trending down. That curve *is* the product. It's also the eval that proves a 500-session Crix beats a fresh one on the same model.

---

# O5 — The two ladders (method + perception)

### WHY
This is "knowing how to do shit": reasoning about *means*, falling back across methods, and acquiring a missing one — the difference between a fixed-path bot and something that figures it out.

### WHAT
- `MethodResolver` — given a capability + the environment (keys present? MCP installed? CLI on PATH?), returns the **highest available rung** and a fallback chain (API→MCP→CLI→browser→acquire).
- `acquire()` — when no rung works: research, then install an MCP / write a skill / scaffold a tool, register it as a new rung, retry.
- `PerceptionRouter` — for a given observation need, pick API→DOM→vision.
- Both update the capability node on success (crystallize the working rung) and on ban/failure (O10/O13 back-off).

### WHERE
- `packages/operator/src/ladders/{methodResolver,perceptionRouter,acquire}.ts`
- Reuse `packages/tools/src/Mcp.ts` for MCP install/list; `agent/skills` + `SkillCraft` for self-authored rungs.

### TEST
`tests/v5-ladders.test.mjs`:
- With an API key present, the resolver picks the API rung; remove the key and it falls to MCP, then browser.
- `acquire()` installs a (mock) MCP for a capability with no rung and the retry now resolves to it.
- PerceptionRouter picks DOM for a form field present in the accessibility tree, vision for a captcha.

### GOTCHAS
- The resolver must check **availability**, not just existence ("there is a Stripe API" ≠ "I have a key").
- `acquire()` is the dangerous one — it installs/writes code. Route its actions through the rails like everything else.

### OP UPGRADE
Let research **write the ladder as structured data**, not prose: a research mission's output is `MethodRung[]` for the capability, so figuring-out-how directly upgrades the graph.

---

# O6 — Browser connector + visual proof (the filmstrip)

### WHY
The eyes and the hands for the open web — and the visual audit trail that makes Crix legible and verifiable. Most real-world capabilities (signup, posting, dashboards) live behind a browser.

### WHAT
- `packages/connectors/browser/` — a Playwright-backed connector exposing **DOM-first actions** (find-by-role/label, fill, click) and **screenshot**; vision is the fallback rung.
- Every action emits a screenshot Effect into the ledger → a **filmstrip** replay (`crix operator film <missionId>`).
- Verification by selector/visual ("the account dashboard rendered").

### WHERE
- `packages/connectors/browser/src/index.ts`; wire as Effects through `packages/effects`.
- Vision via the multimodal main model (GPT-5.5 OAuth) through the existing provider; cheap-model slot for routine "what's on screen."

### TEST
`tests/v5-browser.test.mjs` (against a local fixture page):
- Fills a form by accessibility label (DOM rung), screenshots, asserts the success selector.
- Vision rung reads a value rendered only to canvas.
- The filmstrip reconstructs the run from ledger screenshots in order.

### GOTCHAS
- **DOM-first, always.** Vision-clicking is the last rung — fragile and token-heavy.
- Screenshots can contain secrets — redact before they hit the ledger if the estate persona is "as the user."
- Headed vs headless: some flows (captcha, anti-bot) behave differently; make it a per-mission choice.

### OP UPGRADE
Auto-attach a stable `crixid` to elements it interacts with so re-runs and the filmstrip survive DOM churn — turns brittle selectors into durable ones.

---

# O7 — TrustGovernor (calibration → earned leash)

### WHY
The mechanism that keeps the two curves matched. It turns "test in my env and find the right flow" into a number that grows on its own from the agent's track record.

### WHAT
- `TrustGovernor` holding `leash[(actionClass, domain)]`, all starting at 1.
- Workers **predict** before committing (`Effect.predict`); after VERIFY, score with Brier; update the domain's calibration.
- Leash extends when calibration is good over a window; snaps short on divergence or harm.
- The rails `gate()` (O2) consults the leash + irreversibility together.

### WHERE
- `packages/operator/src/trust/{governor,calibration}.ts`; reuse `agent/self` outcome tracking.

### TEST
`tests/v5-trust.test.mjs`:
- A domain with N well-calibrated predictions sees its leash grow; the gate then auto-allows what it previously staged.
- One harmful/diverged outcome snaps the leash back to 1.
- Irreversible effects stay gated regardless of leash (C8 invariant holds).

### GOTCHAS
- Leash is **per domain**, never global — mastery of email must not unlock spend.
- Require a *minimum sample* before extending (no leash growth from 2 lucky calls).

### OP UPGRADE
Expose the leash dashboard in `crix operator trust` — every domain, its leash, its calibration, its recent evidence. This is the artifact that lets the user *consciously* decide to walk away from a domain. The dashboard is the trust.

---

# O8 — Estate (vault + ledger + persona)

### WHY
The moment Crix owns real accounts, the estate becomes the highest-stakes thing in the system. Manage it deliberately or it becomes the single point of catastrophe.

### WHAT
- Encrypted `CredentialVault` under `~/.crix/operator/vault/` (OS keychain where available; encrypted-at-rest otherwise).
- `EstateLedger` — auditable list of every identity, account, key, and deployed asset, with provenance ("created 2026-06-03 for goal X").
- `PersonaPolicy` in config: `acts_as: "user" | "persona"`, with the legal/ToS guardrails (forbidden capability class for things that require real KYC unless explicitly user-approved).
- Least-privilege: a Worker gets only the credentials its scoped step needs.

### WHERE
- `packages/operator/src/estate/{vault,ledger,persona}.ts`; gate all credential reads through rails + audit.

### TEST
`tests/v5-estate.test.mjs`:
- Creating an account writes an estate-ledger entry with provenance.
- A Worker scoped to "deploy" cannot read "email" credentials.
- A capability flagged `forbidden` by PersonaPolicy is refused with a clear reason.

### GOTCHAS
- Never log raw secrets — not in the ledger, not in screenshots, not in Worker transcripts.
- KYC/ToS: encode "not allowed" as a first-class refusal, distinct from "can't yet."

### OP UPGRADE
A `crix operator estate export` that hands the user a complete, human-readable recovery kit (every account + how to reclaim it) — so the user is never locked out of what Crix built. Recoverability is what makes a big estate safe to grow.

---

# O9 — Email connector (first real capability, leash = 1)

### WHY
The first real-world capability and the proof of the learning loop. It's the hardest single thing Crix will do (no priors, captcha, phone verify) — and succeeding forges verification-handling, form-filling, and the vault that *every* later signup inherits. This is C3 made real.

### WHAT
- `packages/connectors/email/` — send + receive + parse (IMAP/SMTP or a provider API rung).
- Crix runs the **full learning loop** to provision its own inbox: research easiest provider → drive signup via browser (O6) → store creds (O8) → handle verification → VERIFY by logging in.
- Crystallize `handle-verification-link`, `web-signup` sub-skills; assert reuse on the next signup.
- Everything on **leash = 1**: it can *draft/stage* freely; *send* only on approval until calibration earns the leash.

### WHERE
- `packages/connectors/email/src/index.ts`; Effects through rails; learning loop via O4 template.

### TEST
`tests/v5-email.test.mjs` (provider mocked):
- The learning loop provisions an inbox end-to-end and VERIFIES by login.
- `handle-verification-link` is crystallized and **reused** by a second (mock) signup with a smaller novel delta.
- `email.send` is staged (not sent) while leash=1; approving it commits exactly once (idempotent).

### GOTCHAS
- The first inbox bootstrap may need phone/captcha — this is the legitimately hard part; allow a human-assist step on leash=1 rather than failing the whole mission.
- Inbound email is an **event** that should wake the Operator (O1 OP UPGRADE).

### OP UPGRADE
Make the inbox a first-class **event source**: a reply to something Crix sent wakes the loop and resumes the relevant mission. Now it has a real-world feedback channel, not just an outbox.

---

# O10 — Attention economy + metacognition

### WHY
An always-on agent must decide *what to think about*, and must know its own limits. Without this it either idles uselessly or thrashes expensively, and it never knows when to ask for help.

### WHAT
- `Attention` scheduler in the Operator: priority + anti-starvation + **opportunistic idle work** (drill a weak skill, maintain a rotting one, research a flagged gap) + "do nothing" as a valid choice.
- `Metacognition`: a competence-boundary estimate per capability that picks **attempt vs. research vs. ask**.
- `ask_for_help` as a first-class action (not a failure), and a discriminator for "haven't figured it out yet" vs "genuinely beyond me / a trap" vs "not allowed".

### WHERE
- `packages/operator/src/{attention,metacognition}.ts`; feeds DECIDE in the control loop.

### TEST
`tests/v5-attention.test.mjs`:
- With no active goal, idle ticks do useful maintenance (drill/repair/research), not nothing-or-spin.
- A low-competence capability routes to research/ask, not a blind expensive attempt.
- Repeated no-progress flips to `ask_for_help`, not infinite retry.

### GOTCHAS
- Idle work still costs tokens — it's subject to the budget like everything else.
- Don't let high-priority goals **starve** maintenance forever; a rotting graph is a silent debt.

### OP UPGRADE
A token-aware DECIDE that routes cheap steps to the SUMMARIZE/APPLY slots and escalates to GPT-5.5 only when the novel delta is genuinely hard — the existing 3-slot architecture becomes an economic controller, making continuous running affordable.

---

# O11 — Legibility + collaboration protocol

### WHY
Legibility caps autonomy (C12). The user can only extend the leash on what they can see and steer. This is the difference between a black box you can't trust and a partner you can hand the keys to.

### WHAT
- **Decision traces** — every DECIDE records *why* (chosen method, leash check, budget, expected outcome) into the ledger, human-readable.
- **Goal tree** view (`crix operator status`) — goals → missions → steps, live.
- **notify vs ask** — non-blocking updates vs blocking questions, modeling the user's attention (never silent before an irreversible spend; never spammy).
- **Mid-mission redirect** — the user's new instruction interrupts at the next safe checkpoint, re-plans, and continues (extend the existing `user_intervention` queueing to the Operator).

### WHERE
- `packages/operator/src/legibility/{trace,notify}.ts`; CLI/TUI views; reuse existing intervention queue.

### TEST
`tests/v5-legibility.test.mjs`:
- Every committed effect has a retrievable decision trace explaining why.
- A mid-mission instruction redirects work at the next checkpoint without corrupting mission state.
- An irreversible action always produces an `ask` (never a silent commit) while its leash is short.

### GOTCHAS
- Traces must be cheap to write (structured, not an LLM essay per step).
- Redirect must be **safe-checkpoint** based — never interrupt mid-irreversible-effect.

### OP UPGRADE
A live **filmstrip + trace timeline** UI: scrub through what Crix did overnight, screenshot by screenshot, each annotated with the decision trace and cost. This single view is what earns the user's confidence to lengthen leashes.

---

# O12 — Builder/Critic parallelism (large builds stay good)

### WHY
How Machine A builds something *large* and stays good across every change: not a smarter single Worker, but a builder and an independent adversary hunting its bugs.

### WHAT
- A mission mode that spawns a **Builder** Worker and a **Critic** Worker (the Critic's only job is to break the Builder's output: edge cases, regressions, security).
- Critic findings that reproduce against reality (O3) re-open the mission; the Builder fixes; loop until the Critic is dry.
- Optional parallel specialist Workers (frontend/backend) coordinated via durable mission state, not shared context.

### WHERE
- `packages/operator/src/squad/{builder,critic,coordinator}.ts`; reuse `Task` tool patterns + the Worker runtime.

### TEST
`tests/v5-builder-critic.test.mjs`:
- A multi-file feature with a planted bug: the Critic finds it, the Builder fixes it, the mission completes only when the Critic is dry **and** reality-verify is green.

### GOTCHAS
- The Critic must verify against **reality**, not re-grade the Builder's reasoning (or it's theater).
- Bound the build/critic loop with an iteration budget (reuse the mission budget) so it can't ping-pong forever.

### OP UPGRADE
Run **N independent Builders** on hard problems and a judge panel to pick the best, grafting good ideas from runners-up — the diverse-attempt pattern, for when one approach won't cut it.

---

# O13 — Graph maintenance / immune system

### WHY
Compounding cuts both ways: a bad or rotted skill propagates into everything built on it. Mastery is maintenance (C10). This keeps the graph healthy as it scales past ~30 capabilities where naive designs collapse.

### WHAT
- Skill **health checks** (periodic, on idle) that re-run a crystallized skill against a known fixture; failing skills flip to `rotted` and get auto-repaired (relearn the novel delta) or pruned (reuse `agent/self` reflect: fix/acquire/prune).
- **Ban/block detection** as a distinct signal → back-off + switch rung, never retry-into-ban.
- **Dream-consolidation at scale** — promote `agent/dreaming` from regex/threshold to real synthesis: merge duplicate skills, summarize stale memory, prune dead nodes (this also closes self-gap #2 and #3).
- A graph **carrying-capacity** guard: warn/prune when live-skill maintenance load exceeds budget.

### WHERE
- `packages/operator/src/maintenance/{health,repair,banDetect}.ts`; extend `packages/agent/src/dreaming.ts` and reuse `self/reflect.ts`.

### TEST
`tests/v5-maintenance.test.mjs`:
- A skill whose fixture now fails is detected `rotted` and queued for repair/prune.
- A ban signal triggers rung-switch + back-off, not retry.
- Dream-consolidation merges two near-duplicate skills into one.

### GOTCHAS
- Health checks cost tokens/time — schedule them as idle work (O10), prioritized by how many nodes depend on the skill.
- Auto-repair must re-verify before re-crystallizing, or you repair poison with poison.

### OP UPGRADE
Dependency-aware repair: when a foundational sub-skill rots, proactively re-verify everything downstream of it in the DAG before those capabilities are next used — fix the blast radius before it fires.

---

# O14 — Cold-start seeding + connector expansion

### WHY
Survive the valley of disappointment (C13) and broaden reach. A seeded graph skips relearning the obvious; staged connectors expand capability on earned leashes.

### WHAT
- **Seeding**: ship a starter graph — common method rungs (detect installed MCPs/CLIs/APIs and register them) + a handful of pre-crystallized starter skills (web-signup, http-json, file-scaffold). Crix begins several floors up.
- **Connector expansion in strict order**, each at leash=1: **deploy** (Vercel/Fly) → **analytics** (read metrics, feeds metric-kind verification) → **payments (test mode first, real last)**.
- An end-to-end demo mission spanning multiple capabilities (e.g. scaffold app → deploy → wire analytics) to prove the whole stack.

### WHERE
- `packages/operator/src/seed/*`; `packages/connectors/{deploy,analytics,payments}/`.

### TEST
`tests/v5-seed-connectors.test.mjs`:
- A fresh `~/.crix` seeds a non-empty graph; a seeded capability is used without a learning pass.
- The multi-capability demo mission completes with every outward effect audited in the ledger and every domain's leash earned, not granted.

### GOTCHAS
- **Payments real-mode is dead last**, only after the ledger, kill switch, irreversibility gate, and estate recovery are all battle-tested. The order is the safety.
- Seeded skills still get health checks — a seed can rot too.

### OP UPGRADE
Ship a `crix operator demo` that runs the end-to-end mission headless overnight and produces a filmstrip + trace report by morning — the single artifact that shows a skeptic the whole machine working while no one watched.

---

## Data schemas (the durable shapes)

```ts
// Goal — the long-horizon setpoint
interface Goal {
  id: string; statement: string;
  verification: VerificationSpec;          // how reality is measured (O3)
  missionIds: string[];                     // decomposition (reuse agent/mission)
  status: "active" | "blocked" | "done" | "abandoned";
  createdAt: string; updatedAt: string;
}

// Effect — the unit of touching the world (O2)
interface Effect<A=unknown,R=unknown> {
  kind: string; domain: string; args: A;
  cost: { tokens?: number; dollars?: number };
  irreversibility: "reversible" | "recoverable" | "irreversible";
  idempotencyKey: string;
  predict?: { outcome: string; p: number }; // calibration (O7)
  simulate(): Promise<R>; commit(): Promise<R>; undo?(): Promise<void>;
}

// CapabilityNode — competence (O4)
interface CapabilityNode {
  id: string; name: string;
  status: "want" | "learning" | "have" | "mastered" | "rotted" | "forbidden";
  subSkills: string[]; methods: MethodRung[];
  skillRef?: string; playbookRef?: string;
  outcomes: { ok: number; fail: number; lastError?: string; lastUsedAt?: string };
  novelDeltaHistory: number[];              // the smarter-over-time proof
}

// MethodRung — one way to satisfy a capability (O5)
interface MethodRung {
  kind: "api" | "mcp" | "cli" | "browser" | "skill";
  ref: string; available: boolean; reliability: number; lastCheckedAt?: string;
}

// TrustState — what it's allowed to do unsupervised (O7)
interface TrustState { leash: Record<string, { value: number; brier: number; samples: number }>; }

// EstateEntry — the crown jewels (O8)
interface EstateEntry {
  kind: "identity" | "account" | "key" | "asset";
  service: string; ref: string; provenance: string; recovery: string; createdAt: string;
}

// LedgerEntry — append-only audit (O2)
interface LedgerEntry { at: string; phase: "proposed"|"simulated"|"staged"|"committed"|"undone"; effect: Effect; result?: unknown; trace?: DecisionTrace; }
```

---

## The honest risks (do not paper over these)

1. **Model ceiling.** Today's best models (incl. GPT-5.5 / K2-1T / DeepSeek-V4 / GLM-5) still drift on open-ended long-horizon judgment. v5 is designed so the **only throttle is the leash**, which responds to calibration automatically — so Crix gets more autonomous *for free* as models improve, with no rebuild. Design for checkpointed autonomy now; widen the boundaries later.
2. **The adversarial, non-stationary world** (C10) means recurring maintenance cost and a real carrying capacity. Accept it; prune.
3. **The estate is a catastrophe surface** (C8/C9). Least-privilege, redaction, recovery export, and irreversibility-first rails are non-negotiable.
4. **Bad lessons compound** (O13). Crystallize only on verified-repeated success; keep skills narrow; maintain an immune system.
5. **The cold-start valley** (C13) is where faith dies. Seed the graph; make early progress visible; the payoff is back-loaded by nature.
6. **Legibility debt caps autonomy** (C12). If you skimp on traces/filmstrip/dashboards, you will never feel safe extending a leash, and the whole machine stalls at "impressive demo."

---

## Definition of done (v5)

- The Operator runs durably, survives reboot, and drives goals to **reality-verified** completion with the terminal closed.
- Every outward action flows through the Effect rails: simulated, gated by leash+irreversibility+budget, idempotent, audited, killable.
- The capability graph **compounds** — the novel-delta curve trends down, provably (O4 headline test), and a 500-session Crix beats a fresh one on the same model.
- Crix sees (DOM-first, vision-fallback), figures out *how* (method ladder + acquire), and proves what it did (filmstrip + traces).
- Trust is **earned per domain** and visible on a dashboard the user reads to decide when to walk away.
- The estate is auditable and recoverable; the persona stance is deliberate.
- It teaches itself email end-to-end and reuses what it forged on the next signup.
- 300+ tests green; `pnpm verify` clean.

When all of that holds, Crix is no longer a coding tool with a memory. It's an entity that converts uncertainty into competence, earns its own freedom, and gets measurably better every week — exactly the machine we set out to build.

Let's build it. 🛠️
