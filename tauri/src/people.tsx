// People — discovery. Owner, 2026-10-19: "search people as a sort of
// discovery in Ares… create a username, look other people up, message them
// or group chat, or users' agents can talk to each other."
//
// One sheet: your username (claim it once; it belongs to this Ares), a
// search field, and the people it finds — each with Message (a two-person
// room hosted here, invite relayed) and Invite to a room. Invites that reach
// YOU show as cards in the rail; accepting is the ordinary join.
import { useEffect, useRef, useState } from "react";
import { AgentAvatar, type AgentVm } from "./agents";
import { initials, type RoomVm } from "./rooms";
import "./people.css";

export interface DirectoryAgentVm { name: string; emoji?: string; color?: string; role?: string }
export interface DirectoryProfileVm {
  username: string;
  displayName: string;
  bio?: string;
  agents: DirectoryAgentVm[];
  online: boolean;
  reachable: boolean;
  lastSeenAt: string;
}
export interface DirectoryInviteVm {
  seq: number;
  id: string;
  at: string;
  from: { username: string; displayName: string };
  kind: "room" | "dm";
  link: string;
  roomName: string;
  text?: string;
  acked?: boolean;
}
export interface DirectoryVm {
  url: string;
  username?: string;
  displayName?: string;
  shownAgents: string[];
  bio?: string;
  connected: boolean;
  online: boolean;
  error?: string;
  inbox: DirectoryInviteVm[];
}

const PALETTE = ["#0a84ff", "#ff7a1a", "#30d158", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a", "#ff9f0a"];
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const colorFor = (key: string) => PALETTE[hashOf(key) % PALETTE.length]!;

export function PersonFace({ name, username, size = 36, online }: { name: string; username: string; size?: number; online?: boolean }) {
  return (
    <span className="peopleFace" data-online={online ? "1" : "0"} style={{ width: size, height: size, fontSize: Math.round(size * 0.4), ["--agent" as string]: colorFor(username) }} title={`@${username}`}>
      {initials(name)}
    </span>
  );
}

export function PeopleSheet({
  directory,
  agents,
  photos,
  rooms,
  results,
  searching,
  error,
  busy,
  onSearch,
  onClaim,
  onProfile,
  onMessage,
  onInvite,
  onUrl,
  onClose,
}: {
  directory: DirectoryVm;
  agents: AgentVm[];
  photos: Record<string, string>;
  rooms: RoomVm[];
  results: DirectoryProfileVm[];
  searching: boolean;
  error?: string;
  busy?: boolean;
  onSearch: (q: string) => void;
  onClaim: (username: string, displayName: string) => void;
  onProfile: (patch: { displayName?: string; bio?: string; shownAgents?: string[] }) => void;
  onMessage: (username: string, text: string) => void;
  onInvite: (username: string, roomId: string) => void;
  onUrl: (url: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [username, setUsername] = useState(directory.username ?? "");
  const [displayName, setDisplayName] = useState(directory.displayName ?? "");
  const [bio, setBio] = useState(directory.bio ?? "");
  const [editing, setEditing] = useState(!directory.connected);
  const [inviteFor, setInviteFor] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [url, setUrl] = useState(directory.url);
  const [showUrl, setShowUrl] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const nameOk = /^[a-z0-9_]{3,24}$/.test(username.trim().toLowerCase());
  useEffect(() => { setUsername(directory.username ?? ""); setDisplayName(directory.displayName ?? ""); setBio(directory.bio ?? ""); if (directory.connected) setEditing(false); }, [directory.username, directory.displayName, directory.bio, directory.connected]);
  useEffect(() => { const t = setTimeout(() => onSearch(q), 220); return () => clearTimeout(t); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [q]);
  useEffect(() => { requestAnimationFrame(() => (directory.connected ? searchRef.current : null)?.focus()); }, [directory.connected]);
  const myRooms = rooms.filter((r) => !r.remote);
  return (
    <div className="agentScrim" onClick={onClose}>
      <div className="agentSheet peopleSheet" role="dialog" aria-label="People" onClick={(e) => e.stopPropagation()}>
        <header className="agentSheetHead">
          <div>
            <h3>People</h3>
            <p>Find anyone on Ares by username. Message them, pull them into a room, or let your agents and theirs work together — every agent stays on its owner's machine.</p>
          </div>
          <button className="agentClose" onClick={onClose} aria-label="Close">×</button>
        </header>

        <section className="peopleMe" data-on={directory.connected ? "1" : "0"}>
          {directory.connected && !editing ? (
            <div className="peopleMeRow">
              <PersonFace name={directory.displayName ?? directory.username ?? "?"} username={directory.username ?? "me"} size={40} online={directory.online} />
              <div className="peopleMeText">
                <strong>{directory.displayName ?? directory.username}</strong>
                <em>@{directory.username} · {directory.online ? "online" : directory.error ? "can't reach the directory" : "connecting…"}</em>
                {directory.bio ? <span>{directory.bio}</span> : null}
              </div>
              <button className="agentGhost" onClick={() => setEditing(true)}>Edit</button>
            </div>
          ) : (
            <div className="peopleClaim">
              <div className="agentFieldRow">
                <label className="agentField">
                  <span>Username</span>
                  <input value={username} maxLength={24} placeholder="crix" spellCheck={false} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} />
                  {username && !nameOk ? <em className="agentFieldErr">3–24 letters, digits or _</em> : null}
                </label>
                <label className="agentField">
                  <span>Shown as</span>
                  <input value={displayName} maxLength={40} placeholder="Crix" onChange={(e) => setDisplayName(e.target.value)} />
                </label>
              </div>
              <label className="agentField">
                <span>One line about you (optional)</span>
                <input value={bio} maxLength={160} placeholder="building a web agency with my agents" onChange={(e) => setBio(e.target.value)} />
              </label>
              <div className="agentField">
                <span>Agents on your profile</span>
                <div className="roomPickGrid">
                  {agents.length === 0 ? <em className="roomPanelWhy">No agents yet — your profile just shows you.</em> : agents.map((a) => (
                    <button key={a.id} className="roomPick" data-on={directory.shownAgents.includes(a.id) ? "1" : "0"} onClick={() => onProfile({ shownAgents: directory.shownAgents.includes(a.id) ? directory.shownAgents.filter((x) => x !== a.id) : [...directory.shownAgents, a.id] })}>
                      <AgentAvatar agent={a} size={26} photo={photos[a.id]} /><span>{a.name}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="peopleClaimFoot">
                <button className="peopleUrlToggle" onClick={() => setShowUrl((v) => !v)}>{showUrl ? "Hide directory address" : "Directory address"}</button>
                <div>
                  {directory.connected ? <button className="agentGhost" onClick={() => setEditing(false)}>Cancel</button> : null}
                  <button className="agentPrimary" disabled={!nameOk || busy} onClick={() => { if (directory.connected && username.trim().toLowerCase() === directory.username) onProfile({ displayName: displayName.trim(), bio }); else onClaim(username.trim().toLowerCase(), displayName.trim()); }}>
                    {busy ? "Saving…" : directory.connected ? "Save" : "Claim username"}
                  </button>
                </div>
              </div>
              {showUrl ? (
                <div className="peopleUrl">
                  <input value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} placeholder="https://people.example.com" />
                  <button className="agentGhost" disabled={url.trim() === directory.url} onClick={() => onUrl(url.trim())}>Use</button>
                </div>
              ) : null}
            </div>
          )}
          {directory.error ? <p className="agentSheetErr">{directory.error}</p> : null}
        </section>

        {error ? <p className="agentSheetErr">{error}</p> : null}

        <section className="peopleSearch">
          <input ref={searchRef} className="peopleSearchField" value={q} placeholder={directory.connected ? "Search by username or name…" : "Claim a username to search"} disabled={!directory.connected} onChange={(e) => setQ(e.target.value)} />
          {!directory.connected ? null : searching ? <p className="roomPanelWhy">Looking…</p> : results.length === 0 ? (
            <p className="roomPanelWhy">{q.trim() ? `Nobody called "${q.trim()}" yet.` : "Everyone on this directory shows here. Type to narrow."}</p>
          ) : (
            <div className="peopleList">
              {results.map((p) => (
                <div key={p.username} className="peopleRow">
                  <PersonFace name={p.displayName} username={p.username} size={40} online={p.online} />
                  <div className="peopleRowText">
                    <strong>{p.displayName} <em>@{p.username}</em></strong>
                    <span>{p.bio ? p.bio : p.online ? "online now" : `seen ${new Date(p.lastSeenAt).toLocaleDateString([], { month: "short", day: "numeric" })}`}{!p.reachable ? " · can't host rooms yet" : ""}</span>
                    {p.agents.length ? (
                      <div className="peopleAgents">
                        {p.agents.slice(0, 6).map((a) => (
                          <span key={a.name} className="peopleAgentChip" style={{ ["--agent" as string]: a.color ?? colorFor(`${p.username}:${a.name}`) }} title={a.role ?? a.name}>{a.emoji ? `${a.emoji} ` : ""}{a.name}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="peopleRowBtns">
                    {inviteFor === p.username ? (
                      <select autoFocus onChange={(e) => { if (e.target.value) { onInvite(p.username, e.target.value); setInviteFor(null); } }} onBlur={() => setInviteFor(null)} defaultValue="">
                        <option value="">Which room?</option>
                        {myRooms.map((r) => <option key={r.id} value={r.id}>{r.emoji ? `${r.emoji} ` : ""}{r.name}</option>)}
                      </select>
                    ) : (
                      <>
                        <input className="peopleNote" value={note[p.username] ?? ""} placeholder="say hi…" maxLength={300} onChange={(e) => setNote((n) => ({ ...n, [p.username]: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") { onMessage(p.username, note[p.username] ?? ""); setNote((n) => ({ ...n, [p.username]: "" })); } }} />
                        <button className="agentPrimary peopleMsg" disabled={busy} onClick={() => { onMessage(p.username, note[p.username] ?? ""); setNote((n) => ({ ...n, [p.username]: "" })); }}>Message</button>
                        {myRooms.length ? <button className="agentGhost" onClick={() => setInviteFor(p.username)} title="Invite them (and their agents) to one of your rooms">Invite</button> : null}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** An invite that reached you: a card in the rail. */
export function InviteCard({ item, onAccept, onDismiss }: { item: DirectoryInviteVm; onAccept: () => void; onDismiss: () => void }) {
  return (
    <div className="inviteCard">
      <PersonFace name={item.from.displayName} username={item.from.username} size={34} online />
      <div className="inviteCardText">
        <strong>{item.from.displayName} <em>@{item.from.username}</em></strong>
        <span>{item.kind === "dm" ? "wants to message you" : <>invited you to <b>{item.roomName}</b></>}</span>
        {item.text ? <q>{item.text}</q> : null}
      </div>
      <div className="inviteCardBtns">
        <button className="agentPrimary" onClick={onAccept}>{item.kind === "dm" ? "Open" : "Join"}</button>
        <button className="agentGhost" onClick={onDismiss} aria-label="Dismiss">×</button>
      </div>
    </div>
  );
}
