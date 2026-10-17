// Desktop agents, daemon-side.
//
// Owner, 2026-10-17: "Instead of new chats it will be agents, the same as the
// iOS app, just still with the Forge and all abilities. Each agent different
// memories, different forges, different models."
//
// An agent IS a Persona (personas.ts) — the same record the phone's
// /gateway/personas makes, in the same <home>/personas directory, so an agent
// made on one surface is the same agent on the other. The desktop adds many
// chats per agent (`desktopThreads`), kept apart from the phone's one garrison
// thread (`sessionId`).
//
// What binding a chat to an agent changes (resolveEntry applies it):
//   brain   — the agent's provider/model for every new chat
//   memory  — tenant {role:"owner", agent:id} → living-memory scope agent:<id>
//   Forge   — studio ids prefixed per agent (agentScope.agentStudioId)
//   prompt  — desktopAgentLayerBlock: who they are, who they can text
//
// Agent-to-agent texting (AGENT-SOCIETY) is fire-and-acknowledge: the text is
// queued as a new message in the recipient's newest chat and the sender's turn
// carries on. A pair is capped per window so two agents can never ping-pong
// forever on the owner's tokens.

import { randomUUID } from "node:crypto";
import {
  DESKTOP_THREADS_MAX,
  PERSONA_INSTRUCTIONS_MAX,
  PERSONA_NAME_MAX,
  PersonaStore,
  newPersonaId,
  type Persona,
} from "../../personas.js";
import { clearAgentSessions, setSessionAgent, agentOfSession, type AgentCard, type AgentsHost } from "../agentScope.js";
import { desktopAgentLayerBlock } from "../prompt/texting.js";

/** What the desktop renders for one agent. */
export interface AgentWire {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  provider: string;
  model: string;
  reasoningLevel?: string;
  instructions: string;
  threads: string[];
  /** It also has a phone thread (made on, or used from, the iPhone app). */
  onPhone: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSpec {
  name?: unknown;
  emoji?: unknown;
  color?: unknown;
  provider?: unknown;
  model?: unknown;
  reasoningLevel?: unknown;
  instructions?: unknown;
}

export interface DesktopAgentsDeps {
  home: string;
  /** The brain a new agent gets when none is named. */
  defaultBrain(): { provider: string; model: string };
  /** Queue a message as a new turn in a session (the daemon's command queue). */
  deliver(sessionId: string, goal: string, inputId: string): void;
  /** Is that session mid-turn? A non-urgent text waits for it to finish. */
  busy(sessionId: string): boolean;
  /** Untagged event to the desktop (agents_changed, agent_text). */
  emit(payload: Record<string, unknown>): void;
  now?: () => number;
}

export class AgentError extends Error {}

const COLOR_RE = /^#[0-9a-f]{6}$/i;
/** Texts one agent may send another inside PAIR_WINDOW_MS. */
export const PAIR_TEXT_LIMIT = 6;
export const PAIR_WINDOW_MS = 10 * 60_000;
/** A non-urgent text gives up waiting for an idle recipient after this, and
 *  is delivered as a steer instead (it never silently vanishes). */
const WAIT_IDLE_MS = 5 * 60_000;

function cleanString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

export function agentToWire(p: Persona): AgentWire {
  return {
    id: p.id,
    name: p.name,
    ...(p.emoji ? { emoji: p.emoji } : {}),
    ...(p.color ? { color: p.color } : {}),
    provider: p.provider,
    model: p.model,
    ...(p.reasoningLevel ? { reasoningLevel: p.reasoningLevel } : {}),
    instructions: p.instructions,
    threads: [...(p.desktopThreads ?? [])],
    onPhone: Boolean(p.sessionId),
    ...(p.createdBy ? { createdBy: p.createdBy } : {}),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

const card = (p: Persona): AgentCard => ({
  id: p.id,
  name: p.name,
  ...(p.emoji ? { emoji: p.emoji } : {}),
  role: p.instructions.replace(/\s+/g, " ").trim().slice(0, 160),
  model: p.model,
});

/** The opening line of an agent-to-agent text, as the recipient sees it. The
 *  desktop parses this back into a "from" bubble when replaying history. */
export function agentTextGoal(fromName: string, message: string, urgent: boolean): string {
  return `[text from ${fromName}${urgent ? " · urgent" : ""}] ${message.trim()}`;
}

export class DesktopAgents {
  readonly store: PersonaStore;
  private readonly pairLog = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly deps: DesktopAgentsDeps) {
    this.store = new PersonaStore(deps.home);
    this.now = deps.now ?? Date.now;
  }

  /** (Re)read the directory — the phone may have changed it — and re-index
   *  which session belongs to whom. */
  async load(): Promise<AgentWire[]> {
    await this.store.load();
    for (const p of this.store.list()) for (const sid of p.desktopThreads ?? []) setSessionAgent(sid, p.id);
    return this.list();
  }

  list(): AgentWire[] {
    return this.store.list().map(agentToWire);
  }

  get(id: string): Persona | undefined {
    return this.store.get(id);
  }

  agentForSession(sessionId: string): Persona | undefined {
    const id = agentOfSession(sessionId);
    return id ? this.store.get(id) : this.store.byDesktopThread(sessionId);
  }

  private emitChanged(): void {
    this.deps.emit({ type: "agents_list", agents: this.list() });
  }

  private parse(spec: AgentSpec, existing?: Persona): Partial<Persona> {
    const out: Partial<Persona> = {};
    if (spec.name !== undefined) {
      const name = cleanString(spec.name, PERSONA_NAME_MAX);
      if (!name) throw new AgentError("name required");
      if (name.toLowerCase() === "ares") throw new AgentError("Ares is the default agent — pick another name");
      const clash = this.store.list().find((p) => p.id !== existing?.id && p.name.toLowerCase() === name.toLowerCase());
      if (clash) throw new AgentError(`there is already an agent called ${clash.name}`);
      out.name = name;
    }
    if (spec.emoji !== undefined) out.emoji = cleanString(spec.emoji, 16);
    if (spec.color !== undefined) {
      const c = cleanString(spec.color, 7);
      if (c && !COLOR_RE.test(c)) throw new AgentError("color must be #rrggbb");
      out.color = c;
    }
    if (spec.provider !== undefined) out.provider = cleanString(spec.provider, 60);
    if (spec.model !== undefined) out.model = cleanString(spec.model, 160);
    if (spec.reasoningLevel !== undefined) out.reasoningLevel = cleanString(spec.reasoningLevel, 24);
    if (spec.instructions !== undefined) {
      if (typeof spec.instructions !== "string") throw new AgentError("instructions must be text");
      out.instructions = spec.instructions.trim().slice(0, PERSONA_INSTRUCTIONS_MAX);
    }
    return out;
  }

  async create(spec: AgentSpec, createdBy?: string): Promise<Persona> {
    await this.store.load();
    if (spec.name === undefined) throw new AgentError("name required");
    const patch = this.parse(spec);
    const brain = this.deps.defaultBrain();
    const stamp = new Date(this.now()).toISOString();
    const persona: Persona = {
      id: newPersonaId(),
      name: patch.name!,
      ...(patch.emoji ? { emoji: patch.emoji } : {}),
      ...(patch.color ? { color: patch.color } : {}),
      provider: patch.provider ?? brain.provider,
      model: patch.model ?? brain.model,
      ...(patch.reasoningLevel ? { reasoningLevel: patch.reasoningLevel } : {}),
      instructions: patch.instructions ?? "",
      sessionId: "",
      desktopThreads: [],
      ...(createdBy ? { createdBy } : {}),
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.store.save(persona);
    this.emitChanged();
    return persona;
  }

  async update(id: string, spec: AgentSpec): Promise<{ persona: Persona; brainChanged: boolean; layerChanged: boolean }> {
    await this.store.load();
    const existing = this.store.get(id);
    if (!existing) throw new AgentError("unknown agent");
    const patch = this.parse(spec, existing);
    const next: Persona = { ...existing, updatedAt: new Date(this.now()).toISOString() };
    for (const [k, v] of Object.entries(patch) as Array<[keyof Persona, unknown]>) {
      if (v === undefined) {
        if (k === "emoji" || k === "color" || k === "reasoningLevel") delete (next as Partial<Persona>)[k];
      } else (next as unknown as Record<string, unknown>)[k] = v;
    }
    await this.store.save(next);
    this.emitChanged();
    return {
      persona: next,
      brainChanged: next.provider !== existing.provider || next.model !== existing.model,
      layerChanged: next.name !== existing.name || next.instructions !== existing.instructions,
    };
  }

  /** Owner-only: the desktop's delete button, never the Agents tool. Chats
   *  stay on disk (they fall back to plain Ares), like the phone's archive. */
  async remove(id: string): Promise<string[]> {
    await this.store.load();
    const existing = this.store.get(id);
    if (!existing) return [];
    await this.store.remove(id);
    clearAgentSessions(id);
    this.emitChanged();
    return existing.desktopThreads ?? [];
  }

  /** Give a desktop chat to an agent (or back to plain Ares with null). */
  async bind(agentId: string | null, sessionId: string): Promise<Persona | undefined> {
    await this.store.load();
    const previous = this.store.byDesktopThread(sessionId);
    if (previous && previous.id !== agentId) {
      await this.store.save({ ...previous, desktopThreads: (previous.desktopThreads ?? []).filter((t) => t !== sessionId) });
    }
    if (!agentId) {
      setSessionAgent(sessionId, undefined);
      if (previous) this.emitChanged();
      return undefined;
    }
    const agent = this.store.get(agentId);
    if (!agent) throw new AgentError("unknown agent");
    setSessionAgent(sessionId, agent.id);
    if (agent.desktopThreads?.includes(sessionId)) return agent;
    const next = { ...agent, desktopThreads: [...(agent.desktopThreads ?? []), sessionId].slice(-DESKTOP_THREADS_MAX) };
    await this.store.save(next);
    this.emitChanged();
    return next;
  }

  /** A desktop chat was deleted: drop it from whoever owned it. */
  async forgetThread(sessionId: string): Promise<void> {
    const owner = this.store.byDesktopThread(sessionId);
    setSessionAgent(sessionId, undefined);
    if (!owner) return;
    await this.store.save({ ...owner, desktopThreads: (owner.desktopThreads ?? []).filter((t) => t !== sessionId) });
    this.emitChanged();
  }

  /** The system-prompt layer for an agent's chat ("" for plain Ares). */
  layerFor(agentId: string | undefined): string {
    const agent = agentId ? this.store.get(agentId) : undefined;
    if (!agent) return "";
    const contacts = [
      { name: "Ares", role: "the owner's main assistant (the default chat)" },
      ...this.store.list().filter((p) => p.id !== agent.id).map((p) => ({ name: p.name, role: p.instructions })),
    ];
    const maker = agent.createdBy ? this.store.get(agent.createdBy)?.name : undefined;
    return `\n\n${desktopAgentLayerBlock(agent, contacts, maker)}`;
  }

  /** Name or id → agent (case-insensitive name match). */
  resolve(target: string): Persona | undefined {
    const t = target.trim().replace(/^@/, "");
    return this.store.get(t) ?? this.store.list().find((p) => p.name.toLowerCase() === t.toLowerCase());
  }

  /** Has this pair spent its window? Records the attempt when it hasn't. */
  private admitPair(from: string, to: string): boolean {
    const key = `${from}\u0000${to}`;
    const now = this.now();
    const recent = (this.pairLog.get(key) ?? []).filter((t) => now - t < PAIR_WINDOW_MS);
    if (recent.length >= PAIR_TEXT_LIMIT) {
      this.pairLog.set(key, recent);
      return false;
    }
    recent.push(now);
    this.pairLog.set(key, recent);
    return true;
  }

  /** One agent (or plain Ares, fromId undefined) texts another. */
  async text(fromSession: string, to: string, message: string, urgent: boolean): Promise<{ to: Persona; threadId: string; inputId: string }> {
    await this.store.load();
    const fromAgent = this.agentForSession(fromSession);
    const target = this.resolve(to);
    if (!target) {
      if (to.trim().toLowerCase() === "ares") throw new AgentError("Ares is the owner's main chat — tell the owner in your own reply instead");
      throw new AgentError(`no agent called "${to}" — Agents list shows who exists`);
    }
    if (fromAgent && target.id === fromAgent.id) throw new AgentError("that is you");
    const fromKey = fromAgent?.id ?? "ares";
    if (!this.admitPair(fromKey, target.id)) {
      throw new AgentError(`you have texted ${target.name} ${PAIR_TEXT_LIMIT} times in the last ${PAIR_WINDOW_MS / 60_000} minutes — wait for their reply`);
    }
    let threadId = target.desktopThreads?.at(-1);
    if (!threadId) {
      threadId = `sess_${randomUUID()}`;
      await this.bind(target.id, threadId);
    } else setSessionAgent(threadId, target.id);
    const fromName = fromAgent?.name ?? "Ares";
    const goal = agentTextGoal(fromName, message, urgent);
    const inputId = `agent_text_${randomUUID()}`;
    this.deps.emit({
      type: "agent_text",
      sender: fromAgent ? { id: fromAgent.id, name: fromAgent.name, emoji: fromAgent.emoji, color: fromAgent.color } : { id: "ares", name: "Ares" },
      to: { id: target.id, name: target.name },
      fromSession,
      threadId,
      inputId,
      text: message.trim(),
      urgent,
    });
    const recipient = threadId;
    if (urgent || !this.deps.busy(recipient)) this.deps.deliver(recipient, goal, inputId);
    else {
      // Not urgent and they are mid-turn: it lands once they finish, the way a
      // text waits on a phone until its owner looks.
      const started = this.now();
      const timer = setInterval(() => {
        if (this.deps.busy(recipient) && this.now() - started < WAIT_IDLE_MS) return;
        clearInterval(timer);
        this.deps.deliver(recipient, goal, inputId);
      }, 1_500);
      timer.unref?.();
    }
    return { to: target, threadId, inputId };
  }

  /** The Agents tool's view of this directory. */
  host(): AgentsHost {
    return {
      list: (fromSession) => {
        const self = this.agentForSession(fromSession);
        return { ...(self ? { self: card(self) } : {}), agents: this.store.list().map(card) };
      },
      text: async (fromSession, to, message, urgent) => {
        const sent = await this.text(fromSession, to, message, urgent);
        return { to: card(sent.to), threadId: sent.threadId };
      },
      create: async (fromSession, spec) => {
        const maker = this.agentForSession(fromSession);
        const made = await this.create(
          { name: spec.name, instructions: spec.role, emoji: spec.emoji, color: spec.color, ...(spec.model ? { model: spec.model, provider: maker?.provider ?? this.deps.defaultBrain().provider } : {}) },
          maker?.id,
        );
        return card(made);
      },
    };
  }
}
