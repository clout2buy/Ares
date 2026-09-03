// Pure TUI logic — NO Ink imports. Diff grouping, paste normalization, line
// continuation, history reverse-search, fleet-row folding, and motion helpers.
// Everything here is plain data in → data out, unit-tested without a terminal
// (tests/tui-elite.test.mjs). inkTui.ts maps these onto <Text>/<Box> nodes.

import type { MdSpan } from "./mdRender.js";

// ─── Per-file diff grouping ──────────────────────────────────────────────────

export interface DiffFileGroup {
  path: string;
  adds: number;
  dels: number;
  /** Hunk body lines (@@ headers + +/-/context). File headers are consumed. */
  lines: string[];
}

/** Split a unified diff into per-file groups with add/del counts. Robust to
 *  missing `diff --git` headers (bare hunks land under "(diff)"). Never throws. */
export function groupDiffByFile(diff: string): DiffFileGroup[] {
  const groups: DiffFileGroup[] = [];
  let current: DiffFileGroup | null = null;
  const open = (path: string): DiffFileGroup => {
    const group: DiffFileGroup = { path, adds: 0, dels: 0, lines: [] };
    groups.push(group);
    return group;
  };
  for (const line of String(diff ?? "").split(/\r?\n/)) {
    if (!line) continue;
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) {
      current = open(git[2]);
      continue;
    }
    const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (plus) {
      const p = plus[1].trim();
      const path = p === "/dev/null" ? (current ? current.path : "(deleted)") : p;
      if (current && current.lines.length === 0) current.path = path;
      else current = open(path);
      continue;
    }
    if (
      line.startsWith("--- ") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity") ||
      line.startsWith("rename ") ||
      line.startsWith("Binary files")
    ) {
      continue;
    }
    if (!current) current = open("(diff)");
    if (line.startsWith("+")) current.adds++;
    else if (line.startsWith("-")) current.dels++;
    current.lines.push(line);
  }
  return groups;
}

/** The collapsed header row: `▸ path (+adds −dels)`. */
export function diffHeaderLabel(group: DiffFileGroup): string {
  return `▸ ${group.path} (+${group.adds} −${group.dels})`;
}

/** Colors the diff renderer needs — a structural slice of DeckTheme. */
export interface DiffLineTheme {
  add: string;
  del: string;
  meta: string;
  dim: string;
  text: string;
}

/** Style one diff body line as Ink-friendly spans (reuses the MdSpan shape so
 *  the TUI's existing span renderer applies). Pure; never throws. */
export function diffLineSpans(line: string, theme: DiffLineTheme): MdSpan[] {
  const s = String(line ?? "");
  if (s.startsWith("@@")) {
    const m = /^(@@[^@]*@@)(.*)$/.exec(s);
    if (m) {
      const spans: MdSpan[] = [{ text: m[1], color: theme.meta, bold: true }];
      if (m[2]) spans.push({ text: m[2], color: theme.dim });
      return spans;
    }
    return [{ text: s, color: theme.meta, bold: true }];
  }
  if (s.startsWith("+")) {
    return [
      { text: "+", color: theme.add, bold: true },
      { text: s.slice(1), color: theme.add },
    ];
  }
  if (s.startsWith("-")) {
    return [
      { text: "-", color: theme.del, bold: true },
      { text: s.slice(1), color: theme.del },
    ];
  }
  return [{ text: s, color: theme.dim }];
}

// ─── Input: bracketed paste + line continuation ──────────────────────────────

// ESC[200~ … ESC[201~ — matched with or without the ESC (Ink may strip it).
const PASTE_MARKERS = /\x1b?\[20[01]~/g;

export interface InputChunk {
  text: string;
  /** True when the chunk is a paste (bracketed markers, or a multi-char chunk
   *  containing newlines). A paste is inserted verbatim, never submitted. */
  paste: boolean;
}

/** Classify one raw useInput chunk. Bracketed-paste markers are stripped; a
 *  multi-char chunk containing \n or \r is treated as a paste (terminals send
 *  keystrokes one char at a time — newlines mid-chunk only happen on paste).
 *  Paste content is preserved verbatim apart from CRLF→LF normalization. */
export function normalizeInputChunk(raw: string): InputChunk {
  let text = String(raw ?? "");
  let paste = false;
  PASTE_MARKERS.lastIndex = 0;
  const stripped = text.replace(PASTE_MARKERS, "");
  if (stripped !== text) {
    paste = true;
    text = stripped;
  } else if (text.length > 1 && /[\r\n]/.test(text)) {
    paste = true;
  }
  if (paste) text = text.replace(/\r\n?/g, "\n");
  return { text, paste };
}

/** True when the input ends with an ODD number of backslashes — a trailing `\`
 *  continuation. `foo\\` (escaped backslash) does NOT continue. */
export function endsWithContinuation(input: string): boolean {
  const m = /(\\+)$/.exec(String(input ?? ""));
  return m != null && m[1].length % 2 === 1;
}

/** Drop the trailing continuation backslash (only when one is present). */
export function stripContinuation(input: string): string {
  return endsWithContinuation(input) ? input.slice(0, -1) : input;
}

// ─── History reverse-search (Ctrl+R) ─────────────────────────────────────────

export interface HistoryMatch {
  index: number;
  text: string;
}

/** Newest-first case-insensitive substring search. `skip` cycles to older
 *  matches (Ctrl+R pressed again). Empty query or no match → null. */
export function searchHistory(history: readonly string[], query: string, skip = 0): HistoryMatch | null {
  if (!query) return null;
  const q = query.toLowerCase();
  let remaining = Math.max(0, Math.floor(skip));
  for (let i = history.length - 1; i >= 0; i--) {
    const text = history[i] ?? "";
    if (text.toLowerCase().includes(q)) {
      if (remaining === 0) return { index: i, text };
      remaining--;
    }
  }
  return null;
}

// ─── Fleet panel state (Conductor fleet_activity over tool_progress) ─────────

export type FleetAgentStatus = "running" | "done" | "failed" | "resumed";

export interface FleetAgentRow {
  agentId: string;
  role: string;
  phase: string;
  status: FleetAgentStatus;
  activity: string;
}

export interface FleetState {
  fleetId: string | null;
  active: boolean;
  agents: FleetAgentRow[];
  startedAt: number;
}

/** Fold one fleet_activity progress payload into the panel state. Non-fleet
 *  payloads return the state unchanged. Pure — returns a new object. */
export function reduceFleet(state: FleetState | null, data: unknown, now = Date.now()): FleetState | null {
  if (!data || typeof data !== "object") return state;
  const d = data as Record<string, unknown>;
  if (d.kind !== "fleet_activity") return state;
  const base: FleetState = state ?? { fleetId: null, active: true, agents: [], startedAt: now };
  const event = String(d.event ?? "");
  const fleetId = typeof d.fleetId === "string" ? d.fleetId : base.fleetId;
  if (event === "fleet_start" || event === "planning") {
    const agents = event === "planning"
      ? upsertAgent(base.agents, {
          agentId: String(d.role ?? "fleet-architect"),
          role: String(d.role ?? "fleet-architect"),
          phase: String(d.phase ?? "plan"),
          status: "running",
          activity: "planning the fleet",
        })
      : base.agents;
    return { ...base, active: true, fleetId, agents };
  }
  const agentId =
    typeof d.agentId === "string" && d.agentId
      ? d.agentId
      : event === "repair"
        ? String(d.role ?? "repair")
        : null;
  if (!agentId) return { ...base, fleetId };
  const status: FleetAgentStatus =
    event === "done"
      ? (String(d.status ?? "completed") === "completed" || d.status === "needs_verification")
        ? "done"
        : "failed"
      : event === "resumed"
        ? "resumed"
        : "running";
  const activity =
    event === "tool"
      ? [d.tool, d.activity].filter((v) => typeof v === "string" && v).join(" ")
      : event === "done"
        ? String(d.status ?? "done")
        : event === "resumed"
          ? "reused from prior fleet"
          : event === "repair"
            ? "repair round"
            : "starting";
  const row: FleetAgentRow = {
    agentId,
    role: typeof d.role === "string" && d.role ? d.role : agentId,
    phase: typeof d.phase === "string" ? d.phase : "",
    status,
    activity: (activity || "working").slice(0, 120),
  };
  return { ...base, active: true, fleetId, agents: upsertAgent(base.agents, row) };
}

function upsertAgent(agents: readonly FleetAgentRow[], row: FleetAgentRow): FleetAgentRow[] {
  const idx = agents.findIndex((a) => a.agentId === row.agentId);
  if (idx < 0) return [...agents, row];
  const next = [...agents];
  next[idx] = { ...next[idx], ...row };
  return next;
}

/** Bound the panel: running agents first, then the rest, max `max` rows.
 *  `hidden` is the count folded into the "+N more" line. */
export function foldFleetRows(agents: readonly FleetAgentRow[], max = 12): { shown: FleetAgentRow[]; hidden: number } {
  if (agents.length <= max) return { shown: [...agents], hidden: 0 };
  const running = agents.filter((a) => a.status === "running");
  const rest = agents.filter((a) => a.status !== "running");
  const shown = [...running, ...rest].slice(0, max);
  return { shown, hidden: agents.length - shown.length };
}

export function fleetGlyph(status: FleetAgentStatus): string {
  if (status === "done") return "✓";
  if (status === "failed") return "✗";
  if (status === "resumed") return "↻";
  return "⚔";
}

/** The one-line scrollback summary when a fleet completes. */
export function fleetSummary(state: FleetState, now = Date.now()): string {
  const done = state.agents.filter((a) => a.status === "done" || a.status === "resumed").length;
  const failed = state.agents.filter((a) => a.status === "failed").length;
  const secs = Math.max(0, Math.round((now - state.startedAt) / 1000));
  const id = state.fleetId ? ` ${state.fleetId}` : "";
  return `⚔ fleet${id} · ${state.agents.length} agents · ${done}✓ ${failed}✗ · ${secs}s`;
}

// ─── Motion helpers ──────────────────────────────────────────────────────────

/** Motion gate: ARES_NO_MOTION=1 (or non-TTY stdout) → static rendering. */
export function motionEnabled(
  env: Record<string, string | undefined> = process.env,
  tty: boolean = Boolean(process.stdout.isTTY),
): boolean {
  const flag = env.ARES_NO_MOTION;
  if (flag === "1" || flag === "true") return false;
  return tty;
}

/** One easing step toward `target` — a lerp that snaps when close so the gauge
 *  settles instead of oscillating forever. */
export function easeToward(current: number, target: number, factor = 0.35): number {
  const delta = target - current;
  if (Math.abs(delta) < 0.6) return target;
  return current + delta * factor;
}

export interface ShimmerSpan {
  text: string;
  hot: boolean;
}

/** Split `text` into hot/cool runs: a bright band of `band*2+1` chars sweeps
 *  across on each tick (the streaming shimmer). Concatenating the spans always
 *  reproduces `text` exactly. */
export function shimmerSpans(text: string, tick: number, band = 2): ShimmerSpan[] {
  const s = String(text ?? "");
  if (!s) return [];
  const n = s.length;
  const cycle = n + band * 2 + 2;
  const t = ((Math.floor(tick) % cycle) + cycle) % cycle;
  const center = t - band;
  const out: ShimmerSpan[] = [];
  for (let i = 0; i < n; i++) {
    const hot = Math.abs(i - center) <= band;
    const last = out[out.length - 1];
    if (last && last.hot === hot) last.text += s[i];
    else out.push({ text: s[i], hot });
  }
  return out;
}

/** Compact human duration: 850ms · 1.2s · 12s · 2m05s. */
export function formatDuration(ms: number): string {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (v < 1000) return `${Math.round(v)}ms`;
  const s = v / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${String(rem).padStart(2, "0")}s`;
}
