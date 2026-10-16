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
export const MODEL_SHAPES = ["box", "sphere", "cylinder", "cone", "pyramid", "prism", "torus", "capsule", "poly", "mesh", "loft", "arch", "stairs", "extrude", "lathe", "tube", "sculpt", "joint"];
export const BLOB_KINDS = ["ball", "stick", "box", "chain", "cyl", "torus"];
/** Surface detail the sculpt shader draws per pixel (a blob's `tex`, or the default for its mat). */
export const SCULPT_TEX = ["none", "fur", "scales", "wrinkles", "rock", "wood", "cloth", "hammered", "pores"];
const BLOB_KEYS = new Set(["id", "s", "at", "to", "r", "r2", "pts", "rot", "round", "k", "sub", "paint", "soft", "color", "bone", "mirror", "mat", "tex"]);
const MIRROR_SUFFIX = " (mirror)";
const mirrorBone = (b: string): string => (b.endsWith(MIRROR_SUFFIX) ? b.slice(0, -MIRROR_SUFFIX.length) : `${b}${MIRROR_SUFFIX}`.slice(0, 41));
/** A blob's problems in words (shown back to the author; the blob is still sanitised as well as it can be). */
export function lintBlob(raw: unknown, i: number): string[] {
  const b = obj(raw), w: string[] = [], tag = `blob ${i}${b.bone ? ` (${String(b.bone)})` : ""}`;
  for (const k of Object.keys(b)) if (!BLOB_KEYS.has(k)) w.push(`${tag}: unknown field "${k}" (blob fields: ${[...BLOB_KEYS].join(", ")})`);
  const s = b.s === undefined ? "ball" : String(b.s);
  if (!BLOB_KINDS.includes(s)) w.push(`${tag}: unknown s "${s}" (${BLOB_KINDS.join("|")})`);
  if (s === "stick" && arr(b.to).length < 3) w.push(`${tag}: a stick needs to:[x,y,z] (it runs from at to to, radius r -> r2)`);
  if (s === "cyl" && arr(b.to).length < 3) w.push(`${tag}: a cyl needs to:[x,y,z] (a flat-ended cylinder from at to to, radius r, bevel round)`);
  if (b.mat !== undefined && !MODEL_MATS.includes(String(b.mat))) w.push(`${tag}: unknown mat "${String(b.mat)}" (${MODEL_MATS.join(", ")})`);
  if (b.tex !== undefined && !SCULPT_TEX.includes(String(b.tex))) w.push(`${tag}: unknown tex "${String(b.tex)}" (${SCULPT_TEX.join(", ")})`);
  if (s === "chain" && arr(b.pts).length < 2) w.push(`${tag}: a chain needs pts:[[x,y,z,r],...] (2+ points)`);
  if (s !== "chain" && arr(b.at).length < 3) w.push(`${tag}: at should be [x,y,z]`);
  return w;
}
/** Sculpt blobs: validated, chains expanded into sticks, mirrored copies added (their bone follows the mirrored joint). */
function sanitizeBlobs(v: unknown): Obj[] {
  const out: Obj[] = [];
  const P = (q: unknown, d: [number, number, number] = [0, 0, 0]) => vec3(q, d, -50, 50);
  for (const raw of arr(v).slice(0, 64)) {
    if (out.length >= 96) break;
    const b = obj(raw);
    let s = BLOB_KINDS.includes(String(b.s)) ? String(b.s) : "ball";
    const one: Obj = {};
    const sub = b.sub === true, paint = !sub && b.paint === true;
    if (sub) one.sub = true;
    if (paint) { one.paint = true; one.soft = clamp(b.soft, 0.002, 2, 0.04); }
    const c = colour(b.color); if (c) one.color = c;
    if (b.bone !== undefined && String(b.bone) && !sub && !paint) one.bone = str(b.bone, 41);
    if (!sub && MODEL_MATS.includes(String(b.mat))) one.mat = String(b.mat);
    if (!sub && SCULPT_TEX.includes(String(b.tex))) one.tex = String(b.tex);
    const rDef = 0.2;
    const pieces: Obj[] = [];
    if (s === "chain") {
      const pts = arr(b.pts).slice(0, 16).flatMap((q) => { const a = arr(q); return a.length >= 3 ? [[clamp(a[0], -50, 50, 0), clamp(a[1], -50, 50, 0), clamp(a[2], -50, 50, 0), clamp(a[3], 0.002, 20, rDef)]] : []; });
      if (pts.length < 2) s = "ball";
      else for (let i = 0; i < pts.length - 1; i++) pieces.push({ ...one, s: "stick", at: pts[i]!.slice(0, 3), to: pts[i + 1]!.slice(0, 3), r: pts[i]![3], r2: pts[i + 1]![3] });
    }
    if (s === "stick" || s === "cyl") {
      const to = arr(b.to).length >= 3 ? P(b.to) : null;
      if (!to) s = "ball";
      else {
        const r = clamp(Array.isArray(b.r) ? arr(b.r)[0] : b.r, 0.002, 20, rDef);
        pieces.push(s === "cyl" ? { ...one, s, at: P(b.at), to, r, round: clamp(b.round, 0, r, Math.min(r * 0.15, 0.02)) } : { ...one, s, at: P(b.at), to, r, r2: clamp(b.r2, 0.002, 20, r) });
      }
    }
    if (s === "torus") {
      const R = clamp(Array.isArray(b.r) ? arr(b.r)[0] : b.r, 0.004, 20, rDef);
      const piece: Obj = { ...one, s, at: P(b.at), r: [R, R, R], r2: clamp(b.r2, 0.002, R, R * 0.25) };
      const rot = vec3(b.rot, [0, 0, 0], -360, 360); if (rot.some((n) => n)) piece.rot = rot;
      pieces.push(piece);
    }
    if (s === "ball" || s === "box") {
      const r = vec3(b.r, [rDef, rDef, rDef], 0.002, 20);
      const piece: Obj = { ...one, s, at: P(b.at), r };
      const rot = vec3(b.rot, [0, 0, 0], -360, 360); if (rot.some((n) => n)) piece.rot = rot;
      if (s === "box") piece.round = clamp(b.round, 0, Math.min(...r), Math.min(...r) * 0.25);
      pieces.push(piece);
    }
    // k = how far it melts into what is already there (the "clay" radius); carving and markings default softer/tighter
    const minR = Math.min(...pieces.map((q) => q.s === "torus" ? (q.r2 as number) : Math.min(...(Array.isArray(q.r) ? (q.r as number[]) : [q.r as number, (q.r2 as number) ?? (q.r as number)]))));
    const k = clamp(b.k, 0.001, 2, sub ? 0.03 : Math.max(0.01, Math.min(0.25, minR * 0.5)));
    for (const q of pieces) {
      q.k = k;
      out.push(q);
      if (b.mirror === true && out.length < 96) out.push(mirrorBlobs([q])[0]!);
    }
  }
  return out;
}
function mirrorBlobs(blobs: Obj[]): Obj[] {
  return blobs.map((q) => {
    const m: Obj = { ...q, at: [-(q.at as number[])[0]!, (q.at as number[])[1], (q.at as number[])[2]] };
    if (q.to) m.to = [-(q.to as number[])[0]!, (q.to as number[])[1], (q.to as number[])[2]];
    if (q.rot) m.rot = [(q.rot as number[])[0], -(q.rot as number[])[1]!, -(q.rot as number[])[2]!];
    if (q.bone) m.bone = mirrorBone(String(q.bone));
    return m;
  });
}
export const TEXTURE_KINDS = ["planks", "bricks", "noise", "checker", "stripes", "dots"];
/** A procedural texture description: small, bounded, and part of the model JSON (so it exports to a game with no script). */
export function sanitizeTexture(raw: unknown): Obj | null {
  const t = obj(raw);
  if (!TEXTURE_KINDS.includes(String(t.kind))) return null;
  const colors = arr(t.colors).slice(0, 3).map((c) => colour(c)).filter((c): c is string => !!c);
  const rep = arr(t.repeat);
  return {
    kind: String(t.kind), colors: colors.length ? colors : ["#8a5a2b", "#5a3818"], scale: clamp(t.scale, 0.2, 8, 1),
    repeat: [clamp(rep[0], 0.1, 16, 1), clamp(rep[1], 0.1, 16, 1)], pixel: t.pixel !== false, size: Math.round(clamp(t.size, 16, 128, 64)), seed: Math.round(clamp(t.seed, 0, 999, 1)),
  };
}

/** A variant override: the few fields that change how a part LOOKS (so one model + clips serves many colourways). */
export function sanitizeOverride(raw: unknown): Obj | null {
  const o = obj(raw), out: Obj = {};
  const c = colour(o.color); if (c) out.color = c;
  const c2 = colour(o.color2); if (c2) { out.color2 = c2; out.grad = ["x", "y", "z"].includes(String(o.grad)) ? String(o.grad) : "y"; out.mid = clamp(o.mid, 0.05, 0.95, 0.5); }
  if (MODEL_MATS.includes(String(o.mat))) out.mat = String(o.mat);
  if (typeof o.smooth === "boolean") out.smooth = o.smooth;
  if (o.shade !== undefined) out.shade = clamp(o.shade, 0, 0.5, 0);
  if (o.texture === null) out.texture = null;
  else if (o.texture !== undefined) { const t = sanitizeTexture(o.texture); if (t) out.texture = t; }
  return Object.keys(out).length ? out : null;
}

export const MODEL_STYLES = ["smooth", "lowpoly", "wire", "flat"];
export const MODEL_LOOKS = ["studio", "clay", "slate", "pastel", "gallery", "noir", "holo", "sunset", "night", "flat"];
export const MODEL_MATS = ["matte", "clay", "plastic", "holo", "metal", "glossy", "glass", "glow", "fur", "skin", "leather", "wood", "stone", "cloth"];
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
  const blobs = shape === "sculpt" ? sanitizeBlobs(p.blobs) : [];
  if (shape === "sculpt" && !blobs.some((b) => !b.sub && !b.paint)) shape = "box";
  if (shape === "loft" && sections.length < 2) shape = "box";
  if (shape === "mesh" && (verts.length < 3 || !faces.length)) shape = "box";
  if ((shape === "extrude" && pts.length < 3) || (shape === "lathe" && pts.length < 2) || (shape === "tube" && pts.length < 2)) shape = "box";
  const pos = vec3(p.pos, [0, 0, 0], -50, 50), size = vec3(p.size, [1, 1, 1], 0.02, 50), rot = vec3(p.rot, [0, 0, 0], -360, 360);
  const curved = shape === "lathe" || shape === "tube" || shape === "sculpt";
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
  if (p.fuzz !== undefined) base.fuzz = clamp(p.fuzz, 0, 1, 0.5);
  if (p.snap !== undefined && String(p.snap)) { base.snap = str(p.snap, 32); base.out = clamp(p.out, -2, 2, 0); if (p.align === true) base.align = true; }
  if (p.texture !== undefined) { const tx = sanitizeTexture(p.texture); if (tx) base.texture = tx; }
  if (low) base.low = true;
  if (style === "wire") base.wire = true;
  if (typeof p.facets === "boolean" ? p.facets : low) base.facets = true;
  base.shade = clamp(p.shade, 0, 0.5, low ? 0.1 : 0);
  const c2 = colour(p.color2); if (c2) { base.color2 = c2; base.grad = ["x", "y", "z"].includes(String(p.grad)) ? String(p.grad) : "y"; base.mid = clamp(p.mid, 0.05, 0.95, 0.5); }
  if (shape === "loft") { base.sections = sections; base.seg = Math.round(clamp(p.seg, 3, 24, low ? 6 : 16)); }
  if (shape === "sculpt") {
    base.blobs = blobs;
    if (p.res !== undefined) base.res = Math.round(clamp(p.res, 12, 160, 96));
    if (SCULPT_TEX.includes(String(p.tex))) base.tex = String(p.tex);
    if (p.grain !== undefined) base.grain = clamp(p.grain, 0.2, 5, 1);
    if (p.bone !== undefined && String(p.bone)) base.bone = str(p.bone, 41);
    const nz = obj(p.noise); if (p.noise !== undefined && nz.amp !== undefined) base.noise = { amp: clamp(nz.amp, 0, 0.2, 0.01), scale: clamp(nz.scale, 0.5, 60, 6) };
    if (p.tint !== undefined) base.tint = clamp(p.tint, 0, 0.4, 0.06);
    if (p.ao !== undefined) base.ao = clamp(p.ao, 0, 1, 1);
  }
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
    const offAxis = Math.abs(at[0]) > 1e-3 || [...sections, ...verts, ...pts].some((q) => Math.abs(q[0]) > 1e-3) || blobs.some((b) => Math.abs((b.at as number[])[0]!) > 1e-3);
    if (p.mirror === true && offAxis && out.length < room) {
      const opv = one.pivot as number[];
      const m: Obj = { ...one, name: `${one.name} (mirror)`, pos: [-at[0], at[1], at[2]], pivot: [-opv[0], opv[1], opv[2]], rot: [rot[0], -rot[1], -rot[2]] };
      if (shape === "loft") m.sections = (sections as number[][]).map((q) => [-q[0], ...q.slice(1)]);
      if (shape === "mesh") m.verts = (verts as number[][]).map((q) => [-q[0], q[1], q[2]]);
      if (shape === "extrude" || shape === "tube") m.pts = (pts as number[][]).map((q) => [-q[0], ...q.slice(1)]);
      if (shape === "sculpt") m.blobs = mirrorBlobs(blobs);
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

export const MOTION_KINDS = ["swing", "wag", "bob", "spin", "pulse", "step", "lift"];
export const EASES = ["smooth", "linear", "in", "out", "inout", "back", "elastic", "bounce"];
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
    if (EASES.includes(String(o.ease)) && o.ease !== "smooth") out.ease = String(o.ease);
    const rot = keys(o.rot, -720, 720, 0), pos = keys(o.pos, -50, 50, 0), scale = keys(o.scale, 0.01, 20, 1);
    if (rot.length) out.rot = rot;
    if (pos.length) out.pos = pos;
    if (scale.length) out.scale = scale;
    return rot.length || pos.length || scale.length ? [out] : [];
  });
  const motion = arr(a.motion).slice(0, 40).flatMap((m): Obj[] => {
    const o = obj(m), part = str(o.part, 33), kind = String(o.kind);
    if (!part || !MOTION_KINDS.includes(kind)) return [];
    return [{ part, kind, axis: ["x", "y", "z"].includes(String(o.axis)) ? String(o.axis) : kind === "bob" ? "y" : kind === "wag" ? "y" : "x", amp: clamp(o.amp, -720, 720, kind === "pulse" ? 0.1 : kind === "bob" ? 0.2 : 20), speed: clamp(o.speed, 0.05, 8, 1), phase: clamp(o.phase, -7, 7, 0), mirror: o.mirror !== false, ...(kind === "step" || kind === "lift" ? { duty: clamp(o.duty, 0.3, 0.9, 0.6) } : {}) }];
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

/** Part names are identities (parents, animations, edits): make duplicates unique ("leg", "leg #2"). */
export function uniqueNames(parts: Obj[]): Obj[] {
  const seen = new Map<string, number>();
  for (const p of parts) {
    const n = String(p.name), c = (seen.get(n) ?? 0) + 1;
    seen.set(n, c);
    if (c > 1) p.name = `${n.slice(0, 26)} #${c}`;
  }
  return parts;
}

export function sanitizeModel(b: Obj): Obj {
  const parts: Obj[] = [];
  const style = MODEL_STYLES.includes(String(b.style)) ? String(b.style) : "";
  for (const raw of arr(b.parts).slice(0, 120)) {
    if (parts.length >= 220) break;
    parts.push(...sanitizeModelPart(raw, style, 220 - parts.length, String(b.edge ?? "")));
  }
  const anims = arr(b.anims).slice(0, 12).map(sanitizeAnim).filter((x): x is Obj => !!x);
  return { title: str(b.title, 60), caption: str(b.caption, 240), style, look: MODEL_LOOKS.includes(String(b.look)) ? String(b.look) : "", parts: uniqueNames(parts), anims };
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
