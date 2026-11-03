// The daemon's boot session, reused while nobody has typed into it.
//
// Every desktop daemon boot built its primary session with a brand-new id:
// one canonical kernel row per app launch (and per dev-bridge restart), which
// the garrison then mirrored into ~/.ares/garrison/sessions as an "untitled
// session" — the dominant shape of the 613 empty registry entries found on
// 2026-11-02. The primary session is the target of session-less commands; it
// only becomes a conversation when a message lands in it. So the daemon
// remembers the id it booted with and, next boot, takes the SAME id again when
// that session is still empty, instead of minting another.

import { promises as fs } from "node:fs";
import path from "node:path";

export interface PrimaryKernelView {
  getSession(id: string): unknown;
  listMessages(id: string): readonly unknown[];
  countEvents(id: string): number;
}

function file(home: string): string {
  return path.join(home, "daemon-primary.json");
}

/** The last boot's primary id when it is still empty (no row, or a row with
 *  no messages and no events); undefined when it has content or is unknown. */
export async function reusablePrimaryId(home: string, kernel: PrimaryKernelView | undefined): Promise<string | undefined> {
  let id: unknown;
  try {
    id = (JSON.parse(await fs.readFile(file(home), "utf8")) as { id?: unknown }).id;
  } catch {
    return undefined;
  }
  if (typeof id !== "string" || !/^sess_[A-Za-z0-9_-]{8,80}$/.test(id)) return undefined;
  if (!kernel) return undefined;
  try {
    if (!kernel.getSession(id)) return id;
    return kernel.listMessages(id).length === 0 && kernel.countEvents(id) === 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export async function rememberPrimaryId(home: string, id: string): Promise<void> {
  try {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(file(home), JSON.stringify({ id, at: new Date().toISOString() }) + "\n", "utf8");
  } catch {
    // best-effort: the worst case is one more empty row, as before
  }
}
