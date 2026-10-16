# Game architecture (any engine)

## The loop
- Fixed-timestep simulation (60 Hz) + interpolated rendering (see physics.md). Input is sampled once per frame and
  consumed by the simulation; never read the keyboard inside render code.
- Clamp the frame delta (0.1-0.25 s) so a stall or a tab switch does not teleport everything; pause on `visibilitychange`.
- Order per tick: input -> AI/scripts -> physics -> gameplay reactions (collisions, damage) -> animation -> camera -> audio.

## Structure
- **States**: Boot -> Menu -> Play <-> Pause -> GameOver/Win -> Menu. One object per state with enter/update/exit; no
  `if (paused)` sprinkled through the code.
- **Entities**: plain objects with components (transform, render, body, health, ai, ...) and systems iterating them (ECS-lite),
  or engine nodes/GameObjects. Keep data and update logic apart from rendering.
- **Events**: a tiny bus (`on/emit`) for "enemyDied", "coinPicked", "levelComplete" - UI, audio and score listen; gameplay
  code does not call the UI directly.
- **Config**: every tunable (speeds, damage, spawn rates) in one table at the top or a data file, so a fix is a number.
- **Save**: JSON of the meaningful state (level, inventory, position, settings) with a version field; localStorage on the
  web, user data dir elsewhere. Autosave at checkpoints.

## Input
- Map actions, not keys: `{jump: ["Space","KeyW","GamepadA"], move: axes}`. Support keyboard+mouse, gamepad, and touch
  where it runs on phones. Buffer presses (100-150 ms) so early inputs are not lost.
- Mouse look: pointer lock, sensitivity setting, clamp pitch to +-89 deg, yaw on the body, pitch on the camera.

## Cameras
- Third person: spring arm behind and above the target, smoothed follow (`1 - exp(-rate*dt)`), collision pull-in (raycast
  from target to camera), look-ahead in the move direction. First person: camera at eye height 1.6-1.7 m, head bob subtle.
- Top-down/isometric: fixed pitch 45-60 deg, follow with dead zone. 2D platformer: dead zone + look-ahead + vertical
  lock until landing. Screen shake by trauma (decays; offset = trauma^2 * noise).

## Rendering and assets
- Load everything up front behind a loading screen with progress; never block a frame on a fetch.
- Same mesh many times -> instancing (three.js `InstancedMesh`, Godot `MultiMeshInstance3D`, Unity GPU instancing).
- Pool short-lived objects (bullets, particles, enemies) instead of allocating every frame.
- Level of detail and frustum culling for big worlds; chunk worlds into tiles/cells; spatial hash or grid for
  neighbour queries (O(n) instead of O(n^2)).
- Lighting: one key light with shadows (tight shadow camera), hemisphere/ambient fill, an environment map for PBR
  metals; tone mapping (ACES/AgX) with sRGB output. Pixel art: nearest filtering, integer scaling.

## Content
- Levels as data (tile maps, JSON, scenes), not hard-coded coordinates in logic. Spawners with wave tables.
- Difficulty curve: introduce one mechanic at a time, then combine; a breather after every peak.
- Win and lose conditions, score/progress, restart without reloading the page, settings (volume, sensitivity), credits.

## Performance budget (60 fps = 16.6 ms)
- Web: < 200 draw calls, < 1-2 M triangles on desktop (much less on phones), no per-frame allocations in hot loops,
  textures power of two and compressed where possible. Profile before optimising: the browser performance tab, engine
  profilers (Godot Monitors, Unity Profiler).
