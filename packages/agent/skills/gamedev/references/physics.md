# Physics for games

Everything in SI: metres, kilograms, seconds, newtons, radians. Scale your world so 1 unit = 1 m; physics engines are tuned
for objects 0.1-10 m. A 100-unit-tall character falls in slow motion and jitters. Box2D/LibGDX: never pixels - divide by PPM.

## Constants and real values

| Thing | Value |
|---|---|
| gravity | 9.81 m/s^2 (games often use 15-25 for snappier platformers; keep 9.81 for vehicles/realism) |
| air density / water density | 1.225 / 1000 kg/m^3 |
| human | 1.75 m, 70 kg, walk 1.4 m/s, jog 3, run 5-6, sprint 8-10, jump 0.4-0.6 m, capsule r 0.3-0.4 h 1.8 |
| car | 1200-1600 kg, 4.2-4.8 m long, wheelbase 2.5-2.9 m, track 1.5-1.6 m, wheel r 0.30-0.35 m, CoG 0.45-0.55 m high, 0-100 km/h 7-10 s, top 50-60 m/s, max steer 30-35 deg |
| truck | 8-40 t, wheelbase 4-6 m, wheel r 0.5 m; motorcycle 200 kg, wheelbase 1.4 m; bicycle 10 kg + rider, wheel r 0.34 m |
| horse | 500 kg, walk 1.7 m/s, trot 4, canter 6-7, gallop 12-14; dog 20-40 kg, run 10-15 m/s |
| projectiles | arrow 50-90 m/s, thrown ball 20-40 m/s, pistol 350 m/s, rifle 900 m/s (use raycasts, not bodies) |
| friction mu | tyre/dry asphalt 0.9-1.0, wet 0.5-0.7, snow 0.2-0.3, ice 0.05-0.1; wood on wood 0.4; rubber on concrete 0.8; ice on ice 0.03 |
| restitution | rubber ball 0.8, tennis ball 0.7, wood 0.4, flesh/character 0 |
| drag | car Cd 0.3 A 2.2 m^2; human Cd 1.0 A 0.7; sphere Cd 0.47; rolling resistance coefficient tyres 0.01-0.015 |

## Integration and the loop

- **Fixed timestep** (60 Hz, sometimes 120 for vehicles) with an accumulator; render interpolates between the last two
  physics states. Never step physics with the frame dt (variable dt breaks springs, stacking and determinism).
  ```
  acc += min(frameDt, 0.25); while (acc >= DT) { prev = curr; step(DT); acc -= DT; } render(lerp(prev, curr, acc / DT));
  ```
- **Semi-implicit (symplectic) Euler**: `v += a*dt; x += v*dt;` (velocity first). Explicit Euler gains energy - orbits fly off.
- **Verlet** for ropes, cloth, soft bodies: `x' = x + (x - xPrev)*damping + a*dt*dt`, then satisfy distance constraints by
  projection, 5-20 iterations. Damping 0.99-0.999.
- **Springs**: `F = -k*x - c*v`; critical damping `c = 2*sqrt(k*m)`. For camera/follow smoothing use the frame-rate
  independent form: `x += (target - x) * (1 - exp(-rate*dt))`.
- Gravity applies to `velocity`, not position; terminal velocity via drag `F = 0.5*rho*v^2*Cd*A` or a clamp.

## Collisions

- Colliders are simple shapes matching the visuals: capsule for characters (never a box - boxes snag on edges), boxes /
  convex hulls for props, trimesh only for static level geometry, compound shapes for vehicles (chassis box + cabin box).
- If the mesh is scaled, scale the collider (most engines do not inherit visual-only scale).
- **Tunneling**: anything moving more than its own size per step goes through walls. Use CCD (Rapier `setCcdEnabled`,
  Unity `ContinuousDynamic`, Godot `continuous_cd`, Box2D `bullet = true`) or raycast/sweep from previous to current position.
- Layers/masks: define who hits whom (player, enemy, world, projectile, trigger). Triggers/areas/sensors detect, do not push.
- Stacks jitter: raise solver iterations, add sleeping, use lower restitution, avoid tiny mass ratios (> 1:10 is trouble).
- Ground check by short raycast/shape-cast down from the feet, plus a coyote timer; never by "velocity.y == 0".

## Character controllers (kinematic)

- Kinematic capsule + move-and-slide (Godot `move_and_slide`, Unity `CharacterController.Move`, Rapier
  `KinematicCharacterController.computeColliderMovement`). Slope limit 45 deg, step offset 0.3 m, snap-to-ground 0.2 m.
- Horizontal: accelerate toward target velocity: `v = moveToward(v, input*maxSpeed, (grounded?accel:airAccel)*dt)`;
  ground accel 40-80 m/s^2, decel higher than accel, air control 30-60 percent.
- Jump: `v0 = sqrt(2*g*h)`; variable height by cutting upward velocity when the button is released; fall gravity 1.5-2.5x.
- Move relative to the camera's yaw, not the world axes. Rotate the model toward the move direction with slerp.

## Vehicles (cars, trucks, karts)

**Structure**: a rigid chassis (box collider, mass 1200-1500 kg, centre of mass lowered 0.2-0.4 m below the body's
centre or it rolls over), and FOUR wheels on TWO axles: front-left, front-right, rear-left, rear-right. Wheels are raycasts
(or shape casts) with springs, not rolling rigid bodies (rigid wheels jitter and explode).

**Per wheel, each physics step** (raycast vehicle):
1. Raycast down from the wheel's mount point over `restLength + radius` (rest length 0.3-0.5 m).
2. Suspension: compression `x = restLength - (hitDist - radius)`; force `F = k*x - c*compressionSpeed`, k = 20-60 kN/m per
   wheel for a car (so the car sits ~30% into travel), c = 2-5 kN*s/m. Apply at the contact point along the surface normal.
3. Tyre: split the contact velocity into forward and lateral (wheel's axes). Lateral force `-lateralVel * corneringStiffness`
   clamped by `mu * normalLoad`; longitudinal force from engine/brake clamped by the same friction circle.
   `sqrt(Fx^2 + Fy^2) <= mu*Fz` - exceeding it is a skid (play tyre audio, leave marks).
4. Wheel visual: position at `hitDist - radius` along the suspension axis, spin by `forwardSpeed / radius * dt`,
   steer about the up axis. Wheels spin about their AXLE (the car's left-right axis), never the forward axis.

**Steering**: front wheels only (most cars); max 30-35 deg, reduced with speed (`maxSteer * clamp(1 - speed/60, 0.25, 1)`).
Ackermann: inner wheel turns more - `inner = atan(L / (R - T/2))`, `outer = atan(L / (R + T/2))` (L wheelbase, T track).
**Drive**: RWD rear pair, FWD front pair, AWD all four (split torque). Engine torque curve -> gear ratio -> final drive ->
wheel torque / radius = force. Gears 3.5, 2.1, 1.4, 1.0, 0.8, final 3.7; shift at ~85% of max RPM. Brakes on all four,
front bias 60-70%. Handbrake = rear wheels only, lower rear lateral grip -> drift.
**Stability**: anti-roll bar (transfer force between left/right of an axle by their compression difference), downforce
proportional to v^2 at speed, angular damping. Weight transfer `dW = m*a*h/L` front<->rear when braking/accelerating.
**Arcade feel**: stronger grip, lower CoG, assist that rotates velocity toward the heading, a speed-scaled camera FOV.

Engine APIs: three.js + Rapier `world.createVehicleController(chassis)`, `addWheel(pos, suspDir, axle, restLen, radius)`,
`setWheelEngineForce(i,f)`, `setWheelSteering(i,a)`, `setWheelBrake(i,b)`, `updateVehicle(dt)`; cannon-es
`RaycastVehicle` (`addWheel({radius, suspensionStiffness:30, suspensionRestLength:0.3, frictionSlip:1.4,
dampingRelaxation:2.3, dampingCompression:4.4, rollInfluence:0.01, chassisConnectionPointLocal, axleLocal,
directionLocal})`, `applyEngineForce`, `setSteeringValue`, `setBrake`); Godot `VehicleBody3D` + 4 `VehicleWheel3D`
(`use_as_traction`, `use_as_steering`, `engine_force`, `steering`, `brake`); Unity 4 `WheelCollider`s (`motorTorque`,
`steerAngle`, `brakeTorque`, `GetWorldPose` for visuals); Unreal Chaos Vehicle (WheeledVehiclePawn).

Other vehicles: motorcycle = 2 wheels in line + lean angle `atan(v^2/(g*R))` (fake the balance); tank = tracks as 6-8
raycast wheels per side, steer by differential speed; boat = buoyancy points + drag + thrust at the stern, rudder torque;
plane = lift `0.5*rho*v^2*Cl*S` with Cl rising with angle of attack up to stall (~15 deg), thrust, drag, control surfaces
as torques (ailerons roll, elevator pitch, rudder yaw); helicopter = rotor lift up the body axis, cyclic tilts it,
tail rotor cancels torque.

## Projectiles, explosions, water, ragdolls

- Ballistics: `p(t) = p0 + v0*t + 0.5*g*t^2`. Aim to hit a target: solve `tan(theta) = (v^2 +- sqrt(v^4 - g(g*x^2 + 2*y*v^2)))/(g*x)`.
  Fast bullets: raycast per tick from previous to current position; arrows: rigid body with CCD + align to velocity.
- Explosion: impulse `J = power * (1 - d/radius)` along the direction from the centre, upward bias 0.3, plus a damage falloff.
- Buoyancy: sample 4-8 points; each underwater point gets `rho_water * g * pointVolume * depthFactor` up, plus drag.
- Ragdoll: capsules per bone joined by cone-twist / hinge joints with limits (knee/elbow hinge 0-150 deg, hip/shoulder
  cone 60-90 deg); match the animated pose on death, then let physics take it; damp joints heavily.
- Ropes/chains: Verlet particles or a chain of bodies with distance/ball joints; cloth: Verlet grid + structural, shear,
  bend constraints.

## Bugs that bite

| Symptom | Cause |
|---|---|
| things fall slowly / float | world scale too large, or gravity applied per frame not per second |
| jitter at rest | variable timestep, high restitution, tiny mass ratios, collider overlap at spawn |
| passes through walls | no CCD, speed > size per step, collider smaller than the mesh |
| car flips at every turn | CoG too high, no anti-roll, too much lateral grip, wheels as rigid bodies |
| car slides sideways forever | no lateral tyre force; car turns but keeps going straight: steering applied to the body, not the wheels |
| wheels spin wrong | rotating about the forward axis instead of the axle; sign flipped on one side |
| speed depends on FPS | movement not multiplied by dt (or multiplied twice) |
| character sticks to walls | friction on the capsule; use zero-friction material on the character |
