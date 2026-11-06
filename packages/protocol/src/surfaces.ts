/** Surfaces: named, versioned, sandboxed documents Ares writes and the desktop
 * places (a card in the transcript, a tab in the rail, a pane, a window, the
 * phone, Telegram). The Living Surface (`livingSurface.ts`) is the protocol's
 * ancestor and keeps its mutation language; this file adds what makes a
 * surface a thing with a name: the manifest the owner approves, the feeds the
 * daemon pushes into it, the actions it may take through Ares, and the
 * daemon-side patcher — the daemon has no DOM, so region edits are applied on
 * the HTML text with a tag-balanced walk instead of a parser. The desktop
 * still sanitizes everything it renders; the daemon's job is to be the one
 * truth the desktop, the phone and Telegram all read.
 *
 * See docs/CREATOR-MODE-DESIGN.md. */

import { type LivingSurfaceMutation, LIVING_SURFACE_VERSION } from "./livingSurface.js";

/** `root` is level 2 of the design: the document IS the window, under the
 * native chrome floor (approvals, stop, restore). Placing a surface there is
 * always an owner decision. */
export const SURFACE_PLACEMENTS = ["card", "rail", "pane", "window", "phone", "telegram", "root", "free"] as const;
/** The native shell's own regions a surface can occupy, as `slot:<id>`. */
export const SURFACE_SLOTS = ["rail.top", "rail.nav", "rail.bottom", "stage.top", "stage.bottom", "composer.dock", "status", "overlay", "side.left", "side.right"] as const;
export type SurfaceSlot = (typeof SURFACE_SLOTS)[number];
export type SurfacePlacement = (typeof SURFACE_PLACEMENTS)[number] | `slot:${SurfaceSlot}` | `at:${string}`;
/** `at:<before|after|inside|start|replace>:<css selector>`: against ANY element in the app. */
export const SURFACE_ANCHOR_RE = /^at:(before|after|inside|start|replace):[\s\S]{1,300}$/;

export const SURFACE_STATES = ["trial", "kept"] as const;
/** How a `free` surface sits in the window. Nothing about it is a fixed list:
 * any CSS for the host, set at creation or live from the document with
 * ares.frame(). This is how Ares invents placements nobody planned. */
export interface SurfaceFrame {
  style?: Record<string, string>;
  /** See-through: the app shows behind everything the document does not draw. */
  transparent?: boolean;
  /** Clicks pass through to the app underneath. */
  clickThrough?: boolean;
  /** Starts closed: ares.show or ares.toggle from any surface opens it. */
  hidden?: boolean;
  /** `free` surface: the owner drags it around and resizes it, and it stays
   *  where they left it. Always on for a website. */
  movable?: boolean;
  /** `window` placement: the OS window itself, outside Ares. */
  window?: {
    /** Stuck to that side of Ares, following it as it moves and resizes. */
    dock?: "left" | "right" | "top" | "bottom";
    /** Cover the whole monitor Ares is on. */
    cover?: boolean;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    decorations?: boolean;
    transparent?: boolean;
    alwaysOnTop?: boolean;
    clickThrough?: boolean;
  };
}

export type SurfaceState = (typeof SURFACE_STATES)[number];

/** Live data the daemon pushes into a running surface through `ares.onPost`
 * while Ares is idle. The manifest is the complete list; a surface cannot
 * subscribe to anything it did not declare, and the owner saw the list when
 * they approved the surface. */
export type SurfaceFeed =
  /** Every event of the owning session (turn_start, tool_start, text_delta…). */
  | { kind: "session.events" }
  /** A coarse status line for the owning session: idle / thinking / tool. */
  | { kind: "session.status" }
  /** A clock tick, for anything that wants to redraw on a cadence. */
  | { kind: "time"; everySec: number }
  /** A workspace file, posted whole on every change (text files only). */
  | { kind: "file"; path: string }
  /** A READ-ONLY belt tool run on an interval; its output is the payload. */
  | { kind: "tool"; tool: string; input?: Record<string, unknown>; everySec: number };

export interface SurfaceManifest {
  /** Stable id: lowercase, digits, hyphens. Also the ledger directory name. */
  name: string;
  title: string;
  placement: SurfacePlacement;
  /** Current revision, 1-based; 0 means never written. */
  revision: number;
  state: SurfaceState;
  feeds: SurfaceFeed[];
  /** Belt tools the document may call through `ares.call(tool, input)`. Each
   * call still goes through the permission gate as if the model made it. */
  actions: string[];
  /** The session whose thread the surface talks to (intents become turns
   * there; `session.*` feeds read it). */
  sessionId?: string;
  frame?: SurfaceFrame;
  /** Short reason the surface exists, shown on the card and in Introspect. */
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SurfaceDocument {
  title: string;
  html: string;
  css: string;
  js: string;
}

export interface SurfaceRevision extends SurfaceDocument {
  revision: number;
  at: number;
  /** What changed, in Ares's words — the ledger's commit message. */
  note?: string;
}

export const SURFACE_NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const SURFACE_MAX_FEEDS = 12;
export const SURFACE_MAX_ACTIONS = 12;
export const SURFACE_FEED_MIN_SEC = 5;
export const SURFACE_TOOL_FEED_MIN_SEC = 30;

export function isSurfacePlacement(value: unknown): value is SurfacePlacement {
  if (typeof value !== "string") return false;
  if ((SURFACE_PLACEMENTS as readonly string[]).includes(value)) return true;
  if (SURFACE_ANCHOR_RE.test(value)) return true;
  return value.startsWith("slot:") && (SURFACE_SLOTS as readonly string[]).includes(value.slice(5));
}

/** Validate a model- or owner-supplied feed list. Returns the clean list or
 * the first problem. Cadences are floored so a surface can never turn the
 * daemon into a busy loop. */
export function parseSurfaceFeeds(value: unknown): { feeds: SurfaceFeed[] } | { error: string } {
  if (value === undefined || value === null) return { feeds: [] };
  if (!Array.isArray(value)) return { error: "feeds must be an array" };
  if (value.length > SURFACE_MAX_FEEDS) return { error: `at most ${SURFACE_MAX_FEEDS} feeds` };
  const feeds: SurfaceFeed[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object") return { error: `feed ${index + 1} must be an object` };
    const row = raw as Record<string, unknown>;
    const kind = row.kind;
    if (kind === "session.events" || kind === "session.status") {
      feeds.push({ kind });
    } else if (kind === "time") {
      const everySec = Math.max(SURFACE_FEED_MIN_SEC, Math.floor(Number(row.everySec) || 0));
      if (!Number.isFinite(everySec)) return { error: `feed ${index + 1}: everySec must be a number` };
      feeds.push({ kind, everySec });
    } else if (kind === "file") {
      const file = typeof row.path === "string" ? row.path.trim() : "";
      if (!file || file.length > 400) return { error: `feed ${index + 1}: path required` };
      feeds.push({ kind, path: file });
    } else if (kind === "tool") {
      const tool = typeof row.tool === "string" ? row.tool.trim() : "";
      if (!/^[A-Za-z][A-Za-z0-9_]{1,60}$/.test(tool)) return { error: `feed ${index + 1}: tool name required` };
      const everySec = Math.max(SURFACE_TOOL_FEED_MIN_SEC, Math.floor(Number(row.everySec) || 0));
      const input = row.input && typeof row.input === "object" && !Array.isArray(row.input) ? (row.input as Record<string, unknown>) : undefined;
      feeds.push({ kind, tool, ...(input ? { input } : {}), everySec });
    } else {
      return { error: `feed ${index + 1}: unknown kind ${String(kind)}` };
    }
  }
  return { feeds };
}

export function parseSurfaceActions(value: unknown): { actions: string[] } | { error: string } {
  if (value === undefined || value === null) return { actions: [] };
  if (!Array.isArray(value)) return { error: "actions must be an array of tool names" };
  if (value.length > SURFACE_MAX_ACTIONS) return { error: `at most ${SURFACE_MAX_ACTIONS} actions` };
  const actions: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !/^[A-Za-z][A-Za-z0-9_]{1,60}$/.test(raw.trim())) return { error: `action ${String(raw)} is not a tool name` };
    if (!actions.includes(raw.trim())) actions.push(raw.trim());
  }
  return { actions };
}

/** One line a human can read for an approval card: what the surface may see
 * and do. Empty when it is inert (no feeds, no actions). */
export function describeSurfaceCapabilities(feeds: SurfaceFeed[], actions: string[]): string {
  const parts: string[] = [];
  for (const feed of feeds) {
    if (feed.kind === "session.events") parts.push("watch this chat's events");
    else if (feed.kind === "session.status") parts.push("watch this chat's status");
    else if (feed.kind === "time") parts.push(`tick every ${feed.everySec}s`);
    else if (feed.kind === "file") parts.push(`read ${feed.path} on change`);
    else parts.push(`run ${feed.tool} every ${feed.everySec}s`);
  }
  if (actions.length) parts.push(`call ${actions.join(", ")} on click (each call asks as if Ares made it)`);
  return parts.join("; ");
}

// ─── Photosensitive doctrine ─────────────────────────────────────────────────
//
// Nothing Ares draws may flash. The prompt says so; this is the floor under
// the prompt. It is a static scan, not a proof: it catches the common shapes
// (a fast infinite animation on a visibility property, a style-poking timer
// under 100 ms) and leaves the rest to the doctrine. A finding is a hard
// reject at the daemon, so false positives are kept rare on purpose.

export interface SurfaceDoctrineFinding {
  where: "css" | "js";
  message: string;
}

const FLASH_PROPERTIES = /\b(opacity|visibility|background(?:-color)?|color|filter|box-shadow|outline)\b/i;

function parseSeconds(raw: string): number | null {
  const match = /^(\d*\.?\d+)(ms|s)$/i.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return match[2].toLowerCase() === "ms" ? value / 1000 : value;
}

export function scanSurfaceDoctrine(css: string, js: string): SurfaceDoctrineFinding[] {
  const findings: SurfaceDoctrineFinding[] = [];
  // Which keyframes touch a visibility property — a fast infinite spin of a
  // transform is motion, not a flash.
  const flashing = new Set<string>();
  for (const match of css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)\s*\{([\s\S]*?)\}\s*\}/g)) {
    if (FLASH_PROPERTIES.test(match[2])) flashing.add(match[1]);
  }
  for (const match of css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/gi)) {
    const decl = match[1];
    const infinite = /\binfinite\b/.test(decl) || /\b(?:[4-9]|\d{2,})\b(?=\s|;|$)/.test(decl.replace(/[\d.]+m?s/g, ""));
    const durations = [...decl.matchAll(/(\d*\.?\d+)(ms|s)\b/gi)].map((m) => parseSeconds(m[0])).filter((v): v is number => v !== null);
    const name = decl.split(/\s+/).find((token) => flashing.has(token));
    if (name && infinite && durations.length && durations[0] < 0.3) {
      findings.push({ where: "css", message: `animation "${name}" flashes a visibility property every ${durations[0]}s; nothing on an Ares surface may flash (keep infinite animations on opacity/colour at 0.3s or slower)` });
    }
  }
  for (const match of js.matchAll(/setInterval\s*\(\s*[\s\S]{0,400}?,\s*(\d+)\s*\)/g)) {
    const ms = Number(match[1]);
    if (ms < 100 && /\.(style|classList|toggle|opacity|background|visibility)\b/.test(match[0])) {
      findings.push({ where: "js", message: `a setInterval of ${ms}ms changes style; nothing on an Ares surface may flash (use requestAnimationFrame for motion, and 100ms+ for anything that changes visibility)` });
    }
  }
  return findings;
}

// ─── Daemon-side HTML region patcher ─────────────────────────────────────────

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** Tags a surface may never contain: nested browsing contexts, document
 * directives and external references. The desktop strips them too; the daemon
 * refuses them so the ledger never holds one. */
const FORBIDDEN_TAG_RE = /<\s*(iframe|frame|frameset|object|embed|applet|base|meta|link)\b/i;
/** The surface is a document inside a sealed frame: its own <script src>,
 * imports and external URLs are blocked by CSP at render, and refused here so
 * a surface in the ledger is self-contained on every screen. */
const EXTERNAL_REF_RE = /\b(src|href)\s*=\s*["'](?!#|data:|blob:)[^"']*:\/\//i;

/** A whole surface that is a website. It is the one way a real page gets in: the
 * host gives it its own frame, outside the sandbox of a written document, and it
 * reaches nothing of Ares. Its own element so revisions, packs and rollback carry
 * it like any other document. */
const WEB_SURFACE_RE = /^\s*<ares-web data-ares-region="main" src="(https?:\/\/[^"<>\s]+)"><\/ares-web>\s*$/;

export function surfaceWebUrl(html: string): string | null {
  return WEB_SURFACE_RE.exec(html)?.[1] ?? null;
}

export function webSurfaceHtml(url: string): string {
  return `<ares-web data-ares-region="main" src="${url}"></ares-web>`;
}

export function surfaceHtmlProblem(html: string): string | null {
  if (surfaceWebUrl(html)) return null;
  const forbidden = FORBIDDEN_TAG_RE.exec(html);
  if (forbidden) return `<${forbidden[1].toLowerCase()}> is not allowed inside a surface${/i?frame/i.test(forbidden[1]) ? ". To show a website, create the surface with url instead of html" : ""}`;
  if (EXTERNAL_REF_RE.test(html)) return "external URLs are not allowed inside a surface (the sandbox has no network); inline the asset as a data: URI or draw it. To show a website, create the surface with url instead of html";
  return null;
}

export function regionsInSurfaceHtml(html: string): string[] {
  const names: string[] = [];
  for (const match of html.matchAll(/data-ares-region\s*=\s*["']([^"']+)["']/g)) {
    const name = match[1].trim();
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= 80) break;
  }
  return names;
}

interface RegionSpan {
  /** Index of the opening tag's `<`. */
  start: number;
  /** Index just after the opening tag's `>`. */
  innerStart: number;
  /** Index of the closing tag's `<`. */
  innerEnd: number;
  /** Index just after the closing tag's `>`. */
  end: number;
}

/** Locate a `data-ares-region` element by walking tags of the same name and
 * counting depth. Enough for the HTML a model writes; a region the walk
 * cannot balance is reported as missing rather than guessed. */
export function findSurfaceRegion(html: string, name: string): RegionSpan | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const open = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)(?:\\s[^>]*?)?\\sdata-ares-region\\s*=\\s*["']${escaped}["'][^>]*>`, "g");
  const opening = open.exec(html);
  if (!opening) return null;
  const tag = opening[1].toLowerCase();
  const start = opening.index;
  const innerStart = start + opening[0].length;
  if (VOID_ELEMENTS.has(tag) || opening[0].endsWith("/>")) return { start, innerStart, innerEnd: innerStart, end: innerStart };
  const walker = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  walker.lastIndex = innerStart;
  let depth = 1;
  for (let match = walker.exec(html); match; match = walker.exec(html)) {
    if (match[1] === "/") {
      depth -= 1;
      if (depth === 0) return { start, innerStart, innerEnd: match.index, end: match.index + match[0].length };
    } else if (!match[0].endsWith("/>")) {
      depth += 1;
    }
  }
  return null;
}

export interface SurfaceApplyResult {
  next: SurfaceDocument;
  posts: unknown[];
  documentChanged: boolean;
}

/** Apply an envelope's mutations to a document the way the desktop does, on
 * text. Throws a plain Error naming the first problem so the tool can hand
 * the model a correctable message. */
export function applySurfaceMutations(doc: SurfaceDocument, mutations: readonly LivingSurfaceMutation[]): SurfaceApplyResult {
  const posts: unknown[] = [];
  let { html, css, js, title } = doc;
  let documentChanged = false;
  for (const mutation of mutations) {
    if (mutation.op === "post") {
      posts.push(mutation.payload);
      continue;
    }
    documentChanged = true;
    if (mutation.op === "replace_document") {
      html = mutation.html;
      if (mutation.css !== undefined) css = mutation.css;
      js = mutation.js ?? "";
      continue;
    }
    if (mutation.op === "set_css") { css = mutation.css; continue; }
    if (mutation.op === "set_script") { js = mutation.js; continue; }
    if (mutation.op === "set_title") { title = mutation.title.slice(0, 120); continue; }
    const span = findSurfaceRegion(html, mutation.target);
    if (!span) throw new Error(`region "${mutation.target}" does not exist (regions: ${regionsInSurfaceHtml(html).join(", ") || "none"})`);
    if (mutation.op === "remove_region") html = html.slice(0, span.start) + html.slice(span.end);
    else if (mutation.op === "replace_region") html = html.slice(0, span.innerStart) + mutation.html + html.slice(span.innerEnd);
    else if (mutation.op === "append_region") html = html.slice(0, span.innerEnd) + mutation.html + html.slice(span.innerEnd);
    else html = html.slice(0, span.innerStart) + mutation.html + html.slice(span.innerStart);
  }
  if (documentChanged) {
    const problem = surfaceHtmlProblem(html);
    if (problem) throw new Error(problem);
    if (!regionsInSurfaceHtml(html).length) throw new Error("a surface must keep at least one data-ares-region element so it stays addressable");
  }
  return { next: { html, css, js, title }, posts, documentChanged };
}

/** The bridge every surface document gets, as the model should understand
 * it. Kept here so the tool description, the skill and the host agree. */
export const SURFACE_BRIDGE_DOC = `Every document gets a frozen \`ares\` object: ares.send(text) hands intent to Ares (arrives as the next request in this chat, tagged as coming from the surface); ares.onPost(fn) receives every post payload live without a reload (feeds arrive as {feed:"<kind>", data:…}); ares.call(tool, input) runs a belt tool named in the manifest's actions and resolves with its output (it asks the owner exactly as if Ares had called it); ares.frame({style, transparent, clickThrough}) moves, resizes or layers a free surface live; ares.close() removes it (for one-shot effects); ares.toggle(name), ares.show(name), ares.hide(name) open and close another surface (give it frame.hidden to start closed), or this one with no name; ares.store.get(key), .set(key, value), .remove(key), .all() keep JSON for this surface across restarts and resolve as promises; ares.share(topic, data) reaches every other open surface's ares.onShare((topic, data, from) => …) instantly with no turn of Ares, which is how linked panels talk; ares.theme is the host's design tokens ({bg,panel,text,muted,accent,ember,radius,font,mono,fill,rim,shadow,blur}), also CSS variables --ares-<token>, and ares.onTheme(fn) fires when they change. To look exactly like the app's own panels: background:var(--ares-fill);backdrop-filter:var(--ares-blur);border:var(--ares-rim);box-shadow:var(--ares-shadow);border-radius:var(--ares-radius). Free and at: surfaces are see-through, so they paint their own panel, and keep padding around it or the frame cuts off the shadow. Elements with data-ares-action="…" send on click; forms with data-ares-action send their fields on submit. A frame clips: anything outside its box can never be seen, so a popup is a second surface, not an overflowing child. The frame is sealed: no network, no parent.`;

export const SURFACE_PROTOCOL_VERSION = LIVING_SURFACE_VERSION;
