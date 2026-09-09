// Point maps: the specs that drive the Cyber backdrop's point cloud.
//
// A map is a small JSON object — shape kind, motion, spread, density, size,
// opacity and colours — so a new look is data, not code. Four ship here;
// the owner's own live in prefs; Ares can design more with its PointMap tool
// (they arrive from the daemon as `pointmaps`). The same validator guards all
// three sources so a bad spec can never blank the room.

export type PointMapKind = "nebula" | "horizon" | "waves" | "orbit" | "galaxy" | "aurora";

export interface PointMapSpec {
  id: string;
  name: string;
  /** Who made it: shipped, the owner (Settings), or Ares (its tool). */
  by?: "ares" | "owner" | "builtin";
  kind: PointMapKind;
  /** How many points (2k–16k). */
  density: number;
  /** Displacement of the surface / spread of the cloud, 0..1. */
  amplitude: number;
  /** Drift speed, 0..1 (0 = still). Never fast: the doctrine forbids flashing. */
  speed: number;
  /** How much of the room it fills, 0.3..1.4. */
  spread: number;
  /** Vertical placement, -1 (floor) .. 1 (ceiling). */
  lift: number;
  /** Point size multiplier 0.4..2.5. */
  size: number;
  /** Overall opacity 0.1..1. */
  opacity: number;
  /** "accent" follows the Appearance accent; otherwise two hex colours. */
  colors: "accent" | [string, string];
  note?: string;
}

export const BUILTIN_POINT_MAPS: PointMapSpec[] = [
  { id: "nebula", name: "Nebula", by: "builtin", kind: "nebula", density: 9000, amplitude: 0.7, speed: 0.25, spread: 1.2, lift: 0.05, size: 1, opacity: 0.85, colors: "accent", note: "A slow volumetric drift across the whole room." },
  { id: "horizon", name: "Horizon", by: "builtin", kind: "horizon", density: 7000, amplitude: 0.5, speed: 0.3, spread: 1.1, lift: -0.5, size: 1, opacity: 0.8, colors: "accent", note: "A bowl of light low behind the composer." },
  { id: "waves", name: "Waves", by: "builtin", kind: "waves", density: 8000, amplitude: 0.6, speed: 0.35, spread: 1.3, lift: -0.25, size: 0.9, opacity: 0.75, colors: "accent", note: "A wide sheet rolling under the stage." },
  { id: "orbit", name: "Orbit", by: "builtin", kind: "orbit", density: 6000, amplitude: 0.4, speed: 0.2, spread: 0.9, lift: 0.1, size: 1.1, opacity: 0.8, colors: "accent", note: "Rings and a sparse shell, turning slowly." },
  { id: "galaxy", name: "Galaxy", by: "builtin", kind: "galaxy", density: 12000, amplitude: 0.5, speed: 0.15, spread: 1.2, lift: -0.05, size: 0.9, opacity: 0.85, colors: "accent", note: "Spiral arms around a bright core, seen at a tilt." },
  { id: "aurora", name: "Aurora", by: "builtin", kind: "aurora", density: 10000, amplitude: 0.7, speed: 0.3, spread: 1.2, lift: 0.05, size: 1.15, opacity: 0.95, colors: "accent", note: "Tall curtains of light rippling across the room." },
];

const KINDS = new Set<PointMapKind>(["nebula", "horizon", "waves", "orbit", "galaxy", "aurora"]);
const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/** Coerce anything shaped like a map into a safe spec, or null. */
export function normalizePointMap(raw: unknown, by?: PointMapSpec["by"]): PointMapSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 40) : "";
  if (!name) return null;
  const kind = KINDS.has(r.kind as PointMapKind) ? (r.kind as PointMapKind) : "nebula";
  const id = typeof r.id === "string" && /^[a-z0-9_-]{1,48}$/i.test(r.id) ? r.id : `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "map"}-${Math.random().toString(36).slice(2, 7)}`;
  let colors: PointMapSpec["colors"] = "accent";
  if (Array.isArray(r.colors) && r.colors.length === 2 && isHex(r.colors[0]) && isHex(r.colors[1])) colors = [r.colors[0], r.colors[1]];
  return {
    id,
    name,
    by: by ?? (r.by === "ares" || r.by === "owner" || r.by === "builtin" ? r.by : "owner"),
    kind,
    density: Math.round(clamp(r.density, 2000, 16000, 8000)),
    amplitude: clamp(r.amplitude, 0, 1, 0.6),
    speed: clamp(r.speed, 0, 1, 0.3),
    spread: clamp(r.spread, 0.3, 1.4, 1.1),
    lift: clamp(r.lift, -1, 1, 0),
    size: clamp(r.size, 0.4, 2.5, 1),
    opacity: clamp(r.opacity, 0.1, 1, 0.8),
    colors,
    ...(typeof r.note === "string" && r.note.trim() ? { note: r.note.trim().slice(0, 160) } : {}),
  };
}

export function hexToRgb01(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
