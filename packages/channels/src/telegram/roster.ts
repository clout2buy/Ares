// The Telegram participant roster — who is allowed to talk to Ares, and as whom.
//
// Before this, "allowed" was a flat list of chat ids: Ares could not tell the
// owner from a guest, every approval prompt broadcast to everyone, and there was
// no way to say "let my girlfriend talk to you" or "who's been messaging you?".
//
// The roster gives every chat a NAME and a ROLE (owner | guest). Owners get the
// approval Gate and the admin commands; guests just chat. It persists as plain
// JSON under ~/.ares (chat ids + display names — not secrets; the bot TOKEN is
// the secret and lives encrypted elsewhere). Pure ops + a tolerant file store.

import { promises as fs } from "node:fs";
import path from "node:path";

export type ParticipantRole = "owner" | "guest";

export interface Participant {
  chatId: number;
  name: string;
  role: ParticipantRole;
  addedAt: string;
  /** Owner chatId who added a guest (undefined for seeded owners). */
  addedBy?: number;
  /** Last time this chat sent a message — drives "who's active". */
  lastSeenAt?: string;
}

export interface RosterData {
  participants: Participant[];
}

export function emptyRoster(): RosterData {
  return { participants: [] };
}

/** Add or update a participant (keyed by chatId). Returns a new RosterData. */
export function upsertParticipant(
  data: RosterData,
  input: { chatId: number; name: string; role: ParticipantRole; addedBy?: number; now?: Date },
): RosterData {
  const at = (input.now ?? new Date()).toISOString();
  const existing = data.participants.find((p) => p.chatId === input.chatId);
  const next: Participant = existing
    ? { ...existing, name: input.name.trim() || existing.name, role: input.role }
    : { chatId: input.chatId, name: input.name.trim() || `chat ${input.chatId}`, role: input.role, addedAt: at, addedBy: input.addedBy };
  return { participants: [...data.participants.filter((p) => p.chatId !== input.chatId), next] };
}

/** Remove by chatId or by (case-insensitive) name. Returns the new data + who left. */
export function removeParticipant(data: RosterData, target: number | string): { data: RosterData; removed?: Participant } {
  const removed =
    typeof target === "number"
      ? data.participants.find((p) => p.chatId === target)
      : data.participants.find((p) => p.name.toLowerCase() === String(target).trim().toLowerCase());
  if (!removed) return { data };
  return { data: { participants: data.participants.filter((p) => p.chatId !== removed.chatId) }, removed };
}

export function markSeen(data: RosterData, chatId: number, now = new Date()): RosterData {
  const p = data.participants.find((x) => x.chatId === chatId);
  if (!p) return data;
  return { participants: data.participants.map((x) => (x.chatId === chatId ? { ...x, lastSeenAt: now.toISOString() } : x)) };
}

export function findByChat(data: RosterData, chatId: number): Participant | undefined {
  return data.participants.find((p) => p.chatId === chatId);
}

export function isOwner(data: RosterData, chatId: number): boolean {
  return data.participants.some((p) => p.chatId === chatId && p.role === "owner");
}

export function isAllowed(data: RosterData, chatId: number): boolean {
  return data.participants.some((p) => p.chatId === chatId);
}

export function ownerChatIds(data: RosterData): number[] {
  return data.participants.filter((p) => p.role === "owner").map((p) => p.chatId);
}

export function allowedChatIds(data: RosterData): number[] {
  return data.participants.map((p) => p.chatId);
}

/** Human-readable roster for the owner's /who command. */
export function renderWho(data: RosterData, now = new Date()): string {
  if (data.participants.length === 0) return "No one is on the allowlist yet.";
  const lines = ["👥 Who can talk to me:"];
  const sorted = [...data.participants].sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "owner" ? -1 : 1));
  for (const p of sorted) {
    const badge = p.role === "owner" ? "👑" : "👤";
    const seen = p.lastSeenAt ? `, last active ${ago(p.lastSeenAt, now)}` : "";
    lines.push(`${badge} ${p.name} (${p.role}, id ${p.chatId}${seen})`);
  }
  return lines.join("\n");
}

function ago(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ─── persistence ─────────────────────────────────────────────────────────

export function rosterFile(home: string): string {
  return path.join(home, "telegram-roster.json");
}

export async function loadRoster(home: string): Promise<RosterData> {
  try {
    const raw = await fs.readFile(rosterFile(home), "utf8");
    const parsed = JSON.parse(raw) as RosterData;
    if (Array.isArray(parsed?.participants)) return parsed;
  } catch {
    // missing / corrupt → empty
  }
  return emptyRoster();
}

export async function saveRoster(home: string, data: RosterData): Promise<void> {
  const file = rosterFile(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n");
}

/** Seed the roster from the configured owner chat id(s) the first time, so an
 *  existing single-owner setup keeps working and the owner is never locked out. */
export function seedOwners(data: RosterData, ownerIds: readonly number[], ownerName = "owner", now = new Date()): RosterData {
  let next = data;
  for (const id of ownerIds) {
    if (!findByChat(next, id)) next = upsertParticipant(next, { chatId: id, name: ownerName, role: "owner", now });
  }
  return next;
}
