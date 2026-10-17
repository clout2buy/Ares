# Web games (HTML / JS)

## Setup (no build step)
```html
<script type="importmap">{"imports":{
  "three":"https://unpkg.com/three@0.160.0/build/three.module.js",
  "three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"}}</script>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
</script>
```
Pin exact versions. Offline/desktop webviews may block CDNs: vendor the files next to the page (`vendor/three.module.js`)
when the game must run without network. Preview with Browser `action:"preview"` (a file or a dev server URL).

## three.js essentials
- `renderer = new THREE.WebGLRenderer({antialias:true})`, `setPixelRatio(Math.min(2, devicePixelRatio))`,
  `toneMapping = THREE.ACESFilmicToneMapping`, output is sRGB by default (r152+); colour textures need
  `tex.colorSpace = THREE.SRGBColorSpace`, data textures (normal/roughness) must not.
- Shadows: `renderer.shadowMap.enabled = true; type = PCFSoftShadowMap`; `light.castShadow = true`; fit
  `light.shadow.camera` (left/right/top/bottom/near/far) tightly around the play area and follow the player; `shadow.bias -0.0005`.
- Resize: on `resize` update `camera.aspect`, `updateProjectionMatrix()`, `renderer.setSize`.
- Forward is -Z for cameras and `Object3D.lookAt`; models from the Forge face +Z (rotate them PI if needed).
- Clock: `const dt = Math.min(clock.getDelta(), 0.1)`; animation: `mixer = new THREE.AnimationMixer(gltf.scene)`,
  `mixer.clipAction(clip).play()`, crossfade with `fadeIn/fadeOut` or `crossFadeTo`, `mixer.update(dt)` each frame.
- Many copies: `InstancedMesh(geo, mat, n)` + `setMatrixAt(i, m)` + `instanceMatrix.needsUpdate = true`.
- Picking: `Raycaster.setFromCamera(ndc, camera)` + `intersectObjects(list, true)`.
- Dispose geometries/materials/textures you remove (`.dispose()`), or memory grows forever.
- Post: `EffectComposer` + `RenderPass` + `UnrealBloomPass` / `OutputPass` from `three/addons/postprocessing/`.
- Forge models: `import { loadModel } from "./assets/ares-model.js"` -> `const m = await loadModel(url)` ->
  `const a = m.instance(); scene.add(a.group); a.play("walk", {fade:0.25}); a.update(dt)` each frame.

## Physics on the web
- **Rapier** (fast, deterministic, has character + vehicle controllers):
  ```js
  import RAPIER from "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/+esm";
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0).setCcdEnabled(true));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setFriction(0.7), body);
  // fixed step: world.timestep = 1/60; world.step(); then copy body.translation()/rotation() to the mesh
  ```
  Character: `world.createCharacterController(0.01)` + `computeColliderMovement(collider, desired)` + `computedMovement()`.
  Vehicle: `world.createVehicleController(chassisBody)` (see physics.md).
- **cannon-es** (simple, has RaycastVehicle): `new CANNON.World({gravity: new CANNON.Vec3(0,-9.82,0)})`,
  `world.fixedStep()` each frame (fixed 1/60 internally).
- 2D: **Matter.js** or **Planck.js** (Box2D port: metres, not pixels).

## Canvas 2D / pixel art
- Fixed logical resolution (e.g. 320x180) scaled by an integer factor; `ctx.imageSmoothingEnabled = false`;
  CSS `image-rendering: pixelated`. Sprite sheets: `drawImage(sheet, sx, sy, w, h, x, y, w, h)` with frame timing.
- Tile maps: 2D array of tile ids; collide by AABB against solid tiles, resolving X then Y separately.

## Frameworks
- **Phaser 3**: `new Phaser.Game({type: Phaser.AUTO, width, height, physics:{default:"arcade", arcade:{gravity:{y:900}}}, scene:[Boot, Play]})`;
  `this.physics.add.sprite`, `this.physics.add.collider(a, b)`, `this.input.keyboard.createCursorKeys()`; Tiled maps via
  `this.make.tilemap({key})`. **PixiJS** for fast 2D rendering only. **Babylon.js** for a batteries-included 3D engine.

## Platform
- Audio: one `AudioContext` created/resumed on the first user gesture; decode once, play via buffer sources; Howler.js
  is fine. Gamepad: poll `navigator.getGamepads()` every frame (standard mapping: buttons[0]=A, axes[0..1]=left stick,
  dead zone 0.15). Pointer lock: `canvas.requestPointerLock()` on click, `movementX/Y`.
- Mobile: touch joystick + buttons, `touch-action: none`, viewport meta, lower pixel ratio, fewer shadows.
- Fullscreen on a button; pause on `visibilitychange`; save to `localStorage` (JSON, versioned).
- Multiplayer: authoritative server over WebSocket (Node `ws`), client prediction + server reconciliation, interpolate
  remote entities 100 ms in the past; send inputs, not positions.
