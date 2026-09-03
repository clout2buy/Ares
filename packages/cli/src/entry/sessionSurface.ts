// Session surface + tenant stamps for the CLI-hosted session stores.
//
// The garrison stamps its own rollouts (packages/garrison/src/sessions.ts);
// desktop and TUI sessions are Core Sessions whose meta.json is owned by
// @ares/core and rewritten wholesale on every provider switch — writing extra
// fields there would race and be lost. The canonical SQLite kernel is the
// durable, race-free place: `mergeSessionMetadata` is a shallow merge that
// preserves whatever core wrote. The cross-surface digest reads the stamp back
// from the same row.
//
// Surface resolution: ARES_SURFACE wins (an operator forcing a label), then
// what the host declared via setProcessSurface (the desktop daemon says
// "desktop"), then a TTY heuristic — an interactive terminal is the TUI,
// anything else is headless.

import { openWorkspaceSessionKernel, type JsonValue } from "@ares/core";
import type { TurnTenant } from "./turnPipeline.js";

export type SessionSurface = "desktop" | "tui" | "telegram" | "garrison" | "headless";

const SURFACES: ReadonlySet<string> = new Set(["desktop", "tui", "telegram", "garrison", "headless"]);

let processSurface: SessionSurface | undefined;

/** A host declares what it is once at boot (the daemon → "desktop"). */
export function setProcessSurface(surface: SessionSurface): void {
  processSurface = surface;
}

export function currentSurface(): SessionSurface {
  const forced = process.env.ARES_SURFACE;
  if (forced && SURFACES.has(forced)) return forced as SessionSurface;
  if (processSurface) return processSurface;
  return process.stdin.isTTY && process.stdout.isTTY ? "tui" : "headless";
}

/**
 * Validate a tenant carried on a wire frame. A guest without an id cannot be
 * isolated, so it is rejected; the caller falls back to the session's stamp
 * (owner by default) — never to a half-formed guest.
 */
/**
 * Which prompt tail a session gets. The owner's live-mind context (top memories,
 * identity notes) must never be baked into a GUEST session's system prompt — the
 * Garrison composes one prompt per session, and before this every Telegram
 * stranger read the owner's mind. Guests keep the git context only.
 */
export function promptTailForTenant<T>(tenant: { role?: string } | null | undefined, ownerTail: T, gitOnlyTail: T): T {
  return tenant?.role === "guest" ? gitOnlyTail : ownerTail;
}

export function tenantFromWire(value: unknown): TurnTenant | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { role, chatId, name } = value as { role?: unknown; chatId?: unknown; name?: unknown };
  if (role === "owner") return { role: "owner" };
  if (role !== "guest") return undefined;
  const id = typeof chatId === "number" ? String(chatId) : typeof chatId === "string" ? chatId.trim() : "";
  if (!id) return undefined;
  return typeof name === "string" && name.trim() ? { role: "guest", chatId: id, name: name.trim() } : { role: "guest", chatId: id };
}

/** The kernel's JSON shape for a tenant (chatId always a string). */
export function tenantMetadata(tenant: TurnTenant | undefined): Record<string, JsonValue> {
  if (!tenant || tenant.role === "owner") return { role: "owner" };
  return { role: "guest", chatId: String(tenant.chatId) };
}

export interface StampableSession {
  session: { meta: { id: string } };
  context: { workspace: string };
  tenant?: TurnTenant;
}

/**
 * Stamp surface + tenant on a CLI-hosted session: on the live object (so the
 * turn pipeline's tenant resolution sees it) and in the workspace kernel row
 * (so it survives restarts and other surfaces can read it). Best-effort — a
 * missing kernel row (a session that never reached the kernel) is not an error.
 */
export async function stampSessionIdentity(
  live: StampableSession,
  stamp: { surface?: SessionSurface; tenant?: TurnTenant },
): Promise<void> {
  if (stamp.tenant) live.tenant = stamp.tenant;
  const patch: Record<string, JsonValue> = {};
  if (stamp.surface) patch.surface = stamp.surface;
  if (stamp.tenant) patch.tenant = tenantMetadata(stamp.tenant);
  if (Object.keys(patch).length === 0) return;
  try {
    const kernel = await openWorkspaceSessionKernel(live.context.workspace);
    kernel.mergeSessionMetadata(live.session.meta.id, patch);
  } catch {
    // no row yet / archived / kernel unavailable — the stamp is advisory
  }
}

const surfaceStamped = new WeakSet<object>();

/**
 * Hosts that never declare themselves (the in-process TUI, `ares chat`, a
 * script) get stamped lazily on their first turn, once per live session, and
 * only when the row carries no surface yet — a session opened by the desktop
 * and later resumed in a terminal keeps its original label.
 */
export async function ensureSurfaceStamp(live: StampableSession): Promise<void> {
  if (surfaceStamped.has(live)) return;
  surfaceStamped.add(live);
  try {
    const kernel = await openWorkspaceSessionKernel(live.context.workspace);
    const row = kernel.getSession(live.session.meta.id);
    if (!row) return;
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, JsonValue>)
      : {};
    if (typeof metadata.surface === "string") return;
    kernel.mergeSessionMetadata(live.session.meta.id, {
      surface: currentSurface(),
      ...(metadata.tenant === undefined ? { tenant: tenantMetadata(live.tenant) } : {}),
    });
  } catch {
    // advisory
  }
}
