// Modules — everything people add to Ares, as one thing to list, undo, share
// and promote (docs/CREATOR-MODE-DESIGN.md). Surfaces, forged tools, skills,
// hooks and the window layout are all modules: they survive restarts, keep
// their revisions, and go to a restorable trash when removed. A pack carries
// any of them to another Ares; `import` also reads other harnesses' plugins.
// `promote` is the road from "I built this and like it" to a base feature:
// it writes the module into a source checkout's base-modules, and a release
// then installs it on every Ares.

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { addOpenMcpServer, aresHome } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";
import { genuiGate } from "./genui.js";
import { listSurfaces, readSurface, surfaceBus } from "./surfaceStore.js";
import { listExtensions } from "./extensionStore.js";
import { extensionHost } from "./Extension.js";
import { buildPack, exportPack, installPack, listTrash, loadPack, packSummary, restoreModule, type InstallHost, type Pack, portNote } from "./packs.js";

const inputSchema = z
  .object({
    action: z.enum(["list", "trash", "restore", "export", "inspect", "import", "promote"]).describe(
      "list: every module on this Ares. trash: what was removed. restore: bring one back with its history. export: write modules to a .arespack file anyone can import. inspect: read a pack or a plugin folder and say what it holds, installing nothing. import: install a pack, or a plugin from another harness (Claude Code plugin folder, DeepSeek Harness bundle, skills folder, SKILL.md, .mcp.json); asks once. promote: write a module into an Ares source checkout's base-modules so a release ships it to everyone.",
    ),
    name: z.string().optional().describe("restore: the module. export/promote: the pack's name."),
    names: z.array(z.string()).max(100).optional().describe("export/promote: which modules (default all for export)."),
    include_shell: z.boolean().optional().describe("export/promote: include the window layout."),
    path: z.string().optional().describe("import/inspect: file or folder. export: output file (default <home>/packs/<name>.arespack)."),
    repo: z.string().optional().describe("promote: the Ares source checkout (default <home>/source)."),
  })
  .strict();

export interface ModulesOutput {
  message: string;
  modules?: Array<{ name: string; kind: string; state: string; revision: number }>;
  trash?: Array<{ kind: string; name: string; removedAt: number }>;
  file?: string;
  installed?: string[];
  failed?: string[];
  skipped?: string[];
}

function host(): InstallHost {
  return {
    mountTool: extensionHost() ? (name) => extensionHost()!.mount(name) : undefined,
    addMcp: async (name, url) => { await addOpenMcpServer(name, url); },
  };
}

export function hashPack(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Install the base modules a release shipped. Each is installed once per
 * content hash, so a base module the owner removed or changed is not forced
 * back, and a release that changes one does arrive. */
export async function installBaseModules(dir: string, home: string, sessionId?: string, installHost: InstallHost = host()): Promise<string[]> {
  const stateFile = path.join(home, "base-modules.json");
  const state = await readFile(stateFile, "utf8").then((t) => JSON.parse(t) as Record<string, string>).catch(() => ({} as Record<string, string>));
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".arespack"));
  const done: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8").catch(() => "");
    if (!text || state[file] === hashPack(text)) continue;
    try {
      const result = await installPack(JSON.parse(text) as Pack, sessionId, installHost, home);
      state[file] = hashPack(text);
      done.push(...result.installed);
    } catch {
      // a bad base pack must not stop the daemon; it retries next boot
    }
  }
  await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
  return done;
}

export const ModulesTool = buildTool<typeof inputSchema, ModulesOutput>({
  name: "Modules",
  description:
    "Everything added to this Ares as modules: list them, restore a removed one, export any set to a .arespack file another person imports and it just works, import a pack or a plugin from another harness (Claude Code plugin, DeepSeek Harness bundle, skills, MCP config), and promote a module the owner likes into the base so a release ships it. Use inspect first on anything from someone else. Other harnesses' runtime code cannot run here; the result names what was skipped.",
  safety: "read-only",
  dynamicSafety: (input) => (input.action === "import" || input.action === "promote" ? "external-state" : "read-only"),
  ownerDecisions: true,
  concurrency: "exclusive",
  inputZod: inputSchema,
  validateInput: async (input) => genuiGate(input.action === "import" || input.action === "promote" || input.action === "restore"),
  watchdogTimeoutMs: 60_000,
  maxResultSizeChars: 40_000,
  activityDescription: (i) => `${i.action} modules`,
  async checkPermissions(input, ctx) {
    if (input.action !== "import" && input.action !== "promote") return { kind: "allow" };
    if (ctx.permissionMode === "plan") return { kind: "deny", reason: "Modules can only be read in plan mode." };
    if (input.action === "promote") {
      return { kind: "ask", prompt: `Add ${input.names?.join(", ") ?? "these modules"} to Ares's base in ${input.repo ?? "the source checkout"}? It is written there uncommitted; shipping it is your release.`, suggestion: "allow_once", ownerDecision: true };
    }
    if (!input.path) return { kind: "allow" };
    const pack = await loadPack(input.path).catch(() => null);
    if (!pack) return { kind: "allow" }; // call() reports why
    return {
      kind: "ask",
      prompt: `Install "${pack.name}"${pack.from ? ` (${pack.from})` : ""}? It adds: ${packSummary(pack).join("; ") || "nothing yet"}.${pack.port ? ` Its code will not run: ${pack.port.files.length} file(s) are saved for Ares to read and rebuild.` : ""}${pack.skipped?.length ? ` Skipped: ${pack.skipped.join("; ")}.` : ""} Code from someone else can do what its line says; hooks run with your full permissions.`,
      suggestion: "allow_once",
      ownerDecision: true,
    };
  },
  async call(input, ctx): Promise<ToolResult<ModulesOutput>> {
    const home = aresHome();
    try {
      switch (input.action) {
        case "list": {
          const surfaces = (await listSurfaces()).map((s) => ({ name: s.name, kind: `surface (${s.placement})`, state: s.state, revision: s.revision }));
          const extensions = (await listExtensions()).map((e) => ({ name: e.name, kind: e.kind, state: e.mounted ? "mounted" : e.state, revision: e.revision }));
          const modules = [...surfaces, ...extensions];
          return okResult({ modules, message: modules.length ? modules.map((m) => `${m.name}: ${m.kind}, r${m.revision}, ${m.state}`).join("\n") : "No modules yet." });
        }
        case "trash": {
          const trash = await listTrash();
          return okResult({ trash, message: trash.length ? trash.map((t) => `${t.name} (${t.kind})`).join("\n") : "The trash is empty." });
        }
        case "restore": {
          if (!input.name) return failResult<ModulesOutput>("restore needs name.");
          const kind = await restoreModule(input.name);
          if (kind === "surfaces") {
            const record = await readSurface(input.name);
            if (record) surfaceBus.publish({ type: "surface_revision", name: input.name, manifest: record.manifest, document: record.document, origin: "mutate" });
          }
          return okResult({ message: `Restored "${input.name}" with its history.${kind === "extensions" ? " Mount it to use it." : ""}` });
        }
        case "export": {
          const name = input.name ?? "my-ares";
          const pack = await buildPack(name, input.names, input.include_shell === true);
          if (!pack.modules.length) return failResult<ModulesOutput>("Nothing to export.");
          const file = await exportPack(pack, input.path ?? path.join(home, "packs", `${name}.arespack`));
          return okResult({ file, message: `Wrote ${pack.modules.length} module(s) to ${file}. Send that file; on another Ares, Modules import installs it.` });
        }
        case "inspect": {
          if (!input.path) return failResult<ModulesOutput>("inspect needs path.");
          const pack = await loadPack(input.path);
          return okResult({ skipped: pack.skipped, message: `${pack.name}${pack.from ? ` (${pack.from})` : ""}: ${packSummary(pack).join("; ") || "no modules"}.${pack.skipped?.length ? ` Would skip: ${pack.skipped.join("; ")}.` : ""}` });
        }
        case "import": {
          if (!input.path) return failResult<ModulesOutput>("import needs path.");
          const pack = await loadPack(input.path);
          const result = await installPack(pack, ctx.sessionId, host());
          return okResult({ ...result, skipped: pack.skipped, ...(pack.port ? { port: pack.port } : {}), message: `Installed ${result.installed.length}: ${result.installed.join(", ") || "nothing"}.${portNote(pack)}${result.failed.length ? ` Failed: ${result.failed.join("; ")}.` : ""}${pack.skipped?.length ? ` Skipped: ${pack.skipped.join("; ")}.` : ""}` });
        }
        case "promote": {
          if (!input.name || !input.names?.length) return failResult<ModulesOutput>("promote needs name and names.");
          const repo = input.repo ?? path.join(home, "source");
          const pack = await buildPack(input.name, input.names, input.include_shell === true);
          if (!pack.modules.length) return failResult<ModulesOutput>("None of those modules exist.");
          const dir = path.join(repo, "packages", "agent", "base-modules");
          await readdir(path.join(repo, "packages")).catch(() => { throw new Error(`${repo} is not an Ares source checkout`); });
          await mkdir(dir, { recursive: true });
          const file = path.join(dir, `${input.name}.arespack`);
          await exportPack(pack, file);
          return okResult({ file, message: `Wrote ${pack.modules.length} module(s) to ${file}. Commit and release to ship it; every Ares installs it at its next boot.` });
        }
      }
    } catch (err) {
      return failResult<ModulesOutput>(err instanceof Error ? err.message : String(err));
    }
  },
});
