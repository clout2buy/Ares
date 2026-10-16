// Demo content for the Forge tour (ForgeIntro.tsx). Everything here runs through
// the SAME code the real tools use (ExplainStream, the studio engine, the story
// engine), so the tour shows the actual systems, not a mock.

import { buildLiveStageHtml, buildStudioHtml, expandForgeKit, renderExplainer } from "../../packages/cli/src/entry/forgeKit";
import { sanitizeAnim, sanitizeModelPart } from "../../packages/cli/src/entry/forgeBlocks";

type Obj = Record<string, unknown>;

const O = "#e8742a", C = "#f6ead2", K = "#26201e";

/** A low-poly fox, authored the way Ares authors: rings along a spine (loft), mirrored limbs, hinged joints. */
export const FOX_RAW: Obj[] = [
  { name: "torso", shape: "loft", seg: 7, color: C, color2: O, grad: "y", sections: [[0, 1.55, -1.7, 0.1, 0.12], [0, 1.62, -1.25, 0.55, 0.6], [0, 1.58, -0.3, 0.64, 0.62], [0, 1.5, 0.6, 0.62, 0.66], [0, 1.72, 1.25, 0.46, 0.52]], stage: "blockout" },
  { name: "head", shape: "loft", seg: 7, color: C, color2: O, grad: "y", parent: "torso", pivot: [0, 1.95, 1.1], sections: [[0, 1.9, 1.05, 0.34, 0.4], [0, 2.32, 1.62, 0.46, 0.44], [0, 2.36, 2.0, 0.42, 0.36], [0, 2.22, 2.5, 0.22, 0.2], [0, 2.16, 2.92, 0.05, 0.05]], stage: "form" },
  { name: "nose", shape: "poly", pos: [0, 2.17, 2.92], size: 0.15, color: K, detail: 0, parent: "head", stage: "detail" },
  { name: "ear", shape: "pyramid", pos: [0.3, 2.95, 1.72], size: [0.42, 0.78, 0.2], rot: [-12, 0, -14], color: O, mirror: true, parent: "head", stage: "detail" },
  { name: "inner ear", shape: "pyramid", pos: [0.3, 2.88, 1.8], size: [0.26, 0.5, 0.1], rot: [-12, 0, -14], color: K, mirror: true, parent: "head", stage: "detail" },
  { name: "eye", shape: "poly", pos: [0.27, 2.4, 2.22], size: 0.1, color: K, detail: 0, mirror: true, parent: "head", stage: "detail" },
  { name: "front leg", shape: "loft", seg: 6, color: K, color2: O, grad: "y", mirror: true, parent: "torso", pivot: [0.3, 1.5, 1.0], sections: [[0.3, 1.55, 1.0, 0.22, 0.24], [0.28, 1.0, 1.06, 0.15, 0.17], [0.28, 0.4, 1.1, 0.1, 0.11], [0.28, 0.06, 1.22, 0.13, 0.16]], stage: "form" },
  { name: "back leg", shape: "loft", seg: 6, color: K, color2: O, grad: "y", mirror: true, parent: "torso", pivot: [0.4, 1.5, -1.1], sections: [[0.42, 1.75, -1.0, 0.3, 0.34], [0.4, 1.1, -1.3, 0.18, 0.22], [0.36, 0.55, -1.6, 0.1, 0.12], [0.36, 0.06, -1.45, 0.12, 0.16]], stage: "form" },
  { name: "tail", shape: "loft", seg: 7, color: C, color2: O, grad: "z", mid: 0.3, parent: "torso", pivot: [0, 1.65, -1.6], sections: [[0, 1.65, -1.7, 0.12, 0.12], [0, 1.85, -2.35, 0.3, 0.3], [0, 2.1, -3.05, 0.46, 0.46], [0, 2.35, -3.7, 0.34, 0.34], [0, 2.5, -4.15, 0.03, 0.03]], stage: "form" },
];

export const TROT = { name: "trot", dur: 1, motion: [
  { part: "front leg*", kind: "swing", axis: "x", amp: 30, speed: 2 },
  { part: "back leg*", kind: "swing", axis: "x", amp: 30, speed: 2, phase: 3.14 },
  { part: "torso", kind: "bob", amp: 0.06, speed: 4 },
  { part: "tail", kind: "wag", axis: "y", amp: 16, speed: 2 },
  { part: "head", kind: "swing", axis: "x", amp: 5, speed: 2 },
] };

const expand = (raw: Obj[], style = "lowpoly", edge = ""): Obj[] => raw.flatMap((p) => sanitizeModelPart(p, style, 220, edge));

export interface StudioSpec { title: string; style: string; look: string; parts: Obj[]; anims: Obj[]; view: Obj; scripts: Obj[] }
export const foxSpec = (over: Partial<StudioSpec> & { raw?: Obj[] } = {}): StudioSpec => ({
  title: "Fox", style: "lowpoly", look: "clay", anims: [], view: {}, scripts: [],
  ...over,
  parts: expand(over.raw ?? FOX_RAW),
});
export const withAnims = (anims: Obj[]): Obj[] => anims.map((a) => sanitizeAnim(a)).filter((a): a is Obj => !!a);

/** The edit sequence the tour plays on the fox: each step is exactly the kind of op Ares sends. */
export const FOX_EDITS: Array<{ say: string; op: string; spec: () => StudioSpec }> = [
  { say: "make the head rounder", op: '{ op: "set", name: "head", sections: [...] }', spec: () => foxSpec({ raw: FOX_RAW.map((p) => p.name === "head" ? { ...p, sections: [[0, 1.9, 1.05, 0.4, 0.44], [0, 2.32, 1.62, 0.56, 0.52], [0, 2.36, 2.0, 0.5, 0.44], [0, 2.2, 2.45, 0.27, 0.24], [0, 2.14, 2.86, 0.1, 0.09]] } : p) }) },
  { say: "now a pastel backdrop", op: '{ look: "pastel" }', spec: () => foxSpec({ look: "pastel", raw: FOX_RAW.map((p) => p.name === "head" ? { ...p, sections: [[0, 1.9, 1.05, 0.4, 0.44], [0, 2.32, 1.62, 0.56, 0.52], [0, 2.36, 2.0, 0.5, 0.44], [0, 2.2, 2.45, 0.27, 0.24], [0, 2.14, 2.86, 0.1, 0.09]] } : p) }) },
  { say: "give it a collar and let it trot", op: '{ op: "add", parts: [collar] }, anims: [trot]', spec: () => foxSpec({
    look: "pastel", anims: withAnims([TROT]), view: { play: true, camera: "3q" },
    raw: [...FOX_RAW.map((p) => p.name === "head" ? { ...p, sections: [[0, 1.9, 1.05, 0.4, 0.44], [0, 2.32, 1.62, 0.56, 0.52], [0, 2.36, 2.0, 0.5, 0.44], [0, 2.2, 2.45, 0.27, 0.24], [0, 2.14, 2.86, 0.1, 0.09]] } : p),
      { name: "collar", shape: "loft", seg: 7, color: "#f6ead2", sections: [[0, 1.95, 1.05, 0.5, 0.52], [0, 2.0, 1.2, 0.5, 0.52]], parent: "torso", pivot: [0, 1.95, 1.1] }] }) },
  { say: "show me the skeleton", op: '{ view: { rig: true, camera: "side" } }', spec: () => foxSpec({
    look: "pastel", anims: withAnims([TROT]), view: { rig: true, camera: "side", play: true },
    raw: [...FOX_RAW.map((p) => p.name === "head" ? { ...p, sections: [[0, 1.9, 1.05, 0.4, 0.44], [0, 2.32, 1.62, 0.56, 0.52], [0, 2.36, 2.0, 0.5, 0.44], [0, 2.2, 2.45, 0.27, 0.24], [0, 2.14, 2.86, 0.1, 0.09]] } : p),
      { name: "collar", shape: "loft", seg: 7, color: "#f6ead2", sections: [[0, 1.95, 1.05, 0.5, 0.52], [0, 2.0, 1.2, 0.5, 0.52]], parent: "torso", pivot: [0, 1.95, 1.1] }] }) },
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

/** The tool call the tour "writes" while the live stage builds the fox from it. Parts are on their own lines so the JSON reads like Ares's output. */
export function foxCallJson(): string {
  const parts = FOX_RAW.map((p) => JSON.stringify(p));
  return `{"action":"model","model":"fox","style":"lowpoly","look":"clay","parts":[\n${parts.join(",\n")}\n]}`;
}
