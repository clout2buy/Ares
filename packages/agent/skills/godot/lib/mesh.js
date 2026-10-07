// Procedural geometry → Wavefront OBJ. Godot 4 imports .obj natively (as a
// mesh resource, or as a scene when dropped in). Y is up, -Z is forward,
// units are metres — Godot's conventions. Every generator returns a Mesh
// (flat list of triangles with per-vertex position/normal/uv) so OBJ export
// is uniform and face normals are explicit (no reliance on importer smoothing).
//
// Kinds: box, plane, cylinder, cone, sphere, capsule, torus, terrain, lathe,
// extrude, stairs, ramp, arch, wedge, pipe.

const TAU = Math.PI * 2;

class Mesh {
  constructor() {
    this.tris = [];
  }
  tri(a, b, c, n, uva, uvb, uvc) {
    if (!n) n = faceNormal(a, b, c);
    this.tris.push([
      { p: a, n, uv: uva ?? [0, 0] },
      { p: b, n, uv: uvb ?? [1, 0] },
      { p: c, n, uv: uvc ?? [1, 1] },
    ]);
  }
  quad(a, b, c, d, n, uvs) {
    const [ua, ub, uc, ud] = uvs ?? [[0, 0], [1, 0], [1, 1], [0, 1]];
    const fn = n ?? faceNormal(a, b, c);
    this.tri(a, b, c, fn, ua, ub, uc);
    this.tri(a, c, d, fn, ua, uc, ud);
  }
  /** Smooth-shaded triangle with per-vertex normals. */
  triSmooth(va, vb, vc) {
    this.tris.push([va, vb, vc]);
  }
  append(other, offset = [0, 0, 0]) {
    for (const t of other.tris) {
      this.tris.push(t.map((v) => ({ p: add(v.p, offset), n: v.n, uv: v.uv })));
    }
  }
  get triangleCount() {
    return this.tris.length;
  }
  bounds() {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const t of this.tris) for (const v of t) for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], v.p[i]);
      max[i] = Math.max(max[i], v.p[i]);
    }
    return { min, max, size: max.map((m, i) => m - min[i]) };
  }
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function faceNormal(a, b, c) {
  return norm(cross(sub(b, a), sub(c, a)));
}

// ---- primitives ------------------------------------------------------------

export function box({ w = 1, h = 1, d = 1, centered = true } = {}) {
  const m = new Mesh();
  const x0 = centered ? -w / 2 : 0, x1 = centered ? w / 2 : w;
  const y0 = centered ? -h / 2 : 0, y1 = centered ? h / 2 : h;
  const z0 = centered ? -d / 2 : 0, z1 = centered ? d / 2 : d;
  const P = (x, y, z) => [x, y, z];
  // +Y top, -Y bottom, +Z front (Godot -Z forward, but we keep right-handed CCW outward)
  m.quad(P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0), [0, 1, 0]);
  m.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), [0, -1, 0]);
  m.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), [0, 0, 1]);
  m.quad(P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), [0, 0, -1]);
  m.quad(P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), [1, 0, 0]);
  m.quad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), [-1, 0, 0]);
  return m;
}

export function plane({ w = 10, d = 10, subdiv = 1, y = 0, uvScale = 1 } = {}) {
  const m = new Mesh();
  const n = Math.max(1, Math.floor(subdiv));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x0 = -w / 2 + (w * i) / n, x1 = -w / 2 + (w * (i + 1)) / n;
    const z0 = -d / 2 + (d * j) / n, z1 = -d / 2 + (d * (j + 1)) / n;
    const u0 = (i / n) * uvScale, u1 = ((i + 1) / n) * uvScale;
    const v0 = (j / n) * uvScale, v1 = ((j + 1) / n) * uvScale;
    m.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0], [[u0, v1], [u1, v1], [u1, v0], [u0, v0]]);
  }
  return m;
}

export function cylinder({ r = 0.5, rTop, h = 1, segments = 24, capped = true, smooth = true } = {}) {
  const m = new Mesh();
  const rt = rTop ?? r;
  const seg = Math.max(3, Math.floor(segments));
  const y0 = -h / 2, y1 = h / 2;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
    const b0 = [Math.cos(a0) * r, y0, Math.sin(a0) * r];
    const b1 = [Math.cos(a1) * r, y0, Math.sin(a1) * r];
    const t0 = [Math.cos(a0) * rt, y1, Math.sin(a0) * rt];
    const t1 = [Math.cos(a1) * rt, y1, Math.sin(a1) * rt];
    const u0 = i / seg, u1 = (i + 1) / seg;
    if (smooth) {
      const slope = (r - rt) / h;
      const n0 = norm([Math.cos(a0), slope, Math.sin(a0)]);
      const n1 = norm([Math.cos(a1), slope, Math.sin(a1)]);
      m.triSmooth({ p: b1, n: n1, uv: [u1, 1] }, { p: b0, n: n0, uv: [u0, 1] }, { p: t0, n: n0, uv: [u0, 0] });
      m.triSmooth({ p: b1, n: n1, uv: [u1, 1] }, { p: t0, n: n0, uv: [u0, 0] }, { p: t1, n: n1, uv: [u1, 0] });
    } else {
      m.quad(b1, b0, t0, t1, undefined, [[u1, 1], [u0, 1], [u0, 0], [u1, 0]]);
    }
    if (capped) {
      if (rt > 0) m.tri([0, y1, 0], t0, t1, [0, 1, 0], [0.5, 0.5], [0.5 + Math.cos(a0) / 2, 0.5 + Math.sin(a0) / 2], [0.5 + Math.cos(a1) / 2, 0.5 + Math.sin(a1) / 2]);
      if (r > 0) m.tri([0, y0, 0], b1, b0, [0, -1, 0], [0.5, 0.5], [0.5 + Math.cos(a1) / 2, 0.5 + Math.sin(a1) / 2], [0.5 + Math.cos(a0) / 2, 0.5 + Math.sin(a0) / 2]);
    }
  }
  return m;
}

export function cone(opts = {}) {
  return cylinder({ ...opts, rTop: 0 });
}

export function sphere({ r = 0.5, rings = 12, segments = 24 } = {}) {
  const m = new Mesh();
  const R = Math.max(2, Math.floor(rings)), S = Math.max(3, Math.floor(segments));
  const v = (i, j) => {
    const phi = (i / R) * Math.PI, theta = (j / S) * TAU;
    const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
    return { p: n.map((c) => c * r), n, uv: [j / S, i / R] };
  };
  for (let i = 0; i < R; i++) for (let j = 0; j < S; j++) {
    const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1);
    if (i !== 0) m.triSmooth(a, c, b);
    if (i !== R - 1) m.triSmooth(a, d, c);
  }
  return m;
}

export function capsule({ r = 0.5, h = 2, rings = 8, segments = 24 } = {}) {
  // h is total height (Godot CapsuleShape3D convention); cylinder part = h - 2r
  const m = new Mesh();
  const R = Math.max(2, Math.floor(rings)), S = Math.max(3, Math.floor(segments));
  const cyl = Math.max(0, h - 2 * r);
  const v = (i, j, top) => {
    const phi = (i / R) * (Math.PI / 2);
    const theta = (j / S) * TAU;
    const n = top
      ? [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)]
      : [Math.sin(phi) * Math.cos(theta), -Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
    const off = top ? cyl / 2 : -cyl / 2;
    return { p: [n[0] * r, n[1] * r + off, n[2] * r], n, uv: [j / S, top ? i / (2 * R) : 1 - i / (2 * R)] };
  };
  for (let i = 0; i < R; i++) for (let j = 0; j < S; j++) {
    const a = v(i, j, true), b = v(i + 1, j, true), c = v(i + 1, j + 1, true), d = v(i, j + 1, true);
    if (i !== 0) m.triSmooth(a, c, b);
    m.triSmooth(a, d, c);
    const a2 = v(i, j, false), b2 = v(i + 1, j, false), c2 = v(i + 1, j + 1, false), d2 = v(i, j + 1, false);
    if (i !== 0) m.triSmooth(a2, b2, c2);
    m.triSmooth(a2, c2, d2);
  }
  if (cyl > 0) {
    for (let j = 0; j < S; j++) {
      const t0 = (j / S) * TAU, t1 = ((j + 1) / S) * TAU;
      const n0 = [Math.cos(t0), 0, Math.sin(t0)], n1 = [Math.cos(t1), 0, Math.sin(t1)];
      const top0 = { p: [n0[0] * r, cyl / 2, n0[2] * r], n: n0, uv: [j / S, 0.25] };
      const top1 = { p: [n1[0] * r, cyl / 2, n1[2] * r], n: n1, uv: [(j + 1) / S, 0.25] };
      const bot0 = { p: [n0[0] * r, -cyl / 2, n0[2] * r], n: n0, uv: [j / S, 0.75] };
      const bot1 = { p: [n1[0] * r, -cyl / 2, n1[2] * r], n: n1, uv: [(j + 1) / S, 0.75] };
      m.triSmooth(bot1, bot0, top0);
      m.triSmooth(bot1, top0, top1);
    }
  }
  return m;
}

export function torus({ R = 1, r = 0.25, segments = 32, rings = 16 } = {}) {
  const m = new Mesh();
  const S = Math.max(3, Math.floor(segments)), T = Math.max(3, Math.floor(rings));
  const v = (i, j) => {
    const u = (i / S) * TAU, w = (j / T) * TAU;
    const c = [Math.cos(u) * R, 0, Math.sin(u) * R];
    const n = [Math.cos(u) * Math.cos(w), Math.sin(w), Math.sin(u) * Math.cos(w)];
    return { p: add(c, n.map((x) => x * r)), n, uv: [i / S, j / T] };
  };
  for (let i = 0; i < S; i++) for (let j = 0; j < T; j++) {
    const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1);
    m.triSmooth(a, b, c);
    m.triSmooth(a, c, d);
  }
  return m;
}

// ---- terrain ---------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise2D(seed) {
  const rand = mulberry32(seed);
  const size = 256;
  const table = new Float32Array(size * size);
  for (let i = 0; i < table.length; i++) table[i] = rand();
  const at = (x, y) => table[((y & 255) * size) + (x & 255)];
  const fade = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  };
}

export function heightField({ w = 64, d = 64, subdiv = 64, height = 8, seed = 1, octaves = 5, persistence = 0.5, lacunarity = 2, scale = 0.08, flatten = 0, island = false } = {}) {
  const noise = valueNoise2D(seed);
  const n = Math.max(1, Math.floor(subdiv));
  const heights = [];
  let min = Infinity, max = -Infinity;
  for (let j = 0; j <= n; j++) {
    const row = [];
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * w, z = (j / n) * d;
      let amp = 1, freq = scale, sum = 0, total = 0;
      for (let o = 0; o < octaves; o++) {
        sum += (noise(x * freq + 1000, z * freq + 1000) * 2 - 1) * amp;
        total += amp;
        amp *= persistence;
        freq *= lacunarity;
      }
      let hgt = sum / total;
      if (flatten > 0) hgt = Math.sign(hgt) * Math.pow(Math.abs(hgt), 1 + flatten);
      if (island) {
        const dx = i / n - 0.5, dz = j / n - 0.5;
        const dist = Math.min(1, Math.hypot(dx, dz) * 2);
        hgt = hgt * (1 - dist * dist) - dist * dist * 0.8;
      }
      hgt *= height;
      row.push(hgt);
      min = Math.min(min, hgt);
      max = Math.max(max, hgt);
    }
    heights.push(row);
  }
  return { heights, n, w, d, min, max };
}

export function terrain(opts = {}) {
  const { heights, n, w, d } = heightField(opts);
  const m = new Mesh();
  const uvScale = opts.uvScale ?? 1;
  const P = (i, j) => [-w / 2 + (i / n) * w, heights[j][i], -d / 2 + (j / n) * d];
  const N = (i, j) => {
    const l = heights[j][Math.max(0, i - 1)], r = heights[j][Math.min(n, i + 1)];
    const u = heights[Math.max(0, j - 1)][i], dn = heights[Math.min(n, j + 1)][i];
    const sx = w / n, sz = d / n;
    return norm([(l - r) / (2 * sx), 1, (u - dn) / (2 * sz)]);
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = { p: P(i, j), n: N(i, j), uv: [(i / n) * uvScale, (j / n) * uvScale] };
    const b = { p: P(i + 1, j), n: N(i + 1, j), uv: [((i + 1) / n) * uvScale, (j / n) * uvScale] };
    const c = { p: P(i + 1, j + 1), n: N(i + 1, j + 1), uv: [((i + 1) / n) * uvScale, ((j + 1) / n) * uvScale] };
    const dd = { p: P(i, j + 1), n: N(i, j + 1), uv: [(i / n) * uvScale, ((j + 1) / n) * uvScale] };
    // alternate the diagonal to avoid directional artifacts
    if ((i + j) % 2 === 0) {
      m.triSmooth(a, c, b);
      m.triSmooth(a, dd, c);
    } else {
      m.triSmooth(a, dd, b);
      m.triSmooth(b, dd, c);
    }
  }
  return m;
}

// ---- lathe / extrude -------------------------------------------------------

/** Revolve a 2D profile ([[radius, y], ...]) around the Y axis. */
export function lathe({ profile, segments = 24, closeTop = true, closeBottom = true } = {}) {
  if (!Array.isArray(profile) || profile.length < 2) throw new Error("lathe needs profile: [[r, y], ...] with ≥ 2 points");
  const m = new Mesh();
  const S = Math.max(3, Math.floor(segments));
  const ring = (k, j) => {
    const [r, y] = profile[k];
    const a = (j / S) * TAU;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  };
  for (let k = 0; k < profile.length - 1; k++) {
    for (let j = 0; j < S; j++) {
      const a = ring(k, j), b = ring(k, j + 1), c = ring(k + 1, j + 1), d = ring(k + 1, j);
      const u0 = j / S, u1 = (j + 1) / S, v0 = k / (profile.length - 1), v1 = (k + 1) / (profile.length - 1);
      const n = faceNormal(a, b, c);
      if (!n.some(Number.isNaN)) m.quad(a, d, c, b, undefined, [[u0, v0], [u0, v1], [u1, v1], [u1, v0]]);
    }
  }
  const capRing = (k, up) => {
    const [r, y] = profile[k];
    if (r <= 1e-6) return;
    for (let j = 0; j < S; j++) {
      const a = ring(k, j), b = ring(k, j + 1);
      if (up) m.tri([0, y, 0], a, b, [0, 1, 0]);
      else m.tri([0, y, 0], b, a, [0, -1, 0]);
    }
  };
  if (closeTop) capRing(profile.length - 1, profile[profile.length - 1][1] >= profile[0][1]);
  if (closeBottom) capRing(0, profile[0][1] > profile[profile.length - 1][1]);
  return m;
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function pointInTri(p, a, b, c) {
  const s = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Ear-clipping triangulation of a simple polygon ([[x, z], ...]). Returns index triples (CCW). */
export function triangulate(poly) {
  const pts = poly.slice();
  const idx = pts.map((_, i) => i);
  if (signedArea(pts) < 0) idx.reverse();
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10_000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      const crossZ = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (crossZ <= 0) continue;
      let ear = true;
      for (const k of idx) {
        if (k === ia || k === ib || k === ic) continue;
        if (pointInTri(pts[k], a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/** Extrude a polygon in the XZ plane up the Y axis. */
export function extrude({ polygon, height = 1, y = 0 } = {}) {
  if (!Array.isArray(polygon) || polygon.length < 3) throw new Error("extrude needs polygon: [[x, z], ...] with ≥ 3 points");
  const m = new Mesh();
  const pts = signedArea(polygon) < 0 ? polygon.slice().reverse() : polygon.slice();
  const tris = triangulate(pts);
  const top = (p) => [p[0], y + height, p[1]];
  const bot = (p) => [p[0], y, p[1]];
  for (const [a, b, c] of tris) {
    // signedArea > 0 means CCW in x→z plane; viewed from +Y that is CW, so flip for outward top normal
    m.tri(top(pts[a]), top(pts[c]), top(pts[b]), [0, 1, 0], [pts[a][0], pts[a][1]], [pts[c][0], pts[c][1]], [pts[b][0], pts[b][1]]);
    m.tri(bot(pts[a]), bot(pts[b]), bot(pts[c]), [0, -1, 0]);
  }
  let u = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    m.quad(bot(p0), top(p0), top(p1), bot(p1), undefined, [[u, 1], [u, 0], [u + len, 0], [u + len, 1]]);
    u += len;
  }
  return m;
}

// ---- level-building pieces -----------------------------------------------

export function stairs({ steps = 8, w = 2, h = 2, d = 3 } = {}) {
  const m = new Mesh();
  const n = Math.max(1, Math.floor(steps));
  const sh = h / n, sd = d / n;
  for (let i = 0; i < n; i++) {
    const step = box({ w, h: sh * (i + 1), d: sd, centered: false });
    m.append(step, [-w / 2, 0, -d / 2 + i * sd]);
  }
  return m;
}

export function ramp({ w = 2, h = 1, d = 4 } = {}) {
  return wedge({ w, h, d });
}

export function wedge({ w = 1, h = 1, d = 1 } = {}) {
  const m = new Mesh();
  const x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
  // low edge at z0, high edge at z1
  m.quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], [0, -1, 0]);
  m.quad([x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1], [0, 0, 1]);
  m.quad([x0, 0, z0], [x0, h, z1], [x1, h, z1], [x1, 0, z0]);
  m.tri([x1, 0, z0], [x1, h, z1], [x1, 0, z1], [1, 0, 0]);
  m.tri([x0, 0, z0], [x0, 0, z1], [x0, h, z1], [-1, 0, 0]);
  return m;
}

export function arch({ w = 4, h = 3, d = 1, thickness = 0.5, segments = 12, legs = 1 } = {}) {
  const m = new Mesh();
  const S = Math.max(2, Math.floor(segments));
  const rOut = w / 2, rIn = Math.max(0.01, rOut - thickness);
  const baseY = legs;
  const z0 = -d / 2, z1 = d / 2;
  const scaleY = (h - legs) / rOut;
  const o = (a) => [Math.cos(a) * rOut, baseY + Math.sin(a) * rOut * scaleY];
  const i = (a) => [Math.cos(a) * rIn, baseY + Math.sin(a) * rIn * scaleY];
  for (let k = 0; k < S; k++) {
    const a0 = (k / S) * Math.PI, a1 = ((k + 1) / S) * Math.PI;
    const [ox0, oy0] = o(a0), [ox1, oy1] = o(a1), [ix0, iy0] = i(a0), [ix1, iy1] = i(a1);
    m.quad([ox0, oy0, z1], [ox1, oy1, z1], [ix1, iy1, z1], [ix0, iy0, z1], [0, 0, 1]);
    m.quad([ix0, iy0, z0], [ix1, iy1, z0], [ox1, oy1, z0], [ox0, oy0, z0], [0, 0, -1]);
    m.quad([ox1, oy1, z0], [ox1, oy1, z1], [ox0, oy0, z1], [ox0, oy0, z0]);
    m.quad([ix0, iy0, z0], [ix0, iy0, z1], [ix1, iy1, z1], [ix1, iy1, z0]);
  }
  if (legs > 0) {
    for (const sx of [-1, 1]) {
      const leg = box({ w: thickness, h: legs, d, centered: false });
      m.append(leg, [sx > 0 ? rIn : -rOut, 0, z0]);
    }
  }
  return m;
}

export function pipe({ r = 0.5, thickness = 0.1, h = 2, segments = 24 } = {}) {
  const m = new Mesh();
  const outer = cylinder({ r, h, segments, capped: false });
  const inner = cylinder({ r: Math.max(0.01, r - thickness), h, segments, capped: false });
  m.append(outer);
  for (const t of inner.tris) m.tris.push([t[0], t[2], t[1]].map((v) => ({ p: v.p, n: v.n.map((c) => -c), uv: v.uv })));
  const ri = Math.max(0.01, r - thickness);
  const S = Math.max(3, Math.floor(segments));
  for (let j = 0; j < S; j++) {
    const a0 = (j / S) * TAU, a1 = ((j + 1) / S) * TAU;
    for (const [y, nrm] of [[h / 2, [0, 1, 0]], [-h / 2, [0, -1, 0]]]) {
      const o0 = [Math.cos(a0) * r, y, Math.sin(a0) * r], o1 = [Math.cos(a1) * r, y, Math.sin(a1) * r];
      const i0 = [Math.cos(a0) * ri, y, Math.sin(a0) * ri], i1 = [Math.cos(a1) * ri, y, Math.sin(a1) * ri];
      if (y > 0) m.quad(i0, i1, o1, o0, nrm);
      else m.quad(o0, o1, i1, i0, nrm);
    }
  }
  return m;
}

export const GENERATORS = { box, plane, cylinder, cone, sphere, capsule, torus, terrain, lathe, extrude, stairs, ramp, wedge, arch, pipe };

export function generate(kind, params = {}) {
  const fn = GENERATORS[kind];
  if (!fn) throw new Error(`unknown mesh kind '${kind}'. Known: ${Object.keys(GENERATORS).join(", ")}`);
  return fn(params);
}

// ---- transforms & export ---------------------------------------------------

export function transformMesh(mesh, { scale, translate, rotateY } = {}) {
  const s = scale == null ? [1, 1, 1] : Array.isArray(scale) ? scale : [scale, scale, scale];
  const t = translate ?? [0, 0, 0];
  const ry = rotateY ? (rotateY * Math.PI) / 180 : 0;
  const cos = Math.cos(ry), sin = Math.sin(ry);
  const rot = (v) => (ry ? [v[0] * cos + v[2] * sin, v[1], -v[0] * sin + v[2] * cos] : v);
  const out = new Mesh();
  for (const tri of mesh.tris) {
    out.tris.push(tri.map((v) => ({ p: add(rot([v.p[0] * s[0], v.p[1] * s[1], v.p[2] * s[2]]), t), n: norm(rot(v.n)), uv: v.uv })));
  }
  return out;
}

function f(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(5).replace(/\.?0+$/, "");
}

/** Export a mesh as OBJ text. Object name suffixes drive Godot's import:
 * `-col` (trimesh static body), `-convcol` (convex), `-colonly`, `-rigid`, `-navmesh`. */
export function toObj(mesh, { name = "mesh", mtl, material } = {}) {
  const lines = [`# generated by Ares godot provider — ${mesh.triangleCount} triangles`];
  if (mtl) lines.push(`mtllib ${mtl}`);
  lines.push(`o ${name}`);
  const vIndex = new Map(), vtIndex = new Map(), vnIndex = new Map();
  const v = [], vt = [], vn = [];
  const key = (arr) => arr.map(f).join(" ");
  const intern = (map, list, arr) => {
    const k = key(arr);
    let i = map.get(k);
    if (!i) {
      list.push(k);
      i = list.length;
      map.set(k, i);
    }
    return i;
  };
  const faces = [];
  for (const tri of mesh.tris) {
    const parts = tri.map((vert) => `${intern(vIndex, v, vert.p)}/${intern(vtIndex, vt, vert.uv)}/${intern(vnIndex, vn, vert.n)}`);
    faces.push(`f ${parts.join(" ")}`);
  }
  for (const line of v) lines.push(`v ${line}`);
  for (const line of vt) lines.push(`vt ${line}`);
  for (const line of vn) lines.push(`vn ${line}`);
  if (material) lines.push(`usemtl ${material}`);
  lines.push("s off");
  lines.push(...faces);
  return lines.join("\n") + "\n";
}

export function toMtl(name, { color = [0.8, 0.8, 0.8], roughness = 0.8, metallic = 0, emission } = {}) {
  const lines = [`newmtl ${name}`, `Kd ${color.map(f).join(" ")}`, `Ka 0 0 0`, `Ks ${metallic} ${metallic} ${metallic}`, `Ns ${Math.round((1 - roughness) * 1000)}`, `d 1`, `illum 2`];
  if (emission) lines.push(`Ke ${emission.map(f).join(" ")}`);
  return lines.join("\n") + "\n";
}

/** A @tool GDScript that builds a FastNoiseLite terrain at edit time with exported knobs. */
export function terrainGdscript({ w = 64, d = 64, subdiv = 64, height = 8, seed = 1, frequency = 0.05 } = {}) {
  return `@tool
extends MeshInstance3D
## Procedural terrain (generated by Ares). Tweak the exports in the inspector;
## the mesh and collision rebuild live. Add a StaticBody3D child for collision
## or keep generate_collision on.

@export var size := Vector2(${f(w)}, ${f(d)}):
	set(v):
		size = v
		_rebuild()
@export_range(2, 512) var subdivisions := ${Math.floor(subdiv)}:
	set(v):
		subdivisions = v
		_rebuild()
@export var height := ${f(height)}:
	set(v):
		height = v
		_rebuild()
@export var noise_seed := ${Math.floor(seed)}:
	set(v):
		noise_seed = v
		_rebuild()
@export var frequency := ${f(frequency)}:
	set(v):
		frequency = v
		_rebuild()
@export var generate_collision := true:
	set(v):
		generate_collision = v
		_rebuild()

var _noise := FastNoiseLite.new()


func _ready() -> void:
	_rebuild()


func height_at(x: float, z: float) -> float:
	return _noise.get_noise_2d(x, z) * height


func _rebuild() -> void:
	if not is_inside_tree():
		return
	_noise.seed = noise_seed
	_noise.frequency = frequency
	_noise.fractal_octaves = 5
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var n := subdivisions
	for j in range(n + 1):
		for i in range(n + 1):
			var x := -size.x * 0.5 + size.x * float(i) / n
			var z := -size.y * 0.5 + size.y * float(j) / n
			st.set_uv(Vector2(float(i) / n, float(j) / n))
			st.add_vertex(Vector3(x, height_at(x, z), z))
	for j in range(n):
		for i in range(n):
			var a := j * (n + 1) + i
			var b := a + 1
			var c := a + n + 1
			var d := c + 1
			st.add_index(a); st.add_index(c); st.add_index(b)
			st.add_index(b); st.add_index(c); st.add_index(d)
	st.generate_normals()
	st.generate_tangents()
	mesh = st.commit()
	for child in get_children():
		if child.name == "TerrainBody":
			child.queue_free()
	if generate_collision:
		var body := StaticBody3D.new()
		body.name = "TerrainBody"
		var shape := CollisionShape3D.new()
		shape.shape = mesh.create_trimesh_shape()
		body.add_child(shape)
		add_child(body)
		if Engine.is_editor_hint() and owner != null:
			body.owner = owner
			shape.owner = owner
`;
}
