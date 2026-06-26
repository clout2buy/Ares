import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import type { PermissionMode, Todo, TurnEvent, Usage } from "@ares/protocol";
import { currentThemeName, type ThemeName } from "./terminalUi.js";
import { onLifecycle, type LifecycleEvent } from "@ares/agent";

// Weirdcore score popup. Every evolution event emits a gain { target, delta }.
// The TUI shows the last few as floating +N TARGET cards that fade out.
interface Pulse {
  id: number;
  type: LifecycleEvent["type"];
  target: string;
  delta: number;
  kind?: string;
  createdAt: number;
}

function shouldSurfacePulse(event: LifecycleEvent): event is LifecycleEvent & { gain: { target: string; delta: number; kind?: string } } {
  return "gain" in event && typeof (event as { gain?: unknown }).gain === "object" && (event as { gain?: { target?: string } }).gain?.target != null;
}

export interface InkChatSnapshot {
  provider: string;
  model: string;
  workspace: string;
  mode: PermissionMode;
}

export interface InkCommandResult {
  kind: "handled" | "not-handled" | "exit";
  lines?: string[];
  snapshot?: InkChatSnapshot;
}

export interface InkChatOptions {
  snapshot(): InkChatSnapshot;
  resumedLines?: string[];
  sendMessage(goal: string, onEvent: (event: TurnEvent) => void): Promise<void>;
  handleCommand(line: string): Promise<InkCommandResult>;
  /** Structured model catalog per provider, for the ⌃M picker. */
  listModelOptions?(provider: string): Promise<Array<{ id: string; label?: string; hint?: string }>>;
}

interface LogLine {
  id: number;
  tone: "user" | "assistant" | "tool" | "error" | "notice" | "muted" | "diff-add" | "diff-del" | "diff-meta" | "verify";
  text: string;
  meta?: string;
  /** For tool lines: the outcome appended on tool_end (▸ Name … ✓ result). */
  result?: { ok: boolean; text: string };
  /** A wrapped continuation of the line above — render without repeating the label. */
  cont?: boolean;
}

interface RuntimeStats {
  turns: number;
  tools: number;
  errors: number;
  checkpoints: number;
  durationMs: number;
  usage: Usage;
}

interface DeckTheme {
  title: string;
  borderStyle: "single" | "round" | "bold" | "double" | "classic";
  frame: string;
  accent: string;
  accent2: string;
  accent3: string;
  text: string;
  dim: string;
  panel: string;
  input: string;
  user: string;
  assistant: string;
  tool: string;
  error: string;
  success: string;
  warn: string;
}

const h = React.createElement;

// God-of-war themes — exact desktop palette in 24-bit hex (Ink renders hex via
// chalk). `rage` is the default face: warm-black, crimson, ember, warm-tan text.
const DECK_THEMES: Record<ThemeName, DeckTheme> = {
  rage: {
    title: "RAGE", borderStyle: "round", frame: "#d6402e",
    accent: "#ff6a44", accent2: "#ffb24d", accent3: "#ff6a30",
    text: "#ece3d9", dim: "#8b756d", panel: "#d6402e", input: "#d6402e",
    user: "#ece3d9", assistant: "#ece3d9", tool: "#ff6a44",
    error: "#ff5740", success: "#6dc398", warn: "#ffb24d",
  },
  bronze: {
    title: "BRONZE", borderStyle: "round", frame: "#c79a4e",
    accent: "#e6bd72", accent2: "#ffd877", accent3: "#e0a93c",
    text: "#ece0cf", dim: "#8b7a5d", panel: "#c79a4e", input: "#c79a4e",
    user: "#ece0cf", assistant: "#ece0cf", tool: "#e6bd72",
    error: "#e36258", success: "#6dc398", warn: "#ffd877",
  },
  crimson: {
    title: "CRIMSON", borderStyle: "round", frame: "#c0504a",
    accent: "#e87a72", accent2: "#ff9a8f", accent3: "#e36258",
    text: "#ece0dd", dim: "#9b756d", panel: "#c0504a", input: "#c0504a",
    user: "#ece0dd", assistant: "#ece0dd", tool: "#e87a72",
    error: "#ff5740", success: "#6dc398", warn: "#ffb24d",
  },
  steel: {
    title: "STEEL", borderStyle: "round", frame: "#6fb3ae",
    accent: "#a6e0da", accent2: "#95e6dd", accent3: "#5fb8b0",
    text: "#dceae9", dim: "#6d8b87", panel: "#6fb3ae", input: "#6fb3ae",
    user: "#dceae9", assistant: "#dceae9", tool: "#a6e0da",
    error: "#ff5740", success: "#6dc398", warn: "#ffb24d",
  },
  nightfall: {
    title: "NIGHTFALL", borderStyle: "round", frame: "#8b8bd9",
    accent: "#b6b6f5", accent2: "#c4b6ff", accent3: "#9a8bef",
    text: "#e3e3f0", dim: "#6d6d8b", panel: "#8b8bd9", input: "#8b8bd9",
    user: "#e3e3f0", assistant: "#e3e3f0", tool: "#b6b6f5",
    error: "#ff5740", success: "#6dc398", warn: "#ffb24d",
  },
  verdant: {
    title: "VERDANT", borderStyle: "round", frame: "#6dc398",
    accent: "#9fe7bd", accent2: "#93eab8", accent3: "#59c08c",
    text: "#dceae3", dim: "#6d8b7a", panel: "#6dc398", input: "#6dc398",
    user: "#dceae3", assistant: "#dceae3", tool: "#9fe7bd",
    error: "#ff5740", success: "#6dc398", warn: "#ffd877",
  },
  cyberpunk: {
    title: "CYBERPUNK",
    borderStyle: "round",
    frame: "magenta",
    accent: "magenta",
    accent2: "cyan",
    accent3: "blue",
    text: "white",
    dim: "gray",
    panel: "magenta",
    input: "magenta",
    user: "cyan",
    assistant: "white",
    tool: "magenta",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  minimal: {
    title: "MINIMALIST",
    borderStyle: "single",
    frame: "gray",
    accent: "cyan",
    accent2: "white",
    accent3: "blue",
    text: "white",
    dim: "gray",
    panel: "gray",
    input: "blue",
    user: "cyan",
    assistant: "white",
    tool: "blue",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  matrix: {
    title: "HACKER TERMINAL",
    borderStyle: "classic",
    frame: "green",
    accent: "green",
    accent2: "green",
    accent3: "yellow",
    text: "green",
    dim: "gray",
    panel: "green",
    input: "green",
    user: "green",
    assistant: "white",
    tool: "green",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  neon: {
    title: "NEON BLUE",
    borderStyle: "round",
    frame: "blue",
    accent: "blue",
    accent2: "cyan",
    accent3: "magenta",
    text: "white",
    dim: "gray",
    panel: "blue",
    input: "cyan",
    user: "cyan",
    assistant: "white",
    tool: "blue",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  split: {
    title: "SPLIT PANEL",
    borderStyle: "round",
    frame: "magenta",
    accent: "magenta",
    accent2: "blue",
    accent3: "cyan",
    text: "white",
    dim: "gray",
    panel: "magenta",
    input: "magenta",
    user: "magenta",
    assistant: "white",
    tool: "blue",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  professional: {
    title: "BOXED PROFESSIONAL",
    borderStyle: "single",
    frame: "white",
    accent: "white",
    accent2: "gray",
    accent3: "green",
    text: "white",
    dim: "gray",
    panel: "gray",
    input: "white",
    user: "white",
    assistant: "white",
    tool: "gray",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  amber: {
    title: "MODERN DARK",
    borderStyle: "round",
    frame: "yellow",
    accent: "yellow",
    accent2: "white",
    accent3: "cyan",
    text: "white",
    dim: "gray",
    panel: "yellow",
    input: "yellow",
    user: "yellow",
    assistant: "white",
    tool: "cyan",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  dashboard: {
    title: "DASHBOARD",
    borderStyle: "round",
    frame: "cyan",
    accent: "cyan",
    accent2: "blue",
    accent3: "magenta",
    text: "white",
    dim: "gray",
    panel: "cyan",
    input: "cyan",
    user: "cyan",
    assistant: "white",
    tool: "blue",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  light: {
    title: "CLEAN LIGHT",
    borderStyle: "round",
    frame: "blue",
    accent: "blue",
    accent2: "cyan",
    accent3: "green",
    text: "black",
    dim: "gray",
    panel: "blue",
    input: "blue",
    user: "blue",
    assistant: "black",
    tool: "cyan",
    error: "red",
    success: "green",
    warn: "yellow",
  },
  midnight: {
    title: "MIDNIGHT",
    borderStyle: "round",
    frame: "blue",
    accent: "blueBright",
    accent2: "magentaBright",
    accent3: "cyanBright",
    text: "white",
    dim: "gray",
    panel: "blue",
    input: "blueBright",
    user: "cyanBright",
    assistant: "white",
    tool: "magentaBright",
    error: "redBright",
    success: "greenBright",
    warn: "yellowBright",
  },
  "mono-pro": {
    title: "MONO PRO",
    borderStyle: "single",
    frame: "gray",
    accent: "whiteBright",
    accent2: "white",
    accent3: "whiteBright",
    text: "white",
    dim: "gray",
    panel: "gray",
    input: "whiteBright",
    user: "whiteBright",
    assistant: "white",
    tool: "white",
    error: "redBright",
    success: "white",
    warn: "yellowBright",
  },
  solarized: {
    title: "SOLARIZED",
    borderStyle: "round",
    frame: "yellow",
    accent: "yellowBright",
    accent2: "cyanBright",
    accent3: "blueBright",
    text: "white",
    dim: "gray",
    panel: "yellow",
    input: "yellowBright",
    user: "cyanBright",
    assistant: "white",
    tool: "blueBright",
    error: "redBright",
    success: "greenBright",
    warn: "yellow",
  },
  synthwave: {
    title: "SYNTHWAVE",
    borderStyle: "double",
    frame: "magentaBright",
    accent: "magentaBright",
    accent2: "cyanBright",
    accent3: "blueBright",
    text: "white",
    dim: "blueBright",
    panel: "magenta",
    input: "magentaBright",
    user: "cyanBright",
    assistant: "white",
    tool: "magentaBright",
    error: "redBright",
    success: "greenBright",
    warn: "yellowBright",
  },
  graphite: {
    title: "GRAPHITE",
    borderStyle: "single",
    frame: "gray",
    accent: "whiteBright",
    accent2: "cyanBright",
    accent3: "greenBright",
    text: "white",
    dim: "gray",
    panel: "gray",
    input: "cyanBright",
    user: "cyanBright",
    assistant: "white",
    tool: "greenBright",
    error: "redBright",
    success: "greenBright",
    warn: "yellowBright",
  },
  oxide: {
    title: "OXIDE",
    borderStyle: "round",
    frame: "red",
    accent: "redBright",
    accent2: "yellowBright",
    accent3: "cyanBright",
    text: "white",
    dim: "gray",
    panel: "red",
    input: "yellowBright",
    user: "yellowBright",
    assistant: "white",
    tool: "cyanBright",
    error: "redBright",
    success: "greenBright",
    warn: "yellowBright",
  },
};

const TOOL_RAIL = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Bash",
  "PowerShell",
  "Task",
  "TodoWrite",
  "WebFetch",
  "CodeMode",
];

// ⌃P command palette — the desktop has a command surface; the terminal didn't.
const PALETTE: { cmd: string; desc: string }[] = [
  { cmd: "/help", desc: "show every command" },
  { cmd: "/model", desc: "switch the live model" },
  { cmd: "/models", desc: "list models for a provider" },
  { cmd: "/reasoning", desc: "set reasoning low|medium|high|max" },
  { cmd: "/routing", desc: "per-lane model routing" },
  { cmd: "/theme", desc: "switch theme — rage, bronze, crimson, steel…" },
  { cmd: "/themes", desc: "list installed themes" },
  { cmd: "/plan", desc: "read-only planning mode" },
  { cmd: "/code", desc: "exit plan, allow workspace writes" },
  { cmd: "/danger", desc: "toggle bypass — auto-approve tools" },
  { cmd: "/sessions", desc: "list saved sessions" },
  { cmd: "/resume", desc: "replay a session into context" },
  { cmd: "/checkpoints", desc: "list workspace checkpoints" },
  { cmd: "/undo", desc: "restore the last pre-write checkpoint" },
  { cmd: "/keys", desc: "API key status" },
  { cmd: "/settings", desc: "model, keys, routing, runtime" },
  { cmd: "/doctor", desc: "provider + runtime health" },
  { cmd: "/workspace", desc: "switch the active workspace" },
  { cmd: "/exit", desc: "close Ares" },
];

function filterPalette(query: string): { cmd: string; desc: string }[] {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  if (!q) return PALETTE;
  return PALETTE.filter((c) => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));
}

// Live activity spinner — braille frames, the "Claude is working" pulse next to
// streaming text and running tools.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ⌃O / "/model" model+provider picker — scroll, don't type names.
const PICKER_PROVIDERS = ["ollama", "openai", "anthropic", "openrouter", "deepseek"];

export async function runInkChat(options: InkChatOptions): Promise<number> {
  process.stdout.write("\u001b[?1049l\u001b[?1006l\u001b[?1000l\u001b[?25h\u001b[2J\u001b[3J\u001b[H");
  const instance = render(h(AresInkApp, { options }), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    alternateScreen: false,
    exitOnCtrlC: true,
  });
  const result = await instance.waitUntilExit();
  return typeof result === "number" ? result : 0;
}

function AresInkApp({ options }: { options: InkChatOptions }) {
  const app = useApp();
  const { rows, columns } = useWindowSize();
  const theme = deckTheme();
  const [snapshot, setSnapshot] = useState(options.snapshot());
  const [lines, setLines] = useState<LogLine[]>(() =>
    (options.resumedLines ?? []).map((text, index) => ({ id: index + 1, tone: "notice", text })),
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteSel, setPaletteSel] = useState(0);
  const [spin, setSpin] = useState(0);
  const [activity, setActivity] = useState<string | null>(null);
  const [mpOpen, setMpOpen] = useState(false);
  const [mpProvider, setMpProvider] = useState(0);
  const [mpModels, setMpModels] = useState<Array<{ id: string; label?: string; hint?: string }>>([]);
  const [mpSel, setMpSel] = useState(0);
  const [mpLoading, setMpLoading] = useState(false);
  const [stats, setStats] = useState<RuntimeStats>({
    turns: 0,
    tools: 0,
    errors: 0,
    checkpoints: 0,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  const assistantRef = useRef("");
  const lineId = useRef((options.resumedLines?.length ?? 0) + 1);
  const history = useRef<string[]>([]);
  const historyIndex = useRef<number | null>(null);

  // ─── Evolution pulses — weirdcore +N score popups ────────────────────
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const pulseId = useRef(1);
  const [frameTick, setFrameTick] = useState(0);
  useEffect(() => {
    const unsubscribe = onLifecycle((event) => {
      if (!shouldSurfacePulse(event)) return;
      const gain = event.gain;
      const id = pulseId.current++;
      setPulses((prev) => [...prev.slice(-3), {
        id,
        type: event.type,
        target: gain.target,
        delta: gain.delta,
        kind: gain.kind,
        createdAt: Date.now(),
      }]);
    });
    return unsubscribe;
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrameTick((t) => t + 1);
      const now = Date.now();
      setPulses((prev) => prev.filter((p) => now - p.createdAt < 9_000));
    }, 250);
    return () => clearInterval(timer);
  }, []);
  void frameTick;

  // Fast spinner tick — runs ONLY while a turn is in flight, so idle is free.
  useEffect(() => {
    if (!busy) {
      setSpin(0);
      return;
    }
    const id = setInterval(() => setSpin((s) => (s + 1) % SPINNER.length), 90);
    return () => clearInterval(id);
  }, [busy]);
  const frame = SPINNER[spin % SPINNER.length];

  // Load the model catalog for the picker's current provider (async, cancellable).
  useEffect(() => {
    if (!mpOpen || !options.listModelOptions) return;
    let cancelled = false;
    setMpLoading(true);
    options
      .listModelOptions(PICKER_PROVIDERS[mpProvider])
      .then((rows) => {
        if (cancelled) return;
        setMpModels(rows);
        setMpSel(0);
        setMpLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMpModels([]);
        setMpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mpOpen, mpProvider, options]);

  const layout = useMemo(() => {
    // Clean single-stream (the approved mockup) — the conversation is the page,
    // no side rail / status panel. Header + stream + input + status bar.
    const screenWidth = Math.max(60, columns - 2);
    const screenHeight = Math.max(18, rows - 1);
    const mainWidth = screenWidth;
    const mainHeight = Math.max(7, screenHeight - 11);
    return { mainWidth, mainHeight, screenWidth, screenHeight };
  }, [columns, rows]);

  const visibleLogRows = Math.max(5, layout.mainHeight - 3);
  const maxScrollOffset = Math.max(0, lines.length + (assistantDraft ? 1 : 0) - visibleLogRows);
  const scrollUp = useCallback((amount = visibleLogRows) => {
    setScrollOffset((prev) => Math.min(maxScrollOffset, prev + amount));
  }, [maxScrollOffset, visibleLogRows]);
  const scrollDown = useCallback((amount = visibleLogRows) => {
    setScrollOffset((prev) => Math.max(0, prev - amount));
  }, [visibleLogRows]);

  useTerminalMouseMode();
  const handleMouseEvent = useCallback((event: MouseEvent) => {
    if (event.button === 64) scrollUp(Math.max(3, Math.floor(visibleLogRows / 2)));
    if (event.button === 65) scrollDown(Math.max(3, Math.floor(visibleLogRows / 2)));
  }, [scrollDown, scrollUp, visibleLogRows]);

  const append = useCallback((tone: LogLine["tone"], text: string, meta?: string) => {
    const chunks = text.split(/\r?\n/).filter((line) => line.length > 0);
    setLines((prev) => {
      const next = [...prev];
      const list = chunks.length > 0 ? chunks : [text];
      list.forEach((chunk, i) => {
        next.push({ id: lineId.current++, tone, text: chunk, meta, cont: i > 0 });
      });
      return next.slice(-600);
    });
  }, []);

  const flushAssistant = useCallback(() => {
    const text = assistantRef.current.trimEnd();
    if (!text) return;
    assistantRef.current = "";
    setAssistantDraft("");
    append("assistant", text, "reply");
  }, [append]);

  // Paired tool flow: tool_start opens a "▸ Name desc" line; tool_end/_error
  // stamps the ✓/✗ result onto that same line (the mockup's `▸ Read … ✓ 1.2k`).
  const toolLineRef = useRef<number | null>(null);
  const appendToolLine = useCallback((name: string, desc: string) => {
    const id = lineId.current++;
    setLines((prev) => [...prev, { id, tone: "tool" as const, text: desc, meta: name }].slice(-600));
    toolLineRef.current = id;
  }, []);
  const finishToolLine = useCallback((ok: boolean, text: string) => {
    const id = toolLineRef.current;
    toolLineRef.current = null;
    if (id == null) {
      append(ok ? "tool" : "error", text, ok ? "ok" : "tool");
      return;
    }
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, result: { ok, text } } : l)));
  }, [append]);

  const handleEvent = useCallback(
    (event: TurnEvent) => {
      if (event.type === "text_delta") {
        assistantRef.current += event.text;
        setAssistantDraft(assistantRef.current);
        setActivity("responding");
        return;
      }
      if (event.type === "thinking_delta") {
        setActivity("thinking");
        return;
      }
      if (event.type === "tool_start") {
        flushAssistant();
        setActiveTool(event.name);
        setActivity(event.name);
        appendToolLine(event.name, event.activityDescription);
        return;
      }
      if (event.type === "tool_end") {
        setActiveTool(null);
        setActivity("responding");
        setStats((prev) => ({ ...prev, tools: prev.tools + 1 }));
        finishToolLine(true, event.display ?? `${event.durationMs}ms`);
        return;
      }
      if (event.type === "tool_progress") {
        const text = progressText(event.data);
        if (text) append("muted", text, "progress");
        return;
      }
      if (event.type === "workspace_diff") {
        appendDiff(event.diff, append);
        return;
      }
      if (event.type === "tool_error") {
        setActiveTool(null);
        setStats((prev) => ({ ...prev, errors: prev.errors + 1 }));
        finishToolLine(false, event.error);
        return;
      }
      if (event.type === "todo_updated") {
        setTodos(event.todos);
        return;
      }
      if (event.type === "checkpoint_created") {
        setStats((prev) => ({ ...prev, checkpoints: prev.checkpoints + 1 }));
        append("muted", `${event.checkpointId}${event.label ? ` ${event.label}` : ""}`, "checkpoint");
        return;
      }
      if (event.type === "system_reminder_injected") {
        append(event.source === "verifier" ? "verify" : "notice", event.text, event.source);
        return;
      }
      if (event.type === "error") {
        setStats((prev) => ({ ...prev, errors: prev.errors + 1 }));
        append("error", event.error.message, event.error.code);
        return;
      }
      if (event.type === "turn_end") {
        flushAssistant();
        setStats((prev) => ({
          ...prev,
          turns: prev.turns + 1,
          durationMs: prev.durationMs + event.durationMs,
          usage: {
            inputTokens: prev.usage.inputTokens + event.usage.inputTokens,
            outputTokens: prev.usage.outputTokens + event.usage.outputTokens,
            cacheReadTokens: (prev.usage.cacheReadTokens ?? 0) + (event.usage.cacheReadTokens ?? 0),
            cacheWriteTokens: (prev.usage.cacheWriteTokens ?? 0) + (event.usage.cacheWriteTokens ?? 0),
            reasoningTokens: (prev.usage.reasoningTokens ?? 0) + (event.usage.reasoningTokens ?? 0),
          },
        }));
      }
    },
    [append, flushAssistant, appendToolLine, finishToolLine],
  );

  const submit = useCallback(
    async (raw: string) => {
      const line = raw.trim();
      if (!line || busy) return;
      // /model and /models open the scrollable picker, not a text dump.
      if ((line === "/model" || line === "/models") && options.listModelOptions) {
        setInput("");
        setMpProvider(Math.max(0, PICKER_PROVIDERS.indexOf(snapshot.provider)));
        setMpOpen(true);
        return;
      }
      setInput("");
      setScrollOffset(0);
      history.current.push(line);
      historyIndex.current = null;
      append("user", line, "send");
      setBusy(true);
      try {
        if (line.startsWith("/")) {
          const result = await options.handleCommand(line);
          if (result.snapshot) setSnapshot(result.snapshot);
          if (result.kind === "exit") {
            app.exit(0);
            return;
          }
          if (result.kind === "handled") {
            for (const output of result.lines ?? []) append("notice", output, "command");
            return;
          }
          append("error", `Unknown command: ${line}`, "command");
          return;
        }

        await options.sendMessage(line, handleEvent);
        setSnapshot(options.snapshot());
      } catch (err) {
        append("error", err instanceof Error ? err.message : String(err), "runtime");
      } finally {
        flushAssistant();
        setBusy(false);
        setActiveTool(null);
        setActivity(null);
      }
    },
    [append, app, busy, flushAssistant, handleEvent, options, snapshot],
  );

  useInput((value, key) => {
    const mouseEvents = parseMouseEvents(value);
    if (mouseEvents.length > 0 || looksLikeMouseFragment(value)) {
      for (const event of mouseEvents) handleMouseEvent(event);
      return;
    }
    if (value.includes("\u001b[<")) return;
    if (key.ctrl && value === "c") {
      app.exit(130);
      return;
    }
    // ⌃P command palette — fuzzy command picker (the desktop has one; now so does this).
    if (paletteOpen) {
      if (key.escape || (key.ctrl && value === "p")) {
        setPaletteOpen(false);
        setInput("");
        return;
      }
      const filtered = filterPalette(input);
      if (key.upArrow) {
        setPaletteSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setPaletteSel((s) => Math.min(Math.max(0, filtered.length - 1), s + 1));
        return;
      }
      if (key.return) {
        const pick = filtered[Math.min(paletteSel, Math.max(0, filtered.length - 1))];
        setPaletteOpen(false);
        setInput("");
        if (pick) void submit(pick.cmd);
        return;
      }
      if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
        setPaletteSel(0);
        return;
      }
      if (value && !key.ctrl && !key.meta) {
        setInput((prev) => prev + value.replace(/\r?\n/g, ""));
        setPaletteSel(0);
      }
      return;
    }
    if (key.ctrl && value === "p") {
      setPaletteOpen(true);
      setPaletteSel(0);
      setInput("");
      return;
    }
    // ⌃O model + provider picker (⌃M is Enter in terminals, so ⌃O it is).
    if (mpOpen) {
      if (key.escape || (key.ctrl && value === "o")) {
        setMpOpen(false);
        return;
      }
      if (key.leftArrow) {
        setMpProvider((p) => (p - 1 + PICKER_PROVIDERS.length) % PICKER_PROVIDERS.length);
        return;
      }
      if (key.rightArrow || key.tab) {
        setMpProvider((p) => (p + 1) % PICKER_PROVIDERS.length);
        return;
      }
      if (key.upArrow) {
        setMpSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setMpSel((s) => Math.min(Math.max(0, mpModels.length - 1), s + 1));
        return;
      }
      if (key.return) {
        const m = mpModels[Math.min(mpSel, Math.max(0, mpModels.length - 1))];
        setMpOpen(false);
        if (m) void submit(`/model ${PICKER_PROVIDERS[mpProvider]} ${m.id}`);
        return;
      }
      return;
    }
    if (key.ctrl && value === "o") {
      setMpProvider(Math.max(0, PICKER_PROVIDERS.indexOf(snapshot.provider)));
      setMpOpen(true);
      return;
    }
    if (key.ctrl && value === "l") {
      setLines([]);
      setScrollOffset(0);
      return;
    }
    if (key.pageUp) {
      scrollUp();
      return;
    }
    if (key.pageDown) {
      scrollDown();
      return;
    }
    if (key.home) {
      setScrollOffset(maxScrollOffset);
      return;
    }
    if (key.end) {
      setScrollOffset(0);
      return;
    }
    if (value === "!") {
      void submit("/danger");
      return;
    }
    if (!input && value === "[") {
      scrollUp(Math.max(3, Math.floor(visibleLogRows / 2)));
      return;
    }
    if (!input && value === "]") {
      scrollDown(Math.max(3, Math.floor(visibleLogRows / 2)));
      return;
    }
    if (busy) return;
    if (key.return) {
      void submit(input);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    if (key.ctrl && value === "u") {
      setInput("");
      return;
    }
    if (key.upArrow) {
      if (history.current.length === 0) return;
      const next = historyIndex.current === null ? history.current.length - 1 : Math.max(0, historyIndex.current - 1);
      historyIndex.current = next;
      setInput(history.current[next] ?? "");
      return;
    }
    if (key.downArrow) {
      if (historyIndex.current === null) return;
      const next = historyIndex.current + 1;
      if (next >= history.current.length) {
        historyIndex.current = null;
        setInput("");
      } else {
        historyIndex.current = next;
        setInput(history.current[next] ?? "");
      }
      return;
    }
    if (key.escape) {
      setInput("");
      return;
    }
    if (value && !key.ctrl && !key.meta) {
      setInput((prev) => prev + value.replace(/\r?\n/g, ""));
    }
  });

  const displayLines = assistantDraft
    ? [...lines, { id: -1, tone: "assistant" as const, text: assistantDraft, meta: "stream" }]
    : lines;
  const bottom = Math.max(0, displayLines.length - scrollOffset);
  const start = Math.max(0, bottom - visibleLogRows);
  const visibleLines = displayLines.slice(start, bottom);

  return h(
    Box,
    { flexDirection: "column", width: layout.screenWidth, height: layout.screenHeight },
    h(Header, { snapshot, stats, theme, width: layout.screenWidth }),
    h(LogPanel, {
      theme,
      lines: visibleLines,
      totalLines: displayLines.length,
      start,
      scrollOffset,
      spinner: busy ? frame : "",
      width: layout.screenWidth,
      height: layout.mainHeight,
    }),
    todos.length > 0 ? h(TodosStrip, { theme, todos }) : null,
    pulses.length > 0 ? h(EvolutionPulses, { theme, pulses, width: layout.screenWidth }) : null,
    paletteOpen ? h(CommandPalette, { theme, query: input, selected: paletteSel, width: layout.screenWidth }) : null,
    mpOpen ? h(ModelPicker, { theme, providerIdx: mpProvider, models: mpModels, sel: mpSel, loading: mpLoading, width: layout.screenWidth }) : null,
    h(InputDeck, { theme, snapshot, busy, activity, spinner: busy ? frame : "", input, stats, width: layout.screenWidth }),
  );
}

function Header({ snapshot, stats, theme, width }: { snapshot: InkChatSnapshot; stats: RuntimeStats; theme: DeckTheme; width: number }) {
  void stats;
  const model = compactModel(snapshot.model, 30);
  const folder = snapshot.workspace.split(/[\\/]/).filter(Boolean).pop() ?? snapshot.workspace;
  // One slim line — no border, no chip boxes. The conversation is the page.
  return h(
    Box,
    { width, justifyContent: "space-between", paddingX: 1, marginBottom: 1 },
    h(
      Box,
      { gap: 1 },
      h(Text, { color: theme.accent3, bold: true }, "▲"),
      h(Text, { color: theme.accent, bold: true }, "ARES"),
      h(Text, { color: theme.dim }, model),
    ),
    h(
      Box,
      { gap: 1 },
      h(Text, { color: theme.dim }, folder),
      h(Text, { color: theme.dim }, "·"),
      h(Text, { color: theme.accent2 }, theme.title.toLowerCase()),
    ),
  );
}

function ToolRail({ theme, activeTool, width }: { theme: DeckTheme; activeTool: string | null; width: number }) {
  return h(
    Box,
    {
      flexDirection: "column",
      width,
      height: "100%",
      flexShrink: 0,
      borderStyle: theme.borderStyle,
      borderColor: theme.panel,
      paddingX: 1,
      marginRight: 1,
    },
    h(Text, { bold: true, color: theme.accent }, "TOOLS"),
    ...TOOL_RAIL.map((tool) => {
      const active = activeTool === tool;
      return h(
        Text,
        { key: tool, color: active ? theme.warn : theme.text, bold: active, wrap: "truncate" },
        `${active ? "▸" : " "} ${tool}`,
      );
    }),
  );
}

function LogPanel({
  theme,
  lines,
  totalLines,
  start,
  scrollOffset,
  spinner,
  width,
  height,
}: {
  theme: DeckTheme;
  lines: LogLine[];
  totalLines: number;
  start: number;
  scrollOffset: number;
  spinner: string;
  width: number;
  height: number;
}) {
  // Clean full-bleed conversation stream — no panel chrome. A subtle scroll
  // indicator appears only when the user has scrolled up.
  return h(
    Box,
    { flexDirection: "column", width, height, flexShrink: 1, paddingX: 1 },
    scrollOffset > 0
      ? h(
          Box,
          { justifyContent: "flex-end" },
          h(Text, { color: theme.warn }, `▴ ${start + 1}-${start + lines.length}/${totalLines} · End ↓`),
        )
      : null,
    lines.length === 0
      ? h(EmptyState, { theme })
      : lines.map((line) => h(LogText, { key: line.id, line, theme, spinner })),
  );
}

function EmptyState({ theme }: { theme: DeckTheme }) {
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, { color: theme.accent3, bold: true }, "▲ Ares stands ready."),
    h(Text, { color: theme.dim }, "Speak, and it moves — files, shell, web, the whole arsenal."),
    h(Text, { color: theme.dim }, "⌃P commands · ⌃O models (or /model) · /help for the full loadout."),
  );
}

function StatusPanel({
  theme,
  snapshot,
  stats,
  todos,
  activeTool,
  width,
}: {
  theme: DeckTheme;
  snapshot: InkChatSnapshot;
  stats: RuntimeStats;
  todos: Todo[];
  activeTool: string | null;
  width: number;
}) {
  return h(
    Box,
    {
      flexDirection: "column",
      width,
      height: "100%",
      flexShrink: 0,
      borderStyle: theme.borderStyle,
      borderColor: theme.frame,
      paddingX: 1,
      marginLeft: 1,
    },
    h(Text, { bold: true, color: theme.accent }, "STATUS"),
    h(StatusRow, { theme, label: "STATE", value: activeTool ? "working" : "active", color: activeTool ? theme.warn : theme.success }),
    h(StatusRow, { theme, label: "MODE", value: snapshot.mode, color: snapshot.mode === "plan" ? theme.warn : snapshot.mode === "bypass" ? theme.error : theme.success }),
    h(ProgressMetric, { theme, label: "CONTEXT", value: Math.min(100, Math.round((stats.usage.inputTokens / 32000) * 100)) }),
    h(StatusRow, { theme, label: "TOKENS", value: compactNumber(stats.usage.inputTokens + stats.usage.outputTokens), color: theme.accent3 }),
    h(StatusRow, { theme, label: "ERRORS", value: String(stats.errors), color: stats.errors > 0 ? theme.error : theme.dim }),
    h(Text, { color: theme.dim }, ""),
    h(Text, { bold: true, color: theme.accent }, "TODOS"),
    todos.length === 0
      ? h(Text, { color: theme.dim }, "- none active")
      : todos.slice(0, 7).map((todo) => h(TodoLine, { key: todo.id, todo, theme })),
  );
}

function InputDeck({
  theme,
  snapshot,
  busy,
  activity,
  spinner,
  input,
  stats,
  width,
}: {
  theme: DeckTheme;
  snapshot: InkChatSnapshot;
  busy: boolean;
  activity: string | null;
  spinner: string;
  input: string;
  stats: RuntimeStats;
  width: number;
}) {
  const tokens = compactNumber(stats.usage.inputTokens + stats.usage.outputTokens);
  const plan = snapshot.mode === "plan";
  const status = busy
    ? `${spinner || "▲"} ${activity ?? "working"}`
    : `${snapshot.mode} · ${tokens} · ⌃P`;
  // No box. A single faint rule, the ❯ prompt, and a right-aligned status line.
  return h(
    Box,
    { flexDirection: "column", width, marginTop: 1 },
    h(Text, { color: theme.dim }, "─".repeat(Math.max(0, width - 2))),
    h(
      Box,
      { justifyContent: "space-between", paddingX: 1 },
      h(
        Box,
        { flexShrink: 1 },
        h(Text, { color: theme.accent, bold: true }, plan ? "❯ [plan] " : "❯ "),
        h(Text, { color: input.length > 0 ? theme.text : theme.dim, wrap: "truncate" }, input.length > 0 ? input : "message ares"),
        busy ? null : h(Text, { color: theme.accent, bold: true }, "▏"),
      ),
      h(Text, { color: busy ? theme.warn : theme.dim }, status),
    ),
  );
}

function ModelPicker({
  theme,
  providerIdx,
  models,
  sel,
  loading,
  width,
}: {
  theme: DeckTheme;
  providerIdx: number;
  models: Array<{ id: string; label?: string; hint?: string }>;
  sel: number;
  loading: boolean;
  width: number;
}) {
  const provider = PICKER_PROVIDERS[providerIdx];
  const MAX = 8;
  const s = models.length ? Math.min(sel, models.length - 1) : 0;
  const start = models.length > MAX ? Math.min(Math.max(0, s - Math.floor(MAX / 2)), models.length - MAX) : 0;
  const shown = models.slice(start, start + MAX);
  return h(
    Box,
    { flexDirection: "column", width, borderStyle: theme.borderStyle, borderColor: theme.accent, paddingX: 1, marginTop: 1 },
    h(
      Box,
      { justifyContent: "space-between" },
      h(
        Box,
        { gap: 1 },
        h(Text, { color: theme.accent, bold: true }, "▲ MODELS"),
        ...PICKER_PROVIDERS.map((p, i) =>
          h(Text, { key: p, color: i === providerIdx ? theme.accent2 : theme.dim, bold: i === providerIdx }, i === providerIdx ? `[${p}]` : p),
        ),
      ),
      h(Text, { color: theme.dim }, "←→ provider · ↑↓ · enter · esc"),
    ),
    loading
      ? h(Text, { color: theme.dim }, `  loading ${provider}…`)
      : models.length === 0
        ? h(Text, { color: theme.dim }, `  no models for ${provider} (check key / connection)`)
        : shown.map((m, i) => {
            const active = start + i === s;
            return h(
              Box,
              { key: m.id, justifyContent: "space-between" },
              h(Text, { color: active ? theme.accent2 : theme.text, bold: active }, `${active ? "▸ " : "  "}${m.label ?? m.id}`),
              h(Text, { color: theme.dim, wrap: "truncate" }, m.hint ?? m.id),
            );
          }),
  );
}

function CommandPalette({ theme, query, selected, width }: { theme: DeckTheme; query: string; selected: number; width: number }) {
  const filtered = filterPalette(query);
  const sel = filtered.length ? Math.min(selected, filtered.length - 1) : 0;
  const MAX = 8;
  const start = filtered.length > MAX ? Math.min(Math.max(0, sel - Math.floor(MAX / 2)), filtered.length - MAX) : 0;
  const shown = filtered.slice(start, start + MAX);
  return h(
    Box,
    {
      flexDirection: "column",
      width,
      borderStyle: theme.borderStyle,
      borderColor: theme.accent,
      paddingX: 1,
      marginTop: 1,
    },
    h(
      Box,
      { justifyContent: "space-between" },
      h(Text, { color: theme.accent, bold: true }, "▲ COMMAND PALETTE"),
      h(Text, { color: theme.dim }, `${filtered.length} · ↑↓ select · enter run · esc close`),
    ),
    filtered.length === 0
      ? h(Text, { color: theme.dim }, "  no matching command")
      : shown.map((cmd, i) => {
          const active = start + i === sel;
          return h(
            Box,
            { key: cmd.cmd, justifyContent: "space-between" },
            h(Text, { color: active ? theme.accent2 : theme.tool, bold: active }, `${active ? "▸ " : "  "}${cmd.cmd}`),
            h(Text, { color: theme.dim, wrap: "truncate" }, cmd.desc),
          );
        }),
  );
}

function Footer({ theme, snapshot, stats, width }: { theme: DeckTheme; snapshot: InkChatSnapshot; stats: RuntimeStats; width: number }) {
  const cost = formatCost(stats.usage);
  const elapsed = `${Math.round(stats.durationMs / 1000)}s`;
  const cache = cachePercent(stats.usage);
  return h(
    Box,
    { flexDirection: "column", width },
    h(
      Box,
      { width, justifyContent: "space-between" },
      h(
        Box,
        { gap: 1 },
        h(Text, { color: theme.success, bold: true }, cost),
        h(Text, { color: theme.dim }, "·"),
        h(Text, { color: theme.accent2 }, elapsed),
        h(Text, { color: theme.dim }, "·"),
        h(Text, { color: theme.tool }, `${stats.tools} tools`),
        h(Text, { color: theme.dim }, "·"),
        h(Text, { color: theme.success }, `${cache} cached`),
      ),
      h(
        Box,
        { gap: 1 },
        h(Text, { color: theme.accent }, `◈ ${theme.title.toLowerCase()}`),
        h(Text, { color: theme.dim }, "·"),
        h(Text, { color: theme.dim }, `${compactModel(snapshot.provider, 16)} · ckpt ${stats.checkpoints}`),
      ),
    ),
    h(
      Text,
      { color: theme.dim, wrap: "truncate" },
      "⌃P palette  ·  /help  /model  /theme  /plan  /code  /danger  /sessions  /doctor  /exit",
    ),
  );
}

function Chip({ theme, label, value, color }: { theme: DeckTheme; label: string; value: string; color: string }) {
  return h(
    Box,
    { borderStyle: "single", borderColor: color, paddingX: 1 },
    h(Text, { color: theme.dim }, `${label} `),
    h(Text, { color, bold: true }, value),
  );
}

function StatusRow({ theme, label, value, color }: { theme: DeckTheme; label: string; value: string; color: string }) {
  return h(
    Box,
    { justifyContent: "space-between" },
    h(Text, { color: theme.dim }, label),
    h(Text, { color, wrap: "truncate" }, value),
  );
}

function ProgressMetric({ theme, label, value }: { theme: DeckTheme; label: string; value: number }) {
  return h(
    Box,
    { flexDirection: "column", marginY: 1 },
    h(StatusRow, { theme, label, value: `${value}%`, color: theme.accent2 }),
    h(Text, { color: theme.accent2 }, `[${bar(value, 14)}]`),
  );
}

function LogText({ line, theme, spinner }: { line: LogLine; theme: DeckTheme; spinner: string }) {
  // Tool flow: indented, dim — "  ↳ bash  npm test … (spinner) → ✓ result".
  if (line.tone === "tool") {
    const name = line.meta ?? "tool";
    const r = line.result;
    return h(
      Box,
      { justifyContent: "space-between" },
      h(
        Box,
        { flexShrink: 1 },
        h(Text, { color: theme.dim }, line.cont ? "    " : "  ↳ "),
        line.cont ? null : h(Text, { color: theme.accent2 }, `${name} `),
        h(Text, { color: theme.dim, wrap: "truncate" }, line.text),
      ),
      r
        ? h(Text, { color: r.ok ? theme.success : theme.error }, ` ${r.ok ? "✓" : "✗"}${r.text ? ` ${truncateTail(r.text, 26)}` : ""}`)
        : h(Text, { color: theme.accent3, bold: true }, ` ${spinner || "…"}`),
    );
  }
  // Verifier objections — amber, indented, never dressed up as success.
  if (line.tone === "verify") {
    return h(Text, { color: theme.warn, wrap: "truncate" }, `${line.cont ? "    " : "  ⚠ "}${line.text}`);
  }
  // You: ember ❯ then your words. Ares: plain warm text, no label — the page IS Ares.
  if (line.tone === "user") {
    return h(
      Box,
      null,
      h(Text, { color: theme.accent, bold: true }, line.cont ? "  " : "❯ "),
      h(Text, { color: theme.user, wrap: "truncate" }, line.text),
    );
  }
  if (line.tone === "assistant") {
    const streaming = line.meta === "stream" && spinner;
    return h(
      Box,
      null,
      h(Text, { color: theme.assistant, wrap: "truncate" }, line.text),
      streaming ? h(Text, { color: theme.accent3, bold: true }, ` ${spinner}`) : null,
    );
  }
  // verifier-success / notice / error / muted / diff — subtle, indented.
  const color = toneColor(line.tone, theme);
  const prefix = line.cont ? "  " : line.tone === "error" ? "  ✗ " : line.tone === "notice" ? "  " : "  ";
  return h(Text, { color, wrap: "truncate" }, `${prefix}${line.text}`);
}

function truncateTail(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

function TodosStrip({ theme, todos }: { theme: DeckTheme; todos: Todo[] }) {
  return h(
    Box,
    {
      borderStyle: theme.borderStyle,
      borderColor: theme.frame,
      paddingX: 1,
      marginTop: 1,
    },
    h(Text, { color: theme.accent, bold: true }, "TODOS "),
    ...todos.slice(0, 3).map((todo) => h(Text, { key: todo.id, color: todo.status === "completed" ? theme.success : theme.warn }, `${todoMarker(todo)} ${todo.status === "in_progress" ? todo.activeForm : todo.content}  `)),
  );
}

function TodoLine({ todo, theme }: { todo: Todo; theme: DeckTheme }) {
  const color = todo.status === "completed" ? theme.success : todo.status === "in_progress" ? theme.warn : theme.dim;
  return h(Text, { color, wrap: "truncate" }, `${todoMarker(todo)} ${todo.status === "in_progress" ? todo.activeForm : todo.content}`);
}

function deckTheme(): DeckTheme {
  return DECK_THEMES[currentThemeName()] ?? DECK_THEMES.rage;
}

function toneColor(tone: LogLine["tone"], theme: DeckTheme): string {
  if (tone === "diff-add") return theme.success;
  if (tone === "diff-del") return theme.error;
  if (tone === "diff-meta") return theme.accent2;
  if (tone === "user") return theme.user;
  if (tone === "assistant") return theme.assistant;
  if (tone === "tool") return theme.tool;
  if (tone === "verify") return theme.warn;
  if (tone === "error") return theme.error;
  if (tone === "notice") return theme.accent2;
  return theme.dim;
}

function appendDiff(diff: string, append: (tone: LogLine["tone"], text: string, meta?: string) => void): void {
  for (const line of diff.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) append("diff-add", line, "diff");
    else if (line.startsWith("-") && !line.startsWith("---")) append("diff-del", line, "diff");
    else if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) append("diff-meta", line, "diff");
    else append("muted", line, "diff");
  }
}

function progressText(data: unknown): string | null {
  if (!data || typeof data !== "object") return typeof data === "string" ? data : null;
  const obj = data as Record<string, unknown>;
  if (obj.kind === "shell_output") {
    const text = String(obj.text ?? "").trimEnd();
    if (!text) return null;
    return `${obj.stream ?? "stdout"} ${text}`.slice(0, 240);
  }
  if (obj.kind === "grep_match") {
    return `grep ${obj.total ?? "?"} match(es)${obj.file ? ` ${obj.file}:${obj.line ?? ""}` : ""}`;
  }
  if (obj.kind === "lsp_init") return `starting ${obj.server ?? "LSP"}`;
  if (obj.kind === "lsp_ready") return `${obj.server ?? "LSP"} ready`;
  return JSON.stringify(obj).slice(0, 240);
}

function todoMarker(todo: Todo): string {
  if (todo.status === "completed") return "[x]";
  if (todo.status === "in_progress") return "[>]";
  return "[ ]";
}

function compactModel(model: string, max: number): string {
  if (model.length <= max) return model;
  return `${model.slice(0, Math.max(0, max - 4))}...`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function EvolutionPulses({ theme, pulses, width }: { theme: DeckTheme; pulses: Pulse[]; width: number }) {
  // Weirdcore card row. Each pulse renders as "+N TARGET" with a bracketed
  // kind tag if present. Older pulses dim out as they age.
  const now = Date.now();
  return h(
    Box,
    {
      flexDirection: "row",
      width,
      gap: 1,
      paddingX: 1,
      marginTop: 1,
    },
    ...pulses.map((p) => {
      const age = now - p.createdAt;
      const dimming = age > 5_000;
      const fading = age > 7_500;
      const color = pulseColor(p, theme);
      const label = `+${p.delta} ${p.target}`;
      const tag = p.kind ? `[${p.kind}]` : "";
      return h(
        Box,
        {
          key: p.id,
          borderStyle: "round",
          borderColor: fading ? theme.dim : color,
          paddingX: 1,
        },
        h(Text, { color: fading ? theme.dim : dimming ? theme.text : color, bold: !fading }, label),
        tag ? h(Text, { color: theme.dim }, ` ${tag}`) : null,
      );
    }),
  );
}

function pulseColor(p: Pulse, theme: DeckTheme): string {
  if (p.type === "bootstrap_complete") return theme.success;
  if (p.type === "self_evolve") return theme.accent;
  if (p.type === "capture_detected") return theme.accent2;
  if (p.type === "recall_surfaced") return theme.accent3;
  if (p.type === "skill_crafted") return theme.warn;
  if (p.type === "capability_changed") return theme.tool;
  if (p.type === "dream_phase_ended") return theme.accent3;
  return theme.text;
}

function cachePercent(usage: Usage): string {
  const cached = usage.cacheReadTokens ?? 0;
  const denom = usage.inputTokens;
  if (denom <= 0) return "0%";
  return `${Math.round((cached / denom) * 100)}%`;
}

function formatCost(usage: Usage): string {
  const inputPerM = Number(process.env.ARES_COST_INPUT_PER_MTOK ?? 0);
  const outputPerM = Number(process.env.ARES_COST_OUTPUT_PER_MTOK ?? 0);
  const cacheReadPerM = Number(process.env.ARES_COST_CACHE_READ_PER_MTOK ?? inputPerM);
  if (!Number.isFinite(inputPerM) || !Number.isFinite(outputPerM) || (inputPerM <= 0 && outputPerM <= 0)) {
    return "$n/a";
  }
  const uncachedInput = Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0));
  const cost =
    (uncachedInput / 1_000_000) * inputPerM +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * cacheReadPerM +
    (usage.outputTokens / 1_000_000) * outputPerM;
  return `$${cost.toFixed(4)}`;
}

function bar(value: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((value / 100) * width)));
  return "#".repeat(filled) + "-".repeat(width - filled);
}

interface MouseEvent {
  button: number;
  x: number;
  y: number;
  release: boolean;
}

function useTerminalMouseMode(): void {
  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    const stdinStream = process.stdin as typeof process.stdin & {
      setRawMode?: (mode: boolean) => void;
    };
    process.stdout.write("\u001b[?1000h\u001b[?1006h");
    stdinStream.setRawMode?.(true);
    return () => {
      process.stdout.write("\u001b[?1006l\u001b[?1000l");
    };
  }, []);
}

function parseMouseEvents(text: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  const pattern = /(?:\u001b\[|\[)?<(\d+);(\d+);(\d+)([mM])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    events.push({
      button: Number(match[1]),
      x: Number(match[2]),
      y: Number(match[3]),
      release: match[4] === "m",
    });
  }
  return events;
}

function looksLikeMouseFragment(text: string): boolean {
  return /(?:\u001b\[|\[)?<\d*(?:;\d*){0,2}[mM]?/.test(text);
}
