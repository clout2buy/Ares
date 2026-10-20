// Desktop agents — which agent a session belongs to, process-wide.
//
// The desktop sidebar is a list of agents (the same Persona records the phone
// app makes), and every chat under an agent is a daemon session bound to it.
// Several subsystems need "whose session is this?" synchronously and far from
// the daemon's command loop: the memory scope (each agent remembers on its
// own), the Forge (each agent has its own studios), and the Agents tool (an
// agent texting another). This module is that one answer, set by the daemon
// when a session is bound and read everywhere else.
//
// Unbound sessions are plain Ares: owner memory, the shared Forge, no layer.

const sessionAgents = new Map<string, string>();

export function setSessionAgent(sessionId: string, agentId: string | undefined): void {
  if (!sessionId) return;
  if (agentId) sessionAgents.set(sessionId, agentId);
  else sessionAgents.delete(sessionId);
}

export function agentOfSession(sessionId: string | undefined): string | undefined {
  return sessionId ? sessionAgents.get(sessionId) : undefined;
}

/** Forget every session of an agent (it was deleted). */
export function clearAgentSessions(agentId: string): void {
  for (const [sid, id] of sessionAgents) if (id === agentId) sessionAgents.delete(sid);
}

/** The living-memory scope an agent reads and writes. It sees the owner's
 *  shared (unscoped) memories plus its own; the owner and other agents never
 *  see its scope. */
export function agentMemoryScope(agentId: string): string {
  return `agent:${agentId}`;
}

/** Studio ids are namespaced per agent so "the car" Bob builds and "the car"
 *  Ava builds are two different models. Plain Ares keeps unprefixed ids, so
 *  every studio made before agents existed is still where it was. */
export function agentStudioId(sessionId: string | undefined, base: string): string {
  const agent = agentOfSession(sessionId);
  return agent ? `${agent.replace(/^p_/, "")}-${base}` : base;
}

// ─── The Agents tool's host (the daemon registers it) ─────────────────────

export interface AgentCard {
  id: string;
  name: string;
  emoji?: string;
  role: string;
  model: string;
}

export interface AgentsHost {
  /** Every agent, plus which one (if any) is asking. */
  list(fromSession: string): { self?: AgentCard; agents: AgentCard[] };
  /** Deliver a text to another agent. Fire-and-acknowledge: resolves once it
   *  is queued in the recipient's chat, not when they answer. */
  text(fromSession: string, to: string, message: string, urgent: boolean): Promise<{ to: AgentCard; threadId: string }>;
  /** Set the asking agent's own profile picture (JPEG/PNG/WebP bytes). */
  avatar(fromSession: string, bytes: Buffer): Promise<AgentCard>;
  /** Copy memories the caller can see (Ares: the owner's main memory; an
   *  agent: its own) into another agent, optionally only about a topic. */
  handMemory(fromSession: string, to: string, about?: string): Promise<{ to: AgentCard; copied: number; skipped: number }>;
  /** Export the caller's own memories (an agent's, or a named agent's when
   *  the owner's main chat asks) to Markdown + JSON files. */
  exportMemory(fromSession: string, agent?: string): Promise<{ agent: AgentCard; markdown: string; json: string; count: number }>;
  /** Add or remove one of an agent's standing rules (the asking agent's own;
   *  from Ares's main chat, the agent named in `to`). */
  rules(fromSession: string, change: { to?: string; add?: string; remove?: string }): Promise<{ agent: AgentCard; rules: string[] }>;
  /** Save (or drop) one of the asking agent's lessons. */
  lessons(fromSession: string, change: { to?: string; add?: string; remove?: string; from?: string }): Promise<{ agent: AgentCard; lessons: string[] }>;
  /** An agent makes an agent. Only the owner can delete one. */
  create(fromSession: string, spec: { name: string; role: string; emoji?: string; color?: string; model?: string }): Promise<AgentCard>;
}

let host: AgentsHost | undefined;

export function setAgentsHost(next: AgentsHost | undefined): void {
  host = next;
}

export function agentsHost(): AgentsHost | undefined {
  return host;
}
