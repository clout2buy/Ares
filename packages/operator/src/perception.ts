// The perception ladder — Crix's eyes (Crix v5 / O5 / concept C6).
//
// Same shape as the method ladder: most-grounded-and-cheap first, most-general-
// and-fragile last.
//   api  → read the data underneath (cheapest, exact)
//   dom  → the accessibility/DOM tree (exact element targeting, for forms)
//   vision → screenshot + a multimodal model (captchas, canvas, "does it LOOK
//            right", native apps) — the universal fallback, last resort.
//
// "Read structure when you can; look at pixels when you must." Pure pixel-
// clicking is the most general and the most fragile, so it's the bottom rung.

export type PerceptionRung = "api" | "dom" | "vision";

export const PERCEPTION_RANK: Record<PerceptionRung, number> = { api: 0, dom: 1, vision: 2 };

export interface PerceptionNeed {
  /** Structured data / an API can answer this observation directly. */
  hasApi?: boolean;
  /** The target is present in the page's accessibility/DOM tree. */
  inAccessibilityTree?: boolean;
}

/** Pick the cheapest, most reliable way to perceive what's needed. */
export function routePerception(need: PerceptionNeed): PerceptionRung {
  if (need.hasApi) return "api";
  if (need.inAccessibilityTree) return "dom";
  return "vision";
}
