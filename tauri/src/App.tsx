import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { motion } from "framer-motion";
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  Cloud,
  Code2,
  Database,
  GitBranch,
  HeartPulse,
  MessageSquare,
  Minus,
  Palette,
  Play,
  Power,
  SendHorizontal,
  Settings2,
  Sparkles,
  Square,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react";
import "./styles.css";

type View = "chat" | "providers" | "mind" | "tools";
type ProviderId = "ollama" | "openai" | "mock";
type ThemeName = "signal" | "graphite" | "oxide";
type HeartbeatStatus = "idle" | "active" | "alert" | "dreaming" | "error";
type DaemonState = "starting" | "running" | "stopped" | "error";

interface EvolutionGain {
  target: string;
  delta: number;
  kind?: string;
}

interface CrixEvent {
  type: string;
  text?: string;
  name?: string;
  status?: string;
  source?: string;
  phase?: string;
  root?: string;
  error?: unknown;
  provider?: string;
  model?: string;
  durationMs?: number;
  activityDescription?: string;
  display?: string;
  output?: unknown;
  input?: unknown;
  gain?: EvolutionGain;
  // For wrapped lifecycle events: { type: "lifecycle", event: { type, gain, ... } }
  event?: CrixEvent;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
}

interface EvolutionPulse {
  id: number;
  sourceType: string;
  target: string;
  delta: number;
  kind?: string;
  createdAt: number;
}

interface DaemonStatus {
  running: boolean;
  root?: string | null;
  provider?: string | null;
  model?: string | null;
}

interface BufferedEvent {
  seq: number;
  event: CrixEvent;
}

interface ProviderModel {
  id: string;
  hint: string;
  group: string;
}

interface ProviderOption {
  id: ProviderId;
  label: string;
  note: string;
  models: ProviderModel[];
}

interface Selection {
  provider: ProviderId;
  model: string;
}

interface SessionRecord {
  id: string;
  name: string;
  events: CrixEvent[];
  createdAt: number;
  updatedAt: number;
}

const SETTINGS_KEY = "crix.desktop.settings.v2";
const SESSION_LIMIT = 220;

const PROVIDERS: ProviderOption[] = [
  {
    id: "ollama",
    label: "Ollama Cloud",
    note: "Local Ollama endpoint with cloud-capable model ids and Crix slot routing.",
    models: [
      model("qwen3-coder:480b-cloud", "Top coding reasoner", "engineering"),
      model("qwen3-coder-next:cloud", "Agentic coding", "engineering"),
      model("qwen3.5:397b-cloud", "Large multimodal reasoner", "engineering"),
      model("deepseek-v4-pro:cloud", "Frontier reasoning", "engineering"),
      model("deepseek-v4-flash:cloud", "Fast long-context reasoning", "engineering"),
      model("glm-5.1:cloud", "Flagship agentic engineering", "engineering"),
      model("kimi-k2.6:cloud", "Multimodal agentic coding", "engineering"),
      model("minimax-m2.7:cloud", "Coding and productivity", "engineering"),
      model("devstral-2:123b-cloud", "Codebase agents", "engineering"),
      model("gpt-oss:120b-cloud", "Open reasoning", "engineering"),
      model("devstral-small-2:24b-cloud", "Fast apply/edit slot", "fast"),
      model("gpt-oss:20b-cloud", "Fast summary utility", "fast"),
      model("gemini-3-flash-preview:cloud", "Fast multimodal", "general"),
      model("gemma4:31b-cloud", "Multimodal reasoning", "general"),
      model("qwen3-vl:235b-cloud", "Vision-language reasoning", "general"),
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    note: "OpenAI Responses through the existing Crix auth path.",
    models: [
      model("gpt-5.5", "Default frontier model", "frontier"),
      model("gpt-5.1-codex", "Coding-specialized", "frontier"),
      model("gpt-5.1", "General reasoning", "frontier"),
    ],
  },
  {
    id: "mock",
    label: "Mock",
    note: "Deterministic local echo provider for UI checks and demos.",
    models: [model("mock-echo", "No network, no auth", "local")],
  },
];

const THEME_LABELS: Record<ThemeName, string> = {
  signal: "Signal",
  graphite: "Graphite",
  oxide: "Oxide",
};

const STATUS_LABELS: Record<HeartbeatStatus, string> = {
  idle: "Ready",
  active: "Working",
  alert: "Attention",
  dreaming: "Dreaming",
  error: "Error",
};

const DEFAULT_SELECTION: Selection = {
  provider: "ollama",
  model: "qwen3-coder:480b-cloud",
};

function App() {
  const initial = loadDesktopSettings();
  const [theme, setTheme] = useState<ThemeName>(initial.theme);
  const [activeView, setActiveView] = useState<View>("chat");
  const [selection, setSelection] = useState<Selection>(initial.selection);
  const [draftSelection, setDraftSelection] = useState<Selection>(initial.selection);
  const [customModel, setCustomModel] = useState(initial.selection.model);
  const [sessions, setSessions] = useState<SessionRecord[]>(() => [createSession()]);
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0]?.id ?? "");
  const [status, setStatus] = useState<HeartbeatStatus>("idle");
  const [daemon, setDaemon] = useState<DaemonState>("starting");
  const [root, setRoot] = useState<string>("");
  const [message, setMessage] = useState("");
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  const lastEventSeqRef = useRef(0);

  // Weirdcore +N TARGET pulses — agent evolution telemetry the daemon
  // forwards to us as { type: "lifecycle", event: { type, gain, ... } }.
  const [pulses, setPulses] = useState<EvolutionPulse[]>([]);
  const pulseIdRef = useRef(1);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setPulses((prev) => prev.filter((p) => now - p.createdAt < 9000));
    }, 400);
    return () => window.clearInterval(timer);
  }, []);
  function pushPulse(sourceType: string, gain: EvolutionGain) {
    const id = pulseIdRef.current++;
    setPulses((prev) => [...prev.slice(-4), {
      id,
      sourceType,
      target: gain.target,
      delta: gain.delta,
      kind: gain.kind,
      createdAt: Date.now(),
    }]);
  }
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const events = activeSession?.events ?? [];
  const provider = providerById(draftSelection.provider);
  const visibleModels = provider.models;
  const running = daemon === "running";
  const stats = useMemo(() => collectStats(events), [events]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    saveDesktopSettings({ theme, selection });
  }, [theme, selection]);

  useEffect(() => {
    let mounted = true;

    invoke<DaemonStatus>("crix_start_daemon", initial.selection)
      .then((state) => {
        if (!mounted) return;
        applyDaemonStatus(state);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setDaemon("error");
        setStatus("error");
        appendToActiveSession({ type: "desktop_error", text: String(error) });
      });

    const poll = async () => {
      try {
        const events = await invoke<BufferedEvent[]>("crix_drain_events", { after: lastEventSeqRef.current });
        if (!mounted) return;
        for (const item of events) {
          lastEventSeqRef.current = Math.max(lastEventSeqRef.current, item.seq);
          handleDaemonEvent(item.event);
        }
      } catch {
        if (mounted && lastEventSeqRef.current === 0) {
          appendToActiveSession({ type: "desktop_preview", text: "Browser preview mode. Native daemon controls are available in the Tauri app." });
          lastEventSeqRef.current = Number.MAX_SAFE_INTEGER;
        }
      }
    };
    void poll();
    const poller = window.setInterval(() => void poll(), 180);

    return () => {
      mounted = false;
      window.clearInterval(poller);
    };
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [events.length, activeSessionId]);

  function appendToActiveSession(event: CrixEvent) {
    const targetSessionId = activeSessionIdRef.current;
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== targetSessionId) return session;
        const nextEvents = appendEvent(session.events, event).slice(-SESSION_LIMIT);
        return {
          ...session,
          events: nextEvents,
          updatedAt: Date.now(),
          name: session.name === "New session" && event.type === "user_send" && event.text ? titleFromPrompt(event.text) : session.name,
        };
      }),
    );
  }

  function handleDaemonEvent(detail: CrixEvent) {
    if (!detail) return;
    // Lifecycle envelope: { type: "lifecycle", event: { type, gain, ... } }.
    // Unwrap, push a +N pulse, and treat the inner event as a normal one
    // for status/recording purposes.
    if (detail.type === "lifecycle" && detail.event) {
      const inner = detail.event;
      if (inner.gain && inner.gain.target && typeof inner.gain.delta === "number") {
        pushPulse(inner.type, inner.gain);
      }
      if (inner.type === "dream_phase_started") setStatus("dreaming");
      if (inner.type === "dream_phase_ended") setStatus("idle");
      appendToActiveSession(inner);
      return;
    }
    if (detail.gain && detail.gain.target && typeof detail.gain.delta === "number") {
      pushPulse(detail.type, detail.gain);
    }
    if (detail.root) setRoot(detail.root);
    if (detail.provider && isProviderId(detail.provider)) {
      setSelection((current) => ({ provider: detail.provider as ProviderId, model: detail.model || current.model }));
      setDraftSelection((current) => ({ provider: detail.provider as ProviderId, model: detail.model || current.model }));
    }
    if (detail.model) {
      setSelection((current) => ({ ...current, model: detail.model || current.model }));
      setDraftSelection((current) => ({ ...current, model: detail.model || current.model }));
      setCustomModel(detail.model);
    }
    if (detail.type === "daemon_ready" || detail.type === "desktop_daemon_started") setDaemon("running");
    if (detail.type === "desktop_daemon_restarting") setDaemon("starting");
    if (detail.type === "desktop_daemon_stopped") setDaemon("stopped");
    if (detail.type === "daemon_error" || detail.type === "daemon_stderr" || detail.type === "error") setStatus("error");
    if (detail.type === "tool_start" || detail.type === "thinking_delta") setStatus("active");
    if (detail.type === "turn_end") setStatus(detail.status === "failed" ? "error" : "idle");
    if (detail.type === "heartbeat_tick") setStatus(detail.text || detail.reason ? "alert" : "idle");
    if (detail.type === "dream_phase_started") setStatus("dreaming");
    if (detail.type === "dream_phase_ended") setStatus("idle");
    appendToActiveSession(detail);
  }

  function applyDaemonStatus(state: DaemonStatus) {
    setDaemon(state.running ? "running" : "stopped");
    setRoot(state.root ?? "");
    if (state.provider && isProviderId(state.provider)) {
      const next = { provider: state.provider as ProviderId, model: state.model || modelForProvider(state.provider as ProviderId) };
      setSelection(next);
      setDraftSelection(next);
      setCustomModel(next.model);
    }
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const goal = message.trim();
    if (!goal || !running) return;
    setMessage("");
    appendToActiveSession({ type: "user_send", text: goal });
    try {
      await invoke("crix_send", { goal });
    } catch (error) {
      setStatus("error");
      appendToActiveSession({ type: "desktop_error", text: String(error) });
    }
  }

  async function restartWith(nextSelection = selection) {
    setDaemon("starting");
    setStatus("active");
    try {
      const state = await invoke<DaemonStatus>("crix_restart_daemon", nextSelection);
      setSelection(nextSelection);
      setDraftSelection(nextSelection);
      setCustomModel(nextSelection.model);
      applyDaemonStatus(state);
      appendToActiveSession({ type: "desktop_model_applied", provider: nextSelection.provider, model: nextSelection.model });
    } catch (error) {
      setDaemon("error");
      setStatus("error");
      appendToActiveSession({ type: "desktop_error", text: String(error) });
    }
  }

  async function stopDaemon() {
    await invoke("crix_stop_daemon");
    setDaemon("stopped");
  }

  function newSession() {
    const session = createSession();
    setSessions((current) => [session, ...current].slice(0, 24));
    setActiveSessionId(session.id);
    setActiveView("chat");
  }

  function updateDraftProvider(providerId: ProviderId) {
    const modelId = modelForProvider(providerId);
    setDraftSelection({ provider: providerId, model: modelId });
    setCustomModel(modelId);
  }

  function updateDraftModel(modelId: string) {
    setDraftSelection((current) => ({ ...current, model: modelId }));
    setCustomModel(modelId);
  }

  const activeProvider = providerById(selection.provider);

  return (
    <main className="crix-app" data-theme={theme}>
      <FxLayer status={status} running={running} />
      <EvolutionPulseDeck pulses={pulses} />
      <Titlebar />
      <aside className="sidebar">
        <div className="brandBlock">
          <div className="brandMark" data-hot={running ? "1" : "0"}>C</div>
          <div>
            <strong>Crix</strong>
            <span>{running ? "daemon linked" : daemon}</span>
          </div>
        </div>

        <div className="modeTabs">
          <NavButton active={activeView === "chat"} icon={MessageSquare} label="Chat" onClick={() => setActiveView("chat")} />
          <NavButton active={activeView === "providers"} icon={Cloud} label="Models" onClick={() => setActiveView("providers")} />
          <NavButton active={activeView === "mind"} icon={Brain} label="Mind" onClick={() => setActiveView("mind")} />
          <NavButton active={activeView === "tools"} icon={Wrench} label="Tools" onClick={() => setActiveView("tools")} />
        </div>

        <button className="newSession" type="button" onClick={newSession}>
          <Sparkles size={16} />
          New session
        </button>

        <section className="sidebarSection">
          <span className="sectionLabel">Current</span>
          <InfoLine icon={Cloud} label="Provider" value={activeProvider.label} />
          <InfoLine icon={CpuIcon} label="Model" value={selection.model} />
          <InfoLine icon={HeartPulse} label="Pulse" value={STATUS_LABELS[status]} />
          <InfoLine icon={Database} label="Events" value={String(events.length)} />
        </section>

        <section className="sidebarSection sessions">
          <span className="sectionLabel">Sessions</span>
          {sessions.map((session) => (
            <button
              className={session.id === activeSessionId ? "sessionItem active" : "sessionItem"}
              key={session.id}
              onClick={() => {
                setActiveSessionId(session.id);
                setActiveView("chat");
              }}
              title={session.name}
              type="button"
            >
              <span>{session.events.filter((event) => event.type === "user_send").length}</span>
              <strong>{session.name}</strong>
            </button>
          ))}
        </section>

        <div className="sidebarFooter">
          <span className={running ? "connectionDot online" : "connectionDot"} />
          <span>{root || "D:\\Crix"}</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="workspaceTop">
          <div>
            <h1>{activeViewTitle(activeView)}</h1>
            <p>{selection.provider} / {selection.model}</p>
          </div>
          <div className="modelDock">
            <label>
              <span>Provider</span>
              <select value={draftSelection.provider} onChange={(event) => updateDraftProvider(event.target.value as ProviderId)}>
                {PROVIDERS.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
            <label className="wide">
              <span>Model</span>
              <select value={visibleModels.some((item) => item.id === draftSelection.model) ? draftSelection.model : "__custom"} onChange={(event) => updateDraftModel(event.target.value)}>
                {visibleModels.map((item) => (
                  <option key={item.id} value={item.id}>{item.id}</option>
                ))}
                <option value="__custom">Custom...</option>
              </select>
              <ChevronDown size={14} />
            </label>
            <button className="primaryAction" type="button" onClick={() => restartWith({ ...draftSelection, model: draftSelection.model === "__custom" ? customModel : draftSelection.model })}>
              <Play size={15} />
              Apply
            </button>
            <button className="iconAction" title={running ? "Stop daemon" : "Start daemon"} type="button" onClick={running ? stopDaemon : () => restartWith(selection)}>
              {running ? <Power size={16} /> : <Play size={16} />}
            </button>
          </div>
        </header>

        {activeView === "providers" ? (
          <ProvidersView
            customModel={customModel}
            draftSelection={draftSelection}
            onApply={() => restartWith({ ...draftSelection, model: draftSelection.model === "__custom" ? customModel : draftSelection.model })}
            onCustomModel={setCustomModel}
            onModel={updateDraftModel}
            onProvider={updateDraftProvider}
            providers={PROVIDERS}
            running={running}
          />
        ) : activeView === "mind" ? (
          <MindView status={status} stats={stats} />
        ) : activeView === "tools" ? (
          <ToolsView events={events} />
        ) : (
          <ChatView
            daemon={daemon}
            events={events}
            message={message}
            onMessage={setMessage}
            onSend={sendMessage}
            refEl={transcriptRef}
            running={running}
            stats={stats}
          />
        )}
      </section>
    </main>
  );
}

function EvolutionPulseDeck({ pulses }: { pulses: EvolutionPulse[] }) {
  if (pulses.length === 0) return null;
  return (
    <div className="pulseDeck" aria-hidden="true">
      {pulses.map((pulse) => (
        <motion.div
          key={pulse.id}
          className={`pulseCard pulse-${pulseKindClass(pulse.sourceType)}`}
          initial={{ opacity: 0, y: 18, scale: 0.85, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -22, scale: 0.9 }}
          transition={{ duration: 0.38, ease: [0.18, 0.89, 0.32, 1.28] }}
        >
          <span className="pulseDelta">+{pulse.delta}</span>
          <span className="pulseTarget">{pulse.target}</span>
          {pulse.kind ? <span className="pulseKind">[{pulse.kind}]</span> : null}
        </motion.div>
      ))}
    </div>
  );
}

function pulseKindClass(sourceType: string): string {
  if (sourceType === "bootstrap_complete") return "born";
  if (sourceType === "self_evolve") return "soul";
  if (sourceType === "capture_detected") return "capture";
  if (sourceType === "recall_surfaced") return "recall";
  if (sourceType === "skill_crafted") return "skill";
  if (sourceType === "capability_changed") return "capability";
  if (sourceType === "dream_phase_ended") return "dream";
  return "default";
}

function FxLayer({ running, status }: { running: boolean; status: HeartbeatStatus }) {
  return (
    <div className={`fxLayer ${running ? "online" : ""} ${status}`} aria-hidden="true">
      <div className="fxVignette" />
      <div className="fxGrid" />
      <div className="fxScanline" />
      <div className="fxSweep" />
      <div className="fxPulse" />
      <div className="fxGlyphs">
        {Array.from({ length: 12 }, (_, index) => <span key={index}>{index % 3 === 0 ? "01" : index % 3 === 1 ? "CR" : "IX"}</span>)}
      </div>
    </div>
  );
}

function Titlebar() {
  const win = safeWindow();
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebarBrand" data-tauri-drag-region>
        <span>C</span>
        Crix
      </div>
      <div className="windowButtons">
        <button title="Minimize" type="button" onClick={() => void win?.minimize()}><Minus size={14} /></button>
        <button title="Maximize" type="button" onClick={() => void win?.toggleMaximize()}><Square size={12} /></button>
        <button title="Close" type="button" onClick={() => void win?.close()}><X size={15} /></button>
      </div>
    </div>
  );
}

function ChatView({
  daemon,
  events,
  message,
  onMessage,
  onSend,
  refEl,
  running,
  stats,
}: {
  daemon: DaemonState;
  events: CrixEvent[];
  message: string;
  onMessage: (value: string) => void;
  onSend: (event: React.FormEvent) => void;
  refEl: React.RefObject<HTMLDivElement | null>;
  running: boolean;
  stats: ReturnType<typeof collectStats>;
}) {
  return (
    <section className="chatShell">
      <div className="transcript" ref={refEl}>
        {events.length === 0 ? (
          <div className="emptyState">
            <TerminalSquare size={34} />
            <h2>Ready for a real run.</h2>
            <p>Pick a model up top, then send a prompt. The daemon is managed by the app.</p>
          </div>
        ) : (
          events.map((event, index) => <EventCard event={event} key={`${event.type}-${index}`} />)
        )}
      </div>
      <form className="composerBar" onSubmit={onSend}>
        <div className="composerTools">
          <StatusPill label="Daemon" value={daemon} tone={running ? "ok" : daemon === "error" ? "bad" : "warn"} />
          <StatusPill label="Turns" value={String(stats.turns)} />
          <StatusPill label="Tools" value={String(stats.tools)} />
          <StatusPill label="Tokens" value={formatNumber(stats.tokens)} />
        </div>
        <div className="composerInput">
          <textarea
            value={message}
            onChange={(event) => onMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Ask Crix to inspect, build, fix, or explain..."
            disabled={!running}
          />
          <button className="sendButton" disabled={!running || message.trim().length === 0} type="submit" title="Send">
            <SendHorizontal size={20} />
          </button>
        </div>
      </form>
    </section>
  );
}

function ProvidersView({
  customModel,
  draftSelection,
  onApply,
  onCustomModel,
  onModel,
  onProvider,
  providers,
  running,
}: {
  customModel: string;
  draftSelection: Selection;
  onApply: () => void;
  onCustomModel: (value: string) => void;
  onModel: (value: string) => void;
  onProvider: (value: ProviderId) => void;
  providers: ProviderOption[];
  running: boolean;
}) {
  const activeProvider = providerById(draftSelection.provider);
  const groups = groupedModels(activeProvider.models);
  return (
    <main className="providersShell">
      <section className="providerRail">
        {providers.map((provider) => (
          <button
            className={provider.id === draftSelection.provider ? "providerTile active" : "providerTile"}
            key={provider.id}
            onClick={() => onProvider(provider.id)}
            type="button"
          >
            <Cloud size={17} />
            <span>
              <strong>{provider.label}</strong>
              <small>{provider.note}</small>
            </span>
          </button>
        ))}
      </section>

      <section className="providerDetail">
        <div className="detailTitle">
          <Code2 size={20} />
          <div>
            <h2>{activeProvider.label}</h2>
            <p>{activeProvider.note}</p>
          </div>
        </div>

        <div className="customModel">
          <label>
            <span>Exact model id</span>
            <input value={customModel} onChange={(event) => {
              onCustomModel(event.target.value);
              onModel("__custom");
            }} />
          </label>
          <button className="primaryAction" type="button" onClick={onApply}>
            <Play size={15} />
            {running ? "Restart with model" : "Start with model"}
          </button>
        </div>

        {groups.map(([group, models]) => (
          <section className="modelGroup" key={group}>
            <h3>{group}</h3>
            <div className="modelGrid">
              {models.map((item) => (
                <button
                  className={item.id === draftSelection.model ? "modelTile active" : "modelTile"}
                  key={item.id}
                  onClick={() => onModel(item.id)}
                  type="button"
                >
                  <span>{cleanModelName(item.id)}</span>
                  <small>{item.hint}</small>
                  {item.id === draftSelection.model ? <Check size={16} /> : null}
                </button>
              ))}
            </div>
          </section>
        ))}
      </section>
    </main>
  );
}

function MindView({ status, stats }: { status: HeartbeatStatus; stats: ReturnType<typeof collectStats> }) {
  const cards = [
    ["Identity", "Loaded from ~/.crix/IDENTITY.md"],
    ["SOUL", "Voice and operating rules"],
    ["Memory", "Local recall before each turn"],
    ["Dreaming", "LIGHT, DEEP, and REM consolidation"],
  ];
  return (
    <main className="surfaceGrid">
      <section className="surfacePanel wide">
        <header>
          <span><Brain size={17} /> Mind State</span>
          <StatusPill label="Pulse" value={STATUS_LABELS[status]} tone={status === "error" ? "bad" : status === "alert" ? "warn" : "ok"} />
        </header>
        <div className="metricGrid">
          <MetricCard label="Turns" value={String(stats.turns)} />
          <MetricCard label="Tools" value={String(stats.tools)} />
          <MetricCard label="Dreams" value={String(stats.dreams)} />
          <MetricCard label="Recall" value={String(stats.recalls)} />
        </div>
      </section>
      {cards.map(([title, body]) => (
        <section className="surfacePanel" key={title}>
          <header><span><Sparkles size={16} /> {title}</span></header>
          <p>{body}</p>
        </section>
      ))}
    </main>
  );
}

function ToolsView({ events }: { events: CrixEvent[] }) {
  const toolEvents = events.filter((event) => event.type.startsWith("tool_")).slice(-36).reverse();
  return (
    <main className="surfaceGrid toolsGrid">
      <section className="surfacePanel wide">
        <header><span><Wrench size={17} /> Tool Runs</span></header>
        <div className="toolList">
          {toolEvents.length === 0 ? <p className="muted">No tool runs in this session yet.</p> : null}
          {toolEvents.map((event, index) => (
            <EventCard event={event} key={`${event.type}-${index}`} compact />
          ))}
        </div>
      </section>
    </main>
  );
}

function EventCard({ event, compact = false }: { event: CrixEvent; compact?: boolean }) {
  const kind = eventKind(event);
  const title = eventTitle(event);
  const text = eventText(event);
  const Icon = eventIcon(event);
  return (
    <motion.article
      className={`eventCard ${kind}${compact ? " compact" : ""}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16 }}
    >
      <div className="eventAvatar"><Icon size={16} /></div>
      <div className="eventBody">
        <header>
          <strong>{title}</strong>
          <time>{event.type}</time>
        </header>
        {text ? <pre>{text}</pre> : null}
      </div>
    </motion.article>
  );
}

function NavButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: React.ComponentType<{ size?: number }>; label: string; onClick: () => void }) {
  return (
    <button className={active ? "navButton active" : "navButton"} onClick={onClick} type="button">
      <Icon size={15} />
      {label}
    </button>
  );
}

function InfoLine({ icon: Icon, label, value }: { icon: React.ComponentType<{ size?: number }>; label: string; value: string }) {
  return (
    <div className="infoLine">
      <Icon size={14} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "ok" | "warn" | "bad" }) {
  return (
    <span className={`statusPill ${tone}`}>
      <small>{label}</small>
      {value}
    </span>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="metricCard">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function appendEvent(events: CrixEvent[], event: CrixEvent): CrixEvent[] {
  if (event.type === "text_delta") {
    const last = events[events.length - 1];
    if (last?.type === "assistant_stream") {
      return [...events.slice(0, -1), { ...last, text: `${last.text ?? ""}${event.text ?? ""}` }];
    }
    return [...events, { type: "assistant_stream", text: event.text ?? "" }];
  }
  if (event.type === "thinking_delta") {
    const last = events[events.length - 1];
    if (last?.type === "thinking_stream") {
      return [...events.slice(0, -1), { ...last, text: `${last.text ?? ""}${event.text ?? ""}` }];
    }
    return [...events, { type: "thinking_stream", text: event.text ?? "" }];
  }
  if (event.type === "message_done") return events;
  return [...events, event];
}

function collectStats(events: CrixEvent[]) {
  let tokens = 0;
  let turns = 0;
  let tools = 0;
  let dreams = 0;
  let recalls = 0;
  for (const event of events) {
    if (event.type === "turn_end") {
      turns++;
      tokens += Number(event.usage?.inputTokens ?? 0) + Number(event.usage?.outputTokens ?? 0);
    }
    if (event.type === "tool_start") tools++;
    if (event.type === "dream_phase_ended") dreams++;
    if (event.type === "memory_recall_emitted" || event.type === "system_reminder_injected" && event.source === "recall") recalls++;
  }
  return { turns, tools, tokens, dreams, recalls };
}

function eventKind(event: CrixEvent): string {
  if (event.type === "user_send") return "user";
  if (event.type === "assistant_stream") return "assistant";
  if (event.type === "thinking_stream") return "thinking";
  if (event.type.includes("error") || event.status === "failed") return "bad";
  if (event.type.startsWith("tool_")) return "tool";
  if (event.type.includes("daemon")) return "daemon";
  if (event.type.includes("dream") || event.type.includes("memory") || event.type.includes("soul")) return "mind";
  return "system";
}

function eventIcon(event: CrixEvent) {
  if (event.type === "user_send") return MessageSquare;
  if (event.type === "assistant_stream") return Bot;
  if (event.type === "thinking_stream") return Brain;
  if (event.type.startsWith("tool_")) return Wrench;
  if (event.type.includes("daemon")) return TerminalSquare;
  if (event.type.includes("dream") || event.type.includes("memory") || event.type.includes("soul")) return Brain;
  return Sparkles;
}

function eventTitle(event: CrixEvent): string {
  if (event.type === "user_send") return "You";
  if (event.type === "assistant_stream") return "Crix";
  if (event.type === "thinking_stream") return "Thinking";
  if (event.type === "tool_start") return event.name ? `Tool: ${event.name}` : "Tool started";
  if (event.type === "tool_end") return event.name ? `Tool finished: ${event.name}` : "Tool finished";
  if (event.type === "turn_end") return `Turn ${event.status ?? "ended"}`;
  if (event.type === "desktop_model_applied") return "Model applied";
  return humanize(event.type);
}

function eventText(event: CrixEvent): string {
  if (event.text) return event.text;
  if (event.error) return typeof event.error === "string" ? event.error : previewValue(event.error);
  if (event.activityDescription) return event.activityDescription;
  if (event.display) return event.display;
  if (event.provider || event.model) return [event.provider, event.model].filter(Boolean).join(" / ");
  if (event.phase) return event.phase;
  if (event.status) return event.durationMs ? `${event.status} in ${event.durationMs}ms` : event.status;
  if (event.root) return event.root;
  if (event.output !== undefined) return previewValue(event.output);
  if (event.input !== undefined) return previewValue(event.input);
  return "";
}

function providerById(id: ProviderId): ProviderOption {
  return PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0];
}

function modelForProvider(id: ProviderId): string {
  return providerById(id).models[0]?.id ?? "mock-echo";
}

function isProviderId(value: string): boolean {
  return value === "ollama" || value === "openai" || value === "mock";
}

function groupedModels(models: ProviderModel[]): Array<[string, ProviderModel[]]> {
  const groups = new Map<string, ProviderModel[]>();
  for (const item of models) {
    groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  }
  return [...groups.entries()];
}

function model(id: string, hint: string, group: string): ProviderModel {
  return { id, hint, group };
}

function createSession(): SessionRecord {
  const now = Date.now();
  return {
    id: `session-${now}-${Math.random().toString(16).slice(2)}`,
    name: "New session",
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}

function titleFromPrompt(text: string): string {
  const first = text.trim().split(/\r?\n/, 1)[0] || "New session";
  return first.length > 44 ? `${first.slice(0, 41).trim()}...` : first;
}

function activeViewTitle(view: View): string {
  if (view === "providers") return "Provider Control";
  if (view === "mind") return "Mind";
  if (view === "tools") return "Tool Deck";
  return "Session";
}

function cleanModelName(id: string): string {
  return id.replace(/-cloud$/u, "").replace(/:cloud$/u, "").replace(/:/gu, " ");
}

function humanize(value: string): string {
  return value.replace(/_/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function previewValue(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
  } catch {
    return String(value);
  }
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function loadDesktopSettings(): { theme: ThemeName; selection: Selection } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<{ theme: ThemeName; selection: Selection }>;
    const provider = parsed.selection?.provider && isProviderId(parsed.selection.provider) ? parsed.selection.provider : DEFAULT_SELECTION.provider;
    const selection = {
      provider,
      model: parsed.selection?.model || modelForProvider(provider),
    };
    return {
      theme: parsed.theme === "graphite" || parsed.theme === "oxide" || parsed.theme === "signal" ? parsed.theme : "signal",
      selection,
    };
  } catch {
    return { theme: "signal", selection: DEFAULT_SELECTION };
  }
}

function saveDesktopSettings(settings: { theme: ThemeName; selection: Selection }) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings persistence is best effort.
  }
}

function CpuIcon(props: { size?: number }) {
  return <Settings2 {...props} />;
}

function safeWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

createRoot(document.getElementById("root")!).render(<App />);
