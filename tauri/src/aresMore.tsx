// Scheduled jobs, cross-owner sharing, profiles and iPhone pairing — the
// Messages-surface panes for daemon/jobs.ts, daemon/sharing.ts and the
// directory's profiles.
import { useEffect, useState } from "react";
import type { AgentVm } from "./agents";
import { AgentAvatar } from "./agents";
import type { RoomVm } from "./rooms";
import { PersonFace, colorFor, type DirectoryProfileVm, type DirectoryVm } from "./people";
import { PhonePairCard, type PhonePairState } from "./PhonePair";
import "./aresMore.css";

// ─── Scheduled ────────────────────────────────────────────────────────────

export type JobScheduleVm =
  | { kind: "once"; at: string }
  | { kind: "every"; minutes: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; day: number; time: string };

export interface JobVm {
  id: string;
  agentId: string;
  title: string;
  task: string;
  roomId?: string;
  schedule: JobScheduleVm;
  status: "active" | "paused" | "done";
  nextRunAt?: string;
  lastRun?: { at: string; ok: boolean; note?: string; threadId?: string };
  runs: number;
  createdAt: string;
  createdBy: "owner" | "agent";
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const d = new Date();
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function describeJobSchedule(s: JobScheduleVm): string {
  if (s.kind === "once") return `Once · ${new Date(s.at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  if (s.kind === "every") return s.minutes % 1440 === 0 ? `Every ${s.minutes === 1440 ? "day" : `${s.minutes / 1440} days`}` : s.minutes % 60 === 0 ? (s.minutes === 60 ? "Every hour" : `Every ${s.minutes / 60} hours`) : `Every ${s.minutes} min`;
  if (s.kind === "daily") return `Every day at ${clock(s.time)}`;
  return `Every ${DAY_NAMES[s.day]} at ${clock(s.time)}`;
}

function relTime(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  const abs = Math.abs(ms);
  const label = abs < 60_000 ? "now" : abs < 3_600_000 ? `${Math.round(abs / 60_000)} min` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)} h` : new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  if (label === "now") return "now";
  if (abs >= 86_400_000) return label;
  return ms > 0 ? `in ${label}` : `${label} ago`;
}

const QUICK_WHEN: Array<{ label: string; when: string }> = [
  { label: "Every morning", when: "daily 9am" },
  { label: "Every evening", when: "daily 7pm" },
  { label: "Every hour", when: "hourly" },
  { label: "Mondays", when: "weekly mon 9am" },
  { label: "In 1 hour", when: "in 1h" },
];

export function ScheduledList({
  jobs,
  agents,
  photos,
  rooms,
  error,
  compact,
  onAdd,
  onChange,
  onOpenThread,
}: {
  jobs: JobVm[];
  agents: AgentVm[];
  photos: Record<string, string>;
  rooms: RoomVm[];
  error?: string;
  /** The Now tab's short version: active jobs only, no form until asked. */
  compact?: boolean;
  onAdd: (spec: { agentId: string; task: string; when: string; title?: string; roomId?: string }) => void;
  onChange: (id: string, action: "pause" | "resume" | "delete" | "run") => void;
  onOpenThread?: (threadId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [task, setTask] = useState("");
  const [when, setWhen] = useState("daily 9am");
  const [title, setTitle] = useState("");
  const [roomId, setRoomId] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => { if (!agentId && agents[0]) setAgentId(agents[0].id); }, [agents, agentId]);
  const shown = compact ? jobs.filter((j) => j.status === "active").slice(0, 4) : jobs;
  const agentOf = (id: string) => agents.find((a) => a.id === id) ?? null;
  return (
    <div className="jobsList" data-compact={compact ? "1" : "0"}>
      {shown.length === 0 && !adding ? (
        <p className="nowQuiet">{agents.length ? "Nothing scheduled. Ask an agent for something every morning, or add a job here." : "Make an agent first — jobs run as one of your agents."}</p>
      ) : null}
      {shown.map((j) => {
        const a = agentOf(j.agentId);
        const room = j.roomId ? rooms.find((r) => r.id === j.roomId) : undefined;
        return (
          <div key={j.id} className="jobRow" data-status={j.status}>
            <AgentAvatar agent={a} size={compact ? 30 : 36} photo={a ? photos[a.id] : undefined} />
            <div className="jobText">
              <strong>{j.title}</strong>
              <span>{describeJobSchedule(j.schedule)}{room ? ` · posts in ${room.name}` : ""}{j.createdBy === "agent" ? ` · set by ${a?.name ?? "agent"}` : ""}</span>
              <em>
                {j.status === "paused" ? "Paused" : j.status === "done" ? `Done${j.lastRun ? ` · ran ${relTime(j.lastRun.at)}` : ""}` : j.nextRunAt ? `Next ${relTime(j.nextRunAt)}` : ""}
                {j.lastRun && j.status !== "done" ? ` · last ${relTime(j.lastRun.at)}${j.lastRun.ok ? "" : " (couldn't run)"}` : ""}
              </em>
            </div>
            <div className="jobBtns">
              {j.lastRun?.threadId && onOpenThread ? <button className="jobBtn" onClick={() => onOpenThread(j.lastRun!.threadId!)} title="Open the chat it ran in">Open</button> : null}
              <button className="jobBtn" onClick={() => onChange(j.id, "run")} title="Run it now">Run now</button>
              {j.status === "active" ? <button className="jobBtn" onClick={() => onChange(j.id, "pause")}>Pause</button> : j.status === "paused" ? <button className="jobBtn" onClick={() => onChange(j.id, "resume")}>Resume</button> : null}
              {compact ? null : confirm === j.id
                ? <button className="jobBtn jobDanger" onClick={() => { setConfirm(null); onChange(j.id, "delete"); }}>Delete it</button>
                : <button className="jobBtn" onClick={() => setConfirm(j.id)}>Delete</button>}
            </div>
          </div>
        );
      })}
      {error ? <p className="agentSheetErr">{error}</p> : null}
      {adding ? (
        <div className="jobAdd">
          <label className="agentField"><span>Who does it</span>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.emoji ? `${a.emoji} ` : ""}{a.name}</option>)}
            </select>
          </label>
          <label className="agentField"><span>What to do each time</span>
            <textarea rows={3} value={task} placeholder="Check Hacker News for anything about AI agents and send me the top 3 with one line each." onChange={(e) => setTask(e.target.value)} />
          </label>
          <div className="jobQuick">
            {QUICK_WHEN.map((q) => <button key={q.when} data-on={when === q.when ? "1" : "0"} onClick={() => setWhen(q.when)}>{q.label}</button>)}
          </div>
          <div className="agentFieldRow">
            <label className="agentField"><span>When</span><input value={when} spellCheck={false} placeholder="daily 9am · every 30m · weekly fri 5pm · in 2h" onChange={(e) => setWhen(e.target.value)} /></label>
            <label className="agentField"><span>Post results in</span>
              <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                <option value="">Their chat with me</option>
                {rooms.map((r) => <option key={r.id} value={r.id}>{r.emoji ? `${r.emoji} ` : ""}{r.name}</option>)}
              </select>
            </label>
          </div>
          <label className="agentField"><span>Name (optional)</span><input value={title} maxLength={80} placeholder="Morning AI brief" onChange={(e) => setTitle(e.target.value)} /></label>
          <div className="wsKeyBtns">
            <button className="agentGhost" onClick={() => setAdding(false)}>Cancel</button>
            <button className="agentPrimary" disabled={!agentId || !task.trim() || !when.trim()} onClick={() => { onAdd({ agentId, task: task.trim(), when: when.trim(), ...(title.trim() ? { title: title.trim() } : {}), ...(roomId ? { roomId } : {}) }); setAdding(false); setTask(""); setTitle(""); }}>Schedule it</button>
          </div>
        </div>
      ) : agents.length ? (
        <button className="roomNew jobNew" onClick={() => setAdding(true)}><span>+</span> New scheduled job</button>
      ) : null}
    </div>
  );
}

export function ScheduledPane(props: Parameters<typeof ScheduledList>[0]) {
  return (
    <div className="settingsPane">
      <h3 className="paneTitle">Scheduled</h3>
      <p className="paneHint">Jobs your agents run on a timer — a morning brief, an hourly check, a weekly recap in a room. Agents can schedule their own when you ask ("every morning…"); everything they set shows up here, and you can pause or delete any of it.</p>
      <ScheduledList {...props} />
    </div>
  );
}

// ─── Sharing with other people's agents ──────────────────────────────────

export interface ShareItemVm {
  id: string;
  kind: "lesson" | "skill";
  text: string;
  skill?: string;
  roomId: string;
  roomName: string;
  fromAgent: string;
  fromOwner?: string;
  at: string;
}
export interface SharingVm {
  settings: { give: boolean; take: boolean };
  inbox: ShareItemVm[];
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className="iosToggle" role="switch" aria-checked={on} aria-label={label} data-on={on ? "1" : "0"} onClick={() => onChange(!on)}><span /></button>;
}

export function SharingPanel({
  sharing,
  agents,
  rooms,
  error,
  onSet,
  onAccept,
  onReject,
}: {
  sharing: SharingVm;
  agents: AgentVm[];
  rooms: RoomVm[];
  error?: string;
  onSet: (patch: { give?: boolean; take?: boolean }) => void;
  onAccept: (id: string, agentIds?: string[]) => void;
  onReject: (id: string) => void;
}) {
  const [pick, setPick] = useState<Record<string, string>>({});
  return (
    <section className="shareBox">
      <div className="shareHead">
        <strong>Learning from other people's agents</strong>
        <span>In a room, agents can pass each other a lesson or a skill. Both sides have to allow it, and nothing reaches your agents until you approve it here.</span>
      </div>
      <div className="setRows">
        <div className="setRow">
          <div><strong>Let my agents share</strong><span>They can teach a room a lesson or one of your skills (the skill's instructions only, never code or your files).</span></div>
          <Toggle label="Let my agents share" on={sharing.settings.give} onChange={(v) => onSet({ give: v })} />
        </div>
        <div className="setRow">
          <div><strong>Take shares from others</strong><span>Lessons and skills other people's agents share land below for you to approve.</span></div>
          <Toggle label="Take shares from others" on={sharing.settings.take} onChange={(v) => onSet({ take: v })} />
        </div>
      </div>
      {sharing.inbox.length ? (
        <div className="shareInbox">
          {sharing.inbox.map((it) => {
            const room = rooms.find((r) => r.id === it.roomId);
            const inRoom = room ? agents.filter((a) => room.members.some((m) => m.kind === "agent" && m.id === a.id && (m.home ?? "local") === "local")) : [];
            const who = pick[it.id] ?? "";
            return (
              <div key={it.id} className="shareItem" data-kind={it.kind}>
                <span className="shareIcon" aria-hidden="true">{it.kind === "lesson" ? "📘" : "🧩"}</span>
                <div className="shareText">
                  <strong>{it.kind === "lesson" ? it.text : <>Skill <code>{it.skill}</code>{it.text ? ` — ${it.text}` : ""}</>}</strong>
                  <span>from {it.fromAgent}{it.fromOwner ? ` (${it.fromOwner}'s agent)` : ""} in {it.roomName}</span>
                </div>
                <div className="shareBtns">
                  {it.kind === "lesson" ? (
                    <select value={who} onChange={(e) => setPick((p) => ({ ...p, [it.id]: e.target.value }))} title="Who learns it">
                      <option value="">{inRoom.length ? `Agents in ${it.roomName}` : "All my agents"}</option>
                      {agents.map((a) => <option key={a.id} value={a.id}>{a.name} only</option>)}
                    </select>
                  ) : null}
                  <button className="agentPrimary" onClick={() => onAccept(it.id, who ? [who] : undefined)}>{it.kind === "lesson" ? "Teach" : "Install"}</button>
                  <button className="agentGhost" onClick={() => onReject(it.id)}>Dismiss</button>
                </div>
              </div>
            );
          })}
        </div>
      ) : sharing.settings.take ? <p className="shareEmpty">Nothing waiting. Shares from other people's agents show up here.</p> : null}
      {error ? <p className="agentSheetErr">{error}</p> : null}
    </section>
  );
}

// ─── Profiles ────────────────────────────────────────────────────────────

const FACE_EMOJI = ["😎", "🦊", "🐺", "🦁", "🐉", "👾", "🤖", "🧠", "⚡", "🔥", "🌙", "🎮", "🎧", "🛠️", "🚀", "🌊"];
const FACE_COLORS = ["#0a84ff", "#ff7a1a", "#30d158", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a", "#ff9f0a", "#5e5ce6", "#8e8e93"];

export function ProfilePane({
  directory,
  agents,
  photos,
  onSave,
  onOpenPeople,
}: {
  directory: DirectoryVm;
  agents: AgentVm[];
  photos: Record<string, string>;
  onSave: (patch: { displayName?: string; bio?: string; shownAgents?: string[]; emoji?: string; color?: string }) => void;
  onOpenPeople: () => void;
}) {
  const [name, setName] = useState(directory.displayName ?? "");
  const [bio, setBio] = useState(directory.bio ?? "");
  const [emoji, setEmoji] = useState(directory.emoji ?? "");
  const [color, setColor] = useState(directory.color ?? "");
  useEffect(() => { setName(directory.displayName ?? ""); setBio(directory.bio ?? ""); setEmoji(directory.emoji ?? ""); setColor(directory.color ?? ""); }, [directory.displayName, directory.bio, directory.emoji, directory.color]);
  if (!directory.connected || !directory.username) {
    return (
      <div className="settingsPane">
        <h3 className="paneTitle">Your profile</h3>
        <p className="paneHint">Claim a username first — it's how people find you, message you and invite you into rooms. No email, no sign-up.</p>
        <button className="agentPrimary profileClaim" onClick={onOpenPeople}>Claim a username</button>
      </div>
    );
  }
  const dirty = name !== (directory.displayName ?? "") || bio !== (directory.bio ?? "") || emoji !== (directory.emoji ?? "") || color !== (directory.color ?? "");
  const shown = agents.filter((a) => directory.shownAgents.includes(a.id));
  return (
    <div className="settingsPane profilePane">
      <div className="profileHero" style={{ ["--agent" as string]: color || colorFor(directory.username) }}>
        <PersonFace name={name || directory.username} username={directory.username} size={84} online={directory.online} emoji={emoji || undefined} color={color || undefined} />
        <strong>{name || directory.username}</strong>
        <em>@{directory.username} · {directory.online ? "online" : "offline"}</em>
        {bio ? <p>{bio}</p> : null}
        {shown.length ? (
          <div className="profileAgents">
            {shown.map((a) => <span key={a.id} className="profileAgent"><AgentAvatar agent={a} size={34} photo={photos[a.id]} /><b>{a.name}</b></span>)}
          </div>
        ) : null}
      </div>
      <p className="paneHint">This is what people see when they find you. Only what's here leaves your computer — never your files, chats or address.</p>
      <div className="setRows">
        <label className="agentField"><span>Name</span><input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
        <label className="agentField"><span>About you</span><input value={bio} maxLength={160} placeholder="building a game studio with my agents" onChange={(e) => setBio(e.target.value)} /></label>
        <div className="agentField"><span>Face</span>
          <div className="faceGrid">
            <button data-on={emoji === "" ? "1" : "0"} onClick={() => setEmoji("")} title="Initials">Aa</button>
            {FACE_EMOJI.map((e) => <button key={e} data-on={emoji === e ? "1" : "0"} onClick={() => setEmoji(e)}>{e}</button>)}
          </div>
          <div className="colorRow">
            {FACE_COLORS.map((c) => <button key={c} aria-label={c} data-on={color === c ? "1" : "0"} style={{ background: c }} onClick={() => setColor(c)} />)}
          </div>
        </div>
        <div className="agentField"><span>Agents on your profile</span>
          <div className="profilePick">
            {agents.length === 0 ? <em>No agents yet.</em> : agents.map((a) => {
              const on = directory.shownAgents.includes(a.id);
              return (
                <button key={a.id} className="roomPick" data-on={on ? "1" : "0"} onClick={() => onSave({ shownAgents: on ? directory.shownAgents.filter((x) => x !== a.id) : [...directory.shownAgents, a.id] })}>
                  <AgentAvatar agent={a} size={22} photo={photos[a.id]} /> {a.name}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="wsKeyBtns">
        <button className="agentPrimary" disabled={!dirty || !name.trim()} onClick={() => onSave({ displayName: name.trim(), bio, emoji, color })}>Save profile</button>
      </div>
    </div>
  );
}

export function ProfileSheet({
  user,
  loading,
  error,
  isMe,
  onMessage,
  onClose,
}: {
  user: DirectoryProfileVm | null;
  loading: boolean;
  error?: string;
  isMe?: boolean;
  onMessage: (username: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="scrim center" onClick={onClose}>
      <div className="profileSheet" onClick={(e) => e.stopPropagation()}>
        <button className="profileX" onClick={onClose} aria-label="Close">×</button>
        {loading && !user ? <p className="nowQuiet">Loading…</p> : null}
        {error ? <p className="agentSheetErr">{error}</p> : null}
        {user ? (
          <>
            <div className="profileHero" style={{ ["--agent" as string]: user.color ?? colorFor(user.username) }}>
              <PersonFace name={user.displayName} username={user.username} size={88} online={user.online} emoji={user.emoji} color={user.color} />
              <strong>{user.displayName}</strong>
              <em>@{user.username} · {user.online ? "online now" : `seen ${new Date(user.lastSeenAt).toLocaleDateString([], { month: "short", day: "numeric" })}`}</em>
              {user.bio ? <p>{user.bio}</p> : null}
            </div>
            {user.agents.length ? (
              <div className="profileAgentList">
                <h4>{isMe ? "Your agents" : `${user.displayName.split(" ")[0]}'s agents`}</h4>
                {user.agents.map((a) => (
                  <div key={a.name} className="profileAgentRow">
                    <span className="profileAgentFace" style={{ ["--agent" as string]: a.color ?? colorFor(`${user.username}:${a.name}`) }}>{a.emoji ?? a.name.slice(0, 1)}</span>
                    <div><strong>{a.name}</strong>{a.role ? <span>{a.role}</span> : null}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {isMe ? null : (
              <div className="profileActions">
                <button className="agentPrimary" onClick={() => onMessage(user.username)}>Message</button>
              </div>
            )}
            {!user.reachable && !isMe ? <p className="shareEmpty">They can join rooms you host, but can't host one yet.</p> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── iPhone ──────────────────────────────────────────────────────────────

export function IPhonePane({ state, devices, onPair, onClose, onUnpair }: {
  state: PhonePairState;
  devices: Array<{ id: string; label: string; detail?: string }>;
  onPair: () => void;
  onClose: () => void;
  onUnpair: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <div className="settingsPane iphonePane">
      <h3 className="paneTitle">iPhone</h3>
      <p className="paneHint">The Ares app on your iPhone talks straight to this computer — your agents, rooms, feed and scheduled jobs in your pocket. No outside server holds your chats.</p>
      <PhonePairCard state={state} onPair={onPair} onClose={onClose} />
      {devices.length ? (
        <div className="setRows">
          {devices.map((d) => (
            <div key={d.id} className="setRow">
              <div><strong>📱 {d.label}</strong>{d.detail ? <span>{d.detail}</span> : null}</div>
              {confirm === d.id
                ? <button className="agentDanger" onClick={() => { setConfirm(null); onUnpair(d.id); }}>Unpair</button>
                : <button className="agentGhost" onClick={() => setConfirm(d.id)}>Unpair</button>}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
