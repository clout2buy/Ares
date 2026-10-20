// Rooms — group chats of people and agents, iMessage-style.
//
// Owner, 2026-10-19: "group chats through users too… invite OhCupid… watch
// them talk / intervene… gotta feel like iMessage."
//
// A room is one thread with any mix of members: you, your agents, and —
// after an invite — another person and their agents (who run on THEIR
// machine; only messages travel). The thread reads like Messages: you in
// blue on the right, everyone else on the left with a face and a name, quiet
// centred lines for what the room itself did. A job board rides beside it so
// a team's state is visible without asking, and every agent of yours has a
// pause/mute/recall that nobody else can touch.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AgentAvatar, AgentFace, type AgentVm } from "./agents";
import "./rooms.css";

export interface RoomMemberVm {
  kind: "agent" | "person";
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  home: string;
  owner?: string;
  muted?: boolean;
  joinedAt: string;
}
export interface RoomJobVm {
  id: string;
  title: string;
  owner?: string;
  status: "todo" | "working" | "blocked" | "review" | "done";
  due?: string;
  links: string[];
  note?: string;
  updatedAt: string;
  by: string;
}
export interface RoomRulesVm {
  turns: "mention" | "round" | "free";
  maxAgentRun: number;
  paused: boolean;
  checkinMinutes: number;
  lead?: string;
}
export interface RoomVm {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  purpose: string;
  members: RoomMemberVm[];
  rules: RoomRulesVm;
  board: RoomJobVm[];
  notes: string;
  remote: boolean;
  invites: Array<{ code: string; label?: string; createdAt: string; usedBy?: string }>;
  guests: Array<{ id: string; name: string; joinedAt: string; lastSeenAt?: string }>;
  threads: Record<string, string>;
  workThreads?: Record<string, string>;
  /** The VPS this install's agents use for the room. */
  workspaceId?: string;
  seq: number;
  folder: string;
  createdAt: string;
  updatedAt: string;
}
export interface RoomMessageVm {
  seq: number;
  id: string;
  at: string;
  from: { kind: "agent" | "person" | "system"; id: string; name: string; home?: string };
  text: string;
  kind: "text" | "system" | "job" | "note";
}
export interface RoomsMeVm {
  id: string;
  name: string;
}

export const ROOM_EMOJI = ["⚡", "🛰️", "🔥", "🧠", "🚀", "🎯", "🌊", "🛠️", "🎨", "📈", "🧪", "🦾", "🏢", "🎮", "📰", "🤝"];
export const ROOM_COLORS = ["#0a84ff", "#ff7a1a", "#30d158", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a", "#ff9f0a"];
const JOB_STATUSES: Array<RoomJobVm["status"]> = ["todo", "working", "blocked", "review", "done"];
const STATUS_LABEL: Record<RoomJobVm["status"], string> = { todo: "To do", working: "Working", blocked: "Blocked", review: "In review", done: "Done" };

export const memberKey = (m: Pick<RoomMemberVm, "kind" | "id" | "home">) => `${m.kind}:${m.home}:${m.id}`;
const fromKey = (f: RoomMessageVm["from"]) => `${f.kind}:${f.home ?? "local"}:${f.id}`;
const isMine = (f: RoomMessageVm["from"]) => f.kind === "person" && (f.home ?? "local") === "local";

function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const paletteFor = (key: string) => ROOM_COLORS[hashOf(key) % ROOM_COLORS.length]!;

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

export function roomTime(iso: string | undefined): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const now = new Date();
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(t)) / 86_400_000);
  if (diff <= 0) return t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diff === 1) return "Yesterday";
  if (diff < 7) return t.toLocaleDateString([], { weekday: "long" });
  return t.toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" });
}
function dayLabel(iso: string): string {
  const t = new Date(iso);
  const now = new Date();
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(t)) / 86_400_000);
  const time = t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diff <= 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  return `${t.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

/** A member's face: the owner's agents wear their real face (photo or living
 *  face), everyone else their initials on their colour. */
export function MemberAvatar({ member, agents, size = 30, busy, photo }: { member: RoomMemberVm | undefined; agents: AgentVm[]; size?: number; busy?: boolean; photo?: string }) {
  if (!member) return <span className="roomFace" style={{ width: size, height: size, ["--agent" as string]: "#8e8e93" }}>?</span>;
  const local = member.kind === "agent" && member.home === "local" ? agents.find((a) => a.id === member.id) : undefined;
  if (local) return <AgentAvatar agent={local} size={size} busy={busy} photo={photo} />;
  const color = member.color ?? paletteFor(memberKey(member));
  if (member.kind === "agent") {
    return (
      <span className="roomFace roomFaceAgent" data-busy={busy ? "1" : "0"} style={{ width: size, height: size, ["--agent" as string]: color }} title={member.name}>
        {member.emoji ? <span className="roomFaceEmoji" style={{ fontSize: size * 0.52 }}>{member.emoji}</span> : <AgentFace seed={`${member.home}:${member.id}`} color={color} busy={busy} />}
      </span>
    );
  }
  return (
    <span className="roomFace roomFacePerson" style={{ width: size, height: size, ["--agent" as string]: color, fontSize: Math.round(size * 0.4) }} title={member.name}>
      {initials(member.name)}
    </span>
  );
}

/** The room's icon: emoji on its colour, or a cluster of the first faces. */
export function RoomAvatar({ room, agents, size = 38, photos }: { room: RoomVm; agents: AgentVm[]; size?: number; photos?: Record<string, string> }) {
  const color = room.color ?? paletteFor(room.id);
  if (room.emoji) {
    return (
      <span className="roomIcon" style={{ width: size, height: size, ["--agent" as string]: color, fontSize: Math.round(size * 0.5) }}>
        {room.emoji}
      </span>
    );
  }
  const faces = room.members.filter((m) => m.kind === "agent").slice(0, 3);
  return (
    <span className="roomCluster" style={{ width: size, height: size }}>
      {faces.map((m, i) => (
        <span key={memberKey(m)} className="roomClusterFace" style={{ zIndex: 3 - i, left: `${i * 32}%`, top: `${(i % 2) * 28}%` }}>
          <MemberAvatar member={m} agents={agents} size={Math.round(size * 0.62)} photo={photos?.[m.id]} />
        </span>
      ))}
    </span>
  );
}

export interface RoomRowVm {
  room: RoomVm;
  preview: string;
  at?: string;
  unread: boolean;
  typing: string[];
}

/** The rail: every room as a Messages row. */
export function RoomList({ rows, selectedId, agents, photos, onSelect, onNew, onJoin }: { rows: RoomRowVm[]; selectedId: string | null; agents: AgentVm[]; photos: Record<string, string>; onSelect: (id: string) => void; onNew: () => void; onJoin: () => void }) {
  return (
    <nav className="roomList" aria-label="Rooms">
      {rows.map((r) => {
        const on = selectedId === r.room.id;
        return (
          <button key={r.room.id} className="roomRow" data-on={on ? "1" : "0"} data-unread={r.unread && !on ? "1" : "0"} onClick={() => onSelect(r.room.id)}>
            <RoomAvatar room={r.room} agents={agents} size={38} photos={photos} />
            <span className="roomRowText">
              <span className="roomRowTop">
                <strong>{r.room.name}</strong>
                {r.typing.length ? <em className="agentTyping"><i /><i /><i /></em> : r.at ? <span className="roomRowTime">{roomTime(r.at)}</span> : null}
              </span>
              <span className="roomRowPreview">{r.typing.length ? `${r.typing.join(", ")} typing…` : r.preview}</span>
            </span>
            {r.room.rules.paused ? <span className="roomRowPaused" title="Paused">⏸</span> : null}
          </button>
        );
      })}
      <div className="roomRowActions">
        <button className="roomNew" onClick={onNew}><span>+</span> New room</button>
        <button className="roomNew roomJoinBtn" onClick={onJoin}>Join by link</button>
      </div>
    </nav>
  );
}

// ─── the thread ───────────────────────────────────────────────────────────

interface Run {
  key: string;
  from: RoomMessageVm["from"];
  mine: boolean;
  system: boolean;
  items: RoomMessageVm[];
  at: string;
  showDay: boolean;
}

/** Consecutive messages from one sender within a few minutes share a face. */
function runsOf(messages: RoomMessageVm[]): Run[] {
  const sorted = [...messages].sort((a, b) => a.seq - b.seq || a.at.localeCompare(b.at));
  const runs: Run[] = [];
  let lastAt = 0;
  for (const m of sorted) {
    const t = Date.parse(m.at) || 0;
    const showDay = t - lastAt > 20 * 60_000;
    lastAt = t;
    const system = m.kind === "system" || m.from.kind === "system" || m.kind === "job" || m.kind === "note";
    const prev = runs.at(-1);
    // the same notice again (a burst) folds into the one before it
    if (system && prev && prev.system && prev.items.at(-1)!.text === m.text && fromKey(prev.items.at(-1)!.from) === fromKey(m.from)) {
      prev.items[prev.items.length - 1] = { ...prev.items.at(-1)!, repeat: ((prev.items.at(-1) as RoomMessageVm & { repeat?: number }).repeat ?? 1) + 1 } as RoomMessageVm;
      continue;
    }
    if (prev && !system && !prev.system && fromKey(prev.from) === fromKey(m.from) && t - (Date.parse(prev.items.at(-1)!.at) || 0) < 3 * 60_000 && !showDay) {
      prev.items.push(m);
      continue;
    }
    runs.push({ key: m.id, from: m.from, mine: isMine(m.from), system, items: [m], at: m.at, showDay });
  }
  return runs;
}

function inlineMentions(text: string, members: RoomMemberVm[]): ReactNode {
  const names = members.map((m) => m.name).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}|everyone|all|here))(?![\\w-])`, "gi");
  const parts = text.split(re);
  if (parts.length === 1) return text;
  return parts.map((p, i) => (i % 2 === 1 ? <b key={i} className="roomMention">{p}</b> : p));
}

/** A long message shows its first lines and folds the rest behind "Show more"
 *  — one chatty agent can't fill the screen. */
function Folded({ text, members }: { text: string; members: RoomMemberVm[] }) {
  const [open, setOpen] = useState(false);
  const LIMIT = 320;
  if (text.length <= LIMIT + 60 || open) {
    return <>{inlineMentions(text, members)}{open ? <button className="roomMore" onClick={() => setOpen(false)}>Show less</button> : null}</>;
  }
  const cut = text.slice(0, LIMIT).replace(/\s+\S*$/, "");
  return <>{inlineMentions(cut, members)}… <button className="roomMore" onClick={() => setOpen(true)}>Show more</button></>;
}

export function RoomView({
  room,
  me,
  messages,
  agents,
  photos,
  typing,
  remoteTyping = [],
  workspaces = [],
  error,
  onSend,
  onPause,
  onMute,
  onRecall,
  onAddAgent,
  onInvite,
  onJob,
  onNotes,
  onRules,
  onRename,
  onDelete,
  onRemoveGuest,
  onOpenSeat,
}: {
  room: RoomVm;
  me: RoomsMeVm;
  messages: RoomMessageVm[];
  agents: AgentVm[];
  photos: Record<string, string>;
  /** Local agent ids whose seat is mid-turn. */
  typing: string[];
  /** Agents on OTHER machines working right now (key = member key). */
  remoteTyping?: Array<{ key: string; name: string; activity: string }>;
  /** The owner's VPS boxes, for "this room works on". */
  workspaces?: Array<{ id: string; label: string }>;
  error?: string;
  onSend: (text: string) => void;
  onPause: (paused: boolean) => void;
  onMute: (agentId: string, muted: boolean) => void;
  onRecall: (agentId: string) => void;
  onAddAgent: (agentId: string) => void;
  onInvite: () => void;
  onJob: (spec: { id?: string; title?: string; owner?: string; status?: string; due?: string; link?: string; note?: string; remove?: boolean }) => void;
  onNotes: (notes: string) => void;
  onRules: (rules: Partial<RoomRulesVm> & { lead?: string }) => void;
  onRename: (patch: { name?: string; emoji?: string; color?: string; purpose?: string; workspaceId?: string }) => void;
  onDelete: () => void;
  onRemoveGuest: (guestId: string) => void;
  /** Open an agent's seat (its private thread) to see its reasoning. */
  onOpenSeat: (sessionId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [board, setBoard] = useState(true);
  const [panel, setPanel] = useState<null | "members" | "settings" | "notes">(null);
  const [mentionAt, setMentionAt] = useState<number | null>(null);
  const [newJob, setNewJob] = useState("");
  const scroller = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const runs = useMemo(() => runsOf(messages), [messages]);
  const agentsHere = room.members.filter((m) => m.kind === "agent");
  const mine = agentsHere.filter((m) => m.home === "local");
  const people = room.members.filter((m) => m.kind === "person");
  const notHere = agents.filter((a) => !mine.some((m) => m.id === a.id));
  const memberOf = (f: RoomMessageVm["from"]) => room.members.find((m) => m.kind === f.kind && m.id === f.id && m.home === (f.home ?? "local"));
  const stick = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, typing.length, room.id]);
  useEffect(() => {
    stick.current = true;
    setDraft("");
    requestAnimationFrame(() => input.current?.focus());
  }, [room.id]);

  const mentionQuery = mentionAt !== null ? draft.slice(mentionAt + 1).toLowerCase() : null;
  const mentionHits = mentionQuery !== null && !/\s/.test(mentionQuery.slice(0, 1) || "x")
    ? room.members.filter((m) => !(m.kind === "person" && m.home === "local") && m.name.toLowerCase().startsWith(mentionQuery)).slice(0, 6)
    : mentionQuery !== null ? room.members.filter((m) => !(m.kind === "person" && m.home === "local") && m.name.toLowerCase().includes(mentionQuery)).slice(0, 6) : [];
  const pickMention = (m: RoomMemberVm) => {
    if (mentionAt === null) return;
    setDraft(`${draft.slice(0, mentionAt)}@${m.name} `);
    setMentionAt(null);
    requestAnimationFrame(() => input.current?.focus());
  };
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
    setMentionAt(null);
    stick.current = true;
  };
  const onChange = (v: string) => {
    setDraft(v);
    const at = v.lastIndexOf("@");
    if (at >= 0 && (at === 0 || /\s/.test(v[at - 1]!)) && !/\n/.test(v.slice(at))) setMentionAt(at);
    else setMentionAt(null);
  };

  const open = room.board.filter((j) => j.status !== "done");
  const summary = `${people.length} ${people.length === 1 ? "person" : "people"} · ${agentsHere.length} agent${agentsHere.length === 1 ? "" : "s"}${room.remote ? " · hosted elsewhere" : room.guests.length ? ` · ${room.guests.length} guest${room.guests.length === 1 ? "" : "s"}` : ""}`;

  return (
    <div className="roomView" data-board={board ? "1" : "0"}>
      <header className="roomHead">
        <div className="roomHeadId">
          <RoomAvatar room={room} agents={agents} size={40} photos={photos} />
          <div className="roomHeadText">
            <h2>{room.name}</h2>
            <span>{room.rules.paused ? "Paused · " : ""}{summary}</span>
          </div>
        </div>
        <div className="roomHeadFaces" title={room.members.map((m) => m.name).join(", ")} onClick={() => setPanel(panel === "members" ? null : "members")}>
          {room.members.slice(0, 7).map((m) => (
            <span key={memberKey(m)} className="roomHeadFace" data-muted={m.muted ? "1" : "0"}>
              <MemberAvatar member={m} agents={agents} size={26} busy={m.kind === "agent" && m.home === "local" && typing.includes(m.id)} photo={photos[m.id]} />
            </span>
          ))}
          {room.members.length > 7 ? <span className="roomHeadMore">+{room.members.length - 7}</span> : null}
        </div>
        <div className="roomHeadActions">
          <button data-on={panel === "members" ? "1" : "0"} onClick={() => setPanel(panel === "members" ? null : "members")} title="Members">Members</button>
          <button data-on={board ? "1" : "0"} onClick={() => setBoard((b) => !b)} title="Job board">Board{open.length ? <em>{open.length}</em> : null}</button>
          <button data-on={panel === "notes" ? "1" : "0"} onClick={() => setPanel(panel === "notes" ? null : "notes")} title="Shared notes">Notes</button>
          {!room.remote ? <button onClick={onInvite} title="Invite a person (they bring their own agents)">Invite</button> : null}
          <button className={room.rules.paused ? "roomResume" : "roomPause"} onClick={() => onPause(!room.rules.paused)} title={room.rules.paused ? "Let the agents speak again" : "Stop every agent until you resume"}>
            {room.rules.paused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button data-on={panel === "settings" ? "1" : "0"} onClick={() => setPanel(panel === "settings" ? null : "settings")} title="Room settings" aria-label="Room settings">⋯</button>
        </div>
      </header>

      {error ? <div className="roomError">{error}</div> : null}

      <div className="roomBody">
        <div className="roomThread" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
          {runs.length === 0 ? (
            <div className="roomEmpty">
              <RoomAvatar room={room} agents={agents} size={72} photos={photos} />
              <h3>{room.name}</h3>
              <p>{room.purpose || "Say what this room is for, @mention an agent, and watch the team work. You can pause, mute or recall any of yours at any time."}</p>
            </div>
          ) : null}
          {runs.map((run) => {
            if (run.system) {
              return (
                <div key={run.key} className="roomSystem" data-kind={run.items[0]!.kind}>
                  {run.showDay ? <div className="roomDay">{dayLabel(run.at)}</div> : null}
                  {run.items.map((m) => (
                    <div key={m.id} className="roomSystemLine">
                      {m.from.kind !== "system" ? <b>{m.from.name}</b> : null} {m.text}
                      {(m as RoomMessageVm & { repeat?: number }).repeat ? <em className="roomRepeat"> ×{(m as RoomMessageVm & { repeat?: number }).repeat}</em> : null}
                    </div>
                  ))}
                </div>
              );
            }
            if (run.mine) {
              return (
                <div key={run.key} className="roomRun roomRunMine">
                  {run.showDay ? <div className="roomDay">{dayLabel(run.at)}</div> : null}
                  {run.items.map((m, i) => (
                    <div key={m.id} className="roomBubble roomBubbleMine" data-last={i === run.items.length - 1 ? "1" : "0"}>{inlineMentions(m.text, room.members)}</div>
                  ))}
                </div>
              );
            }
            const member = memberOf(run.from);
            const color = member?.color ?? paletteFor(fromKey(run.from));
            const seat = member?.kind === "agent" && member.home === "local" ? room.threads[member.id] : undefined;
            return (
              <div key={run.key} className="roomRun roomRunTheirs" style={{ ["--agent" as string]: color }}>
                {run.showDay ? <div className="roomDay">{dayLabel(run.at)}</div> : null}
                <div className="roomRunRow">
                  <span className="roomRunFace"><MemberAvatar member={member ?? { kind: run.from.kind === "person" ? "person" : "agent", id: run.from.id, name: run.from.name, home: run.from.home ?? "local", joinedAt: "" }} agents={agents} size={30} photo={member ? photos[member.id] : undefined} /></span>
                  <div className="roomRunCol">
                    <span className="roomRunName" style={{ color }}>
                      {run.from.name}
                      {member?.kind === "person" ? <i> person</i> : member?.owner && member.home !== "local" ? <i> {room.members.find((x) => memberKey(x) === member.owner)?.name ?? "guest"}'s agent</i> : null}
                      {seat ? <button className="roomPeek" title={`Open ${run.from.name}'s seat (their private thread)`} onClick={() => onOpenSeat(seat)}>peek</button> : null}
                    </span>
                    {run.items.map((m, i) => (
                      <div key={m.id} className="roomBubble roomBubbleTheirs" data-last={i === run.items.length - 1 ? "1" : "0"}><Folded text={m.text} members={room.members} /></div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
          {remoteTyping.map((p) => {
            const m = room.members.find((x) => memberKey(x) === p.key);
            if (!m) return null;
            return (
              <div key={`rtyping-${p.key}`} className="roomRun roomRunTheirs roomTypingRow" style={{ ["--agent" as string]: m.color ?? paletteFor(memberKey(m)) }}>
                <div className="roomRunRow">
                  <span className="roomRunFace"><MemberAvatar member={m} agents={agents} size={30} busy /></span>
                  <div className="roomRunCol">
                    <span className="roomRunName">{m.name} <i>{p.activity && p.activity !== "working" ? p.activity : "working…"}</i></span>
                    <div className="typingBubble"><i /><i /><i /></div>
                  </div>
                </div>
              </div>
            );
          })}
          {typing.map((id) => {
            const m = mine.find((x) => x.id === id);
            if (!m) return null;
            return (
              <div key={`typing-${id}`} className="roomRun roomRunTheirs roomTypingRow" style={{ ["--agent" as string]: m.color ?? paletteFor(memberKey(m)) }}>
                <div className="roomRunRow">
                  <span className="roomRunFace"><MemberAvatar member={m} agents={agents} size={30} busy photo={photos[m.id]} /></span>
                  <div className="roomRunCol">
                    <span className="roomRunName">{m.name}</span>
                    <div className="typingBubble"><i /><i /><i /></div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {board ? (
          <aside className="roomBoard">
            <div className="roomBoardHead">
              <strong>Board</strong>
              <span>{open.length} open · {room.board.length - open.length} done</span>
            </div>
            <form className="roomBoardAdd" onSubmit={(e) => { e.preventDefault(); if (newJob.trim()) { onJob({ title: newJob.trim() }); setNewJob(""); } }}>
              <input value={newJob} placeholder="Add a job…" onChange={(e) => setNewJob(e.target.value)} />
            </form>
            {JOB_STATUSES.map((status) => {
              const jobs = room.board.filter((j) => j.status === status);
              if (jobs.length === 0) return null;
              return (
                <div key={status} className="roomBoardCol" data-status={status}>
                  <div className="roomBoardColHead">{STATUS_LABEL[status]} <em>{jobs.length}</em></div>
                  {jobs.map((j) => {
                    const owner = j.owner ? room.members.find((m) => memberKey(m) === j.owner) : undefined;
                    const overdue = j.due && j.status !== "done" && Date.parse(j.due) < Date.now();
                    return (
                      <div key={j.id} className="roomJob" data-status={j.status} data-overdue={overdue ? "1" : "0"}>
                        <div className="roomJobTop">
                          <span className="roomJobOwner" title={owner?.name ?? "unassigned"}><MemberAvatar member={owner} agents={agents} size={20} photo={owner ? photos[owner.id] : undefined} /></span>
                          <span className="roomJobTitle">{j.title}</span>
                        </div>
                        {j.note ? <div className="roomJobNote">{j.note}</div> : null}
                        {j.links.length ? <div className="roomJobLinks">{j.links.map((l) => <code key={l} title={l}>{l.replace(/^https?:\/\//, "").slice(0, 40)}</code>)}</div> : null}
                        <div className="roomJobFoot">
                          <select value={j.status} onChange={(e) => onJob({ id: j.id, status: e.target.value })} title="Status">
                            {JOB_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                          </select>
                          <select value={j.owner ?? ""} onChange={(e) => onJob({ id: j.id, owner: e.target.value ? room.members.find((m) => memberKey(m) === e.target.value)?.name ?? "" : "" })} title="Owner">
                            <option value="">unassigned</option>
                            {room.members.map((m) => <option key={memberKey(m)} value={memberKey(m)}>{m.name}</option>)}
                          </select>
                          {j.due ? <span className="roomJobDue" title={j.due}>{overdue ? "overdue · " : "due "}{roomTime(j.due)}</span> : null}
                          <button className="roomJobX" title="Remove" onClick={() => onJob({ id: j.id, remove: true })}>×</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {room.board.length === 0 ? <p className="roomBoardEmpty">Agents put their work here as they take it. You can add a job too.</p> : null}
          </aside>
        ) : null}

        {panel === "members" ? (
          <aside className="roomPanel">
            <div className="roomPanelHead"><strong>Members</strong><button onClick={() => setPanel(null)} aria-label="Close">×</button></div>
            {people.map((p) => (
              <div key={memberKey(p)} className="roomMember">
                <MemberAvatar member={p} agents={agents} size={30} />
                <span className="roomMemberText"><strong>{p.name}{p.home === "local" ? " (you)" : ""}</strong><em>person{p.home !== "local" && !room.remote ? " · guest" : ""}</em></span>
                {!room.remote && p.home !== "local" ? <button className="roomGhost" onClick={() => onRemoveGuest(p.id)} title="Remove them and their agents">Remove</button> : null}
              </div>
            ))}
            {agentsHere.map((a) => {
              const ownerName = a.owner ? room.members.find((x) => memberKey(x) === a.owner)?.name : undefined;
              const own = a.home === "local";
              return (
                <div key={memberKey(a)} className="roomMember" data-muted={a.muted ? "1" : "0"}>
                  <MemberAvatar member={a} agents={agents} size={30} busy={own && typing.includes(a.id)} photo={photos[a.id]} />
                  <span className="roomMemberText"><strong>{a.name}</strong><em>{own ? "your agent" : `${ownerName ?? "guest"}'s agent`}{a.muted ? " · muted" : ""}</em></span>
                  {own ? (
                    <span className="roomMemberBtns">
                      {room.threads[a.id] ? <button className="roomGhost" onClick={() => onOpenSeat(room.threads[a.id]!)} title="Open their seat">Peek</button> : null}
                      <button className="roomGhost" onClick={() => onMute(a.id, !a.muted)}>{a.muted ? "Unmute" : "Mute"}</button>
                      <button className="roomGhost roomDangerText" onClick={() => onRecall(a.id)} title="Pull them out of the room">Recall</button>
                    </span>
                  ) : <span className="roomMemberBtns"><em className="roomNotYours">not yours</em></span>}
                </div>
              );
            })}
            {notHere.length ? (
              <div className="roomPanelAdd">
                <span>Add one of yours</span>
                <div className="roomAddRow">
                  {notHere.map((a) => (
                    <button key={a.id} className="roomAddAgent" onClick={() => onAddAgent(a.id)} title={`Add ${a.name}`}>
                      <AgentAvatar agent={a} size={24} photo={photos[a.id]} /> {a.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {!room.remote ? <button className="agentPrimary roomInviteBtn" onClick={onInvite}>Invite a person</button> : null}
          </aside>
        ) : null}

        {panel === "notes" ? (
          <aside className="roomPanel">
            <div className="roomPanelHead"><strong>Shared notes</strong><button onClick={() => setPanel(null)} aria-label="Close">×</button></div>
            <p className="roomPanelWhy">The room's memory: what the group decided. Agents read it every turn and update it with Rooms note.</p>
            <NotesEditor value={room.notes} onSave={onNotes} />
          </aside>
        ) : null}

        {panel === "settings" ? (
          <aside className="roomPanel">
            <div className="roomPanelHead"><strong>Room</strong><button onClick={() => setPanel(null)} aria-label="Close">×</button></div>
            <RoomSettings room={room} workspaces={workspaces} onRename={onRename} onRules={onRules} onDelete={onDelete} />
          </aside>
        ) : null}
      </div>

      <div className="roomComposer">
        {mentionHits.length && mentionAt !== null ? (
          <div className="roomMentionPop">
            {mentionHits.map((m) => (
              <button key={memberKey(m)} onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}>
                <MemberAvatar member={m} agents={agents} size={22} photo={photos[m.id]} /> {m.name} <em>{m.kind === "person" ? "person" : m.home === "local" ? "your agent" : "agent"}</em>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={input}
          value={draft}
          rows={1}
          placeholder={room.rules.paused ? "Paused — your message is kept, agents answer when you resume" : `Message ${room.name} — @name to summon someone`}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (mentionHits.length && mentionAt !== null) pickMention(mentionHits[0]!);
              else submit();
            }
            if (e.key === "Escape") setMentionAt(null);
          }}
        />
        <button className="roomSend" onClick={submit} disabled={!draft.trim()} aria-label="Send">↑</button>
      </div>
    </div>
  );
}

function NotesEditor({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="roomNotes">
      <textarea value={draft} rows={12} placeholder="Nothing agreed yet." onChange={(e) => setDraft(e.target.value)} />
      <div className="roomNotesFoot">
        <button className="agentGhost" disabled={draft === value} onClick={() => setDraft(value)}>Revert</button>
        <button className="agentPrimary" disabled={draft === value} onClick={() => onSave(draft)}>Save notes</button>
      </div>
    </div>
  );
}

function RoomSettings({ room, workspaces, onRename, onRules, onDelete }: { room: RoomVm; workspaces: Array<{ id: string; label: string }>; onRename: (patch: { name?: string; emoji?: string; color?: string; purpose?: string; workspaceId?: string }) => void; onRules: (rules: Partial<RoomRulesVm> & { lead?: string }) => void; onDelete: () => void }) {
  const [name, setName] = useState(room.name);
  const [purpose, setPurpose] = useState(room.purpose);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setName(room.name); setPurpose(room.purpose); }, [room.id, room.name, room.purpose]);
  const dirty = name.trim() !== room.name || purpose.trim() !== room.purpose;
  return (
    <div className="roomSettings">
      <label className="agentField"><span>Name</span><input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
      <label className="agentField"><span>What this room is for</span><textarea rows={4} value={purpose} placeholder="The playbook every agent in here reads: the goal, who does what, what done looks like." onChange={(e) => setPurpose(e.target.value)} /></label>
      <div className="agentField">
        <span>Icon</span>
        <div className="roomEmojiRow">
          {ROOM_EMOJI.map((e) => <button key={e} data-on={room.emoji === e ? "1" : "0"} onClick={() => onRename({ emoji: room.emoji === e ? "" : e })}>{e}</button>)}
        </div>
        <div className="agentSwatches">
          {ROOM_COLORS.map((c) => <button key={c} data-on={room.color === c ? "1" : "0"} style={{ background: c }} onClick={() => onRename({ color: c })} aria-label={c} />)}
        </div>
      </div>
      {dirty ? <button className="agentPrimary" onClick={() => onRename({ name: name.trim(), purpose: purpose.trim() })}>Save</button> : null}
      <label className="agentField">
        <span>Lead</span>
        <select value={room.rules.lead ?? ""} onChange={(e) => onRules({ lead: e.target.value })} disabled={room.remote}>
          <option value="">The first agent</option>
          {room.members.filter((m) => m.kind === "agent").map((m) => <option key={memberKey(m)} value={memberKey(m)}>{m.name}</option>)}
        </select>
      </label>
      <label className="agentField">
        <span>Your agents work on (VPS)</span>
        <select value={room.workspaceId ?? ""} onChange={(e) => onRename({ workspaceId: e.target.value })} disabled={workspaces.length === 0}>
          <option value="">{workspaces.length === 0 ? "Add a VPS in Settings → Workspaces" : "Their own box"}</option>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
        </select>
      </label>
      {!room.remote ? (
        <>
          <label className="agentField">
            <span>Who answers</span>
            <select value={room.rules.turns} onChange={(e) => onRules({ turns: e.target.value as RoomRulesVm["turns"] })}>
              <option value="mention">Only who is @mentioned (the lead when nobody is)</option>
              <option value="round">Take turns in order</option>
              <option value="free">Everyone, when they have something</option>
            </select>
          </label>
          <div className="agentFieldRow">
            <label className="agentField"><span>Agent run cap</span><input type="number" min={1} max={200} value={room.rules.maxAgentRun} onChange={(e) => onRules({ maxAgentRun: Number(e.target.value) || 1 })} /></label>
            <label className="agentField"><span>Check-in (min, 0 = off)</span><input type="number" min={0} max={1440} value={room.rules.checkinMinutes} onChange={(e) => onRules({ checkinMinutes: Number(e.target.value) || 0 })} /></label>
          </div>
          <p className="roomPanelWhy">The run cap stops agents after that many messages in a row with no person speaking. A check-in has the lead agent look at the board and post a status on that cadence while jobs are open.</p>
        </>
      ) : <p className="roomPanelWhy">The host sets this room's rules. You control your own agents here: mute, recall, add.</p>}
      <p className="roomPanelWhy">Shared files: <code>{room.folder}</code></p>
      {!confirm ? <button className="agentGhost roomDangerText" onClick={() => setConfirm(true)}>{room.remote ? "Leave room" : "Delete room"}</button> : (
        <div className="roomConfirm">
          <span>{room.remote ? "Leave this room? Your agents leave with you." : "Delete this room for everyone? The thread is kept on disk."}</span>
          <button className="agentDanger" onClick={onDelete}>{room.remote ? "Leave" : "Delete"}</button>
          <button className="agentGhost" onClick={() => setConfirm(false)}>Keep</button>
        </div>
      )}
    </div>
  );
}

// ─── sheets ───────────────────────────────────────────────────────────────

export function RoomCreateSheet({ agents, photos, error, directoryUser, onCreate, onCreateShared, onClose }: { agents: AgentVm[]; photos: Record<string, string>; error?: string; /** Our username on the directory, when claimed: rooms can be hosted there and people invited by name. */ directoryUser?: string; onCreate: (spec: { name: string; emoji: string; color: string; purpose: string; agents: string[]; rules: Partial<RoomRulesVm> }) => void; onCreateShared?: (spec: { name: string; purpose: string; agents: string[]; invite: string[] }) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [invite, setInvite] = useState("");
  const [emoji, setEmoji] = useState(ROOM_EMOJI[0]!);
  const [color, setColor] = useState(ROOM_COLORS[0]!);
  const [purpose, setPurpose] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [turns, setTurns] = useState<RoomRulesVm["turns"]>("mention");
  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { requestAnimationFrame(() => nameRef.current?.focus()); }, []);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const ideas = [
    { name: "Agency", emoji: "🏢", purpose: "A web agency run by agents: one finds leads, one builds the site, one audits it, one pitches. The CEO assigns jobs on the board; nothing ships without a PASS." },
    { name: "Writers' room", emoji: "🎨", purpose: "Pitch, argue, and draft. One writes, one edits, one plays the audience. Keep the best ideas in the notes." },
    { name: "Debate", emoji: "🎯", purpose: "Two agents argue opposite sides of whatever a person posts. Short rounds. A third keeps score on the board." },
  ];
  return (
    <div className="agentScrim" onClick={onClose}>
      <div className="agentSheet roomSheet" role="dialog" aria-label="New room" onClick={(e) => e.stopPropagation()}>
        <header className="agentSheetHead">
          <span className="roomIcon" style={{ width: 64, height: 64, fontSize: 32, ["--agent" as string]: color }}>{emoji}</span>
          <div>
            <h3>{name || "New room"}</h3>
            <p>A group chat for you and your agents. Invite a person later and they bring their own agents — everyone's agents run on their own machine.</p>
          </div>
          <button className="agentClose" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="agentTemplates">
          {ideas.map((i) => <button key={i.name} className="agentTemplate" onClick={() => { setName(i.name); setEmoji(i.emoji); setPurpose(i.purpose); }}>{i.emoji} {i.name}</button>)}
        </div>
        <label className="agentField"><span>Name</span><input ref={nameRef} value={name} maxLength={40} placeholder="Agency" onChange={(e) => setName(e.target.value)} /></label>
        <label className="agentField"><span>What it's for</span><textarea rows={3} value={purpose} placeholder="The goal, who does what, what done looks like. Every agent in the room reads this." onChange={(e) => setPurpose(e.target.value)} /></label>
        <div className="agentField">
          <span>Your agents in it</span>
          {agents.length === 0 ? <em className="roomPanelWhy">You have no agents yet — make one first, or open the room and add them later.</em> : (
            <div className="roomPickGrid">
              {agents.map((a) => (
                <button key={a.id} className="roomPick" data-on={picked.includes(a.id) ? "1" : "0"} onClick={() => toggle(a.id)}>
                  <AgentAvatar agent={a} size={30} photo={photos[a.id]} /><span>{a.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {directoryUser && onCreateShared ? (
          <div className="agentField roomSharedBox" data-on={shared ? "1" : "0"}>
            <label className="roomSharedToggle">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              <span><strong>With other people</strong> — hosted on the Ares directory, so nobody needs a server. Invite them by username; their agents run on their machines.</span>
            </label>
            {shared ? (
              <input className="roomInviteNames" value={invite} placeholder="@cupid, @dawg" spellCheck={false} onChange={(e) => setInvite(e.target.value)} />
            ) : null}
          </div>
        ) : null}
        <div className="agentFieldRow">
          <div className="agentField">
            <span>Icon</span>
            <div className="roomEmojiRow">{ROOM_EMOJI.map((e) => <button key={e} data-on={emoji === e ? "1" : "0"} onClick={() => setEmoji(e)}>{e}</button>)}</div>
            <div className="agentSwatches">{ROOM_COLORS.map((c) => <button key={c} data-on={color === c ? "1" : "0"} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}</div>
          </div>
          <label className="agentField">
            <span>Who answers</span>
            <select value={turns} onChange={(e) => setTurns(e.target.value as RoomRulesVm["turns"])}>
              <option value="mention">Only who is @mentioned</option>
              <option value="round">Take turns in order</option>
              <option value="free">Everyone, when they have something</option>
            </select>
          </label>
        </div>
        {error ? <p className="agentSheetErr">{error}</p> : null}
        <footer className="agentSheetFoot">
          <div />
          <div>
            <button className="agentGhost" onClick={onClose}>Cancel</button>
            <button
              className="agentPrimary"
              disabled={!name.trim()}
              onClick={() => {
                if (shared && onCreateShared) onCreateShared({ name: name.trim(), purpose: purpose.trim(), agents: picked, invite: invite.split(/[\s,]+/).map((x) => x.replace(/^@/, "").toLowerCase()).filter(Boolean) });
                else onCreate({ name: name.trim(), emoji, color, purpose: purpose.trim(), agents: picked, rules: { turns } });
              }}
            >
              {shared ? "Open & invite" : "Open room"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function RoomJoinSheet({ agents, photos, error, busy, initialLink, intro, onJoin, onClose }: { agents: AgentVm[]; photos: Record<string, string>; error?: string; busy?: boolean; initialLink?: string; intro?: string; onJoin: (link: string, agents: string[]) => void; onClose: () => void }) {
  const [link, setLink] = useState(initialLink ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const ok = /^ares:\/\/room\?/.test(link.trim());
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <div className="agentScrim" onClick={onClose}>
      <div className="agentSheet roomSheet" role="dialog" aria-label="Join a room" onClick={(e) => e.stopPropagation()}>
        <header className="agentSheetHead">
          <div>
            <h3>{intro ? "You're invited" : "Join a room"}</h3>
            <p>{intro ? `${intro} ` : "Paste the link someone sent you. "} The room lives on their Ares; your agents stay on yours and only messages travel. You can mute or recall your agents there at any time.</p>
          </div>
          <button className="agentClose" onClick={onClose} aria-label="Close">×</button>
        </header>
        <label className="agentField"><span>Invite link</span><input value={link} placeholder="ares://room?url=…&room=…&code=…" spellCheck={false} onChange={(e) => setLink(e.target.value)} /></label>
        <div className="agentField">
          <span>Bring these agents</span>
          {agents.length === 0 ? <em className="roomPanelWhy">No agents yet — you can still join as yourself.</em> : (
            <div className="roomPickGrid">
              {agents.map((a) => (
                <button key={a.id} className="roomPick" data-on={picked.includes(a.id) ? "1" : "0"} onClick={() => toggle(a.id)}>
                  <AgentAvatar agent={a} size={30} photo={photos[a.id]} /><span>{a.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {error ? <p className="agentSheetErr">{error}</p> : null}
        <footer className="agentSheetFoot">
          <div />
          <div>
            <button className="agentGhost" onClick={onClose}>Cancel</button>
            <button className="agentPrimary" disabled={!ok || busy} onClick={() => onJoin(link.trim(), picked)}>{busy ? "Joining…" : "Join"}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function RoomInviteSheet({ room, link, error, busy, onMint, onClose }: { room: RoomVm; link?: string; error?: string; busy?: boolean; onMint: () => void; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!link && !error && !busy) onMint(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="agentScrim" onClick={onClose}>
      <div className="agentSheet roomSheet" role="dialog" aria-label="Invite" onClick={(e) => e.stopPropagation()}>
        <header className="agentSheetHead">
          <div>
            <h3>Invite someone to {room.name}</h3>
            <p>Send them this link. They open it in their own Ares (Rooms → Join by link), pick which of their agents to bring, and they're in. One link, one person.</p>
          </div>
          <button className="agentClose" onClick={onClose} aria-label="Close">×</button>
        </header>
        {link ? (
          <div className="roomInviteLink">
            <code>{link}</code>
            <button className="agentPrimary" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
          </div>
        ) : busy ? <p className="roomPanelWhy">Minting the link…</p> : null}
        {error ? <p className="agentSheetErr">{error}</p> : null}
        {room.guests.length ? (
          <div className="agentField">
            <span>Already in</span>
            {room.guests.map((g) => <div key={g.id} className="roomGuestRow"><strong>{g.name}</strong><em>joined {roomTime(g.joinedAt)}{g.lastSeenAt ? ` · seen ${roomTime(g.lastSeenAt)}` : ""}</em></div>)}
          </div>
        ) : null}
        <p className="roomPanelWhy">What they can do: talk, and do room work with their own agents. What they can't: touch your PC, your files, your accounts, or drive your agents — your agents only take orders from you, and you can mute or recall them any time.</p>
        <footer className="agentSheetFoot">
          <div>{link ? <button className="agentGhost" onClick={onMint} disabled={busy}>New link</button> : null}</div>
          <div><button className="agentGhost" onClick={onClose}>Done</button></div>
        </footer>
      </div>
    </div>
  );
}
