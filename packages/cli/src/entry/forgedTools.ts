// Forged tools in the belt (docs/CREATOR-MODE-DESIGN.md, Layer 2 + kernel
// Step 1 for this tenant). Every mounted extension of kind `tool` is a
// plugin on the daemon's PluginHost: its setup splices an adapted EngineTool
// into every live session's tool array (the same in-place pattern the MCP
// live tools use, so the engine sees it on its next turn) and registers an
// effect that splices it back out, so unmount is provably the inverse of
// mount. The tool itself runs in a worker under its capability manifest
// (forgedToolRunner); a call from the model goes through the ordinary
// adapted-tool gate like any belt tool. Mounted tools sit in the deferred
// tier — the prompt prefix does not change, ToolSearch finds them by name.

import { PluginHost, definePlugin } from "@ares/plugins";
import {
  adaptToolForEngine,
  buildTool,
  listExtensions,
  readExtension,
  recordExtensionFault,
  setExtensionMounted,
  runForgedTool,
  setExtensionHost,
  toolNameOf,
  type ExtensionManifest,
  type RichToolContext,
} from "@ares/tools";
import { z } from "zod";
import type { EngineTool, ToolCallContext } from "@ares/core";

type ForgedEngineTool = EngineTool & { __forged?: string };

export interface ForgedToolsOptions {
  host: PluginHost;
  workspace: string;
  home?: string;
  /** Every live session's belt, so a mount reaches them all. */
  belts: () => Iterable<EngineTool[]>;
  enrich: (base: ToolCallContext) => RichToolContext;
  /** Gated belt call for ares.call inside a module (surfaceFeeds.runGatedTool). */
  callTool?: (sessionId: string, tool: string, input: unknown) => Promise<unknown>;
  /** Append a deferred descriptor so ToolSearch can find the mounted tool. */
  catalog: { add: (name: string, description: string) => void; remove: (name: string) => void };
}

function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  // The forged module validates its own input; the belt only needs a
  // permissive object so the engine's shape stage passes model input through.
  const props = schema && typeof schema === "object" ? (schema as { properties?: Record<string, unknown> }).properties : undefined;
  return props ? z.object({}).passthrough() : z.record(z.unknown());
}

export class ForgedTools {
  private readonly current = new Map<string, ForgedEngineTool>();
  /** Belts handed over through attach(); teardown reaches them as well as
   *  the ones `belts()` enumerates, so no belt keeps a dead tool. */
  private readonly attached = new Set<EngineTool[]>();

  constructor(private readonly options: ForgedToolsOptions) {
    setExtensionHost({
      mount: (name) => this.mount(name),
      unmount: (name) => this.unmount(name),
      mounted: (name) => this.current.has(name),
      callTool: options.callTool,
    });
  }

  /** Kept tools remount at boot; trials wait for the owner's next session. */
  async remountKept(): Promise<void> {
    for (const manifest of await listExtensions(this.options.home)) {
      if (manifest.kind === "tool" && manifest.mounted) await this.mount(manifest.name).catch(() => undefined);
    }
  }

  /** A new session's belt joins every tool already mounted. */
  attach(belt: EngineTool[]): void {
    this.attached.add(belt);
    for (const tool of this.current.values()) if (!belt.includes(tool)) belt.push(tool);
  }

  private allBelts(): Set<EngineTool[]> {
    const set = new Set<EngineTool[]>(this.attached);
    for (const belt of this.options.belts()) set.add(belt);
    return set;
  }

  mounted(): string[] {
    return [...this.current.keys()];
  }

  async mount(name: string): Promise<{ mounted: boolean; error?: string }> {
    const record = await readExtension(name, this.options.home);
    if (!record || record.manifest.kind !== "tool") return { mounted: false, error: `no tool extension named "${name}"` };
    const engineTool = this.build(record.manifest, record.source);
    const plugin = definePlugin<{ tool: ForgedEngineTool }>({
      name: `tool:${name}`,
      setup: (ctx, config) => {
        this.current.set(name, config.tool);
        for (const belt of this.allBelts()) this.splice(belt, config.tool);
        this.options.catalog.add(config.tool.schema.name, config.tool.schema.description);
        // A swap runs the old plugin's teardown around the new one's setup;
        // each registration therefore removes only ITS tool instance, by
        // identity, so the newer revision is never torn down by the older.
        ctx.effect(() => {
          if (this.current.get(name) === config.tool) this.current.delete(name);
          for (const belt of this.allBelts()) this.remove(belt, config.tool);
          if (!this.current.has(name)) this.options.catalog.remove(config.tool.schema.name);
        });
      },
    });
    const status = this.current.has(name)
      ? await this.options.host.swap(plugin, { tool: engineTool })
      : await this.options.host.mount(plugin, { tool: engineTool });
    if (status.state !== "active") return { mounted: false, error: status.error ?? status.state };
    await setExtensionMounted(name, true, this.options.home);
    return { mounted: true };
  }

  async unmount(name: string): Promise<boolean> {
    if (!this.options.host.statusOf(`tool:${name}`)) return false;
    const done = await this.options.host.unmount(`tool:${name}`);
    if (done) await setExtensionMounted(name, false, this.options.home).catch(() => undefined);
    return done;
  }

  /** Put `tool` in the belt in place of any older instance of the same forged tool. */
  private splice(belt: EngineTool[], tool: ForgedEngineTool): void {
    for (let i = belt.length - 1; i >= 0; i--) {
      const row = belt[i] as ForgedEngineTool;
      if (row.__forged === tool.__forged && row !== tool) belt.splice(i, 1);
    }
    if (!belt.includes(tool)) belt.push(tool);
  }

  private remove(belt: EngineTool[], tool: ForgedEngineTool): void {
    for (let i = belt.length - 1; i >= 0; i--) if (belt[i] === tool) belt.splice(i, 1);
  }

  private build(manifest: ExtensionManifest, source: string): ForgedEngineTool {
    const caps = manifest.capabilities ?? { readRoots: [], writeRoots: [], hosts: [], tools: [] };
    const workspace = this.options.workspace;
    const callTool = this.options.callTool;
    const home = this.options.home;
    const tool = buildTool({
      name: toolNameOf(manifest),
      description: `${manifest.description} (forged by Ares; ${manifest.state}; may ${describe(caps)})`,
      safety: manifest.safety ?? "read-only",
      concurrency: "parallel-safe",
      inputZod: jsonSchemaToZod(manifest.inputSchema),
      watchdogTimeoutMs: 90_000,
      activityDescription: () => `Running forged tool ${manifest.title}`,
      async call(input, ctx) {
        const result = await runForgedTool({
          source,
          input,
          workspace,
          capabilities: caps,
          callTool: callTool ? (t, i) => callTool(ctx.sessionId, t, i) : undefined,
          timeoutMs: 60_000,
        });
        if (!result.ok) {
          await recordExtensionFault(manifest.name, result.error ?? "failed", home).catch(() => undefined);
          return { output: { error: result.error, logs: result.logs }, failure: result.error ?? "forged tool failed", display: `${manifest.title} failed: ${result.error}` };
        }
        return { output: result.output, display: `${manifest.title} ran in ${result.durationMs}ms` };
      },
    });
    // The belt carries the real JSON schema the model wrote, not the
    // permissive zod the shape stage uses.
    const engineTool = adaptToolForEngine(tool as never, this.options.enrich) as ForgedEngineTool;
    engineTool.__forged = manifest.name;
    if (manifest.inputSchema && typeof manifest.inputSchema === "object") {
      (engineTool.schema as { inputJsonSchema: unknown }).inputJsonSchema = manifest.inputSchema;
    }
    return engineTool;
  }
}

function describe(caps: { readRoots: string[]; writeRoots: string[]; hosts: string[]; tools: string[] }): string {
  const parts: string[] = [];
  if (caps.readRoots.length) parts.push(`read ${caps.readRoots.join(", ")}`);
  if (caps.writeRoots.length) parts.push(`write ${caps.writeRoots.join(", ")}`);
  if (caps.hosts.length) parts.push(`fetch ${caps.hosts.join(", ")}`);
  if (caps.tools.length) parts.push(`call ${caps.tools.join(", ")}`);
  return parts.length ? parts.join("; ") : "touch nothing outside its input";
}
