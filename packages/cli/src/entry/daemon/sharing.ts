// Agents teaching agents — across owners, only with both owners' say-so.
//
// Owner, 2026-10-20: "each users agents can share shit with other agents if
// users allow to improve them". Two switches, both OFF until the owner turns
// them on (Settings → Skills & Tools):
//   give — my agents may share a lesson or a skill in a room;
//   take — shares from OTHER owners' agents land in my inbox.
// Nothing another owner's agent sends ever reaches my agents on its own: a
// lesson becomes part of an agent's prompt and a skill becomes instructions,
// so each one waits in the inbox until I approve it (and picks who learns it).
// Skills travel as SKILL.md text only — never handler.js, never code — and
// install as prompt-only skills.

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";

export interface SharingSettings {
  give: boolean;
  take: boolean;
}

export interface ShareItem {
  id: string;
  kind: "lesson" | "skill";
  /** lesson: the lesson. skill: its one-line description. */
  text: string;
  /** skill: its name (folder) and the room file carrying SKILL.md. */
  skill?: string;
  file?: string;
  roomId: string;
  roomName: string;
  /** The agent that shared it, and the person it belongs to. */
  fromAgent: string;
  fromOwner?: string;
  at: string;
}

export const SHARE_INBOX_MAX = 60;
export const SHARED_SKILL_MAX = 20_000;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

const LESSON_RE = /^📘 Lesson from ([^:]{1,60}): ([\s\S]{1,300})$/u;
const SKILL_RE = /^🧩 Skill "([a-z0-9][a-z0-9-]{0,47})" from ([^:]{1,60}): ([\s\S]{0,300})$/u;

export function lessonMessage(agentName: string, lesson: string): string {
  return `📘 Lesson from ${agentName}: ${lesson.replace(/\s+/g, " ").trim().slice(0, 240)}`;
}
export function skillMessage(agentName: string, skill: string, description: string): string {
  return `🧩 Skill "${skill}" from ${agentName}: ${description.replace(/\s+/g, " ").trim().slice(0, 200)}`;
}
export function skillFileName(skill: string): string {
  return `skills/${skill}.md`;
}

/** A room message → a share, when it is one. */
export function parseShare(text: string): { kind: "lesson"; agent: string; text: string } | { kind: "skill"; agent: string; skill: string; text: string } | undefined {
  const t = text.trim();
  const l = LESSON_RE.exec(t);
  if (l) return { kind: "lesson", agent: l[1]!.trim(), text: l[2]!.trim() };
  const s = SKILL_RE.exec(t);
  if (s) return { kind: "skill", skill: s[1]!, agent: s[2]!.trim(), text: s[3]!.trim() };
  return undefined;
}

/** Make a received SKILL.md safe to install: text only, size-capped, our own
 *  frontmatter (name, description, where it came from, never "runnable"). */
export function sanitizeSharedSkill(raw: string, item: { skill: string; text: string; fromAgent: string; fromOwner?: string }): string {
  const body = raw.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "").trim().slice(0, SHARED_SKILL_MAX);
  if (!body) throw new Error("that skill is empty");
  const desc = (item.text || "Shared skill.").replace(/[\r\n]+/g, " ").slice(0, 200);
  const from = `${item.fromAgent}${item.fromOwner ? ` (${item.fromOwner}'s agent)` : ""}`.replace(/[\r\n]+/g, " ");
  return `---\nname: ${item.skill}\ndescription: ${desc}\ncategory: shared\nstatus: shared\nshared_from: ${from}\n---\n\n${body}\n`;
}

export class AgentSharing {
  private settings: SharingSettings = { give: false, take: false };
  private inbox: ShareItem[] = [];
  private loaded = false;

  constructor(private readonly deps: { home: string; emit(payload: Record<string, unknown>): void; now?: () => number }) {}

  private get file(): string {
    return path.join(this.deps.home, "agent-sharing.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as { settings?: Partial<SharingSettings>; inbox?: ShareItem[] };
      this.settings = { give: raw.settings?.give === true, take: raw.settings?.take === true };
      this.inbox = Array.isArray(raw.inbox) ? raw.inbox.filter((x) => x && typeof x.id === "string" && (x.kind === "lesson" || x.kind === "skill")).slice(-SHARE_INBOX_MAX) : [];
    } catch {
      /* first run */
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.deps.home, { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ settings: this.settings, inbox: this.inbox }, null, 2));
    await fs.rename(tmp, this.file);
  }

  get(): SharingSettings {
    return { ...this.settings };
  }
  items(): ShareItem[] {
    return [...this.inbox];
  }
  emit(): void {
    this.deps.emit({ type: "agent_sharing", settings: this.get(), inbox: this.items() });
  }

  async set(next: Partial<SharingSettings>): Promise<SharingSettings> {
    await this.load();
    if (typeof next.give === "boolean") this.settings.give = next.give;
    if (typeof next.take === "boolean") this.settings.take = next.take;
    await this.save();
    this.emit();
    return this.get();
  }

  /** A share arrived from another owner's agent. Kept only when `take` is on;
   *  the same lesson or skill from the same agent is kept once. */
  async receive(item: Omit<ShareItem, "id" | "at">): Promise<ShareItem | undefined> {
    await this.load();
    if (!this.settings.take) return undefined;
    const dup = this.inbox.find((x) => x.kind === item.kind && x.fromAgent === item.fromAgent && (item.kind === "skill" ? x.skill === item.skill : x.text === item.text));
    if (dup) return undefined;
    const full: ShareItem = { ...item, id: `sh_${randomBytes(5).toString("hex")}`, at: new Date(this.deps.now?.() ?? Date.now()).toISOString() };
    this.inbox = [...this.inbox, full].slice(-SHARE_INBOX_MAX);
    await this.save();
    this.emit();
    return full;
  }

  async take(id: string): Promise<ShareItem> {
    await this.load();
    const item = this.inbox.find((x) => x.id === id);
    if (!item) throw new Error("that share is gone");
    this.inbox = this.inbox.filter((x) => x.id !== id);
    await this.save();
    this.emit();
    return item;
  }

  peek(id: string): ShareItem | undefined {
    return this.inbox.find((x) => x.id === id);
  }
}
