// Instances — deploy and run separate copies of Ares on this Linux host.
// The logic lives in aresInstances.ts (shared with `ares instance …`).

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";
import { Instances, type InstanceMeta, type InstanceStatus } from "./aresInstances.js";

const READ_ACTIONS: ReadonlySet<string> = new Set(["list", "status", "logs"]);

const inputSchema = z
  .object({
    action: z
      .enum(["list", "status", "create", "start", "stop", "restart", "update", "logs", "pair_link", "remove"])
      .describe(
        "list / status / logs: read. create: deploy a new instance. start / stop / restart: control one. " +
          "update: rebuild the image from this checkout and restart (name, or all when name is omitted). " +
          "pair_link: the ares://pair link the owner opens on the phone (contains the instance token; asks first). remove: uninstall (asks).",
      ),
    name: z.string().optional().describe("Instance name: 2-30 lowercase letters, digits, dashes."),
    purpose: z.string().max(600).optional().describe("create: what this instance is for; written into its identity."),
    provider: z.string().optional().describe("create: model provider (default anthropic)."),
    model: z.string().optional().describe("create: model id (default claude-opus-5-5)."),
    public_url: z.boolean().optional().describe("create: give it the fixed https://<name>-ares.<domain> address on the owner's tunnel (default true when a domain is configured). false: no fixed address; the instance falls back to its own temporary trycloudflare URL, so the phone link changes on restart."),
    guarded: z.boolean().optional().describe("create: keep permission prompts on inside the instance (default false: free mode inside its sandbox)."),
    memory: z.string().optional().describe("create: container memory cap, e.g. 4g."),
    cpus: z.string().optional().describe("create: CPU cap, e.g. 2."),
    lines: z.number().int().min(1).max(500).optional().describe("logs: how many lines."),
    purge: z.boolean().optional().describe("remove: also delete the instance's home (memory, vault). Irreversible; the owner must approve."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface InstancesOutput {
  message: string;
  instances?: InstanceMeta[];
  instance?: InstanceStatus;
  logs?: string;
  link?: string;
}

function describe(s: InstanceStatus): string {
  return `${s.name}: ${s.active}${s.healthy ? ", healthy" : ", not answering"} · ${s.provider}/${s.model}${s.url ? ` · ${s.url}` : ` · localhost:${s.httpPort}`}`;
}

function needName(input: Input): string {
  if (!input.name) throw new Error(`${input.action} needs name`);
  return input.name;
}

export const InstancesTool = buildTool<typeof inputSchema, InstancesOutput>({
  name: "Instances",
  description:
    "Deploy and manage separate Ares instances on this Linux host (Docker + systemd). Each instance is its own entity: its own container, identity, memory, vault and gateway token — nothing of yours is copied in. " +
    "It signs in to its model on its own: after create, give the owner the pair_link so they add it on the phone, where Anthropic sign-in finishes. " +
    "Instances cannot spawn instances. Use update after changing and building this checkout to roll the new code out to them.",
  safety: "external-state",
  dynamicSafety: (input) => (READ_ACTIONS.has(input.action) ? "read-only" : input.action === "remove" ? "destructive" : "external-state"),
  concurrency: "exclusive",
  watchdogTimeoutMs: 1_800_000,
  inputZod: inputSchema,
  activityDescription: (input) => (input.action === "list" ? "Listing Ares instances" : `Instance ${input.action.replace("_", " ")} ${input.name ?? ""}`.trim()),
  async checkPermissions(input, ctx) {
    if (READ_ACTIONS.has(input.action)) return { kind: "allow" };
    if (ctx.permissionMode === "plan") return { kind: "deny", reason: "Instances can only be read in plan mode." };
    if (input.action === "remove" && input.purge) {
      return { kind: "ask", prompt: `Delete instance ${input.name} AND its home (memory, vault, sessions)? This cannot be undone.`, suggestion: "deny", ownerDecision: true };
    }
    if (input.action === "remove") return { kind: "ask", prompt: `Uninstall instance ${input.name}? Its home is kept.`, suggestion: "allow_once" };
    if (input.action === "pair_link") return { kind: "ask", prompt: `Show ${input.name}'s pairing link (it contains that instance's access token) in this chat?`, suggestion: "allow_once" };
    return { kind: "allow" };
  },
  async call(input, ctx): Promise<ToolResult<InstancesOutput>> {
    const box = new Instances();
    try {
      switch (input.action) {
        case "list": {
          const instances = await box.list();
          if (!instances.length) return okResult({ instances, message: "No instances yet." });
          const rows = await Promise.all(instances.map((m) => box.status(m.name)));
          return okResult({ instances, message: rows.map(describe).join("\n") }, `${rows.length} instances`);
        }
        case "status": {
          const instance = await box.status(needName(input));
          return okResult({ instance, message: describe(instance) });
        }
        case "create": {
          const instance = await box.create({
            name: needName(input),
            purpose: input.purpose,
            provider: input.provider,
            model: input.model,
            publicUrl: input.public_url,
            guarded: input.guarded,
            limits: { ...(input.memory ? { memory: input.memory } : {}), ...(input.cpus ? { cpus: input.cpus } : {}) },
            signal: ctx.signal,
          });
          const next = instance.healthy
            ? `Next: pair_link so the owner can add ${instance.name} on the phone and sign it in.`
            : `It has not answered yet — check logs.`;
          return okResult({ instance, message: `Deployed. ${describe(instance)}\n${next}` }, `Deployed ${instance.name}`);
        }
        case "start":
        case "stop":
        case "restart": {
          const instance = await box.systemctl(input.action, needName(input));
          return okResult({ instance, message: describe(instance) });
        }
        case "update": {
          const { image, restarted } = await box.update(input.name ? [input.name] : "all", ctx.signal);
          return okResult({ message: `Built ${image}. ${restarted.length ? restarted.map(describe).join("\n") : "No instances to restart."}` }, `Updated to ${image}`);
        }
        case "logs": {
          const logs = await box.logs(needName(input), input.lines);
          return okResult({ logs, message: logs.slice(-4000) || "(no log lines)" }, `${input.name} logs`);
        }
        case "pair_link": {
          const { link, tokenPath } = await box.pair(needName(input));
          if (!link) return failResult<InstancesOutput>(`${input.name} has no public URL; the phone can't reach it. Its token is at ${tokenPath}.`);
          return okResult({ link, message: `Open on the phone (Instances → ＋ or scan): ${link}` }, `Pair link for ${input.name}`);
        }
        case "remove":
          return okResult({ message: await box.remove(needName(input), input.purge ?? false) });
      }
    } catch (err) {
      return failResult<InstancesOutput>(err instanceof Error ? err.message : String(err));
    }
  },
});
