---
name: gamedev
description: Build games in any stack at a senior level - web (HTML/JS, three.js, canvas, Phaser), Godot, Java (LibGDX, LWJGL, Minecraft mods), Unity, Unreal, Pygame, LOVE, Roblox, Bevy. Real physics (vehicles, characters, projectiles, ragdolls), how real things are built (a car has 4 wheels on 2 axles), game feel, AI, and surgical fixes when the owner points at something.
status: active
version: 1
---

# Game development, any stack

Read the reference that matches the task (same folder as this file, `references/`). They are dense on purpose:
numbers, formulas, APIs and the bugs that bite. Do not re-derive what is written there.

| Need | Read |
|---|---|
| loop, timestep, states, input, cameras, saving, performance | `references/architecture.md` |
| physics: units, integrators, characters, **vehicles**, projectiles, water, ropes, ragdolls | `references/physics.md` |
| what real things are made of: vehicles, buildings, props, creatures, weapons (parts, counts, sizes, how they move) | `references/objects.md` |
| HTML/JS games: three.js, canvas 2D, Phaser, Rapier/cannon-es, WebAudio, gamepad, mobile | `references/web.md` |
| Java: LibGDX, LWJGL, jMonkeyEngine, Java2D, Minecraft (Fabric / NeoForge / Paper) | `references/java.md` |
| Godot, Unity, Unreal, Pygame, LOVE, Roblox, Bevy | `references/engines.md` (+ the `godot` skill for Godot projects) |
| game feel, juice, camera, AI, level design, difficulty | `references/feel.md` |

## How Ares builds a game (fast, complete, once)

1. **Stack in one line.** Match the repo. Greenfield: a single `index.html` with an import map (three.js or canvas)
   unless the owner names an engine. Godot project -> the `godot` skill. Java -> LibGDX (or the modding loader the repo uses).
2. **Know the thing before coding it.** Write the real parts, counts, sizes and rules down first (`objects.md`): a car has 4
   wheels on 2 axles, the front pair steers (Ackermann), the rear or all drive; a bike has 2; a plane has 2 wings, a tailplane
   and a fin; a quadruped walks in a lateral sequence. Units are metres, kilograms, seconds, everywhere.
3. **Skeleton first, all of it:** fixed-timestep loop, input map, game states (menu / play / pause / over), entities, physics,
   render, UI/HUD, audio, save. Then fill each with the real thing - no placeholders, no TODOs, no "basic version".
4. **Real physics** from `physics.md`: correct gravity and scale, colliders that match the visuals, CCD for fast things,
   damping and friction values from the tables.
5. **Feel** from `feel.md`: acceleration curves, coyote time, input buffer, camera smoothing, hit-stop, particles, sound.
6. **Assets:** sculpt models in the Forge (`Browser action:"model"`, `help:true`), then `export` them into the project
   (`ares-model.js` runtime: `loadModel` -> `instance()` -> `play(clip,{fade})` -> `update(dt)`), or procedural meshes in code.
7. **Run it once and play it** (Browser preview / the engine's run): read the console, look at one screenshot, drive the
   controls. Fix what is actually broken. Then report what you ran. One pass, not a re-test loop.

## When the owner points at something: fix it surgically

"The car drives backwards", "the bear's left ear is too low", "jump feels floaty", "you can walk through walls":
1. **Locate** the exact code/data that produces it (Grep the symbol, read the function, the Forge part/blob by name).
   Name the cause in one sentence before editing.
2. **Smallest correct change** at the cause: a sign, a constant, an axis, a collider size, one blob. Do not rewrite the
   file, rename things, restyle code, or "improve" what was not mentioned. Everything else keeps working exactly as it did.
3. **Check that one thing** (one run, one screenshot, one eval) and say what changed: `fixed: wheels spun on the X axis ->
   now Z (car.js:142)`. No extra test passes over the rest.
4. If the report is ambiguous, fix the most likely reading and say which one you chose - do not stall to ask.

Common causes worth checking first: wrong axis or sign (forward is -Z in three.js and Godot, +Z in Unity), degrees vs
radians, dt applied twice or not at all, physics in the render loop, collider not matching the mesh (scale applied to the
mesh only), pixels used as metres in Box2D, local vs world space, an event listener added every frame, a missing
`needsUpdate`, z-fighting, and texture colour space.
