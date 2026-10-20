// Settings → Workspaces: the owner's VPS boxes their agents work on
// (daemon/workspaces.ts). Add one in three steps — address, paste Ares's key
// into the box, test — then pick which agents use it (rooms pick theirs in
// room settings).
import { useState } from "react";
import type { AgentVm } from "./agents";
import { AgentAvatar } from "./agents";

export interface WorkspaceVm {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
  publicKey: string;
  status: "new" | "ok" | "error";
  info?: string;
  error?: string;
  setUp?: boolean;
  addedAt: string;
  checkedAt?: string;
}

export function WorkspacesPane({
  workspaces,
  busy,
  error,
  agents,
  photos,
  onAdd,
  onTest,
  onSetup,
  onRemove,
  onAgentWorkspace,
}: {
  workspaces: WorkspaceVm[];
  /** id → what is running ("test" | "setup"). */
  busy: Record<string, string>;
  error?: string;
  agents: AgentVm[];
  photos: Record<string, string>;
  onAdd: (spec: { label: string; host: string; user: string; port: number }) => void;
  onTest: (id: string) => void;
  onSetup: (id: string) => void;
  onRemove: (id: string) => void;
  onAgentWorkspace: (agentId: string, workspaceId: string) => void;
}) {
  const [adding, setAdding] = useState(workspaces.length === 0);
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("root");
  const [port, setPort] = useState(22);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const copy = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(null), 1600); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="settingsPane wsPane">
      <h3 className="paneTitle">Workspaces</h3>
      <p className="paneHint">A VPS your agents work on: heavy builds, long-running game servers, bots other people reach — none of it on this PC. Ares makes its own key for each box; you never type a password here.</p>

      {workspaces.map((w) => (
        <div key={w.id} className="wsCard" data-status={w.status}>
          <div className="wsCardTop">
            <span className="wsDot" data-status={busy[w.id] ? "busy" : w.status} />
            <div className="wsCardText">
              <strong>{w.label}</strong>
              <em>{w.user}@{w.host}{w.port !== 22 ? `:${w.port}` : ""}</em>
            </div>
            <div className="wsCardBtns">
              <button className="agentGhost" disabled={Boolean(busy[w.id])} onClick={() => onTest(w.id)}>{busy[w.id] === "test" ? "Testing…" : "Test"}</button>
              <button className="agentPrimary" disabled={Boolean(busy[w.id]) || w.status !== "ok"} onClick={() => onSetup(w.id)} title={w.status !== "ok" ? "Test the connection first" : "Make a work folder and install git, Node and Python"}>{busy[w.id] === "setup" ? "Setting up…" : w.setUp ? "Set up again" : "Set up"}</button>
            </div>
          </div>
          {w.status === "ok" ? <p className="wsInfo">{w.info}{w.setUp ? " · ready for agents" : " · press Set up to get it ready"}</p> : null}
          {w.status === "error" && w.error ? <p className="wsError">{w.error}</p> : null}
          {w.status !== "ok" ? (
            <div className="wsKey">
              <span>Add this key to the box — in your provider's panel under <b>SSH keys</b> (Hetzner, DigitalOcean, Vultr all have it), or on the box itself:</span>
              <code>{w.publicKey}</code>
              <div className="wsKeyBtns">
                <button className="agentGhost" onClick={() => void copy(w.id, w.publicKey)}>{copied === w.id ? "Copied" : "Copy key"}</button>
                <button className="agentGhost" onClick={() => void copy(`${w.id}-cmd`, `mkdir -p ~/.ssh && echo '${w.publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`)}>{copied === `${w.id}-cmd` ? "Copied" : "Copy as a command"}</button>
              </div>
              <span className="wsSmall">Then press Test.</span>
            </div>
          ) : null}
          <div className="wsFoot">
            {confirmRemove === w.id
              ? <button className="agentDanger" onClick={() => { setConfirmRemove(null); onRemove(w.id); }}>Remove {w.label} and its key</button>
              : <button className="wsRemove" onClick={() => setConfirmRemove(w.id)}>Remove</button>}
          </div>
        </div>
      ))}

      {adding ? (
        <div className="wsCard wsAdd">
          <strong>Add a VPS</strong>
          <span className="wsSmall">Rent any Linux box (Ubuntu 24.04 is easiest — a 4 GB Hetzner CX22 is plenty). Then:</span>
          <div className="agentFieldRow">
            <label className="agentField"><span>Address (IP)</span><input value={host} placeholder="203.0.113.7" spellCheck={false} onChange={(e) => setHost(e.target.value.trim())} /></label>
            <label className="agentField" style={{ maxWidth: 120 }}><span>User</span><input value={user} spellCheck={false} onChange={(e) => setUser(e.target.value.trim())} /></label>
            <label className="agentField" style={{ maxWidth: 90 }}><span>Port</span><input value={port} inputMode="numeric" onChange={(e) => setPort(Number(e.target.value.replace(/\D/g, "")) || 22)} /></label>
          </div>
          <label className="agentField"><span>Name it</span><input value={label} placeholder="Game box" maxLength={40} onChange={(e) => setLabel(e.target.value)} /></label>
          <div className="wsKeyBtns">
            {workspaces.length ? <button className="agentGhost" onClick={() => setAdding(false)}>Cancel</button> : null}
            <button className="agentPrimary" disabled={!host} onClick={() => { onAdd({ label: label.trim() || host, host, user: user || "root", port }); setAdding(false); setHost(""); setLabel(""); }}>Make a key for it</button>
          </div>
        </div>
      ) : (
        <button className="roomNew wsAddBtn" onClick={() => setAdding(true)}><span>+</span> Add a VPS</button>
      )}

      {error ? <p className="agentSheetErr">{error}</p> : null}

      {workspaces.length && agents.length ? (
        <>
          <h3 className="paneTitle">Who works where</h3>
          <p className="paneHint">An agent's own box, used in its chats. A room can pick its own box in room settings — that one wins for the room's work.</p>
          <div className="wsAgents">
            {agents.map((a) => (
              <label key={a.id} className="wsAgentRow">
                <AgentAvatar agent={a} size={30} photo={photos[a.id]} />
                <span>{a.name}</span>
                <select value={a.workspaceId ?? ""} onChange={(e) => onAgentWorkspace(a.id, e.target.value)}>
                  <option value="">{workspaces.length === 1 ? `${workspaces[0]!.label} (the only one)` : "None"}</option>
                  {workspaces.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                </select>
              </label>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
