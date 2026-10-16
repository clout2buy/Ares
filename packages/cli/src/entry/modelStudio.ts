// The model studio: a persistent, editable 3D model document that Ares works on
// across Browser calls, and the Forge shows live.
//
// `Browser action:"model"` does NOT re-render a page per call. It edits this
// document (add / set / remove parts, anims, style, look, a reference picture),
// the Forge page polls /__ares/studio/<id> and reconciles in place (parts morph
// to their new transform, new parts pop in, removed ones shrink out), and Ares
// gets screenshots from chosen angles to critique its own work and edit again.
// Authored (raw) parts are what is stored and saved, so a model stays compact
// and editable; the sanitised, mirror/repeat-expanded spec is derived for the
// page on every change.

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { buildRuntimeModule } from "./forgeRuntime.js";
import { lintBlob, MODEL_MATS, MODEL_SHAPES, sanitizeOverride, sanitizeTexture, uniqueNames, sanitizeAnim, sanitizeModelPart, sanitizeScript, MODEL_LOOKS, MODEL_STYLES, colour } from "./forgeBlocks.js";

type Obj = Record<string, unknown>;

export interface Studio {
  id: string;
  title: string;
  style: string;
  look: string;
  edge: string;
  raw: Obj[];
  anims: Obj[];
  /** JS the page runs every frame (water, lava, rain, physics…): authored by Ares, see sanitizeScript */
  scripts: Obj[];
  /** colourways: name -> { "lid*": {color,color2,mat,texture,...} }. One model + its clips serves many looks; the game picks one per instance. */
  variants: Record<string, Record<string, Obj>>;
  /** errors / log lines scripts reported back (drained into the next tool result) */
  logs: string[];
  ref?: string;
  /** served URL of a project page shown behind the model (the real game it will live in) */
  backdrop?: string;
  /** how the page presents the model, set by Ares from what the owner says (wireframe, spin, rig, camera, which clip plays) */
  view: Obj;
  version: number;
  /** highest version a page has fetched (so Ares can wait for the Forge to apply an edit) */
  seen: number;
  url?: string;
}

const studios = new Map<string, Studio>();
const REF_MAX_BYTES = 2_000_000;

export const studioId = (v: unknown): string => String(v ?? "model").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "model";
export const getStudio = (id: string): Studio | undefined => studios.get(id);
export function ensureStudio(id: string): Studio {
  let st = studios.get(id);
  if (!st) { st = { id, title: "", style: "", look: "", edge: "", raw: [], anims: [], scripts: [], variants: {}, logs: [], view: {}, version: 0, seen: 0 }; studios.set(id, st); }
  return st;
}
export function dropStudios(): void { studios.clear(); }
export function addStudioLog(id: string, line: string): void {
  const st = studios.get(id);
  if (!st) return;
  st.logs.push(line.slice(0, 300));
  if (st.logs.length > 40) st.logs.splice(0, st.logs.length - 40);
}
/** Take (and clear) what scripts reported since the last call. */
export function drainStudioLogs(st: Studio): string[] { return st.logs.splice(0); }

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const nameOf = (p: Obj): string => String(p.name ?? p.shape ?? "part").slice(0, 32);

/** "leg*" matches by prefix, anything else exactly. */
const matches = (sel: string, name: string): boolean => (sel.endsWith("*") ? name.startsWith(sel.slice(0, -1)) : name === sel);

function upsert(list: Obj[], p: Obj): void {
  const n = nameOf(p), i = list.findIndex((q) => nameOf(q) === n);
  if (i >= 0) list[i] = { ...p, name: n }; else list.push({ ...p, name: n });
}

/** Same containment as inside(), but follows symlinks: the nearest existing ancestor must really live in the project. */
async function insideReal(cwd: string, rel: string): Promise<string> {
  const abs = inside(cwd, rel);
  const root = await realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
  let probe = abs;
  for (let i = 0; i < 40; i++) {
    const real = await realpath(probe).catch(() => null);
    if (real) {
      if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`path escapes the project through a symlink: ${rel}`);
      const home = path.resolve(homedir(), ".ares");
      if (real === home || real.startsWith(home + path.sep)) throw new Error("~/.ares is off limits");
      return abs;
    }
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  return abs;
}

async function readJsonFile(cwd: string, rel: string, maxBytes = 2_000_000): Promise<unknown> {
  const abs = await insideReal(cwd, rel);
  const st = await stat(abs);
  if (st.size > maxBytes) throw new Error(`${rel} is ${(st.size / 1e6).toFixed(1)}MB (max ${maxBytes / 1e6}MB)`);
  return JSON.parse(await readFile(abs, "utf8"));
}

/** Resolve a path for reading/writing assets: relative paths live under cwd and may not escape it. */
function inside(cwd: string, rel: string): string {
  const abs = path.resolve(cwd, rel);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`path escapes the project: ${rel}`);
  const home = path.resolve(homedir(), ".ares");
  if (abs === home || abs.startsWith(home + path.sep)) throw new Error("~/.ares is off limits");
  return abs;
}

export interface ModelEdit {
  title?: string; style?: string; look?: string; edge?: string; reset?: boolean;
  parts?: unknown[]; ops?: unknown[]; remove?: unknown[]; anims?: unknown[]; scripts?: unknown[];
  ref?: string; load?: string; backdrop?: string; view?: unknown;
}

const VIEW_BOOL = ["wire", "smooth", "spin", "rig", "play"];
const VIEW_CAMERAS = ["3q", "front", "back", "side", "top"];
/** Only known view settings survive; everything is a bool, a camera preset, a clip name or a bounded number. */
const SEL_RE = /^[A-Za-z0-9_ ()-]{1,40}\*?$/;
function cleanVariants(raw: unknown): Record<string, Record<string, Obj>> {
  const out: Record<string, Record<string, Obj>> = {};
  for (const [vn, sets] of Object.entries(obj(raw)).slice(0, 12)) {
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(vn)) continue;
    const one: Record<string, Obj> = {};
    for (const [sel, ov] of Object.entries(obj(sets)).slice(0, 40)) { const c = SEL_RE.test(sel) ? sanitizeOverride(ov) : null; if (c) one[sel] = c; }
    if (Object.keys(one).length) out[vn] = one;
  }
  return out;
}
const variantHit = (sel: string, name: string): boolean => { const base = name.replace(/ \(mirror\)$/, ""); return sel.endsWith("*") ? base.startsWith(sel.slice(0, -1)) : sel === name || sel === base; };
/** What a part looks like in a variant: the base part with every matching override applied (later keys win). */
export function applyVariant(p: Obj, v: Record<string, Obj> | undefined): Obj {
  if (!v) return p;
  let q = p;
  for (const [sel, ov] of Object.entries(v)) if (variantHit(sel, String(p.name))) q = { ...q, ...ov };
  return q;
}

function mergeView(cur: Obj, raw: unknown): Obj {
  const o = obj(raw), out: Obj = { ...cur };
  for (const k of VIEW_BOOL) if (typeof o[k] === "boolean") out[k] = o[k];
  if (typeof o.camera === "string" && VIEW_CAMERAS.includes(o.camera)) out.camera = o.camera;
  if (typeof o.anim === "string") out.anim = o.anim.slice(0, 24);
  if (typeof o.variant === "string") out.variant = o.variant.slice(0, 24);
  if (typeof o.speed === "number" && Number.isFinite(o.speed)) out.speed = Math.min(3, Math.max(0.1, o.speed));
  if (typeof o.t === "number" && Number.isFinite(o.t)) out.t = Math.min(20, Math.max(0, o.t));
  if (typeof o.zoom === "number" && Number.isFinite(o.zoom)) out.zoom = Math.min(3, Math.max(0.3, o.zoom));
  if (o.fit === "anim" || o.fit === "rest") out.fit = o.fit;
  return out;
}

// ── lint: input is never silently ignored; unknown fields, shapes and dead clips come back as warnings ──
const PART_KEYS = new Set(["name", "shape", "pos", "size", "rot", "color", "color2", "grad", "mid", "shade", "mat", "smooth", "facets", "mirror", "repeat", "parent", "pivot", "stage", "scenery", "pts", "sections", "verts", "faces", "fcolors", "seg", "detail", "jitter", "depth", "bevel", "r", "r2", "caps", "steps", "texture", "blobs", "res", "noise", "tint", "ao", "snap", "out", "align", "fuzz", "tex", "grain", "bone", "poly", "flow", "shag"]);
const vec = (v: unknown): boolean => Array.isArray(v) && v.length >= 1 && v.length <= 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

function lintPart(p: Obj): string[] {
  const n = nameOf(p), w: string[] = [];
  for (const k of Object.keys(p)) if (!PART_KEYS.has(k)) w.push(`part "${n}": unknown field "${k}" was ignored (fields: ${[...PART_KEYS].join(", ")})`);
  if (p.shape !== undefined && !MODEL_SHAPES.includes(String(p.shape))) w.push(`part "${n}": unknown shape "${String(p.shape)}", drawn as a box (shapes: ${MODEL_SHAPES.join(", ")})`);
  if (p.mat !== undefined && !MODEL_MATS.includes(String(p.mat))) w.push(`part "${n}": unknown mat "${String(p.mat)}" (mats: ${MODEL_MATS.join(", ")})`);
  for (const k of ["pos", "rot", "pivot"]) if (p[k] !== undefined && !vec(p[k])) w.push(`part "${n}": ${k} should be [x,y,z] numbers`);
  if (p.size !== undefined && !vec(p.size) && typeof p.size !== "number") w.push(`part "${n}": size should be [x,y,z] or one number`);
  if (p.texture !== undefined && !sanitizeTexture(p.texture)) w.push(`part "${n}": texture needs {kind: planks|bricks|noise|checker|stripes|dots, colors:[#hex...]}`);
  if (p.shape === "sculpt") {
    const bl = arr(p.blobs);
    if (!bl.length) w.push(`part "${n}": a sculpt needs blobs:[{s:"ball",at:[x,y,z],r:[rx,ry,rz]}, {s:"stick",at,to,r,r2}, ...] (help:true has a worked creature)`);
    bl.slice(0, 64).forEach((b, i) => { for (const x of lintBlob(b, i)) w.push(`part "${n}": ${x}`); });
    if (bl.length > 64) w.push(`part "${n}": ${bl.length} blobs, only the first 64 are used`);
  }
  if (p.color !== undefined && !colour(p.color)) w.push(`part "${n}": colour "${String(p.color)}" not recognised (use #rrggbb or a name like orange/gold/white)`);
  return w;
}

// ── the quality bar: what separates a real model from a toy, checked on every edit so Ares fixes it unprompted ──
const ORGANIC_NAME = /head|leg|arm|ear|tail|eye|torso|body|snout|muzzle|paw|wing|neck|hand|foot|feet|belly|hip|nose|horn|fin|beak|thigh|shin|chest|jaw|mouth|claw|hoof|mane/i;
const PRIMITIVE = new Set(["sphere", "capsule", "cylinder", "cone", "loft", "poly", "torus", "tube", "pyramid", "box", "prism"]);
const GAIT_NAME = /walk|run|trot|gallop|jog|sprint|stride|march|crawl/i;
/** Quality notes on the whole model (each starts "quality:"): stacked primitives, blockouts, flat colour, no eyes, no animation, sine-wave walks. */
export function qualityNotes(st: Studio): string[] {
  const out: string[] = [], raw = st.raw;
  if (!raw.length) return out;
  const sculpts = raw.filter((p) => p.shape === "sculpt");
  const organic = raw.filter((p) => PRIMITIVE.has(String(p.shape ?? "box")) && ORGANIC_NAME.test(nameOf(p)) && !p.snap);
  if (!sculpts.length && organic.length >= 4) out.push(`quality: this is a creature/character stacked from primitives (${organic.slice(0, 6).map(nameOf).join(", ")}...): the toy look. Rebuild it as ONE sculpt part (blobs melt into one skin; help:true has the method) with joints, and remove these parts.`);
  else if (!sculpts.length && raw.filter((p) => PRIMITIVE.has(String(p.shape ?? "box"))).length >= 4 && !raw.some((p) => p.texture)) out.push("quality: props look real when sculpted too: one sculpt with box/cyl blobs (round = bevelled edges), sub carves for grooves/panel lines, and per-blob mat (metal, leather, wood, stone) + tex. Bare primitives read as a blockout.");
  for (const p of sculpts) {
    const blobs = arr(p.blobs).map(obj), add = blobs.filter((b) => !b.sub && !b.paint), n = nameOf(p);
    const bones = blobs.some((b) => b.bone);
    // judged on the whole model: a wheel of 8 blobs is a finished component of a 40-blob car, not a blockout
    const total = sculpts.reduce((t, q) => t + arr(q.blobs).map(obj).filter((b) => !b.sub && !b.paint).length, 0);
    if (total < 15 && p === sculpts.reduce((a, q) => (arr(q.blobs).length > arr(a.blobs).length ? q : a), sculpts[0]!)) out.push(`quality: "${n}" is a blockout (${total} masses in the model). Finished creatures carry 40-75 blobs, props 15-40: secondary forms (muscle groups, cheeks, brow, haunches; bevels, collars, panels) and details (toes, lips, nostrils, eyelids; rivets, wraps, grooves as small sub carves).`);
    const cols = new Set(blobs.map((b) => String(b.color ?? p.color ?? "")));
    if (cols.size <= 1 && !blobs.some((b) => b.paint)) out.push(`quality: "${n}" is one flat colour. Paint it: lighter belly/muzzle/chest, darker extremities and back, markings, tonal variation (paint blobs with soft edges).`);
    if (bones && !raw.some((q) => q.snap === n && /eye/i.test(nameOf(q)))) out.push(`quality: "${n}" is a creature with no eyes on it: add glossy eye parts with snap:"${n}" (and a nose/claws/teeth where the animal has them).`);
    if (bones && !st.anims.length) out.push(`quality: "${n}" is rigged but not animated. Every creature/character ships with clips: idle (breathing pulse on the chest, slow head/tail drift), walk (step + lift), and its signature action; play idle.`);
    if (!p.mat && !blobs.some((b) => b.mat)) out.push(`quality: "${n}" has no material: fur, skin, leather, stone, wood, metal, cloth (per blob too) give real surface detail.`);
  }
  if (st.anims.length && sculpts.some((p) => arr(p.blobs).some((b) => obj(b).bone)) && !st.anims.some((a) => /idle|breath|rest/i.test(String(a.name)))) out.push("quality: there is no idle clip: add one (breathing, small head/ear/tail motion) so the model is alive when nothing else plays.");
  for (const a of st.anims) {
    const motion = arr(a.motion).map(obj);
    if (GAIT_NAME.test(String(a.name)) && motion.some((m) => m.kind === "swing") && !motion.some((m) => m.kind === "step")) out.push(`quality: clip "${String(a.name)}" swings legs on a sine (feet skate). Use kind:"step" on upper limbs (plant, push back, lift, swing forward) + kind:"lift" on knees/hocks/paws with the same speed/phase, a body bob at twice the speed, and head/tail counter-motion.`);
  }
  return out;
}

/** Does a clip target match a part? Same rule the animation player uses: exact, or "name*" prefix; a mirror follows its original. */
function targetMatches(sel: string, names: string[]): boolean {
  return names.some((n) => {
    const base = n.replace(/ \(mirror\)$/, "");
    return sel.endsWith("*") ? base.startsWith(sel.slice(0, -1)) : sel === n || sel === base;
  });
}

function lintAnim(raw: Obj, partNames: string[]): string[] {
  const n = String(raw.name ?? "anim"), w: string[] = [];
  const clean = sanitizeAnim(raw);
  if (!clean) return [`clip "${n}" drives nothing and was dropped. A clip needs tracks:[{part, rot|pos|scale:[[t,[x,y,z]],...]}], motion:[{part,kind,axis,amp,speed}] or events:[{t,name}]. Example hinge: {name:"open",dur:1,loop:false,tracks:[{part:"lid",rot:[[0,[0,0,0]],[0.9,[-105,0,0]]]}]}`];
  for (const key of Object.keys(raw)) if (!["name", "dur", "loop", "tracks", "motion", "events"].includes(key)) w.push(`clip "${n}": unknown field "${key}" was ignored (clip fields: name, dur, loop, tracks, motion, events)`);
  for (const t of (clean.tracks as Obj[])) if (!targetMatches(String(t.part), partNames)) w.push(`clip "${n}": track part "${String(t.part)}" matches no part (parts: ${partNames.slice(0, 12).join(", ")})`);
  for (const m of (clean.motion as Obj[])) if (!targetMatches(String(m.part), partNames)) w.push(`clip "${n}": motion part "${String(m.part)}" matches no part`);
  const dropped = arr(raw.tracks).length - (clean.tracks as unknown[]).length;
  if (dropped > 0) w.push(`clip "${n}": ${dropped} track(s) were unusable (a track is {part, rot|pos|scale:[[t,[x,y,z]],...]})`);
  return w;
}

function moveBy(p: Obj, d: number[]): void {
  const add = (v: unknown): number[] => { const a = arr(v); return [Number(a[0] ?? 0) + d[0]!, Number(a[1] ?? 0) + d[1]!, Number(a[2] ?? 0) + d[2]!]; };
  // The part's geometry (sections / verts / pts / profile) is local to its node at the pivot, so moving a part moves
  // pos and pivot ONLY. Shifting the geometry as well double-offset every loft/extrude/mesh part (lids floated away).
  if (p.pos !== undefined) p.pos = add(p.pos); else p.pos = d;
  if (p.pivot !== undefined) p.pivot = add(p.pivot);
}

function scaleBy(p: Obj, f: number): void {
  const mul = (v: unknown): number[] => arr(v).map((n) => Number(n) * f);
  if (p.size !== undefined) p.size = typeof p.size === "number" ? p.size * f : mul(p.size); else if (!["loft", "mesh", "extrude", "lathe", "tube", "sculpt", "joint"].includes(String(p.shape))) p.size = [f, f, f];
  if (p.pos !== undefined) p.pos = mul(p.pos);
  if (p.pivot !== undefined) p.pivot = mul(p.pivot);
  for (const key of ["verts"]) if (Array.isArray(p[key])) p[key] = (p[key] as unknown[]).map((q) => mul(q));
  if (Array.isArray(p.sections)) p.sections = (p.sections as unknown[]).map((q) => arr(q).map((n) => Number(n) * f));
  if (Array.isArray(p.pts)) p.pts = (p.pts as unknown[]).map((q) => mul(q));
  for (const k of ["r", "r2", "depth"]) if (typeof p[k] === "number") p[k] = (p[k] as number) * f;
  if (Array.isArray(p.blobs)) p.blobs = (p.blobs as unknown[]).map((raw) => {
    const b = { ...obj(raw) };
    for (const k of ["at", "to"]) if (Array.isArray(b[k])) b[k] = mul(b[k]);
    for (const k of ["r", "r2", "k", "soft", "round"]) if (typeof b[k] === "number") b[k] = (b[k] as number) * f; else if (k === "r" && Array.isArray(b.r)) b.r = mul(b.r);
    if (Array.isArray(b.pts)) b.pts = (b.pts as unknown[]).map((q) => arr(q).map((v) => Number(v) * f));
    return b;
  });
}

/** Pull parts out of a saved model file (an asset library entry). */
async function importParts(cwd: string, o: Obj): Promise<Obj[]> {
  const doc = obj(await readJsonFile(cwd, String(o.file ?? "")));
  const names = arr(o.names).map(String);
  const at = arr(o.at).map(Number), f = Number(o.scale) > 0 ? Number(o.scale) : 1;
  let parts = arr(doc.parts).map(obj);
  if (names.length) parts = parts.filter((p) => names.some((s) => matches(s, nameOf(p))));
  const prefix = o.prefix ? String(o.prefix).slice(0, 16) : "";
  return parts.map((src) => {
    const p = JSON.parse(JSON.stringify(src)) as Obj;
    if (f !== 1) scaleBy(p, f);
    if (at.length >= 3) moveBy(p, [at[0] ?? 0, at[1] ?? 0, at[2] ?? 0]);
    if (prefix) { p.name = prefix + nameOf(p); if (p.parent) p.parent = prefix + String(p.parent); }
    return p;
  });
}

/** Apply one edit call to a studio. Returns what changed and any op that could not apply. */
export async function applyEdit(st: Studio, e: ModelEdit, cwd: string): Promise<{ touched: string[]; errors: string[] }> {
  const touched: string[] = [], errors: string[] = [];
  if (e.view !== undefined) { st.view = mergeView(st.view, e.view); touched.push("view"); }
  if (e.reset) { st.view = {}; st.variants = {}; st.raw = []; st.anims = []; st.scripts = []; st.ref = undefined; st.backdrop = undefined; }
  if (e.backdrop !== undefined) { st.backdrop = e.backdrop || undefined; touched.push(e.backdrop ? "backdrop" : "- backdrop"); }
  if (e.load) {
    try {
      const doc = obj(await readJsonFile(cwd, e.load));
      st.raw = arr(doc.parts).map(obj); st.anims = arr(doc.anims).map(obj); st.scripts = arr(doc.scripts).map(obj); st.variants = cleanVariants(doc.variants);
      st.style = String(doc.style ?? ""); st.look = String(doc.look ?? ""); st.edge = String(doc.edge ?? ""); st.title = String(doc.title ?? st.title);
      touched.push(`loaded ${e.load}`);
    } catch (err) { errors.push(`load: ${err instanceof Error ? err.message : String(err)}`); }
  }
  if (e.title !== undefined) st.title = String(e.title).slice(0, 60);
  if (e.style !== undefined && MODEL_STYLES.includes(String(e.style))) st.style = String(e.style);
  if (e.look !== undefined && MODEL_LOOKS.includes(String(e.look))) st.look = String(e.look);
  if (e.edge !== undefined) st.edge = colour(e.edge) ?? "";
  for (const p of arr(e.parts).slice(0, 120)) { const o = obj(p); upsert(st.raw, o); touched.push(nameOf(o)); }
  for (const a of arr(e.anims).slice(0, 12)) { const o = obj(a), n = String(o.name ?? "anim"); const i = st.anims.findIndex((x) => x.name === n); if (i >= 0) st.anims[i] = o; else st.anims.push(o); touched.push(`anim ${n}`); }
  for (const sc of arr(e.scripts).slice(0, 8)) { const s2 = sanitizeScript(sc); if (!s2) { errors.push("script needs a slug name and non-empty code"); continue; } const i = st.scripts.findIndex((x) => x.name === s2.name); if (i >= 0) st.scripts[i] = s2; else st.scripts.push(s2); touched.push(`script ${String(s2.name)}`); }
  for (const raw of arr(e.remove).slice(0, 60)) { const sel = String(raw); const before = st.raw.length; st.raw = st.raw.filter((p) => !matches(sel, nameOf(p))); if (st.raw.length === before) errors.push(`remove: no part "${sel}"`); else touched.push(`- ${sel}`); }
  for (const rawOp of arr(e.ops).slice(0, 60)) {
    const o = obj(rawOp), op = String(o.op);
    try {
      if (op === "set") {
        const sel = String(o.name ?? ""); const hit = st.raw.filter((p) => matches(sel, nameOf(p)));
        if (!hit.length) { errors.push(`set: no part "${sel}"`); continue; }
        for (const p of hit) {
          const { op: _op, name: _n, move, scale, to, ...rest } = o as Obj & { move?: unknown; scale?: unknown; to?: unknown };
          void _op; void _n;
          Object.assign(p, rest);
          if (Array.isArray(move)) moveBy(p, [Number(move[0] ?? 0), Number(move[1] ?? 0), Number(move[2] ?? 0)]);
          if (typeof scale === "number" && scale > 0) scaleBy(p, scale);
          if (typeof to === "string" && to) p.name = to.slice(0, 32);
          touched.push(nameOf(p));
        }
      } else if (op === "blob") {
        // edit ONE blob of a sculpt by its id (patch fields, remove:true, or add a new id) instead of re-sending every blob
        const part = st.raw.find((p) => nameOf(p) === String(o.name ?? ""));
        if (!part || part.shape !== "sculpt") { errors.push(`blob: no sculpt part "${String(o.name ?? "")}"`); continue; }
        const id = String(o.id ?? "").slice(0, 24);
        if (!id) { errors.push("blob: needs id (give blobs ids like \"muzzle\", \"hump\" when you write them)"); continue; }
        const list = arr(part.blobs).map(obj), i = list.findIndex((b) => String(b.id ?? "") === id);
        const { op: _o, name: _n, id: _i, remove, ...rest } = o as Obj & { remove?: unknown };
        void _o; void _n; void _i;
        if (remove === true) { if (i < 0) { errors.push(`blob: "${id}" not found in ${nameOf(part)}`); continue; } list.splice(i, 1); }
        else if (i >= 0) list[i] = { ...list[i], ...rest };
        else list.push({ id, ...rest });
        part.blobs = list;
        touched.push(nameOf(part));
      } else if (op === "remove") {
        const sel = String(o.name ?? ""); const before = st.raw.length; st.raw = st.raw.filter((p) => !matches(sel, nameOf(p)));
        if (st.raw.length === before) errors.push(`remove: no part "${sel}"`); else touched.push(`- ${sel}`);
      } else if (op === "add") {
        for (const p of arr(o.parts).slice(0, 120)) { upsert(st.raw, obj(p)); touched.push(nameOf(obj(p))); }
      } else if (op === "use") {
        if (o.parts !== false) for (const p of await importParts(cwd, o)) { upsert(st.raw, p); touched.push(nameOf(p)); }
        // clips ride along when asked (anims:true or ["open"]); with a prefix, their targets follow the renamed parts
        if (o.anims) {
          const wantA = o.anims === true ? null : arr(o.anims).map(String);
          const src = obj(await readJsonFile(cwd, String(o.file ?? "")));
          const pre = o.prefix ? String(o.prefix).slice(0, 16) : "";
          for (const c of arr(src.anims).map(obj)) {
            if (wantA && !wantA.includes(String(c.name))) continue;
            const clip = JSON.parse(JSON.stringify(c)) as Obj;
            clip.name = `${pre}${String(c.name ?? "anim")}`.slice(0, 24);
            for (const key of ["tracks", "motion"]) clip[key] = arr(clip[key]).map((t) => { const x = obj(t); return { ...x, part: `${pre}${String(x.part ?? "")}` }; });
            const i = st.anims.findIndex((x) => x.name === clip.name); if (i >= 0) st.anims[i] = clip; else st.anims.push(clip);
            touched.push(`anim ${String(clip.name)}`);
          }
        }
        // scripts ride along when asked: use:{file, scripts:["water"]} pulls a saved behaviour (a library of Ares's own tricks)
        const want = arr(o.scripts).map(String);
        if (want.length) {
          const doc = obj(await readJsonFile(cwd, String(o.file ?? "")));
          for (const sc of arr(doc.scripts)) { const s2 = sanitizeScript(sc); if (s2 && want.includes(String(s2.name))) { const i = st.scripts.findIndex((x) => x.name === s2.name); if (i >= 0) st.scripts[i] = s2; else st.scripts.push(s2); touched.push(`script ${String(s2.name)}`); } }
        }
      } else if (op === "script") {
        const s2 = sanitizeScript(o); if (!s2) { errors.push("script needs a slug name and non-empty code"); continue; }
        const i = st.scripts.findIndex((x) => x.name === s2.name); if (i >= 0) st.scripts[i] = s2; else st.scripts.push(s2); touched.push(`script ${String(s2.name)}`);
      } else if (op === "variant") {
        const vn = String(o.name ?? "").trim();
        if (!/^[A-Za-z0-9_-]{1,24}$/.test(vn)) { errors.push("variant needs a slug name"); continue; }
        const set = cleanVariants({ [vn]: o.set })[vn];
        if (!set || !Object.keys(set).length) { errors.push(`variant "${vn}": nothing usable in set (each entry is "partName*": {color|color2|mat|texture|smooth|shade})`); continue; }
        st.variants[vn] = { ...(st.variants[vn] ?? {}), ...set };
        touched.push(`variant ${vn}`);
      } else if (op === "remove_variant") {
        delete st.variants[String(o.name)]; touched.push(`- variant ${String(o.name)}`);
      } else if (op === "remove_script") {
        st.scripts = st.scripts.filter((x) => x.name !== String(o.name)); touched.push(`- script ${String(o.name)}`);
      } else if (op === "anim") {
        const a = obj(o.anim), n = String(a.name ?? "anim"); const i = st.anims.findIndex((x) => x.name === n); if (i >= 0) st.anims[i] = a; else st.anims.push(a); touched.push(`anim ${n}`);
      } else if (op === "remove_anim") {
        st.anims = st.anims.filter((x) => x.name !== String(o.name)); touched.push(`- anim ${String(o.name)}`);
      } else errors.push(`unknown op "${op}"`);
    } catch (err) { errors.push(`${op}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  if (e.ref !== undefined) {
    try { st.ref = await refDataUrl(cwd, e.ref); touched.push("reference"); } catch (err) { errors.push(`ref: ${err instanceof Error ? err.message : String(err)}`); }
  }
  // never silent: unknown fields / shapes / bad vectors on what this call touched, and clips that do nothing
  const names = new Set(touched);
  for (const p of st.raw) if (names.has(nameOf(p))) errors.push(...lintPart(p));
  const partNames = st.raw.map(nameOf);
  for (const a of st.anims) if (names.has(`anim ${String(a.name ?? "anim")}`)) errors.push(...lintAnim(a, partNames));
  // a part that points at a parent which doesn't exist is almost always a typo: say so
  const have = new Set(st.raw.map(nameOf));
  for (const p of st.raw) if (p.parent && !have.has(String(p.parent))) errors.push(`part "${nameOf(p)}" has parent "${String(p.parent)}" which doesn't exist`);
  for (const p of st.raw) if (p.snap && !st.raw.some((q) => nameOf(q) === String(p.snap) && q.shape === "sculpt")) errors.push(`part "${nameOf(p)}" snaps to "${String(p.snap)}", which is not a sculpt part`);
  // a blob bone that names no part is skinned to the sculpt itself (it will not bend): say which
  for (const p of st.raw) if (p.shape === "sculpt" && names.has(nameOf(p))) {
    const missing = [...new Set([...arr(p.blobs).map((b) => String(obj(b).bone ?? "")), String(p.bone ?? "")].filter((b) => b && !have.has(b)))];
    if (missing.length) errors.push(`part "${nameOf(p)}": blob bone(s) ${missing.map((b) => `"${b}"`).join(", ")} name no part — add {name, shape:"joint", pos:[pivot]} parts for them (mirror:true for left/right), or those blobs will not bend`);
  }
  errors.push(...qualityNotes(st));
  st.version += 1;
  return { touched, errors };
}

async function refDataUrl(cwd: string, src: string): Promise<string> {
  if (src.startsWith("data:image/")) { if (src.length > REF_MAX_BYTES * 1.4) throw new Error("reference image too large"); return src; }
  const abs = await insideReal(cwd, src);
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : /\.jpe?g$/.test(ext) ? "image/jpeg" : "";
  if (!mime) throw new Error("reference must be a png/jpg/webp/gif");
  const buf = await readFile(abs);
  if (buf.length > REF_MAX_BYTES) throw new Error(`reference is ${(buf.length / 1e6).toFixed(1)}MB (max 2MB) — save a smaller copy`);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** The expanded parts WITHOUT any variant applied (what a game loads; variants ride separately). */
function baseParts(st: Studio): Obj[] {
  const out: Obj[] = [];
  for (const raw of st.raw) { if (out.length >= 220) break; out.push(...sanitizeModelPart(raw, st.style, 220 - out.length, st.edge)); }
  return uniqueNames(out);
}

/** The sanitised spec the page renders. */
export function studioSpec(st: Studio): Obj {
  const parts: Obj[] = [];
  for (const raw of st.raw) {
    if (parts.length >= 220) break;
    parts.push(...sanitizeModelPart(raw, st.style, 220 - parts.length, st.edge));
  }
  uniqueNames(parts);
  const showVariant = typeof st.view.variant === "string" ? st.variants[st.view.variant] : undefined;
  const shown = showVariant ? parts.map((p) => applyVariant(p, showVariant)) : parts;
  const anims = st.anims.map(sanitizeAnim).filter((a): a is Obj => !!a);
  const scripts = st.scripts.map(sanitizeScript).filter((x): x is Obj => !!x);
  return { title: st.title, style: st.style, look: st.look, parts: shown, anims, scripts, ...(st.ref ? { ref: st.ref } : {}), ...(st.backdrop ? { backdrop: st.backdrop } : {}), view: st.view };
}

/** GET /__ares/studio/<id>?since=N → { v } or { v, spec } when there is something newer. */
export function studioPoll(id: string, since: number): { v: number; spec?: Obj } | null {
  const st = studios.get(id);
  if (!st) return null;
  if (st.version <= since) return { v: st.version };
  st.seen = Math.max(st.seen, st.version);
  return { v: st.version, spec: studioSpec(st) };
}

export async function saveStudio(st: Studio, cwd: string, target: string | boolean): Promise<string> {
  const rel = typeof target === "string" && target && target !== "true" ? target : `assets/models/${st.id}.model.json`;
  if (!rel.endsWith(".model.json")) throw new Error("save path must end in .model.json (e.g. assets/models/chest.model.json)");
  const abs = await insideReal(cwd, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify({ format: "ares-model/1", title: st.title, style: st.style, look: st.look, edge: st.edge, parts: st.raw, anims: st.anims, scripts: st.scripts, variants: st.variants }, null, 1), "utf8");
  return path.relative(cwd, abs);
}

/** Game integration: write the standalone runtime and the model's runtime-ready (expanded) JSON into the project. */
export async function exportGame(st: Studio, cwd: string, o: { dir?: string; three?: string } = {}): Promise<{ runtime: string; model: string; usage: string }> {
  const three = o.three ?? "three";
  if (!/^(three|https?:\/\/[\w./@:~-]+|\.{0,2}\/[\w./-]+)$/.test(three)) throw new Error(`three must be "three", an https URL or a relative path (got ${three})`);
  const dir = (o.dir && o.dir !== "true" ? o.dir : "assets").replace(/\/+$/, "");
  const runtimeAbs = await insideReal(cwd, `${dir}/ares-model.js`), modelAbs = await insideReal(cwd, `${dir}/models/${st.id}.game.json`);
  await mkdir(path.dirname(modelAbs), { recursive: true });
  const spec = studioSpec(st);
  await writeFile(runtimeAbs, buildRuntimeModule(three), "utf8");
  await writeFile(modelAbs, JSON.stringify({ format: "ares-model/1", expanded: true, title: st.title, style: st.style, look: st.look, parts: baseParts(st), anims: spec.anims, scripts: spec.scripts, variants: st.variants }), "utf8");
  const runtime = path.relative(cwd, runtimeAbs).split(path.sep).join("/"), model = path.relative(cwd, modelAbs).split(path.sep).join("/");
  const nScripts = (studioSpec(st).scripts as unknown[]).length;
  const usage = `${nScripts ? `NOTE: this model has ${nScripts} script(s) (textures, tints, effects): they only run in the game if you call attachScripts(m, a, {scene, camera, renderer}). ` : ""}import { loadModel } from "./${runtime}"; const m = await loadModel("${model}"); const a = m.instance(); scene.add(a.group); a.play(${JSON.stringify((spec.anims as Array<{ name?: string }>)[0]?.name ?? "clip")}); /* each frame: a.update(dt) */ — a.part(name), a.on(event, fn), a.triangles(), instance({variant:"name"}) for a colourway (${Object.keys(st.variants).join(", ") || "none defined"}), instance({material:(part, shared)=>…}) for custom tints; attachScripts(m, a, {scene, camera, renderer}) runs the model's scripts.`;
  return { runtime, model, usage };
}
