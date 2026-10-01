// The garrison side of the phone's Goals and Memory surfaces: the goal runner
// (what makes a goal with an agent assigned actually run), and the two route
// handlers the phone API mounts. Kept out of garrisonCmd.ts so the gateway
// command only wires three hooks, and so the coupling to sessions, personas
// and the push channel is one small seam.

import { appendAudit } from "@ares/core";
import { rolloutPath } from "@ares/garrison";
import { GoalsStore } from "@ares/tools";
import { DEFAULT_PERSONA_ID, lastThreadMessage } from "../personas.js";
import { GoalRunner } from "../goalRunner.js";
import { createGoalsApi, type GoalAgent } from "../phoneGoals.js";
import { createMemoryApi } from "../phoneMemory.js";
import { mnemosyneHandle } from "./mnemosyneRuntime.js";
import type { PersonaRuntime } from "./personaRuntime.js";
import type { CliRuntimeContext } from "./runtime.js";

/** The slice of SessionManager this seam drives. */
export interface GoalSessionHost {
  list(): Array<{ id: string; busy: boolean }>;
  send(sessionId: string, text: string, options?: { inputId?: string }): Promise<void>;
  flush(): Promise<void>;
}

export interface GoalSurfacesOptions {
  context: Pick<CliRuntimeContext, "home" | "aresHome" | "mind">;
  sessions: GoalSessionHost;
  personas: Pick<PersonaRuntime, "store" | "defaultThread">;
  /** Phone push (PhonePush.send); absent when APNs is not configured. */
  push?: (message: { title: string; body: string; data?: Record<string, unknown>; collapseId?: string }) => Promise<unknown>;
  isPaused: () => boolean;
  log: (line: string) => void;
}

export interface GoalSurfaces {
  runner: GoalRunner;
  goalsApi: ReturnType<typeof createGoalsApi>;
  memoryApi: ReturnType<typeof createMemoryApi>;
  /** The scheduler's `goals` hook: reports what it did, "idle" when nothing was due. */
  tick: () => Promise<string>;
}

export function startGoalSurfaces(opts: GoalSurfacesOptions): GoalSurfaces {
  const { context, sessions, personas } = opts;
  const store = new GoalsStore(context.home);
  const audit = (entry: Parameters<typeof appendAudit>[0]) => void appendAudit(entry, context.home);
  const agents = (): GoalAgent[] => [
    { id: DEFAULT_PERSONA_ID, name: "Ares" },
    ...personas.store.list().map((p) => ({ id: p.id, name: p.name })),
  ];
  const nameOf = (id: string): string => agents().find((a) => a.id === id)?.name ?? "Ares";

  const runner = new GoalRunner({
    store,
    agentName: nameOf,
    sessionFor: async (agentId) => (agentId === DEFAULT_PERSONA_ID ? personas.defaultThread() : personas.store.get(agentId)?.sessionId),
    busy: (sessionId) => sessions.list().find((s) => s.id === sessionId)?.busy ?? false,
    runTurn: async (sessionId, text, inputId) => {
      await sessions.send(sessionId, text, { inputId });
      await sessions.flush();
      const last = await lastThreadMessage(rolloutPath(context.home, sessionId), 2_000);
      return last && last.role === "assistant" ? { reply: last.text, replyAt: last.at ?? new Date().toISOString() } : {};
    },
    ...(opts.push
      ? {
          notify: (n) =>
            opts.push!({
              title: n.title,
              body: n.body,
              // Same kind a persona's message uses, so a tap opens that agent's thread.
              data: { kind: "persona_message", personaId: n.agentId, sessionId: n.sessionId, goalId: n.goalId },
              collapseId: `goal-${n.goalId}`,
            }),
        }
      : {}),
    isPaused: opts.isPaused,
    audit,
    log: (line) => opts.log(`goals: ${line}`),
  });

  const goalsApi = createGoalsApi({
    home: context.home,
    agents,
    runner: { checkInNow: (id) => runner.checkInNow(id), isRunning: (id) => runner.isRunning(id) },
    audit,
    log: (line) => opts.log(`goals: ${line}`),
  });

  // Which agent a remembered thing came from: a persona's thread, the default
  // thread, or unknown. Live sessions are read once a second, not per item.
  let liveAt = 0;
  let live = new Set<string>();
  const liveSessions = (): Set<string> => {
    const now = Date.now();
    if (now - liveAt > 1_000) {
      live = new Set(sessions.list().map((s) => s.id));
      liveAt = now;
    }
    return live;
  };
  const memoryApi = createMemoryApi({
    memoryFile: context.mind.memoryFile,
    wire: async () => (await mnemosyneHandle(context.aresHome).catch(() => null))?.client ?? null,
    agentOfSession: (sessionId) => {
      const persona = personas.store.bySession(sessionId);
      if (persona) return { id: persona.id, name: persona.name };
      return liveSessions().has(sessionId) ? { id: DEFAULT_PERSONA_ID, name: "Ares" } : undefined;
    },
    audit,
    log: (line) => opts.log(`memory: ${line}`),
  });

  const tick = async (): Promise<string> => {
    const { ran } = await runner.tick();
    return ran.length === 0 ? "idle" : `ran ${ran.length} check-in${ran.length === 1 ? "" : "s"}`;
  };

  return { runner, goalsApi, memoryApi, tick };
}
