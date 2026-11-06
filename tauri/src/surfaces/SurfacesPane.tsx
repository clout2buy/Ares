// The pane placement: a place the owner comes back to. Every surface placed
// as a pane (or made for a screen this desktop cannot show: phone, Telegram,
// window) is listed on the left; the selected one fills the stage.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { SurfaceHost } from "./SurfaceHost";
import { SurfaceChrome } from "./SurfaceChrome";
import { placementLabel, useSurfaces } from "./SurfacesContext";

export function SurfacesPane({ focus }: { focus?: string | null }) {
  const api = useSurfaces();
  const all = useMemo(() => Object.values(api.surfaces).sort((a, b) => b.manifest.updatedAt - a.manifest.updatedAt), [api.surfaces]);
  const panes = all.filter((s) => s.manifest.name === focus || (s.manifest.placement !== "card" && s.manifest.placement !== "rail" && s.manifest.placement !== "free" && !/^(slot|at):/.test(s.manifest.placement)));
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { if (focus) setSelected(focus); }, [focus]);
  const current = panes.find((s) => s.manifest.name === selected) ?? panes[0] ?? null;
  const name = current?.manifest.name ?? "";
  const onIntent = useCallback((text: string) => api.intent(name, text), [api, name]);
  const onFault = useCallback((message: string) => api.fault(name, message), [api, name]);
  const onCall = useCallback((callId: string, tool: string, input: unknown) => api.call(name, callId, tool, input), [api, name]);
  return (
    <div className="surfacesPane">
      <aside className="surfacesList">
        <h2>Surfaces</h2>
        {panes.length ? panes.map((s) => (
          <button key={s.manifest.name} data-on={s.manifest.name === name ? "1" : "0"} onClick={() => setSelected(s.manifest.name)}>
            <strong>{s.manifest.title || s.manifest.name}</strong>
            <small>{placementLabel(s.manifest.placement)} · r{s.manifest.revision}{s.manifest.state === "trial" ? " · trial" : ""}</small>
          </button>
        )) : (
          <p className="surfacesListEmpty">Nothing here yet. Ask Ares for a dashboard, a tracker, a game — “make me a pane that…” — and it lands here.</p>
        )}
        {all.length > panes.length ? (
          <p className="surfacesListNote">{all.length - panes.length} more live in chats and the rail.</p>
        ) : null}
      </aside>
      <section className="surfacesStage">
        {current ? (
          <>
            <SurfaceChrome vm={current} />
            <SurfaceHost key={name} name={name} document={current.document} revision={current.manifest.revision} morph={current.morph} onIntent={onIntent} onFault={onFault} onCall={onCall} className="surfacesPaneFrame" />
          </>
        ) : (
          <div className="surfacesEmpty">
            <strong>A pane is a place you come back to.</strong>
            <p>Dashboards, trackers, editors, games. Ares builds them live, sandboxed, with feeds the daemon keeps fresh while you are away.</p>
          </div>
        )}
      </section>
    </div>
  );
}
