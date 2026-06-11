// Ares desktop — v2, ground-up rebuild.
//
// Anatomy (the field-validated shape, worn in Ares bronze):
//   left rail    — brand, new session, sessions inbox, settings, status dot
//   center       — chat: user/assistant turns, collapsed tool-step cards,
//                  inline thinking, permission cards, usage meters
//   composer     — one clean bar: model + reasoning chips, send
//   footer       — ambient telemetry: daemon state, model, tokens, version
//
// Design law: flat obsidian surfaces, one bronze accent, steel for success,
// crimson strictly for danger. No glass, no animated backdrop — the only
// iconography is the static god relief at the edge of vision.
//
// The daemon bridge contract is unchanged from the legacy app (App.legacy.tsx):
// ares_start_daemon / ares_drain_events polling + ares:event-buffered push,
// ares_send, ares_restart_daemon, ares_set_reasoning, ares_permission_response.
// In a plain browser (no native bridge) the app runs in DEMO mode with a
// seeded transcript so the design is verifiable end to end.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";

// ─── Bridge contract ───────────────────────────────────────────────────────

interface AresEvent {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  toolName?: string;
  status?: string;
  source?: string;
  reason?: string;
  decision?: string;
  level?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  touchedFiles?: string[];
  activityDescription?: string;
  display?: string;
  output?: unknown;
  input?: unknown;
  error?: unknown;
  event?: AresEvent;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number };
}

interface BufferedEvent {
  seq: number;
  event: AresEvent;
}

interface DaemonStatus {
  running: boolean;
  root?: string | null;
  provider?: string | null;
  model?: string | null;
}

function hasNativeBridge(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

// ─── View model: the event stream folds into transcript items ─────────────

type ReasoningLevel = "low" | "medium" | "high" | "max";

interface ToolStep {
  id: string;
  label: string;
  name: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
  detail?: string;
}

type Item =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string; thinking: string; streaming: boolean }
  | { kind: "tools"; key: string; steps: ToolStep[]; startedAt: number }
  | { kind: "usage"; key: string; input: number; output: number; durationMs: number; status: string }
  | { kind: "permission"; key: string; id: string; toolName: string; reason: string; decided?: string }
  | { kind: "notice"; key: string; text: string; tone: "dim" | "warn" | "bad" }
  | { kind: "artifact"; key: string; path: string; label: string };

interface SessionVm {
  id: string;
  title: string;
  items: Item[];
  busy: boolean;
  tokensIn: number;
  tokensOut: number;
}

let keySeq = 0;
const nextKey = () => `i${++keySeq}`;

function freshSession(): SessionVm {
  return { id: `s${Date.now()}${++keySeq}`, title: "New session", items: [], busy: false, tokensIn: 0, tokensOut: 0 };
}

/** Fold one daemon event into the session — pure-ish, mutates a draft copy. */
function foldEvent(s: SessionVm, e: AresEvent): SessionVm {
  const items = [...s.items];
  const last = items[items.length - 1];
  const session = { ...s, items };

  const openAssistant = (): Extract<Item, { kind: "assistant" }> => {
    if (last?.kind === "assistant" && last.streaming) return last;
    const fresh: Extract<Item, { kind: "assistant" }> = { kind: "assistant", key: nextKey(), text: "", thinking: "", streaming: true };
    items.push(fresh);
    return fresh;
  };

  switch (e.type) {
    case "turn_start":
      session.busy = true;
      break;
    case "text_delta": {
      const a = openAssistant();
      items[items.indexOf(a)] = { ...a, text: a.text + (e.text ?? "") };
      break;
    }
    case "thinking_delta": {
      const a = openAssistant();
      items[items.indexOf(a)] = { ...a, thinking: a.thinking + (e.text ?? "") };
      break;
    }
    case "tool_start": {
      const step: ToolStep = {
        id: e.id ?? nextKey(),
        label: e.activityDescription ?? e.name ?? "tool",
        name: e.name ?? "tool",
        status: "running",
      };
      if (last?.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      const tail = items[items.length - 1];
      if (tail?.kind === "tools") items[items.length - 1] = { ...tail, steps: [...tail.steps, step] };
      else items.push({ kind: "tools", key: nextKey(), steps: [step], startedAt: Date.now() });
      break;
    }
    case "tool_end":
    case "tool_error": {
      if (e.type === "tool_end") {
        for (const f of e.touchedFiles ?? []) {
          if (/\.html?$/i.test(f)) {
            items.push({ kind: "artifact", key: nextKey(), path: f, label: f.split(/[\\/]/).pop() ?? f });
          }
        }
      }
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind !== "tools") continue;
        const idx = it.steps.findIndex((st) => st.id === e.id);
        if (idx === -1) continue;
        const steps = [...it.steps];
        steps[idx] = {
          ...steps[idx],
          status: e.type === "tool_end" ? "ok" : "error",
          durationMs: e.durationMs,
          detail: e.type === "tool_end" ? compact(e.display ?? stringify(e.output), 1600) : compact(String(e.error ?? "failed"), 1600),
        };
        items[i] = { ...it, steps };
        break;
      }
      break;
    }
    case "permission_request":
      items.push({ kind: "permission", key: nextKey(), id: e.id ?? "", toolName: e.toolName ?? "tool", reason: e.reason ?? "" });
      break;
    case "permission_response": {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "permission" && it.id === e.id) {
          items[i] = { ...it, decided: e.decision ?? "decided" };
          break;
        }
      }
      break;
    }
    case "system_reminder_injected":
      if (e.source === "verifier") items.push({ kind: "notice", key: nextKey(), text: compact(e.text ?? "", 400), tone: "warn" });
      break;
    case "turn_end": {
      if (last?.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      const input = e.usage?.inputTokens ?? 0;
      const output = e.usage?.outputTokens ?? 0;
      items.push({ kind: "usage", key: nextKey(), input, output, durationMs: e.durationMs ?? 0, status: e.status ?? "completed" });
      session.busy = false;
      session.tokensIn += input;
      session.tokensOut += output;
      break;
    }
    case "error":
      items.push({ kind: "notice", key: nextKey(), text: compact(stringify(e.error ?? e.text ?? "error"), 500), tone: "bad" });
      session.busy = false;
      break;
    case "desktop_error":
      items.push({ kind: "notice", key: nextKey(), text: compact(e.text ?? "desktop error", 500), tone: "bad" });
      break;
    case "lifecycle":
      break; // ambient signals ride the footer, not the transcript
    default:
      break;
  }
  return session;
}

// ─── Small utilities ───────────────────────────────────────────────────────

function compact(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 1) ?? String(v);
  } catch {
    return String(v);
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

const escapeHtml = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Markdown-lite: fenced code, inline code, bold. Everything else stays prose. */
function renderMarkdown(text: string): string {
  const parts = escapeHtml(text).split(/```(\w*)\n?/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 4 === 0) {
      html += parts[i]
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    } else if (i % 4 === 2) {
      html += `<pre><code>${parts[i].replace(/\n$/, "")}</code></pre>`;
    }
  }
  return html;
}

// ─── Persistence ───────────────────────────────────────────────────────────

interface Prefs {
  provider: string;
  model: string;
  reasoning: ReasoningLevel;
}

const PREFS_KEY = "ares.desktop.v2";
function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      provider: raw.provider ?? "ollama",
      model: raw.model ?? "qwen3-coder:480b-cloud",
      reasoning: raw.reasoning === "low" || raw.reasoning === "high" || raw.reasoning === "max" ? raw.reasoning : "medium",
    };
  } catch {
    return { provider: "ollama", model: "qwen3-coder:480b-cloud", reasoning: "medium" };
  }
}
function savePrefs(p: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

// ─── Demo feed (browser preview — the design is verifiable without Tauri) ──

function demoSession(): SessionVm {
  let s = freshSession();
  s.title = "Refactor the auth flow";
  const feed: AresEvent[] = [
    { type: "turn_start" },
    { type: "thinking_delta", text: "The login handler validates sessions in two places — I should unify them before touching the middleware." },
    { type: "text_delta", text: "I'll unify the session validation first, then update the middleware. Let me look at what exists.\n" },
    { type: "tool_start", id: "t1", name: "Grep", activityDescription: "Searching for validateSession" },
    { type: "tool_end", id: "t1", durationMs: 312, display: "src/auth/session.ts:42\nsrc/middleware/guard.ts:18" },
    { type: "tool_start", id: "t2", name: "Read", activityDescription: "Reading session.ts" },
    { type: "tool_end", id: "t2", durationMs: 95, display: "export function validateSession(token: string) { … }" },
    { type: "tool_start", id: "t3", name: "Edit", activityDescription: "Editing guard.ts" },
    { type: "tool_end", id: "t3", durationMs: 141, display: "guard.ts now delegates to validateSession()" },
    { type: "text_delta", text: "Done. `guard.ts` now delegates to the canonical `validateSession()` — one source of truth.\n\n```ts\nimport { validateSession } from \"../auth/session\";\n\nexport const guard = (req) => validateSession(req.token);\n```\n\nThe verifier ran the touched tests: **green**." },
    { type: "turn_end", status: "completed", durationMs: 8400, usage: { inputTokens: 12480, outputTokens: 642 } },
  ];
  for (const e of feed) s = foldEvent(s, e);
  s.items.unshift({ kind: "user", key: nextKey(), text: "unify the duplicated session validation, then make the middleware use it" });
  s.items.push({ kind: "artifact", key: nextKey(), path: "holo-arm.html", label: "holo-arm.html" });
  s.items.push({ kind: "permission", key: nextKey(), id: "demo-perm", toolName: "Bash", reason: "git push origin main — outward effect, staged for your approval" });
  return s;
}

const DEMO_ARTIFACT_HTML = `<!doctype html><html><head><style>
  body { margin:0; height:100vh; display:grid; place-content:center; gap:14px; justify-items:center;
         background:#0c0a0b; color:#c79a4e; font-family:Consolas,monospace; }
  .ring { width:120px; height:120px; border:1px solid #c79a4e55; border-radius:50%;
          display:grid; place-items:center; animation:spin 14s linear infinite; }
  .ring::after { content:""; width:74px; height:74px; border:1px solid #c79a4e99; border-radius:50%; }
  h1 { font-size:13px; letter-spacing:.4em; margin:0; }
  p { font-size:10px; color:#645a4c; letter-spacing:.12em; margin:0; }
  @keyframes spin { to { transform:rotate(360deg); } }
</style></head><body>
  <div class="ring"></div>
  <h1>THE FORGE</h1>
  <p>demo sandbox — in the installed app this previews real artifacts</p>
</body></html>`;

// ─── App ───────────────────────────────────────────────────────────────────

type DaemonState = "starting" | "running" | "stopped" | "error";

function App() {
  const native = useMemo(hasNativeBridge, []);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [daemon, setDaemon] = useState<DaemonState>(native ? "starting" : "running");
  const [sessions, setSessions] = useState<SessionVm[]>(() => (native ? [freshSession()] : [demoSession()]));
  const [activeId, setActiveId] = useState<string>(() => "");
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panel, setPanel] = useState<{ title: string; src?: string; srcdoc?: string } | null>(null);
  const [bootGone, setBootGone] = useState(!native);
  const lastSeq = useRef(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<string>("");

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  activeRef.current = active?.id ?? "";

  const apply = (fn: (s: SessionVm) => SessionVm) => {
    setSessions((prev) => prev.map((s) => (s.id === activeRef.current || (!activeRef.current && s === prev[0]) ? fn(s) : s)));
  };

  // ── daemon boot + event ingestion (native only) ──────────────────────────
  useEffect(() => {
    if (!native) return;
    let mounted = true;
    let poller: number | null = null;
    let unlisten: (() => void) | undefined;

    const ingest = (buffered: BufferedEvent) => {
      if (!mounted || buffered.seq <= lastSeq.current) return;
      lastSeq.current = buffered.seq;
      apply((s) => {
        const next = foldEvent(s, buffered.event);
        if (next.title === "New session") {
          const firstUser = next.items.find((i) => i.kind === "user");
          if (firstUser && firstUser.kind === "user") next.title = compact(firstUser.text, 42);
        }
        return next;
      });
    };

    const poll = async () => {
      try {
        const events = await invoke<BufferedEvent[]>("ares_drain_events", { after: lastSeq.current });
        for (const b of events) ingest(b);
      } catch {
        /* daemon between states */
      }
    };

    const boot = async () => {
      try {
        unlisten = await listen<BufferedEvent>("ares:event-buffered", (ev) => ingest(ev.payload));
      } catch {
        /* polling covers it */
      }
      try {
        const state = await invoke<DaemonStatus>("ares_start_daemon", { provider: prefs.provider, model: prefs.model });
        if (!mounted) return;
        setDaemon(state.running ? "running" : "stopped");
      } catch (err) {
        if (!mounted) return;
        setDaemon("error");
        apply((s) => foldEvent(s, { type: "desktop_error", text: String(err) }));
      }
      window.setTimeout(() => mounted && setBootGone(true), 700);
      void poll();
      poller = window.setInterval(() => void poll(), 1000);
    };
    void boot();
    return () => {
      mounted = false;
      if (poller !== null) window.clearInterval(poller);
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  // autoscroll on new content
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [active?.items]);

  // ── intents ──────────────────────────────────────────────────────────────
  const send = () => {
    const text = draft.trim();
    if (!text || active?.busy) return;
    setDraft("");
    apply((s) => ({
      ...s,
      title: s.title === "New session" ? compact(text, 42) : s.title,
      items: [...s.items, { kind: "user", key: nextKey(), text }],
      busy: true,
    }));
    if (native) {
      void invoke("ares_send", { goal: text }).catch((err) => {
        apply((s) => ({ ...foldEvent(s, { type: "desktop_error", text: String(err) }), busy: false }));
      });
    } else {
      // demo: stream a canned reply so the design is testable in a browser
      window.setTimeout(() => apply((s) => foldEvent(s, { type: "turn_start" })), 150);
      const reply = "Demo mode — no daemon attached. In the installed app this streams from the Garrison.";
      reply.split(" ").forEach((word, i) => {
        window.setTimeout(() => apply((s) => foldEvent(s, { type: "text_delta", text: `${word} ` })), 300 + i * 40);
      });
      window.setTimeout(
        () => apply((s) => foldEvent(s, { type: "turn_end", status: "completed", durationMs: 1400, usage: { inputTokens: 220, outputTokens: 18 } })),
        400 + reply.split(" ").length * 40,
      );
    }
  };

  const newSession = () => {
    const fresh = freshSession();
    setSessions((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
    if (native) {
      setDaemon("starting");
      void invoke<DaemonStatus>("ares_restart_daemon", { provider: prefs.provider, model: prefs.model })
        .then((st) => setDaemon(st.running ? "running" : "stopped"))
        .catch(() => setDaemon("error"));
    }
  };

  const respondPermission = (id: string, decision: string) => {
    apply((s) => foldEvent(s, { type: "permission_response", id, decision }));
    if (native) void invoke("ares_permission_response", { id, decision }).catch(() => null);
  };

  const applyPrefs = (next: Prefs) => {
    setPrefs(next);
    savePrefs(next);
    if (native) {
      void invoke("ares_set_reasoning", { level: next.reasoning }).catch(() => null);
      setDaemon("starting");
      void invoke<DaemonStatus>("ares_restart_daemon", { provider: next.provider, model: next.model })
        .then((st) => setDaemon(st.running ? "running" : "stopped"))
        .catch(() => setDaemon("error"));
    }
    setSettingsOpen(false);
  };

  const cycleReasoning = () => {
    const order: ReasoningLevel[] = ["low", "medium", "high", "max"];
    const next = order[(order.indexOf(prefs.reasoning) + 1) % order.length];
    const p = { ...prefs, reasoning: next };
    setPrefs(p);
    savePrefs(p);
    if (native) void invoke("ares_set_reasoning", { level: next }).catch(() => null);
  };

  const openArtifact = (path: string, label: string) => {
    if (native) setPanel({ title: label, src: convertFileSrc(path) });
    else setPanel({ title: label, srcdoc: DEMO_ARTIFACT_HTML });
  };

  return (
    <div className="ares" data-daemon={daemon} data-panel={panel ? "1" : "0"}>
      {!bootGone && native ? <Boot /> : null}
      <div className="relief" aria-hidden="true" />

      <aside className="rail">
        <div className="brand" data-tauri-drag-region>
          <div className="emblem" aria-hidden="true" />
          <div>
            <h1>ARES</h1>
            <span>the battle-tested agent</span>
          </div>
        </div>

        <button className="primary" onClick={newSession}>
          + New session
        </button>

        <div className="railLabel">Sessions</div>
        <nav className="sessionList">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={s.id === (active?.id ?? "") ? "session on" : "session"}
              onClick={() => setActiveId(s.id)}
            >
              <i data-busy={s.busy ? "1" : "0"} />
              <span>{s.title}</span>
            </button>
          ))}
        </nav>

        <div className="railFoot">
          <button className="ghost" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <div className="daemonDot" title={`daemon: ${daemon}`}>
            <i data-state={daemon} />
            <span>{daemon === "running" ? "Garrison up" : daemon}</span>
          </div>
        </div>
      </aside>

      <main className="stage">
        <header className="stageHead" data-tauri-drag-region>
          <div>
            <h2>{active?.title ?? "Session"}</h2>
            <span>
              {prefs.provider} / {prefs.model}
            </span>
          </div>
          <div className="headRight">
            <span className="pill" data-state={daemon}>
              {daemon === "running" ? "ONLINE" : daemon.toUpperCase()}
            </span>
          </div>
        </header>

        <div className="chat" ref={scroller}>
          {active && active.items.length === 0 ? (
            <div className="empty">
              <div className="emptyEmblem" aria-hidden="true" />
              <h3>The Garrison stands ready.</h3>
              <p>Send a prompt below. Sessions survive this window — the daemon holds them.</p>
            </div>
          ) : null}
          {active?.items.map((item) => (
            <ItemView key={item.key} item={item} onPermission={respondPermission} onArtifact={openArtifact} />
          ))}
          {active?.busy ? <div className="working"><i /><i /><i /></div> : null}
        </div>

        <div className="composer">
          <div className="chips">
            <button className="chip" onClick={() => setSettingsOpen(true)} title="provider / model">
              {prefs.model}
            </button>
            <button className="chip" onClick={cycleReasoning} title="reasoning effort — click to cycle">
              reasoning · {prefs.reasoning}
            </button>
          </div>
          <div className="composerRow">
            <textarea
              value={draft}
              placeholder="Message Ares…"
              rows={1}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="send" onClick={send} disabled={!draft.trim() || active?.busy} aria-label="send">
              ➤
            </button>
          </div>
        </div>

        <footer className="statusBar">
          <span>
            <i className="dot" data-state={daemon} /> Garrison {daemon}
          </span>
          <span>{prefs.provider} · {prefs.model}</span>
          <span>reasoning {prefs.reasoning}</span>
          <span className="grow" />
          <span>
            ↑{fmtTokens(active?.tokensIn ?? 0)} ↓{fmtTokens(active?.tokensOut ?? 0)}
          </span>
          <span>v0.5.0</span>
        </footer>
      </main>

      {panel ? (
        <aside className="forge">
          <header>
            <strong>THE FORGE</strong>
            <span>{panel.title}</span>
            <button className="ghost" onClick={() => setPanel(null)}>
              Close
            </button>
          </header>
          <iframe title={panel.title} src={panel.src} srcDoc={panel.srcdoc} sandbox="allow-scripts" />
        </aside>
      ) : null}

      {settingsOpen ? <Settings prefs={prefs} onApply={applyPrefs} onClose={() => setSettingsOpen(false)} native={native} /> : null}
    </div>
  );
}

// ─── Transcript items ──────────────────────────────────────────────────────

function ItemView({
  item,
  onPermission,
  onArtifact,
}: {
  item: Item;
  onPermission: (id: string, decision: string) => void;
  onArtifact: (path: string, label: string) => void;
}) {
  if (item.kind === "artifact") {
    return (
      <button className="artifact" onClick={() => onArtifact(item.path, item.label)}>
        <i aria-hidden="true" />
        <span>
          <strong>{item.label}</strong>
          <em>artifact forged — open in the panel</em>
        </span>
        <span className="artifactGo">PREVIEW ▸</span>
      </button>
    );
  }
  if (item.kind === "user") {
    return (
      <div className="turn user">
        <div className="bubble">{item.text}</div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="turn assistant">
        {item.thinking ? <ThinkingView text={item.thinking} /> : null}
        {item.text ? <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} /> : null}
      </div>
    );
  }
  if (item.kind === "tools") return <ToolGroup item={item} />;
  if (item.kind === "usage") {
    return (
      <div className="usage" data-status={item.status}>
        {item.status !== "completed" ? `${item.status} · ` : ""}
        {fmtMs(item.durationMs)} · ↑{fmtTokens(item.input)} ↓{fmtTokens(item.output)}
      </div>
    );
  }
  if (item.kind === "permission") {
    return (
      <div className="gate" data-decided={item.decided ? "1" : "0"}>
        <div>
          <strong>The Gate</strong>
          <span>{item.toolName} — {item.reason || "wants to act"}</span>
        </div>
        {item.decided ? (
          <em>{item.decided}</em>
        ) : (
          <div className="gateActions">
            <button onClick={() => onPermission(item.id, "allow_once")}>Allow once</button>
            <button onClick={() => onPermission(item.id, "allow_always")}>Always</button>
            <button className="deny" onClick={() => onPermission(item.id, "deny")}>
              Deny
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="notice" data-tone={item.tone}>
      {item.text}
    </div>
  );
}

function ThinkingView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button className="thinking" data-open={open ? "1" : "0"} onClick={() => setOpen(!open)}>
      <span className="thinkLabel">thinking</span>
      <span className="thinkText">{open ? text : compact(text, 140)}</span>
    </button>
  );
}

function ToolGroup({ item }: { item: Extract<Item, { kind: "tools" }> }) {
  const [open, setOpen] = useState(false);
  const running = item.steps.some((s) => s.status === "running");
  const failed = item.steps.some((s) => s.status === "error");
  const total = item.steps.reduce((n, s) => n + (s.durationMs ?? 0), 0);
  return (
    <div className="toolGroup" data-state={failed ? "error" : running ? "running" : "ok"}>
      <button className="toolHead" onClick={() => setOpen(!open)}>
        <i className="caret" data-open={open ? "1" : "0"} />
        <span>
          Tool actions · {item.steps.length} step{item.steps.length === 1 ? "" : "s"}
        </span>
        <span className="toolMeta">{running ? "running…" : fmtMs(total)}</span>
      </button>
      {open ? (
        <div className="toolBody">
          {item.steps.map((s) => (
            <ToolStepRow key={s.id} step={s} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolStepRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="toolStep" data-status={step.status}>
      <button onClick={() => setOpen(!open)}>
        <i />
        <span className="stepLabel">{step.label}</span>
        <span className="stepMeta">{step.status === "running" ? "…" : step.durationMs !== undefined ? fmtMs(step.durationMs) : ""}</span>
      </button>
      {open && step.detail ? <pre>{step.detail}</pre> : null}
    </div>
  );
}

// ─── Boot + Settings ───────────────────────────────────────────────────────

function Boot() {
  return (
    <div className="boot">
      <div className="bootEmblem" aria-hidden="true" />
      <div className="bootTitle">ARES</div>
      <div className="bootLine" />
      <div className="bootSub">GARRISON · STANDING WATCH</div>
    </div>
  );
}

const PROVIDERS = ["ollama", "openai", "openrouter", "mock"];

function Settings({
  prefs,
  onApply,
  onClose,
  native,
}: {
  prefs: Prefs;
  onApply: (p: Prefs) => void;
  onClose: () => void;
  native: boolean;
}) {
  const [draft, setDraftPrefs] = useState<Prefs>(prefs);
  const [orKey, setOrKey] = useState("");
  return (
    <div className="scrim" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>Settings</h3>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </header>

        <section>
          <label>Provider</label>
          <div className="segment">
            {PROVIDERS.map((p) => (
              <button key={p} data-on={draft.provider === p ? "1" : "0"} onClick={() => setDraftPrefs({ ...draft, provider: p })}>
                {p}
              </button>
            ))}
          </div>
        </section>

        <section>
          <label>Model id</label>
          <input value={draft.model} onChange={(e) => setDraftPrefs({ ...draft, model: e.target.value })} spellCheck={false} />
        </section>

        <section>
          <label>Reasoning effort</label>
          <div className="segment">
            {(["low", "medium", "high", "max"] as ReasoningLevel[]).map((r) => (
              <button key={r} data-on={draft.reasoning === r ? "1" : "0"} onClick={() => setDraftPrefs({ ...draft, reasoning: r })}>
                {r}
              </button>
            ))}
          </div>
        </section>

        {draft.provider === "openrouter" ? (
          <section>
            <label>OpenRouter API key</label>
            <input
              value={orKey}
              type="password"
              placeholder="sk-or-…"
              onChange={(e) => setOrKey(e.target.value)}
              onBlur={() => {
                if (orKey.trim() && native) void invoke("ares_set_openrouter_key", { key: orKey.trim(), model: draft.model }).catch(() => null);
              }}
            />
          </section>
        ) : null}

        <footer>
          <button className="primary" onClick={() => onApply(draft)}>
            Apply · restart daemon
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─── Mount ─────────────────────────────────────────────────────────────────

const rootEl = document.getElementById("root");
if (rootEl) {
  // Vite HMR re-evaluates this module — reuse the root across hot reloads.
  const holder = window as unknown as { __aresRoot?: ReturnType<typeof createRoot> };
  holder.__aresRoot ??= createRoot(rootEl);
  holder.__aresRoot.render(<App />);
}
