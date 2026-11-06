// Shell — Ares recomposes its own window (docs/CREATOR-MODE-DESIGN.md).
//
// Surfaces fill regions; this reshapes the regions themselves. A layout is a
// small document: native regions to hide, tabs to add to the navigation (each
// opens a surface), CSS applied to the REAL shell, and token overrides. It is
// data, versioned under <ARES_HOME>/shell, so "undo" is a rollback and a
// broken layout is one reset away. The desktop applies it live from the
// daemon's shell_layout event.
//
// Hiding the approval path is allowed, because the owner said no limits, but
// it is the one change that needs its own explicit word in the call: without
// `allow_hide_approvals`, a layout that hides it is refused, and with it the
// card names exactly what is being given up.

import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import vm from "node:vm";
import { z } from "zod";
import { aresHome } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";
import { lookAtUi, withEyes } from "./uiLook.js";
import { genuiGate } from "./genui.js";
import { listSurfaces } from "./surfaceStore.js";

export const shellGo = new EventEmitter();
export const SHELL_REGIONS = ["rail", "rail.nav", "rail.foot", "status", "stage.head", "forge", "composer", "approvals"] as const;
export type ShellRegion = (typeof SHELL_REGIONS)[number];

export interface ShellTab {
  id: string;
  label: string;
  /** The surface this tab opens. */
  surface: string;
}

/** One entry of the left navigation strip. An id of chat, now, feed, made or
 * devices is the built-in tab (rename, recolour, move it); any other id must
 * name a surface. Built-ins left out of the list are gone from the strip. */
export interface ShellNavEntry {
  id: string;
  label?: string;
  icon?: string;
  tone?: string;
  surface?: string;
  /** Makes this entry a dropdown: surface names, or ["*"] for every panel. */
  menu?: string[];
}

export interface ShellLayout {
  revision: number;
  hide: ShellRegion[];
  tabs: ShellTab[];
  /** The whole left strip, in order. Empty keeps the default. */
  nav: ShellNavEntry[];
  /** JavaScript run inside the real app: how a person fixes a native bug live.
   *  It has the app's full authority, so setting it is always an owner call. */
  script: string;
  /** Applied to the live shell, after every built-in stylesheet. */
  css: string;
  /** CSS custom properties set on the shell root (e.g. "--accent"). */
  vars: Record<string, string>;
  note?: string;
  at: number;
}

const EMPTY: ShellLayout = { revision: 0, hide: [], tabs: [], nav: [], script: "", css: "", vars: {}, at: 0 };
const KEPT = 50;
const MAX_CSS = 200_000;

class ShellBus extends EventEmitter {}
export const shellBus = new ShellBus();

function dir(home?: string): string { return path.join(home ?? aresHome(), "shell"); }
function currentFile(home?: string): string { return path.join(dir(home), "layout.json"); }
function revisionFile(revision: number, home?: string): string { return path.join(dir(home), "revisions", `${String(revision).padStart(5, "0")}.json`); }

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(5).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

/** CSS runs in the trusted page, so it must not be able to phone home: the
 * app CSP is the wall, and this keeps a remote reference out of the ledger. */
export function shellCssProblem(css: string): string | null {
  if (css.length > MAX_CSS) return `css is over ${MAX_CSS} characters`;
  if (/@import\b/i.test(css)) return "@import is not allowed in shell css";
  if (/url\(\s*["']?\s*(?!data:|#)/i.test(css)) return "url() may only hold data: URIs in shell css";
  return null;
}

export async function readShellLayout(home?: string): Promise<ShellLayout> {
  try {
    return { ...EMPTY, ...(JSON.parse(await readFile(currentFile(home), "utf8")) as Partial<ShellLayout>) };
  } catch {
    return { ...EMPTY };
  }
}

export async function commitShellLayout(next: Omit<ShellLayout, "revision" | "at">, home?: string): Promise<ShellLayout> {
  const problem = shellCssProblem(next.css);
  if (problem) throw new Error(problem);
  const current = await readShellLayout(home);
  const layout: ShellLayout = { ...next, revision: current.revision + 1, at: Date.now() };
  await writeJson(revisionFile(layout.revision, home), layout);
  await writeJson(currentFile(home), layout);
  const files = (await readdir(path.join(dir(home), "revisions")).catch(() => [] as string[])).sort();
  for (const stale of files.slice(0, Math.max(0, files.length - KEPT))) await rm(path.join(dir(home), "revisions", stale), { force: true });
  shellBus.emit("layout", layout);
  return layout;
}

export async function rollbackShellLayout(revision: number, home?: string): Promise<ShellLayout> {
  const raw = JSON.parse(await readFile(revisionFile(revision, home), "utf8").catch(() => { throw new Error(`no shell revision ${revision}`); })) as ShellLayout;
  return commitShellLayout({ hide: raw.hide, tabs: raw.tabs, nav: raw.nav ?? [], script: raw.script ?? "", css: raw.css, vars: raw.vars, note: `rolled back to revision ${revision}` }, home);
}

export function resetShellLayout(home?: string): Promise<ShellLayout> {
  return commitShellLayout({ hide: [], tabs: [], nav: [], script: "", css: "", vars: {}, note: "reset to the default shell" }, home);
}

const inputSchema = z
  .object({
    action: z.enum(["show", "set", "go", "try", "rollback", "reset"]).describe("try: use the app as the owner would and see the result: clicks target (a CSS selector), or types text into it, or presses key on it; give surface to act inside that surface's document, leave it out to act on the app itself. Comes back with a screenshot. show: the current layout. set: replace the fields given (others keep their value). go: drive the app now (target). rollback: back to a revision. reset: the default shell."),
    target: z.string().max(120).optional().describe("go: chat, now, feed, made, devices, settings, settings:<tab>, forge, forge:<tab>, forge:close, or surface:<name>."),
    surface: z.string().optional().describe("try: the surface whose document to act in."),
    text: z.string().max(4000).optional().describe("try: type this into target instead of clicking it."),
    key: z.string().max(24).optional().describe("try: press this key on target instead of clicking it (Enter, Escape, ...)."),
    hide: z.array(z.enum(SHELL_REGIONS)).optional().describe("Native regions to hide."),
    tabs: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), label: z.string().min(1).max(24), surface: z.string() }).strict()).max(16).optional().describe("Tabs to append to the left strip; each opens a surface."),
    nav: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), label: z.string().max(24).optional(), icon: z.enum(["chat", "pulse", "news", "grid", "devices", "search", "forge", "settings", "people", "at", "plus", "download", "bug"]).optional(), tone: z.string().max(24).optional(), surface: z.string().optional(), menu: z.array(z.string()).max(64).optional() }).strict()).max(16).optional().describe("The ENTIRE left strip (Chats, Now, Feed, Made, Devices), in order. Use id chat/now/feed/made/devices for a built-in (label/icon/tone rename and recolour it; leave one out to remove it). Any other id needs surface (opens it) or menu (a dropdown of surface names; the single name * means every panel). [] restores the default."),
    add_css: z.string().optional().describe("CSS added after what is already there. Use this for every fix to a look: nothing already applied is lost."),
    css: z.string().optional().describe("Replaces ALL the shell's CSS, so anything not repeated here is gone; to add or fix a rule use add_css. CSS for the real shell. Selectors: .ares, .rail, .stage, .chat, .forge, .statusBar. No @import; url() only with data:."),
    script: z.string().max(200_000).optional().describe("JavaScript run inside the real app now and at every start, with no reload: setting a new script stops the old one and removes the observers, timers, listeners and createElement nodes it made; return a function to undo anything else. For fixing or changing native behaviour (patch a handler, change the approval card's markup, anything) when a surface or CSS cannot. Full app authority. Empty removes it. Prefer css, then surfaces, then this."),
    vars: z.record(z.string()).optional().describe("Token overrides, merged into the ones already set, e.g. {\"--accent\":\"#ff3300\",\"--r-md\":\"4px\"}."),
    revision: z.number().int().positive().optional().describe("rollback: target revision."),
    allow_hide_approvals: z.boolean().optional().describe("Must be true for a layout that hides 'approvals'; set it only when the owner said so in this conversation."),
    note: z.string().max(400).optional().describe("set: what changed, one line."),
  })
  .strict();

export interface ShellOutput {
  message: string;
  layout?: ShellLayout;
}

export const ShellTool = buildTool<typeof inputSchema, ShellOutput>({
  name: "Shell",
  description:
    "Change Ares's own app live: add, rename, remove or reorder buttons and tabs in the left bar (Chats, Now, Feed, Made, Devices), each new one opening a surface; instant, no rebuild, no refresh. Also hide native regions, restyle the live shell with CSS, override design tokens. Applies live and is versioned; rollback and reset always work. Use Surface to put content in a region (slot:rail.top, slot:composer.dock, …) and Shell to change the regions themselves. Hiding 'approvals' needs allow_hide_approvals and the owner's own words.",
  // Reversible in one click, so it asks nobody; the one exception is below.
  safety: "read-only",
  ownerDecisions: true,
  concurrency: "exclusive",
  inputZod: inputSchema,
  validateInput: async (input) => genuiGate(input.action !== "show"),
  watchdogTimeoutMs: 15_000,
  activityDescription: (i) => (i.action === "show" ? "Reading the shell layout" : "Reshaping the shell"),
  async checkPermissions(input, ctx) {
    if (input.action === "show" || input.action === "go") return { kind: "allow" };
    if (ctx.permissionMode === "plan") return { kind: "deny", reason: "The shell can only be read in plan mode." };
    if (input.action === "set" && input.script) {
      return { kind: "ask", prompt: `Run this script inside Ares${input.note ? ` (${input.note})` : ""}? It has the app's full authority, including answering approval cards, and runs at every start. Ctrl+K, Reset the shell removes it. If it breaks the app, delete shell\\layout.json in the Ares folder.`, suggestion: "allow_once", ownerDecision: true };
    }
    if (input.hide?.includes("approvals")) {
      return { kind: "ask", prompt: "Hide the approval cards? Tools that ask would wait with nothing on screen to answer them, and a surface could draw its own imitation. The command palette (Ctrl+K, Reset the shell) brings them back.", suggestion: "allow_once", ownerDecision: true };
    }
    return { kind: "allow" };
  },
  async call(input): Promise<ToolResult<ShellOutput>> {
    try {
      switch (input.action) {
        case "go": {
          if (!input.target) return failResult<ShellOutput>("go needs target.");
          shellGo.emit("go", input.target);
          return withEyes(okResult({ message: `Went to ${input.target}.` }));
        }
        case "try": {
          if (!input.target) return failResult<ShellOutput>("try needs target, a CSS selector.");
          const look = await lookAtUi(input.surface, 9_000, { selector: input.target, ...(input.text !== undefined ? { text: input.text } : {}), ...(input.key ? { key: input.key } : {}) });
          if (!look) return failResult<ShellOutput>("No desktop answered, so nothing was tried.");
          return { ...okResult({ message: look.report }), ...(look.images.length ? { images: look.images } : {}) };
        }
        case "show": {
          const layout = await readShellLayout();
          return okResult({ layout, message: `Shell revision ${layout.revision}: hides ${layout.hide.join(", ") || "nothing"}; ${layout.tabs.length} added tab(s); ${layout.css.length} chars of css.` });
        }
        case "set": {
          if (input.hide?.includes("approvals") && input.allow_hide_approvals !== true) return failResult<ShellOutput>("Hiding approvals needs allow_hide_approvals: true, set only on the owner's own words.");
          // A script that does not parse dies inside the webview with no error to
          // catch, so it is refused here where the model can still see why.
          if (input.script) {
            try { new vm.Script(`(function(){${input.script}\n})`); }
            catch (error) { return failResult<ShellOutput>(`That script does not parse: ${error instanceof Error ? error.message : String(error)}`); }
          }
          const current = await readShellLayout();
          // A tab that opens nothing is the failure the owner sees as "dead
          // button", so it is refused here where the model can still fix it.
          const known = new Set((await listSurfaces()).map((s) => s.name));
          const dead = [...(input.nav ?? []).map((n) => n.surface), ...(input.tabs ?? []).map((t) => t.surface)].filter((n): n is string => Boolean(n) && !known.has(n as string));
          if (dead.length) return failResult<ShellOutput>(`No surface named ${dead.join(", ")}. Create it with Surface first (placement pane), then point the tab at it.`);
          const layout = await commitShellLayout({ hide: input.hide ?? current.hide, tabs: input.tabs ?? current.tabs, nav: input.nav ?? current.nav, script: input.script ?? current.script, css: [input.css ?? current.css, input.add_css ?? ""].filter(Boolean).join("\n"), vars: { ...current.vars, ...input.vars }, ...(input.note ? { note: input.note } : {}) });
          return withEyes(okResult({ layout, message: `The shell is at revision ${layout.revision}.` }));
        }
        case "rollback": {
          if (typeof input.revision !== "number") return failResult<ShellOutput>("rollback needs revision.");
          const layout = await rollbackShellLayout(input.revision);
          return okResult({ layout, message: `The shell now carries revision ${input.revision}'s layout as revision ${layout.revision}.` });
        }
        case "reset": {
          const layout = await resetShellLayout();
          return okResult({ layout, message: "The shell is back to the default." });
        }
      }
    } catch (err) {
      return failResult<ShellOutput>(err instanceof Error ? err.message : String(err));
    }
  },
});
