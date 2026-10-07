# Movement — Godot 4 (2D and 3D)

Movement is the first thing a player feels. Good movement is tuned, not
derived: build it with exported knobs, then play it and read the numbers
with `run` + `state`/`assert`.

## The canonical bodies

| Need | Node | Move with |
|---|---|---|
| Player / NPC you control | `CharacterBody3D` / `CharacterBody2D` | set `velocity`, call `move_and_slide()` |
| Thing physics should throw around | `RigidBody3D` / `RigidBody2D` | `apply_force`, `apply_impulse`, or `_integrate_forces` |
| Moving platform / door | `AnimatableBody3D` / `AnimatableBody2D` | animate `position` (sync_to_physics on) |
| Level geometry | `StaticBody3D` / `StaticBody2D` | don't |

Never set a RigidBody's `position` every frame — it fights the solver. Never
`move_and_slide()` a RigidBody. Never expect a `Node3D` without a body to
collide.

## 3D character controller (the reference template)

```gdscript
extends CharacterBody3D

@export var speed := 6.0
@export var sprint_multiplier := 1.6
@export var acceleration := 40.0          # how fast we reach target speed on ground
@export var air_acceleration := 12.0      # less control in the air
@export var friction := 50.0              # ground stop
@export var jump_velocity := 7.0
@export var gravity_multiplier := 1.0
@export var fall_multiplier := 1.6        # faster fall than rise = snappier jump
@export var coyote_time := 0.12           # seconds you can still jump after leaving a ledge
@export var jump_buffer := 0.12           # seconds a jump press is remembered before landing
@export var max_fall_speed := 40.0

var gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity")
var _coyote := 0.0
var _buffer := 0.0

@onready var camera_pivot: Node3D = $CameraPivot   # yaw pivot; camera is a child


func _physics_process(delta: float) -> void:
	# --- timers
	_coyote = coyote_time if is_on_floor() else max(0.0, _coyote - delta)
	_buffer = jump_buffer if Input.is_action_just_pressed("jump") else max(0.0, _buffer - delta)

	# --- gravity
	if not is_on_floor():
		var g := gravity * gravity_multiplier
		if velocity.y < 0.0:
			g *= fall_multiplier
		velocity.y = max(velocity.y - g * delta, -max_fall_speed)

	# --- jump (buffered + coyote)
	if _buffer > 0.0 and _coyote > 0.0:
		velocity.y = jump_velocity
		_buffer = 0.0
		_coyote = 0.0
	# variable jump height: cut the rise when the button is released
	if Input.is_action_just_released("jump") and velocity.y > 0.0:
		velocity.y *= 0.5

	# --- horizontal, relative to the camera's yaw
	var input := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	var basis := camera_pivot.global_transform.basis
	var dir := (basis.x * input.x + basis.z * input.y)
	dir.y = 0.0
	dir = dir.normalized()
	var target_speed := speed * (sprint_multiplier if Input.is_action_pressed("sprint") else 1.0)
	var accel := acceleration if is_on_floor() else air_acceleration
	var horizontal := Vector3(velocity.x, 0.0, velocity.z)
	if dir.length() > 0.0:
		horizontal = horizontal.move_toward(dir * target_speed, accel * delta)
	else:
		horizontal = horizontal.move_toward(Vector3.ZERO, (friction if is_on_floor() else air_acceleration * 0.5) * delta)
	velocity.x = horizontal.x
	velocity.z = horizontal.z

	move_and_slide()
```

Required input actions: `move_left/right/forward/back`, `jump`, `sprint`.
Add them with `mutate {ops:[{op:"input.add", action:"move_forward", keys:["W"]}, ...]}`.

Tuning targets that feel good as defaults: speed 5–8 m/s, jump apex ~1.2 m
(`jump_velocity ≈ sqrt(2 * g * apex_height)`), time-to-apex 0.35–0.45 s,
fall 1.5–2× faster than rise. Verify with a run:

```
run {steps:[ "wait 400", {state:"Player"}, {press:"jump"}, "wait 120",
  {assert:{path:"Player", prop:"velocity.y", op:">", value:3, label:"rising"}},
  "wait 700", {assert:{path:"Player", prop:"is_on_floor", op:"truthy", label:"landed"}},
  {hold:["move_forward"], ms:800}, {state:"Player"}, {screenshot:"moved"} ]}
```

## Camera rigs

**Third person (orbit):** `CharacterBody3D > CameraPivot (Node3D) > SpringArm3D > Camera3D`.
Yaw rotates the pivot (`rotate_y(-relative.x * sens)`), pitch rotates the
SpringArm (clamp −60°..+30°). `SpringArm3D.spring_length` is the distance
and it collision-shrinks automatically (set its collision_mask to the level
layer). Capture the mouse: `Input.mouse_mode = Input.MOUSE_MODE_CAPTURED`
and handle `InputEventMouseMotion` in `_unhandled_input`.

**First person:** `CharacterBody3D > Head (Node3D, at eye height) > Camera3D`.
Yaw the body (`rotate_y`), pitch the head. Mouse sensitivity 0.002–0.004
rad/px. Add head-bob only after the base feels right.

**Top-down / isometric 3D:** camera as a sibling that lerps toward the
player (`global_position = global_position.lerp(target, 1.0 - exp(-smoothing * delta))`);
exp-lerp is frame-rate independent, `lerp(a, b, 0.1)` is not.

**Side-scroller 2D:** `Camera2D` as a child of the player with
`position_smoothing_enabled`, `limit_*` set to the level bounds, and a
`drag_*_margin` so small moves don't scroll.

Verify any camera with two screenshots after moving/turning; cameras are the
most common "code runs, looks wrong" bug.

## 2D platformer controller

```gdscript
extends CharacterBody2D

@export var speed := 220.0
@export var acceleration := 1800.0
@export var friction := 2200.0
@export var jump_velocity := -420.0      # negative = up in 2D
@export var fall_multiplier := 1.8
@export var coyote_time := 0.1
@export var jump_buffer := 0.1
@export var max_fall := 900.0

var gravity: float = ProjectSettings.get_setting("physics/2d/default_gravity")
var _coyote := 0.0
var _buffer := 0.0
@onready var sprite: AnimatedSprite2D = $AnimatedSprite2D


func _physics_process(delta: float) -> void:
	_coyote = coyote_time if is_on_floor() else _coyote - delta
	_buffer = jump_buffer if Input.is_action_just_pressed("jump") else _buffer - delta
	if not is_on_floor():
		velocity.y = min(velocity.y + gravity * (fall_multiplier if velocity.y > 0 else 1.0) * delta, max_fall)
	if _buffer > 0 and _coyote > 0:
		velocity.y = jump_velocity
		_buffer = 0; _coyote = 0
	if Input.is_action_just_released("jump") and velocity.y < 0:
		velocity.y *= 0.5
	var dir := Input.get_axis("move_left", "move_right")
	velocity.x = move_toward(velocity.x, dir * speed, (acceleration if dir != 0 else friction) * delta)
	if dir != 0:
		sprite.flip_h = dir < 0
	sprite.play("run" if dir != 0 and is_on_floor() else "jump" if not is_on_floor() else "idle")
	move_and_slide()
```

2D is in pixels: gravity 980 px/s², speeds 150–300 px/s, jump −350..−500.
Set `floor_snap_length` (~8 px) so slopes don't launch the player; set
`floor_max_angle` for what counts as a slope.

## Dash, wall-jump, climb — patterns

- **Dash:** on press, store a direction, set `velocity = dir * dash_speed`,
  start a timer (0.15–0.25 s) during which gravity is off and input is
  ignored; end with a short cooldown. Add `i-frames` via a collision-layer swap.
- **Wall jump:** `is_on_wall_only()` + `get_wall_normal()`; jump velocity =
  `normal * push + up * jump`. Lock horizontal input for ~0.15 s after.
- **Ledge grab / climb:** two raycasts: chest ray hits wall, head ray free →
  snap to ledge, play animation, then move up+forward.
- **Slopes (3D):** `floor_max_angle` (default 45°), `floor_snap_length`
  0.3–0.5 m, `floor_stop_on_slope = true` to not slide down idle.
- **Moving platforms:** `CharacterBody` rides `AnimatableBody` automatically
  when `platform_on_leave` is default; for rotating platforms set
  `platform_floor_layers`.

## Reading the result

`run` gives you `physics.state` (position, velocity, `is_on_floor`,
`is_on_wall`) and screenshots. A movement task is *done* when:

1. `check` passes (no parse/boot errors),
2. `run` asserts prove the behaviour (rises, lands, stops, doesn't clip),
3. a screenshot shows the character where it should be,
4. you reported the actual numbers (speed, apex, time-to-land).

If any of those is missing, say which, and why.

## Research hooks

- `docs {class:"CharacterBody3D", section:"move_and_slide"}` for the contract
  (it uses `velocity`, returns whether it collided, updates `is_on_floor`).
- `docs {page:"tutorials/physics/using_character_body_2d"}`.
- `video {search:"godot 4 platformer movement coyote time jump buffer"}` and
  read the transcript for tuning ranges real devs use.
- GDQuest "3D character controller" and KidsCanCode "3D platformer" recipes.
