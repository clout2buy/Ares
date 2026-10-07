# Game mechanics — Godot 4 patterns

The patterns below are the standard shapes of game code in Godot. Use them so
the project stays readable to the owner, to the other agent, and to you after
compaction.

## Scene architecture

```
res://
  scenes/        main.tscn, levels/level_01.tscn, player/player.tscn, enemies/*.tscn, ui/hud.tscn
  scripts/       (or beside scenes) player.gd, enemy.gd, state_machine.gd
  assets/        models/ textures/ audio/ fonts/ generated/
  autoload/      game.gd (global state), events.gd (signal bus), audio.gd, save.gd
  resources/     items/*.tres, weapons/*.tres  (custom Resource data)
```

- **Autoloads** (`project.set key:"autoload/Events" value:"*res://autoload/events.gd"`)
  for cross-cutting singletons: `Events` (signal bus), `Game` (score, state),
  `Audio` (play SFX by name), `Save`. Keep them small.
- **Signal bus**: `Events.player_died.emit()`; UI/levels connect in `_ready`.
  Avoids spaghetti `get_node("../../HUD")`.
- **Resources as data**: `class_name ItemData extends Resource` with `@export`
  fields; author `.tres` files; reference from scenes. Designers tweak data,
  code stays generic.

## Finite state machine (characters, enemies, game flow)

```gdscript
# state_machine.gd
class_name StateMachine extends Node
@export var initial_state: State
var current: State
func _ready() -> void:
	for child in get_children():
		if child is State:
			child.machine = self
	change(initial_state)
func change(to: State, msg := {}) -> void:
	if current: current.exit()
	current = to
	current.enter(msg)
func _process(delta: float) -> void: current.update(delta)
func _physics_process(delta: float) -> void: current.physics_update(delta)
func _unhandled_input(e: InputEvent) -> void: current.handle_input(e)

# state.gd
class_name State extends Node
var machine: StateMachine
@onready var owner_body: CharacterBody3D = owner
func enter(_msg := {}) -> void: pass
func exit() -> void: pass
func update(_delta: float) -> void: pass
func physics_update(_delta: float) -> void: pass
func handle_input(_e: InputEvent) -> void: pass
```
States as child nodes (`Idle`, `Run`, `Jump`, `Attack`) each `extends State`.
Transition with `machine.change(get_parent().get_node("Jump"))` or `@export var jump_state: State`.
Enemies: `Patrol → Chase → Attack → Hurt → Dead`. Game: `Menu → Playing → Paused → GameOver`.

## Health / damage / hitboxes

```gdscript
class_name Health extends Node
signal changed(current: int, max: int)
signal died
@export var max_health := 100
var current: int:
	set(v):
		var clamped: int = clampi(v, 0, max_health)
		if clamped == current: return
		current = clamped
		changed.emit(current, max_health)
		if current == 0: died.emit()
func _ready() -> void: current = max_health
func damage(amount: int) -> void: current -= amount
func heal(amount: int) -> void: current += amount
```
- Hurtbox = `Area3D` on the victim (layer "player-hurtbox"); Hitbox = `Area3D`
  on the weapon (mask "enemy-hurtbox"); `area_entered` → `area.owner.health.damage(dmg)`.
- Invulnerability frames: timer + flip the hurtbox `monitorable`.
- Knockback: on CharacterBody set `velocity = dir * force`; on RigidBody impulse.
- Damage numbers: spawn a `Label3D`/`Label` and tween up + fade (`create_tween()`).

## Inventory / items

- `ItemData extends Resource` (id, name, icon, stack_size, weight, effects).
- `Inventory extends Node` with `var slots: Array[ItemStack]` and signals
  `changed`, `item_added(item, count)`; methods `add`, `remove`, `has`, `count`.
- UI is a `GridContainer` of `slot.tscn` (TextureRect + Label) rebuilt on `changed`.
- Drag & drop: `Control._get_drag_data`, `_can_drop_data`, `_drop_data`.
- Pickups: `Area3D` + `body_entered` → `body.inventory.add(item_data)` → `queue_free()`.

## Spawning, pooling, projectiles

- `const BULLET := preload("res://scenes/bullet.tscn")`; `var b := BULLET.instantiate()`;
  `get_tree().current_scene.add_child(b)` (NOT as a child of the gun, or it moves with it);
  `b.global_transform = muzzle.global_transform`.
- Projectile: `Area3D` moving `position += -transform.basis.z * speed * delta`
  with `body_entered` → damage → `queue_free()`; or `RigidBody3D` with
  `continuous_cd` for physical ones. Lifetime via `get_tree().create_timer(3.0).timeout.connect(queue_free)`.
- Pooling only when profiling shows instantiate cost; `queue_free` is fine for <100/s.
- Waves: `Timer` + exported `Array[PackedScene]` + `Marker3D` spawn points;
  `Path3D/PathFollow3D` for spawn along a route.

## Scene flow & levels

- `get_tree().change_scene_to_packed(level)` or `change_scene_to_file` for hard cuts.
- For transitions: a `Transition` autoload with a `ColorRect` + `AnimationPlayer`
  (fade out → change scene → fade in). Keep loading synchronous unless a level
  takes >1 s; then `ResourceLoader.load_threaded_request` + a progress bar.
- Persistent player across levels: keep the player under the autoload or
  `reparent` it; or reload the player's state from `Game`.
- Pause: `get_tree().paused = true`; the pause menu node has `process_mode = PROCESS_MODE_WHEN_PAUSED`.
- Checkpoints: store `Game.checkpoint = {level, position}`; on death reload the
  level scene and move the player.

## Save / load

```gdscript
const PATH := "user://save.json"
func save() -> void:
	var data := {"version": 1, "level": Game.level, "player": {"pos": var_to_str(player.global_position), "hp": player.health.current}, "inventory": inventory.to_dict()}
	FileAccess.open(PATH, FileAccess.WRITE).store_string(JSON.stringify(data, "\t"))
func load() -> bool:
	if not FileAccess.file_exists(PATH): return false
	var data = JSON.parse_string(FileAccess.get_file_as_string(PATH))
	...
```
Use `var_to_str`/`str_to_var` for Vectors; JSON cannot hold them. For secure
or binary saves: `ResourceSaver.save(custom_resource, "user://save.tres")`
(do NOT load untrusted `.tres` — scripts can embed). `user://` maps to
`%APPDATA%/Godot/app_userdata/<project>` on Windows.

## UI (Control nodes)

- Root `CanvasLayer` for HUD so it ignores the camera. `Control` anchors +
  containers (`VBoxContainer`, `HBoxContainer`, `MarginContainer`, `GridContainer`,
  `CenterContainer`) — never hand-position UI in pixels.
- Theme: one `Theme` resource at the root `Control` (`theme` prop); override
  per node with `theme_override_*`.
- Health bar: `ProgressBar` or `TextureProgressBar`; bind to `Health.changed`.
- Menus: `Button.pressed` → signals; focus with `grab_focus()` for gamepad;
  `ui_accept`/`ui_cancel` built-in actions.
- Responsive: project `display/window/stretch/mode = "canvas_items"`,
  `aspect = "expand"`; test at 16:9 and 16:10 via `run {width, height}`.
- Dialog: `RichTextLabel` with `visible_characters` tween for typewriter;
  Dialogic/Dialogue Manager addons from `discover {source:assetlib, query:"dialogue"}`.

## Audio

- `AudioStreamPlayer` (2D/3D for positional). Buses in Audio panel:
  Master → Music, SFX, UI. `AudioServer.set_bus_volume_db(idx, linear_to_db(v))`.
- SFX helper autoload: pool of 8 `AudioStreamPlayer`s; `Audio.play("jump")`
  picks a free one; randomize `pitch_scale` 0.9–1.1 for variety.
- Music crossfade: two players + tweens on `volume_db`.
- Looping: set the stream's loop in the import dock (OGG: `loop = true`).

## Animation

- `AnimationPlayer` for authored clips; `AnimationTree` with a
  `AnimationNodeStateMachine` or `BlendTree` for characters
  (`tree.set("parameters/conditions/jumping", true)`, `blend_position` for
  locomotion 2D blend spaces).
- Tweens for juice: `create_tween().tween_property(self, "scale", Vector3.ONE * 1.2, 0.08).set_trans(Tween.TRANS_BACK)`;
  chain `.tween_property(..., Vector3.ONE, 0.12)`. Squash/stretch on land, hit-stop
  (`Engine.time_scale = 0.05` for 60 ms via a timer — timers must be
  `process_always` / use `await get_tree().create_timer(0.06, true, false, true).timeout`),
  camera shake (random offset decaying), screen flash (`ColorRect` modulate).
- Sprites: `AnimatedSprite2D` with `SpriteFrames`; `Sprite3D` billboards for 2.5D.

## Enemies / AI

- `NavigationRegion3D` baked (editor) or `NavigationServer3D.region_bake_navigation_mesh`
  at runtime; `NavigationAgent3D.target_position = player.global_position`,
  `velocity = (agent.get_next_path_position() - global_position).normalized() * speed`,
  call `agent.set_velocity(velocity)` when avoidance is on.
- Perception: `RayCast3D` for line of sight + `Area3D` vision cone + angle check
  (`dir.angle_to(-basis.z) < fov/2`).
- Behaviour: FSM above; for more, Beehave / LimboAI from the asset library.
- Difficulty: tune via exported `Resource` (speed, hp, damage) per enemy type.

## Multiplayer (when asked)

- `ENetMultiplayerPeer` (`create_server(port)`, `create_client(ip, port)`),
  `multiplayer.multiplayer_peer = peer`. `MultiplayerSpawner` + `MultiplayerSynchronizer`
  for replication; `@rpc("any_peer", "call_local")` for actions. Authority:
  `set_multiplayer_authority(peer_id)`; only the authority runs input.
- Test locally: `run` twice with `keepAlive:true` on different runtime ports is
  not supported by one project config — launch the second instance via
  Bash with `ARES_GODOT_RUNTIME=0`.

## Juice checklist (what makes it feel like a game)

Screen shake on hits · hit-stop · squash/stretch · particles on land/hit
(`GPUParticles3D` one-shot) · trail (`Line2D`/`Trail`) · sound on every action ·
camera lead in movement direction · coyote time + jump buffer · input remap menu ·
pause menu · death/restart in <1 s · a main menu · a win condition.

## Verify with the provider

Mechanics claims are verified by **state**, not screenshots alone:
```
run {steps:[ {call:{path:"Player/Health", method:"damage", args:[30]}},
  {get:"Player/Health", props:["current"]}, {screenshot:"hud-after-damage"} ]}
```
Then Read the screenshot and confirm the HUD bar actually moved.
