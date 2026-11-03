// "Ares wanted to" — what unasked work would have done, held for the owner.
//
// Scheduled jobs an agent set up for itself and operator goals nobody
// authorized are recorded by the daemon's mandate gate (daemon/mandates.ts)
// instead of run. Each entry is answered once: approve once (run it now),
// approve always (a standing rule: it runs on its own from now on), or
// dismiss. The per-source switch picks off / observe / auto. Plain cards in
// the Background tab's own style; nothing animates or flashes.

export type ProactiveModeVm = "off" | "observe" | "auto";

export interface WantedItemVm {
  id: string;
  source: string;
  scope: string;
  wouldDo: string;
  because: string;
  lastAt: string;
  count: number;
}

export interface MandateVm {
  id: string;
  source: string;
  scope: string;
  may: string;
  grantedAt: string;
  grantedBy: { kind: string; messageId?: string; what?: string; at?: string; name?: string };
}

export interface MandatesVm {
  modes: Record<string, ProactiveModeVm>;
  wanted: WantedItemVm[];
  mandates: MandateVm[];
}

const SOURCE_LABEL: Record<string, string> = { jobs: "Scheduled jobs", operator: "Background goals" };
const MODE_HINT: Record<ProactiveModeVm, string> = {
  off: "never runs",
  observe: "asks first",
  auto: "runs on its own",
};

function grantLine(m: MandateVm): string {
  const g = m.grantedBy;
  if (g.kind === "owner_message") return "you said yes in chat";
  if (g.kind === "owner_created") return `${g.what ?? "you set it up"}${g.at ? `, ${new Date(g.at).toLocaleDateString()}` : ""}`;
  return g.name ?? "standing rule";
}

export function WantedList({ state, onDecide, onMode, onRevoke }: {
  state: MandatesVm | null;
  onDecide: (id: string, decision: "once" | "always" | "dismiss") => void;
  onMode: (source: string, mode: ProactiveModeVm) => void;
  onRevoke: (id: string) => void;
}) {
  if (!state) return null;
  const sources = Object.keys(state.modes);
  return (
    <>
      <div className="bgSection">Ares wanted to</div>
      {state.wanted.length === 0 ? (
        <div className="bgEmpty">Nothing waiting. When a job or goal wants to act without your go-ahead, it shows up here instead of running.</div>
      ) : state.wanted.map((w) => (
        <div className="bgCard" key={w.id} data-tone="warn">
          <div className="bgCardBody">
            <strong title={w.wouldDo}>{w.wouldDo}</strong>
            <span>because {w.because}{w.count > 1 ? ` · ${w.count} times` : ""} · {new Date(w.lastAt).toLocaleString()}</span>
          </div>
          <div className="bgCardActions">
            <button className="btn primary" onClick={() => onDecide(w.id, "once")} title="Run it this once">Once</button>
            <button className="btn ghost" onClick={() => onDecide(w.id, "always")} title="Let it run on its own from now on">Always</button>
            <button className="btn ghost" onClick={() => onDecide(w.id, "dismiss")} title="Don't run it, and don't ask again">Dismiss</button>
          </div>
        </div>
      ))}
      {sources.length > 0 ? (
        <div className="bgCard">
          <div className="bgCardBody">
            {sources.map((src) => (
              <label key={src} className="wantedMode">
                <span>{SOURCE_LABEL[src] ?? src}</span>
                <select value={state.modes[src]} onChange={(e) => onMode(src, e.target.value as ProactiveModeVm)}>
                  {(["off", "observe", "auto"] as const).map((m) => <option key={m} value={m}>{m} — {MODE_HINT[m]}</option>)}
                </select>
              </label>
            ))}
          </div>
        </div>
      ) : null}
      {state.mandates.length > 0 ? (
        <>
          <div className="bgSection">Allowed to run on its own</div>
          {state.mandates.slice(0, 20).map((m) => (
            <div className="bgCard" key={m.id}>
              <div className="bgCardBody">
                <strong title={m.may}>{m.may || m.scope}</strong>
                <span>{grantLine(m)}</span>
              </div>
              <div className="bgCardActions"><button className="btn ghost" onClick={() => onRevoke(m.id)} title="Stop it before its next run">Revoke</button></div>
            </div>
          ))}
        </>
      ) : null}
    </>
  );
}
