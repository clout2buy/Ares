# Ares: From a Library of Autonomy to a Running, Self-Closing Operator

## 0. Core diagnosis (the thing every phase is fixing)

Ares is **a reactive single-turn agent wearing the costume of an autonomous one.** The center — `QueryEngine.streamTurn` (packages/core/src/queryEngine.ts) — is genuinely excellent: dependency-aware tool batching, watchdog timeouts, four kinds of loop/oscillation/ceiling detection, microcompact → smart compaction → token budgeting, output-cap continuation, and an end-of-turn verification gate, all wrapped by append-only JSONL rollouts with resume (packages/core/src/session.ts). But it is excellent **for exactly one externally-triggered turn**, and everything that would make it autonomous is **built but not wired, gated behind an env var the desktop never sets, or wired to a process whose stdout goes to `/dev/null`.**

The fault is not missing machinery — it is the **absence of a single owned spine and a closed loop that ties the excellent parts together.** Three patterns recur in every subsystem (all verified in-tree during this analysis):

1. **Built-not-wired.** `@ares/operator` (packages/operator/src) is a ~5.4K-LOC durable-mission supervisor — `controlLoop.ts`, `attention.ts`, `probe.ts`, `standingOrders.ts`, `dispatcher.ts`, `learn.ts` — fully built and unit-tested. But `driveLearning` (learn.ts:58) has **zero non-dist call sites** (confirmed by grep), `enqueueEvent` has zero production producers, and the `OperatorBackgroundLoop` is off by default.
2. **Opt-in invariants guarding the spine.** `tauri/src-tauri/src/main.rs` sets `ARES_AGENT_ENABLED` but **never** `ARES_OPERATOR_LOOP` or `ARES_MIND_EMBED` (confirmed). The headline features are dormant by construction. The garrison process — which has the clean `SessionManager`/`Scheduler`/`OperatorBackgroundLoop`/`ApprovalQueue` spine — is spawned with `stdout(Stdio::null())` (main.rs:311) and its only WS client is the Telegram bridge. The desktop drives a *second* divergent stdin daemon (entry.ts:3042-4050, a 1008-line closure) that re-implements sessions worse and has none of the autonomy wiring.
3. **Record-don't-learn / diagnose-don't-act.** `reflect()` emits severity-ranked fix/acquire/prune directives that terminate in a diary the model is told to ignore. `dispatcher.defaultEvaluate` (dispatcher.ts:115) self-certifies recurring missions with a **regex** instead of a reality probe. `standingOrders.ts` creates goals with **no verification spec**.

Compounding this, the **conscience choke-point governs only the embedded browser**: `runEffect` is called at exactly three sites (entry.ts:2059/2070/2079, all Browser), `KillSwitch`/`Budget`/`Ledger` are constructed only in `browserRailsContext` (entry.ts:2113), and the genuinely dangerous hands — `Gmail.send`, `GoogleCalendar.delete_event`, `Connect.set_credentials` — are tagged `safety:'workspace-write'` (Gmail.ts:65, GoogleCalendar.ts:49, Connect.ts:56, all confirmed), which **auto-allows at _shared.ts:327** and structurally bypasses the unattended gate. And provider failover excludes the two most common unattended deaths: `isProviderFatalError` (entry.ts:2204, body confirmed) does **not** match 402 or `no_auth`, so the dead-provider retirement built for exactly "out of balance on DeepSeek" and "Anthropic signed out" (`isPermanentlyDeadError`, entry.ts:3115) never fires — and failover is wrapped only in the desktop daemon (3958), absent from headless paths (3026/4970/5330).

**The strategy:** build the safe substrate first (reliability, one spine, a *tested* gate), prove every irreversible effect is stoppable/budgeted/audited **before** any loop runs, then turn the closed loop on in **shadow mode** behind a UI leash with a 24-hour soak gate before any auto-approve, and only then widen the hands (real OAuth) and the lessons (compounding rules) — because hands and lessons are worth wiring only once there is a safe, observable loop to use them in.

---

## Phase −1 — Survive unattended (pure reliability, ships independently, no spine surgery)

**Why first:** this needs no spine surgery, makes the *existing* reactive Ares survive long unattended runs immediately (user-visible value in week one), and de-risks everything after. You never carve the monolith on a substrate that still silently dies on provider death. It moves the spine's reliability work earlier, where it pays immediately.

**Goal:** guarantee the engine cannot silently die mid-mission from the three most common unattended failures — provider death, crash-resume corruption, once-then-silent detectors — and ship it as a standalone reliability release.

**Workstreams (files named):**

- **Fix the failover gate.** In `packages/cli/src/entry.ts`, extend `isProviderFatalError` (line 2204) to match `402`, `insufficient.?balance`, and `no_auth`/signed-out. Today it matches `401|403|404|5xx|fetch failed` etc. but explicitly not 402/no_auth — so `isPermanentlyDeadError` (3115), which *does* match them, never gets a chance to retire the provider because the gate at 3958 never triggers on those codes. This is a one-regex fix to the exact deaths the retirement set was built for.
- **Make fallback liveness-aware, not key-present-aware.** `pickHealthyFallback` (entry.ts:2218) currently prefers by family/auth-presence. Pass and honor a `dead: ReadonlySet<string>` of providers that returned a balance/auth error **this session** (the parameter already exists in the signature) and skip them, so failover cannot hop to another dry provider and burn the 4-hop cap.
- **Lift failover into a shared helper.** Extract the failover wrapper currently inlined only at entry.ts:3958 into a reusable function (a precursor to the Phase-0 `agentRuntime.ts` extraction) and apply it at the headless/CLI call sites 3026, 4970, 5330 so `ares run` / Ink / TUI / scheduled headless runs all self-heal. Today a scheduled autonomous run dies on the first provider error with no self-heal.
- **Orphan-tool_use reconciliation on resume.** In `packages/core/src/session.ts`, add a pass to `messagesFromRollout` (425-478): for every assistant `tool_use` id with no matching `tool_result`, synthesize a `tool_result('interrupted before completion', is_error: true)` so crash-resume mid-turn stops sending history that providers 400 on.
- **Re-arm per-turn detectors.** In `packages/core/src/queryEngine.ts` (~842, `oscillationFired`), allow oscillation/identical-call/ceiling detectors to fire more than once per turn, so a pathology the model ignores can't recur unchecked through a long autonomous turn.
- **Sanitize cross-provider history.** Before a post-failover call, strip provider-specific thinking/reasoning signatures (not only tool-pair orphans), and seed `tokenScale` from real usage so the first long turn after a swap doesn't risk a `context_length` 400.

**Exit criteria (all in CI):**
- Scripted kill test: start a long turn on DeepSeek, simulate 402 mid-turn → run continues on Anthropic with **no human action**.
- `SIGKILL` the process mid-tool-call, restart → resume succeeds with **no provider 400**.
- Failover asserted present on `ares run` (headless), not just the desktop daemon.
- Injected runaway goal is halted by the re-armed oscillation detector.

---

## Phase 0 — One spine the desktop drives, guarded by a tested gate (the keystone)

**Why this is the biggest bet:** nothing observable or controllable exists until the desktop drives the garrison spine. This is the highest-risk move in the repo — it touches the chat path everyone depends on and the entry.ts monolith. Get it right and "turn on autonomy" becomes a one-line leash flip; get it wrong and you ship a *third* divergent daemon. We land the **effects-gate invariant test inside this same window** so the gate guards the carve-up itself.

**Goal:** make the garrison process the single runtime the desktop drives for **both** chat and operator control, so whatever acts is the thing the user is watching — and make it structurally impossible to ship a world-touching tool that bypasses the conscience. No autonomy turned on yet; this phase only unifies the substrate, makes it observable, and erects the gate.

**Workstreams (files named):**

- **Carve `packages/core/src/agentRuntime.ts` out of the 7639-line `entry.ts`.** Extract `buildSystemPrompt`, tool factories, provider/routing selection, the `requestPermission` gate, and reflection wiring into one composable `AgentRuntime`. `daemonCommand` (entry.ts:3042-4050) and `garrisonCommand` (6885-7012) then compose the **same** runtime instead of two near-copies with divergent permission/failover gates. **Do this incrementally — one factory at a time — with the existing 713 tests as the guardrail.** This is the enabling carve-up; everything downstream depends on "wire once, true everywhere."
- **Stop the `/dev/null` pipe.** In `tauri/src-tauri/src/main.rs`, change the garrison child from `stdout(Stdio::null())` (line 311) to a piped reader and forward its NDJSON lifecycle stream onto the Tauri event bus exactly like the daemon stream, so operator/lifecycle events reach `App.tsx`.
- **WS-drive the desktop.** Add a thin `ws://` client in `tauri/src` (or proxy through Rust) so `App.tsx` connects to the `GarrisonServer` WS gateway that today only the Telegram bridge uses. Route `ares_send` chat through the garrison `SessionManager` instead of the 1008-line stdin-daemon closure. Route staged-effect **approvals** over this same WS channel (the `ApprovalQueue` at entry.ts:7010 currently has no UI peer, so approvals hang or auto-deny).
- **Demote the stdin daemon.** Make `daemonCommand` a deprecated thin shim that delegates to the garrison runtime, or delete its re-implemented session handling, so there is exactly one session/permission/observability policy.
- **Reconcile resume history end-to-end** (carried from Phase −1; verify it holds across the new single-spine path).

**The tested effects-gate invariant (the single most valuable graft — land it here):**

- **Generalize the rails context.** Turn `browserRailsContext` (entry.ts:2113) into `effectsRailsContext(domain)` in `@ares/effects` so any tool can obtain the same `ledger`/`budget`/`killSwitch`/`leash`/`requestApproval` bundle — one constructor, not browser-only. Construct **one global `RailsContext`** at runtime startup in `agentRuntime.ts`.
- **Add `EffectSpec` factories for the non-browser hands** in `packages/effects/src/effectKinds.ts`: `emailSendEffect`, `calendarMutateEffect`, `credentialWriteEffect`, `httpPostEffect`, `shellWriteEffect` — each with a **real `simulate()` that returns real artifacts** (Gmail send → rendered RFC2822 preview; calendar delete → the fetched event being deleted) and correct `irreversibility`/`domain`/`cost`.
- **Re-tag the dangerous tools to their true class.** `Gmail.ts:65` `send` → `external-state`; `GoogleCalendar.ts:49` `delete_event`/`create_event` → `external-state`; `Connect.ts:56` `set_credentials`/`disconnect` → `external-state`. Apply **per-action safety**: Gmail `list`/`search` stay read-only; only `send` escalates. Add `classifyToolRequest` cases (policyGate.ts:132) so these reach `requestPermission` and the unattended gate instead of falling to `default:null` and auto-allowing at `_shared.ts:327`.
- **Write `packages/effects/src/__tests__/effects-gate.invariant.test.ts`.** Enumerate the live tool registry; assert **every** tool whose `safety` is `external-state` or `destructive` EITHER emits an `EffectSpec` through `runEffect` OR has a `classifyToolRequest` case that is hard-blocked/staged when unattended. Add a second invariant: `gateToolPermission(req, { attended: false })` returns `deny` for every hard-blocked category. **The test must go RED if a future tool is added without wiring it through the gate, or if Gmail.send is mis-tagged back to `workspace-write`.** This converts "route dangerous effects through `runEffect`" from a one-time wiring task into a permanent structural guarantee a future engineer cannot merge around.

**Exit criteria:**
- Desktop chat and operator status both flow over **one** garrison WS connection; garrison lifecycle/operator NDJSON appears on the Tauri event bus (no `/dev/null`).
- A deliberately crashed mid-turn session resumes without a provider 400; the stdin daemon no longer owns an independent session implementation.
- `pnpm test` includes the invariant suite and it is **GREEN**; mis-tagging `Gmail.send` back to `workspace-write` makes it **RED**.
- Under `attended:false`, `Gmail.send` / `Calendar.delete` / `Connect.set_credentials` are **DENIED** at the gate; under the desktop attended posture they **STAGE** through `runEffect` with a `simulate()` preview rather than auto-committing.
- **ProveSafe:** killing the garrison process and restarting reproduces identical session state from rollouts.

---

## Phase 1 — Build the conscience choke-point over ALL effects (proven, not prose)

**Why before any loop:** every irreversible capability must be stoppable, capped, and audited **before** a continuous loop is allowed to run. Phase 0 made the gate *exist and be tested*; Phase 1 makes it *enforce kill-switch + budget + ledger over the full dangerous surface* so autonomy is safe to switch on. Because the invariant from Phase 0 is now CI-enforced, this widening is guaranteed-by-test, not hoped-for.

**Goal:** route every dangerous effect through `runEffect` with a global kill switch, a mission-level budget, and an append-only ledger — and make a runaway unattended action structurally impossible to complete.

**Workstreams:**

- **Route the full dangerous surface through `runEffect`:** mail send / calendar mutate / connector `set_credentials` / shell write / payments / deploy / desktop-control (`ComputerUse`) — using the generalized `effectsRailsContext(domain)`. Today only Browser navigate/fill/click reach `runEffect`.
- **One global `KillSwitch` file** honored by every `runEffect` call **and** by the operator loop's `paused()` gate, surfaced as a desktop **PANIC STOP** button that halts ticks **and** refuses in-flight effects within one tick. Wire `ARES_OPERATOR_AUTOTICK=0` semantics to the same switch.
- **Mission-level `Budget`** (tokens + dollars + wall-clock) enforced in the `QueryEngineDispatcher` step and decremented per turn; a goal that exhausts budget **halts and escalates** rather than looping. Pass a real `Budget` into `effectsRailsContext` from the operator mission so an unattended run cannot exceed a spend ceiling.
- **Append-only `Ledger`** (who/what/when/cost/idempotency-key) for every effect, rendered in a desktop **Audit panel**; add **idempotency** so a resumed mission does not re-send a mail it already sent.
- **Per-domain trust leash:** wire `resolveLeash`/`ownerLeash` (rails.ts:170) so the owner can pull back specific domains (e.g. `spend:*` → ask) from the desktop. Default wide-open for reversible/local, staged for irreversible/external when unattended.

**Exit criteria:**
- Every dangerous tool call passes through `runEffect` and lands in the ledger; flipping the kill switch halts ticks and refuses in-flight effects within one tick.
- A mission exceeding its dollar/token/wall-clock budget halts and escalates; a `Gmail.send` by the unattended loop is **DENIED** (no longer auto-allowed).
- **ProveSafe:** a scripted runaway goal that tries to send 100 emails is stopped by budget+killswitch with a complete ledger trail and **zero duplicate sends after a forced restart**.

---

## Phase 2 — Turn the loop ON behind a visible leash, in shadow mode, with real verification

**Why now and not earlier:** only after the substrate is unified (Ph0), the gate is tested (Ph0), and every irreversible hand is kill-switchable/budgeted/audited (Ph1) is it safe to light the continuous loop. We turn it on in **shadow mode** — every effect is a human-approved card — and earn the auto-approve dial by a **24-hour soak with zero auto-executed irreversible effects.** Autonomy widens by proof, not by faith.

**Goal:** light the closed loop — `OperatorBackgroundLoop` ticks while idle, driving attention-ranked goals through `tickGoal → QueryEngineDispatcher → streamTurn`, verifying with reality probes — gated by a **UI trust-leash, not an env var.**

**Workstreams:**

- **Replace the `ARES_OPERATOR_LOOP` env gate with a persisted trust-leash setting** the desktop writes (`off` / `shadow` / `leashed-autoapprove-within-budget`); the garrison loop reads it each tick. `main.rs` no longer sets a magic env var — autonomy is a UI dial.
- **Replace `defaultEvaluate`'s regex** (dispatcher.ts:115) with `runProbe` verification: require a `VerificationSpec` on every goal and standing order (`standingOrders.ts` omits it today — confirmed no `verification`/`probe` references) — default to a report-delivered/file/command/http probe so recurring missions stop self-certifying on the model saying "goal met." Make it impossible to create a standing-order goal without a verification spec.
- **Wire `enqueueEvent` to real sources** (it has zero production callers today): session-end, inbound Telegram/webhook, scheduler heartbeat, deploy/email arrival — so the loop is event-first, not just an interval timer. The `Scheduler` already supports event wakes.
- **Re-arm per-turn detectors** within a long autonomous turn (carried from Phase −1; verify under continuous operation) so a runaway tick self-halts.
- **Shadow mode first:** in shadow, every effect the loop wants becomes an `ApprovalQueue.pending` item rendered in the desktop with one-click approve/deny over the Phase-0 WS approval spine, with the `simulate()` artifact shown. Only after the soak does the leash allow auto-approve within budget for reversible/low-risk effects.

**Exit criteria:**
- With the desktop open and idle, the loop advances a real durable goal end-to-end and a `runProbe` verifies completion against reality (file/command/http/report), not regex.
- A standing order materializes, runs, and self-certifies **only** via probe; an inbound event (session-end) wakes a tick without waiting for the interval.
- In shadow mode every effect surfaces as an approvable card answerable from the desktop, showing the `simulate()` preview.
- **ProveSafe (the gate that earns auto-approve):** a **24-hour shadow-mode soak** produces **zero auto-executed irreversible effects**, every proposed effect is human-resolved, and the oscillation detector halts an injected runaway goal. Passing this soak unlocks the `leashed-autoapprove-within-budget` dial for reversible/low-risk effects only.

---

## Phase 3 — Close diagnose→act→verify→learn and survive provider death everywhere

**Why now:** the loop is running, observable, and safe. Now make it **compound.** Lessons and repairs are only worth wiring once there is a safe loop to use them in. This phase closes the learning loop and finishes provider survival on every path.

**Goal:** high-severity `reflect()` directives drive an actual bounded repair that is probe-verified before being recorded as learned, learning output compounds as LLM-phrased rules, and the mission survives the two most common unattended deaths on every code path.

**Workstreams:**

- **Autonomous directive executor.** Consume high-severity fix/acquire/prune directives from `reflect()` (today they only print — dreaming.ts:127-143, heartbeat.ts:70-89) and dispatch a bounded `SkillCraft`/`SelfEvolve` attempt via `driveLearning` (learn.ts:58, **zero call sites today** — confirmed), gated by budget+killswitch+approval.
- **Verify before learn.** A crafted skill or `SelfEvolve` edit is recorded as a "have" capability **only** after a successful probe-verified run.
- **Skill sandboxing (hard requirement).** Self-authored skill handlers must run with a **capability-scoped env**, never the parent env with `ANTHROPIC_API_KEY`/secrets.
- **SelfEvolve diff + backup + rollback (hard requirement).** `replace_file`/`replace_section` must write a diff + backup before overwriting a brain file (today: only a byte-count audit line). A bad edit must be reversible.
- **Learn produces RULES, not scars.** When a repair/mission succeeds or fails in a recurring way, synthesize an **LLM-phrased rule** ("when deploying to X, always Y first") stored in a **recall-eligible memory tier** — not a templated token-bag. Keep Witness "candidate" nodes **out of recall** until a Crucible trial confirms them. **Stop persisting raw tool stderr verbatim** as recallable memory; distill it.
- **Finish provider survival on every path.** Verify the Phase −1 failover (402/no_auth, liveness-aware, headless-wrapped) holds inside the now-running loop, and that cross-provider history sanitization covers reasoning artifacts, not just tool-pair orphans.

**Exit criteria:**
- A high-severity `reflect()` directive triggers a bounded, budget-capped repair whose outcome is **probe-verified and only then recorded as learned** (diagnose→act→verify→learn closed).
- A standing-order mission that "completes" is **rejected** by its reality probe when the world didn't actually change.
- After a mission fails a recurring way, a later mission **recalls the LLM-phrased rule** and avoids the failure.
- A self-authored skill **cannot read `ANTHROPIC_API_KEY`**; a bad `SelfEvolve` edit is restored by rollback; raw stderr no longer surfaces in recall.
- Inject a 402 mid-mission on a **headless** run → the mission completes via failover.

---

## Phase 4 — Real OAuth hands, the cockpit, and long-horizon memory

**Why last:** real account hands and a full cockpit are only worth building once there is a safe, observable, running loop to use them in. This is where Design 2's complete OAuth program and Design 1's cockpit/memory work bolt on.

**Goal:** make autonomy commissionable/observable/correctable from the desktop, give Ares consumer-grade one-click real-account hands the agent can self-extend mid-mission, and give long missions a durable, well-selected memory spine.

**Workstreams:**

- **Cockpit control verbs on the garrison WS spine + HELM UI:** `operator_create`/`cancel`/`pause`, a standing-orders slate (add/enable/disable), the trust-leash dial, a live mission view with a **STOP** button, and a memory **inspect/forget** panel — replacing the ~2 verbs (status, autotick) HELM exposes today against a 100+ symbol operator package.
- **Make the desktop ANSWER staged approvals:** the existing `permission` HUD item (App.tsx:1388) becomes a live approval responder backed by `ApprovalQueue.requestApproval` (entry.ts:7010), showing the `simulate()` artifact. Allow → commits once via idempotency key; deny → ledger "rejected."
- **Semantic memory in the default loop:** default-enable a bundled local embedder (drop the never-set `ARES_MIND_EMBED` gate, unifiedRecall.ts:38) or pass `corpusIdf` into live `remember()` (store.ts:374) so recall stops degrading to flat token overlap when phrasing differs.
- **Pinned, never-compacted working-memory/plan block:** emit a fragment with `tier:'working'` (the compiler's top tier has **no producer** today) carrying the mission's plan + open-loops, and route recall through the budget compiler instead of a separate un-budgeted reminder (entry.ts:5859 vs context.ts:108) so the mission spine survives compaction intact.
- **Memory hygiene pass** surfaced in the inspect/forget panel so the owner can correct or prune what the loop learned.

**Exit criteria:**
- A user commissions, pauses, and cancels a mission and sets a standing order entirely from the desktop with a working STOP button.
- A non-technical owner connects an account in **one click** (see the OAuth section below) with zero pasted credentials.
- Semantic recall surfaces a relevant prior fact under different phrasing; a multi-hour mission spanning several compactions never loses its top-level plan; the owner can inspect and forget a learned fact.
- **ProveSafe:** every autonomous action remains haltable from the cockpit STOP button across a multi-compaction mission.

---

## Real OAuth & Connector Framework (replacing the URL+key fake)

**What's broken today (verified in-tree):** `packages/core/src/oauth.ts` builds `response_type=code` with **no `code_challenge`** and `exchangeCodeForTokens` sends `client_secret` (lines 72, 126, 148). `oauthProviders.ts` ships **zero `defaultClientId`s** (confirmed: no matches for `defaultClientId`/`publicClient`). So a non-technical owner must register a developer app and paste `client_id`+`secret` **per provider** (App.tsx:5472-5480 literally instructs this), and the agent itself dead-ends on `OAUTH_NOT_AUTHORIZED` because `Connect.ts` has no `authorize` verb. The existing pieces are good — `oauthCallback.ts` runs a loopback redirect server, the daemon already has `oauth_start`/`oauth_set_credentials`/`oauth_disconnect` — they're just the wrong shape.

**What a real desktop OAuth2 flow requires:** a **PKCE public-client authorization-code flow**. The client generates a high-entropy `code_verifier`, derives `code_challenge = BASE64URL(SHA256(verifier))`, sends `code_challenge` + `code_challenge_method=S256` on the authorize URL, opens the system browser to the consent page, receives the `code` on a loopback redirect, and exchanges `code` + `code_verifier` (**no `client_secret`**) for tokens. PKCE proves possession of the verifier so a public client needs no shipped secret. The `client_id` is **not** a secret — Ares can ship its own per provider.

**How to build it here:**

1. **Convert `oauth.ts` to PKCE.** Add `code_verifier`/`code_challenge` (S256) generation; `buildAuthorizeUrl` gains `code_challenge` + `code_challenge_method=S256`; `exchangeCodeForTokens` sends `code_verifier` and **omits `client_secret`** when the provider config is `publicClient:true`. Thread the verifier through `startOAuthFlow` (oauthCallback.ts) so it is generated per-flow and matched on callback alongside the existing `state`.
2. **Extend `OAuthProviderConfig`** with `publicClient?:boolean` and `defaultClientId?:string`; populate `defaultClientId` for the providers that support pure-PKCE public clients (Google desktop, GitHub, Spotify, Reddit, Twitch, Notion). Resolve `client_id` as: vault override → `config.defaultClientId` → error. No secret on the PKCE path.
3. **Ares-owned default client_ids.** Register Ares-owned OAuth apps per provider; ship their **client_ids** (public) in `oauthProviders.ts`. This collapses the 11-provider developer-console chore into one click.
4. **Hosted token-exchange proxy for confidential providers** (~150 LOC Cloudflare Worker in `services/oauth-proxy/`): endpoints `POST /exchange` and `POST /refresh` that hold the Ares-owned `client_secret` **server-side**, accept `{provider, code, code_verifier, redirect_uri}` (or `refresh_token`), perform the token POST, and return **only** the resulting tokens to the loopback caller. **Stateless — never persists tokens, and the PKCE verifier still flows so the proxy cannot mint tokens without the user-completed flow.** Add `tokenExchangeVia?: 'direct'|'proxy'` per provider; when `proxy`, exchange/refresh POST to `ARES_OAUTH_PROXY_URL` (defaulted, overridable). Secrets live only in the proxy env — **grep the desktop build for any `*_OAUTH_CLIENT_SECRET` literal must return nothing.**
5. **Harden the callback server** (oauthCallback.ts): bind a random free port (not fixed `53691`) and whitelist the loopback range in the Ares-owned apps, or use a single fixed loopback path the registered app whitelists; enforce `state` + verifier match.
6. **Agent-callable `authorize` verb.** Add `authorize` to `Connect.ts`'s action enum: call the daemon's `oauth_start` path (or `startOAuthFlow` directly) so the agent can request a connection **mid-mission** and surface the consent URL (desktop browser-open or Telegram inline button) instead of dead-ending on `OAUTH_NOT_AUTHORIZED`.
7. **Post-connect read self-test.** After connect, `Connect` runs a minimal read call (Gmail profile / Calendar primary) and reports verified-vs-stored, so a broken scope/app surfaces immediately, not at first mission use. Telegram `/connect` (packages/channels) drives the same proxy/PKCE path.
8. **Rewrite the App.tsx connect pane (5424-5486):** default path is a single **Connect** button per service that calls `oauth_start`; demote the client_id/secret paste form to an "Advanced: use my own OAuth app" disclosure for confidential-only providers.

**Exit criteria:** connecting Google/GitHub/Spotify is one click, zero pasted credentials; the loopback callback completes and tokens persist encrypted via the vault; `getValidAccessToken` auto-refreshes on the PKCE path with no stored secret; a unit test drives `buildAuthorizeUrl → exchangeCodeForTokens → refresh` with an injected fetch asserting `code_challenge`/`code_verifier` present and `client_secret` absent for public-client providers; all 11 providers connect with no owner-side developer-console work; `Connect{action:'authorize',provider:'google'}` produces a consent URL event rather than throwing.

---

## The tested effects-gate invariant (the structural safety guarantee)

This is the single most valuable artifact in the plan. It converts "route dangerous effects through `runEffect`" from a one-time wiring task a future engineer can forget into a **permanent structural guarantee CI enforces.**

`packages/effects/src/__tests__/effects-gate.invariant.test.ts`:

1. **Enumerate the live tool registry** (the same registry the runtime composes, not a hand-maintained list — so new tools are auto-covered).
2. **Assert** every tool whose `safety` is `external-state` or `destructive` **either** emits an `EffectSpec` through `runEffect` **or** has a `classifyToolRequest` case that is hard-blocked/staged when unattended. The test fails if a future tool is added without one of these.
3. **Deny-by-default assertion:** `gateToolPermission(req, { attended: false })` returns `deny` for **every** hard-blocked category.
4. **Regression guard:** mis-tagging `Gmail.send` back to `workspace-write` flips the suite RED.

Because the registry is enumerated rather than listed, **a future engineer literally cannot merge an off-gate hand** — CI goes red. This makes the choke-point structural, not hopeful, and it is landed in the Phase-0 window so it guards the carve-up itself.

---

## How the autonomy loop closes safely

The closed loop already exists in pieces: `OperatorBackgroundLoop` drives `tickGoal` (SENSE→ORIENT→DECIDE→ACT→VERIFY→LEARN→PERSIST), `QueryEngineDispatcher` bridges a goal step into `streamTurn`, `materializeDueStandingOrders` feeds it work, `runProbe` grounds verification, and `ApprovalQueue` + `KillSwitch` + `Budget` + `Ledger` form a conscience. The plan closes it **safely** by enforcing, before any continuous operation, that every irreversible capability is:

- **(a)** routed through `runEffect` (Phase 0/1, CI-enforced by the invariant),
- **(b)** revocable by one always-honored kill switch (Phase 1 PANIC STOP),
- **(c)** capped by a mission-level token/dollar/wall-clock budget (Phase 1),
- **(d)** auditable in the append-only ledger with idempotency (Phase 1),
- **(e)** crash-resumable with reconciled history (Phase −1).

Then the loop **earns** wider autonomy by proof: it runs in **shadow mode** (every effect a human-approved card) and only opens the `leashed-autoapprove-within-budget` dial after a **24-hour soak with zero auto-executed irreversible effects** (Phase 2). Verification is by **reality probe**, never regex (Phase 2). Learning closes diagnose→act→**verify**→learn — a repair is recorded as a capability only after a probe-verified run, banked as an LLM-phrased rule the next mission inherits (Phase 3). Autonomy widens by **soak, not by faith.**

---

## Sequencing rationale

1. **Phase −1 (reliability)** ships independently in week one — no spine surgery — and de-risks everything by ensuring you never carve the monolith on a substrate that still silently dies.
2. **Phase 0 (one spine + tested gate)** is the keystone: nothing is observable or controllable until the desktop drives the garrison spine, and the invariant test must guard the carve-up *as it happens*.
3. **Phase 1 (conscience over everything)** must precede any continuous loop — every irreversible hand kill-switchable/budgeted/audited first.
4. **Phase 2 (loop on, shadow mode)** is the first time autonomy runs, and only behind a UI leash with a soak gate.
5. **Phase 3 (compound + survive)** and **Phase 4 (real hands + cockpit + memory)** bolt onto the now-running, safe, observable loop last — because hands and lessons are only worth wiring once there is somewhere safe to use them.

**Value lands early and compounds:** reliability in week one, an observable cockpit in week two or three, proven-safe autonomy that widens by soak, then real-account hands and compounding rules.

---

## Risks and mitigations

- **Carving `entry.ts` (7639 lines) reroutes the chat path everyone depends on.** *Mitigation:* incremental extraction, one factory at a time, with the existing 713 tests as guardrail; Phase −1 reliability lands first so you carve on a non-dying substrate; the WS chat path runs in parallel with the deprecated stdin shim until proven at parity.
- **Shipping a third divergent daemon if Phase 0 goes wrong.** *Mitigation:* the explicit goal is *fewer* spines — demote/delete the stdin daemon's session impl; exit criterion requires "exactly one session/permission/observability policy."
- **The OAuth proxy becoming a token-replay liability.** *Mitigation:* stateless, holds only the client_secret, never persists tokens, returns tokens only to the loopback; PKCE verifier still flows so the proxy cannot mint tokens without the user-completed flow; graceful degradation to "Advanced: own app" if the proxy URL is unreachable.
- **Self-evolving skills exfiltrating secrets or bricking a brain file.** *Mitigation:* capability-scoped sandbox env (no `ANTHROPIC_API_KEY`) and mandatory diff+backup+rollback as **hard requirements** on the directive executor, plus verify-before-record.
- **Shadow-mode soak being skipped under pressure.** *Mitigation:* the auto-approve dial is *gated by* the soak result — it is not a setting a human flips, it is unlocked by a passing 24h zero-irreversible-auto-execution run.
- **The invariant test being weakened to make CI green.** *Mitigation:* the test enumerates the live registry (not a maintained list) and includes a self-regression check (mis-tagging Gmail.send must go RED), so weakening it is itself visible in the diff.

---

# Appendix A — Ranked Autonomy Blockers (from the audit)

1. **[critical] No autonomous driving loop above the engine — every production turn is externally triggered and returns after one turn; nothing re-invokes streamTurn to pursue a long-horizon mission.**
   - Why it caps autonomy: This is the ceiling on ALL autonomy. The engine primitives (appendWorkItem, completed-status ends, graceful ceiling) exist but the loop-above-the-loop that would emit successive work items toward a goal was never built. Without it, Ares cannot move while you are gone; it can only respond when poked. Every other autonomy feature is downstream of this missing driver.
   - Evidence: queryEngine.ts streamTurn returns on end_turn/ceiling/interrupt; only production callers are user/Telegram message handlers; heartbeat.ts:52-68 emits text alerts only and never calls streamTurn/appendWorkItem; appendWorkItem callers are only forkedTurn.ts:64 and gauntlet.ts (one-shot).
2. **[critical] Background autonomy is OFF by default and the desktop never enables it; the one process that CAN run it emits to /dev/null.**
   - Why it caps autonomy: Even though @ares/operator (control loop, standing orders, reality probes, attention ranker) is fully built, the Tauri shell sets neither ARES_OPERATOR_LOOP nor ARES_OPERATOR_AUTOTICK (verified: zero matches in main.rs). The daemon autotick is gated off; the garrison loop runs but its NDJSON lifecycle is discarded. So durable goals and standing orders sit on disk and never advance unattended in the shipped product, and the user sees nothing.
   - Evidence: tauri/src-tauri/src/main.rs sets only ARES_AGENT_ENABLED/ARES_HOME (no ARES_OPERATOR_LOOP, confirmed by grep); entry.ts:3331 operatorLoopEnabled() strict gate; garrison stdout=Stdio::null (main.rs:310-312); backgroundLoop.ts:49-52 default OFF.
3. **[critical] Two divergent daemon spines; the desktop drives the wrong one. The clean, rehydratable GarrisonServer/SessionManager/Scheduler/OperatorBackgroundLoop/ApprovalQueue runs as an orphan side-process the UI never connects to, while chat goes through a 1008-line stdin-daemon closure that re-implements sessions worse and has no Scheduler/dream/approval wiring.**
   - Why it caps autonomy: All autonomy machinery (heartbeat, dream, operator loop, staged-effect approvals) is wired into the process whose output is thrown away; the process the user actually drives has none of it. This forks behavior, permission policy, and observability into two incompatible halves and guarantees that whichever process acts, the user is watching the other.
   - Evidence: main.rs:298 spawns garrison with stdout=null; App.tsx has zero ws:// client (uses invoke('ares_send') against stdin daemon); daemonCommand entry.ts:3042-4050 has no Scheduler/ApprovalQueue; garrisonCommand entry.ts:6925-7012 has the full wiring.
4. **[critical] Connector safety holes + fake-turnkey OAuth: Gmail(send)/GoogleCalendar(delete)/Connect(set_credentials) are mis-tagged workspace-write so they auto-allow and STRUCTURALLY BYPASS the unattended gate; and every provider requires the owner to register their own developer OAuth app and paste client_id+secret.**
   - Why it caps autonomy: Two-sided cap. On safety: the unattended operator loop can send mail, mutate calendars, and store/delete OAuth credentials with nobody watching — exactly what the hard-deny exists to prevent — because these tools never reach requestPermission. This forces the unattended gate to stay paranoid (denying even benign 'email me a summary'), narrowing real autonomy. On capability: connections are not consumer-grade; a non-technical owner cannot actually connect 11 accounts, so the act-through-real-accounts pitch is gated on developer-console toil.
   - Evidence: Gmail.ts:65/GoogleCalendar.ts:49/Connect.ts:56 safety:'workspace-write'; _shared.ts:327 auto-allows workspace-write in workspace-write mode; classifyToolRequest has no case for these tools; App.tsx:5472-5480 'register an OAuth app... paste its credentials'; oauthProviders.ts ships no default client ids.
5. **[high] Provider failover misses the two most common unattended deaths and is absent from headless paths. isProviderFatalError (line 2204) excludes 402/no_auth, so the dead-provider retirement (isPermanentlyDeadError, line 3115) — built for exactly 'out of money on DeepSeek' and 'Anthropic signed out' — never fires; and failover is wired only in the desktop daemon, not in `ares run`/Ink/TUI.**
   - Why it caps autonomy: Unattended operation requires surviving provider death without a human re-adding a key. The system was explicitly built to do this, but the gate that triggers failover excludes the precise codes the retirement set handles, and any headless/scheduled autonomous run has zero failover. A long mission dies the moment its provider runs out of credit or token expires.
   - Evidence: isProviderFatalError entry.ts:2204 lacks 402/no_auth; gates loop at entry.ts:3958; isPermanentlyDeadError entry.ts:3115 only runs inside that loop at 3975; failover wrapped only at 3958, absent at entry.ts:3026/4970/5330.
6. **[high] Diagnose-don't-act: the learning/reflection layer produces well-scored directives but no path consumes them to change behavior; recurring missions self-certify via regex instead of reality probes.**
   - Why it caps autonomy: Genuine autonomy requires the agent to get better and to honestly verify its own work. reflect() emits severity-ranked fix/acquire/prune directives that only become diary text or 'do not act on this' alerts; driveLearning is never called; standing-order goals are created with no verification spec so they complete on a regex matching the model saying 'goal met'. The anti-hallucination guarantee is absent on the main autonomous path, and self-improvement never closes its loop.
   - Evidence: dreaming.ts:127-143 / heartbeat.ts:70-89 only print directives; learn.ts:58 driveLearning has zero CLI call sites; standingOrders.ts:146 omits verification; dispatcher.ts:115-120 defaultEvaluate regex.
7. **[high] Memory selection silently degrades: semantic recall and IDF-weighting are dormant, recall bypasses the budget compiler, and the compiler's top-priority 'working' tier has no producer.**
   - Why it caps autonomy: Long-horizon autonomy needs durable, well-selected continuity. ARES_MIND_EMBED is never set so recall is flat token-overlap; corpusIdf is never passed into live remember(); recalled memory injects as a separate un-budgeted reminder block while the compiler's marquee 'protect live working state' tier is always empty. Relevant prior knowledge silently fails to surface when phrasing differs, and there is no pinned plan/working-memory that survives compaction intact — so missions lose their spine as detail is shed.
   - Evidence: unifiedRecall.ts:38 embed gated off (no default env); store.ts:374 remember without corpusIdf; entry.ts:5859 un-budgeted reminder vs identity/context.ts:108 budgeted blocks; no fragment emitted with tier:'working'.
8. **[high] The conscience layer (kill switch, budget, idempotency, audit ledger) governs ONLY the embedded browser; mail, payments, deploys, desktop control, and shell writes bypass runEffect entirely.**
   - Why it caps autonomy: Trustworthy unattended action requires a real choke-point with a panic stop and an audit trail over the dangerous surface. As shipped, the only thing that flows through runEffect is clicking a web page; the genuinely irreversible capabilities have no kill switch, no spend cap, and no ledger. You cannot safely widen autonomy over actions you cannot stop or audit.
   - Evidence: runEffect callsites only at entry.ts:2059/2070/2079 (Browser navigate/fill/click); KillSwitch/Budget/Ledger constructed only in browserRailsContext (entry.ts:2116-2118).
9. **[high] The desktop face is a read-only dashboard: autonomy can only be started by typing a magic chat phrase, and there is no UI to commission/pause/cancel a mission, set a standing order, adjust the trust leash, or inspect/correct memory.**
   - Why it caps autonomy: Even if the background loop were on, the user cannot drive it. HELM exposes ~2 operator verbs (status, autotick toggle) against an operator package of 100+ symbols; missions render as static progress bars with no stop button. Autonomy you cannot commission, observe, or safely halt is autonomy you cannot trust or use — which forces the user back into chat for everything.
   - Evidence: App.tsx HELM only onClick handlers are onRefresh/onToggleAutotick/onOpenSession; createGoal reachable only via in-agent Operator tool (entry.ts:1569); no operator_create/cancel/pause or standing_orders_* daemon command; 'Stelae of Memory' lists sessions, not facts.
10. **[high] Resume-after-crash can send malformed history (orphan tool_use with no tool_result), and per-turn detectors fire once-then-go-silent.**
   - Why it caps autonomy: Reliable long-running operation must survive process death. messagesFromRollout has no reconciliation pass, so a crash mid-turn yields assistant tool_use blocks with no matching results, which most providers 400 on the next call — breaking resume exactly when it matters. Compounding this, each loop/oscillation detector fires at most once per turn, so a pathology the model ignores can recur unchecked for the rest of a long turn.
   - Evidence: session.ts:425-478 messagesFromRollout has no orphan-tool_use reconciliation; queryEngine.ts:842-843 one-shot detector flags; oscillationFired never re-arms within a turn.

---

# Appendix B — Completeness Critique (gaps to fix BEFORE lighting the loop)

Confirmed. The plan is accurate in-tree. Here is the critique.

---

# Completeness Critique: Gaps, Errors, and Hand-Waving

The plan is unusually rigorous and its diagnosis is correct. The sequencing logic (reliability → spine → gate → loop-in-shadow → compound → hands) is sound and I would not reorder the phases. What follows is what it **misses, gets subtly wrong, or leaves too vague to build from.** Prioritized.

## P0 — Safety/correctness gaps that can bite during the plan itself

1. **The kill switch is described as a file but never specified as crash-safe or atomic.** "One global KillSwitch file honored by every runEffect" — but a file-based switch read per-tick has a TOCTOU window: an effect can pass the check, then the user hits PANIC during the in-flight provider call. The plan claims "refuses in-flight effects within one tick" but gives no mechanism. Concretize: the switch must be checked *immediately before commit* (post-simulate, pre-side-effect), not only at tick entry, and the commit path must be a single guarded function. Also specify what happens to an effect that already committed when PANIC fires mid-batch (the ledger needs a `partial-batch` state). This is load-bearing for every ProveSafe criterion and currently hand-wavy.

2. **Idempotency keys are asserted but their derivation is undefined — and a wrong key is worse than none.** Phase 1 says "idempotency-key … so a resumed mission does not re-send a mail." But if the key is derived from mutable content (recipient + body), a legitimate re-send (two real emails to the same person) is silently swallowed; if derived from a turn counter, resume after compaction collides. Specify: key = hash(missionId + goalId + effectOrdinal + simulateArtifactHash), persisted in the ledger *before* the side effect, checked on replay. Without this spec, "zero duplicate sends after restart" is untestable.

3. **The orphan-tool_use reconciliation handles crash mid-turn but not the failover mid-batch case.** Phase −1 synthesizes `tool_result('interrupted')` for orphan `tool_use` on *resume*. But the more common live failure is a provider dying mid-batch with **some** tool_results already produced and others not — that history is sent immediately on the failover call (no restart, so `messagesFromRollout` never runs). The sanitization must also run in-memory on the message array before the post-failover call, not only on rollout rehydration. The plan mentions "sanitize cross-provider history" but scopes it to thinking signatures; the orphan-pairing fix needs the same in-memory application. **This is a real bug the plan will leave open.**

4. **No spend cap on the verification probes themselves.** `runProbe` (http/command/report) and the post-connect read self-test are effects too. An LLM-judged "report-delivered" probe calls a model. Under a runaway goal, the *verification* path can burn budget/tokens independently of the action path. The Budget must wrap probes and the directive executor's SkillCraft attempts, not just `streamTurn` turns. Not addressed.

## P1 — Capability/wiring gaps the plan skips

5. **The two-daemon problem during Phase 0 has no rollback or parity gate.** The plan says "run in parallel until proven at parity" but defines no parity check. You need an explicit shadow-comparison: route a chat through *both* the stdin daemon and the garrison WS for a soak window and diff session state / tool outcomes before demoting the stdin path. Without a concrete parity assertion, "demote the stdin daemon" becomes a leap of faith on the chat path everyone depends on — the single highest-risk move in the repo per the plan's own admission.

6. **`enqueueEvent` wiring (Phase 2) lacks dedup/debounce and a backpressure story.** "Wire enqueueEvent to session-end, inbound Telegram/webhook, scheduler heartbeat, deploy/email arrival." Event-first loops die two ways the plan ignores: (a) **storms** — a webhook retry or an email flood enqueues N events that each wake a tick and each spend budget; (b) **self-triggering loops** — a session-end event from a loop-driven turn enqueues another event (the loop wakes itself forever). Need: event coalescing, a per-source rate limit, and an explicit rule that loop-originated turns do not enqueue wake events. This is a classic autonomous-agent runaway and it is unaddressed.

7. **Provider failover is liveness-aware within a session but has no recovery/half-open path.** Phase −1 retires dead providers for "this session." For a multi-hour or multi-day mission, a provider that was out-of-balance at hour 1 (DeepSeek topped up at hour 3) stays dead for the whole mission, and a 4-hop cap across a long mission can exhaust *all* providers permanently with no re-probe. Add a half-open retry (re-test a retired provider after a backoff) so long missions self-heal as balances/auth recover. The plan treats provider death as terminal-for-session, which is wrong for the long-horizon case it is built for.

8. **No model/cost-tier policy for the loop.** An always-on loop driving `streamTurn` will, by default, use the same premium model as interactive chat. Long-horizon autonomy at Opus pricing per idle tick is an economic failure mode distinct from the per-mission Budget. The plan should specify a cheaper default model/tier for autonomous ticks (escalating only when a goal warrants), or the dollar budget will simply be hit faster with nothing to show. Capability gap, not mentioned.

9. **`ComputerUse` / desktop-control is listed in Phase 1's dangerous surface but has no `simulate()` story.** Phase 0 demands "a real simulate() that returns real artifacts" for email/calendar. Desktop control (clicking, typing into native apps) is fundamentally **not simulatable** — you cannot dry-run a click on someone's banking app. The plan never acknowledges that some effects have no meaningful simulate(), so the gate's "STAGE with preview" posture is undefined for them. These must be hard-staged-as-approval (show the *intended* action, not a simulated artifact) — call this out explicitly or the invariant test's "emits an EffectSpec with simulate()" branch is unsatisfiable for ComputerUse.

## P2 — Audit findings that fell through the plan

10. **Witness "candidate" nodes recall-eligible before Crucible trial** is in the diagnosis's reliabilityGaps but only half-addressed in Phase 3 ("keep candidates out of recall until Crucible confirms"). It is not given an exit criterion or a test. Given the plan's whole thesis is "verify before learn," an unverified model claim surfacing as authoritative recall is exactly the failure the plan exists to prevent — it deserves a ProveSafe line, not a clause.

11. **"Stop persisting raw tool stderr as recallable memory" (Phase 3) has no migration for the existing poisoned corpus.** New writes get distilled, but the diagnosis says raw `Tool error observed: <stderr>` memories already exist. The plan distills going forward and never purges what's there, so recall stays polluted until those age out. Add a one-time hygiene migration (surfaced in the Phase-4 inspect/forget panel).

12. **`tokenScale` cold-start (4-chars/token guess, resets on swap)** is in reliabilityGaps and named in Phase −1 ("seed tokenScale from real usage") but only for the *post-failover* case. The cold-start on the *first* turn of a fresh mission is unaddressed — the very first long autonomous turn risks a context_length 400 before any usage exists to seed from. Specify a per-provider calibrated default, not 1.

13. **The OAuth proxy's availability is a single point of failure for *all* confidential providers with no health/fallback in the connect UX.** The plan mentions "graceful degradation to Advanced: own app if proxy unreachable" once, but the App.tsx rewrite (step 8) makes the one-click Connect the default path. If the Ares-owned proxy is down, *every* non-PKCE connect fails for *every* user simultaneously, and the fallback requires the non-technical owner to register a developer app — i.e., the exact toil the plan eliminated. There's no concrete detection-and-messaging spec. Also: rotating the Ares-owned client_secret in the proxy is a fleet-wide operation with no rollover plan mentioned.

## P3 — Hand-wavy where it must be concrete

14. **The 24-hour soak gate has no definition of "idle" or "load."** "24-hour shadow-mode soak produces zero auto-executed irreversible effects." But a soak where the loop had no goals and never ticked trivially passes while proving nothing. Specify: the soak must include N real goals exercising each effect class, the injected-runaway test, and a minimum tick count — otherwise the gate that "earns auto-approve" can be passed vacuously, which is precisely the "skipped under pressure" risk the plan claims to mitigate.

15. **`VerificationSpec` is required on every goal but its schema and the "default probe" are undefined.** Phase 2 says "default to a report-delivered/file/command/http probe." For a goal like "research and summarize X," what is the default reality probe? "Report delivered" verifies *delivery*, not *correctness* — an LLM-judge probe reintroduces the self-certification the plan is killing, one level up. The plan needs to admit that non-physical goals (research, analysis) cannot be reality-probed and must escalate to human verification in shadow mode, rather than pretending a default probe grounds them.

16. **Phase 0's `agentRuntime.ts` extraction has no behavioral-equivalence harness beyond "713 tests as guardrail."** Those tests pass today against the *current* divergent gates. The plan's own thesis is that the daemon and garrison have **divergent** permission/failover behavior — so a passing test suite does not prove the *unified* runtime matches *either* prior behavior; it may pass while silently changing one path's permission policy. Need a golden-trace test: record real tool-decision traces from both daemons pre-extraction, replay against the unified runtime, assert identical decisions. Without it, "wire once, true everywhere" can mean "wrong everywhere."

## One thing the plan gets wrong

17. **Phase −1 claims to "ship independently in week one" but its failover fix structurally depends on a `dead` set that is only meaningfully populated once effects/sessions track provider death across calls — which the plan itself says is wired only in the desktop daemon today.** Lifting failover into a shared helper (Phase −1 workstream 3) and threading a session-scoped `dead` set into headless paths is *not* a one-regex change; it touches session/runtime plumbing that Phase 0's extraction is supposed to create. There's a latent ordering coupling: doing the shared-helper extraction well basically *is* starting the `agentRuntime.ts` carve. Either accept that Phase −1's third workstream is a down-payment on Phase 0 (and sequence it as such), or scope Phase −1 to the regex + orphan-reconciliation + detector re-arm (genuinely independent) and move the shared-helper lift into Phase 0. As written, Phase −1's "no spine surgery" claim is slightly false.

---

**Net:** the plan's bones are right and the effects-gate invariant is genuinely the best artifact in it. The gaps cluster in three places: (a) **runaway-loop dynamics** the gate doesn't catch — event storms, self-triggering wakes, probe/verification spend, non-resetting dead-provider sets (items 4, 6, 7, 8); (b) **non-simulatable / non-probeable effects** the safety model silently assumes away — ComputerUse, research goals (items 9, 15); and (c) **vacuous-pass risk** in the very gates meant to earn trust — the soak and the 713-test guardrail can both pass while proving nothing (items 14, 16). Fixing 1–9 before lighting the loop is mandatory; 10–17 can ride their respective phases.