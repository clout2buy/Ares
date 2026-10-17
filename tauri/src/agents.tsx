// Desktop agents — the sidebar is a list of contacts, not a list of chats.
//
// Owner, 2026-10-17: "Instead of new chats it will be agents — the same as the
// iOS app, still with the Forge and all abilities. Each agent: different
// memories, different forges, different models." Every agent is the same
// Persona record the phone makes (daemon/agents.ts); each has many chats on
// the desktop. "Ares" is the implicit default agent that owns every chat not
// bound to anyone, so nothing made before agents existed moves.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./agents.css";

export const ARES_AGENT_ID = "ares";

export interface AgentVm {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  provider: string;
  model: string;
  reasoningLevel?: string;
  instructions: string;
  threads: string[];
  onPhone?: boolean;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentDraft {
  name: string;
  emoji: string;
  color: string;
  provider: string;
  model: string;
  instructions: string;
}

/** The colours the phone app offers, so an agent looks the same on both. */
export const AGENT_COLORS = ["#ff7a45", "#f5b942", "#4cd28a", "#38bdf8", "#7c5cff", "#ec4899", "#ef4444", "#94a3b8"];
export const AGENT_EMOJI = ["🦊", "🐉", "🦉", "🐺", "🦁", "🐙", "🤖", "👾", "🧠", "💸", "📈", "🎨", "🎮", "🛠️", "🔬", "📚", "🏋️", "🍳", "✈️", "🎧", "🛡️", "🧭", "⚡", "🌙"];

/** Starting points — one click fills the form; everything stays editable. */
export const AGENT_TEMPLATES: Array<{ name: string; emoji: string; color: string; role: string }> = [
  { name: "Penny", emoji: "💸", color: "#4cd28a", role: "You're my finance person. Keep track of what I spend, flag anything weird or recurring I forgot about, and keep me posted when I get charged for something big." },
  { name: "Forge", emoji: "🎮", color: "#ff7a45", role: "You're my game developer. Build playable games and 3D scenes in the Forge — real physics, real models, polished feel. Show me it running, not a plan." },
  { name: "Atlas", emoji: "🔬", color: "#38bdf8", role: "You're my researcher. Dig into anything I ask, read the real sources, and give me the short answer first, then what you're unsure about." },
  { name: "Muse", emoji: "🎨", color: "#ec4899", role: "You're my designer. Logos, UI, posters, brand looks — make it beautiful and opinionated, and show me options side by side." },
  { name: "Rex", emoji: "🛠️", color: "#f5b942", role: "You're my senior engineer. Work in my repos, fix things surgically, run the tests, and tell me exactly what changed." },
  { name: "Coach", emoji: "🏋️", color: "#ef4444", role: "You're my fitness and health coach. Plan my training and meals, keep me honest, and check in on how I'm doing." },
];

export function blankDraft(provider: string, model: string): AgentDraft {
  return { name: "", emoji: "🦊", color: AGENT_COLORS[0]!, provider, model, instructions: "" };
}

export function draftOf(agent: AgentVm): AgentDraft {
  return {
    name: agent.name,
    emoji: agent.emoji ?? "",
    color: agent.color ?? AGENT_COLORS[0]!,
    provider: agent.provider,
    model: agent.model,
    instructions: agent.instructions,
  };
}

/** "[text from Bob · urgent] hey" → who and what (agent-to-agent texts). */
export function parseAgentText(text: string): { from: string; urgent: boolean; body: string } | null {
  const m = /^\[text from ([^\]]+?)( · urgent)?\]\s*([\s\S]*)$/.exec(text);
  return m ? { from: m[1]!.trim(), urgent: Boolean(m[2]), body: m[3] ?? "" } : null;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2)).toUpperCase();
}

/** One agent's face: their emoji (or initials) on their colour. Ares wears
 *  the house mark. A busy agent gets a slow orbiting ring (rotation only —
 *  nothing flashes). */
export function AgentAvatar({
  agent,
  size = 36,
  busy,
  unread,
  title,
}: {
  agent: Pick<AgentVm, "id" | "name" | "emoji" | "color"> | null;
  size?: number;
  busy?: boolean;
  unread?: boolean;
  title?: string;
}) {
  const isAres = !agent || agent.id === ARES_AGENT_ID;
  const color = isAres ? "#c8794a" : agent!.color ?? AGENT_COLORS[0]!;
  return (
    <span
      className="agentAvatar"
      data-ares={isAres ? "1" : "0"}
      data-busy={busy ? "1" : "0"}
      title={title ?? (isAres ? "Ares" : agent!.name)}
      style={{ width: size, height: size, ["--agent" as string]: color, fontSize: Math.round(size * 0.48) }}
    >
      {isAres ? (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="agentAresMark">
          <path d="M12 2.5 20 7v10l-8 4.5L4 17V7Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M12 6.5 16.5 9v6L12 17.5 7.5 15V9Z" fill="currentColor" opacity=".9" />
        </svg>
      ) : agent!.emoji ? (
        <span className="agentEmoji">{agent!.emoji}</span>
      ) : (
        <span className="agentInitials" style={{ fontSize: Math.round(size * 0.36) }}>{initials(agent!.name)}</span>
      )}
      {unread ? <i className="agentUnread" aria-label="new messages" /> : null}
    </span>
  );
}

export interface AgentRowVm {
  agent: AgentVm | null; // null = Ares
  preview: string;
  busy: boolean;
  unread: boolean;
  chats: number;
}

/** The Codex-style dot strip: every agent as a dot, presence at a glance. */
export function AgentDock({
  rows,
  selectedId,
  onSelect,
  onNew,
  floating,
}: {
  rows: AgentRowVm[];
  selectedId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** A vertical strip pinned to the window's left edge (rail collapsed). */
  floating?: boolean;
}) {
  return (
    <div className="agentDock" data-floating={floating ? "1" : "0"} role="tablist" aria-label="Agents">
      {rows.map((r) => {
        const id = r.agent?.id ?? ARES_AGENT_ID;
        return (
          <button key={id} role="tab" aria-selected={selectedId === id} className="agentDot" data-on={selectedId === id ? "1" : "0"} onClick={() => onSelect(id)} title={r.agent?.name ?? "Ares"}>
            <AgentAvatar agent={r.agent} size={30} busy={r.busy} unread={r.unread} />
          </button>
        );
      })}
      <button className="agentDot agentDotNew" onClick={onNew} title="New agent" aria-label="New agent">
        <span>+</span>
      </button>
    </div>
  );
}

/** The contact list — iMessage rows: face, name, last line, presence. */
export function AgentList({
  rows,
  selectedId,
  onSelect,
  onEdit,
  children,
}: {
  rows: AgentRowVm[];
  selectedId: string;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  /** The selected agent's chats, rendered under its row. */
  children?: ReactNode;
}) {
  return (
    <nav className="agentList">
      {rows.map((r) => {
        const id = r.agent?.id ?? ARES_AGENT_ID;
        const on = selectedId === id;
        return (
          <div key={id} className="agentRowWrap" data-on={on ? "1" : "0"}>
            <div className="agentRow" data-on={on ? "1" : "0"}>
              <button className="agentRowMain" onClick={() => onSelect(id)}>
                <AgentAvatar agent={r.agent} size={38} busy={r.busy} unread={r.unread && !on} />
                <span className="agentRowText">
                  <span className="agentRowTop">
                    <strong>{r.agent?.name ?? "Ares"}</strong>
                    {r.busy ? <em className="agentTyping"><i /><i /><i /></em> : r.chats > 0 ? <em>{r.chats}</em> : null}
                  </span>
                  <span className="agentRowPreview">{r.preview}</span>
                </span>
              </button>
              {r.agent ? (
                <button className="agentRowEdit" title={`${r.agent.name}'s profile`} aria-label={`${r.agent.name}'s profile`} onClick={() => onEdit(id)}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg>
                </button>
              ) : null}
            </div>
            {on && children ? <div className="agentChats">{children}</div> : null}
          </div>
        );
      })}
    </nav>
  );
}

/** Create or edit an agent: face, name, brain, role. */
export function AgentEditor({
  initial,
  existing,
  providers,
  takenNames,
  requestCatalog,
  error,
  onSave,
  onDelete,
  onClose,
}: {
  initial: AgentDraft;
  /** Editing this agent (vs creating one). */
  existing?: AgentVm;
  providers: string[];
  takenNames: string[];
  requestCatalog: (provider: string) => void;
  error?: string;
  onSave: (draft: AgentDraft) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial);
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const set = <K extends keyof AgentDraft>(k: K, v: AgentDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  useEffect(() => {
    requestAnimationFrame(() => nameRef.current?.focus());
  }, []);
  useEffect(() => {
    const onCatalog = (ev: Event) => {
      const detail = (ev as CustomEvent<{ provider?: string; models?: Array<{ id?: string }> }>).detail;
      if (!detail?.provider) return;
      const ids = (detail.models ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
      setCatalog((c) => ({ ...c, [String(detail.provider)]: ids }));
    };
    window.addEventListener("ares:model-catalog", onCatalog);
    return () => window.removeEventListener("ares:model-catalog", onCatalog);
  }, []);
  useEffect(() => {
    if (draft.provider) requestCatalog(draft.provider);
  }, [draft.provider, requestCatalog]);

  const models = catalog[draft.provider] ?? [];
  const nameClash = useMemo(
    () => draft.name.trim() && (draft.name.trim().toLowerCase() === "ares" || takenNames.some((n) => n.toLowerCase() === draft.name.trim().toLowerCase() && n !== existing?.name)),
    [draft.name, takenNames, existing?.name],
  );
  const canSave = draft.name.trim().length > 0 && !nameClash && draft.provider && draft.model.trim();
  const preview: AgentVm = { id: existing?.id ?? "draft", name: draft.name || "New agent", emoji: draft.emoji || undefined, color: draft.color, provider: draft.provider, model: draft.model, instructions: draft.instructions, threads: [] };

  return (
    <div className="agentScrim" onClick={onClose}>
      <div className="agentSheet" role="dialog" aria-label={existing ? `Edit ${existing.name}` : "New agent"} onClick={(e) => e.stopPropagation()}>
        <header className="agentSheetHead">
          <AgentAvatar agent={preview} size={64} />
          <div>
            <h3>{existing ? draft.name || existing.name : "New agent"}</h3>
            <p>{existing ? "Their own memory, their own Forge, their own model." : "A contact with their own role, memory, Forge and model — like texting a specialist."}</p>
          </div>
          <button className="agentClose" onClick={onClose} aria-label="Close">×</button>
        </header>

        {!existing ? (
          <div className="agentTemplates">
            {AGENT_TEMPLATES.map((t) => (
              <button key={t.name} className="agentTemplate" onClick={() => setDraft((d) => ({ ...d, name: takenNames.includes(t.name) ? d.name : t.name, emoji: t.emoji, color: t.color, instructions: t.role }))}>
                <span>{t.emoji}</span>
                {t.name}
              </button>
            ))}
          </div>
        ) : null}

        <label className="agentField">
          <span>Name</span>
          <input ref={nameRef} value={draft.name} maxLength={40} placeholder="Bob" spellCheck={false} onChange={(e) => set("name", e.target.value)} />
          {nameClash ? <em className="agentFieldErr">{draft.name.trim().toLowerCase() === "ares" ? "Ares is the default agent" : "That name is taken"}</em> : null}
        </label>

        <div className="agentField">
          <span>Face</span>
          <div className="agentEmojiGrid">
            {AGENT_EMOJI.map((e) => (
              <button key={e} data-on={draft.emoji === e ? "1" : "0"} onClick={() => set("emoji", e)}>{e}</button>
            ))}
          </div>
          <div className="agentSwatches">
            {AGENT_COLORS.map((c) => (
              <button key={c} data-on={draft.color === c ? "1" : "0"} style={{ background: c }} onClick={() => set("color", c)} aria-label={`colour ${c}`} />
            ))}
          </div>
        </div>

        <div className="agentFieldRow">
          <label className="agentField">
            <span>Provider</span>
            <select value={draft.provider} onChange={(e) => setDraft((d) => ({ ...d, provider: e.target.value, model: "" }))}>
              {[...new Set([draft.provider, ...providers])].filter(Boolean).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="agentField">
            <span>Model</span>
            <input list="agentModelOptions" value={draft.model} placeholder={models[0] ?? "model id"} spellCheck={false} onChange={(e) => set("model", e.target.value)} />
            <datalist id="agentModelOptions">
              {models.map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>
        </div>

        <label className="agentField">
          <span>Role — brief them like a person</span>
          <textarea
            value={draft.instructions}
            rows={5}
            maxLength={4000}
            placeholder="You're my finance guy. Keep me posted when I get charged for anything over $50…"
            onChange={(e) => set("instructions", e.target.value)}
          />
        </label>

        {error ? <p className="agentSheetErr">{error}</p> : null}

        <footer className="agentSheetFoot">
          {existing && onDelete ? (
            confirmDelete ? (
              <button className="agentDanger" onClick={onDelete}>Delete {existing.name} — chats stay, as Ares</button>
            ) : (
              <button className="agentGhost" onClick={() => setConfirmDelete(true)}>Delete agent</button>
            )
          ) : <span />}
          <div>
            <button className="agentGhost" onClick={onClose}>Cancel</button>
            <button className="agentPrimary" disabled={!canSave} onClick={() => canSave && onSave({ ...draft, name: draft.name.trim(), model: draft.model.trim() })}>
              {existing ? "Save" : "Create agent"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** An empty chat with an agent: their card, front and centre. */
export function AgentHero({
  agent,
  others,
  onSend,
  onEdit,
}: {
  agent: AgentVm;
  others: AgentVm[];
  onSend: (text: string) => void;
  onEdit: () => void;
}) {
  const role = agent.instructions.trim();
  const starters = [
    { label: "What can you do for me?", q: "Introduce yourself in a few lines — what you'll handle for me and how." },
    { label: "Build something in the Forge", q: "Show me what you can do: build something that fits your role in the Forge and show it running." },
    others[0]
      ? { label: `Loop in ${others[0].name}`, q: `Text ${others[0].name} and coordinate with them on something useful for me, then tell me what you two decided.` }
      : { label: "Remember this about me", q: "Ask me three questions that would make you better at your role, and remember the answers." },
  ];
  return (
    <div className="empty agentHero" style={{ ["--agent" as string]: agent.color ?? AGENT_COLORS[0]! }}>
      <div className="agentHeroGlow" aria-hidden="true" />
      <button className="agentHeroFace" onClick={onEdit} title={`${agent.name}'s profile`}>
        <AgentAvatar agent={agent} size={104} />
      </button>
      <h2 className="agentHeroName">{agent.name}</h2>
      <div className="agentHeroChips">
        <span>{agent.model}</span>
        <span>own memory</span>
        <span>own Forge</span>
        {agent.onPhone ? <span>on your iPhone</span> : null}
      </div>
      {role ? <p className="agentHeroRole">{role.length > 240 ? role.slice(0, 239) + "…" : role}</p> : <p className="agentHeroRole agentHeroRoleEmpty">No role yet — <button onClick={onEdit}>brief {agent.name}</button> so they know their lane.</p>}
      <div className="agentHeroStarters">
        {starters.map((s) => (
          <button key={s.label} onClick={() => onSend(s.q)} title={s.q}>{s.label}</button>
        ))}
      </div>
    </div>
  );
}

/** name → face, for rendering an agent-to-agent text anywhere (a transcript
 *  item only carries the sender's name). Refreshed by App on every render. */
const agentFaces = new Map<string, { emoji?: string; color?: string }>();
export function rememberAgentFaces(agents: readonly AgentVm[]): void {
  for (const a of agents) agentFaces.set(a.name.toLowerCase(), { emoji: a.emoji, color: a.color });
}
export function agentFaceByName(name: string): { emoji?: string; color?: string } {
  return agentFaces.get(name.toLowerCase()) ?? {};
}
