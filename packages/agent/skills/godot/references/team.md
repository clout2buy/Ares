# Two agents, one game — working in parallel without collisions

Godot projects are text (`.tscn`, `.gd`, `.tres`, `project.godot`), so Git
merges them. Collisions come from two agents editing the **same scene** or
**project.godot** at once. Prevent that with ownership, small merges, and the
provider's offline mode.

## Repo setup (once)

```
.gitignore         .godot/  .import/  *.tmp  .ares/godot/shots/  export/  *.translation
.gitattributes     *.png *.jpg *.glb *.gltf *.wav *.ogg *.mp3 *.ttf *.exr *.hdr filter=lfs diff=lfs merge=lfs -text
docs/TASKS.md      the board (below)
docs/DESIGN.md     one-page pitch + reference list + tuned numbers
```
Commit `.import` files? Yes for small teams (faster clones); they regenerate
anyway. Never commit `.godot/`.

## The board — `docs/TASKS.md`

```
## Owners
- crix-agent:   player/, scenes/player.tscn, scripts/player*.gd, input map
- friend-agent: enemies/, scenes/enemies/*.tscn, ai/*.gd
- shared (ask before editing): scenes/main.tscn, project.godot, autoload/, ui/

## In progress
- [crix-agent] dash + wall jump (branch feat/dash) — touching player.gd, input map
- [friend-agent] turret enemy (branch feat/turret) — touching enemies/turret.tscn

## Queue
- [ ] pause menu (ui/) — unowned
- [ ] level 2 blockout — unowned
```
At session start: read the board, claim a task by writing your name, list the
files you will touch, work on a branch named for it. At session end: tick the
box, note what was verified (check passed / run asserts), push, open a PR.

## Branch & merge discipline

- Branch per task: `feat/dash`, `fix/camera-jitter`. Rebase on `main` before
  starting and before pushing (`git pull --rebase origin main`).
- Merge small and often — a scene file that diverged for two days is the one
  that conflicts. Prefer 5 PRs of 50 lines over 1 of 500.
- `project.godot` conflicts: both sides usually added input actions or
  autoloads — keep both entries. The `[input]` section is order-insensitive.
- `.tscn` conflicts: usually two `[node]` blocks added at the same spot — keep
  both; make sure `load_steps` in the header equals 1 + ext + sub resources
  (the provider fixes this if you `mutate` the scene afterwards with
  `{ops:[{op:"scene.save"}]}` in live mode, or just re-open it in the editor
  and save). Never resolve a `.tscn` conflict by taking one side blindly —
  open both versions with `inspect what:scene-file`.
- Binary assets (LFS): no merging — whoever touched it last wins; coordinate.

## Avoiding the same-scene problem

- Each feature gets its own scene; `main.tscn` only instances them. Then two
  agents add children to **different** scenes and `main.tscn` changes rarely.
- Shared systems (signal bus, Game autoload): add signals, don't rename them.
  Renames are a PR of their own.
- Input actions: prefix by owner if in doubt (`p_dash`), or claim in TASKS.md.
- Verification is per-branch: `check` + `run` before pushing; the PR description
  carries the screenshot path and assert results so the reviewer (the other
  agent or a human) sees proof, not promises.

## Live visibility for humans

- Each human watches their own agent in the Godot editor (live-editor mode):
  node additions, property edits and screenshots happen in front of them.
- Cross-visibility: the PR + screenshots under `.ares/godot/shots/` (don't
  commit those; attach them to the PR or paste in chat). A 5-minute daily sync
  to redistribute the board beats any real-time co-editing tool.

## Reviewing the other agent's PR

Run the provider against their branch (worktree): `check`, then `run` their
feature with asserts from the PR description, read the screenshots, and comment
with what you observed. Approve only on green `check` and a screenshot that
matches the claim.
