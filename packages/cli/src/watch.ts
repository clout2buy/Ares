// The Watch — STAGE 3 of Consciousness. The always-on loop: capture the screen,
// let the local eyes interpret it, and MOSTLY stay silent. Restraint is the
// point — a watcher that comments constantly is a nag; one that's quiet for a
// long stretch and then says a single, exactly-right thing is unsettling.
//
// Everything is injected (capture, describe, phrase, emit, remember, clock) so
// the loop and its decide/speak policy are testable without a screen, a model,
// or a daemon. The policy below (decideSpeak) is pure.

import { EngineUnavailableError } from "./visionEngine.js";

// ─── decide/speak policy (pure) ──────────────────────────────────────────────

export interface SpeakState {
  lastSpokeAt: number;
  lastObservation: string;
}

export interface SpeakConfig {
  /** Minimum gap between spoken remarks. Default 5 min — silence is the feature. */
  cooldownMs?: number;
  /** Similarity above which the screen "hasn't meaningfully changed". 0..1. */
  sameThreshold?: number;
  /** Minimum gap between calls to the (cloud) phrasing model, even on veto.
   *  Bounds cost during long notable stretches. Default 45s. */
  phraseCooldownMs?: number;
}

export interface SpeakDecision {
  speak: boolean;
  reason: string;
}

/** Signals that make an observation worth breaking silence for. */
const NOTABLE =
  /\b(error|errors|failed|failing|fail|exception|stuck|crash|crashed|broken|warning|conflict|retry|again|deleted|undo|stalled|blocked|denied|rejected|timeout|loop)\b/i;

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2),
  );
}

/** Jaccard similarity of two strings' word sets. 1 = identical, 0 = disjoint. */
export function jaccard(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Decide whether the watcher should break silence. Pure. The bar is high on
 * purpose: cooldown, then "did anything actually change", then "is it notable".
 */
export function decideSpeak(
  state: SpeakState,
  observation: string,
  now: number,
  cfg: SpeakConfig = {},
): SpeakDecision {
  const cooldown = cfg.cooldownMs ?? 8 * 60_000;
  const sameThreshold = cfg.sameThreshold ?? 0.6;
  if (!observation || observation.trim().length === 0) return { speak: false, reason: "empty" };
  // A vision model that couldn't read the screen must never trigger a remark.
  if (/^(unclear|uncertain|a screenshot|an image|blank)\b/i.test(observation.trim())) {
    return { speak: false, reason: "unclear read" };
  }
  if (now - state.lastSpokeAt < cooldown) return { speak: false, reason: "cooldown" };
  if (jaccard(observation, state.lastObservation) > sameThreshold) {
    return { speak: false, reason: "nothing changed" };
  }
  const notable = NOTABLE.test(observation) || observation.length > 48;
  if (!notable) return { speak: false, reason: "not notable" };
  return { speak: true, reason: "notable change" };
}

// ─── the loop ────────────────────────────────────────────────────────────────

export interface WatchObservation {
  observation: string;
  comment: string | null;
  spoke: boolean;
  at: number;
}

export interface ConsciousnessWatchDeps {
  /** Grab the screen → a file path the engine can read. */
  capture: () => Promise<{ path: string }>;
  /** Interpret a screenshot into a terse factual observation. */
  describe: (imagePath: string) => Promise<string>;
  /** Turn an observation into one dry remark in the watcher's voice — or null to
   *  stay silent even after the policy said speak (the model gets final veto). */
  phrase?: (observation: string, recent: string[]) => Promise<string | null>;
  emit: (event: Record<string, unknown>) => void;
  remember?: (text: string) => void;
  enabled: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
  /** Active cadence (screen changing). Default 12s. */
  activeIntervalMs?: number;
  /** Idle cadence (screen static / engine missing). Default 60s. */
  idleIntervalMs?: number;
  speakConfig?: SpeakConfig;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

export class ConsciousnessWatch {
  private running = false;
  private pausedUntil = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private speakState: SpeakState = { lastSpokeAt: 0, lastObservation: "" };
  private readonly recent: string[] = [];
  private ticking = false;
  /** Last time we ASKED the chat model to phrase — bounds cloud calls even when
   *  it keeps vetoing during a long notable-but-unworthy stretch. */
  private lastPhraseAt = 0;
  private readonly d: ConsciousnessWatchDeps;

  constructor(deps: ConsciousnessWatchDeps) {
    this.d = deps;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private schedule(ms: number): void {
    const set = this.d.setTimer ?? ((fn, t) => setTimeout(fn, t));
    this.timer = set(() => void this.tick(), ms);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.d.log?.("consciousness watch: online");
    this.schedule(500);
  }

  stop(): void {
    this.running = false;
    if (this.timer) (this.d.clearTimer ?? clearTimeout)(this.timer);
    this.timer = undefined;
    this.d.log?.("consciousness watch: offline");
  }

  /** "Look away" — blind the watcher for a while (also how Safe Mode pauses it). */
  pause(ms: number): void {
    this.pausedUntil = this.now() + ms;
    this.d.log?.(`consciousness watch: paused ${Math.round(ms / 1000)}s`);
  }
  resume(): void {
    this.pausedUntil = 0;
  }
  isRunning(): boolean {
    return this.running;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const idle = this.d.idleIntervalMs ?? 60_000;
    const active = this.d.activeIntervalMs ?? 12_000;

    if (this.ticking || !this.d.enabled() || this.now() < this.pausedUntil) {
      this.schedule(idle);
      return;
    }
    this.ticking = true;
    let next = active;
    try {
      const frame = await this.d.capture();
      const observation = (await this.d.describe(frame.path)).trim();
      if (observation.length === 0) {
        this.schedule(active);
        return;
      }
      const changed = jaccard(observation, this.speakState.lastObservation) <= (this.d.speakConfig?.sameThreshold ?? 0.6);
      next = changed ? active : idle; // idle down when nothing's moving

      const decision = decideSpeak(this.speakState, observation, this.now(), this.d.speakConfig);
      this.speakState.lastObservation = observation;
      this.recent.push(observation);
      if (this.recent.length > 8) this.recent.shift();

      let comment: string | null = null;
      const phraseCooldown = this.d.speakConfig?.phraseCooldownMs ?? 45_000;
      if (decision.speak && this.now() - this.lastPhraseAt >= phraseCooldown) {
        if (this.d.phrase) {
          this.lastPhraseAt = this.now(); // count the attempt, vetoed or not
          comment = await this.d.phrase(observation, this.recent);
        } else {
          comment = observation;
        }
        if (comment && comment.trim().length > 0) {
          this.speakState.lastSpokeAt = this.now();
          this.d.remember?.(comment);
        } else {
          comment = null; // model vetoed — stay silent
        }
      }

      // A capture/describe in flight when stop()/pause() landed must not emit a
      // stale observation after the fact.
      if (this.running && this.now() >= this.pausedUntil) {
        const obs: WatchObservation = { observation, comment, spoke: Boolean(comment), at: this.now() };
        this.d.emit({ type: "consciousness_observation", ...obs });
      }
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        // Eyes not installed yet — stay quiet and check back slowly.
        next = idle;
      } else {
        this.d.log?.(`watch tick failed: ${err instanceof Error ? err.message : String(err)}`);
        next = idle;
      }
    } finally {
      this.ticking = false;
      if (this.running) this.schedule(next);
    }
  }
}

/** The watcher's voice — calm, precise, knowing, never theatrical. Used to build
 *  the phrasing prompt for the chat model when the policy decides to speak. */
export const WATCHER_VOICE_PROMPT =
  "You are the quiet watching presence of Ares — calm, exact attention. " +
  "You see ONLY the single screen description you are given; you have no memory of earlier screens and no other context. " +
  "Respond with AT MOST one short sentence: dry, precise, grounded strictly in that description. " +
  "Absolutely do not invent history, continuity, past actions, or anything not in the description. " +
  "Never threaten, never perform menace, no exclamation marks, no emoji. " +
  "Bias HARD toward silence — if it is not clearly worth interrupting the user, output exactly: NOTHING";
