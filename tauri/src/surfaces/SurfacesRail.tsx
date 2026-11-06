// The rail placement: surfaces to watch while chatting, as tabs in the Forge
// panel beside the conversation. One is on screen at a time; the others keep
// receiving posts (the host queues them for the switch).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { SurfaceHost } from "./SurfaceHost";
import { SurfaceChrome } from "./SurfaceChrome";
import { useSurfaces } from "./SurfacesContext";

export function SurfacesRail({ focus }: { focus?: string | null }) {
  const api = useSurfaces();
  const rail = useMemo(() => Object.values(api.surfaces).filter((s) => s.manifest.placement === "rail").sort((a, b) => b.manifest.updatedAt - a.manifest.updatedAt), [api.surfaces]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { if (focus) setSelected(focus); }, [focus]);
  const current = rail.find((s) => s.manifest.name === selected) ?? rail[0] ?? null;
  const name = current?.manifest.name ?? "";
  const onIntent = useCallback((text: string) => api.intent(name, text), [api, name]);
  const onFault = useCallback((message: string) => api.fault(name, message), [api, name]);
  const onCall = useCallback((callId: string, tool: string, input: unknown) => api.call(name, callId, tool, input), [api, name]);
  if (!rail.length) {
    return (
      <div className="surfacesEmpty">
        <strong>No rail surfaces yet.</strong>
        <p>Ask for something to watch while you chat — “put a checklist for this in the rail”, “keep a live view of the test output here” — and it appears as a tab.</p>
      </div>
    );
  }
  return (
    <div className="surfacesRail">
      {rail.length > 1 ? (
        <div className="surfacesTabs" role="tablist">
          {rail.map((s) => (
            <button key={s.manifest.name} role="tab" data-on={s.manifest.name === name ? "1" : "0"} onClick={() => setSelected(s.manifest.name)}>{s.manifest.title || s.manifest.name}</button>
          ))}
        </div>
      ) : null}
      {current ? (
        <>
          <SurfaceChrome vm={current} compact />
          <SurfaceHost key={name} name={name} document={current.document} revision={current.manifest.revision} morph={current.morph} onIntent={onIntent} onFault={onFault} onCall={onCall} className="surfacesRailFrame" />
        </>
      ) : null}
    </div>
  );
}
