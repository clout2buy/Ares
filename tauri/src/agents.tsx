// Desktop agents — the sidebar is a list of contacts, not a list of chats.
//
// Owner, 2026-10-17: "Instead of new chats it will be agents — the same as the
// iOS app, still with the Forge and all abilities. Each agent: different
// memories, different forges, different models." Every agent is the same
// Persona record the phone makes (daemon/agents.ts); each has many chats on
// the desktop. "Ares" is the implicit default agent that owns every chat not
// bound to anyone, so nothing made before agents existed moves.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./agents.css";

export const ARES_AGENT_ID = "ares";

export interface AgentVm {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  provider: string;
  model: string;
  chatModel?: string;
  /** Its default VPS (Settings → Workspaces). */
  workspaceId?: string;
  reasoningLevel?: string;
  instructions: string;
  /** Standing rules (every chat and room seat). */
  rules?: string[];
  threads: string[];
  /** Profile picture version (photos are fetched separately). */
  avatar?: string;
  onPhone?: boolean;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentDraft {
  /** A new profile picture (data: URL), "" to remove it, undefined = unchanged. */
  photo?: string;
  name: string;
  emoji: string;
  color: string;
  provider: string;
  model: string;
  instructions: string;
  /** One rule per line. */
  rules: string;
  /** The fast model it chats on in rooms ("" = the provider's fast default). */
  chatModel: string;
  /** Its default VPS ("" = none / the only one). */
  workspaceId: string;
  /** Its thinking effort ("" = the global dial). */
  effort: string;
}

/** The colours the phone app offers, so an agent looks the same on both. */
export const AGENT_COLORS = ["#ff7a45", "#f5b942", "#4cd28a", "#38bdf8", "#7c5cff", "#ec4899", "#ef4444", "#94a3b8"];
export const AGENT_EMOJI = ["🦊", "🐉", "🦉", "🐺", "🦁", "🐙", "🤖", "👾", "🧠", "💸", "📈", "🎨", "🎮", "🛠️", "🔬", "📚", "🏋️", "🍳", "✈️", "🎧", "🛡️", "🧭", "⚡", "🌙"];

/** What an agent remembers on its own (the profile sheet's Memory section). */
export interface AgentMemoryVm {
  total: number;
  items: Array<{ id: string; kind: string; content: string; at: string; tags?: string[] }>;
  /** The last action's outcome ("Handed 12 memories from Ares", "Saved to …"). */
  note?: string;
  busy?: boolean;
}

/** Effort levels an agent can pin (the daemon's ReasoningLevel ids). */
export const AGENT_EFFORTS: Array<[string, string]> = [["off", "Off"], ["minimal", "Minimal"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]];

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
  return { name: "", emoji: "", color: AGENT_COLORS[0]!, provider, model, instructions: "", rules: "", chatModel: "", workspaceId: "", effort: "" };
}

export function draftOf(agent: AgentVm): AgentDraft {
  return {
    name: agent.name,
    emoji: agent.emoji ?? "",
    color: agent.color ?? AGENT_COLORS[0]!,
    provider: agent.provider,
    model: agent.model,
    instructions: agent.instructions,
    rules: (agent.rules ?? []).join("\n"),
    chatModel: agent.chatModel ?? "",
    workspaceId: agent.workspaceId ?? "",
    effort: agent.reasoningLevel ?? "",
  };
}

/** "[text from Bob · urgent] hey" → who and what (agent-to-agent texts). */
export function parseAgentText(text: string): { from: string; urgent: boolean; body: string } | null {
  const m = /^\[text from ([^\]]+?)( · urgent)?\]\s*([\s\S]*)$/.exec(text);
  return m ? { from: m[1]!.trim(), urgent: Boolean(m[2]), body: m[3] ?? "" } : null;
}


/** Profile pictures by agent id (data: URLs from the daemon's avatar store —
 *  the same pictures the iPhone app shows). Provided once at the App root so
 *  every avatar, memoized transcript rows included, repaints when one lands. */
export const AgentPhotoContext = createContext<Record<string, string>>({});

/** The agent whose chat is on screen (null = plain Ares): the transcript
 *  renders iMessage-style, with this agent's face beside its replies. */
export const AgentChatContext = createContext<AgentVm | null>(null);

/** How a face is drawn: the living orb face, or the iPhone app's glass tile
 *  (emoji or initial on the agent's colour). The Messages surface uses tiles. */
export const AvatarStyleContext = createContext<"face" | "tile">("face");

function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The default profile picture: a living face on a glossy orb, Codex-DOT
 * style. Everything about it — eyes, mouth, cheeks, the little accessory,
 * when it blinks — is derived from the agent's id, so each agent always looks
 * like itself and no two look alike. Idle, it blinks now and then; working,
 * its eyes dart and its mouth moves. Rotation/translation only, nothing
 * flashes (and nothing moves at all under prefers-reduced-motion).
 */
export function AgentFace({ seed, color, busy }: { seed: string; color: string; busy?: boolean }) {
  const h = hashOf(seed);
  const eyes = h % 4; // 0 dots · 1 tall ovals · 2 happy arcs · 3 big shiny
  const mouth = (h >>> 3) % 5; // 0 smile · 1 grin · 2 o · 3 cat · 4 smirk
  const extra = (h >>> 6) % 6; // 0 none · 1 antenna · 2 ears · 3 halo · 4 headphones · 5 sprout
  const blush = ((h >>> 9) & 1) === 1;
  const blinkDelay = ((h >>> 11) % 50) / 10; // 0..5s, so a room of faces never blinks in sync
  const id = `f${h.toString(36)}`;
  const ink = "#16121f";
  const eyeY = 46;
  const eye = (cx: number) => {
    switch (eyes) {
      case 0: return <circle cx={cx} cy={eyeY} r="5.2" fill={ink} />;
      case 1: return <ellipse cx={cx} cy={eyeY} rx="4.4" ry="7" fill={ink} />;
      case 2: return <path d={`M${cx - 6} ${eyeY + 2} Q${cx} ${eyeY - 6} ${cx + 6} ${eyeY + 2}`} stroke={ink} strokeWidth="3.6" fill="none" strokeLinecap="round" />;
      case 3: return (
        <g>
          <ellipse cx={cx} cy={eyeY} rx="7" ry="8" fill={ink} />
          <circle cx={cx + 2.2} cy={eyeY - 3} r="2.6" fill="#fff" />
          <circle cx={cx - 2.4} cy={eyeY + 2.6} r="1.2" fill="#fff" opacity=".7" />
        </g>
      );
      default: return <path d={`M${cx - 6} ${eyeY} Q${cx} ${eyeY + 5} ${cx + 6} ${eyeY}`} stroke={ink} strokeWidth="3.4" fill="none" strokeLinecap="round" />;
    }
  };
  const mouthEl = (() => {
    switch (mouth) {
      case 0: return <path d="M42 63 Q50 70 58 63" stroke={ink} strokeWidth="3.4" fill="none" strokeLinecap="round" />;
      case 1: return <path d="M40 61 Q50 61 60 61 Q58 72 50 72 Q42 72 40 61Z" fill={ink} />;
      case 2: return <ellipse cx="50" cy="65" rx="4.2" ry="5" fill={ink} />;
      case 3: return <path d="M42 63 Q46 68 50 63 Q54 68 58 63" stroke={ink} strokeWidth="3" fill="none" strokeLinecap="round" />;
      default: return <path d="M44 65 Q52 69 58 61" stroke={ink} strokeWidth="3.4" fill="none" strokeLinecap="round" />;
    }
  })();
  return (
    <svg viewBox="0 0 100 100" className="agentFace" data-busy={busy ? "1" : "0"} aria-hidden="true" style={{ ["--blink-delay" as string]: `${blinkDelay}s` }}>
      <defs>
        <radialGradient id={`${id}b`} cx="34%" cy="28%" r="78%">
          <stop offset="0%" stopColor="#fff" stopOpacity=".95" />
          <stop offset="22%" stopColor={color} stopOpacity="1" />
          <stop offset="100%" stopColor={color} stopOpacity="1" />
        </radialGradient>
        <radialGradient id={`${id}s`} cx="50%" cy="100%" r="70%">
          <stop offset="0%" stopColor="#000" stopOpacity=".35" />
          <stop offset="100%" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="100" height="100" fill={color} />
      <rect width="100" height="100" fill={`url(#${id}b)`} opacity=".55" />
      <rect width="100" height="100" fill={`url(#${id}s)`} />
      {extra === 1 ? <g className="agentFaceBob"><path d="M50 22 L50 10" stroke={ink} strokeWidth="3" strokeLinecap="round" /><circle cx="50" cy="8" r="4.6" fill="#fff" stroke={ink} strokeWidth="2.4" /></g> : null}
      {extra === 2 ? <g fill={ink} opacity=".9"><path d="M22 30 L28 12 L38 26Z" /><path d="M78 30 L72 12 L62 26Z" /></g> : null}
      {extra === 3 ? <ellipse cx="50" cy="14" rx="18" ry="5" fill="none" stroke="#fff6b8" strokeWidth="3.4" className="agentFaceBob" /> : null}
      {extra === 4 ? <g fill="none" stroke={ink} strokeWidth="4" strokeLinecap="round"><path d="M20 52 Q20 18 50 18 Q80 18 80 52" /><rect x="13" y="46" width="11" height="18" rx="5" fill={ink} /><rect x="76" y="46" width="11" height="18" rx="5" fill={ink} /></g> : null}
      {extra === 5 ? <g className="agentFaceBob"><path d="M50 24 Q50 14 50 10" stroke="#2f7d3a" strokeWidth="3" strokeLinecap="round" /><path d="M50 14 Q42 6 36 12 Q44 18 50 14Z" fill="#4cd28a" /><path d="M50 12 Q58 4 64 10 Q56 16 50 12Z" fill="#4cd28a" /></g> : null}
      <g className="agentFaceEyes">
        <g className="agentFaceLids">{eye(38)}{eye(62)}</g>
      </g>
      {blush ? <g fill="#ff6b8a" opacity=".38"><ellipse cx="28" cy="59" rx="6.5" ry="4" /><ellipse cx="72" cy="59" rx="6.5" ry="4" /></g> : null}
      <g className="agentFaceMouth">{mouthEl}</g>
      <ellipse cx="34" cy="22" rx="16" ry="9" fill="#fff" opacity=".22" transform="rotate(-24 34 22)" />
    </svg>
  );
}

/** One agent's profile picture: their photo when they have one, otherwise
 *  their living face. Ares wears the house mark. A busy agent gets a slow
 *  orbiting ring; an agent's emoji (from the phone) rides as a corner badge. */
export function AgentAvatar({
  agent,
  size = 36,
  busy,
  unread,
  title,
  photo,
}: {
  agent: Pick<AgentVm, "id" | "name" | "emoji" | "color"> | null;
  size?: number;
  busy?: boolean;
  unread?: boolean;
  title?: string;
  /** Override the stored photo (the editor's live preview); "" forces none. */
  photo?: string;
}) {
  const photos = useContext(AgentPhotoContext);
  const avatarStyle = useContext(AvatarStyleContext);
  const isAres = !agent || agent.id === ARES_AGENT_ID;
  const id = agent?.id ?? ARES_AGENT_ID;
  const color = isAres ? "#c8794a" : agent!.color ?? AGENT_COLORS[0]!;
  const src = photo !== undefined ? photo : photos[id];
  const badge = !isAres && agent!.emoji && size >= 36 ? agent!.emoji : null;
  if (avatarStyle === "tile" && !isAres && !src) {
    const words = agent!.name.trim().split(/\s+/).filter(Boolean);
    const initial = words.length > 1 ? (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase() : (words[0]?.[0] ?? "?").toUpperCase();
    return (
      <span
        className="agentAvatar agentTile"
        data-busy={busy ? "1" : "0"}
        title={title ?? agent!.name}
        style={{ width: size, height: size, ["--agent" as string]: color }}
      >
        {agent!.emoji ? <span className="agentTileEmoji" style={{ fontSize: Math.round(size * 0.5) }}>{agent!.emoji}</span> : <span className="agentTileInitial" style={{ fontSize: Math.round(size * 0.42) }}>{initial}</span>}
        {unread ? <i className="agentUnread" aria-label="new messages" /> : null}
      </span>
    );
  }
  return (
    <span
      className="agentAvatar"
      data-ares={isAres ? "1" : "0"}
      data-busy={busy ? "1" : "0"}
      data-photo={src ? "1" : "0"}
      title={title ?? (isAres ? "Ares" : agent!.name)}
      style={{ width: size, height: size, ["--agent" as string]: color, fontSize: Math.round(size * 0.48) }}
    >
      <span className="agentAvatarClip">
        {src ? (
          <img src={src} alt="" draggable={false} />
        ) : isAres ? (
          <svg viewBox="0 0 24 24" aria-hidden="true" className="agentAresMark">
            <path d="M12 2.5 20 7v10l-8 4.5L4 17V7Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M12 6.5 16.5 9v6L12 17.5 7.5 15V9Z" fill="currentColor" opacity=".9" />
          </svg>
        ) : (
          <AgentFace seed={agent!.name.trim().toLowerCase() || agent!.id} color={color} busy={busy} />
        )}
      </span>
      {badge && !src ? <span className="agentBadge" style={{ fontSize: Math.max(10, Math.round(size * 0.3)) }}>{badge}</span> : null}
      {unread ? <i className="agentUnread" aria-label="new messages" /> : null}
    </span>
  );
}

/** Square-crop and shrink a picked image to a 512px JPEG data: URL — what the
 *  avatar store keeps (and what the iPhone app downloads). */
export async function squareAvatar(file: Blob, edge = 512): Promise<string> {
  // A data: URL, never URL.createObjectURL: the desktop's CSP allows data: in
  // img-src but not blob:, so a blob URL failed to load and EVERY photo was
  // rejected as "not an image" (owner, 2026-10-20: "we can't add profile pictures").
  if (file.type && !/^image\/(png|jpe?g|webp)$/i.test(file.type)) throw new Error("pick a PNG, JPEG or WebP picture");
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("couldn't read that file"));
    reader.readAsDataURL(file);
  });
  {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("that file is not a picture Ares can read — use PNG, JPEG or WebP"));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(edge, side);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  }
}

export interface AgentRowVm {
  agent: AgentVm | null; // null = Ares
  preview: string;
  busy: boolean;
  unread: boolean;
  chats: number;
  /** When the latest chat last moved (ISO). */
  at?: string;
}

/** Messages-app time: "9:41 AM" today, "Yesterday", a weekday this week, else a date. */
export function chatTime(iso: string | undefined, now = new Date()): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(t)) / 86_400_000);
  if (diff <= 0) return t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diff === 1) return "Yesterday";
  if (diff < 7) return t.toLocaleDateString([], { weekday: "long" });
  return t.toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" });
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
  onDelete,
  children,
}: {
  rows: AgentRowVm[];
  selectedId: string;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  /** Right-click → Delete (asks twice). */
  onDelete?: (id: string) => void;
  /** The selected agent's chats, rendered under its row. */
  children?: ReactNode;
}) {
  const [menu, setMenu] = useState<null | { id: string; x: number; y: number; confirm: boolean }>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("blur", close); };
  }, [menu]);
  const menuAgent = menu ? rows.find((r) => r.agent?.id === menu.id)?.agent : undefined;
  return (
    <nav className="agentList">
      {menu && menuAgent ? (
        <div className="agentMenu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()} role="menu">
          <button role="menuitem" onClick={() => { setMenu(null); onEdit(menu.id); }}>Profile</button>
          {onDelete ? (
            menu.confirm
              ? <button role="menuitem" className="agentMenuDanger" onClick={() => { setMenu(null); onDelete(menu.id); }}>Delete {menuAgent.name} for good</button>
              : <button role="menuitem" className="agentMenuDanger" onClick={() => setMenu({ ...menu, confirm: true })}>Delete {menuAgent.name}…</button>
          ) : null}
        </div>
      ) : null}
      {rows.map((r) => {
        const id = r.agent?.id ?? ARES_AGENT_ID;
        const on = selectedId === id;
        return (
          <div key={id} className="agentRowWrap" data-on={on ? "1" : "0"} data-unread={r.unread && !on ? "1" : "0"}>
            <div className="agentRow" data-on={on ? "1" : "0"}>
              <button className="agentRowMain" onClick={() => onSelect(id)} onContextMenu={(e) => { if (!r.agent) return; e.preventDefault(); setMenu({ id, x: e.clientX, y: e.clientY, confirm: false }); }}>
                <AgentAvatar agent={r.agent} size={46} busy={r.busy} unread={r.unread && !on} />
                <span className="agentRowText">
                  <span className="agentRowTop">
                    <strong>{r.agent?.name ?? "Ares"}</strong>
                    {r.busy ? <em className="agentTyping"><i /><i /><i /></em> : r.at ? <span className="agentRowTime">{chatTime(r.at)}</span> : null}
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
  memory,
  memorySources = [],
  onMemoryHand,
  onMemoryExport,
  onMemoryForget,
  workspaces = [],
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
  /** Edit mode: the agent's own memories and how to hand them over. */
  memory?: AgentMemoryVm;
  /** Where memories can be handed from: Ares's main memory, other agents. */
  memorySources?: Array<{ id: string; name: string }>;
  onMemoryHand?: (from: string, about: string) => void;
  onMemoryExport?: () => void;
  onMemoryForget?: (memoryId: string) => void;
  /** The owner's VPS boxes, for "works on". */
  workspaces?: Array<{ id: string; label: string }>;
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial);
  const [showIdeas, setShowIdeas] = useState(false);
  const [handFrom, setHandFrom] = useState("ares");
  const [handAbout, setHandAbout] = useState("");
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [photoErr, setPhotoErr] = useState<string | undefined>();
  const storedPhoto = useContext(AgentPhotoContext)[existing?.id ?? ""];
  const shownPhoto = draft.photo !== undefined ? draft.photo : storedPhoto ?? "";
  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoErr(undefined);
    try {
      set("photo", await squareAvatar(file));
    } catch (error) {
      setPhotoErr(error instanceof Error ? error.message : String(error));
    }
  };
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
          <button className="agentPhotoPick" onClick={() => fileRef.current?.click()} title="Choose a profile picture">
            <AgentAvatar agent={preview} size={84} photo={shownPhoto} />
            <span className="agentPhotoEdit">{shownPhoto ? "Change" : "Add photo"}</span>
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void pickPhoto(e.target.files?.[0]); e.target.value = ""; }} />
          <div>
            <h3>{existing ? draft.name || existing.name : "New agent"}</h3>
            <p>{existing ? "Their own memory, their own Forge, their own model." : "Make anyone you want: give them a name, a face and a job. They get their own memory, Forge and model, and still know what you've told Ares."}</p>
          </div>
          <button className="agentClose" onClick={onClose} aria-label="Close">×</button>
        </header>


        <label className="agentField">
          <span>Name</span>
          <input ref={nameRef} value={draft.name} maxLength={40} placeholder="Bob" spellCheck={false} onChange={(e) => set("name", e.target.value)} />
          {nameClash ? <em className="agentFieldErr">{draft.name.trim().toLowerCase() === "ares" ? "Ares is the default agent" : "That name is taken"}</em> : null}
        </label>

        <div className="agentField">
          <span>Profile picture</span>
          <div className="agentPhotoRow">
            <button className="agentGhost" onClick={() => fileRef.current?.click()}>{shownPhoto ? "Choose another photo" : "Upload a photo"}</button>
            {shownPhoto ? <button className="agentGhost" onClick={() => set("photo", "")}>Use their generated face</button> : <em>No photo: they wear their emoji (or their face, in the other looks).</em>}
          </div>
          {photoErr ? <em className="agentFieldErr">{photoErr}</em> : null}
          <span className="agentSubLabel">Badge emoji (optional)</span>
          <div className="agentEmojiGrid">
            {AGENT_EMOJI.map((e) => (
              <button key={e} data-on={draft.emoji === e ? "1" : "0"} onClick={() => set("emoji", draft.emoji === e ? "" : e)}>{e}</button>
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
          <span>Effort</span>
          <select value={draft.effort} onChange={(e) => set("effort", e.target.value)}>
            <option value="">Same as Ares (the global dial)</option>
            {AGENT_EFFORTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <em className="agentFieldHint">How hard they think before answering. Higher is smarter and slower; their chats keep it when you move the global dial.</em>
        </label>

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

        <label className="agentField">
          <span>Chat model in group chats</span>
          <input value={draft.chatModel} maxLength={160} spellCheck={false} placeholder={draft.provider === "anthropic" ? "claude-haiku-5-5 (fast default)" : `${draft.model || "same as above"}`} onChange={(e) => set("chatModel", e.target.value)} />
          <em className="agentFieldHint">In rooms they chat on this fast model and hand real work (building, testing) to their full model above. Leave empty for the fast default.</em>
        </label>

        {workspaces.length ? (
          <label className="agentField">
            <span>Works on (VPS)</span>
            <select value={draft.workspaceId} onChange={(e) => set("workspaceId", e.target.value)}>
              <option value="">{workspaces.length === 1 ? `${workspaces[0]!.label} (the only one)` : "No VPS"}</option>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </label>
        ) : null}

        <label className="agentField">
          <span>Standing rules — one per line</span>
          <textarea
            value={draft.rules}
            rows={3}
            maxLength={6000}
            placeholder={"In group chats, keep it to one line\nAlways @ the person you're answering"}
            onChange={(e) => set("rules", e.target.value)}
          />
          <em className="agentFieldHint">They follow {draft.name.trim() || "them"} everywhere — every chat and every room. You can also just tell them "from now on…" and they'll save it here.</em>
        </label>

        {!existing ? (
          <div className="agentIdeas">
            <button className="agentIdeasToggle" onClick={() => setShowIdeas((v) => !v)}>{showIdeas ? "▾" : "▸"} Need ideas?</button>
            {showIdeas ? (
              <div className="agentTemplates">
                {AGENT_TEMPLATES.map((t) => (
                  <button key={t.name} className="agentTemplate" title={t.role} onClick={() => setDraft((d) => ({ ...d, name: d.name.trim() || takenNames.includes(t.name) ? d.name : t.name, emoji: d.emoji || t.emoji, color: t.color, instructions: t.role }))}>
                    <span>{t.emoji}</span>
                    {t.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {existing && memory ? (
          <div className="agentField agentMemory">
            <span>Memory · {memory.total} of their own</span>
            <p className="agentMemoryWhy">
              {existing.name} already knows what you've told Ares. These are the things only they remember. Give them more from Ares or another agent: everything, or just one topic.
            </p>
            <div className="agentMemoryHand">
              <select value={handFrom} onChange={(e) => setHandFrom(e.target.value)} aria-label="Hand memories from">
                {memorySources.map((src) => <option key={src.id} value={src.id}>{src.id === "ares" ? "From Ares (your main memory)" : `From ${src.name}`}</option>)}
              </select>
              <input value={handAbout} maxLength={200} placeholder="About… (empty = everything)" spellCheck={false} onChange={(e) => setHandAbout(e.target.value)} />
              <button className="agentGhost" disabled={memory.busy} onClick={() => onMemoryHand?.(handFrom, handAbout.trim())}>Hand over</button>
            </div>
            {memory.note ? <em className="agentMemoryNote">{memory.note}</em> : null}
            <div className="agentMemoryList">
              {memory.items.length === 0 ? (
                <div className="agentMemoryEmpty">Nothing of their own yet: they'll remember as you talk, or hand them some above.</div>
              ) : memory.items.slice(0, 60).map((m) => (
                <div key={m.id} className="agentMemoryItem">
                  <i data-kind={m.kind} />
                  <span>{m.content}</span>
                  {m.tags?.some((t) => t.startsWith("handed-from:")) ? <em>handed</em> : null}
                  <button title="Forget this" aria-label="Forget this" onClick={() => onMemoryForget?.(m.id)}>×</button>
                </div>
              ))}
            </div>
            <div className="agentMemoryFoot">
              <button className="agentGhost" disabled={memory.busy} onClick={() => onMemoryExport?.()}>Export memory</button>
            </div>
          </div>
        ) : null}

        {error ? <p className="agentSheetErr">{error}</p> : null}

        <footer className="agentSheetFoot">
          {existing && onDelete ? (
            confirmDelete ? (
              <button className="agentDanger" onClick={onDelete}>Delete {existing.name} for good — chats go to Older chats</button>
            ) : (
              <button className="agentGhost agentDeleteBtn" onClick={() => setConfirmDelete(true)}>Delete agent</button>
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
const agentFaces = new Map<string, { id?: string; emoji?: string; color?: string }>();
export function rememberAgentFaces(agents: readonly AgentVm[]): void {
  for (const a of agents) agentFaces.set(a.name.toLowerCase(), { id: a.id, emoji: a.emoji, color: a.color });
}
export function agentFaceByName(name: string): { id?: string; emoji?: string; color?: string } {
  return agentFaces.get(name.toLowerCase()) ?? {};
}
