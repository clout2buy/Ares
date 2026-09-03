// TurnGuards — the per-turn loop-guard state for QueryEngine.streamTurn().
//
// streamTurn() used to hold ~30 mutable locals for its stall/loop/gate
// detectors, which made the guard logic untestable at the unit level. This
// class extracts exactly that state — one instance per turn, constructed at
// the top of streamTurn() and discarded with it, so lifecycle is automatic.
//
// CONTRACT:
//   - Zero behavior change from the original locals: every threshold, arm/
//     re-arm rule, and one-shot flag is lifted verbatim.
//   - No imports from queryEngine. Methods take primitives/collections in and
//     return verdicts out; message text and event emission stay in the engine.
//   - The doc comments on fields/methods carry incident history from the
//     original declarations — they explain WHY each guard exists.

export class TurnGuards {
  // ── Thresholds (exposed so tests never restate magic numbers) ─────────
  /** End-of-turn verification gate: hard cap on NEW objections pushed back to
   *  the model before the turn ends honestly with the failures surfaced. */
  static readonly END_GATE_HARDCAP = 6;
  /** C3 — shared cap on auto-continues after the model hit its output-token
   *  ceiling (plain text continues, withheld truncated tool calls, and the
   *  mixed-batch leg all count against the same cap). */
  static readonly MAX_TOKENS_CONTINUE_CAP = 3;
  /** Consecutive identical failures before the circuit-breaker fires. */
  static readonly FAIL_STREAK_BREAKER_THRESHOLD = 3;
  /** Cumulative same-signature failures that trigger the GRIND ALERT nudge. */
  static readonly GRIND_NUDGE_THRESHOLD = 4;
  /** Cumulative same-signature failures that trigger the GRIND STOP nudge. */
  static readonly GRIND_STOP_THRESHOLD = 8;
  /** The SECOND identical failure is the moment to ask memory for a known fix. */
  static readonly FAILURE_RECALL_COUNT = 2;
  /** Sleep-poll shell calls tolerated per turn before the one-shot hint. */
  static readonly SLEEP_POLL_THRESHOLD = 3;
  /** Round-signature window inspected for A/B/A/B oscillation. */
  static readonly ROUND_SIG_HISTORY_MAX = 6;

  // ── Provider/stream guards ────────────────────────────────────────────
  /** ZERO-OUTPUT stall counter, turn-scoped. When the provider commits NO
   *  usable output repeatedly — nothing at all, or only reasoning that stalls
   *  out — even after the prompt was shrunk, the prompt was never the
   *  problem — the endpoint is down/misrouted/unable to finish. Without this
   *  cap the shrink ladder walked every rung at 90s×2 per rung, across
   *  iterations: a field user watched "no stream events for 90s" for 996
   *  seconds against a dead glm endpoint before the turn finally failed.
   *  Reset on any completed provider call (the provider is demonstrably
   *  alive and able to finish). */
  zeroOutputStalls = 0;
  /** One-shot: the context-ledger injection notice has been surfaced. */
  ledgerAnnounced = false;

  // ── End-of-turn gates ─────────────────────────────────────────────────
  /** Times the C1 end-of-turn verification gate has pushed back this turn. */
  endGateFired = 0;
  /** Signature of the last end-gate objection, so we can tell "the model made
   *  progress on the failures" (new objection → keep pushing) from "the model
   *  is stuck re-claiming done against the SAME red checks" (stop, but honestly). */
  private lastGateSig = "";

  // ── Failure detectors ─────────────────────────────────────────────────
  /** Repeated-failure circuit-breaker: tracks consecutive identical tool
   *  failures (tool name + error signature). When the model bangs the same
   *  dead approach, we inject a "change strategy" reminder instead of letting
   *  it loop for minutes (e.g. retrying a missing browser install forever). */
  readonly failStreak = new Map<string, number>();
  private breakerFired = false;
  /** CUMULATIVE per-turn failure totals — never reset on non-recurrence. The
   *  consecutive streak above catches tight loops; this catches the long
   *  edit-build-fail treadmill it is blind to: a real session re-ran the same
   *  failing build 14 times over two hours, each attempt separated by reads
   *  and edits, so the streak reset every round and nothing ever intervened. */
  private readonly failTotal = new Map<string, number>();
  private readonly grindNudgesFired = new Set<string>();
  /** Failure signatures we've already asked memory about this turn (recall fires
   *  at most once per distinct signature — no repeated lookups on every round). */
  private readonly recalledFailureSigs = new Set<string>();

  // ── Gather/progress tracking ──────────────────────────────────────────
  /** S5 — signatures of every gather target seen this turn (novelty tracking). */
  private readonly seenGatherSigs = new Set<string>();
  private lastProgressIter = -1;
  private lastConvergenceIter = -Infinity;

  // ── Output-cap ladder ─────────────────────────────────────────────────
  /** C3 — times we've auto-continued after the model hit its output-token cap. */
  private maxTokensContinues = 0;
  /** C3 tool-call extension — tool_use ids whose arguments were truncated at
   *  the output cap AFTER the recovery ladder was exhausted. Their surfaced
   *  tool_use_error gains the "write smaller pieces" hint; before exhaustion
   *  the error is withheld entirely and the call retried (see reconciliation). */
  readonly truncatedToolCallHintIds = new Set<string>();
  /** "typing then nothing" guard — times we've nudged the model after it ended
   *  the turn with end_turn but EMPTY content (no text, no tool calls). Capped
   *  at one retry so a model that genuinely has nothing to say still ends. */
  emptyTurnNudges = 0;

  // ── Loop precision (L-phase) ──────────────────────────────────────────
  // Catch spinning the failure-breaker misses — identical SUCCESSFUL calls,
  // A/B/A/B oscillation, and an absolute per-turn tool-call ceiling. All
  // fresh per turn, so lifecycle is automatic.
  readonly repeatStreak = new Map<string, number>();
  private readonly roundSigHistory: string[] = [];
  totalToolCalls = 0;
  private repeatBreakerFired = false;
  private oscillationFired = false;
  private oscillationStreak = 0;
  ceilingNudged = false;
  shellEditHinted = false;

  // ── Sleep-polling detector ────────────────────────────────────────────
  /** Sleep-polling detector. A pomodoro-clock task burned 26 browser calls and
   *  24 seconds of literal Start-Sleep trying to watch a timer tick in real
   *  time, then still ended unverified — you cannot observe a minute-scale
   *  rule by waiting for it. Counted across the turn (like the grind breaker,
   *  not the tight-loop detector) because the sleeps are separated by work. */
  sleepCalls = 0;
  private sleepPollHinted = false;

  // ── Verification gate one-shots ───────────────────────────────────────
  proofGateFired = false;
  unverifiedSurfaced = false;
  guiGateFired = false;
  guiUnverifiedSurfaced = false;
  specGateFired = false;

  // ── Evidence freshness ticks ──────────────────────────────────────────
  /** Freshness is ordered by a monotonic per-turn counter, NOT by wall clock.
   *  Two tool outcomes in the same turn routinely land in the same millisecond,
   *  and `visualEvidence < lastMutation` then reads false — so a screenshot
   *  taken BEFORE an edit counted as proof of the edit. A counter can't tie. */
  evidenceTick = 0;
  lastMutationTick = 0;
  visualEvidenceTick = 0;

  // ── Methods (pure decisions lifted verbatim from streamTurn) ──────────

  /** Advance the per-turn evidence counter — strictly increasing, in outcome
   *  order — and return the new tick. */
  nextEvidenceTick(): number {
    return ++this.evidenceTick;
  }

  /** C1 end-of-turn gate admission: keep pushing the model as long as the
   *  objection is NEW (it's making progress), up to the hard cap; when it's
   *  stuck re-claiming done against the SAME red checks (or hits the cap),
   *  return false so the turn ends HONESTLY — the failures surface as
   *  UNRESOLVED rather than pretending success. */
  recordEndGate(sig: string): boolean {
    const stuck = sig === this.lastGateSig; // same objection as last time → no progress
    if (!stuck && this.endGateFired < TurnGuards.END_GATE_HARDCAP) {
      this.lastGateSig = sig;
      this.endGateFired++;
      return true;
    }
    return false;
  }

  /** True once the end gate has pushed back END_GATE_HARDCAP times. */
  endGateExhausted(): boolean {
    return this.endGateFired >= TurnGuards.END_GATE_HARDCAP;
  }

  /** C3 — whether another auto-continue after a max_tokens stop is allowed. */
  canContinueAfterMaxTokens(): boolean {
    return this.maxTokensContinues < TurnGuards.MAX_TOKENS_CONTINUE_CAP;
  }

  /** Count one auto-continue against the shared C3 cap. */
  recordMaxTokensContinue(): void {
    this.maxTokensContinues++;
  }

  /** Record one failed tool call under both detectors: the consecutive streak
   *  (tool + error signature) and the cumulative grind total (which carries the
   *  shell command HEAD in its key so a failing build and a failing test run
   *  don't pool into one "exited with code #" bucket). */
  recordFailure(sig: string, grindKey: string): void {
    this.failStreak.set(sig, (this.failStreak.get(sig) ?? 0) + 1);
    this.failTotal.set(grindKey, (this.failTotal.get(grindKey) ?? 0) + 1);
  }

  /** reset streaks for signatures that did NOT recur this round */
  settleFailureRound(seenThisRound: ReadonlySet<string>): void {
    for (const sig of [...this.failStreak.keys()]) {
      if (!seenThisRound.has(sig)) this.failStreak.delete(sig);
    }
  }

  /** Grind breaker: the SAME failure accumulating across the turn. Not a
   *  tight loop (edits and reads happen between attempts), so no turn-kill —
   *  escalating strategy pressure instead. Fires once per threshold per
   *  signature; returns the nudges to emit this round. */
  grindNudges(): Array<{ grindKey: string; total: number; threshold: number }> {
    const fired: Array<{ grindKey: string; total: number; threshold: number }> = [];
    for (const [grindKey, total] of this.failTotal.entries()) {
      const threshold =
        total >= TurnGuards.GRIND_STOP_THRESHOLD
          ? TurnGuards.GRIND_STOP_THRESHOLD
          : total >= TurnGuards.GRIND_NUDGE_THRESHOLD
            ? TurnGuards.GRIND_NUDGE_THRESHOLD
            : 0;
      if (threshold === 0) continue;
      const onceKey = `${grindKey}@${threshold}`;
      if (this.grindNudgesFired.has(onceKey)) continue;
      this.grindNudgesFired.add(onceKey);
      fired.push({ grindKey, total, threshold });
    }
    return fired;
  }

  /** Failure-signature recall admission: the SECOND identical failure is the
   *  moment to intervene — the model is repeating a mistake but the breaker
   *  hasn't given up yet. Fires at most once per distinct signature. */
  shouldRecallFailureFix(sig: string, count: number): boolean {
    if (count !== TurnGuards.FAILURE_RECALL_COUNT || this.recalledFailureSigs.has(sig)) return false;
    this.recalledFailureSigs.add(sig);
    return true;
  }

  /** Loop-kill: dead failure loop. The breaker (3×) and failure-recall (2×)
   *  already intervened. A model still re-issuing the SAME failing call after
   *  both interventions is provably stuck — and with no default iteration cap,
   *  this terminator is what ends the turn. */
  deadFailureSig(killLimit: number): string | undefined {
    return [...this.failStreak.entries()].find(([, n]) => n >= killLimit)?.[0];
  }

  /** Consecutive-failure circuit-breaker verdict: returns the stuck signature
   *  exactly once per dead-loop episode (armed again only after the loop
   *  clears), or null when nothing should fire this round. */
  firingFailureBreaker(): string | null {
    const stuckSig = [...this.failStreak.entries()].find(
      ([, n]) => n >= TurnGuards.FAIL_STREAK_BREAKER_THRESHOLD,
    )?.[0];
    if (stuckSig && !this.breakerFired) {
      this.breakerFired = true;
      return stuckSig;
    }
    if (!stuckSig) this.breakerFired = false; // re-arm once the loop clears
    return null;
  }

  /** Identical-call (no-op loop) accounting: bump the streak for every
   *  signature issued this round, and drop signatures that did not recur. */
  recordRoundSignatures(roundSigs: ReadonlySet<string>): void {
    for (const sig of roundSigs) this.repeatStreak.set(sig, (this.repeatStreak.get(sig) ?? 0) + 1);
    for (const sig of [...this.repeatStreak.keys()]) if (!roundSigs.has(sig)) this.repeatStreak.delete(sig);
  }

  /** Loop-kill: no-op repeat loop. Identical SUCCESSFUL call still being
   *  re-issued long after the nudge fired (3× warns, 3× the limit kills). Same
   *  contract as the failure loop-kill: with no iteration cap, sustained no-op
   *  repetition must end the turn honestly instead of burning tokens forever. */
  noopKillSig(repeatLimit: number): string | undefined {
    return [...this.repeatStreak.entries()].find(([, n]) => n >= repeatLimit * 3)?.[0];
  }

  /** Identical-successful-call nudge verdict — e.g. the same TodoWrite every
   *  round to game the gather-stall. Fires once per episode; re-arms once the
   *  repeat clears. */
  firingRepeatBreaker(repeatLimit: number): string | null {
    const repeatedSig = [...this.repeatStreak.entries()].find(([, n]) => n >= repeatLimit)?.[0];
    if (repeatedSig && !this.repeatBreakerFired) {
      this.repeatBreakerFired = true;
      return repeatedSig;
    }
    if (!repeatedSig) this.repeatBreakerFired = false; // re-arm once the repeat clears
    return null;
  }

  /** A/B oscillation detection over the last ROUND_SIG_HISTORY_MAX round
   *  signatures. Updates the sustained-oscillation streak (kill decision uses
   *  the returned streak; the one-shot nudge uses shouldNudgeOscillation). */
  recordOscillationRound(roundSig: string): { oscillating: boolean; streak: number } {
    this.roundSigHistory.push(roundSig);
    if (this.roundSigHistory.length > TurnGuards.ROUND_SIG_HISTORY_MAX) this.roundSigHistory.shift();
    const h = this.roundSigHistory;
    const oscillating =
      h.length >= 4 &&
      h[h.length - 1] === h[h.length - 3] &&
      h[h.length - 2] === h[h.length - 4] &&
      h[h.length - 1] !== h[h.length - 2];
    this.oscillationStreak = oscillating ? this.oscillationStreak + 1 : 0;
    return { oscillating, streak: this.oscillationStreak };
  }

  /** One-shot oscillation nudge: fires on the first detection only. A model
   *  still ping-ponging A/B/A/B many rounds later has ignored it — the
   *  sustained streak (see recordOscillationRound) terminates instead. */
  shouldNudgeOscillation(oscillating: boolean): boolean {
    if (oscillating && !this.oscillationFired) {
      this.oscillationFired = true;
      return true;
    }
    return false;
  }

  /** One-shot sleep-polling hint: fires once the turn's sleep-style shell
   *  calls reach the threshold. */
  shouldHintSleepPolling(): boolean {
    if (this.sleepCalls >= TurnGuards.SLEEP_POLL_THRESHOLD && !this.sleepPollHinted) {
      this.sleepPollHinted = true;
      return true;
    }
    return false;
  }

  /** S5 novelty: true (and remembered) the first time a gather signature is
   *  seen this turn — acquiring NEW sources is progress too. */
  isNovelGather(sig: string): boolean {
    if (this.seenGatherSigs.has(sig)) return false;
    this.seenGatherSigs.add(sig);
    return true;
  }

  /** Mark this iteration as having produced progress (novel gather, or any
   *  PROGRESS_TOOLS use) — resets the gather-stall convergence clock. */
  recordProgress(iter: number): void {
    this.lastProgressIter = iter;
  }

  /** Adaptive convergence guard: a build that is WRITING may run as long as it
   *  needs. Only a model truly spinning (re-fetching the same URL, re-running
   *  the same search with nothing new) trips the stall. Re-arms after each
   *  stall (a firing records the convergence iteration). */
  gatherStalled(iter: number, stallRounds: number): boolean {
    const stalled = iter - Math.max(this.lastProgressIter, this.lastConvergenceIter) >= stallRounds;
    if (stalled) this.lastConvergenceIter = iter;
    return stalled;
  }
}
