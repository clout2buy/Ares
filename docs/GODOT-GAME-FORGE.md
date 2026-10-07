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

## Live feed and native embedding

Three layers, all engine-agnostic above the provider:

1. **Provider progress stream** — a handler writes `##ares-progress## {json}`
   lines to stdout; `runSkill` (`packages/agent/src/skills/runtime.ts`,
   `PROGRESS_MARKER`) parses them as they stream and keeps them out of the
   logs; the `Capability` tool forwards each as a `tool_progress` event. The
   Godot provider streams `live_frame` (JPEG, base64, ≤960 px, from the
   bridge's `editor.frame` / the runtime's `frame`), `live_step`, and
   `live_control` (`{host, port, method, side, state, pid, windowTitle}`).
2. **Daemon live-feed hub** (`packages/cli/src/entry/daemon/liveFeed.ts`) —
   on `live_control state:"detached"` (a game left running with `keepAlive`)
   it keeps polling frames between turns and emits `live_frame` / `live_feed`
   events to the UI; `live_input` forwards the owner's keys/mouse to the
   runtime's `input.key` / `input.mouse` (explicit press/release edges,
   relative mouse-look); `live_watch` / `live_unwatch` / `live_status` are the
   UI commands (allow-listed in `tauri/src-tauri/src/main.rs`). Editor feeds
   are view-only. A feed is declared lost after 8 failed polls.
3. **Forge "Live" pane** (`tauri/src/App.tsx`) — paints frames on the same
   canvas as the browser screencast, with Play (keyboard/mouse capture,
   Shift+Esc releases), Mouse look (pointer lock → relative motion), Watch /
   Stop watching. On Windows, **Embed window** asks the shell
   (`ares_embed_window`, `ares_embed_place`, `ares_embed_release` in
   `main.rs`) to re-parent the real Godot window (found by pid, else title)
   into the Ares window over the stage: native rendering, direct input, kept
   in place on resize, released on Detach, tab switch hides it, and every
   embedded window is released before the app exits so closing Ares never
   destroys a running game.

## AI asset generation (image → 3D)

`asset {kind:"ai", image, name}` turns a concept image into a textured GLB
through the owner's local **ComfyUI + TRELLIS.2** (Microsoft, MIT, 4B params,
PBR materials) and copies it into `res://assets/generated/`. The provider's
`lib/comfy.js` starts ComfyUI from its venv when it is not listening, converts
the node pack's UI-format example workflows to API prompts via `/object_info`
(so `MeshWithTexturing.json` / `MeshOnly.json` run unchanged), uploads the
image, overrides what matters (`Trellis2LoadModel.backend`, `low_vram`,
`modelname`, cascade resolution for `quality: fast|balanced|high`, plus any
`sets`), waits, and reports the produced files with hashes. Install lives
outside the repo (`D:/ComfyUI`, `~/.ares/godot.json` → `comfyDir`/`comfyUrl`):
ComfyUI + `visualbruno/ComfyUI-Trellis2` with its Windows wheels for
Python 3.13 / Torch 2.10 / CUDA 13.1 (cumesh, nvdiffrast, nvdiffrec_render,
flex_gemm, o_voxel, natten), flash-attn 2.8.3 (cu130/torch 2.10 community
wheel), triton-windows, and the checkpoints `microsoft/TRELLIS.2-4B`
(16.2 GB; `visualbruno/TRELLIS.2-4B-FP8` and `TencentARC/Pixal3D` are
selectable). Text → 3D: `asset {kind:"concept", prompt}` makes the image with
FLUX.2 Klein 4B (`lib/comfy.js` `fluxKleinPrompt`, flat API prompt — the
ComfyUI template is a subgraph the API cannot run), then `kind:"ai"` with
`prompt` chains both.

**Blackwell (RTX 50, sm_120) trap:** the node pack's `cumesh` / `o_voxel`
wheels carry only `sm_86` code; JIT-translated on sm_120 the narrow-band
remesh silently produces ~90 % degenerate faces and tens of thousands of
fragments. Rebuild both natively (`D:/ComfyUI/ares/build-sm120.cmd`: vcvars64
`-vcvars_ver=14.44`, CUDA 13.0, `GPU_ARCHS=sm_89;sm_120`,
`uv pip install --no-build-isolation` of `JeffreyXiang/CuMesh` and
`TRELLIS.2/o-voxel`); verify with `cuobjdump --list-elf` and a trimesh
component count (≤ 5 is healthy). Plan B is the pack's `Trellis2VoxelToMesh`
(CPU marching cubes).

## Engine provisioning

`install` (and `ares godot install`, or `ares godot init` when nothing is
found) downloads the official release for the platform from the godotengine
GitHub releases, verifies the archive against the published `SHA512-SUMS.txt`,
extracts it under `~/.ares/godot/engine/<tag>/`, writes an MIT notice beside
the executable and remembers the path in `~/.ares/godot.json`. Ares-installed
engines rank above anything found on the machine; an explicitly configured
path still wins. The engine is not bundled into the installer on purpose:
130 MB per platform build, and projects pin different versions.

## Verified

`tests/godot-provider.test.mjs` covers the manifest, bundled install/refresh
policy, tscn round-trip and edits, mesh generators, net helpers, output
classification, release-asset naming, the full offline path through the
contract runtime (health/inspect/mutate/asset, failure receipts), and
`ares godot init`. Research ops were exercised against the real services.

Validated live on 2026-10-07 with Godot 4.3.stable (Windows, gl_compatibility):
`ares godot init` installed and enabled the addon; the editor printed
`Ares bridge listening`; `health` reported `live-editor`; `inspect tree` came
from the editor; a `mutate` batch added a CSGBox3D + OmniLight3D through the
bridge with Vector3/Color/bool coercion, set a script export, focused the
node and saved (receipt carried the scene's post-save hash); `screenshot
source:editor` captured the 3D viewport; `check` parsed all scripts including
the addon's and booted the main scene headless; `run` launched the game with
the runtime, drove `jump`/`move_right`, read `physics.state`, passed three
asserts (rising 5.53 m/s, landed, stopped against the obstacle with
`is_on_wall`), captured three screenshots and reported 146 fps with zero
engine errors.
