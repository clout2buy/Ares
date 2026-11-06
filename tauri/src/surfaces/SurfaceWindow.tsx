// A surface in its own OS window. It carries the same sandbox, feeds and
// bridge as every other placement; this window only holds the host and
// listens to the daemon's events directly.

import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { SurfaceDocument, SurfaceManifest } from "../../../packages/protocol/src/surfaces";
import { SurfaceHost } from "./SurfaceHost";
import { deliverSurfacePost, deliverSurfaceShare } from "./postBus";
import { loadPrefs, surfaceToStyle } from "../state/prefs";

interface Vm { manifest: SurfaceManifest; document: SurfaceDocument; morph?: { revision: number; ops: Array<Record<string, unknown>> } | null }

const send = (command: Record<string, unknown>) => void invoke("ares_daemon_command", { command }).catch(() => null);

export function SurfaceWindow({ name, see }: { name: string; see: boolean }) {
  const [vm, setVm] = useState<Vm | null>(null);
  const [gone, setGone] = useState(false);
  const prefs = loadPrefs();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<{ event: Record<string, unknown> }>("ares:event-buffered", ({ payload }) => {
      const e = payload.event;
      if (e.type === "surfaces_list") {
        const row = (e.surfaces as Vm[] | undefined)?.find((r) => r.manifest.name === name);
        if (row) setVm({ manifest: row.manifest, document: row.document });
      } else if (e.type === "surface_share") {
        deliverSurfaceShare(String(e.name), String(e.topic ?? ""), e.payload);
      } else if (e.name !== name) {
        return;
      } else if (e.type === "surface_revision") {
        const ops = Array.isArray(e.mutations) ? (e.mutations as Array<Record<string, unknown>>) : [];
        const manifest = e.manifest as SurfaceManifest;
        const morphable = e.origin === "mutate" && ops.length > 0 && ops.every((op) => op.op !== "replace_document" && op.op !== "set_script");
        setVm({ manifest, document: e.document as SurfaceDocument, morph: morphable ? { revision: manifest.revision, ops } : null });
      } else if (e.type === "surface_post") {
        deliverSurfacePost(name, e.payload);
      } else if (e.type === "surface_removed") {
        setGone(true);
        void getCurrentWindow().close().catch(() => null);
      }
    }).then((un) => { if (disposed) un(); else unlisten = un; });
    send({ type: "surfaces_list" });
    return () => { disposed = true; unlisten?.(); };
  }, [name]);
  // Show only once the document exists. A window covering the monitor can
  // never take clicks, whatever it asked for: click-through is applied after
  // showing, and only then, because it does not reliably stick to a hidden
  // window.
  const wants = vm?.manifest.frame?.window;
  useEffect(() => {
    if (!vm) return;
    const win = getCurrentWindow();
    void win.show().then(() => {
      if (wants?.clickThrough || wants?.cover) void win.setIgnoreCursorEvents(true).catch(() => null);
    }).catch(() => null);
  }, [vm !== null, wants?.clickThrough, wants?.cover]); // eslint-disable-line react-hooks/exhaustive-deps
  const onIntent = useCallback((text: string) => send({ type: "surface_intent", surface: name, text }), [name]);
  const onFault = useCallback((text: string) => send({ type: "surface_fault", surface: name, text }), [name]);
  const onCall = useCallback((callId: string, tool: string, input: unknown) => send({ type: "surface_call", surface: name, callId, tool, input }), [name]);
  return (
    <div className={see ? "surfaceWindow" : "ares surfaceWindow"} data-see-through={see ? "1" : undefined} data-theme={prefs.theme} data-accent={prefs.accent} data-style={surfaceToStyle(prefs.surface)} data-surface={prefs.surface}>
      {gone ? <p className="surfacesEmpty">This surface was removed.</p> : vm ? (
        <SurfaceHost name={name} document={vm.document} revision={vm.manifest.revision} morph={vm.morph} onIntent={onIntent} onFault={onFault} onCall={onCall} transparent={see} className="surfaceWindowFrame" />
      ) : null}
    </div>
  );
}
