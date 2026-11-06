// The root surface: Ares's whole window is one document it wrote. Level 2
// of docs/CREATOR-MODE-DESIGN.md. The document fills the window; the CHROME
// FLOOR stays native and above it, and the document cannot draw, cover or
// imitate it: approvals waiting on the owner, Stop, Stop everything, Restore
// default shell, and a composer that always reaches Ares. The floor is why
// a model-owned window is safe to allow at all — the sandbox stops the
// document from doing what it was not granted; the floor stops it from
// misleading the owner about what is happening.

import React, { useCallback, useState } from "react";
import { SurfaceHost } from "./SurfaceHost";
import { useSurfaces, type SurfaceVm } from "./SurfacesContext";

export interface FloorApproval {
  sessionId: string;
  id: string;
  toolName: string;
  reason: string;
  submitting?: string;
}

export interface RootShellProps {
  vm: SurfaceVm;
  approvals: FloorApproval[];
  busy: boolean;
  daemon: string;
  onPermission: (id: string, decision: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onStopEverything: () => void;
  onRestore: () => void;
}

export function RootShell({ vm, approvals, busy, daemon, onPermission, onSend, onStop, onStopEverything, onRestore }: RootShellProps) {
  const api = useSurfaces();
  const name = vm.manifest.name;
  const [text, setText] = useState("");
  const onIntent = useCallback((t: string) => api.intent(name, t), [api, name]);
  const onFault = useCallback((m: string) => api.fault(name, m), [api, name]);
  const onCall = useCallback((callId: string, tool: string, input: unknown) => api.call(name, callId, tool, input), [api, name]);
  return (
    <div className="rootShell" data-busy={busy ? "1" : "0"}>
      <header className="chromeFloor" role="toolbar" aria-label="Ares floor">
        <span className="chromeFloorIdentity"><i /><strong>ARES</strong><em>{vm.manifest.title}</em><b>r{vm.manifest.revision}</b><small data-daemon={daemon}>{daemon === "running" ? (busy ? "working" : "ready") : daemon}</small></span>
        <span className="chromeFloorActions">
          {busy ? <button onClick={onStop} title="Stop the current turn">Stop</button> : null}
          <button className="chromeFloorDanger" onClick={onStopEverything} title="Halt every autonomous action Ares is taking">Stop everything</button>
          <button onClick={onRestore} title="Back to the standard Ares window; this surface stays in the ledger">Restore default shell</button>
        </span>
      </header>
      {approvals.length ? (
        <div className="chromeFloorApprovals">
          {approvals.map((a) => (
            <div key={a.id} className="chromeFloorGate" aria-busy={a.submitting ? "true" : undefined}>
              <strong>{a.toolName}</strong>
              <span>{a.reason}</span>
              <span className="chromeFloorGateActions">
                <button disabled={!!a.submitting} onClick={() => onPermission(a.id, "allow_once")}>Yes, this once</button>
                <button disabled={!!a.submitting} onClick={() => onPermission(a.id, "deny")}>No</button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <SurfaceHost name={name} document={vm.document} revision={vm.manifest.revision} morph={vm.morph} onIntent={onIntent} onFault={onFault} onCall={onCall} className="rootShellFrame" />
      <form className="chromeFloorComposer" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (!t) return; onSend(t); setText(""); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell Ares… (this always reaches it, whatever the window shows)" />
        <button type="submit" disabled={!text.trim()}>Send</button>
      </form>
    </div>
  );
}
