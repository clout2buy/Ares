// Avatar motion as data, not video (owner, 2026-10-24). One state vocabulary
// for every agent; each state is a small keyframed clip played client-side.
// Nothing renders on a GPU per avatar, so any picture gains motion for free
// and it works offline.
//
// Tiers, picked by what the picture supports:
//   0  whole picture: bob, sway, squash, hop. Works on any image, even a logo.
//   1  head/body split: parallax, nods (needs the parts cut out; not built yet).
//   2  full rig: limbs, blinks, mouth (needs a contract-fit image; not built yet).
// Only tier 0 exists today. Motion is transform-only and never changes
// brightness (photosensitive doctrine).

export type RigState = "idle" | "waking" | "working" | "connecting" | "waiting" | "making" | "milestone";

/** One key: when (0..1 of the clip), where (percent of the avatar), tilt
 *  (degrees), turn (ry: degrees around the vertical axis, in perspective, so
 *  a flat picture reads as turning its head) and squash (scale x/y, about the
 *  bottom centre). */
export type RigKey = { t: number; x?: number; y?: number; r?: number; ry?: number; sx?: number; sy?: number };
export type RigClip = { ms: number; ease: string; keys: RigKey[] };

/** Tier 0: the whole picture moves. The base scale keeps the picture's edges
 *  outside the round frame while it moves. */
const BASE = 1.06;

export const TIER0_CLIPS: Record<RigState, RigClip> = {
  // at rest: a slow breath. Real poses (blink, glances) come from the
  // avatar's pose frames, not from warping the picture (owner: "real
  // animations not smudging").
  idle: { ms: 4200, ease: "ease-in-out", keys: [
    { t: 0 },
    { t: 0.5, y: -1.2, sx: 0.992, sy: 1.01 },
    { t: 1 },
  ] },
  // stretch up and settle, once per loop
  waking: { ms: 1800, ease: "ease-out", keys: [
    { t: 0, sy: 0.96, sx: 1.03 },
    { t: 0.35, y: -3, sy: 1.04, sx: 0.97 },
    { t: 0.7, y: 0 },
    { t: 1 },
  ] },
  // busy: a small bounce
  working: { ms: 1400, ease: "ease-in-out", keys: [
    { t: 0 },
    { t: 0.5, y: -2.4, sx: 0.99, sy: 1.012 },
    { t: 1 },
  ] },
  // leaning out, looking for someone
  connecting: { ms: 2400, ease: "ease-in-out", keys: [
    { t: 0, x: -2, r: -4 },
    { t: 0.5, x: 2, r: 4 },
    { t: 1, x: -2, r: -4 },
  ] },
  // patient, slow tilt
  waiting: { ms: 3400, ease: "ease-in-out", keys: [
    { t: 0, r: -3 },
    { t: 0.5, r: 3, y: -0.8 },
    { t: 1, r: -3 },
  ] },
  // eager squash-and-stretch bounce
  making: { ms: 900, ease: "ease-in-out", keys: [
    { t: 0, sx: 1.04, sy: 0.95 },
    { t: 0.45, y: -4, sx: 0.97, sy: 1.04 },
    { t: 1, sx: 1.04, sy: 0.95 },
  ] },
  // a happy hop
  milestone: { ms: 1100, ease: "ease-out", keys: [
    { t: 0, sx: 1.06, sy: 0.92 },
    { t: 0.3, y: -9, sx: 0.95, sy: 1.06, r: -4 },
    { t: 0.6, y: 0, sx: 1.06, sy: 0.93, r: 0 },
    { t: 0.8, y: -2 },
    { t: 1 },
  ] },
};

function frame(k: RigKey): Keyframe {
  const s = BASE;
  return {
    offset: k.t,
    transform: `translate(${k.x ?? 0}%, ${k.y ?? 0}%) rotate(${k.r ?? 0}deg) scale(${s * (k.sx ?? 1)}, ${s * (k.sy ?? 1)})`,
  };
}

/** Play `state`'s clip on `el` until the state changes or the element goes;
 *  returns the stop function. Reduced motion: holds the still base pose. */
export function playRig(el: HTMLElement, state: RigState): () => void {
  el.style.transformOrigin = "50% 100%";
  el.style.transform = `scale(${BASE})`;
  if (typeof el.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return () => undefined;
  const clip = TIER0_CLIPS[state];
  // a random start, so a list of faces never moves in lockstep
  const anim = el.animate(clip.keys.map(frame), { duration: clip.ms, easing: clip.ease, iterations: Infinity, delay: -Math.random() * clip.ms });
  return () => anim.cancel();
}

// ── pose frames: the base animation every avatar is mapped onto ─────────────
// Each avatar can carry frames for these poses (rendered by the daemon,
// packages/cli/src/entry/avatarPoses.ts). The scripts below are written once
// and play the same on every avatar: a frame name and how long it holds.
// Frames of one loop line up exactly, so a swap reads as movement, never a
// flash (no brightness change between frames).
export type PoseName = "rest" | "blink" | "look_left" | "look_right" | "thinking" | "thinking_b" | "working" | "working_b" | "creating" | "creating_b";
/** [frame, hold ms, fade-in ms]: each frame dissolves in over the one before
 *  (owner: "smoother, not snapping, like real life"). */
export type PoseScript = Array<[PoseName, number, number]>;
export type PoseState = "idle" | "thinking" | "working" | "creating";

export const POSE_SCRIPTS: Record<PoseState, PoseScript> = {
  // rests, blinks, glances left, glances right, blinks again
  idle: [["rest", 2600, 380], ["blink", 90, 70], ["rest", 1700, 110], ["look_left", 1300, 480], ["rest", 300, 420], ["look_right", 1300, 480], ["rest", 2300, 420], ["blink", 90, 70], ["rest", 900, 110]],
  // taps its chin
  thinking: [["thinking", 650, 420], ["thinking_b", 650, 420]],
  // types
  working: [["working", 300, 200], ["working_b", 300, 200], ["working", 300, 200], ["working_b", 300, 200], ["working", 900, 260]],
  // turns the ember cube over in its hands
  creating: [["creating", 700, 520], ["creating_b", 700, 520]],
};

/** What the agent is doing, from its live activity line. */
export function poseStateOf(busy: boolean | undefined, activity?: string): PoseState {
  if (!busy) return "idle";
  const a = (activity ?? "").toLowerCase();
  if (/think|plan|reason|consider|research|search|read/.test(a)) return "thinking";
  if (/writ|edit|creat|forge|build|render|draw|generat|design|make/.test(a)) return "creating";
  return "working";
}
