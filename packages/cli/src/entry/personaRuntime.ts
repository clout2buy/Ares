// The garrison side of personas: everything that ties a Persona (personas.ts)
// to a live thread. Kept out of garrisonCmd.ts so the gateway command only
// wires hooks, and so the routing rules are testable with fakes.
//
//   • session hooks  — SessionManager asks which persona a session belongs to,
//                      and binds a freshly created thread to its persona.
//   • brains         — each persona's provider/model is resolved ONCE (async)
//                      and cached, because the session factory is synchronous.
//   • prompt layer   — the texting doctrine + the persona's role, appended per
//                      session (prompt/texting.ts), never to the default thread.
//   • alarms         — a Remind alarm set from a persona's thread (or carrying
//                      a prompt) runs back IN that thread; the reply is pushed
//                      to the phone titled with the persona's name.
//   • REST           — /gateway/personas (phonePersonas.ts) with real hooks.

import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import { rolloutPath, type SessionPersonaHooks } from "@ares/garrison";
import type { SessionSummary } from "@ares/garrison";
import { PersonaStore, firstLine, lastThreadMessage, DEFAULT_PERSONA_ID, type Persona } from "../personas.js";
import { handlePersonasApi } from "../phonePersonas.js";
import { sessionPromptLayers } from "./prompt/texting.js";

/** The slice of SessionManager this module drives. */
export interface PersonaSessionHost {
  create(opts: { surface?: SessionSummary["surface"]; tenant?: SessionSummary["tenant"]; personaId?: string }): SessionSummary;
  list(): SessionSummary[];
  ensureLive(sessionId: string): Promise<SessionSummary | null>;
  send(sessionId: string, text: string, options?: { inputId?: string }): Promise<void>;
  flush(): Promise<void>;
  archive(sessionId: string): Promise<boolean>;
}

/** A fired Remind alarm (the TelegramScheduler's Alarm, structurally). */
export interface RoutableAlarm {
  id: string;
  label: string;
  body?: string;
  prompt?: string;
  sessionId?: string;
}

export interface PersonaRuntimeOptions<Brain> {
  home: string;
  /** Resolve a provider+model into a runnable brain (selectProvider). */
  resolveBrain: (provider: string, model: string) => Promise<Brain>;
  /** Push a resolved brain / effort / prompt into a LIVE thread. Each is a
   *  no-op when the thread isn't live (the factory applies it on rehydrate). */
  live: {
    setBrain: (sessionId: string, brain: Brain) => Promise<void>;
    setReasoningLevel: (sessionId: string, level: string) => void;
    refreshPrompt: (sessionId: string) => void;
  };
  /** The cockpit catalog (same as /gateway/control, /gateway/control/models). */
  catalog: {
    providers: () => string[];
    models: (provider: string) => Promise<Array<{ id: string }>>;
    reasoningLevels: () => string[];
  };
  /** The default assistant's brain as the cockpit shows it. */
  defaultBrain: () => { provider: string; model: string; reasoningLevel?: string };
  /** Phone push (PhonePush.send); absent when APNs is not configured. */
  push?: (message: { title: string; body: string; data?: Record<string, unknown>; collapseId?: string }) => Promise<unknown>;
  log?: (line: string) => void;
}

export class PersonaRuntime<Brain = unknown> {
  readonly store: PersonaStore;
  private readonly brains = new Map<string, Brain>();
  private sessions?: PersonaSessionHost;

  constructor(private readonly opts: PersonaRuntimeOptions<Brain>) {
    this.store = new PersonaStore(opts.home);
  }

  /** Late-bound: SessionManager is built with this runtime's hooks. */
  attach(sessions: PersonaSessionHost): void {
    this.sessions = sessions;
  }

  /** Load personas and resolve every brain, BEFORE sessions rehydrate, so a
   *  persona thread comes back on its own model. A brain that won't resolve
   *  (a key removed since) falls back to the default brain in the factory. */
  async boot(): Promise<Persona[]> {
    const all = await this.store.load();
    await Promise.all(all.map((p) => this.prepareBrain(p).catch((err) => this.log(`persona ${p.id}: brain ${p.provider}/${p.model} unavailable (${errText(err)})`))));
    return all;
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private brainKey(provider: string, model: string): string {
    return `${provider}\u0000${model}`;
  }

  async prepareBrain(persona: Pick<Persona, "provider" | "model">): Promise<Brain> {
    const key = this.brainKey(persona.provider, persona.model);
    const cached = this.brains.get(key);
    if (cached !== undefined) return cached;
    const brain = await this.opts.resolveBrain(persona.provider, persona.model);
    this.brains.set(key, brain);
    return brain;
  }

  /** The persona a session factory request belongs to. */
  personaFor(req: { sessionId: string; personaId?: string }): Persona | undefined {
    if (req.personaId) return this.store.get(req.personaId);
    return this.store.bySession(req.sessionId);
  }

  /** Sync: the cached brain for a persona, or undefined (→ default brain). */
  brainFor(persona: Persona | undefined): Brain | undefined {
    return persona ? this.brains.get(this.brainKey(persona.provider, persona.model)) : undefined;
  }

  /** The per-session prompt tail: texting doctrine (phone/Telegram) + role. */
  promptLayers(sessionId: string, surface: string | undefined, personaId?: string): string {
    const persona = this.personaFor({ sessionId, personaId });
    return sessionPromptLayers(surface, persona ?? null);
  }

  sessionHooks(): SessionPersonaHooks {
    return {
      resolve: (personaId) => {
        const p = this.store.get(personaId);
        return p ? { provider: p.provider, model: p.model } : null;
      },
      bind: (personaId, sessionId) => {
        const p = this.store.get(personaId);
        if (!p || p.sessionId === sessionId) return;
        const previous = p.sessionId;
        const next = { ...p, sessionId, updatedAt: new Date().toISOString() };
        // A persona created over REST is only staged at this point; the REST
        // handler saves it. A WS session.create re-binds a saved persona.
        this.store.stage(next);
        if (!previous) return;
        void this.store.save(next).catch((err) => this.log(`persona ${p.id}: rebind save failed (${errText(err)})`));
        // One thread per persona: the old one is archived (rollout kept) so it
        // can't resurface as an anonymous phone thread — or worse, be picked
        // as the default Ares thread.
        void this.sessions?.archive(previous).catch((err) => this.log(`persona ${p.id}: archiving old thread failed (${errText(err)})`));
      },
      personaOf: (sessionId) => this.store.bySession(sessionId)?.id,
    };
  }

  private requireSessions(): PersonaSessionHost {
    if (!this.sessions) throw new Error("persona runtime is not attached to a session manager");
    return this.sessions;
  }

  /** The default "ares" thread on the phone: the newest mobile session that
   *  isn't any persona's. */
  async defaultThread(): Promise<string | undefined> {
    const candidates = this.requireSessions()
      .list()
      .filter((s) => s.surface === "mobile" && !this.store.bySession(s.id));
    let best: { id: string; at: number } | undefined;
    for (const s of candidates) {
      const at = await fs.stat(rolloutPath(this.opts.home, s.id)).then((st) => st.mtimeMs).catch(() => 0);
      if (!best || at > best.at) best = { id: s.id, at };
    }
    return best?.id;
  }

  /** Mounted on the phone API (after its bearer check). */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    return handlePersonasApi(req, res, url, {
      store: this.store,
      providers: () => this.opts.catalog.providers(),
      models: (provider) => this.opts.catalog.models(provider),
      reasoningLevels: () => this.opts.catalog.reasoningLevels(),
      defaultPersona: async () => {
        const brain = this.opts.defaultBrain();
        const sessionId = await this.defaultThread();
        return { ...brain, ...(sessionId ? { sessionId } : {}) };
      },
      createSession: async (persona) => {
        await this.prepareBrain(persona);
        return this.requireSessions().create({ surface: "mobile", tenant: { role: "owner" }, personaId: persona.id }).id;
      },
      archiveSession: async (sessionId) => {
        await this.requireSessions().archive(sessionId);
      },
      busy: (sessionId) => this.requireSessions().list().find((s) => s.id === sessionId)?.busy ?? false,
      lastMessage: (sessionId) => lastThreadMessage(rolloutPath(this.opts.home, sessionId)),
      apply: async (persona, changed) => {
        if (!persona.sessionId) return;
        if (changed.brain) await this.opts.live.setBrain(persona.sessionId, await this.prepareBrain(persona));
        if (changed.effort && persona.reasoningLevel) this.opts.live.setReasoningLevel(persona.sessionId, persona.reasoningLevel);
        if (changed.layer) this.opts.live.refreshPrompt(persona.sessionId);
      },
      kickoff: (sessionId, text) => {
        void this.requireSessions()
          .send(sessionId, text)
          .catch((err) => this.log(`persona kickoff in ${sessionId} failed: ${errText(err)}`));
      },
      log: this.opts.log,
    });
  }

  /**
   * TelegramScheduler.routeAlarm: run a fired alarm back in the thread that
   * set it. Handled when the thread is a persona's, or the alarm carries a
   * prompt; everything else stays an ordinary Telegram ping. Resolves once the
   * turn is ADMITTED — the push follows when it settles.
   */
  async routeAlarm(alarm: RoutableAlarm, now: Date): Promise<boolean> {
    const sessionId = alarm.sessionId;
    if (!sessionId) return false;
    const persona = this.store.bySession(sessionId);
    if (!persona && !alarm.prompt) return false;
    const sessions = this.requireSessions();
    const summary = await sessions.ensureLive(sessionId);
    if (!summary) return false;
    const text = scheduledTurnText(alarm, now);
    const inputId = `alarm_${alarm.id}_${now.toISOString().slice(0, 16)}`;
    void this.runAndNotify(sessionId, text, inputId, persona, summary.surface === "mobile" || Boolean(persona))
      .catch((err) => this.log(`alarm ${alarm.id} run in ${sessionId} failed: ${errText(err)}`));
    return true;
  }

  private async runAndNotify(sessionId: string, text: string, inputId: string, persona: Persona | undefined, notify: boolean): Promise<void> {
    const sessions = this.requireSessions();
    await sessions.send(sessionId, text, { inputId });
    await sessions.flush();
    if (!notify || !this.opts.push) return;
    const last = await lastThreadMessage(rolloutPath(this.opts.home, sessionId), 2_000);
    if (!last || last.role !== "assistant") return;
    const body = firstLine(last.text);
    if (!body) return;
    await this.opts.push({
      title: persona?.name ?? "Ares",
      body,
      data: { kind: "persona_message", personaId: persona?.id ?? DEFAULT_PERSONA_ID, sessionId },
      collapseId: `persona-${persona?.id ?? DEFAULT_PERSONA_ID}`,
    });
  }
}

/** What the thread receives when an alarm fires. The (System: …) wrapper is
 *  stripped from titles and previews, so the thread reads like a text. */
export function scheduledTurnText(alarm: RoutableAlarm, now: Date): string {
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const task = alarm.prompt?.trim() || alarm.body?.trim() || `Remind the owner: ${alarm.label}`;
  return (
    `(System: your scheduled check "${alarm.label}" is due now, at ${time}. Do it, then text the owner what they need to know, ` +
    `in your own voice — short, no preamble, don't mention this note. If there's genuinely nothing new, say so in one line.)\n\n${task}`
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
