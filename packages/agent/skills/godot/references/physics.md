# Physics — Godot 4

Godot's physics is deterministic per tick (`physics/common/physics_ticks_per_second`,
default 60). Everything that moves physically belongs in `_physics_process(delta)`.

## Bodies and shapes

- Every physics body needs a `CollisionShape3D`/`2D` child with a `shape`
  resource (`BoxShape3D`, `CapsuleShape3D`, `SphereShape3D`, `CylinderShape3D`,
  `ConvexPolygonShape3D`, `ConcavePolygonShape3D` (trimesh, static only),
  `WorldBoundaryShape3D`; 2D: `RectangleShape2D`, `CircleShape2D`,
  `CapsuleShape2D`, `ConvexPolygonShape2D`, `CollisionPolygon2D` node).
- Characters: **capsule**, never a box (boxes catch on edges). Radius ≈ 0.4 m,
  height ≈ 1.8 m, origin at feet means the shape is offset up by height/2.
- Mesh collision for levels: `MeshInstance3D` → `create_trimesh_collision()`
  (static) or import with the `-col` name suffix. Trimesh only for static.
  Moving things need convex (or `-convcol`, which decomposes).
- `RigidBody3D` with `ConcavePolygonShape3D` silently does nothing — use convex.

Offline, shapes are sub_resources in the `.tscn`:
```
[sub_resource type="CapsuleShape3D" id="CapsuleShape3D_1"]
radius = 0.4
height = 1.8
...
[node name="Shape" type="CollisionShape3D" parent="Player"]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.9, 0)
shape = SubResource("CapsuleShape3D_1")
```
The provider's `node.set` accepts `{"shape": {"$var": "SubResource(\"CapsuleShape3D_1\")"}}`
if the sub_resource already exists; in live mode pass a built-in shape via
`node.call {method:"set_shape", args:[...]}` or, simplest, create the shape in a
script `_ready` (`$Shape.shape = CapsuleShape3D.new()`) with exported dims.

## Layers and masks (the model of who hits whom)

- `collision_layer`: what I **am**. `collision_mask`: what I **scan/collide with**.
- A collision happens when A.mask has B.layer **or** B.mask has A.layer (for
  bodies); areas detect bodies whose layer is in the area's mask.
- Name the layers in Project Settings (`layer_names/3d_physics/layer_1 = "world"`)
  and use constants. Common set: 1 world, 2 player, 3 enemies, 4 projectiles,
  5 pickups, 6 triggers, 7 player-hurtbox, 8 enemy-hurtbox.
- Bits: layer N = `1 << (N-1)`. Layers 1+3 = `0b101` = 5. Set via
  `node.set {props:{"collision_layer":2, "collision_mask":5}}` or
  `set_collision_layer_value(3, true)`.
- Projectiles that must not hit their shooter: exclude via layers (shooter's
  layer not in projectile mask) or `add_collision_exception_with(shooter)`.

## Detecting things

| Need | Use |
|---|---|
| Trigger volume / pickup / hurtbox | `Area3D` + `body_entered`/`area_entered` signals (`monitoring` on) |
| Line of sight, ground check, aim | `RayCast3D` (`is_colliding()`, `get_collider()`, `get_collision_point()`), or `PhysicsDirectSpaceState3D.intersect_ray` for ad-hoc |
| Shape sweep (will I fit) | `ShapeCast3D`, or `PhysicsDirectSpaceState3D.intersect_shape` |
| What did I just slide against | after `move_and_slide()`: `get_slide_collision_count()`, `get_slide_collision(i).get_collider()` |
| Overlaps now | `Area3D.get_overlapping_bodies()` (needs one physics frame after entering the tree) |

Space-state queries must run in `_physics_process` (or after `await get_tree().physics_frame`):
```gdscript
var space := get_world_3d().direct_space_state
var q := PhysicsRayQueryParameters3D.create(from, to, collision_mask, [self.get_rid()])
var hit := space.intersect_ray(q)   # {} if nothing; else position, normal, collider, rid
```

## RigidBody feel

- Mass, `gravity_scale`, `linear_damp`, `angular_damp`, `PhysicsMaterial`
  (friction, bounce, rough, absorbent). Set `continuous_cd = true` for fast
  small bodies (bullets) so they don't tunnel.
- Force vs impulse: `apply_central_force` every tick (continuous push),
  `apply_central_impulse` once (hit). `apply_impulse(impulse, position)` adds spin.
- To drive a RigidBody like a vehicle/hover: `_integrate_forces(state)` and
  modify `state.linear_velocity`; never write `linear_velocity` from `_process`.
- `freeze = true` + `freeze_mode = FREEZE_MODE_KINEMATIC` turns it into a
  pushable animatable body (good for pickups being carried).
- `sleeping` bodies ignore forces until woken: `sleeping = false` or `can_sleep = false`.

## Vehicles, ragdolls, joints

- `VehicleBody3D` + four `VehicleWheel3D` (set `use_as_traction`, `use_as_steering`,
  suspension travel ~0.2, stiffness ~40, wheel radius from the mesh). Engine
  force 200–600 for a 1-ton body; brake 5–20; steering ±0.5 rad.
- Ragdoll: `Skeleton3D` → "Create physical skeleton" in the editor (not scriptable
  offline); then `physical_bones_start_simulation()`.
- Joints: `PinJoint3D`, `HingeJoint3D` (doors), `SliderJoint3D`, `Generic6DOFJoint3D`;
  set `node_a`/`node_b` to body paths.

## Determinism & performance

- Keep tick rate 60; raise to 120 only for fighting/racing games. Use
  `Engine.physics_jitter_fix` default and `physics/common/physics_interpolation`
  (4.3+) to smooth visuals at low tick rates.
- Hundreds of RigidBodies: use `MultiMeshInstance3D` for visuals and sleep
  aggressively; or fake it with `AnimatableBody`.
- 2D: Jolt is 3D only. 3D: Jolt is the default in 4.4+ (`physics/3d/physics_engine`);
  Godot Physics for older. Jolt behaves better with stacked/thin bodies.
- Scale: never scale physics bodies non-uniformly; scale the mesh instead.
  Shapes don't support negative scale.

## Verifying physics with the provider

```
run {steps:[ "wait 300",
  {assert:{path:"Crate", prop:"sleeping", op:"falsy"}},
  {call:{path:"Crate", method:"apply_central_impulse", args:["Vector3(0, 6, 0)"]}},
  "wait 150", {assert:{path:"Crate", prop:"linear_velocity.y", op:">", value:1, label:"launched"}},
  "wait 1500", {state:"Crate"}, {screenshot:"crate-landed"} ]}
```
When a body falls through the floor: check that the floor has a body + shape,
that layers/masks overlap, that the shape is not a RigidBody trimesh, and that
the spawn position isn't inside the floor (set `safe_margin` 0.001–0.01).

## Research hooks

- `docs {class:"PhysicsBody3D"}`, `{class:"RigidBody3D", section:"_integrate_forces"}`,
  `{class:"Area3D", section:"body_entered"}`, `{page:"tutorials/physics/physics_introduction"}`,
  `{page:"tutorials/physics/ray-casting"}`, `{page:"tutorials/physics/collision_shapes_3d"}`.
