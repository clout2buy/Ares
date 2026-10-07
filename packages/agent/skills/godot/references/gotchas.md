# Godot 4 gotchas (things that compile and still fail)

Read this before writing GDScript. Each item has bitten agents in practice.

## Lifecycle & node access

- `@onready var x = $Path` resolves after the node enters the tree. Accessing it
  in `_init` or from another node's `_ready` that runs earlier → null. Parents'
  `_ready` runs **after** children's; siblings in tree order.
- `get_node("Path")`/`$Path` is relative to the node the script is on, not the
  scene root. `%UniqueName` needs "Access as Unique Name" (`unique_name_in_owner`)
  set in the scene (`node.set {props:{"unique_name_in_owner":true}}`).
- `owner` is the scene root for nodes saved in that scene; it is `null` for
  nodes added at runtime unless you set it (only matters for saving/packing).
- `queue_free()` is deferred; `is_instance_valid(x)` before using a reference
  that may have been freed; never `free()` a node during a signal from it.
- `add_child` during `_ready` of the parent is fine; during a physics callback
  (e.g. `body_entered`) use `call_deferred("add_child", n)` / `add_child.call_deferred(n)`
  — "Parent node is busy setting up children" otherwise. Same for changing
  `monitoring`, `collision_layer`, `disabled` on shapes inside physics callbacks
  (`set_deferred("monitoring", false)`).
- Autoloads are accessed by their name (`Events.x`), not `$Events`; they live
  under `/root`. A script `class_name` cannot match an autoload name.
- `get_tree().current_scene` is the root scene; adding bullets to the shooter
  makes them move with it — add to `get_tree().current_scene` or a dedicated
  `Projectiles` node.

## GDScript 2 syntax that changed from Godot 3

- `yield` → `await`; `.connect("sig", self, "fn")` → `sig.connect(fn)`;
  `instance()` → `instantiate()`; `export` → `@export`; `onready` → `@onready`;
  `tool` → `@tool`; `setget` → property `set(v):`/`get:`; `KinematicBody` →
  `CharacterBody`; `move_and_slide(velocity)` → set `velocity`, call `move_and_slide()`
  with no args; `Spatial` → `Node3D`; `PoolStringArray` → `PackedStringArray`;
  `rand_range` → `randf_range`; `OS.get_ticks_msec` → `Time.get_ticks_msec`;
  `deg2rad` → `deg_to_rad`; `Transform` → `Transform3D`; `Quat` → `Quaternion`.
- Integer division: `7 / 2 == 3`; write `7.0 / 2`. `int / int` warning is real.
- Typed arrays: `var a: Array[int] = []`; `Array[Node]` cannot hold `null`
  issues aside, assigning an untyped array to a typed var errors.
- Lambdas capture by value for locals: `var f = func(): return x` snapshots `x`.
- `match` needs `_:` for default; a `match` on strings is case-sensitive.
- String formatting: `"%s has %d hp" % [name, hp]` or `"{a}".format({"a": 1})`.
- `static func` can't access instance members; `static var` exists (4.1+).
- `signal hit(amount: int)` then `hit.emit(5)`; `emit_signal("hit", 5)` still works.
- `await signal` inside `_process` stalls that frame only for that coroutine;
  `await get_tree().create_timer(1.0).timeout` is the sleep idiom. A function
  that awaits returns a coroutine — callers that need the result must `await` it.
- `Callable`: `my_fn.bind(arg)` to pre-bind; `.call()`; `.callv([args])`.
- Enums: `enum State {IDLE, RUN}`; typed `var s: State = State.IDLE`.
- No ternary `? :` — use `a if cond else b`.
- `@export_range(0, 10, 0.1)`, `@export_enum("A","B")`, `@export_node_path("Node3D")`,
  `@export var scene: PackedScene`, `@export_group("Jump")`.

## Physics-specific

- `move_and_slide()` must run in `_physics_process`; `is_on_floor()` is only
  valid after it. Setting `position` directly on a CharacterBody skips collision.
- `velocity` is in units/second — do not multiply by `delta` when assigning
  it; `move_and_slide` applies delta internally. Only accelerations × delta.
- Area signals need `monitoring`/`monitorable` and overlapping **masks**;
  the most common "my pickup doesn't trigger" is a mask that excludes the
  player's layer.
- Collision shapes with `scale` ≠ 1 misbehave; shapes on a scaled parent too.
- Changing `collision_layer` of a body takes effect next physics frame.
- `RayCast3D` is updated at physics time; after moving it, call `force_raycast_update()`
  to query immediately.
- Trimesh (`ConcavePolygonShape3D`) on a RigidBody = no collision (static only).
- Tiny fast objects tunnel: `continuous_cd` or a raycast-based bullet.

## Resources & scenes

- `preload` paths must be constant strings; `load` at runtime. A missing
  resource prints `Failed to load resource` once and returns null — check.
- Resources are **shared by reference**: modifying `mesh.material.albedo_color`
  on one instance changes all. `resource_local_to_scene = true` or `.duplicate()`.
- `PackedScene.instantiate()` each time you need a copy; instancing the same
  node twice (`add_child(n)` on an already-parented node) throws.
- `.tscn` references by `uid://` survive moves; `res://` paths don't. When
  moving files, do it in the editor (or fix `ext_resource path=` lines).
- `ProjectSettings.set_setting` needs `ProjectSettings.save()` and some
  settings only apply after restart (renderer, physics engine).
- `user://` for writable files; `res://` is read-only in exports.
- `.import` sidecar files are generated — never write them; commit them for
  speed but they regenerate.

## Editor / `@tool`

- A `@tool` script runs in the editor; guard side effects with
  `if Engine.is_editor_hint():`. Infinite loops in `_process` freeze the editor.
- Setters on `@export` vars run on load in `@tool` scripts before `_ready`
  (`is_inside_tree()` false) — guard rebuilds.
- Editor plugin scripts (`extends EditorPlugin`) can't be instanced in games.

## Headless / CI

- `--headless` has no rendering: `get_viewport().get_texture()` returns an
  empty image; screenshots need a windowed run (the provider's `run` is
  windowed by default).
- `--check-only --script res://x.gd` parses one script; it does not catch
  errors that only appear when the scene loads (missing nodes, bad paths) —
  the provider's boot check covers those.
- C# projects: build with `dotnet build` first; Godot needs the .NET-enabled
  binary (`Godot_v4.x-stable_mono_win64.exe`).

## Rendering

- Magenta = shader compile error; check the `.gdshader` with `check`.
- Something invisible: `visible`, `layers` (visual layers vs camera `cull_mask`),
  camera `near/far`, material `cull_mode`, normals inverted, scale 0, or it is
  behind the camera (Godot cameras look down **-Z**).
- Lights: `DirectionalLight3D` only lights if `shadow` is off or shadow map
  sized; `OmniLight3D` range in metres. Forward+ caps 8 lights/mesh.
- 2D: `z_index` / tree order decide draw order; `y_sort_enabled` on the
  parent for top-down depth.
- `Control` nodes under `Node2D` ignore anchors — put UI under a `CanvasLayer`.

## Input

- `Input.is_action_just_pressed` in `_process` vs `_physics_process`: with
  physics at 60 and frames at 144, a just-pressed read in `_physics_process`
  can be missed; read in `_unhandled_input` or `_process` and store a flag, or
  rely on `Input.is_action_just_pressed` in `_physics_process` only when
  frame rate ≥ tick rate (fine for most). The provider's `press` holds for
  120 ms by default so a tick always sees it.
- `_input` fires before UI; `_unhandled_input` after. Gameplay belongs in
  `_unhandled_input`, otherwise clicks on buttons also fire.
- Mouse captured mode hides the cursor; remember to release on pause/menu.
- Gamepad: `InputEventJoypadMotion` deadzone from the action's `deadzone`;
  `Input.get_vector` already applies it.

## Export / platform

- Web export can't use threads by default and no `OS.execute`; `gl_compatibility`.
- Mobile: no `SDFGI`, keep textures ≤ 2k, use `mobile` renderer.
- Windows export needs rcedit for icons (editor setting); not needed to run.
