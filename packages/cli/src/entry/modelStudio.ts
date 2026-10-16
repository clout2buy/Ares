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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { sanitizeAnim, sanitizeModelPart, sanitizeScript, MODEL_LOOKS, MODEL_STYLES, colour } from "./forgeBlocks.js";

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
  if (!st) { st = { id, title: "", style: "", look: "", edge: "", raw: [], anims: [], scripts: [], logs: [], version: 0, seen: 0 }; studios.set(id, st); }
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
  ref?: string; load?: string; backdrop?: string;
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
  const file = inside(cwd, String(o.file ?? ""));
  const doc = obj(JSON.parse(await readFile(file, "utf8")));
  const names = arr(o.names).map(String);
  const at = arr(o.at).map(Number), f = Number(o.scale) || 1;
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
  if (e.reset) { st.raw = []; st.anims = []; st.scripts = []; st.ref = undefined; st.backdrop = undefined; }
  if (e.backdrop !== undefined) { st.backdrop = e.backdrop || undefined; touched.push(e.backdrop ? "backdrop" : "- backdrop"); }
  if (e.load) {
    try {
      const doc = obj(JSON.parse(await readFile(inside(cwd, e.load), "utf8")));
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
        for (const p of arr(o.parts)) { upsert(st.raw, obj(p)); touched.push(nameOf(obj(p))); }
      } else if (op === "use") {
        if (o.parts !== false) for (const p of await importParts(cwd, o)) { upsert(st.raw, p); touched.push(nameOf(p)); }
        // scripts ride along when asked: use:{file, scripts:["water"]} pulls a saved behaviour (a library of Ares's own tricks)
        const want = arr(o.scripts).map(String);
        if (want.length) {
          const doc = obj(JSON.parse(await readFile(inside(cwd, String(o.file ?? "")), "utf8")));
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
  // a part that points at a parent which doesn't exist is almost always a typo: say so
  const have = new Set(st.raw.map(nameOf));
  for (const p of st.raw) if (p.parent && !have.has(String(p.parent))) errors.push(`part "${nameOf(p)}" has parent "${String(p.parent)}" which doesn't exist`);
  st.version += 1;
  return { touched, errors };
}

async function refDataUrl(cwd: string, src: string): Promise<string> {
  if (src.startsWith("data:image/")) { if (src.length > REF_MAX_BYTES * 1.4) throw new Error("reference image too large"); return src; }
  const abs = path.isAbsolute(src) ? src : inside(cwd, src);
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
  const anims = st.anims.map(sanitizeAnim).filter((a): a is Obj => !!a);
  const scripts = st.scripts.map(sanitizeScript).filter((x): x is Obj => !!x);
  return { title: st.title, style: st.style, look: st.look, parts, anims, scripts, ...(st.ref ? { ref: st.ref } : {}), ...(st.backdrop ? { backdrop: st.backdrop } : {}) };
}

/** GET /__ares/studio/<id>?since=N → { v } or { v, spec } when there is something newer. */
export function studioPoll(id: string, since: number): { v: number; spec?: Obj } | null {
  const st = studios.get(id);
  if (!st) return null;
  if (st.version <= since) return { v: st.version };
  st.seen = Math.max(st.seen, st.version);
  return { v: st.version, spec: studioSpec(st) };
}

export async function saveStudio(st: Studio, cwd: string, target: string): Promise<string> {
  const rel = target && target !== "true" ? target : `assets/models/${st.id}.model.json`;
  if (!rel.endsWith(".json")) throw new Error("save path must end in .json");
  const abs = inside(cwd, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify({ format: "ares-model/1", title: st.title, style: st.style, look: st.look, edge: st.edge, parts: st.raw, anims: st.anims, scripts: st.scripts }, null, 1), "utf8");
  return path.relative(cwd, abs);
}
