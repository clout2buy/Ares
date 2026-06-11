// The Holotable (ARES — the friend-group answer).
//
// Generates a SELF-CONTAINED hologram-style 3D viewer: one HTML file, opens
// straight in a browser, no build step. Bronze wireframe + additive glow on
// obsidian (the warroom palette), an exploded-view slider that walks every
// part outward along its assembly axis, orbit controls, and a raycast HUD
// that names the part under the cursor.
//
// Two modes:
//   - procedural (default): a mech built from primitives, parts annotated
//     with assembly axes — the demo that needs zero assets.
//   - model: pass a .glb/.gltf URL/path; parts explode radially from the
//     model's center by child-mesh centroid.
//
// This file is ALSO the reference solution for the gauntlet's holo-viewer
// task — the structural probes (three / exploded / input / wireframe) are the
// bones any valid solution shares.

export interface HolotableOptions {
  title?: string;
  /** Optional GLTF/GLB to load instead of the procedural mech. */
  modelUrl?: string;
  /** Accent hex (default warroom bronze). */
  accent?: string;
}

export function buildHolotableHtml(opts: HolotableOptions = {}): string {
  const title = opts.title ?? "ARES // HOLOTABLE";
  const accent = opts.accent ?? "#c79a4e";
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
  #part { top: 40px; left: 22px; font-size: 11px; opacity: 0.75; min-height: 14px; }
  #dock { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; gap: 14px; align-items: center;
          padding: 10px 18px; border: 1px solid ${accent}44; border-radius: 10px; background: #121013cc; backdrop-filter: blur(8px); }
  #dock label { color: ${accent}; font-size: 10px; letter-spacing: 0.18em; }
  #explode { width: 260px; accent-color: ${accent}; }
  #hint { position: fixed; right: 22px; bottom: 24px; font-size: 10px; opacity: 0.45; }
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
<div class="hud" id="title">${escapeHtml(title)}</div>
<div class="hud" id="part">&nbsp;</div>
<div id="dock">
  <label for="explode">DISASSEMBLE</label>
  <input id="explode" type="range" min="0" max="1" step="0.001" value="0" />
  <label>ASSEMBLE</label>
</div>
<div class="hud" id="hint">drag · rotate&nbsp;&nbsp;wheel · zoom&nbsp;&nbsp;hover · inspect</div>

<script type="module">
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const ACCENT = new THREE.Color("${accent}");
const MODEL_URL = ${modelUrl};

// ── stage ─────────────────────────────────────────────────────────────────
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
const scene = new THREE.Scene();
scene.background = new THREE.Color("#0c0a0b");
scene.fog = new THREE.FogExp2("#0c0a0b", 0.035);
const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
camera.position.set(6.5, 4.2, 8.5);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 2.0, 0);

const grid = new THREE.GridHelper(40, 40, ACCENT.clone().multiplyScalar(0.5), ACCENT.clone().multiplyScalar(0.16));
grid.material.transparent = true;
grid.material.opacity = 0.22;
scene.add(grid);
scene.add(new THREE.AmbientLight(ACCENT, 0.35));
const key = new THREE.PointLight(ACCENT, 60, 60);
key.position.set(6, 9, 6);
scene.add(key);

// ── hologram materials: bronze wireframe shell + additive glow core ──────
function holoMaterials() {
  const wire = new THREE.MeshBasicMaterial({ color: ACCENT, wireframe: true, transparent: true, opacity: 0.85 });
  const glow = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false });
  return { wire, glow };
}

/** A part: geometry + name + the assembly axis it travels when exploded. */
const parts = [];
function addPart(parent, name, geometry, position, axis, travel) {
  const { wire, glow } = holoMaterials();
  const group = new THREE.Group();
  group.name = name;
  const shell = new THREE.Mesh(geometry, wire);
  const core = new THREE.Mesh(geometry, glow);
  core.scale.setScalar(0.985);
  group.add(core, shell);
  group.position.copy(position);
  parent.add(group);
  parts.push({ group, name, base: position.clone(), axis: axis.clone().normalize(), travel });
  return group;
}

const rig = new THREE.Group();
scene.add(rig);

if (MODEL_URL) {
  // External model: explode child meshes radially from the model center.
  new GLTFLoader().load(MODEL_URL, (gltf) => {
    const root = gltf.scene;
    rig.add(root);
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    root.traverse((child) => {
      if (!child.isMesh) return;
      const { wire } = holoMaterials();
      child.material = wire;
      const childCenter = new THREE.Box3().setFromObject(child).getCenter(new THREE.Vector3());
      const axis = childCenter.clone().sub(center);
      if (axis.lengthSq() < 1e-6) axis.set(0, 1, 0);
      parts.push({ group: child, name: child.name || "part", base: child.position.clone(), axis: axis.normalize(), travel: 1.6 });
    });
    frame(box);
  });
} else {
  buildMech(rig);
}

// ── the procedural mech (the zero-asset demo) ─────────────────────────────
function buildMech(parent) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  addPart(parent, "REACTOR CORE", new THREE.IcosahedronGeometry(0.42, 1), V(0, 2.55, 0.1), V(0, 0, 1), 1.4);
  addPart(parent, "TORSO FRAME", new THREE.BoxGeometry(1.7, 1.6, 1.0), V(0, 2.6, 0), V(0, 0, -1), 1.2);
  addPart(parent, "PELVIC MOUNT", new THREE.CylinderGeometry(0.55, 0.7, 0.55, 8), V(0, 1.55, 0), V(0, -1, 0.2), 1.0);
  addPart(parent, "HELM SENSOR ARRAY", new THREE.SphereGeometry(0.42, 12, 10), V(0, 3.75, 0.05), V(0, 1, 0), 1.3);
  addPart(parent, "L SHOULDER ACTUATOR", new THREE.SphereGeometry(0.34, 10, 8), V(-1.18, 3.18, 0), V(-1, 0.4, 0), 1.5);
  addPart(parent, "R SHOULDER ACTUATOR", new THREE.SphereGeometry(0.34, 10, 8), V(1.18, 3.18, 0), V(1, 0.4, 0), 1.5);
  addPart(parent, "L ARM SERVO CHAIN", new THREE.CylinderGeometry(0.18, 0.24, 1.5, 8), V(-1.32, 2.2, 0), V(-1, -0.2, 0), 1.9);
  addPart(parent, "R ARM SERVO CHAIN", new THREE.CylinderGeometry(0.18, 0.24, 1.5, 8), V(1.32, 2.2, 0), V(1, -0.2, 0), 1.9);
  addPart(parent, "L GAUNTLET", new THREE.BoxGeometry(0.4, 0.45, 0.45), V(-1.36, 1.2, 0.05), V(-1, -0.6, 0.3), 2.3);
  addPart(parent, "R GAUNTLET", new THREE.BoxGeometry(0.4, 0.45, 0.45), V(1.36, 1.2, 0.05), V(1, -0.6, 0.3), 2.3);
  addPart(parent, "L FEMUR STRUT", new THREE.CylinderGeometry(0.22, 0.26, 1.3, 8), V(-0.45, 0.85, 0), V(-0.5, -1, 0), 1.6);
  addPart(parent, "R FEMUR STRUT", new THREE.CylinderGeometry(0.22, 0.26, 1.3, 8), V(0.45, 0.85, 0), V(0.5, -1, 0), 1.6);
  addPart(parent, "L FOOT PLATE", new THREE.BoxGeometry(0.5, 0.3, 0.85), V(-0.45, 0.16, 0.12), V(-0.3, -1, 0.4), 2.1);
  addPart(parent, "R FOOT PLATE", new THREE.BoxGeometry(0.5, 0.3, 0.85), V(0.45, 0.16, 0.12), V(0.3, -1, 0.4), 2.1);
}

function frame(box) {
  const size = box.getSize(new THREE.Vector3()).length();
  camera.position.setLength(Math.max(6, size * 1.2));
}

// ── exploded view: slider drives a smoothed parameter, parts ride axes ────
// "exploded" state: 0 = assembled, 1 = fully disassembled.
const exploded = { current: 0, target: 0 };
document.getElementById("explode").addEventListener("input", (e) => {
  exploded.target = Number(e.target.value);
});

// ── raycast HUD: name the part under the cursor ───────────────────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(-2, -2);
canvas.addEventListener("pointermove", (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
});
const partLabel = document.getElementById("part");

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
  // critically-damped-ish ease toward the slider target
  exploded.current += (exploded.target - exploded.current) * Math.min(1, dt * 7);
  const t = exploded.current;
  for (const p of parts) {
    p.group.position.copy(p.base).addScaledVector(p.axis, t * p.travel);
  }
  rig.rotation.y += dt * 0.12 * (1 - t * 0.6);

  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(rig.children, true);
  let name = "";
  if (hits.length > 0) {
    let node = hits[0].object;
    while (node && !node.name && node.parent) node = node.parent;
    name = node?.name ?? "";
  }
  partLabel.textContent = name ? "> " + name : "\\u00a0";

  controls.update();
  renderer.render(scene, camera);
});
</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
