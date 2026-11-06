// The extension ledger: everything Ares forged that is not a surface, as
// files under <ARES_HOME>/extensions/<name>/ — extension.json (the manifest
// the owner approved) beside revisions/<n>.json (the source at each
// revision). Layer 2 of docs/CREATOR-MODE-DESIGN.md.
//
// Two kinds have a runtime here: `skill` (a SKILL.md the skill catalog picks
// up) and `tool` (a module the daemon mounts into the belt through the
// plugin kernel and runs in a worker under a capability manifest). The other
// kinds the design names — connector, agent, watcher — already have homes
// (Connect/Mcp, Agents, Remind/Hooks/Track); the Extension tool routes there
// instead of growing a second lifecycle for each.

import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { aresHome } from "@ares/core";

export const EXTENSION_KINDS = ["tool", "skill", "hook"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];
export const EXTENSION_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
export const EXTENSION_REVISIONS_KEPT = 30;
const MAX_SOURCE = 200_000;

/** What a forged tool may reach. The manifest is derived from the source by
 * a static scan, shown to the owner, and enforced by the worker: the module
 * sees an `ares` object holding exactly these capabilities and nothing else. */
export interface ToolCapabilities {
  /** Workspace-relative roots the tool may read. */
  readRoots: string[];
  /** Workspace-relative roots the tool may write. */
  writeRoots: string[];
  /** Hosts the tool may fetch from. */
  hosts: string[];
  /** Belt tools the module may call through ares.call (each gated). */
  tools: string[];
}

export interface ExtensionManifest {
  name: string;
  kind: ExtensionKind;
  title: string;
  description: string;
  revision: number;
  state: "trial" | "kept";
  /** In the belt / installed; restored at every boot. */
  mounted?: boolean;
  /** tool: the capability manifest the owner approved. */
  capabilities?: ToolCapabilities;
  /** tool: the model-facing input schema (JSON Schema) and safety class. */
  inputSchema?: unknown;
  safety?: "read-only" | "workspace-write" | "external-state";
  /** hook: when it runs and on which tools. */
  hookEvent?: "SessionStart" | "PreToolUse" | "PostToolUse";
  matcher?: string;
  sessionId?: string;
  /** Last fault messages (runtime) — diagnostics for the next prompt. */
  faults?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ExtensionRevision {
  revision: number;
  at: number;
  source: string;
  note?: string;
}

export interface ExtensionRecord {
  manifest: ExtensionManifest;
  source: string;
}

export type ExtensionBusEvent =
  | { type: "extension_revision"; name: string; manifest: ExtensionManifest; source: string; origin: "create" | "update" | "rollback" }
  | { type: "extension_manifest"; name: string; manifest: ExtensionManifest }
  | { type: "extension_removed"; name: string };

class ExtensionBus extends EventEmitter {
  publish(event: ExtensionBusEvent): void { this.emit("event", event); }
  subscribe(listener: (event: ExtensionBusEvent) => void): () => void {
    this.on("event", listener);
    return () => { this.off("event", listener); };
  }
}

export const extensionBus = new ExtensionBus();

export function extensionsDir(home?: string): string {
  return path.join(home ?? aresHome(), "extensions");
}
function extDir(name: string, home?: string): string { return path.join(extensionsDir(home), name); }
function manifestFile(name: string, home?: string): string { return path.join(extDir(name, home), "extension.json"); }
function revisionsDir(name: string, home?: string): string { return path.join(extDir(name, home), "revisions"); }
function revisionFile(name: string, revision: number, home?: string): string { return path.join(revisionsDir(name, home), `${String(revision).padStart(5, "0")}.json`); }

export function validExtensionName(name: unknown): name is string {
  return typeof name === "string" && EXTENSION_NAME_RE.test(name);
}

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(5).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return null; }
}

function cleanCapabilities(raw: unknown): ToolCapabilities {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 300).slice(0, 32) : []);
  return { readRoots: list(row.readRoots), writeRoots: list(row.writeRoots), hosts: list(row.hosts), tools: list(row.tools) };
}

function cleanManifest(raw: unknown): ExtensionManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (!validExtensionName(row.name) || (row.kind !== "tool" && row.kind !== "skill" && row.kind !== "hook")) return null;
  return {
    name: row.name,
    kind: row.kind,
    title: typeof row.title === "string" ? row.title.slice(0, 120) : row.name,
    description: typeof row.description === "string" ? row.description.slice(0, 1_000) : "",
    revision: Number.isInteger(row.revision) ? Number(row.revision) : 0,
    state: row.state === "kept" ? "kept" : "trial",
    ...(row.mounted === true ? { mounted: true } : {}),
    ...(row.kind === "tool" ? { capabilities: cleanCapabilities(row.capabilities) } : {}),
    ...(row.inputSchema !== undefined ? { inputSchema: row.inputSchema } : {}),
    ...(row.safety === "read-only" || row.safety === "workspace-write" || row.safety === "external-state" ? { safety: row.safety } : {}),
    ...(row.hookEvent === "SessionStart" || row.hookEvent === "PreToolUse" || row.hookEvent === "PostToolUse" ? { hookEvent: row.hookEvent } : {}),
    ...(typeof row.matcher === "string" ? { matcher: row.matcher.slice(0, 200) } : {}),
    ...(typeof row.sessionId === "string" ? { sessionId: row.sessionId } : {}),
    ...(Array.isArray(row.faults) ? { faults: (row.faults as unknown[]).filter((f): f is string => typeof f === "string").slice(-5) } : {}),
    createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now(),
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : Date.now(),
  };
}

export async function listExtensions(home?: string): Promise<ExtensionManifest[]> {
  let names: string[];
  try {
    names = (await readdir(extensionsDir(home), { withFileTypes: true })).filter((d) => d.isDirectory() && validExtensionName(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  const rows = await Promise.all(names.map((n) => readJson<unknown>(manifestFile(n, home)).then(cleanManifest)));
  return rows.filter((m): m is ExtensionManifest => m !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readExtension(name: string, home?: string): Promise<ExtensionRecord | null> {
  if (!validExtensionName(name)) return null;
  const manifest = cleanManifest(await readJson<unknown>(manifestFile(name, home)));
  if (!manifest) return null;
  const rev = manifest.revision > 0 ? await readJson<ExtensionRevision>(revisionFile(name, manifest.revision, home)) : null;
  return { manifest, source: typeof rev?.source === "string" ? rev.source : "" };
}

export async function listExtensionRevisions(name: string, home?: string): Promise<Array<{ revision: number; at: number; note?: string }>> {
  if (!validExtensionName(name)) return [];
  let files: string[];
  try { files = (await readdir(revisionsDir(name, home))).filter((f) => f.endsWith(".json")); } catch { return []; }
  const rows = await Promise.all(files.map(async (f) => {
    const raw = await readJson<ExtensionRevision>(path.join(revisionsDir(name, home), f));
    return raw && Number.isInteger(raw.revision) ? { revision: raw.revision, at: raw.at ?? 0, ...(raw.note ? { note: raw.note } : {}) } : null;
  }));
  return rows.filter((r): r is NonNullable<typeof r> => r !== null).sort((a, b) => a.revision - b.revision);
}

async function commit(name: string, manifest: ExtensionManifest, source: string, note: string | undefined, origin: "create" | "update" | "rollback", home?: string): Promise<ExtensionRecord> {
  if (source.length > MAX_SOURCE) throw new Error(`source is over ${MAX_SOURCE} characters`);
  const revision = manifest.revision + 1;
  const row: ExtensionRevision = { revision, at: Date.now(), source, ...(note ? { note: note.slice(0, 400) } : {}) };
  await writeJson(revisionFile(name, revision, home), row);
  const next: ExtensionManifest = { ...manifest, revision, updatedAt: row.at, faults: [] };
  await writeJson(manifestFile(name, home), next);
  const revs = await listExtensionRevisions(name, home);
  for (const stale of revs.slice(0, Math.max(0, revs.length - EXTENSION_REVISIONS_KEPT))) await rm(revisionFile(name, stale.revision, home), { force: true });
  extensionBus.publish({ type: "extension_revision", name, manifest: next, source, origin });
  return { manifest: next, source };
}

export interface SaveExtensionInput {
  name: string;
  kind: ExtensionKind;
  title: string;
  description: string;
  source: string;
  capabilities?: ToolCapabilities;
  inputSchema?: unknown;
  safety?: ExtensionManifest["safety"];
  hookEvent?: ExtensionManifest["hookEvent"];
  matcher?: string;
  sessionId?: string;
  note?: string;
}

/** Create (revision 1) or update (next revision) an extension. */
export async function saveExtension(input: SaveExtensionInput, home?: string): Promise<ExtensionRecord> {
  if (!validExtensionName(input.name)) throw new Error("name must be 2-41 lowercase letters, digits or hyphens, starting with a letter");
  return serial(async () => {
    const existing = await readExtension(input.name, home);
    if (existing && existing.manifest.kind !== input.kind) throw new Error(`"${input.name}" is a ${existing.manifest.kind}, not a ${input.kind}`);
    const now = Date.now();
    const hookFields = input.kind === "hook" ? { hookEvent: input.hookEvent ?? "PreToolUse", ...(input.matcher ? { matcher: input.matcher } : {}) } : {};
    const manifest: ExtensionManifest = existing
      ? { ...existing.manifest, ...hookFields, title: input.title.slice(0, 120), description: input.description.slice(0, 1_000), ...(input.kind === "tool" ? { capabilities: cleanCapabilities(input.capabilities), inputSchema: input.inputSchema, safety: input.safety ?? "read-only" } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), updatedAt: now }
      : { ...hookFields, name: input.name, kind: input.kind, title: input.title.slice(0, 120), description: input.description.slice(0, 1_000), revision: 0, state: "kept", ...(input.kind === "tool" ? { capabilities: cleanCapabilities(input.capabilities), inputSchema: input.inputSchema, safety: input.safety ?? "read-only" } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), createdAt: now, updatedAt: now };
    return commit(input.name, manifest, input.source, input.note, existing ? "update" : "create", home);
  });
}

async function updateManifest(name: string, patch: (m: ExtensionManifest) => ExtensionManifest, home?: string): Promise<ExtensionManifest> {
  return serial(async () => {
    const current = await readExtension(name, home);
    if (!current) throw new Error(`no extension named "${name}"`);
    const next = { ...patch(current.manifest), updatedAt: Date.now() };
    await writeJson(manifestFile(name, home), next);
    extensionBus.publish({ type: "extension_manifest", name, manifest: next });
    return next;
  });
}

export function keepExtension(name: string, home?: string): Promise<ExtensionManifest> {
  return updateManifest(name, (m) => ({ ...m, state: "kept", mounted: true }), home);
}

export function setExtensionMounted(name: string, mounted: boolean, home?: string): Promise<ExtensionManifest> {
  return updateManifest(name, (m) => ({ ...m, mounted }), home);
}

export function recordExtensionFault(name: string, message: string, home?: string): Promise<ExtensionManifest> {
  return updateManifest(name, (m) => ({ ...m, faults: [...(m.faults ?? []), message.slice(0, 400)].slice(-5) }), home);
}

export async function removeExtension(name: string, home?: string): Promise<boolean> {
  if (!validExtensionName(name)) return false;
  return serial(async () => {
    try { await stat(extDir(name, home)); } catch { return false; }
    const trash = path.join(home ?? aresHome(), "trash", "extensions", `${name}__${Date.now()}`);
    await mkdir(path.dirname(trash), { recursive: true });
    await rename(extDir(name, home), trash);
    extensionBus.publish({ type: "extension_removed", name });
    return true;
  });
}

export async function rollbackExtension(name: string, revision: number, home?: string): Promise<ExtensionRecord> {
  return serial(async () => {
    const current = await readExtension(name, home);
    if (!current) throw new Error(`no extension named "${name}"`);
    const target = await readJson<ExtensionRevision>(revisionFile(name, revision, home));
    if (!target || typeof target.source !== "string") throw new Error(`"${name}" has no revision ${revision}`);
    return commit(name, current.manifest, target.source, `rolled back to revision ${revision}`, "rollback", home);
  });
}
