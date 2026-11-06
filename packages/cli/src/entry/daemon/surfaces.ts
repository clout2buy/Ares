// Surfaces on the wire (docs/CREATOR-MODE-DESIGN.md).
//
// The ledger (@ares/tools surfaceStore) is the truth; this module is the
// daemon's two-way seam around it. Outbound: every ledger change is forwarded
// to the screens as a `surface_*` event tagged with the owning session, so a
// card lands in the right transcript and a rail tab appears wherever the
// desktop is. Inbound: the screens send back what the document did —
// `ares.send(text)` becomes a turn in the owning chat (surface_intent),
// `ares.call(tool, input)` runs through the belt's own gate (surface_call),
// script faults are remembered for the next prompt (surface_fault), and the
// owner's buttons (keep / remove / rollback / place) edit the ledger without
// a model turn. Feeds (surfaceFeeds.ts) follow the manifests the ledger
// announces, so daemon.ts only dispatches.

import {
  type SurfaceBusEvent,
  bindSurfaceSession,
  keepSurface,
  listSurfaces,
  placeSurface,
  readShellLayout,
  resetShellLayout,
  rollbackShellLayout,
  shellBus,
  type ShellLayout,
  readSurface,
  recordSurfaceFault,
  removeSurface,
  surfaceFaults,
  clearSurfaceFaults,
  rollbackSurface,
  genuiEnabled,
  setGenui,
  setUiMap,
  answerLook,
  setLookRequester,
  readSurfaceData,
  writeSurfaceData,
  shellGo,
  surfaceBus,
} from "@ares/tools";
import { rm } from "node:fs/promises";
import path from "node:path";
import { isSurfacePlacement } from "@ares/protocol";
import type { EngineTool, ToolPermissionRequest } from "@ares/core";
import type { PermissionPromptDecision } from "@ares/protocol";
import type { DaemonInputCommand } from "./protocol.js";
import { SurfaceFeeds, runGatedTool } from "./surfaceFeeds.js";

export interface SurfaceWiringOptions {
  /** tagEmit: session-tagged event to every attached screen. */
  emit: (sessionId: string | undefined, payload: Record<string, unknown>) => void;
  /** Start a turn in a session (the daemon's own `send` path). */
  deliver: (sessionId: string | undefined, goal: string, inputId: string) => void;
  home?: string;
  workspace: string;
  /** The belt of a live session, for feeds and calls. */
  toolsFor: (sessionId: string | undefined) => readonly EngineTool[] | undefined;
  /** The daemon's attended permission prompt (policy gate + owner posture). */
  requestPermission?: (request: ToolPermissionRequest) => Promise<PermissionPromptDecision>;
  tickMs?: number;
}

/** The surface-originated request as the model sees it. Tagged so the model
 * answers THROUGH the surface (post / small mutate) instead of rebuilding it —
 * the Living Surface's INHABIT lesson, now carried by the daemon so every
 * screen gets the same framing. */
export function surfaceIntentGoal(input: { name: string; title: string; revision: number; placement: string; text: string; faults?: string[] }): string {
  const faults = (input.faults ?? []).slice(-3);
  return `[SURFACE INTENT · ${input.name} · revision ${input.revision} · ${input.placement}]
${input.text.trim()}

(The owner acted inside the surface "${input.title}". Answer through it: Surface post with data its ares.onPost renders, or a small Surface mutate against base_revision ${input.revision} only when these words ask to change the UI. Never rebuild it to reply. Keep any visible text to one line.${faults.length ? ` The document reported script faults: ${faults.join(" | ")} — fix them if you touch the document.` : ""})`;
}

export class SurfaceWiring {
  private readonly off: () => void;
  private readonly onShell: (layout: ShellLayout) => void;
  private readonly onGo: (target: string) => void;
  readonly feeds: SurfaceFeeds;
  private readonly calls = new Map<string, AbortController>();

  constructor(private readonly options: SurfaceWiringOptions) {
    this.feeds = new SurfaceFeeds({
      post: (name, payload) => this.options.emit(this.sessionFor(name), { type: "surface_post", name, payload }),
      workspace: options.workspace,
      toolsFor: options.toolsFor,
      emit: options.emit,
      tickMs: options.tickMs,
    });
    // A rebuilt backend proved it boots: tell the launcher not to fall back.
    if (options.home) void rm(path.join(options.home, "runtime-active", ".trying"), { force: true }).catch(() => undefined);
    this.off = surfaceBus.subscribe((event) => this.forward(event));
    this.onShell = (layout: ShellLayout) => this.options.emit(undefined, { type: "shell_layout", layout });
    shellBus.on("layout", this.onShell);
    this.onGo = (target: string) => this.options.emit(undefined, { type: "shell_go", target });
    shellGo.on("go", this.onGo);
    setLookRequester((id, surface, act) => this.options.emit(undefined, { type: "ui_look", id, surface, act }));
    // Kept surfaces remount at boot: their feeds start with the daemon, so a
    // pane opened an hour later already shows fresh data.
    void listSurfaces(options.home).then((manifests) => {
      for (const manifest of manifests) {
        this.sessions.set(manifest.name, manifest.sessionId);
        this.feeds.reconcile(manifest);
      }
    }).catch(() => undefined);
  }

  private readonly sessions = new Map<string, string | undefined>();

  private sessionFor(name: string): string | undefined {
    return this.sessions.get(name);
  }

  dispose(): void {
    this.off();
    shellBus.off("layout", this.onShell);
    shellGo.off("go", this.onGo);
    setLookRequester(null);
    this.feeds.dispose();
    for (const controller of this.calls.values()) controller.abort();
  }

  /** daemon.ts calls this from tagEmit so session feeds see every event. */
  observe(sessionId: string | undefined, payload: Record<string, unknown>): void {
    this.feeds.observe(sessionId, payload);
  }

  private forward(event: SurfaceBusEvent): void {
    const sessionId = "manifest" in event ? event.manifest.sessionId : this.sessionFor(event.name);
    if ("manifest" in event) {
      this.sessions.set(event.name, event.manifest.sessionId);
      this.feeds.reconcile(event.manifest);
    }
    if (event.type === "surface_removed") {
      this.feeds.drop(event.name);
      this.sessions.delete(event.name);
    }
    this.options.emit(sessionId, { ...event });
  }

  async snapshot(): Promise<Array<Record<string, unknown>>> {
    const manifests = await listSurfaces(this.options.home);
    const records = await Promise.all(manifests.map((m) => readSurface(m.name, this.options.home)));
    return records.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => ({ manifest: r.manifest, document: r.document }));
  }

  /** Handle one wire command. Replies are emitted; a problem is thrown as a
   * plain Error the caller reports as daemon_error. */
  async handle(command: DaemonInputCommand): Promise<void> {
    const name = typeof command.surface === "string" ? command.surface : typeof command.name === "string" ? command.name : "";
    switch (command.type) {
      case "surfaces_list": {
        this.options.emit(undefined, { type: "surfaces_list", surfaces: await this.snapshot() });
        return;
      }
      case "genui_get": {
        this.options.emit(undefined, { type: "genui_state", enabled: genuiEnabled(this.options.home) });
        return;
      }
      case "genui_set": {
        try {
          setGenui(command.enabled === true, this.options.home);
        } catch (error) {
          this.options.emit(undefined, { type: "genui_state", enabled: genuiEnabled(this.options.home), error: `GenUI could not be saved: ${error instanceof Error ? error.message : String(error)}` });
          return;
        }
        this.options.emit(undefined, { type: "genui_state", enabled: genuiEnabled(this.options.home) });
        return;
      }
      case "surface_share": {
        if (!name) throw new Error("surface_share needs surface");
        this.options.emit(undefined, { type: "surface_share", name, topic: typeof command.topic === "string" ? command.topic : "", payload: command.input });
        return;
      }
      case "ui_map": {
        if (Array.isArray(command.map)) setUiMap(command.map.filter((x): x is string => typeof x === "string"), command.input as { styles?: unknown; vars?: unknown; state?: string } | undefined);
        return;
      }
      case "ui_seen": {
        const look = command.input as { report?: unknown; images?: unknown } | undefined;
        if (typeof command.callId === "string") {
          answerLook(command.callId, {
            report: typeof look?.report === "string" ? look.report : "",
            images: Array.isArray(look?.images) ? (look.images as Array<{ mediaType: string; data: string }>) : [],
          });
        }
        return;
      }
      case "surface_store": {
        // ares.store: what a document keeps across restarts. It is that
        // surface's own data, so no gate and no turn.
        const callId = typeof command.callId === "string" ? command.callId : "";
        if (!name || !callId) throw new Error("surface_store needs surface and callId");
        const reply = (payload: Record<string, unknown>) => this.options.emit(this.sessionFor(name), { type: "surface_post", name, payload: { __call: 1, callId, ...payload } });
        const key = typeof command.key === "string" ? command.key : "";
        const op = (command as { op?: unknown }).op;
        try {
          if (op === "set" || op === "remove") {
            if (!key) throw new Error("needs a key");
            await writeSurfaceData(name, key, op === "set" ? (command.input ?? null) : undefined, this.options.home);
            reply({ ok: true, output: null });
          } else {
            const data = await readSurfaceData(name, this.options.home);
            reply({ ok: true, output: op === "all" ? data : (data[key] ?? null) });
          }
        } catch (error) {
          reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case "shell_get": {
        this.options.emit(undefined, { type: "shell_layout", layout: await readShellLayout(this.options.home) });
        return;
      }
      case "shell_reset": {
        await resetShellLayout(this.options.home);
        return;
      }
      case "shell_rollback": {
        if (!Number.isInteger(command.revision)) throw new Error("shell_rollback needs revision");
        await rollbackShellLayout(Number(command.revision), this.options.home);
        return;
      }
      case "surface_intent": {
        const text = typeof command.text === "string" ? command.text.trim() : "";
        if (!name || !text) throw new Error("surface_intent needs surface and text");
        const record = await readSurface(name, this.options.home);
        if (!record) throw new Error(`no surface named "${name}"`);
        // A surface made from one chat may be driven from another screen; the
        // intent goes to the chat it talks to, binding one when none exists.
        let sessionId = record.manifest.sessionId;
        if (!sessionId && typeof command.sessionId === "string" && command.sessionId) {
          sessionId = command.sessionId;
          await bindSurfaceSession(name, sessionId, this.options.home);
        }
        const inputId = typeof command.inputId === "string" && command.inputId ? command.inputId : `surface_${name}_${Date.now().toString(36)}`;
        this.options.deliver(sessionId, surfaceIntentGoal({
          name,
          title: record.manifest.title,
          revision: record.manifest.revision,
          placement: record.manifest.placement,
          text: text.slice(0, 6_000),
        }), inputId);
        return;
      }
      case "surface_call": {
        // The document called ares.call(tool, input). Only a tool the manifest
        // names may run, and it runs through the owning chat's belt and gate
        // exactly as if the model had called it; the result lands back in the
        // document as a post the bridge resolves the promise with.
        const callId = typeof command.callId === "string" ? command.callId : "";
        const tool = typeof command.tool === "string" ? command.tool.trim() : "";
        if (!name || !callId || !tool) throw new Error("surface_call needs surface, callId and tool");
        const reply = (payload: Record<string, unknown>) => this.options.emit(this.sessionFor(name), { type: "surface_post", name, payload: { __call: 1, callId, ...payload } });
        const record = await readSurface(name, this.options.home);
        if (!record) { reply({ ok: false, error: `no surface named "${name}"` }); return; }
        if (!record.manifest.actions.includes(tool)) { reply({ ok: false, error: `"${tool}" is not in this surface's actions (${record.manifest.actions.join(", ") || "none"})` }); return; }
        const sessionId = record.manifest.sessionId ?? (typeof command.sessionId === "string" ? command.sessionId : undefined);
        const controller = new AbortController();
        this.calls.set(callId, controller);
        // Run detached: the command loop must keep serving while the owner
        // decides on the card.
        void runGatedTool({
          sessionId,
          tool,
          input: command.input ?? {},
          workspace: this.options.workspace,
          tools: this.options.toolsFor(sessionId),
          mode: "call",
          requestPermission: this.options.requestPermission,
          emit: this.options.emit,
          signal: controller.signal,
        }).then((result) => {
          reply(result.ok ? { ok: true, output: result.output, ...(result.display ? { display: result.display } : {}) } : { ok: false, error: result.error ?? "call failed" });
        }).finally(() => this.calls.delete(callId));
        return;
      }
      case "surface_fault": {
        if (!name) throw new Error("surface_fault needs surface");
        recordSurfaceFault(name, typeof command.text === "string" ? command.text : "script fault");
        // What people build stays. A revision that keeps throwing falls back
        // to the one before it and the owner is told once; a first revision
        // has nothing to fall back to, so its faults wait for the next prompt.
        const record = await readSurface(name, this.options.home);
        if (record && record.manifest.revision > 1 && surfaceFaults(name).length >= 3) {
          await rollbackSurface(name, record.manifest.revision - 1, this.options.home);
          clearSurfaceFaults(name);
          this.options.emit(record.manifest.sessionId, { type: "surface_notice", name, text: `"${record.manifest.title}" revision ${record.manifest.revision} faulted three times, so it went back to the revision before.`, tone: "warn" });
        }
        return;
      }
      case "surface_keep": {
        if (!name) throw new Error("surface_keep needs surface");
        await keepSurface(name, this.options.home);
        return;
      }
      case "surface_remove": {
        if (!name) throw new Error("surface_remove needs surface");
        if (!(await removeSurface(name, this.options.home))) throw new Error(`no surface named "${name}"`);
        return;
      }
      case "surface_rollback": {
        if (!name || !Number.isInteger(command.revision)) throw new Error("surface_rollback needs surface and revision");
        await rollbackSurface(name, Number(command.revision), this.options.home);
        return;
      }
      case "surface_place": {
        if (!name || !isSurfacePlacement(command.placement)) throw new Error("surface_place needs surface and a placement");
        await placeSurface(name, command.placement, this.options.home);
        return;
      }
      default:
        throw new Error(`unknown surface command ${String(command.type)}`);
    }
  }
}
