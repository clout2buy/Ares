// Agents — how one of the owner's agents reaches the others.
//
// AGENT-SOCIETY (docs/AGENT-SOCIETY-DESIGN.md): agents text each other the way
// people do. A text is fire-and-acknowledge — it lands in the other agent's
// chat as a new message and this call returns at once; their answer comes back
// later as its own message in YOUR chat (they text you back with this same
// tool). Every text shows up in the owner's sidebar, so nothing is private
// from the owner. Agents may create agents; only the owner deletes one.
import { z } from "zod";
import { buildTool } from "@ares/tools";
import { agentsHost, type AgentCard } from "./agentScope.js";

const input = z
  .object({
    action: z.enum(["list", "text", "create"]).describe("list the owner's agents, text one of them, or create a new agent"),
    to: z.string().min(1).max(60).optional().describe("text: the agent's name (or id)"),
    message: z.string().min(1).max(4000).optional().describe("text: what to say — write it like a text to a colleague, with everything they need"),
    urgent: z.boolean().optional().describe("text: true only when it cannot wait for their current work to finish"),
    name: z.string().min(1).max(40).optional().describe("create: the new agent's name"),
    role: z.string().min(1).max(4000).optional().describe("create: their role, in plain words, the way the owner would brief them"),
    emoji: z.string().max(8).optional().describe("create: one emoji for their avatar"),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).optional().describe("create: avatar colour, hex"),
    model: z.string().max(120).optional().describe("create: model id (default: the owner's current model)"),
  })
  .strict();

const line = (a: AgentCard) => `${a.emoji ? a.emoji + " " : ""}${a.name} (${a.id}) · ${a.model} — ${a.role}`;

export function makeAgentsTool() {
  return buildTool({
    name: "Agents",
    description:
      "The owner's personal agents (the desktop sidebar contacts — each has its own role, memory, Forge and model). " +
      "list shows who exists; text sends one of them a message (fire-and-acknowledge: it lands in their chat now, and their reply arrives later as a new message in yours — do not wait or poll for it); " +
      "create makes a new agent when the owner asks for one or a job clearly needs its own specialist. Agents cannot delete agents — only the owner can.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: input,
    activityDescription: (i) => `Agents ${i.action}${i.to ? " → " + i.to : i.name ? ": " + i.name : ""}`,

    async call(i, ctx): Promise<{ output: unknown; display: string }> {
      const host = agentsHost();
      if (!host) throw new Error("agents are not available in this process (the desktop app hosts them)");
      const from = ctx?.sessionId ?? "";
      if (i.action === "list") {
        const { self, agents } = host.list(from);
        const others = agents.filter((a) => a.id !== self?.id);
        return {
          output: { self: self ?? null, agents: others },
          display: [self ? `you: ${line(self)}` : "you: Ares (the default agent)", ...(others.length ? others.map(line) : ["no other agents yet"])].join("\n"),
        };
      }
      if (i.action === "text") {
        if (!i.to || !i.message) throw new Error("text needs to and message");
        const sent = await host.text(from, i.to, i.message, i.urgent === true);
        return {
          output: { ok: true, to: sent.to, threadId: sent.threadId },
          display: `texted ${sent.to.name} — their reply will arrive as a new message here`,
        };
      }
      if (!i.name || !i.role) throw new Error("create needs name and role");
      const made = await host.create(from, { name: i.name, role: i.role, emoji: i.emoji, color: i.color, model: i.model });
      return { output: { ok: true, agent: made }, display: `created agent ${line(made)}` };
    },
  });
}
