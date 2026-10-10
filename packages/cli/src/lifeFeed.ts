// The Feed — a personal newspaper Ares writes every morning from a brief the
// owner controls (the phone's Today tab reads it via /gateway/feed).
//
// Generation is a REAL Ares turn, not a side query: the edition needs fresh
// facts, so it has to research with WebSearch/WebFetch like any other request,
// and it runs through the garrison's SessionManager so it gets the same
// tools, deadlines and stuck-turn watchdog as a conversation. The host injects
// `runTurn`; this file owns everything else: the prompt on disk, parsing the
// model's reply into a bounded edition, keeping the last good edition when a
// run fails, retention, and deciding when the daily run is due.
//
// Files under <ARES_HOME>/feed/:
//   prompt.txt              the owner's brief (default below when absent)
//   editions/<iso>.json     one per successful run, newest 14 kept

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_FEED_PROMPT =
  "Top news in AI, tech and my city, plus anything relevant to what we've worked on";

export interface FeedItem {
  title: string;
  summary: string;
  url?: string;
  image?: string;
}

export interface FeedSection {
  heading: string;
  items: FeedItem[];
}

export interface FeedEdition {
  id: string;
  generatedAt: string;
  title: string;
  sections: FeedSection[];
}

export interface FeedSnapshot {
  prompt: string;
  generating: boolean;
  edition?: FeedEdition;
}

/** Editions kept on disk. */
export const FEED_EDITIONS_KEPT = 14;
const MAX_PROMPT_CHARS = 2_000;
const MAX_SECTIONS = 8;
const MAX_ITEMS = 8;
const MAX_TITLE = 200;
const MAX_HEADING = 120;
const MAX_SUMMARY = 700;
const MAX_URL = 2_000;

/** Local hour the daily edition is due; ARES_FEED_HOUR (default 7). */
export function feedHour(): number {
  const n = Number(process.env.ARES_FEED_HOUR);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : 7;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, max) : undefined;
}

function httpUrl(value: unknown): string | undefined {
  const text = clip(value, MAX_URL);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Every balanced {...} in `text`, in order of their opening brace. String-
 *  aware, so a brace inside a summary never ends an object early. */
function* balancedObjects(text: string): Generator<string> {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          yield text.slice(start, i + 1);
          break;
        }
      }
    }
  }
}

/**
 * The model's reply → a bounded edition body, or null when there is no usable
 * edition in it. Robust to what models actually do: code fences, a sentence
 * before the JSON, a stray "[1]" citation (which a first-bracket parser takes
 * for the answer), oversized lists, junk URLs. Items without a title or
 * summary are dropped; a section left empty is dropped; no sections = null.
 */
export function parseFeedEdition(raw: string): { title: string; sections: FeedSection[] } | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1] ?? "");
  for (const source of [...fenced.reverse(), raw]) {
    for (const candidate of balancedObjects(source)) {
      let value: unknown;
      try {
        value = JSON.parse(candidate);
      } catch {
        continue;
      }
      const edition = normalizeEdition(value);
      if (edition) return edition;
    }
  }
  return null;
}

function normalizeEdition(value: unknown): { title: string; sections: FeedSection[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.sections)) return null;
  const sections: FeedSection[] = [];
  for (const rawSection of v.sections) {
    if (sections.length >= MAX_SECTIONS) break;
    if (!rawSection || typeof rawSection !== "object") continue;
    const s = rawSection as Record<string, unknown>;
    const heading = clip(s.heading ?? s.title, MAX_HEADING);
    if (!heading || !Array.isArray(s.items)) continue;
    const items: FeedItem[] = [];
    for (const rawItem of s.items) {
      if (items.length >= MAX_ITEMS) break;
      if (!rawItem || typeof rawItem !== "object") continue;
      const it = rawItem as Record<string, unknown>;
      const title = clip(it.title, MAX_TITLE);
      const summary = clip(it.summary ?? it.description, MAX_SUMMARY);
      if (!title || !summary) continue;
      const url = httpUrl(it.url);
      const image = httpUrl(it.image);
      items.push({ title, summary, ...(url ? { url } : {}), ...(image ? { image } : {}) });
    }
    if (items.length > 0) sections.push({ heading, items });
  }
  if (sections.length === 0) return null;
  return { title: clip(v.title, MAX_TITLE) ?? "Today", sections };
}

// ─── The turn instruction ────────────────────────────────────────────────────

export function feedTurnText(prompt: string, now: Date): string {
  const date = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return [
    `Today feed — build today's edition of the owner's personal newspaper (${date}).`,
    "",
    "The owner's brief for this feed:",
    `"""${prompt}"""`,
    "",
    "Research it now with WebSearch and WebFetch: fresh stories (last 24-48 hours where news is involved), real sources, no invented facts or URLs. " +
      "Use what you know about the owner and recent work only to judge relevance. Do not message anyone, do not track or book anything, do not ask questions — this runs unattended.",
    "",
    "When done, reply with ONLY this JSON — no prose, no code fences:",
    '{"title": "a short headline for today\'s edition", "sections": [{"heading": "Section name", "items": [{"title": "Story headline", "summary": "2-3 sentences on what happened and why it matters to the owner", "url": "https://source", "image": "https://direct-image-url (optional, e.g. the article\'s og:image)"}]}]}',
    "3-6 sections, 2-6 items each.",
  ].join("\n");
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface FeedServiceOptions {
  home: string;
  /** Run one Ares turn and resolve with its final assistant text. */
  runTurn: (text: string) => Promise<string>;
  now?: () => Date;
  log?: (line: string) => void;
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class FeedService {
  readonly dir: string;
  private readonly editionsDir: string;
  private readonly promptFile: string;
  private readonly opts: FeedServiceOptions;
  private readonly now: () => Date;
  private running: Promise<FeedEdition | null> | null = null;
  /** The local day the daily run was last ATTEMPTED — a failing run must not
   *  retry every scheduler check for the rest of the day. */
  private attemptedDay: string | undefined;

  constructor(opts: FeedServiceOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
    this.dir = path.join(opts.home, "feed");
    this.editionsDir = path.join(this.dir, "editions");
    this.promptFile = path.join(this.dir, "prompt.txt");
  }

  get generating(): boolean {
    return this.running !== null;
  }

  async getPrompt(): Promise<string> {
    const text = await fs.readFile(this.promptFile, "utf8").catch(() => "");
    return text.trim() || DEFAULT_FEED_PROMPT;
  }

  async setPrompt(prompt: string): Promise<void> {
    const clean = prompt.trim().slice(0, MAX_PROMPT_CHARS);
    if (!clean) throw new Error("prompt must not be empty");
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.promptFile}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, clean + "\n", "utf8");
    await fs.rename(tmp, this.promptFile);
  }

  private async editionFiles(): Promise<string[]> {
    const names = await fs.readdir(this.editionsDir).catch(() => [] as string[]);
    return names.filter((n) => n.endsWith(".json")).sort();
  }

  async latestEdition(): Promise<FeedEdition | undefined> {
    const files = await this.editionFiles();
    for (const name of files.reverse()) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.editionsDir, name), "utf8")) as FeedEdition;
        if (parsed && Array.isArray(parsed.sections) && typeof parsed.generatedAt === "string") return parsed;
      } catch {
        // a torn edition file is skipped; the previous one still shows
      }
    }
    return undefined;
  }

  async snapshot(): Promise<FeedSnapshot> {
    const [prompt, edition] = await Promise.all([this.getPrompt(), this.latestEdition()]);
    return { prompt, generating: this.generating, ...(edition ? { edition } : {}) };
  }

  /** Save a parsed edition and prune to the newest FEED_EDITIONS_KEPT. */
  async saveEdition(body: { title: string; sections: FeedSection[] }, at = this.now()): Promise<FeedEdition> {
    const generatedAt = at.toISOString();
    const id = generatedAt.replace(/[:.]/g, "-");
    const edition: FeedEdition = { id, generatedAt, title: body.title, sections: body.sections };
    await fs.mkdir(this.editionsDir, { recursive: true });
    const file = path.join(this.editionsDir, `${id}.json`);
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(edition, null, 2) + "\n", "utf8");
    await fs.rename(tmp, file);
    const files = await this.editionFiles();
    for (const stale of files.slice(0, Math.max(0, files.length - FEED_EDITIONS_KEPT))) {
      await fs.rm(path.join(this.editionsDir, stale), { force: true }).catch(() => undefined);
    }
    return edition;
  }

  /**
   * Start a generation unless one is already running (the running one is
   * returned instead — two taps on refresh must not launch two research
   * turns). Resolves with the new edition, or null when the run produced
   * nothing usable (the last good edition stays current).
   */
  generate(): Promise<FeedEdition | null> {
    if (this.running) return this.running;
    const job = (async () => {
      const startedAt = this.now();
      try {
        const reply = await this.opts.runTurn(feedTurnText(await this.getPrompt(), startedAt));
        const body = parseFeedEdition(reply);
        if (!body) {
          this.opts.log?.(`feed: the run returned no usable edition (${reply.length} chars) — keeping the last one`);
          return null;
        }
        const edition = await this.saveEdition(body);
        this.opts.log?.(`feed: edition ${edition.id} — ${edition.sections.length} sections`);
        return edition;
      } catch (err) {
        this.opts.log?.(`feed: generation failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    })().finally(() => {
      this.running = null;
    });
    this.running = job;
    return job;
  }

  /** Fire-and-forget refresh for the phone's button. */
  refresh(): void {
    void this.generate();
  }

  /**
   * The scheduler's check (every few minutes): due once per local day at or
   * after feedHour(), unless today already has an edition — so a garrison
   * that was down at 07:00 still delivers the morning paper when it comes up,
   * and a manual refresh at 06:50 doesn't get a duplicate ten minutes later.
   */
  async maybeRunDaily(): Promise<boolean> {
    const now = this.now();
    if (now.getHours() < feedHour() || this.generating) return false;
    const today = localDayKey(now);
    if (this.attemptedDay === today) return false;
    const latest = await this.latestEdition();
    if (latest && localDayKey(new Date(latest.generatedAt)) === today) {
      this.attemptedDay = today;
      return false;
    }
    this.attemptedDay = today;
    void this.generate();
    return true;
  }
}
