# Ares → Ultra Coding Agent (Pi + Claude Code references)

> Source: 9-agent research+blueprint+critique pass over **Pi** (earendil-works/pi
> `packages/coding-agent`), the **Claude Code** source, the **DeepSeek reasoning path**, and
> **Ares' current coding gaps**, 2026-06-19. Critic verdict: **go-ahead = true** (every cited
> line number verified accurate); corrections folded in below. Raw research in the workflow transcript.

## North star
Keep Ares' real edge — loop-control + context survival (watchdogs, oscillation breakers,
content-hash staleness, disk-spill, microcompact, dep-aware batching, confirmTurnEnd) — and close the
five gaps that separate it from Claude Code / Pi: (1) **amnesiac reasoning across tool loops**,
(2) **single-shot fragile edits**, (3) **dishonest keyword "semantic" search**, (4) a **persona-bloated
prompt with no act-first signal**, (5) **advisory-not-structural verification**. The reasoning-model
path is the top lever: route DeepSeek through the hardened `/anthropic` provider, echo unsigned
thinking on tool loops, and beat the unreducible `"high"` reasoning floor at the **prompt + loop**
level (act-first, decomposition, first-turn `tool_choice`) — not by trying to turn thinking down.

## Why the DeepSeek build failed (root cause, confirmed by docs)
- `reasoning_effort` only accepts `high`/`max` (low/medium→high); `budget_tokens` ignored on
  `/anthropic`. **Thinking cannot be reduced** — it floored at "high" and front-loaded ~14k thinking
  tokens before any action.
- We were on the **OpenAI-compat path**; DeepSeek ships an **Anthropic-Messages endpoint**
  (`https://api.deepseek.com/anthropic`, `x-api-key`; Opus→`deepseek-v4-pro`, Sonnet/Haiku→`deepseek-v4-flash`).
- Latent bug: with tool calls DeepSeek requires `reasoning_content`/thinking **echoed every turn or it
  400s**. Ares' `/anthropic` provider currently **drops unsigned thinking** (anthropic.ts:500-505) — so
  DeepSeek tool loops would break. (The OpenAI path already echoes it at openrouter.ts:431 — proof the
  fix is a faithful port, not a guess.)

---

## Phase 0 — make DeepSeek actually work as a coding driver (P0; with critic fixes)

1. **Dialect flag + unsigned-thinking echo.** Add `dialect: 'anthropic' | 'deepseek'` to
   `AnthropicProviderOptions`. In `toAnthropicContentBlock`, when `dialect==='deepseek'`, emit
   `{type:'thinking', thinking: block.text}` **unsigned**; keep dropping unsigned for genuine Anthropic
   (signatures are model-bound). *(anthropic.ts:58-66, 500-505)*
2. **Route DeepSeek through `AnthropicProvider`** with `endpointUrl='https://api.deepseek.com/anthropic'`,
   `dialect:'deepseek'`, wire-edge model map. `x-api-key` skips the OAuth identity branch (no Claude-Code
   leak). **Kill-switch:** `ARES_DEEPSEEK_DIALECT=anthropic|openai` falls back to the old path. Keep
   `DeepSeekProvider` + `fetchDeepSeekModels` for discovery/fallback. *(entry.ts:1015-1020)* 🔧 map at a
   **single chokepoint** and record the resolved id onto the request/usage so picker+telemetry+wire agree.
3. **Dialect-aware `buildMessagesBody`:** skip all 3 `cache_control` breakpoints (DeepSeek ignores them;
   it auto KV-caches server-side), send `thinking:{type:'enabled'}` **without** `budget_tokens`, and do
   **not** inflate `max_tokens` (the `/fable/`-only `usesAdaptiveThinking` check sends DeepSeek down the
   budget branch today). *(anthropic.ts:429-473)*
4. **Act-first scaffolding** (beats the unreducible "high" floor):
   - DeepSeek-only system addendum: *"Act first. Take ONE concrete action (a tool call), then observe,
     then continue. Don't plan the whole task before acting. Keep reasoning before your first tool call
     under ~2 short paragraphs."*
   - Add `tool_choice` to `ProviderRequest` + every provider's body builder (Anthropic/OpenAI/OpenRouter
     honor; Ollama ignore). Force `{type:'any'}` on the **first agentic turn** 🔧 **only in goal-mode**
     (run/mission/operator — never interactive chat), relax to `auto` after.
5. 🔧 **Image-routing guard — moved into Phase 0** (correctness prerequisite, not P1): DeepSeek `/anthropic`
   rejects image/document blocks. A turn carrying image content must route to Anthropic/Fable (preferred —
   don't silently strip a screenshot), given Ares' live vision/screen-capture loops.
6. **Tests** *(extend tests/ares-anthropic.test.mjs)*: two-turn DeepSeek tool loop echoes unsigned thinking
   on turn 2; no `cache_control` sent; no identity block on `x-api-key`; model mapped. 🔧 **Negative test:
   genuine Anthropic STILL drops unsigned thinking** (protects the load-bearing invariant).

### Critic corrections folded into Phase 0
- 🔧 **Drop the ">4k thinking deltas" ceiling as P1.** The floor is ~14k → 4k would abort every first
  turn; and aborting mid-stream leaves an unsigned partial thinking block. Rely on first-turn
  `tool_choice:'any'` (structurally prevents a no-tool turn); keep a verbose-actionless ceiling only as a
  **P2 backstop** that fires *after* a completed no-tool turn (not mid-stream), threshold well above 14k.
- 🔧 **Date/volatile relocation (P1) collides with the rolling cache breakpoint** (anthropic.ts:466-473
  caches the LAST block of the LAST message). Place volatile content as a **non-last** block so the
  rolling breakpoint still lands on stable content.
- 🔧 **Bidirectional strip-on-switch.** On provider failover DeepSeek↔Anthropic mid-session, unsigned
  DeepSeek thinking will 400 a real Anthropic call (and signed Anthropic thinking 400s elsewhere). The
  `stripSignatureBlocks` pass must handle **both** directions.
- 🔧 **Compaction × dialect cross-cut:** kept-suffix assistant turns after microcompact/summarizeSpan
  still carry thinking that must be echoed on the DeepSeek path — compaction must preserve it.
- 🔧 **Fork isolation:** a forked subagent inherits `dialect` on DeepSeek, but a fork that falls back to a
  different provider must NOT carry `tool_choice:'any'` or unsigned thinking.

---

## Phases 1-4 (post-DeepSeek)

**Phase 1 — cheap prompt + honesty wins (low risk, immediate lift):**
- Re-order `buildSystemPrompt` to lead with the edit→verify coding core; demote persona to a compact
  block; gate Holotable/Operator/Mission sections behind capability detection.
- Add doctrine paragraphs (steal from CC `prompts.ts`): **minimum-complexity** (no gold-plating, validate
  only at boundaries, "three similar lines beat a premature abstraction"); **comment-discipline**;
  **faithful-reporting** (never claim tests pass when they fail; say when a step was skipped);
  **diagnose-before-retry**. Add a **"skip TodoWrite for 1-2 step tasks"** counter-signal.
- **Relabel `CodebaseSearch`** description from "semantic" → "ranked keyword search; use Grep for exact"
  (it has no embeddings — the model trusts it for synonym matches it can't do).
- **Self-correcting tool errors:** extend the `<tool_use_error>` pattern to truncation/limit cases
  ("Use offset=N", "Use limit=2N or refine").

**Phase 2 — structural reliability:**
- **MultiEdit** — atomic batched `edits[]` matched against ORIGINAL content, reject overlaps, apply in
  reverse offset order, all-or-nothing in memory before fs write, reuse `replaceResilient` + content-hash
  staleness. (Pi/CC — the #1 edit-reliability gap.)
- **max_output_tokens recovery ladder** — withhold the cutoff error, retry at an escalated cap, inject a
  verbatim "resume mid-thought, no recap, break into smaller pieces" meta, loop ≤3×. (CC query.ts:1188.)
- **Complete thinking-signature lifecycle** + strip-on-switch (see Phase-0 bidirectional note).
- **Structured compaction summary schema** (Pi compaction.ts:455): Goal / Constraints /
  Progress(Done|InProgress|Blocked) / Decisions / Next Steps / Critical Context + read/modified files —
  makes Ares' compaction recoverable instead of lossy. Highest-value context port.
- **Tie TodoWrite to turn-end** in `confirmTurnEnd`: block "completed" while a plan is unfinished.

**Phase 3 — the verification differentiator (biggest coding-quality lever):**
- **Adversarial verification subagent** ("your job is to break it; reading isn't verification; a check
  without a Command-run block is a skip; emit VERDICT: PASS|FAIL|PARTIAL") + **verification-as-contract**:
  non-trivial turns (3+ edits / backend / infra) must be independently verified before reporting done.
  Upgrade `packages/core/src/verifier.ts`, don't duplicate.
- 🔧 Keep `confirmTurnEnd` **advisory-with-cap** (the `endGateFired<2` anti-spiral cap stays); make
  build/lint **best-effort within that budget**, not a hard blocker. The real convergence guarantee is the
  verification subagent, not removing the cap (those were contradictory in the raw blueprint).

**Phase 4 — polish/depth:** iterative compaction + file-op manifest + split-turn; two-tier
steering/follow-up queue (defer — large concurrency surface); subagent doctrine prompt; .gitignore/multiline
Grep; Read image/PDF awareness; Unicode/NFKC fuzzy edit layer; context-overflow recovery path; per-file
realpath mutation lock. (Real embedding index for CodebaseSearch is out of scope — relabel only.)

## Quick wins (do alongside Phase 1, ~hours, near-zero risk)
Relabel CodebaseSearch; add the doctrine paragraphs; TodoWrite skip-signal; self-correcting tool-error
messages; move date out of the cached prefix (respecting block ordering); gate the wasted DeepSeek
`max_tokens` inflation even before the full dialect work.

## Load-bearing invariants to protect (don't regress)
tool_use↔tool_result pairing; prompt-cache prefix stability; fork read-stamp isolation; the genuine
Anthropic path still dropping unsigned thinking; the `endGateFired<2` anti-spiral cap; never route
images to the text-only DeepSeek endpoint.

*Captured 2026-06-19. Implementation log appended below as phases land.*

## Implementation log
- **2026-06-19 — Phase 0 keystone LANDED: DeepSeek now actually codes.** Added
  `dialect:'anthropic'|'deepseek'` to `AnthropicProvider`: echoes UNSIGNED thinking for DeepSeek
  (genuine Anthropic still drops it), skips all cache_control, enables thinking without
  budget_tokens / max_tokens inflation. Routed DeepSeek through it at
  `https://api.deepseek.com/anthropic/v1/messages` (entry.ts), with `ARES_DEEPSEEK_DIALECT=openai`
  kill-switch to the legacy path; `DeepSeekProvider` kept as fallback.
  **Result, V4 Flash, same "create hello.txt" task:** before (OpenAI-compat) = 14,000+ thinking
  deltas, 0 tool calls, no file (killed); after (/anthropic dialect) = **41 thinking deltas → Write
  tool → file created → completed in 4.4s**, with `cacheReadTokens: 26752` (DeepSeek server-side KV
  cache hit). Tests: `tests/c3-deepseek-dialect` (echo + negative-anthropic-drops + no-cache-control +
  no-budget-inflation). Suite 777 tests, 775 pass (1 pre-existing holotable red, 1 skip).
- (next) Phase 0 remainder: act-first system addendum + first-turn `tool_choice:any` (goal-mode only),
  image-routing guard, bidirectional strip-on-switch. Then Phase 1 prompt/honesty wins.
