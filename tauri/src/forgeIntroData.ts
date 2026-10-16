// Demo content for the Forge tour (ForgeIntro.tsx). Everything here runs through
// the SAME code the real tools use (ExplainStream, the studio engine, the story
// engine), so the tour shows the actual systems, not a mock.

import { buildLiveStageHtml, buildStudioHtml, expandForgeKit, renderExplainer } from "../../packages/cli/src/entry/forgeKit";
import { sanitizeAnim, sanitizeModelPart } from "../../packages/cli/src/entry/forgeBlocks";

type Obj = Record<string, unknown>;

const O = "#e8742a", C = "#f6ead2", K = "#26201e";

/** A fox, authored the way Ares authors creatures: ONE sculpt part whose blobs melt into a single skin, joints the blobs bend with, eyes and nose snapped onto the surface. */
export const FOX_BLOBS: Obj[] = [
  { id: "chest", s: "ball", at: [0, 0.78, 0.38], r: [0.24, 0.27, 0.3] },
  { id: "belly", s: "ball", at: [0, 0.78, -0.05], r: [0.21, 0.21, 0.36], k: 0.2 },
  { id: "hips", s: "ball", at: [0, 0.8, -0.42], r: [0.22, 0.23, 0.24], k: 0.18 },
  { id: "neck", s: "stick", at: [0, 0.86, 0.5], to: [0, 1.06, 0.7], r: 0.17, r2: 0.13, k: 0.12, bone: "head" },
  { id: "skull", s: "ball", at: [0, 1.1, 0.78], r: [0.15, 0.14, 0.16], k: 0.08, bone: "head" },
  { id: "cheek", s: "ball", at: [0.09, 1.04, 0.8], r: [0.09, 0.08, 0.1], k: 0.06, bone: "head", mirror: true, color: C },
  { id: "snout", s: "stick", at: [0, 1.07, 0.86], to: [0, 1.01, 1.12], r: 0.075, r2: 0.035, k: 0.06, bone: "head" },
  { id: "jaw", s: "stick", at: [0, 1.0, 0.84], to: [0, 0.98, 1.06], r: 0.05, r2: 0.03, k: 0.05, bone: "head", color: C },
  { id: "ear", s: "stick", at: [0.08, 1.2, 0.74], to: [0.12, 1.38, 0.72], r: 0.06, r2: 0.012, k: 0.04, bone: "head", mirror: true },
  { id: "earIn", s: "ball", at: [0.1, 1.27, 0.77], r: [0.035, 0.07, 0.03], paint: true, soft: 0.02, color: K, mirror: true },
  { id: "bib", s: "ball", at: [0, 0.82, 0.62], r: [0.16, 0.24, 0.14], paint: true, soft: 0.08, color: C },
  { id: "chin", s: "ball", at: [0, 0.98, 0.95], r: [0.07, 0.04, 0.14], paint: true, soft: 0.03, color: C },
  { id: "armF", s: "chain", pts: [[0.13, 0.78, 0.4, 0.09], [0.13, 0.45, 0.42, 0.055], [0.13, 0.12, 0.43, 0.04], [0.13, 0.035, 0.49, 0.045]], k: 0.06, bone: "legF", mirror: true },
  { id: "thigh", s: "ball", at: [0.13, 0.72, -0.42], r: [0.1, 0.19, 0.15], k: 0.12, bone: "legB", mirror: true },
  { id: "shin", s: "stick", at: [0.14, 0.6, -0.36], to: [0.14, 0.3, -0.5], r: 0.07, r2: 0.045, k: 0.05, bone: "legB", mirror: true },
  { id: "hock", s: "chain", pts: [[0.14, 0.3, -0.5, 0.045], [0.14, 0.05, -0.44, 0.04], [0.14, 0.035, -0.37, 0.045]], k: 0.04, bone: "pawB", mirror: true },
  { id: "sockF", s: "ball", at: [0.13, 0.12, 0.44], r: [0.08, 0.17, 0.09], paint: true, soft: 0.05, color: K, mirror: true },
  { id: "sockB", s: "ball", at: [0.14, 0.13, -0.45], r: [0.08, 0.18, 0.1], paint: true, soft: 0.05, color: K, mirror: true },
  { id: "tail", s: "chain", pts: [[0, 0.86, -0.6, 0.06], [0, 0.78, -0.82, 0.13], [0, 0.6, -1.05, 0.15], [0, 0.48, -1.22, 0.07]], k: 0.08, bone: "tail" },
  { id: "tip", s: "ball", at: [0, 0.48, -1.22], r: [0.12, 0.12, 0.13], paint: true, soft: 0.06, color: C },
];
const FOX_BODY: Obj = { name: "body", shape: "sculpt", mat: "fur", color: O, tint: 0.07, res: 72, blobs: FOX_BLOBS };
export const FOX_RAW: Obj[] = [
  FOX_BODY,
  { name: "head", shape: "joint", pos: [0, 0.92, 0.55] },
  { name: "legF", shape: "joint", pos: [0.13, 0.78, 0.4], mirror: true },
  { name: "legB", shape: "joint", pos: [0.13, 0.72, -0.42], mirror: true },
  { name: "pawB", shape: "joint", pos: [0.14, 0.3, -0.5], parent: "legB", mirror: true },
  { name: "tail", shape: "joint", pos: [0, 0.84, -0.58] },
  { name: "eye", shape: "sphere", pos: [0.07, 1.13, 0.9], size: [0.035, 0.03, 0.035], color: "#140d08", mat: "glossy", parent: "head", mirror: true, snap: "body", out: -0.006 },
  { name: "nose", shape: "sphere", pos: [0, 1.03, 1.15], size: [0.045, 0.035, 0.04], color: K, mat: "glossy", parent: "head", snap: "body", out: -0.008 },
];
/** The fox with some blobs patched by id: exactly what {op:"blob", name:"body", id, ...} does in the studio. */
const foxWith = (patch: Record<string, Obj>, add: Obj[] = []): Obj[] => FOX_RAW.map((p) => p === FOX_BODY ? { ...p, blobs: [...FOX_BLOBS.map((b) => patch[String(b.id)] ? { ...b, ...patch[String(b.id)] } : b), ...add] } : p);
const ROUND = { skull: { r: [0.17, 0.16, 0.17] }, cheek: { r: [0.11, 0.095, 0.11] } };
const COLLAR: Obj = { id: "collar", s: "stick", at: [0, 0.9, 0.56], to: [0, 0.98, 0.64], r: 0.2, paint: true, soft: 0.012, color: "#c8453a" };

export const TROT = { name: "trot", dur: 0.7, motion: [
  { part: "legF", kind: "step", axis: "x", amp: 26, speed: 1.43, duty: 0.5 },
  { part: "legB", kind: "step", axis: "x", amp: 26, speed: 1.43, duty: 0.5, phase: 3.14 },
  { part: "pawB", kind: "lift", axis: "x", amp: -40, speed: 1.43, duty: 0.5, phase: 3.14 },
  { part: "body", kind: "bob", axis: "y", amp: 0.02, speed: 2.86 },
  { part: "tail", kind: "wag", axis: "y", amp: 14, speed: 1.43 },
  { part: "head", kind: "swing", axis: "x", amp: 3, speed: 2.86 },
] };

const expand = (raw: Obj[], style = "", edge = ""): Obj[] => raw.flatMap((p) => sanitizeModelPart(p, style, 220, edge));

export interface StudioSpec { title: string; style: string; look: string; parts: Obj[]; anims: Obj[]; view: Obj; scripts: Obj[] }
export const foxSpec = (over: Partial<StudioSpec> & { raw?: Obj[] } = {}): StudioSpec => ({
  title: "Fox", style: "", look: "clay", anims: [], view: {}, scripts: [],
  ...over,
  parts: expand(over.raw ?? FOX_RAW),
});
export const withAnims = (anims: Obj[]): Obj[] => anims.map((a) => sanitizeAnim(a)).filter((a): a is Obj => !!a);

/** The edit sequence the tour plays on the fox: each step is exactly the kind of op Ares sends. */
export const FOX_EDITS: Array<{ say: string; op: string; spec: () => StudioSpec }> = [
  { say: "make the head rounder", op: '{ op: "blob", name: "body", id: "skull", r: [0.17, 0.16, 0.17] }', spec: () => foxSpec({ raw: foxWith(ROUND) }) },
  { say: "now a pastel backdrop", op: '{ look: "pastel" }', spec: () => foxSpec({ look: "pastel", raw: foxWith(ROUND) }) },
  { say: "give it a red collar and let it trot", op: '{ op: "blob", name: "body", id: "collar", paint: true, ... }, anims: [trot]', spec: () => foxSpec({
    look: "pastel", anims: withAnims([TROT]), view: { play: true, camera: "3q" }, raw: foxWith(ROUND, [COLLAR]) }) },
  { say: "show me the skeleton", op: '{ view: { rig: true, camera: "side" } }', spec: () => foxSpec({
    look: "pastel", anims: withAnims([TROT]), view: { rig: true, camera: "side", play: true }, raw: foxWith(ROUND, [COLLAR]) }) },
];

/** Three chest variants side by side, one clip that opens them in turn: what `instance({material})` gives a game. */
export function chestsSpec(): StudioSpec {
  const arc = Array.from({ length: 13 }, (_, i) => { const a = Math.PI * i / 12; return [+(Math.cos(a)).toFixed(3), +(Math.sin(a) * 0.5).toFixed(3)]; });
  const variants = [
    { id: "w", x: -3.4, wood: "#8a5a2b", band: "#5d6068", name: "wooden" },
    { id: "i", x: 0, wood: "#4b3f3a", band: "#9aa2ad", name: "iron-bound" },
    { id: "f", x: 3.4, wood: "#8fc0e8", band: "#e8f4ff", name: "frost" },
  ];
  const raw: Obj[] = [];
  const tracks: Obj[] = [];
  variants.forEach((v, k) => {
    raw.push(
      { name: `${v.id}_base`, shape: "box", pos: [v.x, 0.55, 0], size: [2, 1.1, 1.3], color: v.wood, mat: "clay" },
      { name: `${v.id}_lid`, shape: "extrude", pts: arc.map(([x, y]) => [x! + v.x, y]), depth: 1.3, bevel: 0.02, pos: [0, 1.1, 0], pivot: [v.x, 1.1, -0.65], color: v.wood, mat: "clay", parent: `${v.id}_base` },
      { name: `${v.id}_strap`, shape: "box", pos: [v.x + 0.62, 0.55, 0], size: [0.16, 1.14, 1.36], color: v.band, mat: "metal", mirror: true, parent: `${v.id}_base` },
      { name: `${v.id}_lock`, shape: "box", pos: [v.x, 1.05, 0.68], size: [0.34, 0.38, 0.1], color: "#e0b43a", mat: "metal", parent: `${v.id}_lid`, pivot: [v.x, 1.1, -0.65] },
      { name: `${v.id}_gold`, shape: "poly", pos: [v.x, 1.0, 0], size: [1.5, 0.3, 0.8], color: "#ffd24a", detail: 1, jitter: 0.08, mat: "metal", parent: `${v.id}_base` },
    );
    tracks.push({ part: `${v.id}_lid`, rot: [[0, [0, 0, 0]], [0.5 + k * 0.9, [0, 0, 0]], [1.3 + k * 0.9, [-105, 0, 0]], [5.2, [-105, 0, 0]], [6, [0, 0, 0]]] });
  });
  return { title: "Chests", style: "lowpoly", look: "pastel", parts: expand(raw), anims: withAnims([{ name: "open all", dur: 6, loop: true, tracks }]), view: { play: true, camera: "front", fit: "anim" }, scripts: [] };
}

// ── real pages for the iframes ──
const ROME = { type: "story", title: "Rise and fall of Rome", scenes: [
  { t: "753 BC", bg: "dawn", say: "A cluster of huts on seven hills.", do: [{ op: "spawn", sprite: "mountain", at: [30, 66], scale: 2 }, { op: "spawn", sprite: "house", n: 4, at: [70, 72], spread: [40, 8] }, { op: "spawn", sprite: "person", id: "folk", n: 6, at: [70, 78] }, { op: "meter", id: "p", label: "Power", value: 10 }] },
  { t: "509 BC", bg: "day", say: "Kings out. Citizens in. A Republic.", do: [{ op: "spawn", sprite: "temple", id: "tmp", at: [110, 72] }, { op: "spawn", sprite: "person", n: 14, at: [90, 78], spread: [50, 6] }, { op: "meter", id: "p", label: "Power", value: 35 }] },
  { t: "264 BC", say: "Legions march out across the sea.", do: [{ op: "spawn", sprite: "soldier", id: "leg", n: 10, at: [25, 76], spread: [16, 8] }, { op: "move", id: "leg", to: [130, 78], dur: 3 }, { op: "spawn", sprite: "flag", at: [145, 76], color: "red" }, { op: "meter", id: "p", label: "Power", value: 70 }] },
  { t: "27 BC", say: "The Empire. Power at its peak.", do: [{ op: "spawn", sprite: "column", n: 3, at: [40, 74], spread: [20, 4] }, { op: "spawn", sprite: "crown", at: [80, 50] }, { op: "spawn", sprite: "sun", at: [130, 16] }, { op: "meter", id: "p", label: "Power", value: 100 }] },
  { t: "410 AD", bg: "storm", say: "Stretched thin, Rome is sacked.", do: [{ op: "spawn", sprite: "soldier", id: "inv", n: 8, at: [10, 76], spread: [8, 8], color: "purple" }, { op: "move", id: "inv", to: [100, 76], dur: 2.5 }, { op: "fall", id: "tmp" }, { op: "spawn", sprite: "fire", n: 3, at: [100, 74], spread: [14, 4] }, { op: "meter", id: "p", label: "Power", value: 25 }] },
  { t: "476 AD", bg: "night", say: "The West falls.", do: [{ op: "fall", id: "folk" }, { op: "spawn", sprite: "label", at: [80, 40], text: "THE WEST FALLS", color: "gold" }, { op: "meter", id: "p", label: "Power", value: 4 }] },
] };
export const romeHtml = (): string => expandForgeKit(renderExplainer({ title: "Rome", blocks: [ROME] }));
export const liveStageHtml = (): string => buildLiveStageHtml();
export const manualStudioHtml = (title: string): string => buildStudioHtml("tour", title, { manual: true });

/** The tool call the tour "writes" while the live stage builds the fox from it. Parts and blobs are on their own lines so the JSON reads like
 *  Ares's output, and the live stage melts the sculpt together blob by blob as it streams. */
export function foxCallJson(): string {
  const parts = FOX_RAW.map((p) => {
    if (p !== FOX_BODY) return JSON.stringify(p);
    const { blobs, ...head } = p as Obj & { blobs: Obj[] };
    return `${JSON.stringify(head).slice(0, -1)},"blobs":[\n  ${blobs.map((b) => JSON.stringify(b)).join(",\n  ")}\n]}`;
  });
  return `{"action":"model","model":"fox","look":"clay","parts":[\n${parts.join(",\n")}\n]}`;
}
