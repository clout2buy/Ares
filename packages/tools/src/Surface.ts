// Surface — Ares builds live UI anywhere Ares is.
//
// A surface is a named, versioned, sandboxed document: HTML + CSS + script the
// model writes, placed by the desktop as a card under the reply, a tab in the
// rail, a pane, its own window, a screen on the phone or a Telegram Mini App.
// The daemon owns the ledger (surfaceStore.ts) and validates every revision;
// the screens render what the ledger says and never trust the document. This
// tool is the model's whole handle on it: create, patch, post live data,
// keep, remove, roll back. The desktop learns of each change from the
// store's bus, not from this tool's output, so the model's context never
// carries a document twice.
//
// Capabilities (feeds the daemon pushes in, tools the document may call) are
// what the owner approves — as an owner decision, so a surface that can see
// or do things always asks once, whatever the permission posture. A surface
// that only draws asks nobody; it is a reply with pixels.

import { z } from "zod";
import {
  SURFACE_BRIDGE_DOC,
  SURFACE_PLACEMENTS,
  SURFACE_SLOTS,
  isSurfacePlacement,
  describeSurfaceCapabilities,
  parseLivingSurfaceMutations,
  parseSurfaceActions,
  parseSurfaceFeeds,
  regionsInSurfaceHtml,
  type SurfaceManifest,
  type SurfacePlacement,
  webSurfaceHtml,
} from "@ares/protocol";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";
import { withEyes } from "./uiLook.js";
import { genuiGate } from "./genui.js";
import {
  createSurface,
  keepSurface,
  listSurfaceRevisions,
  listSurfaces,
  mutateSurface,
  placeSurface,
  postSurface,
  readSurface,
  removeSurface,
  rollbackSurface,
  surfaceFaults,
} from "./surfaceStore.js";

const feedSchema = z
  .object({
    kind: z.enum(["session.events", "session.status", "time", "file", "tool"]).describe("session.events: every event of this chat; session.status: idle/thinking/tool line; time: a tick; file: a workspace file on change; tool: a READ-ONLY belt tool run on an interval."),
    everySec: z.number().int().positive().optional().describe("time/tool: cadence in seconds (time ≥5, tool ≥30)."),
    path: z.string().optional().describe("file: workspace-relative path."),
    tool: z.string().optional().describe("tool: belt tool name (read-only tools only)."),
    input: z.record(z.unknown()).optional().describe("tool: the input to run it with."),
  })
  .strict();

const mutationSchema = z
  .object({
    op: z.enum(["replace_document", "replace_region", "append_region", "prepend_region", "remove_region", "set_css", "set_script", "set_title", "post"]),
    target: z.string().optional().describe("region ops: the data-ares-region name."),
    html: z.string().optional(),
    css: z.string().optional(),
    js: z.string().optional(),
    title: z.string().optional(),
    payload: z.unknown().optional().describe("post: JSON the document's ares.onPost handler renders live, no reload."),
  })
  .strict();

const inputSchema = z
  .object({
    action: z.enum(["offer", "create", "mutate", "post", "list", "show", "keep", "remove", "rollback", "place"]).describe(
      "offer: propose a surface before building it (name, title, placement, brief, feeds, actions) — the owner gets a card with Make it / Not now; build with create only after it returns approved. Use offer for rail/pane/window surfaces and anything with feeds or actions; cards just get created. create: new surface (or replace one wholesale) from html/css/js. mutate: patch regions / css / script / title of an existing one against base_revision, and/or post. post: live data into the running document (no reload, no revision). list / show: the ledger. keep: promote a trial to kept (remounts at boot) — only on the owner's word. remove: delete. rollback: make an older revision current. place: move it to another placement.",
    ),
    name: z.string().optional().describe("Surface id: 2-41 lowercase letters/digits/hyphens (e.g. 'bills-rail'). Required for everything but list."),
    title: z.string().max(120).optional().describe("create: human title."),
    placement: z.string().refine(isSurfacePlacement, { message: `placement must be one of ${SURFACE_PLACEMENTS.join(", ")} or slot:<${SURFACE_SLOTS.join("|")}>` }).optional().describe("create/place: free puts it anywhere with any shape via frame (nothing here is a fixed list). at:<before|after|inside|start|replace>:<css selector> puts it against ANY element in the app, including the titlebar and Settings pages, and it appears whenever that element does (Introspect ui lists what is on screen). window opens its own OS window and reopens at boot. slot:<region> puts it inside the native shell (rail.top, rail.nav, rail.bottom, stage.top, stage.bottom, composer.dock under the input bar, status, overlay). card (inline under this reply — default, cheapest), rail (tab beside the chat, for watch-while-chatting), pane (full pane with a sidebar entry), window (its own window), phone, telegram, root (the WHOLE Ares window becomes this document, under a native floor with approvals/Stop/Restore — only when the owner asks for a new shell; always asks)."),
    frame: z.object({ style: z.record(z.string()).optional(), transparent: z.boolean().optional(), clickThrough: z.boolean().optional(), hidden: z.boolean().optional(), movable: z.boolean().optional(), window: z.object({ dock: z.enum(["left", "right", "top", "bottom"]).optional(), cover: z.boolean().optional(), width: z.number().optional(), height: z.number().optional(), x: z.number().optional(), y: z.number().optional(), decorations: z.boolean().optional(), transparent: z.boolean().optional(), alwaysOnTop: z.boolean().optional(), clickThrough: z.boolean().optional() }).strict().optional() }).strict().optional().describe("window: for placement window, a real OS window OUTSIDE Ares: dock sticks it to that side of Ares and follows it (panels around the app); cover spans the monitor; decorations false, transparent, alwaysOnTop and clickThrough make overlays on the desktop itself. create/place with placement free: style is any CSS for the host (e.g. {inset:'0',zIndex:'200'} for the whole window, {left:'50%',top:'20px',width:'300px',height:'80px'} for a floating bar); transparent shows the app behind what you do not draw; clickThrough lets clicks reach the app. A one-shot full-window effect is free + inset 0 + transparent + clickThrough, calling ares.close() when finished."),
    url: z.string().url().optional().describe("create: show this website instead of writing html: a real page in its own frame, with its own network and sign-in. With placement free it floats, and the owner drags and resizes it. With placement window it is its own OS window."),
    html: z.string().optional().describe("create: body markup. Must contain at least one element with data-ares-region=\"name\"."),
    css: z.string().optional().describe("create: stylesheet. Use the ares.theme tokens via var(--ares-bg) etc. for a native look."),
    js: z.string().optional().describe("create: the document's script (full inline JS; build real software)."),
    feeds: z.array(feedSchema).max(12).optional().describe("create: live data the daemon pushes in while Ares is idle. Declaring any feed asks the owner once."),
    actions: z.array(z.string()).max(12).optional().describe("create: belt tools the document may call with ares.call(tool, input). Declaring any asks the owner once; each call then asks as if Ares made it."),
    mutations: z.array(mutationSchema).max(24).optional().describe("mutate: ordered operations."),
    base_revision: z.number().int().nonnegative().optional().describe("mutate: the revision you are patching (from create/show). A stale base is refused."),
    payload: z.unknown().optional().describe("post: JSON for ares.onPost."),
    revision: z.number().int().positive().optional().describe("rollback: target revision."),
    note: z.string().max(400).optional().describe("create/mutate: what changed, one line (the ledger's commit message)."),
    brief: z.string().max(600).optional().describe("offer: two or three plain sentences — what it shows, what the owner can do in it, what it keeps."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface SurfaceOutput {
  message: string;
  name?: string;
  revision?: number;
  placement?: SurfacePlacement;
  state?: string;
  regions?: string[];
  faults?: string[];
  surfaces?: Array<Pick<SurfaceManifest, "name" | "title" | "placement" | "revision" | "state" | "note">>;
  revisions?: Array<{ revision: number; at: number; note?: string; title: string }>;
  html?: string;
  css?: string;
  js?: string;
  feeds?: SurfaceManifest["feeds"];
  actions?: string[];
}

function capabilitiesOf(input: Input): { feeds: SurfaceManifest["feeds"]; actions: string[] } | { error: string } {
  const feeds = parseSurfaceFeeds(input.feeds);
  if ("error" in feeds) return feeds;
  const actions = parseSurfaceActions(input.actions);
  if ("error" in actions) return actions;
  return { feeds: feeds.feeds, actions: actions.actions };
}

/** Offers the owner accepted this process, so the create that follows does
 * not ask twice for the capabilities already on the card. */
const approvedOffers = new Map<string, { feeds: SurfaceManifest["feeds"]; actions: string[]; sessionId: string }>();

function sameCapabilities(a: { feeds: SurfaceManifest["feeds"]; actions: string[] }, b: SurfaceManifest): boolean {
  return JSON.stringify(a.feeds) === JSON.stringify(b.feeds) && JSON.stringify([...a.actions].sort()) === JSON.stringify([...b.actions].sort());
}

/** Sites that forbid framing show as a blank panel and no error reaches the app,
 * so ask the site first. Any doubt, such as no network, lets it through. */
export async function refusesEmbedding(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(4_000) });
    void res.body?.cancel().catch(() => undefined);
    if (/deny|sameorigin/i.test(res.headers.get("x-frame-options") ?? "")) return true;
    const ancestors = /frame-ancestors([^;]*)/i.exec(res.headers.get("content-security-policy") ?? "")?.[1]?.trim();
    return ancestors !== undefined && !/(^|\s)\*(\s|$)/.test(ancestors);
  } catch {
    return false;
  }
}

export const SurfaceTool = buildTool<typeof inputSchema, SurfaceOutput>({
  name: "Surface",
  description:
    "Build live UI inside Ares: a card under your reply, a tab in the rail, a pane, a window, the phone or Telegram. A surface is HTML+CSS+JS you write, rendered in a sealed sandbox (no network, no storage) with a bridge to Ares. "
    + "Use it when the owner asks for a page, panel, dashboard, tracker, game, picker, chart or anything they will look at or interact with — reply with a surface instead of describing one. Prefer card for one-off things, rail for anything to watch while chatting, pane for a place they will come back to. "
    + "FORGE then INHABIT: build the thing once (create), then answer through it (post; small mutate) — never rebuild a surface to answer a message inside it. LOCAL FIRST: controls that only affect the surface (sliders, tabs, filters, game input) are handled by its own script; ares.send carries only what needs your intelligence. "
    + "Quality bar: every control works, the core function works end to end, real state, art direction drawn from the request, arrives whole in one create. Nothing may flash (fast infinite opacity/colour animations and sub-100ms style timers are refused). "
    + SURFACE_BRIDGE_DOC + " "
    + "Feeds (session events/status, a clock, a file, a read-only tool on an interval) arrive as posts {feed, data} with no turn of yours. A surface with feeds or actions asks the owner once when created; a drawing-only surface just appears. Surfaces persist across restarts; remove goes to a trash Modules restore can undo.",
  safety: "read-only",
  ownerDecisions: true,
  concurrency: "exclusive",
  inputZod: inputSchema,
  // Using what exists stays open with GenUI off: reading, and posting data in.
  validateInput: async (input) => genuiGate(!(input.action === "list" || input.action === "show" || input.action === "post" || (input.action === "mutate" && (input.mutations ?? []).every((m) => m.op === "post")))),
  watchdogTimeoutMs: 20_000,
  maxResultSizeChars: 80_000,
  activityDescription: (input) => {
    const name = input.name ? ` ${input.name}` : "";
    switch (input.action) {
      case "create": return `Building surface${name}`;
      case "mutate": return `Updating surface${name}`;
      case "post": return `Updating surface${name} live`;
      case "keep": return `Keeping surface${name}`;
      case "remove": return `Removing surface${name}`;
      case "rollback": return `Rolling surface${name} back`;
      case "place": return `Moving surface${name}`;
      default: return "Reading surfaces";
    }
  },
  async checkPermissions(input, ctx) {
    if (input.placement === "root" && (input.action === "create" || input.action === "place" || input.action === "offer")) {
      // The whole window. Always the owner's call, whatever the posture; the
      // floor (approvals, Stop, Restore default shell) stays native above it.
      if (ctx.permissionMode === "plan") return { kind: "deny", reason: "Surfaces can only be read in plan mode." };
      const caps = capabilitiesOf(input);
      const what = "error" in caps ? "" : describeSurfaceCapabilities(caps.feeds, caps.actions);
      return {
        kind: "ask",
        prompt: `Make "${input.title ?? input.name}" Ares's whole window?${input.brief ? ` ${input.brief.trim()}` : ""}${what ? ` It would ${what}.` : ""} The floor stays native: approvals, Stop, and Restore default shell are always one click away.`,
        suggestion: "allow_once",
        ownerDecision: true,
      };
    }
    if (input.action === "offer") {
      if (ctx.permissionMode === "plan") return { kind: "deny", reason: "Surfaces can only be read in plan mode." };
      const caps = capabilitiesOf(input);
      const what = "error" in caps ? "" : describeSurfaceCapabilities(caps.feeds, caps.actions);
      return {
        kind: "ask",
        prompt: `${input.brief?.trim() || `Build the surface "${input.title ?? input.name}"?`}${what ? ` It would ${what}.` : ""}`,
        suggestion: "allow_once",
        ownerDecision: true,
      };
    }
    if (input.action !== "create" && input.action !== "remove") return { kind: "allow" };
    if (ctx.permissionMode === "plan") return { kind: "deny", reason: "Surfaces can only be read in plan mode." };
    // Removal goes to the trash with its history, so there is nothing to confirm.
    if (input.action === "remove") return { kind: "allow" };
    const caps = capabilitiesOf(input);
    if ("error" in caps) return { kind: "allow" }; // validation reports it
    // Only reach beyond the app asks: a clock or this chat's own status is
    // not a decision anyone should have to make.
    if (!caps.actions.length && !caps.feeds.some((f) => f.kind === "file" || f.kind === "tool")) return { kind: "allow" };
    const existing = input.name ? await readSurface(input.name) : null;
    if (existing && sameCapabilities(caps, existing.manifest)) return { kind: "allow" };
    const offered = input.name ? approvedOffers.get(input.name) : undefined;
    if (offered && offered.sessionId === ctx.sessionId && sameCapabilities(caps, { feeds: offered.feeds, actions: offered.actions } as SurfaceManifest)) return { kind: "allow" };
    return {
      kind: "ask",
      prompt: `Let the surface "${input.title ?? input.name}" (${input.placement ?? "card"}) ${describeSurfaceCapabilities(caps.feeds, caps.actions)}?`,
      suggestion: "allow_once",
      ownerDecision: true,
    };
  },
  async call(input: Input, ctx): Promise<ToolResult<SurfaceOutput>> {
    try {
      switch (input.action) {
        case "offer": {
          // Reaching call() means the owner pressed Make it; the capabilities
          // on the card are the ones create may now use without asking again.
          if (!input.name) return failResult<SurfaceOutput>("offer needs name.");
          const caps = capabilitiesOf(input);
          if ("error" in caps) return failResult<SurfaceOutput>(caps.error);
          approvedOffers.set(input.name, { feeds: caps.feeds, actions: caps.actions, sessionId: ctx.sessionId });
          return okResult({
            name: input.name,
            placement: input.placement ?? "card",
            feeds: caps.feeds,
            actions: caps.actions,
            message: `The owner said Make it. Build "${input.title ?? input.name}" now with Surface create (name ${input.name}, placement ${input.placement ?? "card"}, the same feeds and actions); it will not ask again. Arrive whole: every control working, real state, art direction from the request.`,
          }, `Offer accepted: ${input.name}`);
        }
        case "list": {
          const surfaces = (await listSurfaces()).map((m) => ({ name: m.name, title: m.title, placement: m.placement, revision: m.revision, state: m.state, ...(m.note ? { note: m.note } : {}) }));
          return okResult({ surfaces, message: surfaces.length ? surfaces.map((s) => `${s.name} (${s.placement}, r${s.revision}, ${s.state}) — ${s.title}`).join("\n") : "No surfaces yet." });
        }
        case "show": {
          if (!input.name) return failResult<SurfaceOutput>("show needs name.");
          const record = await readSurface(input.name);
          if (!record) return failResult<SurfaceOutput>(`No surface named "${input.name}".`);
          const revisions = await listSurfaceRevisions(input.name);
          const faults = surfaceFaults(input.name);
          return okResult({
            name: record.manifest.name,
            revision: record.manifest.revision,
            placement: record.manifest.placement,
            state: record.manifest.state,
            regions: regionsInSurfaceHtml(record.document.html),
            feeds: record.manifest.feeds,
            actions: record.manifest.actions,
            revisions: revisions.slice(-10),
            html: record.document.html.slice(0, 60_000),
            css: record.document.css.slice(0, 30_000),
            js: record.document.js.slice(0, 40_000),
            ...(faults.length ? { faults } : {}),
            message: `${record.manifest.name} is at revision ${record.manifest.revision} (${record.manifest.placement}, ${record.manifest.state}).${faults.length ? ` Script faults reported by the document: ${faults.join(" | ")}` : ""}`,
          }, `${record.manifest.name} r${record.manifest.revision}`);
        }
        case "create": {
          if (!input.name) return failResult<SurfaceOutput>("create needs name.");
          if (input.url && !/^https?:\/\/[^"<>\s]+$/.test(input.url)) return failResult<SurfaceOutput>("url must be an http or https address.");
          const html = input.url ? webSurfaceHtml(input.url) : input.html;
          if (typeof html !== "string" || !html.trim()) return failResult<SurfaceOutput>("create needs html or url.");
          if (input.url && input.placement !== "window" && await refusesEmbedding(input.url)) {
            return failResult<SurfaceOutput>(`${input.url} refuses to load inside another app, so this would be a blank panel. Use placement window: it opens the site as its own real window, and the left-bar button works the same.`);
          }
          const caps = capabilitiesOf(input);
          if ("error" in caps) return failResult<SurfaceOutput>(caps.error);
          const record = await createSurface({
            name: input.name,
            title: input.title?.trim() || input.name,
            placement: input.placement ?? "card",
            document: { html, css: input.css ?? "", js: input.js ?? "" },
            feeds: caps.feeds,
            actions: caps.actions,
            ...(input.frame ? { frame: input.frame } : {}),
            sessionId: ctx.sessionId,
            ...(input.note ? { note: input.note } : {}),
          });
          const regions = regionsInSurfaceHtml(record.document.html);
          return withEyes(okResult({
            name: record.manifest.name,
            revision: record.manifest.revision,
            placement: record.manifest.placement,
            state: record.manifest.state,
            regions,
            message: `Surface "${record.manifest.name}" is live at revision ${record.manifest.revision} as a ${record.manifest.placement} (${record.manifest.state}). Regions: ${regions.join(", ")}. Patch it with mutate (base_revision ${record.manifest.revision}) or feed it with post; do not rebuild it to answer.`,
          }, `Surface ${record.manifest.name} r${record.manifest.revision}`), record.manifest.name);
        }
        case "mutate": {
          if (!input.name) return failResult<SurfaceOutput>("mutate needs name.");
          if (typeof input.base_revision !== "number") return failResult<SurfaceOutput>("mutate needs base_revision (the revision you are patching).");
          const parsed = parseLivingSurfaceMutations(input.mutations);
          if ("error" in parsed) return failResult<SurfaceOutput>(parsed.error);
          const result = await mutateSurface(input.name, input.base_revision, parsed.mutations, input.note);
          const regions = regionsInSurfaceHtml(result.document.html);
          const patched = okResult({
            name: result.manifest.name,
            revision: result.manifest.revision,
            placement: result.manifest.placement,
            state: result.manifest.state,
            regions,
            message: result.documentChanged
              ? `Surface "${result.manifest.name}" is now revision ${result.manifest.revision}${result.posts.length ? ` and received ${result.posts.length} post(s)` : ""}. Regions: ${regions.join(", ")}.`
              : `Posted ${result.posts.length} payload(s) into "${result.manifest.name}" (still revision ${result.manifest.revision}).`,
          }, `Surface ${result.manifest.name} r${result.manifest.revision}`);
          return result.documentChanged ? withEyes(patched, result.manifest.name) : patched;
        }
        case "post": {
          if (!input.name) return failResult<SurfaceOutput>("post needs name.");
          if (input.payload === undefined) return failResult<SurfaceOutput>("post needs payload.");
          await postSurface(input.name, input.payload);
          return okResult({ name: input.name, message: `Posted into "${input.name}".` });
        }
        case "keep": {
          if (!input.name) return failResult<SurfaceOutput>("keep needs name.");
          const manifest = await keepSurface(input.name);
          return okResult({ name: manifest.name, state: manifest.state, revision: manifest.revision, placement: manifest.placement, message: `Surface "${manifest.name}" is kept: it remounts at boot as a ${manifest.placement}.` });
        }
        case "remove": {
          if (!input.name) return failResult<SurfaceOutput>("remove needs name.");
          const removed = await removeSurface(input.name);
          return removed ? okResult({ name: input.name, message: `Removed surface "${input.name}".` }) : failResult<SurfaceOutput>(`No surface named "${input.name}".`);
        }
        case "rollback": {
          if (!input.name || typeof input.revision !== "number") return failResult<SurfaceOutput>("rollback needs name and revision.");
          const record = await rollbackSurface(input.name, input.revision);
          return okResult({ name: record.manifest.name, revision: record.manifest.revision, placement: record.manifest.placement, state: record.manifest.state, regions: regionsInSurfaceHtml(record.document.html), message: `Surface "${record.manifest.name}" rolled back to the content of revision ${input.revision}; it is now revision ${record.manifest.revision}.` });
        }
        case "place": {
          if (!input.name || !input.placement) return failResult<SurfaceOutput>("place needs name and placement.");
          const manifest = await placeSurface(input.name, input.placement, undefined, input.frame);
          return withEyes(okResult({ name: manifest.name, placement: manifest.placement, revision: manifest.revision, state: manifest.state, message: `Surface "${manifest.name}" now shows as a ${manifest.placement}.` }), manifest.name);
        }
      }
    } catch (err) {
      return failResult<SurfaceOutput>(err instanceof Error ? err.message : String(err));
    }
  },
});
