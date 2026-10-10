// Phone Hands — the shapes Ares and the owner's phone agree on.
//
// The garrison owns the live sockets (DeviceBridge, @ares/garrison); the
// `iPhone` tool lives here and only sees it through DeviceBridgeLike, injected
// at daemon start exactly like the Telegram channel. The capability list is
// ALWAYS whatever the phone advertised in device.hello — nothing below says a
// capability exists. The risk FLOOR table is different: it only ever makes the
// gating stricter for capabilities we know the blast radius of.

export type DeviceRisk = "read" | "write" | "sensitive";
export type DevicePermission = "granted" | "denied" | "undetermined" | "unavailable";

export interface DeviceCapability {
  id: string;
  enabled: boolean;
  permission: DevicePermission;
  risk: DeviceRisk;
  description: string;
}

export interface DeviceShortcut {
  name: string;
  description?: string;
  acceptsInput?: boolean;
  /** What the owner calls it out loud (see deviceShortcuts.ts). */
  alias?: string;
  /** One line: when to reach for it. */
  whenToUse?: string;
  /** false = the owner marked it routine; anything else is sensitive. */
  sensitive?: boolean;
}

export interface DeviceIdentity {
  id: string;
  name: string;
  model?: string;
  os?: string;
  appVersion?: string;
}

export type DeviceErrorCode =
  | "not_connected"
  | "capability_unavailable"
  | "permission_denied"
  | "disabled_by_owner"
  | "timeout"
  | "device_error"
  /** Server-side refusals (never produced by the phone). */
  | "paused"
  | "forbidden"
  | "invalid_args"
  | "cancelled";

export interface DeviceInvokeOptions {
  /** The human sentence the phone shows ("Ares wants to add 'Dentist' …"). */
  reason?: string;
  /** Per-request budget once the phone has the request. Default 25s, max 120s. */
  timeoutMs?: number;
  /** The garrison session asking (owner-only; also the audit trail's key). */
  sessionId?: string;
  /** Audit actor: "ares" (default), "owner" (the phone's own health check). */
  actor?: string;
  signal?: AbortSignal;
}

export type DeviceInvokeResult =
  | { ok: true; device: string; result: unknown; durationMs: number }
  | { ok: false; error: { code: DeviceErrorCode; message: string }; device?: string; durationMs: number };

export interface DeviceStatusEntry extends DeviceIdentity {
  connected: boolean;
  /** ISO time of the last frame / poll from this device. */
  lastSeenAt: string;
  capabilities: DeviceCapability[];
  shortcuts: DeviceShortcut[];
}

/** What the iPhone tool needs from the live bridge — DeviceBridge satisfies it. */
export interface DeviceBridgeLike {
  list(): DeviceStatusEntry[];
  invoke(device: string | "default", capability: string, args: Record<string, unknown>, opts?: DeviceInvokeOptions): Promise<DeviceInvokeResult>;
  /** false for a guest tenant's session (they never get the owner's phone). */
  isOwnerSession(sessionId: string | undefined): boolean;
}

let bridgeRef: DeviceBridgeLike | null = null;

export function setDeviceBridge(bridge: DeviceBridgeLike | null): void {
  bridgeRef = bridge;
}

export function getDeviceBridge(): DeviceBridgeLike | null {
  return bridgeRef;
}

// ─── Risk floor ──────────────────────────────────────────────────────────

/** What we know a capability can do, whatever the phone says about it. */
const RISK_FLOOR: Readonly<Record<string, DeviceRisk>> = {
  "calendar.list_events": "read",
  "calendar.create_event": "write",
  "calendar.delete_event": "sensitive",
  "reminders.list": "read",
  "reminders.create": "write",
  "reminders.complete": "write",
  "contacts.search": "sensitive",
  "contacts.get": "sensitive",
  "health.summary": "sensitive",
  "notify.show": "write",
  "notify.cancel": "write",
  "haptic.play": "write",
  "audio.play": "write",
  "url.open": "sensitive",
  "shortcut.run": "sensitive",
  "device.info": "read",
  // Native-build capabilities: advertised by the phone, gated here.
  "location.get": "sensitive",
  "battery.get": "read",
  "clipboard.read": "sensitive",
  "clipboard.write": "write",
  "speech.say": "write",
  "speech.stop": "read",
  "brightness.get": "read",
  "brightness.set": "write",
  "network.info": "read",
  "motion.steps": "sensitive",
  "photos.latest": "sensitive",
  "files.pick": "sensitive",
  "auth.confirm": "read",
  "mail.compose": "write",
  "sms.compose": "write",
};

const RANK: Record<DeviceRisk, number> = { read: 0, write: 1, sensitive: 2 };

/** The floor for a capability we recognise, or undefined for one we do not. */
export function deviceCapabilityFloor(capability: string): DeviceRisk | undefined {
  return RISK_FLOOR[capability];
}

/**
 * The risk a call is gated at: the stricter of what the phone advertised and
 * our floor for that id. A capability we have never heard of is gated at
 * exactly what the phone says (an unparseable/absent declaration is
 * "sensitive"); the phone can always raise a class, never lower a known one.
 */
export function effectiveDeviceRisk(capability: string, declared?: string): DeviceRisk {
  const floor = RISK_FLOOR[capability];
  const d: DeviceRisk | undefined = declared === "read" || declared === "write" || declared === "sensitive" ? declared : undefined;
  if (floor && d) return RANK[d] >= RANK[floor] ? d : floor;
  if (floor) return floor;
  return d ?? "sensitive";
}

/** Look a capability's gating risk up against the live bridge. */
export function gatingRisk(bridge: DeviceBridgeLike | null, device: string | undefined, capability: string): DeviceRisk {
  const devices = bridge?.list() ?? [];
  const picked =
    (device && device !== "default" ? devices.find((d) => d.id === device || d.name === device) : undefined) ??
    devices.find((d) => d.connected) ??
    devices[0];
  const declared = picked?.capabilities.find((c) => c.id === capability)?.risk;
  return effectiveDeviceRisk(capability, declared);
}
