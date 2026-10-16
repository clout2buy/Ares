// Sanitisers for the generative `model` and `story` explain blocks. The model
// writes a compact JSON description; everything is coerced, clamped and
// whitelisted here so the page-side engines (forgeModel / forgeStory) only ever
// see numbers, known sprite names and short strings. Text is never injected as
// markup: the engines draw it with textContent / canvas fillText.

type Obj = Record<string, unknown>;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown, n: number): string => String(v ?? "").slice(0, n);
const clamp = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = typeof v === "number" ? v : v === "" || v == null ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;

const NAMED: Record<string, string> = {
  red: "#c8453a", blue: "#2f6df0", green: "#4a9a3a", gold: "#f0a32f", yellow: "#ffd36a", white: "#f4efe0", black: "#1a1d2a", gray: "#8a8f9c", grey: "#8a8f9c",
  brown: "#7a4a2b", purple: "#8a5ad0", orange: "#ff8a3a", pink: "#f08ab0", skin: "#e8b48a", tan: "#d9b38c", cyan: "#5fd0e8", teal: "#2fa89a", sand: "#d9b36a", stone: "#8a8f9c", navy: "#15347a", silver: "#cfd6e6", cream: "#f4efe0", maroon: "#7a2a30",
};
/** A colour name or #rgb/#rrggbb → #rrggbb, else the default. */
export function colour(v: unknown, d?: string): string | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return d;
}

// ── model: parts that assemble one by one ────────────────────────────────────
export const MODEL_SHAPES = ["box", "sphere", "cylinder", "cone", "pyramid", "prism", "torus", "capsule", "poly", "mesh", "loft", "arch", "stairs", "extrude", "lathe", "tube"];
export const MODEL_STYLES = ["smooth", "lowpoly", "wire", "flat"];
export const MODEL_LOOKS = ["studio", "clay", "slate", "pastel", "gallery", "noir", "holo", "sunset", "night", "flat"];
export const MODEL_MATS = ["matte", "clay", "plastic", "holo", "metal", "glossy", "glass", "glow"];
const vec3 = (v: unknown, d: [number, number, number], lo: number, hi: number): [number, number, number] => {
  if (typeof v === "number") return [clamp(v, lo, hi, d[0]), clamp(v, lo, hi, d[1]), clamp(v, lo, hi, d[2])];
  const a = arr(v);
  return [clamp(a[0], lo, hi, d[0]), clamp(a[1], lo, hi, d[1]), clamp(a[2], lo, hi, d[2])];
};
/** Outline / profile / path points: [x,y] pairs for extrude + lathe, [x,y,z] for tube. */
function points(v: unknown, dims: 2 | 3): number[][] {
  return arr(v).slice(0, 48).flatMap((q) => {
    const a = arr(q);
    if (a.length < dims) return [];
    return [Array.from({ length: dims }, (_, i) => clamp(a[i], -50, 50, 0))];
  });
}

/** One authored part → 1..n sanitised parts (repeat / mirror expand here, so the
 *  streaming path and the one-shot path agree). `room` caps the expansion. */
export function sanitizeModelPart(raw: unknown, style = "", room = 220, edge = ""): Obj[] {
  const out: Obj[] = [];
  const p = obj(raw);
  let shape = MODEL_SHAPES.includes(String(p.shape)) ? String(p.shape) : "box";
  const dims = shape === "tube" ? 3 : 2;
  const pts = shape === "extrude" || shape === "lathe" || shape === "tube" ? points(p.pts, dims as 2 | 3) : [];
  const verts = shape === "mesh" ? arr(p.verts).slice(0, 240).map((q) => { const a = arr(q); return [clamp(a[0], -50, 50, 0), clamp(a[1], -50, 50, 0), clamp(a[2], -50, 50, 0)]; }) : [];
  const faces = shape === "mesh" ? arr(p.faces).slice(0, 400).flatMap((f) => { const a = arr(f).map((v) => Math.round(Number(v))); return a.length >= 3 && a.length <= 6 && a.every((v) => Number.isInteger(v) && v >= 0 && v < verts.length) ? [a] : []; }) : [];
  const sections = shape === "loft" ? arr(p.sections).slice(0, 24).flatMap((q) => { const a = arr(q); return a.length >= 5 ? [[clamp(a[0], -50, 50, 0), clamp(a[1], -50, 50, 0), clamp(a[2], -50, 50, 0), clamp(a[3], 0, 20, 0.2), clamp(a[4], 0, 20, 0.2)]] : []; }) : [];
  if (shape === "loft" && sections.length < 2) shape = "box";
  if (shape === "mesh" && (verts.length < 3 || !faces.length)) shape = "box";
  if ((shape === "extrude" && pts.length < 3) || (shape === "lathe" && pts.length < 2) || (shape === "tube" && pts.length < 2)) shape = "box";
  const pos = vec3(p.pos, [0, 0, 0], -50, 50), size = vec3(p.size, [1, 1, 1], 0.02, 50), rot = vec3(p.rot, [0, 0, 0], -360, 360);
  const curved = shape === "lathe" || shape === "tube";
  const low = style === "lowpoly" || style === "wire";
  const base: Obj = {
    name: str(p.name || shape, 32), shape, pos, size, rot, color: colour(p.color, "#9cc5ff"),
    mat: MODEL_MATS.includes(String(p.mat)) ? String(p.mat) : "matte",
    smooth: typeof p.smooth === "boolean" ? p.smooth : style === "smooth" || (curved && !low),
  };
  const pv = p.pivot !== undefined ? vec3(p.pivot, pos, -50, 50) : pos;
  if (p.parent !== undefined && String(p.parent)) base.parent = str(p.parent, 32);
  base.pivot = pv;
  const ec = colour(edge); if (ec) base.edgeColor = ec;
  if (p.stage !== undefined && String(p.stage)) base.stage = str(p.stage, 16);
  if (p.scenery === true) base.scenery = true;
  if (low) base.low = true;
  if (style === "wire") base.wire = true;
  if (typeof p.facets === "boolean" ? p.facets : low) base.facets = true;
  base.shade = clamp(p.shade, 0, 0.5, low ? 0.1 : 0);
  const c2 = colour(p.color2); if (c2) { base.color2 = c2; base.grad = ["x", "y", "z"].includes(String(p.grad)) ? String(p.grad) : "y"; base.mid = clamp(p.mid, 0.05, 0.95, 0.5); }
  if (shape === "loft") { base.sections = sections; base.seg = Math.round(clamp(p.seg, 3, 24, low ? 6 : 16)); }
  if (shape === "stairs") base.steps = Math.round(clamp(p.steps, 2, 16, 4));
  if (shape === "tube") base.caps = p.caps !== false;
  if (shape === "poly") { base.detail = Math.round(clamp(p.detail, 0, 3, low ? 0 : 1)); base.jitter = clamp(p.jitter, 0, 0.4, low ? 0.06 : 0); }
  if (shape === "mesh") { base.verts = verts; base.faces = faces; const fc = arr(p.fcolors).slice(0, 400).map((v) => colour(v, "")); if (fc.some((v) => v)) base.fcolors = fc; }
  if (pts.length) base.pts = pts;
  if (shape === "extrude") { base.depth = clamp(p.depth, 0.02, 50, 1); base.bevel = clamp(p.bevel, 0, 2, 0.03); }
  if (shape === "tube") { base.r = clamp(p.r, 0.01, 10, 0.1); base.r2 = clamp(p.r2, 0.01, 10, base.r as number); }
  const rep = obj(p.repeat), n = Math.round(clamp(rep.n, 1, 24, 1)), step = vec3(rep.step, [1, 0, 0], -50, 50);
  for (let i = 0; i < n && out.length < room; i++) {
    const at: [number, number, number] = [pos[0] + step[0] * i, pos[1] + step[1] * i, pos[2] + step[2] * i];
    const one = { ...base, name: n > 1 ? `${base.name} ${i + 1}` : base.name, pos: at, pivot: [pv[0] + step[0] * i, pv[1] + step[1] * i, pv[2] + step[2] * i] };
    out.push(one);
    // authored-in-place geometry (loft / mesh / extrude / tube) is off-axis through its points, not pos
    const offAxis = Math.abs(at[0]) > 1e-3 || [...sections, ...verts, ...pts].some((q) => Math.abs(q[0]) > 1e-3);
    if (p.mirror === true && offAxis && out.length < room) {
      const opv = one.pivot as number[];
      const m: Obj = { ...one, name: `${one.name} (mirror)`, pos: [-at[0], at[1], at[2]], pivot: [-opv[0], opv[1], opv[2]], rot: [rot[0], -rot[1], -rot[2]] };
      if (shape === "loft") m.sections = (sections as number[][]).map((q) => [-q[0], ...q.slice(1)]);
      if (shape === "mesh") m.verts = (verts as number[][]).map((q) => [-q[0], q[1], q[2]]);
      if (shape === "extrude" || shape === "tube") m.pts = (pts as number[][]).map((q) => [-q[0], ...q.slice(1)]);
      out.push(m);
    }
  }
  return out;
}

// ── animation: keyframe tracks and procedural motions over named parts ──────
/** A studio script: JS the page runs every frame (init/update/cleanup with an `api`). Ares writes these itself for anything
 *  the engine has no feature for: water, lava, rain, wind, physics, particles. Size-capped; name is a slug. */
export function sanitizeScript(raw: unknown): Obj | null {
  const o = obj(raw), name = String(o.name ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(name) || typeof o.code !== "string" || !o.code.trim()) return null;
  return { name, code: o.code.slice(0, 24_000), enabled: o.enabled !== false };
}

export const MOTION_KINDS = ["swing", "wag", "bob", "spin", "pulse"];
const keys = (v: unknown, lo: number, hi: number, d: number): [number, number[]][] =>
  arr(v).slice(0, 32).flatMap((k) => { const a = arr(k); if (a.length < 2) return []; const val = arr(a[1]); return [[clamp(a[0], 0, 20, 0), [clamp(val[0], lo, hi, d), clamp(val[1], lo, hi, d), clamp(val[2], lo, hi, d)]] as [number, number[]]]; }).sort((x, y) => x[0] - y[0]);

/** One clip: { name, dur, loop?, tracks:[{part, rot?/pos?/scale?:[[t,[x,y,z]]…]}], motion:[{part,kind,axis,amp,speed,phase}] }.
 *  `part` is a part name; a trailing * matches a prefix ("front leg*" also catches the mirror). */
export function sanitizeAnim(raw: unknown): Obj | null {
  const a = obj(raw);
  const tracks = arr(a.tracks).slice(0, 40).flatMap((t): Obj[] => {
    const o = obj(t), part = str(o.part, 33);
    if (!part) return [];
    const out: Obj = { part };
    const rot = keys(o.rot, -720, 720, 0), pos = keys(o.pos, -50, 50, 0), scale = keys(o.scale, 0.01, 20, 1);
    if (rot.length) out.rot = rot;
    if (pos.length) out.pos = pos;
    if (scale.length) out.scale = scale;
    return rot.length || pos.length || scale.length ? [out] : [];
  });
  const motion = arr(a.motion).slice(0, 40).flatMap((m): Obj[] => {
    const o = obj(m), part = str(o.part, 33), kind = String(o.kind);
    if (!part || !MOTION_KINDS.includes(kind)) return [];
    return [{ part, kind, axis: ["x", "y", "z"].includes(String(o.axis)) ? String(o.axis) : kind === "bob" ? "y" : kind === "wag" ? "y" : "x", amp: clamp(o.amp, -720, 720, kind === "pulse" ? 0.1 : kind === "bob" ? 0.2 : 20), speed: clamp(o.speed, 0.05, 8, 1), phase: clamp(o.phase, -7, 7, 0), mirror: o.mirror !== false }];
  });
  // named moments inside a clip: a script (see sanitizeScript) listens with api.on(name, fn) — a hoof lands, a muzzle touches water
  const events = arr(a.events).slice(0, 24).flatMap((e): Obj[] => {
    const o = obj(e), name = str(o.name, 24);
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(name)) return [];
    let data: unknown = null;
    try { const j = JSON.stringify(o.data ?? null); if (j.length <= 600) data = JSON.parse(j); } catch { data = null; }
    return [{ t: clamp(o.t, 0, 20, 0), name, data }];
  });
  if (!tracks.length && !motion.length && !events.length) return null;
  return { name: str(a.name || "anim", 24), dur: clamp(a.dur, 0.2, 20, 1), loop: a.loop !== false, tracks, motion, events };
}

export function sanitizeModel(b: Obj): Obj {
  const parts: Obj[] = [];
  const style = MODEL_STYLES.includes(String(b.style)) ? String(b.style) : "";
  for (const raw of arr(b.parts).slice(0, 120)) {
    if (parts.length >= 220) break;
    parts.push(...sanitizeModelPart(raw, style, 220 - parts.length, String(b.edge ?? "")));
  }
  const anims = arr(b.anims).slice(0, 12).map(sanitizeAnim).filter((x): x is Obj => !!x);
  return { title: str(b.title, 60), caption: str(b.caption, 240), style, look: MODEL_LOOKS.includes(String(b.look)) ? String(b.look) : "", parts, anims };
}

// ── story: an animated 2D pixel stage driven by scenes of short actions ─────
export const STORY_SPRITES = ["person", "soldier", "house", "temple", "column", "tower", "wall", "castle", "tree", "ship", "horse", "flag", "mountain", "sun", "moon", "cloud", "coin", "fire", "arrow", "pyramid", "scroll", "crown", "sword", "label"];
export const STORY_BGS = ["day", "dawn", "dusk", "night", "desert", "sea", "storm", "snow"];
const STORY_OPS = ["spawn", "move", "fall", "fade", "tint", "meter", "clear"];

/** One authored scene → a sanitised scene, or null when it carries nothing. */
export function sanitizeScene(raw: unknown): Obj | null {
  const s = obj(raw);
  const ops = arr(s.do).slice(0, 16).flatMap((r): Obj[] => {
    const o = obj(r), op = String(o.op);
    if (!STORY_OPS.includes(op)) return [];
    const out: Obj = { op };
    if (o.id !== undefined) { if (!ID_RE.test(String(o.id))) return []; out.id = String(o.id); }
    const pair = (v: unknown, lo: number, hi: number): [number, number] | undefined => { const a = arr(v); return a.length >= 2 ? [clamp(a[0], lo, hi, 80), clamp(a[1], lo, hi, 74)] : undefined; };
    if (op === "spawn") {
      if (!STORY_SPRITES.includes(String(o.sprite))) return [];
      out.sprite = String(o.sprite);
      out.n = Math.round(clamp(o.n, 1, 60, 1));
      const at = pair(o.at, -20, 180), sp = pair(o.spread, 0, 160);
      if (at) out.at = at;
      if (sp) out.spread = sp;
      out.scale = Math.round(clamp(o.scale, 1, 4, 1));
      if (o.flip === true) out.flip = true;
      if (o.text !== undefined) out.text = str(o.text, 40);
      const c = colour(o.color); if (c) out.color = c;
    }
    if (op === "move") { const to = pair(o.to, -20, 180); if (!to) return []; out.to = to; out.dur = clamp(o.dur, 0.3, 6, 1.8); }
    if (op === "tint") { const c = colour(o.color); if (!c) return []; out.color = c; }
    if (op === "meter") { out.label = str(o.label ?? o.id, 20); out.value = clamp(o.value, 0, 100, 50); out.color = colour(o.color, "#f0a32f"); if (!out.id) return []; }
    if ((op === "move" || op === "fall" || op === "fade" || op === "tint") && !out.id) return [];
    return [out];
  });
  const scene = { t: str(s.t, 24), say: str(s.say, 220), bg: STORY_BGS.includes(String(s.bg)) ? String(s.bg) : undefined, do: ops };
  return scene.say || scene.t || scene.do.length ? scene : null;
}

export function sanitizeStory(b: Obj): Obj {
  const scenes = arr(b.scenes).slice(0, 24).map(sanitizeScene).filter((s): s is Obj => !!s);
  return { title: str(b.title, 60), scenes };
}
