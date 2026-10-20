// The iPhone app's other tabs on the desktop: Feed (the daily edition Ares
// writes for you) and Now (mission control: what is happening, what needs
// you, who is working). Both read the same garrison routes the phone reads
// through the daemon's gateway relay, so an edition written for the phone is
// the one you see here.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentVm } from "./agents";
import { AgentAvatar } from "./agents";
import type { RoomVm, RoomMessageVm } from "./rooms";
import { RoomAvatar, roomTime } from "./rooms";
import type { SessionVm } from "./state/session";
import "./messagesViews.css";

export type GatewayFetch = (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => Promise<{ status: number; data: unknown }>;

export interface FeedItemVm { title: string; summary: string; url?: string; image?: string }
export interface FeedSectionVm { heading: string; items: FeedItemVm[] }
export interface FeedVm { prompt: string; generating: boolean; edition?: { id: string; generatedAt: string; title: string; sections: FeedSectionVm[] } }

const EMOJI_BY_WORD: Array<[RegExp, string]> = [
  [/\b(ai|model|llm|gpt|claude|openai|anthropic)\b/i, "🤖"],
  [/\b(stock|market|shares|earnings|crypto|bitcoin)\b/i, "📈"],
  [/\b(game|gaming|xbox|playstation|nintendo|steam)\b/i, "🎮"],
  [/\b(weather|rain|storm|snow|heat)\b/i, "🌤️"],
  [/\b(football|soccer|nba|nfl|match|league|arsenal)\b/i, "⚽"],
  [/\b(music|album|song|tour)\b/i, "🎧"],
  [/\b(space|nasa|rocket|launch|moon|mars)\b/i, "🚀"],
  [/\b(phone|iphone|android|apple|google|microsoft)\b/i, "📱"],
  [/\b(city|local|council|downtown|traffic)\b/i, "🏙️"],
  [/\b(health|medical|doctor|study)\b/i, "🩺"],
];
export function emojiFor(text: string): string {
  for (const [re, e] of EMOJI_BY_WORD) if (re.test(text)) return e;
  return "📰";
}
export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
function partOfDay(d = new Date()): string {
  const h = d.getHours();
  return h < 5 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
}
function editionTitle(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  return `${d.toLocaleDateString([], { weekday: "long" })} ${partOfDay(d)}`;
}

export function FeedView({ gateway, native, onOpen, onAsk }: { gateway: GatewayFetch; native: boolean; onOpen: (url: string) => void; onAsk: (text: string) => void }) {
  const [feed, setFeed] = useState<FeedVm | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [hidden, setHidden] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("ares.feed.hidden") ?? "[]"); } catch { return []; } });
  const load = async () => {
    if (!native) {
      setFeed({ prompt: "Top news in AI, tech and my city", generating: false, edition: { id: "demo", generatedAt: new Date().toISOString(), title: "Demo edition", sections: [{ heading: "AI", items: [{ title: "This is a sample story", summary: "In the desktop app this tab shows the edition your Ares writes every morning from your feed instructions.", url: "https://example.com" }] }] } });
      return;
    }
    try {
      const r = await gateway("GET", "/gateway/feed");
      if (r.status === 200) { setFeed(r.data as FeedVm); setError(undefined); }
      else setError(typeof (r.data as { error?: string })?.error === "string" ? (r.data as { error: string }).error : `the feed answered ${r.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => { void load(); const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [native]);
  useEffect(() => { if (feed?.prompt && !editing) setPrompt(feed.prompt); }, [feed?.prompt, editing]);
  useEffect(() => { try { localStorage.setItem("ares.feed.hidden", JSON.stringify(hidden.slice(-200))); } catch { /* private mode */ } }, [hidden]);
  const refresh = async () => { await gateway("POST", "/gateway/feed/refresh").catch(() => undefined); setFeed((f) => (f ? { ...f, generating: true } : f)); setTimeout(() => void load(), 4_000); };
  const savePrompt = async () => { await gateway("PUT", "/gateway/feed/prompt", { prompt }).catch(() => undefined); setEditing(false); void refresh(); };
  const edition = feed?.edition;
  const stories = useMemo(() => (edition?.sections ?? []).flatMap((s) => s.items.map((it) => ({ ...it, heading: s.heading, key: `${s.heading}|${it.url ?? it.title}` }))).filter((s) => !hidden.includes(s.key)), [edition, hidden]);
  const hero = stories.find((s) => s.image) ?? stories[0];
  return (
    <div className="feedView">
      <header className="feedHead">
        <div>
          <h1>{editionTitle(edition?.generatedAt)}</h1>
          <p>{edition ? `Written ${roomTime(edition.generatedAt)} · ${stories.length} ${stories.length === 1 ? "story" : "stories"}` : feed?.generating ? "Writing your edition…" : "No edition yet"}</p>
        </div>
        <div className="feedHeadBtns">
          <button className="feedPill" onClick={() => setEditing((e) => !e)} data-on={editing ? "1" : "0"} title="Feed instructions">⚙︎ Instructions</button>
          <button className="feedPill feedPillPrimary" onClick={() => void refresh()} disabled={feed?.generating}>{feed?.generating ? "Writing…" : "Write a fresh edition"}</button>
        </div>
      </header>
      {editing ? (
        <div className="feedPromptCard">
          <strong>What should your feed cover?</strong>
          <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="AI news, Arsenal, anything about my stocks, my city…" />
          <div className="feedPromptFoot"><button className="feedPill" onClick={() => setEditing(false)}>Cancel</button><button className="feedPill feedPillPrimary" onClick={() => void savePrompt()}>Save & rewrite</button></div>
        </div>
      ) : null}
      {error ? <div className="feedError">{error}{/not running/.test(error) ? " — the feed is written by the garrison; it starts with the desktop app." : ""}</div> : null}
      {!edition && !error ? (
        <div className="feedEmpty">
          <div className="feedEmptyArt">📰</div>
          <h3>Your own paper</h3>
          <p>Every morning Ares writes an edition from your instructions: what matters to you, with a source next to every story. Nothing to read yet — write the first one.</p>
          <button className="feedPill feedPillPrimary" onClick={() => void refresh()}>Write it now</button>
        </div>
      ) : null}
      {hero ? (
        <article className="feedHero" onClick={() => hero.url && onOpen(hero.url)} role={hero.url ? "link" : undefined}>
          {hero.image ? <img src={hero.image} alt="" loading="lazy" /> : <div className="feedHeroArt">{emojiFor(hero.title + " " + hero.heading)}</div>}
          <div className="feedHeroText">
            <em>{hero.heading}</em>
            <h2>{hero.title}</h2>
            <p>{hero.summary}</p>
            {hero.url ? <span className="feedSource">{hostOf(hero.url)}</span> : null}
          </div>
        </article>
      ) : null}
      {edition ? (
        <div className="feedSections">
          {edition.sections.map((s) => {
            const items = s.items.filter((it) => !hidden.includes(`${s.heading}|${it.url ?? it.title}`) && it !== hero);
            if (items.length === 0) return null;
            return (
              <section key={s.heading} className="feedSection">
                <h3>{s.heading}</h3>
                {items.map((it) => {
                  const key = `${s.heading}|${it.url ?? it.title}`;
                  return (
                    <article key={key} className="feedStory">
                      <span className="feedStoryEmoji">{emojiFor(it.title + " " + s.heading)}</span>
                      <div className="feedStoryText" onClick={() => it.url && onOpen(it.url)}>
                        <strong>{it.title}</strong>
                        <p>{it.summary}{it.url ? <> <span className="feedSource">{hostOf(it.url)}</span></> : null}</p>
                      </div>
                      <div className="feedStoryBtns">
                        <button title="Ask Ares about this" onClick={() => onAsk(`Tell me more about this story and why it matters to me: "${it.title}"${it.url ? ` (${it.url})` : ""}`)}>Ask</button>
                        <button title="Hide" onClick={() => setHidden((h) => [...h, key])}>×</button>
                      </div>
                      {it.image ? <img className="feedStoryImg" src={it.image} alt="" loading="lazy" onClick={() => it.url && onOpen(it.url)} /> : null}
                    </article>
                  );
                })}
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Now ──────────────────────────────────────────────────────────────────

export interface NowProps {
  me: string;
  sessions: SessionVm[];
  agents: AgentVm[];
  photos: Record<string, string>;
  rooms: RoomVm[];
  roomMessages: Record<string, RoomMessageVm[]>;
  agentIdOf: (sessionId: string) => string;
  onOpenSession: (id: string) => void;
  onOpenRoom: (id: string) => void;
  onPermission: (sessionId: string, id: string, decision: "allow" | "deny") => void;
  onAsk: (text: string) => void;
  onNewAgent: () => void;
  onNewRoom: () => void;
  onFeed: () => void;
  /** The Scheduled section (jobs your agents run on a timer). */
  scheduled?: ReactNode;
  onAllScheduled?: () => void;
}

export function NowView(p: NowProps) {
  const working = p.sessions.filter((s) => s.busy && !s.background);
  const asks = p.sessions.flatMap((s) => s.items.filter((it): it is Extract<typeof it, { kind: "permission" }> => it.kind === "permission" && !it.decided && !it.submitting).map((it) => ({ session: s, ask: it })));
  const liveRooms = p.rooms
    .map((r) => ({ room: r, last: (p.roomMessages[r.id] ?? []).filter((m) => m.kind === "text").at(-1), typing: Object.entries(r.threads).filter(([, sid]) => p.sessions.find((s) => s.id === sid)?.busy).length, open: r.board.filter((j) => j.status !== "done").length }))
    .sort((a, b) => (b.last?.at ?? b.room.updatedAt).localeCompare(a.last?.at ?? a.room.updatedAt));
  const recent = p.sessions.filter((s) => !s.busy && !s.background && s.items.length > 0).slice(0, 6);
  const nameOf = (s: SessionVm) => { const id = p.agentIdOf(s.id); return id === "ares" ? "Ares" : p.agents.find((a) => a.id === id)?.name ?? "Ares"; };
  const agentOf = (s: SessionVm) => { const id = p.agentIdOf(s.id); return p.agents.find((a) => a.id === id) ?? null; };
  const hero = asks.length
    ? `${asks.length} ${asks.length === 1 ? "thing needs" : "things need"} you.`
    : working.length
      ? `${working.length === 1 ? nameOf(working[0]!) + " is" : working.length + " agents are"} working.`
      : liveRooms.some((r) => r.typing)
        ? "The rooms are talking."
        : `Good ${partOfDay()}, ${p.me}. All quiet.`;
  const sub = working.length
    ? working.map((s) => `${nameOf(s)}: ${s.activity ?? s.title}`).slice(0, 3).join(" · ")
    : liveRooms.reduce((n, r) => n + r.open, 0)
      ? `${liveRooms.reduce((n, r) => n + r.open, 0)} open jobs across ${liveRooms.filter((r) => r.open).length} room${liveRooms.filter((r) => r.open).length === 1 ? "" : "s"}`
      : "Nothing running, nothing waiting on you.";
  return (
    <div className="nowView">
      <header className="nowHero">
        <em>{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</em>
        <h1>{hero}</h1>
        <p>{sub}</p>
      </header>

      {asks.length ? (
        <section className="nowSection nowNeeds">
          <h3>Needs you</h3>
          {asks.map(({ session, ask }) => (
            <div key={ask.key} className="nowAsk">
              <AgentAvatar agent={agentOf(session)} size={30} photo={agentOf(session) ? p.photos[agentOf(session)!.id] : undefined} />
              <div className="nowAskText">
                <strong>{nameOf(session)} wants to {ask.toolName}</strong>
                <p>{ask.reason}</p>
              </div>
              <div className="nowAskBtns">
                <button className="nowAllow" onClick={() => p.onPermission(session.id, ask.id, "allow")}>Allow</button>
                <button className="nowDeny" onClick={() => p.onPermission(session.id, ask.id, "deny")}>Deny</button>
                <button className="nowOpen" onClick={() => p.onOpenSession(session.id)}>Open</button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="nowSection">
        <h3>Working now</h3>
        {working.length === 0 ? <p className="nowQuiet">Nobody is mid-task. Ask for something below, or open a room.</p> : null}
        <div className="nowGrid">
          {working.map((s) => (
            <button key={s.id} className="nowCard nowWorking" onClick={() => p.onOpenSession(s.id)}>
              <AgentAvatar agent={agentOf(s)} size={34} busy photo={agentOf(s) ? p.photos[agentOf(s)!.id] : undefined} />
              <span className="nowCardText"><strong>{nameOf(s)}</strong><em>{s.activity ?? s.title}</em></span>
              <span className="nowRing" aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>

      {p.scheduled ? (
        <section className="nowSection">
          <h3>Scheduled{p.onAllScheduled ? <button className="nowLink nowAll" onClick={p.onAllScheduled}>See all</button> : null}</h3>
          {p.scheduled}
        </section>
      ) : null}

      <section className="nowSection">
        <h3>Rooms</h3>
        {liveRooms.length === 0 ? <p className="nowQuiet">No rooms yet. A room is a group chat of you, your agents, and anyone you invite — with their agents. <button className="nowLink" onClick={p.onNewRoom}>Open one</button>.</p> : null}
        <div className="nowGrid">
          {liveRooms.map(({ room, last, typing, open }) => (
            <button key={room.id} className="nowCard" onClick={() => p.onOpenRoom(room.id)}>
              <RoomAvatar room={room} agents={p.agents} size={34} photos={p.photos} />
              <span className="nowCardText">
                <strong>{room.name}{room.rules.paused ? " · paused" : ""}</strong>
                <em>{typing ? `${typing} typing…` : last ? `${last.from.name}: ${last.text}` : room.purpose || "quiet"}</em>
              </span>
              {open ? <span className="nowBadge">{open} open</span> : null}
            </button>
          ))}
        </div>
      </section>

      <section className="nowSection">
        <h3>Your agents</h3>
        <div className="nowStrip">
          {p.agents.map((a) => {
            const busy = p.sessions.some((s) => s.busy && p.agentIdOf(s.id) === a.id);
            return (
              <button key={a.id} className="nowAgent" onClick={() => { const s = p.sessions.find((x) => p.agentIdOf(x.id) === a.id); if (s) p.onOpenSession(s.id); }} title={a.instructions}>
                <AgentAvatar agent={a} size={48} busy={busy} photo={p.photos[a.id]} />
                <span>{a.name}</span>
              </button>
            );
          })}
          <button className="nowAgent nowAgentNew" onClick={p.onNewAgent}><span className="nowPlus">+</span><span>New agent</span></button>
        </div>
      </section>

      {recent.length ? (
        <section className="nowSection">
          <h3>Recent</h3>
          <div className="nowList">
            {recent.map((s) => (
              <button key={s.id} className="nowRow" onClick={() => p.onOpenSession(s.id)}>
                <AgentAvatar agent={agentOf(s)} size={26} photo={agentOf(s) ? p.photos[agentOf(s)!.id] : undefined} />
                <strong>{s.title}</strong>
                <em>{roomTime(s.updatedAt)}</em>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="nowSection">
        <h3>Try</h3>
        <div className="nowTry">
          {[
            "What did my agents do today?",
            "Write my feed for this evening",
            "Start a room with everyone and plan the week",
            "What's waiting on me?",
          ].map((t) => <button key={t} onClick={() => (t.includes("feed") ? p.onFeed() : p.onAsk(t))}>{t}</button>)}
        </div>
      </section>
    </div>
  );
}
