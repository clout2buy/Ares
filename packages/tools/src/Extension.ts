// Extension — forge, mount, try, keep (docs/CREATOR-MODE-DESIGN.md, Layer 2).
//
// Two kinds live here. A `skill` is a SKILL.md Ares writes into the skill
// catalog. A `tool` is a module Ares writes that joins this chat's belt as a
// trial: the daemon mounts it through the plugin kernel (reversible, same
// turn, deferred tier so the prompt cache survives) and runs it in a worker
// under the capability manifest the owner approved. Keep promotes a trial
// to kept (remounts at boot); unmount and rollback are what the kernel and
// the ledger make cheap. The other kinds the design names already have
// homes, and the tool says where instead of duplicating them.
//
// Mounting a tool with capabilities is an owner decision: the card shows the
// manifest (what it may read, write, fetch, call), derived from the source
// by a static scan, not from what the model claims.

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";
import { genuiGate } from "./genui.js";
import {
  type ExtensionManifest,
  type ToolCapabilities,
  keepExtension,
  listExtensionRevisions,
  listExtensions,
  readExtension,
  removeExtension,
  rollbackExtension,
  saveExtension,
} from "./extensionStore.js";
import { manifestProblems, runForgedTool, scanToolSource } from "./forgedToolRunner.js";
import { installHook, installSkillSource, uninstallHook } from "./extensionSkills.js";

const capabilitiesSchema = z
  .object({
    readRoots: z.array(z.string()).max(32).optional().describe("Workspace-relative folders the tool may read (ares.readFile/readDir)."),
    writeRoots: z.array(z.string()).max(32).optional().describe("Workspace-relative folders the tool may write (ares.writeFile)."),
    hosts: z.array(z.string()).max(32).optional().describe("Hosts the tool may fetch (ares.fetch)."),
    tools: z.array(z.string()).max(32).optional().describe("Belt tools the module may call with ares.call(name, input); each call is gated like one of yours."),
  })
  .strict();

const inputSchema = z
  .object({
    action: z.enum(["draft", "try", "mount", "keep", "unmount", "remove", "rollback", "list", "show"]).describe(
      "draft: write (or update) an extension's source into the ledger — a tool module or a SKILL.md — and get its scanned manifest back. try: run a tool draft once with an input, in its sandbox, without mounting. mount: put a tool into the belt, where it stays across restarts (asks the owner with the manifest) / install a skill into the catalog. keep: mark it to remount at boot. unmount: take it out of the belt (ledger kept). remove: delete. rollback: make an older revision current. list / show: the ledger.",
    ),
    name: z.string().optional().describe("Extension id: 2-41 lowercase letters/digits/hyphens, starting with a letter."),
    hook_event: z.enum(["SessionStart", "PreToolUse", "PostToolUse"]).optional().describe("hook: when it runs. A non-zero exit from a PreToolUse hook blocks that tool call."),
    matcher: z.string().max(200).optional().describe("hook: which calls, e.g. Bash(git *), Edit, or * for all."),
    kind: z.enum(["tool", "skill", "hook", "connector", "agent", "watcher"]).optional().describe("draft: tool (a belt tool), skill (a SKILL.md), hook (a Node script on the engine's tool events; JSON on stdin; runs with the owner's full authority, outside the sandbox). connector/agent/watcher are routed to the tools that own them (Connect/Mcp, Agents, Remind/Hooks/Track)."),
    title: z.string().max(120).optional(),
    description: z.string().max(1000).optional().describe("tool: the model-facing description the belt shows (what it does, when to use it). skill: the catalog description."),
    source: z.string().optional().describe("tool: JavaScript with `module.exports = { call(input, ares) {...} }`; no require/import/process — only the ares object (readFile, readDir, writeFile, fetch, call, log). skill: the SKILL.md text (frontmatter name/description, then the procedure)."),
    input_schema: z.record(z.unknown()).optional().describe("tool: JSON Schema of the input (object with properties)."),
    safety: z.enum(["read-only", "workspace-write", "external-state"]).optional().describe("tool: the permission class (read-only runs; others ask per the posture)."),
    capabilities: capabilitiesSchema.optional().describe("tool: what the module may reach. The scan of the source must fit inside it."),
    input: z.unknown().optional().describe("try: the input to run with."),
    revision: z.number().int().positive().optional().describe("rollback: target revision."),
    note: z.string().max(400).optional().describe("draft: what changed, one line."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface ExtensionOutput {
  message: string;
  name?: string;
  kind?: string;
  revision?: number;
  state?: string;
  manifest?: ToolCapabilities;
  scan?: Array<{ capability: string; evidence: string }>;
  problems?: string[];
  output?: unknown;
  logs?: string[];
  durationMs?: number;
  extensions?: Array<Pick<ExtensionManifest, "name" | "kind" | "title" | "revision" | "state">>;
  revisions?: Array<{ revision: number; at: number; note?: string }>;
  source?: string;
  faults?: string[];
}

/** The host's hooks: mounting into the belt and gated calls are the
 * daemon's (forgedTools.ts); a CLI without them can still draft and try. */
export interface ExtensionHost {
  mount: (name: string) => Promise<{ mounted: boolean; error?: string }>;
  unmount: (name: string) => Promise<boolean>;
  mounted: (name: string) => boolean;
  callTool?: (sessionId: string, tool: string, input: unknown) => Promise<unknown>;
}

let host: ExtensionHost | null = null;
export function extensionHost(): ExtensionHost | null {
  return host;
}
export function setExtensionHost(next: ExtensionHost | null): void {
  host = next;
}

function cleanCaps(raw: Input["capabilities"]): ToolCapabilities {
  return { readRoots: raw?.readRoots ?? [], writeRoots: raw?.writeRoots ?? [], hosts: raw?.hosts ?? [], tools: raw?.tools ?? [] };
}

function describeCaps(caps: ToolCapabilities): string {
  const parts: string[] = [];
  if (caps.readRoots.length) parts.push(`read ${caps.readRoots.join(", ")}`);
  if (caps.writeRoots.length) parts.push(`write ${caps.writeRoots.join(", ")}`);
  if (caps.hosts.length) parts.push(`fetch from ${caps.hosts.join(", ")}`);
  if (caps.tools.length) parts.push(`call ${caps.tools.join(", ")} (each call gated)`);
  return parts.length ? parts.join("; ") : "nothing outside its own input and output";
}

const ROUTED: Record<string, string> = {
  connector: "Connectors already have a home: use Connect (service sign-in), Mcp (an MCP server) or Api (any OpenAPI spec). They mount live tools into this chat the same way a forged tool does.",
  agent: "Agents already have a home: use the Agents tool to create one with its own persona, brain, effort and tool allow-list; it appears in the sidebar at once.",
  watcher: "Watchers already have homes: Remind (a time or cron), Hooks (an inbound webhook that starts a turn) and Track (a condition on data). Pick the trigger and use that tool.",
};

export const ExtensionTool = buildTool<typeof inputSchema, ExtensionOutput>({
  name: "Extension",
  description:
    "Forge a new capability for Ares and use it in the same turn. kind tool: write a small JavaScript module (module.exports = { call(input, ares) }) with a JSON input schema and a capability manifest (readRoots, writeRoots, hosts, tools); draft it, try it on real input, then mount it — it joins the belt and stays across restarts (deferred tier; call ToolSearch select:<Name> once mounted). kind skill: write a SKILL.md and mount it into the skill catalog. "
    + "Inside a tool module there is no require, import or process: only the frozen ares object — ares.readFile(path), ares.readDir(path), ares.writeFile(path, text) within the manifest's roots, ares.fetch(url, init) to the manifest's hosts (returns {status, ok, text, json()}), ares.call(tool, input) for the manifest's tools (gated like your own calls), ares.log(...). "
    + "Mounting a tool with any capability asks the owner once, with the scanned manifest. Unmount or remove undoes it; rollback restores any revision. Use Introspect first to check a tool does not already exist.",
  safety: "read-only",
  ownerDecisions: true,
  concurrency: "exclusive",
  inputZod: inputSchema,
  validateInput: async (input) => genuiGate(input.action !== "list" && input.action !== "show"),
  watchdogTimeoutMs: 90_000,
  maxResultSizeChars: 60_000,
  activityDescription: (i) => `${i.action[0].toUpperCase()}${i.action.slice(1)}ing extension${i.name ? ` ${i.name}` : ""}`,
  async checkPermissions(input, ctx) {
    if (ctx.permissionMode === "plan" && input.action !== "list" && input.action !== "show") return { kind: "deny", reason: "Extensions can only be read in plan mode." };
    if (input.action !== "mount" || !input.name) return { kind: "allow" };
    const record = await readExtension(input.name);
    if (!record) return { kind: "allow" }; // call() reports the missing name
    if (record.manifest.kind === "hook") {
      return { kind: "ask", prompt: `Install the hook "${record.manifest.title}" on ${record.manifest.hookEvent} (${record.manifest.matcher ?? "all tools"})? It runs as a program with your full permissions, not in the sandbox, in every new chat. ${record.manifest.description}`, suggestion: "allow_once", ownerDecision: true };
    }
    if (record.manifest.kind === "skill") {
      return { kind: "ask", prompt: `Install the skill "${record.manifest.title}" into Ares's skill catalog? ${record.manifest.description}`, suggestion: "allow_once", ownerDecision: true };
    }
    const caps = record.manifest.capabilities ?? { readRoots: [], writeRoots: [], hosts: [], tools: [] };
    // A tool that can reach nothing is safe by construction; it just mounts.
    if (!caps.readRoots.length && !caps.writeRoots.length && !caps.hosts.length && !caps.tools.length && (record.manifest.safety ?? "read-only") === "read-only") return { kind: "allow" };
    return {
      kind: "ask",
      prompt: `Mount the tool "${record.manifest.title}" into Ares? ${caps.readRoots.length || caps.writeRoots.length || caps.hosts.length || caps.tools.length ? `It may ${describeCaps(caps)}.` : "It touches nothing outside its own input and output."} Permission class: ${record.manifest.safety ?? "read-only"}. It runs in a worker with only those capabilities; Unmount removes it with no residue.`,
      suggestion: "allow_once",
      ownerDecision: true,
    };
  },
  async call(input: Input, ctx): Promise<ToolResult<ExtensionOutput>> {
    try {
      switch (input.action) {
        case "list": {
          const extensions = (await listExtensions()).map((m) => ({ name: m.name, kind: m.kind, title: m.title, revision: m.revision, state: m.state, mounted: host?.mounted(m.name) ?? false }));
          return okResult({ extensions, message: extensions.length ? extensions.map((e) => `${e.name} (${e.kind}, r${e.revision}, ${e.state}${e.mounted ? ", mounted" : ""}) — ${e.title}`).join("\n") : "No extensions yet." });
        }
        case "show": {
          if (!input.name) return failResult<ExtensionOutput>("show needs name.");
          const record = await readExtension(input.name);
          if (!record) return failResult<ExtensionOutput>(`No extension named "${input.name}".`);
          const revisions = await listExtensionRevisions(input.name);
          return okResult({
            name: record.manifest.name, kind: record.manifest.kind, revision: record.manifest.revision, state: record.manifest.state,
            manifest: record.manifest.capabilities, revisions: revisions.slice(-10), source: record.source.slice(0, 40_000),
            ...(record.manifest.faults?.length ? { faults: record.manifest.faults } : {}),
            message: `${record.manifest.name} (${record.manifest.kind}) is at revision ${record.manifest.revision}, ${record.manifest.state}${host?.mounted(record.manifest.name) ? ", mounted" : ""}.${record.manifest.faults?.length ? ` Recent faults: ${record.manifest.faults.join(" | ")}` : ""}`,
          });
        }
        case "draft": {
          if (!input.name) return failResult<ExtensionOutput>("draft needs name.");
          const kind = input.kind ?? "tool";
          if (kind in ROUTED) return failResult<ExtensionOutput>(ROUTED[kind]);
          if (typeof input.source !== "string" || !input.source.trim()) return failResult<ExtensionOutput>("draft needs source.");
          if (kind === "hook") {
            const record = await saveExtension({ name: input.name, kind: "hook", title: input.title ?? input.name, description: input.description ?? "", source: input.source, hookEvent: input.hook_event ?? "PreToolUse", matcher: input.matcher, sessionId: ctx.sessionId, note: input.note }, undefined);
            return okResult({ name: record.manifest.name, kind: "hook", revision: record.manifest.revision, state: record.manifest.state, message: `Hook "${record.manifest.name}" drafted at revision ${record.manifest.revision}. Mount it to install it; it applies to new chats.` });
          }
          if (kind === "skill") {
            const record = await saveExtension({ name: input.name, kind: "skill", title: input.title ?? input.name, description: input.description ?? "", source: input.source, sessionId: ctx.sessionId, note: input.note }, undefined);
            return okResult({ name: record.manifest.name, kind: "skill", revision: record.manifest.revision, state: record.manifest.state, message: `Skill "${record.manifest.name}" drafted at revision ${record.manifest.revision}. Mount it to install it into the catalog.` });
          }
          const caps = cleanCaps(input.capabilities);
          const scan = scanToolSource(input.source);
          const problems = manifestProblems(input.source, caps);
          if (!input.input_schema) return failResult<ExtensionOutput>("a tool draft needs input_schema (JSON Schema object).");
          if (!input.description) return failResult<ExtensionOutput>("a tool draft needs description (what the belt shows).");
          if (problems.length) return failResult<ExtensionOutput>(`The source wants more than the manifest grants: ${problems.join("; ")}`, { scan, problems } as Partial<ExtensionOutput>);
          const record = await saveExtension({ name: input.name, kind: "tool", title: input.title ?? input.name, description: input.description, source: input.source, capabilities: caps, inputSchema: input.input_schema, safety: input.safety ?? "read-only", sessionId: ctx.sessionId, note: input.note }, undefined);
          const wasMounted = host?.mounted(input.name) ?? false;
          if (wasMounted && host) await host.mount(input.name).catch(() => undefined); // a mounted tool picks up its new revision
          return okResult({ name: record.manifest.name, kind: "tool", revision: record.manifest.revision, state: record.manifest.state, manifest: caps, scan, message: `Tool "${record.manifest.name}" drafted at revision ${record.manifest.revision}. Manifest: ${describeCaps(caps)}. Try it with try, then mount it${wasMounted ? " (already mounted: the belt now runs this revision)" : ""}.` });
        }
        case "try": {
          if (!input.name) return failResult<ExtensionOutput>("try needs name.");
          const record = await readExtension(input.name);
          if (!record) return failResult<ExtensionOutput>(`No extension named "${input.name}".`);
          if (record.manifest.kind !== "tool") return failResult<ExtensionOutput>("Only tools can be tried.");
          const result = await runForgedTool({
            source: record.source,
            input: input.input ?? {},
            workspace: ctx.workspace,
            capabilities: record.manifest.capabilities ?? { readRoots: [], writeRoots: [], hosts: [], tools: [] },
            callTool: host?.callTool ? (tool, callInput) => host!.callTool!(ctx.sessionId, tool, callInput) : undefined,
            timeoutMs: 60_000,
          });
          return result.ok
            ? okResult({ name: input.name, output: result.output, logs: result.logs, durationMs: result.durationMs, message: `Ran in ${result.durationMs}ms.${result.logs.length ? ` Logs: ${result.logs.join(" | ").slice(0, 600)}` : ""}` }, `${input.name} ran`)
            : failResult<ExtensionOutput>(`The tool failed: ${result.error}${result.logs.length ? ` Logs: ${result.logs.join(" | ").slice(0, 600)}` : ""}`, { logs: result.logs, durationMs: result.durationMs } as Partial<ExtensionOutput>);
        }
        case "mount": {
          if (!input.name) return failResult<ExtensionOutput>("mount needs name.");
          const record = await readExtension(input.name);
          if (!record) return failResult<ExtensionOutput>(`No extension named "${input.name}".`);
          if (record.manifest.kind === "hook") {
            const where = await installHook(record.manifest.name, record.source, record.manifest.hookEvent ?? "PreToolUse", record.manifest.matcher);
            return okResult({ name: input.name, kind: "hook", message: `Hook "${record.manifest.name}" is installed at ${where}. It runs in chats started from now on.` });
          }
          if (record.manifest.kind === "skill") {
            const where = await installSkillSource(record.manifest.name, record.source);
            return okResult({ name: input.name, kind: "skill", message: `Skill "${record.manifest.name}" installed at ${where}. SkillsList shows it from the next call.` });
          }
          if (!host) return failResult<ExtensionOutput>("This host cannot mount tools into a belt (no daemon).");
          const mounted = await host.mount(input.name);
          if (!mounted.mounted) return failResult<ExtensionOutput>(`Could not mount "${input.name}": ${mounted.error ?? "unknown"}`);
          return okResult({ name: input.name, kind: "tool", state: record.manifest.state, message: `"${record.manifest.title}" is in the belt and stays across restarts. Load it with ToolSearch select:${toolNameOf(record.manifest)} and call it like any tool. Unmount removes it.` });
        }
        case "unmount": {
          if (!input.name) return failResult<ExtensionOutput>("unmount needs name.");
          if (await uninstallHook(input.name)) return okResult({ name: input.name, message: `Hook "${input.name}" is uninstalled for new chats; the ledger still holds it.` });
          if (!host) return failResult<ExtensionOutput>("This host has no belt to unmount from.");
          const done = await host.unmount(input.name);
          return done ? okResult({ name: input.name, message: `"${input.name}" is out of the belt; the ledger still holds it.` }) : failResult<ExtensionOutput>(`"${input.name}" was not mounted.`);
        }
        case "keep": {
          if (!input.name) return failResult<ExtensionOutput>("keep needs name.");
          const manifest = await keepExtension(input.name);
          return okResult({ name: manifest.name, state: manifest.state, message: `"${manifest.name}" is kept: it remounts at boot.` });
        }
        case "remove": {
          if (!input.name) return failResult<ExtensionOutput>("remove needs name.");
          if (host?.mounted(input.name)) await host.unmount(input.name);
          await uninstallHook(input.name);
          const removed = await removeExtension(input.name);
          return removed ? okResult({ name: input.name, message: `Removed "${input.name}".` }) : failResult<ExtensionOutput>(`No extension named "${input.name}".`);
        }
        case "rollback": {
          if (!input.name || typeof input.revision !== "number") return failResult<ExtensionOutput>("rollback needs name and revision.");
          const record = await rollbackExtension(input.name, input.revision);
          if (host?.mounted(input.name)) await host.mount(input.name).catch(() => undefined);
          return okResult({ name: record.manifest.name, revision: record.manifest.revision, message: `"${record.manifest.name}" now carries revision ${input.revision}'s source as revision ${record.manifest.revision}.` });
        }
      }
    } catch (err) {
      return failResult<ExtensionOutput>(err instanceof Error ? err.message : String(err));
    }
  },
});

/** The belt name of a forged tool: PascalCase of its id, prefixed so a
 * forged tool can never shadow a built-in one. */
export function toolNameOf(manifest: Pick<ExtensionManifest, "name">): string {
  return "Forged" + manifest.name.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}
