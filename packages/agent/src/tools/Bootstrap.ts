// Bootstrap — finalizes the v4 agent birth ritual.
//
// The model calls this tool exactly once, when it has gathered the seven
// bootstrap answers from the user. The tool atomically writes IDENTITY.md,
// SOUL.md, USER.md (and ensures HEARTBEAT.md / MEMORY.md exist) under the
// global Ares agent home (~/.ares/), then deletes BOOTSTRAP.md. The agent
// never has to touch raw Write to perform its own birth.

import { z } from "zod";
import { buildTool } from "@ares/tools";
import { completeBootstrap, ensureAgentScaffold, type BootstrapProfile } from "../bootstrap/bootstrap.js";
import { agentPaths, aresAgentHome } from "../paths.js";
import { exists } from "../files.js";
import { emitLifecycle } from "../lifecycle/bus.js";
import { gainForTarget } from "../voice.js";

const inputSchema = z
  .object({
    user_name: z
      .string()
      .min(1)
      .describe("What the user wants to be called. Use exactly what they said — do not normalize."),
    user_timezone: z
      .string()
      .optional()
      .describe("IANA timezone string if known, e.g. America/Los_Angeles. Leave unset to use the system default."),
    languages: z
      .string()
      .optional()
      .describe("Primary languages/stacks the user works in, comma-separated. Use 'unknown' if unsure."),
    style: z
      .string()
      .optional()
      .describe("How the user wants the agent to write code: terse/detailed commits, tabs/spaces, test-first/move-fast, etc."),
    conventions: z
      .string()
      .optional()
      .describe("Other relevant working conventions or norms the user mentioned."),
    agent_name: z
      .string()
      .min(1)
      .describe("The name the agent chose for itself in conversation with the user."),
    creature: z
      .string()
      .min(1)
      .describe("Self-chosen creature/type. e.g. 'coding agent', 'lab partner', 'familiar', 'daemon'. Respect user pushback."),
    vibe: z
      .string()
      .min(1)
      .describe("Self-chosen vibe. e.g. direct, playful, paranoid, careful, ruthless, op, or a custom phrase."),
    emoji: z
      .string()
      .min(1)
      .describe("Self-chosen emoji or plain-text mark. One character or a short bracketed mark like '[R]'."),
    avatar: z
      .string()
      .optional()
      .describe("Optional richer avatar string. Defaults to the emoji."),
  })
  .strict();

export interface BootstrapToolOutput {
  home: string;
  identityPath: string;
  soulPath: string;
  userPath: string;
  heartbeatPath: string;
  memoryPath: string;
  bornAt: string;
  bootstrapRemoved: boolean;
}

export const BootstrapTool = buildTool({
  name: "Bootstrap",
  description:
    "Finalize the Ares v4 agent birth ritual. Call this exactly once, after the user has answered the bootstrap questions and you have picked your own name, creature, vibe, and emoji. Writes IDENTITY/SOUL/USER atomically under the global agent home (~/.ares/) so identity survives every repo update or fresh clone. Do NOT use the Write tool for these files — that's the agent's own brain and belongs in the global home, not the workspace.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `Bootstrap ${i.agent_name} for ${i.user_name}`,

  async call(input, ctx): Promise<{ output: BootstrapToolOutput; touchedFiles?: string[]; display: string }> {
    const home = aresAgentHome(process.env.ARES_HOME);
    const paths = agentPaths(home);
    await ensureAgentScaffold({ home, workspace: ctx.workspace });

    const profile: BootstrapProfile = {
      userName: input.user_name,
      userTimezone: input.user_timezone,
      languages: input.languages,
      style: input.style,
      conventions: input.conventions,
      agentName: input.agent_name,
      creature: input.creature,
      vibe: input.vibe,
      emoji: input.emoji,
      avatar: input.avatar,
      bornAt: new Date(),
    };

    const state = await completeBootstrap(profile, { home, workspace: ctx.workspace });
    const bootstrapStillThere = await exists(paths.bootstrap);
    // 5 files materialized atomically: IDENTITY, SOUL, USER, HEARTBEAT, MEMORY,
    // plus CAPABILITIES = 6 fresh self-files. That's the +6 BORN delta.
    const gain = gainForTarget("BORN", 6, "self");
    emitLifecycle({ type: "bootstrap_complete", agentName: input.agent_name, home: state.home, gain });

    return {
      output: {
        home: state.home,
        identityPath: paths.identity,
        soulPath: paths.soul,
        userPath: paths.user,
        heartbeatPath: paths.heartbeat,
        memoryPath: paths.memory,
        bornAt: profile.bornAt!.toISOString(),
        bootstrapRemoved: !bootstrapStillThere,
      },
      touchedFiles: [paths.identity, paths.soul, paths.user, paths.heartbeat, paths.memory],
      display: `+${gain.delta} ${gain.target} — ${input.agent_name} ↳ ${state.home}`,
    };
  },
});
