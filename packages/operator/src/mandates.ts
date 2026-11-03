// Mandates — who said Ares may act when nobody asked this turn.
//
// Owner history: "minecraft keeps randomly launching... when im not even doing
// that or authorizing it" (Aug 5); "backround processes sometimes repoen when u
// start ares" (Sep 9). Scheduled jobs, the operator loop and standing orders
// all run without an owner message in front of them, and nothing recorded WHO
// had authorized each one. This is the small control plane over that (idea
// borrowed from deepseek-ai/dsh-superagent-prototype's observe mode):
//
//   * A Mandate is the durable record of an authorization: which proactive
//     source, which scope inside it ("job:aj_1", "goal:g_2", "*" for the whole
//     source), who granted it (an owner message id, the owner creating the
//     thing at time T, or a standing rule's name), what it may do, when.
//   * Every proactive source has a mode: off | observe | auto. Sources that
//     TAKE ACTIONS (run commands, edit files, launch programs, send messages)
//     default to observe; reading/summarizing sources default to auto.
//   * gate() is the one question every unasked run asks before acting. An
//     acting run with no live mandate does not act: it records a "would have
//     done X because Y" observation instead. A mandate scoped to exactly that
//     thing, a one-time approval, or the owner setting the source to auto (a
//     source-wide standing rule) lets it through.
//   * gate() runs before EVERY run of a recurring thing, so a revoked mandate
//     stops the very next run (revalidation is not a separate step to forget).
//   * The owner answers each observation once: approve once, approve always
//     (a standing-rule mandate for that scope), or dismiss (sticky: the same
//     scope does not nag again).
//
// Storage follows the jobs store: one JSON file, written tmp+rename. The
// desktop daemon and the garrison may both hold a store on the same home, so
// every mutation re-reads the file first (read-modify-write) instead of
// trusting a stale in-memory copy.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { operatorPaths } from "./paths.js";
import type { Goal } from "./types.js";

export type ProactiveSource =
  | "jobs"
  | "operator"
  | "consciousness"
  | "dreaming"
  | "reflection"
  | "briefing";

export type ProactiveMode = "off" | "observe" | "auto";

/** Sources whose runs take actions in the world. Everything else only reads
 *  and summarizes (the Consciousness watcher looks and remarks; dreaming and
 *  reflection consolidate memory; briefings summarize). */
export const ACTING_SOURCES: ReadonlySet<ProactiveSource> = new Set<ProactiveSource>(["jobs", "operator"]);

export const PROACTIVE_SOURCES: readonly ProactiveSource[] = ["jobs", "operator", "consciousness", "dreaming", "reflection", "briefing"];

export function defaultProactiveMode(source: ProactiveSource): ProactiveMode {
  return ACTING_SOURCES.has(source) ? "observe" : "auto";
}

export type MandateGrant =
  | { kind: "owner_message"; messageId: string }
  | { kind: "owner_created"; what: string; at: string }
  | { kind: "standing_rule"; name: string };

export interface Mandate {
  id: string;
  source: ProactiveSource;
  /** "job:<id>", "goal:<id>", "standing_order:<id>", or "*" (the whole source). */
  scope: string;
  grantedBy: MandateGrant;
  /** What it may do, in the owner's terms. */
  may: string;
  grantedAt: string;
  revokedAt?: string;
}

export type ObservationStatus = "pending" | "approved_once" | "approved_always" | "dismissed";

export interface Observation {
  id: string;
  source: ProactiveSource;
  scope: string;
  /** "would have done X" — the action, said plainly. */
  wouldDo: string;
  /** "because Y" — why the source wanted to. */
  because: string;
  firstAt: string;
  lastAt: string;
  /** How many times it wanted to (a recurring job folds into one entry). */
  count: number;
  status: ObservationStatus;
  decidedAt?: string;
  /** A one-time approval is spent by the first run it lets through. */
  consumedAt?: string;
}

export interface MandateFile {
  modes: Partial<Record<ProactiveSource, ProactiveMode>>;
  mandates: Mandate[];
  observations: Observation[];
}

export interface GateRequest {
  source: ProactiveSource;
  scope: string;
  wouldDo: string;
  because: string;
  /** False for reading/summarizing work, which needs no mandate. */
  takesActions: boolean;
}

export interface GateResult {
  allowed: boolean;
  via?: "read_only" | "mandate" | "once" | "source_auto";
  mandate?: Mandate;
  /** Set when the run was recorded instead of done. */
  observation?: Observation;
  /** The scope HAD a mandate and the owner revoked it: the thing should stop. */
  revoked?: boolean;
  /** One line for logs and job notes. */
  reason: string;
}

/** Decided observations kept for the record; pending ones are never dropped. */
export const MAX_DECIDED_OBSERVATIONS = 200;

export function mandatesFile(home?: string): string {
  return path.join(operatorPaths(home).operatorDir, "mandates.json");
}

function emptyFile(): MandateFile {
  return { modes: {}, mandates: [], observations: [] };
}

function isSource(v: unknown): v is ProactiveSource {
  return typeof v === "string" && (PROACTIVE_SOURCES as readonly string[]).includes(v);
}

function isMode(v: unknown): v is ProactiveMode {
  return v === "off" || v === "observe" || v === "auto";
}

function normalize(raw: unknown): MandateFile {
  const out = emptyFile();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (r.modes && typeof r.modes === "object") {
    for (const [k, v] of Object.entries(r.modes as Record<string, unknown>)) {
      if (isSource(k) && isMode(v)) out.modes[k] = v;
    }
  }
  for (const m of Array.isArray(r.mandates) ? r.mandates : []) {
    const x = m as Partial<Mandate>;
    if (typeof x?.id === "string" && isSource(x.source) && typeof x.scope === "string" && x.grantedBy && typeof x.grantedAt === "string") {
      out.mandates.push({ ...(x as Mandate), may: typeof x.may === "string" ? x.may : "" });
    }
  }
  for (const o of Array.isArray(r.observations) ? r.observations : []) {
    const x = o as Partial<Observation>;
    if (typeof x?.id === "string" && isSource(x.source) && typeof x.scope === "string" && typeof x.status === "string") {
      out.observations.push({
        ...(x as Observation),
        count: typeof x.count === "number" ? x.count : 1,
        wouldDo: typeof x.wouldDo === "string" ? x.wouldDo : "",
        because: typeof x.because === "string" ? x.because : "",
        firstAt: typeof x.firstAt === "string" ? x.firstAt : "",
        lastAt: typeof x.lastAt === "string" ? x.lastAt : "",
      });
    }
  }
  return out;
}

const id = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`;

export class MandateStore {
  private state: MandateFile = emptyFile();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  readonly file: string;

  constructor(opts: { home?: string; file?: string; now?: () => number } = {}) {
    this.file = opts.file ?? mandatesFile(opts.home);
    this.now = opts.now ?? Date.now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private async read(): Promise<MandateFile> {
    try {
      this.state = normalize(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch {
      // first run, or a damaged file: start empty rather than refuse to gate
      // (an empty store means NO mandates — the safe direction).
    }
    return this.state;
  }

  private async write(): Promise<void> {
    const decided = this.state.observations.filter((o) => o.status !== "pending");
    if (decided.length > MAX_DECIDED_OBSERVATIONS) {
      const drop = new Set(decided.slice(0, decided.length - MAX_DECIDED_OBSERVATIONS).map((o) => o.id));
      this.state.observations = this.state.observations.filter((o) => !drop.has(o.id));
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2) + "\n", "utf8");
    await fs.rename(tmp, this.file);
  }

  /** Serialize every read-modify-write in this process. */
  private mutate<T>(fn: (s: MandateFile) => T | Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const s = await this.read();
      const out = await fn(s);
      await this.write();
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async snapshot(): Promise<MandateFile & { effectiveModes: Record<ProactiveSource, ProactiveMode> }> {
    await this.chain;
    const s = await this.read();
    const effectiveModes = Object.fromEntries(PROACTIVE_SOURCES.map((src) => [src, s.modes[src] ?? defaultProactiveMode(src)])) as Record<ProactiveSource, ProactiveMode>;
    return { modes: { ...s.modes }, mandates: s.mandates.map((m) => ({ ...m })), observations: s.observations.map((o) => ({ ...o })), effectiveModes };
  }

  async modeOf(source: ProactiveSource): Promise<ProactiveMode> {
    await this.chain;
    return (await this.read()).modes[source] ?? defaultProactiveMode(source);
  }

  /** Set a source's mode. auto IS a source-wide standing rule (so it is a
   *  mandate like any other, revocable and on the record); observe and off
   *  revoke that rule. */
  setMode(source: ProactiveSource, mode: ProactiveMode): Promise<ProactiveMode> {
    return this.mutate((s) => {
      s.modes[source] = mode;
      const at = this.iso();
      const wide = s.mandates.filter((m) => m.source === source && m.scope === "*" && !m.revokedAt);
      if (mode === "auto") {
        if (wide.length === 0) {
          s.mandates.push({ id: id("md"), source, scope: "*", grantedBy: { kind: "standing_rule", name: `owner set ${source} to auto` }, may: `run any ${source} work on its own`, grantedAt: at });
        }
      } else {
        for (const m of wide) m.revokedAt = at;
      }
      return mode;
    });
  }

  /** Grant a mandate for one scope. An explicit owner act always grants, even
   *  over an earlier revocation. */
  grant(spec: { source: ProactiveSource; scope: string; grantedBy: MandateGrant; may: string; grantedAt?: string }): Promise<Mandate> {
    return this.mutate((s) => {
      const live = s.mandates.find((m) => m.source === spec.source && m.scope === spec.scope && !m.revokedAt);
      if (live) return { ...live };
      const m: Mandate = { id: id("md"), source: spec.source, scope: spec.scope, grantedBy: spec.grantedBy, may: spec.may, grantedAt: spec.grantedAt ?? this.iso() };
      s.mandates.push(m);
      return { ...m };
    });
  }

  /**
   * Record the mandate a thing was BORN with (a job the owner created at T, a
   * goal the owner consented to) — but only the first time it is seen. If the
   * scope ever had a mandate, live or revoked, nothing is granted: otherwise a
   * revocation would be silently undone on the next tick.
   */
  ensure(spec: { source: ProactiveSource; scope: string; grantedBy: MandateGrant; may: string; grantedAt?: string }): Promise<Mandate | undefined> {
    return this.mutate((s) => {
      const any = s.mandates.filter((m) => m.source === spec.source && m.scope === spec.scope);
      if (any.length > 0) {
        const live = any.find((m) => !m.revokedAt);
        return live ? { ...live } : undefined;
      }
      const m: Mandate = { id: id("md"), source: spec.source, scope: spec.scope, grantedBy: spec.grantedBy, may: spec.may, grantedAt: spec.grantedAt ?? this.iso() };
      s.mandates.push(m);
      return { ...m };
    });
  }

  /** Revoke by mandate id, or every live mandate on a scope. */
  revoke(target: { id: string } | { source: ProactiveSource; scope: string }): Promise<number> {
    return this.mutate((s) => {
      const at = this.iso();
      let n = 0;
      for (const m of s.mandates) {
        if (m.revokedAt) continue;
        const hit = "id" in target ? m.id === target.id : m.source === target.source && m.scope === target.scope;
        if (hit) { m.revokedAt = at; n++; }
      }
      return n;
    });
  }

  /** A one-time go-ahead for a scope, with no observation behind it (the
   *  owner pressing "run now" on a job). */
  approveOnce(source: ProactiveSource, scope: string, wouldDo: string): Promise<Observation> {
    return this.mutate((s) => {
      const at = this.iso();
      const o: Observation = { id: id("ob"), source, scope, wouldDo, because: "the owner asked for it now", firstAt: at, lastAt: at, count: 1, status: "approved_once", decidedAt: at };
      s.observations.push(o);
      return { ...o };
    });
  }

  /** The owner's answer to one "Ares wanted to" entry. */
  decide(observationId: string, decision: "once" | "always" | "dismiss"): Promise<{ observation: Observation; mandate?: Mandate } | undefined> {
    return this.mutate((s) => {
      const o = s.observations.find((x) => x.id === observationId);
      if (!o) return undefined;
      const at = this.iso();
      o.decidedAt = at;
      if (decision === "dismiss") {
        o.status = "dismissed";
        return { observation: { ...o } };
      }
      if (decision === "once") {
        o.status = "approved_once";
        delete o.consumedAt;
        return { observation: { ...o } };
      }
      o.status = "approved_always";
      let m = s.mandates.find((x) => x.source === o.source && x.scope === o.scope && !x.revokedAt);
      if (!m) {
        m = { id: id("md"), source: o.source, scope: o.scope, grantedBy: { kind: "standing_rule", name: `approved always: ${o.wouldDo}`.slice(0, 160) }, may: o.wouldDo, grantedAt: at };
        s.mandates.push(m);
      }
      return { observation: { ...o }, mandate: { ...m } };
    });
  }

  /**
   * The one question every unasked run asks before it acts. Called before
   * EVERY run (first or resumed), so a revoked mandate stops the next one.
   */
  gate(req: GateRequest): Promise<GateResult> {
    return this.mutate((s): GateResult => {
      const mode = s.modes[req.source] ?? defaultProactiveMode(req.source);
      if (mode === "off") return { allowed: false, reason: `${req.source} is off` };
      if (!req.takesActions) return { allowed: true, via: "read_only", reason: "reading only" };
      const exact = s.mandates.find((m) => m.source === req.source && m.scope === req.scope && !m.revokedAt);
      if (exact) return { allowed: true, via: "mandate", mandate: { ...exact }, reason: describeGrant(exact.grantedBy) };
      const once = s.observations.find((o) => o.source === req.source && o.scope === req.scope && o.status === "approved_once" && !o.consumedAt);
      if (once) {
        once.consumedAt = this.iso();
        return { allowed: true, via: "once", observation: { ...once }, reason: "approved once by the owner" };
      }
      const wide = mode === "auto" ? s.mandates.find((m) => m.source === req.source && m.scope === "*" && !m.revokedAt) : undefined;
      if (wide) return { allowed: true, via: "source_auto", mandate: { ...wide }, reason: describeGrant(wide.grantedBy) };
      const revoked = s.mandates.some((m) => m.source === req.source && m.scope === req.scope && m.revokedAt);
      const at = this.iso();
      // One entry per scope: a recurring job folds into its pending (or
      // dismissed — dismissal is sticky, it does not nag again) record.
      const prior = [...s.observations].reverse().find((o) => o.source === req.source && o.scope === req.scope && (o.status === "pending" || o.status === "dismissed"));
      let observation: Observation;
      if (prior) {
        prior.count += 1;
        prior.lastAt = at;
        if (prior.status === "pending") {
          prior.wouldDo = req.wouldDo;
          prior.because = req.because;
        }
        observation = { ...prior };
      } else {
        observation = { id: id("ob"), source: req.source, scope: req.scope, wouldDo: req.wouldDo, because: req.because, firstAt: at, lastAt: at, count: 1, status: "pending" };
        s.observations.push(observation);
        observation = { ...observation };
      }
      return {
        allowed: false,
        observation,
        ...(revoked ? { revoked: true } : {}),
        reason: revoked ? "its mandate was revoked" : "no mandate — recorded what it would have done",
      };
    });
  }
}

/** The mandate scope an operator goal answers to: its standing order when a
 *  standing order made it (so one revocation stops every future firing), else
 *  the goal itself. */
export function goalMandateScope(goal: Pick<Goal, "id" | "origin">): string {
  return goal.origin?.kind === "standing_order" ? `standing_order:${goal.origin.id}` : `goal:${goal.id}`;
}

/**
 * The OperatorBackgroundLoop `gate` over a MandateStore. A goal is born with
 * a mandate when the owner authorized it: recorded consent (an approval id)
 * or a standing order the owner created or approved. A plan-mode goal only
 * investigates and proposes, so it needs none. Everything else is observed.
 */
export function operatorGoalGate(
  store: MandateStore,
  opts: { onObserved?: (result: GateResult, goal: Goal) => void } = {},
): (goal: Goal) => Promise<boolean> {
  return async (goal) => {
    const scope = goalMandateScope(goal);
    if (goal.consent?.approvalId) {
      await store.ensure({ source: "operator", scope, grantedBy: { kind: "owner_message", messageId: goal.consent.approvalId }, may: `work on: ${goal.statement.slice(0, 160)}`, grantedAt: goal.consent.at });
    } else if (goal.origin?.kind === "owner") {
      const at = goal.origin.createdAt ?? goal.createdAt;
      await store.ensure({ source: "operator", scope, grantedBy: { kind: "owner_created", what: `goal (${goal.origin.via})`, at }, may: `work on: ${goal.statement.slice(0, 160)}`, grantedAt: at });
    } else if (goal.origin?.kind === "standing_order" && (goal.origin.createdBy !== "ares" || goal.origin.approved === true) && goal.origin.approved !== false) {
      const at = goal.origin.createdAt ?? goal.createdAt;
      await store.ensure({ source: "operator", scope, grantedBy: { kind: "owner_created", what: "standing order", at }, may: `run the standing order: ${goal.statement.slice(0, 160)}`, grantedAt: at });
    }
    const result = await store.gate({
      source: "operator",
      scope,
      wouldDo: `work on "${goal.statement.slice(0, 160)}"`,
      because: goal.origin?.kind === "standing_order" ? "its standing order came due" : "it was the most urgent open goal",
      takesActions: goal.mode !== "plan",
    });
    if (!result.allowed) opts.onObserved?.(result, goal);
    return result.allowed;
  };
}

export function describeGrant(g: MandateGrant): string {
  if (g.kind === "owner_message") return `owner message ${g.messageId}`;
  if (g.kind === "owner_created") return `${g.what} by the owner at ${g.at}`;
  return `standing rule: ${g.name}`;
}
