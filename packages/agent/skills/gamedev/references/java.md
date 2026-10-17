# Java games

Build with Gradle (wrapper in the repo: `./gradlew build`, `./gradlew run`); Java 17+ (Minecraft 1.20.5+ needs 21).
Run once after changes (`./gradlew run` / `runClient` with a timeout) and read the log: a stack trace is the truth.

## LibGDX (default for a new Java game)
- Project from gdx-liftoff (core + lwjgl3 desktop launcher [+ android/html]). Game code lives in `core`.
- `class MyGame extends Game` -> `setScreen(new PlayScreen(this))`; `Screen.render(float delta)` is the loop:
  update with a fixed-step accumulator, then `ScreenUtils.clear`, `batch.begin()`, draw, `batch.end()`.
- Rendering: `SpriteBatch` + `TextureAtlas` (pack sprites with TexturePacker), `OrthographicCamera` + `FitViewport`
  (resize -> `viewport.update(w, h, true)`), `ShapeRenderer` for debug, `BitmapFont`/FreeType for text, Scene2D `Stage`
  + `Skin` for UI, `Tiled` maps via `TmxMapLoader` + `OrthogonalTiledMapRenderer`.
- Box2D (`gdx-box2d`): `new World(new Vector2(0, -9.8f), true)`; units are METRES - `PPM = 32` pixels per metre, convert
  at the render boundary only. `world.step(1/60f, 6, 2)` in a fixed step; bodies via `BodyDef` + `FixtureDef`
  (density, friction, restitution, `isSensor`); contacts via `ContactListener`; never destroy bodies inside a callback -
  queue them. `Box2DDebugRenderer` while tuning.
- Input: `InputProcessor` / `InputMultiplexer`, or poll `Gdx.input.isKeyPressed(Input.Keys.SPACE)`; controllers via gdx-controllers.
- Assets: `AssetManager` load + `finishLoading()` behind a loading screen; `dispose()` textures, batches, fonts.
- 3D: `ModelBatch`, `PerspectiveCamera`, `Environment` lights, G3DJ/GLTF via gdx-gltf; Bullet via gdx-bullet.
- ECS: Ashley (`Engine`, `Entity`, `Component`, `IteratingSystem`).

## Plain Java (no framework)
- Java2D: a `Canvas` in a `JFrame`, `createBufferStrategy(2)`, a game thread with a fixed-step loop
  (`System.nanoTime()` accumulator), draw on `bs.getDrawGraphics()`, `bs.show()`, `Toolkit.getDefaultToolkit().sync()`.
  Keys via a `KeyListener` writing into a boolean array. Fine for small 2D games and prototypes.
- LWJGL 3 for raw OpenGL/Vulkan (GLFW window, `glfwPollEvents`, your own renderer); jMonkeyEngine for a full 3D engine
  (`SimpleApplication.simpleUpdate(tpf)`, scene graph, Bullet physics via `BulletAppState`, `VehicleControl`).

## Minecraft (Java Edition) mods and plugins
- **Fabric**: `fabric.mod.json` (id, entrypoints.main -> class implementing `ModInitializer`), Fabric API dependency,
  Loom in Gradle, `./gradlew runClient`. Register in `onInitialize`:
  `Registry.register(Registries.ITEM, Identifier.of(MOD_ID, "ruby"), new Item(new Item.Settings()))` (1.21+;
  earlier versions `new Identifier(...)`). Client-only code (renderers, keybinds) behind a `ClientModInitializer`.
  Mixins for changing vanilla code: smallest injection that works (`@Inject` at HEAD/RETURN) over `@Overwrite`.
- **NeoForge / Forge**: `@Mod(MOD_ID)` main class, `DeferredRegister.create(Registries.ITEM, MOD_ID)` +
  `ITEMS.register("ruby", () -> new Item(new Item.Properties()))`, register the DeferredRegister on the mod event bus,
  events on `NeoForge.EVENT_BUS`; `./gradlew runClient`.
- Both: assets under `src/main/resources/assets/<modid>/` - `lang/en_us.json`, `models/item/*.json`, `textures/item/*.png`
  (16x16), `blockstates/*.json`; data (recipes, loot tables, tags) under `data/<modid>/` (1.21 renamed folders to singular:
  `recipe/`, `loot_table/`). A missing texture = purple/black checker: a path or model JSON is wrong.
- **Paper/Spigot plugins** (server side): `plugin.yml` (name, version, main, api-version) or `paper-plugin.yml`;
  `class MyPlugin extends JavaPlugin` -> `onEnable()` registers listeners
  `getServer().getPluginManager().registerEvents(new MyListener(), this)`; handlers are `@EventHandler` methods;
  commands in `plugin.yml` + `getCommand("x").setExecutor(...)`; schedule with `Bukkit.getScheduler().runTaskTimer`.
  Never block the main thread (no sleeps, no network on it). Build a shaded jar into `plugins/`.
- Check the exact game version the project targets before using an API: mappings and names change between versions.
