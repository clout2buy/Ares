// What every placement needs from the shell: the ledger as the desktop
// currently knows it, and the handful of things a document or the owner can
// do to a surface. App.tsx owns the state and the daemon commands; the
// placements only read this.

import { createContext, useContext } from "react";
import type { SurfaceDocument, SurfaceManifest, SurfacePlacement } from "../../../packages/protocol/src/surfaces";

export interface SurfaceVm {
  manifest: SurfaceManifest;
  document: SurfaceDocument;
  faults: string[];
  /** Region ops of the latest revision, when it arrived as a patch. */
  morph?: { revision: number; ops: Array<Record<string, unknown>> } | null;
}

export interface SurfacesApi {
  surfaces: Record<string, SurfaceVm>;
  /** The document called ares.send: a turn in the surface's chat. */
  intent: (name: string, text: string) => void;
  fault: (name: string, message: string) => void;
  /** The document called ares.call: a gated belt-tool call. */
  call: (name: string, callId: string, tool: string, input: unknown) => void;
  keep: (name: string) => void;
  remove: (name: string) => void;
  rollback: (name: string, revision: number) => void;
  place: (name: string, placement: SurfacePlacement) => void;
  /** Say something to Ares as the owner, in the open chat. */
  say: (text: string) => void;
  /** Bring the surface's placement on screen (open the rail tab, the pane…). */
  open: (name: string) => void;
}

const noop = () => undefined;

export const SurfacesContext = createContext<SurfacesApi>({
  surfaces: {},
  intent: noop,
  fault: noop,
  call: noop,
  keep: noop,
  remove: noop,
  rollback: noop,
  place: noop,
  say: noop,
  open: noop,
});

export function useSurfaces(): SurfacesApi {
  return useContext(SurfacesContext);
}

export function placementLabel(placement: SurfacePlacement): string {
  switch (placement) {
    case "card": return "card";
    case "rail": return "rail";
    case "pane": return "pane";
    case "window": return "window";
    case "phone": return "phone";
    case "telegram": return "Telegram";
    case "root": return "whole window";
    default: return placement.replace(/^slot:/, "");
  }
}
