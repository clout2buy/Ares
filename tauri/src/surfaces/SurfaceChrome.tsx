// The strip above a surface in every placement: what it is, which revision,
// whether it is a trial, and the owner's buttons. Keep is the only way a
// trial survives the session; Undo is a rollback to the previous revision,
// which the ledger records as a new one, so nothing is ever lost.

import React from "react";
import type { SurfacePlacement } from "../../../packages/protocol/src/surfaces";
import { placementLabel, useSurfaces, type SurfaceVm } from "./SurfacesContext";

export function SurfaceChrome({ vm, compact, extra }: { vm: SurfaceVm; compact?: boolean; extra?: React.ReactNode }) {
  const api = useSurfaces();
  const { manifest } = vm;
  const targets: SurfacePlacement[] = (["card", "rail", "pane"] as SurfacePlacement[]).filter((p) => p !== manifest.placement);
  return (
    <div className="surfaceChrome" data-state={manifest.state} data-compact={compact ? "1" : "0"}>
      <span className="surfaceChromeTitle" title={manifest.note ?? manifest.title}>
        <i className="surfaceChromeDot" />
        <strong>{manifest.title || manifest.name}</strong>
        <em>r{manifest.revision}</em>
        {manifest.state === "trial" ? <b className="surfaceTrial" title="A trial lives in this session until you keep it">trial</b> : null}
        {vm.faults.length ? <b className="surfaceFault" title={vm.faults.join("\n")}>script fault</b> : null}
      </span>
      <span className="surfaceChromeActions">
        {extra}
        {manifest.state === "trial" ? <button onClick={() => api.keep(manifest.name)} title="Keep this surface: it comes back at boot">Keep</button> : null}
        {manifest.revision > 1 ? <button onClick={() => api.rollback(manifest.name, manifest.revision - 1)} title="Back to the previous revision">Undo</button> : null}
        {targets.map((p) => (
          <button key={p} onClick={() => api.place(manifest.name, p)} title={`Show this as a ${placementLabel(p)}`}>→ {placementLabel(p)}</button>
        ))}
        {manifest.placement !== "root" && manifest.placement !== "card" ? <button onClick={() => api.place(manifest.name, "root")} title="Make this the whole Ares window (the floor with approvals, Stop and Restore stays native)">→ whole window</button> : null}
        <button className="surfaceRemove" onClick={() => api.remove(manifest.name)} title="Remove this surface and its history">✕</button>
      </span>
    </div>
  );
}
