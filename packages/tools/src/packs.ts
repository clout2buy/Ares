// Packs: everything anyone built on one Ares, as one file another Ares can
// install (docs/CREATOR-MODE-DESIGN.md). Surfaces, forged tools, skills, hooks,
// the shell layout and MCP connections are all just modules, so a pack is a
// JSON list of them. Export → send the file → import → it works, because a
// module carries its own source and asks for nothing machine-specific.
//
// Importers for other harnesses live here too: a plugin from another agent
// turns into the same module list, and whatever has no equivalent is named
// in `skipped` instead of being dropped silently. Code written against
// another harness's runtime (a Cordis plugin, a Claude Code JS mod) cannot
// run here as it is; its skills, MCP servers and shell hooks can, and the code
// itself is kept for Ares to rebuild natively (pluginImport.ts).

import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { aresHome } from "@ares/core";
import { isSurfacePlacement, type SurfaceDocument, type SurfaceManifest } from "@ares/protocol";
import { createSurface, listSurfaces, readSurface, surfacesDir, validSurfaceName } from "./surfaceStore.js";
import { extensionsDir, listExtensions, readExtension, saveExtension, validExtensionName, type ExtensionManifest } from "./extensionStore.js";
import { commitShellLayout, readShellLayout, type ShellLayout } from "./Shell.js";
import { installHook, installSkillSource } from "./extensionSkills.js";
import { manifestProblems } from "./forgedToolRunner.js";
import { identifyPlugin, keepForPorting, pluginFileKind, ruleFiles, sealedMessage, surfaceFromHtml, unpackPlugin, type PluginPort } from "./pluginImport.js";

export const PACK_FORMAT = "ares-pack";
export const PACK_VERSION = 1;

export type PackModule =
  | { type: "surface"; manifest: SurfaceManifest; document: SurfaceDocument }
  | { type: "extension"; manifest: ExtensionManifest; source: string }
  | { type: "shell"; layout: Omit<ShellLayout, "revision" | "at"> }
  | { type: "mcp"; name: string; url: string };

export interface Pack {
  format: typeof PACK_FORMAT;
  version: number;
  name: string;
  description?: string;
  from?: string;
  modules: PackModule[];
  /** Parts of a foreign plugin with no equivalent here, and why. */
  skipped?: string[];
  /** Code that cannot run here as it is, kept for Ares to rebuild natively. */
  port?: PluginPort;
}

/** What to tell the agent about code it has to rebuild. */
export function portNote(pack: Pack): string {
  if (!pack.port) return "";
  return ` ${pack.port.files.length} code file(s) written for ${pack.port.runtime} cannot run here as they are. They were not run. They are kept at ${pack.port.dir}: read them, then rebuild what the plugin does with Surface, Extension or Shell. Do not stop at saying it is incompatible.`;
}

export function packSummary(pack: Pack): string[] {
  return pack.modules.map((m) => {
    if (m.type === "surface") return `surface "${m.manifest.title}" (${m.manifest.placement})${m.manifest.feeds.length ? ` with ${m.manifest.feeds.length} live feed(s)` : ""}${m.manifest.actions.length ? `, may call ${m.manifest.actions.join(", ")}` : ""}`;
    if (m.type === "shell") return `a window layout (hides ${m.layout.hide.join(", ") || "nothing"})${m.layout.script ? " and a script with Ares's full authority" : ""}`;
    if (m.type === "mcp") return `MCP connection ${m.name} (${m.url})`;
    if (m.manifest.kind === "hook") return `hook "${m.manifest.title}" on ${m.manifest.hookEvent}: a program with your full permissions`;
    if (m.manifest.kind === "skill") return `skill "${m.manifest.title}"`;
    const c = m.manifest.capabilities;
    return `tool "${m.manifest.title}" (reads ${c?.readRoots.join(", ") || "nothing"}, writes ${c?.writeRoots.join(", ") || "nothing"}, fetches ${c?.hosts.join(", ") || "nothing"})`;
  });
}

export async function buildPack(name: string, names: string[] | undefined, includeShell: boolean, home?: string): Promise<Pack> {
  const wanted = names?.length ? new Set(names) : null;
  const modules: PackModule[] = [];
  for (const m of await listSurfaces(home)) {
    if (wanted && !wanted.has(m.name)) continue;
    const record = await readSurface(m.name, home);
    if (record) {
      const { sessionId: _s, ...manifest } = record.manifest;
      modules.push({ type: "surface", manifest: manifest as SurfaceManifest, document: record.document });
    }
  }
  for (const m of await listExtensions(home)) {
    if (wanted && !wanted.has(m.name)) continue;
    const record = await readExtension(m.name, home);
    if (record) {
      const { sessionId: _s, faults: _f, ...manifest } = record.manifest;
      modules.push({ type: "extension", manifest: manifest as ExtensionManifest, source: record.source });
    }
  }
  if (includeShell) {
    const { revision: _r, at: _a, ...layout } = await readShellLayout(home);
    modules.push({ type: "shell", layout });
  }
  return { format: PACK_FORMAT, version: PACK_VERSION, name, modules };
}

export async function exportPack(pack: Pack, file: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(pack, null, 2), "utf8");
  return file;
}

function frontmatterField(text: string, field: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const m = fm ? new RegExp(`^${field}:\\s*(.+)$`, "m").exec(fm) : null;
  return m?.[1].replace(/^["']|["']$/g, "").trim();
}

function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return /^[a-z]/.test(s) && s.length >= 2 ? s : `x-${s || "module"}`.slice(0, 40);
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

function skillModule(name: string, text: string): PackModule {
  const now = Date.now();
  const id = slug(frontmatterField(text, "name") ?? name);
  return { type: "extension", source: text, manifest: { name: id, kind: "skill", title: frontmatterField(text, "name") ?? name, description: (frontmatterField(text, "description") ?? "").slice(0, 1000), revision: 0, state: "kept", createdAt: now, updatedAt: now } };
}

async function skillsIn(dir: string, modules: PackModule[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(path.join(dir, entry.name, "SKILL.md"), "utf8").catch(() => "");
    if (text) modules.push(skillModule(entry.name, text));
  }
}

function mcpFrom(json: unknown, modules: PackModule[], skipped: string[]): void {
  // Claude Code and Cursor say mcpServers, VS Code says servers.
  const shape = json as { mcpServers?: Record<string, { url?: unknown; command?: unknown }>; servers?: Record<string, { url?: unknown; command?: unknown }> };
  const servers = shape?.mcpServers ?? shape?.servers ?? {};
  for (const [name, row] of Object.entries(servers)) {
    if (typeof row?.url === "string") modules.push({ type: "mcp", name, url: row.url });
    else skipped.push(`MCP server "${name}" is a local command; connect it with Mcp, it needs its own runtime on this machine`);
  }
}

/** Claude Code hook commands run as they are; only the ones with a known event map. */
function hooksFrom(json: unknown, modules: PackModule[], skipped: string[], label: string): void {
  const hooks = (json as { hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>> })?.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (event !== "PreToolUse" && event !== "PostToolUse" && event !== "SessionStart") { skipped.push(`${label} hook on ${event}: Ares has no such event`); continue; }
    groups.forEach((group, gi) => (group.hooks ?? []).forEach((hook, hi) => {
      if (typeof hook.command !== "string") return;
      const now = Date.now();
      // Exit status passes through, so a blocking hook still blocks.
      const source = `import { spawnSync } from "node:child_process";\nimport { readFileSync } from "node:fs";\nconst r = spawnSync(${JSON.stringify(hook.command)}, { shell: true, input: readFileSync(0), stdio: ["pipe", "inherit", "inherit"] });\nprocess.exit(r.status ?? 1);\n`;
      modules.push({ type: "extension", source, manifest: { name: slug(`${label}-${event}-${gi}-${hi}`), kind: "hook", title: `${label} ${event}`, description: hook.command.slice(0, 300), revision: 0, state: "kept", hookEvent: event, ...(group.matcher ? { matcher: group.matcher } : {}), createdAt: now, updatedAt: now } });
    }));
  }
}

function surfaceModule(name: string, title: string, document: SurfaceDocument): PackModule {
  const now = Date.now();
  return { type: "surface", document, manifest: { name, title, placement: "pane", revision: 0, state: "kept", feeds: [], actions: [], createdAt: now, updatedAt: now } as SurfaceManifest };
}

/** A single file that is not a pack: an archive, a sealed module, a page, instructions or code. */
async function loadFile(target: string, buf: Buffer, label: string | undefined): Promise<Pack | null> {
  const stem = slug(path.basename(target).replace(/\.[^.]+$/, ""));
  const kind = pluginFileKind(buf);
  if (kind === "sealed") throw new Error(sealedMessage(target, buf));
  if (kind === "binary") throw new Error(`${path.basename(target)} is a compiled file, so there is nothing to read or convert. Import the plugin's source folder instead, or describe what it does and build it with Surface.`);
  if (kind !== "text") return loadPack(await unpackPlugin(buf, kind, stem), label ?? path.basename(target));
  const ext = path.extname(target).toLowerCase();
  const name = label ?? path.basename(target);
  if (ext === ".html" || ext === ".htm") {
    const page = await surfaceFromHtml(target);
    if (page) return { format: PACK_FORMAT, version: PACK_VERSION, name, from: "web page", modules: [surfaceModule(stem, page.title, page.document)] };
  }
  if (ext === ".md" || ext === ".mdc" || ext === ".txt") return { format: PACK_FORMAT, version: PACK_VERSION, name, from: "instructions", modules: [skillModule(stem, buf.toString("utf8"))] };
  return null;
}

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

/** Read a pack file, or recognize a plugin from anywhere: a file, a folder or an archive. */
export async function loadPack(target: string, label?: string): Promise<Pack> {
  const info = await stat(target).catch(() => null);
  if (!info) throw new Error(`nothing at ${target}`);
  if (info.isFile()) {
    const buf = await readFile(target);
    const raw = parseJson(buf) as (Partial<Pack> & { mcpServers?: unknown; servers?: unknown }) | null;
    if (!raw) {
      if (path.basename(target) !== "SKILL.md") {
        const handled = await loadFile(target, buf, label);
        if (handled) return handled;
        const stem = slug(path.basename(target).replace(/\.[^.]+$/, ""));
        const folder = path.join(aresHome(), "imports", `${stem}-file`);
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, path.basename(target)), buf);
        const port = await keepForPorting(folder, stem, "another app");
        if (port) return { format: PACK_FORMAT, version: PACK_VERSION, name: label ?? path.basename(target), from: "code file", modules: [], port };
        throw new Error(`${path.basename(target)} is not a format Ares recognizes`);
      }
      return { format: PACK_FORMAT, version: PACK_VERSION, name: path.basename(path.dirname(target)), from: "skill", modules: [skillModule(path.basename(path.dirname(target)), buf.toString("utf8"))] };
    }
    if (raw.format === PACK_FORMAT) {
      if ((raw.version ?? 0) > PACK_VERSION) throw new Error(`this pack needs a newer Ares (pack v${raw.version})`);
      if (!Array.isArray(raw.modules)) throw new Error("the pack has no modules");
      return raw as Pack;
    }
    if (raw.mcpServers || raw.servers) {
      const modules: PackModule[] = [];
      const skipped: string[] = [];
      mcpFrom(raw, modules, skipped);
      return { format: PACK_FORMAT, version: PACK_VERSION, name: path.basename(target), from: "mcp config", modules, skipped };
    }
    if (path.basename(target) === "SKILL.md") return { format: PACK_FORMAT, version: PACK_VERSION, name: path.basename(path.dirname(target)), from: "skill", modules: [skillModule(path.basename(path.dirname(target)), await readFile(target, "utf8"))] };
    throw new Error("this JSON is not an Ares pack or an MCP config, and there is no plugin code to read");
  }
  const modules: PackModule[] = [];
  const skipped: string[] = [];
  const known = await identifyPlugin(target);
  let name = known.name ?? label ?? path.basename(target);
  let from = known.from ?? "skills folder";
  const claudeManifest = path.join(target, ".claude-plugin", "plugin.json");
  const pkgFile = path.join(target, "package.json");
  if (await exists(path.join(target, "SKILL.md"))) {
    modules.push(skillModule(name, await readFile(path.join(target, "SKILL.md"), "utf8")));
  }
  if (await exists(claudeManifest)) {
    from = "Claude Code plugin";
    const manifest = JSON.parse(await readFile(claudeManifest, "utf8")) as { name?: string };
    name = manifest.name ?? name;
    await skillsIn(path.join(target, "skills"), modules);
    const commands = await readdir(path.join(target, "commands")).catch(() => [] as string[]);
    for (const file of commands.filter((f) => f.endsWith(".md"))) modules.push(skillModule(file.replace(/\.md$/, ""), await readFile(path.join(target, "commands", file), "utf8")));
    const agents = await readdir(path.join(target, "agents")).catch(() => [] as string[]);
    if (agents.length) skipped.push(`${agents.length} subagent definition(s): create them with Agents`);
  }
  if (await exists(path.join(target, ".mcp.json"))) mcpFrom(JSON.parse(await readFile(path.join(target, ".mcp.json"), "utf8")), modules, skipped);
  const hooksJson = path.join(target, "hooks", "hooks.json");
  if (await exists(hooksJson)) hooksFrom(JSON.parse(await readFile(hooksJson, "utf8")), modules, skipped, slug(name));
  if (await exists(pkgFile)) {
    const pkg = JSON.parse(await readFile(pkgFile, "utf8")) as { name?: string; dsh?: { bundle?: unknown; client?: unknown } };
    if (pkg.dsh?.bundle) {
      from = "DeepSeek Harness bundle";
      name = pkg.name ?? name;
      await skillsIn(path.join(target, "skills"), modules);
      const hasCode = (await readdir(target)).some((f) => /\.(m?js|ts)$/.test(f)) || Boolean(pkg.dsh.client);
      if (hasCode) skipped.push("the bundle's plugin code targets DeepSeek Harness's Cordis runtime and its UI slots, which Ares does not run; it is kept for Ares to rebuild as a surface or forged tool");
    }
  }
  await skillsIn(path.join(target, ".claude", "skills"), modules);
  if (!(await exists(claudeManifest))) await skillsIn(path.join(target, "skills"), modules);
  for (const file of ["mcp.json", path.join(".cursor", "mcp.json"), path.join(".vscode", "mcp.json")]) {
    if (await exists(path.join(target, file))) mcpFrom(JSON.parse(await readFile(path.join(target, file), "utf8")), modules, skipped);
  }
  for (const rule of await ruleFiles(target)) modules.push(skillModule(rule.name, rule.text));
  // A built page runs here as it is, in the same sandbox as any surface.
  for (const page of ["index.html", "dist/index.html", "build/index.html", "public/index.html", "web/index.html", "ui/index.html"]) {
    const built = await exists(path.join(target, page)) ? await surfaceFromHtml(path.join(target, page)) : null;
    if (built) { modules.push(surfaceModule(slug(name), built.title, built.document)); break; }
  }
  const port = await keepForPorting(target, slug(name), from === "skills folder" ? "another app" : from);
  if (from === "skills folder" && port) from = "plugin";
  const seen = new Set<string>();
  const unique = modules.filter((m) => {
    const key = m.type === "extension" ? `e:${m.manifest.name}` : m.type === "mcp" ? `m:${m.name}` : m.type === "surface" ? `s:${m.manifest.name}` : m.type;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.length && !port) throw new Error(`found nothing Ares can use in ${target}${skipped.length ? `: ${skipped.join("; ")}` : ""}`);
  return { format: PACK_FORMAT, version: PACK_VERSION, name, from, modules: unique, ...(skipped.length ? { skipped } : {}), ...(port ? { port } : {}) };
}

export interface InstallHost {
  mountTool?: (name: string) => Promise<{ mounted: boolean; error?: string }>;
  addMcp?: (name: string, url: string) => Promise<void>;
}

/** Install every module. A name that already exists gets a new revision,
 * so an import is itself revertible. Problems are reported per module. */
export async function installPack(pack: Pack, sessionId: string | undefined, host: InstallHost, home?: string): Promise<{ installed: string[]; failed: string[] }> {
  const installed: string[] = [];
  const failed: string[] = [];
  for (const m of pack.modules) {
    try {
      if (m.type === "surface") {
        if (!validSurfaceName(m.manifest.name) || !isSurfacePlacement(m.manifest.placement)) throw new Error("bad name or placement");
        await createSurface({ name: m.manifest.name, title: m.manifest.title, placement: m.manifest.placement, document: m.document, feeds: m.manifest.feeds ?? [], actions: m.manifest.actions ?? [], ...(m.manifest.frame ? { frame: m.manifest.frame } : {}), sessionId, note: `imported from pack ${pack.name}` }, home);
        installed.push(`surface ${m.manifest.name}`);
      } else if (m.type === "shell") {
        await commitShellLayout({ ...m.layout, note: `imported from pack ${pack.name}` }, home);
        installed.push("window layout");
      } else if (m.type === "mcp") {
        if (!host.addMcp) throw new Error("this host cannot add MCP servers");
        await host.addMcp(m.name, m.url);
        installed.push(`MCP ${m.name}`);
      } else {
        const man = m.manifest;
        if (!validExtensionName(man.name)) throw new Error(`bad name ${man.name}`);
        if (man.kind === "tool") {
          const problems = manifestProblems(m.source, man.capabilities ?? { readRoots: [], writeRoots: [], hosts: [], tools: [] });
          if (problems.length) throw new Error(problems.join("; "));
        }
        await saveExtension({ name: man.name, kind: man.kind, title: man.title, description: man.description, source: m.source, capabilities: man.capabilities, inputSchema: man.inputSchema, safety: man.safety, hookEvent: man.hookEvent, matcher: man.matcher, sessionId, note: `imported from pack ${pack.name}` }, home);
        if (man.kind === "skill") await installSkillSource(man.name, m.source);
        else if (man.kind === "hook") await installHook(man.name, m.source, man.hookEvent ?? "PreToolUse", man.matcher);
        else if (host.mountTool) {
          const r = await host.mountTool(man.name);
          if (!r.mounted) throw new Error(r.error ?? "mount failed");
        }
        installed.push(`${man.kind} ${man.name}`);
      }
    } catch (err) {
      failed.push(`${m.type === "extension" || m.type === "surface" ? m.manifest.name : m.type}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { installed, failed };
}

// ─── Trash ───────────────────────────────────────────────────────────────────
// Removing a module moves it here with its whole history; restore is a rename.

function trashDir(home?: string): string {
  return path.join(home ?? aresHome(), "trash");
}

export async function listTrash(home?: string): Promise<Array<{ kind: string; name: string; removedAt: number }>> {
  const rows: Array<{ kind: string; name: string; removedAt: number }> = [];
  for (const kind of ["surfaces", "extensions"]) {
    for (const dir of await readdir(path.join(trashDir(home), kind)).catch(() => [] as string[])) {
      const m = /^(.+)__(\d+)$/.exec(dir);
      if (m) rows.push({ kind, name: m[1], removedAt: Number(m[2]) });
    }
  }
  return rows.sort((a, b) => b.removedAt - a.removedAt);
}

export async function restoreModule(name: string, home?: string): Promise<string> {
  const hit = (await listTrash(home)).find((r) => r.name === name);
  if (!hit) throw new Error(`nothing named "${name}" in the trash`);
  const target = path.join(hit.kind === "surfaces" ? surfacesDir(home) : extensionsDir(home), name);
  if (await exists(target)) throw new Error(`"${name}" already exists; remove it first`);
  await rename(path.join(trashDir(home), hit.kind, `${name}__${hit.removedAt}`), target);
  return hit.kind;
}
