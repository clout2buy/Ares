// The surface ledger: every surface Ares has made, as files under
// <ARES_HOME>/surfaces/<name>/ — surface.json (the manifest) beside
// revisions/<n>.json (the full document at each revision, newest kept, oldest
// pruned). Plain files on purpose: the desktop, the phone bridge and a person
// reading the directory all see the same thing, and a rollback is a copy.
//
// The store is also the daemon's event source: every change is emitted on
// `surfaceBus` so daemon.ts can forward it to whichever screens are attached
// without the tool knowing how. The Living Surface window kept its documents
// in the desktop's localStorage; that was one screen's memory. This is Ares's.

import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { aresHome } from "@ares/core";
import {
  SURFACE_NAME_RE,
  applySurfaceMutations,
  isSurfacePlacement,
  scanSurfaceDoctrine,
  surfaceHtmlProblem,
  regionsInSurfaceHtml,
  type LivingSurfaceMutation,
  type SurfaceDocument,
  type SurfaceFeed,
  type SurfaceManifest,
  type SurfacePlacement,
  type SurfaceRevision,
} from "@ares/protocol";

export const SURFACE_REVISIONS_KEPT = 50;
export const SURFACE_MAX_COUNT = 200;
const MAX_HTML = 120_000;
const MAX_CSS = 60_000;
const MAX_JS = 120_000;
const MAX_FAULTS = 5;

export interface SurfaceRecord {
  manifest: SurfaceManifest;
  document: SurfaceDocument;
}

/** What the daemon forwards to the screens. Every event names the surface;
 * revisions carry the whole document because the screen may have never seen
 * it (a surface made from the phone appears on the desktop). */
export type SurfaceBusEvent =
  | {
      type: "surface_revision";
      name: string;
      manifest: SurfaceManifest;
      document: SurfaceDocument;
      note?: string;
      origin: "create" | "mutate" | "rollback";
      /** The document ops that produced this revision (mutate only). A screen
       * with the previous revision mounted applies them to the running
       * document instead of reloading it, so script state survives. */
      mutations?: LivingSurfaceMutation[];
    }
  | { type: "surface_notice"; name: string; text: string; tone: "dim" | "warn" | "bad" }
  | { type: "surface_post"; name: string; payload: unknown }
  | { type: "surface_manifest"; name: string; manifest: SurfaceManifest }
  | { type: "surface_removed"; name: string };

class SurfaceBus extends EventEmitter {
  publish(event: SurfaceBusEvent): void {
    this.emit("event", event);
  }
  subscribe(listener: (event: SurfaceBusEvent) => void): () => void {
    this.on("event", listener);
    return () => { this.off("event", listener); };
  }
}

/** One bus per process: the daemon subscribes once, every tool call publishes. */
export const surfaceBus = new SurfaceBus();

export function surfacesDir(home?: string): string {
  return path.join(home ?? aresHome(), "surfaces");
}

function surfaceDir(name: string, home?: string): string {
  return path.join(surfacesDir(home), name);
}

function manifestFile(name: string, home?: string): string {
  return path.join(surfaceDir(name, home), "surface.json");
}

function revisionsDir(name: string, home?: string): string {
  return path.join(surfaceDir(name, home), "revisions");
}

function revisionFile(name: string, revision: number, home?: string): string {
  return path.join(revisionsDir(name, home), `${String(revision).padStart(5, "0")}.json`);
}

export function validSurfaceName(name: unknown): name is string {
  return typeof name === "string" && SURFACE_NAME_RE.test(name);
}

let writeChain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(5).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function cleanManifest(raw: unknown): SurfaceManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (!validSurfaceName(row.name) || !isSurfacePlacement(row.placement)) return null;
  return {
    name: row.name,
    title: typeof row.title === "string" ? row.title.slice(0, 120) : row.name,
    placement: row.placement,
    revision: Number.isInteger(row.revision) ? Number(row.revision) : 0,
    state: row.state === "kept" ? "kept" : "trial",
    feeds: Array.isArray(row.feeds) ? (row.feeds as SurfaceFeed[]) : [],
    actions: Array.isArray(row.actions) ? (row.actions as unknown[]).filter((a): a is string => typeof a === "string") : [],
    ...(typeof row.sessionId === "string" ? { sessionId: row.sessionId } : {}),
    ...(row.frame && typeof row.frame === "object" ? { frame: row.frame as SurfaceManifest["frame"] } : {}),
    ...(typeof row.note === "string" ? { note: row.note.slice(0, 400) } : {}),
    createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now(),
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : Date.now(),
  };
}

function cleanDocument(raw: unknown): SurfaceDocument | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.html !== "string") return null;
  return {
    title: typeof row.title === "string" ? row.title.slice(0, 120) : "",
    html: row.html.slice(0, MAX_HTML),
    css: typeof row.css === "string" ? row.css.slice(0, MAX_CSS) : "",
    js: typeof row.js === "string" ? row.js.slice(0, MAX_JS) : "",
  };
}

/** Reject what the ledger must never hold. Returns the first problem. */
export function documentProblem(doc: SurfaceDocument): string | null {
  if (doc.html.length > MAX_HTML) return `html is over ${MAX_HTML} characters`;
  if (doc.css.length > MAX_CSS) return `css is over ${MAX_CSS} characters`;
  if (doc.js.length > MAX_JS) return `js is over ${MAX_JS} characters`;
  const html = surfaceHtmlProblem(doc.html);
  if (html) return html;
  if (!regionsInSurfaceHtml(doc.html).length) return "a surface needs at least one element with data-ares-region=\"…\" so later edits can address it";
  const doctrine = scanSurfaceDoctrine(doc.css, doc.js);
  if (doctrine.length) return doctrine.map((f) => f.message).join("; ");
  return null;
}

export async function listSurfaces(home?: string): Promise<SurfaceManifest[]> {
  let names: string[];
  try {
    names = (await readdir(surfacesDir(home), { withFileTypes: true })).filter((d) => d.isDirectory() && validSurfaceName(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  const manifests = await Promise.all(names.map((name) => readJson<unknown>(manifestFile(name, home)).then(cleanManifest)));
  return manifests.filter((m): m is SurfaceManifest => m !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readSurface(name: string, home?: string): Promise<SurfaceRecord | null> {
  if (!validSurfaceName(name)) return null;
  const manifest = cleanManifest(await readJson<unknown>(manifestFile(name, home)));
  if (!manifest) return null;
  const document = manifest.revision > 0 ? cleanDocument(await readJson<unknown>(revisionFile(name, manifest.revision, home))) : null;
  return { manifest, document: document ?? { title: manifest.title, html: "", css: "", js: "" } };
}

export async function listSurfaceRevisions(name: string, home?: string): Promise<Array<{ revision: number; at: number; note?: string; title: string }>> {
  if (!validSurfaceName(name)) return [];
  let files: string[];
  try {
    files = (await readdir(revisionsDir(name, home))).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = await Promise.all(files.map(async (file) => {
    const raw = await readJson<SurfaceRevision>(path.join(revisionsDir(name, home), file));
    return raw && Number.isInteger(raw.revision) ? { revision: raw.revision, at: raw.at ?? 0, ...(raw.note ? { note: raw.note } : {}), title: raw.title ?? "" } : null;
  }));
  return rows.filter((r): r is NonNullable<typeof r> => r !== null).sort((a, b) => a.revision - b.revision);
}

export async function readSurfaceRevision(name: string, revision: number, home?: string): Promise<SurfaceRevision | null> {
  if (!validSurfaceName(name) || !Number.isInteger(revision) || revision < 1) return null;
  const raw = await readJson<SurfaceRevision>(revisionFile(name, revision, home));
  const doc = cleanDocument(raw);
  return raw && doc ? { ...doc, revision: raw.revision, at: raw.at ?? 0, ...(raw.note ? { note: raw.note } : {}) } : null;
}

async function pruneRevisions(name: string, keep: number, home?: string): Promise<void> {
  const rows = await listSurfaceRevisions(name, home);
  const stale = rows.slice(0, Math.max(0, rows.length - keep));
  await Promise.all(stale.map((row) => rm(revisionFile(name, row.revision, home), { force: true })));
}

async function commitRevision(name: string, manifest: SurfaceManifest, document: SurfaceDocument, note: string | undefined, origin: "create" | "mutate" | "rollback", home?: string, mutations?: LivingSurfaceMutation[]): Promise<SurfaceRecord> {
  const revision = manifest.revision + 1;
  const row: SurfaceRevision = { ...document, revision, at: Date.now(), ...(note ? { note: note.slice(0, 400) } : {}) };
  await writeJson(revisionFile(name, revision, home), row);
  const next: SurfaceManifest = { ...manifest, title: document.title || manifest.title, revision, updatedAt: row.at };
  await writeJson(manifestFile(name, home), next);
  await pruneRevisions(name, SURFACE_REVISIONS_KEPT, home);
  surfaceBus.publish({ type: "surface_revision", name, manifest: next, document, ...(note ? { note } : {}), origin, ...(mutations?.length ? { mutations } : {}) });
  return { manifest: next, document };
}

export interface CreateSurfaceInput {
  name: string;
  title: string;
  placement: SurfacePlacement;
  document: Omit<SurfaceDocument, "title">;
  feeds: SurfaceFeed[];
  actions: string[];
  frame?: SurfaceManifest["frame"];
  sessionId?: string;
  note?: string;
}

/** Create (revision 1) or, for an existing name, replace the whole document
 * as a new revision. Capability changes (feeds, actions) are applied too:
 * the tool decides whether they needed an owner decision first. */
export async function createSurface(input: CreateSurfaceInput, home?: string): Promise<SurfaceRecord> {
  if (!validSurfaceName(input.name)) throw new Error("name must be 2-41 lowercase letters, digits or hyphens, starting with a letter or digit");
  const document: SurfaceDocument = { title: input.title.slice(0, 120), html: input.document.html, css: input.document.css ?? "", js: input.document.js ?? "" };
  const problem = documentProblem(document);
  if (problem) throw new Error(problem);
  return serial(async () => {
    const existing = await readSurface(input.name, home);
    if (!existing && (await listSurfaces(home)).length >= SURFACE_MAX_COUNT) throw new Error(`the ledger holds ${SURFACE_MAX_COUNT} surfaces; remove one first`);
    const now = Date.now();
    const manifest: SurfaceManifest = existing
      ? { ...existing.manifest, ...(input.frame ? { frame: input.frame } : {}), title: document.title, placement: input.placement, feeds: input.feeds, actions: input.actions, ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.note ? { note: input.note.slice(0, 400) } : {}), updatedAt: now }
      : { ...(input.frame ? { frame: input.frame } : {}), name: input.name, title: document.title, placement: input.placement, revision: 0, state: "kept", feeds: input.feeds, actions: input.actions, ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.note ? { note: input.note.slice(0, 400) } : {}), createdAt: now, updatedAt: now };
    return commitRevision(input.name, manifest, document, input.note, existing ? "mutate" : "create", home);
  });
}

export interface MutateSurfaceResult extends SurfaceRecord {
  posts: unknown[];
  documentChanged: boolean;
}

/** Apply mutations against `baseRevision`. A stale base is refused — the
 * model is told the current revision and retries against it. Posts never
 * touch the ledger; they go straight to the bus. */
export async function mutateSurface(name: string, baseRevision: number, mutations: readonly LivingSurfaceMutation[], note: string | undefined, home?: string): Promise<MutateSurfaceResult> {
  return serial(async () => {
    const current = await readSurface(name, home);
    if (!current) throw new Error(`no surface named "${name}"`);
    if (baseRevision !== current.manifest.revision) throw new Error(`surface "${name}" is at revision ${current.manifest.revision}, not ${baseRevision}; re-read it and patch that revision`);
    const applied = applySurfaceMutations(current.document, mutations);
    let record: SurfaceRecord = current;
    if (applied.documentChanged) {
      const problem = documentProblem(applied.next);
      if (problem) throw new Error(problem);
      record = await commitRevision(name, current.manifest, applied.next, note, "mutate", home, mutations.filter((m) => m.op !== "post"));
    }
    for (const payload of applied.posts) surfaceBus.publish({ type: "surface_post", name, payload });
    return { ...record, posts: applied.posts, documentChanged: applied.documentChanged };
  });
}

export async function postSurface(name: string, payload: unknown, home?: string): Promise<void> {
  const current = await readSurface(name, home);
  if (!current) throw new Error(`no surface named "${name}"`);
  surfaceBus.publish({ type: "surface_post", name, payload });
}

async function updateManifest(name: string, patch: (manifest: SurfaceManifest) => SurfaceManifest, home?: string): Promise<SurfaceManifest> {
  return serial(async () => {
    const current = await readSurface(name, home);
    if (!current) throw new Error(`no surface named "${name}"`);
    const next = { ...patch(current.manifest), updatedAt: Date.now() };
    await writeJson(manifestFile(name, home), next);
    surfaceBus.publish({ type: "surface_manifest", name, manifest: next });
    return next;
  });
}

export function keepSurface(name: string, home?: string): Promise<SurfaceManifest> {
  return updateManifest(name, (m) => ({ ...m, state: "kept" }), home);
}

export function placeSurface(name: string, placement: SurfacePlacement, home?: string, frame?: SurfaceManifest["frame"]): Promise<SurfaceManifest> {
  return updateManifest(name, (m) => ({ ...m, placement, ...(frame ? { frame } : {}) }), home);
}

export function bindSurfaceSession(name: string, sessionId: string, home?: string): Promise<SurfaceManifest> {
  return updateManifest(name, (m) => ({ ...m, sessionId }), home);
}

export async function removeSurface(name: string, home?: string): Promise<boolean> {
  if (!validSurfaceName(name)) return false;
  return serial(async () => {
    try {
      await stat(surfaceDir(name, home));
    } catch {
      return false;
    }
    // Removal is a move to the trash, history included: Modules restore undoes it.
    const trash = path.join(home ?? aresHome(), "trash", "surfaces", `${name}__${Date.now()}`);
    await mkdir(path.dirname(trash), { recursive: true });
    await rename(surfaceDir(name, home), trash);
    surfaceBus.publish({ type: "surface_removed", name });
    return true;
  });
}

/** Make an older revision the newest one (a new revision with its content),
 * so history is never rewritten and "undo the undo" is another rollback. */
export async function rollbackSurface(name: string, revision: number, home?: string): Promise<SurfaceRecord> {
  return serial(async () => {
    const current = await readSurface(name, home);
    if (!current) throw new Error(`no surface named "${name}"`);
    const target = await readSurfaceRevision(name, revision, home);
    if (!target) throw new Error(`surface "${name}" has no revision ${revision} (kept: ${(await listSurfaceRevisions(name, home)).map((r) => r.revision).join(", ")})`);
    const { revision: _r, at: _a, note: _n, ...document } = target;
    return commitRevision(name, current.manifest, document, `rolled back to revision ${revision}`, "rollback", home);
  });
}

// Script faults the document reported, kept per surface in memory (they are
// diagnostics for the next prompt, not ledger state).
const faults = new Map<string, string[]>();

export function recordSurfaceFault(name: string, message: string): void {
  const list = faults.get(name) ?? [];
  list.push(message.slice(0, 400));
  faults.set(name, list.slice(-MAX_FAULTS));
}

export function surfaceFaults(name: string): string[] {
  return [...(faults.get(name) ?? [])];
}

export function clearSurfaceFaults(name: string): void {
  faults.delete(name);
}

/** What a document keeps with ares.store: beside the ledger, not in it, so it
 * never travels with an exported module. */
const SURFACE_DATA_LIMIT = 1_000_000;

function dataFile(name: string, home?: string): string {
  return path.join(surfaceDir(name, home), "data.json");
}

export async function readSurfaceData(name: string, home?: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(dataFile(name, home), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeSurfaceData(name: string, key: string, value: unknown, home?: string): Promise<void> {
  return serial(async () => {
    const data = await readSurfaceData(name, home);
    if (value === undefined) delete data[key];
    else data[key] = value;
    if (JSON.stringify(data).length > SURFACE_DATA_LIMIT) throw new Error("this surface keeps at most 1 MB");
    await writeJson(dataFile(name, home), data);
  });
}
