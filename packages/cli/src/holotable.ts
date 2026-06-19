// The Holotable (ARES) — a data-driven hologram BUILD engine, not a demo.
//
// Doctrine: deterministic spine, LLM judgment. Any model — whatever is
// plugged into Ares — drives the Holotable by emitting a declarative
// HoloSpec (parts, wiring runs, assembly steps, bill of materials). The
// engine below is fixed and renders any valid spec: bronze-hologram parts
// with per-part assembly axes, an exploded-view slider, a step-by-step
// ASSEMBLY walkthrough, a glowing wiring overlay, a BOM panel that splits
// print-vs-purchase and exports printable parts as STL straight to your
// slicer, and a raycast inspector. One self-contained HTML file, no build
// step — open it and build the thing in your hands.
//
// Built-in specs: MECH_SPEC (the showpiece) and ROBOT_ARM_SPEC (a real DIY
// 6-servo robot arm: print list, vendor list, wiring map, 8 assembly steps).
// `ares holo --spec file.json` renders anything a model dreams up.

export interface HoloPart {
  id: string;
  name: string;
  /** Primitive geometry kind. */
  kind: "box" | "cylinder" | "sphere" | "icosa" | "capsule" | "cone" | "torus";
  /** Dimensions, kind-specific: box [w,h,d]; cylinder [rTop,rBottom,h]; sphere [r]; icosa [r]; capsule [r,len]; cone [r,h]; torus [r,tube]. */
  size: number[];
  position: [number, number, number];
  rotation?: [number, number, number];
  /** Exploded-view travel direction (default: outward from origin). */
  axis?: [number, number, number];
  /** Exploded-view travel distance (default 1.5). */
  travel?: number;
  /** Composite geometry role — servo, bracket, bearing, gear, fastener, motor,
   *  wheel, pcb, rod, joint, plate, gripper. Inferred from name if omitted. */
  role?: string;
  /** BOM: 3D-printable part (STL export offered) vs purchased. */
  printable?: boolean;
  /** BOM: where to buy / what to search for. */
  vendor?: string;
  qty?: number;
  /** BOM: manufacturer/vendor part number. */
  partNumber?: string;
  /** BOM: unit price (USD). */
  unitPrice?: number;
  /** BOM: direct buy/spec link. */
  link?: string;
  /** BOM: print material (PLA/PETG/ABS) or stock material. */
  material?: string;
  /** Inspector note: what this part does, what to watch for. */
  note?: string;
}

export interface HoloWire {
  name: string;
  /** Part ids (wire runs between their centers) or raw [x,y,z] points. */
  from: string | [number, number, number];
  to: string | [number, number, number];
  /** Optional intermediate routing points. */
  via?: Array<[number, number, number]>;
  color?: string;
  /** Connection table: signal carried (e.g. "5V", "GND", "PWM", "SIG"). */
  signal?: string;
  /** Wire gauge (e.g. "22 AWG"). */
  gauge?: string;
  /** Connector pins at each end (e.g. "D9", "VCC"). */
  fromPin?: string;
  toPin?: string;
}

export interface HoloStep {
  title: string;
  instruction: string;
  /** Parts placed in this step (ids). */
  parts: string[];
}

export interface HoloSpec {
  title: string;
  accent?: string;
  parts: HoloPart[];
  wires?: HoloWire[];
  steps?: HoloStep[];
}

export interface HolotableOptions {
  title?: string;
  /** Render a declarative build spec (the main mode). */
  spec?: HoloSpec;
  /** Or load an external GLTF/GLB and explode it radially. */
  modelUrl?: string;
  accent?: string;
}

/** Light validation — throws with a human reason on a malformed spec. */
export function validateHoloSpec(spec: HoloSpec): void {
  if (!spec || typeof spec.title !== "string") throw new Error("HoloSpec: title is required");
  if (!Array.isArray(spec.parts) || spec.parts.length === 0) throw new Error("HoloSpec: parts[] must be non-empty");
  const ids = new Set<string>();
  for (const p of spec.parts) {
    if (!p.id || ids.has(p.id)) throw new Error(`HoloSpec: duplicate or missing part id: ${p.id}`);
    ids.add(p.id);
    if (!Array.isArray(p.position) || p.position.length !== 3) throw new Error(`HoloSpec: part ${p.id} needs position [x,y,z]`);
    if (!Array.isArray(p.size) || p.size.length === 0) throw new Error(`HoloSpec: part ${p.id} needs size[]`);
  }
  for (const w of spec.wires ?? []) {
    for (const end of [w.from, w.to]) {
      if (typeof end === "string" && !ids.has(end)) throw new Error(`HoloSpec: wire "${w.name}" references unknown part ${end}`);
    }
  }
  for (const s of spec.steps ?? []) {
    for (const id of s.parts) {
      if (!ids.has(id)) throw new Error(`HoloSpec: step "${s.title}" references unknown part ${id}`);
    }
  }
}

export function buildHolotableHtml(opts: HolotableOptions = {}): string {
  const spec = opts.modelUrl ? null : (opts.spec ?? MECH_SPEC);
  if (spec) validateHoloSpec(spec);
  const title = opts.title ?? spec?.title ?? "ARES // HOLOTABLE";
  const accent = opts.accent ?? spec?.accent ?? "#c79a4e";
  // </script> inside the JSON would terminate the script block — neutralize.
  const specJson = spec ? JSON.stringify(spec).replace(/</g, "\\u003c") : "null";
  const modelUrl = opts.modelUrl ? JSON.stringify(opts.modelUrl) : "null";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0c0a0b; overflow: hidden; font-family: "Cascadia Code", ui-monospace, Consolas, monospace; }
  #scene { position: fixed; inset: 0; display: block; }
  .hud { position: fixed; pointer-events: none; color: ${accent}; text-shadow: 0 0 12px ${accent}66; letter-spacing: 0.14em; }
  #title { top: 18px; left: 22px; font-size: 13px; opacity: 0.9; }
  #part { top: 40px; left: 22px; font-size: 11px; opacity: 0.8; max-width: 44vw; }
  #note { top: 58px; left: 22px; font-size: 10px; opacity: 0.55; max-width: 40vw; letter-spacing: 0.04em; }
  #dock { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; gap: 14px; align-items: center;
          padding: 10px 18px; border: 1px solid ${accent}44; border-radius: 10px; background: #121013cc; backdrop-filter: blur(8px); }
  #dock label, #dock button { color: ${accent}; font-size: 10px; letter-spacing: 0.18em; font-family: inherit; }
  #dock button { background: none; border: 1px solid ${accent}55; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  #dock button:hover { background: ${accent}22; }
  #dock button.on { background: ${accent}33; }
  #explode { width: 220px; accent-color: ${accent}; }
  #steppanel { position: fixed; left: 50%; bottom: 78px; transform: translateX(-50%); display: none; max-width: 560px;
               padding: 10px 16px; border: 1px solid ${accent}44; border-radius: 10px; background: #121013d9; color: #e9dfd0; }
  #steppanel h3 { margin: 0 0 4px; font-size: 11px; color: ${accent}; letter-spacing: 0.16em; }
  #steppanel p { margin: 0; font-size: 11px; line-height: 1.5; opacity: 0.85; }
  #bom { position: fixed; right: 0; top: 0; bottom: 0; width: 400px; max-width: 92vw; overflow-y: auto; transform: translateX(100%);
         transition: transform 240ms ease; background: #121013f2; border-left: 1px solid ${accent}33; padding: 16px 18px; }
  #bom.open { transform: none; }
  #bom h2 { font-size: 11px; color: ${accent}; letter-spacing: 0.2em; margin: 16px 0 6px; display: flex; justify-content: space-between; align-items: baseline; }
  #bom h2 span { font-size: 9px; opacity: 0.5; letter-spacing: 0.1em; }
  .bomtable { width: 100%; border-collapse: collapse; font-size: 10px; color: #e9dfd0; }
  .bomtable th { text-align: left; font-size: 8px; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.5; padding: 4px 6px; border-bottom: 1px solid ${accent}33; font-weight: 600; }
  .bomtable td { padding: 6px 6px; border-bottom: 1px solid ${accent}14; vertical-align: top; }
  .bomtable td.r, .bomtable th.r { text-align: right; }
  .bomtable td.qty { color: ${accent}; font-weight: 700; white-space: nowrap; }
  .bomtable td.nm { font-weight: 600; }
  .bomtable td small { display: block; opacity: 0.5; font-size: 9px; margin-top: 1px; }
  .bomtable a { color: ${accent}; text-decoration: none; border-bottom: 1px dotted ${accent}66; }
  .bomtable td em { font-style: normal; opacity: 0.6; }
  .bomtable tr.tot td { border-bottom: none; font-weight: 700; color: ${accent}; padding-top: 8px; }
  .bomtable td.act button { color: ${accent}; background: none; border: 1px solid ${accent}66; border-radius: 5px; font: inherit; padding: 2px 8px; cursor: pointer; }
  .bomtable td.act button:hover { background: ${accent}22; }
  .wiretable .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; box-shadow: 0 0 6px currentColor; }
  .bomgrand { display: flex; justify-content: space-between; align-items: baseline; margin: 18px 0 6px; padding: 10px 8px; border: 1px solid ${accent}44; border-radius: 8px; background: ${accent}12; }
  .bomgrand span { font-size: 9px; letter-spacing: 0.18em; opacity: 0.6; }
  .bomgrand b { font-size: 18px; color: ${accent}; }
  #hint { position: fixed; left: 22px; bottom: 24px; font-size: 10px; opacity: 0.45; }
  #holoerr { display: none; position: fixed; inset: 0; align-items: center; justify-content: center; background: #0c0807ee; z-index: 50; }
  #holoerr > div { text-align: center; max-width: 320px; padding: 24px; }
  #holoerr b { display: block; color: ${accent}; font-size: 14px; letter-spacing: 0.1em; margin-bottom: 8px; }
  #holoerr span { display: block; font-size: 11px; opacity: 0.6; line-height: 1.5; margin-bottom: 14px; }
  #holoerr button { color: ${accent}; background: none; border: 1px solid ${accent}66; border-radius: 6px; font: inherit; padding: 6px 16px; cursor: pointer; }
</style>
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
  }
}
</script>
</head>
<body>
<canvas id="scene"></canvas>
<div id="holoerr"><div><b>3D engine didn't load</b><span>The hologram needs the three.js runtime. Check the connection and reload — the spec, BOM and wiring are all intact.</span><button onclick="location.reload()">Reload</button></div></div>
<script>
  // Watchdog: if the module never paints (CDN unreachable / blocked), surface a
  // clear message instead of a silent black panel.
  window.addEventListener("load", function () {
    setTimeout(function () { if (!window.__holoReady) { var e = document.getElementById("holoerr"); if (e) e.style.display = "flex"; } }, 6500);
  });
</script>
<div class="hud" id="title">${escapeHtml(title)}</div>
<div class="hud" id="part">&nbsp;</div>
<div class="hud" id="note">&nbsp;</div>
<div id="steppanel"><h3 id="steptitle"></h3><p id="stepbody"></p></div>
<div id="dock">
  <button id="modebtn">ASSEMBLY MODE</button>
  <button id="prevbtn" style="display:none">&#9664; PREV</button>
  <button id="nextbtn" style="display:none">NEXT &#9654;</button>
  <label for="explode" id="explabel">DISASSEMBLE</label>
  <input id="explode" type="range" min="0" max="1" step="0.001" value="0" />
  <button id="wirebtn">WIRING</button>
  <button id="bombtn">PARTS / BOM</button>
</div>
<aside id="bom"></aside>
<div class="hud" id="hint">drag · rotate&nbsp;&nbsp;wheel · zoom&nbsp;&nbsp;hover · inspect</div>

<script type="module">
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

const ACCENT = new THREE.Color("${accent}");
const SPEC = ${specJson};
const MODEL_URL = ${modelUrl};

// ── stage ─────────────────────────────────────────────────────────────────
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
const scene = new THREE.Scene();
scene.background = new THREE.Color("#080708");
scene.fog = new THREE.FogExp2("#080708", 0.028);
const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 300);
camera.position.set(6.5, 4.2, 8.5);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 2.0, 0);
controls.autoRotate = true;
controls.autoRotateSpeed = 0.45;

// ── the projection dais: glowing disc + concentric scan rings ──────────────
const dais = new THREE.Group();
scene.add(dais);
const discMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const disc = new THREE.Mesh(new THREE.CircleGeometry(7.5, 64), discMat);
disc.rotation.x = -Math.PI / 2;
disc.position.y = -0.02;
dais.add(disc);
const ringMats = [];
for (let r = 0; r < 4; r++) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.6 + r * 1.7, 1.66 + r * 1.7, 96),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.22 - r * 0.035, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  dais.add(ring);
  ringMats.push(ring);
}
// faint radial-fade floor grid
const grid = new THREE.GridHelper(50, 50, ACCENT.clone().multiplyScalar(0.6), ACCENT.clone().multiplyScalar(0.14));
grid.material.transparent = true;
grid.material.opacity = 0.16;
scene.add(grid);

scene.add(new THREE.AmbientLight(ACCENT, 0.4));
const key = new THREE.PointLight(ACCENT, 70, 90);
key.position.set(6, 9, 6);
scene.add(key);
const underGlow = new THREE.PointLight(new THREE.Color("#e3b86a"), 24, 30);
underGlow.position.set(0, 0.4, 0);
scene.add(underGlow);

// ── ambient mote field ─────────────────────────────────────────────────────
const moteGeo = new THREE.BufferGeometry();
const MOTES = 260;
const motePos = new Float32Array(MOTES * 3);
for (let i = 0; i < MOTES; i++) {
  motePos[i * 3] = (Math.random() - 0.5) * 22;
  motePos[i * 3 + 1] = Math.random() * 11;
  motePos[i * 3 + 2] = (Math.random() - 0.5) * 22;
}
moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({ color: ACCENT, size: 0.045, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
scene.add(motes);

// ── the build scan-plane: a bronze sheet that sweeps up through the model ──
const scanPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(9, 9),
  new THREE.MeshBasicMaterial({ color: new THREE.Color("#e3b86a"), transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
);
scanPlane.rotation.x = -Math.PI / 2;
scene.add(scanPlane);

// ── hologram materials — wire shell + translucent surface + additive glow ──
function holoMaterials() {
  // Crisp hologram OUTLINE (clean feature edges) instead of a noisy triangle
  // wireframe — reads as a real engineered part, not a mesh soup.
  const edge = new THREE.LineBasicMaterial({ color: ACCENT.clone().lerp(new THREE.Color("#ffffff"), 0.25), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const surface = new THREE.MeshPhongMaterial({ color: ACCENT, emissive: ACCENT.clone().multiplyScalar(0.3), transparent: true, opacity: 0.17, shininess: 90, depthWrite: false, blending: THREE.AdditiveBlending });
  const glow = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false });
  return { edge, surface, glow };
}

// Position/rotate a geometry in place so role parts can be assembled from primitives.
function xform(geo, pos, rot) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  if (rot) q.setFromEuler(new THREE.Euler(rot[0] || 0, rot[1] || 0, rot[2] || 0));
  m.compose(new THREE.Vector3(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0), q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(m);
  return geo;
}

// Infer what a part IS from its name, so we can build geometry that actually
// looks like that component instead of a featureless box.
function inferRole(part) {
  if (part.role) return part.role;
  const n = ((part.name || "") + " " + (part.id || "")).toLowerCase();
  if (/servo/.test(n)) return "servo";
  if (/bracket|mount|clamp|holder/.test(n)) return "bracket";
  if (/bearing/.test(n)) return "bearing";
  if (/gear|cog|pinion/.test(n)) return "gear";
  if (/screw|bolt|fasten|\bnut\b|standoff/.test(n)) return "fastener";
  if (/motor|stepper/.test(n)) return "motor";
  if (/wheel|roller|caster/.test(n)) return "wheel";
  if (/board|pcb|controller|driver|mcu|arduino|raspberry|\bpi\b/.test(n)) return "pcb";
  if (/rod|shaft|link|forearm|upperarm|\barm\b|rail|beam|spar|strut/.test(n)) return "rod";
  if (/joint|pivot|\bhub\b|knuckle|shoulder|elbow|wrist/.test(n)) return "joint";
  if (/plate|base|chassis|panel|deck|frame/.test(n)) return "plate";
  if (/grip|jaw|claw|finger|gripper/.test(n)) return "gripper";
  return null;
}

// Assemble a recognizable component from primitives, merged into one geometry so
// the existing surface/edge/glow pipeline (and STL export) works unchanged.
function buildRoleGeometry(part) {
  const role = inferRole(part);
  if (!role) return null;
  const s = part.size || [0.5, 0.5, 0.5];
  const W = s[0] || 0.5, H = s[1] || 0.5, D = s[2] !== undefined ? s[2] : (s[0] || 0.5);
  const g = [];
  const ring = (count, r, fn) => { for (let i = 0; i < count; i++) { const a = (i / count) * Math.PI * 2; fn(a, Math.cos(a) * r, Math.sin(a) * r); } };
  switch (role) {
    case "servo":
      g.push(new THREE.BoxGeometry(W, H, D));
      g.push(xform(new THREE.BoxGeometry(W * 0.62, H * 0.32, D * 0.7), [0, H * 0.58, 0]));
      g.push(xform(new THREE.CylinderGeometry(W * 0.2, W * 0.2, H * 0.28, 16), [0, H * 0.82, 0]));
      g.push(xform(new THREE.BoxGeometry(W * 1.5, H * 0.1, D * 0.5), [0, H * 0.22, 0]));
      break;
    case "bracket":
      g.push(xform(new THREE.BoxGeometry(W, H * 0.16, D), [0, -H * 0.42, 0]));
      g.push(xform(new THREE.BoxGeometry(W * 0.16, H, D), [-W * 0.42, 0, 0]));
      g.push(xform(new THREE.BoxGeometry(W * 0.16, H * 0.16, D), [-W * 0.42, -H * 0.42, 0]));
      break;
    case "bearing":
      g.push(xform(new THREE.TorusGeometry(W * 0.5, W * 0.15, 12, 28), [0, 0, 0], [Math.PI / 2, 0, 0]));
      g.push(new THREE.CylinderGeometry(W * 0.22, W * 0.22, H * 0.5, 20));
      break;
    case "gear": {
      const r = W * 0.5;
      g.push(new THREE.CylinderGeometry(r * 0.92, r * 0.92, H * 0.6, 24));
      ring(12, r, (a) => g.push(xform(new THREE.BoxGeometry(r * 0.26, H * 0.6, r * 0.16), [Math.cos(a) * r, 0, Math.sin(a) * r], [0, -a, 0])));
      g.push(new THREE.CylinderGeometry(r * 0.2, r * 0.2, H * 0.72, 12));
      break;
    }
    case "fastener":
      g.push(xform(new THREE.CylinderGeometry(W * 0.5, W * 0.5, H * 0.35, 6), [0, H * 0.32, 0]));
      g.push(xform(new THREE.CylinderGeometry(W * 0.26, W * 0.26, H, 12), [0, -H * 0.18, 0]));
      break;
    case "motor":
      g.push(new THREE.CylinderGeometry(W * 0.5, W * 0.5, H, 22));
      g.push(xform(new THREE.CylinderGeometry(W * 0.12, W * 0.12, H * 0.4, 12), [0, H * 0.62, 0]));
      g.push(xform(new THREE.BoxGeometry(W * 1.2, H * 0.08, W * 1.2), [0, -H * 0.45, 0]));
      break;
    case "wheel":
      g.push(xform(new THREE.TorusGeometry(W * 0.5, W * 0.17, 14, 30), [0, 0, 0], [Math.PI / 2, 0, 0]));
      g.push(new THREE.CylinderGeometry(W * 0.2, W * 0.2, D * 0.6, 16));
      ring(5, W * 0.26, (a) => g.push(xform(new THREE.BoxGeometry(W * 0.5, D * 0.1, W * 0.07), [Math.cos(a) * W * 0.26, 0, Math.sin(a) * W * 0.26], [0, -a, 0])));
      break;
    case "pcb":
      g.push(new THREE.BoxGeometry(W, H * 0.12, D));
      for (const c of [[0.22, 0.22], [-0.26, 0.12], [0.1, -0.3]]) g.push(xform(new THREE.BoxGeometry(W * 0.22, H * 0.18, D * 0.22), [c[0] * W, H * 0.14, c[1] * D]));
      break;
    case "rod":
      g.push(new THREE.CapsuleGeometry(Math.min(W, D) * 0.42, H, 4, 12));
      break;
    case "joint":
      g.push(new THREE.SphereGeometry(W * 0.5, 18, 14));
      g.push(new THREE.CylinderGeometry(W * 0.28, W * 0.28, H, 14));
      break;
    case "plate":
      g.push(new THREE.BoxGeometry(W, H * 0.12, D));
      for (const c of [[0.42, 0.42], [-0.42, 0.42], [0.42, -0.42], [-0.42, -0.42]]) g.push(xform(new THREE.CylinderGeometry(W * 0.05, W * 0.05, H * 0.3, 8), [c[0] * W, 0, c[1] * D]));
      break;
    case "gripper":
      g.push(new THREE.BoxGeometry(W, H, D * 0.5));
      g.push(xform(new THREE.BoxGeometry(W * 0.32, H * 0.85, D), [0, H * 0.18, D * 0.32], [0.28, 0, 0]));
      break;
    default:
      return null;
  }
  const merged = BufferGeometryUtils.mergeGeometries(g, false);
  return merged || new THREE.BoxGeometry(W, H, D);
}

function buildGeometry(part) {
  const role = buildRoleGeometry(part);
  if (role) return role;
  const s = part.size;
  switch (part.kind) {
    case "box": return new THREE.BoxGeometry(s[0], s[1], s[2]);
    case "cylinder": return new THREE.CylinderGeometry(s[0], s[1] !== undefined ? s[1] : s[0], s[2] !== undefined ? s[2] : 1, 16);
    case "sphere": return new THREE.SphereGeometry(s[0], 18, 14);
    case "icosa": return new THREE.IcosahedronGeometry(s[0], 1);
    case "capsule": return new THREE.CapsuleGeometry(s[0], s[1], 4, 12);
    case "cone": return new THREE.ConeGeometry(s[0], s[1], 14);
    case "torus": return new THREE.TorusGeometry(s[0], s[1], 12, 28);
    default: return new THREE.BoxGeometry(0.5, 0.5, 0.5);
  }
}

// ── parts from spec ───────────────────────────────────────────────────────
const rig = new THREE.Group();
scene.add(rig);
const parts = []; // { group, shell, glowMesh, spec, base, axis, travel, placed }
const byId = new Map();

function addSpecPart(p) {
  const geometry = buildGeometry(p);
  const { edge, surface, glow } = holoMaterials();
  const group = new THREE.Group();
  group.name = p.name;
  const glowMesh = new THREE.Mesh(geometry, glow);
  glowMesh.scale.setScalar(0.985);
  const surfaceMesh = new THREE.Mesh(geometry, surface);
  surfaceMesh.scale.setScalar(0.992);
  // crisp feature-edge outline (angle threshold drops coplanar tris → only real edges)
  const shell = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 24), edge);
  group.add(glowMesh, surfaceMesh, shell);
  const base = new THREE.Vector3(p.position[0], p.position[1], p.position[2]);
  group.position.copy(base);
  if (p.rotation) group.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2]);
  rig.add(group);
  let axis;
  if (p.axis) axis = new THREE.Vector3(p.axis[0], p.axis[1], p.axis[2]);
  else if (base.lengthSq() > 1e-6) axis = base.clone();
  else axis = new THREE.Vector3(0, 1, 0);
  const entry = { group, shell, glowMesh, solidGeo: geometry, spec: p, base, axis: axis.normalize(), travel: p.travel !== undefined ? p.travel : 1.5, placed: true };
  parts.push(entry);
  byId.set(p.id, entry);
  return entry;
}

if (SPEC) {
  for (const p of SPEC.parts) addSpecPart(p);
} else if (MODEL_URL) {
  new GLTFLoader().load(MODEL_URL, (gltf) => {
    const root = gltf.scene;
    rig.add(root);
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    root.traverse((child) => {
      if (!child.isMesh) return;
      const { edge, surface } = holoMaterials();
      child.material = surface;
      // crisp hologram edges over the loaded mesh
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(child.geometry, 24), edge);
      child.add(edges);
      const cc = new THREE.Box3().setFromObject(child).getCenter(new THREE.Vector3());
      const axis = cc.clone().sub(center);
      if (axis.lengthSq() < 1e-6) axis.set(0, 1, 0);
      parts.push({ group: child, shell: edges, glowMesh: null, solidGeo: child.geometry, spec: { id: child.uuid, name: child.name || "part" }, base: child.position.clone(), axis: axis.normalize(), travel: 1.6, placed: true });
    });
  });
}

// ── wiring overlay: glowing routed runs between part centers ─────────────
const wiring = new THREE.Group();
wiring.visible = false;
scene.add(wiring);
function endpoint(ref) {
  if (Array.isArray(ref)) return new THREE.Vector3(ref[0], ref[1], ref[2]);
  const part = byId.get(ref);
  return part ? part.base.clone() : new THREE.Vector3();
}
if (SPEC && SPEC.wires) {
  // count parallel runs between the same endpoints so a multi-conductor harness
  // fans out instead of overlapping into one fat tube.
  const pairKey = (w) => [w.from, w.to].map((e) => (Array.isArray(e) ? e.join(",") : e)).sort().join("|");
  const pairCount = {}, pairSeen = {};
  for (const w of SPEC.wires) pairCount[pairKey(w)] = (pairCount[pairKey(w)] || 0) + 1;

  for (const w of SPEC.wires) {
    const a = endpoint(w.from), b = endpoint(w.to);
    const k = pairKey(w);
    const n = pairCount[k], idx = (pairSeen[k] = (pairSeen[k] || 0)) , _ = (pairSeen[k]++);
    // lateral offset so bundled conductors separate
    const dir = b.clone().sub(a);
    const off = new THREE.Vector3(0, 1, 0).cross(dir).normalize().multiplyScalar(n > 1 ? (idx - (n - 1) / 2) * 0.06 : 0);
    const pts = [a.clone().add(off)];
    for (const v of w.via || []) pts.push(new THREE.Vector3(v[0], v[1], v[2]).add(off));
    if (!w.via || !w.via.length) {
      // gentle catenary sag at the midpoint so runs look like real cable, not laser
      const mid = a.clone().add(b).multiplyScalar(0.5).add(off);
      mid.y -= dir.length() * 0.08;
      pts.push(mid);
    }
    pts.push(b.clone().add(off));
    const curve = new THREE.CatmullRomCurve3(pts);
    const col = new THREE.Color(w.color || "#7fa6a3");
    const tube = new THREE.TubeGeometry(curve, 48, 0.022, 8, false);
    const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(tube, mat);
    mesh.name = "WIRE: " + w.name;
    wiring.add(mesh);
    // connector nodes at both ends (little terminal beads)
    const nodeGeo = new THREE.SphereGeometry(0.05, 10, 8);
    const nodeMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    for (const p of [pts[0], pts[pts.length - 1]]) {
      const node = new THREE.Mesh(nodeGeo, nodeMat);
      node.position.copy(p);
      wiring.add(node);
    }
  }
}

// ── BOM panel: print list, purchase list, STL export to your slicer ───────
const bomEl = document.getElementById("bom");
const exporter = new STLExporter();
function downloadStl(entry) {
  // Export the SOLID part geometry (not the edge outline) with its world
  // transform baked, ready to slice into a real printable mesh.
  const mesh = new THREE.Mesh(entry.solidGeo.clone(), new THREE.MeshBasicMaterial());
  mesh.rotation.copy(entry.group.rotation);
  mesh.updateMatrixWorld(true);
  const stl = exporter.parse(mesh, { binary: false });
  const blob = new Blob([stl], { type: "model/stl" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = entry.spec.id + ".stl";
  a.click();
  URL.revokeObjectURL(a.href);
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function money(n) { return "$" + Number(n).toFixed(2); }

if (SPEC) {
  const printables = parts.filter((p) => p.spec.printable);
  const purchases = parts.filter((p) => !p.spec.printable);
  const section = (label, sub) => {
    const h = document.createElement("h2");
    h.innerHTML = esc(label) + (sub ? "<span>" + esc(sub) + "</span>" : "");
    bomEl.appendChild(h);
  };

  // a real bill-of-materials table: qty · part · spec · vendor/part# · unit · subtotal
  const bomTable = (entries, withStl) => {
    const tbl = document.createElement("table");
    tbl.className = "bomtable";
    const head = document.createElement("tr");
    head.innerHTML = "<th>qty</th><th>part</th><th>vendor / part #</th><th class='r'>unit</th><th class='r'>subtotal</th><th></th>";
    tbl.appendChild(head);
    let total = 0;
    for (const entry of entries) {
      const s = entry.spec;
      const qty = s.qty && s.qty > 0 ? s.qty : 1;
      const unit = typeof s.unitPrice === "number" ? s.unitPrice : null;
      const sub = unit != null ? unit * qty : null;
      if (sub != null) total += sub;
      const tr = document.createElement("tr");
      const vendorCell = s.link
        ? "<a href='" + esc(s.link) + "' target='_blank' rel='noopener'>" + esc(s.vendor || "buy") + "</a>"
        : esc(s.vendor || "");
      tr.innerHTML =
        "<td class='qty'>" + qty + "\\u00d7</td>" +
        "<td class='nm'>" + esc(s.name) + (s.material ? "<small>" + esc(s.material) + "</small>" : (s.note ? "<small>" + esc(s.note) + "</small>" : "")) + "</td>" +
        "<td>" + vendorCell + (s.partNumber ? "<small>" + esc(s.partNumber) + "</small>" : "") + "</td>" +
        "<td class='r'>" + (unit != null ? money(unit) : "\\u2014") + "</td>" +
        "<td class='r'>" + (sub != null ? money(sub) : "\\u2014") + "</td>" +
        "<td class='act'></td>";
      if (withStl) {
        const btn = document.createElement("button");
        btn.textContent = "STL";
        btn.title = "export this part for 3D printing";
        btn.addEventListener("click", () => downloadStl(entry));
        tr.lastChild.appendChild(btn);
      }
      tbl.appendChild(tr);
    }
    if (total > 0) {
      const tot = document.createElement("tr");
      tot.className = "tot";
      tot.innerHTML = "<td></td><td></td><td class='r'>subtotal</td><td></td><td class='r'>" + money(total) + "</td><td></td>";
      tbl.appendChild(tot);
    }
    bomEl.appendChild(tbl);
    return total;
  };

  let grand = 0;
  if (printables.length) { section("PRINT", printables.length + " parts"); grand += bomTable(printables, true); }
  if (purchases.length) { section("BUY", purchases.length + " parts"); grand += bomTable(purchases, false); }

  // a real wiring HARNESS table: from-pin \\u2192 to-pin, signal, gauge, colour swatch
  if (SPEC.wires && SPEC.wires.length) {
    section("WIRING HARNESS", SPEC.wires.length + " runs");
    const tbl = document.createElement("table");
    tbl.className = "bomtable wiretable";
    const head = document.createElement("tr");
    head.innerHTML = "<th></th><th>run</th><th>from</th><th>to</th><th>signal</th><th>gauge</th>";
    tbl.appendChild(head);
    const nameOf = (ref) => { if (Array.isArray(ref)) return "pt"; const p = byId.get(ref); return p ? p.spec.name : ref; };
    for (const w of SPEC.wires) {
      const tr = document.createElement("tr");
      const sw = "<span class='swatch' style='background:" + esc(w.color || "#7fa6a3") + "'></span>";
      const from = esc(nameOf(w.from)) + (w.fromPin ? " <em>" + esc(w.fromPin) + "</em>" : "");
      const to = esc(nameOf(w.to)) + (w.toPin ? " <em>" + esc(w.toPin) + "</em>" : "");
      tr.innerHTML = "<td>" + sw + "</td><td class='nm'>" + esc(w.name) + "</td><td>" + from + "</td><td>" + to + "</td><td>" + esc(w.signal || "\\u2014") + "</td><td>" + esc(w.gauge || "\\u2014") + "</td>";
      tbl.appendChild(tr);
    }
    bomEl.appendChild(tbl);
  }

  if (grand > 0) {
    const g = document.createElement("div");
    g.className = "bomgrand";
    g.innerHTML = "<span>EST. TOTAL</span><b>" + money(grand) + "</b>";
    bomEl.appendChild(g);
  }
}

// ── modes: INSPECT (exploded slider) / ASSEMBLY (step walkthrough) ────────
const exploded = { current: 0, target: 0 };
const steps = (SPEC && SPEC.steps) || [];
let mode = "inspect";
let stepIndex = -1; // -1 = nothing placed yet
const modeBtn = document.getElementById("modebtn");
const prevBtn = document.getElementById("prevbtn");
const nextBtn = document.getElementById("nextbtn");
const slider = document.getElementById("explode");
const expLabel = document.getElementById("explabel");
const stepPanel = document.getElementById("steppanel");
const stepTitle = document.getElementById("steptitle");
const stepBody = document.getElementById("stepbody");

slider.addEventListener("input", (e) => { exploded.target = Number(e.target.value); });
document.getElementById("wirebtn").addEventListener("click", (e) => {
  wiring.visible = !wiring.visible;
  e.target.classList.toggle("on", wiring.visible);
});
document.getElementById("bombtn").addEventListener("click", (e) => {
  bomEl.classList.toggle("open");
  e.target.classList.toggle("on", bomEl.classList.contains("open"));
});

function applyStep() {
  const placedIds = new Set();
  for (let i = 0; i <= stepIndex && i < steps.length; i++) for (const id of steps[i].parts) placedIds.add(id);
  const currentIds = stepIndex >= 0 && stepIndex < steps.length ? new Set(steps[stepIndex].parts) : new Set();
  for (const p of parts) {
    p.placed = placedIds.has(p.spec.id);
    p.group.visible = p.placed;
    p.current = currentIds.has(p.spec.id);
    if (p.shell.material) p.shell.material.opacity = p.current ? 1.0 : 0.45;
  }
  if (stepIndex >= 0 && stepIndex < steps.length) {
    stepPanel.style.display = "block";
    stepTitle.textContent = "STEP " + (stepIndex + 1) + "/" + steps.length + " — " + steps[stepIndex].title;
    stepBody.textContent = steps[stepIndex].instruction;
  } else {
    stepPanel.style.display = "none";
  }
  prevBtn.disabled = stepIndex < 0;
  nextBtn.disabled = stepIndex >= steps.length - 1;
}

modeBtn.addEventListener("click", () => {
  if (steps.length === 0) { modeBtn.textContent = "NO STEPS IN SPEC"; return; }
  mode = mode === "inspect" ? "assembly" : "inspect";
  const assembly = mode === "assembly";
  modeBtn.classList.toggle("on", assembly);
  modeBtn.textContent = assembly ? "INSPECT MODE" : "ASSEMBLY MODE";
  prevBtn.style.display = nextBtn.style.display = assembly ? "" : "none";
  slider.style.display = expLabel.style.display = assembly ? "none" : "";
  if (assembly) { exploded.target = 0; stepIndex = steps.length ? 0 : -1; applyStep(); }
  else { stepIndex = -1; stepPanel.style.display = "none"; for (const p of parts) { p.group.visible = true; p.current = false; if (p.shell.material) p.shell.material.opacity = 0.85; } }
});
prevBtn.addEventListener("click", () => { if (stepIndex > 0) { stepIndex--; applyStep(); } });
nextBtn.addEventListener("click", () => { if (stepIndex < steps.length - 1) { stepIndex++; applyStep(); } });

// ── raycast inspector ─────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(-2, -2);
canvas.addEventListener("pointermove", (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
});
const partLabel = document.getElementById("part");
const noteLabel = document.getElementById("note");

// ── loop ──────────────────────────────────────────────────────────────────
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  const time = clock.elapsedTime;
  exploded.current += (exploded.target - exploded.current) * Math.min(1, dt * 7);
  const t = mode === "assembly" ? 0 : exploded.current;
  for (const p of parts) {
    // exploded translation along the assembly axis
    p.group.position.copy(p.base).addScaledVector(p.axis, t * p.travel);
    // assembly mode: the current step's parts pulse
    if (p.current && p.glowMesh) p.glowMesh.material.opacity = 0.10 + 0.10 * Math.sin(time * 5);
    else if (p.glowMesh) p.glowMesh.material.opacity = 0.07;
  }
  // wiring fades out as the build comes apart (runs are routed assembled)
  if (wiring.visible) for (const m of wiring.children) m.material.opacity = 0.85 * Math.max(0, 1 - t * 2.2);
  rig.rotation.y += dt * 0.1 * (mode === "assembly" ? 0 : 1 - t * 0.6);
  wiring.rotation.y = rig.rotation.y;

  // dais scan rings breathe; the build scan-plane sweeps up through the model
  dais.rotation.y -= dt * 0.08;
  for (let r = 0; r < ringMats.length; r++) {
    ringMats[r].material.opacity = (0.22 - r * 0.035) * (0.6 + 0.4 * Math.sin(time * 1.4 - r * 0.8));
  }
  scanPlane.position.y = ((time * 0.7) % 5);
  scanPlane.material.opacity = 0.16 * (0.4 + 0.6 * Math.abs(Math.sin(time * 0.7 * Math.PI)));
  underGlow.intensity = 20 + 8 * Math.sin(time * 1.6);
  // motes drift slowly upward, wrapping
  const mp = moteGeo.attributes.position.array;
  for (let i = 1; i < mp.length; i += 3) { mp[i] += dt * 0.18; if (mp[i] > 11) mp[i] = 0; }
  moteGeo.attributes.position.needsUpdate = true;
  motes.rotation.y += dt * 0.01;

  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([rig, wiring], true);
  let label = "", note = "";
  if (hits.length > 0) {
    let node = hits[0].object;
    while (node && !node.name && node.parent) node = node.parent;
    label = (node && node.name) || "";
    const entry = parts.find((p) => p.group === node);
    if (entry && entry.spec.note) note = entry.spec.note;
    if (entry && entry.spec.printable) note = (note ? note + " " : "") + "[3D-PRINTABLE — STL in BOM]";
  }
  partLabel.textContent = label ? "> " + label : "\\u00a0";
  noteLabel.textContent = note || "\\u00a0";

  controls.update();
  renderer.render(scene, camera);
  window.__holoReady = true; // signals the watchdog the engine painted
});
</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Built-in specs ────────────────────────────────────────────────────────

/** The showpiece mech — now data like everything else. */
export const MECH_SPEC: HoloSpec = {
  title: "ARES // HOLOTABLE — MK I",
  parts: [
    { id: "core", name: "REACTOR CORE", kind: "icosa", size: [0.42], position: [0, 2.55, 0.1], axis: [0, 0, 1], travel: 1.4, printable: false, vendor: "fusion not included", note: "Power bus root — everything wires back here." },
    { id: "torso", name: "TORSO FRAME", kind: "box", size: [1.7, 1.6, 1.0], position: [0, 2.6, 0], axis: [0, 0, -1], travel: 1.2, printable: true },
    { id: "pelvis", name: "PELVIC MOUNT", kind: "cylinder", size: [0.55, 0.7, 0.55], position: [0, 1.55, 0], axis: [0, -1, 0.2], travel: 1.0, printable: true },
    { id: "helm", name: "HELM SENSOR ARRAY", kind: "sphere", size: [0.42], position: [0, 3.75, 0.05], axis: [0, 1, 0], travel: 1.3, printable: true },
    { id: "lshoulder", name: "L SHOULDER ACTUATOR", kind: "sphere", size: [0.34], position: [-1.18, 3.18, 0], axis: [-1, 0.4, 0], travel: 1.5 },
    { id: "rshoulder", name: "R SHOULDER ACTUATOR", kind: "sphere", size: [0.34], position: [1.18, 3.18, 0], axis: [1, 0.4, 0], travel: 1.5 },
    { id: "larm", name: "L ARM SERVO CHAIN", kind: "cylinder", size: [0.18, 0.24, 1.5], position: [-1.32, 2.2, 0], axis: [-1, -0.2, 0], travel: 1.9 },
    { id: "rarm", name: "R ARM SERVO CHAIN", kind: "cylinder", size: [0.18, 0.24, 1.5], position: [1.32, 2.2, 0], axis: [1, -0.2, 0], travel: 1.9 },
    { id: "lhand", name: "L GAUNTLET", kind: "box", size: [0.4, 0.45, 0.45], position: [-1.36, 1.2, 0.05], axis: [-1, -0.6, 0.3], travel: 2.3, printable: true },
    { id: "rhand", name: "R GAUNTLET", kind: "box", size: [0.4, 0.45, 0.45], position: [1.36, 1.2, 0.05], axis: [1, -0.6, 0.3], travel: 2.3, printable: true },
    { id: "lfemur", name: "L FEMUR STRUT", kind: "cylinder", size: [0.22, 0.26, 1.3], position: [-0.45, 0.85, 0], axis: [-0.5, -1, 0], travel: 1.6 },
    { id: "rfemur", name: "R FEMUR STRUT", kind: "cylinder", size: [0.22, 0.26, 1.3], position: [0.45, 0.85, 0], axis: [0.5, -1, 0], travel: 1.6 },
    { id: "lfoot", name: "L FOOT PLATE", kind: "box", size: [0.5, 0.3, 0.85], position: [-0.45, 0.16, 0.12], axis: [-0.3, -1, 0.4], travel: 2.1, printable: true },
    { id: "rfoot", name: "R FOOT PLATE", kind: "box", size: [0.5, 0.3, 0.85], position: [0.45, 0.16, 0.12], axis: [0.3, -1, 0.4], travel: 2.1, printable: true },
  ],
  wires: [
    { name: "core → helm sensor bus", from: "core", to: "helm", via: [[0.3, 3.2, 0.3]], color: "#7fa6a3" },
    { name: "core → L arm power", from: "core", to: "larm", via: [[-0.9, 2.9, 0.4]], color: "#b03a3a" },
    { name: "core → R arm power", from: "core", to: "rarm", via: [[0.9, 2.9, 0.4]], color: "#b03a3a" },
    { name: "core → leg drive trunk", from: "core", to: "pelvis", color: "#e3b86a" },
  ],
  steps: [
    { title: "Pelvis and legs", instruction: "Mount the femur struts into the pelvic mount, then bolt the foot plates on. This is the stance the whole frame loads onto.", parts: ["pelvis", "lfemur", "rfemur", "lfoot", "rfoot"] },
    { title: "Torso frame", instruction: "Drop the torso frame onto the pelvic mount and torque the spine coupling.", parts: ["torso"] },
    { title: "Reactor core", instruction: "Seat the reactor core into the chest cavity. Route nothing yet — wiring comes after the limbs.", parts: ["core"] },
    { title: "Shoulders and arms", instruction: "Press the shoulder actuators into their sockets, then hang the arm servo chains and gauntlets.", parts: ["lshoulder", "rshoulder", "larm", "rarm", "lhand", "rhand"] },
    { title: "Helm", instruction: "Crown it. The sensor array clips onto the neck ring — mind the bus connector orientation.", parts: ["helm"] },
  ],
};

/** A real build: DIY 6-servo robot arm — print list, vendor list, wiring, steps. */
export const ROBOT_ARM_SPEC: HoloSpec = {
  title: "ARES // HOLOTABLE — DIY ROBOT ARM",
  parts: [
    { id: "base", name: "BASE PLATE", role: "plate", kind: "cylinder", size: [1.6, 1.8, 0.3], position: [0, 0.15, 0], axis: [0, -1, 0], travel: 1.2, printable: true, material: "PETG · 40% infill", unitPrice: 1.8, note: "Print at 40% infill minimum — the whole arm cantilevers off this." },
    { id: "bearing", name: "TURNTABLE BEARING", role: "bearing", kind: "torus", size: [1.0, 0.12], position: [0, 0.42, 0], rotation: [1.5707963, 0, 0], axis: [0, -1, 0.4], travel: 1.4, vendor: "Lazy-susan bearing 120mm", partNumber: "VXB 120mm", unitPrice: 8.5, link: "https://www.amazon.com/s?k=lazy+susan+bearing+120mm", note: "Takes the yaw load off the base servo spline." },
    { id: "baseservo", name: "BASE YAW SERVO", role: "servo", kind: "box", size: [0.55, 0.5, 0.5], position: [0, 0.75, 0], axis: [0, -1, -0.6], travel: 1.6, vendor: "TowerPro", partNumber: "MG996R", unitPrice: 4.2, qty: 1, link: "https://www.amazon.com/s?k=MG996R+servo", note: "Hardest-working servo in the build. Metal gears not optional." },
    { id: "shoulderbracket", name: "SHOULDER BRACKET", role: "bracket", kind: "box", size: [0.7, 0.9, 0.5], position: [0, 1.35, 0], axis: [-0.6, 0.4, 0], travel: 1.5, printable: true, material: "PETG · 5 perimeters", unitPrice: 1.1 },
    { id: "shoulderservo", name: "SHOULDER SERVO", role: "servo", kind: "box", size: [0.55, 0.5, 0.5], position: [0, 1.85, 0], axis: [0.8, 0.3, 0], travel: 1.6, vendor: "TowerPro", partNumber: "MG996R", unitPrice: 4.2, qty: 1 },
    { id: "upperarm", name: "UPPER ARM BEAM", role: "rod", kind: "box", size: [0.32, 1.5, 0.32], position: [0, 2.7, 0], axis: [0, 1, -0.5], travel: 1.6, printable: true, material: "PETG · hollow, 3 walls", unitPrice: 0.9, note: "Hollow print with 3 perimeters — stiffness over weight." },
    { id: "elbowservo", name: "ELBOW SERVO", role: "servo", kind: "box", size: [0.5, 0.45, 0.45], position: [0, 3.5, 0], axis: [-0.8, 0.4, 0], travel: 1.7, vendor: "TowerPro", partNumber: "MG90S", unitPrice: 2.6, qty: 1 },
    { id: "forearm", name: "FOREARM BEAM", role: "rod", kind: "box", size: [0.26, 1.2, 0.26], position: [0, 4.25, 0.25], rotation: [0.5, 0, 0], axis: [0, 1, 0.6], travel: 1.7, printable: true, material: "PETG", unitPrice: 0.7 },
    { id: "wristservo", name: "WRIST SERVO", role: "servo", kind: "box", size: [0.4, 0.35, 0.35], position: [0, 4.85, 0.6], axis: [0.8, 0.5, 0], travel: 1.8, vendor: "TowerPro", partNumber: "MG90S", unitPrice: 2.6, qty: 1 },
    { id: "gripperbase", name: "GRIPPER CHASSIS", role: "gripper", kind: "box", size: [0.5, 0.3, 0.4], position: [0, 5.2, 0.85], axis: [0, 1, 0.8], travel: 1.9, printable: true, material: "PETG", unitPrice: 0.8 },
    { id: "gripperjawl", name: "GRIPPER JAW L", role: "gripper", kind: "box", size: [0.1, 0.45, 0.3], position: [-0.18, 5.55, 1.0], axis: [-1, 0.6, 0.4], travel: 2.1, printable: true, material: "PETG", unitPrice: 0.4, qty: 1 },
    { id: "gripperjawr", name: "GRIPPER JAW R", role: "gripper", kind: "box", size: [0.1, 0.45, 0.3], position: [0.18, 5.55, 1.0], axis: [1, 0.6, 0.4], travel: 2.1, printable: true, material: "PETG", unitPrice: 0.4, qty: 1 },
    { id: "controller", name: "SERVO CONTROLLER", role: "pcb", kind: "box", size: [0.9, 0.15, 0.6], position: [2.2, 0.2, 0], axis: [1, 0, 0.3], travel: 1.4, vendor: "Adafruit / clone", partNumber: "PCA9685 16-ch", unitPrice: 6.0, link: "https://www.adafruit.com/product/815", note: "Drives all 5 servos from 2 I2C pins." },
    { id: "brain", name: "BRAIN BOARD", role: "pcb", kind: "box", size: [1.0, 0.18, 0.7], position: [2.2, 0.2, 1.1], axis: [1, 0, 0.8], travel: 1.5, vendor: "Raspberry Pi", partNumber: "Pi 5 8GB / Jetson Orin Nano", unitPrice: 80.0, link: "https://www.raspberrypi.com/products/raspberry-pi-5/", note: "Where your robotics/vision model lives. Camera plugs here." },
    { id: "psu", name: "5V 10A PSU", role: "pcb", kind: "box", size: [1.1, 0.5, 0.7], position: [2.2, 0.45, -1.1], axis: [1, 0, -0.8], travel: 1.5, vendor: "MeanWell", partNumber: "RS-50-5", unitPrice: 14.0, note: "Servos NEVER share the brain's power rail. Common ground only." },
    { id: "fasteners", name: "M3 HARDWARE KIT", role: "fastener", kind: "cylinder", size: [0.12, 0.12, 0.5], position: [2.2, 0.1, -2.0], axis: [1, 0, -1], travel: 1.2, vendor: "Assorted M3 bolts/nuts/standoffs", partNumber: "M3 kit", unitPrice: 9.0, qty: 1, note: "M3×8/12/16, nuts, nylon standoffs. You will use all of them." },
  ],
  wires: [
    { name: "Power rail", from: "psu", to: "controller", color: "#d0473a", signal: "+5V / GND", gauge: "18 AWG", fromPin: "V+/V-", toPin: "VCC/GND" },
    { name: "I2C control", from: "brain", to: "controller", color: "#7fa6a3", signal: "SDA / SCL", gauge: "26 AWG", fromPin: "GPIO2/3", toPin: "SDA/SCL" },
    { name: "Common ground", from: "brain", to: "psu", color: "#888888", signal: "GND", gauge: "22 AWG", fromPin: "GND", toPin: "V-" },
    { name: "Base yaw", from: "controller", to: "baseservo", via: [[1.2, 0.5, 0]], color: "#e3b86a", signal: "PWM", gauge: "22 AWG", fromPin: "CH0", toPin: "SIG" },
    { name: "Shoulder", from: "controller", to: "shoulderservo", via: [[1.3, 1.3, 0]], color: "#e3b86a", signal: "PWM", gauge: "22 AWG", fromPin: "CH1", toPin: "SIG" },
    { name: "Elbow", from: "controller", to: "elbowservo", via: [[1.4, 2.6, 0]], color: "#e3b86a", signal: "PWM", gauge: "26 AWG", fromPin: "CH2", toPin: "SIG" },
    { name: "Wrist", from: "controller", to: "wristservo", via: [[1.5, 3.8, 0.4]], color: "#e3b86a", signal: "PWM", gauge: "26 AWG", fromPin: "CH3", toPin: "SIG" },
    { name: "Gripper", from: "controller", to: "gripperbase", via: [[1.6, 4.4, 0.7]], color: "#e3b86a", signal: "PWM", gauge: "26 AWG", fromPin: "CH4", toPin: "SIG" },
  ],
  steps: [
    { title: "Print the structure", instruction: "Print: base plate (40% infill), shoulder bracket, upper arm beam, forearm beam, gripper chassis + both jaws. PETG over PLA if the arm will run for hours — servo heat creeps.", parts: ["base"] },
    { title: "Base and bearing", instruction: "Bolt the turntable bearing onto the base plate. The bearing carries the load so the yaw servo only has to steer.", parts: ["bearing"] },
    { title: "Yaw servo", instruction: "Mount the MG996R under the bearing, spline up, and center it (write the PWM center value down — you will need it in software).", parts: ["baseservo"] },
    { title: "Shoulder", instruction: "Bolt the shoulder bracket to the bearing top plate, then seat the shoulder servo into the bracket.", parts: ["shoulderbracket", "shoulderservo"] },
    { title: "Arm beams", instruction: "Attach the upper arm beam to the shoulder horn, mount the elbow servo at its top, then hang the forearm beam off the elbow horn.", parts: ["upperarm", "elbowservo", "forearm"] },
    { title: "Wrist and gripper", instruction: "Wrist servo into the forearm end, gripper chassis on the wrist horn, jaws onto the gripper gears. Check jaw mesh by hand before powering.", parts: ["wristservo", "gripperbase", "gripperjawl", "gripperjawr"] },
    { title: "Electronics bench", instruction: "Place the PCA9685, brain board, and PSU off-arm. Toggle WIRING to see every run: heavy red is servo power, teal is I2C, bronze is per-channel signal.", parts: ["controller", "brain", "psu"] },
    { title: "Wire and first light", instruction: "Wire per the overlay (servos to ch0–ch4, COMMON GROUND between PSU and brain). First test: center all channels at 1500µs, THEN attach horns. Your vision/robotics model drives the brain board from here.", parts: [] },
  ],
};
