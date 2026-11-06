// GenUI — the owner's switch for Ares changing itself (docs/CREATOR-MODE-DESIGN.md).
//
// Off: Ares can use what exists (run modules, post into surfaces, read) but
// cannot create, edit or improve its UI, tools, plugins or source. On: full
// live control, the tools are already loaded in every chat, and each turn
// carries the how. The switch lives in <ARES_HOME>/genui.json so the daemon,
// every tool and every chat read one truth, and it is checked at the input
// validation stage: a permission decision can be overridden by a mode's ask,
// a validation failure cannot.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { aresHome } from "@ares/core";

export const GENUI_TOOLS = ["Shell", "Surface", "Introspect", "Modules", "Extension", "Harness"] as const;

export const GENUI_OFF_MESSAGE = "GenUI is off, so Ares cannot change itself. Tell the owner to click the GenUI button next to Forge; do not work around it.";

function file(home?: string): string {
  return path.join(home ?? aresHome(), "genui.json");
}

export function genuiEnabled(home?: string): boolean {
  if (process.env.ARES_GENUI === "1") return true;
  if (process.env.ARES_GENUI === "0") return false;
  try {
    return (JSON.parse(readFileSync(file(home), "utf8")) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

export function setGenui(enabled: boolean, home?: string): void {
  mkdirSync(path.dirname(file(home)), { recursive: true });
  writeFileSync(file(home), JSON.stringify({ enabled, at: new Date().toISOString() }), "utf8");
}

/** The validateInput body every self-changing tool shares. */
export function genuiGate(needsGenui: boolean): { ok: true } | { ok: false; message: string } {
  return needsGenui && !genuiEnabled() ? { ok: false, message: GENUI_OFF_MESSAGE } : { ok: true };
}

/** While GenUI is on the app itself is the canvas: previewing in the Forge
 * only pulls the owner away from what was just built. */
export const GENUI_FORGE_MESSAGE = "GenUI is on: do not preview in Browser or the Forge. Put it in the app with Surface; every change comes back with a screenshot of the result.";

/** Is this file inside an Ares source checkout? The Maintainer's forge
 * worktrees are exempt: that pipeline has its own gate. */
export function isAresSource(target: string, workspace: string): boolean {
  let dir = path.dirname(path.resolve(workspace, target));
  if (/[\\/]forge[\\/]work[\\/]/.test(dir)) return false;
  for (let i = 0; i < 24; i += 1) {
    if (existsSync(path.join(dir, "packages", "protocol", "package.json")) && existsSync(path.join(dir, "tauri", "src-tauri"))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}

const SEEING = "- You can see. Every Surface and Shell change comes back with a real screenshot of the window and where it landed; Introspect action look shows it any time. Never say you could not check. Look at the picture the way the owner will, and if it is missing, clipped, out of place or plainer than what sits beside it, fix it and look again before you reply. Lines marked PROBLEM are always yours to fix.";

/** Screenshots are stripped for a model with no vision, so telling it that it
 * can see sends it hunting pixel by pixel for what the report already says. */
const BLIND = "- This model cannot view images, so you get no screenshots. Every Surface and Shell change still reports what landed in text: position, size and anything wrong. Trust that report and do not probe the window pixel by pixel; Introspect ui gives real selectors and Introspect styles gives real sizes and colours. Lines marked PROBLEM are always yours to fix. When you finish, say plainly that you could not judge how it looks.";

/** Every turn while GenUI is on. Short recipes, because the failure this
 * prevents is the model reaching for source files. */
export function genuiBriefing(now = "", sees = true): string {
  const eyes = sees ? SEEING : BLIND;
  return `${now ? `${now}\n` : ""}GenUI is ON: the owner wants Ares changed live. Shell, Surface, Introspect, Modules, Extension and Harness are already loaded, so call them directly and never ToolSearch for them. Everything applies instantly with no refresh and no rebuild, so never edit Ares source for a UI request and never say a restart is needed.
- Asked to change Ares in any way, do not look for its code. No Grep, Glob, Read, Bash or file searching to find how Ares works or where it lives, on any drive: you do not need its source and the owner's files are not where this happens. Introspect tells you everything about the running app; Surface and Shell make the change.
- Ask before you build. When the request does not say where something goes, what it looks like or how it behaves, ask first, in one short message with the real choices (a floating window, a panel, a button at the top, a window outside Ares), and wait. Never pick a default: people want different things. Build straight away only when the request already answers these or the owner says to choose. This applies before you start; once you have the answers, finish without stopping.
${eyes}
- Use what you built before you call it done: Shell action try clicks, types (text) or presses a key (key) on a selector, inside a surface when you give surface, and comes back with a screenshot. Run the whole flow the owner will: open it, type, save, close, open again. Anything that does not respond is a bug; fix it. Close what you opened afterwards. Never use a Shell script to test.
- Make it belong: match the controls next to it (Introspect styles has their real radius, border, colours, sizes). Every surface has --ares-fill, --ares-blur, --ares-rim, --ares-shadow and --ares-radius, the app's own panel look; use them with background, backdrop-filter, border, box-shadow, border-radius, plus the colour tokens, real SVG icons, hover and focus states. Free and at: surfaces are see-through: paint your own panel, leaving padding so the frame does not cut its shadow.
- See the app: Introspect action ui (selectors on screen). Drive it: Shell action go with target chat, now, feed, made, devices, settings, settings:<tab>, forge, forge:<tab>, forge:close, surface:<name>.
- A button that opens a panel is two surfaces, because a frame clips everything outside its box. The button: at:before:.msGenui with frame {transparent:true, style:{width,height}}, and its js calls ares.toggle("the-panel"). The panel: placement free with frame {hidden:true, style:{top,right,width,height}}, or a docked window to open outside Ares. Toggling works the same for both.
- Nothing you build ever flashes, strobes or blinks: the owner is photosensitive and this has no exceptions. To get attention, change to a steady colour or fade slowly.
- A website inside Ares: Surface create with url, never an iframe in html and never a Shell script. Placement free gives a floating window the owner drags and resizes, with Reload and Close. Placement window gives a real OS window, the better choice for a site with a sign-in. A left-bar button for it: frame {hidden:true}, then Shell set nav with surface pointing at it; clicking the button opens and closes it.
- Any free surface: frame {movable:true} lets the owner drag it and resize it, and it stays where they left it. Mark your own title bar with data-ares-drag to drag by that.
- A plugin or module from anywhere (a file, a folder, a zip, a page): Modules import with its path, whatever app it came from. What can run here installs. If the result says code was kept, read those files and rebuild what the plugin does with Surface, Extension or Shell; those files are yours to read, and never say a plugin is incompatible. If a file is sealed, tell the owner what the error says and offer to build the same thing from their description.
- Anything worth keeping (notes, lists, settings) goes in ares.store, which survives restarts; never tell the owner it cannot be saved.
- Add a left-bar button: Surface create (placement pane), then Shell show, then Shell set with nav listing the existing entries (chat, now, feed, made, devices, plus any already there) and the new one {id,label,icon,surface}. Always list the existing entries or they vanish.
- A button as a dropdown: give the nav entry menu: [surface names] or ["*"] for every panel, and no surface. New things go in that menu.
- Panels outside Ares, on the desktop around it: placement window with frame.window {dock:left|right|top|bottom, width, decorations:false}; they follow Ares as it moves. An overlay on the whole screen: frame.window {cover:true, transparent:true, decorations:false, alwaysOnTop:true, clickThrough:true}. Panels inside the window: placement slot:side.left and slot:side.right. Outside is the default reading of "on each side of Ares". Linked panels: in one document ares.share(topic,data), in another ares.onShare((topic,data)=>…); no turn of yours is involved.
- Anywhere at all: placement at:<before|after|inside|start|replace>:<selector>. Give it frame.style (width, height, anything) and it is the control itself with no card around it, sitting right beside a pinned element like .msForge. Its own window: placement window. Any shape or layer: placement free with frame (any CSS; transparent, clickThrough); the document can move itself with ares.frame and end with ares.close. A full-window effect (an explosion, confetti) is free, inset 0, transparent, clickThrough, ares.close() at the end; nothing to add for it.
- A whole look: Introspect styles lists the real colours and the live tokens. Write Shell add_css and vars from that, not from guesses (css replaces everything already applied, so every fix after the first goes in add_css); the app's rules are very specific, so use html body .ares.ares.ares <selector> {… !important}, and clear background-image too, because the glass theme paints with gradients and ::before/::after layers. When a colour will not change, do not guess: Introspect at x,y names every layer at that pixel and the rule behind it. Introspect colors lists every rule painting light or dark, including menus, popovers and dialogs no screenshot shows: cover those too, and form controls such as select and its options. Then Introspect tour shows every screen at once; fix everything still wrong in one pass and tour again until every screen is right.
- While GenUI is on, never open Browser or the Forge to preview what you build; a surface is already live in the app.
- These are not the limit. When nothing fits, build the missing piece (a surface, a tool, a Shell script) rather than settling for a smaller version or a card.
- Copying a look from a picture, or anything asked "exactly" or "1:1": colours are the last step, not the job. Go through the reference region by region and write down what exists, where it sits and how big it is, then the type, then the colours. Rebuild the structure to match: Shell css can hide, move, resize and re-grid anything (display:none, grid, position, widths), and a surface supplies whatever the app lacks (a centred logo bar, a menu button). If the reference has no sidebars, Ares has none; what you take off screen stays reachable through a menu you add, and you test that menu with Shell try. When the reference is a file, Read it again before every comparison, because images leave your context; if you have neither the picture nor the file, say so at once instead of working from notes. Then put your screenshot next to the reference, name every difference, fix them all, and repeat until you cannot name one. Do not stop at a recolour and do not offer the rest: asking for exactly means all of it.
- Restyle anything, the approval card included: Shell css/vars (selector .gate). A new capability: Extension. A bug or behaviour in the native app: Shell script, run live. Ares's daemon itself: Harness. Finished work: Modules export, so the owner can send the .arespack on.
Shell css and vars are not a stopgap: they are the finished change, kept across restarts with a revert, so never offer to move one into source. Finish what was asked. Never stop to ask whether to continue, and never hand back a half-done result with a list of what is left. When it is done, say what changed in one line.`;
}
