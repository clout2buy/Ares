// A surface inline in the transcript, under the reply that made it. The
// cheapest placement and the one used most: a chart, a form, a picker, a
// small game. Grows on request; a removed surface leaves a one-line stone.

import React, { useCallback, useState } from "react";
import { SurfaceHost } from "./SurfaceHost";
import { SurfaceChrome } from "./SurfaceChrome";
import { useSurfaces } from "./SurfacesContext";

export function SurfaceCard({ name }: { name: string }) {
  const api = useSurfaces();
  const vm = api.surfaces[name];
  const [tall, setTall] = useState(false);
  const onIntent = useCallback((text: string) => api.intent(name, text), [api, name]);
  const onFault = useCallback((message: string) => api.fault(name, message), [api, name]);
  const onCall = useCallback((callId: string, tool: string, input: unknown) => api.call(name, callId, tool, input), [api, name]);
  if (!vm) {
    return <div className="surfaceCard surfaceCardGone"><span>Surface “{name}” was removed.</span></div>;
  }
  if (vm.manifest.placement !== "card") {
    return (
      <div className="surfaceCard surfaceCardMoved">
        <span>“{vm.manifest.title}” now lives in the {vm.manifest.placement}.</span>
        <button onClick={() => api.open(name)}>Open</button>
      </div>
    );
  }
  return (
    <div className="surfaceCard" data-tall={tall ? "1" : "0"}>
      <SurfaceChrome vm={vm} compact extra={<button onClick={() => setTall((t) => !t)} title={tall ? "Smaller" : "Taller"}>{tall ? "▾" : "▴"}</button>} />
      <SurfaceHost name={name} document={vm.document} revision={vm.manifest.revision} morph={vm.morph} onIntent={onIntent} onFault={onFault} onCall={onCall} className="surfaceCardFrame" />
    </div>
  );
}
