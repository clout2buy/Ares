import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { render, useApp, useInput, useWindowSize } from "ink";
import type { PermissionMode, Todo, TurnEvent, Usage } from "@ares/protocol";
import { chatMainRows, mapTone, type ChatFrame } from "./ui/chat/ChatMain.js";
import { frameDims } from "./ui/layout.js";
import { RowsView } from "./ui/RowText.js";
import { flattenTranscript, type LogLine as RowLine, type Row } from "./ui/rows.js";
import { DEFAULT_TUI_THEME, TUI_THEMES, resolveTheme, tuiTheme } from "./ui/themes.js";
import { glyphsFor, termCaps } from "./ui/term.js";
import {
  EFFORT_PILL_ROW,
  effortBody,
  effortPillIndexAt,
  infoBody,
  themesBody,
  keyCaptureBody,
  listBody,
  modelsBody,
  overlayCapacity,
  overlayRows,
} from "./ui/chat/overlay.js";
import {
  diffHeaderLabel,
  endsWithContinuation,
  fleetGlyph,
  fleetSummary,
  foldFleetRows,
  formatDuration,
  groupDiffByFile,
  motionEnabled,
  normalizeInputChunk,
  reduceFleet,
  searchHistory,
  stripContinuation,
  type FleetState,
} from "./tuiElite.js";
import {
  disableMouseTracking,
  enableMouseTracking,
  isMouseFragment,
  parseSgrMouse,
  type SgrMouseEvent,
} from "./mouseInput.js";
import {
  MODAL_TAB_ROW,
  SLIDER_LEVELS,
  indexForKey,
  modalHitTest,
  parseReasoningLevel,
  toolbarHitTest,
  SLATE_HEADER_MODEL_ROW,
  slateModelSpan,
  permHitTest,
} from "./tuiChrome.js";

// ─────────────────────────────────────────────────────────────────────────────
// The chat TUI host. All engine wiring (events → transcript, permission seam,
// steering, overlays, mouse) lives here; ALL drawing is delegated to the pure
// row builders under ui/ (see ui/rows.ts — "rows, not boxes"). The frame is
// always exactly one row shorter than the terminal, so Ink never overflows —
// that overflow was the cross-platform break.
// ─────────────────────────────────────────────────────────────────────────────

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
  /** Hands the TUI the live permission seam: the host routes the engine's
   *  requestPermission through the handler registered here, so prompts render
   *  as an IN-FRAME card (keys 1/2/3 or click) instead of a raw-stderr prompt
   *  Ink instantly paints over — which hung turns forever. */
  registerPermissionHandler?(
    handler: (req: { toolName: string; reason: string; suggestion?: string; signal?: AbortSignal }) => Promise<"allow_once" | "allow_always" | "deny">,
  ): void;
  /** Mid-turn steering: a line typed while busy is queued into the live turn
   *  (the engine drains reminders after every tool round) instead of dropped. */
  steer?(text: string): void;
  /** The persisted TUI theme id (settings.tuiTheme); defaults to midnight. */
  initialTheme?: string;
  /** Persist a settings patch (theme picks) without going through a command. */
  persistSettings?(patch: { tuiTheme?: string }): void;
}

/** One pending permission ask — the card renders it; a key/click resolves it. */
interface PendingPermission {
  toolName: string;
  reason: string;
  suggestion?: string;
  settled: boolean;
  finish: (d: "allow_once" | "allow_always" | "deny") => boolean;
}

interface LogLine {
  id: number;
  tone: "user" | "assistant" | "tool" | "error" | "notice" | "muted" | "diff-add" | "diff-del" | "diff-meta" | "diff-file" | "verify";
  text: string;
  meta?: string;
  /** For tool lines: the outcome appended on tool_end. */
  result?: { ok: boolean; text: string; durationMs?: number };
  /** A wrapped continuation of the line above — render without repeating the label. */
  cont?: boolean;
  /** diff-file cards: hunk body lines shown while expanded. */
  detail?: string[];
  /** diff-file cards: expanded while the turn streams, collapsed on completion. */
  expanded?: boolean;
  /** diff-file cards: add/del counts for the colored header. */
  adds?: number;
  dels?: number;
  /** tool lines: wall-clock start for the live elapsed readout. */
  startedAt?: number;
}

interface RuntimeStats {
  turns: number;
  tools: number;
  errors: number;
  checkpoints: number;
  durationMs: number;
  usage: Usage;
}

const h = React.createElement;

// Motion gate — non-TTY or ARES_NO_MOTION=1 renders static (no spinners, no
// cursor blink), which is also what keeps harness snapshots deterministic.
const MOTION = motionEnabled();

const PALETTE: { cmd: string; desc: string }[] = [
  { cmd: "/help", desc: "show every command" },
  { cmd: "/model", desc: "switch the live model" },
  { cmd: "/models", desc: "list models for a provider" },
  { cmd: "/reasoning", desc: "set reasoning low|medium|high|max" },
  { cmd: "/routing", desc: "per-lane model routing" },
  { cmd: "/theme", desc: "switch the output theme" },
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

// Model picker providers — the tab row of the Models overlay (hit-test spans
// derive from these labels, so they render verbatim).
const PICKER_PROVIDERS = ["ollama", "openai", "anthropic", "openrouter", "deepseek", "ares"];

// Settings overlay tabs (verbatim labels, same reason).
const SETTINGS_TABS = ["Providers", "Models", "Appearance", "Effort", "Engine"];
const SETTINGS_PROVIDERS_TAB = 0;
const SETTINGS_MODELS_TAB = 1;
const SETTINGS_APPEARANCE_TAB = 2;
const SETTINGS_EFFORT_TAB = 3;
const SETTINGS_ENGINE_TAB = 4;

/** Providers whose keys the Providers tab can set (masked entry → /key). */
const KEY_PROVIDERS = ["anthropic", "openrouter", "deepseek", "openai", "brave", "ares"] as const;

export async function runInkChat(options: InkChatOptions): Promise<number> {
  // Own the alternate screen from the first byte: enter it, clear it, home the
  // cursor, and make sure no stale mouse mode is armed. Ink's own 1049h after
  // this is a no-op, and the frame is then TOP-anchored at row 1 — which is
  // what the mouse geometry assumes. Scrollback is untouched (no 3J).
  process.stdout.write("\u001b[?1002l\u001b[?1006l\u001b[?1000l\u001b[?1049h\u001b[2J\u001b[H\u001b[?25l");
  const instance = render(h(AresInkApp, { options }), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    alternateScreen: true,
    // Line-diff redraws: only changed rows are rewritten each frame, which is
    // the difference between a calm screen and a 10fps full-screen repaint.
    incrementalRendering: true,
    maxFps: 20,
    exitOnCtrlC: true,
  });
  try {
    const result = await instance.waitUntilExit();
    return typeof result === "number" ? result : 0;
  } finally {
    // Belt-and-braces: the mount effect's cleanup and mouseInput's process
    // hooks also restore, but this is the common exit path — NEVER hand the
    // owner back a terminal stuck in mouse mode or the alternate screen.
    disableMouseTracking();
    process.stdout.write("\u001b[?1049l\u001b[?25h");
  }
}

function AresInkApp({ options }: { options: InkChatOptions }) {
  const app = useApp();
  const { rows, columns } = useWindowSize();
  // The face — a theme id, resolved to a palette at this terminal's color tier.
  const [themeId, setThemeId] = useState<string>(options.initialTheme ?? DEFAULT_TUI_THEME);
  const THEME = useMemo(() => resolveTheme(themeId, termCaps().colorLevel), [themeId]);
  const [snapshot, setSnapshot] = useState(options.snapshot());
  const [lines, setLines] = useState<LogLine[]>(() =>
    (options.resumedLines ?? []).map((text, index) => ({ id: index + 1, tone: "notice", text })),
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [scrollOffset, setScrollOffset] = useState(0);
  // Ctrl+R reverse-search over history — live match preview in the composer.
  const [rsOpen, setRsOpen] = useState(false);
  const [rsQuery, setRsQuery] = useState("");
  const [rsSkip, setRsSkip] = useState(0);
  // Live Conductor fleet panel (fleet_activity riding tool_progress).
  const [fleet, setFleet] = useState<FleetState | null>(null);
  const fleetRef = useRef<FleetState | null>(null);
  const fleetToolRef = useRef<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteSel, setPaletteSel] = useState(0);
  const [spin, setSpin] = useState(0);
  const [activity, setActivity] = useState<string | null>(null);
  // When the current turn began — drives the live "working Ns" timer in slate.
  const turnStartedAt = useRef<number | null>(null);
  // Cumulative reasoning chars this turn (~4 chars/token) — the live "thinking"
  // counter that keeps a deep-reasoning model from looking frozen.
  const thinkingChars = useRef(0);
  // ── In-frame permission prompts ──────────────────────────────────────────
  // The engine's requestPermission lands here (via registerPermissionHandler);
  // one card shows at a time, parallel asks queue behind it.
  const [perm, setPerm] = useState<PendingPermission | null>(null);
  const permRef = useRef<PendingPermission | null>(null);
  const permQueue = useRef<PendingPermission[]>([]);
  permRef.current = perm;
  useEffect(() => {
    options.registerPermissionHandler?.(
      (req) =>
        new Promise((resolve) => {
          let pending!: PendingPermission;
          const onAbort = () => {
            if (!pending.finish("deny")) return;
            if (permRef.current === pending) {
              let next = permQueue.current.shift() ?? null;
              while (next?.settled) next = permQueue.current.shift() ?? null;
              permRef.current = next;
              setPerm(next);
            } else {
              permQueue.current = permQueue.current.filter((candidate) => candidate !== pending);
            }
          };
          pending = {
            toolName: req.toolName,
            reason: req.reason,
            suggestion: req.suggestion,
            settled: false,
            finish: (decision) => {
              if (pending.settled) return false;
              pending.settled = true;
              req.signal?.removeEventListener("abort", onAbort);
              resolve(decision);
              return true;
            },
          };
          if (req.signal?.aborted) {
            pending.finish("deny");
            return;
          }
          req.signal?.addEventListener("abort", onAbort, { once: true });
          if (permRef.current) permQueue.current.push(pending);
          else {
            permRef.current = pending;
            setPerm(pending);
          }
        }),
    );
  }, [options]);
  const decidePermission = useCallback((decision: "allow_once" | "allow_always" | "deny") => {
    const current = permRef.current;
    if (!current) return;
    if (!current.finish(decision)) return;
    let next = permQueue.current.shift() ?? null;
    while (next?.settled) next = permQueue.current.shift() ?? null;
    permRef.current = next;
    setPerm(next);
  }, []);
  // Fullscreen overlays — each REPLACES the main view (anchored at app row 1)
  // so every row is deterministic for the tuiChrome hit-tests.
  const [overlay, setOverlay] = useState<"models" | "effort" | "settings" | null>(null);
  const [settingsTab, setSettingsTab] = useState(0);
  const [ovScroll, setOvScroll] = useState(0);
  /** Non-null while the "custom model id" row is capturing typed text. */
  const [mpCustom, setMpCustom] = useState<string | null>(null);
  /** Masked key entry on the Providers tab: which provider + typed value. */
  const [keyCapture, setKeyCapture] = useState<{ provider: string; value: string } | null>(null);
  /** Live info lines for the Providers (/keys) and Engine (/settings) tabs. */
  const [settingsInfo, setSettingsInfo] = useState<string[]>([]);
  // Effort dial — local mirror of the host's /reasoning level, seeded lazily
  // the first time an effort surface opens (parsed from the live /reasoning line).
  const [effortLevel, setEffortLevel] = useState(2);
  const effortKnown = useRef(false);
  const dragEffort = useRef(false);
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


  // One animation clock. Busy: 100ms (spinners, elapsed readouts, wordmark
  // sweep). Idle: 500ms (cursor blink only). Off entirely without motion.
  useEffect(() => {
    if (!MOTION) {
      setSpin(0);
      return;
    }
    const id = setInterval(() => setSpin((s) => (s + 1) % 36000), busy ? 100 : 500);
    return () => clearInterval(id);
  }, [busy]);
  const cursorOn = !MOTION || busy || spin % 2 === 0;


  // Load the model catalog for the picker's current provider (async, cancellable).
  useEffect(() => {
    if (overlay !== "models" || !options.listModelOptions) return;
    let cancelled = false;
    setMpLoading(true);
    options
      .listModelOptions(PICKER_PROVIDERS[mpProvider])
      .then((rows) => {
        if (cancelled) return;
        setMpModels(rows);
        setMpSel(0);
        setOvScroll(0);
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
  }, [overlay, mpProvider, options]);

  // Providers/Engine tabs show live host state — quiet /keys | /settings
  // queries, refetched on tab entry (and after a key save via keyCapture).
  useEffect(() => {
    if (overlay !== "settings" || (settingsTab !== SETTINGS_PROVIDERS_TAB && settingsTab !== SETTINGS_ENGINE_TAB)) return;
    if (keyCapture != null) return; // wait until the save lands
    let cancelled = false;
    options
      .handleCommand(settingsTab === SETTINGS_PROVIDERS_TAB ? "/keys" : "/settings")
      .then((r) => {
        if (!cancelled && r.kind === "handled") setSettingsInfo(r.lines ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [overlay, settingsTab, keyCapture, options]);

  // Seed the effort dial from the host's LIVE /reasoning level the first time
  // an effort surface opens — quiet query, no lines appended to the stream.
  useEffect(() => {
    if (overlay !== "effort" && overlay !== "settings") return;
    if (effortKnown.current) return;
    let cancelled = false;
    options
      .handleCommand("/reasoning")
      .then((result) => {
        if (cancelled) return;
        const level = parseReasoningLevel(result.lines ?? []);
        if (level) setEffortLevel(Math.max(0, SLIDER_LEVELS.indexOf(level)));
        effortKnown.current = true;
      })
      .catch(() => {
        effortKnown.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [overlay, options]);

  // Frame geometry — one column and one row short of the terminal, so the
  // last cell never pending-wraps and Ink never takes its overflow path. The
  // frame is TOP-anchored in the alternate screen: app row === terminal row.
  const bleed = !termCaps().legacyConsole;
  const { width: frameW, height: frameH } = frameDims(columns, rows, bleed);
  const ovCapacity = overlayCapacity(frameH);
  // Scroll is measured in RENDERED rows; the frame builder reports the budget.
  const frameRef = useRef<ChatFrame | null>(null);
  const visibleRows = frameRef.current?.layout.transcriptRows ?? Math.max(3, frameH - 8);
  const maxScroll = frameRef.current?.maxScroll ?? 0;
  const scrollUp = useCallback((amount = visibleRows) => {
    setScrollOffset((prev) => Math.min(frameRef.current?.maxScroll ?? 0, prev + amount));
  }, [visibleRows]);
  const scrollDown = useCallback((amount = visibleRows) => {
    setScrollOffset((prev) => Math.max(0, prev - amount));
  }, [visibleRows]);


  // Terminal mouse mode: ?1002 (press/drag/release) + ?1006 (SGR encoding).
  // Gated on TTY + ARES_NO_MOUSE inside enableMouseTracking; cleanup runs on
  // unmount AND on process exit/signals (mouseInput's hooks) — a terminal left
  // in mouse mode is broken for the user.
  useEffect(() => {
    if (!process.stdin.isTTY) return;
    if (!enableMouseTracking()) return;
    const stdinStream = process.stdin as typeof process.stdin & { setRawMode?: (mode: boolean) => void };
    stdinStream.setRawMode?.(true);
    return () => disableMouseTracking();
  }, []);

  const append = useCallback((tone: LogLine["tone"], text: string, meta?: string) => {
    // Assistant replies keep their full multi-line body in ONE LogLine so the
    // markdown renderer sees fenced code blocks / lists whole. Every other tone
    // stays split-per-line (tool flow, diffs, notices render one line each).
    if (tone === "assistant") {
      setLines((prev) => [...prev, { id: lineId.current++, tone, text, meta }].slice(-600));
      return;
    }
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
  // stamps the ✓/✗ result onto that SAME line — keyed by the tool_use id, not
  // a single ref. The old single-ref version broke on PARALLEL tool calls:
  // three tools fired together, each start clobbered the ref, so only the
  // last-started line ever completed — the rest spun at "21m…" forever while
  // their results landed as orphan lines. THE hang illusion, fixed for real.
  const toolLinesById = useRef(new Map<string, number>());
  const appendToolLine = useCallback((toolUseId: string, name: string, desc: string) => {
    const id = lineId.current++;
    setLines((prev) => [...prev, { id, tone: "tool" as const, text: desc, meta: name, startedAt: Date.now() }].slice(-600));
    toolLinesById.current.set(toolUseId, id);
  }, []);
  const finishToolLine = useCallback((toolUseId: string, ok: boolean, text: string, durationMs?: number) => {
    const id = toolLinesById.current.get(toolUseId);
    toolLinesById.current.delete(toolUseId);
    if (id == null) {
      append(ok ? "tool" : "error", text, ok ? "ok" : "tool");
      return;
    }
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, startedAt: undefined, result: { ok, text, durationMs } } : l)));
  }, [append]);
  // A turn boundary settles any line whose completion event never arrived, so
  // nothing can spin past its turn (belt-and-suspenders on top of id pairing).
  const settleOrphanToolLines = useCallback(() => {
    const orphaned = new Set(toolLinesById.current.values());
    toolLinesById.current.clear();
    if (orphaned.size === 0) return;
    setLines((prev) =>
      prev.map((l) => (orphaned.has(l.id) && l.startedAt != null ? { ...l, startedAt: undefined, result: { ok: false, text: "no result before turn end" } } : l)),
    );
  }, []);

  // Per-file diff cards: the newest file's hunk stays expanded while the turn
  // streams; older cards (and everything on tool completion) collapse to the
  // `▸ path (+adds −dels)` header line — scrollback stays minimal.
  const appendDiffGrouped = useCallback((diff: string) => {
    const groups = groupDiffByFile(diff);
    if (groups.length === 0) return;
    setLines((prev) => {
      const next = prev.map((l) => (l.tone === "diff-file" && l.expanded ? { ...l, expanded: false } : l));
      groups.forEach((g, i) => {
        next.push({
          id: lineId.current++,
          tone: "diff-file" as const,
          text: diffHeaderLabel(g),
          meta: g.path,
          adds: g.adds,
          dels: g.dels,
          detail: g.lines.slice(0, 40),
          expanded: i === groups.length - 1,
        });
      });
      return next.slice(-600);
    });
  }, []);
  const collapseDiffCards = useCallback(() => {
    setLines((prev) =>
      prev.some((l) => l.tone === "diff-file" && l.expanded)
        ? prev.map((l) => (l.tone === "diff-file" && l.expanded ? { ...l, expanded: false } : l))
        : prev,
    );
  }, []);

  // Fleet lifecycle: progress payloads build the live panel; when the owning
  // Conductor tool call ends (or the turn does), collapse to a one-line summary.
  const applyFleetProgress = useCallback((toolId: string, data: unknown) => {
    fleetRef.current = reduceFleet(fleetRef.current, data);
    fleetToolRef.current = toolId;
    setFleet(fleetRef.current);
  }, []);
  const finalizeFleet = useCallback(() => {
    const state = fleetRef.current;
    fleetRef.current = null;
    fleetToolRef.current = null;
    if (state) {
      append("notice", fleetSummary(state), "fleet");
      setFleet(null);
    }
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
        // Live reasoning telemetry — deep thinking must LOOK alive. ~4 chars/token.
        thinkingChars.current += event.text.length;
        setActivity("thinking");
        return;
      }
      if (event.type === "tool_start") {
        flushAssistant();
        setActivity(event.name);
        appendToolLine(event.id, event.name, event.activityDescription);
        return;
      }
      if (event.type === "tool_end") {
        setActivity("responding");
        setStats((prev) => ({ ...prev, tools: prev.tools + 1 }));
        finishToolLine(event.id, true, event.display ?? "", event.durationMs);
        collapseDiffCards();
        if (fleetToolRef.current === event.id) finalizeFleet();
        return;
      }
      if (event.type === "tool_progress") {
        const obj = event.data as Record<string, unknown> | null;
        if (obj && typeof obj === "object" && obj.kind === "fleet_activity") {
          applyFleetProgress(event.id, obj);
          return;
        }
        const text = progressText(event.data);
        if (text) append("muted", text, "progress");
        return;
      }
      if (event.type === "workspace_diff") {
        appendDiffGrouped(event.diff);
        return;
      }
      if (event.type === "tool_error") {
        setStats((prev) => ({ ...prev, errors: prev.errors + 1 }));
        finishToolLine(event.id, false, event.error, event.durationMs);
        collapseDiffCards();
        if (fleetToolRef.current === event.id) finalizeFleet();
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
        // Verifier verdicts and compaction notices carry real user-facing
        // signal. Everything else (memory weave, identity anchor, foreground
        // framing) is INTERNAL prompt plumbing — dumping it into the stream
        // was the single ugliest thing in the TUI. Collapse to one dim pulse
        // per source and never repeat back-to-back.
        if (event.source === "verifier") {
          // Turn-end verification disclosures (UNVERIFIED / UNRESOLVED /
          // GUI-UNVERIFIED) are gone by owner order — they stay in the model's
          // context and diagnostics, never in the stream.
          if (!/^(?:UNVERIFIED|UNRESOLVED|GUI-UNVERIFIED)\b/i.test(event.text)) {
            append("verify", event.text, event.source);
          }
        } else if (event.source === "compaction" && !/^microcompacted\b/i.test(event.text)) {
          append("muted", event.text.split("\n")[0].slice(0, 120), "compaction");
        } else if (event.source === "instructions" && /retrying|stalled|provider hiccup|switched to/i.test(event.text)) {
          // Provider retry/stall/failover notes are the only heartbeat the user
          // gets during dead air — swallowing them read as a frozen turn.
          append("muted", event.text.split("\n")[0].slice(0, 120), "retry");
        }
        // Everything else (memory weave, identity anchor, foreground framing) is
        // INTERNAL prompt plumbing with zero user value. It is NOT shown — dumping
        // "⟡ … woven in" into the stream every turn was pure noise.
        return;
      }
      if (event.type === "error") {
        setStats((prev) => ({ ...prev, errors: prev.errors + 1 }));
        append("error", event.error.message, event.error.code);
        return;
      }
      if (event.type === "turn_end") {
        flushAssistant();
        collapseDiffCards();
        finalizeFleet();
        settleOrphanToolLines();
        // workStatus (unverified/blocked) is intentionally not echoed into the
        // stream — the owner removed the turn-end verification warning.
        // A permission ask can't outlive its turn — deny + drain so no dead
        // card lingers (its awaiter is gone; resolving is a harmless no-op).
        if (permRef.current) {
          permRef.current.finish("deny");
          for (const p of permQueue.current) p.finish("deny");
          permQueue.current = [];
          permRef.current = null;
          setPerm(null);
        }
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
    [append, flushAssistant, appendToolLine, finishToolLine, settleOrphanToolLines, appendDiffGrouped, collapseDiffCards, applyFleetProgress, finalizeFleet],
  );

  const submit = useCallback(
    async (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      // Mid-turn STEERING: typing while Ares works no longer dies at the door.
      // The line rides the engine's reminder drain and reaches the model within
      // one tool round — course-correct without killing the turn.
      if (busy) {
        if (!line.startsWith("/") && options.steer) {
          options.steer(line);
          setInput("");
          history.current.push(line);
          historyIndex.current = null;
          append("user", `↳ ${line}`, "steer");
          append("muted", "steering — applies within a tool round", "steer");
        }
        return;
      }
      // /model and /models open the scrollable picker, not a text dump.
      if ((line === "/model" || line === "/models") && options.listModelOptions) {
        setInput("");
        setMpProvider(Math.max(0, PICKER_PROVIDERS.indexOf(snapshot.provider)));
        setMpSel(0);
        setOvScroll(0);
        setMpCustom(null);
        setOverlay("models");
        return;
      }
      setInput("");
      setScrollOffset(0);
      history.current.push(line);
      historyIndex.current = null;
      append("user", line, "send");
      turnStartedAt.current = Date.now();
      thinkingChars.current = 0;
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
        setActivity(null);
      }
    },
    [append, app, busy, flushAssistant, handleEvent, options, snapshot],
  );

  // ─── Mouse routing — SGR events → toolbar / overlay geometry / scroll ──────
  // Plain closures (recreated per render) so they always see live state; the
  // useInput handler below re-subscribes every render anyway.
  const effortSurfaceActive = overlay === "effort" || (overlay === "settings" && settingsTab === SETTINGS_EFFORT_TAB);

  /** Set + dispatch an effort level through the host's real /reasoning path —
   *  QUIETLY: straight to handleCommand, no busy flag, no fake user turn in the
   *  transcript (the old path went through submit(), which refused while busy
   *  and printed "/reasoning x" as if you had typed it). */
  const applyEffort = (idx: number) => {
    const clamped = Math.max(0, Math.min(SLIDER_LEVELS.length - 1, idx));
    setEffortLevel(clamped);
    effortKnown.current = true;
    const level = SLIDER_LEVELS[clamped];
    options
      .handleCommand(`/reasoning ${level}`)
      .then((r) => {
        const bad = r.lines?.find((l) => /unknown/i.test(l));
        if (bad) append("error", bad, "reasoning");
        else append("muted", `reasoning ${GLYPHS.prompt} ${level}`, "reasoning");
      })
      .catch((err) => append("error", err instanceof Error ? err.message : String(err), "reasoning"));
  };

  /** Switch the face live and persist it. */
  const applyTheme = (id: string) => {
    if (id === themeId) return;
    setThemeId(id);
    options.persistSettings?.({ tuiTheme: id });
    append("muted", `theme ${GLYPHS.prompt} ${tuiTheme(id).label.toLowerCase()}`, "theme");
  };

  /** Row index → action for the models overlay. The row AFTER the last model
   *  is the "custom model id" row, which flips into text-input mode. */
  const selectModelRow = (idx: number) => {
    if (idx < 0 || idx > mpModels.length) return;
    setMpSel(idx);
    if (idx === mpModels.length) {
      setMpCustom("");
      return;
    }
    const m = mpModels[idx];
    if (!m) return;
    setOverlay(null);
    void submit(`/model ${PICKER_PROVIDERS[mpProvider]} ${m.id}`);
  };

  const openModelsOverlay = () => {
    setMpProvider(Math.max(0, PICKER_PROVIDERS.indexOf(snapshot.provider)));
    setMpSel(0);
    setOvScroll(0);
    setMpCustom(null);
    setOverlay("models");
  };

  const toolbarAction = (id: string) => {
    if (id === "models") {
      openModelsOverlay();
    } else if (id === "effort") {
      setOverlay("effort");
    } else if (id === "themes") {
      setSettingsTab(SETTINGS_APPEARANCE_TAB);
      setOvScroll(0);
      setOverlay("settings");
    } else if (id === "settings") {
      setSettingsTab(0);
      setOvScroll(0);
      setOverlay("settings");
    } else if (id === "ultra") {
      // The headline button: slam the dial to MAX and let the surge rip.
      setOverlay("effort");
      applyEffort(SLIDER_LEVELS.length - 1);
    }
  };

  /** Click/drag on the effort slider band (flame row → labels row): x maps to
   *  the nearest level stop; drags track live, release commits. */
  /** Click a pill on the effort row → that level. */
  const effortMouse = (event: SgrMouseEvent, appRow: number) => {
    if (event.kind !== "down" || appRow !== EFFORT_PILL_ROW) return;
    const idx = effortPillIndexAt(event.x);
    if (idx != null && idx !== effortLevel) applyEffort(idx);
  };

  const handleMouseEvent = (event: SgrMouseEvent) => {
    const appRow = event.y; // frame is top-anchored in the alternate screen
    if (overlay) {
      if (event.kind === "wheel-up" || event.kind === "wheel-down") {
        if (effortSurfaceActive) {
          // Wheel nudges the dial: up = hotter, down = cooler.
          const next = Math.max(0, Math.min(SLIDER_LEVELS.length - 1, effortLevel + (event.kind === "wheel-up" ? 1 : -1)));
          if (next !== effortLevel) applyEffort(next);
          return;
        }
        const total =
          overlay === "models"
            ? mpModels.length + 1
            : overlay === "settings" && settingsTab === SETTINGS_APPEARANCE_TAB
              ? TUI_THEMES.length
              : 0;
        const maxScroll = Math.max(0, total - ovCapacity);
        setOvScroll((s) => Math.max(0, Math.min(maxScroll, s + (event.kind === "wheel-down" ? 2 : -2))));
        return;
      }
      if (overlay === "models") {
        if (mpCustom != null || event.kind !== "down") return;
        const visible = Math.max(0, Math.min(ovCapacity, mpModels.length + 1 - ovScroll));
        const hit = modalHitTest(event.x, appRow, PICKER_PROVIDERS, visible);
        if (!hit) return;
        if (hit.kind === "tab") {
          setMpProvider(hit.index);
          setMpSel(0);
          setOvScroll(0);
          return;
        }
        selectModelRow(ovScroll + hit.index);
        return;
      }
      if (overlay === "effort") {
        effortMouse(event, appRow);
        return;
      }
      // settings — tabs row first, then the active tab's surface.
      if (event.kind === "down" && appRow === MODAL_TAB_ROW) {
        const hit = modalHitTest(event.x, appRow, SETTINGS_TABS, 0);
        if (hit && hit.kind === "tab") {
          setSettingsTab(hit.index);
          setOvScroll(0);
        }
        return;
      }
      if (settingsTab === SETTINGS_EFFORT_TAB) {
        effortMouse(event, appRow);
        return;
      }
      if (settingsTab === SETTINGS_APPEARANCE_TAB && event.kind === "down") {
        const visible = Math.max(0, Math.min(ovCapacity, TUI_THEMES.length - ovScroll));
        const hit = modalHitTest(event.x, appRow, SETTINGS_TABS, visible);
        if (hit && hit.kind === "item") {
          const pick = TUI_THEMES[ovScroll + hit.index];
          if (pick) applyTheme(pick.id);
        }
        return;
      }
      if (settingsTab === SETTINGS_PROVIDERS_TAB && event.kind === "down" && keyCapture == null) {
        const hit = modalHitTest(event.x, appRow, SETTINGS_TABS, KEY_PROVIDERS.length);
        if (hit && hit.kind === "item") {
          const provider = KEY_PROVIDERS[hit.index];
          if (provider) setKeyCapture({ provider, value: "" });
        }
        return;
      }
      if (settingsTab === SETTINGS_MODELS_TAB && event.kind === "down") {
        // One row: jump to the full picker (same surface as ⌃O / toolbar).
        const hit = modalHitTest(event.x, appRow, SETTINGS_TABS, 1);
        if (hit && hit.kind === "item") openModelsOverlay();
        return;
      }
      return;
    }
    // Main view: wheel scrolls the stream, clicks land on the bottom toolbar.
    if (event.kind === "wheel-up") {
      scrollUp(Math.max(3, Math.floor(visibleRows / 2)));
      return;
    }
    if (event.kind === "wheel-down") {
      scrollDown(Math.max(3, Math.floor(visibleRows / 2)));
      return;
    }
    if (event.kind === "down") {
      // Permission card buttons (slate geometry: buttons row = screenH-6).
      if (permRef.current) {
        const decision = permHitTest(event.x, appRow, frameH);
        if (decision) {
          decidePermission(decision as "allow_once" | "allow_always" | "deny");
          return;
        }
      }
      // Slate header: the model chip (row 1, ` ARES  {model} ▾`) opens the picker.
      if (appRow === SLATE_HEADER_MODEL_ROW) {
        const span = slateModelSpan(snapshot.model);
        if (event.x >= span.start && event.x <= span.end) {
          toolbarAction("models");
          return;
        }
      }
      const id = toolbarHitTest(event.x, appRow, frameH, frameW);
      if (id) toolbarAction(id);
    }
  };

  useInput((value, key) => {
    // Explicit bracketed paste beats every other classifier — pasted text can
    // contain "<" runs that would otherwise read as mouse fragments.
    if (!busy && !paletteOpen && !overlay && !rsOpen && /\x1b?\[20[01]~/.test(value)) {
      setInput((prev) => prev + normalizeInputChunk(value).text);
      return;
    }
    const mouseEvents = parseSgrMouse(value);
    if (mouseEvents || isMouseFragment(value)) {
      for (const event of mouseEvents ?? []) handleMouseEvent(event);
      return;
    }
    if (value.includes("\u001b[<")) return;
    if (key.ctrl && value === "c") {
      app.exit(130);
      return;
    }
    // Permission card — the human's answer beats every other keybinding while
    // a tool waits. 1/y allow once · 2/a always · 3/n/esc deny.
    if (perm) {
      if (value === "1" || value === "y") {
        decidePermission("allow_once");
        return;
      }
      if (value === "2" || value === "a") {
        decidePermission("allow_always");
        return;
      }
      if (value === "3" || value === "n" || key.escape) {
        decidePermission("deny");
        return;
      }
      return; // swallow everything else — the card owns the keyboard
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
    if (key.ctrl && value === "p" && !overlay) {
      setPaletteOpen(true);
      setPaletteSel(0);
      setInput("");
      return;
    }
    // Fullscreen overlays — number keys 1-9/a-z select, Tab cycles tabs, Esc
    // closes, Enter confirms. Arrows are SUPPORTED but never required (the
    // owner's device has none). Everything here is also mouse-clickable.
    if (overlay) {
      // "Custom model id" text capture beats every other key.
      if (overlay === "settings" && keyCapture != null) {
        // Masked API-key entry: typed/pasted chars accumulate hidden; Enter
        // dispatches the SAME /key command the composer accepts, Esc bails.
        if (key.escape) {
          setKeyCapture(null);
          return;
        }
        if (key.return) {
          const { provider, value } = keyCapture;
          setKeyCapture(null);
          const trimmed = value.trim();
          if (trimmed) void submit(`/key ${provider} ${trimmed}`);
          return;
        }
        if (key.backspace || key.delete) {
          setKeyCapture((c) => (c ? { ...c, value: c.value.slice(0, -1) } : c));
          return;
        }
        if (value && !key.ctrl && !key.meta && !key.tab) {
          const clean = normalizeInputChunk(value).text.replace(/[\r\n\t ]/g, "");
          setKeyCapture((c) => (c ? { ...c, value: c.value + clean } : c));
        }
        return;
      }
      if (overlay === "models" && mpCustom != null) {
        if (key.escape) {
          setMpCustom(null);
          return;
        }
        if (key.return) {
          const id = mpCustom.trim();
          setMpCustom(null);
          if (id) {
            setOverlay(null);
            void submit(`/model ${PICKER_PROVIDERS[mpProvider]} ${id}`);
          }
          return;
        }
        if (key.backspace || key.delete) {
          setMpCustom((c) => (c ?? "").slice(0, -1));
          return;
        }
        if (value && !key.ctrl && !key.meta && !key.tab) {
          // normalizeInputChunk strips bracketed-paste markers so a pasted
          // model id lands clean; ids are single-line, so newlines drop too.
          setMpCustom((c) => (c ?? "") + normalizeInputChunk(value).text.replace(/[\r\n\t]/g, ""));
        }
        return;
      }
      if (key.escape || (key.ctrl && value === "o")) {
        setOverlay(null);
        dragEffort.current = false;
        return;
      }
      if (key.tab) {
        if (overlay === "models") {
          setMpProvider((p) => (p + 1) % PICKER_PROVIDERS.length);
          setMpSel(0);
          setOvScroll(0);
        } else if (overlay === "settings") {
          setSettingsTab((t) => (t + 1) % SETTINGS_TABS.length);
          setOvScroll(0);
        }
        return;
      }
      if (effortSurfaceActive) {
        // The dial: 1-7 = off … max. ←→ nudge if present.
        if (/^[1-7]$/.test(value)) {
          applyEffort(Number(value) - 1);
          return;
        }
        if (key.leftArrow) {
          applyEffort(effortLevel - 1);
          return;
        }
        if (key.rightArrow) {
          applyEffort(effortLevel + 1);
          return;
        }
        if (key.return) {
          setOverlay(null);
          return;
        }
        return;
      }
      if (overlay === "models") {
        if (key.leftArrow) {
          setMpProvider((p) => (p - 1 + PICKER_PROVIDERS.length) % PICKER_PROVIDERS.length);
          setMpSel(0);
          setOvScroll(0);
          return;
        }
        if (key.rightArrow) {
          setMpProvider((p) => (p + 1) % PICKER_PROVIDERS.length);
          setMpSel(0);
          setOvScroll(0);
          return;
        }
        if (key.upArrow || key.downArrow) {
          const total = mpModels.length + 1; // + custom-id row
          const next = key.upArrow ? Math.max(0, mpSel - 1) : Math.min(total - 1, mpSel + 1);
          setMpSel(next);
          // Keep the selection visible: follow it past either window edge.
          setOvScroll((sc) => (next < sc ? next : next >= sc + ovCapacity ? next - ovCapacity + 1 : sc));
          return;
        }
        if (key.return) {
          selectModelRow(mpSel);
          return;
        }
        const ki = indexForKey(value);
        if (ki != null && ki <= mpModels.length) selectModelRow(ki);
        return;
      }
      // settings — Appearance items select by number key (Effort handled above).
      if (settingsTab === SETTINGS_APPEARANCE_TAB) {
        const ki = indexForKey(value);
        const pick = ki != null ? TUI_THEMES[ki] : undefined;
        if (pick) applyTheme(pick.id);
        return;
      }
      if (settingsTab === SETTINGS_PROVIDERS_TAB) {
        const ki = indexForKey(value);
        const provider = ki != null ? KEY_PROVIDERS[ki] : undefined;
        if (provider) setKeyCapture({ provider, value: "" });
        return;
      }
      if (settingsTab === SETTINGS_MODELS_TAB && (key.return || indexForKey(value) === 0)) {
        openModelsOverlay();
        return;
      }
      return;
    }
    if (key.ctrl && value === "o") {
      openModelsOverlay();
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
      setScrollOffset(maxScroll);
      return;
    }
    if (key.end) {
      setScrollOffset(0);
      return;
    }
    if (!input && value === "!") {
      void submit("/danger");
      return;
    }
    if (!input && value === "[") {
      scrollUp(Math.max(3, Math.floor(visibleRows / 2)));
      return;
    }
    if (!input && value === "]") {
      scrollDown(Math.max(3, Math.floor(visibleRows / 2)));
      return;
    }
    if (busy) return;
    // Ctrl+R reverse-search over history — live match preview; Ctrl+R again
    // cycles older matches, enter accepts, esc cancels.
    if (rsOpen) {
      if (key.escape) {
        setRsOpen(false);
        return;
      }
      if (key.ctrl && value === "r") {
        setRsSkip((s) => s + 1);
        return;
      }
      if (key.return || key.tab) {
        const match = searchHistory(history.current, rsQuery, rsSkip);
        setRsOpen(false);
        if (match) setInput(match.text);
        return;
      }
      if (key.backspace || key.delete) {
        setRsQuery((q) => q.slice(0, -1));
        setRsSkip(0);
        return;
      }
      if (value && !key.ctrl && !key.meta) {
        setRsQuery((q) => q + value.replace(/[\r\n]/g, ""));
        setRsSkip(0);
      }
      return;
    }
    if (key.ctrl && value === "r") {
      setRsOpen(true);
      setRsQuery("");
      setRsSkip(0);
      return;
    }
    // Bracketed paste / multi-line chunk — becomes ONE buffered multi-line
    // input, verbatim. Never submits.
    {
      const chunk = normalizeInputChunk(value);
      if (chunk.paste) {
        setInput((prev) => prev + chunk.text);
        return;
      }
    }
    // Ctrl+J (raw \n) inserts a newline for multi-line composing.
    if ((key.ctrl && value === "j") || value === "\n") {
      setInput((prev) => prev + "\n");
      return;
    }
    if (key.return) {
      // Trailing "\" continues onto the next line instead of submitting.
      if (endsWithContinuation(input)) {
        setInput(stripContinuation(input) + "\n");
        return;
      }
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

  // ─── Render ────────────────────────────────────────────────────────────────
  const displayLines = assistantDraft
    ? [...lines, { id: -1, tone: "assistant" as const, text: assistantDraft, meta: "stream" }]
    : lines;

  // Engine lines → row model. Tool cards: the head is the name; the result's
  // first line is the headline on the elbow, the next few lines a dim preview.
  const rowLines = useMemo<RowLine[]>(() => {
    const now = Date.now();
    return displayLines.map((l) => {
      const isTool = l.tone === "tool";
      const running = isTool && l.startedAt != null && !l.result;
      const resultText = l.result?.text ?? "";
      const resultLines = resultText.split("\n").filter((s) => s.trim().length > 0);
      const extra = resultLines.slice(1, 4).map((s) => s.trim().slice(0, 160));
      if (resultLines.length > 4) extra.push(`${GLYPHS.ellipsis} +${resultLines.length - 4} more lines`);
      const mapped = mapTone(l.tone);
      return {
        tone: mapped,
        text: isTool ? (running ? "" : resultLines[0] ?? "") : l.text,
        desc: isTool ? l.text : undefined,
        name: isTool ? l.meta || l.text.split(/\s+/)[0] : undefined,
        ok: l.result?.ok,
        running,
        elapsed:
          running && l.startedAt != null
            ? formatDuration(now - l.startedAt)
            : l.result?.durationMs
              ? formatDuration(l.result.durationMs)
              : undefined,
        preview: !running && extra.length > 0 ? extra : undefined,
        stream: l.meta === "stream",
        md: l.tone === "assistant",
        adds: l.adds,
        dels: l.dels,
      };
    });
    // spin is a dependency on purpose: live elapsed readouts tick with it.
  }, [displayLines, spin]);

  const flat = useMemo<Row[]>(
    () => flattenTranscript(rowLines, { theme: THEME, glyphs: GLYPHS, tick: spin, width: frameW - 2, cursorOn }),
    [rowLines, spin, cursorOn, frameW, THEME],
  );

  const inFlight = displayLines.filter((l) => l.tone === "tool" && l.startedAt != null && !l.result).length;
  const fleetVm =
    fleet && fleet.active && fleet.agents.length > 0
      ? {
          summary: fleetSummary(fleet),
          rows: foldFleetRows(fleet.agents, 3).shown.map((a, i, arr) => ({
            glyph: a.status === "running" ? GLYPHS.half : a.status === "done" ? GLYPHS.check : a.status === "failed" ? GLYPHS.cross : fleetGlyph(a.status),
            name: a.agentId,
            activity: a.activity || a.phase || a.role || a.status,
            last: i === arr.length - 1,
          })),
        }
      : undefined;

  // A modal REPLACES the main view — fullscreen, anchored at row 1 — so every
  // row matches the tuiChrome hit-test geometry exactly.
  if (overlay) {
    return h(RowsView, { rows: overlayFrame(), width: frameW });
  }

  const frame = chatMainRows({
    theme: THEME,
    glyphs: GLYPHS,
    columns,
    rows,
    bleed,
    snapshot: { model: snapshot.model, workspace: snapshot.workspace, mode: snapshot.mode },
    flat,
    stats: {
      msgs: stats.turns,
      tokens: stats.usage.inputTokens + stats.usage.outputTokens,
      turnElapsed: busy && turnStartedAt.current != null ? (Date.now() - turnStartedAt.current) / 1000 : undefined,
      tools: stats.tools,
      agents: fleet?.agents?.length,
      errors: stats.errors,
    },
    busy,
    tick: spin,
    cursorOn,
    input,
    search: rsOpen ? { query: rsQuery, match: searchHistory(history.current, rsQuery, rsSkip)?.text } : undefined,
    thinking: busy,
    thinkingTokens: activity === "thinking" && thinkingChars.current > 0 ? Math.round(thinkingChars.current / 4) : undefined,
    currentTool: activity && activity !== "responding" && activity !== "thinking" ? activity : undefined,
    inFlight,
    fleet: fleetVm,
    scrolled: scrollOffset,
    todos: todos.length > 0 ? todos : undefined,
    palette: paletteOpen ? { items: filterPalette(input), selected: paletteSel, query: input } : undefined,
    perm: perm ? { toolName: perm.toolName, reason: perm.reason, suggestion: perm.suggestion } : undefined,
    version: process.env.npm_package_version ?? "",
  });
  frameRef.current = frame;
  return h(RowsView, { rows: frame.rows, width: frameW });

  // ── overlay frame builder (closure over live state) ───────────────────────
  function overlayFrame(): Row[] {
    const base = { theme: THEME, glyphs: GLYPHS, width: frameW };
    if (overlay === "models") {
      const provider = PICKER_PROVIDERS[mpProvider];
      const hint = mpLoading
        ? `loading ${provider}…`
        : mpModels.length === 0
          ? `no models for ${provider} — check key / connection`
          : `${mpModels.length} models · ${provider}`;
      return overlayRows({
        ...base,
        kind: "models",
        height: frameH,
        tabs: PICKER_PROVIDERS,
        activeTab: mpProvider,
        hint,
        footer: "click / 1-9 a-z select · tab provider · enter confirm · wheel scroll · esc close",
        body: modelsBody({ ...base, models: mpModels, sel: mpSel, scroll: ovScroll, capacity: ovCapacity, custom: mpCustom, loading: mpLoading, current: snapshot.model }),
      });
    }
    if (overlay === "effort") {
      return overlayRows({
        ...base,
        kind: "effort",
        height: frameH,
        tabs: [],
        activeTab: -1,
        hint: "how hard the model thinks before it acts",
        footer: "click a level · 1-7 · wheel nudge · esc close",
        body: effortBody({ ...base, level: effortLevel }),
      });
    }
    // settings
    let body: Row[];
    let hint = `settings · ${SETTINGS_TABS[settingsTab].toLowerCase()}`;
    if (settingsTab === SETTINGS_EFFORT_TAB) {
      body = effortBody({ ...base, level: effortLevel });
      hint = "how hard the model thinks before it acts";
    } else if (settingsTab === SETTINGS_APPEARANCE_TAB) {
      const caps = termCaps();
      const swatchOf = (t: (typeof TUI_THEMES)[number]) => {
        const pal = caps.colorLevel >= 2 ? t.truecolor : t.ansi;
        return [pal.primary, pal.secondary, pal.active, pal.success, pal.danger];
      };
      body = [
        ...themesBody({ ...base, themes: TUI_THEMES.map((t) => ({ id: t.id, label: t.label, tagline: t.tagline, swatch: swatchOf(t) })), current: themeId, scroll: ovScroll, capacity: Math.max(1, ovCapacity - 2) }),
        [],
        [{ text: ` terminal: ${caps.colorLevel >= 3 ? "truecolor" : caps.colorLevel === 2 ? "256 colors" : caps.colorLevel === 1 ? "16 colors" : "no color"} · ${caps.unicode ? "unicode" : "ascii"} glyphs   (ARES_TUI_COLOR / ARES_TUI_ASCII override)`, color: THEME.faint }],
      ];
      hint = "pick a face — it applies live to every screen and sticks";
    } else if (settingsTab === SETTINGS_PROVIDERS_TAB) {
      if (keyCapture) body = keyCaptureBody({ ...base, provider: keyCapture.provider, length: keyCapture.value.length });
      else
        body = [
          ...listBody({ ...base, items: KEY_PROVIDERS.map((name) => ({ label: name, hint: "set key" })), scroll: 0, capacity: KEY_PROVIDERS.length }),
          [],
          ...infoBody({ ...base, lines: settingsInfo.slice(0, Math.max(0, ovCapacity - KEY_PROVIDERS.length - 1)) }),
        ];
      hint = "click a provider (or its key) to enter an API key — stored encrypted";
    } else if (settingsTab === SETTINGS_MODELS_TAB) {
      body = listBody({ ...base, items: [{ label: "Open the full model picker", hint: "enter" }], scroll: 0, capacity: 1 });
      hint = "provider tabs · live catalogs · custom ids — also ctrl+o or Models in the toolbar";
    } else {
      body = settingsInfo.length ? infoBody({ ...base, lines: settingsInfo.slice(0, ovCapacity), firstBright: true }) : infoBody({ ...base, lines: ["loading engine settings…"] });
      hint = "the live engine configuration (read-only here)";
    }
    return overlayRows({
      ...base,
      kind: "settings",
      height: frameH,
      tabs: SETTINGS_TABS,
      activeTab: settingsTab,
      hint,
      footer: "click a tab (or Tab to cycle) · number keys select · esc close",
      body,
    });
  }
}

const GLYPHS = glyphsFor();

function progressText(data: unknown): string | null {
  if (!data || typeof data !== "object") return typeof data === "string" ? data : null;
  const obj = data as Record<string, unknown>;
  if (obj.kind === "subagent_activity") {
    // A researcher/builder agent narrating its step — one calm line, not the
    // raw payload (which used to land in the transcript as JSON).
    const activity = String(obj.activity ?? "").trim();
    if (!activity) return null;
    return `${obj.tool ? `${obj.tool} · ` : ""}${activity}`.slice(0, 160);
  }
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
