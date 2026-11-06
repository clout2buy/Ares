// Introspect — the runtime, readable by the model (docs/CREATOR-MODE-DESIGN.md).
//
// dsh's Creator mode ships two read-only inspection tools; this is Ares's
// one: what tools this chat can call and what each costs in the prompt, the
// plugin kernel's roster, the surfaces and their feeds, the skills, the
// connectors, and the friction telemetry — the view that turns Creator from
// "build what I'm told" into "notice what should exist". Read-only by
// construction; nothing here can change the runtime.

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";
import { listSurfaces } from "./surfaceStore.js";
import { listExtensions } from "./extensionStore.js";
import { readShellLayout, shellGo } from "./Shell.js";
import { scanSkills } from "./Skills.js";
import { lookAtUi } from "./uiLook.js";

const inputSchema = z
  .object({
    action: z.enum(["look", "tour", "at", "colors", "ui", "styles", "tools", "tool", "plugins", "surfaces", "skills", "connectors", "friction"]).describe(
      "colors: every CSS rule in the app that paints a light background (or dark, with find), including menus, popovers, dialogs and cards that are not on screen, which a screenshot can never show you; run it before calling a whole-app look done. look: a real screenshot of the app window right now, plus where every surface landed and what is wrong with it; use it whenever you want to see. tour: goes through every screen and returns a screenshot of each in one call, for checking a change across the whole app. at: names every layer painting the pixel x,y of the screenshot, pseudo-elements included, with the app's CSS rules behind each; use it the moment a colour will not change. styles: the computed background, colour and border of everything visible, and the live theme tokens; read it before restyling and again to check. ui: every class, id and labelled control on the owner's screen right now, for Surface at:<position>:<selector> and Shell css (open the screen first if it is not listed). tools: every tool this chat can call, with tier (core/deferred/mcp), safety, and prompt cost in characters. tool: one tool's full description and input schema. plugins: the daemon's plugin kernel roster (state, what each waits on, failures). surfaces: the surface ledger with feeds, actions and state. skills: every skill and where it lives. connectors: live MCP/OpenAPI tools by server. friction: recent friction telemetry (repeated manual sequences, failing tools, slow tools).",
    ),
    name: z.string().optional().describe("tool: the tool name."),
    find: z.enum(["light", "dark"]).optional().describe("colors: which backgrounds to list (default light)."),
    x: z.number().optional().describe("at: pixel x in the screenshot."),
    y: z.number().optional().describe("at: pixel y in the screenshot."),
    limit: z.number().int().min(1).max(200).optional().describe("How many rows (default 60)."),
  })
  .strict();

export interface IntrospectToolRow {
  name: string;
  tier: "core" | "deferred" | "mcp";
  safety: string;
  concurrency: string;
  promptChars: number;
  loaded?: boolean;
}

export interface IntrospectOutput {
  message: string;
  tools?: IntrospectToolRow[];
  tool?: { name: string; description: string; inputSchema: unknown; safety: string; concurrency: string; promptChars: number };
  plugins?: unknown[];
  recentMaintenance?: unknown[];
  surfaces?: unknown[];
  skills?: unknown[];
  connectors?: Array<{ server: string; tools: string[] }>;
  friction?: unknown[];
  ui?: string[];
  styles?: unknown;
  vars?: unknown;
  state?: string;
  totals?: Record<string, number>;
}

/** What the host hands the tool: the belt and the daemon-level roster. Each
 * is a getter so the tool reads live state at call time, never a snapshot. */
export interface IntrospectContext {
  tools: () => ReadonlyArray<{ schema: { name: string; description: string; inputJsonSchema: unknown; safety: string; concurrency: string } }>;
  isCore: (name: string) => boolean;
  plugins?: () => { plugins: unknown[]; recentMaintenance: unknown[] };
  friction?: (limit: number) => Promise<unknown[]> | unknown[];
}

function promptChars(schema: { name: string; description: string; inputJsonSchema: unknown }): number {
  try {
    return schema.name.length + schema.description.length + JSON.stringify(schema.inputJsonSchema).length;
  } catch {
    return schema.name.length + schema.description.length;
  }
}

let uiMap: string[] = [];
let uiDetail: { styles?: unknown; vars?: unknown; state?: string } = {};
/** The desktop reports what is on screen; the model reads it here. */
export function setUiMap(map: string[], detail?: { styles?: unknown; vars?: unknown; state?: string }): void {
  uiMap = map.slice(0, 800);
  if (detail) uiDetail = detail;
}

/** Everything Ares has made and what is showing, for the top of every GenUI
 * turn, so "that overlay" or "the panel from earlier" needs no searching. */
export async function genuiNow(): Promise<string> {
  const surfaces = await listSurfaces().catch(() => []);
  const extensions = await listExtensions().catch(() => []);
  const layout = await readShellLayout().catch(() => null);
  const parts = [`On screen: ${uiDetail.state ?? "unknown"}.`];
  parts.push(surfaces.length ? `Surfaces that exist: ${surfaces.map((s) => `${s.name} "${s.title}" (${s.placement}, r${s.revision})`).join("; ")}.` : "No surfaces exist.");
  if (extensions.length) parts.push(`Forged: ${extensions.map((e) => `${e.name} (${e.kind}${e.mounted ? ", mounted" : ""})`).join("; ")}.`);
  if (layout?.revision) parts.push(`Shell layout r${layout.revision}: ${layout.css.length} chars of css, ${Object.keys(layout.vars).length} tokens, hides ${layout.hide.join(", ") || "nothing"}, nav ${layout.nav.map((n) => n.id).join(", ") || "default"}${layout.script ? ", has a page script" : ""}.`);
  return parts.join(" ");
}

/** Every screen of the app, for checking a change across all of it. */
const TOUR = ["chat", "now", "feed", "made", "devices", "settings", "forge"];

export const IntrospectTool = buildTool<typeof inputSchema, IntrospectOutput>({
  name: "Introspect",
  description:
    "Read Ares's own runtime: the tools in this chat and what each costs in the prompt, one tool's full schema, the plugin kernel roster, the surface ledger, skills, live connectors, and friction telemetry. Use it before building an extension (is there already a tool for this? what does it cost?), when the owner asks what Ares can do or why something is slow, and to find what should exist (friction). Read-only.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  watchdogTimeoutMs: 60_000,
  maxResultSizeChars: 60_000,
  activityDescription: (i) => `Introspecting ${i.action}${i.name ? ` ${i.name}` : ""}`,
  async call(input, ctx): Promise<ToolResult<IntrospectOutput>> {
    const host = ctx.introspect;
    const limit = input.limit ?? 60;
    try {
      switch (input.action) {
        case "look": {
          const look = await lookAtUi();
          if (!look) return okResult({ message: "No desktop is attached, so there is nothing to see." });
          return { ...okResult({ message: look.report }), ...(look.images.length ? { images: look.images } : {}) };
        }
        case "tour": {
          const images: Array<{ mediaType: string; data: string }> = [];
          const seen: string[] = [];
          for (const target of TOUR) {
            shellGo.emit("go", target);
            await new Promise((resolve) => setTimeout(resolve, 800));
            const look = await lookAtUi();
            if (!look) return okResult({ message: "No desktop is attached, so there is nothing to see." });
            const shot = look.images[0];
            if (shot) { images.push(shot); seen.push(`Image ${images.length}: ${target}.`); }
          }
          shellGo.emit("go", "settings:close");
          shellGo.emit("go", "forge:close");
          shellGo.emit("go", "chat");
          return { ...okResult({ message: seen.length ? `${seen.join(" ")} Back on chat. Judge every image now: screenshots drop out of your context after a few steps.` : "No screenshots are available here." }), ...(images.length ? { images } : {}) };
        }
        case "colors": {
          const look = await lookAtUi(undefined, 7_000, { scan: input.find ?? "light" });
          return okResult({ message: look?.report ?? "No desktop is attached, so there is nothing to see." });
        }
        case "at": {
          if (typeof input.x !== "number" || typeof input.y !== "number") return failResult<IntrospectOutput>("at needs x and y.");
          const look = await lookAtUi(undefined, 7_000, { probe: { x: input.x, y: input.y } });
          return okResult({ message: look?.report ?? "No desktop is attached, so there is nothing to see." });
        }
        case "styles": {
          return okResult({ styles: uiDetail.styles ?? [], vars: uiDetail.vars ?? {}, state: uiDetail.state, message: uiDetail.styles ? `Computed styles for what is on screen: ${uiDetail.state ?? ""}` : "No desktop has reported its screen." });
        }
        case "ui": {
          return okResult({ ui: uiMap, message: uiMap.length ? `${uiMap.length} selectors on screen.` : "No desktop has reported its screen." });
        }
        case "tools": {
          if (!host) return failResult<IntrospectOutput>("This host does not expose its belt to Introspect.");
          const loaded = new Set(ctx.deferredTools?.loaded() ?? []);
          const rows: IntrospectToolRow[] = host.tools().map((t) => {
            const name = t.schema.name;
            const tier: IntrospectToolRow["tier"] = name.startsWith("mcp_") ? "mcp" : host.isCore(name) ? "core" : "deferred";
            return { name, tier, safety: t.schema.safety, concurrency: t.schema.concurrency, promptChars: promptChars(t.schema), ...(tier === "deferred" ? { loaded: loaded.has(name) } : {}) };
          });
          const totals = {
            tools: rows.length,
            core: rows.filter((r) => r.tier === "core").length,
            deferred: rows.filter((r) => r.tier === "deferred").length,
            mcp: rows.filter((r) => r.tier === "mcp").length,
            corePromptChars: rows.filter((r) => r.tier === "core").reduce((n, r) => n + r.promptChars, 0),
            loadedPromptChars: rows.filter((r) => r.loaded).reduce((n, r) => n + r.promptChars, 0),
          };
          const sorted = [...rows].sort((a, b) => (a.tier === b.tier ? b.promptChars - a.promptChars : a.tier.localeCompare(b.tier))).slice(0, limit);
          return okResult({ tools: sorted, totals, message: `${totals.tools} tools: ${totals.core} core (${totals.corePromptChars.toLocaleString()} prompt chars every turn), ${totals.deferred} deferred (${totals.loadedPromptChars.toLocaleString()} chars loaded this session), ${totals.mcp} from connectors.` });
        }
        case "tool": {
          if (!host) return failResult<IntrospectOutput>("This host does not expose its belt to Introspect.");
          if (!input.name) return failResult<IntrospectOutput>("tool needs name.");
          const hit = host.tools().find((t) => t.schema.name === input.name) ?? host.tools().find((t) => t.schema.name.toLowerCase() === input.name!.toLowerCase());
          if (!hit) return failResult<IntrospectOutput>(`No tool named "${input.name}" in this chat.`);
          return okResult({
            tool: { name: hit.schema.name, description: hit.schema.description, inputSchema: hit.schema.inputJsonSchema, safety: hit.schema.safety, concurrency: hit.schema.concurrency, promptChars: promptChars(hit.schema) },
            message: `${hit.schema.name}: ${hit.schema.safety}, ${hit.schema.concurrency}, ${promptChars(hit.schema).toLocaleString()} prompt chars.`,
          });
        }
        case "plugins": {
          const roster = host?.plugins?.();
          if (!roster) return failResult<IntrospectOutput>("The plugin kernel is not exposed on this host (not a daemon).");
          const rows = roster.plugins as Array<{ name?: string; state?: string; waitingOn?: string[]; error?: string }>;
          return okResult({ plugins: rows, recentMaintenance: roster.recentMaintenance.slice(0, limit), message: rows.length ? rows.map((p) => `${p.name}: ${p.state}${p.waitingOn?.length ? ` (waiting on ${p.waitingOn.join(", ")})` : ""}${p.error ? ` — ${p.error}` : ""}`).join("\n") : "No plugins mounted." });
        }
        case "surfaces": {
          const surfaces = (await listSurfaces()).slice(0, limit);
          return okResult({ surfaces, message: surfaces.length ? surfaces.map((s) => `${s.name} (${s.placement}, r${s.revision}, ${s.state})${s.feeds.length ? ` feeds: ${s.feeds.map((f) => f.kind).join(", ")}` : ""}${s.actions.length ? ` actions: ${s.actions.join(", ")}` : ""}`).join("\n") : "No surfaces." });
        }
        case "skills": {
          const skills = (await scanSkills(ctx.workspace)).slice(0, limit);
          return okResult({ skills, message: skills.length ? skills.map((s) => `${s.name} — ${s.description} (${s.path})`).join("\n") : "No skills installed." });
        }
        case "connectors": {
          if (!host) return failResult<IntrospectOutput>("This host does not expose its belt to Introspect.");
          const byServer = new Map<string, string[]>();
          for (const t of host.tools()) {
            const m = /^mcp_([a-z0-9-]+)_(.+)$/i.exec(t.schema.name);
            if (!m) continue;
            byServer.set(m[1], [...(byServer.get(m[1]) ?? []), m[2]]);
          }
          const connectors = [...byServer].map(([server, tools]) => ({ server, tools }));
          return okResult({ connectors, message: connectors.length ? connectors.map((c) => `${c.server}: ${c.tools.length} tools`).join("\n") : "No connector tools are live in this chat (Connect / Mcp to add one)." });
        }
        case "friction": {
          if (!host?.friction) return failResult<IntrospectOutput>("Friction telemetry is not exposed on this host.");
          const friction = (await host.friction(limit)) ?? [];
          return okResult({ friction, message: friction.length ? `${friction.length} friction entries (newest first).` : "No friction recorded yet." });
        }
      }
    } catch (err) {
      return failResult<IntrospectOutput>(err instanceof Error ? err.message : String(err));
    }
  },
});
