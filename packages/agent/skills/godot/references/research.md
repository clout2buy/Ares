# Research & references — how to find out instead of guess

Game dev is reference-driven. Experienced developers steal shamelessly:
they look at how shipped games do a mechanic, read what engine authors wrote,
watch tutorials by people who tuned the thing for weeks. Do the same, every
time a task has a *feel*, *API*, or *asset* question. Budget: a few minutes of
research saves hours of trial and error.

## The research ladder (cheapest first)

1. **`docs {class, section}`** — the class reference is the truth for any API.
   Cached 7 days under `~/.ares/godot/docs/`. Use `section` to pull one method
   (`{class:"CharacterBody3D", section:"move_and_slide"}`) instead of 40 KB.
   Tutorials: `{page:"tutorials/3d/using_transforms"}`,
   `{page:"tutorials/physics/using_character_body_2d"}`,
   `{page:"tutorials/animation/animation_tree"}`,
   `{page:"tutorials/navigation/navigation_introduction_3d"}`,
   `{page:"tutorials/shaders/your_first_shader/your_first_3d_shader"}`,
   `{page:"getting_started/first_3d_game/03.player_movement_code"}`.
   `{query:"text"}` searches everything already cached.
2. **`inspect what:class`** (live editor) — exact property/method/signal names
   of any ClassDB class in the installed version. Beats memory.
3. **`WebSearch`** — "godot 4 <mechanic>" plus the year; prefer results from
   docs.godotengine.org, gdquest.com, kidscancode.org, godotforums, reddit
   r/godot, GitHub issues. Then `WebFetch` the page. Godot 3 answers are
   everywhere — check the version before copying (`KinematicBody`, `yield`,
   `instance()` = Godot 3).
4. **`video {search}` → `video {url}`** — *watch* tutorials by reading their
   transcripts. Use `from`/`to` seconds to page long videos; `chapters` tell
   you where to jump. Best channels: GDQuest, KidsCanCode, Godotneers,
   Bramwell, Brackeys (Godot era), Chris Tutorials, FinePointCGI, Game
   Endeavor, StayAtHomeDev (3D), Bitlytic, Mr. Eliptik (juice), Jonas Tyroller
   (design). For *feel*, also watch GDC talks: "Math for Game Programmers:
   Juicing Your Cameras", "Celeste & Towerfall physics", "The art of
   screenshake" (Vlambeer), "Building a Better Jump".
5. **`discover`** — assets and addons:
   - `{source:assetlib, query:"state machine"}` → addons with ratings/support
     level; `download` URL is a zip — fetch with Bash, unzip into `addons/`,
     enable in project.godot `[editor_plugins] enabled=PackedStringArray("res://addons/<x>/plugin.cfg")`
     via `mutate project.set`.
   - `{source:polyhaven, query:"rock", type:models|textures|hdris}` then
     `{source:"polyhaven-files", id, resolution:"1k"}` → `asset {kind:download}`.
   - `{source:sources}` — the curated list (Kenney, Quaternius, OpenGameArt,
     Mixamo, freesound, itch).
6. **`ImageSearch`/`WebFetch` for visual references** — concept art, UI
   layouts, colour palettes, screenshot of the game you are imitating. Save
   references under `res://.ares/refs/` and Read them when designing.
7. **Play the reference** — if the owner names a game, search "<game> movement
   analysis" / "<game> camera breakdown"; there is almost always a video that
   measured it (e.g. Mario jump timings, Celeste coyote frames, Hollow Knight
   dash).

## What to research for common asks

| Ask | Look up |
|---|---|
| "make the jump feel good" | Building a Better Jump (GDC), Celeste physics video, GDQuest platformer; then tune apex 0.35–0.45 s, fall ×1.5–2, coyote 6–8 frames, buffer 6–8 frames |
| "third person camera like X" | "<X> camera breakdown"; SpringArm3D docs; GDQuest 3D camera; test with screenshots while rotating |
| "enemy AI" | NavigationAgent3D docs, Beehave/LimboAI addon, "FSM vs behaviour tree godot" |
| "inventory" | GDQuest inventory, Godot Recipes inventory; Resource-based items |
| "procedural terrain" | FastNoiseLite docs, "godot 4 terrain generation", HTerrain / Terrain3D addons |
| "water / outline / dissolve shader" | godotshaders.com; `docs {page:"tutorials/shaders/..."}` |
| "multiplayer" | `docs {page:"tutorials/networking/high_level_multiplayer"}`; Godot 4 multiplayer tutorials (Battery Acid Dev) |
| "dialogue system" | Dialogic / Dialogue Manager on the asset library |
| "save system" | `docs {page:"tutorials/io/saving_games"}` |
| "pixel art 2D setup" | project settings: viewport 320×180, stretch canvas_items/integer, filter nearest |
| "optimize" | `docs {page:"tutorials/performance/index"}`; Profiler via editor; `run {stats:true}` numbers |

## How to read a transcript usefully

Skim for numbers and node names (they are the transferable parts), note the
Godot version, then reproduce the *structure* (which nodes, which signals,
which process function), not the exact code. Credit the source in a comment
(`# after GDQuest's 3D controller`) so the owner can revisit it.

## Keep what you learn

Durable facts (tuned numbers the owner liked, chosen addons, the game's
reference list) go to the project memory via the Memory tool, and into
`res://docs/DESIGN.md` for humans. The next session should not re-research.
