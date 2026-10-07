---
name: godot
description: Build and verify Godot 4 games — live editor bridge, offline scene/script editing, headless checks, instrumented play sessions with screenshots + input scripting, procedural 3D assets, docs lookup, YouTube transcript watching, asset discovery.
status: active
version: 1
provides: godot/health, scene/inspect, scene/mutate, godot/check, game/run, scene/render, asset/generate, reference/docs, reference/video, reference/discover
---

# Godot game forge

You are working in a Godot 4 project. This skill is a **capability provider**:
every operation below is reached through the `Capability` tool
(`action: invoke`, `provider_id: ares/godot`, `operation: <name>`,
`target_root: <project dir>`, `arguments: {...}`). Read
`references/*.md` in this directory when a task touches that topic —
they are the part of this skill that makes you *understand* games, not
just drive the engine.

| Topic | Read |
|---|---|
| player movement 2D/3D, jump feel, camera rigs | `references/movement.md` |
| physics bodies, collisions, layers, raycasts, areas | `references/physics.md` |
| game mechanics: state machines, health, inventory, save, UI, audio, scenes | `references/mechanics.md` |
| 3D models: procedural meshes, glTF/OBJ import, materials, collision, animation | `references/assets-3d.md` |
| Godot 4 gotchas that silently break code | `references/gotchas.md` |
| pulling references: docs, videos, asset sources, how to research a mechanic | `references/research.md` |
| two agents / two people building one project | `references/team.md` |

## The loop (never skip a step)

1. **Observe first.** `inspect what:project`, then `inspect what:tree` for the scene you will touch. Never edit a scene you have not read; never guess a node path.
2. **Research before inventing.** For any API you are not 100% sure of: `docs {class, section}`. For any *feel* question ("how should a dash feel", "what makes a good camera"): `references/research.md` → `video {search}` → `video {url}` and read what experienced devs do. Reference-driven work beats first-principles guessing.
3. **Mutate through the provider** (`mutate`), not by hand-writing `.tscn` text with Write. The provider keeps ext_resources, load_steps, ownership and connections valid, and uses the live editor when it is open so the owner can watch.
4. **Check headless** (`check`) after every batch of script edits. A parse error reported by Godot is the truth; your reading of the code is not.
5. **Run and look** (`run` with steps + screenshots, or `screenshot`). Then *Read the PNG files* — you can see images. Compare what you see with what was asked. Movement/physics claims need an `assert` or a `state` read, not vibes.
6. **Report what the engine said**, including warnings. "check passed, run healthy, screenshot shows X" is a result. "should work" is not.

## Operation cheat sheet

```
health                       {}                                   → mode: live-editor | live-game | offline, godot path, bridge status
locate                       {}                                   → where the Godot exe is
install                      {version?: "4.3", mono?: bool, dir?, force?}   → download + verify + extract the official engine when none is found
inspect                      {what: project|tree|node|inputmap|scripts|assets|signals|find|class|selection|scene-file,
                              scene?: "res://...", path?: "Player/Camera3D", props?: [...], pattern?, type?, class?}
mutate                       {scene?: "res://...", save?: true, ops: [
                                {op:"scene.new", path:"res://scenes/main.tscn", root_type:"Node3D", name:"Main", main:true},
                                {op:"node.add", parent:".", type:"CharacterBody3D", name:"Player", props:{"position":"Vector3(0, 1, 0)"}, script:"res://player.gd"},
                                {op:"node.add", parent:"Player", type:"CollisionShape3D", name:"Shape", props:{"shape":{"$var":"SubResource(\"x\")"}}},
                                {op:"scene.instance", parent:".", scene:"res://enemy.tscn", name:"Enemy", props:{...}},
                                {op:"node.set", path:"Player", props:{"floor_max_angle":0.8}},
                                {op:"node.remove", path:"Old"}, {op:"node.rename", path:"A", name:"B"},
                                {op:"script.create", path:"res://player.gd", content:"extends CharacterBody3D\n...", attach_to:"Player"},
                                {op:"script.attach", path:"Player", script:"res://player.gd"},
                                {op:"signal.connect", from:"Button", signal:"pressed", to:".", method:"_on_button_pressed"},
                                {op:"input.add", action:"jump", keys:["SPACE"], joy_buttons:[0]},
                                {op:"project.set", key:"physics/3d/default_gravity", value:12.0}
                              ]}
check                        {scripts?: [..]|false, boot?: true, scene?: "res://...", build?: true}   → parse + boot diagnostics
run                          {scene?: "res://...", steps:[ "wait 500", {press:"jump"}, {hold:["move_right"], ms:800},
                                {state:"Player"}, {assert:{path:"Player", prop:"velocity.y", op:">", value:0, label:"jumped"}},
                                {screenshot:"after-jump"}, {get:"Player", props:["global_position"]}, {call:{path:"Player", method:"take_damage", args:[10]}},
                                {mouse:{x:400,y:300,button:1}}, {key:"ESCAPE"}, {timeScale:0.25}, {stats:true} ],
                              timeoutMs?: 90000, keepAlive?: false, headless?: false, attach?: true}
screenshot                   {source: "editor"|"game"|"auto", view: "3d"|"2d", label?, focus?: "Player"}
asset                        {kind: box|plane|cylinder|cone|sphere|capsule|torus|terrain|lathe|extrude|stairs|ramp|wedge|arch|pipe|download|terrain-script,
                              name, params:{...}, dir?: "res://assets/generated", collision?: trimesh|convex|only|rigid,
                              material?: {color:[r,g,b], roughness, metallic}, transform?: {scale, translate, rotateY},
                              parts?: [{kind, params, transform}], url? (download)}
docs                         {class: "CharacterBody3D", section?: "move_and_slide"} | {page: "tutorials/physics/using_character_body_2d"} | {query: "coyote"}
video                        {search: "godot 4 third person camera"} | {url: "...", from?: 120, to?: 400}
discover                     {source: all|assetlib|polyhaven|polyhaven-files|sources, query, type?: addon|project|models|textures|hdris, id?}
```

Scene node paths are relative to the scene root (`"."` is the root,
`"Player/Camera3D"` a child). Vector/Color/Transform values are written as
Godot literals in strings: `"Vector3(0, 1, 0)"`, `"Color(1, 0.5, 0, 1)"`.
Resources are `"res://..."` strings (auto-loaded) or `{"$res": "res://..."}`.

## Modes

- **live-editor** — the project is open in Godot with the Ares bridge addon
  enabled (`ares godot init <project>` installs it). Mutations happen in the
  real editor, the owner watches them land, and `screenshot source:editor`
  shows the viewport. Prefer this when a human is around.
- **live-game** — a `run` left `keepAlive:true`, so later `run` calls attach
  and keep driving the same session.
- **offline** — editor closed. Scenes/scripts/project.godot are edited on
  disk, `check` and `run` launch headless/windowed Godot themselves. Fully
  sufficient for agent-only work; this is the normal mode in CI or when two
  agents share a repo.

## Rules of the craft

- **Scripts in `.gd` (or `.cs`), structure in `.tscn`.** Keep scenes thin and
  scripts testable. Export tunables (`@export var jump_velocity := 4.5`) so
  the owner can tweak in the inspector and you can `node.set` them in runs.
- **One scene per reusable thing** (player, enemy, pickup, UI panel). Instance
  them; do not duplicate node trees.
- **Signals up, calls down.** Children emit signals; parents call methods on
  children. Never reach into siblings with hard-coded paths from deep scripts.
- **Input through actions**, never raw keys in gameplay code. Add actions with
  `input.add` and verify them with `inspect what:inputmap`.
- **Physics in `_physics_process`, visuals in `_process`.** Use `delta`.
- **Prefer `CharacterBody*` for controlled things, `RigidBody*` for simulated
  things, `StaticBody*`/`AnimatableBody*` for level.** Mixing them is the #1
  cause of "it jitters".
- **After any movement/physics change, run with asserts**: does it jump, does
  it land, does it stop. Then screenshot. Then report numbers.
- **New assets → import check.** After generating or downloading an asset,
  `check` (headless import) so Godot writes `.import` metadata before a scene
  references it.
- When something feels wrong and you cannot see why, **slow time**
  (`{timeScale:0.2}`) and screenshot in sequence; or read `physics.state`
  each 100 ms. Do not guess at physics.

## When the engine is missing

`health` reports `godot: null`. **Provision it yourself**: `install {}`
downloads the official release matching the project (`version` and `mono`
default from `project.godot`; pass `mono:true` for C# projects), verifies
the SHA-512 against the published sums, extracts it under `~/.ares/godot/engine/`
and remembers it — Godot is MIT-licensed, so this is Ares carrying its own
engine. Tell the owner it happened (size ≈ 55–105 MB). If the owner prefers a
specific exe, `ares godot init --godot <path>` remembers that instead.

## Scope guard

This provider edits the Godot project under `target_root` and launches Godot
from the located executable. It never touches other projects, never installs
engine versions, never publishes. Downloads only go to `res://` dirs you name.
