// Feeds: live data into a running surface while Ares is idle, and the one
// gate every surface-originated tool run goes through (docs/CREATOR-MODE-DESIGN.md).
//
// A surface declared its feeds in its manifest and the owner approved that
// list; this reconciler turns the list into subscriptions and posts each
// update as {feed, data} through the ledger's bus, so every screen with the
// surface mounted sees it. A feed is as cheap as it looks: a clock tick, a
// file watch, the owning session's own events, or a READ-ONLY belt tool on
// an interval. Nothing here starts a model turn.
//
// `runGatedTool` is shared with `ares.call`: it looks the tool up in the
// owning session's belt and runs it through the same adapted call the engine
// uses — zod shape check, semantic validation, the permission gate. Feeds run
// with a gate that answers "deny" to every ask (a feed that needs an owner
// decision is not a feed); calls run with the daemon's real prompt, so a Pay
// button raises the same card Ares would.

import { readFile, stat, watch } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { EngineTool, ToolPermissionRequest } from "@ares/core";
import type { PermissionPromptDecision } from "@ares/protocol";
import type { SurfaceFeed, SurfaceManifest } from "@ares/protocol";

export interface GatedToolRunOptions {
  sessionId: string | undefined;
  tool: string;
  input: unknown;
  workspace: string;
  tools: readonly EngineTool[] | undefined;
  /** "feed": asks are denied, only read-only classes may run. "call": the
   *  daemon's prompt decides, like a model call. */
  mode: "feed" | "call";
  requestPermission?: (request: ToolPermissionRequest) => Promise<PermissionPromptDecision>;
  /** Emit a session-tagged event (the permission_request / _response pair
   *  the desktop renders as a card). */
  emit: (sessionId: string | undefined, payload: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

export interface GatedToolRunResult {
  ok: boolean;
  output?: unknown;
  display?: string;
  error?: string;
}

function canonical(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function findBeltTool(tools: readonly EngineTool[] | undefined, name: string): EngineTool | undefined {
  if (!tools) return undefined;
  return tools.find((t) => t.schema.name === name) ?? tools.find((t) => canonical(t.schema.name) === canonical(name));
}

export async function runGatedTool(options: GatedToolRunOptions): Promise<GatedToolRunResult> {
  const tool = findBeltTool(options.tools, options.tool);
  if (!tool) return { ok: false, error: `no tool named "${options.tool}" in this chat's belt` };
  const safety = tool.classifyInput?.(options.input)?.safety ?? tool.schema.safety;
  if (options.mode === "feed" && safety !== "read-only") {
    return { ok: false, error: `${tool.schema.name} is ${safety}; a feed may only run read-only tools` };
  }
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const requestPermission = async (request: ToolPermissionRequest): Promise<PermissionPromptDecision> => {
    if (options.mode === "feed" || !options.requestPermission) return "deny";
    // Mirror the engine's wrapper: the desktop renders the request as a
    // card in the owning chat, the answer comes back by id, and the closing
    // response always follows so no card stays open.
    const id = `perm_surface_${randomUUID().slice(0, 12)}`;
    options.emit(options.sessionId, {
      type: "permission_request",
      id,
      toolName: request.toolName,
      input: request.input,
      reason: request.reason,
      suggestion: request.suggestion,
      ...(request.ownerDecision ? { ownerDecision: true } : {}),
      surfaceCall: true,
    });
    const waitMs = Number(process.env.ARES_PERMISSION_WAIT_MS) > 0 ? Number(process.env.ARES_PERMISSION_WAIT_MS) : 10 * 60_000;
    let ceiling: ReturnType<typeof setTimeout> | undefined;
    try {
      const decision = await Promise.race([
        options.requestPermission({ ...request, id, signal }),
        new Promise<PermissionPromptDecision>((resolve) => { ceiling = setTimeout(() => resolve("deny"), waitMs); ceiling.unref?.(); }),
      ]).catch(() => "deny" as PermissionPromptDecision);
      options.emit(options.sessionId, { type: "permission_response", id, decision });
      return decision;
    } finally {
      clearTimeout(ceiling);
    }
  };
  try {
    const result = await tool.call(options.input, {
      workspace: options.workspace,
      sessionId: options.sessionId ?? "surface",
      signal,
      requestPermission,
    });
    const failure = (result as { failure?: unknown }).failure;
    return {
      ok: !failure,
      output: (result as { output?: unknown }).output,
      ...(typeof (result as { display?: unknown }).display === "string" ? { display: (result as { display: string }).display } : {}),
      ...(failure ? { error: String(failure) } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SurfaceFeedsOptions {
  post: (name: string, payload: unknown) => void;
  workspace: string;
  toolsFor: (sessionId: string | undefined) => readonly EngineTool[] | undefined;
  emit: (sessionId: string | undefined, payload: Record<string, unknown>) => void;
  /** Tests speed the clock up; production leaves it at 1000. */
  tickMs?: number;
}

interface FeedSub {
  key: string;
  stop: () => void;
}

const MAX_FILE_BYTES = 200_000;

/** The session-event kinds a `session.events` feed forwards. Streaming deltas
 * and frames are left out: a surface wants the shape of the turn, not every
 * token. */
const SESSION_EVENT_TYPES = new Set(["turn_start", "turn_end", "tool_start", "tool_end", "permission_request", "permission_response", "message_done", "error", "daemon_error", "background_jobs", "steer_admitted"]);

function statusOf(type: string, payload: Record<string, unknown>): string | null {
  if (type === "turn_start") return "thinking";
  if (type === "tool_start") return `using ${String(payload.name ?? "a tool")}`;
  if (type === "tool_end") return "thinking";
  if (type === "turn_end" || type === "error" || type === "interrupted_by_user" || type === "interrupt_settled") return "idle";
  if (type === "permission_request") return "waiting for you";
  return null;
}

export class SurfaceFeeds {
  private readonly subs = new Map<string, FeedSub[]>();
  private readonly sessionOf = new Map<string, string | undefined>();
  private readonly tickMs: number;

  constructor(private readonly options: SurfaceFeedsOptions) {
    this.tickMs = options.tickMs ?? 1000;
  }

  /** Bring a surface's subscriptions in line with its manifest. Idempotent:
   * unchanged feeds keep running, removed ones stop, new ones start. */
  reconcile(manifest: SurfaceManifest): void {
    const wanted = new Map<string, SurfaceFeed>();
    for (const feed of manifest.feeds) wanted.set(feedKey(feed), feed);
    this.sessionOf.set(manifest.name, manifest.sessionId);
    const current = this.subs.get(manifest.name) ?? [];
    const kept: FeedSub[] = [];
    for (const sub of current) {
      if (wanted.has(sub.key)) { kept.push(sub); wanted.delete(sub.key); } else sub.stop();
    }
    for (const [key, feed] of wanted) kept.push(this.start(manifest, key, feed));
    this.subs.set(manifest.name, kept);
  }

  drop(name: string): void {
    for (const sub of this.subs.get(name) ?? []) sub.stop();
    this.subs.delete(name);
    this.sessionOf.delete(name);
  }

  dispose(): void {
    for (const name of [...this.subs.keys()]) this.drop(name);
  }

  /** Every session-tagged event the daemon emits passes through here; the
   * surfaces watching that session get the ones worth having. */
  observe(sessionId: string | undefined, payload: Record<string, unknown>): void {
    const type = typeof payload.type === "string" ? payload.type : "";
    if (!type || type.startsWith("surface_")) return;
    for (const [name, subs] of this.subs) {
      if (this.sessionOf.get(name) !== sessionId) continue;
      for (const sub of subs) {
        if (sub.key === "session.events" && SESSION_EVENT_TYPES.has(type)) {
          this.options.post(name, { feed: "session.events", data: compactEvent(payload) });
        } else if (sub.key === "session.status") {
          const status = statusOf(type, payload);
          if (status) this.options.post(name, { feed: "session.status", data: { status, at: Date.now() } });
        }
      }
    }
  }

  private start(manifest: SurfaceManifest, key: string, feed: SurfaceFeed): FeedSub {
    const name = manifest.name;
    if (feed.kind === "session.events" || feed.kind === "session.status") {
      return { key, stop: () => undefined };
    }
    if (feed.kind === "time") {
      const timer = setInterval(() => this.options.post(name, { feed: "time", data: { now: Date.now(), iso: new Date().toISOString() } }), feed.everySec * this.tickMs);
      timer.unref?.();
      this.options.post(name, { feed: "time", data: { now: Date.now(), iso: new Date().toISOString() } });
      return { key, stop: () => clearInterval(timer) };
    }
    if (feed.kind === "file") {
      const file = path.isAbsolute(feed.path) ? feed.path : path.join(this.options.workspace, feed.path);
      // Only the workspace is a feed's reach; a manifest naming a path outside
      // it is refused at subscription time, not silently followed.
      const inside = !path.relative(this.options.workspace, file).startsWith("..") && !path.isAbsolute(path.relative(this.options.workspace, file));
      if (!inside) {
        this.options.post(name, { feed: "file", path: feed.path, error: "outside the workspace" });
        return { key, stop: () => undefined };
      }
      let stopped = false;
      let last = "";
      const read = () => {
        stat(file, (statErr, info) => {
          if (stopped) return;
          if (statErr || !info.isFile()) { this.options.post(name, { feed: "file", path: feed.path, error: "missing" }); return; }
          if (info.size > MAX_FILE_BYTES) { this.options.post(name, { feed: "file", path: feed.path, error: `over ${MAX_FILE_BYTES} bytes` }); return; }
          readFile(file, "utf8", (err, text) => {
            if (stopped || err) return;
            if (text === last) return;
            last = text;
            this.options.post(name, { feed: "file", path: feed.path, data: text, size: info.size, mtime: info.mtimeMs });
          });
        });
      };
      let watcher: ReturnType<typeof watch> | null = null;
      let debounce: ReturnType<typeof setTimeout> | undefined;
      try {
        watcher = watch(file, { persistent: false }, () => {
          clearTimeout(debounce);
          debounce = setTimeout(read, 150);
        });
        watcher.on("error", () => undefined);
      } catch {
        // A file that does not exist yet cannot be watched; the poll below
        // still reports it, and a later revision can re-subscribe.
      }
      const poll = setInterval(read, 15 * this.tickMs);
      poll.unref?.();
      read();
      return { key, stop: () => { stopped = true; clearTimeout(debounce); clearInterval(poll); watcher?.close(); } };
    }
    // tool feed
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        const result = await runGatedTool({
          sessionId: this.sessionOf.get(name),
          tool: feed.tool,
          input: feed.input ?? {},
          workspace: this.options.workspace,
          tools: this.options.toolsFor(this.sessionOf.get(name)),
          mode: "feed",
          emit: this.options.emit,
        });
        this.options.post(name, { feed: "tool", tool: feed.tool, at: Date.now(), ...(result.ok ? { data: result.output } : { error: result.error }) });
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void run(), feed.everySec * this.tickMs);
    timer.unref?.();
    void run();
    return { key, stop: () => clearInterval(timer) };
  }
}

function feedKey(feed: SurfaceFeed): string {
  switch (feed.kind) {
    case "session.events":
    case "session.status":
      return feed.kind;
    case "time":
      return `time:${feed.everySec}`;
    case "file":
      return `file:${feed.path}`;
    case "tool":
      return `tool:${feed.tool}:${feed.everySec}:${JSON.stringify(feed.input ?? {})}`;
  }
}

function compactEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "image" || key === "images" || key === "sessionId") continue;
    if (typeof value === "string") out[key] = value.length > 600 ? `${value.slice(0, 600)}…` : value;
    else if (value === null || typeof value !== "object") out[key] = value;
    else {
      const text = JSON.stringify(value);
      out[key] = text.length > 1200 ? `${text.slice(0, 1200)}…` : value;
    }
  }
  return out;
}
