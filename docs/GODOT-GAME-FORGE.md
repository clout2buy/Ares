# Godot Game Forge

Ares builds and verifies Godot 4 games through one bundled **capability
provider**, `ares/godot`, instead of an engine-specific branch in core
(see `CODING-HARNESS-ARCHITECTURE.md` §3.11). The provider ships in the repo
at `packages/agent/skills/godot/` (and in the desktop bundle at
`runtime/skills/godot/`), is installed into `~/.ares/skills/godot` on
scaffold by `installBundledSkills`, and is reached by the model through the
`Capability` tool like any learned provider.

## Pieces

| Piece | Where | Role |
|---|---|---|
| `capability.json` | skill root | contract: 10 operations, their effects, evidence requirements (`run`/`screenshot` demand fresh `screenshot` evidence), healthcheck |
| `handler.js` + `lib/` | skill root | the Node side: tscn parser/writer, mesh/OBJ generator, Godot process control, RPC client, docs/YouTube/asset-library/Poly Haven clients |
| `addon/ares_bridge/` | copied into `<project>/addons/` by `ares godot init` | **editor plugin** (`plugin.gd`) exposing the live scene tree over loopback JSON-RPC (port 6505) and the **runtime autoload** (`ares_runtime.gd`, port 6506, active only when `ARES_GODOT_RUNTIME=1`) that lets a running game be driven: press actions, inject keys/mouse, read physics state, screenshot, change scene, time-scale |
| `SKILL.md` + `references/*.md` | skill root | the knowledge pack: workflow loop, op cheat sheet, and deep references on movement, physics, mechanics, 3D assets, gotchas, research, team workflow |
| `ares godot` CLI | `packages/cli/src/entry/godotCmd.ts` | `init` (install + enable addon, write `.ares/godot.json`, remember `--godot <exe>`), `doctor`, `check`, `shot`, `run`, `skill` |
| prompt hooks | `prompt/toolDoctrine.ts`, `prompt/surfaces.ts` | Capability doctrine names the provider; the environment block flags a Godot workspace so the model reads the pack before acting |

## Operations

```
health      read-only   godot exe, project facts, bridge/runtime reachability → mode live-editor | live-game | offline
locate      read-only   find the executable (ARES_GODOT, ~/.ares/godot.json, project .ares/godot.json, PATH, common dirs)
inspect     read-only   project | tree | node | inputmap | scripts | assets | signals | find | class | selection | scene-file
mutate      ws-write    scene.new/open/save/instance, node.add/set/remove/rename/reparent/call, script.create/attach, signal.connect, input.add, project.set
check       read-only   per-script `--check-only`, headless boot (`--quit-after`), `dotnet build` for C# — structured diagnostics
run         ws-write    launch (or attach to) the game with the runtime, execute steps (wait/press/hold/key/mouse/get/state/assert/screenshot/call/scene/timeScale/pause/stats), capture engine errors, screenshots as evidence
screenshot  read-only   editor 3D/2D viewport via the bridge, or the running game via the runtime
asset       ws-write    procedural OBJ (box, plane, cylinder, cone, sphere, capsule, torus, terrain, lathe, extrude, stairs, ramp, wedge, arch, pipe, composites), `-col`/`-convcol` naming, MTL, a @tool FastNoiseLite terrain script, or `download` a URL into res://
docs        read-only   Godot class reference / tutorial pages → text (cached 7 d), `section` windows, cache search
video       read-only   YouTube search; transcripts via the InnerTube player API (cached 30 d), `from`/`to` paging, chapters
discover    read-only   Godot Asset Library API, Poly Haven (index + per-asset files), curated learning/asset sources
```

Live mode is used when the editor bridge answers; otherwise the same
operations edit `.tscn`/`.gd`/`project.godot` on disk and launch Godot
themselves. Receipts list every touched file with its post-write hash, and a
`run` without a captured screenshot is a failure, not a success with a caveat.

## Protocol (addon ↔ handler)

Newline-delimited JSON over 127.0.0.1: `{"id","method","params"}` →
`{"id","ok","result"|"error"}`. Values cross as Godot literals in strings
(`"Vector3(0, 1, 0)"`, parsed with `str_to_var`), `res://` strings
(auto-`load`ed when the target property is an Object), `{"$res": path}` and
`{"$var": literal}`. Node paths are relative to the edited scene root.

## Verified

`tests/godot-provider.test.mjs` covers the manifest, bundled install/refresh
policy, tscn round-trip and edits, mesh generators, net helpers, output
classification, the full offline path through the contract runtime
(health/inspect/mutate/asset, failure receipts), and `ares godot init`.
Live research ops were exercised against the real services. The GDScript
addon is validated against a real editor by `ares godot init <project>` +
`ares godot doctor` (needs a Godot 4 executable).
