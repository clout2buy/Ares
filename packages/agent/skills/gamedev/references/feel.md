# Game feel, AI and design

## Movement feel (platformers / action)
- Coyote time 80-120 ms, jump buffer 100-150 ms, variable jump (cut vy by 50% on release), apex hang (lower gravity near
  vy=0), fall gravity 1.5-2.5x, max fall speed, corner correction (nudge around ceiling edges by a few px).
- Acceleration 0.05-0.15 s to top speed, deceleration faster; turn-around boost. Dash: fixed distance, i-frames, cooldown.
- Squash on landing / stretch on jump (scale 1.2/0.8 for 80 ms), dust particles on land and turn, footstep sounds synced
  to animation events.

## Impact
- Hit-stop 40-100 ms on heavy hits (freeze both attacker and target), screen shake by trauma, knockback impulse,
  flash white for 1-2 frames, damage numbers, hit sparks, a punchy layered sound (transient + body + tail).
- Every action gets three kinds of feedback: visual, audio, and a number/UI change.

## Camera and UI
- Smooth but responsive camera (see architecture.md); never lose sight of the player.
- HUD: health, resource, score/objective; diegetic where possible; readable at a glance; animate changes (tween counters).
- Menus: keyboard/gamepad navigable, focus visible, back button everywhere.

## AI
- **State machines**: Idle -> Patrol -> Chase (on sight: raycast line of sight + view cone + hearing radius) -> Attack
  (in range, cooldown) -> Search (last known position, timeout) -> Patrol. Flee at low health.
- **Steering behaviours**: seek, flee, arrive (slow within radius), pursue (aim at predicted position), wander, separation
  (crowds), obstacle avoidance (feelers). Sum weighted forces, clamp to max speed/force.
- **Pathfinding**: A* on a grid or navmesh (Godot NavigationAgent, Unity NavMeshAgent, recast-navigation on the web);
  repath on a timer, not every frame; smooth the path.
- Behaviour trees or utility AI for richer agents; telegraph attacks (wind-up 300-600 ms) so players can react.
- Spawn fairness: never spawn in view or on top of the player.

## Design
- Core loop in one sentence (act -> reward -> upgrade -> harder act). First 30 seconds teach the controls by doing.
- Juice is not optional: particles, sound, tweens, light. A finished game has menus, pause, restart, game over, win state,
  audio with volume, and stays at 60 fps.
- Audio: music loop + SFX; WebAudio needs a user gesture to start; randomise pitch +-5% on repeated SFX.
