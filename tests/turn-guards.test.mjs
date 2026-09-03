// Unit tests for TurnGuards — the extracted per-turn loop-guard state that
// streamTurn() used to hold as ~30 untestable mutable locals. Every threshold
// is read off the class (TurnGuards.*), never restated as a magic number, so
// a deliberate threshold change updates these assertions with it.

import test from "node:test";
import assert from "node:assert/strict";

import { TurnGuards } from "../packages/core/dist/index.js";

// ── repeat-streak (identical successful call) breaker ────────────────────────

test("repeat breaker fires exactly at the repeat limit, once per episode, re-arms after clearing", () => {
  const guards = new TurnGuards();
  const limit = 4; // engine passes repeatCallLimit(); the class takes it as a primitive
  const sig = "todowrite::abc";

  for (let round = 1; round < limit; round++) {
    guards.recordRoundSignatures(new Set([sig]));
    assert.equal(guards.firingRepeatBreaker(limit), null, `no fire below the limit (round ${round})`);
  }
  guards.recordRoundSignatures(new Set([sig]));
  assert.equal(guards.firingRepeatBreaker(limit), sig, "fires exactly at the limit");
  guards.recordRoundSignatures(new Set([sig]));
  assert.equal(guards.firingRepeatBreaker(limit), null, "one-shot: does not re-fire while the repeat persists");

  // The streak clears when the signature stops recurring; the breaker re-arms.
  guards.recordRoundSignatures(new Set(["other::xyz"]));
  assert.equal(guards.firingRepeatBreaker(limit), null, "cleared round re-arms silently");
  for (let round = 0; round < limit; round++) guards.recordRoundSignatures(new Set([sig]));
  assert.equal(guards.firingRepeatBreaker(limit), sig, "re-armed breaker fires on a fresh episode");
});

test("noop loop-kill trips at 3x the repeat limit", () => {
  const guards = new TurnGuards();
  const limit = 3;
  const sig = "read::same";
  for (let round = 1; round < limit * 3; round++) {
    guards.recordRoundSignatures(new Set([sig]));
    assert.equal(guards.noopKillSig(limit), undefined, `no kill below 3x limit (round ${round})`);
  }
  guards.recordRoundSignatures(new Set([sig]));
  assert.equal(guards.noopKillSig(limit), sig, "kill signature surfaces at 3x the limit");
  assert.equal(guards.repeatStreak.get(sig), limit * 3, "streak count is readable for the error message");
});

// ── A/B oscillation ──────────────────────────────────────────────────────────

test("A/B oscillation detected from the 4-round window; nudge is one-shot; streak feeds the kill", () => {
  const guards = new TurnGuards();
  const rounds = ["A", "B", "A", "B", "A", "B"];
  const verdicts = rounds.map((sig) => guards.recordOscillationRound(sig));

  assert.equal(verdicts[0].oscillating, false, "1 round cannot oscillate");
  assert.equal(verdicts[2].oscillating, false, "3 rounds cannot oscillate (window needs 4)");
  assert.equal(verdicts[3].oscillating, true, "A/B/A/B detected at round 4");
  assert.equal(verdicts[3].streak, 1);
  assert.equal(verdicts[5].streak, 3, "sustained oscillation accumulates the streak");

  assert.equal(guards.shouldNudgeOscillation(true), true, "first detection nudges");
  assert.equal(guards.shouldNudgeOscillation(true), false, "nudge is one-shot per turn");

  // A repeated round (…A,A) breaks the A/B pattern: identical adjacent rounds
  // are a repeat, not an oscillation, and the streak resets.
  guards.recordOscillationRound("A");
  const steady = guards.recordOscillationRound("A");
  assert.equal(steady.oscillating, false, "identical adjacent rounds are not oscillation");
  assert.equal(steady.streak, 0, "streak resets once oscillation stops");
});

// ── consecutive-failure breaker + cumulative grind detector ──────────────────

test("failure breaker fires at its threshold, once per episode; settleFailureRound resets non-recurring streaks", () => {
  const guards = new TurnGuards();
  const sig = "Bash:exit-1";
  const threshold = TurnGuards.FAIL_STREAK_BREAKER_THRESHOLD;

  for (let round = 1; round < threshold; round++) {
    guards.recordFailure(sig, sig);
    guards.settleFailureRound(new Set([sig]));
    assert.equal(guards.firingFailureBreaker(), null, `no fire below threshold (round ${round})`);
  }
  guards.recordFailure(sig, sig);
  guards.settleFailureRound(new Set([sig]));
  assert.equal(guards.firingFailureBreaker(), sig, "fires at the consecutive threshold");
  guards.recordFailure(sig, sig);
  guards.settleFailureRound(new Set([sig]));
  assert.equal(guards.firingFailureBreaker(), null, "one-shot while the loop persists");

  // A round without the signature clears the streak (the treadmill case the
  // grind detector exists for) and re-arms the breaker.
  guards.settleFailureRound(new Set());
  assert.equal(guards.failStreak.has(sig), false, "non-recurring streak is deleted");
  assert.equal(guards.firingFailureBreaker(), null, "re-arm is silent");
});

test("grind detector: cumulative totals survive streak resets and nudge once per threshold", () => {
  const guards = new TurnGuards();
  const grindKey = "Bash:exit-1::npm run";

  // Failures separated by clean rounds — the consecutive streak resets every
  // time, but the cumulative total keeps climbing (the edit-build-fail treadmill).
  for (let i = 1; i < TurnGuards.GRIND_NUDGE_THRESHOLD; i++) {
    guards.recordFailure("Bash:exit-1", grindKey);
    guards.settleFailureRound(new Set());
    assert.deepEqual(guards.grindNudges(), [], `no nudge below the grind threshold (${i})`);
  }
  guards.recordFailure("Bash:exit-1", grindKey);
  guards.settleFailureRound(new Set());
  assert.deepEqual(guards.grindNudges(), [
    { grindKey, total: TurnGuards.GRIND_NUDGE_THRESHOLD, threshold: TurnGuards.GRIND_NUDGE_THRESHOLD },
  ], "GRIND ALERT fires at the nudge threshold");
  assert.deepEqual(guards.grindNudges(), [], "each threshold fires once per signature");

  for (let i = TurnGuards.GRIND_NUDGE_THRESHOLD; i < TurnGuards.GRIND_STOP_THRESHOLD; i++) {
    guards.recordFailure("Bash:exit-1", grindKey);
  }
  assert.deepEqual(guards.grindNudges(), [
    { grindKey, total: TurnGuards.GRIND_STOP_THRESHOLD, threshold: TurnGuards.GRIND_STOP_THRESHOLD },
  ], "GRIND STOP fires at the stop threshold");
  assert.deepEqual(guards.grindNudges(), [], "stop threshold also fires once");
});

test("dead failure loop-kill surfaces the signature at the kill limit; failure recall fires once at count 2", () => {
  const guards = new TurnGuards();
  const sig = "Browser:launch-missing";
  const killLimit = 6; // engine passes loopKillLimit(); primitive in
  for (let i = 0; i < killLimit - 1; i++) {
    guards.recordFailure(sig, sig);
    assert.equal(guards.deadFailureSig(killLimit), undefined, `alive below the kill limit (${i + 1})`);
  }
  guards.recordFailure(sig, sig);
  assert.equal(guards.deadFailureSig(killLimit), sig, "kill fires at the limit");

  const fresh = new TurnGuards();
  assert.equal(fresh.shouldRecallFailureFix(sig, TurnGuards.FAILURE_RECALL_COUNT - 1), false, "not on the first failure");
  assert.equal(fresh.shouldRecallFailureFix(sig, TurnGuards.FAILURE_RECALL_COUNT), true, "recall on the second identical failure");
  assert.equal(fresh.shouldRecallFailureFix(sig, TurnGuards.FAILURE_RECALL_COUNT), false, "at most once per distinct signature");
});

// ── end-of-turn verification gate ────────────────────────────────────────────

test("end gate: new objections push back up to the hardcap; a repeated (stuck) objection never does", () => {
  const guards = new TurnGuards();
  for (let i = 0; i < TurnGuards.END_GATE_HARDCAP; i++) {
    assert.equal(guards.recordEndGate(`objection-${i}`), true, `new objection ${i + 1} pushes back`);
    // The anti-spiral rule: re-claiming done against the SAME red checks is
    // "stuck" and ends the turn honestly — even with cap budget remaining.
    assert.equal(guards.recordEndGate(`objection-${i}`), false, "identical objection is stuck, not progress");
  }
  assert.equal(guards.endGateFired, TurnGuards.END_GATE_HARDCAP);
  assert.equal(guards.endGateExhausted(), true);
  assert.equal(guards.recordEndGate("brand-new-objection"), false, "hardcap binds even for new objections");
  assert.equal(guards.endGateFired, TurnGuards.END_GATE_HARDCAP, "capped counter never advances");
});

// ── evidence ticks ───────────────────────────────────────────────────────────

test("evidenceTick is strictly monotonic and never ties (freshness ordering)", () => {
  const guards = new TurnGuards();
  assert.equal(guards.evidenceTick, 0, "a zero tick means no evidence yet");
  let prev = 0;
  for (let i = 0; i < 25; i++) {
    const tick = guards.nextEvidenceTick();
    assert.ok(tick > prev, "each tick strictly exceeds the last — a counter can't tie");
    assert.equal(tick, guards.evidenceTick, "returned tick and stored tick agree");
    prev = tick;
  }
  // A screenshot taken BEFORE an edit must never read as proof of the edit.
  guards.visualEvidenceTick = guards.evidenceTick;
  guards.nextEvidenceTick();
  guards.lastMutationTick = guards.evidenceTick;
  assert.ok(guards.visualEvidenceTick < guards.lastMutationTick, "older visual evidence stays older");
});

// ── max_tokens continue ladder ───────────────────────────────────────────────

test("max_tokens continues share one cap across text, withheld-tool-call, and mixed-batch legs", () => {
  const guards = new TurnGuards();
  for (let i = 0; i < TurnGuards.MAX_TOKENS_CONTINUE_CAP; i++) {
    assert.equal(guards.canContinueAfterMaxTokens(), true, `continue ${i + 1} allowed under the cap`);
    guards.recordMaxTokensContinue();
  }
  assert.equal(guards.canContinueAfterMaxTokens(), false, "the shared cap is exhausted");
  guards.recordMaxTokensContinue(); // a mixed-batch increment past the cap must not wrap around
  assert.equal(guards.canContinueAfterMaxTokens(), false, "stays exhausted");
});

// ── sleep polling / gather stall ─────────────────────────────────────────────

test("sleep-poll hint fires once at the threshold", () => {
  const guards = new TurnGuards();
  guards.sleepCalls = TurnGuards.SLEEP_POLL_THRESHOLD - 1;
  assert.equal(guards.shouldHintSleepPolling(), false, "below threshold");
  guards.sleepCalls++;
  assert.equal(guards.shouldHintSleepPolling(), true, "fires at the threshold");
  guards.sleepCalls++;
  assert.equal(guards.shouldHintSleepPolling(), false, "one-shot per turn");
});

test("gather stall: novelty and progress reset the clock; a firing re-arms it", () => {
  const guards = new TurnGuards();
  const stallRounds = 3;

  assert.equal(guards.isNovelGather("web:query"), true, "first sighting is novel");
  assert.equal(guards.isNovelGather("web:query"), false, "repeat sighting is not");

  guards.recordProgress(0);
  assert.equal(guards.gatherStalled(1, stallRounds), false);
  assert.equal(guards.gatherStalled(2, stallRounds), false);
  assert.equal(guards.gatherStalled(3, stallRounds), true, "stalls after stallRounds without progress");
  // The firing recorded a convergence iteration — the clock restarts.
  assert.equal(guards.gatherStalled(4, stallRounds), false, "re-armed after the stall fired");
  assert.equal(guards.gatherStalled(6, stallRounds), true, "fires again after another full window");
});
