// Self — the agent's hands on its own self-model.
//
// SelfEvolve rewrites the prose mind (IDENTITY/SOUL/USER). Self operates on the
// structured capability graph: read what you are and how reliably you perform
// (status), get concrete self-improvement directives (reflect), declare a
// capability you want but don't have yet (want), or retire one (drop). This is
// how Crix answers "what am I good at, what do I keep failing, what should I
// become next" with data instead of vibes.

import { z } from "zod";
import { buildTool } from "@crix/tools";
import { crixAgentHome } from "../paths.js";
import { emitLifecycle } from "../lifecycle/bus.js";
import { gainForTarget } from "../voice.js";
import {
  dropCapability,
  loadSelfModel,
  summarizeSelf,
  upsertCapability,
} from "../self/store.js";
import { reflect, type SelfDirective } from "../self/reflect.js";
import type { Capability, CapabilityKind, SelfSummary } from "../self/types.js";

const ACTIONS = ["status", "reflect", "want", "drop"] as const;
const KINDS = ["skill", "tool", "package", "mission"] as const;

const inputSchema = z
  .object({
    action: z
      .enum(ACTIONS)
      .describe(
        "status: summarize what you are (capabilities, reliability, flaky/top). reflect: get concrete self-improvement directives grounded in your outcome history. want: declare a capability you need but don't have yet (so reflect will tell you to acquire it). drop: retire a capability node.",
      ),
    name: z.string().optional().describe("Capability name. Required for 'want'."),
    kind: z.enum(KINDS).optional().describe("Capability kind for 'want' (default skill)."),
    description: z.string().optional().describe("What this capability is / why you want it. For 'want'."),
    id: z.string().optional().describe("Capability id (e.g. skill/foo). Required for 'drop'."),
  })
  .strict();

export interface SelfToolOutput {
  action: string;
  summary?: SelfSummary;
  capabilities?: Array<Pick<Capability, "id" | "name" | "kind" | "status"> & { runs: number; reliability: number | null }>;
  directives?: SelfDirective[];
  capability?: Capability;
  dropped?: boolean;
}

export const SelfTool = buildTool({
  name: "Self",
  description:
    "Inspect and steer your own machine-readable self-model. status = what you are + how reliably you perform; reflect = outcome-grounded directives for what to fix, acquire, or prune; want = flag a capability gap to close; drop = retire a capability. Self-territory under ~/.crix/self/ — no permission ritual. Read your status at the start of a session and reflect when idle.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `Self ${i.action}${i.name ? ` ${i.name}` : ""}`,

  async call(input): Promise<{ output: SelfToolOutput; display: string }> {
    const home = crixAgentHome(process.env.CRIX_HOME);
    const model = await loadSelfModel(home);

    switch (input.action) {
      case "status": {
        const summary = summarizeSelf(model);
        const capabilities = Object.values(model.capabilities)
          .filter((c) => c.status !== "removed")
          .map((c) => ({
            id: c.id,
            name: c.name,
            kind: c.kind,
            status: c.status,
            runs: c.outcomes.runs,
            reliability: c.outcomes.ok + c.outcomes.fail === 0 ? null : c.outcomes.ok / (c.outcomes.ok + c.outcomes.fail),
          }))
          .sort((a, b) => b.runs - a.runs);
        const relPct = summary.reliability === null ? "n/a" : `${Math.round(summary.reliability * 100)}%`;
        return {
          output: { action: "status", summary, capabilities },
          display: `self: ${summary.total} cap (${summary.skills} skill), ${summary.totalRuns} runs, ${relPct} reliable`,
        };
      }

      case "reflect": {
        const directives = reflect(model);
        emitLifecycle({
          type: "self_reflected",
          directives: directives.length,
          topKind: directives[0]?.kind,
          gain: directives.length > 0 ? gainForTarget("SELF", directives.length, "reflected") : undefined,
        });
        return {
          output: { action: "reflect", directives },
          display: directives.length === 0 ? "reflect: nothing to act on — self looks healthy" : `reflect: ${directives.length} directive(s), top=${directives[0].kind} ${directives[0].capabilityName}`,
        };
      }

      case "want": {
        if (!input.name || !input.name.trim()) throw new Error("Self.want requires a name");
        const kind: CapabilityKind = input.kind ?? "skill";
        const id = input.id ?? `${kind}/${slug(input.name)}`;
        const capability = await upsertCapability(home, {
          id,
          kind,
          name: input.name,
          status: "want",
          description: input.description,
          provenance: "self.want",
        });
        return {
          output: { action: "want", capability },
          display: `+1 CAPABILITY — want ${input.name} [${id}]`,
        };
      }

      case "drop": {
        if (!input.id) throw new Error("Self.drop requires an id (e.g. skill/foo)");
        const dropped = await dropCapability(home, input.id);
        return {
          output: { action: "drop", dropped },
          display: dropped ? `dropped ${input.id}` : `no capability ${input.id}`,
        };
      }

      default:
        throw new Error(`Self: unsupported action ${String(input.action)}`);
    }
  },
});

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}
