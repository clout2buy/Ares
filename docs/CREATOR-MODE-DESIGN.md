# Creator mode for Ares: generative UI first

*2026-11-04. Design, not built. Prompted by DeepSeek Harness's Creator mode.
Companion to [PLUGIN-KERNEL-DESIGN.md](PLUGIN-KERNEL-DESIGN.md) and the Living
Surface (`packages/protocol/src/livingSurface.ts`, `tauri/src/LivingSurface.tsx`).*

## What dsh's generative UI actually is

Read from a clone of `deepseek-ai/deepseek-harness` on 2026-11-04:
`packages/experimental/creation-recommendations` (+ its `personalized-pages`
skill and four placement references), `action-cards`,
`client-ui-creation-recommendations`, `client-ui-entry-customization`, the
`cordis` preset, `tool-cordis`, `plugin-manager`, and the
`cordis-plugin-development` skill with its `decoration` template.

The flow, end to end:

1. **Offer.** The main agent answers the question. If the ask was for a page,
   panel or tool, or the user said the data will keep changing, it loads the
   `personalized-pages` skill and calls `propose_action` once. A card appears
   under the answer: title, a 1–3 sentence brief, a location dropdown (right
   sidebar, session tab, global page, "write your own"), a cost notice, and a
   Create button. Nothing is built yet. One card per turn, one unstarted card
   per conversation.
2. **Create.** On click, the host reserves a package name and launches a
   background subagent in the `cordis` preset with a self-contained brief
   (it cannot read the conversation). That subagent inspects the live
   runtime with `cordis_inspect_query` (Client slots, services, theme
   tokens), copies a template, and writes a real plugin package: `package.json`
   with a `dsh.client` section, a `cordis.patch.yml`, a host `index.js`, and a
   `client.js` that calls `window.__ModuleLoader__.load(...)` and registers a
   React component into a named slot via `ctx.slots.inject`.
3. **Install.** The host validates the package (insert-only patch, built JS
   entries, no YAML tags) and installs it into the profile through
   `plugin_manager`. The page is now part of the app shell: same React tree,
   theme tokens, locale, session projections. It survives reload and shows in
   every session of the profile.
4. **Undo / Restore.** The card offers Undo (uninstall, files kept) and then
   Restore (reinstall the kept copy).

There are also three "More" menus (left sidebar, conversation tabs, right
sidebar) whose "Create your plugin" opens a Creator session with the
placement pre-filled.

What they state as limits, in their own README: only new pages, editing an
existing page is deferred; no version history; "package validation is not a
code sandbox", generated code runs with the Creator's permissions in the
page; source directories linger after Undo; no creation timeout; a
long, token-heavy background build per page; Web only.

What makes it good: the page is **native** (real slot, real theme, real
session data, no iframe), the offer is **cheap and optional** (one skill load,
one tool call, a card the user can ignore), and the build is **off the
conversation's critical path**.

## What Ares has today

The Living Surface (v0.28-era, shipped): a separate Tauri window per session,
one document, a fenced `ares-surface` JSON envelope with `replace_document` /
`replace_region` / `set_css` / `set_script` / `post`, rendered in an
opaque-origin iframe with scripts on and a `default-src 'none'` CSP. A
postMessage bridge gives the document `ares.send(text)` (becomes a user
message tagged as an in-surface interaction) and `ares.onPost(payload)` (live
data from Ares). FORGE vs INHABIT doctrine keeps the model from rebuilding the
room on every chat line. Snapshots and history live in `localStorage`.

Strengths dsh does not have: the sandbox is real (no parent access, no
network), the model generates **in the turn**, and posts update a running
document without a rebuild.

Gaps against dsh: it is a separate experiment window, not the shell; one
document per session, unnamed, not persistent across sessions; the only live
data is what the model chooses to `post` during a turn, so nothing updates
while Ares is idle; no placement, no offer card, no undo, no theme tokens, and
document mutations reload the iframe and drop script state.

## The design

Three layers. The first is the one the owner means by "creator mode" and it
does not wait on the plugin kernel.

### Layer 1 — Surfaces: generative UI, everywhere Ares is

A **surface** is a named, versioned, sandboxed HTML document Ares writes,
placed somewhere in the app, fed live data by the daemon, able to act through
Ares, and portable to every screen Ares has.

**Placement.** Same idea as dsh's four locations, mapped onto the shell we
have and extended:

| placement | where it renders | use |
|---|---|---|
| `card` | inline in the transcript, under the reply, like a tool card | a one-off chart, a form, a picker, a mini-game; the cheapest generative UI and the one used most |
| `rail` | a tab in the right rail beside the conversation | watch-while-chatting: a log, a checklist, a live view of a watch |
| `pane` | a full pane next to Messages / Forge / People | a dashboard, a tracker, an editor; opened from a pinned entry in the sidebar |
| `window` | its own Tauri window (today's Living Surface) | games, rooms, anything that wants the whole screen |
| `phone` | a screen in the iPhone app | the same document in a webview; Ares already pairs the phone |
| `telegram` | a Telegram Mini App button on the message | the same document opened from Telegram, with `ares.send` routed back through the bot |

One document, six screens. dsh is Web only. Nothing in the document changes
between placements; only the host chrome and the bridge transport do.

**Native look without giving up the sandbox.** dsh gets theme tokens for
free because its pages are React in the page. We keep the iframe (the owner
chose scripts-on for local use, and the opaque origin is what makes that
safe) and inject the shell's design tokens into the document: the surface and
accent ramps `prefs.ts` already derives, type scale, radii, the glass panes.
Theme changes re-post the token sheet; the document never knows which theme
it is in. The photosensitive doctrine (nothing flashes) is enforced two ways:
in the prompt, and by a static scan of the CSS and script that rejects
animations under 300 ms and any `setInterval` under 100 ms that touches
style.

**Feeds: live data without a model turn.** This is the biggest gap and the
biggest win. A surface declares the feeds it wants in its manifest, and the
desktop subscribes on its behalf; the daemon pushes updates through
`ares.onPost` while Ares is idle, in another session, or asleep:

| feed | source |
|---|---|
| `session.events`, `session.status` | the session kernel event stream (already pushed to the desktop) |
| `agent.<id>.status` | roster agent state, avatar pose |
| `track.<watchId>` | a Track watch's latest samples |
| `connector.<id>.<query>` | a read-only query against a connected service (Gmail inbox, calendar, Hue state, Withings, bank balance) run on the daemon on an interval the manifest sets |
| `memory.recall(<query>)` | Mnemosyne recall, refreshed when memory changes |
| `file.<path>` | a workspace file, re-posted on change |
| `tool.<name>(<input>)` | any read-only belt tool run on an interval |

Feeds are the manifest's capability list. The owner approves the manifest
once, on the card, and the daemon enforces it: a surface cannot ask for a
feed it did not declare. dsh's pages read any Client service they like;
ours read exactly what the owner saw.

**Actions: the surface acts through Ares, with Ares's permissions.** Today a
surface can only `ares.send(text)`. Add `ares.call(tool, input)` for tools the
manifest names. The call goes through the same permission classifier as a
tool call from the model: read-only runs, external-state asks the owner, owner
decisions always ask. A "Pay" button on a bills surface therefore produces
the same approval card as Ares deciding to pay. The surface is a face on the
belt, not a bypass.

**Morph, don't reload.** `replace_region` and friends should patch the live
DOM (idiomorph-style) so script state and scroll survive. `replace_document`
keeps reload semantics. This closes the known Living Surface gap.

**Ledger, revisions, editing.** Every surface is a directory in
`~/.ares/surfaces/<name>/` holding the document, the manifest and a `git`
history. Keep, unmount, rollback and **edit** all work on it. dsh cannot edit
a page after creation and keeps no history; we get both from the ledger. A
surface is shared between Ares instances over Oricle net like any other
ledger entry, and the people directory can list a surface a person chooses to
publish.

**Two ways to get one.**

- *Inline* (default for `card`, and for anything small): Ares writes the
  document in the turn, as the Living Surface does today. Nothing to click.
- *Offered* (for `rail`, `pane`, `window`, and anything the friction log
  suggests): Ares answers, then attaches one card: name, a two-line brief,
  placement picker, the feed list in plain words, and Make it. On Make it a
  background child agent builds it with the `surface` skill, test-renders it
  in a hidden webview, checks the doctrine scan, and installs it as a trial.
  The card then shows Open, Keep, Undo. Same shape as dsh's card, plus the
  manifest the owner is approving and the trial state.

The offer rules are dsh's, which are right: an explicit ask, or the owner's
own words say the data keeps changing or they will interact with it, or it is
a live view of Ares's own state. A table that merely looks dynamic earns no
card. One card per turn. A declined offer stays declined for the
conversation. Ares's addition: the friction log can trigger an offer
("you've asked for this balance four days running, want a rail for it?").

**Trial state.** An offered surface mounts as a trial: it lives in the
session it was made in until the owner says Keep. A trial that throws three
times, exceeds its manifest, or outlives the session is removed and the owner
told once. Kept surfaces remount at boot in their placement.

**Agents own surfaces.** A roster agent can have a surface as its face, in
the pane the agent already has. The flame-guy avatar and the agent-made
avatars already give agents a visual identity; this gives them a working
one.

### Layer 1b — The root surface: Ares rebuilds the whole shell

Everything above places surfaces *inside* a hand-built shell. The next step
is to make the shell itself a surface. Four levels, each a superset:

| level | what Ares can author | what stays native |
|---|---|---|
| 0 (today) | one document in its own window | everything else |
| 1 (above) | documents in card / rail / pane / window / phone / Telegram slots | the shell: layout, sidebar, composer, Messages, People, Forge, settings, approval cards |
| 2 | the **root surface**: the window's layout itself. Which regions exist, where, what each contains (a surface, a native pane, an agent's face), the composer, the sidebar, the theme | the **chrome floor** (below) |
| 3 | `tauri/src` itself, through `Harness propose` | nothing, but it ships only through verify + Deploy card |

At level 2 the desktop becomes a thin host: windowing, the bridge, feeds,
theme tokens, the permission chrome. The default shell Ares ships with is
just the first revision of the root surface, in the ledger like any other,
and "restore default" is a rollback. Ares can, in one turn, turn the app into
a terminal, a war room, a chat client, a game console, or a single giant
avatar that talks, and turn it back.

**The chrome floor.** A fixed set of native regions the root surface cannot
draw, cover, resize below a minimum, or imitate, rendered by the shell into
reserved space the surface declares but does not own:

- approval cards and permission prompts (a surface must never be able to
  draw a fake one, or hide a real one);
- the kill switch and pause;
- settings that hold secrets: keys, sign-ins, pairing, the updater;
- the update banner and crash recovery;
- a one-click "restore default shell" and the revision picker.

The floor is why level 2 is safe to allow at all. The sandbox keeps a
surface from *doing* anything it was not granted; the floor keeps it from
*misleading the owner* about what it is doing.

**What it takes beyond Layer 1.** A `layout` manifest kind (regions, sizes,
which surface or native pane fills each, floor reservations); the shell
reading that manifest instead of its hard-coded `App.tsx` layout; native
panes (Messages, People, Forge, Settings) registrable as fillers so a root
surface can keep the ones it wants; the floor enforced in the host, not the
document. The current `App.tsx` is several thousand lines of exactly the
layout decisions this would move into a document, which is also the
argument for it.

**Drift guard.** A UI that rewrites itself drifts. Every root revision is
named and dated, trials never become the boot layout without Keep, the
owner can pin a revision as "daily driver" so FORGE experiments happen in a
separate window and never replace the layout they are typing in, and the
floor cannot be edited by any level below 3.

### Layer 2 — Extensions: tools, skills, agents, watchers

Same ledger, same trial-mount model, for the kinds that are not UI:

| kind | on disk | runs as |
|---|---|---|
| `tool` | `tool.ts` exporting `buildTool(...)` + `test.ts` | a kernel plugin providing `tool/<Name>`, executed in a worker under a capability manifest, mounted into the deferred tier so the prompt cache survives and `ToolSearch` finds it the same turn |
| `skill` | `SKILL.md` + references | copied into `~/.ares/skills` |
| `connector` | an MCP or OpenAPI spec | the existing Connect path |
| `agent` | a roster entry: persona, brain, effort, tool allow-list, skills, surface | the existing roster |
| `watcher` | a trigger (cron, Hook, Track condition, bus event) + instruction + agent | Remind / Hooks / Track under one manifest |

Tools need plugin-kernel Step 1 (belt tools as plugins, a live deferred
catalog). The other four are thin fronts over paths that exist.

Two tools expose all of this to the model:

- **`Introspect`** (read-only): tools with schema sizes and prompt-budget
  share, kernel roster, services, prompt sections against the 14,200 budget,
  friction and reliability digests, surfaces and their feeds, skills,
  connectors, the surface bridge's recent intents. This is dsh's two
  inspection tools plus the telemetry dsh does not have.
- **`Extension`**: `draft`, `mount` (owner decision on the manifest),
  `try`, `keep`, `unmount`, `rollback`, `edit`, `list`, `show`. Surfaces are
  one kind of extension here, so a surface and the tool it calls can be
  forged in one go.

### Layer 3 — Harness: changing Ares itself

dsh stops at plugins. Ares already has the forge worktree, `ares-verify`, the
Deploy card and auto-rollback (`docs/ELITE-SELFIMPROVE.md`). A `Harness
propose` tool fronts it for the cases an extension cannot cover (a new feed
source, a new placement, a kernel seam). High-risk labelling unchanged.

### The skills, not prompt text

dsh's correct lesson: the procedure lives in skills that load on demand.
Three bundled skills, each under 8 KB with references:

- `surface`: placement choice, the manifest, the FORGE/INHABIT doctrine,
  LOCAL FIRST (surface-only controls handled by the document's own script),
  the feed and action bridge, the photosensitive rule, a template per
  placement, the quality bar (complete controls, arrive whole, no mock).
- `extension`: the belt tool contract, safety labels, owner decisions,
  `postMutationFeedback`, the capability manifest, a template per kind.
- `creator-offer`: when to attach a card and when not to, the brief format,
  one card per turn, how to hand a brief to the background child.

## How reprogrammable is that, and by whom

The question this design has to answer plainly: can a person's Ares fix its
own UI bugs and backend bugs, on their machine, without us shipping a
release? Layer by layer:

| what breaks | who fixes it, how | needs from us |
|---|---|---|
| a surface or the root layout (a pane renders wrong, a button is in the wrong place, a feed shows stale data) | their Ares, in the turn: edit the ledger document, trial, keep. Rollback if worse. | Layer 1 + 1b |
| a missing capability (no tool for X, no watcher for Y, a connector not wired) | their Ares forges an extension, mounts it as a trial, keeps it | Layer 2 |
| a daemon bug inside an existing seam (a provider's retry logic, a tool's parser, a connector's auth refresh, a prompt section) | their Ares mounts a **replacement provider** for that seam through the kernel: same service name, new implementation, hot-swapped, reversible. The shipped code is untouched on disk. | kernel Steps 1, 3, 4 (belt, queryEngine stages, execution world as seams) |
| a daemon bug outside any seam (the session kernel, the loop itself, the permission classifier) | `Harness propose`: edit the source in a forge worktree, build, verify, Deploy card, smoke, auto-rollback. On a packaged install this needs the TypeScript source and a Node toolchain shipped or fetched, and a slimmer verify than the full suite. | Layer 3 made to work on installs, not just doingbox |
| the Rust shell, WebView host, updater, installer | nobody from inside. A signed release from us. | release pipeline, unchanged |

So: everything a person sees is reprogrammable at level 1b; most of what
Ares does becomes reprogrammable as the kernel's seams land, because a seam
is precisely "a thing you can swap without a rebuild"; the loop itself is
reprogrammable only through the verified self-change path; the native host
and the signing keys never are.

**The floor, restated for the backend.** Four things must not be replaceable
by anything the model mounts, however the owner has set permissions:

1. the permission classifier and approval path (a swapped provider could
   otherwise approve itself);
2. the kernel and the manifest enforcer (the thing that decides what a
   plugin may touch cannot be a plugin);
3. secrets handles and the vault;
4. the updater's signature check and the chrome floor.

Those change only at Layer 3, labelled high-risk, with the owner's explicit
acknowledgement on top of the Deploy approval, as the self-improve doc
already requires.

**People fixing each other's Ares.** A fix is a ledger entry (a surface
revision, an extension, a seam replacement). Oricle net already syncs
ledgers between instances and the people directory already lists people.
So a fix one person's Ares made can be offered to another's, and a fix many
people kept is a strong signal for what the next release should contain.
Rules so this is not a supply chain hole: a shared entry carries its
author's signature and its manifest; receiving it is a trial mount behind
the same owner decision as a local one; seam replacements from other people
are off by default and never auto-apply; nothing shared can touch the floor.
This is dsh's plugin market index, except the units are fixes people's own
agents made, and the verification is the same manifest and trial every local
change gets.

**What "self-fixing a backend bug" needs to be real, not a demo.** A
reproduction the model can run (the friction log and crash artifacts give
it); a fast local check (a per-seam test set, not the full gate); a rollback
that actually fires (kernel unmount for seams, `ares-deploy` for source);
and the model being good enough, which on a person's machine means their
chosen brain, so the trial state is doing real work here, not ceremony.

## Side by side

| | dsh Creator / Personalized pages | Ares surfaces + extensions |
|---|---|---|
| What a generated page is | a React plugin in the page's own tree, unsandboxed | a sandboxed document with injected theme tokens, same look, no page access |
| Where it can live | right sidebar, session tab, global page | card, rail, pane, window, phone, Telegram Mini App |
| Live data | reads Client services and session projections directly, no limits | declared feeds pushed by the daemon while Ares is idle; the owner approved the list |
| Acting | user actions call application operations with Creator's permissions | `ares.call` through the belt's own permission classifier and approval cards |
| Build | always a background subagent, long and token-heavy | inline in the turn for cards and small surfaces; background only when offered |
| Edit after creation | deferred, not supported | `Extension edit` on the ledger copy |
| Versions | none; Restore reinstalls one kept copy | git history per surface, rollback to any revision |
| Undo | uninstall, files linger | kernel-style teardown; trial auto-removal; ledger stays clean |
| Theme | native tokens, light/dark | injected token sheet, same ramps the shell uses; photosensitive scan |
| Reload on change | React re-render | DOM morph; script state survives |
| Why it offers | explicit ask or user's words about changing data | the same, plus the friction log |
| Reach | Web | desktop, phone, Telegram, people directory, Oricle net |
| Self-change | none | forge worktree + signed verify + Deploy card |

## Build order

Layer 1 does not depend on the kernel; it is protocol, desktop, and one
daemon feed service. That is why it goes first.

1. **Surface manifest + ledger.** `~/.ares/surfaces/<name>/` with
   `surface.json` (name, placement, feeds, actions, revision) and the
   document; git-backed; a `surfaces_list` wire command. Move Living Surface
   snapshots out of `localStorage` into it.
2. **Placements in the shell.** `card` (transcript) and `rail` first, then
   `pane` with a pinned sidebar entry; `window` is the existing path. Theme
   token injection and the doctrine scan land here.
3. **Feeds.** A daemon subscription service that maps feed names to the
   event stream, Track, connectors, memory, files and read-only tools, and
   posts into the mounted surface's bridge. Enforced against the manifest.
4. **Actions.** `ares.call` in the bridge, routed through the permission
   classifier; approval cards for the rest.
5. **The offer card + background build + trial state.** Reuses the approval
   card component (the light-theme fix on the current branch matters here).
6. **Morph instead of reload** for region mutations.
7. **Phone and Telegram placements** (phone webview; Telegram Mini App with
   `ares.send` over the bot).
8. **The root surface.** The `layout` manifest, the shell reading it, native
   panes as fillers, the chrome floor enforced in the host, the default
   shell saved as revision one, restore-default and daily-driver pinning.
9. **`Introspect`**, then **`Extension`** over the surface ledger and the
   four non-tool kinds.
10. **Kernel Step 1**, then the `tool` kind with its worker and manifest.
11. **`Harness`** last.

Each step ships alone and is useful alone.

## Built (2026-11-04) and what is still design

Owner direction, same day: no limits on what Ares may change, everything people do persists and reverts, every module travels between installs, other harnesses' plugins import, and a module can be promoted to base. That replaces the trial lifetimes and the fixed floor described above.

| piece | state |
|---|---|
| GenUI switch (button next to Forge, `<home>/genui.json`) | built, checked through a bridge. Off blocks every self-changing tool action at validation, plus Edit/Write into an Ares checkout. Bash and ApplyPatch are not blocked. On: tools preloaded, per-turn briefing, whole-UI animation, greeting from the open agent |
| Shell `script`: JavaScript in the real app, always an owner card | built; run, reset and no-loop-on-replay checked through a dev bridge. The native `ares_shell_eval` path has not run |
| side panels, `ares.share` links, dropdown nav entries, Shell `go` | panels, links and dropdown checked live; `go` covered by tests only |
| Anywhere: `at:<position>:<selector>` against any element, `Introspect ui` screen map, `window` as a real OS window that reopens at boot | selectors checked in the titlebar and Settings; the window route checked in the preview, the native window itself has not run |
| Eyes: every Surface and Shell change returns a real screenshot and a landing report (off screen, covered, clipped, script faults); `Introspect look`, `tour`, `at`, `colors` | built, driven live with a real model through the bridge. The native WebView2 capture compiles; whether it ran in the exe is recorded in the memory note |
| Hands: `Shell try` clicks, types or presses a key in the app or inside a surface | built, driven live |
| `ares.toggle/show/hide`, `frame.hidden`, `ares.store`, `Shell add_css`, merged `vars`, see-through floating surfaces, `--ares-fill/blur/rim/shadow` | built, driven live |
| `Surface`: card, rail, pane, root, all `slot:` regions; feeds; `ares.call`; offer card; morph | built. `ares.call` and morph checked against the real host component, slots through a bridge. Offer card covered by tests only |
| `Shell`: rewrite the left strip, hide regions, live CSS, tokens, rollback, reset | built, checked live through a bridge; hiding approvals needs its own explicit flag |
| `Extension`: tool (worker sandbox + manifest scan, kernel mount), skill, hook | built, tested. Hooks run with the owner's full authority |
| `Modules`: list, trash + restore, export `.arespack`, inspect, import, promote to base | built, tested with fixtures for each foreign format |
| Foreign import | Claude Code plugins (skills, commands, remote MCP, shell hooks), skills folders, `.mcp.json`, dsh bundles (skills only). Runtime code for another harness cannot run and is named as skipped; local-command MCP servers and subagents are skipped too |
| `Harness`: source, apply, revert, propose | apply's boot test verified against the packaged runtime. The launcher's promotion and fallback compile but have not run. Rebuilding needs git, Node 22 and pnpm on the machine |
| Rebuilding the desktop UI or the Rust shell on an install | **not built**: the front end is embedded in the signed exe, so it changes through `promote` + a release, or through Shell and surfaces |
| phone and Telegram placements | **not built** |
| friction-driven offers | **not built** |
| kernel Step 1 for built-in tools | **not built**: forged tools are kernel tenants, built-ins are the static belt |
| Oricle-net sharing | **not built**: a `.arespack` file is the sharing path today |

A forged tool's sandbox is a capability floor, not a proof against a hostile module. Hooks and imported hooks have no sandbox at all, and the import card says so.

## Not doing

- A Creator preset or a mode the owner has to pick. "Make me a pane for
  that" works in any thread.
- Unsandboxed generated UI in the shell. The sandbox is the reason scripts
  are allowed at all.
- Letting a surface skip the manifest because `ask_before_acting` is off.
  Mounting is a different act from running a command; the first mount asks.
- Re-verification ceremony: a trial surface either works on the owner's
  screen or gets removed.
- Adopting Cordis. Same call as the kernel doc.
