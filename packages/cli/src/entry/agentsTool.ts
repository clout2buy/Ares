// Agents — how one of the owner's agents reaches the others.
//
// AGENT-SOCIETY (docs/AGENT-SOCIETY-DESIGN.md): agents text each other the way
// people do. A text is fire-and-acknowledge — it lands in the other agent's
// chat as a new message and this call returns at once; their answer comes back
// later as its own message in YOUR chat (they text you back with this same
// tool). Every text shows up in the owner's sidebar, so nothing is private
// from the owner. Agents may create agents; only the owner deletes one.
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildTool } from "@ares/tools";
import { agentsHost, type AgentCard } from "./agentScope.js";

const input = z
  .object({
    action: z.enum(["list", "text", "create", "avatar", "hand_memory", "export_memory", "rule", "lesson"]).describe("list the owner's agents, text one of them, create a new agent, set YOUR OWN profile picture, hand memories to an agent, export an agent's memory to files, add/remove one of your standing rules, or save/drop a lesson you learned"),
    to: z.string().min(1).max(60).optional().describe("text: the agent's name (or id)"),
    message: z.string().min(1).max(4000).optional().describe("text: what to say — write it like a text to a colleague, with everything they need"),
    urgent: z.boolean().optional().describe("text: true only when it cannot wait for their current work to finish"),
    name: z.string().min(1).max(40).optional().describe("create: the new agent's name"),
    role: z.string().min(1).max(4000).optional().describe("create: their role, in plain words, the way the owner would brief them"),
    emoji: z.string().max(8).optional().describe("create: one emoji for their avatar"),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).optional().describe("create: avatar colour, hex"),
    model: z.string().max(120).optional().describe("create: model id (default: the owner's current model)"),
    about: z.string().min(1).max(200).optional().describe("hand_memory: only memories about this (e.g. 'my finances', 'the racing game'); omit to hand everything"),
    add_rule: z.string().min(1).max(400).optional().describe("rule: a standing rule to keep from now on — in every chat AND every room you sit in (e.g. 'in group chats, keep replies to one line'). Save one whenever the owner says 'always…', 'from now on…', 'whenever you're in a group…'."),
    remove_rule: z.string().min(1).max(400).optional().describe("rule: drop the standing rule that contains this text"),
    add_lesson: z.string().min(1).max(240).optional().describe("lesson: one short, reusable lesson from a job (what worked, what failed, what these people like) — it rides in every chat and room you sit in, so you do better next time. Not a diary entry."),
    remove_lesson: z.string().min(1).max(240).optional().describe("lesson: drop the lesson that contains this text (it turned out wrong)"),
    learned_in: z.string().min(1).max(80).optional().describe("lesson: where you learned it, e.g. 'room Neon Brawl'"),
    image: z.string().min(1).max(1024).optional().describe("avatar: path to a square JPEG/PNG/WebP (≤2 MB) you made — e.g. a Forge render or a screenshot of a portrait you drew. It becomes your face in the sidebar, in chats and on the owner's iPhone."),
  })
  .strict();

const line = (a: AgentCard) => `${a.emoji ? a.emoji + " " : ""}${a.name} (${a.id}) · ${a.model} — ${a.role}`;

export function makeAgentsTool() {
  return buildTool({
    name: "Agents",
    description:
      "The owner's personal agents (the desktop sidebar contacts — each has its own role, memory, Forge and model). " +
      "list shows who exists; text sends one of them a message (fire-and-acknowledge: it lands in their chat now, and their reply arrives later as a new message in yours — do not wait or poll for it); " +
      "hand_memory copies what you remember (from Ares's chat: the owner's main memory; from an agent: its own) into the agent named in to — all of it, or just what is about a topic — when the owner asks to give an agent memory or history; export_memory writes an agent's own memories to Markdown + JSON files (from Ares's chat, name the agent in to). " +
      "create makes a new agent when the owner asks for one or a job clearly needs its own specialist; avatar sets your own profile picture from an image file you made (do it when the owner asks you to pick or make a pic). Agents cannot delete agents — only the owner can.",
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
      if (i.action === "hand_memory") {
        if (!i.to) throw new Error("hand_memory needs to (the agent receiving the memories)");
        const done = await host.handMemory(from, i.to, i.about);
        return {
          output: { ok: true, to: done.to, copied: done.copied, skipped: done.skipped },
          display: `handed ${done.copied} memor${done.copied === 1 ? "y" : "ies"} to ${done.to.name}${i.about ? ` about ${i.about}` : ""}${done.skipped ? ` (${done.skipped} they already had)` : ""}`,
        };
      }
      if (i.action === "rule") {
        if (!i.add_rule && !i.remove_rule) throw new Error("rule needs add_rule or remove_rule");
        const out = await host.rules(from, { to: i.to, add: i.add_rule, remove: i.remove_rule });
        return { output: { ok: true, agent: out.agent, rules: out.rules }, display: `${out.agent.name}'s rules:\n${out.rules.map((r) => `- ${r}`).join("\n") || "(none)"}` };
      }
      if (i.action === "lesson") {
        if (!i.add_lesson && !i.remove_lesson) throw new Error("lesson needs add_lesson or remove_lesson");
        const out = await host.lessons(from, { to: i.to, add: i.add_lesson, remove: i.remove_lesson, from: i.learned_in });
        return { output: { ok: true, agent: out.agent.name, lessons: out.lessons.length }, display: `${out.agent.name} has ${out.lessons.length} lesson${out.lessons.length === 1 ? "" : "s"}` };
      }
      if (i.action === "export_memory") {
        const out = await host.exportMemory(from, i.to);
        return { output: { ok: true, ...out }, display: `exported ${out.count} of ${out.agent.name}'s memories to ${out.markdown}` };
      }
      if (i.action === "avatar") {
        if (!i.image) throw new Error("avatar needs image (a file path)");
        const base = (ctx as { workspace?: string } | undefined)?.workspace ?? process.cwd();
        const file = path.resolve(base, i.image);
        const bytes = await fs.readFile(file);
        if (bytes.length > 2 * 1024 * 1024) throw new Error("the picture is over 2 MB — crop or shrink it first");
        const who = await host.avatar(from, bytes);
        return { output: { ok: true, agent: who }, display: `${who.name}'s profile picture is now ${path.basename(file)}` };
      }
      if (!i.name || !i.role) throw new Error("create needs name and role");
      const made = await host.create(from, { name: i.name, role: i.role, emoji: i.emoji, color: i.color, model: i.model });
      return { output: { ok: true, agent: made }, display: `created agent ${line(made)}` };
    },
  });
}
