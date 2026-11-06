// Slots: the named regions of the native shell a surface can occupy. Every
// slot renders whatever surfaces were placed at `slot:<id>`, stacked, each
// in the same sandboxed host as a card. This is how "anywhere" works without
// handing the model the shell's own React tree: the shell keeps its regions,
// and the model fills them.

import React, { useCallback, useMemo } from "react";
import { SurfaceHost } from "./SurfaceHost";
import { useSurfaces, type SurfaceVm } from "./SurfacesContext";

/** The tallest a slot may grow; it hugs its content below that. */
const SLOT_MAX: Record<string, number> = {
  "rail.top": 240,
  "rail.nav": 240,
  "rail.bottom": 240,
  "stage.top": 320,
  "stage.bottom": 320,
  "composer.dock": 140,
  "status": 28,
  "overlay": 420,
  "anchor": 700,
};

export function SlotSurface({ vm, slot }: { vm: SurfaceVm; slot: string }) {
  const api = useSurfaces();
  const name = vm.manifest.name;
  const onIntent = useCallback((t: string) => api.intent(name, t), [api, name]);
  const onFault = useCallback((m: string) => api.fault(name, m), [api, name]);
  const onCall = useCallback((id: string, tool: string, input: unknown) => api.call(name, id, tool, input), [api, name]);
  return (
    <div className="slotSurface" data-slot={slot} data-state={vm.manifest.state} title={`${vm.manifest.title} · r${vm.manifest.revision}${vm.manifest.state === "trial" ? " · trial" : ""}`}>
      <SurfaceHost name={name} document={vm.document} revision={vm.manifest.revision} morph={vm.morph} onIntent={onIntent} onFault={onFault} onCall={onCall} className="slotFrame" {...(slot.startsWith("side.") ? { style: { height: "100%" } } : { fitMax: SLOT_MAX[slot] ?? 240, style: { height: 48 } })} />
      <button className="slotRemove" onClick={() => api.remove(name)} title={`Remove "${vm.manifest.title}"`} aria-label={`Remove ${vm.manifest.title}`}>✕</button>
    </div>
  );
}

export function SlotHost({ slot }: { slot: string }) {
  const { surfaces } = useSurfaces();
  const here = useMemo(() => Object.values(surfaces).filter((s) => s.manifest.placement === `slot:${slot}`).sort((a, b) => a.manifest.createdAt - b.manifest.createdAt), [surfaces, slot]);
  if (!here.length) return null;
  return (
    <div className="slotHost" data-slot={slot}>
      {here.map((vm) => <SlotSurface key={vm.manifest.name} vm={vm} slot={slot} />)}
    </div>
  );
}
