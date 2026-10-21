// The Messages shell — the iPhone app's chrome on the desktop.
//
// Owner, 2026-10-20: "the settings, the download and the Forge buttons on the
// top right are garbage… we don't need the HELM… repurpose what the iOS app
// does… we need a minimize button… you're reusing a lot of the old UI." So the
// Messages surface gets its OWN title bar and tab bar instead of restyled
// medallions: one line-icon set (Ionicons-like, 24px grid, 1.8 stroke), a tab
// bar with the app's five tabs, each with its own light, and window controls
// that do what a desktop app's do.
import type { ReactNode } from "react";
import "./shell.css";

export type IconName =
  | "chat" | "pulse" | "news" | "grid" | "devices" | "search" | "forge" | "settings"
  | "minimize" | "maximize" | "close" | "at" | "plus" | "people" | "sidebar" | "download";

const PATHS: Record<IconName, ReactNode> = {
  chat: <path d="M12 4c4.7 0 8.5 3.1 8.5 7s-3.8 7-8.5 7c-1 0-2-.1-2.9-.4L5 19.5l1.2-3.4C4.6 14.8 3.5 13 3.5 11c0-3.9 3.8-7 8.5-7Z" />,
  pulse: <path d="M3 12.5h3.6l2.3-6 4.2 11.5 2.6-7 1.2 1.5H21" />,
  news: <><rect x="4" y="5" width="13" height="14" rx="2.2" /><path d="M17 9h2.2a1 1 0 0 1 1 1v6.8A2.2 2.2 0 0 1 18 19H6.4" /><path d="M7.5 9h6M7.5 12h6M7.5 15h4" /></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><rect x="13" y="13" width="7" height="7" rx="2" /></>,
  devices: <><rect x="3" y="4.5" width="18" height="12" rx="2.2" /><path d="M9 20h6M12 16.5V20" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>,
  forge: <><path d="M12 3.5 19.5 7.7v8.6L12 20.5l-7.5-4.2V7.7L12 3.5Z" /><path d="m4.8 7.9 7.2 4.1 7.2-4.1M12 12v8.3" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2 5.6 5.6" /></>,
  minimize: <path d="M6 12h12" />,
  maximize: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  close: <path d="m7 7 10 10M17 7 7 17" />,
  at: <><circle cx="12" cy="12" r="3.6" /><path d="M15.6 12v1.4a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  people: <><circle cx="9" cy="9" r="3.2" /><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6" /><circle cx="16.5" cy="8" r="2.6" /><path d="M15.4 13.6c2.4-.2 4.4 1.1 5.1 3.9" /></>,
  sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9 4.5v15" /></>,
  download: <><path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5" /><path d="M4.5 16.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1.5" /></>,
};

export function Icon({ name, size = 22, filled, title }: { name: IconName; size?: number; filled?: boolean; title?: string }) {
  return (
    <svg className="msIcon" data-filled={filled ? "1" : "0"} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}

// ─── the title bar ─────────────────────────────────────────────────────────

export function MsgTitlebar({
  daemon,
  forgeOpen,
  credits,
  native,
  onDrag,
  onAccount,
  onSearch,
  onForge,
  onExport,
  onSettings,
  onMinimize,
  onMaximize,
  onClose,
}: {
  daemon: string;
  forgeOpen: boolean;
  credits?: number;
  native: boolean;
  onDrag: (e: React.MouseEvent) => void;
  onAccount: () => void;
  onSearch: () => void;
  onForge: () => void;
  /** Download this chat as a text file (chat + tool calls + errors); absent = no chat open. */
  onExport?: () => void;
  onSettings: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const state = daemon === "running" ? "on" : daemon === "starting" ? "wait" : "off";
  return (
    <header className="titlebar msTitlebar" onMouseDown={onDrag}>
      <button className="msMark" onMouseDown={stop} onClick={onAccount} title="Your Ares account">
        <span className="msMarkTile" aria-hidden="true" />
        <span className="msStatus" data-state={state} title={daemon === "running" ? "Online" : daemon} />
        {typeof credits === "number" ? <em>${credits.toFixed(2)}</em> : null}
      </button>
      <div className="msDrag" />
      <div className="msTools" onMouseDown={stop}>
        <button className="msTool" onClick={onSearch} title="Search and commands (Ctrl+K)" aria-label="Search"><Icon name="search" size={19} /></button>
        <button className="msTool" data-on={forgeOpen ? "1" : "0"} onClick={onForge} title={forgeOpen ? "Close the Forge" : "Open the Forge"} aria-label="Forge"><Icon name="forge" size={19} filled={forgeOpen} /></button>
        <button className="msTool" onClick={onExport} disabled={!onExport} title="Download this chat (chat + tool calls + errors) as a text file" aria-label="Download chat"><Icon name="download" size={19} /></button>
        <button className="msTool" onClick={onSettings} title="Settings" aria-label="Settings"><Icon name="settings" size={19} /></button>
      </div>
      {native ? (
        <div className="msWin" onMouseDown={stop}>
          <button onClick={onMinimize} title="Minimize" aria-label="Minimize"><Icon name="minimize" size={16} /></button>
          <button onClick={onMaximize} title="Maximize" aria-label="Maximize"><Icon name="maximize" size={14} /></button>
          <button className="msWinClose" onClick={onClose} title="Close" aria-label="Close"><Icon name="close" size={16} /></button>
        </div>
      ) : null}
    </header>
  );
}

// ─── the tab bar ───────────────────────────────────────────────────────────

export type MsgTab = "chat" | "now" | "feed" | "made" | "devices";

const TABS: Array<{ id: MsgTab; label: string; icon: IconName; tone: string }> = [
  { id: "chat", label: "Chats", icon: "chat", tone: "#ff7a1a" },
  { id: "now", label: "Now", icon: "pulse", tone: "#ffc83d" },
  { id: "feed", label: "Feed", icon: "news", tone: "#4cc2ff" },
  { id: "made", label: "Made", icon: "grid", tone: "#a78bfa" },
  { id: "devices", label: "Devices", icon: "devices", tone: "#3fd18b" },
];

export function MsgTabBar({ active, badges, live, onChange }: { active: MsgTab | null; badges?: Partial<Record<MsgTab, number | "!">>; live?: Partial<Record<MsgTab, boolean>>; onChange: (tab: MsgTab) => void }) {
  const index = Math.max(0, TABS.findIndex((t) => t.id === active));
  const tone = TABS[index]!.tone;
  return (
    <nav className="msTabs" role="tablist" aria-label="Sections" style={{ ["--tab-i" as string]: String(index), ["--tab-tone" as string]: tone, ["--tab-n" as string]: String(TABS.length) }}>
      {active ? <span className="msTabLight" aria-hidden="true" /> : null}
      {TABS.map((t) => {
        const on = t.id === active;
        const badge = badges?.[t.id];
        return (
          <button key={t.id} role="tab" aria-selected={on} className="msTab" data-on={on ? "1" : "0"} style={{ ["--tone" as string]: t.tone }} onClick={() => onChange(t.id)} title={t.label}>
            <span className="msTabIcon">
              {live?.[t.id] ? <i className="msTabLive" aria-hidden="true" /> : null}
              <Icon name={t.icon} size={22} filled={on} />
              {badge ? <b className="msTabBadge">{badge}</b> : null}
            </span>
            <span className="msTabLabel">{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
