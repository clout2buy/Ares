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
import { MODEL_MATS, MODEL_SHAPES, uniqueNames, sanitizeAnim, sanitizeModelPart, sanitizeScript, MODEL_LOOKS, MODEL_STYLES, colour } from "./forgeBlocks.js";

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
  if (!st) { st = { id, title: "", style: "", look: "", edge: "", raw: [], anims: [], scripts: [], logs: [], view: {}, version: 0, seen: 0 }; studios.set(id, st); }
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
function mergeView(cur: Obj, raw: unknown): Obj {
  const o = obj(raw), out: Obj = { ...cur };
  for (const k of VIEW_BOOL) if (typeof o[k] === "boolean") out[k] = o[k];
  if (typeof o.camera === "string" && VIEW_CAMERAS.includes(o.camera)) out.camera = o.camera;
  if (typeof o.anim === "string") out.anim = o.anim.slice(0, 24);
  if (typeof o.speed === "number" && Number.isFinite(o.speed)) out.speed = Math.min(3, Math.max(0.1, o.speed));
  if (typeof o.t === "number" && Number.isFinite(o.t)) out.t = Math.min(20, Math.max(0, o.t));
  if (typeof o.zoom === "number" && Number.isFinite(o.zoom)) out.zoom = Math.min(3, Math.max(0.3, o.zoom));
  if (o.fit === "anim" || o.fit === "rest") out.fit = o.fit;
  return out;
}

// ── lint: input is never silently ignored; unknown fields, shapes and dead clips come back as warnings ──
const PART_KEYS = new Set(["name", "shape", "pos", "size", "rot", "color", "color2", "grad", "mid", "shade", "mat", "smooth", "facets", "mirror", "repeat", "parent", "pivot", "stage", "scenery", "pts", "sections", "verts", "faces", "fcolors", "seg", "detail", "jitter", "depth", "bevel", "r", "r2", "caps", "steps"]);
const vec = (v: unknown): boolean => Array.isArray(v) && v.length >= 1 && v.length <= 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

function lintPart(p: Obj): string[] {
  const n = nameOf(p), w: string[] = [];
  for (const k of Object.keys(p)) if (!PART_KEYS.has(k)) w.push(`part "${n}": unknown field "${k}" was ignored (fields: ${[...PART_KEYS].join(", ")})`);
  if (p.shape !== undefined && !MODEL_SHAPES.includes(String(p.shape))) w.push(`part "${n}": unknown shape "${String(p.shape)}", drawn as a box (shapes: ${MODEL_SHAPES.join(", ")})`);
  if (p.mat !== undefined && !MODEL_MATS.includes(String(p.mat))) w.push(`part "${n}": unknown mat "${String(p.mat)}" (mats: ${MODEL_MATS.join(", ")})`);
  for (const k of ["pos", "rot", "pivot"]) if (p[k] !== undefined && !vec(p[k])) w.push(`part "${n}": ${k} should be [x,y,z] numbers`);
  if (p.size !== undefined && !vec(p.size) && typeof p.size !== "number") w.push(`part "${n}": size should be [x,y,z] or one number`);
  if (p.color !== undefined && !colour(p.color)) w.push(`part "${n}": colour "${String(p.color)}" not recognised (use #rrggbb or a name like orange/gold/white)`);
  return w;
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
  if (p.pos !== undefined) p.pos = add(p.pos); else p.pos = d;
  if (p.pivot !== undefined) p.pivot = add(p.pivot);
  for (const key of ["sections", "verts"]) if (Array.isArray(p[key])) p[key] = (p[key] as unknown[]).map((q) => { const a = arr(q).slice(); for (let k = 0; k < 3; k++) a[k] = Number(a[k] ?? 0) + d[k]!; return a; });
  if (Array.isArray(p.pts)) p.pts = (p.pts as unknown[]).map((q) => { const a = arr(q).slice(); for (let k = 0; k < Math.min(3, a.length); k++) a[k] = Number(a[k] ?? 0) + (k < 3 ? d[k]! : 0); return a; });
}

function scaleBy(p: Obj, f: number): void {
  const mul = (v: unknown): number[] => arr(v).map((n) => Number(n) * f);
  if (p.size !== undefined) p.size = typeof p.size === "number" ? p.size * f : mul(p.size); else if (!["loft", "mesh", "extrude", "lathe", "tube"].includes(String(p.shape))) p.size = [f, f, f];
  if (p.pos !== undefined) p.pos = mul(p.pos);
  if (p.pivot !== undefined) p.pivot = mul(p.pivot);
  for (const key of ["verts"]) if (Array.isArray(p[key])) p[key] = (p[key] as unknown[]).map((q) => mul(q));
  if (Array.isArray(p.sections)) p.sections = (p.sections as unknown[]).map((q) => arr(q).map((n) => Number(n) * f));
  if (Array.isArray(p.pts)) p.pts = (p.pts as unknown[]).map((q) => mul(q));
  for (const k of ["r", "r2", "depth"]) if (typeof p[k] === "number") p[k] = (p[k] as number) * f;
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
  if (e.reset) { st.view = {}; st.raw = []; st.anims = []; st.scripts = []; st.ref = undefined; st.backdrop = undefined; }
  if (e.backdrop !== undefined) { st.backdrop = e.backdrop || undefined; touched.push(e.backdrop ? "backdrop" : "- backdrop"); }
  if (e.load) {
    try {
      const doc = obj(await readJsonFile(cwd, e.load));
      st.raw = arr(doc.parts).map(obj); st.anims = arr(doc.anims).map(obj); st.scripts = arr(doc.scripts).map(obj);
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
      } else if (op === "remove") {
        const sel = String(o.name ?? ""); const before = st.raw.length; st.raw = st.raw.filter((p) => !matches(sel, nameOf(p)));
        if (st.raw.length === before) errors.push(`remove: no part "${sel}"`); else touched.push(`- ${sel}`);
      } else if (op === "add") {
        for (const p of arr(o.parts).slice(0, 120)) { upsert(st.raw, obj(p)); touched.push(nameOf(obj(p))); }
      } else if (op === "use") {
        if (o.parts !== false) for (const p of await importParts(cwd, o)) { upsert(st.raw, p); touched.push(nameOf(p)); }
        // scripts ride along when asked: use:{file, scripts:["water"]} pulls a saved behaviour (a library of Ares's own tricks)
        const want = arr(o.scripts).map(String);
        if (want.length) {
          const doc = obj(await readJsonFile(cwd, String(o.file ?? "")));
          for (const sc of arr(doc.scripts)) { const s2 = sanitizeScript(sc); if (s2 && want.includes(String(s2.name))) { const i = st.scripts.findIndex((x) => x.name === s2.name); if (i >= 0) st.scripts[i] = s2; else st.scripts.push(s2); touched.push(`script ${String(s2.name)}`); } }
        }
      } else if (op === "script") {
        const s2 = sanitizeScript(o); if (!s2) { errors.push("script needs a slug name and non-empty code"); continue; }
        const i = st.scripts.findIndex((x) => x.name === s2.name); if (i >= 0) st.scripts[i] = s2; else st.scripts.push(s2); touched.push(`script ${String(s2.name)}`);
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

/** The sanitised spec the page renders. */
export function studioSpec(st: Studio): Obj {
  const parts: Obj[] = [];
  for (const raw of st.raw) {
    if (parts.length >= 220) break;
    parts.push(...sanitizeModelPart(raw, st.style, 220 - parts.length, st.edge));
  }
  uniqueNames(parts);
  const anims = st.anims.map(sanitizeAnim).filter((a): a is Obj => !!a);
  const scripts = st.scripts.map(sanitizeScript).filter((x): x is Obj => !!x);
  return { title: st.title, style: st.style, look: st.look, parts, anims, scripts, ...(st.ref ? { ref: st.ref } : {}), ...(st.backdrop ? { backdrop: st.backdrop } : {}), view: st.view };
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
  await writeFile(abs, JSON.stringify({ format: "ares-model/1", title: st.title, style: st.style, look: st.look, edge: st.edge, parts: st.raw, anims: st.anims, scripts: st.scripts }, null, 1), "utf8");
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
  await writeFile(modelAbs, JSON.stringify({ format: "ares-model/1", expanded: true, title: st.title, style: st.style, look: st.look, parts: spec.parts, anims: spec.anims, scripts: spec.scripts }), "utf8");
  const runtime = path.relative(cwd, runtimeAbs).split(path.sep).join("/"), model = path.relative(cwd, modelAbs).split(path.sep).join("/");
  const nScripts = (studioSpec(st).scripts as unknown[]).length;
  const usage = `${nScripts ? `NOTE: this model has ${nScripts} script(s) (textures, tints, effects): they only run in the game if you call attachScripts(m, a, {scene, camera, renderer}). ` : ""}import { loadModel } from "./${runtime}"; const m = await loadModel("${model}"); const a = m.instance(); scene.add(a.group); a.play(${JSON.stringify((spec.anims as Array<{ name?: string }>)[0]?.name ?? "clip")}); /* each frame: a.update(dt) */ — a.part(name), a.on(event, fn), a.triangles(), instance({material:(part, shared)=>…}) for tints; attachScripts(m, a, {scene, camera, renderer}) runs the model's scripts.`;
  return { runtime, model, usage };
}
