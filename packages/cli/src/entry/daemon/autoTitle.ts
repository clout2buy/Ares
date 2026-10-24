// Chat names that say what the chat is about.
//
// A chat used to be named by its first message, cut short: "hi", "effort
// check: reply with just ok", "lets work on paradice parcoure up in forge"
// (owner, 2026-10-23: "the wack ass autonaming"). After a turn ends, a chat
// with no name yet gets a 2-5 word topic from the model. Greetings and tests
// are skipped until the chat says something worth naming; a chat the owner
// named is never touched.

import { loadSessionSnapshot, openWorkspaceSessionKernel, renameSession } from "@ares/core";

/** Turns a chat may go unnamed (greetings, tests) before the titler gives up on it. */
const MAX_ATTEMPTS = 3;

const SYSTEM =
  "You name chats for a messaging app. Reply with ONLY the name: 2 to 5 words, Title Case, " +
  "no quotes, no trailing punctuation, no emoji. Name the topic, not the request " +
  '(e.g. "Paradise Run Parkour Game", "WeMod Trainer Hashes", "Party Video to MP3"). ' +
  "If the chat is only a greeting, a test, or too vague to name, reply exactly: SKIP";

export interface AutoTitlerOptions {
  workspace: string;
  /** One cheap model call (system, user) → text. */
  ask: (system: string, user: string) => Promise<string>;
  /** Chats that are not the owner's to see (room seats, child tasks). */
  skip?: (sessionId: string) => boolean;
  emit: (payload: Record<string, unknown>) => void;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .join(" ");
}

/** Strip what models wrap a name in, and refuse anything that is not a name. */
export function cleanTitle(raw: string): string | null {
  const line = raw.trim().split(/\r?\n/)[0] ?? "";
  const name = line.replace(/^(title|name)\s*:\s*/i, "").replace(/^["'“”‘’*#\s]+|["'“”‘’*.!?:;,\s]+$/g, "").replace(/\s+/g, " ");
  if (!name || /^skip$/i.test(name)) return null;
  const words = name.split(" ");
  if (words.length > 7 || name.length > 60) return null;
  return name;
}

export function createAutoTitler(options: AutoTitlerOptions): (sessionId: string) => void {
  const attempts = new Map<string, number>();
  const busy = new Set<string>();
  return (sessionId) => {
    if (busy.has(sessionId) || (attempts.get(sessionId) ?? 0) >= MAX_ATTEMPTS || options.skip?.(sessionId)) return;
    busy.add(sessionId);
    void (async () => {
      const kernel = await openWorkspaceSessionKernel(options.workspace);
      const row = kernel.getSession(sessionId);
      // Named already (by the owner, or by us on an earlier turn), or not a top-level chat.
      if (!row || row.archived || row.title || row.parentSessionId) {
        attempts.set(sessionId, MAX_ATTEMPTS);
        return;
      }
      const snapshot = await loadSessionSnapshot(options.workspace, sessionId, { maxMessages: 12 });
      const lines: string[] = [];
      for (const message of snapshot.messages) {
        const text = textOf((message as { content?: unknown }).content).replace(/data:image\/[^\s]+/g, "[image]").replace(/\s+/g, " ").trim();
        if (!text || (message.role !== "user" && message.role !== "assistant")) continue;
        lines.push(`${message.role === "user" ? "Owner" : "Agent"}: ${text.slice(0, 400)}`);
      }
      if (!lines.some((l) => l.startsWith("Owner:")) || !lines.some((l) => l.startsWith("Agent:"))) return;
      attempts.set(sessionId, (attempts.get(sessionId) ?? 0) + 1);
      const name = cleanTitle(await options.ask(SYSTEM, lines.slice(0, 8).join("\n")));
      if (!name) return;
      // The owner may have renamed it while we were asking.
      if (kernel.getSession(sessionId)?.title) return;
      const ok = await renameSession(options.workspace, sessionId, name);
      if (ok) {
        attempts.set(sessionId, MAX_ATTEMPTS);
        options.emit({ type: "session_renamed", id: sessionId, label: name, ok: true, auto: true });
      }
    })()
      .catch(() => undefined)
      .finally(() => busy.delete(sessionId));
  };
}
