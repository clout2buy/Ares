// Static preview server: "open it in the Forge" for a project FOLDER.
//
// A file:// preview only works for a page that is self-contained. Anything
// real — <script type="module">, an import map, a root-relative asset, a
// relative fetch() — breaks under file:// (and under the desktop's asset
// protocol, which is what the Forge's Live tab turns a file:// target into).
// Field case (runestone, 2026-10-15): "open it in ur forge" rendered a grey
// page because the entry imported modules by path. The owner's bar: if a
// thing needs hosting for both of us to see it in the Forge, host it.
//
// So a local file handed to Browser preview/open is served from its folder on
// 127.0.0.1 and the http URL is what gets opened. One server per folder root,
// ephemeral port, loopback only, no directory listing, no traversal, no
// caching. The Forge embeds localhost origins directly.
//
// Two things ride along on every served HTML page:
//
//   1. The Forge sensor (/__ares/forge-sensor.js). The owner tests the page in
//      the Forge; Ares should SEE that test — exceptions, failed resource
//      loads, console errors and warnings, frame rate. The sensor batches them
//      to /__ares/telemetry; the sink forwards them to the desktop (a HUD on
//      the Live tab) and to the model (a reminder at its next boundary).
//   2. Bare-import rescue. `import * as THREE from "three"` has no meaning to
//      a browser without an import map. When the page has none, one is
//      injected: packages found in a nearby node_modules are served from
//      there (/__ares/nm/<pkg>/…), anything else maps to a pinned CDN build.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, mkdirSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORGE_KIT_CSS, FORGE_KIT_JS } from "./forgeKit.js";

import { addStudioLog, setStudioVideo, studioDir, studioPoll } from "./modelStudio.js";
import { DRIVE_PATH, PAGE_DRIVER_SOURCE } from "./pageDriverSource.js";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "text/plain; charset=utf-8",
  ".mtl": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".xml": "application/xml; charset=utf-8",
  ".pdf": "application/pdf",
};

const SENSOR_PATH = "/__ares/forge-sensor.js";
const TELEMETRY_PATH = "/__ares/telemetry";
const NM_PREFIX = "/__ares/nm/";
const CDN = "https://esm.sh/";

// ── Forge sensor (runs inside the served page) ─────────────────────────────
// Plain ES5-ish, no dependencies, never throws into the page. Batches every
// 1s; errors flush immediately. FPS is measured from requestAnimationFrame.
const SENSOR_SOURCE = `(function(){
  if (window.__aresForgeSensor) return; window.__aresForgeSensor = 1;
  var queue = [], timer = null, frames = 0, fpsStart = 0, lastFps = -1, longest = 0, lastT = 0;
  function clip(s){ s = String(s == null ? "" : s); return s.length > 600 ? s.slice(0, 600) + "…" : s; }
  function post(now){
    if (!queue.length) return;
    var body = JSON.stringify({ url: location.href, at: Date.now(), items: queue.splice(0, 40) });
    try {
      if (navigator.sendBeacon && !now) { navigator.sendBeacon("${TELEMETRY_PATH}", new Blob([body], { type: "application/json" })); }
      else { fetch("${TELEMETRY_PATH}", { method: "POST", body: body, headers: { "content-type": "application/json" }, keepalive: true }).catch(function(){}); }
    } catch (e) {}
  }
  function push(item, urgent){
    queue.push(item);
    if (urgent) { post(true); return; }
    if (!timer) timer = setTimeout(function(){ timer = null; post(false); }, 1000);
  }
  window.addEventListener("error", function(ev){
    if (ev && ev.target && ev.target !== window && (ev.target.src || ev.target.href)) {
      push({ kind: "resource", text: "failed to load " + clip(ev.target.src || ev.target.href), tag: String(ev.target.tagName || "").toLowerCase() }, true);
      return;
    }
    push({ kind: "error", text: clip(ev && ev.message), where: ev && ev.filename ? clip(ev.filename) + ":" + (ev.lineno || 0) + ":" + (ev.colno || 0) : undefined, stack: ev && ev.error && ev.error.stack ? clip(ev.error.stack) : undefined }, true);
  }, true);
  window.addEventListener("unhandledrejection", function(ev){
    var r = ev && ev.reason; push({ kind: "error", text: "unhandled rejection: " + clip(r && r.message ? r.message : r), stack: r && r.stack ? clip(r.stack) : undefined }, true);
  });
  var origError = console.error, origWarn = console.warn;
  console.error = function(){ try { push({ kind: "error", text: clip(Array.prototype.map.call(arguments, function(a){ return a instanceof Error ? (a.stack || a.message) : (typeof a === "object" ? JSON.stringify(a) : String(a)); }).join(" ")) }, true); } catch (e) {} return origError.apply(console, arguments); };
  console.warn = function(){ try { push({ kind: "warn", text: clip(Array.prototype.map.call(arguments, function(a){ return typeof a === "object" ? JSON.stringify(a) : String(a); }).join(" ")) }, false); } catch (e) {} return origWarn.apply(console, arguments); };
  function frame(t){
    frames++;
    if (lastT && t - lastT > longest) longest = t - lastT;
    lastT = t;
    if (!fpsStart) fpsStart = t;
    if (t - fpsStart >= 2000) {
      var fps = Math.round(frames * 1000 / (t - fpsStart));
      if (fps !== lastFps || longest > 120) push({ kind: "fps", fps: fps, longestMs: Math.round(longest) }, false);
      lastFps = fps; frames = 0; fpsStart = t; longest = 0;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.addEventListener("load", function(){
    var nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    push({ kind: "load", ms: nav ? Math.round(nav.loadEventEnd || nav.duration || 0) : Math.round(performance.now()) }, true);
  });
  document.addEventListener("visibilitychange", function(){ if (document.hidden) post(false); });
})();`;

export interface ForgeTelemetryItem {
  kind: "error" | "warn" | "resource" | "fps" | "load";
  text?: string;
  where?: string;
  stack?: string;
  tag?: string;
  fps?: number;
  longestMs?: number;
  ms?: number;
}

export interface ForgeTelemetryBatch {
  /** The served root the page belongs to. */
  root: string;
  origin: string;
  url: string;
  at: number;
  items: ForgeTelemetryItem[];
}

/** Where sensor batches go: the desktop (HUD) and the model (reminder). */
export interface ForgeSink {
  /** A UI event for the session that opened this root (undefined = untagged). */
  event(sessionId: string | undefined, payload: Record<string, unknown>): void;
  /** A system reminder for the model of that session, deduped by key. */
  remind(sessionId: string | undefined, text: string, key: string): void;
}

let sink: ForgeSink | null = null;

/** Install the host's sink. The daemon does this once at startup. */
export function setForgeSink(next: ForgeSink | null): void {
  sink = next;
}

export interface ImportMapRescue {
  /** bare specifier → where it now resolves (served node_modules or CDN). */
  mapped: Record<string, string>;
  source: "node_modules" | "cdn" | "mixed";
}

export interface ServedFolder {
  root: string;
  origin: string;
  server: Server;
  /** The session that last opened this root (telemetry is tagged with it). */
  sessionId?: string;
  /** node_modules directory used for bare-import rescue, when one was found. */
  nodeModules?: string;
  /** The last import map injected into an HTML page under this root. */
  lastRescue?: ImportMapRescue;
  /** Rolling sensor state for the HUD + reminders. */
  sensor: SensorState;
  /** Open copies of pages under this root that Ares can drive (pageDriverSource.ts). */
  drive?: DriveState;
}

interface SensorState {
  errors: Array<{ at: number; text: string; where?: string }>;
  warnings: Array<{ at: number; text: string }>;
  fps: number | null;
  longestMs: number;
  loadMs: number | null;
  lowFpsSince: number | null;
  lastHud: number;
  lastRemindAt: number;
  pending: ForgeTelemetryItem[];
  remindTimer: NodeJS.Timeout | null;
}

const servers = new Map<string, Promise<ServedFolder>>();

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function freshSensor(): SensorState {
  return { errors: [], warnings: [], fps: null, longestMs: 0, loadMs: null, lowFpsSince: null, lastHud: 0, lastRemindAt: 0, pending: [], remindTimer: null };
}

/** Map a request path to a file under root, or null when it escapes root. */
function resolveUnderRoot(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]!.split("#")[0]!);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

async function readBinary(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("telemetry body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── bare-import rescue ──────────────────────────────────────────────────────

const BARE_IMPORT = /\b(?:import|export)\s*(?:[\w*{}\s,$]*?\s*from\s*)?["']([^"'./][^"']*)["']|\bimport\(\s*["']([^"'./][^"']*)["']\s*\)/g;

/** Bare package names imported by inline module scripts, in page order. */
export function bareImportsIn(html: string): string[] {
  const seen = new Set<string>();
  const scripts = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']module["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of scripts) {
    for (const hit of m[1]!.matchAll(BARE_IMPORT)) {
      const spec = hit[1] ?? hit[2];
      if (!spec || /^(?:https?:|data:|blob:|\/)/i.test(spec)) continue;
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      if (pkg) seen.add(pkg);
    }
  }
  return [...seen];
}

async function findNodeModules(root: string): Promise<string | null> {
  // The project's own node_modules or a parent workspace's — never the
  // owner's home or anything above it (a stray ~/node_modules/three would
  // otherwise shadow the CDN for every project under the home folder).
  const home = canonicalRoot(os.homedir());
  let current = root;
  for (let depth = 0; depth < 4; depth++) {
    if (canonicalRoot(current) === home || home.startsWith(canonicalRoot(current) + path.sep) || canonicalRoot(current) === canonicalRoot(path.parse(current).root)) break;
    const candidate = path.join(current, "node_modules");
    if (await fs.stat(candidate).then((s) => s.isDirectory(), () => false)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function packageEntry(dir: string): Promise<string | null> {
  const raw = await fs.readFile(path.join(dir, "package.json"), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const pkg = JSON.parse(raw) as { module?: string; main?: string; exports?: unknown };
    const exportsField = pkg.exports as Record<string, unknown> | string | undefined;
    const fromExports = (() => {
      if (typeof exportsField === "string") return exportsField;
      if (exportsField && typeof exportsField === "object") {
        const dot = (exportsField as Record<string, unknown>)["."];
        if (typeof dot === "string") return dot;
        if (dot && typeof dot === "object") {
          const d = dot as Record<string, unknown>;
          const pick = d.import ?? d.module ?? d.default ?? d.browser;
          if (typeof pick === "string") return pick;
          if (pick && typeof pick === "object" && typeof (pick as Record<string, unknown>).default === "string") return (pick as Record<string, string>).default;
        }
      }
      return undefined;
    })();
    const entry = fromExports ?? pkg.module ?? pkg.main ?? "index.js";
    return entry.replace(/^\.\//, "");
  } catch {
    return null;
  }
}

export interface ImportMapPlan extends ImportMapRescue {
  imports: Record<string, string>;
}

/** Build the import map to inject for `bare` under `served`. */
export async function buildImportMap(served: ServedFolder, bare: string[]): Promise<ImportMapPlan | null> {
  if (bare.length === 0) return null;
  const imports: Record<string, string> = {};
  const mapped: Record<string, string> = {};
  let local = 0;
  let cdn = 0;
  const nm = served.nodeModules ?? (served.nodeModules = (await findNodeModules(served.root)) ?? undefined);
  for (const pkg of bare) {
    const localDir = nm ? path.join(nm, pkg) : null;
    const entry = localDir ? await packageEntry(localDir) : null;
    if (localDir && entry) {
      imports[pkg] = `${NM_PREFIX}${pkg}/${entry}`;
      imports[`${pkg}/`] = `${NM_PREFIX}${pkg}/`;
      if (pkg === "three") imports["three/addons/"] = `${NM_PREFIX}three/examples/jsm/`;
      mapped[pkg] = `${served.origin}${NM_PREFIX}${pkg}/ (node_modules)`;
      local++;
    } else {
      imports[pkg] = `${CDN}${pkg}`;
      imports[`${pkg}/`] = `${CDN}${pkg}/`;
      if (pkg === "three") imports["three/addons/"] = `${CDN}three/examples/jsm/`;
      mapped[pkg] = `${CDN}${pkg} (CDN)`;
      cdn++;
    }
  }
  return { imports, mapped, source: local && cdn ? "mixed" : local ? "node_modules" : "cdn" };
}

function injectIntoHead(html: string, fragment: string): string {
  const head = html.match(/<head\b[^>]*>/i);
  if (head && head.index !== undefined) return html.slice(0, head.index + head[0].length) + fragment + html.slice(head.index + head[0].length);
  const htmlTag = html.match(/<html\b[^>]*>/i);
  if (htmlTag && htmlTag.index !== undefined) return html.slice(0, htmlTag.index + htmlTag[0].length) + fragment + html.slice(htmlTag.index + htmlTag[0].length);
  return fragment + html;
}

/** The HTML as the browser should receive it: sensor first, then an import
 *  map when the page needs one and has none. */
export async function prepareHtml(served: ServedFolder, html: string): Promise<string> {
  let fragment = `<script src="${SENSOR_PATH}"></script>`;
  if (!/<script\b[^>]*type\s*=\s*["']importmap["']/i.test(html)) {
    const bare = bareImportsIn(html);
    const rescue = await buildImportMap(served, bare);
    if (rescue) {
      fragment += `<script type="importmap">${JSON.stringify({ imports: rescue.imports })}</script>`;
      served.lastRescue = { mapped: rescue.mapped, source: rescue.source };
    } else {
      served.lastRescue = undefined;
    }
  } else {
    served.lastRescue = undefined;
  }
  return injectIntoHead(html, fragment);
}

// ── request handling ────────────────────────────────────────────────────────

function sendFile(res: ServerResponse, file: string, size: number, head: boolean): void {
  res.writeHead(200, {
    "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": size,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  if (head) {
    res.end();
    return;
  }
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** DNS-rebinding guard: only answer requests addressed to loopback names, and POSTs that came from this origin (or no browser origin). */
function loopbackRequest(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? "").toLowerCase();
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}

async function handle(served: ServedFolder, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!loopbackRequest(req)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("loopback only");
    return;
  }
  const urlPath = (req.url ?? "/").split("?")[0]!;
  if (urlPath === DRIVE_PATH) {
    await handleDrive(served, req, res);
    return;
  }
  if (req.method === "POST" && urlPath === TELEMETRY_PATH) {
    const body = await readBody(req).catch(() => "");
    res.writeHead(204, { "access-control-allow-origin": "*" }).end();
    if (body) ingestTelemetry(served, body);
    return;
  }
  // scripts in a model-studio page report their errors / log lines here so Ares sees them in its next tool result
  if (req.method === "POST" && urlPath.startsWith("/__ares/studio/") && urlPath.endsWith("/log")) {
    const id = urlPath.slice("/__ares/studio/".length, -"/log".length).replace(/[^a-z0-9_-]/gi, "");
    const body = await readBody(req).catch(() => "");
    res.writeHead(204, { "access-control-allow-origin": "*" }).end();
    try { const j = JSON.parse(body) as { name?: unknown; msg?: unknown }; addStudioLog(id, `[${String(j.name ?? "script").slice(0, 24)}] ${String(j.msg ?? "").slice(0, 260)}`); } catch { /* ignore */ }
    return;
  }
  // a studio page posts the video it just recorded from its own canvas (Browser model {record}); saved next to the page
  if (req.method === "POST" && urlPath.startsWith("/__ares/studio/") && urlPath.endsWith("/video")) {
    const id = urlPath.slice("/__ares/studio/".length, -"/video".length).replace(/[^a-z0-9_-]/gi, "");
    const buf = await readBinary(req, 300 * 1024 * 1024).catch(() => null);
    if (!buf || buf.length < 64) { res.writeHead(400).end(); return; }
    const file = path.join(studioDir(id), `recording-${Date.now()}.webm`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buf);
    setStudioVideo(id, file, buf.length);
    res.writeHead(204, { "access-control-allow-origin": "*" }).end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  // Model studio: the Forge page polls its document here (see modelStudio.ts).
  if (urlPath.startsWith("/__ares/studio/")) {
    const id = urlPath.slice("/__ares/studio/".length).replace(/[^a-z0-9_-]/gi, "");
    const since = Number(new URL(req.url ?? "/", "http://x").searchParams.get("since")) || 0;
    const body = studioPoll(id, since);
    res.writeHead(body ? 200 : 404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body ?? { v: 0 }));
    return;
  }
  if (urlPath === SENSOR_PATH) {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : `${SENSOR_SOURCE}
${PAGE_DRIVER_SOURCE}`);
    return;
  }
  // The Forge kit for served pages: <link rel="stylesheet" href="/__ares/kit.css">
  // + <script src="/__ares/kit.js"> give a project page the same pixel theme
  // an explainer gets from <!--ares:kit-->.
  if (urlPath === "/__ares/kit.css" || urlPath === "/__ares/kit.js") {
    const css = urlPath.endsWith(".css");
    res.writeHead(200, { "content-type": css ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : css ? FORGE_KIT_CSS : FORGE_KIT_JS);
    return;
  }
  if (urlPath.startsWith(NM_PREFIX) && served.nodeModules) {
    const file = resolveUnderRoot(served.nodeModules, urlPath.slice(NM_PREFIX.length - 1));
    const stat = file ? await fs.stat(file).catch(() => null) : null;
    if (!file || !stat?.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`not found in node_modules: ${urlPath}`);
      return;
    }
    sendFile(res, file, stat.size, req.method === "HEAD");
    return;
  }
  let file = resolveUnderRoot(served.root, urlPath);
  if (!file) {
    res.writeHead(403).end();
    return;
  }
  let stat = await fs.stat(file).catch(() => null);
  if (stat?.isDirectory()) {
    file = path.join(file, "index.html");
    stat = await fs.stat(file).catch(() => null);
  }
  if (!stat?.isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`not found under ${path.basename(served.root)}: ${req.url}`);
    return;
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    const raw = await fs.readFile(file, "utf8");
    const html = await prepareHtml(served, raw);
    const buf = Buffer.from(html, "utf8");
    res.writeHead(200, { "content-type": MIME[ext]!, "content-length": buf.length, "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(req.method === "HEAD" ? undefined : buf);
    return;
  }
  sendFile(res, file, stat.size, req.method === "HEAD");
}

// ── telemetry → HUD + reminders ─────────────────────────────────────────────

const HUD_MIN_INTERVAL_MS = 1500;
const REMIND_DEBOUNCE_MS = 1500;
const LOW_FPS = 30;
const LOW_FPS_HOLD_MS = 5000;
const REMIND_MIN_GAP_MS = 20_000;

function ingestTelemetry(served: ServedFolder, body: string): void {
  let batch: { url?: unknown; at?: unknown; items?: unknown };
  try {
    batch = JSON.parse(body) as typeof batch;
  } catch {
    return;
  }
  const items = Array.isArray(batch.items) ? (batch.items as ForgeTelemetryItem[]).filter((i) => i && typeof i.kind === "string") : [];
  if (items.length === 0) return;
  const s = served.sensor;
  const now = Date.now();
  let urgent = false;
  for (const item of items) {
    if (item.kind === "error" || item.kind === "resource") {
      s.errors.push({ at: now, text: String(item.text ?? ""), where: item.where });
      if (s.errors.length > 40) s.errors.splice(0, s.errors.length - 40);
      s.pending.push(item);
      urgent = true;
    } else if (item.kind === "warn") {
      s.warnings.push({ at: now, text: String(item.text ?? "") });
      if (s.warnings.length > 40) s.warnings.splice(0, s.warnings.length - 40);
      s.pending.push(item);
    } else if (item.kind === "fps" && typeof item.fps === "number") {
      s.fps = item.fps;
      s.longestMs = typeof item.longestMs === "number" ? item.longestMs : 0;
      if (item.fps < LOW_FPS) {
        if (s.lowFpsSince === null) s.lowFpsSince = now;
      } else {
        s.lowFpsSince = null;
      }
    } else if (item.kind === "load" && typeof item.ms === "number") {
      s.loadMs = item.ms;
      urgent = true;
    }
  }
  const url = typeof batch.url === "string" ? batch.url : served.origin;
  if (urgent || now - s.lastHud >= HUD_MIN_INTERVAL_MS) {
    s.lastHud = now;
    sink?.event(served.sessionId, {
      type: "forge_telemetry",
      root: served.root,
      origin: served.origin,
      url,
      at: now,
      fps: s.fps,
      longestMs: s.longestMs,
      loadMs: s.loadMs,
      errors: s.errors.slice(-8).map((e) => (e.where ? `${e.text} (${e.where})` : e.text)),
      warnings: s.warnings.slice(-5).map((w) => w.text),
      errorCount: s.errors.length,
      warningCount: s.warnings.length,
      lowFps: s.lowFpsSince !== null && now - s.lowFpsSince >= LOW_FPS_HOLD_MS,
    });
  }
  // Reminders for the model: a debounced batch of errors/warnings, and a
  // sustained low frame rate — never more than one of each per 20s.
  if (s.remindTimer) clearTimeout(s.remindTimer);
  s.remindTimer = setTimeout(() => {
    s.remindTimer = null;
    flushReminders(served, url);
  }, REMIND_DEBOUNCE_MS);
  s.remindTimer.unref?.();
}

function flushReminders(served: ServedFolder, url: string): void {
  const s = served.sensor;
  const now = Date.now();
  const pending = s.pending.splice(0, s.pending.length);
  const errors = pending.filter((i) => i.kind === "error" || i.kind === "resource");
  const warns = pending.filter((i) => i.kind === "warn");
  const lowFps = s.lowFpsSince !== null && now - s.lowFpsSince >= LOW_FPS_HOLD_MS;
  if (errors.length === 0 && warns.length === 0 && !lowFps) return;
  if (now - s.lastRemindAt < REMIND_MIN_GAP_MS && errors.length === 0) return;
  s.lastRemindAt = now;
  const lines: string[] = [`Forge sensor — the owner is looking at ${url} (served from ${served.root}):`];
  for (const e of errors.slice(0, 6)) lines.push(`- ERROR ${e.text}${e.where ? ` (${e.where})` : ""}`);
  if (errors.length > 6) lines.push(`- …and ${errors.length - 6} more errors`);
  for (const w of warns.slice(0, 3)) lines.push(`- warn ${w.text}`);
  if (lowFps) lines.push(`- frame rate ${s.fps} fps for ${Math.round((now - (s.lowFpsSince ?? now)) / 1000)}s (longest frame ${s.longestMs}ms) — the page is dropping frames`);
  lines.push("These came from the page itself while it ran in the Forge. If they are caused by your recent edits, fix them; if they are pre-existing or expected, say so in one line.");
  sink?.remind(served.sessionId, lines.join("\n"), `forge-sensor:${canonicalRoot(served.root)}`);
}

/** Current sensor snapshot for a root (tests, the preview result). */
export async function sensorSnapshot(root: string): Promise<{ errors: number; warnings: number; fps: number | null } | null> {
  const served = await servers.get(canonicalRoot(root));
  if (!served) return null;
  return { errors: served.sensor.errors.length, warnings: served.sensor.warnings.length, fps: served.sensor.fps };
}

// ── lifecycle ───────────────────────────────────────────────────────────────

/** Serve `root` on 127.0.0.1 (one server per folder, reused across calls). */
export function serveFolder(root: string, opts: { sessionId?: string } = {}): Promise<ServedFolder> {
  const key = canonicalRoot(root);
  const existing = servers.get(key);
  if (existing) {
    return existing.then((served) => {
      if (opts.sessionId) served.sessionId = opts.sessionId;
      return served;
    });
  }
  const started = new Promise<ServedFolder>((resolve, reject) => {
    const absRoot = path.resolve(root);
    const served: ServedFolder = { root: absRoot, origin: "", server: undefined as unknown as Server, sessionId: opts.sessionId, sensor: freshSensor() };
    const server = createServer((req, res) => {
      void handle(served, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    served.server = server;
    // The same folder gets the same port across daemon restarts, so a page
    // address an agent (or the Forge) already holds keeps working.
    const preferred = rememberedPorts()[key]?.port;
    let retried = false;
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (!retried && preferred && err.code === "EADDRINUSE") {
        retried = true;
        server.listen(0, "127.0.0.1");
        return;
      }
      servers.delete(key);
      reject(err);
    });
    server.on("listening", () => {
      const { port } = server.address() as AddressInfo;
      // Never keep the daemon alive on our account; the server lives as long
      // as the process does and dies with it.
      server.unref();
      served.origin = `http://127.0.0.1:${port}`;
      rememberPort(key, absRoot, port);
      resolve(served);
    });
    server.listen(preferred ?? 0, "127.0.0.1");
  });
  servers.set(key, started);
  return started;
}

/** Local file or folder reference → { path, query } or null for anything else. */
function localTarget(input: string, cwd?: string): { fsPath: string; suffix: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return { fsPath: fileURLToPath(url), suffix: `${url.search}${url.hash}` };
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-zA-Z]:[\\/]/.test(trimmed)) return null; // http:, data:, about: …
  // A plain path may carry a query/hash for the page ("game/index.html?seed=1"),
  // and a model often names it relative to the workspace.
  const cut = trimmed.search(/[?#]/);
  const bare = cut >= 0 ? trimmed.slice(0, cut) : trimmed;
  const suffix = cut >= 0 ? trimmed.slice(cut) : "";
  if (path.isAbsolute(bare)) return { fsPath: bare, suffix };
  if (cwd && bare && !/^(?:\/\/|[a-z0-9-]+\.[a-z]{2,}(?:[:/]|$))/i.test(bare)) return { fsPath: path.resolve(cwd, bare), suffix };
  return null;
}

export interface ServedTarget {
  url: string;
  root: string;
  origin: string;
  /** Set after the page has been served once with an injected import map. */
  rescue?: ImportMapRescue;
}

/**
 * Turn a local file/folder reference into a served http URL. A file is
 * served from its own folder; a folder serves itself (index.html). Anything
 * that is not a local path (http, data, inline temp previews) returns null.
 */
export async function serveLocalTarget(input: string, opts: { sessionId?: string; cwd?: string } = {}): Promise<ServedTarget | null> {
  const target = localTarget(input, opts.cwd);
  if (!target) return null;
  const stat = await fs.stat(target.fsPath).catch(() => null);
  const root = stat?.isDirectory() ? target.fsPath : path.dirname(target.fsPath);
  // never publish secrets or whole disks over HTTP, whatever path a model names (checked on the path as written AND after symlinks)
  const home = os.homedir();
  const secret = (p: string): boolean => p === path.parse(p).root || p === home || [".ares", ".ssh", ".aws", ".gnupg"].some((d) => isUnder(p, path.join(home, d)));
  const real = await fs.realpath(root).catch(() => root);
  if (secret(path.resolve(root)) || secret(real)) throw new Error(`refusing to serve ${root}: it is (or is inside) a secrets or system folder`);
  if (!stat) return null;
  const served = await serveFolder(root, opts);
  const rel = stat.isDirectory() ? "" : path.basename(target.fsPath);
  return {
    url: `${served.origin}/${rel.split("/").map(encodeURIComponent).join("/")}${target.suffix}`,
    root: served.root,
    origin: served.origin,
    rescue: served.lastRescue,
  };
}

/** What the last HTML served under `root` needed rescuing (for tool results). */
export async function lastRescueFor(root: string): Promise<ImportMapRescue | undefined> {
  const served = await servers.get(canonicalRoot(root));
  return served?.lastRescue;
}

/** Close every preview server (tests, daemon shutdown). */
export async function stopPreviewServers(): Promise<void> {
  const open = [...servers.values()];
  servers.clear();
  await Promise.all(
    open.map((p) => p.then((s) => new Promise<void>((r) => s.server.close(() => r()))).catch(() => undefined)),
  );
}

// ── driving the page the owner sees ─────────────────────────────────────────
// Every served HTML page runs the page driver (pageDriverSource.ts), which
// long-polls DRIVE_PATH. Ares sends a command to the copy the owner looked at
// most recently and awaits its reply — so it plays, clicks and reads the very
// page in the Forge instead of a hidden copy.

interface DrivePage {
  id: string;
  url: string;
  seenAt: number;
  firstSeenAt: number;
  queue: Array<{ id: string; op: string; args?: unknown }>;
  waiting: ServerResponse | null;
  /** Commands handed to the page and not answered yet. */
  inflight: Set<string>;
}

interface DriveState {
  pages: Map<string, DrivePage>;
  replies: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
}

const DRIVE_POLL_MS = 20_000;
/** A page that hasn't polled for this long is gone (closed tab, reload). */
const DRIVE_ALIVE_MS = DRIVE_POLL_MS + 5_000;
let driveSeq = 0;

function driveState(served: ServedFolder): DriveState {
  if (!served.drive) served.drive = { pages: new Map(), replies: new Map() };
  return served.drive;
}

function alivePages(state: DriveState, now = Date.now()): DrivePage[] {
  for (const [id, page] of state.pages) if (!page.waiting && now - page.seenAt > DRIVE_ALIVE_MS) state.pages.delete(id);
  return [...state.pages.values()].sort((a, b) => b.firstSeenAt - a.firstSeenAt);
}

function flushPage(page: DrivePage): void {
  if (!page.waiting || page.queue.length === 0) return;
  const res = page.waiting;
  page.waiting = null;
  const cmd = page.queue.shift()!;
  page.inflight.add(cmd.id);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(cmd));
}

/** Error text that tells the caller to retry on the page's next copy. */
export const PAGE_GONE = "PAGE_GONE";

async function handleDrive(served: ServedFolder, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const state = driveState(served);
  const query = new URL(req.url ?? "/", "http://x").searchParams;
  const pageId = (query.get("page") ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 40);
  if (!pageId) { res.writeHead(400).end(); return; }
  if (req.method === "POST" && query.get("bye")) {
    res.writeHead(204).end();
    const gone = state.pages.get(pageId);
    if (!gone) return;
    state.pages.delete(pageId);
    if (gone.waiting) { gone.waiting.writeHead(204).end(); gone.waiting = null; }
    for (const id of [...gone.queue.map((c) => c.id), ...gone.inflight]) {
      const waiter = state.replies.get(id);
      if (!waiter) continue;
      state.replies.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new Error(PAGE_GONE));
    }
    return;
  }
  if (req.method === "POST") {
    const body = await readBody(req, 16 * 1024 * 1024).catch(() => "");
    res.writeHead(204).end();
    let reply: { id?: string; ok?: boolean; value?: unknown; error?: string };
    try { reply = JSON.parse(body); } catch { return; }
    const waiter = reply.id ? state.replies.get(reply.id) : undefined;
    if (!waiter || !reply.id) return;
    state.pages.get(pageId)?.inflight.delete(reply.id);
    state.replies.delete(reply.id);
    clearTimeout(waiter.timer);
    if (reply.ok) waiter.resolve(reply.value);
    else waiter.reject(new Error(String(reply.error ?? "the page failed the command")));
    return;
  }
  const now = Date.now();
  let page = state.pages.get(pageId);
  if (!page) {
    page = { id: pageId, url: "", seenAt: now, firstSeenAt: now, queue: [], waiting: null, inflight: new Set() };
    state.pages.set(pageId, page);
  }
  page.seenAt = now;
  page.url = query.get("url") ?? page.url;
  if (page.waiting) page.waiting.writeHead(204).end();
  page.waiting = res;
  const current = page;
  const timer = setTimeout(() => {
    if (current.waiting === res) { current.waiting = null; current.seenAt = Date.now(); res.writeHead(204).end(); }
  }, DRIVE_POLL_MS);
  timer.unref?.();
  res.on("close", () => {
    clearTimeout(timer);
    if (current.waiting === res) { current.waiting = null; current.seenAt = Date.now(); }
  });
  flushPage(page);
}

/** The newest open copy of a page under `root` that can take commands. */
export async function drivablePage(root: string, opts: { since?: number } = {}): Promise<{ url: string; id: string; loadedAt: number } | null> {
  const served = await servers.get(canonicalRoot(root))?.catch(() => undefined);
  if (!served?.drive) return null;
  const page = alivePages(served.drive).find((p) => p.firstSeenAt >= (opts.since ?? 0));
  return page ? { url: page.url, id: page.id, loadedAt: page.firstSeenAt } : null;
}

/** Did any file under `root` change after `sinceMs`? (Bounded walk; skips
 *  dependency folders.) The page driver uses it to act on fresh code. */
export async function rootChangedSince(root: string, sinceMs: number): Promise<boolean> {
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > 6 || seen > 3000) return false;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (++seen > 3000) return false;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (await walk(full, depth + 1)) return true;
      } else {
        const st = await fs.stat(full).catch(() => null);
        if (st && st.mtimeMs > sinceMs) return true;
      }
    }
    return false;
  };
  return walk(root, 0);
}

/** Wait (bounded) for a copy of a page under `root` to come up and poll. */
export async function waitForDrivablePage(root: string, timeoutMs: number, opts: { since?: number } = {}): Promise<{ url: string; id: string } | null> {
  const t0 = Date.now();
  for (;;) {
    const page = await drivablePage(root, opts);
    if (page || Date.now() - t0 >= timeoutMs) return page;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Every served root that has an open, drivable page right now (newest first). */
export async function drivableRoots(): Promise<Array<{ root: string; url: string; seenAt: number }>> {
  const out: Array<{ root: string; url: string; seenAt: number }> = [];
  for (const p of servers.values()) {
    const served = await p.catch(() => undefined);
    if (!served?.drive) continue;
    const page = alivePages(served.drive)[0];
    if (page) out.push({ root: served.root, url: page.url, seenAt: page.firstSeenAt });
  }
  return out.sort((a, b) => b.seenAt - a.seenAt);
}

/** Run one command in the page with that id (see pageDriverSource.ts for ops). */
export async function drivePage(root: string, pageId: string, op: string, args?: unknown, timeoutMs = 30_000): Promise<unknown> {
  const served = await servers.get(canonicalRoot(root))?.catch(() => undefined);
  const state = served ? driveState(served) : null;
  const page = state?.pages.get(pageId);
  if (!state || !page) throw new Error("the page is no longer open in the Forge");
  const id = `c${++driveSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.replies.delete(id);
      page.queue = page.queue.filter((c) => c.id !== id);
      reject(new Error(`the page did not answer "${op}" within ${Math.round(timeoutMs / 1000)}s (closed, reloading, or busy)`));
    }, timeoutMs);
    timer.unref?.();
    state.replies.set(id, { resolve, reject, timer });
    page.queue.push({ id, op, args });
    flushPage(page);
  });
}

/** The served folder behind a loopback URL Ares handed out (its origin), or
 *  null. A port from before a restart is served again from its folder. */
export async function servedForUrl(url: string): Promise<{ root: string; origin: string; url: string } | null> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const origin = parsed.origin;
  for (const p of servers.values()) {
    const served = await p.catch(() => undefined);
    if (served && served.origin === origin) return { root: served.root, origin, url };
  }
  if (!/^(127\.0\.0\.1|localhost)$/.test(parsed.hostname)) return null;
  const port = Number(parsed.port);
  const remembered = Object.values(rememberedPorts()).find((r) => r.port === port);
  if (!remembered) return null;
  const stat = await fs.stat(remembered.root).catch(() => null);
  if (!stat?.isDirectory()) return null;
  const served = await serveFolder(remembered.root);
  return { root: served.root, origin: served.origin, url: `${served.origin}${parsed.pathname}${parsed.search}${parsed.hash}` };
}

function portsFile(): string {
  return path.join(process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"), "preview-ports.json");
}

function rememberedPorts(): Record<string, { port: number; root: string }> {
  try {
    const raw = JSON.parse(readFileSync(portsFile(), "utf8")) as Record<string, unknown>;
    const out: Record<string, { port: number; root: string }> = {};
    for (const [k, v] of Object.entries(raw)) {
      const r = v as { port?: unknown; root?: unknown };
      if (typeof r?.port === "number" && typeof r.root === "string") out[k] = { port: r.port, root: r.root };
    }
    return out;
  } catch { return {}; }
}

function rememberPort(key: string, root: string, port: number): void {
  try {
    const all = rememberedPorts();
    if (all[key]?.port === port) return;
    // one port per folder; a port reused by another folder belongs to it now
    for (const [k, r] of Object.entries(all)) if (r.port === port) delete all[k];
    all[key] = { port, root };
    mkdirSync(path.dirname(portsFile()), { recursive: true });
    writeFileSync(portsFile(), JSON.stringify(all));
  } catch {
    // a remembered port is a convenience; never fail serving over it
  }
}
