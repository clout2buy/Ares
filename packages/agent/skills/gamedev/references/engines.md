# Other engines

## Godot 4 (GDScript)
Use the `godot` skill (SkillRead godot) - it has the live editor provider and deep references. Core facts: physics in
`_physics_process(delta)`; `CharacterBody3D` + `move_and_slide()` with `velocity`; forward is `-transform.basis.z`;
`@export` tunables; signals for events; `Input.get_vector("left","right","forward","back")` with an Input Map;
`VehicleBody3D` + 4 `VehicleWheel3D`; scenes instanced with `preload(...).instantiate()`.

## Unity (C#)
- `Update` for input/visuals, `FixedUpdate` for physics (Rigidbody forces/velocity), `LateUpdate` for cameras.
  Use `Time.deltaTime` in Update, `Time.fixedDeltaTime` implicitly in FixedUpdate.
- Movement: `CharacterController.Move` (kinematic, handles slopes/steps) or `Rigidbody` with `MovePosition` /
  `linearVelocity` (Unity 6; `velocity` before). Forward is +Z (`transform.forward`).
- Physics: colliders + layers + the collision matrix; `Physics.Raycast`; `OnCollisionEnter` (solid) vs `OnTriggerEnter`
  (isTrigger); `Rigidbody.interpolation = Interpolate`, `collisionDetectionMode = ContinuousDynamic` for fast bodies.
  Cars: 4 `WheelCollider`s (motorTorque, steerAngle, brakeTorque, `GetWorldPose` for the wheel meshes).
- New Input System (actions asset, `PlayerInput`), Cinemachine for cameras, ScriptableObjects for data, prefabs for reuse,
  `[SerializeField] private` over public fields, object pooling via `UnityEngine.Pool.ObjectPool`.

## Unreal (C++ / Blueprints)
- Actor/Pawn/Character/PlayerController/GameMode; `Tick(DeltaTime)`; `UPROPERTY(EditAnywhere)` for tunables;
  `UFUNCTION(BlueprintCallable)`; Enhanced Input (Input Actions + Mapping Contexts); Chaos physics, `WheeledVehiclePawn`
  for cars; units are centimetres (gravity -980 cm/s^2). Forward is +X, up is +Z.

## Pygame
- `pygame.init()`, `screen = pygame.display.set_mode((w,h))`, `clock = pygame.time.Clock()`; loop: handle `pygame.event.get()`
  (QUIT), `dt = clock.tick(60)/1000`, update, draw, `pygame.display.flip()`. Sprites with `pygame.sprite.Group`,
  collisions with `spritecollide`/`colliderect`. `convert_alpha()` every loaded image.

## LOVE (Lua)
- `love.load()`, `love.update(dt)`, `love.draw()`, `love.keypressed(key)`; `love.physics` is Box2D (metres:
  `love.physics.setMeter(64)`); `love.graphics.setDefaultFilter("nearest","nearest")` for pixel art.

## Roblox (Luau)
- Server `Script`s in ServerScriptService own state and validation; `LocalScript`s on the client own input, camera and UI;
  talk through `RemoteEvent`/`RemoteFunction` and never trust the client. `RunService.Heartbeat:Connect(function(dt) ... end)`
  for per-frame logic; `Humanoid` for characters; `TweenService` for motion; `DataStoreService` for saves (pcall + retries).
  Units are studs (about 0.28 m), gravity 196.2 studs/s^2.

## Bevy (Rust)
- ECS: components are structs, systems are functions with queries, `App::new().add_plugins(DefaultPlugins)
  .add_systems(Update, move_player)`; `Res<Time>` for `delta_secs()`; physics via `avian` or `bevy_rapier`;
  `FixedUpdate` schedule for simulation.
