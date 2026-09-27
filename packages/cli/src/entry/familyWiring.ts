import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersonaStore } from "../personas.js";
import { lastThreadMessage } from "../personas.js";
import { rolloutPath } from "@ares/garrison";

type Message = { id: string; from: string; to: string; sender: string; text: string; threadId: string; mode: string };

export function startFamilyReplies(opts: {
  home: string;
  relay: string;
  token: string;
  self: "noah" | "jamara";
  store: PersonaStore;
  sessions: { send(id: string, text: string, options?: { delivery: "steer" }): Promise<void>; flush(): Promise<void> };
  push: (message: { title: string; body: string; data: Record<string, unknown> }) => Promise<unknown>;
  log: (line: string) => void;
}): () => void {
  const stateFile = path.join(opts.home, "family-replies-cursor.json");
  let busy = false;
  const auth = { authorization: `Bearer ${opts.token}`, "content-type": "application/json" };
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch(`${opts.relay}/messages`, { headers: auth, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`family relay GET ${response.status}`);
      const messages = (await response.json() as { messages: Message[] }).messages;
      let cursor = await readFile(stateFile, "utf8").then((s) => JSON.parse(s).id as string).catch(() => "");
      const start = cursor ? messages.findIndex((m) => m.id === cursor) + 1 : 0;
      if (cursor && start === 0) throw new Error("family cursor missing from relay history");
      for (let i = start; i < messages.length; i++) {
        const incoming = messages[i];
        if (incoming.to === opts.self) {
          const prior = messages.slice(0, i).reverse().find((m) => m.threadId === incoming.threadId && m.from === opts.self);
          const agents = prior && opts.store.list().filter((p) => p.name.toLowerCase() === prior.sender.toLowerCase() || p.name.toLowerCase().endsWith(` ${prior.sender.toLowerCase()}`));
          const agent = agents?.length === 1 ? agents[0] : undefined;
          const human = incoming.sender.toLowerCase() === (incoming.from === "noah" ? "noah" : "jamara");
          if (human && agent?.sessionId) {
            const alreadyReplied = async () => {
              const current = await fetch(`${opts.relay}/messages`, { headers: auth, signal: AbortSignal.timeout(10_000) });
              if (!current.ok) throw new Error(`family relay GET ${current.status}`);
              const all = (await current.json() as { messages: Message[] }).messages;
              const index = all.findIndex((m) => m.id === incoming.id);
              return index >= 0 && all.slice(index + 1).some((m) => m.threadId === incoming.threadId && m.from === opts.self && (m.sender.toLowerCase() === agent.name.toLowerCase() || agent.name.toLowerCase().endsWith(` ${m.sender.toLowerCase()}`)));
            };
            if (!await alreadyReplied()) {
              await opts.sessions.send(agent.sessionId, `(Family message from ${incoming.sender} in ${incoming.mode} chat: ${incoming.text})\nWrite only your natural reply to ${incoming.sender}. Do not call the family message tool: delivery happens automatically. Do not write an update to your owner in this turn.`, { delivery: "steer" });
              await opts.sessions.flush();
              if (!await alreadyReplied()) {
                const answer = await lastThreadMessage(rolloutPath(opts.home, agent.sessionId), 8000);
                if (answer?.role === "assistant" && answer.text.trim()) {
                  const sent = await fetch(`${opts.relay}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ to: incoming.from, sender: agent.name, text: answer.text.trim(), mode: incoming.mode, threadId: incoming.threadId }), signal: AbortSignal.timeout(10_000) });
                  if (!sent.ok) throw new Error(`family reply POST ${sent.status}`);
                }
              }
            }
            await opts.sessions.send(agent.sessionId, `(Private update to your owner only: ${incoming.sender} replied in the ${incoming.mode} chat: ${incoming.text}. Tell your owner what they said in your own voice, briefly. Do not send this update to the family chat or use the family message tool.)`);
            await opts.sessions.flush();
            const update = await lastThreadMessage(rolloutPath(opts.home, agent.sessionId), 8000);
            if (update?.role === "assistant" && update.text.trim()) {
              await opts.push({ title: agent.name, body: update.text.trim().slice(0, 180), data: { kind: "persona_message", personaId: agent.id, sessionId: agent.sessionId } });
            }
          }
          if (!human || !agent?.sessionId) await opts.push({ title: incoming.sender, body: incoming.text.slice(0, 180), data: { kind: "family_message", threadId: incoming.threadId, mode: incoming.mode } });
        }
        cursor = incoming.id;
        await writeFile(stateFile, JSON.stringify({ id: cursor }), "utf8");
      }
    } catch (err) { opts.log(`family replies: ${err instanceof Error ? err.message : String(err)}`); }
    finally { busy = false; }
  };
  void poll();
  const timer = setInterval(() => void poll(), 5_000);
  timer.unref();
  return () => clearInterval(timer);
}
