// Ideas — the suggestion cards on the phone's Today tab (/gateway/ideas).
//
// Tapping a card sends its `prompt` as a chat message, so a card is only as
// good as how specific it is to what the owner is actually doing. The inputs
// are what the garrison already has on disk — recent conversation titles and
// last messages, plus open tracked commitments — and the model is the cheap
// "summarize" slot, not the frontier model: this runs on a phone refresh.
//
// Bounded on purpose: at most N sessions, the newest by mtime, and only the
// TAIL of each rollout. Rollouts have reached 240 MB (2026-09-22 OOM); reading
// one whole to find its last user message would repeat that incident from a
// pull-to-refresh. Results are cached for 6 hours in <ARES_HOME>/feed/
// ideas.json; any failure falls back to a static set that is still useful.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sessionsDir } from "@ares/garrison";
import { TrackingStore } from "@ares/tools";

export interface Idea {
  id: string;
  title: string;
  prompt: string;
  icon?: string;
}

export const IDEAS_TTL_MS = 6 * 60 * 60_000;
/** A fallback set is retried sooner than a real one — a provider blip at
 *  breakfast shouldn't pin the generic cards until lunch. */
const FALLBACK_TTL_MS = 30 * 60_000;
const MIN_IDEAS = 4;
const MAX_IDEAS = 8;

export const FALLBACK_IDEAS: Idea[] = [
  { id: "fallback-brief", title: "Brief me on today", prompt: "Give me a short brief for today: weather, my calendar, anything I'm waiting on, and the one thing I should do first.", icon: "☀️" },
  { id: "fallback-pending", title: "What's still open?", prompt: "What commitments are still open — reservations, deliveries, orders, promises? Follow up on anything overdue.", icon: "📦" },
  { id: "fallback-news", title: "What's new in AI", prompt: "What happened in AI in the last 24 hours that actually matters? Keep it to five bullets with sources.", icon: "🧠" },
  { id: "fallback-dinner", title: "Find dinner nearby", prompt: "Find three good dinner spots near me that are open tonight, with hours and a maps link.", icon: "🍽️" },
  { id: "fallback-plan", title: "Plan my week", prompt: "Look at my week and help me plan it: what's fixed, what's at risk, and where I have focus time.", icon: "🗓️" },
  { id: "fallback-image", title: "Make me a wallpaper", prompt: "Make me a phone wallpaper (portrait) in a style you think I'd like, and show it to me.", icon: "🎨" },
];

// ─── Inputs ──────────────────────────────────────────────────────────────────

function stripPreamble(text: string): string {
  if (!/^\(\s*system\s*:/i.test(text)) return text;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(i + 1).trim();
  }
  return text;
}

function userText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join(" ");
}

async function readTail(file: string, bytes: number): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // Drop the (probably torn) first line when we started mid-file.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

/**
 * One line per recent owner conversation: its title and the last thing the
 * owner said. Newest first; guests' chats and `skipIds` (the feed's own
 * session) are left out.
 */
export async function recentConversationLines(
  home: string,
  opts: { maxSessions?: number; tailBytes?: number; skipIds?: ReadonlySet<string> } = {},
): Promise<string[]> {
  const dir = sessionsDir(home);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const rollouts = await Promise.all(
    names
      .filter((n) => n.endsWith(".jsonl"))
      .map(async (n) => ({ id: n.slice(0, -".jsonl".length), file: path.join(dir, n), mtime: (await fs.stat(path.join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  rollouts.sort((a, b) => b.mtime - a.mtime);
  const lines: string[] = [];
  for (const r of rollouts) {
    if (lines.length >= (opts.maxSessions ?? 8)) break;
    if (opts.skipIds?.has(r.id)) continue;
    let meta: { title?: unknown; tenant?: { role?: unknown } } = {};
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, `${r.id}.meta.json`), "utf8"));
    } catch {
      // no meta — title from the messages
    }
    if (meta.tenant?.role === "guest") continue;
    let last = "";
    try {
      const tail = await readTail(r.file, opts.tailBytes ?? 48 * 1024);
      for (const line of tail.split("\n")) {
        if (!line) continue;
        try {
          const event = (JSON.parse(line) as { event?: { type?: string; userMessage?: unknown } }).event;
          if (event?.type === "turn_start" || event?.type === "input_admitted") {
            const text = stripPreamble(userText(event.userMessage).replace(/\s+/g, " ").trim());
            if (text) last = text;
          }
        } catch {
          // torn line
        }
      }
    } catch {
      continue;
    }
    const title = typeof meta.title === "string" ? meta.title.trim() : "";
    if (!title && !last) continue;
    if (/^Today feed —/.test(title) || /^Today feed —/.test(last)) continue;
    lines.push(`- ${title || "(untitled)"}${last && last !== title ? ` — last: ${last.slice(0, 200)}` : ""}`);
  }
  return lines;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** The model's reply → 4–8 clean ideas, or null. */
export function parseIdeas(raw: string): Idea[] | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/```(?:json)?/gi, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  let rows: unknown;
  try {
    rows = JSON.parse(start !== -1 && end > start ? text.slice(start, end + 1) : text);
  } catch {
    try {
      rows = (JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { ideas?: unknown }).ideas;
    } catch {
      return null;
    }
  }
  if (rows && !Array.isArray(rows) && typeof rows === "object") rows = (rows as { ideas?: unknown }).ideas;
  if (!Array.isArray(rows)) return null;
  const ideas: Idea[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (ideas.length >= MAX_IDEAS) break;
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.replace(/\s+/g, " ").trim().slice(0, 60) : "";
    const prompt = typeof r.prompt === "string" ? r.prompt.replace(/\s+/g, " ").trim().slice(0, 500) : "";
    if (!title || !prompt || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const icon = typeof r.icon === "string" && r.icon.trim() && [...r.icon.trim()].length <= 4 ? r.icon.trim() : undefined;
    ideas.push({ id: `idea-${ideas.length + 1}-${randomUUID().slice(0, 6)}`, title, prompt, ...(icon ? { icon } : {}) });
  }
  return ideas.length >= MIN_IDEAS ? ideas : null;
}

const IDEAS_SYSTEM =
  "You suggest what a personal AI assistant could do next for its owner. You get the owner's recent conversations and open commitments. " +
  "Return ONLY a JSON array of 6 objects: {\"title\": \"2-5 words\", \"prompt\": \"the exact first-person message the owner would send, specific and actionable\", \"icon\": \"one emoji\"}. " +
  "Continue or follow up on real threads (unfinished work, overdue commitments, a natural next step); at most two generic ideas. No prose, no code fences.";

// ─── Service ─────────────────────────────────────────────────────────────────

interface IdeasCache {
  generatedAt: string;
  source: "model" | "fallback";
  ideas: Idea[];
}

export interface IdeasServiceOptions {
  home: string;
  /** One cheap completion (the summarize slot): system + user → text. */
  complete: (system: string, user: string, signal: AbortSignal) => Promise<string>;
  /** Session ids to leave out of the inputs (the feed's own session). */
  skipIds?: () => ReadonlySet<string>;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export class IdeasService {
  private readonly file: string;
  private readonly opts: IdeasServiceOptions;
  private readonly now: () => number;
  private inflight: Promise<Idea[]> | null = null;

  constructor(opts: IdeasServiceOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.file = path.join(opts.home, "feed", "ideas.json");
  }

  private async readCache(): Promise<IdeasCache | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as IdeasCache;
      return Array.isArray(parsed.ideas) && typeof parsed.generatedAt === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeCache(cache: IdeasCache): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2) + "\n", "utf8");
    await fs.rename(tmp, this.file);
  }

  /** Cached ideas when fresh, else a (deduped) regeneration. Never throws. */
  async get(): Promise<Idea[]> {
    const cache = await this.readCache();
    if (cache) {
      const age = this.now() - Date.parse(cache.generatedAt);
      const ttl = cache.source === "fallback" ? FALLBACK_TTL_MS : this.opts.ttlMs ?? IDEAS_TTL_MS;
      if (age >= 0 && age < ttl && cache.ideas.length > 0) return cache.ideas;
    }
    if (!this.inflight) {
      this.inflight = this.generate().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async generate(): Promise<Idea[]> {
    let ideas: Idea[] | null = null;
    try {
      const [conversations, open] = await Promise.all([
        recentConversationLines(this.opts.home, { skipIds: this.opts.skipIds?.() }),
        new TrackingStore(this.opts.home).list("open").catch(() => []),
      ]);
      const user = [
        `Now: ${new Date(this.now()).toString()}`,
        "",
        "Recent conversations (newest first):",
        conversations.length ? conversations.join("\n") : "- (none yet)",
        "",
        "Open commitments:",
        open.length ? open.slice(0, 10).map((i) => `- [${i.kind}] ${i.title}${i.dueAt ? ` (due ${i.dueAt})` : ""}`).join("\n") : "- (none)",
      ].join("\n");
      const reply = await this.opts.complete(IDEAS_SYSTEM, user, AbortSignal.timeout(this.opts.timeoutMs ?? 45_000));
      ideas = parseIdeas(reply);
      if (!ideas) this.opts.log?.(`ideas: unusable reply (${reply.length} chars) — using the fallback set`);
    } catch (err) {
      this.opts.log?.(`ideas: generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const cache: IdeasCache = ideas
      ? { generatedAt: new Date(this.now()).toISOString(), source: "model", ideas }
      : { generatedAt: new Date(this.now()).toISOString(), source: "fallback", ideas: FALLBACK_IDEAS };
    await this.writeCache(cache).catch(() => undefined);
    return cache.ideas;
  }
}
