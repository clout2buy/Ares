// Ares desktop — v3.
//
// Anatomy:
//   titlebar     — draggable strip: brand, daemon pill, window controls
//   left rail    — new session, sessions inbox, settings, status dot
//   center       — chat: turns, tool-step cards, thinking, permissions, usage
//   composer     — model + reasoning + routing chips, autosizing input
//   footer       — ambient telemetry + Garrison log + manual restart
//   the Forge    — right side panel: artifact preview / live HTML sandbox /
//                  the holo 3D engine. Real documents over the asset protocol
//                  so their scripts actually run.
//
// Design law: flat obsidian, one bronze accent, steel = success, crimson =
// danger. Motion everywhere, but small: entrances, sweeps, pulses.
//
// Daemon bridge: ares_start_daemon / ares_drain_events polling +
// ares:event-buffered push, ares_send, ares_restart_daemon, ares_set_reasoning,
// ares_set_routing, ares_permission_response, ares_forge_write. The shell now
// watches the child and emits desktop_daemon_exited when it dies — the UI
// surfaces the stderr tail and auto-restarts the Garrison.
//
// In a plain browser (no native bridge) the app runs in DEMO mode.

import React, { Fragment, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize, PhysicalSize, PhysicalPosition } from "@tauri-apps/api/window";
// The REAL holotable BUILD engine — same module the CLI's `ares holo` uses.
// Any model plugged into Ares emits a HoloSpec (*.holo.json) and this renders
// it: exploded view, assembly steps, wiring overlay, BOM with STL export.
import { buildHolotableHtml, validateHoloSpec, type HoloSpec } from "../../packages/cli/src/holotable";
import { redactSecrets } from "../../packages/protocol/src/secretRedact";
import { daemonExitMessage } from "../../packages/protocol/src/daemonExit";
import { createLiveExplain, settled as settledKitPage } from "./liveExplain";
import { UpdateBanner } from "./UpdateBanner";
import { PhonePairCard, type PhonePairState } from "./PhonePair";
import { WhatsNew } from "./WhatsNew";
import { ForgeIntro } from "./ForgeIntro";
import { LivingSurface } from "./LivingSurface";
import { StyleCtx, SpringNumber, SpringHeight, TokenFlowStrip, pushTokenFlow, useNewStyle, useUiStyle } from "./newStyle";
import { AresSigils, Medallion, Sigil, asSigilName } from "./modernIcons";
import { CHANGELOG } from "./changelog";
import { useTts, sidecarListen, wakeListen, fetchVoices, setVoiceToken, setVoiceEndpoint, type VoiceInfo, type WakeHandle } from "./voice";
import {
  type AresEvent,
  type ConsciousnessModelVm,
  type ConsciousnessVm,
  type AresNetworkVm,
  type OAuthProviderVm,
  type McpConnectorVm,
  type SlashAction,
  type McpRegistryResult,
  type McpToolsVm,
  type GatewayAccountVm,
  type BufferedEvent,
  type DaemonStatus,
  type PresenceMode,
  type PresenceSnapshot,
  type BackgroundJobVm,
  type FleetSummaryWire,
  type SubagentJobWire,
  type OllamaUsageView,
  type ProviderUsageView,
  type McpCatalogVm,
  type McpServerStatusVm,
} from "./state/events";
import {
  type ReasoningLevel,
  REASONING_LEVELS,
  EFFORT_META,
  effortLevelsFor,
  effectiveEffort,
  recordEffortLadders,
  effortWireLabel,
  PREVIEW_SANDBOX,
  PREVIEWABLE,
  HOLO_SPEC_FILE,
  type ToolStep,
  type Item,
  type SessionVm,
  type CodingBackendVm,
  type FleetVm,
  nextKey,
  fireNotification,
  freshSession,
  type SessionSummaryWire,
  sessionFromSummary,
  sessionFromHistory,
  workingHintFor,
  setTurnTokenWarn,
} from "./state/session";
import { foldEvent, toolKind, summarizeSteps } from "./state/foldEvent";
import { daemonHealth, loopStuckNote, turnStatusNote, type Pong } from "./state/health";
import {
  claimSteersForDaemonReady,
  createSteerReplayEpoch,
  markSteerSentInEpoch,
  resetSteerReplayEpoch,
  steerReplayWireText,
} from "./state/steerReplay";
import {
  attachmentBudgetViolation,
  MAX_ATTACH_B64,
  MAX_ATTACHMENTS,
  supportedAttachmentMediaType,
} from "./state/attachments";
import { compact, stringify, fmtTokens, fmtSpend, fmtMs, fmtBytes, escapeHtml, dataUrlB64Len, splitDataImages } from "./lib/format";
import { renderMarkdown, splitRich, inlineMd, type RichSegment } from "./lib/markdown";
import {
  type Prefs,
  type ThemeName,
  THEMES,
  SURFACES,
  ACCENTS,
  surfaceToStyle,
  surfaceToTheme,
  type RouteLane,
  ROUTE_LANES,
  type Routing,
  type EngineConfig,
  loadPrefs,
  savePrefs,
  type PermSettings,
  DEFAULT_PERMS,
} from "./state/prefs";
import {
  type ModelOption,
  defaultModelForProvider,
  useModelCatalog,
  CUSTOM_BASE_LS,
  CUSTOM_MODELS_LS,
  CUSTOM_MODEL_LS,
  readCustomModels,
} from "./models/catalog";
import { STREAM_SPEECH_SENTENCE_MIN, STREAM_SPEECH_BATCH_MIN, takeStreamSpeechChunk } from "./voice/streamSpeech";
import "./devBridge";
import "./styles.css";
import "./modern.css";
// LAST on purpose: the Basic themes neutralize tokens the skins above set, so
// they must win ties on load order as well as on specificity.
import "./basic.css";
import "./cyber.generated.css";
import "./cyber.css";
import "./forge.css";
import "./messages.css";
import "./glass.css";
import { FeedView, NowView } from "./messagesViews";
import { ForgePixelPulse, ForgePixelReveal, ForgePixelRim, PixelIcon } from "./forgePixels";
import { ForgeNativeView, forgeNativeTarget, forgeViewControl } from "./forgeNativeView";
import { CyberField } from "./cyberField";
import { ConnectorDirectory } from "./ConnectorDirectory";
import { BUILTIN_POINT_MAPS, normalizePointMap, type PointMapSpec } from "./pointMaps";
import { Tutorial, markTutorialSeen, tutorialSeen } from "./tutorial";
import { MsgTabBar, MsgTitlebar, type MsgTab } from "./shell";
import { WorkspacesPane, type WorkspaceVm } from "./workspacesPane";
import { IPhonePane, ProfilePane, ProfileSheet, ScheduledList, ScheduledPane, SharingPanel, type JobVm, type SharingVm } from "./aresMore";
import { InviteCard, PeopleSheet, type DirectoryInviteVm, type DirectoryProfileVm, type DirectoryVm } from "./people";
import { RoomCreateSheet, RoomInviteSheet, RoomJoinSheet, RoomList, RoomView, type RoomMessageVm, type RoomRowVm, type RoomVm, type RoomsMeVm } from "./rooms";
import { type AgentMemoryVm, ARES_AGENT_ID, AgentChatContext, AgentComposerMeta, AgentPhotoContext, AgentPosesContext, AgentClipsContext, AvatarStyleContext, AgentAvatar, AgentDock, AgentEditor, AgentHero, AgentList, agentFaceByName, blankDraft, draftOf, parseAgentText, rememberAgentFaces, type AgentDraft, type AgentRowVm, type AgentVm } from "./agents";

// The app version, injected by Vite's `define`. Guarded with typeof so that even
// if the build ever fails to substitute the token (which white-screened the app
// on a past update), this resolves to a harmless fallback instead of throwing a
// ReferenceError that takes the whole UI down.
const APP_VERSION: string = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";


function hasNativeBridge(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}








// ─── The Forge: built-in holo engine + sandbox seeds ───────────────────────

// The holotable showpiece (MECH_SPEC) renders by default; agent-forged
// *.holo.json specs replace it. Built lazily — the engine HTML is ~40KB.
let holoDefaultCache: string | null = null;
function holoDefaultHtml(): string {
  holoDefaultCache ??= buildHolotableHtml();
  return holoDefaultCache;
}

const SANDBOX_SEED = `<!doctype html>
<html>
<head>
<style>
  body { margin:0; height:100vh; display:grid; place-content:center; gap:16px;
         background:#0c0a0b; color:#c79a4e; font-family:Consolas,monospace; text-align:center; }
  h1 { font-size:14px; letter-spacing:.4em; margin:0; }
  button { background:none; border:1px solid #c79a4e66; color:#e3b86a; padding:10px 18px;
           border-radius:10px; font:inherit; cursor:pointer; }
  button:hover { background:#c79a4e22; }
</style>
</head>
<body>
  <h1>THE FORGE · SANDBOX</h1>
  <p id="out">Edit the HTML on the left, then Run. Scripts are live.</p>
  <button onclick="document.getElementById('out').textContent='It runs. ' + new Date().toLocaleTimeString()">prove it</button>
</body>
</html>`;

type ForgeTab = "preview" | "sandbox" | "holo" | "live" | "background";

interface ForgeState {
  open: boolean;
  tab: ForgeTab;
  artifact?: { path: string; label: string };
}

function launchableUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^(https?|file):\/\//i.test(value)) return value;
  return `http://${value}`;
}

function forgeFrameUrl(url: string, native: boolean, revision: number): string {
  if (/^file:\/\//i.test(url) && native) {
    try {
      const parsed = new URL(url);
      let filePath = decodeURIComponent(parsed.pathname);
      if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
      return `${convertFileSrc(filePath)}?forge=${revision}`;
    } catch { return url; }
  }
  const join = url.includes("?") ? "&" : "?";
  return `${url}${join}ares_forge=${revision}`;
}

/** The browser-preview build only (no desktop): external sites commonly deny
 * iframe embedding, so there the Forge frames only local targets and streams
 * Ares's browser for the rest. The desktop shows every http(s) page in its
 * native view instead (forgeNativeView.tsx), which no site can refuse. */
function forgeCanEmbed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:" || parsed.protocol === "asset:" || parsed.protocol === "tauri:") return true;
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

// ─── Demo feed (browser preview) ───────────────────────────────────────────

/**
 * The roster, for the browser preview only.
 *
 * The real roster arrives from the daemon (`roster_list`), which the web
 * preview has no access to. These mirror the built-ins in
 * packages/agent/src/roster.ts so HELM → Agents is reviewable in `pnpm dev`
 * instead of showing a permanently empty gallery. Same intent as demoSession.
 * The installed app always overwrites this on its first roster_list.
 *
 * Keep `autonomy` in step with the real built-ins — they are all "suggest", and
 * a preview that shows "Steps in" would have a reviewer signing off on exactly
 * the behaviour that was removed.
 */
function demoRoster(): PersonaVm[] {
  const make = (
    name: string,
    label: string,
    description: string,
    greeting: string,
    glyph: string,
    tone: PersonaVm["tone"],
    autonomy: PersonaVm["autonomy"],
    triggers: string[],
    tools: string[],
  ): PersonaVm => ({
    name, label, description, greeting, glyph, tone, autonomy, triggers, tools,
    source: "builtin",
    file: "",
    body: `You are working as ${label}.

${description}`,
  });
  return [
    make("aegis", "Aegis", "Adversarial review. Tries to break the work — security, edge cases, and the last 20% nobody checks.",
      "Aegis. I'm here to break it, not bless it. What am I attacking?", "shield", "ember", "suggest",
      ["review", "audit", "security", "edge case", "harden"], ["Read", "Glob", "Grep", "Bash"]),
    make("forge", "Forge", "Implementation. Writes and ships code, verifies against the real thing, refuses to claim done without proof.",
      "Forge here. Point me at it — I build, I run it, and I tell you what I actually saw.", "forge", "ember", "suggest",
      ["implement", "build", "refactor", "fix", "wire up"], []),
    make("scribe", "Scribe", "Writing and explanation. Docs, changelogs, commit messages, and turning tangled work into plain language.",
      "Scribe. Tell me what needs saying and who's reading it.", "scroll", "ivory", "suggest",
      ["document", "write up", "explain", "changelog", "commit message"], ["Read", "Grep", "Write", "Edit"]),
    make("vitruvius", "Vitruvius", "Research and architecture. Reads widely, cites everything, argues trade-offs before writing code.",
      "Research hat on. I read before I opine and I cite what I find — what are we digging into?", "search", "mint", "suggest",
      ["research", "investigate", "look into", "compare", "trade-off", "architecture"], ["Read", "Grep", "WebSearch", "WebFetch"]),
  ];
}

/**
 * A cognitive snapshot for the browser preview only.
 *
 * Shaped to show what the panel looks like when things have actually gone
 * wrong — a red check, real uncertainty, a repeated tool failure, a dead
 * subsystem — because a cockpit that has only ever been seen in its happy state
 * is a cockpit nobody has really reviewed. The installed app replaces this on
 * its first cognitive_state.
 */
function demoCognitive(): CognitiveStateVm {
  return {
    sessionId: "demo",
    at: new Date(0).toISOString(),
    missions: [
      { id: "g1", statement: "Unify session validation and keep the middleware honest", status: "active", progress: 0.62, steps: 8,
        contract: "Done when guard.ts delegates to validateSession() and the auth suite passes with no skips." },
    ],
    objective: "Unify the duplicated session validation",
    phase: "implement",
    steering: ["keep the public signature stable"],
    currentStep: "Running the auth suite",
    todos: [
      { content: "Trace every validateSession caller", status: "completed" },
      { content: "Delegate guard.ts to the canonical path", status: "completed" },
      { content: "Run the auth suite", status: "in_progress" },
      { content: "Check the middleware still short-circuits", status: "pending" },
    ],
    evidence: [
      { label: "auth suite", command: "pnpm test -- auth", verdict: "fail", cached: false, durationMs: 4120, at: new Date(0).toISOString(),
        outputTail: "not ok 12 - rejects an expired token\n  expected 401, got 200" },
      { label: "typecheck", command: "tsc -b", verdict: "pass", cached: false, durationMs: 8830, at: new Date(0).toISOString() },
      { label: "lint", command: "eslint src/auth", verdict: "skip", cached: true, durationMs: 0, at: new Date(0).toISOString() },
    ],
    uncertainty: [
      "1 check is currently red: auth suite.",
      "1 check was reused from cache rather than re-run.",
      "The middleware path has not been exercised — only the validator was tested.",
    ],
    workStatus: "unverified",
    recalled: [{ id: "mem_a41", used: true }, { id: "mem_7c2", used: true }, { id: "mem_ff9", used: true }],
    failures: [
      { tool: "Edit", signature: "a91f2c4e", count: 3, latest: "File has changed since it was last read — re-read before editing.", at: new Date(0).toISOString() },
    ],
    recovery: ["Edit failed 3× on the same signature — strategy change was demanded after each."],
    blockedApprovals: [{ tool: "Bash", reason: "git push origin main — outward effect", at: new Date(0).toISOString() }],
    touchedFiles: ["src/auth/session.ts", "src/middleware/guard.ts"],
    liveness: [
      { subsystem: "Working state (journal)", state: "live", detail: "6 turn(s) recorded · 3 check(s) · 1 failure signature(s)" },
      { subsystem: "Continuous verification", state: "live", detail: "1 passed / 1 failed / 1 skipped · latest: failed (behavioral)" },
      { subsystem: "Memory recall", state: "live", detail: "3 memory node(s) injected into the last turn." },
      { subsystem: "Reliability triage", state: "dead", detail: "Ran but read ZERO rollout files — it is finding nothing because it can see nothing." },
      { subsystem: "Mission loop", state: "unknown", detail: "Reachable via the Operator tool, but not yet instrumented — this panel cannot tell you whether it ran." },
    ],
  };
}

function demoSession(): SessionVm {
  let s = freshSession();
  s.title = "Refactor the auth flow";
  const feed: AresEvent[] = [
    { type: "turn_start" },
    { type: "route_resolved", model: "minimax-m2", lane: "coding" },
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
  // Replicates the deepseek-via-ollama cadence that produced render bugs:
  // thinking-only rounds, each followed by a single tool call, reused ids.
  const deepseekRounds: AresEvent[] = [
    { type: "thinking_delta", text: "The user wants to see cow pictures. I'll use the Browser tool headless to search for cow images." },
    { type: "tool_start", id: "functions.Browser:0", name: "Browser", input: { action: "open", url: "https://pexels.com" } },
    { type: "tool_error", id: "functions.Browser:0", error: "Playwright is not installed", durationMs: 41 },
    { type: "thinking_delta", text: "The browser tool needs Playwright installed. Let me install it and then try again." },
    { type: "tool_start", id: "functions.Bash:0", name: "Bash", input: { command: "pnpm add -w playwright" } },
    { type: "tool_end", id: "functions.Bash:0", durationMs: 9000, display: "added playwright" },
    { type: "thinking_delta", text: "Playwright is installed. Now let me try the browser again." },
    { type: "text_delta", text: "---\n" },
    { type: "text_delta", text: "Stock sites are blocking the headless browser. Let me pull image URLs from image search instead.\n\n" },
    { type: "text_delta", text: "Here's how the tools compare:\n\n| Tool | Best for | Watch out |\n|---|---|---|\n| Edit | one-line surgical fixes | fails if the string appears twice |\n| ApplyIntent | large rewrites | adds APPLY-slot latency |\n| ImageSearch | direct image URLs | no content filtering |\n\nAnd the agent's mental model:\n\n```mermaid\ngraph TD\n  USER[You] --> PLAN[Plan]\n  PLAN --> ACT[Act with tools]\n  ACT --> VERIFY{Verify}\n  VERIFY -->|green| DONE[Deliver]\n  VERIFY -->|red| ACT\n```\n\nTool-call latency, lower is better:\n\n```chart\nRead: 95\nGrep: 312\nEdit: 141\nWebFetch: 1400\n```\n" },
  ];
  for (const e of [...feed, ...deepseekRounds]) s = foldEvent(s, e);
  s.items.unshift({ kind: "user", key: nextKey(), text: "unify the duplicated session validation, then make the middleware use it" });
  s.items.push({ kind: "artifact", key: nextKey(), path: "holo-arm.html", label: "holo-arm.html" });
  s.items.push({ kind: "permission", key: nextKey(), id: "demo-perm", toolName: "Bash", reason: "git push origin main — outward effect, staged for your approval" });
  return s;
}

// ─── Demo agents (browser preview without a daemon) ─────────────────────────
function demoChat(title: string, user: string, feed: AresEvent[], extra: Item[] = [], minutesAgo = 5): SessionVm {
  let s = freshSession();
  s.title = title;
  s.updatedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  for (const e of [...feed, { type: "turn_settled" } as AresEvent]) s = foldEvent(s, e);
  s.busy = false;
  s.activity = undefined;
  s.items.unshift({ kind: "user", key: nextKey(), text: user });
  s.items.push(...extra);
  return s;
}

function demoAgentWorld(): { agents: AgentVm[]; sessions: SessionVm[] } {
  const racer = demoChat("Neon drift racer", "build me a drift racing game in a neon city — real car physics, 4 wheels, skid marks, the works", [
    { type: "turn_start" },
    { type: "thinking_delta", text: "Raycast-vehicle physics: four wheels with suspension springs, lateral grip curve so drifting happens when the rear breaks traction." },
    { type: "tool_start", id: "d1", name: "Browser", activityDescription: "Sculpting the car body in the Forge" },
    { type: "tool_end", id: "d1", durationMs: 4200, display: "studio forge-racer · 18 parts · glass windshield · 4 wheels skinned" },
    { type: "tool_start", id: "d2", name: "Write", activityDescription: "Writing game/drift.js" },
    { type: "tool_end", id: "d2", durationMs: 120, display: "game/drift.js — vehicle, grip curve, skid decals, chase cam" },
    { type: "text_delta", text: "It's running in the Forge. The car is a real sculpt — windshield, four wheels on suspension, and the rear lets go when you flick it, so drifts feel earned.\n\n**Controls:** WASD, space for handbrake. Skid marks fade over ~6s, and the city is instanced so it holds 120fps." },
    { type: "turn_end", status: "completed", durationMs: 41000, usage: { inputTokens: 48000, outputTokens: 3100 } },
  ], [{ kind: "artifact", key: nextKey(), path: "game/index.html", label: "Neon drift racer" }], 3);
  const subs = demoChat("Subscriptions audit", "what am I paying for every month?", [
    { type: "turn_start" },
    { type: "text_delta", text: "Seven recurring charges, $143.96/mo total. Two look forgotten: **Dropbox Plus** ($11.99, last opened in June) and a **second Spotify** ($10.99 on the Amex). Want me to cancel those two?" },
    { type: "turn_end", status: "completed", durationMs: 9000, usage: { inputTokens: 9000, outputTokens: 220 } },
  ], [
    { kind: "user", key: nextKey(), text: "[text from Atlas] Found it — the second Spotify is a Duo plan your sister's account still points at. Safe to cancel; she has her own now." },
    { kind: "assistant", key: nextKey(), text: "Atlas checked the Spotify one — it's a leftover Duo plan, safe to cancel. I'll cancel both and keep watching for new charges over $50.", thinking: "", streaming: false },
  ], 26);
  const research = demoChat("Spotify Duo leftover", "[text from Penny] Can you check whether the second Spotify charge on the Amex is a family/duo plan someone else uses?", [
    { type: "turn_start" },
    { type: "tool_start", id: "r1", name: "WebSearch", activityDescription: "Searching Spotify Duo billing" },
    { type: "tool_end", id: "r1", durationMs: 900, display: "Duo plans bill the manager's card; members show as linked accounts" },
    { type: "text_delta", text: "Texted Penny back: it's a Duo plan whose second seat is your sister's old account — safe to cancel." },
    { type: "turn_end", status: "completed", durationMs: 7000, usage: { inputTokens: 7000, outputTokens: 180 } },
  ], [], 1500);
  // Atlas is mid-reply: the typing bubble and the face that looks around.
  research.items.push({ kind: "user", key: nextKey(), text: "while you're at it, is Dropbox Plus safe to drop? I think my photos backup uses it" });
  research.busy = true;
  research.activity = "thinking";
  research.updatedAt = new Date(Date.now() - 30_000).toISOString();
  const moodboard = freshSession();
  const now = new Date().toISOString();
  const agents: AgentVm[] = [
    { id: "p_demo0forge01", name: "Forge", emoji: "🎮", color: "#ff7a45", provider: "anthropic", model: "claude-opus-5-5", instructions: "You're my game developer. Build playable games and 3D scenes in the Forge — real physics, real models, polished feel. Show me it running, not a plan.", threads: [racer.id], createdAt: now },
    { id: "p_demo0penny1", name: "Penny", emoji: "💸", color: "#4cd28a", provider: "openai", model: "gpt-5.6", instructions: "You're my finance person. Keep track of what I spend, flag anything weird or recurring I forgot about, and keep me posted when I get charged for something big.", threads: [subs.id], onPhone: true, createdAt: now },
    { id: "p_demo0atlas1", name: "Atlas", emoji: "🔬", color: "#38bdf8", provider: "deepseek", model: "deepseek-v4", instructions: "You're my researcher. Dig into anything I ask, read the real sources, and give me the short answer first.", threads: [research.id], createdAt: now },
    { id: "p_demo0muse01", name: "Muse", emoji: "🎨", color: "#ec4899", provider: "anthropic", model: "claude-sonnet-5-5", instructions: "You're my designer. Logos, UI, posters, brand looks — make it beautiful and opinionated, and show me options side by side.", threads: [moodboard.id], createdBy: "p_demo0forge01", createdAt: now },
  ];
  return { agents, sessions: [demoSession(), racer, subs, research, moodboard] };
}
function demoAgentMemory(agentId: string): AgentMemoryVm {
  const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const sets: Record<string, Array<[string, string, string[]?]>> = {
    p_demo0penny1: [
      ["semantic", "Owner wants a heads-up for any single charge over $50."],
      ["semantic", "Second Spotify on the Amex is a leftover Duo plan (sister's old seat) — safe to cancel.", ["handed-from:p_demo0atlas1"]],
      ["episodic", "Found 7 recurring charges totalling $143.96/mo on Oct 17."],
      ["procedural", "Check the Amex and the debit card every morning; summarise only what changed."],
      ["semantic", "Owner's rent is paid on the 1st from the checking account.", ["handed-from:ares"]],
    ],
  };
  const items = (sets[agentId] ?? [["semantic", "Owner prefers short answers that lead with the result."], ["episodic", "First chat with the owner."]]).map(([kind, content, tags], i) => ({ id: `${agentId}-m${i}`, kind, content, at: at(i * 7 + 1), ...(tags ? { tags } : {}) }));
  return { total: items.length, items };
}

const DEMO_AGENT_WORLD = typeof window !== "undefined" && !hasNativeBridge() ? demoAgentWorld() : null;

// ─── First-run key gate ──────────────────────────────────────────────────────
//
// A brand-new user who launches with zero API keys used to be able to type and
// send — then the turn would die deep in the provider with a cryptic auth error.
// This intercepts that: once the daemon reports its key status and NOTHING is
// usable (no provider key AND no reachable local Ollama), we put a calm welcome
// in front of the chat that routes straight to Settings → API Keys. It's
// dismissible (so a power user spinning up Ollama isn't trapped) and re-appears
// next launch while still unconfigured. It auto-closes the moment a key lands.

function noUsableKeys(keyStatus: Record<string, boolean>): boolean {
  const known = Object.values(keyStatus);
  return known.length > 0 && known.every((v) => !v);
}

/** "I'll use local Ollama" is a real decision, not a per-launch dismissal:
 *  remember it so the gate never re-prompts a local-first user on every boot.
 *  (Adding a key / signing in closes the gate through keyStatus instead.) */
const FIRSTRUN_CHOICE_KEY = "ares.firstRun.choice";

function FirstRunGate({
  active,
  onOpenKeys,
  onConnectAres,
}: {
  active: boolean;
  onOpenKeys: () => void;
  onConnectAres: () => void;
}): React.ReactElement | null {
  const [dismissed, setDismissed] = useState(false);
  // Re-arm if keys disappear again (e.g. the user clears them mid-session) —
  // but never for a user who durably chose the local-Ollama path.
  useEffect(() => {
    if (!active) setDismissed(false);
  }, [active]);
  let chosenLocal = false;
  try {
    chosenLocal = window.localStorage.getItem(FIRSTRUN_CHOICE_KEY) === "local-ollama";
  } catch { /* storage unavailable — fall back to per-launch behavior */ }
  if (!active || dismissed || chosenLocal) return null;
  const chooseLocal = () => {
    try {
      window.localStorage.setItem(FIRSTRUN_CHOICE_KEY, "local-ollama");
    } catch { /* storage unavailable */ }
    setDismissed(true);
  };
  return (
    <div className="scrim center" role="dialog" aria-modal="true" aria-labelledby="frgTitle">
      <div className="wnCard frgCard" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="wnGlow" aria-hidden="true" />
        <div className="wnMark" aria-hidden="true" />
        <header className="wnHead">
          <div className="wnKicker">
            <span className="wnSpark" aria-hidden="true">✦</span>
            Welcome to Ares
          </div>
          <h2 id="frgTitle" className="wnTitle">One quick step to begin</h2>
          <p className="wnTagline">
            Ares needs a way to think. Connect your Ares account for models with zero setup —
            or bring your own: add a provider key (Anthropic, OpenAI, OpenRouter, DeepSeek, or
            any OpenAI-compatible endpoint), or point it at a local Ollama. About a minute.
          </p>
        </header>
        <footer className="wnFoot">
          <button className="wnOlderToggle" onClick={chooseLocal}>
            I'll use local Ollama
          </button>
          <button className="wnGhost" onClick={onOpenKeys}>
            Add an API key
          </button>
          {/* The zero-setup path: one account, models included. Made primary. */}
          <button className="wnGo" onClick={onConnectAres} autoFocus>
            Connect Ares account
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─── App ───────────────────────────────────────────────────────────────────

type DaemonState = "starting" | "running" | "stopped" | "error";


const MAX_AUTO_RESTARTS = 3;

/** How many transcript items stay mounted at once. Long sessions used to
 *  mount every bubble forever — the unbounded DOM (plus full-size data-URI
 *  images inside it) is what walked the WebView2 renderer to 4.8GB. */
const TRANSCRIPT_WINDOW = 150;

/** Live automation frames drawn into ONE persistent canvas. The old path set
 *  a brand-new data: URI on a mounted <img> for every frame — each frame a
 *  fresh decode + cached bitmap the renderer had to GC, the CPU/memory churn
 *  behind the WebView2 leak during browser-driving runs. The canvas backing
 *  store is allocated once and repainted in place. */
interface LiveFeedState {
  source: string;
  side: string;
  label: string;
  at: number;
  interactive: boolean;
  watching: boolean;
  offered: boolean;
  width?: number;
  height?: number;
  step?: string;
  note?: string;
  /** Native window hints from the provider, for embedding the real window. */
  pid?: number | null;
  windowTitle?: string;
}

const IS_WINDOWS_HOST = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** Physical-pixel rectangle of an element inside the window's client area. */
function physicalRect(el: HTMLElement): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  const s = window.devicePixelRatio || 1;
  return { x: Math.round(r.left * s), y: Math.round(r.top * s), w: Math.max(1, Math.round(r.width * s)), h: Math.max(1, Math.round(r.height * s)) };
}

interface LiveInputEvent {
  kind: "key" | "mouse" | "wheel";
  key?: string;
  pressed?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  x?: number;
  y?: number;
  button?: number;
  relative?: boolean;
  move?: boolean;
  mask?: number;
  delta?: number;
}

/** Browser KeyboardEvent.code → the key name Godot's OS.find_keycode_from_string accepts. */
function godotKeyName(code: string, key: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `KP ${code.slice(6)}`;
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  const named: Record<string, string> = {
    Space: "Space", Escape: "Escape", Enter: "Enter", NumpadEnter: "Kp Enter", Tab: "Tab", Backspace: "Backspace",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    ShiftLeft: "Shift", ShiftRight: "Shift", ControlLeft: "Ctrl", ControlRight: "Ctrl", AltLeft: "Alt", AltRight: "Alt",
    Delete: "Delete", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", CapsLock: "CapsLock",
    Minus: "Minus", Equal: "Equal", BracketLeft: "BracketLeft", BracketRight: "BracketRight", Semicolon: "Semicolon", Quote: "Apostrophe",
    Comma: "Comma", Period: "Period", Slash: "Slash", Backslash: "Backslash", Backquote: "QuoteLeft",
  };
  if (named[code]) return named[code];
  return key.length === 1 ? key.toUpperCase() : null;
}

/** Map a pointer position on an object-fit:contain canvas to frame pixels. */
function frameCoords(el: HTMLElement, clientX: number, clientY: number, fw: number, fh: number): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  const ar = fw / Math.max(1, fh);
  let dw = rect.width, dh = rect.width / ar;
  if (dh > rect.height) { dh = rect.height; dw = rect.height * ar; }
  const ox = (rect.width - dw) / 2, oy = (rect.height - dh) / 2;
  const x = Math.max(0, Math.min(fw, ((clientX - rect.left - ox) / Math.max(1, dw)) * fw));
  const y = Math.max(0, Math.min(fh, ((clientY - rect.top - oy) / Math.max(1, dh)) * fh));
  return { x: Math.round(x), y: Math.round(y) };
}

function LiveFrameCanvas({ frame, className, title }: { frame: string; className?: string; title?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      canvas.getContext("2d")?.drawImage(img, 0, 0);
    };
    img.src = `data:image/jpeg;base64,${frame}`;
    return () => {
      cancelled = true;
      img.onload = null;
      img.src = "";
    };
  }, [frame]);
  return <canvas ref={canvasRef} className={className} title={title} aria-label={title} />;
}

/** Longest edge of a transcript image thumbnail's backing store. */
const THUMB_EDGE = 320;

/** Transcript attachment images, decoded ONCE into a small canvas. The full
 *  data: URL used to sit in a mounted <img> per attachment — every pasted
 *  screenshot pinned its full decoded bitmap in the renderer for the life of
 *  the session (a large slice of the 4.8GB leak). The full image now only
 *  mounts while the lightbox is open. */
function BubbleImage({ src, alt }: { src: string; alt: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const scale = Math.min(1, THUMB_EDGE / Math.max(1, Math.max(img.naturalWidth, img.naturalHeight)));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = src;
    return () => {
      cancelled = true;
      img.onload = null;
      img.src = "";
    };
  }, [src]);
  return (
    <>
      <canvas
        ref={canvasRef}
        className="bubbleImage"
        role="img"
        aria-label={alt}
        title="Click to view full size"
        onClick={() => setFull(true)}
      />
      {full ? (
        <div className="imageLightbox" onClick={() => setFull(false)} role="dialog" aria-label={alt}>
          <img src={src} alt={alt} />
        </div>
      ) : null}
    </>
  );
}

/** An agent's proposed new faces: tap one and it goes live (the App's
 *  "ares:avatar-pick" listener sets it and tells the agent). */
function AvatarIdeasCard({ item }: { item: Extract<Item, { kind: "avatarIdeas" }> }) {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div className="turn avatarIdeasTurn">
      <div className="avatarIdeas" data-picked={picked ? "1" : "0"}>
        {item.options.map((o) => (
          <button
            key={o.n}
            className="avatarIdea"
            data-on={picked === o.n ? "1" : "0"}
            disabled={picked !== null}
            title={o.idea}
            onClick={() => {
              setPicked(o.n);
              window.dispatchEvent(new CustomEvent("ares:avatar-pick", { detail: { agentId: item.agentId, path: o.path, n: o.n } }));
            }}
          >
            <img src={convertFileSrc(o.path)} alt={o.idea} loading="lazy" draggable={false} />
          </button>
        ))}
      </div>
      <p className="avatarIdeasHint">{picked ? `Option ${picked} is your new look` : "Tap the one you like"}</p>
    </div>
  );
}

function App() {
  const native = useMemo(hasNativeBridge, []);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  setTurnTokenWarn(prefs.turnTokenWarn);
  // Glass mode "auto" follows the system light/dark setting, live.
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const glass = prefs.glassMode === "dark" || (prefs.glassMode === "auto" && systemDark) ? "dark" : "light";
  const [daemon, setDaemon] = useState<DaemonState>(native ? "starting" : "running");
  // Out-of-band health probe: the daemon answers a ping even mid-turn, so a
  // missing pong means the daemon itself is wedged, not just a slow chat.
  const lastPingAtRef = useRef(0);
  const lastPongAtRef = useRef(0);
  const [pong, setPong] = useState<Pong | null>(null);
  const [healthNow, setHealthNow] = useState(() => Date.now());
  const [sessions, setSessions] = useState<SessionVm[]>(() => (native ? [freshSession()] : DEMO_AGENT_WORLD?.sessions ?? [demoSession()]));
  // ── desktop agents: the rail's contacts (agents.tsx, daemon/agents.ts) ──
  const [agents, setAgents] = useState<AgentVm[]>(() => (native ? [] : DEMO_AGENT_WORLD?.agents ?? []));
  /** The daemon has answered agents_list once: until then "no agents" means "not loaded yet". */
  const [agentsLoaded, setAgentsLoaded] = useState(!native);
  const [selectedAgentId, setSelectedAgentIdState] = useState<string>(() => {
    try { return window.localStorage.getItem("ares.agent.selected") || ARES_AGENT_ID; } catch { return ARES_AGENT_ID; }
  });
  const [agentEditor, setAgentEditor] = useState<null | { mode: "create" } | { mode: "edit"; id: string }>(null);
  // Ares is retired as a contact (owner, 2026-10-19): the sidebar is only the
  // agents you make. Older chats (never bound to an agent) stay on a shelf,
  // every one of them hand-able to an agent with its whole history.
  const [tutorialOpen, setTutorialOpen] = useState<boolean>(() => !tutorialSeen());
  // The "seen" flag lives in this webview's storage, which a new origin (dev
  // build, reinstall, browser preview) starts without — so it popped up for an
  // owner with agents already made. Having agents means you've been through it.
  useEffect(() => {
    if (agents.length > 0 && !tutorialSeen()) { markTutorialSeen(); setTutorialOpen(false); }
  }, [agents.length]);
  const [olderOpen, setOlderOpen] = useState(false);
  /** Right after the first agent is made: offer to hand it the older chats. */
  const [handOver, setHandOver] = useState<{ agentId: string } | null>(null);
  const agentsCountRef = useRef(0);
  const [agentError, setAgentError] = useState<string | undefined>();
  const [agentUnread, setAgentUnread] = useState<string[]>([]);
  /** Profile pictures by agent id (data: URLs), fetched when a version changes. */
  const [agentPhotos, setAgentPhotos] = useState<Record<string, string>>({});
  const [agentPoses, setAgentPoses] = useState<Record<string, Record<string, string>>>({});
  const [agentClips, setAgentClips] = useState<Record<string, Record<string, string>>>({});
  const agentPhotoVersions = useRef<Record<string, string>>({});
  // ─── Rooms: group chats of people + agents (rooms.tsx, daemon/rooms.ts) ──
  const [rooms, setRooms] = useState<RoomVm[]>([]);
  const [roomsMe, setRoomsMe] = useState<RoomsMeVm>({ id: "", name: "You" });
  const [roomMessages, setRoomMessages] = useState<Record<string, RoomMessageVm[]>>({});
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const activeRoomRef = useRef<string | null>(null);
  activeRoomRef.current = activeRoomId;
  const [roomUnread, setRoomUnread] = useState<string[]>([]);
  const [roomSheet, setRoomSheet] = useState<null | { kind: "create" } | { kind: "join"; busy?: boolean } | { kind: "invite"; roomId: string; link?: string; busy?: boolean }>(null);
  const [roomError, setRoomError] = useState<string | undefined>();
  const roomMessagesRef = useRef(roomMessages);
  roomMessagesRef.current = roomMessages;
  // ─── People: the directory (people.tsx, daemon/directory.ts) ─────────────
  const [directory, setDirectory] = useState<DirectoryVm>({ url: "", shownAgents: [], connected: false, online: false, inbox: [] });
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [peopleResults, setPeopleResults] = useState<DirectoryProfileVm[]>([]);
  const [peopleSearching, setPeopleSearching] = useState(false);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [peopleError, setPeopleError] = useState<string | undefined>();
  const peopleSearchSeq = useRef(0);
  /** An invite the owner accepted: the join sheet opens prefilled with its link. */
  const [acceptingInvite, setAcceptingInvite] = useState<DirectoryInviteVm | null>(null);
  /** Every seat session (an agent's private thread for a room): hidden from the chat lists. */
  const roomSeatIds = useMemo(() => new Set(rooms.flatMap((r) => [...Object.values(r.threads), ...Object.values(r.workThreads ?? {})])), [rooms]);
  // ─── Workspaces: the owner's VPS boxes (workspacesPane.tsx) ───────────────
  const [workspaces, setWorkspaces] = useState<WorkspaceVm[]>([]);
  const [workspaceBusy, setWorkspaceBusy] = useState<Record<string, string>>({});
  const [workspaceError, setWorkspaceError] = useState<string | undefined>();
  const [jobs, setJobs] = useState<JobVm[]>([]);
  const [jobError, setJobError] = useState<string | undefined>();
  const [sharing, setSharing] = useState<SharingVm>({ settings: { give: false, take: false }, inbox: [] });
  const [shareError, setShareError] = useState<string | undefined>();
  const [profileView, setProfileView] = useState<{ username: string; user: DirectoryProfileVm | null; loading: boolean; error?: string } | null>(null);
  const openProfile = (username: string) => {
    const known = peopleResults.find((p) => p.username === username) ?? null;
    setProfileView({ username, user: known, loading: true });
    daemonCmd({ type: "directory_user", name: username });
  };
  /** roomId → who on the OTHER machines is working right now. */
  const [roomPresence, setRoomPresence] = useState<Record<string, Array<{ key: string; name: string; activity: string }>>>({});
  /** Each agent's own memories, loaded when its profile opens. */
  const [agentMemory, setAgentMemory] = useState<Record<string, AgentMemoryVm>>({});
  /** A photo picked in the New agent sheet, uploaded once the agent exists. */
  const pendingAgentPhoto = useRef<string | null>(null);
  /** Chats handed to an agent before the daemon's agents_list echo lands. */
  const [localAgentBindings, setLocalAgentBindings] = useState<Record<string, string>>({});
  /** sessionId → agent id, for every chat that belongs to a named agent. */
  const sessionAgentMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) for (const t of a.threads ?? []) map[t] = a.id;
    for (const [sid, id] of Object.entries(localAgentBindings)) {
      if (id === ARES_AGENT_ID) delete map[sid];
      else map[sid] = id;
    }
    return map;
  }, [agents, localAgentBindings]);
  /** For send(): may this chat talk at all (an agent's chat or a room seat)? */
  const chatHasAgentRef = useRef<(sessionId: string) => boolean>(() => true);
  chatHasAgentRef.current = (sessionId) => Boolean(sessionAgentMap[sessionId]) || roomSeatIds.has(sessionId);
  rememberAgentFaces(agents);
  useEffect(() => {
    if (agents.length === 0) return;
    if (selectedAgentId === ARES_AGENT_ID || !agents.some((a) => a.id === selectedAgentId)) {
      const first = agents[0]!.id;
      selectedAgentRef.current = first;
      setSelectedAgentIdState(first);
    }
  }, [agents, selectedAgentId]);
  const agentIdOf = (sessionId: string | undefined): string => (sessionId ? sessionAgentMap[sessionId] : undefined) ?? ARES_AGENT_ID;
  const [activeId, setActiveId] = useState<string>("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("model");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [pluginsVm, setPluginsVm] = useState<PluginsVm | null>(null);
  const [mindVm, setMindVm] = useState<MindOverviewVm | null>(null);
  const [roster, setRoster] = useState<PersonaVm[]>(() => (native ? [] : demoRoster()));
  const [cognitive, setCognitive] = useState<CognitiveStateVm | null>(() => (native ? null : demoCognitive()));
  const [activePersona, setActivePersona] = useState<PersonaVm | null>(null);
  // The voice layer above Ares's craft doctrine. Echoed back by the daemon
  // as persona_style_set so a change made elsewhere still lands here.
  const [personaStyle, setPersonaStyle] = useState<string>("ares");
  // Which HELM tab is showing. Lifted out of HelmView so the status bar's
  // persona chip can jump straight to the gallery.
  const [helmTab, setHelmTab] = useState<"overview" | "agents" | "fleets" | "mind">("overview");
  const [personaSuggestion, setPersonaSuggestion] = useState<{ persona: PersonaVm; matched: string[] } | null>(null);
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [consciousness, setConsciousness] = useState<ConsciousnessVm>({
    enabled: false,
    downloading: false,
    ready: false,
    watching: false,
    paused: false,
    engineInstalled: false,
    engineAvailable: false,
    models: [],
    progress: {},
  });
  const [aresNetwork, setAresNetwork] = useState<AresNetworkVm>({ configured: false, enabled: false, connected: false, busy: false, url: "", libFound: false });
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});
  const [ollamaUsage, setOllamaUsage] = useState<OllamaUsageState | null>(null);
  const [aresPointMaps, setAresPointMaps] = useState<PointMapSpec[]>([]);
  const allPointMaps = useMemo(() => {
    const seen = new Set<string>();
    const out: PointMapSpec[] = [];
    for (const m of [...BUILTIN_POINT_MAPS, ...(prefs.pointMaps ?? []), ...aresPointMaps]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  }, [prefs.pointMaps, aresPointMaps]);
  const activePointMap = allPointMaps.find((m) => m.id === prefs.pointMap) ?? BUILTIN_POINT_MAPS[0];
  const [providerUsage, setProviderUsage] = useState<{ providers: ProviderUsageView[]; errors: Record<string, string>; at: number } | null>(null);
  const [contextPopOpen, setContextPopOpen] = useState(false);
  const [permissions, setPermissions] = useState<PermSettings>(DEFAULT_PERMS);
  const pushNotice = (text: string, tone: "dim" | "warn" | "bad" = "dim") => {
    setSessions((prev) => prev.map((sess, i) => (sess.id === activeRef.current || (!activeRef.current && i === 0)
      ? { ...sess, items: [...sess.items, { kind: "notice" as const, key: `notice_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`, text, tone }] }
      : sess)));
  };
  const [recoveryMode, setRecoveryMode] = useState<{ mode: "ask" | "auto" | "never"; pinnedByEnv: boolean }>({ mode: "ask", pinnedByEnv: false });
  const [opStatus, setOpStatus] = useState<{ activeCount: number; goals: Array<{ id: string; statement: string; status: string; progress: number }>; autotick: boolean; trust?: Array<{ domain: string; level: number; proven: number }> } | null>(null);
  // Operator halt state. Optimistic on click; an operator_status frame that
  // carries `halted` is authoritative and overwrites the guess on the next poll.
  const [opHalted, setOpHalted] = useState(false);
  /** Where Ares may work: "host" (default) or "sandbox" (its own machine only).
   *  Seeded from the daemon's computer_status so the chip never lies after a
   *  relaunch. */
  const [computerMode, setComputerMode] = useState<"host" | "sandbox">("host");
  // HELM → Fleets: fleet history + background Task subagents, fed by the
  // fleets_list / subagents_list reply events on the 5s helm poll.
  const [fleetHistory, setFleetHistory] = useState<FleetSummaryWire[]>([]);
  const [subagentJobs, setSubagentJobs] = useState<SubagentJobWire[]>([]);
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderVm[]>([]);
  // Ares Gateway account (doingteam.com): live snapshot + grant toasts.
  const [gatewayAccount, setGatewayAccount] = useState<GatewayAccountVm | null>(null);
  const [gatewayToasts, setGatewayToasts] = useState<Array<{ id: number; text: string }>>([]);
  const gwToastId = useRef(0);
  const pushGatewayToast = useCallback((text: string) => {
    const id = ++gwToastId.current;
    setGatewayToasts((t) => [...t, { id, text }]);
    setTimeout(() => setGatewayToasts((t) => t.filter((x) => x.id !== id)), 6500);
  }, []);
  // (the old strikeFlash counter is gone — a full-screen flash per agent
  // action was a photosensitive hazard; see the Effects overhaul)
  // The embedded live browser: latest JPEG frame Ares streamed while driving its
  // own browser (cursor, clicks, navigation) — shown in the Forge "Live" tab.
  const [liveBrowser, setLiveBrowser] = useState<{ frame: string; at: number } | null>(null);
  const [liveTarget, setLiveTarget] = useState<{ url: string; title: string; at: number; driven?: boolean } | null>(null);
  // What the previewed page said on load: console errors and, when Ares served
  // a project folder for it, which folder. A grey canvas with no words is how
  // "open it in the Forge" read as broken (2026-10-15) — the errors belong on
  // the stage, not only in the model's tool result.
  const [liveConsole, setLiveConsole] = useState<{ url: string; errors: string[]; served: { root: string; origin: string } | null; at: number } | null>(null);
  // The folder Ares is serving into the Live tab, readable from the event
  // ingest closure. When a tool touches a file under it, the iframe reloads
  // on its own — the owner should never have to press ↻ to see an edit.
  const servedRootRef = useRef<string | null>(null);
  const liveRefreshTimer = useRef<number | null>(null);
  /** Last time Ares used the Browser (it drives the Forge page). */
  const forgeDrivenAt = useRef(0);
  /** An edit was held back from reloading the Forge mid-turn. */
  const forgeReloadPending = useRef(false);
  // The Forge sensor: what the served page reports while the owner tests it
  // (frame rate, exceptions, failed loads, console errors/warnings). Rendered
  // as the HUD pills over the Live tab; the daemon also hands it to Ares.
  const [forgeTelemetry, setForgeTelemetry] = useState<{
    url: string; root: string; at: number; fps: number | null; longestMs: number; loadMs: number | null;
    errors: string[]; warnings: string[]; errorCount: number; warningCount: number; lowFps: boolean;
  } | null>(null);
  const [forgeDrawer, setForgeDrawer] = useState<"errors" | "warnings" | null>(null);
  // 2-bit pixel resolves: one run per open (panel), one per page landing
  // (stage). Closing runs the reverse before the panel unmounts.
  const [forgePixelKey, setForgePixelKey] = useState(0);
  const [forgeClosing, setForgeClosing] = useState(false);
  const [stageRevealKey, setStageRevealKey] = useState(0);
  // Frame-rate history for the HUD sparkline and the last few stage events
  // for the ticker line — both reset when a new page lands.
  const [fpsHistory, setFpsHistory] = useState<number[]>([]);
  const [forgeLog, setForgeLog] = useState<Array<{ at: number; text: string; tone: "info" | "good" | "warn" | "error" }>>([]);
  const logForge = useCallback((text: string, tone: "info" | "good" | "warn" | "error" = "info") => {
    setForgeLog((l) => [...l.slice(-7), { at: Date.now(), text, tone }]);
  }, []);
  // Markdown artifacts render as documents in the Artifacts tab.
  const [forgeDoc, setForgeDoc] = useState<{ path: string; html: string } | null>(null);
  const [artifactRevealKey, setArtifactRevealKey] = useState(0);
  // Two Forge modes. "explain": Ares generated what is on the stage (a kit
  // explainer) — the panel goes warm/gold and bursts; "project": a real app,
  // site or file — blue. The daemon says which with each target; the flip
  // itself is a full pixel resolve.
  const [forgeMode, setForgeMode] = useState<"project" | "explain">("project");
  const forgeModeRef = useRef(forgeMode);
  useEffect(() => {
    if (forgeModeRef.current !== forgeMode) {
      forgeModeRef.current = forgeMode;
      setForgePixelKey((k) => k + 1);
    }
  }, [forgeMode]);
  // Iframe lifecycle: true from the moment a target/revision is set until the
  // page's load event (or 8s), so the stage shows Ares forging instead of a
  // white rectangle.
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveLoadedAt, setLiveLoadedAt] = useState<number | null>(null);
  const [hudNow, setHudNow] = useState(() => Date.now());
  // A non-browser live source (a Godot game/editor Ares is driving). Frames
  // land in liveBrowser like the screencast; this carries what it is, whether
  // the daemon is still polling it between turns, and whether it takes input.
  const [liveFeed, setLiveFeed] = useState<LiveFeedState | null>(null);
  const [liveInteract, setLiveInteract] = useState(false);
  const [liveMouseLook, setLiveMouseLook] = useState(false);
  // The REAL engine window re-parented into the Ares window over the live
  // stage (Windows). While embedded, frames are not painted — the owner sees
  // and uses the engine itself; the stage element only reserves the space.
  const [liveEmbed, setLiveEmbed] = useState<{ hwnd: number; title: string; side: string } | null>(null);
  const [liveEmbedError, setLiveEmbedError] = useState<string | null>(null);
  const liveStageRef = useRef<HTMLDivElement | null>(null);
  const liveEmbedRef = useRef<{ hwnd: number } | null>(null);
  const liveInputQueue = useRef<LiveInputEvent[]>([]);
  const liveInputTimer = useRef<number | null>(null);
  const liveHeldKeys = useRef<Set<string>>(new Set());
  const [liveUrl, setLiveUrl] = useState("http://127.0.0.1:3000");
  const [liveRevision, setLiveRevision] = useState(0);
  // A reload is a fresh page: the last load's errors no longer apply.
  useEffect(() => {
    setForgeTelemetry((t) => (t && t.errors.length ? { ...t, errors: [], errorCount: 0 } : t));
  }, [liveRevision]);
  // The INTERACTIVE embedded browser — Ares drives its own self-contained HTML
  // apps/games in-window (same-origin), no Playwright. Driven via webview_cmd.
  const embeddedRef = useRef<EmbeddedBrowserHandle>(null);
  const [embeddedActive, setEmbeddedActive] = useState(false);
  // Live explain: model/story blocks build in the Forge while Ares is still writing the call.
  const liveExplain = useMemo(() => createLiveExplain({
    host: () => embeddedRef.current,
    show: () => { setEmbeddedActive(true); setForge((f) => ({ ...f, open: true, tab: "live" })); setForgeMode("explain"); },
  }), []);
  const [embeddedActivity, setEmbeddedActivity] = useState("");
  const [forge, setForge] = useState<ForgeState>({ open: false, tab: "live" });
  // Live tab lifecycle: the stage shows Ares forging from the moment a target
  // or revision changes until the page's load event (8s fallback), and the
  // HUD clock ticks only while the Live tab is showing something.
  useEffect(() => {
    if (!liveTarget) { setLiveLoading(false); return; }
    setLiveLoading(true);
    const fallback = window.setTimeout(() => setLiveLoading(false), 8000);
    return () => window.clearTimeout(fallback);
    // Keyed on the URL, not the target object: Ares re-announces the same page
    // after every action, which doesn't reload it — so no load event ever came
    // to lift the cover and the Forge sat blank for 8s after each move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTarget?.url, liveRevision]);
  useEffect(() => {
    if (!forge.open || forge.tab !== "live" || !liveTarget) return;
    const timer = window.setInterval(() => setHudNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [forge.open, forge.tab, liveTarget]);
  // Every open is a resolve: the pixel run keys off the open edge.
  useEffect(() => {
    if (forge.open) { setForgeClosing(false); setForgePixelKey((k) => k + 1); }
  }, [forge.open]);
  const requestForgeClose = useCallback(() => {
    if (forgeClosing) return;
    setForgeClosing(true);
    // the "out" run (reverse resolve) takes ~480ms; unmount right after
    window.setTimeout(() => { setForge((f) => ({ ...f, open: false })); setForgeClosing(false); }, 500);
  }, [forgeClosing]);
  const [forgeWidth, setForgeWidth] = useState(() => Math.min(560, Math.round(window.innerWidth * 0.36)));
  // True only during an active grip drag — flips off the 280ms grid transition
  // so the panel tracks the pointer 1:1 instead of rubber-banding behind it.
  const [forgeDragging, setForgeDragging] = useState(false);
  // The forge must never crush the chat below a usable width. This is the max
  // forge width the CURRENT window allows (rail 264 + a min chat of 360).
  const maxForgeFor = (winW: number) => Math.max(300, winW - 264 - 360);
  // Re-clamp the forge as the window shrinks — without this the forge kept its
  // px width while the window narrowed, overflowing the grid and clipping the
  // right half of the UI (the "UI gets cut off when smaller" bug).
  useEffect(() => {
    const onResize = () => setForgeWidth((w) => Math.min(w, maxForgeFor(window.innerWidth)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Buffers only the active session's assistant text, then flushes natural
  // phrases to TTS while tokens stream. A ref avoids chat-wide re-renders.
  const spokenBuf = useRef("");
  const spokenFlushTimer = useRef<number | null>(null);
  // How many chunks we've spoken this turn — the first fires small (fast start),
  // the rest batch larger to cut provider round-trips (the delay lever).
  const spokenChunkCount = useRef(0);
  const [view, setView] = useState<"chat" | "artifacts" | "helm" | "aresos" | "feed" | "now">("chat");
  // AresOS: devices connected through the remote-PC agent, and the pending
  // connect link. Populated by the daemon's remote_pcs / remote_pc_link events.
  const [remotePcs, setRemotePcs] = useState<RemotePcRow[]>([]);
  const [remoteLink, setRemoteLink] = useState<{ url: string; scope: string; label: string } | null>(null);
  // Permanent pairing is a SEPARATE flow from the one-time help link above:
  // its own link (with a permanence warning) and the list of devices already
  // paired to this machine.
  const [remotePairLink, setRemotePairLink] = useState<{ url: string; scope: string; label: string; warning: string } | null>(null);
  const [phonePair, setPhonePair] = useState<PhonePairState>({ status: "idle" });
  const [remoteDevices, setRemoteDevices] = useState<PairedDeviceRow[]>([]);
  const [remoteScope, setRemoteScope] = useState<"public" | "lan" | "unknown">("unknown");
  // pcId → live screen preview state (image data URL, error, or loading).
  const [remoteShots, setRemoteShots] = useState<Record<string, { data?: string; error?: string; loading?: boolean }>>({});
  const [sessionQuery, setSessionQuery] = useState("");
  const [garrisonOpen, setGarrisonOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The last text the owner highlighted in the page (not in an input). Opening
  // the palette moves focus into its search box, which clears the selection,
  // so "Remember selection" reads this instead.
  const lastSelectionRef = useRef<{ text: string; at: number } | null>(null);
  useEffect(() => {
    const onSelection = () => {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      const text = window.getSelection()?.toString().trim() ?? "";
      if (text) lastSelectionRef.current = { text, at: Date.now() };
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);
  const [modelPopOpen, setModelPopOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [cronOpen, setCronOpen] = useState(false);
  // Bug report: opt-in upload of the full session transcript to the gateway.
  const [reportOpen, setReportOpen] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  // Connector Directory (/mcp): remote MCP servers connected via OAuth.
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [mcpConnectors, setMcpConnectors] = useState<McpConnectorVm[]>([]);
  const [mcpTools, setMcpTools] = useState<Record<string, McpToolsVm>>({});
  /** Ollama library downloads in flight: model → progress (done/error terminal). */
  const [ollamaPulls, setOllamaPulls] = useState<Record<string, { pct: number | null; status: string; done?: boolean; error?: string }>>({});
  /** MCP registry search results for the /mcp explorer. */
  const [mcpSearch, setMcpSearch] = useState<{ text: string; searching: boolean; results: McpRegistryResult[] }>({ text: "", searching: false, results: [] });
  const [mcpConnecting, setMcpConnecting] = useState<string | null>(null);
  const [mcpCatalog, setMcpCatalog] = useState<{ catalog: McpCatalogVm[]; categories: Array<{ id: string; label: string }> }>({ catalog: [], categories: [] });
  const [mcpServers, setMcpServers] = useState<McpServerStatusVm[]>([]);
  const [mcpProbe, setMcpProbe] = useState<{ url: string; auth?: string; registration?: boolean; transport?: string; note?: string } | null>(null);
  const [mcpRegistryCursor, setMcpRegistryCursor] = useState<string | null>(null);
  const [directoryPrefill, setDirectoryPrefill] = useState<{ url: string; name: string } | null>(null);
  // Floating-pill mode: shrink the window to an always-on-top mic bar.
  const [pill, setPill] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => window.localStorage.getItem("ares.rail.collapsed") === "1");
  const prePillGeom = useRef<{ size: PhysicalSize; pos: PhysicalPosition } | null>(null);
  // `browser` tracks whether the handoff actually happened. It is not cosmetic:
  // when opening the browser fails (headless session, no xdg-open) the user is
  // waiting on a page that never appeared, and the only useful recovery is the
  // URL itself.
  const [anthropicAuth, setAnthropicAuth] = useState<{ open: boolean; status: "idle" | "opening" | "waiting" | "done" | "error"; error?: string; browser?: "opening" | "opened" | "failed"; url?: string }>({ open: false, status: "idle" });
  // ChatGPT (OpenAI) OAuth — routes GPT usage through the user's ChatGPT
  // subscription via the Codex backend; no API key.
  const [openaiAuth, setOpenaiAuth] = useState<{ signingIn: boolean; connected: boolean; email: string | null; plan: string | null }>({ signingIn: false, connected: false, email: null, plan: null });
  const [kimiAuth, setKimiAuth] = useState<{ signingIn: boolean; connected: boolean; detail: string | null }>({ signingIn: false, connected: false, detail: null });
  const oauthCtx = useRef<{ verifier: string; state: string }>({ verifier: "", state: "" });
  const [logLines, setLogLines] = useState<string[]>([]);
  const [bootGone, setBootGone] = useState(false);
  // Universal splash dismiss — covers the web/demo build too (the native daemon
  // connect path also clears it; whichever fires first wins, both idempotent).
  useEffect(() => {
    const t = window.setTimeout(() => setBootGone(true), 2150);
    return () => window.clearTimeout(t);
  }, []);
  const lastSeq = useRef(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef("");
  const selectedAgentRef = useRef(selectedAgentId);
  selectedAgentRef.current = selectedAgentId;
  /** An agent just created from the sheet: open a chat with them once it lands. */
  const pendingAgentChat = useRef<string | null>(null);
  const sessionsRef = useRef(sessions);
  /** Synchronous click-to-ack gate. React state may not re-render between a
   * Stop click and an immediate Enter keypress, so this closes that tiny race. */
  const stoppingSessionsRef = useRef(new Set<string>());
  /** Titles as they were before an in-flight rename, so a failed persist can
   * revert the optimistic update instead of lying until the next restart.
   * `pending` counts unacknowledged renames: an ack only clears the stash
   * when it settles the LAST one, so a rapid A→B→C where B succeeds and C
   * fails still reverts to something real. */
  const pendingRenamesRef = useRef(new Map<string, { title: string; pending: number }>());
  const rosterRef = useRef<PersonaVm[]>([]);
  // While the experimental Living Surface owns this session it owns narration
  // too. The hidden Classic window must not read the JSON patch stream aloud.
  const livingSessionRef = useRef<string | null>(null);
  // The daemon's bootstrap conversation is stable even while the owner opens
  // and focuses other cards. Untagged legacy events belong here, never to the
  // card that happens to be active when they arrive.
  const primarySessionRef = useRef(sessions[0]?.id ?? "");
  const prefsRef = useRef(prefs);
  const restartAttempts = useRef(0);
  const pendingGoal = useRef<{
    goal: string;
    sessionId: string;
    voice?: boolean;
    inputId: string;
    draftText: string;
    images?: string[];
  } | null>(null);
  /** Synchronous fence for approval clicks. React commits the visual
   * `submitting` lock immediately after the event; this closes the smaller
   * same-tick window before that commit for every approval-card variant. */
  const permissionSubmissionLocks = useRef<Set<string>>(new Set());
  /** IDs submitted to the current daemon process. A new process clears this,
   * allowing unresolved steer bubbles to replay once with their original ID. */
  const steerReplayEpoch = useRef(createSteerReplayEpoch());
  const stderrTail = useRef<string[]>([]);
  /** Background jobs per session id — what's running right now, and what was
   *  suspended when a Stop or an app close took the host away. */
  const [bgJobs, setBgJobs] = useState<Record<string, BackgroundJobVm[]>>({});
  prefsRef.current = prefs;

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  sessionsRef.current = sessions;
  activeRef.current = active?.id ?? "";
  rosterRef.current = roster;

  const apply = useCallback((fn: (s: SessionVm) => SessionVm) => {
    setSessions((prev) => prev.map((s) => (s.id === activeRef.current || (!activeRef.current && s === prev[0]) ? fn(s) : s)));
  }, []);

  /** Apply an update to a SPECIFIC session by id — used to route daemon events
   *  to the right chat, so concurrent sessions never bleed into each other. */
  const applyTo = useCallback((sessionId: string, fn: (s: SessionVm) => SessionVm) => {
    setSessions((prev) => {
      const hit = prev.some((s) => s.id === sessionId);
      if (!hit) {
        // A background session may emit before sessions_list hydrates its rail
        // row. Adopt it as its own card; routing an unknown id into the focused
        // card is the exact cross-session bleed this registry exists to prevent.
        const adopted = fn({ ...freshSession(), id: sessionId, title: "Background session", background: true });
        return [...prev, adopted];
      }
      return prev.map((s) => (s.id === sessionId ? fn(s) : s));
    });
  }, []);

  const pushLog = useCallback((line: string) => {
    setLogLines((prev) => [...prev.slice(-240), line]);
  }, []);

  /** Serialize the current session (turns, tool calls, failures) + the Garrison
   *  log into a plain-text report and save it — so feedback is one click + a
   *  file attach. Captures everything that broke, not just the visible chat. */
  const exportSessionLog = useCallback(async () => {
    const s = active;
    const out: string[] = [];
    out.push(`ARES SESSION LOG`);
    out.push(`exported: ${new Date().toISOString()}`);
    out.push(`provider: ${prefs.provider} · model: ${prefs.model} · routing: ${prefs.routingMode}`);
    out.push(`tokens: up ${s?.tokensIn ?? 0} / down ${s?.tokensOut ?? 0}`);
    out.push("=".repeat(64));
    for (const it of s?.items ?? []) {
      if (it.kind === "user") out.push(`\n[USER] ${it.text}`);
      else if (it.kind === "assistant") {
        const who = `ARES${it.model ? ` ${it.model}` : ""}${it.provider ? `/${it.provider}` : ""}${it.proactive ? " (proactive)" : ""}`;
        if (it.thinking) out.push(`\n[${who} · thinking] ${it.thinking}`);
        out.push(`\n[${who}] ${it.text}`);
      } else if (it.kind === "tools") {
        for (const st of it.steps) {
          const tag = st.status === "error" ? "TOOL FAILED" : "TOOL";
          out.push(`  [${tag}] ${st.name} · ${st.status}${st.durationMs ? ` · ${st.durationMs}ms` : ""}`);
          // Tool inputs/results routinely carry API keys pasted into a prompt or
          // echoed back from a provider error — scrub before this leaves the app
          // as an exported file the owner might paste into a bug report.
          if (st.inputJson) out.push(`      input: ${redactSecrets(st.inputJson)}`);
          if (st.detail) out.push(`      ${st.status === "error" ? "error" : "result"}: ${redactSecrets(st.detail)}`);
        }
      } else if (it.kind === "diff") out.push(`  [DIFF] ${(it.files ?? []).join(", ")}`);
      else if (it.kind === "subagent") out.push(`  [SUBAGENT] ${it.name} · ${it.status}${it.summary ? ` — ${it.summary}` : ""}`);
    }
    out.push("\n" + "=".repeat(64));
    out.push("GARRISON LOG (last 240 lines — includes provider switches, errors):");
    out.push(...logLines);
    const content = out.join("\n");
    if (native) {
      // Feedback must be VISIBLE: both outcomes used to go only to the
      // Garrison log, so a user who pressed ⤓ and saw nothing happen read the
      // button as broken even when it worked (field report, 2026-08-06).
      try {
        const path = await invoke<string>("ares_export_log", { content });
        pushLog(`[export] session log saved → ${path}`);
        pushGatewayToast(`⤓ Session log saved to ${path}`);
      } catch (err) {
        pushLog(`[export] failed: ${String(err)}`);
        // A giant transcript can choke the IPC hop — retry once with the tail,
        // which is where whatever prompted the export almost always lives.
        const TAIL = 4 * 1024 * 1024;
        if (content.length > TAIL) {
          try {
            const clipped = `[export truncated: first ${content.length - TAIL} chars omitted after a full-size save failed]\n` + content.slice(-TAIL);
            const path = await invoke<string>("ares_export_log", { content: clipped });
            pushGatewayToast(`⤓ Session log saved to ${path} (truncated — the full transcript was too large to export)`);
            return;
          } catch {
            // fall through to the failure toast
          }
        }
        pushGatewayToast(`Export failed: ${String(err)}`);
      }
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
      a.download = `ares-session-${Date.now()}.txt`;
      a.click();
    }
  }, [active, logLines, prefs, native, pushLog, pushGatewayToast]);

  /** Send a control command to the daemon (sessions_list, skills_list, etc.). */
  const daemonCmd = useCallback(
    (command: Record<string, unknown>) => {
      if (!native) return;
      void invoke("ares_daemon_command", { command }).catch(() => null);
    },
    [native],
  );
  /** The phone API from the desktop (Feed, Now): one relayed request, one
   *  gateway_response matched by requestId. */
  const gatewayWaiters = useRef(new Map<string, (r: { status: number; data: unknown }) => void>());
  const gatewayFetch = useCallback((method: "GET" | "POST" | "PUT", path: string, body?: unknown) => new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    if (!native) { reject(new Error("no gateway in the browser demo")); return; }
    const requestId = `gw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => { gatewayWaiters.current.delete(requestId); reject(new Error("the gateway did not answer")); }, 50_000);
    gatewayWaiters.current.set(requestId, (r) => { clearTimeout(timer); resolve(r); });
    void invoke("ares_daemon_command", { command: { type: "gateway_request", requestId, method, path, ...(body !== undefined ? { body } : {}) } }).catch((e) => { clearTimeout(timer); gatewayWaiters.current.delete(requestId); reject(e); });
  }), [native]);

  // Owner input into the live game: batched per animation frame so a mouse
  // drag does not become a hundred daemon commands.
  const sendLiveInput = useCallback((events: LiveInputEvent[]) => {
    liveInputQueue.current.push(...events);
    if (liveInputTimer.current !== null) return;
    liveInputTimer.current = window.setTimeout(() => {
      liveInputTimer.current = null;
      const batch = liveInputQueue.current.splice(0, 64);
      if (batch.length) daemonCmd({ type: "live_input", events: batch });
    }, 16);
  }, [daemonCmd]);

  const releaseLiveKeys = useCallback(() => {
    const held = [...liveHeldKeys.current];
    liveHeldKeys.current.clear();
    if (held.length) sendLiveInput(held.map((key) => ({ kind: "key" as const, key, pressed: false })));
  }, [sendLiveInput]);

  // Embed the real engine window over the live stage (Windows). The provider
  // told us the pid / window title; the shell re-parents that HWND into ours.
  const embedLiveWindow = useCallback(async () => {
    const el = liveStageRef.current;
    if (!native || !el || !liveFeed) return;
    setLiveEmbedError(null);
    const rect = physicalRect(el);
    try {
      const info = await invoke<{ hwnd: number; title: string }>("ares_embed_window", { pid: liveFeed.pid ?? null, title: liveFeed.windowTitle ?? null, ...rect });
      liveEmbedRef.current = { hwnd: info.hwnd };
      setLiveEmbed({ hwnd: info.hwnd, title: info.title, side: liveFeed.side });
      setLiveInteract(false);
      releaseLiveKeys();
      // The engine is on screen for real now; stop pulling frames for it.
      if (liveFeed.watching) daemonCmd({ type: "live_unwatch" });
    } catch (err) {
      setLiveEmbedError(err instanceof Error ? err.message : String(err));
    }
  }, [native, liveFeed, daemonCmd, releaseLiveKeys]);

  const releaseLiveWindow = useCallback(() => {
    const current = liveEmbedRef.current;
    liveEmbedRef.current = null;
    setLiveEmbed(null);
    if (native && current) void invoke("ares_embed_release", { hwnd: current.hwnd }).catch(() => null);
  }, [native]);

  // Keep the embedded window glued to the stage: follow layout changes, hide
  // it when the Forge/live tab is not showing, and release it on unmount.
  useEffect(() => {
    if (!native || !liveEmbed) return;
    const visible = forge.open && forge.tab === "live";
    const place = () => {
      const el = liveStageRef.current;
      const current = liveEmbedRef.current;
      if (!current) return;
      if (!visible || !el) { void invoke("ares_embed_place", { hwnd: current.hwnd, x: 0, y: 0, w: 1, h: 1, visible: false }).catch(() => null); return; }
      const rect = physicalRect(el);
      void invoke<boolean>("ares_embed_place", { hwnd: current.hwnd, ...rect, visible: true }).then((still) => { if (still === false) { liveEmbedRef.current = null; setLiveEmbed(null); } }).catch(() => null);
    };
    place();
    const el = liveStageRef.current;
    const ro = el ? new ResizeObserver(() => place()) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", place);
    const poll = window.setInterval(place, 1000); // sidebar/rail animations move the stage without resizing the window
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
      window.clearInterval(poll);
    };
  }, [native, liveEmbed, forge.open, forge.tab, forgeWidth]);

  useEffect(() => () => { const current = liveEmbedRef.current; if (native && current) void invoke("ares_embed_release", { hwnd: current.hwnd }).catch(() => null); }, [native]);

  // Slash-command palette for the composer: typing "/" surfaces these, Enter
  // runs them. The composer stays dumb — it just renders and fires `run`.
  const slashActions = useMemo<SlashAction[]>(
    () => [
      { id: "mcp", icon: "🔌", label: "Connectors", hint: "Open the MCP explorer — connect, toggle & inspect tools", run: () => { setDirectoryOpen(true); daemonCmd({ type: "mcp_list" }); } },
      { id: "model", icon: "🧠", label: "Models", hint: "Open the model discovery panel", run: () => setModelPopOpen(true) },
      { id: "helm", icon: "🛡️", label: "HELM", hint: "Open the war room — missions, usage, autonomy", run: () => setView("helm") },
      { id: "settings", icon: "⚙️", label: "Settings", hint: "Open settings", run: () => setSettingsOpen(true) },
      { id: "bug", icon: "🐛", label: "Report a bug", hint: "Send a bug report with this session's log", run: () => setReportOpen(true) },
      { id: "export", icon: "⤓", label: "Download chat", hint: "Save this session (chat + tool calls + errors) as a text file", run: () => void exportSessionLog() },
    ],
    [daemonCmd, exportSessionLog],
  );

  // Promise-correlated skill invocation: send skill_invoke with a unique id and
  // resolve when the matching skill_result comes back. Powers TTS-provider
  // skills (op:"tts") and tray surface-button clicks over one channel.
  const skillInvokePending = useRef(new Map<string, { resolve: (r: { ok: boolean; result?: unknown; error?: string }) => void; timer: number }>());
  const skillInvoke = useCallback(
    (name: string, input: unknown, timeoutMs = 60_000): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
      if (!native) return Promise.resolve({ ok: false, error: "no daemon attached" });
      const invokeId = `si_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          skillInvokePending.current.delete(invokeId);
          resolve({ ok: false, error: "skill timed out" });
        }, timeoutMs);
        skillInvokePending.current.set(invokeId, { resolve, timer });
        daemonCmd({ type: "skill_invoke", name, input, invokeId });
      });
    },
    [native, daemonCmd],
  );

  // ── Voice bus ──────────────────────────────────────────────────────────
  // A toggled-on `provides:tts` skill overrides the built-in sidecar voice —
  // Ares speaks through whatever engine the user installed (Piper, ElevenLabs…).
  const ttsProviderSkill = skills.find((s) => s.enabled && (s.provides ?? []).includes("tts"));
  // Karaoke: the sentence Ares is speaking RIGHT NOW (null = quiet).
  const [nowSpeaking, setNowSpeaking] = useState<string | null>(null);
  // The active provider's own voice catalog. Needed at CALL time: the saved
  // voiceId often belongs to the PREVIOUS engine (e.g. Kokoro's "af_heart"
  // sent to a Piper skill), which made every provider call fail and silently
  // fall back to the robotic browser voice — "it's not using my skill".
  const [providerVoices, setProviderVoices] = useState<VoiceInfo[] | null>(null);
  // Throttled, not latched: the old one-shot flag surfaced only the FIRST
  // provider failure ever — every later failure fell into the robot voice
  // with zero explanation until the skill name changed.
  const providerFailAt = useRef(0);
  useEffect(() => {
    providerFailAt.current = 0;
    if (!ttsProviderSkill) { setProviderVoices(null); return; }
    let cancelled = false;
    void skillInvoke(ttsProviderSkill.name, { op: "voices" }).then((r) => {
      if (cancelled) return;
      const voices = r.ok ? (r.result as { voices?: VoiceInfo[] })?.voices : null;
      setProviderVoices(Array.isArray(voices) ? voices : []);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsProviderSkill?.name]);
  const voice = useTts({
    enabled: prefs.voiceEnabled ?? false,
    voice: prefs.voiceId ?? "",
    speed: prefs.voiceSpeed ?? 1,
    onUtterance: setNowSpeaking,
    provider: ttsProviderSkill
      ? (text, v, speed) => {
          // Only pass a voice the provider actually KNOWS; otherwise send ""
          // so the skill uses its own default instead of erroring out.
          const known = providerVoices;
          const voiceForSkill = known && known.length > 0 ? (known.some((k) => k.id === v) ? v : "") : v;
          return skillInvoke(ttsProviderSkill.name, { op: "tts", text, voice: voiceForSkill, speed }).then((r) => {
            if (!r.ok) {
              // Never fail silently into the robot voice — say why (at most
              // once per 30s so a broken skill doesn't spam toasts).
              const now = Date.now();
              if (now - providerFailAt.current > 30_000) {
                providerFailAt.current = now;
                setSkillToast({ name: ttsProviderSkill.name, text: `Voice skill ${ttsProviderSkill.name} failed: ${(r.error ?? "unknown error").slice(0, 120)}`, ok: false });
                window.setTimeout(() => setSkillToast(null), 5000);
              }
              // The failure may be a stale voice catalog (provider updated its
              // voices in place) — refresh it so the next call self-heals.
              void skillInvoke(ttsProviderSkill.name, { op: "voices" }).then((vr) => {
                const voices = vr.ok ? (vr.result as { voices?: VoiceInfo[] })?.voices : null;
                if (Array.isArray(voices)) setProviderVoices(voices);
              });
            }
            return r.ok ? (r.result as { audio?: string; mime?: string }) : null;
          });
        }
      : undefined,
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // ── STT provider skill (mirror of the TTS override) ──
  // A toggled-on `provides:stt` skill transcribes the composer mic's recording
  // instead of the cloud fallback: {op:"transcribe", audio,<b64>, mime} → {text}.
  const sttProviderSkill = skills.find((s) => s.enabled && (s.provides ?? []).includes("stt"));
  useEffect(() => {
    globalSttProvider.current = sttProviderSkill
      ? async (audio: string, mime: string) => {
          const r = await skillInvoke(sttProviderSkill.name, { op: "transcribe", audio, mime });
          const text = r.ok ? (r.result as { text?: string })?.text : null;
          return typeof text === "string" ? text : null;
        }
      : null;
  }, [sttProviderSkill?.name, skillInvoke]);

  const clearSpokenFlushTimer = () => {
    if (spokenFlushTimer.current !== null) {
      window.clearTimeout(spokenFlushTimer.current);
      spokenFlushTimer.current = null;
    }
  };

  const flushSpokenBuffer = (force = false, relaxed = false) => {
    if (force) clearSpokenFlushTimer();
    let guard = 0;
    while (guard < 8) {
      // First chunk of the turn fires at the small min for a fast start; every
      // chunk after batches to STREAM_SPEECH_BATCH_MIN so slow provider synths
      // run a third as often.
      const min = spokenChunkCount.current === 0 ? STREAM_SPEECH_SENTENCE_MIN : STREAM_SPEECH_BATCH_MIN;
      const { chunk, rest } = takeStreamSpeechChunk(spokenBuf.current, force, relaxed, min);
      spokenBuf.current = rest;
      if (!chunk) break;
      voiceRef.current.speak(chunk);
      spokenChunkCount.current += 1;
      guard += 1;
      if (!force && !relaxed) continue;
      if (!force) break;
    }
  };

  const scheduleSpokenFlush = () => {
    if (spokenFlushTimer.current !== null) return;
    spokenFlushTimer.current = window.setTimeout(() => {
      spokenFlushTimer.current = null;
      // Never force a phrase boundary merely because the model paused to call a
      // tool. A token such as "trouble" may still become "troubleshooting" in
      // the next model round; sentence punctuation or turn_end is the safe cut.
      flushSpokenBuffer(false, false);
    }, 700);
  };

  const appendSpokenDelta = (text: string) => {
    if (!text) return;
    spokenBuf.current += text;
    flushSpokenBuffer(false, false);
    if (spokenBuf.current.trim()) scheduleSpokenFlush();
  };

  const resetSpokenStream = () => {
    clearSpokenFlushTimer();
    spokenBuf.current = "";
    spokenChunkCount.current = 0;
  };

  // Native voice health gates every mic/wake connection. Previously the wake
  // loop retried independently while Python was down, making the button flash
  // between "starting" and "offline" every few seconds.
  const [voiceEngine, setVoiceEngine] = useState<{ phase: string; detail: string }>({ phase: "idle", detail: "" });
  useEffect(() => {
    if (!native) return;
    let alive = true;
    void invoke<{ phase: string; detail: string; token?: string; port?: number }>("ares_voice_status")
      .then((s) => {
        if (!alive) return;
        if (s?.token) setVoiceToken(s.token);
        if (s?.port) setVoiceEndpoint(s.port);
        if (s?.phase) setVoiceEngine({ phase: s.phase, detail: s.detail ?? "" });
      })
      .catch(() => { /* shell predates the command */ });
    const un = listen<{ phase: string; detail: string }>("ares:voice-status", (e) => {
      if (alive && e.payload?.phase) setVoiceEngine({ phase: e.payload.phase, detail: e.payload.detail ?? "" });
    });
    return () => { alive = false; void un.then((f) => f()); };
  }, [native]);
  const repairVoice = useCallback(() => {
    setVoiceEngine({ phase: "starting", detail: "Restarting local speech…" });
    void invoke("ares_voice_setup").catch(() => { /* ignore */ });
  }, []);

  // ── Conversation mode ─────────────────────────────────────────────────────
  // Full-duplex hands-free: after Ares finishes SPEAKING a reply, auto-open the
  // mic; the transcript is sent as the next message; a new send barges in. One
  // switch on top of the STT + TTS halves. Off by default; needs voice on.
  const [convoMode, setConvoMode] = useState(false);
  const [convoListening, setConvoListening] = useState(false);
  const convoRef = useRef<{ cancel: () => void } | null>(null);
  const sendRef = useRef<(t: string, opts?: { voice?: boolean }) => void>(() => {});
  // Voice presence: what the hands-free session is doing right now, plus the
  // last thing Ares HEARD (flashed as a caption so you know it got you right).
  const [presenceHeard, setPresenceHeard] = useState<string | null>(null);
  const presenceHeardTimer = useRef<number | null>(null);
  const flashHeard = useCallback((txt: string) => {
    setPresenceHeard(txt);
    if (presenceHeardTimer.current !== null) window.clearTimeout(presenceHeardTimer.current);
    presenceHeardTimer.current = window.setTimeout(() => setPresenceHeard(null), 3200);
  }, []);
  const activeBusy = active?.busy ?? false;
  // Mirror convoMode into a ref so async arms can re-check the CURRENT value at
  // promise-resolution time instead of the value captured when the effect ran.
  const convoModeRef = useRef(convoMode);
  convoModeRef.current = convoMode;
  // True while sidecarListen() is in flight (mic opening) but before the handle
  // exists — closes the double-arm window without putting transient state in
  // the effect's dependency array.
  const convoArmingRef = useRef(false);
  useEffect(() => {
    if (!convoMode || !prefs.voiceEnabled) return;
    // Enabling conversation mode opens the channel immediately; after every
    // reply or empty utterance it re-arms once Ares is idle.
    if (voice.speaking || convoListening || activeBusy || convoRef.current || convoArmingRef.current) return;
    // NO cleanup-cancellation here, on purpose. This effect sets convoListening
    // — one of its own dependencies — so React ALWAYS runs its cleanup right
    // after the set. The old `cancelled` flag therefore tripped on every single
    // arm: the mic-open promise resolved into the cancelled branch, skipped
    // attaching the transcript handler, and convoListening was orphaned at true
    // ("listening…" forever, mic dead). Stale arms are instead reconciled below
    // by re-checking convoModeRef when the promise resolves.
    convoArmingRef.current = true;
    setConvoListening(true);
    // AUTO listen: the sidecar's VAD ends the utterance the moment you stop
    // talking (with its own no-speech + hard caps), so the reply sends itself —
    // no fixed window, no waiting. The 30s client cap is pure belt-and-braces.
    void sidecarListen(undefined, { auto: true }).then((handle) => {
      convoArmingRef.current = false;
      if (!convoModeRef.current) {
        // Conversation was switched off while the mic was opening — walk the
        // arm back completely instead of leaving "listening" stuck on.
        void handle.cancel();
        setConvoListening(false);
        return;
      }
      convoRef.current = handle;
      const cap = window.setTimeout(() => void handle.stop(), 30_000);
      void handle.transcript.then((txt) => {
        window.clearTimeout(cap);
        convoRef.current = null;
        setConvoListening(false);
        if (txt.trim() && convoModeRef.current) {
          flashHeard(txt.trim());
          sendRef.current(txt.trim(), { voice: true });
        }
      });
    }).catch(() => {
      convoArmingRef.current = false;
      // Avoid a hot reconnect loop while the local sidecar is being repaired.
      window.setTimeout(() => setConvoListening(false), 1_500);
    });
  }, [voice.speaking, convoMode, prefs.voiceEnabled, convoListening, activeBusy, flashHeard]);

  // ── Wake word: "Hey Ares" arms the mic hands-free ─────────────────────────
  const wakeRef = useRef<WakeHandle | null>(null);
  // Wake works WITHOUT the speak-replies toggle — hearing you and speaking to
  // you are independent. (It was chained to voiceEnabled, so a reset voice
  // toggle silently killed the wake word too.)
  const wakeOn = (prefs.wakeWord ?? false) && native && voiceEngine.phase === "running";
  // Surfaced in the dock: silence was the old failure mode — you toggled "Hey
  // Ares" on, the sidecar was down, and NOTHING told you it couldn't hear.
  const [wakeStatus, setWakeStatus] = useState<"off" | "arming" | "armed" | "offline">("off");
  useEffect(() => {
    if (!wakeOn) {
      wakeRef.current?.dispose();
      wakeRef.current = null;
      setWakeStatus("off");
      return;
    }
    let disposed = false;
    let retry: number | null = null;
    const arm = () => {
      if (disposed) return;
      setWakeStatus("arming");
      wakeListen((_heard) => {
        // Woken: cut any speech and open the command mic immediately. The
        // monitor-edge pulse is the acknowledgement; a spoken "Yeah?" made us
        // wait and then risked transcribing Ares through its own speaker.
        voiceRef.current.stop();
        setConvoListening(true);
        // The wake stream closes before this event is emitted. One animation
        // frame lets picky Windows audio drivers release the device cleanly.
        window.setTimeout(() => {
          if (!wakeRef.current) { setConvoListening(false); return; }
          void sidecarListen(undefined, { auto: true }).then((handle) => {
            const cap = window.setTimeout(() => void handle.stop(), 30_000);
            void handle.transcript.then((txt) => {
              window.clearTimeout(cap);
              setConvoListening(false);
              // Symmetric to the 32ms wake→stt handoff above: give the audio
              // device a beat to release before the wake loop reopens it, or
              // picky Windows drivers fail the reopen and kill wake listening.
              window.setTimeout(() => wakeRef.current?.resume(), 120);
              if (txt.trim()) {
                flashHeard(txt.trim());
                sendRef.current(txt.trim(), { voice: true });
              }
            });
          }).catch(() => { setConvoListening(false); window.setTimeout(() => wakeRef.current?.resume(), 120); });
        }, 32);
      }, () => {
        // Sidecar died AFTER arming (crash/restart). The old code left the UI
        // claiming "· listening" forever — drop to offline and re-arm.
        if (!disposed) {
          wakeRef.current = null;
          setWakeStatus("offline");
          retry = window.setTimeout(arm, 5_000);
        }
      }).then((handle) => {
        if (disposed) { handle.dispose(); return; }
        wakeRef.current = handle;
        setWakeStatus("armed");
      }).catch(() => {
        // Sidecar down / wake engine unavailable — SHOW it, then keep retrying.
        if (!disposed) {
          setWakeStatus("offline");
          retry = window.setTimeout(arm, 30_000);
        }
      });
    };
    arm();
    return () => {
      disposed = true;
      if (retry !== null) window.clearTimeout(retry);
      wakeRef.current?.dispose();
      wakeRef.current = null;
    };
  }, [wakeOn]);
  // Leaving convo mode stops any listen in progress. Reset convoListening even
  // when no handle exists — an arm may have died between setConvoListening(true)
  // and the handle arriving, and this is the state's last line of defense.
  useEffect(() => {
    if (convoMode) return;
    if (convoRef.current) { convoRef.current.cancel(); convoRef.current = null; }
    setConvoListening(false);
  }, [convoMode]);

  // HELM live feed: while the war room is visible, re-scry on open, every 5s,
  // and on every busy flip (turn start/end) so missions, todos, and cost move
  // without touching ⟳. Gated on view so the idle app costs nothing.
  const helmBusy = Boolean(active?.busy);
  useEffect(() => {
    if (view !== "helm" || !native || daemon === "stopped" || daemon === "error") return;
    const scryCognitive = () => daemonCmd({ type: "cognitive_state", sessionId: activeRef.current });
    const scry = () => {
      daemonCmd({ type: "operator_status" });
      daemonCmd({ type: "usage_stats", days: 14 });
      // The Fleets tab's history + background agents ride the same 5s cadence
      // (cheap list reads; fetched for all tabs so the data is warm on switch).
      daemonCmd({ type: "fleets_list" });
      daemonCmd({ type: "subagents_list" });
      scryCognitive();
    };
    scry();
    // The roster changes only when someone edits it, so it rides the open/flip
    // effect rather than the 5s poll.
    daemonCmd({ type: "roster_list", sessionId: activeRef.current });
    // Cognitive state DOES move during a turn, so it joins the 5s scry.
    scryCognitive();
    const timer = window.setInterval(scry, 5_000);
    return () => window.clearInterval(timer);
  }, [view, native, daemon, helmBusy, daemonCmd]);

  // AresOS device list — poll while the tab is open so connects/disconnects show live.
  useEffect(() => {
    if (view !== "aresos" || !native || daemon === "stopped" || daemon === "error") return;
    const poll = () => { daemonCmd({ type: "remote_pcs" }); daemonCmd({ type: "remote_devices" }); };
    poll();
    const timer = window.setInterval(poll, 4_000);
    return () => window.clearInterval(timer);
  }, [view, native, daemon, daemonCmd]);

  useEffect(() => {
    if (!native || daemon !== "running") return;
    const tick = () => {
      // Keep the first unanswered ping's time so the wait accumulates.
      if (lastPongAtRef.current >= lastPingAtRef.current) lastPingAtRef.current = Date.now();
      daemonCmd({ type: "ping", nonce: String(Date.now()) });
      setHealthNow(Date.now());
    };
    tick();
    const ping = window.setInterval(tick, 10_000);
    const clock = window.setInterval(() => setHealthNow(Date.now()), 5_000);
    return () => { window.clearInterval(ping); window.clearInterval(clock); };
  }, [native, daemon, daemonCmd]);

  const restartDaemon = useCallback(
    (provider?: string, model?: string) => {
      if (!native) return;
      resetSteerReplayEpoch(steerReplayEpoch.current);
      setDaemon("starting");
      void invoke<DaemonStatus>("ares_restart_daemon", {
        provider: provider ?? prefsRef.current.provider,
        model: model ?? prefsRef.current.model,
      })
        .then((st) => setDaemon(st.running ? "running" : "stopped"))
        .catch((err) => {
          setDaemon("error");
          apply((s) => foldEvent(s, { type: "desktop_error", text: String(err) }));
        });
    },
    [native, apply],
  );

  /** Wear a persona for the active session, or null to go back to plain Ares.
   *  Adoption is per-session (the roster is global), so this always carries the
   *  session id — otherwise the daemon would swap the primary session's prompt
   *  while the owner is looking at a different tab. */
  const adoptPersona = useCallback(
    (name: string | null) => {
      if (!native) {
        // Browser preview: no daemon to swap a prompt, so reflect the choice
        // locally. The installed app takes the real path below, where the
        // daemon recomposes the system prompt and echoes persona_changed.
        setActivePersona(name ? rosterRef.current.find((p) => p.name === name) ?? null : null);
        setPersonaSuggestion(null);
        return;
      }
      daemonCmd({ type: "persona_adopt", name: name ?? "", sessionId: activeRef.current });
    },
    [native, daemonCmd],
  );

  /** Push routing + reasoning into a freshly-ready daemon, flush queued goal. */
  const onDaemonReady = useCallback((event?: AresEvent) => {
    restartAttempts.current = 0;
    setDaemon("running");
    if (!native) return;
    if (event?.sessionId) {
      const previousPrimary = primarySessionRef.current;
      primarySessionRef.current = event.sessionId;
      setSessions((prev) => {
        if (prev.some((session) => session.id === event.sessionId)) return prev;
        // Replace only the bootstrap placeholder. A newly-created empty card may
        // sit beside it while the daemon starts and must keep its own id/history.
        const emptyIndex = prev.findIndex((session) => session.id === previousPrimary);
        if (emptyIndex < 0) return prev;
        const next = [...prev];
        const oldId = next[emptyIndex].id;
        next[emptyIndex] = { ...next[emptyIndex], id: event.sessionId! };
        setActiveId((current) => (!current || current === oldId ? event.sessionId! : current));
        return next;
      });
    }
    if (event?.provider && event.model) {
      const next: Prefs = {
        ...prefsRef.current,
        provider: event.provider,
        model: event.model,
        reasoning: REASONING_LEVELS.includes(event.reasoningLevel as ReasoningLevel)
          ? (event.reasoningLevel as ReasoningLevel)
          : prefsRef.current.reasoning,
        routingMode: event.routingMode ?? prefsRef.current.routingMode,
        routing: event.routing ?? prefsRef.current.routing,
        engine: event.engine ?? prefsRef.current.engine,
      };
      prefsRef.current = next;
      setPrefs(next);
      savePrefs(next);
    }
    if (event?.keyStatus) setKeyStatus(event.keyStatus);
    if (event?.permissions) setPermissions({ ...DEFAULT_PERMS, ...event.permissions });
    void invoke("ares_set_reasoning", { level: prefsRef.current.reasoning }).catch(() => null);
    if (Object.keys(prefsRef.current.routing).length > 0) {
      void invoke("ares_set_routing", { routing: prefsRef.current.routing }).catch(() => null);
    }
    void invoke("ares_daemon_command", {
      command: { type: "routing_mode", enabled: prefsRef.current.routingMode === "auto" },
    }).catch(() => null);
    // populate the status bar's mission count + rail's disk-session log
    void invoke("ares_daemon_command", { command: { type: "operator_status" } }).catch(() => null);
    // Agents and rooms first: the daemon answers commands in order, and the
    // chat list is the slow one — the sidebar must never wait behind it.
    void invoke("ares_daemon_command", { command: { type: "agents_list" } }).catch(() => null);
    void invoke("ares_daemon_command", { command: { type: "rooms_list" } }).catch(() => null);
    void invoke("ares_daemon_command", { command: { type: "sessions_list" } }).catch(() => null);
    void invoke("ares_daemon_command", { command: { type: "directory_status" } }).catch(() => null);
    void invoke("ares_daemon_command", { command: { type: "workspaces_list" } }).catch(() => null);
    void invoke("ares_daemon_command", { command: { type: "jobs_list" } }).catch(() => null);
    void invoke("ares_daemon_command", { command: { type: "agents_sharing" } }).catch(() => null);
    void invoke("ares_daemon_command", { command: { type: "agent_avatar", agentId: "ares" } }).catch(() => null);
    // The computer chip must show the REAL posture on a cold start, not the
    // "host" default it was initialised with.
    void invoke("ares_daemon_command", { command: { type: "computer_status" } }).catch(() => null);
    // Anything the last run left behind is suspended, not gone. Ask for it on
    // every daemon start so picking a session back up SHOWS the offer to resume
    // instead of the work quietly having never stopped.
    void invoke("ares_daemon_command", {
      command: { type: "background_list", sessionId: activeRef.current || undefined },
    }).catch(() => null);
    // A crash can happen after SQLite admitted a steer but before Desktop saw
    // its acknowledgement. Replay every unresolved bubble with the exact same
    // identity and payload; daemon idempotency, rather than UI guesswork, then
    // settles it. The epoch ledger absorbs duplicate ready frames from one
    // daemon process.
    const replaySteers = claimSteersForDaemonReady(sessionsRef.current, steerReplayEpoch.current);
    let replayRestarted = false;
    for (const replay of replaySteers) {
      // Close the daemon-ready/event round-trip gap locally. An unresolved
      // correction is owned work as soon as this epoch claims its exact ID, so
      // keep steer/Stop controls visible until canonical replay settles it.
      applyTo(replay.sessionId, (s) => ({
        ...s,
        busy: true,
        cancelling: false,
        activity: "recovering interrupted work",
      }));
      void invoke("ares_daemon_command", {
        command: {
          type: "steer",
          text: steerReplayWireText(replay),
          sessionId: replay.sessionId,
          inputId: replay.inputId,
        },
      }).catch((error) => {
        // Delivery is ambiguous: never restore or reject the bubble here. A
        // fresh daemon epoch will safely retry the same durable identity.
        pushLog(`[garrison] steer replay ${replay.inputId} lost transport: ${String(error)}`);
        if (!replayRestarted) {
          replayRestarted = true;
          restartDaemon();
        }
      });
    }
    const queued = pendingGoal.current;
    if (queued) {
      pendingGoal.current = null;
      void invoke("ares_send", { goal: queued.goal, sessionId: queued.sessionId, voice: queued.voice ?? false, inputId: queued.inputId }).catch((err) => {
        applyTo(queued.sessionId, (s) => ({ ...foldEvent(s, { type: "desktop_error", text: String(err) }), busy: false }));
      });
    }
  }, [native, applyTo, pushLog, restartDaemon]);

  // ── daemon boot + event ingestion (native only) ──────────────────────────
  useEffect(() => {
    if (!native) return;
    let mounted = true;
    let poller: number | null = null;
    let unlisten: (() => void) | undefined;

    // Untagged daemon events belong to the PRIMARY card (tagEmit omits the
    // sessionId for the primary session) — never whichever card the owner
    // happens to be viewing. Fall back to the active card only when no
    // primary has been established yet.
    const ownerOf = (e: { sessionId?: string }) => e.sessionId ?? (primarySessionRef.current || activeRef.current);

    const handleShellEvent = (e: AresEvent): boolean => {
      switch (e.type) {
        case "pong":
          lastPongAtRef.current = Date.now();
          setPong(e as unknown as Pong);
          return true;
        case "daemon_ready":
          lastPingAtRef.current = 0;
          lastPongAtRef.current = 0;
          pushLog(`[garrison] ready · session ${e.sessionId ?? ""}`);
          onDaemonReady(e);
          window.dispatchEvent(new CustomEvent("ares:daemon-ready"));
          return true;
        case "tool_end":
          if (e.name === "PointMap") daemonCmd({ type: "pointmaps_list" });
          return false;
        case "daemon_stderr": {
          const line = e.text ?? "";
          stderrTail.current = [...stderrTail.current.slice(-19), line];
          pushLog(`[stderr] ${line}`);
          return true;
        }
        case "daemon_stdout":
          pushLog(`[stdout] ${e.text ?? ""}`);
          return true;
        // The daemon watching its own heap. This is the warning that used to
        // not exist: the slowdown before exit 134 now has a number attached to
        // it, and the log says whether shedding idle sessions helped.
        case "daemon_memory_pressure": {
          const evicted = typeof e.evictedSessions === "number" && e.evictedSessions > 0
            ? ` · released ${e.evictedSessions} idle session${e.evictedSessions === 1 ? "" : "s"}`
            : "";
          pushLog(
            `[garrison] memory ${e.pressure ?? ""} · ${e.percent ?? "?"}% (${e.usedMb ?? "?"}/${e.limitMb ?? "?"} MB) · ` +
            `${e.residentSessions ?? "?"} sessions resident${evicted}`,
          );
          return true;
        }
        case "background_jobs": {
          const sid = ownerOf(e as { sessionId?: string });
          const jobs = Array.isArray(e.jobs) ? (e.jobs as BackgroundJobVm[]) : [];
          setBgJobs((prev) => ({ ...prev, [sid]: jobs }));
          return true;
        }
        case "background_suspended": {
          const count = Array.isArray(e.jobs) ? e.jobs.length : 0;
          if (count > 0) {
            pushLog(`[garrison] suspended ${count} background job${count === 1 ? "" : "s"} · ${e.reason ?? ""}`);
          }
          return true;
        }
        case "background_stopped":
        case "background_resumed":
          return true;
        case "session_evicted":
          pushLog(`[garrison] session released from memory (idle ${Math.round((e.idleMs ?? 0) / 1000)}s) — it reloads on next use`);
          return true;
        case "interrupt_requested":
        case "interrupt_pending":
        case "interrupt_settled":
        case "interrupt_idle":
        case "interrupted_by_user":
        case "interrupt_forced":
          pushLog(`[garrison] ${e.type}`);
          if (e.type === "interrupt_requested" || e.type === "interrupt_pending" || e.type === "interrupt_forced") {
            // forced = killed but not yet settled; the daemon's force-release
            // guarantees interrupt_settled within its grace window, which is
            // what clears the gate.
            stoppingSessionsRef.current.add(ownerOf(e));
          } else {
            stoppingSessionsRef.current.delete(ownerOf(e));
          }
          applyTo(ownerOf(e), (s) => foldEvent(s, e));
          return true;
        case "startup_recovery_preparing":
        case "startup_recovery_queued":
        case "startup_recovery_failed": {
          const recoverySession = ownerOf(e);
          pushLog(`[garrison] ${e.type}${e.inputId ? ` · ${e.inputId}` : ""}`);
          // A failed takeover is a real terminal UI boundary. In particular,
          // clear a Stop gate armed during lease wait so the composer cannot
          // remain locally blocked after the daemon has released recovery.
          if (e.type === "startup_recovery_failed") {
            stoppingSessionsRef.current.delete(recoverySession);
          }
          applyTo(recoverySession, (s) => foldEvent(s, e));
          return true;
        }
        case "workflow_mode_set": {
          // Authoritative echo from the daemon. The pill renders THIS, never an
          // optimistic local guess, so it can never show a mode the session
          // did not actually take.
          const mode = e.mode === "plan" ? "plan" : "build";
          applyTo(ownerOf(e), (s) => ({ ...s, workflowMode: mode }));
          pushLog(e.error ? `[garrison] workflow_mode rejected: ${e.error}` : `[garrison] ${mode} mode`);
          return true;
        }
        case "reasoning_set":
        case "routing_set":
        case "routing_mode_set":
        case "openrouter_key_set":
        case "provider_key_set":
        case "engine_config_set":
        case "skill_toggle_set":
          pushLog(`[garrison] ${e.type}`);
          if (e.type === "provider_key_set" && e.provider) {
            setKeyStatus((current) => ({ ...current, [e.provider!]: e.hasKey === true }));
          }
          if (e.type === "skill_toggle_set") daemonCmd({ type: "skills_list" });
          return true;
        case "model_switched":
          pushLog(`[garrison] model pinned · ${e.provider ?? ""}/${e.model ?? ""}`);
          // The pin is per-session state, not just a log line — reflect it so
          // the footer/badges agree with what the daemon will actually run.
          if (e.model) {
            applyTo(ownerOf(e), (s) => ({
              ...s,
              sessionModel: String(e.model),
              turnModel: String(e.model),
              ...(e.provider ? { turnProvider: String(e.provider) } : {}),
            }));
          }
          return true;
        case "model_switch_failed": {
          const currentProvider = String(e.currentProvider ?? prefsRef.current.provider);
          const currentModel = String(e.currentModel ?? prefsRef.current.model);
          const restored = { ...prefsRef.current, provider: currentProvider, model: currentModel };
          setPrefs(restored);
          savePrefs(restored);
          applyTo(ownerOf(e), (s) => foldEvent({
            ...s,
            turnProvider: currentProvider,
            turnModel: currentModel,
            sessionModel: currentModel,
          }, { type: "desktop_error", text: `Model selection kept on ${currentProvider}/${currentModel}: ${String(e.error ?? "provider preflight failed")}` }));
          return true;
        }
        case "anthropic_login_url": {
          // The daemon started the loopback server and handed us the URL; the
          // DESKTOP opens the browser. The code arrives automatically via the
          // redirect — but only if the browser actually came up, so the result
          // of that open is state, not a swallowed promise.
          const url = e.url ? String(e.url) : "";
          setAnthropicAuth({ open: true, status: "waiting", browser: url ? "opening" : "failed", url });
          if (url) {
            void invoke("ares_open_url", { url }).then(
              () => setAnthropicAuth((s) => (s.open ? { ...s, browser: "opened" } : s)),
              () => setAnthropicAuth((s) => (s.open ? { ...s, browser: "failed" } : s)),
            );
          }
          return true;
        }
        case "anthropic_login_done": {
          if (e.ok) {
            setAnthropicAuth({ open: true, status: "done" });
            window.setTimeout(() => {
              daemonCmd({ type: "model_switch", provider: prefsRef.current.provider, model: prefsRef.current.model, sessionId: activeRef.current });
              setAnthropicAuth({ open: false, status: "idle" });
            }, 1400);
          } else {
            setAnthropicAuth({ open: true, status: "error", error: String(e.error ?? "sign-in failed") });
          }
          return true;
        }
        case "openai_login_url": {
          // Device-code flow: open the verification URL (code pre-filled) in the
          // real browser; the daemon polls until the user approves.
          const oe = e as { url?: unknown; userCode?: unknown };
          if (oe.url) void invoke("ares_open_url", { url: String(oe.url) }).catch(() => null);
          setOpenaiAuth((s) => ({ ...s, signingIn: true }));
          pushGatewayToast(`Opened ChatGPT sign-in in your browser${oe.userCode ? ` — code ${String(oe.userCode)}` : ""}.`);
          return true;
        }
        case "openai_login_done": {
          const oe = e as { ok?: unknown; email?: unknown; plan?: unknown; error?: unknown };
          setOpenaiAuth({ signingIn: false, connected: oe.ok === true, email: typeof oe.email === "string" ? oe.email : null, plan: typeof oe.plan === "string" ? oe.plan : null });
          pushGatewayToast(oe.ok ? `🟢 ChatGPT connected${oe.plan ? ` — ${String(oe.plan)} plan` : ""}. GPT models use your subscription.` : `ChatGPT sign-in failed: ${oe.error ? stringify(oe.error) : "unknown"}`);
          return true;
        }
        case "openai_auth_status": {
          const oe = e as { configured?: unknown; email?: unknown; plan?: unknown };
          setOpenaiAuth({ signingIn: false, connected: oe.configured === true, email: typeof oe.email === "string" ? oe.email : null, plan: typeof oe.plan === "string" ? oe.plan : null });
          return true;
        }
        case "kimi_login_url": {
          // Device flow: the verification URL arrives with the code pre-filled;
          // open it in the real browser and show the waiting state.
          const ke = e as { url?: unknown };
          if (ke.url) void invoke("ares_open_url", { url: String(ke.url) }).catch(() => null);
          setKimiAuth((s) => ({ ...s, signingIn: true }));
          pushGatewayToast("Opened Kimi sign-in in your browser — approve to connect.");
          return true;
        }
        case "kimi_login_done": {
          const ke = e as { ok?: unknown; detail?: unknown; error?: unknown };
          setKimiAuth({ signingIn: false, connected: ke.ok === true, detail: typeof ke.detail === "string" ? ke.detail : null });
          pushGatewayToast(ke.ok === true
            ? "🟢 Kimi connected. Kimi models use your subscription."
            : `Kimi sign-in failed: ${ke.error ? stringify(ke.error) : "unknown"}`);
          return true;
        }
        case "kimi_auth_status": {
          const ke = e as { configured?: unknown; detail?: unknown };
          setKimiAuth({ signingIn: false, connected: ke.configured === true, detail: typeof ke.detail === "string" ? ke.detail : null });
          return true;
        }
        case "ares_network_status": {
          const n = e as unknown as Partial<AresNetworkVm>;
          setAresNetwork({
            configured: n.configured === true,
            enabled: n.enabled === true,
            connected: n.connected === true,
            busy: n.busy === true,
            url: typeof n.url === "string" ? n.url : "",
            libFound: n.libFound === true,
            ...(typeof n.estateDir === "string" ? { estateDir: n.estateDir } : {}),
            ...(typeof n.estateId === "string" ? { estateId: n.estateId } : {}),
            ...(typeof n.estateName === "string" ? { estateName: n.estateName } : {}),
            ...(typeof n.records === "number" ? { records: n.records } : {}),
            ...(typeof n.writers === "number" ? { writers: n.writers } : {}),
            ...(typeof n.lastSyncAt === "number" ? { lastSyncAt: n.lastSyncAt } : {}),
            ...(typeof n.lastPushed === "number" ? { lastPushed: n.lastPushed } : {}),
            ...(typeof n.lastPulled === "number" ? { lastPulled: n.lastPulled } : {}),
            ...(typeof n.totalPushed === "number" ? { totalPushed: n.totalPushed } : {}),
            ...(typeof n.totalPulled === "number" ? { totalPulled: n.totalPulled } : {}),
            ...(typeof n.error === "string" && n.error ? { error: n.error } : {}),
            ...(n.hosting && typeof n.hosting === "object" ? { hosting: n.hosting } : {}),
          });
          return true;
        }
        case "consciousness_status": {
          const models = Array.isArray(e.models) ? (e.models as ConsciousnessModelVm[]) : [];
          setConsciousness((c) => ({
            ...c,
            enabled: e.enabled === true,
            downloading: e.downloading === true,
            watching: e.watching === true,
            engineInstalled: e.engineStatus?.binaryInstalled === true,
            engineAvailable: e.engineStatus?.available === true,
            models,
            ready: models.length > 0 && models.every((m) => m.present),
          }));
          return true;
        }
        case "consciousness_set":
          setConsciousness((c) => ({
            ...c,
            enabled: e.enabled === true,
            watching: e.enabled === true ? c.watching : false,
            paused: e.enabled === true ? c.paused : false,
            error: undefined,
          }));
          return true;
        case "consciousness_observation":
          setConsciousness((c) => ({
            ...c,
            watching: true,
            paused: false,
            lastObservation: e.observation,
            lastComment: e.spoke && e.comment ? e.comment : c.lastComment,
            lastObservationAt: typeof e.at === "number" ? e.at : Date.now(),
          }));
          if (e.spoke && e.comment) pushLog(`[watch] ${e.comment}`);
          return true;
        case "consciousness_killed":
          setConsciousness((c) => ({ ...c, enabled: false, watching: false, paused: false }));
          pushLog("[watch] killswitch — consciousness halted");
          return true;
        case "consciousness_paused":
          setConsciousness((c) => ({ ...c, watching: false, paused: true }));
          pushLog(`[watch] looking away${typeof e.seconds === "number" ? ` (${e.seconds}s)` : ""}`);
          return true;
        case "consciousness_resumed":
          setConsciousness((c) => ({ ...c, paused: false }));
          daemonCmd({ type: "consciousness_status" });
          return true;
        case "consciousness_cancelled":
          daemonCmd({ type: "consciousness_status" });
          return true;
        case "consciousness_progress": {
          if (e.id) {
            const id = e.id;
            const pct = e.pct ?? 0;
            setConsciousness((c) => ({ ...c, downloading: true, progress: { ...c.progress, [id]: pct } }));
          }
          return true;
        }
        case "consciousness_model_ready":
          daemonCmd({ type: "consciousness_status" });
          return true;
        case "consciousness_ready":
          setConsciousness((c) => ({ ...c, downloading: false, ready: true }));
          daemonCmd({ type: "consciousness_status" });
          return true;
        case "consciousness_error":
          setConsciousness((c) => ({ ...c, downloading: false, error: String(e.error ?? "download failed") }));
          return true;
        case "skills_list":
          setSkills(Array.isArray(e.skills) ? (e.skills as SkillInfo[]) : []);
          return true;
        case "plugins_list":
          setPluginsVm({
            plugins: Array.isArray(e.plugins) ? (e.plugins as PluginStatusVm[]) : [],
            recentMaintenance: Array.isArray(e.recentMaintenance) ? (e.recentMaintenance as MaintenanceRunVm[]) : [],
          });
          return true;
        case "cognitive_state":
          setCognitive((e.cognitive as CognitiveStateVm | undefined) ?? null);
          return true;
        case "mind_overview_result":
          setMindVm((e.groups as MindOverviewVm | undefined) ?? null);
          return true;
        case "mind_edit_result":
        case "mind_forget_result":
          // A correction/deletion landed — re-pull so the pane shows the truth
          // on disk, not an optimistic local patch.
          daemonCmd({ type: "mind_overview" });
          return true;
        case "roster_list":
          setRoster(Array.isArray(e.personas) ? (e.personas as PersonaVm[]) : []);
          setActivePersona((e.active as PersonaVm | null) ?? null);
          return true;
        case "persona_changed": {
          const active = (e.active as PersonaVm | null) ?? null;
          setActivePersona(active);
          // A resolved switch retires any pending suggestion — otherwise the
          // chip would keep offering a persona that is already worn.
          setPersonaSuggestion(null);
          const err = (e as { error?: string }).error;
          if (err) {
            setSkillToast({ name: "Persona", text: err.slice(0, 180), ok: false });
            window.setTimeout(() => setSkillToast(null), 4500);
          }
          return true;
        }
        case "persona_style_set":
          // Authoritative echo — the daemon persisted it to ui.json.
          if (typeof e.style === "string") setPersonaStyle(e.style);
          return true;
        case "persona_suggested":
          // Personas were replaced by agents (2026-10-19): nothing to show.
          return true;
        case "persona_written": {
          // Saving happens from HELM, where transcript notices are invisible —
          // so both outcomes get a toast, not just the failures.
          const pw = e as { ok?: boolean; error?: string; persona?: PersonaVm; name?: string };
          const ok = pw.ok !== false;
          setSkillToast({
            name: "Roster",
            text: ok
              ? `Saved ${pw.persona?.label ?? pw.name ?? "persona"} — it's on the roster and delegable now.`
              : `Couldn't save ${pw.name || "that persona"}: ${(pw.error ?? "unknown error").slice(0, 160)}`,
            ok,
          });
          window.setTimeout(() => setSkillToast(null), ok ? 3200 : 6000);
          daemonCmd({ type: "roster_list", sessionId: activeRef.current });
          return true;
        }
        case "persona_deleted":
          daemonCmd({ type: "roster_list", sessionId: activeRef.current });
          return true;
        case "skill_result": {
          const id = (e as { invokeId?: string }).invokeId;
          const pending = id ? skillInvokePending.current.get(id) : undefined;
          if (pending && id) {
            clearTimeout(pending.timer);
            skillInvokePending.current.delete(id);
            pending.resolve({ ok: (e as { ok?: boolean }).ok === true, result: (e as { result?: unknown }).result, error: (e as { error?: string }).error });
          } else {
            const ok = (e as { ok?: boolean }).ok === true;
            const result = (e as { result?: unknown }).result;
            const text = ok
              ? (typeof result === "string" ? result : `${e.name ?? "Skill"} is ready`)
              : String((e as { error?: string }).error ?? "skill failed");
            setSkillToast({ name: String(e.name ?? "Skill"), text: text.slice(0, 180), ok });
            window.setTimeout(() => setSkillToast(null), 4500);
          }
          return true;
        }
        case "skillhub_list":
        case "skillhub_installed":
        case "skillhub_published":
          // Bridge to the SkillHub browser component via a window event (avoids
          // threading hub state through the settings tree). Refresh the local
          // skills list after an install so a freshly-pulled skill shows at once.
          window.dispatchEvent(new CustomEvent(`ares:${e.type}`, { detail: e }));
          if (e.type === "skillhub_installed" && (e as { ok?: boolean }).ok) daemonCmd({ type: "skills_list" });
          if (e.type === "skillhub_published") {
            const ok = (e as { ok?: boolean }).ok === true;
            setSkillToast({ name: "SkillHub", text: ok ? "Published to the SkillHub 🎉" : `Publish failed: ${(e as { error?: string }).error ?? "unknown"}`, ok });
            window.setTimeout(() => setSkillToast(null), 4500);
          }
          return true;
        case "usage_stats":
          setUsageStats((e.stats as UsageStats | null) ?? null);
          return true;
        case "remote_pcs": {
          // No list means the daemon could not ask (garrison down, restarting,
          // slow) — keep the last-known rows and let the next poll refresh.
          // Rendering that as an empty pane is the UI version of telling
          // someone their paired machine was never paired.
          if (!Array.isArray(e.pcs)) return true;
          const rows = e.pcs as RemotePcRow[];
          setRemotePcs(rows);
          if (e.scope === "public" || e.scope === "lan") setRemoteScope(e.scope);
          // Drop preview state for devices that are gone.
          setRemoteShots((prev) => {
            const live = new Set(rows.map((r) => r.id));
            const next: typeof prev = {};
            for (const [id, v] of Object.entries(prev)) if (live.has(id)) next[id] = v;
            return next;
          });
          return true;
        }
        case "remote_pc_link":
          if (typeof e.url === "string") setRemoteLink({ url: e.url, scope: String(e.scope ?? "public"), label: String(e.label ?? "") });
          return true;
        case "remote_pc_pair_link":
          if (typeof e.url === "string") setRemotePairLink({ url: e.url, scope: String(e.scope ?? "public"), label: String(e.label ?? ""), warning: String(e.warning ?? "") });
          return true;
        case "remote_devices":
          if (Array.isArray(e.devices)) setRemoteDevices(e.devices as PairedDeviceRow[]);
          return true;
        case "phone_pair": {
          const p = e as { url?: unknown; token?: unknown; name?: unknown; link?: unknown; permanence?: unknown; advice?: unknown; error?: unknown };
          if (typeof p.url === "string" && typeof p.token === "string" && typeof p.link === "string") {
            const permanence = p.permanence === "stable" || p.permanence === "tunnel" ? p.permanence : "lan";
            setPhonePair({ status: "ready", pairing: { url: p.url, token: p.token, name: String(p.name ?? ""), link: p.link, permanence, ...(typeof p.advice === "string" ? { advice: p.advice } : {}) } });
          } else {
            setPhonePair({ status: "error", error: typeof p.error === "string" ? p.error : "Ares couldn't produce a pairing code." });
          }
          return true;
        }
        case "remote_pc_screenshot": {
          const pcId = String(e.pcId ?? "");
          if (!pcId) return true;
          const data = typeof (e as { dataBase64?: unknown }).dataBase64 === "string" ? (e as { dataBase64: string }).dataBase64 : undefined;
          setRemoteShots((prev) => ({
            ...prev,
            [pcId]: data
              ? { data: `data:image/png;base64,${data}`, loading: false }
              : { error: typeof e.error === "string" ? e.error : "capture failed", loading: false },
          }));
          return true;
        }
        case "model_catalog": {
          const catalogModels = Array.isArray(e.models) ? e.models : [];
          // Capture each model's NATIVE effort ladder before the event fans out
          // — done here (not in the picker) so the effort panel is correct even
          // if the model browser was never opened this session.
          recordEffortLadders(String(e.provider ?? ""), catalogModels as Array<{ id?: string; effortLevels?: string[] }>);
          window.dispatchEvent(new CustomEvent("ares:model-catalog", {
            detail: { provider: e.provider, models: catalogModels },
          }));
          return true;
        }
        case "mcp_catalog":
          setMcpCatalog({ catalog: Array.isArray(e.catalog) ? (e.catalog as McpCatalogVm[]) : [], categories: Array.isArray(e.categories) ? (e.categories as Array<{ id: string; label: string }>) : [] });
          if (Array.isArray(e.connectors)) setMcpConnectors(e.connectors as McpConnectorVm[]);
          if (Array.isArray(e.servers)) setMcpServers(e.servers as McpServerStatusVm[]);
          return true;
        case "mcp_tools_refreshed":
          setMcpServers(Array.isArray(e.servers) ? (e.servers as McpServerStatusVm[]) : []);
          return true;
        case "mcp_probe_result":
          setMcpProbe({ url: String(e.url ?? ""), ...(typeof e.auth === "string" ? { auth: e.auth } : {}), ...(typeof e.registration === "boolean" ? { registration: e.registration } : {}), ...(typeof e.transport === "string" ? { transport: e.transport } : {}), ...(typeof e.note === "string" ? { note: e.note } : {}) });
          return true;
        case "pointmaps": {
          setAresPointMaps(Array.isArray(e.maps) ? e.maps.map((m) => normalizePointMap(m)).filter((m): m is PointMapSpec => m !== null) : []);
          // Ares asked the room to switch: apply once per activation, so the
          // owner's later pick in Appearance is never overridden by a stale ask.
          const act = e.activation;
          if (act && typeof act.id === "string" && typeof act.at === "number") {
            let seen = 0;
            try { seen = Number(window.localStorage.getItem("ares.pointmap.activatedAt") ?? "0"); } catch { seen = 0; }
            if (act.at > seen) {
              try { window.localStorage.setItem("ares.pointmap.activatedAt", String(act.at)); } catch { /* private mode */ }
              setPrefs((prev) => { const next = { ...prev, pointMap: act.id as string, pointMapOff: false, surface: prev.surface === "cyber" ? prev.surface : prev.surface }; savePrefs(next); return next; });
            }
          }
          return true;
        }
        case "provider_usage":
          setProviderUsage({ providers: Array.isArray(e.providers) ? (e.providers as ProviderUsageView[]) : [], errors: e.errors ?? {}, at: Date.now() });
          return true;
        case "ollama_usage":
          setOllamaUsage({ usage: (e.usage as OllamaUsageView | null | undefined) ?? null, error: typeof e.error === "string" ? e.error : null, at: Date.now() });
          return true;
        case "startup_recovery_mode":
          setRecoveryMode({ mode: e.mode === "auto" || e.mode === "never" ? e.mode : "ask", pinnedByEnv: e.pinnedByEnv === true });
          return true;
        case "operator_loop_started":
          pushNotice(`Operator loop is running unattended at startup (${e.reason || "enabled"}). ${e.note || ""}`.trim(), "dim");
          return true;
        case "operator_status":
          setOpStatus({
            activeCount: typeof e.activeCount === "number" ? e.activeCount : 0,
            goals: Array.isArray(e.goals) ? (e.goals as Array<{ id: string; statement: string; status: string; progress: number }>) : [],
            autotick: e.autotick !== false,
            trust: Array.isArray(e.trust) ? (e.trust as Array<{ domain: string; level: number; proven: number }>) : [],
          });
          // Authoritative halt state when the daemon reports it; otherwise the
          // optimistic local flag from the Halt/Resume button stands.
          if (typeof e.halted === "boolean") setOpHalted(e.halted);
          return true;
        case "fleets_list":
          setFleetHistory(Array.isArray(e.fleets) ? e.fleets : []);
          return true;
        case "subagents_list":
          setSubagentJobs(Array.isArray(e.jobs) ? (e.jobs as SubagentJobWire[]) : []);
          return true;
        case "gateway_account":
          setGatewayAccount(e as unknown as GatewayAccountVm);
          return true;
        case "gateway_grant": {
          // A credit grant landed while the app is open — ember toast, live.
          const usd = typeof e.amount_usd === "number" ? `+$${e.amount_usd.toFixed(2)}` : "+credits";
          pushGatewayToast(`${usd} credits${e.reason ? ` — ${e.reason}` : ""}`);
          return true;
        }
        case "bug_report_result": {
          setReportBusy(false);
          // A trimmed upload says so. A partial transcript that reports itself
          // as complete sends whoever reads it looking for events that were
          // never sent.
          const dropped = (e as { droppedEvents?: number }).droppedEvents ?? 0;
          // A failed upload that still produced a local file is a SUCCESS with
          // a different delivery route — say where the file is, don't just
          // report failure (field report: "can't send it as a bug report").
          const savedPath = typeof e.savedPath === "string" ? e.savedPath : null;
          pushGatewayToast(
            e.ok
              ? dropped > 0
                ? `🐛 Bug report sent — thank you. The session was too big for one upload, so the ${dropped} oldest events were left out; everything recent went through.`
                : "🐛 Bug report sent — thank you, this helps improve Ares."
              : savedPath
                ? `Upload didn't go through (${e.error ? stringify(e.error) : "unknown"}) — the report was saved to ${savedPath} instead. Attach that file wherever you report bugs.`
                : `Report failed: ${e.error ? stringify(e.error) : "unknown"}`,
          );
          if (e.ok || savedPath) setReportOpen(false);
          return true;
        }
        case "custom_models":
          // Server-side discovery result for the Custom provider card to consume.
          window.dispatchEvent(new CustomEvent("ares:custom-models", { detail: e }));
          return true;
        case "mcp_directory": {
          const list = (e as { connectors?: unknown }).connectors;
          if (Array.isArray(list)) setMcpConnectors(list as McpConnectorVm[]);
          return true;
        }
        case "mcp_tools": {
          const name = typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : "";
          if (name) {
            const tools = Array.isArray((e as { tools?: unknown }).tools) ? ((e as unknown as { tools: McpToolsVm["tools"] }).tools) : [];
            const error = typeof (e as { error?: unknown }).error === "string" ? (e as { error: string }).error : null;
            setMcpTools((prev) => ({ ...prev, [name]: { loading: false, tools, error } }));
          }
          return true;
        }
        case "mcp_connect_result":
          setSessions((prev) => prev.map((sess) => ({ ...sess, items: sess.items.map((it) => (it.kind === "connect" && it.state === "connecting"
            ? { ...it, state: e.ok === false ? ("failed" as const) : ("connected" as const), ...(e.ok === false && typeof e.error === "string" ? { error: e.error } : {}) }
            : it)) }))); {
          setMcpConnecting(null);
          // "Connected" only reads as proven when the post-connect tools/list
          // probe succeeded — an issued-but-rejected token says so out loud.
          const verified = (e as { verified?: unknown }).verified !== false;
          const toolCount = typeof (e as { toolCount?: unknown }).toolCount === "number" ? (e as { toolCount: number }).toolCount : null;
          const verifyError = typeof (e as { verifyError?: unknown }).verifyError === "string" ? (e as { verifyError: string }).verifyError : null;
          pushGatewayToast(
            !e.ok
              ? `Connect failed: ${e.error ? stringify(e.error) : "unknown"}`
              : verified
                ? `🔌 Connected ${e.name ?? "connector"} — verified, ${toolCount ?? "?"} tool${toolCount === 1 ? "" : "s"} live.`
                : `🔌 Connected ${e.name ?? "connector"} — but verification failed (${verifyError ?? "unreachable"}). Its tools may not work yet.`,
          );
          return true;
        }
        case "mcp_search_results":
          setMcpRegistryCursor(typeof e.nextCursor === "string" ? e.nextCursor : null); {
          const text = typeof (e as { text?: unknown }).text === "string" ? (e as { text: string }).text : "";
          const results = Array.isArray((e as { results?: unknown }).results) ? ((e as unknown as { results: McpRegistryResult[] }).results) : [];
          setMcpSearch((prev) => (prev.text === text ? { ...prev, searching: false, results } : prev));
          return true;
        }
        case "ollama_pull_progress": {
          const model = typeof (e as { model?: unknown }).model === "string" ? (e as { model: string }).model : "";
          if (model) {
            const pct = typeof (e as { pct?: unknown }).pct === "number" ? (e as { pct: number }).pct : null;
            const status = typeof (e as { status?: unknown }).status === "string" ? (e as { status: string }).status : "";
            setOllamaPulls((prev) => ({ ...prev, [model]: { pct, status } }));
          }
          return true;
        }
        case "ollama_pull_done": {
          const model = typeof (e as { model?: unknown }).model === "string" ? (e as { model: string }).model : "";
          if (model) {
            const ok = (e as { ok?: unknown }).ok !== false;
            const error = typeof (e as { error?: unknown }).error === "string" ? (e as { error: string }).error : undefined;
            setOllamaPulls((prev) => ({ ...prev, [model]: ok ? { pct: 100, status: "success", done: true } : { pct: null, status: "error", error } }));
            pushGatewayToast(ok ? `🦙 Pulled ${model} — it's ready to use.` : `Pull failed: ${error ?? "unknown error"}`);
          }
          return true;
        }
        case "oauth_status":
          if (Array.isArray(e.providers)) setOauthProviders(e.providers as OAuthProviderVm[]);
          return true;
        case "oauth_url":
          // The daemon's callback server is up; open the consent page in the
          // user's REAL browser (codecs, logins, no automation flags).
          if (e.url) void invoke("ares_open_url", { url: e.url }).catch(() => null);
          return true;
        case "oauth_connected":
          pushLog(`[oauth] ${e.provider ?? "service"} connected`);
          if (e.provider === "ares") pushGatewayToast("🐉 Ares account connected — models and credits are live.");
          else daemonCmd({ type: "oauth_status" });
          return true;
        case "oauth_disconnected":
        case "oauth_credentials_set":
          daemonCmd({ type: "oauth_status" });
          return true;
        case "oauth_error":
          pushLog(`[oauth] ${e.provider ?? "service"} failed: ${e.error ? stringify(e.error) : "unknown"}`);
          if (e.provider === "ares") pushGatewayToast(`Sign-in failed: ${e.error ? stringify(e.error) : "unknown"}`);
          return true;
        // ── desktop agents ──
        case "agents_list":
          if (Array.isArray(e.agents)) {
            const list = e.agents as AgentVm[];
            agentsCountRef.current = list.length;
            setAgents(list);
            setAgentsLoaded(true);
            // Fetch any profile picture that is new or changed (the phone may
            // have set it); drop the ones that were removed.
            for (const a of list) {
              if (a.avatar && agentPhotoVersions.current[a.id] !== a.avatar) {
                agentPhotoVersions.current[a.id] = a.avatar;
                daemonCmd({ type: "agent_avatar", agentId: a.id });
              } else if (!a.avatar && agentPhotoVersions.current[a.id]) {
                delete agentPhotoVersions.current[a.id];
                setAgentPhotos((p) => { const n = { ...p }; delete n[a.id]; return n; });
              }
            }
            // The daemon knows the bindings now; drop the optimistic ones it echoed.
            setLocalAgentBindings((current) => {
              const echoed = new Set(list.flatMap((a) => a.threads ?? []));
              const next = Object.fromEntries(Object.entries(current).filter(([sid]) => !echoed.has(sid)));
              return Object.keys(next).length === Object.keys(current).length ? current : next;
            });
          }
          return true;
        case "agent_created": {
          const made = e.agent as AgentVm | undefined;
          if (made?.id && agentsCountRef.current === 0) setHandOver({ agentId: made.id });
          if (made?.id) {
            setAgents((current) => [...current.filter((a) => a.id !== made.id), made]);
            setAgentEditor(null);
            setAgentError(undefined);
            pendingAgentChat.current = made.id;
            if (pendingAgentPhoto.current) {
              daemonCmd({ type: "agent_avatar_set", agentId: made.id, image: pendingAgentPhoto.current });
              setAgentPhotos((p) => ({ ...p, [made.id]: pendingAgentPhoto.current! }));
              pendingAgentPhoto.current = null;
            }
          }
          return true;
        }
        case "agent_updated": {
          const next = e.agent as AgentVm | undefined;
          if (next?.id) {
            setAgents((current) => current.map((a) => (a.id === next.id ? next : a)));
            setAgentEditor(null);
            setAgentError(undefined);
          }
          return true;
        }
        case "agent_deleted": {
          const id = String(e.agentId ?? "");
          setAgents((current) => current.filter((a) => a.id !== id));
          setAgentEditor(null);
          setSelectedAgentIdState((current) => (current === id ? ARES_AGENT_ID : current));
          return true;
        }
        case "agent_error":
          setAgentMemory((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, busy: false }])));
          setAgentError(String(e.error ?? "agent change failed"));
          pushLog(`[agents] ${String(e.command ?? "")}: ${String(e.error ?? "")}`);
          return true;
        case "agent_bound":
          return true;
        case "agent_memory": {
          const id = String(e.agentId ?? "");
          if (!id) return true;
          const ev = e as { total?: number; items?: AgentMemoryVm["items"]; handed?: { copied: number; skipped: number }; exported?: { markdown: string; count: number }; forgot?: boolean };
          const note = ev.handed
            ? `Handed over ${ev.handed.copied} memor${ev.handed.copied === 1 ? "y" : "ies"}${ev.handed.skipped ? ` (${ev.handed.skipped} they already had)` : ""}.`
            : ev.exported
              ? `Exported ${ev.exported.count} memories to ${ev.exported.markdown} (and a .json next to it).`
              : undefined;
          setAgentMemory((m) => ({ ...m, [id]: { total: ev.total ?? 0, items: ev.items ?? [], note: note ?? m[id]?.note, busy: false } }));
          return true;
        }
        case "agent_memory_changed": {
          const id = String(e.agentId ?? "");
          if (id) daemonCmd({ type: "agent_memory", agentId: id });
          return true;
        }
        case "agent_avatar_clips": {
          // the living clips landed: real motion replaces the frame loops
          const id = String(e.agentId ?? "");
          const clips = (e as { clips?: unknown }).clips;
          const version = (e as { version?: unknown }).version;
          if (id && clips && typeof clips === "object" && (!version || agentPhotoVersions.current[id] === String(version))) setAgentClips((p) => ({ ...p, [id]: clips as Record<string, string> }));
          return true;
        }
        case "agent_avatar_poses": {
          // a new picture's pose frames finished rendering: it comes alive
          const id = String(e.agentId ?? "");
          const poses = (e as { poses?: unknown }).poses;
          const version = (e as { version?: unknown }).version;
          if (id && poses && typeof poses === "object" && (!version || agentPhotoVersions.current[id] === String(version))) setAgentPoses((p) => ({ ...p, [id]: poses as Record<string, string> }));
          return true;
        }
        case "agent_avatar": {
          const id = String(e.agentId ?? "");
          const image = typeof (e as { image?: unknown }).image === "string" ? String((e as { image?: unknown }).image) : "";
          if (!id) return true;
          const version = (e as { version?: unknown }).version;
          if (version) agentPhotoVersions.current[id] = String(version);
          const clips = (e as { clips?: unknown }).clips;
          setAgentClips((p) => {
            if (image && clips && typeof clips === "object") return { ...p, [id]: clips as Record<string, string> };
            if (!(id in p)) return p;
            const n = { ...p };
            delete n[id];
            return n;
          });
          const poses = (e as { poses?: unknown }).poses;
          setAgentPoses((p) => {
            if (image && poses && typeof poses === "object") return { ...p, [id]: poses as Record<string, string> };
            if (!(id in p)) return p;
            const n = { ...p };
            delete n[id];
            return n;
          });
          setAgentPhotos((p) => {
            if (image) return p[id] === image ? p : { ...p, [id]: image };
            if (!(id in p)) return p;
            const n = { ...p };
            delete n[id];
            return n;
          });
          return true;
        }
        case "agent_text": {
          // One agent texted another: show it in the recipient's chat right
          // away (the turn it starts streams in behind it) and light their dot.
          const threadId = String(e.threadId ?? "");
          const to = (e.to ?? {}) as { id?: string; name?: string };
          const from = (e.sender ?? {}) as { name?: string };
          if (!threadId) return true;
          if (to.id) setLocalAgentBindings((current) => (current[threadId] === to.id ? current : { ...current, [threadId]: to.id! }));
          const text = `[text from ${from.name ?? "an agent"}${e.urgent ? " · urgent" : ""}] ${String(e.text ?? "")}`;
          setSessions((prev) => {
            const hit = prev.find((x) => x.id === threadId);
            const item: Item = { kind: "user", key: nextKey(), inputId: String(e.inputId ?? "") || undefined, text };
            if (!hit) return [{ ...freshSession(), id: threadId, title: `${from.name ?? "Agent"} → ${to.name ?? ""}`.trim(), items: [item] }, ...prev];
            return prev.map((x) => (x.id === threadId ? { ...x, items: [...x.items, item] } : x));
          });
          if (to.id && to.id !== selectedAgentRef.current) setAgentUnread((u) => (u.includes(to.id!) ? u : [...u, to.id!]));
          return true;
        }
        case "gateway_response": {
          const ev = e as { requestId?: string; status?: number; data?: unknown; error?: string };
          const waiter = ev.requestId ? gatewayWaiters.current.get(ev.requestId) : undefined;
          if (waiter && ev.requestId) {
            gatewayWaiters.current.delete(ev.requestId);
            waiter({ status: ev.status ?? 0, data: ev.error ? { error: ev.error } : ev.data });
            return true;
          }
          return false;
        }
        case "directory_state": {
          const d = (e as { directory?: DirectoryVm }).directory;
          if (d) setDirectory(d);
          setPeopleBusy(false);
          setPeopleError(undefined);
          return true;
        }
        case "directory_results": {
          const ev = e as { requestId?: string; users?: DirectoryProfileVm[] };
          if (ev.requestId && ev.requestId !== `ps_${peopleSearchSeq.current}`) return true;
          setPeopleResults(Array.isArray(ev.users) ? ev.users : []);
          setPeopleSearching(false);
          return true;
        }
        case "directory_sent": {
          const ev = e as { roomId?: string; dm?: boolean };
          setPeopleBusy(false);
          setPeopleError(undefined);
          if (ev.dm && ev.roomId) { setPeopleOpen(false); setActiveRoomId(ev.roomId); setView("chat"); daemonCmd({ type: "room_history", roomId: ev.roomId }); }
          return true;
        }
        case "directory_invite": {
          const item = (e as { item?: DirectoryInviteVm }).item;
          if (item) pushLog(`[people] @${item.from.username} invited you to ${item.roomName}`);
          return true;
        }
        case "directory_error": {
          const ev = e as { error?: string; requestId?: string; command?: string };
          setPeopleBusy(false);
          setPeopleSearching(false);
          if (ev.command === "directory_user") setProfileView((p) => (p ? { ...p, loading: false, error: String(ev.error ?? "couldn't load that profile") } : p));
          if (ev.command === "directory_group") setRoomError(String(ev.error ?? "the directory did not answer"));
          else setPeopleError(String(ev.error ?? "the directory did not answer"));
          return true;
        }
        case "rooms_list": {
          if (Array.isArray(e.rooms)) setRooms(e.rooms as RoomVm[]);
          const me = e.me as RoomsMeVm | undefined;
          if (me?.id) setRoomsMe(me);
          for (const r of (Array.isArray(e.rooms) ? (e.rooms as RoomVm[]) : [])) {
            if (!roomMessagesRef.current[r.id]) daemonCmd({ type: "room_history", roomId: r.id });
          }
          return true;
        }
        case "room_created": {
          const made = e.room as RoomVm | undefined;
          if (!made?.id) return true;
          setRooms((current) => [made, ...current.filter((r) => r.id !== made.id)]);
          setRoomSheet(null);
          setRoomError(undefined);
          setActiveRoomId(made.id);
          setView("chat");
          daemonCmd({ type: "room_history", roomId: made.id });
          return true;
        }
        case "room_changed": {
          const next = e.room as RoomVm | undefined;
          if (!next?.id) return true;
          setRooms((current) => (current.some((r) => r.id === next.id) ? current.map((r) => (r.id === next.id ? next : r)) : [next, ...current]));
          return true;
        }
        case "room_deleted": {
          const id = String(e.roomId ?? "");
          setRooms((current) => current.filter((r) => r.id !== id));
          setRoomMessages((m) => { const n = { ...m }; delete n[id]; return n; });
          if (activeRoomRef.current === id) setActiveRoomId(null);
          setRoomSheet(null);
          return true;
        }
        case "room_history": {
          const id = String(e.roomId ?? "");
          const list = Array.isArray(e.messages) ? (e.messages as RoomMessageVm[]) : [];
          if (id) setRoomMessages((m) => ({ ...m, [id]: list }));
          return true;
        }
        case "room_message":
        case "room_posted": {
          const id = String(e.roomId ?? "");
          const msg = e.message as RoomMessageVm | undefined;
          if (!id || !msg?.id) return true;
          setRoomMessages((m) => {
            const list = m[id] ?? [];
            if (list.some((x) => x.id === msg.id)) return m;
            return { ...m, [id]: [...list, msg].slice(-600) };
          });
          const mine = msg.from.kind === "person" && (msg.from.home ?? "local") === "local";
          if (!mine && msg.kind === "text" && activeRoomRef.current !== id) setRoomUnread((u) => (u.includes(id) ? u : [...u, id]));
          return true;
        }
        case "room_turn":
          return true;
        case "jobs_list": {
          const list = (e as unknown as { jobs?: JobVm[] }).jobs;
          if (Array.isArray(list)) setJobs(list);
          setJobError(undefined);
          return true;
        }
        case "job_error": {
          setJobError(String((e as { error?: unknown }).error ?? "that didn't work"));
          return true;
        }
        case "agent_sharing": {
          const ev = e as unknown as Partial<SharingVm>;
          if (ev.settings) setSharing({ settings: ev.settings, inbox: Array.isArray(ev.inbox) ? ev.inbox : [] });
          setShareError(undefined);
          return true;
        }
        case "share_error": {
          setShareError(String((e as { error?: unknown }).error ?? "that didn't work"));
          return true;
        }
        case "directory_user": {
          const user = (e as unknown as { user?: DirectoryProfileVm }).user;
          if (user?.username) setProfileView((p) => (p && p.username === user.username ? { ...p, user, loading: false } : p));
          return true;
        }
        case "workspaces_list": {
          const list = (e as unknown as { workspaces?: WorkspaceVm[] }).workspaces;
          if (Array.isArray(list)) setWorkspaces(list);
          setWorkspaceError(undefined);
          return true;
        }
        case "workspace_added": {
          const w = (e as unknown as { workspace?: WorkspaceVm }).workspace;
          if (w?.id) setWorkspaces((cur) => [...cur.filter((x) => x.id !== w.id), w]);
          setWorkspaceError(undefined);
          return true;
        }
        case "workspace_busy": {
          const ev = e as unknown as { id?: string; step?: string };
          if (ev.id) setWorkspaceBusy((b) => ({ ...b, [ev.id!]: ev.step ?? "test" }));
          return true;
        }
        case "workspace_checked": {
          const w = (e as unknown as { workspace?: WorkspaceVm }).workspace;
          if (w?.id) {
            setWorkspaces((cur) => cur.map((x) => (x.id === w.id ? w : x)));
            setWorkspaceBusy((b) => { const n = { ...b }; delete n[w.id]; return n; });
          }
          return true;
        }
        case "workspace_error": {
          const ev = e as unknown as { id?: string; error?: string };
          setWorkspaceError(String(ev.error ?? "that didn't work"));
          if (ev.id) setWorkspaceBusy((b) => { const n = { ...b }; delete n[ev.id!]; return n; });
          return true;
        }
        case "room_presence": {
          const id = String(e.roomId ?? "");
          const list = Array.isArray((e as { presence?: unknown }).presence) ? ((e as unknown as { presence: Array<{ key: string; name: string; activity: string }> }).presence) : [];
          if (id) setRoomPresence((p) => ({ ...p, [id]: list }));
          return true;
        }
        case "agent_open_url": {
          // An agent opened something on the owner's screen: their real browser.
          const url = String((e as { url?: unknown }).url ?? "");
          if (/^https?:\/\//i.test(url)) {
            if (native) void invoke("ares_open_url", { url }).catch(() => null);
            else window.open(url, "_blank", "noopener");
          }
          return true;
        }
        case "room_invite": {
          const id = String(e.roomId ?? "");
          const link = String(e.link ?? "");
          setRoomSheet((sheet) => (sheet?.kind === "invite" && sheet.roomId === id ? { kind: "invite", roomId: id, link } : sheet));
          return true;
        }
        case "room_error": {
          const err = String(e.error ?? "room change failed");
          setRoomError(err);
          setRoomSheet((sheet) => (sheet && "busy" in sheet ? { ...sheet, busy: false } : sheet));
          pushLog(`[rooms] ${String(e.command ?? "")}: ${err}`);
          return true;
        }
        case "sessions_list": {
          const disk = Array.isArray(e.sessions) ? (e.sessions as SessionSummaryWire[]) : [];
          pushLog(`[garrison] ${disk.length} sessions on disk`);
          setSessions((current) => {
            const byId = new Map(current.map((session) => [session.id, session]));
            const merged = disk.map((summary) => {
              const existing = byId.get(summary.id);
              if (!existing) return sessionFromSummary(summary);
              // A busy chat's live events can land before this list (a reload
              // mid-turn): it was adopted as a placeholder "Background session".
              // The disk knows what it really is — its title, and that it's
              // the owner's chat, not a background job.
              if (existing.background && existing.title === "Background session") {
                const real = sessionFromSummary(summary);
                return { ...existing, title: real.title, background: real.background, workflowMode: summary.workflowMode ?? existing.workflowMode };
              }
              const workflowMode = summary.workflowMode ?? existing.workflowMode;
              const createdAt = existing.createdAt ?? summary.createdAt;
              // A rename done on disk (meta.label) should refresh the rail title.
              if (summary.label) {
                const next = compact(summary.label, 42);
                if (existing.title !== next || existing.workflowMode !== workflowMode) return { ...existing, title: next, workflowMode, createdAt };
              }
              return existing.workflowMode === workflowMode && existing.createdAt === createdAt ? existing : { ...existing, workflowMode, createdAt };
            });
            const localOnly = current.filter((session) => !disk.some((summary) => summary.id === session.id));
            return [...localOnly, ...merged];
          });
          return true;
        }
        case "session_deleted": {
          if (e.id && e.ok !== false) {
            setSessions((current) => current.filter((session) => session.id !== e.id));
            if (activeRef.current === e.id) activeRef.current = "";
          }
          return true;
        }
        case "session_renamed": {
          if (e.id && e.ok !== false) {
            const stash = pendingRenamesRef.current.get(e.id);
            if (stash && --stash.pending <= 0) pendingRenamesRef.current.delete(e.id);
            // A success while more renames are pending becomes the new revert
            // point: only the still-unacked renames could fail from here.
            else if (stash && typeof e.label === "string" && e.label) stash.title = compact(e.label, 42);
            const label = typeof e.label === "string" ? e.label : "";
            setSessions((current) => current.map((session) => (
              session.id === e.id ? { ...session, title: label ? compact(label, 42) : session.title } : session
            )));
          } else if (e.id) {
            // The rename never persisted — revert the optimistic title so the
            // rail doesn't show a name that will vanish on restart.
            const stash = pendingRenamesRef.current.get(e.id);
            pendingRenamesRef.current.delete(e.id);
            pushLog(`[garrison] session rename failed for ${e.id} — title reverted`);
            if (stash !== undefined) {
              setSessions((current) => current.map((session) => (
                session.id === e.id ? { ...session, title: stash.title } : session
              )));
            }
          }
          return true;
        }
        case "session_history":
          if (e.id) {
            const hydrated = sessionFromHistory(e.id, e.messages, e.meta);
            // Only trust the hydrated title when the snapshot carries a real
            // user-set label; otherwise keep the rail title (sessions_list
            // already resolved label-or-preview) instead of regressing to the
            // first-message fallback.
            const metaHasLabel =
              !!e.meta && typeof e.meta === "object" && !!(e.meta as { label?: unknown }).label &&
              typeof (e.meta as { label?: unknown }).label === "string";
            // Placeholders must not outrank a real first-message title.
            const keepable = (title: string | undefined): string | undefined =>
              title && title !== "Saved session" && title !== "New session" ? title : undefined;
            setSessions((current) => current.map((session) => {
              if (session.id !== e.id) return session;
              // A send/steer can land while the history request is in flight.
              // If the local card is mid-turn, or already holds MORE than the
              // snapshot, the snapshot is stale — keep the local transcript and
              // busy state entirely (only the title may refresh) instead of
              // erasing a message the user just sent.
              if (session.busy || session.items.length > hydrated.items.length) {
                return {
                  ...session,
                  loading: false,
                  loaded: true,
                  title: metaHasLabel ? hydrated.title : keepable(session.title) ?? hydrated.title,
                };
              }
              return {
                ...hydrated,
                title: metaHasLabel ? hydrated.title : keepable(session.title) ?? hydrated.title,
                updatedAt: session.updatedAt,
                createdAt: session.createdAt,
                workflowMode: hydrated.workflowMode ?? session.workflowMode,
              };
            }));
          }
          return true;
        case "lifecycle": {
          pushLog(`[lifecycle] ${compact(stringify(e.event ?? {}), 200)}`);
          const ev = (e.event ?? {}) as { type?: string; server?: string; displayName?: string; url?: string; id?: string; name?: string; auth?: string; reason?: string };
          if (ev.type === "mcp_auth_required" || ev.type === "mcp_suggest") {
            const expired = ev.type === "mcp_auth_required";
            const id = expired ? (ev.server ?? "") : (ev.id ?? "");
            const target = e.sessionId ?? activeRef.current;
            if (id && target) {
              applyTo(target, (sess) => sess.items.some((it) => it.kind === "connect" && it.id === id && it.state !== "connected" && it.state !== "failed")
                ? sess
                : { ...sess, items: [...sess.items, { kind: "connect" as const, key: `connect_${Date.now()}_${id}`, id, name: expired ? (ev.displayName ?? id) : (ev.name ?? id), url: ev.url ?? "", auth: ev.auth ?? "oauth", reason: ev.reason ?? "", why: expired ? ("expired" as const) : ("suggest" as const), state: "idle" as const }] });
            }
          }
          return true;
        }
        case "desktop_daemon_started":
          resetSteerReplayEpoch(steerReplayEpoch.current);
          pushLog(`[shell] daemon started (${e.provider ?? "default"} / ${e.model ?? "default"})`);
          return true;
        case "desktop_daemon_restarting":
          resetSteerReplayEpoch(steerReplayEpoch.current);
          setDaemon("starting");
          pushLog("[shell] daemon restarting");
          return true;
        case "desktop_daemon_stopped":
          resetSteerReplayEpoch(steerReplayEpoch.current);
          setDaemon("stopped");
          pushLog("[shell] daemon stopped");
          return true;
        case "desktop_daemon_stream_closed":
          pushLog("[shell] daemon stream closed");
          return true;
        case "desktop_daemon_exited": {
          resetSteerReplayEpoch(steerReplayEpoch.current);
          pushLog(`[shell] daemon exited · code ${e.code ?? "unknown"}`);
          setDaemon("error");
          const attempt = restartAttempts.current;
          const willRetry = attempt < MAX_AUTO_RESTARTS;
          // Not the last four lines — the last four lines of a V8 fatal dump
          // are stack addresses resolved against whatever symbol sits nearest
          // in node.exe ("AES_cbc_encrypt+152028"), which told people nothing
          // while the line that mattered scrolled off the top.
          const errorText = daemonExitMessage(
            typeof e.code === "number" ? e.code : null,
            stderrTail.current,
            { willRetry, attempt: attempt + 1, max: MAX_AUTO_RESTARTS },
          );
          // A daemon crash kills every in-flight turn, not just the one the
          // user is currently looking at — sweep ALL busy sessions so
          // background cards don't stay stuck forever with no error shown.
          // Unresolved steer bubbles intentionally remain nonterminal; ready
          // replay lets the durable idempotency record settle their real state.
          setSessions((prev) =>
            prev.map((s) => (s.busy ? {
              ...foldEvent(s, { type: "desktop_error", text: errorText }),
              busy: false,
              cancelling: false,
            } : s)),
          );
          stoppingSessionsRef.current.clear();
          // The sweep above folded desktop_error into every busy session, which
          // re-enables their approval buttons — release the matching locks.
          permissionSubmissionLocks.current.clear();
          if (willRetry) {
            restartAttempts.current += 1;
            window.setTimeout(() => restartDaemon(), 900 * (attempt + 1));
          }
          return true;
        }
        case "computer_screen": {
          // The agent computer's noVNC screen: open it in the system browser
          // (localhost URL served from inside the sandbox).
          if (e.ok !== false && e.url) {
            if (native) void invoke("ares_open_url", { url: String(e.url) }).catch(() => null);
          } else if (e.error) {
            pushGatewayToast(`Agent computer: ${String(e.error)}`);
          }
          return true;
        }
        case "computer_mode":
          if (e.mode === "sandbox" || e.mode === "host") setComputerMode(e.mode);
          pushGatewayToast(
            e.mode === "sandbox"
              ? `Sandbox only — Ares will work on its own computer${e.setupStarted ? "; setting that machine up now" : ""}. New sessions pick this up immediately.`
              : "Host mode — Ares can work on your machine again (gated as usual).",
          );
          return true;
        case "computer_status": {
          const status = e.status as { mode?: string } | undefined;
          if (status?.mode === "sandbox" || status?.mode === "host") setComputerMode(status.mode);
          return true;
        }
        case "computer_setup_progress":
          pushLog(`[computer] ${String(e.line ?? "")}`);
          return true;
        case "computer_setup_done":
          pushLog(`[computer] setup ${e.ok === false ? "failed" : "done"}: ${String(e.result ?? e.error ?? "")}`);
          pushGatewayToast(e.ok === false
            ? `Agent computer setup failed: ${String(e.error ?? "unknown error")}`
            : "Agent computer is ready — Ares now has its own sandboxed Linux machine.");
          return true;
        case "daemon_error": {
          // A failed sessions_list (kernel open error, locked WAL, missing
          // native sqlite) used to fall through to the per-session fold — on
          // a cold boot there is no session to fold into, so the rail was
          // just silently empty and read as "my sessions disappeared".
          const detail = typeof e.error === "string" ? e.error : e.error ? stringify(e.error) : "";
          if (detail.startsWith("sessions_list:")) {
            pushLog(`[daemon] ${detail}`);
            pushGatewayToast("Couldn't load the session list — your sessions are still on disk. Check the Garrison log, then relaunch.");
            return true;
          }
          return false;
        }
        default:
          return false;
      }
    };

    const ingest = (buffered: BufferedEvent) => {
      if (!mounted || buffered.seq <= lastSeq.current) return;
      lastSeq.current = buffered.seq;
      if (handleShellEvent(buffered.event)) return;
      // Route the event to the session it belongs to (multi-session daemon
      // tags every event with sessionId). Untagged events go to the active card.
      const sid = (buffered.event as { sessionId?: string }).sessionId;
      // Surface attention-worthy events as OS notifications when you're not
      // looking at this session/window — so overnight & background work is visible.
      const ev = buffered.event;
      if (ev.type === "permission_response" && ev.id) {
        permissionSubmissionLocks.current.delete(ev.id);
      }
      // A daemon transport failure makes every in-flight approval delivery
      // ambiguous. foldEvent re-enables the prompt buttons on desktop_error;
      // the local submission locks must open at the same moment, or the
      // re-enabled buttons are dead on click.
      if (ev.type === "desktop_error") {
        permissionSubmissionLocks.current.clear();
      }
      // Turn settlement clears the local Stop gate. The daemon does not always
      // pair a Stop with interrupt_settled (a successor handoff cancels the
      // settle and closes via plain turn_end/turn_settled) — without this, the
      // session's composer stayed send/steer-blocked forever.
      if (ev.type === "turn_settled" || ev.type === "turn_end") {
        stoppingSessionsRef.current.delete(sid ?? (primarySessionRef.current || activeRef.current));
      }
      // Ares is working in the Forge page (any Browser call): note it, and at
      // turn end show the owner the final code if edits were held back.
      if (ev.type === "tool_start" && (ev as { name?: string }).name === "Browser") forgeDrivenAt.current = Date.now();
      if ((ev.type === "turn_end" || ev.type === "turn_settled") && forgeReloadPending.current) {
        forgeReloadPending.current = false;
        forgeDrivenAt.current = 0;
        setLiveRevision((n) => n + 1);
      }
      // Feed the composer's token-flow strip: count every streamed character of
      // the session you're LOOKING at (text, thinking, tool-input authoring).
      // One integer addition on a module-level accumulator — no React involved.
      // Untagged events belong to the PRIMARY card, so they only feed the strip
      // (and the voice) when the primary is the card being looked at.
      if ((sid ?? (primarySessionRef.current || activeRef.current)) === activeRef.current) {
        if (ev.type === "provider_attempt_superseded" && ev.reason === "steering") {
          // Any speech/text from this provider attempt is stale by definition.
          // The reducer removes only that attempt's draft items; stop its voice
          // stream at the same fence so it cannot keep talking over the steer.
          voiceRef.current.stop();
          resetSpokenStream();
        }
        if ((ev.type === "text_delta" || ev.type === "thinking_delta") && ev.text) pushTokenFlow(ev.text.length);
        else if (ev.type === "tool_use_input_delta" && ev.deltaJson) pushTokenFlow(ev.deltaJson.length);
        liveExplain.onEvent(ev as { type?: string; id?: string; name?: string; deltaJson?: string });
        if (ev.type === "turn_end" || ev.type === "turn_settled" || ev.type === "interrupt_settled") liveExplain.reset();
        // Voice: speak natural phrases while reply text streams. Only the session
        // you're looking at speaks; thinking + tool noise never do.
        if (prefs.voiceEnabled && sid !== livingSessionRef.current) {
          if (ev.type === "turn_start") resetSpokenStream();
          else if (ev.type === "text_delta" && ev.text) appendSpokenDelta(ev.text);
          else if (ev.type === "message_done" && spokenBuf.current && !/\s$/.test(spokenBuf.current)) {
            // Separate assistant rounds around tool calls. Token deltas within a
            // round still concatenate exactly, so BPE word pieces stay intact.
            spokenBuf.current += " ";
          } else if (ev.type === "turn_end") flushSpokenBuffer(true, true);
        }
      }
      const elsewhere = document.hidden || (!!sid && sid !== activeRef.current);
      if (ev.type === "permission_request" && elsewhere) {
        fireNotification("Ares needs your approval", ev.reason || ev.toolName || "A tool needs your OK");
      } else if (ev.type === "turn_end" && elsewhere && sid !== livingSessionRef.current) {
        fireNotification("Ares finished a task", "A background turn just completed.");
        // Spoken heads-up: you're away from the window — say it out loud too.
        if (prefsRef.current.voiceEnabled && prefsRef.current.voiceNotify !== false) {
          voiceRef.current.speak("Heads up — a background task just finished.");
        }
      }
      // Live browser frame — Ares driving its own embedded browser. Don't fold
      // into the transcript; push it to the Forge "Live" panel and open it.
      if (ev.type === "tool_progress" && ev.data?.kind === "browser_frame" && ev.data.image) {
        setLiveBrowser({ frame: ev.data.image, at: Date.now() });
        setForge((f) => (f.open && f.tab === "live" ? f : { ...f, open: true, tab: "live" }));
        return;
      }
      // Live engine frames — a provider (the Godot game/editor) streaming while
      // its operation runs, or the daemon's live-feed hub polling it between
      // turns. Same canvas as the browser screencast; carries its own label.
      {
        const raw = ev as unknown as { type?: string; data?: Record<string, unknown>; image?: string; source?: string; side?: string; label?: string; width?: number; height?: number; interactive?: boolean; state?: string; error?: string; project?: string };
        const frameData = raw.type === "tool_progress" && raw.data?.kind === "live_frame" ? raw.data : raw.type === "live_frame" ? raw : null;
        if (frameData && typeof frameData.image === "string") {
          const d = frameData as { image: string; source?: string; side?: string; label?: string; width?: number; height?: number };
          const now = Date.now();
          setLiveBrowser({ frame: d.image, at: now });
          setLiveFeed((f) => ({
            source: d.source ?? f?.source ?? "engine",
            side: d.side ?? f?.side ?? "game",
            label: d.label ?? f?.label ?? "Live",
            at: now,
            interactive: (d.side ?? f?.side) === "game",
            watching: raw.type === "live_frame" ? true : f?.watching ?? false,
            offered: f?.offered ?? false,
            width: d.width ?? f?.width,
            height: d.height ?? f?.height,
            step: f?.step,
          }));
          setForge((f) => (f.open && f.tab === "live" ? f : { ...f, open: true, tab: "live" }));
          return;
        }
        if (raw.type === "tool_progress" && raw.data?.kind === "live_step") {
          const label = typeof raw.data.label === "string" ? raw.data.label : "";
          setLiveFeed((f) => (f ? { ...f, step: label } : f));
          return;
        }
        if (raw.type === "tool_progress" && raw.data?.kind === "live_control") {
          // Native-window hints (pid/title) so the owner can embed the real engine.
          const d = raw.data as { side?: string; source?: string; label?: string; pid?: number | null; windowTitle?: string; state?: string };
          setLiveFeed((f) => {
            const base: LiveFeedState = f ?? { source: d.source ?? "engine", side: d.side ?? "game", label: d.label ?? "Live", at: 0, interactive: d.side === "game", watching: false, offered: false };
            if (d.state === "ended") return { ...base, pid: null, offered: false, watching: false, note: "run finished" };
            return { ...base, side: d.side ?? base.side, label: d.label ?? base.label, pid: d.pid ?? base.pid, windowTitle: d.windowTitle ?? base.windowTitle, offered: true, interactive: (d.side ?? base.side) === "game" };
          });
          // do not return: the Capability tool's activity stream also shows it
        }
        if (raw.type === "live_feed" && typeof raw.state === "string") {
          const state = raw.state;
          const hints = raw as { pid?: number | null; windowTitle?: string };
          setLiveFeed((f) => {
            const base: LiveFeedState = f ?? { source: raw.source ?? "engine", side: raw.side ?? "game", label: raw.label ?? "Live", at: 0, interactive: raw.side === "game", watching: false, offered: false };
            if (state === "watching") return { ...base, label: raw.label ?? base.label, side: raw.side ?? base.side, interactive: !!raw.interactive, watching: true, offered: true, note: undefined, pid: hints.pid ?? base.pid, windowTitle: hints.windowTitle ?? base.windowTitle };
            if (state === "offered" || state === "streaming") return { ...base, label: raw.label ?? base.label, side: raw.side ?? base.side, interactive: !!raw.interactive, offered: true, note: undefined };
            if (state === "stopped" || state === "lost" || state === "ended" || state === "offer_gone") {
              return { ...base, watching: false, offered: state === "stopped", note: state === "lost" ? "the game closed" : state === "ended" ? "run finished" : undefined };
            }
            if (state === "unavailable" || state === "input_failed") return { ...base, note: raw.error ?? state };
            return base;
          });
          if (state === "lost" || state === "ended") { setLiveInteract(false); setLiveMouseLook(false); }
          return;
        }
      }
      if (ev.type === "tool_progress" && ev.data?.kind === "browser_console" && typeof ev.data.url === "string") {
        const d = ev.data as { url: string; errors?: unknown; served?: { root?: unknown; origin?: unknown } | null };
        const errors = Array.isArray(d.errors) ? d.errors.filter((e): e is string => typeof e === "string") : [];
        const served = d.served && typeof d.served.root === "string" && typeof d.served.origin === "string" ? { root: d.served.root, origin: d.served.origin } : null;
        setLiveConsole({ url: d.url, errors, served, at: Date.now() });
        servedRootRef.current = served ? served.root : null;
        // falls through: the progress event still belongs in the tool's activity stream
      }
      if ((ev as { type?: string }).type === "forge_telemetry") {
        const d = ev as unknown as { url?: unknown; root?: unknown; at?: unknown; fps?: unknown; longestMs?: unknown; loadMs?: unknown; errors?: unknown; warnings?: unknown; errorCount?: unknown; warningCount?: unknown; lowFps?: unknown };
        const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
        const errors = strs(d.errors);
        setForgeTelemetry({
          url: typeof d.url === "string" ? d.url : "",
          root: typeof d.root === "string" ? d.root : "",
          at: typeof d.at === "number" ? d.at : Date.now(),
          fps: typeof d.fps === "number" ? d.fps : null,
          longestMs: typeof d.longestMs === "number" ? d.longestMs : 0,
          loadMs: typeof d.loadMs === "number" ? d.loadMs : null,
          errors,
          warnings: strs(d.warnings),
          errorCount: typeof d.errorCount === "number" ? d.errorCount : errors.length,
          warningCount: typeof d.warningCount === "number" ? d.warningCount : 0,
          lowFps: d.lowFps === true,
        });
        // The drawer opens only from the red pill (owner: "that panel is annoying
        // af"); the ticker line and Ares still get every error.
        if (typeof d.fps === "number") setFpsHistory((h) => [...h.slice(-39), d.fps as number]);
        if (errors.length > 0) logForge(errors[errors.length - 1]!, "error");
        else if (typeof d.loadMs === "number") logForge(`page loaded in ${d.loadMs}ms`, "good");
        else if (d.lowFps === true && typeof d.fps === "number") logForge(`frame rate ${d.fps} fps — dropping frames`, "warn");
        if (typeof d.loadMs === "number") { setLiveLoading(false); setLiveLoadedAt(Date.now()); }
        return;
      }
      // Auto-refresh: an edit under the served folder reloads the Live tab
      // (debounced, so a burst of edits is one reload). The load-error strip
      // belongs to the previous load, so it clears with the reload.
      if (ev.type === "tool_end" && servedRootRef.current && Array.isArray(ev.touchedFiles) && ev.touchedFiles.length > 0) {
        const root = servedRootRef.current.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "") + "/";
        const touched = ev.touchedFiles.some((f) => typeof f === "string" && f.replace(/\\/g, "/").toLowerCase().startsWith(root));
        if (touched && Date.now() - forgeDrivenAt.current < 120_000) {
          // Ares is working IN this page this turn: reloading after every edit
          // loaded half-applied changes between two edits and fed their errors
          // back to it. Its next action on the page reloads it first (the
          // page driver checks for changed files); the owner's view refreshes
          // when the turn ends.
          forgeReloadPending.current = true;
          const edited = (ev.touchedFiles ?? []).map((f) => String(f).split(/[\\/]/).pop()).filter(Boolean);
          logForge(`Ares edited ${edited.slice(0, 2).join(", ")}${edited.length > 2 ? ` +${edited.length - 2}` : ""} — refreshes when it looks again`, "info");
        } else if (touched) {
          if (liveRefreshTimer.current !== null) window.clearTimeout(liveRefreshTimer.current);
          liveRefreshTimer.current = window.setTimeout(() => {
            liveRefreshTimer.current = null;
            setLiveRevision((n) => n + 1);
            setLiveConsole((c) => (c && c.errors.length ? { ...c, errors: [] } : c));
            const edited = (ev.touchedFiles ?? []).map((f) => String(f).split(/[\\/]/).pop()).filter(Boolean);
            logForge(`Ares edited ${edited.slice(0, 2).join(", ")}${edited.length > 2 ? ` +${edited.length - 2}` : ""} — reloading`, "info");
            setForge((f) => (f.open && f.tab === "live" ? f : { ...f, open: true, tab: "live" }));
          }, 350);
        }
      }
      if (ev.type === "tool_progress" && ev.data?.kind === "browser_target" && typeof ev.data.url === "string") {
        // A page Ares just finished writing, right after the Forge showed it building live, opens already
        // settled (?settled=1) so it does not replay the build; and the live stage (embedded) steps aside.
        const handedOff = (ev.data as { mode?: unknown }).mode === "explain" && liveExplain.handoff();
        setEmbeddedActive(false);
        const target = { url: handedOff ? `${ev.data.url}${ev.data.url.includes("?") ? "&" : "?"}settled=1` : ev.data.url, title: typeof ev.data.title === "string" ? ev.data.title : "", at: Date.now(), driven: (ev.data as { driven?: unknown }).driven === true };
        setLiveTarget(target);
        setLiveUrl(target.url);
        setForgeMode((ev.data as { mode?: unknown }).mode === "explain" ? "explain" : "project");
        setLiveConsole((c) => (c && c.url === target.url ? c : null));
        setFpsHistory([]);
        setForgeDrawer(null);
        if (target.url !== "about:blank") logForge(`opened ${target.url.replace(/^https?:\/\//, "")}`, "info");
        setForge((f) => (f.open && f.tab === "live" ? f : { ...f, open: true, tab: "live" }));
        // Do not return: the progress event also belongs in the running tool's
        // activity stream, so the transcript and Forge stay in sync.
      }
      // Embedded-browser command from the daemon — drive Ares's in-app browser and
      // return the result over the same channel. This is the request/response
      // bridge that lets the agent operate its own embedded browser.
      if ((ev as { type?: string }).type === "webview_cmd") {
        const c = ev as unknown as { cmdId?: string; op?: string; html?: string; query?: string; selector?: string; value?: string; js?: string; onlyErrors?: boolean; explainer?: boolean };
        void (async () => {
          let ok = true, result: unknown, error: string | undefined;
          try {
            if (c.op === "load") {
              setEmbeddedActive(true);
              setForge((f) => ({ ...f, open: true, tab: "live" }));
              setForgeMode(c.explainer ? "explain" : "project");
              logForge(c.explainer ? "Ares is showing you something" : "Ares loaded a page", "info");
              let h = embeddedRef.current;
              for (let i = 0; i < 40 && !h; i++) { await new Promise((r) => setTimeout(r, 33)); h = embeddedRef.current; }
              if (!h) throw new Error("embedded browser unavailable");
              result = await h.load(c.explainer && liveExplain.handoff() ? settledKitPage(c.html ?? "") : (c.html ?? ""));
            } else {
              const h = embeddedRef.current;
              if (!h) throw new Error("nothing loaded — call load first");
              if (c.op === "click") result = await h.click(c.query ?? "");
              else if (c.op === "type") result = await h.type(c.selector ?? "", c.value ?? "");
              else if (c.op === "eval") result = await h.evalJs(c.js ?? "");
              else if (c.op === "console") result = h.getConsole(c.onlyErrors);
              else if (c.op === "snapshot") result = h.snapshot();
              else throw new Error(`unknown webview op: ${c.op}`);
            }
          } catch (err) { ok = false; error = err instanceof Error ? err.message : String(err); }
          if (native) void invoke("ares_daemon_command", { command: { type: "webview_result", cmdId: c.cmdId, ok, result, error } }).catch(() => {});
        })();
        return;
      }
      // Ares restyling its own working effect: the SetUiEffect tool's whole
      // implementation is this hook — the daemon-side tool just validates and
      // returns ok, and the UI applies + persists the accent when the call
      // streams through. Clamped hard so a wild model can't strobe anything:
      // hue is a palette rotation, speed picks among three slow ring periods.
      if (buffered.event.type === "tool_start" && buffered.event.name === "SetUiEffect") {
        const raw = (buffered.event.input ?? {}) as { hue?: unknown; speed?: unknown; label?: unknown };
        const hue = typeof raw.hue === "number" && Number.isFinite(raw.hue) ? ((Math.round(raw.hue) % 360) + 360) % 360 : undefined;
        const speed = raw.speed === "calm" || raw.speed === "brisk" || raw.speed === "steady" ? raw.speed : undefined;
        const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 24) : undefined;
        const p: Prefs = { ...prefsRef.current, uiEffect: { ...prefsRef.current.uiEffect, hue, speed: speed ?? prefsRef.current.uiEffect?.speed ?? "steady", label } };
        setPrefs(p);
        savePrefs(p);
      }
      const fold = (s: SessionVm) => {
        const next = foldEvent(s, buffered.event);
        if (next.title === "New session") {
          const firstUser = next.items.find((i) => i.kind === "user");
          if (firstUser && firstUser.kind === "user") next.title = compact(firstUser.text, 42);
        }
        return next;
      };
      // Modern turn events are tagged. Legacy/daemon-global events are pinned
      // to the bootstrap card instead of whichever session the owner is viewing.
      const owner = sid ?? primarySessionRef.current;
      if (owner) applyTo(owner, fold);
      else pushLog(`[routing] quarantined unowned event ${buffered.event.type}`);
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
        const state = await invoke<DaemonStatus>("ares_start_daemon", { provider: prefsRef.current.provider, model: prefsRef.current.model });
        if (!mounted) return;
        setDaemon(state.running ? "running" : "stopped");
        // Reload survival (F5 / webview crash): an already-running daemon
        // returns its status without re-emitting daemon_ready, and daemon_ready
        // is the only place that asked for sessions_list — so a reload booted an
        // EMPTY rail while every session sat safe on disk. Hydrate explicitly.
        // The sessions_list handler merges by id, so the duplicate request on a
        // fresh spawn (where daemon_ready also fires) is harmless.
        if (state.running) {
          // Agents, rooms and the people directory hydrate here too: they were
          // only requested on daemon_ready, so a refresh showed no agents and an
          // unclaimed username even though both sat on disk (owner, 2026-10-20).
          for (const type of ["agents_list", "rooms_list", "sessions_list", "directory_status", "workspaces_list", "jobs_list", "agents_sharing", "operator_status", "oauth_status", "startup_recovery_mode", "ollama_usage", "provider_usage", "pointmaps_list", "mcp_catalog"]) {
            void invoke("ares_daemon_command", { command: { type } }).catch(() => null);
          }
          void invoke("ares_daemon_command", {
            command: { type: "background_list", sessionId: activeRef.current || undefined },
          }).catch(() => null);
        }
      } catch (err) {
        if (!mounted) return;
        setDaemon("error");
        apply((s) => foldEvent(s, { type: "desktop_error", text: String(err) }));
      }
      // A touch longer so the boot can play its full three-beat ignition + a
      // forge-bloom exit (Boot owns the exit anim; this is the hard unmount).
      window.setTimeout(() => mounted && setBootGone(true), 2150);
      void poll();
      // The push listener (ares:event-buffered) carries events in real time;
      // this poll is just a slow reconciliation net for any missed push, so it
      // runs every 4s instead of hammering every 1s (B5 — lower idle CPU).
      poller = window.setInterval(() => void poll(), 4000);
    };
    void boot();
    return () => {
      mounted = false;
      if (poller !== null) window.clearInterval(poller);
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  // autoscroll ONLY when the user is already near the bottom — reading history
  // mid-stream never yanks them down. A "jump to latest" pill appears otherwise.
  const [pinned, setPinned] = useState(true);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !pinned) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [active?.items, pinned]);

  const onChatScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setPinned(nearBottom);
  }, []);
  // Transcript window: long sessions used to mount EVERY item forever — the
  // 4.8GB WebView2 renderer leak. Only the newest window stays mounted; the
  // "show earlier" control walks back in slabs. Reset per session card.
  const [transcriptCap, setTranscriptCap] = useState(TRANSCRIPT_WINDOW);
  useEffect(() => {
    setTranscriptCap(TRANSCRIPT_WINDOW);
  }, [active?.id]);
  const jumpToLatest = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
  }, []);

  // ── intents ──────────────────────────────────────────────────────────────
  const send = useCallback((text: string, opts?: { voice?: boolean; images?: string[] }): boolean => {
    const trimmed = text.trim();
    const images = (opts?.images ?? []).filter((u) => u.startsWith("data:image/"));
    if (!trimmed && images.length === 0) return false;
    // Barge-in: sending a new message cuts any reply still being spoken, and
    // resets the spoken buffer so the next turn starts clean.
    voiceRef.current.stop();
    resetSpokenStream();
    if (/^\/selftest$/i.test(trimmed)) {
      daemonCmd({ type: "selftest", sessionId: activeRef.current });
      return true;
    }
    // "/remember <text>": pin it into long-term memory instead of sending.
    const remember = /^\/remember\s+([\s\S]+)$/i.exec(trimmed);
    if (remember) {
      daemonCmd({ type: "memory_pin", sessionId: activeRef.current, text: remember[1] });
      return true;
    }
    // Slash command: "/mcp" (or /connectors) opens the connector Directory
    // instead of sending a message — the one-word way in the user asked for.
    if (/^\/(mcp|connectors?)$/i.test(trimmed)) {
      setDirectoryOpen(true);
      daemonCmd({ type: "mcp_list" });
      return true;
    }
    const sid = activeRef.current;
    // No talking to Ares directly: a chat with no agent takes no messages.
    if (!chatHasAgentRef.current(sid)) return false;
    if (
      stoppingSessionsRef.current.has(sid) ||
      sessionsRef.current.find((session) => session.id === sid)?.cancelling
    ) return false;
    // ULTRA posture: steer the agent toward the Conductor fleet for this turn.
    // Prepended to the GOAL the daemon receives (provider-agnostic) but NOT shown
    // in the transcript — the user's message stays clean.
    const ultraDirective = prefsRef.current.ultra
      ? "[ULTRA MODE — fleet by default] Run this task as a parallel agent FLEET unless it is trivial or purely conversational (a one-line answer, a single tiny edit, a greeting). Your FIRST move should be the Conductor tool: author a FleetSpec that fans out the independent angles, then reduce:\"judge\" to synthesize — do NOT do it as one linear pass and do NOT hand-roll what a fleet should do. Any task with research, multi-file or multi-angle review, design options, audits, refactors, or broad sweeps QUALIFIES — when in doubt, spawn the fleet. If you genuinely cannot decompose it, say so in one line, then proceed normally.\n\n---\n\n"
      : "";
    // Images ride along to the daemon appended to the goal (its
    // contentFromUserInput parses data:image URLs into image blocks), but are
    // stored on the item separately so the bubble renders thumbnails.
    const imagePart = images.length ? "\n" + images.join("\n") : "";
    const goal = ultraDirective + trimmed + imagePart;
    const inputId = `input_${crypto.randomUUID()}`;
    applyTo(sid, (s) => ({
      ...s,
      title: s.title === "New session" ? compact(trimmed || "image", 42) : s.title,
      items: [...s.items, { kind: "user", key: nextKey(), inputId, text: trimmed, images: images.length ? images : undefined }],
      busy: true,
    }));
    if (native) {
      if (daemon !== "running") {
        pendingGoal.current = {
          goal,
          sessionId: sid,
          voice: opts?.voice === true,
          inputId,
          draftText: trimmed,
          images: images.length ? [...images] : undefined,
        };
        applyTo(sid, (s) => foldEvent(s, { type: "system_reminder_injected", source: "verifier", text: "Garrison is down — restarting, your message is queued." }));
        restartDaemon();
        return true;
      }
      void invoke("ares_send", { goal, sessionId: sid, voice: opts?.voice === true, inputId }).catch((err) => {
        pendingGoal.current = {
          goal,
          sessionId: sid,
          voice: opts?.voice === true,
          inputId,
          draftText: trimmed,
          images: images.length ? [...images] : undefined,
        };
        applyTo(sid, (s) => ({ ...foldEvent(s, { type: "desktop_error", text: `${String(err)} — restarting the Garrison, message queued.` }), busy: true }));
        restartDaemon();
      });
    } else {
      const settleDemo = (event: AresEvent) => apply((s) =>
        foldEvent(foldEvent(s, event), { type: "turn_settled" }),
      );
      window.setTimeout(() => apply((s) => foldEvent(s, { type: "turn_start" })), 150);
      // Demo mode shows the delegation CHOICE popup when asked which coder to use.
      if (/should i|which coder|use claude code or|do it yourself/i.test(trimmed)) {
        window.setTimeout(() => apply((s) => foldEvent(s, { type: "permission_request", id: "demo-offer", toolName: "CodingBackend:offer", reason: "Hand this to Claude Code (runs on your Ares account — no login needed), or have Ares do it directly?" })), 400);
        window.setTimeout(() => settleDemo({ type: "turn_end", status: "completed", durationMs: 600, usage: { inputTokens: 500, outputTokens: 0 } }), 700);
        return true;
      }
      // Demo mode shows the delegation cut-scene when the message mentions a
      // backend — so the feature is visible without a daemon (and demoable).
      if (/claude code|codex|delegate/i.test(trimmed)) {
        const backend = /codex/i.test(trimmed) ? "codex" : "claude";
        const label = backend === "codex" ? "Codex" : "Claude Code";
        const cb = (data: Record<string, unknown>, t: number) =>
          window.setTimeout(() => apply((s) => foldEvent(s, { type: "tool_progress", id: "demo-cb", data: { kind: "coding_backend", backend, label, ...data } })), t);
        cb({ phase: "detect" }, 300);
        cb({ phase: "running", version: "1.0.0" }, 1400);
        cb({ phase: "running", line: '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/mod.lua"}}]}}' }, 2500);
        cb({ phase: "running", line: '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"src/hud.lua"}}]}}' }, 3600);
        cb({ phase: "done", filesTouched: 2 }, 4800);
        const reply = `Demo — I delegated to ${label} on the Ares account. In the installed app this drives the real CLI, no login needed.`;
        window.setTimeout(() => apply((s) => foldEvent(s, { type: "text_delta", text: reply })), 5100);
        window.setTimeout(() => settleDemo({ type: "turn_end", status: "completed", durationMs: 5400, usage: { inputTokens: 4000, outputTokens: 300 } }), 5400);
        return true;
      }
      // ULTRA in demo mode shows a sample fleet so the board is visible without a daemon.
      if (prefsRef.current.ultra) {
        const fa = (data: Record<string, unknown>, t: number) =>
          window.setTimeout(() => apply((s) => foldEvent(s, { type: "tool_progress", id: "demo-fleet", data })), t);
        const crew = [
          { id: "a1", role: "correctness", phase: "review" },
          { id: "a2", role: "security", phase: "review" },
          { id: "a3", role: "performance", phase: "review" },
        ];
        crew.forEach((c, i) => {
          fa({ kind: "fleet_activity", event: "start", agentId: c.id, role: c.role, phase: c.phase }, 300 + i * 250);
          fa({ kind: "fleet_activity", event: "tool", agentId: c.id, role: c.role, phase: c.phase, tool: "Grep", activity: "scanning the diff" }, 1200 + i * 350);
          fa({ kind: "fleet_activity", event: "done", agentId: c.id, role: c.role, phase: c.phase, status: "completed" }, 3200 + i * 600);
        });
        fa({ kind: "fleet_activity", event: "start", agentId: "judge", role: "review-judge", phase: "review" }, 5200);
        fa({ kind: "fleet_activity", event: "done", agentId: "judge", role: "review-judge", phase: "review", status: "completed" }, 6400);
        const reply = "Demo fleet complete — 3 reviewers fanned out, one judge synthesized. In the installed app this is a real Conductor run.";
        window.setTimeout(() => apply((s) => foldEvent(s, { type: "text_delta", text: reply })), 6700);
        window.setTimeout(() => settleDemo({ type: "turn_end", status: "completed", durationMs: 7000, usage: { inputTokens: 9000, outputTokens: 600 } }), 7000);
        return true;
      }
      const reply = "Demo mode — no daemon attached. In the installed app this streams from the Garrison.";
      reply.split(" ").forEach((word, i) => {
        window.setTimeout(() => {
          pushTokenFlow(word.length + 1); // demo mode still animates the token-flow strip
          apply((s) => foldEvent(s, { type: "text_delta", text: `${word} ` }));
        }, 300 + i * 40);
      });
      window.setTimeout(
        () => settleDemo({ type: "turn_end", status: "completed", durationMs: 1400, usage: { inputTokens: 220, outputTokens: 18 } }),
        400 + reply.split(" ").length * 40,
      );
    }
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, daemon, applyTo]);
  // Conversation mode auto-sends the recognized transcript through the same path.
  sendRef.current = send;

  // An avatar option was tapped: picking is the approval. Set it, then tell
  // the agent so it can answer in character.
  useEffect(() => {
    const onPick = (ev: Event) => {
      const { agentId, path, n } = (ev as CustomEvent<{ agentId: string; path: string; n: number }>).detail;
      void (async () => {
        try {
          const blob = await (await fetch(convertFileSrc(path))).blob();
          const image = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          await daemonCmd({ type: "agent_avatar_set", agentId, image });
          sendRef.current?.(`I picked option ${n} — it's your face now.`);
        } catch (err) {
          console.warn("[ares] avatar pick failed", err);
        }
      })();
    };
    window.addEventListener("ares:avatar-pick", onPick);
    return () => window.removeEventListener("ares:avatar-pick", onPick);
  }, []);

  /** Steer: queue a message mid-turn; the daemon folds it in at a safe boundary. */
  const steer = useCallback((text: string, images?: string[]) => {
    const trimmed = text.trim();
    const imgs = (images ?? []).filter((u) => u.startsWith("data:image/"));
    if (!trimmed && imgs.length === 0) return false;
    const sid = activeRef.current;
    if (
      stoppingSessionsRef.current.has(sid) ||
      sessionsRef.current.find((session) => session.id === sid)?.cancelling
    ) return false;
    const inputId = `steer_${crypto.randomUUID()}`;
    applyTo(sid, (s) => ({
      ...s,
      items: [...s.items, {
        kind: "steer",
        key: nextKey(),
        inputId,
        text: trimmed,
        images: imgs.length ? imgs : undefined,
        status: "submitting",
      }],
      steerQueued: (s.steerQueued ?? 0) + 1,
    }));
    const steerText = steerReplayWireText({ text: trimmed, images: imgs });
    if (native) {
      if (daemon !== "running") {
        // Keep the bubble unresolved. daemon_ready will claim it from session
        // state and submit its original ID and attachments once this epoch boots.
        restartDaemon();
        return true;
      }
      markSteerSentInEpoch(steerReplayEpoch.current, sid, inputId);
      void invoke("ares_daemon_command", {
        command: { type: "steer", text: steerText, sessionId: sid, inputId },
      }).catch((error) => {
        // The write may already be canonical in SQLite even though IPC lost its
        // acknowledgement. Leave the bubble nonterminal and replay the same ID
        // after restart instead of manufacturing a rejected/restored duplicate.
        pushLog(`[garrison] steer ${inputId} lost transport: ${String(error)}`);
        restartDaemon();
      });
    }
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, daemon, applyTo, pushLog, restartDaemon]);

  const stopTurn = useCallback(() => {
    const sid = activeRef.current;
    const current = sessionsRef.current.find((session) => session.id === sid);
    if (!current?.busy) return;
    if (current.cancelling || stoppingSessionsRef.current.has(sid)) {
      // Second Stop = escalation, not a no-op. The daemon force-kills whatever
      // the turn is blocked on once the grace window has passed (and reports
      // the countdown until then). This path used to be unreachable — every
      // Stop control disabled itself the moment the first Stop landed, so a
      // turn that never settled left "stopping safely" up with no way out.
      if (native && daemon === "running") {
        void invoke("ares_interrupt", { sessionId: sid }).catch(() => null);
      }
      return;
    }
    const localPending = pendingGoal.current?.sessionId === sid ? pendingGoal.current : null;
    if (native && daemon !== "running" && localPending) {
      // No daemon owns this input yet, so Stop is a local, exact cancellation.
      // Revoke the restart buffer before any ready event can observe it, then
      // restore only the user's clean text/images (never the hidden ULTRA wire
      // directive) to the composer.
      pendingGoal.current = null;
      applyTo(sid, (s) => foldEvent(s, {
        type: "desktop_pending_input_cancelled",
        inputId: localPending.inputId,
        text: localPending.draftText,
        images: localPending.images,
      }));
      return;
    }
    stoppingSessionsRef.current.add(sid);
    // Stop is a two-phase settlement: keep the input editable, but do not allow
    // a new send/steer until the daemon confirms its owning generator released.
    applyTo(sid, (s) => ({
      ...s,
      busy: true,
      cancelling: true,
      activity: "stopping safely",
    }));
    if (native) {
      void invoke("ares_interrupt", { sessionId: sid }).catch((error) => {
        stoppingSessionsRef.current.delete(sid);
        applyTo(sid, (s) => ({
          ...foldEvent(s, { type: "desktop_error", text: `Could not stop the turn: ${String(error)}` }),
          busy: false,
          cancelling: false,
        }));
      });
    } else {
      stoppingSessionsRef.current.delete(sid);
      applyTo(sid, (s) => foldEvent(
        foldEvent(s, { type: "turn_end", status: "interrupted", durationMs: 0 }),
        { type: "interrupt_settled" },
      ));
    }
  }, [native, daemon, applyTo]);

  const undoLastChange = useCallback(() => {
    if (!native || daemon !== "running" || active?.busy) return;
    daemonCmd({ type: "undo", sessionId: activeRef.current, depth: 1 });
  }, [active?.busy, daemon, daemonCmd, native]);

  /** Kick off the Anthropic (Claude Pro/Max) browser sign-in. */
  const startAnthropicSignIn = useCallback(() => {
    setAnthropicAuth({ open: true, status: "opening" });
    if (native) daemonCmd({ type: "anthropic_login_start" });
    else setAnthropicAuth({ open: true, status: "error", error: "sign-in needs the daemon (installed app)." });
  }, [native, daemonCmd]);

  const startOpenaiSignIn = useCallback(() => {
    if (!native) { pushGatewayToast("ChatGPT sign-in needs the installed app."); return; }
    setOpenaiAuth((s) => ({ ...s, signingIn: true }));
    daemonCmd({ type: "openai_login_start" });
  }, [native, daemonCmd, pushGatewayToast]);

  const startKimiSignIn = useCallback(() => {
    if (!native) { pushGatewayToast("Kimi sign-in needs the installed app."); return; }
    setKimiAuth((s) => ({ ...s, signingIn: true }));
    daemonCmd({ type: "kimi_login_start" });
  }, [native, daemonCmd, pushGatewayToast]);

  // Reflect existing ChatGPT / Kimi connections when the daemon comes up.
  useEffect(() => {
    if (native && daemon === "running") {
      daemonCmd({ type: "openai_auth_status" });
      daemonCmd({ type: "kimi_auth_status" });
    }
  }, [native, daemon, daemonCmd]);

  // finishAnthropicSignIn no longer needed — loopback flow handles it automatically.

  const openSession = useCallback((id: string) => {
    setActiveId(id);
    setActiveRoomId(null);
    setView("chat");
    const target = sessions.find((session) => session.id === id);
    if (native && target && target.loaded === false && !target.loading) {
      setSessions((current) => current.map((session) => (
        session.id === id ? { ...session, loading: true } : session
      )));
      daemonCmd({ type: "session_history", id });
      daemonCmd({ type: "session_open", sessionId: id });
    }
  }, [daemonCmd, native, sessions]);

  /** Home: the sanctum. Reuse the empty card you are on, or an existing empty
   *  one, before ever creating another — clicking Home twice must not stack
   *  blank sessions in the rail. */
  const goHome = () => {
    setView("chat");
    const agentId = selectedAgentRef.current;
    const current = sessionsRef.current.find((s) => s.id === activeRef.current);
    if (current && current.items.length === 0 && !current.busy && !current.background && agentIdOf(current.id) === agentId) return;
    const spare = sessionsRef.current.find((s) => s.items.length === 0 && !s.busy && !s.background && s.loaded !== false && s.title === "New session" && agentIdOf(s.id) === agentId);
    if (spare) { openSession(spare.id); return; }
    newSession(agentId);
  };

  /** A new chat with an agent (the selected one by default). Wired straight
   *  to onClick too, so a non-string argument means "the selected agent". */
  const newSession = (agentArg?: unknown) => {
    // A new chat is just a new card — the multi-session daemon lazily spawns an
    // isolated session for it on first message. NEVER restart the daemon here
    // (that would kill every other running chat).
    let agentId = typeof agentArg === "string" ? agentArg : selectedAgentRef.current;
    if (agentId === ARES_AGENT_ID) {
      const first = agents[0]?.id;
      if (!first) { setAgentError(undefined); setAgentEditor({ mode: "create" }); return; }
      agentId = first;
    }
    // One blank chat per agent: "New chat" on an agent that already has an
    // untouched card opens that card instead of stacking another "New
    // session" row (owner, 2026-10-23: "fix it spamming new chats").
    const blank = sessionsRef.current.find((s) => agentIdOf(s.id) === agentId && !s.background && !roomSeatIds.has(s.id) && s.items.length === 0 && s.title === "New session" && !s.busy);
    if (blank) {
      openSession(blank.id);
      return;
    }
    const fresh = freshSession();
    if (agentId !== ARES_AGENT_ID) {
      // Bound BEFORE the first send: the daemon builds the session on the
      // agent's brain, memory scope and prompt layer from its first turn.
      setLocalAgentBindings((current) => ({ ...current, [fresh.id]: agentId }));
      daemonCmd({ type: "agent_bind", agentId, sessionId: fresh.id });
    }
    setSessions((prev) => [fresh, ...prev]);
    openSession(fresh.id);
  };

  const requestAgentCatalog = useCallback((provider: string) => daemonCmd({ type: "model_catalog", provider }), [daemonCmd]);

  // Opening a chat (search, a notification, a text landing) follows its agent.
  useEffect(() => {
    const owner = agentIdOf(activeId);
    if (activeId && owner !== selectedAgentRef.current) {
      setSelectedAgentIdState(owner);
      selectedAgentRef.current = owner;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, sessionAgentMap]);

  /** Pick an agent in the rail: their newest chat opens (or a fresh one). */
  const selectAgent = (agentId: string) => {
    setActiveRoomId(null);
    setSelectedAgentIdState(agentId);
    selectedAgentRef.current = agentId;
    try { window.localStorage.setItem("ares.agent.selected", agentId); } catch { /* private mode */ }
    setAgentUnread((u) => u.filter((id) => id !== agentId));
    if (agentIdOf(activeRef.current) === agentId && view === "chat") return;
    // Never a room seat: that is the agent's private thread for a room, reached from the room.
    const theirs = sessionsRef.current.find((s) => !roomSeatIds.has(s.id) && agentIdOf(s.id) === agentId && (agentId !== ARES_AGENT_ID || !s.background));
    if (theirs) openSession(theirs.id);
    else newSession(agentId);
  };

  // Opening an agent's profile loads what it remembers on its own.
  useEffect(() => {
    if (agentEditor?.mode !== "edit") return;
    if (native) daemonCmd({ type: "agent_memory", agentId: agentEditor.id });
    else setAgentMemory((m) => (m[agentEditor.id] ? m : { ...m, [agentEditor.id]: demoAgentMemory(agentEditor.id) }));
  }, [agentEditor, native, daemonCmd]);

  const memoryAction = (agentId: string, command: Record<string, unknown>, demoNote: string) => {
    setAgentMemory((m) => ({ ...m, [agentId]: { ...(m[agentId] ?? { total: 0, items: [] }), busy: true, note: undefined } }));
    if (native) daemonCmd({ agentId, ...command });
    else setAgentMemory((m) => ({ ...m, [agentId]: { ...(m[agentId] ?? { total: 0, items: [] }), busy: false, note: demoNote } }));
  };

  // An agent made from the sheet opens straight into a chat with them.
  useEffect(() => {
    const id = pendingAgentChat.current;
    if (!id || !agents.some((a) => a.id === id)) return;
    pendingAgentChat.current = null;
    selectAgent(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  const saveAgent = (draft: AgentDraft) => {
    setAgentError(undefined);
    const payload = { name: draft.name, emoji: draft.emoji, color: draft.color, provider: draft.provider, model: draft.model, chatModel: draft.chatModel.trim(), workspaceId: draft.workspaceId, reasoningLevel: draft.effort, instructions: draft.instructions, rules: draft.rules.split(/\r?\n/).map((r) => r.trim()).filter(Boolean) };
    const setPhotoLocal = (id: string, photo: string) =>
      setAgentPhotos((p) => {
        const n = { ...p };
        if (photo) n[id] = photo;
        else delete n[id];
        return n;
      });
    if (!native) {
      // Browser preview: no daemon — keep the directory in memory.
      if (agentEditor?.mode === "edit") {
        setAgents((current) => current.map((a) => (a.id === agentEditor.id ? { ...a, ...payload } : a)));
        if (draft.photo !== undefined) setPhotoLocal(agentEditor.id, draft.photo);
      } else {
        const id = `p_demo${Math.random().toString(16).slice(2, 10)}`;
        setAgents((current) => [...current, { id, ...payload, threads: [], createdAt: new Date().toISOString() }]);
        if (draft.photo) setPhotoLocal(id, draft.photo);
        pendingAgentChat.current = id;
      }
      setAgentEditor(null);
      return;
    }
    if (agentEditor?.mode === "edit") {
      daemonCmd({ type: "agent_update", agentId: agentEditor.id, agent: payload });
      if (draft.photo !== undefined) {
        daemonCmd({ type: "agent_avatar_set", agentId: agentEditor.id, image: draft.photo || null });
        setPhotoLocal(agentEditor.id, draft.photo);
      }
    } else {
      pendingAgentPhoto.current = draft.photo || null;
      daemonCmd({ type: "agent_create", agent: payload });
    }
  };

  const deleteAgent = (id: string) => {
    if (!native) {
      setAgents((current) => current.filter((a) => a.id !== id));
      setAgentEditor(null);
      if (selectedAgentRef.current === id) selectAgent(ARES_AGENT_ID);
      return;
    }
    daemonCmd({ type: "agent_delete", agentId: id });
  };

  const toggleRail = useCallback(() => {
    setRailCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("ares.rail.collapsed", next ? "1" : "0");
      return next;
    });
  }, []);

  /** A Connect card's button: OAuth and open servers connect right here;
   *  key-based ones open the directory with the URL filled in. */
  const connectService = (card: { key: string; id: string; name: string; url: string; auth: string }) => {
    if (card.auth === "key") {
      setDirectoryPrefill({ url: card.url, name: card.id });
      setDirectoryOpen(true);
      return;
    }
    setSessions((prev) => prev.map((sess) => ({ ...sess, items: sess.items.map((it) => (it.kind === "connect" && it.key === card.key ? { ...it, state: "connecting" as const } : it)) })));
    setMcpConnecting(card.url);
    daemonCmd({ type: "mcp_connect", url: card.url, name: card.id });
  };
  const dismissConnect = (key: string) => {
    setSessions((prev) => prev.map((sess) => ({ ...sess, items: sess.items.filter((it) => !(it.kind === "connect" && it.key === key)) })));
  };
  const respondPermission = (id: string, decision: string) => {
    // Route the answer to the session that actually raised this prompt (B4) —
    // a permission request from a background chat must never resolve into
    // whatever card happens to be focused now.
    const owner = sessionsRef.current.find((s) => s.items.some((it) => it.kind === "permission" && it.id === id));
    const ownerId = owner?.id ?? activeRef.current;
    const prompt = owner?.items.find((it) => it.kind === "permission" && it.id === id);
    if (prompt?.kind === "permission" && (prompt.decided || prompt.submitting)) return;
    if (!native) {
      applyTo(ownerId, (s) => foldEvent(s, { type: "permission_response", id, decision }));
      return;
    }
    if (permissionSubmissionLocks.current.has(id)) return;
    permissionSubmissionLocks.current.add(id);
    // Disable duplicate clicks while the bridge write is in flight, but do not
    // mark the prompt decided until QueryEngine emits its real response event.
    // A failed IPC write re-enables the exact card instead of parking an
    // invisible daemon waiter forever.
    applyTo(ownerId, (s) => foldEvent(s, { type: "permission_submission_started", id, decision }));
    void invoke("ares_permission_response", { id, decision }).catch((error) => {
      permissionSubmissionLocks.current.delete(id);
      applyTo(ownerId, (s) => foldEvent(s, { type: "permission_submission_failed", id, decision, error }));
    });
  };

  const applySettings = (next: Prefs, keys: Record<string, string>) => {
    setPrefs(next);
    savePrefs(next);
    setSettingsOpen(false);
    if (!native) return;
    const applyLive = async () => {
      // Persist settings through the live daemon. Normal preferences must not
      // kill in-memory sessions or force a transcript restore.
      for (const [provider, key] of Object.entries(keys)) {
        if (!key.trim()) continue;
        await invoke("ares_set_provider_key", {
          provider,
          key: key.trim(),
          model: provider === next.provider ? next.model : null,
        }).catch(() => null);
      }
      if (Object.keys(next.routing).length > 0 || Object.keys(prefs.routing).length > 0) {
        await invoke("ares_set_routing", { routing: next.routing }).catch(() => null);
      }
      await invoke("ares_daemon_command", {
        command: { type: "routing_mode", enabled: next.routingMode === "auto" },
      }).catch(() => null);
      await invoke("ares_daemon_command", { command: { type: "engine_config", config: next.engine } }).catch(() => null);
      await invoke("ares_set_reasoning", { level: next.reasoning }).catch(() => null);
      if (next.provider !== prefs.provider || next.model !== prefs.model) {
        await invoke("ares_daemon_command", {
          command: { type: "model_switch", provider: next.provider, model: next.model, sessionId: activeRef.current },
        }).catch(() => null);
      }
    };
    void applyLive();
  };

  const chooseReasoning = (level: ReasoningLevel) => {
    const next = { ...prefs, reasoning: level };
    setPrefs(next);
    savePrefs(next);
    if (native) void invoke("ares_set_reasoning", { level }).catch((err) => {
      apply((s) => foldEvent(s, { type: "desktop_error", text: `effort change failed: ${String(err)}` }));
    });
  };

  const EFFECT_MODES: Prefs["flameMode"][] = ["glow", "minimal", "off"];
  const cycleFlame = () => {
    const next = EFFECT_MODES[(EFFECT_MODES.indexOf(prefs.flameMode) + 1) % EFFECT_MODES.length];
    const p = { ...prefs, flameMode: next };
    setPrefs(p);
    savePrefs(p);
  };

  const setVoiceEnabled = (on: boolean) => {
    const p = { ...prefs, voiceEnabled: on };
    setPrefs(p); savePrefs(p);
    if (!on) { setConvoMode(false); voiceRef.current.stop(); resetSpokenStream(); }
  };
  const setWakeWord = (on: boolean) => {
    const p = { ...prefs, wakeWord: on };
    setPrefs(p); savePrefs(p);
  };

  // ── Read-aloud selection: select reply text → a floating 🔊 Speak button ──
  const [readAloud, setReadAloud] = useState<{ x: number; y: number; text: string } | null>(null);
  useEffect(() => {
    const onMouseUp = () => {
      // Defer a tick so the selection is final before we read it.
      window.setTimeout(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim() ?? "";
        if (!sel || !text || text.length < 8 || sel.rangeCount === 0) { setReadAloud(null); return; }
        // Only offer it for selections inside the chat transcript.
        const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
        if (!anchor?.closest(".chat")) { setReadAloud(null); return; }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        setReadAloud({
          x: Math.min(window.innerWidth - 110, Math.max(8, rect.left + rect.width / 2 - 40)),
          y: Math.max(8, rect.top - 38),
          text: text.slice(0, 4000),
        });
      }, 0);
    };
    const dismiss = () => setReadAloud(null);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, []);
  // Fetch skills for the tray whenever the daemon attaches.
  useEffect(() => { if (native) daemonCmd({ type: "skills_list" }); }, [native, daemonCmd]);
  const [skillToast, setSkillToast] = useState<{ name: string; text: string; ok: boolean } | null>(null);
  const runSurface = (skill: SkillInfo, surface: SkillSurface) => {
    setSkillToast({ name: skill.name, text: `Running ${surface.label}…`, ok: true });
    void skillInvoke(skill.name, surface.input ?? { op: surface.id }).then((r) => {
      const result = r.result as { audio?: string; mime?: string; message?: string } | string | undefined;
      if (r.ok && result && typeof result === "object" && result.audio) {
        voiceRef.current.playAudio(result.audio, result.mime);
      }
      const text = r.ok
        ? (typeof result === "string" ? result : result?.message ?? (result?.audio ? `${surface.label} playing` : `${surface.label} done`))
        : (r.error ?? "failed");
      setSkillToast({ name: skill.name, text: String(text).slice(0, 160), ok: r.ok });
      window.setTimeout(() => setSkillToast(null), 4000);
    });
  };

  // ── the Forge ─────────────────────────────────────────────────────────────
  const [sandboxCode, setSandboxCode] = useState(SANDBOX_SEED);
  const [sandboxSrc, setSandboxSrc] = useState<{ src?: string; srcdoc?: string; path?: string } | null>(null);
  const [holoSrc, setHoloSrc] = useState<{ src?: string; srcdoc?: string; path?: string } | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  // A markdown artifact becomes a rendered document in the Artifacts tab.
  useEffect(() => {
    const p = forge.artifact?.path;
    if (!p || !/\.(md|markdown)$/i.test(p)) { setForgeDoc(null); return; }
    let alive = true;
    (async () => {
      try {
        const raw = native ? await invoke<string>("ares_read_text_file", { path: p }) : "# Document\n\nMarkdown artifacts render here in the desktop app.";
        if (alive) setForgeDoc({ path: p, html: renderMarkdown(raw) });
      } catch (err) {
        if (alive) setForgeDoc({ path: p, html: `<p>Could not read ${p}: ${String(err)}</p>` });
      }
    })();
    return () => { alive = false; };
  }, [forge.artifact?.path, previewRevision, native]);

  const [holoMeta, setHoloMeta] = useState<string>("MECH MK I — built-in showpiece");

  /** Render an agent-forged HoloSpec through the real holotable engine. */
  const openHoloSpec = useCallback(
    async (path: string, label: string) => {
      try {
        const raw = native ? await invoke<string>("ares_read_text_file", { path }) : "";
        const spec = JSON.parse(raw) as HoloSpec;
        validateHoloSpec(spec);
        const html = buildHolotableHtml({ spec });
        if (native) {
          const out = await invoke<string>("ares_forge_write", { name: "holo-spec", html });
          setHoloSrc({ src: `${convertFileSrc(out)}?t=${Date.now()}`, path: out });
        } else {
          setHoloSrc({ srcdoc: html });
        }
        setHoloMeta(`${spec.title} — ${spec.parts.length} parts · ${spec.wires?.length ?? 0} wires · ${spec.steps?.length ?? 0} steps`);
        setForge({ open: true, tab: "holo", artifact: { path, label } });
      } catch (err) {
        apply((s) => foldEvent(s, { type: "desktop_error", text: `holotable: ${String(err instanceof Error ? err.message : err)}` }));
      }
    },
    [native, apply],
  );

  const openArtifact = (path: string, label: string) => {
    if (HOLO_SPEC_FILE.test(path)) {
      void openHoloSpec(path, label);
      return;
    }
    // A pre-built holotable HTML (filename contains "holo") belongs in the HOLO
    // section, not the flat preview — otherwise the holo panel looks redundant.
    if (/holo[\w-]*\.html?$/i.test(path)) {
      if (native) {
        setHoloSrc({ src: `${convertFileSrc(path)}?t=${Date.now()}`, path });
        setHoloMeta(label);
        setForge({ open: true, tab: "holo", artifact: { path, label } });
        return;
      }
    }
    setForge({ open: true, tab: "preview", artifact: { path, label } });
  };

  const runSandbox = useCallback(
    async (code: string) => {
      if (native) {
        try {
          const path = await invoke<string>("ares_forge_write", { name: "sandbox", html: code });
          setSandboxSrc({ src: `${convertFileSrc(path)}?t=${Date.now()}`, path });
        } catch (err) {
          apply((s) => foldEvent(s, { type: "desktop_error", text: String(err) }));
        }
      } else {
        setSandboxSrc({ srcdoc: code });
      }
    },
    [native, apply],
  );

  const igniteHolo = useCallback(async () => {
    if (holoSrc) return;
    if (native) {
      try {
        const path = await invoke<string>("ares_forge_write", { name: "holo", html: holoDefaultHtml() });
        setHoloSrc({ src: `${convertFileSrc(path)}?t=${Date.now()}`, path });
      } catch (err) {
        apply((s) => foldEvent(s, { type: "desktop_error", text: String(err) }));
      }
    } else {
      setHoloSrc({ srcdoc: holoDefaultHtml() });
    }
  }, [native, holoSrc, apply]);

  useEffect(() => {
    if (forge.open && forge.tab === "holo") void igniteHolo();
  }, [forge, igniteHolo, runSandbox, sandboxSrc]);

  // Web links in the transcript/vault are <a target="_blank">, which a Tauri
  // webview won't route to the system browser on its own. Intercept clicks and
  // hand them to the validated ares_open_url command so cited sources actually open.
  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      const anchor = (ev.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(href)) return;
      ev.preventDefault();
      void invoke("ares_open_url", { url: href }).catch(() => null);
    };
    document.addEventListener("click", onClick);
    // Ask once for OS-notification permission so background/permission alerts work.
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission().catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    return () => document.removeEventListener("click", onClick);
  }, []);

  // auto-open the Forge when an artifact lands
  const artifactCount = active?.items.filter((i) => i.kind === "artifact").length ?? 0;
  const lastArtifactCount = useRef(artifactCount);
  useEffect(() => {
    if (artifactCount > lastArtifactCount.current) {
      const latest = [...(active?.items ?? [])].reverse().find((i) => i.kind === "artifact");
      if (latest && latest.kind === "artifact") {
        setForge({ open: true, tab: "preview", artifact: { path: latest.path, label: latest.label } });
      }
    }
    lastArtifactCount.current = artifactCount;
  }, [artifactCount, active?.items]);

  const onForgeGrip = (down: React.PointerEvent) => {
    down.preventDefault();
    // Capture the pointer: without it, crossing the page preview (an iframe)
    // handed it the moves and the drag froze or dropped (owner, 2026-10-24).
    const grip = down.currentTarget as HTMLElement;
    try { grip.setPointerCapture(down.pointerId); } catch { /* old engine: window listeners still run */ }
    setForgeDragging(true);
    const startX = down.clientX;
    const startW = forgeWidth;
    // While dragging, write the width straight onto the root once per frame
    // and keep React out of it: a state update per pointer move re-rendered
    // the whole app and dropped frames (owner, 2026-10-24). The final width
    // is committed to state on release.
    const root = grip.closest(".ares") as HTMLElement | null;
    let width = startW;
    let frame = 0;
    const move = (e: PointerEvent) => {
      // Cap by what actually fits (never past the chat's min width) instead of a
      // flat 62% of the window, so dragging wide can't occlude the chat.
      width = Math.min(Math.max(startW + (startX - e.clientX), 340), maxForgeFor(window.innerWidth));
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        root?.style.setProperty("--forge-w", `${width}px`);
      });
    };
    const up = () => {
      if (frame) cancelAnimationFrame(frame);
      root?.style.setProperty("--forge-w", `${width}px`);
      setForgeWidth(width);
      setForgeDragging(false);
      try { grip.releasePointerCapture(down.pointerId); } catch { /* already released */ }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      grip.removeEventListener("lostpointercapture", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    grip.addEventListener("lostpointercapture", up);
  };

  // ── command palette (Ctrl+K) ──────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setPaletteOpen(false);
        setModelPopOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Notify themeable canvases (mermaid diagrams) so they re-tint on a war-band switch.
  useEffect(() => {
    window.dispatchEvent(new Event("ares-theme"));
  }, [prefs.theme]);

  const paletteActions: PaletteAction[] = [
    { label: "New session", hint: "fresh Garrison session", run: newSession },
    { label: "Undo last agent change", hint: "restore the latest workspace checkpoint", run: undoLastChange },
    { label: "Run self-test", hint: "check this machine for the known ways a chat can get stuck · /selftest", run: () => daemonCmd({ type: "selftest", sessionId: activeRef.current }) },
    {
      label: "Remember selection",
      hint: "pin the highlighted text into long-term memory · or type /remember …",
      run: () => {
        const recent = lastSelectionRef.current && Date.now() - lastSelectionRef.current.at < 120_000 ? lastSelectionRef.current.text : "";
        const picked = window.getSelection()?.toString().trim() || recent;
        if (picked) daemonCmd({ type: "memory_pin", sessionId: activeRef.current, text: picked });
        else apply((s) => foldEvent(s, { type: "memory_pinned", error: "highlight some text first, or type /remember followed by what to keep" }));
      },
    },
    { label: forge.open ? "Close the Forge" : "Open the Forge", hint: "one live artifact and browser canvas", run: () => setForge((f) => ({ ...f, open: !f.open })) },
    { label: "Settings", hint: "provider · model · keys", run: () => setSettingsOpen(true) },
    { label: "Connectors — the Directory", hint: "/mcp · connect tools & apps", run: () => { setDirectoryOpen(true); daemonCmd({ type: "mcp_list" }); } },
    { label: "Switch model", hint: `current: ${prefs.routingMode === "auto" ? "routing (auto)" : prefs.model}`, run: () => setModelPopOpen(true) },
    { label: "Routing — the war table", hint: "per-lane model assignments", run: () => setRoutingOpen(true) },
    { label: "Garrison: restart", hint: "bounce the daemon", run: () => { restartAttempts.current = 0; restartDaemon(); } },
    { label: "Garrison: panel", hint: "status + live log", run: () => setGarrisonOpen(true) },
    ...sessions.map((s) => ({ label: `Jump: ${s.title}`, hint: "session", run: () => openSession(s.id) })),
  ];

  // ── window chrome ─────────────────────────────────────────────────────────
  const dragWindow = (e: React.MouseEvent) => {
    if (!native || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea")) return;
    if (e.detail === 2) {
      void invoke("ares_window_toggle_maximize").catch(() => null);
    } else {
      void getCurrentWindow()
        .startDragging()
        .catch(() => null);
    }
  };

  // ── floating pill: condense Ares to an always-on-top mic bar ───────────────
  const PILL_W = 276;
  const PILL_H = 42;
  const enterPill = useCallback(async () => {
    if (native) {
      try {
        const w = getCurrentWindow();
        const [size, pos] = await Promise.all([w.outerSize(), w.outerPosition()]);
        prePillGeom.current = { size, pos };
        await w.setResizable(false);
        // Pill is a persistent desktop control, never a second minimize state.
        await w.setAlwaysOnTop(true);
        await w.setSize(new LogicalSize(PILL_W, PILL_H));
        // tuck it to the top-right of where the window was
        const sf = await w.scaleFactor();
        await w.setPosition(new PhysicalPosition(Math.round(pos.x + size.width - PILL_W * sf), pos.y));
      } catch {
        /* even if the window ops fail, still show the pill UI */
      }
    }
    setPill(true);
  }, [native]);

  const exitPill = useCallback(async () => {
    if (native) {
      try {
        const w = getCurrentWindow();
        await w.setAlwaysOnTop(false);
        await w.setResizable(true);
        const g = prePillGeom.current;
        if (g) {
          await w.setSize(g.size);
          await w.setPosition(g.pos);
        } else {
          await w.setSize(new LogicalSize(1280, 820));
        }
      } catch {
        /* ignore — UI still expands */
      }
    }
    setPill(false);
  }, [native]);

  const launchLivingSurface = useCallback(async () => {
    let sid = activeRef.current;
    if (!sid) {
      const fresh = freshSession();
      sid = fresh.id;
      setSessions((current) => [fresh, ...current]);
      setActiveId(sid);
      activeRef.current = sid;
    }
    let unlistenReady: (() => void) | null = null;
    try {
      let acknowledge: (() => void) | null = null;
      const ready = new Promise<void>((resolve) => { acknowledge = resolve; });
      if (native) {
        unlistenReady = await listen<{ sessionId?: string }>("ares:living-surface-ready", ({ payload }) => {
          if (payload?.sessionId === sid) acknowledge?.();
        });
        await invoke("ares_living_surface_open", { sessionId: sid });
        await Promise.race([
          ready,
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("Living Surface did not finish booting within 8 seconds")), 8_000)),
        ]);
      }
      livingSessionRef.current = sid;
      setSettingsOpen(false);
      await enterPill();
    } catch (error) {
      livingSessionRef.current = null;
      if (native) void invoke("ares_living_surface_close").catch(() => null);
      pushLog(`[living-surface] launch failed: ${String(error)}`);
      apply((session) => foldEvent(session, { type: "desktop_error", text: `Living Surface failed to start: ${String(error)}` }));
    } finally {
      unlistenReady?.();
    }
  }, [apply, enterPill, native, pushLog]);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen("ares:living-surface-closed", () => {
      if (disposed) return;
      livingSessionRef.current = null;
      void exitPill();
    }).then((un) => { if (disposed) un(); else unlisten = un; });
    return () => { disposed = true; unlisten?.(); };
  }, [exitPill, native]);

  const routedLanes = ROUTE_LANES.filter((l) => prefs.routing[l]);
  // The model that ACTUALLY handled this session's last turn (sticky/lane/
  // In MANUAL mode the footer is SOLID: it always shows the model the user
  // picked (prefs.model), never the per-turn model — so a one-off route or a
  // transient failover can't make the readout look like the selection changed.
  // What actually ran is still surfaced per-message (the assistant badge). In
  // auto mode the routed per-turn model IS the point, so show it there.
  // In auto mode, before a turn has resolved, fall back to the model that WOULD
  // take the next message — the chat lane's assignment, else the main model.
  // The old "routing (auto)" placeholder told the owner nothing and made the
  // chip look like a dead label ("all I see is on").
  // MANUAL mode: the footer shows the ACTIVE SESSION's pinned model. Sessions
  // deliberately keep their saved model across restarts, so the global pref
  // can differ from what a reopened card actually runs — showing the pref
  // there made the per-message badge look wrong when it was the honest one
  // (the "footer says glm, turn ran deepseek" report). One-turn detours
  // (vision/failover) still never touch sessionModel, so the readout stays
  // solid within a session.
  const liveModelId =
    prefs.routingMode === "auto"
      ? (active?.turnModel ?? prefs.routing.chat?.model ?? prefs.model)
      : (active?.sessionModel ?? prefs.model);
  /** "chat → sonnet · coding → opus-5" — the whole routing table, for the
   *  route chip's tooltip, so the mapping is legible without opening anything. */
  const routeSummary = routedLanes.length
    ? routedLanes.map((l) => `${l} → ${prefs.routing[l]?.model ?? "?"}`).join("\n")
    : "";
  // Gateway models are white-labeled: the footer chip shows the friendly name
  // ("Model Ares (in house)"), never the raw virtual id or the upstream model.
  // "ares-internal" is the house sentinel — resolve it to the crowned model's name.
  const houseModel = gatewayAccount?.models?.find((m) => m.is_house);
  const liveModel =
    liveModelId === "ares-internal"
      ? houseModel?.display_name ?? "Ares (in house)"
      : gatewayAccount?.models?.find((m) => m.id === liveModelId)?.display_name ?? liveModelId;

  // ── rail: search, pins, and the artifact vault ───────────────────────────
  const q = sessionQuery.trim().toLowerCase();
  const activeRoom = activeRoomId ? rooms.find((r) => r.id === activeRoomId) : undefined;
  const roomTypingOf = (r: RoomVm): string[] => Object.entries(r.threads).filter(([, sid]) => sessions.find((s) => s.id === sid)?.busy).map(([agentId]) => agentId);
  const roomRows: RoomRowVm[] = rooms
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .map((r) => {
      const msgs = roomMessages[r.id] ?? [];
      const last = [...msgs].reverse().find((m) => m.kind === "text") ?? msgs.at(-1);
      const mine = last && last.from.kind === "person" && (last.from.home ?? "local") === "local";
      const preview = last ? `${last.from.kind === "system" ? "" : mine ? "You: " : `${last.from.name}: `}${last.text}`.replace(/\s+/g, " ").trim() : r.purpose.trim() || "No messages yet";
      return {
        room: r,
        preview: preview.length > 72 ? preview.slice(0, 71) + "…" : preview,
        at: last?.at ?? r.updatedAt,
        unread: roomUnread.includes(r.id),
        typing: roomTypingOf(r).map((id) => r.members.find((m) => m.kind === "agent" && m.home === "local" && m.id === id)?.name ?? "").filter(Boolean),
      };
    });
  const selectRoom = (id: string) => {
    setActiveRoomId(id);
    setRoomUnread((u) => u.filter((x) => x !== id));
    setRoomError(undefined);
    setView("chat");
    setForge((current) => ({ ...current, open: false }));
    if (!roomMessages[id]) daemonCmd({ type: "room_history", roomId: id });
  };
  const railSessions = sessions.filter((s) => {
    // A room seat is an agent's private thread for that room: it is reached
    // from the room ("peek"), never listed as a chat.
    if (roomSeatIds.has(s.id)) return false;
    const owner = agentIdOf(s.id);
    if (owner !== selectedAgentId) return false;
    // A blank card is not a chat yet: listed only while it is the one open.
    if (s.items.length === 0 && s.title === "New session" && s.id !== active?.id) return false;
    // An agent's chats are all real conversations, even ones it started for
    // itself (a text from another agent); plain Ares still hides background cards.
    return owner !== ARES_AGENT_ID || !s.background || s.id === active?.id;
  });
  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const activeAgent = agents.find((a) => a.id === agentIdOf(active?.id));
  const previewOf = (s: SessionVm | undefined): string => {
    if (!s) return "No chats yet";
    for (let i = s.items.length - 1; i >= 0; i--) {
      const it = s.items[i]!;
      if ((it.kind === "assistant" || it.kind === "user") && it.text.trim()) {
        const parsed = it.kind === "user" ? parseAgentText(it.text) : null;
        const line = (parsed ? `${parsed.from}: ${parsed.body}` : it.kind === "user" ? `You: ${it.text}` : it.text).replace(/[#*`>|]/g, "").replace(/\s+/g, " ").replace(/^[-—–\s]+/, "").trim();
        return line.length > 70 ? line.slice(0, 69) + "…" : line;
      }
    }
    return s.title;
  };
  /** Hand a chat to another agent (or back to Ares): it keeps its whole
   *  history and carries on with the new agent's role, memory and model. */
  const giveChat = (sessionId: string, agentId: string) => {
    setLocalAgentBindings((current) => ({ ...current, [sessionId]: agentId }));
    if (native) daemonCmd({ type: "agent_bind", agentId: agentId === ARES_AGENT_ID ? null : agentId, sessionId });
    else setAgents((current) => current.map((a) => ({ ...a, threads: a.id === agentId ? [...a.threads.filter((t) => t !== sessionId), sessionId] : a.threads.filter((t) => t !== sessionId) })));
    selectedAgentRef.current = agentId;
    setSelectedAgentIdState(agentId);
    try { window.localStorage.setItem("ares.agent.selected", agentId); } catch { /* private mode */ }
    openSession(sessionId);
  };
  const chatHandoff = {
    // Never back to Ares: every chat is with an agent (owner, 2026-10-22).
    agents: agents.filter((a) => a.id !== selectedAgentId),
    onGive: giveChat,
  };
  const olderChats = sessions.filter((s) => !roomSeatIds.has(s.id) && agentIdOf(s.id) === ARES_AGENT_ID && !s.background && (s.items.length > 0 || s.title !== "New session") && !MACHINE_CHAT.test(s.title));
  const agentRows: AgentRowVm[] = agents
    .filter((a) => !q || a.name.toLowerCase().includes(q) || a.id === selectedAgentId)
    .map((a) => {
      const id = a?.id ?? ARES_AGENT_ID;
      const theirs = sessions.filter((s) => !roomSeatIds.has(s.id) && agentIdOf(s.id) === id && (id !== ARES_AGENT_ID || !s.background));
      const latest = theirs.find((s) => s.items.length > 0) ?? theirs[0];
      return {
        agent: a,
        preview: a && theirs.every((s) => s.items.length === 0) ? (a.instructions.trim() ? a.instructions.trim().slice(0, 70) : "No chats yet") : previewOf(latest),
        busy: theirs.some((s) => s.busy),
        unread: agentUnread.includes(id),
        chats: theirs.filter((s) => s.items.length > 0 || s.title !== "New session").length,
        at: theirs.map((s) => s.updatedAt).filter(Boolean).sort().at(-1),
      };
    });
  const visibleSessions = q ? railSessions.filter((s) => s.title.toLowerCase().includes(q)) : railSessions;
  const pinnedSessions = visibleSessions.filter((s) => prefs.pinned.includes(s.id));
  const unpinnedSessions = visibleSessions.filter((s) => !prefs.pinned.includes(s.id));
  // ── projects: named, collapsible session groups (client-side, like pins) ──
  const sessionProjects = prefs.sessionProjects ?? {};
  const allProjectNames = [...new Set(Object.values(sessionProjects))].sort((a, b) => a.localeCompare(b));
  const projectNames = allProjectNames.filter((name) =>
    unpinnedSessions.some((s) => sessionProjects[s.id] === name),
  );
  const looseSessions = unpinnedSessions.filter((s) => !sessionProjects[s.id]);
  /** Assign a session to a project (empty name = remove from its project). */
  const assignProject = (id: string, name: string) => {
    const clean = name.trim().slice(0, 40);
    const nextMap = { ...(prefs.sessionProjects ?? {}) };
    if (clean) nextMap[id] = clean;
    else delete nextMap[id];
    const next = { ...prefs, sessionProjects: nextMap };
    setPrefs(next);
    savePrefs(next);
  };
  const toggleProjectCollapsed = (name: string) => {
    const collapsed = prefs.collapsedProjects ?? [];
    const next = {
      ...prefs,
      collapsedProjects: collapsed.includes(name) ? collapsed.filter((p) => p !== name) : [...collapsed, name],
    };
    setPrefs(next);
    savePrefs(next);
  };
  const togglePin = (id: string) => {
    const pinned = prefs.pinned.includes(id) ? prefs.pinned.filter((p) => p !== id) : [...prefs.pinned, id];
    const next = { ...prefs, pinned };
    setPrefs(next);
    savePrefs(next);
  };

  /** Rename a session: optimistic title update, then persist via the daemon.
   *  The previous title is stashed so a failed persist can revert instead of
   *  leaving an optimistic title that silently vanishes on restart. */
  const renameSession = (id: string, label: string) => {
    const clean = label.trim().slice(0, 120);
    if (!clean) return;
    const previous = sessionsRef.current.find((s) => s.id === id)?.title;
    const stash = pendingRenamesRef.current.get(id);
    if (stash) stash.pending++;
    else if (previous !== undefined) pendingRenamesRef.current.set(id, { title: previous, pending: 1 });
    setSessions((current) => current.map((s) => (s.id === id ? { ...s, title: compact(clean, 42) } : s)));
    daemonCmd({ type: "session_rename", id, label: clean });
  };

  /** Close (delete) a session: drop it locally, persist, and leave the active
   *  session sane. The primary in-memory session is never deleted on disk but
   *  vanishes from the rail until its next turn re-registers it. */
  const closeSession = (id: string) => {
    setSessions((current) => {
      const next = current.filter((s) => s.id !== id);
      if (activeRef.current === id) {
        const fallback = next[0]?.id ?? "";
        activeRef.current = fallback;
        if (fallback) setTimeout(() => openSession(fallback), 0);
      }
      return next;
    });
    const hadProject = prefs.sessionProjects?.[id] !== undefined;
    if (prefs.pinned.includes(id) || hadProject) {
      // Drop the closed id from pins AND project membership — a stale
      // sessionProjects entry accumulated forever and could resurrect a
      // ghost project name. Collapse state for now-empty projects goes too.
      const { [id]: _closed, ...restProjects } = prefs.sessionProjects ?? {};
      const remainingNames = new Set(Object.values(restProjects));
      const cleaned: Prefs = {
        ...prefs,
        pinned: prefs.pinned.filter((p) => p !== id),
        sessionProjects: Object.keys(restProjects).length > 0 ? restProjects : undefined,
        collapsedProjects: prefs.collapsedProjects?.filter((name) => remainingNames.has(name)),
      };
      setPrefs(cleaned);
      savePrefs(cleaned);
    }
    daemonCmd({ type: "session_delete", id });
  };

  /** The vault: every image, file, and link Ares produced, across sessions.
   *  Scanning every message of every session is O(transcript) — doing it on
   *  EVERY streamed token was a per-delta full rescan. Compute only while the
   *  artifacts view is actually open (it refreshes on open because `view` is a
   *  dependency); off-view, serve the last computed snapshot so the nav badge
   *  keeps its count without any rescan. */
  const vaultCacheRef = useRef<Vault>({ images: [], files: [], links: [] });
  const vault = useMemo(() => {
    if (view === "artifacts") vaultCacheRef.current = collectVault(sessions);
    return vaultCacheRef.current;
  }, [view, sessions]);
  const vaultCount = vault.images.length + vault.files.length + vault.links.length;

  // God-of-War drivers for the whole shell: --heat (molten temperature) and
  // --draft (daemon-gated ambient). Every ember, glow, and rune reads these.
  const heat = Math.min(
    1,
    (daemon === "running" ? 0.3 : daemon === "starting" ? 0.18 : 0.05) +
      (active?.busy ? 0.4 : 0) +
      Math.min(0.15, (opStatus?.activeCount ?? 0) * 0.05),
  );
  const draft = daemon === "running" ? 1 : daemon === "starting" ? 0.5 : 0.1;
  // Each agent action STRIKES — a felt ember-flare + micro-shake. Driven off the
  // activity ticker so it fires once per tool, decoupled from event internals.
  const activity = active?.activity;
  useEffect(() => {
    // no-op: action strikes no longer flash the screen
  }, [activity]);
  // The working label counts up while the model has not said anything yet.
  // A 1 Hz tick, only while busy; the clock itself lives on the session.
  const [workingNow, setWorkingNow] = useState(() => Date.now());
  const workingBusy = !!active?.busy;
  useEffect(() => {
    if (!workingBusy) return;
    setWorkingNow(Date.now());
    const timer = window.setInterval(() => setWorkingNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [workingBusy]);
  const workingElapsedS = active?.activityAt ? Math.max(0, Math.floor((workingNow - active.activityAt) / 1000)) : 0;
  const quietS = active?.lastEventAt ? Math.max(0, Math.floor((workingNow - active.lastEventAt) / 1000)) : 0;
  const health = native && daemon === "running" ? daemonHealth(lastPingAtRef.current, lastPongAtRef.current, healthNow) : "ok";
  const loopNote = loopStuckNote(pong);
  const activeTurnStatus = active?.busy
    ? pong?.turns.find((t) => t.sessionId === active.id)
    : undefined;
  // The daemon's own account of a quiet turn beats a guess from the UI clock.
  const workingHint = active?.busy
    ? turnStatusNote(activeTurnStatus) ?? workingHintFor(active.activity, workingElapsedS, quietS, active.preparing === true)
    : null;

  // In pill mode presence belongs to the DESKTOP, not inside the controller.
  // Rust owns a monitor-sized, click-through WebView so the pulse and captions
  // remain visible over every application without intercepting the real mouse.
  const overlayMode: PresenceMode = convoListening
    ? "listening"
    : voice.speaking
      ? "speaking"
      : activeBusy
        ? "working"
        : presenceHeard
          ? "heard"
          : "idle";
  const overlayCaption = convoListening
    ? "Listening…"
    : nowSpeaking
      ? nowSpeaking
      : presenceHeard
        ? `“${presenceHeard}”`
        : activity || (activeBusy ? "Ares is working…" : "");
  useEffect(() => {
    if (!native) return;
    if (!pill || overlayMode === "idle") {
      void invoke("ares_presence_hide").catch(() => null);
      return;
    }
    void invoke("ares_presence_update", {
      mode: overlayMode,
      caption: overlayCaption,
      detail: activeBusy && activity && overlayCaption !== activity ? activity : "",
    }).catch(() => null);
  }, [native, pill, overlayMode, overlayCaption, activeBusy, activity]);
  useEffect(() => () => {
    if (native) void invoke("ares_presence_hide").catch(() => null);
  }, [native]);

  // Hands-free work narration: if a tool run goes quiet, read one concise
  // activity update. Rapid tool sequences are rate-limited so this stays useful
  // instead of becoming a stream of implementation noise.
  const narratedActivity = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  useEffect(() => {
    if (!prefs.voiceEnabled || !activeBusy || !(convoMode || pill || wakeOn) || !activity || voice.speaking) return;
    const now = Date.now();
    if (activity === narratedActivity.current.text || now - narratedActivity.current.at < 9_000) return;
    const timer = window.setTimeout(() => {
      if (spokenBuf.current.trim() || voiceRef.current.speaking) return;
      narratedActivity.current = { text: activity, at: Date.now() };
      const clean = activity.replace(/[…]+$/u, "").replace(/\s+/g, " ").trim();
      if (clean) voiceRef.current.speak(`${clean}${/[.!?]$/.test(clean) ? "" : "."}`);
    }, 850);
    return () => window.clearTimeout(timer);
  }, [prefs.voiceEnabled, activeBusy, convoMode, pill, wakeOn, activity, voice.speaking]);

  return (
    <StyleCtx.Provider value={prefs.uiStyle}>
    <AgentPhotoContext.Provider value={agentPhotos}>
    <AgentPosesContext.Provider value={agentPoses}>
    <AgentClipsContext.Provider value={agentClips}>
    <AvatarStyleContext.Provider value={prefs.surface === "messages" ? "tile" : "face"}>
    <div
      className="ares"
      data-daemon={daemon}
      data-theme={prefs.theme}
      data-accent={prefs.accent}
      data-flame={prefs.flameMode}
      data-style={prefs.uiStyle}
      data-surface={prefs.surface}
      data-glass={glass}
      data-panel={forge.open ? "1" : "0"}
      data-rail={railCollapsed ? "collapsed" : "open"}
      data-dragging={forgeDragging ? "1" : "0"}
      data-working={active?.busy ? "1" : "0"}
      data-pill={pill ? "1" : "0"}
      data-ultra={prefs.ultra ? "1" : "0"}
      style={{
        ["--forge-w" as string]: `${forgeWidth}px`,
        ["--heat" as string]: heat.toFixed(3),
        ["--draft" as string]: draft.toFixed(3),
        // agent-set effect accent: rotates the ember palette of the glow +
        // header ring; pace maps to the ring's rotation period (all smooth
        // rotation/drift — never opacity flashing)
        ["--fx-hue" as string]: `${prefs.uiEffect?.hue ?? 0}deg`,
        ["--fx-period" as string]: prefs.uiEffect?.speed === "calm" ? "4.6s" : prefs.uiEffect?.speed === "brisk" ? "1.6s" : "2.8s",
      }}
    >
      <AresSigils />
      {pill ? (
        <PillBar
          daemon={daemon}
          busy={active?.busy ?? false}
          cancelling={active?.cancelling ?? false}
          activity={activity ?? ""}
          conversation={convoMode}
          listening={convoListening}
          speaking={voice.speaking}
          wakeStatus={wakeStatus}
          onExpand={exitPill}
          onToggleConversation={() => {
            if (!convoMode && !prefsRef.current.voiceEnabled) setVoiceEnabled(true);
            setConvoMode((current) => !current);
          }}
          onStop={stopTurn}
          native={native}
        />
      ) : null}
      {!bootGone ? <Boot /> : null}
      {native && !pill ? (
        <SkillDock
          voiceEnabled={prefs.voiceEnabled ?? false}
          onToggleVoice={setVoiceEnabled}
          speaking={voice.speaking}
          listening={convoListening}
          convoMode={convoMode}
          onToggleConvo={setConvoMode}
          wakeWord={prefs.wakeWord ?? false}
          wakeStatus={wakeStatus}
          onToggleWake={setWakeWord}
          onStopVoice={() => { voiceRef.current.stop(); resetSpokenStream(); }}
          providerLabel={ttsProviderSkill ? `via ${ttsProviderSkill.name}` : "built-in · local"}
          skills={skills}
          onSurface={runSurface}
          toast={skillToast}
          voiceEngine={voiceEngine}
          onRepairVoice={repairVoice}
        />
      ) : null}
      {/* Voice PRESENCE: the monitor edges glow while Ares listens (steel) or
          speaks (ember) — the Gemini-style "I'm here" signal for hands-free. */}
      {!pill && (convoListening || voice.speaking) ? (
        <div className="presenceGlow" data-mode={convoListening ? "listening" : "speaking"} aria-hidden="true" />
      ) : null}
      {/* Hands-free captions: "listening…" while the mic is open, then a flash
          of exactly what Ares heard, then the karaoke of what it's saying. */}
      {!pill && convoListening ? (
        <div className="presenceCaption" data-kind="listening" aria-live="off">
          <span className="presenceDot" aria-hidden="true" />
          listening…
        </div>
      ) : null}
      {!pill && !convoListening && presenceHeard && !voice.speaking ? (
        <div className="presenceCaption" data-kind="heard" aria-live="off">“{presenceHeard}”</div>
      ) : null}
      {/* Karaoke: the sentence being spoken right now, following the voice. */}
      {!pill && voice.speaking && nowSpeaking ? (
        <div className="speakingNow" aria-live="off">
          <span className="speakingNowIcon" aria-hidden="true" />
          <span className="speakingNowText">{nowSpeaking}</span>
        </div>
      ) : null}
      {/* Read-aloud: select any reply text → a floating speak button. */}
      {readAloud ? (
        <button
          className="readAloudBtn"
          style={{ left: readAloud.x, top: readAloud.y }}
          onMouseDown={(e) => e.preventDefault() /* keep the selection alive */}
          onClick={() => {
            voiceRef.current.speak(readAloud.text, { force: true });
            setReadAloud(null);
          }}
        >
          🔊 Speak
        </button>
      ) : null}
      <UpdateBanner />
      <WhatsNew />
      <ForgeIntro />
      <FirstRunGate
        active={native && daemon !== "starting" && noUsableKeys(keyStatus)}
        onOpenKeys={() => {
          setSettingsTab("keys");
          setSettingsOpen(true);
        }}
        onConnectAres={() => {
          setSettingsTab("account");
          setSettingsOpen(true);
        }}
      />
      <Backdrop pointMap={prefs.surface === "cyber" && !prefs.pointMapOff ? activePointMap : null} />
      <div className="embers" aria-hidden="true" />
      <div className="workGlow" aria-hidden="true" />
      <ScreenFlame />
      {prefs.ultra ? <HackerRain active={active?.busy ?? false} /> : null}
      {/* strikeFlash intentionally NOT rendered: a 480ms full-screen flash on
          every agent action is a photosensitive-seizure hazard. Working state
          is carried by the static glow + the header indicator instead. */}
      {/* Turbulence filter that makes the composer's flame rim actually lick + flicker. */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          {/* coarse slow sway for the flame body — higher octaves for organic
             noise, then a soft blur so the displaced edge reads as fire, not a
             jagged stretched polygon. */}
          <filter id="flameTurbCoarse" x="-50%" y="-50%" width="200%" height="200%">
            <feTurbulence type="fractalNoise" baseFrequency="0.011 0.026" numOctaves={4} seed={5} result="n">
              <animate attributeName="baseFrequency" dur="3s" values="0.011 0.024;0.016 0.038;0.011 0.024" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="n" scale={13} xChannelSelector="R" yChannelSelector="G" result="d" />
            <feGaussianBlur in="d" stdDeviation="1.1" />
          </filter>
          {/* medium licking for the mid layer */}
          <filter id="flameTurb" x="-40%" y="-40%" width="180%" height="180%">
            <feTurbulence type="fractalNoise" baseFrequency="0.018 0.046" numOctaves={3} seed={3} result="n">
              <animate attributeName="baseFrequency" dur="1.5s" values="0.018 0.042;0.028 0.072;0.018 0.042" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="n" scale={8} xChannelSelector="R" yChannelSelector="G" result="d" />
            <feGaussianBlur in="d" stdDeviation="0.7" />
          </filter>
          {/* fast fine crackle for the white-hot core */}
          <filter id="flameTurbFine" x="-40%" y="-40%" width="180%" height="180%">
            <feTurbulence type="fractalNoise" baseFrequency="0.038 0.086" numOctaves={3} seed={8} result="n">
              <animate attributeName="baseFrequency" dur="0.85s" values="0.038 0.078;0.056 0.122;0.038 0.078" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="n" scale={5} xChannelSelector="R" yChannelSelector="G" result="d" />
            <feGaussianBlur in="d" stdDeviation="0.4" />
          </filter>
          {/* body: deep red → orange, fading translucent at the tips */}
          <linearGradient id="flameGradBack" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--blood)" stopOpacity={0.95} />
            <stop offset="35%" stopColor="var(--ember)" stopOpacity={0.85} />
            <stop offset="72%" stopColor="var(--ember)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--ember)" stopOpacity={0} />
          </linearGradient>
          {/* mid: orange → gold, soft fade */}
          <linearGradient id="flameGradMid" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--ember)" stopOpacity={0.98} />
            <stop offset="40%" stopColor="var(--ember-hi)" stopOpacity={0.95} />
            <stop offset="75%" stopColor="#ffd98a" stopOpacity={0.5} />
            <stop offset="100%" stopColor="#ffd98a" stopOpacity={0} />
          </linearGradient>
          {/* core: gold → white-hot tips */}
          <linearGradient id="flameGradCore" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--ember-hi)" stopOpacity={0} />
            <stop offset="45%" stopColor="#ffe8b0" stopOpacity={0.7} />
            <stop offset="80%" stopColor="#fff7e6" stopOpacity={0.95} />
            <stop offset="100%" stopColor="#fffdf7" stopOpacity={1} />
          </linearGradient>
        </defs>
      </svg>

      {prefs.surface === "messages" ? (
        <MsgTitlebar
          daemon={daemon}
          forgeOpen={forge.open}
          credits={gatewayAccount?.connected ? gatewayAccount.balance_usd ?? 0 : undefined}
          native={native}
          onDrag={dragWindow}
          onAccount={() => { setSettingsOpen(true); setSettingsTab("account"); }}
          onSearch={() => setPaletteOpen(true)}
          onForge={() => setForge((f) => ({ ...f, open: !f.open, tab: f.open ? f.tab : f.artifact ? "preview" : "live" }))}
          onExport={active?.id ? () => void exportSessionLog() : undefined}
          onSettings={() => setSettingsOpen(true)}
          onMinimize={() => { void getCurrentWindow().minimize().catch(() => null); }}
          onMaximize={() => void invoke("ares_window_toggle_maximize").catch(() => null)}
          onClose={() => void invoke("ares_window_close").catch(() => null)}
        />
      ) : (
      <header className="titlebar" onMouseDown={dragWindow}>
        <button
          className="brand brandBtn"
          data-open={accountMenuOpen ? "1" : "0"}
          onMouseDown={(ev) => ev.stopPropagation()}
          onClick={() => {
            setAccountMenuOpen((v) => !v);
            if (!accountMenuOpen) daemonCmd({ type: "gateway_status" });
          }}
          title="Ares account"
        >
          <div className="emblem" aria-hidden="true" />
          <h1>ARES</h1>
          <span>the battle-tested agent</span>
          {gatewayAccount?.connected ? (
            <em className="brandCredits">${(gatewayAccount.balance_usd ?? 0).toFixed(2)}</em>
          ) : null}
          <i className="brandCaret" aria-hidden="true">▾</i>
        </button>
        {accountMenuOpen ? (
          <div className="accountMenu" onMouseDown={(ev) => ev.stopPropagation()}>
            {gatewayAccount?.connected ? (
              <>
                <div className="amHead">
                  <div className="gwAvatar">
                    {gatewayAccount.profile?.avatar_url ? (
                      <img src={gatewayAccount.profile.avatar_url} alt="" />
                    ) : (
                      <span>{(gatewayAccount.profile?.display_name ?? "A").slice(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="amWho">
                    <strong>{gatewayAccount.profile?.display_name ?? "warrior"}</strong>
                    <span className="gwStatus" data-status={gatewayAccount.profile?.status ?? ""}>{gatewayAccount.profile?.status}</span>
                  </div>
                </div>
                <div className="amWallet">
                  <div className="amWalletBig">${(gatewayAccount.balance_usd ?? 0).toFixed(2)}</div>
                  <div className="amWalletSub">credits · ${(gatewayAccount.usage?.cost_usd ?? 0).toFixed(4)} spent today</div>
                </div>
                <div className="amSectionLabel">Models you can use</div>
                <div className="amModels">
                  {(gatewayAccount.models ?? []).length === 0 ? (
                    <div className="amEmpty">No models assigned yet — the owner grants them.</div>
                  ) : (
                    (gatewayAccount.models ?? []).map((m) => {
                      const active = prefs.provider === "ares" && prefs.model === m.id;
                      const limit = m.is_free
                        ? "free"
                        : typeof m.cap_remaining_microcents === "number"
                          ? `$${(m.cap_remaining_microcents / 1e6).toFixed(2)} left`
                          : "wallet";
                      return (
                        <button
                          key={m.id}
                          className="amModelRow"
                          data-active={active ? "1" : "0"}
                          title={active ? "current model" : "use this model"}
                          onClick={() => {
                            const next = { ...prefsRef.current, provider: "ares", model: m.id };
                            setPrefs(next as Prefs);
                            prefsRef.current = next as Prefs;
                            savePrefs(next as Prefs);
                            daemonCmd({ type: "model_switch", provider: "ares", model: m.id, sessionId: activeRef.current });
                            setAccountMenuOpen(false);
                          }}
                        >
                          <span className="amModelName">
                            {m.is_house ? <em className="gwHouse">ARES</em> : null}
                            {m.display_name ?? m.id}
                          </span>
                          <span className="amModelLimit" data-free={m.is_free ? "1" : "0"}>{limit}</span>
                          {active ? <span className="amModelDot" aria-hidden="true">●</span> : null}
                        </button>
                      );
                    })
                  )}
                </div>
                <div className="amFoot">
                  <span className="amUsageLine">{(gatewayAccount.usage?.input_tokens ?? 0).toLocaleString()} in · {(gatewayAccount.usage?.output_tokens ?? 0).toLocaleString()} out today</span>
                  <button className="amManage" onClick={() => { setAccountMenuOpen(false); setSettingsOpen(true); setSettingsTab("account"); }}>Manage →</button>
                </div>
              </>
            ) : (
              <>
                <div className="amEmpty">Connect your Ares account to route through the gateway with your credits.</div>
                <button className="amAction" onClick={() => { setAccountMenuOpen(false); setSettingsOpen(true); setSettingsTab("account"); }}>
                  Connect account →
                </button>
              </>
            )}
          </div>
        ) : null}
        <div className="titleDrag" />
        <span className="pill" data-state={daemon}>
          {daemon === "running" ? "Online" : daemon.charAt(0).toUpperCase() + daemon.slice(1)}
        </span>
        <button
          type="button"
          className="workflowPill"
          data-mode={active?.workflowMode ?? "build"}
          onMouseDown={(ev) => ev.stopPropagation()}
          onClick={() => {
            const next = (active?.workflowMode ?? "build") === "plan" ? "build" : "plan";
            daemonCmd({ type: "workflow_mode", mode: next, sessionId: active?.id });
          }}
          title={(active?.workflowMode ?? "build") === "plan"
            ? "Plan mode: Ares may inspect and discuss, but cannot edit or execute. Click to switch to Build."
            : "Build mode: approved execution and editing are available. Click to switch to Plan."}
          aria-label={`Workflow mode: ${(active?.workflowMode ?? "build") === "plan" ? "plan" : "build"}. Click to switch.`}
        >
          {(active?.workflowMode ?? "build") === "plan" ? "PLAN MODE" : "BUILD MODE"}
        </button>
        {prefs.uiStyle === "modern" ? (
          <div className="titleTools" onMouseDown={(ev) => ev.stopPropagation()}>
            <button className="titleIcon" onClick={() => setPaletteOpen(true)} title="Command palette (Ctrl+K)" aria-label="Command palette">
              <Medallion glyph="search" size={30} />
            </button>
            <button
              className="titleIcon"
              onClick={() => setForge((f) => ({ ...f, open: !f.open, tab: f.open ? f.tab : f.artifact ? "preview" : "live" }))}
              title={forge.open ? "Close the Forge" : "Open the Forge"}
              aria-label="Forge"
              data-on={forge.open ? "1" : "0"}
            >
              <Medallion glyph="forge" size={30} />
            </button>
            <button
              className="titleIcon"
              onClick={() => void exportSessionLog()}
              disabled={!active?.id}
              title="Download this chat (session log: chat + tool calls + errors) as a text file"
              aria-label="Download chat"
            >
              <Medallion glyph="download" size={30} />
            </button>
            <button className="titleIcon" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings">
              <Medallion glyph="settings" size={30} />
            </button>
          </div>
        ) : null}
        <div className="winControls">
          <button className="winPill" aria-label="condense to floating pill" title="Condense to a floating pill" onClick={() => void enterPill()}>
            <AresPillGlyph />
          </button>
          {native ? (
            <>
            <button aria-label="maximize" onClick={() => void invoke("ares_window_toggle_maximize").catch(() => null)}>
              <svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" rx="1" /></svg>
            </button>
            <button aria-label="close" className="winClose" onClick={() => void invoke("ares_window_close").catch(() => null)}>
              <svg viewBox="0 0 10 10"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5" /><line x1="8.5" y1="1.5" x2="1.5" y2="8.5" /></svg>
            </button>
            </>
          ) : null}
        </div>
      </header>
      )}

      <aside className="rail">
        <div className="railBrand" aria-hidden="true">ARES</div>
        <button className="railCollapse" onClick={toggleRail} title="Collapse navigation" aria-label="Collapse navigation">
          <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M11 4 6 9l5 5"/><path d="M15 3v12"/></svg>
          <span>Collapse</span>
        </button>
        <button className="primary" onClick={prefs.surface === "cyber" ? goHome : newSession}>
          <Medallion glyph="new-session" tone="ember" /><svg className="cyberHome" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-4v-4H8v4H4a1 1 0 0 1-1-1Z" /></svg><span className="primaryLabel">{selectedAgent ? `New chat with ${selectedAgent.name}` : "New session"}</span>
        </button>

        {prefs.surface === "messages" ? (
          <MsgTabBar
            active={(view === "chat" ? "chat" : view === "now" ? "now" : view === "feed" ? "feed" : view === "artifacts" ? "made" : view === "aresos" ? "devices" : null) as MsgTab | null}
            badges={{
              chat: (agentUnread.length + roomUnread.length + directory.inbox.length) || undefined,
              now: sessions.some((x) => x.items.some((it) => it.kind === "permission" && !it.decided)) ? "!" : undefined,
            }}
            live={{ now: sessions.some((x) => x.busy && !x.background) }}
            onChange={(tab) => {
              setForge((current) => ({ ...current, open: false }));
              if (tab === "chat") setView("chat");
              else if (tab === "now") setView("now");
              else if (tab === "feed") setView("feed");
              else if (tab === "made") setView("artifacts");
              else { setView("aresos"); daemonCmd({ type: "remote_pcs" }); }
            }}
          />
        ) : (
        <nav className="railNav">
          <button
            title="Chats"
            data-on={view === "chat" ? "1" : "0"}
            onClick={() => {
              setView("chat");
              // On the sanctum (an empty session) "Sessions" means the latest
              // real conversation, otherwise the click did nothing visible.
              if (prefs.surface === "cyber" && active && active.items.length === 0) {
                // the latest real conversation — never another blank card
                const latest = sessions.find((s) => s.id !== active.id && !s.background && (s.items.length > 0 || s.title !== "New session"));
                if (latest) openSession(latest.id);
              }
            }}
          >
            <Medallion glyph="sessions" /><i className="glyph" data-glyph="task" /> Chats
          </button>
          <button
            title="Now"
            data-on={view === "now" ? "1" : "0"}
            onClick={() => { setView("now"); setForge((current) => ({ ...current, open: false })); }}
          >
            <Medallion glyph="flame" /><i className="glyph" data-glyph="dot" /> Now
            {sessions.some((s) => s.items.some((it) => it.kind === "permission" && !it.decided)) ? <em>!</em> : null}
          </button>
          <button
            title="Feed"
            data-on={view === "feed" ? "1" : "0"}
            onClick={() => { setView("feed"); setForge((current) => ({ ...current, open: false })); }}
          >
            <Medallion glyph="scroll" /><i className="glyph" data-glyph="dot" /> Feed
          </button>
          <button
            className="helmNav"
            title="HELM"
            data-on={view === "helm" ? "1" : "0"}
            onClick={() => {
              setView("helm");
              setForge((current) => ({ ...current, open: false }));
              daemonCmd({ type: "operator_status" });
              daemonCmd({ type: "usage_stats", days: 14 });
            }}
          >
            <Medallion glyph="helm" /><i className="glyph" data-glyph="dot" /> HELM
            {opStatus?.activeCount ? <em>{opStatus.activeCount}</em> : null}
          </button>
          <button
            title="Artifacts"
            data-on={view === "artifacts" ? "1" : "0"}
            onClick={() => {
              setView("artifacts");
              setForge((current) => ({ ...current, open: false }));
            }}
          >
            <Medallion glyph="artifacts" /><i className="glyph" data-glyph="file" /> Artifacts
            {vaultCount > 0 ? <em>{vaultCount}</em> : null}
          </button>
          <button
            title="AresOS"
            data-on={view === "aresos" ? "1" : "0"}
            onClick={() => {
              setView("aresos");
              setForge((current) => ({ ...current, open: false }));
              daemonCmd({ type: "remote_pcs" });
            }}
          >
            <Medallion glyph="shield" /><i className="glyph" data-glyph="dot" /> AresOS
            {remotePcs.length > 0 ? <em>{remotePcs.length}</em> : null}
          </button>
        </nav>
        )}

        <input
          className="railSearch"
          value={sessionQuery}
          placeholder="Search agents & chats…"
          spellCheck={false}
          onChange={(e) => setSessionQuery(e.target.value)}
        />

        {/* Agents, not chats: every contact owns its own chats (nested under
            the selected one). ONE scroll container for all of it — sibling
            flex:1 scrollers crushed the controls above (field report,
            2026-08-10). */}
        <div className="railScroll">
        <div className="railLabel" data-label="Agents">Agents<span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><button className="railHelp" onClick={() => setTutorialOpen(true)} title="How Ares works" aria-label="Tutorial">?</button><button className="railNew" onClick={() => { setAgentError(undefined); setAgentEditor({ mode: "create" }); }} title="New agent" aria-label="New agent">+</button></span></div>
        {agents.length === 0 && !q ? (
          <div className="agentFirst">
            <h3>Make someone</h3>
            <p>A name, a face, a job. They get their own memory, their own model and the whole machine. Text them like a person.</p>
            <div className="agentFirstBtns">
              <button className="agentPrimary" onClick={() => { setAgentError(undefined); setAgentEditor({ mode: "create" }); }}>Make my first agent</button>
              <button className="agentGhost" onClick={() => setTutorialOpen(true)}>How it works</button>
            </div>
          </div>
        ) : null}
        {handOver && agents.some((a) => a.id === handOver.agentId) && olderChats.length > 0 ? (
          <div className="handOverCard">
            <strong>Hand your older chats to {agents.find((a) => a.id === handOver.agentId)?.name}?</strong>
            <p>{olderChats.length} chat{olderChats.length === 1 ? "" : "s"} from before. They keep everything and carry on with {agents.find((a) => a.id === handOver.agentId)?.name}'s memory and model. You can also hand them one at a time from the shelf below.</p>
            <div>
              <button className="agentPrimary" onClick={() => { for (const s of olderChats) giveChat(s.id, handOver.agentId); setHandOver(null); }}>Hand them over</button>
              <button className="agentGhost" onClick={() => setHandOver(null)}>Later</button>
            </div>
          </div>
        ) : null}
        <AgentList
          rows={agentRows}
          selectedId={selectedAgentId}
          onSelect={selectAgent}
          onEdit={(id) => { setAgentError(undefined); setAgentEditor({ mode: "edit", id }); }}
          onDelete={(id) => deleteAgent(id)}
        >
          <button className="agentNewChat" onClick={() => newSession(selectedAgentId)}>
            <span>+</span> New chat{selectedAgent ? ` with ${selectedAgent.name}` : ""}
          </button>
          {pinnedSessions.length > 0 ? (
            <>
              <div className="railLabel">Pinned</div>
              <nav className="sessionList pinnedList">
                {pinnedSessions.map((s) => (
                  <SessionRow key={s.id} s={s} activeId={active?.id ?? ""} pinned project={sessionProjects[s.id]} onSelect={openSession} onPin={togglePin} onRename={renameSession} onClose={closeSession} onProject={assignProject} handoff={chatHandoff} />
                ))}
              </nav>
            </>
          ) : null}

          {projectNames.map((name) => {
            const members = unpinnedSessions.filter((s) => sessionProjects[s.id] === name);
            const collapsed = (prefs.collapsedProjects ?? []).includes(name);
            return (
              <div key={name} className="railProject">
                <button
                  className="railLabel railProjectHeader"
                  data-collapsed={collapsed ? "1" : "0"}
                  onClick={() => toggleProjectCollapsed(name)}
                  title={collapsed ? "expand project" : "collapse project"}
                >
                  <b>▸</b>
                  <span>{name}</span>
                  <em>{members.length}</em>
                </button>
                {!collapsed ? (
                  <nav className="sessionList">
                    {members.map((s) => (
                      <SessionRow key={s.id} s={s} activeId={active?.id ?? ""} project={name} onSelect={openSession} onPin={togglePin} onRename={renameSession} onClose={closeSession} onProject={assignProject} handoff={chatHandoff} />
                    ))}
                  </nav>
                ) : null}
              </div>
            );
          })}


          {looseSessions.length > 0 ? (
            <>
              <div className="railLabel" data-label={selectedAgent ? `Chats with ${selectedAgent.name}` : "Recent sessions"}>{selectedAgent ? "Chats" : "Sessions"}</div>
              <nav className="sessionList">
                {looseSessions.map((s) => (
                  <SessionRow key={s.id} s={s} activeId={active?.id ?? ""} onSelect={openSession} onPin={togglePin} onRename={renameSession} onClose={closeSession} onProject={assignProject} handoff={chatHandoff} />
                ))}
              </nav>
            </>
          ) : pinnedSessions.length === 0 && projectNames.length === 0 ? (
            <div className="agentEmptyChats">{q ? "No chats match." : "No chats yet."}</div>
          ) : null}
        </AgentList>
        {olderChats.length > 0 ? (
          <div className="olderChats">
            <button className="olderChatsHead" onClick={() => setOlderOpen((v) => !v)} title="Chats from before agents — hand any of them to an agent, history and all">
              <span>{olderOpen ? "▾" : "▸"} Older chats</span><em>{olderChats.length}</em>
            </button>
            {olderOpen ? (
              <nav className="sessionList">
                {(q ? olderChats.filter((s) => s.title.toLowerCase().includes(q)) : olderChats).slice(0, 200).map((s) => (
                  <SessionRow key={s.id} s={s} display={shelfTitle(s.title)} when={shelfDate(s.updatedAt ?? s.createdAt)} activeId={active?.id ?? ""} onSelect={openSession} onPin={togglePin} onRename={renameSession} onClose={closeSession} onProject={assignProject} handoff={{ agents: agents.map((a) => ({ id: a.id, name: a.name })), onGive: giveChat }} />
                ))}
              </nav>
            ) : null}
          </div>
        ) : null}
        {/* Rooms: group chats of you, your agents, and people you invite
            (with their agents). Below the contacts, like Messages' groups. */}
        <div className="railLabel" data-label="Rooms">Rooms<button className="railNew" onClick={() => { setRoomError(undefined); setRoomSheet({ kind: "create" }); }} title="New room" aria-label="New room">+</button></div>
        <RoomList
          rows={roomRows}
          selectedId={activeRoomId}
          agents={agents}
          photos={agentPhotos}
          onSelect={selectRoom}
          onNew={() => { setRoomError(undefined); setRoomSheet({ kind: "create" }); }}
          onJoin={() => { setRoomError(undefined); setRoomSheet({ kind: "join" }); }}
        />
        {directory.inbox.map((item) => (
          <InviteCard
            key={item.id}
            item={item}
            onAccept={() => { setAcceptingInvite(item); setRoomError(undefined); setRoomSheet({ kind: "join" }); }}
            onDismiss={() => daemonCmd({ type: "directory_ack", id: item.id })}
          />
        ))}
        <div className="roomRowActions">
          <button className="peopleBtn" onClick={() => { setPeopleError(undefined); setPeopleOpen(true); if (directory.connected) { peopleSearchSeq.current += 1; setPeopleSearching(true); daemonCmd({ type: "directory_search", text: "", requestId: `ps_${peopleSearchSeq.current}` }); } }} title="Find people on Ares">
            <span>@</span> {directory.connected ? `People · @${directory.username}` : "People — claim a username"}
            {directory.inbox.length ? <em>{directory.inbox.length}</em> : null}
          </button>
        </div>
        </div>
        {/* Autocomplete of existing project names for the row-level assign input. */}
        <datalist id="aresProjectOptions">
          {allProjectNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        <div className="railFoot">
          {/* Cyber's footer card (hidden on the other surfaces via basic.css). */}
          <div className="railMemory" onClick={() => { setSettingsOpen(true); }} role="button" title="Open settings">
            <Medallion glyph="scroll" size={34} />
            <div className="railMemoryText">
              <strong>Agent Memory</strong>
              <span><i data-state={daemon} /> {daemon === "running" ? "Live" : daemon} · Garrison</span>
            </div>
          </div>
          {/* data-act lets the modern skin drop the two that moved into the
              titlebar (Forge, Settings) without touching the other skins. */}
          <button className="ghost" data-act="undo" disabled={!native || daemon !== "running" || active?.busy} onClick={undoLastChange}>
            Undo last agent change
          </button>
          <button className="ghost" data-act="forge" onClick={() => setForge((f) => ({ ...f, open: !f.open, tab: f.open ? f.tab : f.artifact ? "preview" : "live" }))}>
            {forge.open ? "Close the Forge" : "Open the Forge"}
          </button>
          <button className="ghost" data-act="settings" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <div className="daemonDot" title={`daemon: ${daemon}`}>
            <i data-state={daemon} />
            <span>{daemon === "running" ? "Garrison up" : daemon}</span>
          </div>
        </div>
      </aside>

      <main className="stage" data-view={view}>
        {railCollapsed ? (
          <AgentDock floating rows={agentRows} selectedId={selectedAgentId} onSelect={selectAgent} onNew={() => { setAgentError(undefined); setAgentEditor({ mode: "create" }); }} />
        ) : null}
        {/* No header over the "who do you want to text" picker: it belongs to no one, and showed the raw model id. */}
        <header className="stageHead" data-busy={active?.busy ? "1" : "0"} data-imsg={activeAgent || prefs.surface === "messages" ? "1" : "0"} hidden={Boolean(activeRoom && view === "chat") || view === "now" || view === "feed" || view === "artifacts" || view === "aresos" || (view === "chat" && !activeAgent && !activeRoom && (active?.items.length ?? 0) === 0)}>
          {railCollapsed ? (
            <button className="railReveal" onClick={toggleRail} title="Show navigation" aria-label="Show navigation">
              <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="m7 4 5 5-5 5"/><path d="M3 3v12"/></svg>
            </button>
          ) : null}
          <div className="stageHeadAgent">
          {activeAgent ? (
            <button className="stageAgent" onClick={() => { setAgentError(undefined); setAgentEditor({ mode: "edit", id: activeAgent.id }); }} title={`${activeAgent.name}'s profile`}>
              <AgentAvatar agent={activeAgent} size={34} busy={active?.busy} activity={active?.activity} />
            </button>
          ) : null}
          <div>
            {/* Like Messages: who you're texting is the headline; the chat's
                topic (or what they're doing right now) sits under it. */}
            <h2>{activeAgent && (prefs.surface === "messages" || !active || active.title === "New session") ? activeAgent.name : active?.title ?? "Session"}</h2>
            <span>
              {activeAgent
                ? prefs.surface === "messages"
                  ? active?.busy ? (active.activity && !/^(thinking|working|response committed|settling proposed actions)$/i.test(active.activity) ? active.activity : "working…") : active && active.title !== "New session" ? active.title : "tap for profile"
                  : `${activeAgent.name} · ${activeAgent.provider} / ${activeAgent.model}`
                : prefs.routingMode === "auto" ? `routing · ${liveModel}` : `${prefs.provider} / ${prefs.model}`}
              {prefs.routingMode === "auto" && routedLanes.length > 0 ? ` · ${routedLanes.length} lane${routedLanes.length === 1 ? "" : "s"}` : ""}
            </span>
          </div>
          </div>
          {/* THE working signal — a small, contained, smoothly rotating ring
              beside the session title. Rotation only: luminance never flashes,
              so it is photosensitive-safe in every effects mode except "off".
              Ares can recolor/pace it via SetUiEffect (--fx-hue/--fx-period). */}
          {active?.busy && prefs.flameMode !== "off" ? (
            <span className="stageWork" title={active.activity ?? "working"}>
              <i className="stageWorkRing" aria-hidden="true" />
              <em>{prefs.uiEffect?.label ?? active.activity ?? "working"}</em>
            </span>
          ) : null}
        </header>

        {activeRoom && view === "chat" ? (
          <RoomView
            key={activeRoom.id}
            room={activeRoom}
            me={roomsMe}
            messages={roomMessages[activeRoom.id] ?? []}
            agents={agents}
            photos={agentPhotos}
            typing={roomTypingOf(activeRoom)}
            remoteTyping={roomPresence[activeRoom.id] ?? []}
            workspaces={workspaces.map((w) => ({ id: w.id, label: w.label }))}
            error={roomError}
            onSend={(text) => { setRoomError(undefined); daemonCmd({ type: "room_post", roomId: activeRoom.id, text }); }}
            onPause={(paused) => daemonCmd(paused ? { type: "room_stop", roomId: activeRoom.id } : { type: "room_update", roomId: activeRoom.id, room: { rules: { paused } } })}
            onMute={(agentId, muted) => daemonCmd({ type: "room_agent_mute", roomId: activeRoom.id, agentId, muted })}
            onRecall={(agentId) => daemonCmd({ type: "room_agent_remove", roomId: activeRoom.id, agentId })}
            onAddAgent={(agentId) => daemonCmd({ type: "room_agent_add", roomId: activeRoom.id, agentId })}
            onInvite={() => { setRoomError(undefined); setRoomSheet({ kind: "invite", roomId: activeRoom.id }); }}
            onJob={(job) => daemonCmd({ type: "room_job", roomId: activeRoom.id, job })}
            onNotes={(notes) => daemonCmd({ type: "room_notes", roomId: activeRoom.id, notes })}
            onRules={(rules) => daemonCmd({ type: "room_update", roomId: activeRoom.id, room: { rules } })}
            onRename={(patch) => daemonCmd({ type: "room_update", roomId: activeRoom.id, room: patch })}
            onDelete={() => daemonCmd({ type: "room_delete", roomId: activeRoom.id })}
            onRemoveGuest={(guestId) => daemonCmd({ type: "room_guest_remove", roomId: activeRoom.id, guestId })}
            onOpenSeat={(sessionId) => {
              // A seat is a real session: open it like any chat (history loads on demand).
              if (!sessions.some((s) => s.id === sessionId)) setSessions((prev) => [{ ...freshSession(), id: sessionId, title: `${activeRoom.name} · seat`, loaded: false }, ...prev]);
              setActiveId(sessionId);
              setActiveRoomId(null);
              daemonCmd({ type: "session_history", id: sessionId });
              daemonCmd({ type: "session_open", sessionId });
            }}
          />
        ) : view === "now" ? (
          <NowView
            me={roomsMe.name}
            sessions={sessions}
            agents={agents}
            photos={agentPhotos}
            rooms={rooms}
            roomMessages={roomMessages}
            agentIdOf={agentIdOf}
            onOpenSession={openSession}
            onOpenRoom={selectRoom}
            onPermission={(sessionId, id, decision) => { setActiveId(sessionId); respondPermission(id, decision); }}
            onAsk={(text) => { setView("chat"); send(text); }}
            onNewAgent={() => { setAgentError(undefined); setAgentEditor({ mode: "create" }); }}
            onNewRoom={() => { setRoomError(undefined); setRoomSheet({ kind: "create" }); }}
            onFeed={() => setView("feed")}
            scheduled={
              <ScheduledList
                compact
                jobs={jobs}
                agents={agents}
                photos={agentPhotos}
                rooms={rooms}
                {...(jobError ? { error: jobError } : {})}
                onAdd={(spec) => { setJobError(undefined); daemonCmd({ type: "job_add", job: spec }); }}
                onChange={(id, action) => { setJobError(undefined); daemonCmd({ type: "job_change", id, action }); }}
                onOpenThread={(sid) => openSession(sid)}
              />
            }
            onAllScheduled={() => { setSettingsTab("scheduled"); setSettingsOpen(true); }}
          />
        ) : view === "feed" ? (
          <FeedView
            gateway={gatewayFetch}
            native={native}
            onOpen={(url) => { window.open(url, "_blank", "noopener"); }}
            onAsk={(text) => { setView("chat"); send(text); }}
          />
        ) : view === "helm" ? (
          <HelmView
            daemon={daemon}
            opStatus={opStatus}
            usage={usageStats}
            keyStatus={keyStatus}
            sessions={sessions}
            active={active}
            roster={roster}
            activePersona={activePersona}
            cognitive={cognitive}
            tab={helmTab}
            onTab={setHelmTab}
            fleetHistory={fleetHistory}
            subagentJobs={subagentJobs}
            operatorHalted={opHalted}
            onToggleHalt={() => {
              daemonCmd({ type: "operator_control", action: opHalted ? "resume" : "halt" });
              setOpHalted((h) => !h);
            }}
            onResumeFleet={(fleetId) =>
              send(`Resume the agent fleet "${fleetId}" — author a Conductor FleetSpec with resumeFleetId: "${fleetId}" so the completed leaves are reused from disk and only the failed/incomplete ones re-run.`)
            }
            onOpenSession={openSession}
            onToggleAutotick={() => daemonCmd({ type: "operator_autotick", enabled: !(opStatus?.autotick ?? true) })}
            onRefresh={() => { daemonCmd({ type: "operator_status" }); daemonCmd({ type: "usage_stats", days: 14 }); daemonCmd({ type: "roster_list", sessionId: activeId }); daemonCmd({ type: "fleets_list" }); daemonCmd({ type: "subagents_list" }); }}
            onAdoptPersona={adoptPersona}
            onDeletePersona={(name) => daemonCmd({ type: "persona_delete", name })}
            onWritePersona={(draft) => daemonCmd({ type: "persona_write", ...draft })}
            personaStyle={personaStyle}
            onPersonaStyle={(style) => { setPersonaStyle(style); daemonCmd({ type: "persona_style", name: style }); }}
          />
        ) : view === "artifacts" ? (
          <ArtifactsPage
            vault={vault}
            onOpenFile={(path, label) => openArtifact(path, label)}
            onReturn={() => setView("chat")}
            onJump={openSession}
          />
        ) : view === "aresos" ? (
          <AresOsView
            pcs={remotePcs}
            link={remoteLink}
            pairLink={remotePairLink}
            devices={remoteDevices}
            scope={remoteScope}
            shots={remoteShots}
            onConnect={(label) => { setRemoteLink(null); daemonCmd({ type: "remote_pc_link", label }); }}
            onPair={(label) => { setRemotePairLink(null); daemonCmd({ type: "remote_pc_pair", label }); }}
            onClearPairLink={() => setRemotePairLink(null)}
            phonePair={phonePair}
            onPhonePair={() => {
              if (!native) {
                // Browser DEMO mode has no garrison: show a clearly fake sample so the flow is visible.
                setPhonePair({ status: "ready", pairing: { url: "wss://ares.example.org/gateway", token: "demo-token-not-real", name: "demo", link: "ares://pair?url=wss%3A%2F%2Fares.example.org%2Fgateway&token=demo-token-not-real&name=demo", permanence: "tunnel", advice: "Demo mode: this is a sample code. In the desktop app it points at your own computer." } });
                return;
              }
              setPhonePair({ status: "loading" });
              daemonCmd({ type: "phone_pair" });
            }}
            onPhonePairClose={() => setPhonePair({ status: "idle" })}
            onUnpair={(deviceId) => daemonCmd({ type: "remote_device_unpair", deviceId })}
            onClearLink={() => setRemoteLink(null)}
            onDisconnect={(pcId) => { daemonCmd({ type: "remote_pc_disconnect", pcId }); setRemoteShots((p) => { const n = { ...p }; delete n[pcId]; return n; }); }}
            onRefresh={() => daemonCmd({ type: "remote_pcs" })}
            onPreview={(pcId) => { setRemoteShots((p) => ({ ...p, [pcId]: { ...p[pcId], loading: true } })); daemonCmd({ type: "remote_pc_screenshot", pcId }); }}
            onHelp={(pc) => {
              setView("chat");
              send(`Help ${pc.label || pc.hostname} with their PC. It's connected as remote PC id "${pc.id}" (${pc.os}). Use the RemotePC tool (exec_on_pc, get_file/put_file, screenshot_pc) to work on THEIR machine — match commands to their OS. Ask me what's wrong if you don't know yet.`);
            }}
          />
        ) : (
          <AgentChatContext.Provider value={activeAgent ?? null}>
          <div className="chat" ref={scroller} onScroll={onChatScroll} data-imsg={activeAgent || prefs.surface === "messages" ? "1" : "0"}>
            {active?.loading ? (
              <div className="empty">
                <div className="wordmark">LOADING</div>
                <p className="wordmarkSub">Restoring this session from its durable event log.</p>
              </div>
            ) : active && active.items.length === 0 && activeAgent ? (
              <AgentHero
                agent={activeAgent}
                others={agents.filter((a) => a.id !== activeAgent.id)}
                onSend={(text) => send(text)}
                onEdit={() => { setAgentError(undefined); setAgentEditor({ mode: "edit", id: activeAgent.id }); }}
              />
            ) : active && active.items.length === 0 && !activeRoom && agents.length > 0 ? (
              // Launch lands here with no one picked: choose who to text,
              // never a blank chat that belongs to no agent.
              <div className="agentPicker">
                <h2>Who do you want to text?</h2>
                <div className="agentPickerGrid">
                  {agents.map((a) => (
                    <button key={a.id} type="button" className="agentPickerCard" onClick={() => selectAgent(a.id)}>
                      <AgentAvatar agent={a} size={56} />
                      <span className="agentPickerName">{a.name}</span>
                      {a.instructions.trim() ? <span className="agentPickerRole">{a.instructions.trim().split(/\r?\n/)[0]}</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : active && active.items.length === 0 && !activeRoom && !agentsLoaded ? (
              <div className="empty">
                <div className="wordmark">LOADING</div>
                <p className="wordmarkSub">Bringing your agents in.</p>
              </div>
            ) : active && active.items.length === 0 && !activeRoom ? (
              // Nobody talks to Ares directly (owner, 2026-10-22): with no
              // agents yet, the only way forward is making one.
              <div className="agentPicker">
                <h2>Make someone to text</h2>
                <p className="wordmarkSub">Every chat is with an agent you make: a name, a face and a job.</p>
                <button type="button" className="agentPrimary" onClick={() => { setAgentError(undefined); setAgentEditor({ mode: "create" }); }}>Make my first agent</button>
              </div>
            ) : null}
            {active && active.items.length > transcriptCap ? (
              <button
                className="showEarlier"
                onClick={() => setTranscriptCap((cap) => cap + TRANSCRIPT_WINDOW)}
              >
                Show earlier — {active.items.length - transcriptCap} older items
              </button>
            ) : null}
            {(active
              ? active.items.length > transcriptCap
                ? active.items.slice(-transcriptCap)
                : active.items
              : []
            ).map((item, index, shown) => (
              <Fragment key={item.key}>
                <ItemView
                  onConnectService={connectService}
                  onDismissConnect={dismissConnect}
                  item={item}
                  onPermission={respondPermission}
                  onArtifact={openArtifact}
                  onSignIn={startAnthropicSignIn}
                  toolDisplay={prefs.toolDisplay}
                />
                {/* iMessage receipts: under the owner's latest message only. */}
                {activeAgent && item.kind === "user" && !parseAgentText(item.text) && !shown.slice(index + 1).some((x) => x.kind === "user" && !parseAgentText(x.text)) ? (
                  <div className="turn user imsgReceiptRow"><span className="imsgReceipt">{shown.slice(index + 1).some((x) => x.kind === "assistant" && x.text.trim()) ? "Read" : "Delivered"}</span></div>
                ) : null}
              </Fragment>
            ))}
            {/* The typing bubble: the agent is working and has not started
                talking yet (or is between tool calls). */}
            {activeAgent && active?.busy && !(active.items.at(-1)?.kind === "assistant" && (active.items.at(-1) as Extract<Item, { kind: "assistant" }>).streaming && (active.items.at(-1) as Extract<Item, { kind: "assistant" }>).text.trim()) ? (
              <div className="turn assistant imsgTyping" aria-label={`${activeAgent.name} is typing`}>
                <span className="turnMark imsgFace"><AgentAvatar agent={activeAgent} size={30} busy /></span>
                <div className="typingBubble"><i /><i /><i /></div>
                {(() => {
                  // What it's doing and for how long: a long think (Opus can go
                  // minutes before its first word) must never look frozen.
                  const doing = active.activity && !/^(working|response committed|settling proposed actions|generating)$/i.test(active.activity) ? active.activity : workingElapsedS >= 6 ? "thinking" : null;
                  const took = workingElapsedS >= 6 ? (workingElapsedS >= 60 ? `${Math.floor(workingElapsedS / 60)}m ${workingElapsedS % 60}s` : `${workingElapsedS}s`) : null;
                  return doing || took ? <span className="typingNow">{[doing, took].filter(Boolean).join(" · ")}</span> : null;
                })()}
              </div>
            ) : null}
            {active?.busy ? (
              <div className="working">
                <span className="workingForge" />
                <span className="workingLabel" key={active.activity ?? "working"}>
                  {active.activity ?? "working"}
                </span>
                {workingElapsedS >= 3 ? <span className="workingElapsed">{workingElapsedS}s</span> : null}
                {workingHint ? <span className="workingHint">{workingHint}</span> : null}
                {native && (quietS >= 90 || (activeTurnStatus?.lastEventMs ?? 0) >= 90_000) ? (
                  <button className="pillBtn" onClick={() => daemonCmd({ type: "stall_report", sessionId: active.id })} title="save what this chat is stuck on to a file you can send">
                    save stall report
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          {/* Outside the scroller, in its own slot above the composer: a
              sticky pill inside the transcript sat on top of the words. */}
          {!pinned ? (
            <div className="jumpDock">
              <button className="jumpLatest" onClick={jumpToLatest} title="jump to latest">
                ↓ latest
              </button>
            </div>
          ) : null}
          </AgentChatContext.Provider>
        )}

        {active?.fleet && active.fleet.agents.length > 0 && (active.fleet.active || active.fleet.canResume) ? (
          <FleetPanel
            fleet={active.fleet}
            onResume={(fleetId) =>
              send(`Resume the agent fleet "${fleetId}" — author a Conductor FleetSpec with resumeFleetId: "${fleetId}" so the completed leaves are reused from disk and only the failed/incomplete ones re-run.`)
            }
          />
        ) : null}

        {active?.codingBackend ? <CodingBackendScene vm={active.codingBackend} /> : null}

        {health === "unresponsive" ? (
          <div className="recoveryBanner" role="alert">
            <div className="recoveryBody">
              <b>Ares isn't answering</b>
              <span>No reply to a health check for {Math.round((healthNow - lastPingAtRef.current) / 1000)}s. Restarting keeps your chats; a turn in progress stops.</span>
            </div>
            <div className="recoveryActions">
              <button className="btn primary" onClick={() => restartDaemon()}>Restart Ares</button>
            </div>
          </div>
        ) : loopNote ? (
          <div className="recoveryBanner" role="status">
            <div className="recoveryBody">
              <b>Other chats are waiting</b>
              <span>{loopNote}</span>
            </div>
          </div>
        ) : null}
        {active?.pendingRecovery && view !== "helm" ? (
          <div className="recoveryBanner" role="status">
            <div className="recoveryBody">
              <b>Unfinished from last time</b>
              <span>
                {active.pendingRecovery.previews[0]?.goal ? `“${compact(active.pendingRecovery.previews[0].goal, 140)}”` : "a pending request"}
                {active.pendingRecovery.count > 1 ? ` and ${active.pendingRecovery.count - 1} more` : ""}
                {" — nothing runs until you choose."}
              </span>
            </div>
            <div className="recoveryActions">
              <button className="btn primary" onClick={() => daemonCmd({ type: "startup_recovery_resume", sessionId: active.id })}>Resume</button>
              <button className="btn ghost" onClick={() => daemonCmd({ type: "startup_recovery_discard", sessionId: active.id })}>Discard</button>
            </div>
          </div>
        ) : null}
        {/* An older chat (from before agents) is read-only until an agent
            takes it: there is no talking to Ares directly. */}
        {view === "chat" && !activeRoom && active && !activeAgent && !roomSeatIds.has(active.id) && active.items.length > 0 && agentsLoaded ? (
          <div className="recoveryBanner" role="status">
            <div className="recoveryBody">
              <b>Older chat</b>
              <span>{agents.length > 0 ? "Hand it to an agent to keep going. It keeps everything." : "Make an agent, then hand this chat to it to keep going."}</span>
            </div>
            <div className="recoveryActions">
              {agents.length > 0
                ? agents.map((a) => <button key={a.id} className="btn ghost" onClick={() => giveChat(active.id, a.id)}>Give to {a.name}</button>)
                : <button className="btn primary" onClick={() => { setAgentError(undefined); setAgentEditor({ mode: "create" }); }}>Make an agent</button>}
            </div>
          </div>
        ) : null}
        {/* Kept MOUNTED on HELM (hidden, not unmounted) — unmounting destroyed
            the draft text and pending attachments every time the view flipped. */}
        <Composer
          agentName={activeAgent?.name ?? "Ares"}
            hidden={view === "helm" || view === "now" || view === "feed" || view === "artifacts" || view === "aresos" || Boolean(activeRoom) || (!activeAgent && !roomSeatIds.has(active?.id ?? ""))}
            busy={active?.busy ?? false}
            cancelling={active?.cancelling ?? false}
            model={liveModel}
            autoRouting={prefs.routingMode === "auto"}
            routedLanes={routedLanes}
            todos={active?.todos ?? []}
            backgroundJobs={active ? bgJobs[active.id] ?? [] : []}
            onStopBackground={(id) => daemonCmd({ type: "background_stop", id, sessionId: active?.id })}
            onResumeBackground={(id) => daemonCmd({ type: "background_resume", id, sessionId: active?.id })}
            steerQueued={active?.steerQueued ?? 0}
            steerActivity={active?.activity}
            recoverableDrafts={active?.recoverableDrafts ?? []}
            onDraftsRecovered={(inputIds) => {
              const sid = active?.id;
              if (!sid || inputIds.length === 0) return;
              const recovered = new Set(inputIds);
              applyTo(sid, (s) => ({
                ...s,
                recoverableDrafts: (s.recoverableDrafts ?? []).filter((draft) => !recovered.has(draft.inputId)),
              }));
            }}
            onSend={(t, imgs) => send(t, { images: imgs })}
            onSteer={steer}
            onStop={stopTurn}
            onModelChip={() => setModelPopOpen(true)}
            onRoutingChip={() => setRoutingOpen(true)}
            slashActions={slashActions}
            footer={activeAgent ? (
              <AgentComposerMeta
                agent={activeAgent}
                providers={PROVIDERS.filter((p) => p !== "mock" && p !== "moa")}
                requestCatalog={requestAgentCatalog}
                onChange={(patch) => daemonCmd({ type: "agent_update", agentId: activeAgent.id, agent: patch })}
              />
            ) : null}
        />

        <footer className="statusBar">
          <div className="statusGroup">
            {/* data-seg drives the responsive shedding order in modern.css.
                It used to key off these buttons' `title` text, which broke the
                moment a title changed with state: in auto-routing the MODEL
                segment's title contains the word "routing", so the rule meant
                to hide the route chip hid the model instead. */}
            <button className="statusSeg" data-seg="garrison" onClick={() => setGarrisonOpen(true)} title="Garrison panel — status, log, restart">
              <i className="dot" data-state={daemon} /><b>garrison</b><span>{daemon}</span>
            </button>
            {/* The agent's own computer (docs/AGENT-COMPUTER-DESIGN.md).
                Click TOGGLES where Ares may work — same interaction the perms
                chip uses — because "keep off my machine" is a posture the
                owner changes often and should never have to hunt for.
                Shift-click opens the screen (alt adds watch-only). */}
            {native ? (
              <button
                className="statusSeg"
                data-seg="computer"
                data-mode={computerMode}
                onClick={(e) => {
                  if (e.shiftKey) {
                    daemonCmd({ type: "computer_screen", viewOnly: e.altKey });
                    return;
                  }
                  const next = computerMode === "sandbox" ? "host" : "sandbox";
                  setComputerMode(next);
                  daemonCmd({ type: "computer_mode", mode: next });
                }}
                title={
                  computerMode === "sandbox"
                    ? "SANDBOX ONLY — Ares works on its own Linux machine; your PC's shell, GUI and file writes are withheld. Click for host mode. Shift-click: open its screen (add Alt to watch only)."
                    : "Ares works on your machine (gated as usual) and on its own computer when asked. Click to confine it to its own machine. Shift-click: open its screen (add Alt to watch only)."
                }
              >
                <b>computer</b><span>{computerMode === "sandbox" ? "sandbox only" : "host"}</span>
              </button>
            ) : null}
            {/* WHICH HANDS did the work. When Ares delegates to an external
                coding harness (Claude Code / Codex on the Ares account), the
                cut-scene scrolls away with the turn — this chip stays for the
                whole session, so delegation is always disclosed, never buried. */}
            {(active?.codingBackend ?? active?.lastCodingBackend) ? (
              <button
                className="statusSeg"
                data-seg="harness"
                data-state={(active?.codingBackend ?? active?.lastCodingBackend)?.phase}
                title={`This session used the ${(active?.codingBackend ?? active?.lastCodingBackend)?.label} harness (Ares account credentials, no user OAuth).\nLast run: ${(active?.codingBackend ?? active?.lastCodingBackend)?.phase}.`}
              >
                <b>harness</b>
                <span>
                  {(active?.codingBackend ?? active?.lastCodingBackend)?.backend}
                  {" · "}
                  {(active?.codingBackend ?? active?.lastCodingBackend)?.phase}
                </span>
              </button>
            ) : null}
            <button
              className="statusSeg"
              data-seg="model"
              data-auto={prefs.routingMode === "auto" ? "1" : "0"}
              onClick={() => setModelPopOpen(true)}
              title={
                prefs.routingMode === "auto"
                  ? `Auto-routing is on — ${active?.turnModel ? `${liveModel} handled the last turn` : `${liveModel} will take the next message`}.\nOpens the model picker (sets the fallback model for unassigned lanes).${routeSummary ? `\n\nLanes:\n${routeSummary}` : ""}`
                  : "switch provider / model"
              }
            >
              <b>model</b><span>{liveModel}</span>
              {prefs.routingMode === "auto" ? <em className="segAuto">auto</em> : null}
            </button>
            <button
              className="statusSeg contextSeg"
              data-seg="context"
              data-tone={contextTone(sessionContext(active).prompt, sessionContext(active).window)}
              onClick={() => { setContextPopOpen((v) => !v); daemonCmd({ type: "provider_usage" }); }}
              title="Context window fill and your plan's usage limits"
            >
              <b>context</b>
              <span>{contextLabel(sessionContext(active).prompt, sessionContext(active).window)}</span>
              <i className="contextMeter" aria-hidden="true"><em style={{ width: `${Math.round(contextFraction(sessionContext(active).prompt, sessionContext(active).window) * 100)}%` }} /></i>
            </button>
            <button className="statusSeg effortStatus" data-seg="effort" onClick={() => setReasoningOpen(true)} title="Set the active model's native reasoning effort">
              <b>effort</b><span>{EFFORT_META[effectiveEffort(prefs.provider, prefs.model, prefs.reasoning)].label.toLowerCase()}</span>
            </button>
            {/* The route chip is the door to the War Table, so it names the
                lanes it routes rather than just counting them — "all I see is
                on" was this chip reading `auto · 2` with the mapping hidden. */}
            <button
              className="statusSeg"
              data-seg="route"
              onClick={() => setRoutingOpen(true)}
              title={
                routedLanes.length
                  ? `Per-lane model routing${prefs.routingMode === "auto" ? " (active)" : " (assigned, but Auto is off)"}:\n${routeSummary}\n\nClick to edit the War Table.`
                  : "Per-lane model routing — nothing assigned yet. Click to open the War Table and give each kind of work its own model."
              }
            >
              <b>route</b>
              <span>
                {prefs.routingMode !== "auto"
                  ? routedLanes.length > 0
                    ? `off · ${routedLanes.length} set`
                    : "off"
                  : routedLanes.length === 0
                    ? "auto · none set"
                    : routedLanes.join(" · ")}
              </span>
            </button>
            {opStatus?.activeCount ? (
              <button
                className="statusSeg"
                onClick={() => {
                  daemonCmd({ type: "operator_status" });
                  setCronOpen(true);
                }}
                title="durable missions (Operator)"
              >
                <i className="dot" data-state="running" /><b>missions</b><span>{opStatus.activeCount}</span>
              </button>
            ) : null}
            {/* YOLO: one click between "ask me about the dangerous things" and
                "act on everything, never ask". This is the SAME posture the
                Permissions pane writes — free + sensitive auto-approved — just
                reachable without opening settings, because it's the toggle
                you flip mid-task. Deliberately reads YOLO when armed so it can
                never be mistaken for the guarded default. */}
            <button
              className="statusSeg permSeg"
              data-seg="perms"
              data-yolo={permissions.mode === "free" ? "1" : "0"}
              onClick={() => {
                const next: PermSettings = permissions.mode === "free"
                  ? { ...permissions, mode: "guarded", sensitive: false }
                  : { ...permissions, mode: "free", sensitive: true, fleetsInherit: true };
                setPermissions(next);
                daemonCmd({ type: "set_permissions", permissions: next });
              }}
              title={
                permissions.mode === "free"
                  ? "YOLO is ON — Ares acts on everything without asking, including credentials, payments and destructive commands. Click to return to guarded."
                  : "Guarded — Ares asks before sensitive actions. Click to arm YOLO (auto-approve everything, no prompts)."
              }
            >
              <b>perms</b><span>{permissions.mode === "free" ? "YOLO" : "guarded"}</span>
            </button>
            <button className="statusSeg" data-seg="effects" onClick={cycleFlame} title="working-state effects — glow (static ember rim) / minimal (header indicator only) / off. Nothing flashes in any mode.">
              <b>effects</b><span>{prefs.flameMode}</span>
            </button>
          </div>
            {contextPopOpen ? (
              <ContextPopover
                promptTokens={sessionContext(active).prompt}
                windowTokens={sessionContext(active).window}
                usage={providerUsage}
                onRefresh={() => daemonCmd({ type: "provider_usage", force: true })}
                onClose={() => setContextPopOpen(false)}
                onDetails={() => { setContextPopOpen(false); setSettingsOpen(true); setSettingsTab("usage"); }}
              />
            ) : null}
          <span className="grow" />
          <span className="hudReadout" title={`This session: ${fmtTokens(active?.tokensOut ?? 0)} written by the model. ${fmtTokens(Math.max(0, (active?.tokensIn ?? 0) - (active?.cacheReadTokens ?? 0)))} new input; ${fmtTokens(active?.cacheReadTokens ?? 0)} re-read from cache (each call re-reads the conversation, so raw input totals are large and not a cost).`}>
            ↓<SpringNumber value={active?.tokensOut ?? 0} format={fmtTokens} /> written{active && active.tokensIn > 0 && active.cacheReadTokens / active.tokensIn >= 0.5 ? ` · ${Math.round((active.cacheReadTokens / active.tokensIn) * 100)}% cached` : ""}
          </span>
          <div className="statusGroup statusActions">
            {native && daemon !== "running" && daemon !== "starting" ? (
              <button className="statusIcon" onClick={() => { restartAttempts.current = 0; restartDaemon(); }} title="Restart the Garrison" aria-label="Restart">⟳</button>
            ) : null}
            <button className="statusIcon" onClick={() => void exportSessionLog()} title="Export this session (chat + tool calls + errors) to a file" aria-label="Export session">⤓</button>
            <button className="statusIcon" onClick={() => setReportOpen(true)} disabled={!active?.id} title="Report a bug — upload this chat so the owner can diagnose it" aria-label="Report a bug">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M8 5.5v6M4.5 8H2m12 0h-2.5M4.8 5.2 3.4 3.8m9.2 1.4 1.4-1.4M4.6 11l-1.4 1.4m9.6-1.4 1.4 1.4"/><rect x="5" y="4.5" width="6" height="7.5" rx="3"/></svg>
            </button>
            <button className="statusIcon" onClick={() => setPaletteOpen(true)} title="Command palette (Ctrl+K)" aria-label="Command palette">⌘</button>
          </div>
          <span className="hudVersion" title={`Ares v${APP_VERSION}`}>{APP_VERSION}</span>
        </footer>
      </main>

      {forge.open ? (
        <aside className="forge" data-closing={forgeClosing ? "1" : "0"} data-mode={forgeMode}>
          <div className="forgeGrip" onPointerDown={onForgeGrip} />
          <ForgePixelRim palette={forgeMode === "explain" ? "gold" : "blue"} />
          <header>
            {(() => {
              const st = embeddedActive || (liveFeed && liveFeed.watching) ? "live" : liveTarget ? (liveLoading ? "loading" : "live") : "idle";
              return (
                <strong>
                  <PixelIcon name="ares" size={15} palette={st === "live" ? "green" : st === "loading" ? "ember" : "blue"} className={`forgeMark ${st}`} />
                  THE FORGE
                </strong>
              );
            })()}
            <div className="forgeTabs" role="tablist">
              <button role="tab" data-on={forge.tab === "live" ? "1" : "0"} data-live={forge.tab !== "live" && liveTarget ? "1" : "0"} onClick={() => setForge((f) => ({ ...f, tab: "live" }))}><PixelIcon name="live" size={10} palette={forge.tab === "live" ? "blue" : "dim"} />Live</button>
              <button role="tab" data-on={forge.tab === "preview" || forge.tab === "holo" || forge.tab === "sandbox" ? "1" : "0"} onClick={() => setForge((f) => ({ ...f, tab: "preview" }))}><PixelIcon name="artifacts" size={10} palette={forge.tab === "preview" || forge.tab === "holo" || forge.tab === "sandbox" ? "blue" : "dim"} />Files</button>
              <button role="tab" data-on={forge.tab === "background" ? "1" : "0"} onClick={() => { setForge((f) => ({ ...f, tab: "background" })); daemonCmd({ type: "subagents_list" }); daemonCmd({ type: "background_list", sessionId: active?.id }); daemonCmd({ type: "operator_status" }); }}>Background</button>
            </div>
            <span className="forgeSurfaceState" data-live={forge.tab === "live" && liveBrowser && Date.now() - liveBrowser.at < 4000 ? "1" : "0"}>
              {forge.tab === "live" ? (embeddedActive ? "interactive canvas" : liveTarget ? "browser canvas" : "canvas ready") : forge.tab === "holo" ? "spatial artifact" : forge.artifact ? forge.artifact.label : "artifact canvas"}
            </span>
            <button className="ghost forgeClose" onClick={requestForgeClose} title="Close the Forge" aria-label="Close the Forge">
              ✕
            </button>
          </header>

          {forge.tab === "background" ? (
            <ForgeBackgroundPanel
              jobs={active ? bgJobs[active.id] ?? [] : []}
              agents={subagentJobs}
              opStatus={opStatus}
              recovery={active?.pendingRecovery ?? null}
              recoveryMode={recoveryMode}
              onStop={(id) => daemonCmd({ type: "background_stop", id, sessionId: active?.id })}
              onStopAgent={(jobId) => daemonCmd({ type: "interrupt", sessionId: jobId })}
              onResume={() => active && daemonCmd({ type: "startup_recovery_resume", sessionId: active.id })}
              onDiscard={() => active && daemonCmd({ type: "startup_recovery_discard", sessionId: active.id })}
              onHalt={() => daemonCmd({ type: "operator_control", action: "halt" })}
              onRefresh={() => { daemonCmd({ type: "subagents_list" }); daemonCmd({ type: "background_list", sessionId: active?.id }); daemonCmd({ type: "operator_status" }); }}
            />
          ) : null}
          {forge.tab === "preview" ? (
            forge.artifact ? (
              <div className="forgeBody">
                <div className="forgeToolbar">
                  <span className="forgeMeta"><PixelIcon name="artifacts" size={11} palette="gold" />{forge.artifact.label}</span>
                  <button onClick={() => setPreviewRevision((n) => n + 1)}><PixelIcon name="reload" size={9} palette="dim" />Refresh</button>
                  {native ? <button onClick={() => void invoke("ares_open_path", { path: forge.artifact!.path })}>↗ Launch</button> : null}
                </div>
                {forgeDoc && forgeDoc.path === forge.artifact.path ? (
                  <div className="forgeDoc" dangerouslySetInnerHTML={{ __html: forgeDoc.html }} />
                ) : /\.(md|markdown)$/i.test(forge.artifact.path) ? (
                  <div className="forgeDoc"><p>Reading {forge.artifact.label}…</p></div>
                ) : (
                  <div className="liveStage interactive artifactStage">
                    <iframe
                      key={`${forge.artifact.path}-${previewRevision}`}
                      title={forge.artifact.label}
                      src={native ? `${convertFileSrc(forge.artifact.path)}?forge=${previewRevision}` : undefined}
                      srcDoc={native ? undefined : holoDefaultHtml()}
                      sandbox={PREVIEW_SANDBOX}
                      onLoad={() => setArtifactRevealKey((k) => k + 1)}
                    />
                    <div className="forgeStageFx" key={`afx-${artifactRevealKey}`} data-sweep={artifactRevealKey > 0 ? "1" : "0"} aria-hidden="true">
                      <i className="forgeCorner tl" /><i className="forgeCorner tr" /><i className="forgeCorner bl" /><i className="forgeCorner br" />
                    </div>
                    <ForgePixelReveal runKey={artifactRevealKey} mode="in" cell={8} durationMs={640} />
                  </div>
                )}
              </div>
            ) : (
              <div className="forgeIdle">
                <ForgePixelPulse cell={8} period={3400} />
                <div className="forgeOrbital" aria-hidden="true">
                  <div className="forgeOrbit" /><div className="forgeOrbit o2" />
                  <div className="forgeCube"><i /><i /><i /><i /><i /><i /></div>
                  <PixelIcon name="artifacts" size={30} palette="gold" className="forgeLoadingSigil" />
                </div>
                <div className="forgeIdleTitle">No files yet</div>
                <p className="forgeIdleLead">Pages, documents and pictures your agents make open here the moment they exist.</p>
                <div className="forgeIdleReadout"><span>watch <b>armed</b></span><span>render <b>ready</b></span></div>
              </div>
            )
          ) : null}

          {forge.tab === "sandbox" ? (
            <div className="forgeBody sandbox">
              <div className="sandboxBar">
                <span>live HTML — scripts run for real</span>
                <span className="forgeActions">
                  {native && sandboxSrc?.path ? <button onClick={() => void invoke("ares_open_path", { path: sandboxSrc.path })}>↗ Launch</button> : null}
                  <button onClick={() => void runSandbox(sandboxCode)}>↻ Refresh</button>
                  <button className="primary tiny" onClick={() => void runSandbox(sandboxCode)}>▶ Run</button>
                </span>
              </div>
              <textarea className="sandboxCode" value={sandboxCode} onChange={(e) => setSandboxCode(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void runSandbox(sandboxCode); } }} spellCheck={false} />
              <iframe title="sandbox" src={sandboxSrc?.src} srcDoc={sandboxSrc?.srcdoc} sandbox={PREVIEW_SANDBOX} />
            </div>
          ) : null}

          {forge.tab === "holo" ? (
            <div className="forgeBody">
              <div className="forgeToolbar">
                <span className="forgeMeta">{holoMeta}</span>
                <button onClick={() => setHoloSrc((current) => current?.src ? { ...current, src: `${current.src.split("?")[0]}?t=${Date.now()}` } : current)}>↻ Refresh</button>
                {native && holoSrc?.path ? <button onClick={() => void invoke("ares_open_path", { path: holoSrc.path })}>↗ Launch</button> : null}
              </div>
              <iframe title="holo" src={holoSrc?.src} srcDoc={holoSrc?.srcdoc} sandbox={PREVIEW_SANDBOX} />
            </div>
          ) : null}

          {forge.tab === "live" ? (
            <div className="forgeBody liveBrowser">
              <form className="liveToolbar" onSubmit={(e) => { e.preventDefault(); const url = launchableUrl(liveUrl); if (url) { setLiveTarget({ url, title: "Manual preview", at: Date.now() }); setLiveUrl(url); setLiveRevision((n) => n + 1); } }}>
                <i className={embeddedActive || liveTarget ? "liveDot" : "idleDot"} />
                <input aria-label="Preview URL" value={liveUrl} onChange={(e) => setLiveUrl(e.target.value)} placeholder="localhost:3000 or https://…" />
                <button type="submit" className="liveGo">Open</button>
                {native && liveTarget && forgeNativeTarget(liveTarget.url) ? (
                  <>
                    <button type="button" onClick={() => forgeViewControl("back")} aria-label="Back">←</button>
                    <button type="button" onClick={() => forgeViewControl("forward")} aria-label="Forward">→</button>
                  </>
                ) : null}
                <button type="button" onClick={() => setLiveRevision((n) => n + 1)} disabled={!liveTarget}>↻</button>
                {native && liveTarget && /^https?:/i.test(liveTarget.url) ? <button type="button" onClick={() => void invoke("ares_open_url", { url: liveTarget.url })} title="Open a separate copy in your browser" aria-label="Open a separate copy">↗</button> : null}
              </form>
              {/* The HUD: one row of pills that says, at a glance, what the
                  stage is showing and how the page is doing — state, title,
                  served folder, frame rate, errors, warnings, load time, age.
                  Fed by the Forge sensor inside the served page. */}
              {(() => {
                const telemetryCurrent = !!(forgeTelemetry && liveTarget && !embeddedActive && (forgeTelemetry.url === liveTarget.url || forgeTelemetry.url.startsWith(liveTarget.url.split("?")[0]!)));
                const tele = telemetryCurrent ? forgeTelemetry : null;
                const served = !embeddedActive && liveConsole?.served && liveTarget && liveConsole.url === liveTarget.url ? liveConsole.served : null;
                const loadErrors = !embeddedActive && liveConsole && liveTarget && liveConsole.url === liveTarget.url ? liveConsole.errors : [];
                const errorLines = tele && tele.errors.length ? tele.errors : loadErrors;
                const errorCount = tele ? Math.max(tele.errorCount, loadErrors.length) : loadErrors.length;
                const warnCount = tele?.warningCount ?? 0;
                const title = embeddedActive
                  ? embeddedActivity || "Interactive app controlled by Ares"
                  : liveFeed && (!liveTarget || liveFeed.at >= liveTarget.at)
                    ? `${liveFeed.label}${liveFeed.step ? ` · ${liveFeed.step}` : ""}${liveFeed.note ? ` · ${liveFeed.note}` : liveFeed.watching ? " · watching" : ""}`
                    : liveTarget?.title || liveTarget?.url || "Nothing on the stage yet";
                const state = embeddedActive || (liveFeed && liveFeed.watching) ? "live" : liveTarget ? (liveLoading ? "loading" : "live") : "idle";
                const ageS = liveLoadedAt ? Math.max(0, Math.floor((hudNow - liveLoadedAt) / 1000)) : null;
                const fpsTone = tele?.fps == null ? "" : tele.fps < 30 ? "bad" : tele.fps < 50 ? "warn" : "ok";
                return (
                  <>
                    <div className="forgeHud" data-state={state}>
                      <span className="hudPill hudState" data-state={state}>
                        <PixelIcon name={state === "live" ? "live" : state === "loading" ? "reload" : "idle"} size={10} palette={state === "live" ? "green" : state === "loading" ? "ember" : "dim"} />
                        {state === "loading" ? "forging" : forgeMode === "explain" && state === "live" ? "explaining" : state}
                      </span>
                      <span className="hudPill hudTitle" title={liveTarget?.url ?? ""}>{title}</span>
                      {served ? <span className="hudPill hudServed" title={`Served from ${served.root} at ${served.origin}`}><PixelIcon name="host" size={10} palette="gold" />{served.root.split(/[\\/]/).filter(Boolean).pop()}</span> : null}
                      {tele?.fps != null ? (
                        <span className="hudPill hudFps" data-tone={fpsTone} title={`longest frame ${tele.longestMs}ms`}>
                          {fpsHistory.length > 1 ? (
                            <svg className="hudSpark" viewBox="0 0 44 12" preserveAspectRatio="none" aria-hidden="true">
                              <line x1="0" y1="6" x2="44" y2="6" />
                              <polyline points={fpsHistory.slice(-24).map((v, i, arr) => `${(i / Math.max(1, arr.length - 1)) * 44},${12 - Math.min(12, (Math.max(0, Math.min(v, 90)) / 90) * 12)}`).join(" ")} />
                            </svg>
                          ) : null}
                          {tele.fps} fps
                        </span>
                      ) : null}
                      {errorCount > 0 ? (
                        <button type="button" className="hudPill hudErr" data-on={forgeDrawer === "errors" ? "1" : "0"} onClick={() => setForgeDrawer((d) => (d === "errors" ? null : "errors"))}><PixelIcon name="error" size={9} palette="red" />{errorCount} error{errorCount === 1 ? "" : "s"}</button>
                      ) : null}
                      {warnCount > 0 ? (
                        <button type="button" className="hudPill hudWarn" data-on={forgeDrawer === "warnings" ? "1" : "0"} onClick={() => setForgeDrawer((d) => (d === "warnings" ? null : "warnings"))}><PixelIcon name="warn" size={10} palette="gold" />{warnCount} warn</button>
                      ) : null}
                      {tele?.loadMs != null ? <span className="hudPill hudLoad"><PixelIcon name="clock" size={10} palette="dim" />{tele.loadMs}ms</span> : null}
                      {ageS != null && state === "live" ? <span className="hudPill hudAge"><PixelIcon name="reload" size={10} palette="dim" />{ageS < 5 ? "fresh" : `${ageS}s ago`}</span> : null}
                    </div>
                    {forgeLog.length > 0 && liveTarget && !embeddedActive ? (() => {
                      const last = forgeLog[forgeLog.length - 1]!;
                      const age = Math.max(0, Math.floor((hudNow - last.at) / 1000));
                      return (
                        <div className="forgeTicker" data-tone={last.tone} title={forgeLog.map((l) => l.text).join("\n")}>
                          <span key={last.at}>{last.text}</span>
                          <time>{age < 2 ? "now" : `${age}s`}</time>
                        </div>
                      );
                    })() : null}
                    {forgeDrawer && (forgeDrawer === "errors" ? errorLines.length > 0 : (tele?.warnings.length ?? 0) > 0) ? (
                      <div className={`forgeDrawer ${forgeDrawer}`} role="status">
                        <div className="forgeDrawerHead">
                          <strong>{forgeDrawer === "errors" ? "What the page threw" : "Warnings from the page"}</strong>
                          <span>{forgeDrawer === "errors" ? "Ares has these too and will fix what its edits broke" : "visible to Ares as well"}</span>
                          <button type="button" onClick={() => setForgeDrawer(null)} aria-label="Close">×</button>
                        </div>
                        <ul>
                          {(forgeDrawer === "errors" ? errorLines : tele?.warnings ?? []).slice(-8).map((line, idx) => (
                            <li key={idx}>{line}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </>
                );
              })()}
              {/* interactive embedded browser (Ares's own HTML apps/games) */}
              <div className="liveStage embed" data-on={embeddedActive ? "1" : "0"}>
                <EmbeddedBrowser ref={embeddedRef} onActivity={setEmbeddedActivity} />
              </div>
              {/* Local apps are safely embeddable. External sites frequently
                  refuse frames; show the actual Playwright screencast instead
                  of a blocked iframe that falsely appears interactive. */}
              {/* Engine feed (Godot game/editor): the latest frame, plus the
                  owner's keyboard and mouse forwarded into the running game. */}
              {!embeddedActive && liveFeed && (liveBrowser || liveEmbed) && (!liveTarget || liveFeed.at >= liveTarget.at) ? (
                <div
                  ref={liveStageRef}
                  className={`liveStage interactive engineFeed ${liveInteract ? "capturing" : ""} ${liveEmbed ? "embedded" : ""}`}
                  data-live={liveEmbed || Date.now() - liveFeed.at < 4000 ? "1" : "0"}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (!liveInteract) return;
                    if (e.code === "Escape" && e.shiftKey) { setLiveInteract(false); releaseLiveKeys(); if (document.pointerLockElement) document.exitPointerLock(); return; }
                    e.preventDefault();
                    if (e.repeat) return;
                    const key = godotKeyName(e.code, e.key);
                    if (!key) return;
                    liveHeldKeys.current.add(key);
                    sendLiveInput([{ kind: "key", key, pressed: true, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey }]);
                  }}
                  onKeyUp={(e) => {
                    if (!liveInteract) return;
                    e.preventDefault();
                    const key = godotKeyName(e.code, e.key);
                    if (!key) return;
                    liveHeldKeys.current.delete(key);
                    sendLiveInput([{ kind: "key", key, pressed: false }]);
                  }}
                  onBlur={() => releaseLiveKeys()}
                  onPointerDown={(e) => {
                    const el = e.currentTarget;
                    el.focus();
                    if (!liveInteract) { setLiveInteract(true); return; }
                    if (liveMouseLook && document.pointerLockElement !== el) { void el.requestPointerLock(); }
                    const { x, y } = frameCoords(el, e.clientX, e.clientY, liveFeed.width ?? el.clientWidth, liveFeed.height ?? el.clientHeight);
                    sendLiveInput([{ kind: "mouse", x, y, button: e.button === 2 ? 2 : e.button === 1 ? 3 : 1, pressed: true, move: !liveMouseLook }]);
                  }}
                  onPointerUp={(e) => {
                    if (!liveInteract) return;
                    const el = e.currentTarget;
                    const { x, y } = frameCoords(el, e.clientX, e.clientY, liveFeed.width ?? el.clientWidth, liveFeed.height ?? el.clientHeight);
                    sendLiveInput([{ kind: "mouse", x, y, button: e.button === 2 ? 2 : e.button === 1 ? 3 : 1, pressed: false, move: !liveMouseLook }]);
                  }}
                  onPointerMove={(e) => {
                    if (!liveInteract) return;
                    const el = e.currentTarget;
                    if (liveMouseLook) {
                      if (e.movementX || e.movementY) sendLiveInput([{ kind: "mouse", x: e.movementX, y: e.movementY, relative: true, mask: e.buttons }]);
                      return;
                    }
                    if (e.buttons === 0 && (e.timeStamp % 3) > 1) return; // thin hover traffic
                    const { x, y } = frameCoords(el, e.clientX, e.clientY, liveFeed.width ?? el.clientWidth, liveFeed.height ?? el.clientHeight);
                    sendLiveInput([{ kind: "mouse", x, y, mask: e.buttons }]);
                  }}
                  onWheel={(e) => {
                    if (!liveInteract) return;
                    e.preventDefault();
                    const el = e.currentTarget;
                    const { x, y } = frameCoords(el, e.clientX, e.clientY, liveFeed.width ?? el.clientWidth, liveFeed.height ?? el.clientHeight);
                    sendLiveInput([{ kind: "wheel", x, y, delta: e.deltaY }]);
                  }}
                  onContextMenu={(e) => { if (liveInteract) e.preventDefault(); }}
                >
                  {liveEmbed ? (
                    <div className="engineEmbedSlot" aria-label={`${liveEmbed.title} (embedded)`}>
                      <span>{liveEmbed.title}</span>
                    </div>
                  ) : liveBrowser ? (
                    <LiveFrameCanvas className="liveTelemetryMain" frame={liveBrowser.frame} title={liveFeed.label} />
                  ) : null}
                  <div className="engineFeedBar">
                    <span className={liveEmbed || Date.now() - liveFeed.at < 4000 ? "liveDot" : "idleDot"} />
                    <span className="engineFeedLabel">{liveFeed.side === "editor" ? "Godot editor" : "Godot game"}{liveEmbed ? " · native" : liveFeed.width ? ` · ${liveFeed.width}×${liveFeed.height}` : ""}</span>
                    {native && IS_WINDOWS_HOST ? (
                      liveEmbed ? (
                        <button type="button" data-on="1" onClick={() => releaseLiveWindow()} title="Give the window back to the desktop">⧉ Detach window</button>
                      ) : (liveFeed.pid || liveFeed.windowTitle) ? (
                        <button type="button" onClick={() => void embedLiveWindow()} title="Pull the real Godot window into this pane — native speed, direct input">⧉ Embed window</button>
                      ) : null
                    ) : null}
                    {liveEmbedError ? <span className="engineFeedHint" title={liveEmbedError}>couldn't embed — {liveEmbedError.slice(0, 60)}</span> : null}
                    {liveFeed.interactive && !liveEmbed ? (
                      <>
                        <button type="button" data-on={liveInteract ? "1" : "0"} onClick={() => { const next = !liveInteract; setLiveInteract(next); if (!next) { releaseLiveKeys(); if (document.pointerLockElement) document.exitPointerLock(); } }} title="Send your keyboard and mouse to the game (Shift+Esc releases)">
                          {liveInteract ? "⌨ Playing — Shift+Esc to release" : "🎮 Play"}
                        </button>
                        <button type="button" data-on={liveMouseLook ? "1" : "0"} onClick={() => setLiveMouseLook((v) => !v)} title="Relative mouse motion for first/third-person cameras (click the frame to capture the cursor)">
                          Mouse look
                        </button>
                      </>
                    ) : liveEmbed ? <span className="engineFeedHint">click inside to play — it is the real window</span> : <span className="engineFeedHint">view only</span>}
                    {liveEmbed ? null : liveFeed.watching ? (
                      <button type="button" onClick={() => { daemonCmd({ type: "live_unwatch" }); setLiveInteract(false); }}>Stop watching</button>
                    ) : liveFeed.offered ? (
                      <button type="button" onClick={() => daemonCmd({ type: "live_watch", source: liveFeed.source, side: liveFeed.side })}>Watch live</button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {/* The desktop shows every http(s) page in the Forge's NATIVE view
                  (forgeNativeView.tsx): a real browser over the stage, so any
                  site loads, sign-ins work, and Ares drives this same page —
                  never a frame stream or a screenshot. */}
              {!embeddedActive && liveTarget && native && forgeNativeTarget(liveTarget.url) && !(liveFeed && (liveBrowser || liveEmbed) && liveFeed.at >= liveTarget.at) ? (
                <div className="liveStage interactive nativeTarget">
                  <ForgeNativeView
                    url={liveTarget.url}
                    driven={liveTarget.driven}
                    revision={liveRevision}
                    visible={forge.open && forge.tab === "live"}
                    onNav={(url, loading) => {
                      setLiveLoading(loading);
                      if (!loading) { setLiveLoadedAt(Date.now()); setLiveUrl(url); }
                    }}
                    onError={(message) => logForge(`the Forge view: ${message}`, "warn")}
                  />
                  <div className="forgeLoading" data-on={liveLoading ? "1" : "0"} aria-hidden={!liveLoading}>
                    <span className="forgeLoadingUrl">{liveTarget.url.replace(/^https?:\/\//, "")}</span>
                  </div>
                </div>
              ) : null}
              {!embeddedActive && liveTarget && !(native && forgeNativeTarget(liveTarget.url)) && !(liveFeed && liveBrowser && liveFeed.at >= liveTarget.at) ? (
                <div className={`liveStage interactive ${forgeCanEmbed(liveTarget.url) ? "localTarget" : "externalTarget"}`}>
                  {forgeCanEmbed(liveTarget.url) ? (
                    <>
                      <iframe
                        key={`${liveTarget.url}-${liveRevision}`}
                        title={liveTarget.title || "Live preview"}
                        src={forgeFrameUrl(liveTarget.url, native, liveRevision)}
                        sandbox={PREVIEW_SANDBOX}
                        data-loading={liveLoading ? "1" : "0"}
                        onLoad={() => { setLiveLoading(false); setLiveLoadedAt(Date.now()); setStageRevealKey((k) => k + 1); }}
                      />
                      {/* While the page loads the stage shows Ares at the anvil, never a
                          white rectangle. The "latest frame seen by Ares" thumbnail that
                          used to sit bottom-right is gone: for an embedded local page it
                          duplicated what you were already looking at (owner, 2026-10-15). */}
                      <div className="forgeLoading" data-on={liveLoading ? "1" : "0"} aria-hidden={!liveLoading}>
                        <div className="forgeLoadingRings"><i /><i /><i /><Medallion glyph="forge" size={46} tone="ember" className="forgeLoadingSigil" /></div>
                        <span className="forgeLoadingText">forging the view</span>
                        <span className="forgeLoadingBar" aria-hidden="true" />
                        <span className="forgeLoadingUrl">{liveTarget.url.replace(/^https?:\/\//, "")}</span>
                      </div>
                      {/* console frame over the page: scanlines, vignette, brackets,
                          one scan sweep per landing; then the 2-bit resolve. */}
                      <div className="forgeStageFx" data-sweep={stageRevealKey > 0 && !liveLoading ? "1" : "0"} key={`fx-${stageRevealKey}`} aria-hidden="true">
                        <i className="forgeCorner tl" /><i className="forgeCorner tr" /><i className="forgeCorner bl" /><i className="forgeCorner br" />
                      </div>
                      <ForgePixelReveal runKey={stageRevealKey} mode="in" cell={8} durationMs={640} palette={forgeMode === "explain" ? "gold" : "blue"} />
                    </>
                  ) : liveBrowser ? (
                    <LiveFrameCanvas className="liveTelemetryMain" frame={liveBrowser.frame} title="Live browser controlled by Ares" />
                  ) : (
                    <div className="externalPreviewNotice">
                      <strong>Opening {liveTarget.url.replace(/^https?:\/\//, "")}</strong>
                      <p>The desktop app shows every site live in the Forge. This preview build streams Ares's browser instead.</p>
                    </div>
                  )}
                </div>
              ) : null}
              {!embeddedActive && !liveTarget && !(liveFeed && liveBrowser) ? (
                <div className="forgeIdle">
                  <ForgePixelPulse cell={8} period={2800} />
                  <div className="forgeOrbital" aria-hidden="true">
                    <div className="forgeOrbit" /><div className="forgeOrbit o2" />
                    <div className="forgeCube"><i /><i /><i /><i /><i /><i /></div>
                    <Medallion glyph="forge" size={44} tone="ember" className="forgeLoadingSigil" />
                  </div>
                  <div className="forgeIdleTitle">Nothing open yet</div>
                  <p className="forgeIdleLead">Ask your agent to open a game or a page, or paste a link above. It runs here live: you can click, type and sign in, and your agent works in the same page.</p>
                  <ul className="forgeIdleAbilities">
                    <li><PixelIcon name="host" size={14} palette="gold" /><b>Serves</b>your project folder, so its files and imports load</li>
                    <li><PixelIcon name="watch" size={14} palette="green" /><b>Watches</b>errors, failed loads and frame rate as it runs</li>
                    <li><PixelIcon name="reload" size={14} palette="blue" /><b>Reloads</b>by itself when your agent edits a file</li>
                    <li><PixelIcon name="rescue" size={14} palette="ember" /><b>Fixes</b>missing imports like <code>three</code> for you</li>
                  </ul>
                  <div className="forgeIdleReadout"><span>sensor <b>armed</b></span><span>host <b>ready</b></span><span>stage <b>idle</b></span></div>
                </div>
              ) : null}
            </div>
          ) : null}
          <ForgePixelReveal runKey={forgePixelKey + (forgeClosing ? 1000 : 0)} mode={forgeClosing ? "out" : "in"} cell={10} durationMs={forgeClosing ? 460 : 760} palette={forgeMode === "explain" ? "gold" : "blue"} />
        </aside>
      ) : null}

      {gatewayToasts.length > 0 ? (
        <div className="gwToasts">
          {gatewayToasts.map((t) => (
            <div key={t.id} className="gwToast">
              🔥 {t.text}
            </div>
          ))}
        </div>
      ) : null}
      {tutorialOpen ? (
        <Tutorial
          onDone={() => { markTutorialSeen(); setTutorialOpen(false); }}
          onMakeAgent={() => { setAgentError(undefined); setAgentEditor({ mode: "create" }); }}
          hasAgents={agentRows.length > 0}
        />
      ) : null}
      {peopleOpen ? (
        <PeopleSheet
          directory={directory}
          agents={agents}
          photos={agentPhotos}
          rooms={rooms}
          results={peopleResults}
          searching={peopleSearching}
          error={peopleError}
          busy={peopleBusy}
          onSearch={(q) => { if (!directory.connected) return; peopleSearchSeq.current += 1; setPeopleSearching(true); daemonCmd({ type: "directory_search", text: q, requestId: `ps_${peopleSearchSeq.current}` }); }}
          onClaim={(username, displayName) => { setPeopleBusy(true); setPeopleError(undefined); daemonCmd({ type: "directory_claim", name: username, label: displayName }); }}
          onProfile={(patch) => { setPeopleError(undefined); daemonCmd({ type: "directory_profile", profile: patch }); }}
          onMessage={(username, text) => { setPeopleBusy(true); setPeopleError(undefined); daemonCmd({ type: "directory_dm", name: username, ...(text.trim() ? { text: text.trim() } : {}) }); }}
          onInvite={(username, roomId) => { setPeopleBusy(true); setPeopleError(undefined); daemonCmd({ type: "directory_invite", name: username, roomId }); }}
          onUrl={(url) => { setPeopleError(undefined); daemonCmd({ type: "directory_url", url }); }}
          onClose={() => setPeopleOpen(false)}
          onView={(username) => openProfile(username)}
        />
      ) : null}
      {profileView ? (
        <ProfileSheet
          user={profileView.user}
          loading={profileView.loading}
          {...(profileView.error ? { error: profileView.error } : {})}
          isMe={profileView.username === directory.username}
          onMessage={(username) => { setProfileView(null); setPeopleBusy(true); setPeopleError(undefined); daemonCmd({ type: "directory_dm", name: username }); }}
          onClose={() => setProfileView(null)}
        />
      ) : null}
      {roomSheet?.kind === "create" ? (
        <RoomCreateSheet
          agents={agents}
          photos={agentPhotos}
          error={roomError}
          directoryUser={directory.connected ? directory.username : undefined}
          onCreateShared={(spec) => { setRoomError(undefined); daemonCmd({ type: "directory_group", room: spec }); }}
          onCreate={(spec) => { setRoomError(undefined); daemonCmd({ type: "room_create", room: spec }); }}
          onClose={() => { setRoomSheet(null); setRoomError(undefined); }}
        />
      ) : roomSheet?.kind === "join" ? (
        <RoomJoinSheet
          agents={agents}
          photos={agentPhotos}
          error={roomError}
          busy={roomSheet.busy}
          initialLink={acceptingInvite?.link}
          intro={acceptingInvite ? `${acceptingInvite.from.displayName} (@${acceptingInvite.from.username}) invited you to ${acceptingInvite.roomName}.${acceptingInvite.text ? ` "${acceptingInvite.text}"` : ""}` : undefined}
          onJoin={(link, bring) => {
            setRoomError(undefined);
            setRoomSheet({ kind: "join", busy: true });
            daemonCmd({ type: "room_join", link, agents: bring });
            if (acceptingInvite) { daemonCmd({ type: "directory_ack", id: acceptingInvite.id }); setAcceptingInvite(null); }
          }}
          onClose={() => { setRoomSheet(null); setRoomError(undefined); setAcceptingInvite(null); }}
        />
      ) : roomSheet?.kind === "invite" ? (() => {
        const room = rooms.find((r) => r.id === roomSheet.roomId);
        if (!room) return null;
        return (
          <RoomInviteSheet
            room={room}
            link={roomSheet.link}
            busy={roomSheet.busy}
            error={roomError}
            onMint={() => { setRoomError(undefined); setRoomSheet({ kind: "invite", roomId: room.id, busy: true }); daemonCmd({ type: "room_invite", roomId: room.id }); }}
            onClose={() => { setRoomSheet(null); setRoomError(undefined); }}
          />
        );
      })() : null}
      {agentEditor ? (() => {
        const editing = agentEditor.mode === "edit" ? agents.find((a) => a.id === agentEditor.id) : undefined;
        if (agentEditor.mode === "edit" && !editing) return null;
        return (
          <AgentEditor
            key={editing?.id ?? "new"}
            initial={editing ? draftOf(editing) : blankDraft(prefs.provider, prefs.model)}
            existing={editing}
            providers={PROVIDERS.filter((p) => p !== "mock" && p !== "moa")}
            takenNames={agents.map((a) => a.name)}
            requestCatalog={requestAgentCatalog}
            error={agentError}
            onSave={saveAgent}
            onDelete={editing ? () => deleteAgent(editing.id) : undefined}
            memory={editing ? agentMemory[editing.id] ?? { total: 0, items: [], busy: true } : undefined}
            memorySources={editing ? [{ id: ARES_AGENT_ID, name: "Ares" }, ...agents.filter((a) => a.id !== editing.id).map((a) => ({ id: a.id, name: a.name }))] : []}
            onMemoryHand={(from, about) => editing && memoryAction(editing.id, { type: "agent_memory_hand", from, ...(about ? { about } : {}) }, `Handed over 14 memories${about ? ` about ${about}` : ""} from ${from === ARES_AGENT_ID ? "Ares" : agents.find((a) => a.id === from)?.name ?? "them"}.`)}
            onMemoryExport={() => editing && memoryAction(editing.id, { type: "agent_memory_export" }, `Exported to exports/${editing.name}-memory-${new Date().toISOString().slice(0, 10)}.md (and a .json next to it).`)}
            onMemoryForget={(memoryId) => {
              if (!editing) return;
              if (native) daemonCmd({ type: "agent_memory_forget", agentId: editing.id, memoryId });
              else setAgentMemory((m) => ({ ...m, [editing.id]: { ...m[editing.id]!, total: m[editing.id]!.total - 1, items: m[editing.id]!.items.filter((x) => x.id !== memoryId) } }));
            }}
            onClose={() => { setAgentEditor(null); setAgentError(undefined); }}
            workspaces={workspaces.map((w) => ({ id: w.id, label: w.label }))}
          />
        );
      })() : null}
      {settingsOpen ? (
        <Settings
          recoveryMode={recoveryMode}
          setRecoveryMode={setRecoveryMode}
          prefs={prefs}
          onApply={applySettings}
          onClose={() => setSettingsOpen(false)}
          native={native}
          skills={skills}
          plugins={pluginsVm}
          mind={mindVm}
          usage={usageStats}
          pointMaps={allPointMaps}
          onDeletePointMap={(id) => { const mine = (prefs.pointMaps ?? []).some((m) => m.id === id); if (mine) { const next = { ...prefs, pointMaps: (prefs.pointMaps ?? []).filter((m) => m.id !== id) }; setPrefs(next); savePrefs(next); } else daemonCmd({ type: "pointmap_delete", id }); }}
          providerUsage={providerUsage}
          anthropicSignedIn={Boolean(keyStatus["anthropic"])}
          ollamaUsage={ollamaUsage}
          keyStatus={keyStatus}
          gatewayAccount={gatewayAccount}
          permissions={permissions}
          onPermissions={(next) => {
            setPermissions(next);
            daemonCmd({ type: "set_permissions", permissions: next });
          }}
          oauthProviders={oauthProviders}
          consciousness={consciousness}
          aresNetwork={aresNetwork}
          onDaemonCommand={daemonCmd}
          onLivePref={(patch) => {
            const next = { ...prefs, ...patch };
            setPrefs(next);
            savePrefs(next);
          }}
          onAnthropicSignIn={startAnthropicSignIn}
          initialTab={settingsTab}
          onPreviewVoice={(id) => voiceRef.current.preview(id)}
          voiceEngine={voiceEngine}
          onRepairVoice={repairVoice}
          onOpenModelBrowser={() => setModelPopOpen(true)}
          extraSlots={{
            profile: (
              <ProfilePane
                directory={directory}
                agents={agents}
                photos={agentPhotos}
                onSave={(patch) => { setPeopleError(undefined); daemonCmd({ type: "directory_profile", profile: patch }); }}
                onOpenPeople={() => { setSettingsOpen(false); setPeopleOpen(true); }}
              />
            ),
            iphone: (
              <IPhonePane
                state={phonePair}
                devices={remoteDevices.map((d) => ({ id: d.id, label: d.name || d.hostname, detail: `${d.os}${d.online ? " · online" : ""}` }))}
                onPair={() => {
                  if (!native) {
                    setPhonePair({ status: "ready", pairing: { url: "wss://ares.example.org/gateway", token: "demo-token-not-real", name: "demo", link: "ares://pair?url=wss%3A%2F%2Fares.example.org%2Fgateway&token=demo-token-not-real&name=demo", permanence: "tunnel", advice: "Demo mode: this is a sample code. In the desktop app it points at your own computer." } });
                    return;
                  }
                  setPhonePair({ status: "loading" });
                  daemonCmd({ type: "phone_pair" });
                }}
                onClose={() => setPhonePair({ status: "idle" })}
                onUnpair={(deviceId) => daemonCmd({ type: "remote_device_unpair", deviceId })}
              />
            ),
            scheduled: (
              <ScheduledPane
                jobs={jobs}
                agents={agents}
                photos={agentPhotos}
                rooms={rooms}
                {...(jobError ? { error: jobError } : {})}
                onAdd={(spec) => { setJobError(undefined); daemonCmd({ type: "job_add", job: spec }); }}
                onChange={(id, action) => { setJobError(undefined); daemonCmd({ type: "job_change", id, action }); }}
                onOpenThread={(sid) => { setSettingsOpen(false); openSession(sid); }}
              />
            ),
          }}
          skillsTopSlot={
            <SharingPanel
              sharing={sharing}
              agents={agents}
              rooms={rooms}
              {...(shareError ? { error: shareError } : {})}
              onSet={(patch) => { setShareError(undefined); daemonCmd({ type: "agents_sharing_set", settings: patch }); }}
              onAccept={(id, agentIds) => { setShareError(undefined); daemonCmd({ type: "share_accept", id, ...(agentIds ? { agentIds } : {}) }); }}
              onReject={(id) => daemonCmd({ type: "share_reject", id })}
            />
          }
          workspacesSlot={
            <WorkspacesPane
              workspaces={workspaces}
              busy={workspaceBusy}
              error={workspaceError}
              agents={agents}
              photos={agentPhotos}
              onAdd={(spec) => { setWorkspaceError(undefined); daemonCmd({ type: "workspace_add", workspace: spec }); }}
              onTest={(id) => { setWorkspaceError(undefined); setWorkspaceBusy((b) => ({ ...b, [id]: "test" })); daemonCmd({ type: "workspace_test", id }); }}
              onSetup={(id) => { setWorkspaceError(undefined); setWorkspaceBusy((b) => ({ ...b, [id]: "setup" })); daemonCmd({ type: "workspace_setup", id }); }}
              onRemove={(id) => daemonCmd({ type: "workspace_remove", id })}
              onAgentWorkspace={(agentId, workspaceId) => daemonCmd({ type: "agent_update", agentId, agent: { workspaceId } })}
            />
          }
          openaiAuth={openaiAuth}
          onOpenaiSignIn={startOpenaiSignIn}
          kimiAuth={kimiAuth}
          onKimiSignIn={startKimiSignIn}
          onLaunchLivingSurface={() => void launchLivingSurface()}
          listProviderVoices={
            ttsProviderSkill
              ? () => skillInvoke(ttsProviderSkill.name, { op: "voices" }).then((r) => {
                  const voices = r.ok ? (r.result as { voices?: VoiceInfo[] })?.voices : null;
                  return Array.isArray(voices) ? voices : [];
                })
              : undefined
          }
        />
      ) : null}

      {reportOpen ? (
        <BugReportModal
          busy={reportBusy}
          sessionTitle={active?.title ?? "this session"}
          connected={Boolean(gatewayAccount?.connected)}
          onClose={() => (reportBusy ? null : setReportOpen(false))}
          onSend={(note) => {
            if (!active?.id) return;
            setReportBusy(true);
            daemonCmd({ type: "bug_report", id: active.id, note });
          }}
        />
      ) : null}

      {directoryOpen ? (
        <ConnectorDirectory
          connectors={mcpConnectors}
          servers={mcpServers}
          catalog={mcpCatalog.catalog}
          categories={mcpCatalog.categories}
          connecting={mcpConnecting}
          tools={mcpTools}
          registry={mcpSearch}
          registryCursor={mcpRegistryCursor}
          probe={mcpProbe}
          prefill={directoryPrefill}
          onConnect={(url, name) => { setMcpConnecting(url); daemonCmd({ type: "mcp_connect", url, name }); }}
          onConnectWithToken={(url, name, token, header) => { setMcpConnecting(url); daemonCmd({ type: "mcp_set_token", url, name, token, ...(header ? { header } : {}) }); }}
          onDisconnect={(name) => daemonCmd({ type: "mcp_disconnect", name })}
          onToggle={(name, enabled) => daemonCmd({ type: "mcp_toggle", name, enabled })}
          onListTools={(name) => { setMcpTools((prev) => ({ ...prev, [name]: { loading: true, tools: [] } })); daemonCmd({ type: "mcp_tools", name }); }}
          onSearchRegistry={(text, cursor) => daemonCmd({ type: "mcp_search", text, ...(cursor ? { cursor } : {}) })}
          onProbe={(url) => { setMcpProbe(null); daemonCmd({ type: "mcp_probe", url }); }}
          onRefreshTools={() => daemonCmd({ type: "mcp_refresh_tools" })}
          onClose={() => { setDirectoryOpen(false); setDirectoryPrefill(null); }}
        />
      ) : null}

      {modelPopOpen ? (
        <ModelPopover
          hasOllamaKey={Boolean(keyStatus["ollama"])}
          ollamaUsage={ollamaUsage}
          prefs={prefs}
          native={native}
          usage={usageStats}
          onRequestUsage={() => daemonCmd({ type: "usage_stats", days: 30 })}
          pulls={ollamaPulls}
          onPull={(model) => {
            setOllamaPulls((prev) => ({ ...prev, [model]: { pct: null, status: "starting…" } }));
            daemonCmd({ type: "ollama_pull", model });
          }}
          onClose={() => setModelPopOpen(false)}
          onPickAuto={() => {
            setModelPopOpen(false);
            // Toggle: if auto is already on, clicking the card turns it OFF (back
            // to the manual main model) — previously there was no way to disable.
            const enabled = prefs.routingMode !== "auto";
            const next = { ...prefs, routingMode: (enabled ? "auto" : "manual") as "auto" | "manual" };
            setPrefs(next);
            savePrefs(next);
            // Reflect the switch in the footer/composer NOW. liveModel prefers the
            // session's turnModel (the model that handled the last turn); without
            // clearing it, the readout would keep showing the previous turn's model
            // and the user's pick would look like it "did nothing".
            apply((s) => ({ ...s, turnModel: enabled ? undefined : next.model, turnProvider: enabled ? undefined : next.provider }));
            daemonCmd({ type: "routing_mode", enabled });
          }}
          onToggleFavorite={(key) => {
            const favorites = (prefs.favoriteModels ?? []).includes(key)
              ? (prefs.favoriteModels ?? []).filter((k) => k !== key)
              : [...(prefs.favoriteModels ?? []), key].slice(-12);
            const next = { ...prefs, favoriteModels: favorites };
            setPrefs(next);
            savePrefs(next);
          }}
          onPick={(provider, model) => {
            setModelPopOpen(false);
            const key = `${provider}/${model}`;
            const recentModels = [key, ...(prefs.recentModels ?? []).filter((k) => k !== key)].slice(0, 6);
            const next = { ...prefs, provider, model, routingMode: "manual" as const, recentModels };
            setPrefs(next);
            savePrefs(next);
            // Immediately show the picked model in the footer/composer. The next
            // turn's route_resolved event overwrites this with whatever actually
            // ran (failover-aware), but until then the readout must match the pick.
            apply((s) => ({ ...s, sessionModel: model, turnModel: model, turnProvider: provider, turnLane: undefined }));
            if (native) {
              if (daemon === "running") {
                void invoke("ares_daemon_command", { command: { type: "model_switch", provider, model, sessionId: activeRef.current } }).catch((err) => {
                  apply((s) => foldEvent(s, { type: "desktop_error", text: `model switch failed: ${String(err)}` }));
                });
              } else {
                restartAttempts.current = 0;
                restartDaemon(provider, model);
              }
            }
          }}
        />
      ) : null}

      {reasoningOpen ? (
        <EffortPopover
          provider={active?.turnProvider ?? prefs.provider}
          model={liveModel}
          value={prefs.reasoning}
          onPick={chooseReasoning}
          onClose={() => setReasoningOpen(false)}
        />
      ) : null}

      {paletteOpen ? <Palette actions={paletteActions} onClose={() => setPaletteOpen(false)} /> : null}

      {anthropicAuth.open ? (
        <AnthropicSignIn
          status={anthropicAuth.status}
          error={anthropicAuth.error}
          browser={anthropicAuth.browser}
          url={anthropicAuth.url}
          onRetry={startAnthropicSignIn}
          onClose={() => setAnthropicAuth({ open: false, status: "idle" })}
        />
      ) : null}

      {cronOpen ? (
        <div className="paletteScrim" onClick={() => setCronOpen(false)}>
          <div className="palette missionsPop" onClick={(e) => e.stopPropagation()}>
            <div className="popTitle">
              Durable missions
              <span className="missionsTick" data-on={opStatus?.autotick ? "1" : "0"}>{opStatus?.autotick ? "auto-tick on" : "auto-tick off"}</span>
            </div>
            {!opStatus || opStatus.goals.length === 0 ? (
              <div className="paneEmpty">
                No durable missions yet. Ask Ares to "create a durable goal to …" and it advances while idle.
              </div>
            ) : (
              <div className="missionsList">
                {opStatus.goals.map((g) => (
                  <div key={g.id} className="missionRow" data-status={g.status}>
                    <div className="missionDot" data-status={g.status} />
                    <div className="missionInfo">
                      <strong>{g.statement}</strong>
                      <span>{g.status} · {g.progress} step{g.progress === 1 ? "" : "s"}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {routingOpen ? (
        <RoutingPanel
          prefs={prefs}
          native={native}
          onClose={() => setRoutingOpen(false)}
          onApply={(routing) => {
            const routingMode = Object.keys(routing).length > 0 ? "auto" as const : "manual" as const;
            const p = { ...prefs, routing, routingMode };
            setPrefs(p);
            savePrefs(p);
            if (native) {
              void invoke("ares_set_routing", { routing }).catch(() => null);
              daemonCmd({ type: "routing_mode", enabled: routingMode === "auto" });
            }
            setRoutingOpen(false);
          }}
        />
      ) : null}

      {garrisonOpen ? (
        <div className="scrim" onClick={() => setGarrisonOpen(false)}>
          <div className="drawer wide consoleDrawer" onClick={(e) => e.stopPropagation()}>
            <header className="consoleHead">
              <h3>Daemon Console</h3>
              <span className="pill" data-state={daemon}>
                <i className="dot" data-state={daemon} />{daemon.toUpperCase()}
              </span>
              <span className="grow" />
              <button
                className="ghost"
                title="Copy the log — paste it when reporting a bug"
                onClick={() => void navigator.clipboard?.writeText(logLines.join("\n")).catch(() => null)}
              >
                ⧉ Copy
              </button>
              <button
                className="ghost"
                onClick={() => {
                  restartAttempts.current = 0;
                  restartDaemon();
                }}
              >
                ⟳ Restart
              </button>
              {native ? (
                <button className="ghost danger" onClick={() => void invoke("ares_stop_daemon").catch(() => null)}>
                  ■ Stop
                </button>
              ) : null}
              <button className="ghost" onClick={() => setGarrisonOpen(false)}>
                Close
              </button>
            </header>
            <pre className="logView">{logLines.length ? logLines.join("\n") : "No daemon output yet — the Garrison hasn't written to stderr."}</pre>
            <footer className="consoleFoot">
              {logLines.length} line{logLines.length === 1 ? "" : "s"} · live stdout/stderr from the Garrison daemon
            </footer>
          </div>
        </div>
      ) : null}
    </div>
    </AvatarStyleContext.Provider>
    </AgentClipsContext.Provider>
    </AgentPosesContext.Provider>
    </AgentPhotoContext.Provider>
    </StyleCtx.Provider>
  );
}

// ─── Command palette ───────────────────────────────────────────────────────

interface PaletteAction {
  label: string;
  hint?: string;
  run: () => void;
}

function Palette({ actions, onClose }: { actions: PaletteAction[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const q = query.trim().toLowerCase();
  const filtered = q ? actions.filter((a) => a.label.toLowerCase().includes(q) || (a.hint ?? "").toLowerCase().includes(q)) : actions;
  const sel = Math.min(cursor, Math.max(0, filtered.length - 1));

  return (
    <div className="paletteScrim" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Search actions and sessions…"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter" && filtered[sel]) {
              filtered[sel].run();
              onClose();
            }
          }}
        />
        <div className="paletteList">
          {filtered.map((a, i) => (
            <button
              key={a.label}
              data-on={i === sel ? "1" : "0"}
              onMouseEnter={() => setCursor(i)}
              onClick={() => {
                a.run();
                onClose();
              }}
            >
              <span>{a.label}</span>
              {a.hint ? <em>{a.hint}</em> : null}
            </button>
          ))}
          {filtered.length === 0 ? <div className="paletteEmpty">nothing matches</div> : null}
        </div>
      </div>
    </div>
  );
}

// ─── Routing panel — per-lane model assignments, its own surface ───────────

const LANE_HINTS: Record<RouteLane, string> = {
  chat: "conversation, quick answers, summaries",
  coding: "edits, builds, refactors, debugging",
  research: "planning, analysis, deep reads",
  "tool-use": "tool-output digestion, mechanical steps",
};
const LANE_ICONS: Record<RouteLane, string> = {
  chat: "💬",
  coding: "⌨️",
  research: "🔎",
  "tool-use": "🔧",
};

function RoutingPanel({
  prefs,
  native,
  onApply,
  onClose,
}: {
  prefs: Prefs;
  native: boolean;
  onApply: (routing: Routing) => void;
  onClose: () => void;
}) {
  const [routing, setRouting] = useState<Routing>(prefs.routing);
  const setLane = (lane: RouteLane, entry: { provider: string; model: string } | undefined) => {
    const next = { ...routing };
    if (entry) next[lane] = entry;
    else delete next[lane];
    setRouting(next);
  };
  return (
    <div className="paletteScrim" onClick={onClose}>
      <div className="palette routingPop" onClick={(e) => e.stopPropagation()}>
        <div className="routingHead">
          <div>
            <strong>The War Table</strong>
            <span>Assign a model to each kind of work. Any assignment turns on auto-routing; unset lanes use your main model ({prefs.model}).</span>
          </div>
          <button className="ghost popClose" onClick={onClose}>Close</button>
        </div>
        <div className="routingPopBody">
          {ROUTE_LANES.map((lane) => {
            const entry = routing[lane];
            const open = !!entry;
            return (
              <div key={lane} className="routeLane" data-on={open ? "1" : "0"}>
                <button className="laneToggle" onClick={() => setLane(lane, entry ? undefined : { provider: prefs.provider, model: prefs.model })}>
                  <span className="laneIcon" aria-hidden="true">{LANE_ICONS[lane]}</span>
                  <span className="laneName">
                    <strong>{lane}</strong>
                    <em>{LANE_HINTS[lane]}</em>
                  </span>
                  <span className="laneAssign" title={entry ? `${entry.provider} · ${entry.model}` : "main model"}>{entry ? `${entry.provider} · ${entry.model}` : "main model"}</span>
                  <span className="laneSwitch" data-on={entry ? "1" : "0"} aria-hidden="true"><i /></span>
                </button>
                {entry ? (
                  <div className="laneBody">
                    <div className="segment mini">
                      {/* MoA ensembles are themselves routers — assigning one
                          to a lane routes a route. Lanes take concrete
                          providers only. */}
                      {PROVIDERS.filter((p) => p !== "mock" && p !== "moa").map((p) => (
                        <button
                          key={p}
                          data-on={entry.provider === p ? "1" : "0"}
                          onClick={() => setLane(lane, { provider: p, model: defaultModelForProvider(p) })}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                    <ModelPicker
                      provider={entry.provider}
                      value={entry.model}
                      onPick={(id) => setLane(lane, { ...entry, model: id })}
                      native={native}
                      compact
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
          {!native ? <p className="keyHint">demo mode — assignments persist locally and apply when the daemon is attached.</p> : null}
        </div>
        <div className="routingPopFoot">
          <button className="primary" onClick={() => onApply(routing)}>
            Apply routing
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Model hot-swap popover ────────────────────────────────────────────────

function BugReportModal({
  busy,
  sessionTitle,
  connected,
  onSend,
  onClose,
}: {
  busy: boolean;
  sessionTitle: string;
  connected: boolean;
  onSend: (note: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div className="paletteScrim" onClick={onClose}>
      <div className="palette bugReport" onClick={(e) => e.stopPropagation()}>
        <header className="bugReportHead">
          <strong>🐛 Report a bug</strong>
          {/* Label the session name — a bare truncated first-message ("hey") floating
             top-right reads as a random keyword (bug report dac60375). */}
          <em title={`The session being reported: ${sessionTitle}`}>Session: “{sessionTitle}”</em>
        </header>
        <p className="bugReportBlurb">
          This uploads the <b>whole chat</b> — every message, all generated code, every tool call and its
          result, and any errors — to your Ares account so the owner can see exactly what went wrong and improve
          Ares. Nothing is sent unless you press Send.
        </p>
        {!connected ? (
          <div className="bugReportWarn">You're not connected to your Ares account. Connect at doingteam.com → Account first, or this will fail.</div>
        ) : null}
        <label className="bugReportLabel">
          What went wrong? <span>(optional, but it helps)</span>
        </label>
        <textarea
          className="bugReportNote"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. asked for a snake game — it created the HTML but the arrow keys don't move the snake, and it claimed it was done"
          rows={4}
          autoFocus
          spellCheck
        />
        <div className="bugReportActions">
          <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={() => onSend(note.trim())} disabled={busy}>
            {busy ? "Sending…" : "Send report"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EffortPopover({
  provider,
  model,
  value,
  onPick,
  onClose,
}: {
  provider: string;
  model: string;
  value: ReasoningLevel;
  onPick: (level: ReasoningLevel) => void;
  onClose: () => void;
}) {
  // Ask the daemon for THIS provider's catalog on open, so the ladder reflects
  // the live roster even if the model browser was never opened. The registry
  // is populated by the model_catalog frame; the tick re-renders when it lands.
  const [, setCatalogTick] = useState(0);
  useEffect(() => {
    const bump = () => setCatalogTick((n) => n + 1);
    window.addEventListener("ares:model-catalog", bump);
    void invoke("ares_daemon_command", { command: { type: "model_catalog", provider } }).catch(() => null);
    return () => window.removeEventListener("ares:model-catalog", bump);
  }, [provider]);

  const levels = effortLevelsFor(provider, model);
  const selected = levels.includes(value) ? value : null;
  const activeIndex = selected ? levels.indexOf(selected) : -1;
  const fill = activeIndex < 0 || levels.length < 2 ? 0 : (activeIndex / (levels.length - 1)) * 100;

  // A model with no extended thinking gets an honest empty state instead of a
  // ladder of rungs it would silently ignore.
  if (levels.length === 0) {
    return (
      <div className="paletteScrim" onClick={onClose}>
        <div className="palette reasoningPop" onClick={(e) => e.stopPropagation()}>
          <div className="effortHead">
            <ProviderLogo brand={provider} className="effortProviderMark" />
            <span>
              <strong>Reasoning effort</strong>
              <em>{provider} / {model}</em>
            </span>
            <button className="close" onClick={onClose} aria-label="Close">×</button>
          </div>
          <div className="effortWire" data-warning="1">
            <i />
            <span>{model} does no extended thinking, so there is no effort to set. Pick a reasoning-capable model to use this dial.</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="paletteScrim" onClick={onClose}>
      <div className="palette reasoningPop" onClick={(e) => e.stopPropagation()}>
        <div className="effortHead">
          <ProviderLogo brand={provider} className="effortProviderMark" />
          <span>
            <strong>Reasoning effort</strong>
            <em>{provider} / {model}</em>
          </span>
          <button className="close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="effortSignal" aria-hidden="true">
          <i style={{ width: `${fill}%` }} />
          {levels.map((level, index) => <b key={level} data-on={level === selected ? "1" : "0"} style={{ left: `${levels.length === 1 ? 50 : (index / (levels.length - 1)) * 100}%` }} />)}
        </div>
        <div className="effortChoices" style={{ "--effort-stops": levels.length } as React.CSSProperties}>
          {levels.map((level) => {
            const meta = EFFORT_META[level];
            return (
              <button key={level} data-on={level === selected ? "1" : "0"} onClick={() => onPick(level)}>
                <span>{meta.label}</span>
                <small>{meta.hint}</small>
              </button>
            );
          })}
        </div>
        <div className="effortWire" data-warning={selected ? "0" : "1"}>
          <i />
          <span>{selected ? effortWireLabel(provider, model, selected) : `Choose a supported level for ${model}; the saved “${EFFORT_META[value].label}” setting is not valid here.`}</span>
        </div>
      </div>
    </div>
  );
}

/** Provider identity for the discovery panel — a branded gradient mark per
 *  provider (no external logo fetches; the CSP forbids them anyway). */
const PROVIDER_IDENTITY: Record<string, { title: string; tagline: string; mark: string; from: string; to: string }> = {
  ares: { title: "Ares", tagline: "In-house models on your Ares account", mark: "Λ", from: "#5c1414", to: "#e08b2e" },
  ollama: { title: "Ollama", tagline: "Local machine + Ollama Cloud", mark: "ᒍ", from: "#1d2b31", to: "#7fa6a3" },
  openai: { title: "OpenAI", tagline: "The GPT frontier family", mark: "◎", from: "#0c2b22", to: "#10a37f" },
  anthropic: { title: "Anthropic", tagline: "The Claude family", mark: "A\\", from: "#3b2417", to: "#d97757" },
  deepseek: { title: "DeepSeek", tagline: "Frontier coding + reasoning, open weights", mark: "◗", from: "#101f3d", to: "#4d6bfe" },
  openrouter: { title: "OpenRouter", tagline: "Hundreds of models behind one key", mark: "◈", from: "#241a33", to: "#9d7bea" },
  custom: { title: "Custom", tagline: "Any OpenAI-compatible endpoint", mark: "✦", from: "#2a2a2e", to: "#9aa3ad" },
  moa: { title: "Mixture of Agents", tagline: "Ensembles — several models, one answer", mark: "⁂", from: "#2d1a30", to: "#c86bd1" },
  mock: { title: "Demo", tagline: "Offline demo models", mark: "◇", from: "#26262a", to: "#8a8f98" },
};

function ModelPopover({
  prefs,
  native,
  usage,
  onRequestUsage,
  pulls,
  onPull,
  onToggleFavorite,
  onPickAuto,
  onPick,
  onClose,
  hasOllamaKey,
  ollamaUsage,
}: {
  prefs: Prefs;
  native: boolean;
  usage: UsageStats | null;
  onRequestUsage: () => void;
  pulls: Record<string, { pct: number | null; status: string; done?: boolean; error?: string }>;
  onPull: (model: string) => void;
  onToggleFavorite: (key: string) => void;
  onPickAuto: () => void;
  onPick: (provider: string, model: string) => void;
  onClose: () => void;
  /** An Ollama Cloud key is set: local Ollama is optional, never an error. */
  hasOllamaKey?: boolean;
  ollamaUsage?: OllamaUsageState | null;
}) {
  const [provider, setProvider] = useState(prefs.provider);
  const { models, loading, error } = useModelCatalog(provider, native);
  // The public library is 300+ models that need a local pull. Hidden behind a
  // chip (or a search) so the picker shows what actually runs: your local
  // models and the cloud, newest first.
  const [showLibrary, setShowLibrary] = useState(false);
  // 30-day usage for the hero strip — ask once per open.
  useEffect(() => { onRequestUsage(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const providerUsage = usage?.providers?.find((p) => p.provider === provider);
  // Pulled state: any Local Ollama entry with the same base name means the
  // library model is already on this machine.
  const localBases = useMemo(
    () => new Set(models.filter((m) => m.group === "Local Ollama").map((m) => m.id.split(":")[0].toLowerCase())),
    [models],
  );
  const selectModel = (pickedProvider: string, id: string) => {
    if (pickedProvider === "ollama") {
      const option = models.find((model) => model.id === id);
      const pullName = option?.label ?? id;
      const base = pullName.split(":")[0].toLowerCase();
      const cloud = id.toLowerCase().endsWith(":cloud")
        || option?.group.includes("cloud") === true
        || option?.group.startsWith("Ollama Cloud") === true;
      const localLibraryModel = option?.group === "Ollama Library";
      if (localLibraryModel && !cloud && !localBases.has(base) && !pulls[pullName]?.done) {
        onPull(pullName);
      }
    }
    onPick(pickedProvider, id);
  };
  const groupRank = (g: string) => {
    if (g === "Local Ollama") return 0;
    if (g.startsWith("Ollama Cloud")) return 1;
    if (g.startsWith("Ollama Library")) return 3;
    return 4;
  };
  const parsePulls = (p?: string) => {
    const m = p?.match(/([\d.]+)\s*([KMB]?)/i);
    if (!m) return 0;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase() as "k" | "m" | "b"] ?? 1;
    return Number(m[1]) * mult;
  };
  const [query, setQuery] = useState("");
  const [capability, setCapability] = useState<"all" | "tools" | "reasoning" | "vision" | "free">("all");
  const [detail, setDetail] = useState<ModelOption | null>(null);
  const value = prefs.provider === provider ? prefs.model : "";
  const ident = PROVIDER_IDENTITY[provider] ?? { title: provider, tagline: "", mark: "◆", from: "#26262a", to: "#8a8f98" };
  const q = query.trim().toLowerCase();
  const isLibrary = (m: ModelOption) => m.group.startsWith("Ollama Library");
  const libraryCount = models.filter(isLibrary).length;
  const visible = showLibrary || q ? models : models.filter((m) => !isLibrary(m));
  const byCapability = capability === "all" ? visible : visible.filter((m) => m.capabilities?.includes(capability));
  const searched = q
    ? byCapability.filter((m) => [m.id, m.label ?? "", m.hint ?? "", m.description ?? "", ...(m.capabilities ?? [])].join(" ").toLowerCase().includes(q))
    : byCapability;
  // Ordered: local models first, then cloud, then the library. WITHIN a group
  // the daemon's order stands — it is newest-first for the cloud and for
  // Anthropic (their APIs list newest first) and by popularity for the
  // library. The old id.localeCompare tiebreak alphabetized everything, so a
  // model released yesterday sat wherever its name fell.
  const order = new Map(models.map((m, i) => [m.id, i]));
  const filtered = [...searched].sort((a, b) =>
    groupRank(a.group) - groupRank(b.group) ||
    (a.group.startsWith("Ollama Library") ? parsePulls(b.pulls) - parsePulls(a.pulls) : 0) ||
    (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const sections = [...new Set(filtered.map((m) => m.group))];
  const capabilityCount = (name: Exclude<typeof capability, "all">) => models.filter((m) => m.capabilities?.includes(name)).length;
  const ctxLabel = (n?: number) => {
    if (!n) return null;
    const k = Math.round(n / 1000);
    return k >= 1000 ? `${(k / 1000).toFixed(k % 1000 ? 1 : 0)}M ctx` : `${k}k ctx`;
  };
  const markStyle = (pi: { from: string; to: string }) => ({ background: `linear-gradient(135deg, ${pi.from}, ${pi.to})` });
  const pickProvider = (p: string) => {
    setProvider(p);
    setDetail(null);
    setQuery("");
    setCapability("all");
  };
  return (
    <div className="paletteScrim" onClick={onClose}>
      <div className="palette modelDiscovery" onClick={(e) => e.stopPropagation()}>
        <aside className="mdlRail">
          <div className="mdlRailTitle">Providers</div>
          <div className="mdlRailList">
            {PROVIDERS.map((p, i) => {
              const pi = PROVIDER_IDENTITY[p] ?? { title: p, tagline: "", mark: "◆", from: "#26262a", to: "#8a8f98" };
              return (
                <button key={p} className="mdlProv" data-on={provider === p ? "1" : "0"} style={{ "--i": i } as React.CSSProperties} onClick={() => pickProvider(p)}>
                  <ProviderLogo brand={p} className="mdlMark" />
                  <span className="mdlProvBody">
                    <strong>{pi.title}</strong>
                    <em>{pi.tagline}</em>
                  </span>
                </button>
              );
            })}
          </div>
          <button className="autoRoutePick" data-on={prefs.routingMode === "auto" ? "1" : "0"} onClick={onPickAuto} title={prefs.routingMode === "auto" ? "Routing is ON — click to switch back to a single manual model" : "Enable per-lane auto routing"}>
            <span>
              <strong>Routing (Auto){prefs.routingMode === "auto" ? " · ON" : ""}</strong>
              <em>{prefs.routingMode === "auto" ? "click to disable — pick a model for manual" : "classifies each turn per lane"}</em>
            </span>
            <i>{prefs.routingMode === "auto" ? "ON" : `${Object.keys(prefs.routing).length} lanes`}</i>
          </button>
        </aside>
        <section className="mdlMain">
          <header className="mdlHero">
            <ProviderLogo brand={provider} className="mdlMark big" />
            <div className="mdlHeroBody">
              <strong>{ident.title}</strong>
              <em>{ident.tagline}</em>
            </div>
            <span className="mdlCount">{loading ? "scanning…" : `${models.length} models`}</span>
            <button className="ghost" onClick={onClose}>Close</button>
          </header>
          {(prefs.favoriteModels ?? []).length > 0 || (prefs.recentModels ?? []).length > 0 ? (
            <div className="mdlQuick">
              {(prefs.favoriteModels ?? []).map((key) => {
                const [p, ...rest] = key.split("/");
                const id = rest.join("/");
                return (
                  <button key={`f:${key}`} className="mdlQuickChip fav" data-on={p === prefs.provider && id === prefs.model ? "1" : "0"} title={key} onClick={() => selectModel(p, id)}>
                    ★ {id}
                  </button>
                );
              })}
              {(prefs.recentModels ?? []).filter((key) => !(prefs.favoriteModels ?? []).includes(key)).slice(0, 4).map((key) => {
                const [p, ...rest] = key.split("/");
                const id = rest.join("/");
                return (
                  <button key={`r:${key}`} className="mdlQuickChip" data-on={p === prefs.provider && id === prefs.model ? "1" : "0"} title={`recent · ${key}`} onClick={() => selectModel(p, id)}>
                    ↺ {id}
                  </button>
                );
              })}
            </div>
          ) : null}
          {providerUsage ? (
            <div className="mdlUsage" title="Your last 30 days through this provider (spend estimated from live OpenRouter pricing)">
              <span className="mdlUsageLabel">30d</span>
              <span><b>{providerUsage.calls}</b> requests</span>
              <span title="Includes the conversation re-read on every call, so it is large; it is not what you are charged for."><b>{fmtTokens(providerUsage.tokensIn)}</b> read</span>
              <span><b>{fmtTokens(providerUsage.tokensOut)}</b> written</span>
              <span className="mdlUsageCost">{providerUsage.costUsd !== undefined ? <>≈ <b>${providerUsage.costUsd.toFixed(2)}</b></> : "cost n/a"}</span>
            </div>
          ) : null}
          <div className="mdlControls">
            <input
              className="modelSearch"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={loading ? "loading models…" : `search ${models.length} models`}
              spellCheck={false}
              autoFocus
            />
            <div className="modelFilters" aria-label="model capability filters">
              <button data-on={capability === "all" ? "1" : "0"} onClick={() => setCapability("all")}>all</button>
              {(["tools", "reasoning", "vision", "free"] as const).map((name) => {
                const count = capabilityCount(name);
                return (
                  <button key={name} data-on={capability === name ? "1" : "0"} disabled={count === 0} onClick={() => setCapability(name)}>
                    {name} <em>{count}</em>
                  </button>
                );
              })}
              {libraryCount > 0 ? (
                <button data-on={showLibrary ? "1" : "0"} onClick={() => setShowLibrary((v) => !v)} title="The public ollama.com library — needs a local Ollama and a pull">
                  library <em>{libraryCount}</em>
                </button>
              ) : null}
            </div>
          </div>
          {error && !(provider === "ollama" && hasOllamaKey) ? (
            <div className={/Local Ollama isn't running/.test(error) ? "modelNote" : "modelError"}>{error}</div>
          ) : null}
          {provider === "ollama" && hasOllamaKey && ollamaUsage?.usage ? <OllamaUsageLine state={ollamaUsage} /> : null}
          {detail ? (
            <div className="mdlDetailWrap">
              <ModelDetail
                model={detail}
                selected={detail.id === value}
                onUse={(id) => { selectModel(provider, id); setDetail(null); }}
                onBack={() => setDetail(null)}
              />
            </div>
          ) : (
            <div className="mdlGrid">
              {sections.map((section) => (
                <React.Fragment key={section}>
                  {sections.length > 1 ? (
                    <div className="mdlSection">
                      <span>{section}</span>
                      <em>{filtered.filter((m) => m.group === section).length}</em>
                    </div>
                  ) : null}
                  {filtered.filter((m) => m.group === section).map((m, i) => {
                    const ctx = ctxLabel(m.contextLength);
                    const isFree = m.capabilities?.includes("free");
                    const price = m.pricing?.input !== undefined ? `$${m.pricing.input.toFixed(2)}/M in` : null;
                    const isLibrary = m.group.startsWith("Ollama Library");
                    const cloudHosted = m.group.includes("cloud") || m.group.startsWith("Ollama Cloud") || m.id.includes("cloud");
                    const pulled = isLibrary && localBases.has((m.label ?? m.id).split(":")[0].toLowerCase());
                    return (
                      <button key={m.id} className="mdlCard" data-on={m.id === value ? "1" : "0"} style={{ "--i": Math.min(i, 20) } as React.CSSProperties} onClick={() => selectModel(provider, m.id)}>
                        <span className="mdlCardTop">
                          <ProviderLogo brand={brandKey(m)} className="modelGlyph" />
                          <span className="mdlCardName">
                            <strong>{m.label ?? m.id}</strong>
                            {m.label && m.label !== m.id ? <em>{m.id}</em> : null}
                          </span>
                          <span
                            className="mdlStar"
                            role="button"
                            tabIndex={0}
                            data-on={(prefs.favoriteModels ?? []).includes(`${provider}/${m.id}`) ? "1" : "0"}
                            title={(prefs.favoriteModels ?? []).includes(`${provider}/${m.id}`) ? "Unpin" : "Pin to the top"}
                            aria-label={`Pin ${m.label ?? m.id}`}
                            onClick={(e) => { e.stopPropagation(); onToggleFavorite(`${provider}/${m.id}`); }}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onToggleFavorite(`${provider}/${m.id}`); } }}
                          >{(prefs.favoriteModels ?? []).includes(`${provider}/${m.id}`) ? "★" : "☆"}</span>
                          <span
                            className="modelInfo"
                            role="button"
                            tabIndex={0}
                            title="Details"
                            aria-label={`Details for ${m.label ?? m.id}`}
                            onClick={(e) => { e.stopPropagation(); setDetail(m); }}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setDetail(m); } }}
                          >ⓘ</span>
                        </span>
                        {m.description ? (
                          <span className="mdlCardDesc" title={m.description}>{m.description}</span>
                        ) : m.hint && !m.pulls ? (
                          <span className="mdlCardDesc thin">{m.hint}</span>
                        ) : null}
                        {m.pulls || m.updated ? (
                          <span className="mdlCardMeta">
                            {m.pulls ? <span title="library pulls">⇩ {m.pulls}</span> : null}
                            {m.updated ? <span title="last updated">↻ {m.updated}</span> : null}
                          </span>
                        ) : null}
                        {(() => {
                          const pullState = pulls[m.label ?? m.id];
                          if (!pullState || pullState.done || pullState.error) return null;
                          return (
                            <span className="mdlPullBar" title={pullState.status}>
                              <span className="mdlPullFill" style={{ width: pullState.pct !== null ? `${pullState.pct}%` : "100%" }} data-indeterminate={pullState.pct === null ? "1" : "0"} />
                              <em>{pullState.pct !== null ? `${pullState.pct}%` : pullState.status || "pulling…"}</em>
                            </span>
                          );
                        })()}
                        <span className="mdlCardFoot">
                          {isLibrary ? (
                            pulled || pulls[m.label ?? m.id]?.done ? <i className="mdlChip pulled">✓ pulled</i>
                            : cloudHosted ? null
                            : pulls[m.label ?? m.id] && !pulls[m.label ?? m.id]?.error ? null
                            : <span
                                className="mdlChip pullBtn"
                                role="button"
                                tabIndex={0}
                                title="Download this model through your local Ollama"
                                onClick={(e) => { e.stopPropagation(); onPull(m.label ?? m.id); }}
                                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onPull(m.label ?? m.id); } }}
                              >⇩ pull</span>
                          ) : null}
                          {cloudHosted && provider === "ollama" ? <i className="mdlChip cloud">☁ cloud</i> : null}
                          {m.group === "Local Ollama" ? <i className="mdlChip pulled">💾 local</i> : null}
                          {ctx ? <i className="mdlChip">{ctx}</i> : null}
                          {isFree ? <i className="mdlChip free">FREE</i> : price ? <i className="mdlChip">{price}</i> : null}
                          {m.capabilities?.filter((c) => c !== "free").slice(0, 3).map((c) => <i key={c} className="mdlChip cap">{c}</i>)}
                          {m.id === value ? <i className="mdlChip current">✓ current</i> : null}
                        </span>
                      </button>
                    );
                  })}
                </React.Fragment>
              ))}
              {!loading && filtered.length === 0 ? <div className="modelHintEmpty">no models match</div> : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ─── The vault: cross-session artifact aggregation ─────────────────────────

interface VaultEntry {
  key: string;
  label: string;
  url: string;
  session: string;
  sessionId: string;
}
interface Vault {
  images: VaultEntry[];
  files: VaultEntry[];
  links: VaultEntry[];
}

const VAULT_IMG = /https?:[^\s<>"')\]]+\.(?:png|jpe?g|webp|gif|avif)(?:\?[^\s<>"')\]]*)?/gi;
const VAULT_LINK = /https?:\/\/[^\s<>"')\]]+/gi;

function collectVault(sessions: SessionVm[]): Vault {
  const images: VaultEntry[] = [];
  const files: VaultEntry[] = [];
  const links: VaultEntry[] = [];
  const seen = new Set<string>();
  const push = (list: VaultEntry[], entry: VaultEntry) => {
    if (seen.has(entry.url)) return;
    seen.add(entry.url);
    list.push(entry);
  };
  for (const s of sessions) {
    for (const item of s.items) {
      if (item.kind === "artifact") {
        push(files, { key: item.key, label: item.label, url: item.path, session: s.title, sessionId: s.id });
      } else if (item.kind === "assistant" && item.text) {
        for (const m of item.text.matchAll(VAULT_IMG)) {
          push(images, { key: `${item.key}-${images.length}`, label: m[0].split("/").pop()?.split("?")[0] ?? "image", url: m[0], session: s.title, sessionId: s.id });
        }
        for (const m of item.text.matchAll(VAULT_LINK)) {
          if (/\.(?:png|jpe?g|webp|gif|avif)/i.test(m[0])) continue;
          push(links, { key: `${item.key}-l${links.length}`, label: m[0].replace(/^https?:\/\//, "").slice(0, 70), url: m[0], session: s.title, sessionId: s.id });
        }
      }
    }
  }
  return { images, files, links };
}

interface RemotePcRow {
  id: string;
  label: string;
  hostname: string;
  os: string;
  ip: string;
  connectedAt: number;
}

/** A permanently paired device (mirrors PairedDeviceRow from the CLI). */
interface PairedDeviceRow {
  id: string;
  name: string;
  hostname: string;
  os: string;
  addedAt: number;
  lastSeenAt?: number;
  elevated: boolean;
  online: boolean;
}

/** OS → the shell family, mirrored from the RemotePC tool so the card reads
 *  the same language Ares does. */
function osFamily(os: string): { name: string; glyph: string } {
  if (/darwin|mac|os ?x/i.test(os)) return { name: "macOS", glyph: "🍎" };
  if (/linux|nix|bsd/i.test(os)) return { name: "Linux", glyph: "🐧" };
  if (/win/i.test(os)) return { name: "Windows", glyph: "🪟" };
  return { name: os || "Unknown", glyph: "💻" };
}

function agoLabel(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function AresOsView({
  pcs,
  link,
  pairLink,
  devices,
  scope,
  shots,
  onConnect,
  onPair,
  onClearPairLink,
  phonePair,
  onPhonePair,
  onPhonePairClose,
  onUnpair,
  onClearLink,
  onDisconnect,
  onRefresh,
  onPreview,
  onHelp,
}: {
  pcs: RemotePcRow[];
  link: { url: string; scope: string; label: string } | null;
  pairLink: { url: string; scope: string; label: string; warning: string } | null;
  devices: PairedDeviceRow[];
  scope: "public" | "lan" | "unknown";
  shots: Record<string, { data?: string; error?: string; loading?: boolean }>;
  onConnect: (label: string) => void;
  onPair: (label: string) => void;
  onClearPairLink: () => void;
  phonePair: PhonePairState;
  onPhonePair: () => void;
  onPhonePairClose: () => void;
  onUnpair: (deviceId: string) => void;
  onClearLink: () => void;
  onDisconnect: (pcId: string) => void;
  onRefresh: () => void;
  onPreview: (pcId: string) => void;
  onHelp: (pc: RemotePcRow) => void;
}) {
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);
  const [pairCopied, setPairCopied] = useState(false);
  const makeLink = () => { onConnect(name.trim() || "their PC"); setName(""); };
  const makePair = () => { onPair(name.trim() || "my device"); setName(""); };

  // Auto-copy the link the moment it's minted, so "Connect" → paste-to-friend is one step.
  useEffect(() => {
    if (!link) { setCopied(false); return; }
    void navigator.clipboard.writeText(link.url).then(() => setCopied(true)).catch(() => setCopied(false));
  }, [link]);

  return (
    <div className="aresos">
      <header className="aresosHead">
        <div>
          <div className="aresosTitle"><Medallion glyph="shield" size={30} /> AresOS</div>
          <p className="aresosSub">Devices you're helping. Send someone a link — the moment they open it, they show up here and Ares can work on their machine.</p>
        </div>
        <div className="aresosHeadRight">
          <span className={`aresosScope ${scope === "public" ? "ok" : scope === "lan" ? "warn" : ""}`}>
            {scope === "public" ? "🌐 Internet links" : scope === "lan" ? "⚠ Local network only" : "…"}
          </span>
          <button className="aresosGhost" onClick={onRefresh} title="Refresh">↻</button>
        </div>
      </header>

      <section className="aresosConnect">
        <input
          className="aresosInput"
          value={name}
          placeholder="Who is it? e.g. Dave's laptop"
          onChange={(ev) => setName(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === "Enter") makeLink(); }}
        />
        <button className="aresosPrimary" onClick={makeLink} title="One-time link — connects while the window is open. For helping someone else.">+ Connect (temporary)</button>
        <button className="aresosPair" onClick={makePair} title="Permanent link for YOUR OWN machine — installs a boot connector so Ares can reach it with admin rights whenever it's on.">🔒 Pair permanently</button>
      </section>

      {link ? (
        <div className="aresosLink">
          <div className="aresosLinkTop">
            <b>{copied ? "✓ Copied — paste it to " : "Link for "}{link.label || "them"}</b>
            <button className="aresosX" onClick={onClearLink} title="Dismiss">✕</button>
          </div>
          <div className="aresosLinkUrl">{link.url}</div>
          <div className="aresosLinkRow">
            <button
              className="aresosPrimary"
              onClick={() => { void navigator.clipboard.writeText(link.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }); }}
            >{copied ? "✓ Copied" : "⎘ Copy link"}</button>
            <span className="aresosHint">Send it to them (text, chat, email). They open it → a tiny connector runs → they appear below. Nothing to install.</span>
          </div>
          {link.scope === "lan" ? (
            <div className="aresosWarn">⚠ Local-network only right now (no internet tunnel) — this works only if they're on your wifi. Ask Ares to set up the tunnel for remote friends.</div>
          ) : null}
        </div>
      ) : null}

      {pairLink ? (
        <div className="aresosLink aresosPairLink">
          <div className="aresosLinkTop">
            <b>🔒 Permanent pairing link{pairLink.label ? ` for ${pairLink.label}` : ""}</b>
            <button className="aresosX" onClick={onClearPairLink} title="Dismiss">✕</button>
          </div>
          <div className="aresosPairNote">
            Open this <b>on the machine you're pairing</b>, in an <b>admin</b> PowerShell. It installs a
            boot-time connector so that machine reconnects on its own — with your admin rights — every time it's on.
            Only do this on a machine you own.
          </div>
          <div className="aresosLinkUrl">{pairLink.url}</div>
          <div className="aresosLinkRow">
            <button
              className="aresosPair"
              onClick={() => { void navigator.clipboard.writeText(pairLink.url).then(() => { setPairCopied(true); setTimeout(() => setPairCopied(false), 1800); }); }}
            >{pairCopied ? "✓ Copied" : "⎘ Copy pairing link"}</button>
            <span className="aresosHint">This link works once and expires in 10 minutes.</span>
          </div>
          {pairLink.warning ? <div className="aresosWarn">⚠ {pairLink.warning}</div> : null}
          {pairLink.scope === "lan" ? (
            <div className="aresosWarn">⚠ Local-network only (no internet tunnel) — the device must be on the same network as this machine.</div>
          ) : null}
        </div>
      ) : null}

      <PhonePairCard state={phonePair} onPair={onPhonePair} onClose={onPhonePairClose} />

      {devices.length > 0 ? (
        <section className="aresosDevices">
          <div className="aresosDevicesHead">🔒 Paired devices <span className="aresosDim">(reconnect on their own)</span></div>
          {devices.map((d) => (
            <div key={d.id} className="aresosDeviceRow">
              <span className={`aresosDot ${d.online ? "" : "aresosDotOff"}`} />
              <b>{d.name}</b>
              <span className="aresosMeta aresosDim">{d.hostname} · {d.os}{d.elevated ? " · admin" : ""} · {d.online ? "online" : "offline"}</span>
              <button className="aresosGhost aresosUnpair" onClick={() => onUnpair(d.id)} title="Revoke this device — its connector stops and the credential is invalidated">Unpair</button>
            </div>
          ))}
        </section>
      ) : null}

      {pcs.length === 0 ? (
        <div className="aresosEmpty">
          <div className="aresosEmptyGlyph">🖥️</div>
          <p>No devices connected yet. Name who you're helping above and hit Connect — you'll get a link to send them.</p>
        </div>
      ) : (
        <div className="aresosGrid">
          {pcs.map((pc) => {
            const fam = osFamily(pc.os);
            const shot = shots[pc.id];
            return (
              <div key={pc.id} className="aresosCard">
                <div className="aresosCardHead">
                  <span className="aresosDot" /> <b>{pc.label || pc.hostname}</b>
                </div>
                <div className="aresosMeta">{fam.glyph} {pc.os} · {pc.hostname}</div>
                <div className="aresosMeta aresosDim">{pc.ip} · connected {agoLabel(pc.connectedAt)} ago</div>

                <div className="aresosShot">
                  {shot?.data ? (
                    <img className="aresosShotImg" src={shot.data} alt={`${pc.hostname} screen`} onClick={() => onPreview(pc.id)} title="Click to refresh" />
                  ) : shot?.loading ? (
                    <div className="aresosShotPlaceholder">Capturing…</div>
                  ) : shot?.error ? (
                    <div className="aresosShotPlaceholder aresosShotErr">{shot.error.length > 90 ? "Screen view isn't available on this device yet." : shot.error}</div>
                  ) : (
                    <button className="aresosGhost aresosSm aresosShotBtn" onClick={() => onPreview(pc.id)}>👁 Preview screen</button>
                  )}
                </div>

                <div className="aresosCardRow">
                  <button className="aresosPrimary aresosSm" onClick={() => onHelp(pc)}>Help this PC</button>
                  <button className="aresosGhost aresosSm" onClick={() => onDisconnect(pc.id)}>Disconnect</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ArtifactsPage({
  vault,
  onOpenFile,
  onReturn,
  onJump,
}: {
  vault: Vault;
  onOpenFile: (path: string, label: string) => void;
  onReturn: () => void;
  onJump: (sessionId: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "images" | "files" | "links">("all");
  const [query, setQuery] = useState("");
  const ql = query.trim().toLowerCase();
  const match = (e: VaultEntry) => !ql || e.label.toLowerCase().includes(ql) || e.url.toLowerCase().includes(ql);
  const images = vault.images.filter(match);
  const files = vault.files.filter(match);
  const links = vault.links.filter(match);
  const total = vault.images.length + vault.files.length + vault.links.length;
  const visibleTotal =
    (filter === "all" || filter === "images" ? images.length : 0) +
    (filter === "all" || filter === "files" ? files.length : 0) +
    (filter === "all" || filter === "links" ? links.length : 0);

  return (
    <div className="vault">
      <header className="vaultHero">
        <div>
          <span className="vaultEyebrow">From every chat</span>
          <h2>Made by your agents</h2>
          <p>Everything your agents build, find and cite, in one place.</p>
        </div>
        <div className="vaultMetric" aria-label={`${total} artifacts`}>
          <strong>{total}</strong>
          <span>{total === 1 ? "artifact" : "artifacts"}</span>
        </div>
      </header>

      <div className="vaultHead">
        <input value={query} placeholder="Search what they made…" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        <nav aria-label="Artifact filters">
          {(
            [
              ["all", total],
              ["images", vault.images.length],
              ["files", vault.files.length],
              ["links", vault.links.length],
            ] as Array<["all" | "images" | "files" | "links", number]>
          ).map(([f, n]) => (
            <button key={f} data-on={filter === f ? "1" : "0"} onClick={() => setFilter(f)}>
              {f} <em>{n}</em>
            </button>
          ))}
        </nav>
      </div>

      <div className="vaultScroll">
        {total === 0 ? (
          <div className="vaultEmpty">
            <div className="emptyEmblem" aria-hidden="true" />
            <strong>Nothing made yet.</strong>
            <p>Images your agents find, files they write and links they cite show up here on their own.</p>
            <button className="primary tiny" onClick={onReturn}>Back to chats</button>
          </div>
        ) : visibleTotal === 0 ? (
          <div className="vaultEmpty compact">
            <i className="glyph" data-glyph="search" />
            <strong>No matching artifacts</strong>
            <p>Try another search or switch back to All.</p>
            <button
              className="ghost"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              Clear filters
            </button>
          </div>
        ) : null}

        {(filter === "all" || filter === "images") && images.length > 0 ? (
          <>
            <div className="vaultLabel">Images</div>
            <div className="vaultGrid">
              {images.map((e) => (
                <figure key={e.key} className="vaultCard">
                  <img src={e.url} loading="lazy" alt={e.label} />
                  <figcaption>
                    <strong>{e.label}</strong>
                    <button onClick={() => onJump(e.sessionId)}>{e.session}</button>
                  </figcaption>
                </figure>
              ))}
            </div>
          </>
        ) : null}

        {(filter === "all" || filter === "files") && files.length > 0 ? (
          <>
            <div className="vaultLabel">Files</div>
            <div className="vaultTable">
              {files.map((e) => (
                <div key={e.key} className="vaultRow">
                  <i className="glyph" data-glyph="file" />
                  <button className="vaultName" onClick={() => onOpenFile(e.url, e.label)}>
                    {e.label}
                  </button>
                  <span className="vaultLoc">{e.url}</span>
                  <button className="vaultSession" onClick={() => onJump(e.sessionId)}>
                    {e.session}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {(filter === "all" || filter === "links") && links.length > 0 ? (
          <>
            <div className="vaultLabel">Links</div>
            <div className="vaultTable">
              {links.map((e) => (
                <div key={e.key} className="vaultRow">
                  <i className="glyph" data-glyph="web" />
                  <a className="vaultName" href={e.url} target="_blank" rel="noreferrer">
                    {e.label}
                  </a>
                  <span className="vaultLoc">{e.url}</span>
                  <button className="vaultSession" onClick={() => onJump(e.sessionId)}>
                    {e.session}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── HELM — "The Scrying Basin of Ares" ─────────────────────────────────────
// A God-of-War war-room: a molten scrying basin at the heart, six augury slates
// of live daemon data orbiting it, an omen ledger below. Everything heats, cools,
// boils and stirs off two drivers written to the root: --heat (0..1 molten temp)
// and --draft (0..1 daemon-gated ambient). Each agent action STIRS the basin.

function kfmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(n));
}

/**
 * HELM, modern skin — the design's reading of the same room: a medallion
 * header, a row of struck stat tiles, then the operator's durable goals beside
 * the trust rails it has actually earned. Every number here is live; nothing
 * is a mock. The Forged/Legacy temple (ScryingBasin and friends) is untouched
 * below and still renders for those skins.
 */
function HelmModern({
  daemon,
  opStatus,
  usage,
  keyStatus,
  sessions,
  roster,
  activePersona,
  cognitive,
  tab,
  onTab,
  activeFleet,
  fleetHistory,
  subagentJobs,
  operatorHalted,
  onToggleHalt,
  onResumeFleet,
  onOpenSession,
  onToggleAutotick,
  onRefresh,
  onAdoptPersona,
  onDeletePersona,
  onWritePersona,
  personaStyle,
  onPersonaStyle,
}: {
  daemon: DaemonState;
  opStatus: { activeCount: number; goals: Array<{ id: string; statement: string; status: string; progress: number }>; autotick: boolean; trust?: Array<{ domain: string; level: number; proven: number }> } | null;
  usage: UsageStats | null;
  keyStatus: Record<string, boolean>;
  sessions: SessionVm[];
  roster: PersonaVm[];
  activePersona: PersonaVm | null;
  cognitive: CognitiveStateVm | null;
  /** Controlled by the app so the status bar's persona chip can deep-link
   *  straight to Agents — a "you're wearing Forge" indicator you can't click
   *  through to is only half an answer. */
  tab: "overview" | "agents" | "fleets" | "mind";
  onTab: (tab: "overview" | "agents" | "fleets" | "mind") => void;
  /** The active session's live fleet board — mirrored into the Fleets tab. */
  activeFleet: FleetVm | undefined;
  fleetHistory: FleetSummaryWire[];
  subagentJobs: SubagentJobWire[];
  operatorHalted: boolean;
  onToggleHalt: () => void;
  onResumeFleet: (fleetId: string) => void;
  onOpenSession: (id: string) => void;
  onToggleAutotick: () => void;
  onRefresh: () => void;
  onAdoptPersona: (name: string | null) => void;
  onDeletePersona: (name: string) => void;
  onWritePersona: (draft: PersonaDraft) => void;
  personaStyle?: string;
  onPersonaStyle: (style: "ares" | "neutral") => void;
}) {
  const setTab = onTab;
  // Anything the owner would want to notice without going looking. Drives the
  // dot on the Mind tab — a red check or a dead subsystem should not require
  // opening the panel to discover.
  const attention =
    (cognitive?.uncertainty.length ?? 0) +
    (cognitive?.failures.length ?? 0) +
    (cognitive?.blockedApprovals.length ?? 0) +
    (cognitive?.liveness.filter((l) => l.state === "dead").length ?? 0);
  const goals = opStatus?.goals ?? [];
  const activeGoals = goals.filter((g) => g.status === "active");
  const trust = opStatus?.trust ?? [];
  const services = [
    { id: "anthropic", label: "Anthropic" }, { id: "openrouter", label: "OpenRouter" },
    { id: "deepseek", label: "DeepSeek" }, { id: "ollama", label: "Ollama" }, { id: "brave", label: "Brave" },
  ];
  const connected = services.filter((s) => keyStatus[s.id]).length;
  const freshIn = Math.max(0, (usage?.tokensIn ?? 0) - (usage?.cacheReadTokens ?? 0));
  const reusedPct = usage && usage.tokensIn > 0 ? Math.round((usage.cacheReadTokens / usage.tokensIn) * 100) : 0;
  const recent = sessions.filter((s) => !s.background && (s.loaded !== false || s.items.length > 0)).slice(0, 5);

  // Live workers for the Fleets tab badge: running fleet agents + running
  // background Task subagents.
  const fleetsLive =
    (activeFleet?.agents.filter((a) => a.status === "running").length ?? 0) +
    subagentJobs.filter((j) => j.status === "running").length;

  const stats = [
    { label: "Missions", value: String(opStatus?.activeCount ?? 0), sub: opStatus?.autotick ? "hunting unattended" : "attended only" },
    { label: "Sessions", value: String(sessions.length), sub: "rehydrated from rollout" },
    { label: "Tokens", value: kfmt(freshIn + (usage?.tokensOut ?? 0)), sub: `${reusedPct}% reused from cache` },
    { label: "Providers", value: `${connected}/${services.length}`, sub: "keys installed" },
  ];

  return (
    <div className="hm">
      <header className="hmHead">
        <Medallion glyph="helm" size={54} tone="ember" />
        <div className="hmHeadText">
          <h2>HELM</h2>
          <p>The agent's own state — mind, operator, rails.</p>
        </div>
        <span className="hmDaemon" data-state={daemon}>
          <i />{daemon === "running" ? "Garrison ready" : daemon}
        </span>
        <button className="hmGhost" onClick={onRefresh}>Re-scry</button>
      </header>

      <div className="hmTabs" role="tablist">
        {([
          { id: "overview" as const, label: "Overview", glyph: "helm" },
          { id: "fleets" as const, label: "Fleets", glyph: "sessions" },
          { id: "mind" as const, label: "Mind", glyph: "search" },
        ]).map((t) => (
          <button
            key={t.id}
            className="hmTab"
            role="tab"
            aria-selected={tab === t.id}
            data-on={tab === t.id ? "1" : "0"}
            onClick={() => setTab(t.id)}
          >
            <Sigil name={asSigilName(t.glyph)} size={18} />
            <span>{t.label}</span>
            {t.id === "fleets" && fleetsLive > 0 ? <em className="hmTabCount">{fleetsLive}</em> : null}
            {t.id === "mind" && attention > 0 ? <em className="hmTabCount" data-alert="1">{attention}</em> : null}
          </button>
        ))}
        <span className="hmTabRail" data-at={tab} aria-hidden="true" />
      </div>

      {tab === "mind" ? (
        <HelmMind cognitive={cognitive} />
      ) : tab === "fleets" ? (
        <HelmFleets
          fleet={activeFleet}
          history={fleetHistory}
          jobs={subagentJobs}
          onResume={onResumeFleet}
        />
      ) : (
      <div className="hmPane" key="overview">
      <div className="hmStats">
        {stats.map((s) => (
          <div className="hmStat" key={s.label}>
            <div className="hmStatLabel">{s.label}</div>
            <div className="hmStatValue">{s.value}</div>
            <div className="hmStatSub">{s.sub}</div>
          </div>
        ))}
      </div>

      <div className="hmPanels">
        <section className="hmPanel">
          <div className="hmPanelLabel">Durable goals · Operator</div>
          {activeGoals.length === 0 ? (
            <p className="hmEmpty">No missions march. Queue one and Ares hunts unattended.</p>
          ) : (
            activeGoals.slice(0, 5).map((g) => (
              <div className="hmGoal" key={g.id}>
                <div className="hmGoalTop">
                  <span className="hmDiamond" aria-hidden="true">◈</span>
                  <span className="hmGoalText">{compact(g.statement, 62)}</span>
                  <span className="hmGoalPct">{Math.round((g.progress ?? 0) * 100)}%</span>
                </div>
                <span className="hmBar"><i style={{ width: `${Math.round((g.progress ?? 0) * 100)}%` }} /></span>
              </div>
            ))
          )}
          <button className="hmToggle" data-on={opStatus?.autotick ? "1" : "0"} onClick={onToggleAutotick}>
            <span>Unattended hunt</span>
            <i className="hmSwitch" data-on={opStatus?.autotick ? "1" : "0"} />
          </button>
          <button
            className="hmToggle hmHalt"
            data-halted={operatorHalted ? "1" : "0"}
            onClick={onToggleHalt}
            title={operatorHalted
              ? "The operator is halted — nothing advances until you resume it."
              : "Stop the operator from advancing any mission until you resume it."}
          >
            <span>{operatorHalted ? "Resume operator" : "Halt operator"}</span>
            <i className="hmSwitch" data-on={operatorHalted ? "0" : "1"} />
          </button>
        </section>

        <section className="hmPanel">
          <div className="hmPanelLabel">The rails · earned trust</div>
          {trust.length === 0 ? (
            <p className="hmEmpty">No domain has proven itself yet. Trust is earned per domain, by result.</p>
          ) : (
            trust.slice(0, 6).map((t) => (
              <div className="hmRail" key={t.domain}>
                <span className="hmRailStage">{t.domain}</span>
                <span className="hmRailPips">
                  {[1, 2, 3, 4, 5].map((p) => <i key={p} data-lit={p <= t.level ? "1" : "0"} />)}
                </span>
                <span className="hmRailVerdict">{t.proven} proven</span>
              </div>
            ))
          )}
          <div className="hmPanelLabel hmPanelLabelInner">Recent sessions</div>
          {recent.length === 0 ? (
            <p className="hmEmpty">Nothing engraved yet.</p>
          ) : (
            recent.map((s) => (
              <button className="hmSession" key={s.id} onClick={() => onOpenSession(s.id)}>
                <Medallion glyph="sessions" size={26} />
                <span className="hmSessionTitle">{compact(s.title, 44)}</span>
                <span className="hmRailVerdict">{s.items.length} items</span>
              </button>
            ))
          )}
        </section>
      </div>
      </div>
      )}
    </div>
  );
}

/** HELM → Fleets: the active session's live fleet board plus the durable
 *  ledger — past fleets (fleets_list) and background Task subagents
 *  (subagents_list), both refreshed on the 5s helm poll. The live board is
 *  fold-state, so it moves in real time between polls. */
function HelmFleets({
  fleet,
  history,
  jobs,
  onResume,
}: {
  fleet: FleetVm | undefined;
  history: FleetSummaryWire[];
  jobs: SubagentJobWire[];
  onResume: (fleetId: string) => void;
}) {
  const when = (v?: string | number): string => {
    if (v === undefined || v === "") return "";
    const d = typeof v === "number" ? new Date(v) : new Date(String(v));
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  return (
    <div className="hmPane hmFleets" key="fleets">
      <section className="hmPanel">
        <div className="hmPanelLabel">Live fleet · this session</div>
        {fleet && fleet.agents.length > 0 ? (
          <FleetPanel fleet={fleet} onResume={onResume} />
        ) : (
          <p className="hmEmpty">No fleet marching in this session. Ask for a big parallel build and the board lights up here.</p>
        )}
      </section>

      <div className="hmPanels">
        <section className="hmPanel">
          <div className="hmPanelLabel">Fleet ledger · {history.length}</div>
          {history.length === 0 ? (
            <p className="hmEmpty">No fleets on record yet. Every Conductor run lands here, win or lose.</p>
          ) : (
            history.slice(0, 20).map((f) => (
              <div className="hmFleetRow" key={f.fleetId} data-status={f.status ?? ""}>
                <i className="hmFleetDot" data-status={f.status ?? ""} aria-hidden="true" />
                <div className="hmFleetText">
                  <strong title={f.goal ? `${f.goal} · ${f.fleetId}` : f.fleetId}>{compact(f.goal || f.fleetId, 64)}</strong>
                  <span>
                    {f.status ?? "unknown"}
                    {` · ${(f.phases ?? []).length} phase${(f.phases ?? []).length === 1 ? "" : "s"}`}
                    {when(f.startedAt) ? ` · ${when(f.startedAt)}` : ""}
                  </span>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="hmPanel">
          <div className="hmPanelLabel">Background agents · {jobs.length}</div>
          {jobs.length === 0 ? (
            <p className="hmEmpty">No background Task agents running or on record.</p>
          ) : (
            jobs.slice(0, 20).map((j) => (
              <div className="hmFleetRow" key={j.jobId} data-status={j.status}>
                <i className="hmFleetDot" data-status={j.status} aria-hidden="true" />
                <div className="hmFleetText">
                  <strong title={j.jobId}>{compact(j.description || j.jobId, 64)}</strong>
                  <span>
                    {j.status}
                    {j.kind ? ` · ${j.kind}` : ""}
                    {when(j.startedAt) ? ` · ${when(j.startedAt)}` : ""}
                  </span>
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * The cockpit. Read-only by design.
 *
 * Ares reported four capabilities as missing that all already existed in code;
 * what was missing was any way to SEE them, so a subsystem that had quietly
 * died looked identical to one that was never built. This panel is the
 * instrument that tells those two apart.
 *
 * Two rules it holds to:
 *   - a skipped or cached check is never displayed as a pass;
 *   - an empty section says it is empty, and says what that means, rather than
 *     being hidden (a hidden panel reads as "nothing to worry about").
 */
function HelmMind({ cognitive }: { cognitive: CognitiveStateVm | null }) {
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);

  if (!cognitive) {
    return (
      <div className="hmPane hmMind" key="mind">
        <p className="hmEmpty">No snapshot yet — the garrison has not reported in. Open a session and this fills in.</p>
      </div>
    );
  }

  const c = cognitive;
  const dead = c.liveness.filter((l) => l.state === "dead");
  const verdictWord = { pass: "PASS", fail: "FAIL", skip: "SKIP" } as const;

  return (
    <div className="hmPane hmMind" key="mind">
      {/* The one thing worth reading first: a subsystem that should be working
          and is not. This is the failure mode that hid for three releases. */}
      {dead.length > 0 ? (
        <div className="hmAlarm">
          <Medallion glyph={asSigilName("shield")} size={34} tone="ember" />
          <div className="hmAlarmText">
            <strong>{dead.length === 1 ? "A subsystem is not working" : `${dead.length} subsystems are not working`}</strong>
            {dead.map((d) => <span key={d.subsystem}>{d.subsystem} — {d.detail}</span>)}
          </div>
        </div>
      ) : null}

      <div className="hmMindGrid">
        {/* ── Pursuing ─────────────────────────────────────────────── */}
        <section className="hmPanel hmMindCard">
          <div className="hmPanelLabel">Pursuing</div>
          {c.missions.length === 0 && !c.objective ? (
            <p className="hmEmpty">Nothing durable in flight. This session is answering turn by turn.</p>
          ) : (
            <>
              {c.objective ? (
                <div className="hmMindObjective">
                  <strong>{c.objective}</strong>
                  {c.phase ? <em className="hmPill">{c.phase}</em> : null}
                </div>
              ) : null}
              {c.currentStep ? <div className="hmMindStep"><i className="hmStepDot" aria-hidden="true" />{c.currentStep}</div> : null}
              {c.steering.length > 0 ? (
                <div className="hmCardRow">
                  <span className="hmCardRowLabel">You steered</span>
                  {c.steering.map((t, i) => <q key={i} className="hmGreeting">{t}</q>)}
                </div>
              ) : null}
              {c.missions.map((m) => (
                <div className="hmGoal" key={m.id}>
                  <div className="hmGoalTop">
                    <span className="hmDiamond" aria-hidden="true">◈</span>
                    <span className="hmGoalText">{compact(m.statement, 70)}</span>
                    <span className="hmGoalPct">{Math.round(m.progress * 100)}%</span>
                  </div>
                  <span className="hmBar"><i style={{ width: `${Math.round(m.progress * 100)}%` }} /></span>
                  {/* Without the contract, a progress number has no referent. */}
                  {m.contract ? <p className="hmMindContract">Done means: {m.contract}</p> : (
                    <p className="hmMindContract" data-warn="1">No mission contract — "done" is not defined for this goal.</p>
                  )}
                </div>
              ))}
              {c.todos.length > 0 ? (
                <ul className="hmMindTodos">
                  {c.todos.map((t, i) => (
                    <li key={i} data-status={t.status}>{t.content}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </section>

        {/* ── Evidence ─────────────────────────────────────────────── */}
        <section className="hmPanel hmMindCard">
          <div className="hmPanelLabel">What proves it</div>
          {c.evidence.length === 0 ? (
            <p className="hmEmpty">Nothing has been checked yet. Any claim of "done" from this session is unproven.</p>
          ) : (
            c.evidence.map((e, i) => {
              const key = `${e.label}-${i}`;
              const open = openEvidence === key;
              return (
                <div className="hmProof" key={key} data-verdict={e.verdict}>
                  <button className="hmProofTop" onClick={() => setOpenEvidence(open ? null : key)} aria-expanded={open}>
                    <span className="hmProofVerdict" data-verdict={e.verdict}>{verdictWord[e.verdict]}</span>
                    <span className="hmProofLabel">{e.label}</span>
                    {e.cached ? <em className="hmPill" title="Reused from cache — not re-run against the current files">cached</em> : null}
                    {e.durationMs > 0 ? <span className="hmProofMs">{Math.round(e.durationMs / 100) / 10}s</span> : null}
                  </button>
                  <code className="hmProofCmd">{e.command}</code>
                  {e.outputTail ? (
                    <SpringHeight>
                      {open ? <pre className="hmProofOut">{e.outputTail}</pre> : null}
                    </SpringHeight>
                  ) : open ? (
                    <p className="hmEmpty">No output was captured for this run.</p>
                  ) : null}
                </div>
              );
            })
          )}
        </section>

        {/* ── Uncertainty ──────────────────────────────────────────── */}
        <section className="hmPanel hmMindCard">
          <div className="hmPanelLabel">Not sure about</div>
          {c.workStatus ? (
            <div className="hmMindWork" data-status={c.workStatus}>
              last turn: {c.workStatus}
            </div>
          ) : null}
          {c.uncertainty.length === 0 ? (
            <p className="hmEmpty">Nothing flagged. That is only meaningful if checks have actually run — see the panel above.</p>
          ) : (
            <ul className="hmMindList">
              {c.uncertainty.map((u, i) => <li key={i}>{u}</li>)}
            </ul>
          )}
        </section>

        {/* ── Failures + recovery ──────────────────────────────────── */}
        <section className="hmPanel hmMindCard">
          <div className="hmPanelLabel">What went wrong</div>
          {c.failures.length === 0 ? (
            <p className="hmEmpty">No repeated tool failures recorded.</p>
          ) : (
            c.failures.map((f) => (
              <div className="hmFail" key={`${f.tool}-${f.signature}`}>
                <div className="hmFailTop">
                  <span className="hmFailTool">{f.tool}</span>
                  <em className="hmFailCount" data-hot={f.count >= 3 ? "1" : "0"}>×{f.count}</em>
                  <code className="hmFailSig">{f.signature}</code>
                </div>
                <p className="hmFailMsg">{f.latest}</p>
              </div>
            ))
          )}
          {c.recovery.length > 0 ? (
            <>
              <div className="hmPanelLabel hmPanelLabelInner">Recovery</div>
              <ul className="hmMindList">{c.recovery.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </>
          ) : null}
        </section>

        {/* ── Recalled + touched ───────────────────────────────────── */}
        <section className="hmPanel hmMindCard">
          <div className="hmPanelLabel">What I remembered</div>
          {c.recalled.length === 0 ? (
            <p className="hmEmpty">No memories were pulled into the last turn.</p>
          ) : (
            <>
              <p className="hmMindCount">{c.recalled.length} fact{c.recalled.length === 1 ? "" : "s"} injected</p>
              <span className="hmTriggers">{c.recalled.map((m) => <em key={m.id}>{m.id}</em>)}</span>
            </>
          )}
          {c.touchedFiles.length > 0 ? (
            <>
              <div className="hmPanelLabel hmPanelLabelInner">Files touched</div>
              <span className="hmTriggers">{c.touchedFiles.map((f) => <em key={f}>{f}</em>)}</span>
            </>
          ) : null}
        </section>

        {/* ── Waiting on you ──────────────────────────────────────── */}
        <section className="hmPanel hmMindCard">
          <div className="hmPanelLabel">Waiting on you</div>
          {c.blockedApprovals.length === 0 ? (
            <p className="hmEmpty">Nothing is blocked on your approval.</p>
          ) : (
            c.blockedApprovals.map((b, i) => (
              <div className="hmBlocked" key={i}>
                <Medallion glyph={asSigilName("shield")} size={28} tone="ember" />
                <div>
                  <strong>{b.tool}</strong>
                  <span>{b.reason}</span>
                </div>
              </div>
            ))
          )}
        </section>
      </div>

      {/* ── Liveness strip ─────────────────────────────────────────── */}
      <div className="hmPanelLabel hmPanelLabelInner">Is each part actually running?</div>
      <div className="hmLive">
        {c.liveness.map((l) => (
          <div className="hmLiveRow" key={l.subsystem} data-state={l.state}>
            <i className="hmLiveDot" aria-hidden="true" />
            <span className="hmLiveName">{l.subsystem}</span>
            <span className="hmLiveState">{l.state}</span>
            <span className="hmLiveDetail">{l.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Fields the owner can author from HELM → Agents. Mirrors persona_write.
 *
 *  `tools`/`model`/`effort`/`maxTurns` are NOT editable in the form, but they
 *  ride along anyway: persona_write is a whole-file overwrite, so omitting them
 *  when saving an edit silently widened Aegis's delegated belt from six tools to
 *  the full set and dropped every model preference. A form that can't show a
 *  field must still carry it. */
interface PersonaDraft {
  name: string;
  label: string;
  description: string;
  greeting: string;
  body: string;
  triggers: string[];
  glyph: string;
  tone: "ember" | "mint" | "ivory";
  autonomy: "auto" | "suggest" | "manual";
  tools?: string[];
  model?: string;
  effort?: string;
  maxTurns?: number;
}

const AUTONOMY_COPY: Record<PersonaVm["autonomy"], { label: string; hint: string }> = {
  auto: { label: "Steps in", hint: "Takes over when its triggers match, and announces itself so you always know." },
  suggest: { label: "Offers", hint: "Suggests itself when its triggers match — nothing changes until you tap." },
  manual: { label: "On call", hint: "Only when you pick it, or when Ares delegates a task to it." },
};

const PERSONA_GLYPHS = ["helm", "forge", "shield", "search", "scroll", "skills", "sessions", "usage", "messaging", "flame"];

function HelmView({
  daemon,
  opStatus,
  usage,
  keyStatus,
  sessions,
  active,
  roster,
  activePersona,
  cognitive,
  tab,
  onTab,
  fleetHistory,
  subagentJobs,
  operatorHalted,
  onToggleHalt,
  onResumeFleet,
  onOpenSession,
  onToggleAutotick,
  onRefresh,
  onAdoptPersona,
  onDeletePersona,
  onWritePersona,
  personaStyle,
  onPersonaStyle,
}: {
  daemon: DaemonState;
  opStatus: { activeCount: number; goals: Array<{ id: string; statement: string; status: string; progress: number }>; autotick: boolean; trust?: Array<{ domain: string; level: number; proven: number }> } | null;
  usage: UsageStats | null;
  keyStatus: Record<string, boolean>;
  sessions: SessionVm[];
  active: SessionVm | undefined;
  roster: PersonaVm[];
  activePersona: PersonaVm | null;
  cognitive: CognitiveStateVm | null;
  tab: "overview" | "agents" | "fleets" | "mind";
  onTab: (tab: "overview" | "agents" | "fleets" | "mind") => void;
  fleetHistory: FleetSummaryWire[];
  subagentJobs: SubagentJobWire[];
  operatorHalted: boolean;
  onToggleHalt: () => void;
  onResumeFleet: (fleetId: string) => void;
  onOpenSession: (id: string) => void;
  onToggleAutotick: () => void;
  onRefresh: () => void;
  onAdoptPersona: (name: string | null) => void;
  onDeletePersona: (name: string) => void;
  onWritePersona: (draft: PersonaDraft) => void;
  personaStyle?: string;
  onPersonaStyle: (style: "ares" | "neutral") => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const modern = useUiStyle() === "modern";
  const busy = Boolean(active?.busy);
  const activity = active?.activity ?? "";
  const [stir, setStir] = useState(0);

  // Heat/draft drivers — written straight to the node so the whole temple
  // re-tempers without per-frame React renders.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const base = daemon === "running" ? 0.34 : daemon === "starting" ? 0.2 : 0.06;
    const missionHeat = Math.min(0.18, (opStatus?.activeCount ?? 0) * 0.06);
    const heat = Math.min(1, base + (busy ? 0.42 : 0) + missionHeat);
    const draft = daemon === "running" ? 1 : daemon === "starting" ? 0.5 : 0.08;
    el.style.setProperty("--heat", heat.toFixed(3));
    el.style.setProperty("--draft", draft.toFixed(3));
    el.dataset.daemon = daemon;
    el.dataset.working = busy ? "1" : "0";
  }, [daemon, busy, opStatus?.activeCount]);

  // Action-as-heartbeat: each new activity string spikes a stir/shockwave.
  useEffect(() => {
    if (!activity) return;
    setStir((n) => n + 1);
  }, [activity]);

  const onMove = (e: React.MouseEvent) => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const tx = ((e.clientX - r.left) / r.width - 0.5) * 5;
    const ty = ((e.clientY - r.top) / r.height - 0.5) * 5;
    el.style.setProperty("--tilt-x", `${(-ty).toFixed(2)}deg`);
    el.style.setProperty("--tilt-y", `${tx.toFixed(2)}deg`);
  };

  const goals = opStatus?.goals ?? [];
  const activeGoals = goals.filter((g) => g.status === "active");
  const wonGoals = goals.filter((g) => g.status === "completed" || g.status === "done");
  const todos = active?.todos ?? [];
  const recentSessions = sessions.filter((s) => !s.background && (s.loaded !== false || s.items.length > 0)).slice(0, 6);
  const services = [
    { id: "anthropic", label: "Anthropic" }, { id: "openrouter", label: "OpenRouter" },
    { id: "deepseek", label: "DeepSeek" }, { id: "ollama", label: "Ollama" }, { id: "brave", label: "Brave" },
  ];
  const connected = services.filter((s) => keyStatus[s.id]).length;
  const daily = usage?.daily ?? [];
  const peak = Math.max(1, ...daily.map((d) => d.in + d.out));

  // The modern skin reads HELM the way the design does — struck tiles and
  // ledgers, not the molten temple. Hooks above already ran, so this early
  // return is stable across renders.
  if (modern) {
    return (
      <HelmModern
        daemon={daemon}
        opStatus={opStatus}
        usage={usage}
        keyStatus={keyStatus}
        sessions={sessions}
        roster={roster}
        activePersona={activePersona}
        cognitive={cognitive}
        tab={tab}
        onTab={onTab}
        activeFleet={active?.fleet}
        fleetHistory={fleetHistory}
        subagentJobs={subagentJobs}
        operatorHalted={operatorHalted}
        onToggleHalt={onToggleHalt}
        onResumeFleet={onResumeFleet}
        onOpenSession={onOpenSession}
        onToggleAutotick={onToggleAutotick}
        onRefresh={onRefresh}
        onAdoptPersona={onAdoptPersona}
        onDeletePersona={onDeletePersona}
        onWritePersona={onWritePersona}
        personaStyle={personaStyle}
        onPersonaStyle={onPersonaStyle}
      />
    );
  }

  return (
    <div className="helm-root" ref={rootRef} onMouseMove={onMove} data-daemon={daemon}>
      {/* ambient ember field — gated by --draft */}
      <div className="helm-embers" aria-hidden="true" />
      <div className="helm-vignette" aria-hidden="true" />

      {/* LINTEL — top ticker */}
      <div className="helm-lintel">
        <span className="helm-rune">⚔</span>
        <div className="helm-ticker">
          <span data-on={busy ? "1" : "0"}>{busy ? (activity || "Ares moves…") : daemon === "running" ? "The Garrison stands. Ares awaits the word." : `Daemon ${daemon}`}</span>
        </div>
        <button className="helm-refresh" onClick={onRefresh} title="Re-scry">⟳</button>
      </div>

      {/* CENTER GRID — basin flanked by three slates per side */}
      <div className="helm-content">
        {/* THE OMPHALOS — molten scrying basin */}
        <div className={busy ? "helm-basin working" : "helm-basin"} data-stir={stir % 2}>
          <ScryingBasin heat={busy ? 1 : 0.4} />
          <div className="helm-basin-core">
            <div className="helm-basin-count">{opStatus?.activeCount ?? 0}</div>
            <div className="helm-basin-label">{(opStatus?.activeCount ?? 0) === 1 ? "MISSION" : "MISSIONS"}</div>
            <div className="helm-basin-state" data-state={daemon}>{daemon === "running" ? "GARRISON UP" : daemon.toUpperCase()}</div>
          </div>
          {/* shockwave keyed to each stir */}
          <span key={stir} className="helm-shock" aria-hidden="true" />
        </div>

        <div className="helm-slate slate-war">
          <h4>Omen of War</h4>
          {activeGoals.length === 0 ? (
            <p className="helm-empty">No missions march. Queue one and Ares hunts unattended.</p>
          ) : (
            <ul className="helm-missions">
              {activeGoals.slice(0, 4).map((g) => (
                <li key={g.id}>
                  <span className="helm-mtext">{compact(g.statement, 54)}</span>
                  <span className="helm-bar"><i style={{ width: `${Math.round((g.progress ?? 0) * 100)}%` }} /></span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="helm-slate slate-plan">
          <h4>Pythia's Plan</h4>
          {todos.length === 0 ? (
            <p className="helm-empty">{busy ? "Ares deliberates…" : "Silent. No plan etched."}</p>
          ) : (
            <ul className="helm-todos">
              {todos.slice(0, 5).map((t) => (
                <li key={t.id} data-status={t.status}>
                  <i className="helm-glyph" />{compact(t.status === "in_progress" ? t.activeForm : t.content, 48)}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="helm-slate slate-cost">
          <h4>Entrails of Cost</h4>
          <div className="helm-cost">
            <div><b><SpringNumber value={Math.max(0, (usage?.tokensIn ?? 0) - (usage?.cacheReadTokens ?? 0))} format={kfmt} /></b><span>fresh in</span></div>
            <div><b><SpringNumber value={usage?.tokensOut ?? 0} format={kfmt} /></b><span>out</span></div>
            <div><b><SpringNumber value={usage?.apiCalls ?? 0} format={kfmt} /></b><span>calls</span></div>
          </div>
          <div className="helm-cost-cached">
            cached <SpringNumber value={usage?.cacheReadTokens ?? 0} format={kfmt} /> · {usage && usage.tokensIn > 0 ? Math.round((usage.cacheReadTokens / usage.tokensIn) * 100) : 0}% reused
          </div>
          <div className="helm-spark">
            {daily.slice(-14).map((d, i) => (
              <span key={i} title={d.date} style={{ height: `${Math.max(6, Math.round(((d.in + d.out) / peak) * 100))}%` }} />
            ))}
          </div>
        </div>

        <div className="helm-slate slate-auguries">
          <h4>Auguries · {connected}/{services.length}</h4>
          <ul className="helm-augur">
            {services.map((s) => (
              <li key={s.id} data-on={keyStatus[s.id] ? "1" : "0"}><i />{s.label}</li>
            ))}
          </ul>
        </div>

        <div className="helm-slate slate-memory">
          <h4>Stelae of Memory · {sessions.length}</h4>
          {recentSessions.length === 0 ? (
            <p className="helm-empty">No engraved sessions yet.</p>
          ) : (
            <ul className="helm-stelae">
              {recentSessions.map((s) => (
                <li key={s.id}><button onClick={() => onOpenSession(s.id)}>{compact(s.title, 40)}</button></li>
              ))}
            </ul>
          )}
        </div>

        <div className="helm-slate slate-favor">
          <h4>Favor of Ares</h4>
          <div className="helm-gauge" data-state={daemon}>
            <div className="helm-gauge-fill" />
            <span>{daemon === "running" ? "FAVORED" : daemon.toUpperCase()}</span>
          </div>
          {(opStatus?.trust ?? []).length > 0 ? (
            <ul className="helm-trust" title="Earned leash — trust the Crucible has proven, domain by domain">
              {(opStatus?.trust ?? []).slice(0, 4).map((t) => (
                <li key={t.domain}>
                  <span className="helm-trust-domain">{t.domain}</span>
                  <span className="helm-trust-pips">
                    {[1, 2, 3, 4, 5].map((p) => <i key={p} data-lit={p <= t.level ? "1" : "0"} />)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <button className="helm-toggle" data-on={opStatus?.autotick ? "1" : "0"} onClick={onToggleAutotick}>
            <i />{opStatus?.autotick ? "Unattended hunt: ON" : "Unattended hunt: OFF"}
          </button>
        </div>
      </div>

      {/* OMEN LEDGER — recent victories */}
      <div className="helm-ledger">
        <span className="helm-rune">𐤀</span>
        {wonGoals.length === 0 ? (
          <span className="helm-ledger-empty">Victories will be carved here as missions fall.</span>
        ) : (
          <div className="helm-ledger-scroll">
            {wonGoals.slice(0, 8).map((g) => <span key={g.id} className="helm-tablet">✓ {compact(g.statement, 40)}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}

// The molten basin surface — SVG feTurbulence + displacement (the WebGL-free
// "never blank" path from the design), with rotating rune rings and a pulsing
// core light whose intensity rides --heat.
function ScryingBasin({ heat }: { heat: number }) {
  return (
    <svg className="helm-basin-svg" viewBox="0 0 400 400" aria-hidden="true">
      <defs>
        <radialGradient id="moltenPool" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--ember-hi, #ffd27a)" stopOpacity={0.95} />
          <stop offset="34%" stopColor="var(--ember, #e08b2e)" stopOpacity={0.9} />
          <stop offset="68%" stopColor="var(--blood, #7a1f12)" stopOpacity={0.92} />
          <stop offset="100%" stopColor="#1a0d08" stopOpacity={1} />
        </radialGradient>
        <radialGradient id="poolGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--ember-hi, #ffd27a)" stopOpacity={0.9} />
          <stop offset="55%" stopColor="var(--accent, #c79a4e)" stopOpacity={0.25} />
          <stop offset="100%" stopColor="var(--accent, #c79a4e)" stopOpacity={0} />
        </radialGradient>
        <filter id="boil" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves={2} seed={7} result="noise">
            <animate attributeName="baseFrequency" dur={`${(9 - heat * 4).toFixed(1)}s`} values="0.010 0.018;0.020 0.030;0.010 0.018" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale={heat > 0.7 ? 26 : 16} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      {/* outer rune ring */}
      <circle className="helm-ring-outer" cx="200" cy="200" r="186" />
      <circle className="helm-ring-mid" cx="200" cy="200" r="158" />
      {/* the molten surface */}
      <circle cx="200" cy="200" r="140" fill="url(#moltenPool)" filter="url(#boil)" className="helm-pool" />
      {/* fresnel rim */}
      <circle cx="200" cy="200" r="140" fill="none" stroke="var(--ember-hi, #ffd27a)" strokeOpacity={0.5} strokeWidth={2} className="helm-pool-rim" />
      {/* core light */}
      <circle cx="200" cy="200" r="120" fill="url(#poolGlow)" className="helm-pool-glow" />
    </svg>
  );
}

/** Chats the machine opened for itself (verifiers, room relays, scheduled
 *  checks, background shells, the daily feed): never the owner's to keep on
 *  the Older chats shelf. */
const MACHINE_CHAT = /^(\[room |\(System:|Verify \d+ changed file|\[background shell|Background task failed|Today feed — )/;

/** "[text from frankie lingling · urgent] CEO: hi" → "frankie lingling: CEO: hi". */
function shelfTitle(title: string): string {
  return title.replace(/^\[text from ([^\]·]+?)\s*(?:·[^\]]*)?\]\s*/, "$1: ");
}

/** When an older chat was last used, short enough to leave the title its room: "Oct 18". */
function shelfDate(iso: string | undefined): string | undefined {
  const t = iso ? new Date(iso) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleDateString([], { month: "short", day: "numeric" }) : undefined;
}

function SessionRow({
  s,
  display,
  when,
  activeId,
  pinned,
  project,
  onSelect,
  onPin,
  onRename,
  onClose,
  onProject,
  handoff,
}: {
  s: SessionVm;
  /** Shown instead of the raw title (renaming still edits the real one). */
  display?: string;
  /** A short date on the right ("Oct 18"). */
  when?: string;
  activeId: string;
  /** "Give to an agent": who can take this chat (its owner excluded). */
  handoff?: { agents: Array<Pick<AgentVm, "id" | "name" | "emoji" | "color">>; onGive: (sessionId: string, agentId: string) => void };
  pinned?: boolean;
  /** Name of the project this session currently belongs to, if any. */
  project?: string;
  onSelect: (id: string) => void;
  onPin: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onClose: (id: string) => void;
  onProject: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const [draft, setDraft] = useState(s.title);
  const [projectDraft, setProjectDraft] = useState(project ?? "");
  const [confirming, setConfirming] = useState(false);
  const [giving, setGiving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const projectInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(s.title);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, s.title]);

  useEffect(() => {
    if (editingProject) {
      setProjectDraft(project ?? "");
      requestAnimationFrame(() => projectInputRef.current?.select());
    }
  }, [editingProject, project]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== s.title) onRename(s.id, next);
    setEditing(false);
  };

  const commitProject = () => {
    const next = projectDraft.trim();
    if (next !== (project ?? "")) onProject(s.id, next);
    setEditingProject(false);
  };

  if (editing) {
    return (
      <div className={s.id === activeId ? "session on editing" : "session editing"}>
        <input
          ref={inputRef}
          className="sessionRename"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") setEditing(false);
          }}
        />
      </div>
    );
  }

  if (editingProject) {
    return (
      <div className={s.id === activeId ? "session on editing" : "session editing"}>
        <input
          ref={projectInputRef}
          className="sessionRename"
          value={projectDraft}
          placeholder="Project name — empty removes"
          spellCheck={false}
          list="aresProjectOptions"
          onChange={(e) => setProjectDraft(e.target.value)}
          onBlur={commitProject}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitProject();
            else if (e.key === "Escape") setEditingProject(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className={s.id === activeId ? "session on" : "session"} data-giving={giving ? "1" : "0"}>
      <button className="sessionMain" onClick={() => onSelect(s.id)} onDoubleClick={() => setEditing(true)} title="Double-click to rename">
        <i data-busy={s.busy ? "1" : "0"} />
        <span>{display ?? s.title}</span>
        {when ? <em className="sessionWhen">{when}</em> : null}
      </button>
      <div className="sessionActions">
        <button className="rowBtn" title="Rename" onClick={() => setEditing(true)}>✎</button>
        {handoff && handoff.agents.length > 0 ? (
          <button className="rowBtn" title="Give this chat to an agent (it keeps the whole history)" aria-label="Give to an agent" onClick={() => setGiving((v) => !v)}>⇢</button>
        ) : null}
        <button className="rowBtn" data-project={project ? "1" : "0"} title={project ? `Project: ${project} — click to move or remove` : "Group into a project"} onClick={() => setEditingProject(true)}>▦</button>
        <button className="pinBtn" data-pinned={pinned ? "1" : "0"} title={pinned ? "unpin" : "pin"} onClick={() => onPin(s.id)}>
          {pinned ? "◆" : "◇"}
        </button>
        {confirming ? (
          <button className="rowBtn danger" title="Confirm delete" onClick={() => { onClose(s.id); setConfirming(false); }}>✓</button>
        ) : (
          <button className="rowBtn" title="Close session" onClick={() => { setConfirming(true); setTimeout(() => setConfirming(false), 2600); }}>✕</button>
        )}
      </div>
      {giving && handoff ? (
        <div className="handoffMenu" onMouseLeave={() => setGiving(false)}>
          <b>Give this chat to</b>
          {handoff.agents.map((a) => (
            <button key={a.id} onClick={() => { setGiving(false); handoff.onGive(s.id, a.id); }}>
              <AgentAvatar agent={a} size={22} />
              {a.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ─── The live fleet board — Conductor agents, grouped by phase ──────────────
// ─── The delegation cut-scene — Ares handing a job to Claude Code / Codex ────
// A little animated stage: Ares (the dragon) beams a task across to the chosen
// backend's character, a phase timeline lights up (detect → install → running →
// done), and Ares narrates. Pure CSS/emoji — no assets, CSP-safe.
const CODING_CHARS: Record<string, { glyph: string; accent: string }> = {
  claude: { glyph: "✳", accent: "#d9935a" },
  codex: { glyph: "◆", accent: "#74c39c" },
};
const CODING_PHASES: Array<CodingBackendVm["phase"]> = ["detect", "install", "running", "done"];
function codingNarration(vm: CodingBackendVm): string {
  switch (vm.phase) {
    case "detect": return `Sizing up the job — is ${vm.label} here?`;
    case "install": return `Bringing ${vm.label} online…`;
    case "running": return `${vm.label} is on it — I'm driving. This is overpowered.`;
    case "done": return `Done — ${vm.filesTouched} file${vm.filesTouched === 1 ? "" : "s"} touched. Completely overpowered. 🔥`;
    case "failed": return `${vm.label} choked. I've got it from here.`;
    default: return "";
  }
}
function CodingBackendScene({ vm }: { vm: CodingBackendVm }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (vm.phase === "done" || vm.phase === "failed") return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [vm.phase]);
  const backend = CODING_CHARS[vm.backend] ?? CODING_CHARS.claude;
  const elapsed = Math.max(0, Math.round((Date.now() - vm.startedTick) / 1000));
  const running = vm.phase === "running";
  const activeIdx = CODING_PHASES.indexOf(vm.phase === "failed" ? "running" : vm.phase);
  const lastLine = vm.lines[vm.lines.length - 1];
  return (
    <div className="cbScene" data-phase={vm.phase} data-backend={vm.backend} style={{ ["--cb-accent" as string]: backend.accent }}>
      <div className="cbStage">
        <div className="cbChar cbAres" title="Ares">
          <span className="cbAvatar">🐉</span>
          <span className="cbName">Ares</span>
        </div>
        <div className="cbBeam" aria-hidden="true"><i /><i /><i /></div>
        <div className="cbChar cbBackend" title={vm.label}>
          <span className="cbAvatar">{backend.glyph}</span>
          <span className="cbName">{vm.label}</span>
        </div>
      </div>
      <div className="cbBubble">{codingNarration(vm)}</div>
      <div className="cbTimeline">
        {CODING_PHASES.map((p, i) => (
          <div key={p} className="cbStep" data-state={vm.phase === "done" || i < activeIdx ? "done" : i === activeIdx ? "active" : "todo"}>
            <i className="cbStepDot" /><span>{p}</span>
          </div>
        ))}
      </div>
      <div className="cbMeta">
        {running && lastLine ? <span className="cbLive" title={lastLine}>{lastLine.slice(0, 84)}</span> : <span className="cbLive cbLiveIdle">{running ? "streaming…" : vm.phase}</span>}
        <span className="cbTally">{vm.filesTouched} file{vm.filesTouched === 1 ? "" : "s"}</span>
        <span className="cbClock">{elapsed}s</span>
      </div>
    </div>
  );
}

function FleetPanel({ fleet, onResume }: { fleet: FleetVm; onResume: (fleetId: string) => void }) {
  const agents = fleet.agents;
  const total = agents.length;
  const done = agents.filter((a) => a.status === "done").length;
  const failed = agents.filter((a) => a.status === "failed").length;
  const running = agents.filter((a) => a.status === "running").length;
  const phases: string[] = [];
  for (const a of agents) if (!phases.includes(a.phase)) phases.push(a.phase);
  return (
    <div className="fleetPanel" data-active={fleet.active ? "1" : "0"}>
      <div className="fleetHead">
        <span className="fleetTitle"><i className="fleetPulse" />FLEET</span>
        <span className="fleetCounts">
          {running > 0 ? <em data-k="run">{running} running</em> : null}
          <em data-k="done">{done} done</em>
          {failed > 0 ? <em data-k="fail">{failed} failed</em> : null}
          <em data-k="total">/ {total}</em>
          {fleet.canResume && fleet.fleetId ? (
            <button className="fleetResume" onClick={() => onResume(fleet.fleetId!)} title="re-run the failed leaves; completed ones are reused from disk">
              ↻ Resume
            </button>
          ) : null}
        </span>
      </div>
      <div className="fleetBody">
        {phases.map((ph) => (
          <div key={ph} className="fleetPhase">
            <div className="fleetPhaseName">{ph}</div>
            <div className="fleetAgents">
              {agents.filter((a) => a.phase === ph).map((a) => (
                <div key={a.id} className="fleetAgent" data-status={a.status}>
                  <i className="fleetDot" />
                  <span className="fleetRole">{a.role}</span>
                  <span className="fleetAct">
                    {a.resumed ? "reused" : a.status === "running" ? (a.activity || a.tool || "working…") : a.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── The effort slider — low → max → ULTRA (with the fleet ignition) ─────────
// ─── Dictation (speech → text) ───────────────────────────────────────────────
// Mic → MediaRecorder (webm/opus) → Google Speech REST. Same public Chromium key
// the rest of Ares uses for voice notes; the webview reaches the API directly
// (verified: no CORS wall), so this needs no daemon, no native bridge, no keys.
const STT_KEY_ENC = "QUl6YVN5Qk90aTRtTS02eDlXRG5aSWpJZXlFVTIxT3BCWHFXQmd3";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1)); // strip the data: prefix
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}


// Vision-safe downscale, done in the webview with a plain <canvas> — no deps.
// WHY THIS EXISTS: the Ares Gateway rides Vercel, whose serverless transport
// hard-caps the request body at ~4.5MB. A raw pasted screenshot (often 5–12MB)
// used to sail past the old client guard, 413 at the gateway, and — because the
// same oversized body was resent every turn — LOCK the session dead (a real
// user sat stranded for 8h overnight). Models already downscale images to
// ~1568px on the long edge, so shrinking to that here costs the model nothing
// while cutting multi-MB pastes to a few hundred KB. We re-encode as JPEG and
// step quality/size down until the payload is comfortably under budget.
const MAX_IMG_EDGE = 1568; // Anthropic's long-edge downscale target; larger buys no quality
async function downscaleAttachment(dataUrl: string): Promise<string> {
  // Already small — leave it byte-for-byte (keeps PNG alpha / exact pixels).
  if (dataUrlB64Len(dataUrl) <= MAX_ATTACH_B64) return dataUrl;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = dataUrl;
    });
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (!w || !h) return dataUrl;
    const scale = Math.min(1, MAX_IMG_EDGE / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const render = (cw: number, ch: number): HTMLCanvasElement | null => {
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      // JPEG has no alpha — white-fill first so transparent PNGs don't go black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      return canvas;
    };
    let canvas = render(w, h);
    if (!canvas) return dataUrl;
    // Step quality down, then halve dimensions, until it fits the wire budget.
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const out = canvas.toDataURL("image/jpeg", quality);
      if (dataUrlB64Len(out) <= MAX_ATTACH_B64) return out;
    }
    for (let pass = 0; pass < 3; pass++) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      canvas = render(w, h);
      if (!canvas) break;
      const out = canvas.toDataURL("image/jpeg", 0.6);
      if (dataUrlB64Len(out) <= MAX_ATTACH_B64) return out;
    }
    return canvas ? canvas.toDataURL("image/jpeg", 0.4) : dataUrl; // best effort
  } catch {
    return dataUrl; // never block a paste on a processing failure — the daemon guard is the backstop
  }
}

async function transcribeSpeech(blob: Blob, language = "en-US"): Promise<string> {
  const key = atob(STT_KEY_ENC);
  const content = await blobToBase64(blob);
  const res = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: { encoding: "WEBM_OPUS", languageCode: language, model: "default", enableAutomaticPunctuation: true },
      audio: { content },
    }),
  });
  if (!res.ok) throw new Error(`stt ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  return (data.results ?? []).map((r) => r.alternatives?.[0]?.transcript ?? "").join(" ").trim();
}

// A `provides:stt` skill's transcriber, installed by the App component when one
// is enabled. Module-level so the mic hooks (which live in deeply-nested
// components) reach it without threading a prop through every layer.
const globalSttProvider: { current: ((audioB64: string, mime: string) => Promise<string | null>) | null } = { current: null };

type DictState = "idle" | "recording" | "thinking" | "error";
/**
 * Tap once, speak, then pause → transcribe → onText. Prefers the LOCAL voice
 * sidecar (faster-whisper, offline, no key, mic captured server-side so there's
 * no WebView getUserMedia dance). Falls back to the old MediaRecorder → Google
 * Speech path only when the sidecar isn't reachable, so the mic still works on a
 * machine without the sidecar running. Both paths use silence detection; a
 * second click merely finishes early and is never required.
 */
function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictState>("idle");
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const legacyVadFrame = useRef<number | null>(null);
  const legacyAudioContext = useRef<AudioContext | null>(null);
  const sttRef = useRef<Awaited<ReturnType<typeof sidecarListen>> | null>(null);
  const usingSidecar = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stopLegacyVad = () => {
    if (legacyVadFrame.current !== null) cancelAnimationFrame(legacyVadFrame.current);
    legacyVadFrame.current = null;
    if (legacyAudioContext.current) void legacyAudioContext.current.close().catch(() => null);
    legacyAudioContext.current = null;
  };

  const cleanupStream = () => {
    stopLegacyVad();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // ── legacy path (MediaRecorder → provider skill → Google) — the fallback ──
  const startLegacy = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime });
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
    rec.onstop = async () => {
      cleanupStream();
      const blob = new Blob(chunksRef.current, { type: mime });
      if (!blob.size) { setState("idle"); return; }
      setState("thinking");
      try {
        // A provides:stt skill (whisper.cpp, Deepgram, …) transcribes the
        // recording first; the cloud path is the last resort.
        let txt = "";
        const provider = globalSttProvider.current;
        if (provider) {
          const viaSkill = await provider(await blobToBase64(blob), mime).catch(() => null);
          if (viaSkill?.trim()) txt = viaSkill.trim();
        }
        if (!txt) txt = await transcribeSpeech(blob);
        setState("idle");
        if (txt) onTextRef.current(txt);
      } catch {
        setState("error");
        setTimeout(() => setState("idle"), 2400);
      }
    };
    rec.start();
    recRef.current = rec;
    setState("recording");

    // Even the emergency WebView recorder is one-tap now. A tiny local energy
    // gate ends capture after the user pauses, then the existing provider/cloud
    // transcription path receives the finished blob.
    try {
      const ctx = new AudioContext();
      legacyAudioContext.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const started = performance.now();
      let heardSpeech = false;
      let lastVoice = started;
      const watchSilence = () => {
        if (rec.state === "inactive") return;
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        const rms = Math.sqrt(energy / samples.length);
        const now = performance.now();
        if (rms >= 0.014) { heardSpeech = true; lastVoice = now; }
        if ((heardSpeech && now - lastVoice >= 3_000) || (!heardSpeech && now - started >= 8_000) || now - started >= 22_000) {
          setState("thinking");
          rec.stop();
          return;
        }
        legacyVadFrame.current = requestAnimationFrame(watchSilence);
      };
      legacyVadFrame.current = requestAnimationFrame(watchSilence);
    } catch {
      // Manual early-finish remains available when Web Audio is unavailable.
    }
  }, []);

  const start = useCallback(async () => {
    setState("thinking");
    // Try the local sidecar first — in AUTO mode, so the mic also ends itself
    // when you stop talking (the transcript just lands in the composer).
    try {
      const handle = await sidecarListen((status) => {
        setState(status === "listening" ? "recording" : "thinking");
      }, { auto: true, silenceMs: 3_000 });
      sttRef.current = handle;
      usingSidecar.current = true;
      setState("recording");
      // VAD auto-stop: the transcript can arrive without stop() being clicked.
      void handle.transcript.then((txt) => {
        if (sttRef.current !== handle) return; // manual stop already handled it
        sttRef.current = null;
        usingSidecar.current = false;
        setState("idle");
        if (txt) onTextRef.current(txt);
      });
      return;
    } catch {
      usingSidecar.current = false;
      sttRef.current = null;
    }
    // Sidecar down → legacy.
    try {
      await startLegacy();
    } catch {
      cleanupStream();
      setState("error");
      setTimeout(() => setState("idle"), 2400);
    }
  }, [startLegacy]);

  const stop = useCallback(() => {
    if (usingSidecar.current && sttRef.current) {
      const handle = sttRef.current;
      sttRef.current = null;
      usingSidecar.current = false;
      setState("thinking");
      void handle.stop().then((txt) => {
        setState("idle");
        if (txt) onTextRef.current(txt);
      }).catch(() => {
        setState("error");
        setTimeout(() => setState("idle"), 2400);
      });
      return;
    }
    if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
  }, []);

  const toggle = useCallback(() => {
    setState((s) => {
      if (s === "recording") { stop(); return s; }
      if (s === "idle" || s === "error") { void start(); }
      return s;
    });
  }, [start, stop]);

  useEffect(() => () => {
    try { sttRef.current?.cancel(); } catch { /* ignore */ }
    if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
    cleanupStream();
  }, []);

  return { state, toggle };
}

const MicGlyph = () => (
  <svg className="voiceAperture" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
    <circle className="voiceOrbit" cx="10" cy="10" r="8" strokeWidth="1" />
    <path className="voiceBar voiceBar1" d="M6 11V9" strokeWidth="1.8" />
    <path className="voiceBar voiceBar2" d="M10 14V6" strokeWidth="1.8" />
    <path className="voiceBar voiceBar3" d="M14 12V8" strokeWidth="1.8" />
  </svg>
);

function AresPillGlyph({ active = false }: { active?: boolean }) {
  return (
    <svg className="aresPillGlyph" data-active={active ? "1" : "0"} viewBox="0 0 28 16" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="26" height="14" rx="7" stroke="currentColor" strokeWidth="1.35" />
      <path d="M8 8h2m2-2.5v5M15 4v8m3-4h2" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
      <circle cx="23.2" cy="8" r="1.25" fill="currentColor" />
    </svg>
  );
}

// ─── The floating pill — Ares condensed to an always-on-top mic bar ──────────
function PillBar({
  daemon,
  busy,
  cancelling,
  activity,
  conversation,
  listening,
  speaking,
  wakeStatus,
  onExpand,
  onToggleConversation,
  onStop,
  native,
}: {
  daemon: DaemonState;
  busy: boolean;
  cancelling: boolean;
  activity: string;
  conversation: boolean;
  listening: boolean;
  speaking: boolean;
  wakeStatus: "off" | "arming" | "armed" | "offline";
  onExpand: () => void;
  onToggleConversation: () => void;
  onStop: () => void;
  native: boolean;
}) {
  const label =
    listening ? "listening…" :
    speaking ? "speaking" :
    cancelling ? "stopping safely…" :
    busy ? (activity || "working…") :
    conversation ? "conversation open" : wakeStatus === "armed" ? "hey ares armed" : daemon === "running" ? "ready" : daemon;

  const onDrag = (e: React.MouseEvent) => {
    if (!native || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    void getCurrentWindow().startDragging().catch(() => null);
  };

  return (
    <div className="pillBar" data-busy={busy ? "1" : "0"} data-conversation={conversation ? "1" : "0"} onMouseDown={onDrag}>
      <div className="pillTopline">
        <span className="pillMark"><AresPillGlyph active={listening || speaking || busy} /></span>
        <span className="pillStatus">
          <i className="dot" data-state={listening || speaking || busy ? "running" : daemon} />
          <em>{label}</em>
        </span>
        <span className="pillGrow" />
        <button className="pillMic" data-state={listening ? "recording" : wakeStatus === "offline" ? "error" : conversation || wakeStatus === "armed" ? "armed" : "idle"} onClick={onToggleConversation} title={conversation ? "close hands-free conversation" : "open hands-free conversation"}>
          {listening ? <i className="pillSpin" /> : <MicGlyph />}
        </button>
        {busy ? (
          <button className="pillBtn" onClick={onStop} title={cancelling ? "stopping — press again to force-stop a stuck turn" : "stop the turn"}>
            <svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>
          </button>
        ) : null}
        <button className="pillBtn" onClick={onExpand} title="expand Ares">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2 L14 2 L14 7 M14 2 L8.5 7.5 M7 14 L2 14 L2 9 M2 14 L7.5 8.5" /></svg>
        </button>
      </div>
    </div>
  );
}

// ─── Composer ───────────────────────────────────────────────────────────────
// Owns its OWN text state so keystrokes never re-render the transcript. Sends,
// or steers mid-turn (queue a message the daemon folds in at a safe boundary).

const Composer = React.memo(function Composer({
  hidden,
  busy,
  agentName = "Ares",
  cancelling,
  model,
  autoRouting,
  routedLanes,
  todos,
  backgroundJobs,
  onStopBackground,
  onResumeBackground,
  steerQueued,
  steerActivity,
  recoverableDrafts,
  onDraftsRecovered,
  onSend,
  onSteer,
  onStop,
  onModelChip,
  onRoutingChip,
  slashActions,
  footer,
}: {
  /** display:none instead of unmount — preserves the draft across view flips. */
  hidden?: boolean;
  busy: boolean;
  /** Who this chat talks to — the composer addresses them by name. */
  agentName?: string;
  cancelling: boolean;
  model: string;
  autoRouting: boolean;
  routedLanes: RouteLane[];
  todos: Array<{ id: string; content: string; activeForm: string; status: string }>;
  backgroundJobs: BackgroundJobVm[];
  onStopBackground: (id: string) => void;
  onResumeBackground: (id: string) => void;
  steerQueued: number;
  steerActivity?: string;
  recoverableDrafts: NonNullable<SessionVm["recoverableDrafts"]>;
  onDraftsRecovered: (inputIds: string[]) => void;
  onSend: (text: string, images?: string[]) => boolean;
  onSteer: (text: string, images?: string[]) => boolean;
  onStop: () => void;
  onModelChip: () => void;
  onRoutingChip: () => void;
  slashActions: SlashAction[];
  /** Under the input bar: the agent's model and effort. */
  footer?: React.ReactNode;
}) {
  const [text, setText] = useState("");
  // "/" command menu: visible while the draft is a bare slash prefix.
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashQuery = text.startsWith("/") && !/\s/.test(text) && text.length <= 24 ? text.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery !== null && !slashDismissed
    ? slashActions.filter((a) => a.id.startsWith(slashQuery) || a.label.toLowerCase().includes(slashQuery))
    : [];
  const runSlash = (a: SlashAction) => {
    a.run();
    setText("");
    setSlashSel(0);
    if (ref.current) ref.current.style.height = "auto";
  };
  const [attachments, setAttachmentsState] = useState<Array<{ name: string; dataUrl: string; path?: string; size?: number }>>([]);
  // Mirrors `attachments` synchronously. Refs update immediately (unlike state,
  // which is batched/rendered-on-a-delay) — submit() reads THIS after awaiting
  // in-flight reads below, since the `attachments` state variable itself would
  // still be the stale value captured when this render's submit closure formed.
  const attachmentsRef = useRef<Array<{ name: string; dataUrl: string; path?: string; size?: number }>>([]);
  const setAttachments = (updater: (prev: Array<{ name: string; dataUrl: string; path?: string; size?: number }>) => Array<{ name: string; dataUrl: string; path?: string; size?: number }>) => {
    attachmentsRef.current = updater(attachmentsRef.current);
    setAttachmentsState(attachmentsRef.current);
  };
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // True while submit() is in flight (it awaits pending attachment reads).
  const submittingRef = useRef(false);
  const cancellingRef = useRef(cancelling);
  cancellingRef.current = cancelling;
  const restoredDraftIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const pending = recoverableDrafts.filter((draft) => !restoredDraftIds.current.has(draft.inputId));
    if (pending.length === 0) return;
    for (const draft of pending) restoredDraftIds.current.add(draft.inputId);
    const textParts = pending.map((draft) => draft.text.trim()).filter(Boolean);
    if (textParts.length > 0) {
      const restored = textParts.join("\n\n");
      setText((current) => {
        const clean = current.trim();
        if (!clean) return restored;
        if (clean === restored || clean.startsWith(`${restored}\n`)) return current;
        return `${restored}\n\n${current}`;
      });
    }
    const restoredImages = pending.flatMap((draft) => draft.images ?? []);
    if (restoredImages.length > 0) {
      const existing = new Set(attachmentsRef.current.map((attachment) => attachment.dataUrl));
      const additions = restoredImages
        .filter((dataUrl) => !existing.has(dataUrl))
        .map((dataUrl, index) => ({ name: `restored-steer-${index + 1}`, dataUrl }));
      if (additions.length > 0) {
        attachmentsRef.current = [...additions, ...attachmentsRef.current];
        setAttachmentsState(attachmentsRef.current);
      }
    }
    onDraftsRecovered(pending.map((draft) => draft.inputId));
  }, [onDraftsRecovered, recoverableDrafts]);
  // The modern skin swaps the composer's glyphs for Ares sigils (markup, not
  // just CSS — the sigils are <use> refs into the sprite).
  const modern = useUiStyle() === "modern";
  // In-flight FileReader reads from a paste/drop that haven't landed in
  // `attachments` yet. FileReader is async — pasting a screenshot and
  // immediately hitting Enter (a completely normal motion) could fire submit()
  // before the read finishes, silently sending text-only with the image gone
  // and no error shown ("Ares can't see my pasted image"). submit() awaits
  // these before deciding what to send.
  const pendingReads = useRef<Set<Promise<void>>>(new Set());
  // Dictation drops the transcript into the draft (appended), then focuses.
  const dictation = useDictation((t) => {
    setText((prev) => (prev.trim() ? prev.replace(/\s+$/, "") + " " : "") + t);
    ref.current?.focus();
  });

  // Append a line to the draft without eating what is already typed.
  const appendDraft = (line: string) => {
    setText((current) => (current.trim() ? `${current.replace(/\s+$/, "")}\n${line}` : line));
  };
  // A small text file (source, notes, JSON, logs) drops in as a quoted block
  // the model can read directly. Larger or binary files are named so the drop
  // is never silent — with a real path (native drop) the agent can Read them.
  const TEXT_FILE_MAX = 1024 * 1024;
  const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|yaml|yml|toml|ini|cfg|conf|env|csv|tsv|log|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|ps1|bat|cmd|sql|lua|r|m|ex|exs|erl|hs|scala|dart|vue|svelte|astro|graphql|proto|dockerfile|gitignore|editorconfig|lock)$/i;
  const quoteTextFile = (name: string, text: string, pathHint?: string) => {
    const fence = text.includes("```") ? "````" : "```";
    const ext = (name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
    appendDraft(`${pathHint ? `File: ${pathHint}` : `File: ${name}`}\n${fence}${ext}\n${text.replace(/\r\n/g, "\n").replace(/\s+$/, "")}\n${fence}`);
  };
  const looksLikeTextFile = (file: File) => file.type.startsWith("text/") || /json|xml|javascript|yaml|toml|csv|x-sh/.test(file.type) || TEXT_EXT.test(file.name) || (!file.type && file.size > 0 && file.size <= TEXT_FILE_MAX);

  const addFiles = (files: Iterable<File>) => {
    for (const file of files) {
      const attachmentType = supportedAttachmentMediaType(file);
      if (!attachmentType.looksLikeImage) {
        // Every non-image file — text, code, PDF, archive — is kept as a file
        // and shown as a chip; Ares reads it with its tools. Quoting text files
        // into the message dumped their contents into the composer.
        // Anything else (PDF, docx, zip, binaries …) is kept as a real file:
        // its bytes go to Ares's dropped-files folder and the message carries
        // the path, so Ares can open it with its tools — like dropping into
        // Claude or Codex, not like pasting a location.
        const inTauri = "__TAURI_INTERNALS__" in window;
        if (inTauri && file.size <= 200 * 1024 * 1024) {
          const stash: Promise<void> = new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = String(reader.result ?? "");
              const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
              invoke<string>("ares_stash_file", { name: file.name || "dropped.bin", base64: b64 })
                .then((path) => setAttachments((prev) => [...prev, { name: file.name || "dropped.bin", dataUrl: "", path, size: file.size }]))
                .catch((err) => appendDraft(`[Dropped ${file.name || "file"} could not be kept: ${String(err)}]`))
                .finally(resolve);
            };
            reader.onerror = () => { appendDraft(`[Dropped ${file.name || "file"} could not be read.]`); resolve(); };
            reader.readAsDataURL(file);
          });
          pendingReads.current.add(stash);
          void stash.finally(() => pendingReads.current.delete(stash));
          continue;
        }
        appendDraft(`[Dropped ${file.name || "file"}${file.type ? ` (${file.type}` : " ("}${file.size ? `${file.type ? ", " : ""}${fmtBytes(file.size)}` : ""}) — ${inTauri ? "too large to keep (200 MB max)" : "files are kept only in the desktop app"}.]`);
        continue;
      }
      if (!attachmentType.mediaType) {
        const notice = `[Attachment skipped: ${file.name || "image"} uses ${file.type || "an unknown image type"}; convert it to PNG, JPEG, WebP, or GIF.]`;
        setText((current) => current.trim() ? `${current.replace(/\s+$/, "")}\n${notice}` : notice);
        continue;
      }
      if (file.size > 15 * 1024 * 1024) {
        const notice = `[Attachment skipped: ${file.name || "image"} is larger than 15 MB; resize it and try again.]`;
        setText((current) => current.trim() ? `${current.replace(/\s+$/, "")}\n${notice}` : notice);
        continue;
      }
      const read: Promise<void> = new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result ?? "");
          if (!dataUrl.startsWith("data:image/")) {
            resolve();
            return;
          }
          // Shrink to a vision-safe size BEFORE it becomes an attachment, so an
          // oversized paste can never reach the gateway and 413 the turn.
          void downscaleAttachment(dataUrl)
            .then((processed) => {
              const encodedChars = dataUrlB64Len(processed);
              let rejected = "";
              setAttachments((prev) => {
                const violation = attachmentBudgetViolation(
                  prev.map((attachment) => dataUrlB64Len(attachment.dataUrl)),
                  encodedChars,
                );
                if (violation === "per_image") {
                  rejected = `[Attachment skipped: ${file.name || "image"} could not be reduced below the per-image request limit.]`;
                  return prev;
                }
                if (violation === "count") {
                  rejected = `[Attachment skipped: one message can contain at most ${MAX_ATTACHMENTS} images.]`;
                  return prev;
                }
                if (violation === "total") {
                  rejected = "[Attachment skipped: the images exceed the total request budget; send this image in a separate message.]";
                  return prev;
                }
                return [...prev, { name: file.name || "pasted-image", dataUrl: processed }];
              });
              if (rejected) {
                setText((current) => current.trim() ? `${current.replace(/\s+$/, "")}\n${rejected}` : rejected);
              }
            })
            .finally(() => resolve());
        };
        reader.onerror = () => resolve(); // never hang submit() on an unreadable file
        // Windows drag/drop sometimes reports an empty/octet-stream MIME even
        // for a normal .png/.jpg. Re-wrap the bytes with the extension-derived
        // canonical type so FileReader produces a parseable image data URL.
        const source = file.type.trim().toLowerCase() === attachmentType.mediaType
          ? file
          : new Blob([file], { type: attachmentType.mediaType });
        reader.readAsDataURL(source);
      });
      pendingReads.current.add(read);
      void read.finally(() => pendingReads.current.delete(read));
    }
  };

  // Native drops (files AND folders, with real paths). Tauri's own drag-drop
  // handler is ON (dragDropEnabled:true): on Windows that is the only way a
  // drop reaches the app with paths, and paths are what let the agent read a
  // PDF, open a folder, or work in a dropped project. Images attach inline,
  // small text files are quoted, everything else lands as its path.
  const addPaths = async (paths: string[]) => {
    if (!paths.length) return;
    let entries: Array<{ path: string; name: string; kind: string; size: number; content?: string | null; entries?: number | null; note?: string | null }> = [];
    try {
      entries = await invoke("ares_inspect_paths", { paths });
    } catch (err) {
      appendDraft(`[Dropped ${paths.length} item(s) but could not read them: ${String(err)}]`);
      return;
    }
    const images: File[] = [];
    for (const e of entries) {
      if (e.kind === "image" && e.content) {
        try {
          const blob = await (await fetch(e.content)).blob();
          images.push(new File([blob], e.name, { type: blob.type || "image/png" }));
        } catch {
          appendDraft(`[Dropped image ${e.name} could not be decoded; path: ${e.path}]`);
        }
      } else if (e.kind === "text" && typeof e.content === "string") {
        quoteTextFile(e.name, e.content, e.path);
      } else if (e.kind === "dir") {
        appendDraft(`Folder: ${e.path}${typeof e.entries === "number" ? ` (${e.entries}${e.entries >= 500 ? "+" : ""} entries)` : ""}`);
      } else if (e.kind === "missing") {
        appendDraft(`[Dropped ${e.name} but it is not there anymore: ${e.path}]`);
      } else {
        appendDraft(`File: ${e.path}${e.size ? ` (${fmtBytes(e.size)})` : ""}${e.note ? ` — ${e.note}` : ""}`);
      }
    }
    if (images.length) addFiles(images);
    ref.current?.focus();
  };
  useEffect(() => {
    let unlisten: null | (() => void) = null;
    let live = true;
    // Native path drops exist only inside the Tauri shell; in a plain browser
    // (the vite preview) getCurrentWebview() throws before any promise forms.
    if (!("__TAURI_INTERNALS__" in window)) return;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") void addPaths(event.payload.paths);
      })
      .then((fn) => { if (live) unlisten = fn; else fn(); })
      .catch(() => { /* not native (browser preview) — the HTML5 path below still works */ });
    return () => { live = false; unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // HTML5 drops (dragged text/URLs from other apps, and file drops on platforms
  // where the native handler leaves them to the page). Still preventDefault:
  // without it the webview navigates to the dropped file.
  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      if (dt.files && dt.files.length) {
        e.preventDefault();
        // a folder arrives as a File with no type and no readable bytes;
        // say so instead of stashing an empty blob
        const entries = Array.from(dt.items ?? []).map((it) => (typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null));
        const dirs = entries.filter((en): en is FileSystemEntry => !!en && en.isDirectory).map((en) => en.name);
        const files = Array.from(dt.files).filter((f) => !dirs.includes(f.name));
        if (dirs.length) appendDraft(`Folder: ${dirs.join(", ")} — drop the files inside it, or type the path so Ares can walk it.`);
        if (files.length) addFiles(files);
        return;
      }
      // Dragged TEXT (from a page, editor, etc.) drops into the composer.
      const dropped = dt.getData("text/plain") || dt.getData("text/uri-list") || dt.getData("text");
      if (dropped && dropped.trim()) {
        e.preventDefault();
        setText((prev) => (prev.trim() ? prev.replace(/\s+$/, "") + " " : "") + dropped.trim());
        ref.current?.focus();
      }
    };
    const onOverAny = (e: DragEvent) => {
      // Allow BOTH file and text drops (getData is empty during dragover, so
      // check types) — without this the webview blocks the drop or navigates.
      const types = Array.from(e.dataTransfer?.types ?? []);
      if (types.includes("Files") || types.includes("text/plain") || types.includes("text/uri-list") || types.includes("text")) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      }
    };
    // Ctrl+V with focus on the transcript, a panel, or nothing at all: the
    // composer still takes it. Editable targets keep their own paste.
    const onPasteAnywhere = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editable = !!target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
      if (editable) return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const files = items.filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter((f): f is File => !!f);
      const plain = e.clipboardData?.getData("text/plain") ?? "";
      if (!files.length && !plain.trim()) return;
      e.preventDefault();
      if (files.length) addFiles(files);
      if (plain.trim()) setText((prev) => (prev.trim() ? prev.replace(/\s+$/, "") + " " : "") + plain.trim());
      ref.current?.focus();
    };
    window.addEventListener("dragover", onOverAny);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPasteAnywhere);
    return () => { window.removeEventListener("dragover", onOverAny); window.removeEventListener("drop", onDrop); window.removeEventListener("paste", onPasteAnywhere); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    // Re-entry latch: the await below yields, so a second Enter (or Enter +
    // send-button click) during a pending attachment read used to run the whole
    // body twice and double-send the same draft.
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      if (cancellingRef.current) return;
      if (pendingReads.current.size > 0) await Promise.all(pendingReads.current);
      if (cancellingRef.current) return;
      const t = text.trim();
      const currentAttachments = attachmentsRef.current;
      if (!t && currentAttachments.length === 0) return;
      // Images travel OUT OF BAND now (not concatenated into the message text) so
      // the transcript renders thumbnails, not a truncated base64 blob. The daemon
      // still gets them as image content, and send() shows them on the bubble.
      const imgs = currentAttachments.filter((a) => a.dataUrl).map((a) => a.dataUrl);
      const kept = currentAttachments.filter((a) => a.path);
      const t2 = kept.length ? `${t}${t ? "\n\n" : ""}${kept.map((a) => `Attached file: ${a.path}${a.size ? ` (${fmtBytes(a.size)})` : ""}`).join("\n")}` : t;
      if (busy) {
        // If Stop/settlement won a local race, retain the draft. Ownership moves
        // out of the composer only after the parent accepts this exact steer.
        if (!onSteer(t2, imgs)) return;
      } else if (!onSend(t2, imgs)) return;
      setText("");
      setAttachments(() => []);
      if (ref.current) ref.current.style.height = "auto";
    } finally {
      submittingRef.current = false;
    }
  };
  return (
    <div className="composer" style={hidden ? { display: "none" } : undefined}>
      {todos.length > 0 ? <TodoPanel todos={todos} /> : null}
      <BackgroundPanel jobs={backgroundJobs} onStop={onStopBackground} onResume={onResumeBackground} />
      {/* Model / reasoning / routing live in the bottom HUD only — no duplicate
         control strip over the input. Just a contextual steer indicator here. */}
      {busy && steerQueued > 0 ? (
        <div className="chips">
          <span className="chip steerChip">{steerQueued > 1 ? `${steerQueued} steers · ` : ""}{steerActivity ?? "sending steer"}</span>
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="attachments">
          {attachments.map((a, idx) => (
            <span className="attachChip" key={idx} title={a.path ? `${a.path}${a.size ? ` · ${fmtBytes(a.size)}` : ""}` : a.name} data-kind={a.path ? "file" : "image"}>
              {a.path ? <span className="attachFile">{(a.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "file").slice(0, 5).toLowerCase()}</span> : <img src={a.dataUrl} alt={a.name} />}
              <span className="attachName">{a.name}</span>
              <button onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))} aria-label="remove">
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {slashMatches.length > 0 ? (
        <div className="slashMenu" role="listbox" aria-label="Commands">
          <div className="slashMenuTitle">Commands</div>
          {slashMatches.map((a, i) => (
            <button
              key={a.id}
              className="slashItem"
              role="option"
              aria-selected={i === slashSel}
              data-sel={i === slashSel ? "1" : "0"}
              onMouseEnter={() => setSlashSel(i)}
              onClick={() => runSlash(a)}
            >
              <span className="slashIcon" aria-hidden="true">{a.icon}</span>
              <span className="slashCmd">/{a.id}</span>
              <span className="slashLabel">{a.label}</span>
              <span className="slashHint">{a.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div
        className="composerRow"
        data-busy={busy ? "1" : "0"}
        data-cancelling={cancelling ? "1" : "0"}
        data-draft={text.trim() || attachments.length ? "1" : "0"}
      >
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { const list = Array.from(e.target.files ?? []); if (list.length) addFiles(list); e.target.value = ""; }} />
        <button type="button" className="attach" onClick={() => fileRef.current?.click()} title="Attach files (or paste / drop them)" aria-label="Attach files">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
        </button>
        <textarea
          ref={ref}
          value={text}
          placeholder={cancelling
            ? "Stopping current turn… your draft stays here"
            : busy
              ? `Steer ${agentName} now…`
              : `Message ${agentName}…  (paste or drop an image)`}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            setSlashSel(0);
            setSlashDismissed(false);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
          }}
          onPaste={(e) => {
            // Files of any kind (copied in the file explorer, screenshots,
            // text files) route through addFiles; plain text keeps the native
            // path so the caret and undo behave. When both come together, the
            // text is inserted too instead of being swallowed with the image.
            const items = Array.from(e.clipboardData?.items ?? []);
            const files = items.filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter((f): f is File => !!f);
            if (!files.length) return;
            e.preventDefault();
            addFiles(files);
            const plain = e.clipboardData?.getData("text/plain") ?? "";
            if (plain.trim()) setText((prev) => (prev.trim() ? prev.replace(/\s+$/, "") + " " : "") + plain.trim());
          }}
          onKeyDown={(e) => {
            if (slashMatches.length > 0) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSlashSel((s) => (s + 1) % slashMatches.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSlashSel((s) => (s - 1 + slashMatches.length) % slashMatches.length); return; }
              if (e.key === "Escape") { e.preventDefault(); setSlashDismissed(true); return; }
              if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); runSlash(slashMatches[Math.min(slashSel, slashMatches.length - 1)]); return; }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME candidate confirm, not a send
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className="mic"
          data-state={dictation.state}
          onClick={dictation.toggle}
          aria-label="dictate"
          aria-pressed={dictation.state === "recording"}
          title={dictation.state === "recording" ? "listening — pauses automatically; tap to finish early" : dictation.state === "thinking" ? "decoding speech…" : dictation.state === "error" ? "mic unavailable" : "tap once, speak, and pause"}
        >
          {dictation.state === "thinking" ? <i className="micSpin" /> : modern ? <Sigil name="voice" size={22} /> : <MicGlyph />}
        </button>
        {busy ? (
          <>
            {!cancelling && (text.trim() || attachments.length > 0) ? (
              <button className="send steer" onClick={() => void submit()} aria-label="steer" title="interrupt generation now; executing actions settle first">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3 L8 13 M3 8 L13 8" />
                </svg>
              </button>
            ) : null}
            <button
              className="send stop"
              onClick={onStop}
              aria-label={cancelling ? "force stop" : "stop"}
              title={cancelling ? "stopping — press again to force-stop a stuck turn" : "stop this turn"}
            >
              <svg viewBox="0 0 16 16" fill="currentColor">
                <rect x="4" y="4" width="8" height="8" rx="1.5" />
              </svg>
            </button>
          </>
        ) : (
          <button className="send" onClick={() => void submit()} disabled={!text.trim() && attachments.length === 0} aria-label="send">
            {modern ? (
              <Sigil name="send" size={22} />
            ) : (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 8 L14 2 L10.5 14 L8 9 Z" />
              </svg>
            )}
          </button>
        )}
      </div>
      {footer}
      {/* new-style only: a slim pulse line whose amplitude rides tokens/sec.
          Renders null in legacy mode / at rest / under reduced motion. */}
      <TokenFlowStrip busy={busy} />
    </div>
  );
});

// ─── Transcript items ──────────────────────────────────────────────────────

// Build a flame-tongue silhouette path from per-tongue tip heights. `sharp`
// pulls the control points toward the tip so tongues taper to a point (real
// flames lick to thin tips, not rounded bumps).
function flamePath(tips: number[], W: number, base: number, sharp = 0.16): string {
  const step = W / tips.length;
  let d = `M0,${base}`;
  tips.forEach((h, i) => {
    const x0 = i * step, xc = x0 + step / 2, x1 = x0 + step;
    d += ` C ${(x0 + step * 0.28).toFixed(1)},${(base - h * 0.28).toFixed(1)} ${(xc - step * sharp).toFixed(1)},${(h * 1.05).toFixed(1)} ${xc.toFixed(1)},${h.toFixed(1)}`;
    d += ` C ${(xc + step * sharp).toFixed(1)},${(h * 1.05).toFixed(1)} ${(x1 - step * 0.28).toFixed(1)},${(base - h * 0.28).toFixed(1)} ${x1.toFixed(1)},${base}`;
  });
  return d + ` L${W},${base} Z`;
}

// ─── Embedded interactive browser — Ares's OWN in-app browser ───────────────
// For Ares's self-contained HTML apps/games: renders same-origin so Ares can
// reach in and DRIVE it — a real cursor glides to controls (curved + eased),
// hovers, presses, clicks; types char-by-char; reads console; evaluates JS.
// Zero Playwright, fully in-window, the owner watches it happen.

export interface EmbeddedBrowserHandle {
  load: (html: string) => Promise<{ ok: boolean }>;
  click: (query: string) => Promise<{ ok: boolean; matched?: string; error?: string }>;
  type: (selector: string, value: string) => Promise<{ ok: boolean; error?: string }>;
  evalJs: (js: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  getConsole: (onlyErrors?: boolean) => { type: string; text: string }[];
  snapshot: () => { title: string; text: string; controls: string[] };
  /** Post a live-build piece to the page (see liveExplain). */
  post: (msg: unknown) => void;
}

const EmbeddedBrowser = React.forwardRef<EmbeddedBrowserHandle, { paceMs?: number; onActivity?: (label: string) => void }>(
  function EmbeddedBrowser({ paceMs = 460, onActivity }, ref) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const cur = useRef({ x: 200, y: 160 });
    const consoleBuf = useRef<{ type: string; text: string }[]>([]);

    const doc = () => iframeRef.current?.contentDocument ?? null;
    const win = () => iframeRef.current?.contentWindow as (Window & typeof globalThis) | null;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

    const ensureCursor = () => {
      const d = doc();
      if (!d || !d.body || d.getElementById("__ares_cur")) return;
      const c = d.createElement("div");
      c.id = "__ares_cur";
      c.style.cssText =
        "position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:filter 90ms ease;will-change:transform;filter:drop-shadow(0 2px 5px rgba(0,0,0,.55))";
      c.innerHTML =
        '<svg width="24" height="24" viewBox="0 0 26 26"><path d="M3,2 L3,20 L8,15 L11,23 L14,22 L11,14 L18,14 Z" fill="#fff" stroke="#d6402e" stroke-width="1.7" stroke-linejoin="round"/></svg>';
      d.body.appendChild(c);
      const st = d.createElement("style");
      st.textContent = "@keyframes __ar{0%{transform:translate(-50%,-50%) scale(.2);opacity:.95}100%{transform:translate(-50%,-50%) scale(2);opacity:0}}";
      d.head.appendChild(st);
    };
    const moveCur = (x: number, y: number, scale = 1) => {
      const c = doc()?.getElementById("__ares_cur");
      if (c) (c as HTMLElement).style.transform = `translate(${x - 3}px,${y - 2}px) scale(${scale})`;
    };
    const ripple = (x: number, y: number) => {
      const d = doc();
      if (!d) return;
      const r = d.createElement("div");
      r.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:34px;height:34px;border:2.5px solid #d6402e;border-radius:50%;z-index:2147483646;pointer-events:none;animation:__ar .5s ease-out forwards`;
      d.body.appendChild(r);
      setTimeout(() => r.remove(), 560);
    };

    const glide = async (tx: number, ty: number) => {
      ensureCursor();
      const sx = cur.current.x, sy = cur.current.y;
      const dx = tx - sx, dy = ty - sy, dist = Math.hypot(dx, dy);
      if (dist < 1.5) { cur.current = { x: tx, y: ty }; moveCur(tx, ty); return; }
      const bow = Math.min(dist * 0.16, 70) * (Math.random() < 0.5 ? 1 : -1);
      const mx = (sx + tx) / 2 - (dy / dist) * bow, my = (sy + ty) / 2 + (dx / dist) * bow;
      const steps = Math.max(14, Math.min(44, Math.round(dist / 9)));
      for (let i = 1; i <= steps; i++) {
        const t = easeInOut(i / steps), u = 1 - t;
        const x = u * u * sx + 2 * u * t * mx + t * t * tx;
        const y = u * u * sy + 2 * u * t * my + t * t * ty;
        moveCur(x, y);
        cur.current = { x, y };
        // fire a real hover on whatever's under the cursor (cosmetic — never let it break the action)
        try {
          const w = win();
          const el = doc()?.elementFromPoint(x, y);
          if (w && el && typeof w.MouseEvent === "function") el.dispatchEvent(new w.MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
        } catch { /* ignore hover */ }
        await sleep(paceMs / steps);
      }
      cur.current = { x: tx, y: ty };
    };

    const findEl = (query: string): HTMLElement | null => {
      const d = doc();
      if (!d) return null;
      // CSS selector first
      try { const byCss = d.querySelector(query) as HTMLElement | null; if (byCss) return byCss; } catch { /* not a selector */ }
      // visible text match on clickable-ish elements
      const cands = [...d.querySelectorAll("button,a,[role=button],input,summary,label,[onclick],.btn,td,li,span,div")] as HTMLElement[];
      const q = query.trim().toLowerCase();
      return cands.find((e) => (e.textContent ?? "").trim().toLowerCase() === q)
        ?? cands.find((e) => (e.textContent ?? "").trim().toLowerCase().includes(q))
        ?? null;
    };

    const hookConsole = () => {
      const w = win();
      if (!w || (w as unknown as { __aresHooked?: boolean }).__aresHooked) return;
      (w as unknown as { __aresHooked?: boolean }).__aresHooked = true;
      const wrap = (type: string, orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
        consoleBuf.current.push({ type, text: args.map((a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } }).join(" ").slice(0, 1500) });
        if (consoleBuf.current.length > 300) consoleBuf.current.shift();
        orig(...args);
      };
      try {
        w.console.log = wrap("log", w.console.log.bind(w.console));
        w.console.warn = wrap("warn", w.console.warn.bind(w.console));
        w.console.error = wrap("error", w.console.error.bind(w.console));
        w.addEventListener("error", (e) => consoleBuf.current.push({ type: "error", text: String((e as ErrorEvent).message) }));
      } catch { /* cross-origin — can't hook */ }
    };

    useImperativeHandle(ref, () => ({
      load: (html: string) =>
        new Promise((resolve) => {
          const f = iframeRef.current;
          if (!f) return resolve({ ok: false });
          consoleBuf.current = [];
          cur.current = { x: 200, y: 160 };
          const onLoad = () => {
            f.removeEventListener("load", onLoad);
            hookConsole();
            ensureCursor();
            resolve({ ok: true });
          };
          f.addEventListener("load", onLoad);
          f.srcdoc = html;
        }),
      post: (msg: unknown) => { iframeRef.current?.contentWindow?.postMessage({ ares: "live", piece: msg }, "*"); },
      click: async (query: string) => {
        const el = findEl(query);
        if (!el) return { ok: false, error: `no element matching "${query}"` };
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        await sleep(180);
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        onActivity?.(`Clicking ${(el.textContent ?? el.tagName).trim().slice(0, 30)}`);
        await glide(cx, cy);
        await sleep(120);
        moveCur(cx, cy, 0.8); await sleep(90); moveCur(cx, cy, 1);
        ripple(cx, cy);
        const W = win()!;
        // press feedback, then ONE real click (el.click fires the native handler) —
        // don't also dispatch a synthetic 'click' or it double-fires onclick.
        for (const t of ["mousedown", "mouseup"]) el.dispatchEvent(new W.MouseEvent(t, { bubbles: true, clientX: cx, clientY: cy }));
        if (typeof (el as HTMLElement).click === "function") (el as HTMLElement).click();
        else el.dispatchEvent(new W.MouseEvent("click", { bubbles: true, clientX: cx, clientY: cy }));
        await sleep(220);
        return { ok: true, matched: (el.textContent ?? el.tagName).trim().slice(0, 60) };
      },
      type: async (selector: string, value: string) => {
        const el = findEl(selector) as HTMLInputElement | null;
        if (!el) return { ok: false, error: `no field matching "${selector}"` };
        const r = el.getBoundingClientRect();
        await glide(r.left + r.width / 2, r.top + r.height / 2);
        el.focus();
        onActivity?.(`Typing into ${selector}`);
        const W = win()!;
        el.value = "";
        for (const chr of value) {
          el.value += chr;
          el.dispatchEvent(new W.Event("input", { bubbles: true }));
          await sleep(55);
        }
        el.dispatchEvent(new W.Event("change", { bubbles: true }));
        return { ok: true };
      },
      evalJs: async (js: string) => {
        const w = win();
        if (!w) return { ok: false, error: "no window" };
        try { return { ok: true, result: (w as unknown as { eval: (s: string) => unknown }).eval(`(()=>{return (${js})})()`) }; }
        catch (e) { try { return { ok: true, result: (w as unknown as { eval: (s: string) => unknown }).eval(`(()=>{${js}})()`) }; } catch (e2) { return { ok: false, error: String(e2 instanceof Error ? e2.message : e2) }; } }
      },
      getConsole: (onlyErrors?: boolean) => onlyErrors ? consoleBuf.current.filter((c) => c.type === "error" || c.type === "warn") : consoleBuf.current.slice(),
      snapshot: () => {
        const d = doc();
        const controls = d ? ([...d.querySelectorAll("button,a,[role=button],input,select,summary")] as HTMLElement[]).map((e) => (e.textContent ?? (e as HTMLInputElement).placeholder ?? e.tagName).trim().slice(0, 40)).filter(Boolean).slice(0, 40) : [];
        return { title: d?.title ?? "", text: (d?.body?.innerText ?? "").slice(0, 4000), controls };
      },
    }), [paceMs, onActivity]);

    return (
      <iframe
        ref={iframeRef}
        title="Ares embedded browser"
        className="embeddedBrowserFrame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock"
      />
    );
  },
);

// A layered strip of real fire: a deep-red body, an orange mid, and a white-hot
// core — each its own tongue shape, gradient, turbulence and flicker rate, so it
// reads as volumetric flame, not a glow.
function FlameStrip() {
  const W = 280, base = 22;
  // Back body: tall, broad, fewer tongues. Mid: medium. Core: short, sharp, many.
  const back = flamePath([16, 9, 19, 6, 14, 10, 18, 7, 15, 11, 17, 8], W, base, 0.24);
  const mid = flamePath([12, 6, 15, 4, 10, 8, 14, 5, 11, 7, 13, 5, 12, 9, 15, 6], W, base, 0.16);
  const core = flamePath([7, 3, 9, 2, 6, 4, 8, 3, 6, 5, 7, 3, 8, 4, 6, 3, 7, 4, 8, 3], W, base, 0.1);
  return (
    <svg viewBox={`0 0 ${W} ${base}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="flame-back" d={back} fill="url(#flameGradBack)" filter="url(#flameTurbCoarse)" />
      <path className="flame-mid" d={mid} fill="url(#flameGradMid)" filter="url(#flameTurb)" />
      <path className="flame-core" d={core} fill="url(#flameGradCore)" filter="url(#flameTurbFine)" />
    </svg>
  );
}

// The whole-UI flame border: four edge strips licking inward. Shown when working.
function ScreenFlame() {
  return (
    <div className="screenFlame" aria-hidden="true">
      <div className="fStrip edge-top"><FlameStrip /></div>
      <div className="fStrip edge-bottom"><FlameStrip /></div>
      <div className="fStrip edge-left"><FlameStrip /></div>
      <div className="fStrip edge-right"><FlameStrip /></div>
    </div>
  );
}

// ─── Hacker rain — the ULTRA working effect. When the fleet is running, the
// flame rims become Matrix-style digital rain (purple in nightfall, else green),
// raining on the edges until the turn finishes. Center is masked out via CSS.
function HackerRain({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const root = document.querySelector(".ares") ?? document.documentElement;
    const theme = root.getAttribute("data-theme");
    const color = theme === "nightfall" ? "#b9a8ff" : "#5cf08a"; // purple or matrix-green
    const fontSize = 14;
    const glyphs = "アァカサタナハマヤラ0123456789ABCDEF<>/\\|=+*#".split("");
    let w = 0, h = 0, cols = 0, drops: number[] = [], raf = 0;
    const resize = () => {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
      cols = Math.ceil(w / fontSize);
      drops = Array.from({ length: cols }, () => Math.floor(Math.random() * -60));
    };
    resize();
    window.addEventListener("resize", resize);
    const draw = () => {
      ctx.fillStyle = "rgba(6,5,8,0.10)"; // fade trail
      ctx.fillRect(0, 0, w, h);
      ctx.font = `${fontSize}px "Cascadia Code", monospace`;
      for (let i = 0; i < cols; i++) {
        const ch = glyphs[(Math.random() * glyphs.length) | 0];
        const x = i * fontSize;
        const y = drops[i] * fontSize;
        // lead glyph brighter than the trail
        ctx.fillStyle = Math.random() > 0.92 ? "#ffffff" : color;
        ctx.fillText(ch, x, y);
        if (y > h && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [active]);
  if (!active) return null;
  return <canvas ref={ref} className="hackerRain" aria-hidden="true" />;
}

const ItemView = React.memo(function ItemView({
  item,
  onConnectService,
  onDismissConnect,
  onPermission,
  onArtifact,
  onSignIn,
  toolDisplay,
}: {
  item: Item;
  onConnectService: (card: { key: string; id: string; name: string; url: string; auth: string }) => void;
  onDismissConnect: (key: string) => void;
  onPermission: (id: string, decision: string) => void;
  onArtifact: (path: string, label: string) => void;
  onSignIn?: () => void;
  toolDisplay?: "product" | "technical";
}) {
  const chatAgent = useContext(AgentChatContext);
  if (item.kind === "authPrompt") {
    return (
      <div className="authPrompt">
        <div className="authPromptMark" aria-hidden="true" />
        <div className="authPromptBody">
          <strong>Sign in to use this model</strong>
          <span>{item.text}</span>
        </div>
        <button className="primary" onClick={() => onSignIn?.()}>
          ◆ Sign in with Claude
        </button>
      </div>
    );
  }
  if (item.kind === "artifact") {
    const holo = HOLO_SPEC_FILE.test(item.path);
    return (
      <button className="artifact" onClick={() => onArtifact(item.path, item.label)}>
        <Medallion glyph={holo ? "skills" : "artifacts"} size={40} tone="ember" />
        <i aria-hidden="true" />
        <span>
          <strong>{item.label}</strong>
          <em>{holo ? "hologram spec — open on the holotable" : "artifact forged — open in the panel"}</em>
        </span>
        <span className="artifactGo">Open</span>
      </button>
    );
  }
  if (item.kind === "user") {
    // A scheduled job coming due (daemon/jobs.ts): a quiet notice, not a
    // bubble that looks like the owner typed it.
    const job = item.text ? /^\(Scheduled job "([^"]{1,80})" — ([^.]{1,80})\./.exec(item.text) : null;
    if (job) return <div className="jobNotice">⏰ Scheduled job · {job[1]} · {job[2]}</div>;
    const texted = item.text ? parseAgentText(item.text) : null;
    if (texted) {
      // Another agent texting this one: a grey bubble on the left with the
      // sender's face and name above it, like a group thread in iMessage.
      const face = agentFaceByName(texted.from);
      const sender = { id: texted.from.toLowerCase() === "ares" ? ARES_AGENT_ID : `from-${texted.from}`, name: texted.from, ...face };
      return (
        <div className="turn user agentText" style={{ ["--agent" as string]: face.color ?? "#7c5cff" }}>
          <span className="imsgFace"><AgentAvatar agent={sender} size={30} /></span>
          <div className="agentTextCol">
            <div className="agentTextHead"><b>{texted.from}</b>{texted.urgent ? <span className="urgent"> · urgent</span> : null}</div>
            <div className="bubble">
              <div className="bubbleText">{texted.body}</div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="turn user">
        <div className="bubble">
          {item.images && item.images.length > 0 ? (
            <div className="bubbleImages">
              {item.images.map((src, i) => (
                <BubbleImage key={i} src={src} alt="attachment" />
              ))}
            </div>
          ) : null}
          {item.text ? <div className="bubbleText">{item.text}</div> : null}
        </div>
      </div>
    );
  }
  if (item.kind === "steer") {
    const label = item.status === "interrupting_generation"
      ? "interrupting generation"
      : item.status === "waiting_for_action"
        ? "waiting for current action"
        : item.status === "waiting_for_boundary"
          ? "applying steer"
          : item.status === "cancelled" || item.status === "rejected"
            ? "restored to draft"
            : item.status === "applied" || item.landed
              ? "steered"
              : "sending steer";
    return (
      <div className="turn user steer" data-landed={item.landed ? "1" : "0"} data-status={item.status ?? "submitting"}>
        <div className="bubble">
          <span className="steerTag">{label}</span>
          {item.images && item.images.length > 0 ? (
            <div className="bubbleImages">
              {item.images.map((src, index) => <BubbleImage key={index} src={src} alt="steer attachment" />)}
            </div>
          ) : null}
          {item.text ? <div className="bubbleText">{item.text}</div> : null}
        </div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="turn assistant" data-streaming={item.streaming ? "1" : "0"} data-proactive={item.proactive ? "1" : "0"}>
        {/* modern skin: the agent speaks from behind the helm, struck into the
            left gutter. Hidden in Forged/Legacy like every other medallion.
            In an agent's chat it is that agent's face instead (iMessage). */}
        {chatAgent ? (
          <span className="turnMark imsgFace"><AgentAvatar agent={chatAgent} size={30} /></span>
        ) : (
          <Medallion glyph="helm" size={34} className="turnMark" />
        )}
        <div className="turnBody">
        {item.proactive ? (
          <div className="watchBadge" title="Ares noticed this on your screen — unprompted">
            <span aria-hidden="true">👁</span> watching
          </div>
        ) : null}
        {item.model ? (
          <div className="modelBadge" data-lane={item.lane ?? ""} title={`handled by ${item.model}${item.provider ? ` (${item.provider})` : ""}${item.lane ? ` · ${item.lane} lane` : ""}`}>
            <i className="glyph" data-glyph="task" /> {item.model}
            {item.provider ? <em className="providerTag">{item.provider}</em> : null}
            {item.lane ? <em>{item.lane}</em> : null}
          </div>
        ) : null}
        {item.thinking ? <ThinkingView text={item.thinking} /> : null}
        {item.text ? <RichContent text={item.text} /> : null}
        </div>
      </div>
    );
  }
  if (item.kind === "diff") return <DiffCard item={item} />;
  if (item.kind === "subagent") {
    return (
      <div className="subagent" data-status={item.status}>
        <i className="lane" />
        <div className="subagentBody">
          <strong>
            {item.name}
            <em>{item.status === "running" ? "deployed" : item.status}</em>
          </strong>
          <span>{item.description}</span>
          {item.summary ? <p>{item.summary}</p> : null}
        </div>
      </div>
    );
  }
  if (item.kind === "tools") return <ToolGroup item={item} technical={toolDisplay === "technical"} />;
  if (item.kind === "usage") {
    // A turn is many calls and every call re-reads the whole conversation, so the SUM of input tokens (1.9M, 600k...)
    // is a big scary number that means nothing about cost or size. Lead with what a person can read: how long, how many
    // calls, how much the model wrote, and how big the conversation is per call. Totals live in the tooltip.
    const freshInput = Math.max(0, item.input - item.cacheRead);
    const calls = Math.max(1, item.modelCalls);
    const perCall = Math.round(item.input / calls);
    const cachedPct = item.input > 0 ? Math.min(100, Math.round((item.cacheRead / item.input) * 100)) : 0;
    const why = `Each call re-reads the conversation so far. ${calls} call${calls === 1 ? "" : "s"} x ~${fmtTokens(perCall)} = ${fmtTokens(item.input)} tokens read` +
      `${item.cacheRead > 0 ? `, ${cachedPct}% of it served from cache (cheap)` : ""}. New input this turn: ${fmtTokens(freshInput)}. Written by the model: ${fmtTokens(item.output)}.`;
    return (
      <div className="usage" data-status={item.status} title={why}>
        {item.status !== "completed" ? `${item.status} · ` : ""}
        {fmtMs(item.durationMs)} · {calls} call{calls === 1 ? "" : "s"} · {fmtTokens(perCall)} context · ↓{fmtTokens(item.output)} written
        {item.cacheRead > 0 && cachedPct >= 50 ? ` · ${cachedPct}% cached` : ""}
        {item.model ? <span className="usageModelTag">{item.model}{item.provider ? ` (${item.provider})` : ""}{item.lane ? ` · ${item.lane}` : ""}</span> : null}
      </div>
    );
  }
  if (item.kind === "permission" && item.toolName === "CodingBackend:offer") {
    // The delegation choice popup: Ares asks whether to hand the job to an
    // external coder or do it itself. Claude Code = allow, Ares = deny; Codex
    // is gated until the gateway speaks the OpenAI wire.
    return (
      <div className="cbOffer" data-decided={item.decided ? "1" : "0"} aria-busy={item.submitting ? "true" : undefined}>
        <div className="cbOfferHead">
          <span className="cbOfferSpark" aria-hidden="true">🐉</span>
          <strong>How should I build this?</strong>
        </div>
        <span className="cbOfferReason">{item.reason || "Delegate this, or do it myself?"}</span>
        {item.decided ? (
          <em className="gateDecided">{item.decided === "deny" ? "Ares is handling it" : "delegated ⚡"}</em>
        ) : (
          <>
            {item.submitting ? <em className="gateDecided">sending {item.submitting.replace(/_/gu, " ")}…</em> : null}
            <div className="cbOfferActions">
              <button className="cbOfferPick cbOfferClaude" disabled={!!item.submitting} onClick={() => onPermission(item.id, "allow_once")}>
                <span className="cbOfferGlyph">✳</span><span>Use Claude Code</span><small>on your Ares account</small>
              </button>
              <button className="cbOfferPick cbOfferCodex" disabled title="Coming soon — needs the gateway's OpenAI-compatible route">
                <span className="cbOfferGlyph">◆</span><span>Codex</span><small>soon</small>
              </button>
              <button className="cbOfferPick cbOfferSelf" disabled={!!item.submitting} onClick={() => onPermission(item.id, "deny")}>
                <span className="cbOfferGlyph">🐉</span><span>Ares does it</span><small>in-house</small>
              </button>
            </div>
          </>
        )}
      </div>
    );
  }
  if (item.kind === "permission" && item.toolName === "ExitPlanMode") {
    const plan = item.input && typeof item.input === "object" && !Array.isArray(item.input)
      ? String((item.input as { plan?: unknown }).plan ?? "")
      : "";
    const approved = item.decided === "allow_once" || item.decided === "allow_always";
    return (
      <div className="gate planHandoff" data-decided={item.decided ? "1" : "0"} data-approved={approved ? "1" : "0"} aria-busy={item.submitting ? "true" : undefined}>
        <div className="gateTop">
          <Medallion glyph="forge" size={34} tone="ember" />
          <div className="gateBody">
            <strong>Ready to build?</strong>
            <span className="gateReason">Approve the exact plan handoff to unlock execution</span>
          </div>
          {item.decided
            ? <em className="gateDecided">{approved ? "BUILD MODE" : "KEEP PLANNING"}</em>
            : item.submitting
              ? <em className="gateDecided">sending {item.submitting.replace(/_/gu, " ")}…</em>
              : null}
        </div>
        <p className="planHandoffReason">Planning stays read-only until you choose Build this plan.</p>
        {plan ? <details className="planHandoffBody"><summary>Review exact plan</summary><pre>{plan}</pre></details> : null}
        {item.decided ? null : (
          <div className="gateActions">
            <button className="gateAllow" disabled={!!item.submitting} onClick={() => onPermission(item.id, "allow_once")}>Build this plan</button>
            <button className="gateDeny" disabled={!!item.submitting} onClick={() => onPermission(item.id, "deny")}>Keep planning</button>
          </div>
        )}
      </div>
    );
  }
  if (item.kind === "connect") {
    const done = item.state === "connected";
    return (
      <div className="connectCard" data-state={item.state ?? "idle"} data-why={item.why}>
        <div className="connectTop">
          <Medallion glyph="shield" size={34} tone="ember" />
          <div className="connectBody">
            <strong>{done ? `${item.name} connected` : item.why === "expired" ? `${item.name} needs to be connected again` : `Connect ${item.name}?`}</strong>
            <span>
              {done
                ? "Its tools are ready — send your request again."
                : item.why === "expired"
                  ? "Its authorization expired or was revoked. One click signs you back in."
                  : item.reason || (item.auth === "key" ? `Ares can work through ${item.name} with an API key.` : `Ares can work through ${item.name}. You sign in with ${item.name} itself — no keys to paste.`)}
              {item.state === "failed" && item.error ? ` — ${item.error}` : ""}
            </span>
          </div>
        </div>
        {done ? null : (
          <div className="connectActions">
            <button className="btn primary" disabled={item.state === "connecting"} onClick={() => onConnectService(item)}>
              {item.state === "connecting" ? "Waiting for sign-in…" : item.auth === "key" ? `Add ${item.name} key` : `Connect ${item.name}`}
            </button>
            <button className="btn ghost" onClick={() => onDismissConnect(item.key)}>Not now</button>
          </div>
        )}
      </div>
    );
  }
  if (item.kind === "permission") {
    return (
      <div className="gate" data-decided={item.decided ? "1" : "0"} aria-busy={item.submitting ? "true" : undefined}>
        <div className="gateTop">
          <Medallion glyph="shield" size={34} tone="ember" />
          <div className="gateBody">
            <strong>Approval needed</strong>
            <span className="gateReason">{item.toolName} wants to act</span>
          </div>
          {item.decided
            ? <em className="gateDecided">{item.decided.replace(/_/gu, " ")}</em>
            : item.submitting
              ? <em className="gateDecided">sending {item.submitting.replace(/_/gu, " ")}…</em>
              : null}
        </div>
        {/* The reason carries the actual command/target. It is the thing being
            judged, so it gets the widest, most legible slot — verbatim and
            monospaced, never ellipsised the way the old single-row card did. */}
        <code className="gateTarget">{item.reason || "wants to act"}</code>
        {item.decided ? null : (
          <div className="gateActions">
            <button className="gateAllow" disabled={!!item.submitting} onClick={() => onPermission(item.id, "allow_once")}>Allow once</button>
            <button className="gateAlways" disabled={!!item.submitting} onClick={() => onPermission(item.id, "allow_always")}>Always</button>
            <button className="gateDeny" disabled={!!item.submitting} onClick={() => onPermission(item.id, "deny")}>Deny</button>
          </div>
        )}
      </div>
    );
  }
  if (item.kind === "avatarIdeas") return <AvatarIdeasCard item={item} />;
  return (
    <div className="notice" data-tone={item.tone}>
      {item.text}
    </div>
  );
});

function DiffCard({ item }: { item: Extract<Item, { kind: "diff" }> }) {
  const [open, setOpen] = useState(false);
  const stats = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const line of item.diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++;
      else if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    return { add, del };
  }, [item.diff]);
  const names = item.files.map((f) => f.split(/[\\/]/).pop() ?? f);
  return (
    <div className="diffCard" data-open={open ? "1" : "0"}>
      <button className="diffHead" onClick={() => setOpen(!open)}>
        <i className="caret" data-open={open ? "1" : "0"} />
        <span className="diffFiles">{names.slice(0, 3).join(", ")}{names.length > 3 ? ` +${names.length - 3}` : ""}</span>
        <span className="diffStat add">+{stats.add}</span>
        <span className="diffStat del">−{stats.del}</span>
      </button>
      {open ? (
        <pre className="diffBody">
          {item.diff.split("\n").map((line, i) => (
            <span
              key={i}
              data-kind={
                line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")
                  ? "meta"
                  : line.startsWith("@@")
                    ? "hunk"
                    : line.startsWith("+")
                      ? "add"
                      : line.startsWith("-")
                        ? "del"
                        : "ctx"
              }
            >
              {line}
              {"\n"}
            </span>
          ))}
          {item.truncated ? <span data-kind="meta">… diff truncated</span> : null}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * Background jobs, where you can actually see them.
 *
 * This panel exists because a background job used to be completely invisible.
 * Ares could start a dev server or a watcher, the turn would end, and the only
 * evidence anything was still running was the machine getting slower — or, in
 * one case, a game relaunching itself every few minutes for days. Task Manager
 * was the UI. Now: what's running, what it is, and one click to stop it.
 *
 * A suspended job (the app closed, or you pressed Stop) shows its offer to
 * resume. It never resumes on its own — that is the point.
 */
function BackgroundPanel({
  jobs,
  onStop,
  onResume,
}: {
  jobs: BackgroundJobVm[];
  onStop: (id: string) => void;
  onResume: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const running = jobs.filter((j) => j.status === "running");
  const resumable = jobs.filter((j) => j.resumable);
  // Finished jobs are history, not something to act on — only surface work that
  // is live or waiting on a decision.
  const shown = [...running, ...resumable];
  if (shown.length === 0) return null;
  return (
    <div className="bgPanel" data-open={open ? "1" : "0"}>
      <button className="bgHead" onClick={() => setOpen(!open)}>
        <i className="bgDot" data-running={running.length ? "1" : "0"} aria-hidden="true" />
        <span className="bgTitle">Background</span>
        <span className="bgCount">
          {running.length ? `${running.length} running` : ""}
          {running.length && resumable.length ? " · " : ""}
          {resumable.length ? `${resumable.length} paused` : ""}
        </span>
        <span className="bgChevron" aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <ul>
          {shown.map((job) => (
            <li key={job.id} data-status={job.status} data-suspended={job.suspended ? "1" : "0"}>
              <span className="bgDesc" title={job.command}>{job.description || job.command}</span>
              <span className="bgState">
                {job.suspended ? (/previous ares/i.test(job.stoppedReason ?? "") ? "from last session" : job.stoppedReason || "paused") : "running"}
              </span>
              {job.status === "running" ? (
                <button className="bgAct" onClick={() => onStop(job.id)}>Stop</button>
              ) : job.resumable ? (
                <button className="bgAct" onClick={() => onResume(job.id)}>Resume</button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TodoPanel({ todos }: { todos: SessionVm["todos"] }) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress");
  return (
    <div className="todoPanel" data-open={open ? "1" : "0"}>
      <button className="todoHead" onClick={() => setOpen(!open)}>
        <span className="todoTitle">PLAN</span>
        <span className="todoProgress">
          <i style={{ width: `${todos.length ? Math.round((done / todos.length) * 100) : 0}%` }} />
        </span>
        <span className="todoCount">
          {done}/{todos.length}
        </span>
        {!open && current ? <span className="todoCurrent">{current.activeForm || current.content}</span> : null}
      </button>
      {open ? (
        <ul>
          {todos.map((t) => (
            <li key={t.id} data-status={t.status}>
              <i />
              <span>{t.status === "in_progress" ? t.activeForm || t.content : t.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The rich assistant body — prose with tables, plus live mermaid diagrams and
 *  charts rendered as real visuals (no HTML file needed). */
const RichContent = React.memo(function RichContent({ text }: { text: string }) {
  const segments = useMemo(() => splitRich(text), [text]);
  return (
    <div className="prose">
      {segments.map((seg, i) => {
        if (seg.kind === "prose") return <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.content) }} />;
        if (seg.kind === "code")
          return (
            <pre key={i}>
              {seg.lang ? <span className="codeLang">{seg.lang}</span> : null}
              <code>{seg.content}</code>
            </pre>
          );
        if (seg.kind === "mermaid") return <MermaidDiagram key={i} code={seg.content} complete={seg.complete} />;
        return <ChartBlock key={i} spec={seg.content} complete={seg.complete} />;
      })}
    </div>
  );
});

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  // Just resolve the module — initialization happens per-render so diagrams
  // pick up the live war-band tokens (and re-tint when the theme changes).
  mermaidReady ??= import("mermaid").then((m) => m.default);
  return mermaidReady;
}

/** Read the active theme's tokens off the shell so the diagram matches the room. */
function mermaidThemeVars() {
  const el = document.querySelector(".ares") ?? document.documentElement;
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const accent = v("--accent", "#d6402e");
  return {
    background: "transparent",
    primaryColor: v("--panel-2", "#1e1213"),
    primaryBorderColor: accent,
    primaryTextColor: v("--text", "#f0e3da"),
    lineColor: accent,
    secondaryColor: v("--panel", "#160d0e"),
    tertiaryColor: v("--bg-raised", "#120c0d"),
    fontFamily: "Cascadia Code, ui-monospace, monospace",
    fontSize: "13px",
  };
}

let mermaidSeq = 0;
function MermaidDiagram({ code, complete }: { code: string; complete: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState(false);
  // Re-tint when the war-band changes — App dispatches "ares-theme" on switch.
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const bump = () => setThemeTick((n) => n + 1);
    window.addEventListener("ares-theme", bump);
    return () => window.removeEventListener("ares-theme", bump);
  }, []);
  useEffect(() => {
    if (!complete || !code.trim()) return;
    let alive = true;
    void loadMermaid().then(async (mermaid) => {
      try {
        // Re-initialize with the live theme tokens right before rendering so the
        // diagram always matches the active war-band.
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: mermaidThemeVars() });
        const { svg } = await mermaid.render(`aresmmd${++mermaidSeq}`, code.trim());
        if (alive && ref.current) {
          ref.current.innerHTML = svg;
          setErr(false);
        }
      } catch {
        if (alive) setErr(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [code, complete, themeTick]);
  if (!complete) return <div className="mermaidBlock building">◆ diagram building…</div>;
  if (err)
    return (
      <pre className="mermaidFallback">
        <span className="codeLang">mermaid</span>
        <code>{code}</code>
      </pre>
    );
  return <div className="mermaidBlock" ref={ref} />;
}

interface ChartDatum {
  label: string;
  value: number;
}
/** A ```chart block — either JSON [{label,value}] or "label: value" lines. */
function ChartBlock({ spec, complete }: { spec: string; complete: boolean }) {
  const data = useMemo<ChartDatum[]>(() => {
    if (!complete) return [];
    const trimmed = spec.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((d) => ({ label: String(d.label ?? d.name ?? ""), value: Number(d.value ?? d.y ?? 0) })).filter((d) => d.label);
    } catch {
      /* not JSON — try line format */
    }
    return trimmed
      .split("\n")
      .map((line) => {
        const m = line.match(/^\s*(.+?)\s*[:|]\s*(-?[\d.]+)/);
        return m ? { label: m[1].trim(), value: Number(m[2]) } : null;
      })
      .filter((d): d is ChartDatum => d !== null && Number.isFinite(d.value));
  }, [spec, complete]);
  if (!complete) return <div className="mermaidBlock building">◆ chart building…</div>;
  if (data.length === 0)
    return (
      <pre className="mermaidFallback">
        <span className="codeLang">chart</span>
        <code>{spec}</code>
      </pre>
    );
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  return (
    <div className="chartBlock">
      {data.map((d, i) => (
        <div key={i} className="chartRow">
          <span className="chartLabel">{d.label}</span>
          <span className="chartTrack">
            <span className="chartFill" style={{ width: `${(Math.abs(d.value) / max) * 100}%` }} />
          </span>
          <span className="chartVal">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

// The thought card. Streams visibly (shimmering label + growing preview while
// deltas arrive), springs open/closed like the tool cards, and keeps the text
// in a real div so it stays selectable (the old version was one big <button>).
function ThinkingView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const newStyle = useNewStyle();
  // "Live" = the text grew within the last moment. No session state needed —
  // the stream itself is the signal.
  const [live, setLive] = useState(false);
  const lastLen = useRef(text.length);
  useEffect(() => {
    if (text.length === lastLen.current) return;
    lastLen.current = text.length;
    setLive(true);
    const t = window.setTimeout(() => setLive(false), 1500);
    return () => window.clearTimeout(t);
  }, [text]);
  const words = text.split(/\s+/).filter(Boolean).length;
  const body = (
    <>
      <button className="thinkHead" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="thinkSigil" aria-hidden="true" />
        <span className="thinkLabel">{live ? "thinking" : "thought"}</span>
        {live ? <span className="thinkEllipsis" aria-hidden="true"><i /><i /><i /></span> : null}
        <span className="thinkMeta">{words.toLocaleString()} word{words === 1 ? "" : "s"}</span>
        <span className="thinkChevron" data-open={open ? "1" : "0"} aria-hidden="true">▾</span>
      </button>
      {/* A live thought renders in FULL and is windowed by CSS. It used to
          render liveTail(text, 150) — the last 150 characters, whitespace
          flattened — which meant every streamed chunk slid the window and
          shifted every visible character left: the text rewrote itself instead
          of growing, and the 2-line clamp then cut whatever survived. Keeping
          the whole string here lets the VIEWPORT move instead of the text. */}
      <div className="thinkText" data-open={open ? "1" : "0"} data-live={live ? "1" : "0"}>
        {open || live ? text : compact(text, 220)}
      </div>
    </>
  );
  return newStyle ? (
    <SpringHeight className="thinking" attrs={{ "data-open": open ? "1" : "0", "data-live": live ? "1" : "0" }}>
      {body}
    </SpringHeight>
  ) : (
    <div className="thinking" data-open={open ? "1" : "0"} data-live={live ? "1" : "0"}>
      {body}
    </div>
  );
}

// A SINGLE tool card that MORPHS as the agent works: one icon slot crossfades
// through each tool (Read→Edit→Run…), the title rewrites to the live action, and
// when the batch finishes it collapses to "N tools attempted · …". The full
// per-step breakdown stays one click away. One reused card, not a stack.
function ToolGroup({ item, technical }: { item: Extract<Item, { kind: "tools" }>; technical?: boolean }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const newStyle = useNewStyle();
  const running = item.steps.some((s) => s.status === "running" || s.status === "drafting");
  const failed = item.steps.some((s) => s.status === "error");
  const wallElapsed = item.finishedAt === undefined ? 0 : Math.max(0, item.finishedAt - item.startedAt);
  const slowestStep = item.steps.reduce((n, s) => Math.max(n, s.durationMs ?? 0), 0);
  const elapsed = wallElapsed > 0 ? wallElapsed : slowestStep;
  const runningSteps = item.steps.filter((s) => s.status === "running" || s.status === "drafting");
  const doneCount = item.steps.filter((s) => s.status === "ok").length;
  const failedCount = item.steps.filter((s) => s.status === "error").length;
  const total = item.steps.length;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [running]);
  // The step the card is currently "wearing": the first live one, else the last.
  const current = runningSteps[0] ?? item.steps[item.steps.length - 1];
  const activeGlyph = toolGlyph(current?.name ?? "");

  const title = running ? current?.label ?? "working…" : `${total} tool${total === 1 ? "" : "s"} attempted`;
  const subline = running
    ? `${doneCount}/${total} done · ${fmtMs(Math.max(0, now - item.startedAt))}${runningSteps.length > 1 ? ` · ${runningSteps.length} running` : ""}`
    : `${summarizeSteps(item.steps)}${failed ? ` · ${failedCount} failed` : ""} · ${fmtMs(elapsed)}`;

  // New style: a finished card COLLAPSES to a compact ✓ line (height-spring via
  // SpringHeight); clicking it re-expands the full breakdown. Legacy keeps the
  // classic always-full card — `compactDone` is impossible there.
  const compactDone = newStyle && !running && !open;

  const inner = compactDone ? (
    <button className="toolDoneLine" data-failed={failed ? "1" : "0"} onClick={() => setOpen(true)} title="show the full tool breakdown">
      <i className="doneMark" aria-hidden="true">{failed ? "✕" : "✓"}</i>
      <span className="doneSummary">
        {total} tool{total === 1 ? "" : "s"} · {summarizeSteps(item.steps)}
        {failed ? ` · ${failedCount} failed` : ""}
      </span>
      <em className="doneTime">{fmtMs(elapsed)}</em>
    </button>
  ) : (
    <>
      <button className="toolCardHead" onClick={() => setOpen(!open)}>
        <span className="toolCardIcon">
          {/* keyed so the glyph re-animates (morphs) each time the active tool changes */}
          <i className="glyph morphGlyph" key={`${activeGlyph}-${running ? current?.id : "done"}`} data-glyph={activeGlyph} data-status={running ? current?.status : failed ? "error" : "ok"} />
        </span>
        <span className="toolCardBody">
          <span className="toolCardTitle" key={title}>{title}</span>
          <span className="toolCardSub">{subline}</span>
        </span>
        <span className="toolCardTrail">
          {item.steps.slice(-14).map((s) => <i key={s.id} className="glyph mini" data-glyph={toolGlyph(s.name)} data-status={s.status} />)}
        </span>
        <i className="caret" data-open={open ? "1" : "0"} />
      </button>
      {running ? <div className="toolProgressRail" aria-hidden="true"><i style={{ width: `${Math.max(5, (doneCount / Math.max(total, 1)) * 100)}%` }} /></div> : null}
      {running && current?.liveTail && !open ? (
        <pre className="stepLiveTail cardTail">{current.liveTail.split("\n").slice(-10).join("\n")}</pre>
      ) : null}
      {open ? (
        <div className="toolBody">
          {item.steps.map((s) => (
            <ToolStepRow key={s.id} step={s} technical={technical} />
          ))}
        </div>
      ) : null}
    </>
  );

  const state = failed ? "error" : running ? "running" : "ok";
  if (newStyle) {
    return (
      <SpringHeight className="toolCard" attrs={{ "data-state": state, "data-open": open ? "1" : "0", "data-compact": compactDone ? "1" : "0" }}>
        {inner}
      </SpringHeight>
    );
  }
  return (
    <div className="toolCard" data-state={state} data-open={open ? "1" : "0"}>
      {inner}
    </div>
  );
}

/** Tiny glyph class per tool family — rendered as CSS-drawn icons. Derived from
 *  toolKind so the icon, the verb, and the roll-up summary never disagree. */
function toolGlyph(name: string): string {
  switch (toolKind(name)) {
    case "read": return "file";
    case "search": return "search";
    case "create": return "create";
    case "edit": return "edit";
    case "shell": return "shell";
    case "web": return "web";
    case "task": return "task";
    default: return "dot";
  }
}

function ToolStepRow({ step, technical }: { step: ToolStep; technical?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="toolStep" data-status={step.status}>
      <button onClick={() => setOpen(!open)}>
        <i className="glyph" data-glyph={toolGlyph(step.name)} />
        <span className="stepLabel">{step.label}</span>
        <span className="stepMeta">{step.status === "drafting" ? "✎…" : step.status === "running" ? "…" : step.durationMs !== undefined ? fmtMs(step.durationMs) : ""}</span>
      </button>
      {step.status === "running" && step.liveTail ? (
        <pre className="stepLiveTail">{step.liveTail.split("\n").slice(-12).join("\n")}</pre>
      ) : null}
      {open ? (
        <>
          {technical && step.inputJson ? (
            <pre className="stepIo">
              <b>input</b>
              {"\n"}
              {step.inputJson}
            </pre>
          ) : null}
          {step.detail ? (
            <pre className="stepIo">
              {technical ? <b>output{"\n"}</b> : null}
              {step.detail}
            </pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ─── Boot + Settings ───────────────────────────────────────────────────────

/** The backdrop — a war-god's command table. Layered, parallaxed, alive:
 *  a slow astrolabe of concentric rings + tick marks, the great helm at the
 *  edge of vision, crossed spears, and a drifting depth field. Pure SVG/CSS,
 *  GPU-cheap, sits behind everything at low opacity. */
function Backdrop({ pointMap }: { pointMap: PointMapSpec | null }) {
  return (
    <div className="backdrop" aria-hidden="true">
      {pointMap ? <CyberField spec={pointMap} /> : null}
      <svg className="astrolabe" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id="agrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#d6402e" stopOpacity="0.0" />
            <stop offset="72%" stopColor="#d6402e" stopOpacity="0.0" />
            <stop offset="100%" stopColor="#d6402e" stopOpacity="0.12" />
          </radialGradient>
        </defs>
        <g className="ringSlow" stroke="#d6402e" fill="none">
          <circle cx="500" cy="500" r="470" strokeOpacity="0.06" strokeWidth="1" />
          <circle cx="500" cy="500" r="470" stroke="url(#agrad)" strokeWidth="40" />
          {Array.from({ length: 72 }).map((_, i) => {
            const a = (i / 72) * Math.PI * 2;
            const long = i % 6 === 0;
            const r1 = long ? 446 : 458;
            return (
              <line
                key={i}
                x1={500 + Math.cos(a) * r1}
                y1={500 + Math.sin(a) * r1}
                x2={500 + Math.cos(a) * 470}
                y2={500 + Math.sin(a) * 470}
                strokeOpacity={long ? 0.16 : 0.08}
                strokeWidth={long ? 1.4 : 0.8}
              />
            );
          })}
        </g>
        <g className="ringMid" stroke="#d6402e" fill="none" strokeOpacity="0.09">
          <circle cx="500" cy="500" r="360" strokeWidth="1" strokeDasharray="3 9" />
          <circle cx="500" cy="500" r="300" strokeWidth="1" />
        </g>
        <g className="ringFast" stroke="#ff6a44" fill="none" strokeOpacity="0.14">
          <circle cx="500" cy="500" r="230" strokeWidth="1.2" strokeDasharray="60 30 12 30" />
        </g>
      </svg>
      <div className="helm" />
      <div className="depthField" />
    </div>
  );
}

const BOOT_LOG = [
  "Waking your agents",
  "Loading tools",
  "Opening the Forge",
  "Ready",
];

/** The launch splash (owner, 2026-10-24): light glass with the flame logo.
 *  It eases in and fades out; the old one ended in a bright bloom, which
 *  broke the photosensitive doctrine (nothing flashes). */
function Boot() {
  const [logIdx, setLogIdx] = useState(0);
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setLogIdx((i) => Math.min(i + 1, BOOT_LOG.length - 1)), 320);
    // fade out just before the parent unmounts, into the live shell
    const ex = window.setTimeout(() => setExiting(true), 1820);
    return () => { window.clearInterval(t); window.clearTimeout(ex); };
  }, []);
  return (
    <div className="boot bootGlass" data-exit={exiting ? "1" : "0"}>
      <div className="bootCore">
        <img className="bootLogo" src="/ares-logo.png" alt="" draggable={false} />
        <div className="bootWord">Ares</div>
        <div className="bootBar"><i style={{ width: `${((logIdx + 1) / BOOT_LOG.length) * 100}%` }} /></div>
        <div className="bootStatus">{BOOT_LOG[logIdx]}</div>
      </div>
    </div>
  );
}

// Ares (the owner gateway) leads; mock is dev-only and hidden from users.
const PROVIDERS = ["ares", "ollama", "openai", "anthropic", "deepseek", "kimi", "openrouter", "custom", "moa"];


// Known OpenAI-compatible providers — click one and the base URL fills itself
// so nobody has to hunt for it. keyUrl points at where to mint a key.
interface ProviderPreset {
  id: string;
  label: string;
  base: string;
  keyUrl?: string;
  keyHint?: string;
  sample?: string;
  keyless?: boolean;
}
const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "google", label: "Google AI Studio", base: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/app/apikey", keyHint: "AIza… key — set it to unrestricted", sample: "gemini-2.5-flash" },
  { id: "nvidia", label: "NVIDIA NIM", base: "https://integrate.api.nvidia.com/v1", keyUrl: "https://build.nvidia.com", keyHint: "nvapi-… key", sample: "meta/llama-3.1-70b-instruct" },
  { id: "groq", label: "Groq", base: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys", keyHint: "gsk_… key", sample: "llama-3.3-70b-versatile" },
  { id: "xai", label: "xAI (Grok)", base: "https://api.x.ai/v1", keyUrl: "https://console.x.ai", keyHint: "xai-… key", sample: "grok-4" },
  { id: "together", label: "Together", base: "https://api.together.xyz/v1", keyUrl: "https://api.together.ai/settings/api-keys", sample: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { id: "fireworks", label: "Fireworks", base: "https://api.fireworks.ai/inference/v1", keyUrl: "https://fireworks.ai/account/api-keys", sample: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
  { id: "mistral", label: "Mistral", base: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys", sample: "mistral-large-latest" },
  { id: "deepinfra", label: "DeepInfra", base: "https://api.deepinfra.com/v1/openai", keyUrl: "https://deepinfra.com/dash/api_keys", sample: "meta-llama/Llama-3.3-70B-Instruct" },
  { id: "cerebras", label: "Cerebras", base: "https://api.cerebras.ai/v1", keyUrl: "https://cloud.cerebras.ai", sample: "llama-3.3-70b" },
  { id: "perplexity", label: "Perplexity", base: "https://api.perplexity.ai", keyUrl: "https://www.perplexity.ai/settings/api", sample: "sonar-pro" },
  { id: "openai", label: "OpenAI", base: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys", keyHint: "sk-… key", sample: "gpt-5.5" },
  { id: "lmstudio", label: "LM Studio (local)", base: "http://localhost:1234/v1", keyless: true, keyHint: "no key needed", sample: "" },
  { id: "vllm", label: "vLLM (local)", base: "http://localhost:8000/v1", keyless: true, keyHint: "no key needed", sample: "" },
];

function CustomProviderBlock({
  onDaemonCommand,
  native,
}: {
  onDaemonCommand: (cmd: Record<string, unknown>) => void;
  native: boolean;
}) {
  const [base, setBase] = useState<string>(() => {
    try { return window.localStorage.getItem(CUSTOM_BASE_LS) ?? ""; } catch { return ""; }
  });
  const [key, setKey] = useState<string>("");
  const [models, setModels] = useState<string[]>(() => readCustomModels());
  const [model, setModel] = useState<string>(() => {
    try { return window.localStorage.getItem(CUSTOM_MODEL_LS) ?? ""; } catch { return ""; }
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [presetId, setPresetId] = useState<string>("");
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);

  const applyModels = useCallback((ids: string[]) => {
    setModels(ids);
    setModel((cur) => (!cur || !ids.includes(cur) ? ids[0] : cur));
    try { window.localStorage.setItem(CUSTOM_MODELS_LS, JSON.stringify(ids)); } catch { /* ignore */ }
    setOk(true);
    setMsg(`Found ${ids.length} model${ids.length === 1 ? "" : "s"}.`);
  }, []);

  const discover = useCallback(async () => {
    const root = base.trim().replace(/\/+$/, "");
    if (!root) { setOk(false); setMsg("Pick a provider above, or enter a base URL — e.g. https://api.together.xyz/v1"); return; }
    setBusy(true); setOk(null); setMsg("Discovering models…");

    // Preferred path: ask the daemon to fetch server-side (Node, no CORS) so
    // hosts that block browser requests (NVIDIA, Google, most) still work.
    if (native) {
      const done = await new Promise<boolean>((resolve) => {
        const onResult = (ev: Event) => {
          const d = (ev as CustomEvent<{ ok?: boolean; models?: string[]; error?: string }>).detail;
          window.removeEventListener("ares:custom-models", onResult);
          window.clearTimeout(timer);
          if (d?.ok && Array.isArray(d.models) && d.models.length) {
            applyModels(d.models);
          } else {
            setOk(false);
            setMsg(d?.error ? String(d.error) : "no models returned. You can still type a model id by hand below.");
          }
          resolve(true);
        };
        const timer = window.setTimeout(() => {
          window.removeEventListener("ares:custom-models", onResult);
          resolve(false); // daemon didn't answer — fall through to the browser attempt
        }, 12000);
        window.addEventListener("ares:custom-models", onResult);
        onDaemonCommand({ type: "discover_custom_models", base: root, key: key.trim() });
      });
      if (done) { setBusy(false); return; }
    }

    // Fallback: direct browser fetch (works for CORS-friendly / local endpoints).
    try {
      const res = await fetch(`${root}/models`, {
        headers: key.trim() ? { Authorization: `Bearer ${key.trim()}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: unknown[]; models?: unknown[] };
      const list = (body.data ?? body.models ?? []) as Array<string | { id?: string }>;
      const ids = list
        .map((m) => (typeof m === "string" ? m : m?.id))
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .sort((a, b) => a.localeCompare(b));
      if (!ids.length) throw new Error("the endpoint returned no models");
      applyModels(ids);
    } catch (err) {
      setOk(false);
      setMsg(
        `Couldn't reach ${root}/models — ${err instanceof Error ? err.message : String(err)}. ` +
        `Make sure the key is valid and unrestricted, or just type a model id by hand below.`,
      );
    } finally {
      setBusy(false);
    }
  }, [base, key, native, onDaemonCommand, applyModels]);

  const choosePreset = useCallback((p: ProviderPreset) => {
    setPresetId(p.id);
    setBase(p.base);
    setModels([]);
    setModel(p.sample ?? "");
    setOk(null);
    setMsg(p.keyless ? "No key needed — click Discover (make sure the local server is running)." : `Paste your ${p.label} key, then Discover.`);
  }, []);

  const save = useCallback(() => {
    const root = base.trim().replace(/\/+$/, "");
    const chosen = model.trim();
    try {
      window.localStorage.setItem(CUSTOM_BASE_LS, root);
      window.localStorage.setItem(CUSTOM_MODEL_LS, chosen);
    } catch { /* ignore */ }
    onDaemonCommand({ type: "provider_key", provider: "custom", key: key.trim(), baseUrl: root, model: chosen });
    setOk(true);
    setMsg("Saved. Pick “custom” as your provider to use it.");
  }, [base, key, model, onDaemonCommand]);

  return (
    <div className="customProv">
      <div className="keyGroupLabel">Custom provider · OpenAI-compatible</div>
      <p className="keyHint" style={{ margin: "0 0 8px" }}>
        Pick a provider below and the base URL fills itself — just paste your key and Discover. Or point Ares at
        any OpenAI-compatible endpoint by hand. Discovery runs through Ares (not the browser), so hosts that block
        browser requests still work.
      </p>
      <div className="presetGallery">
        {PROVIDER_PRESETS.map((p) => (
          <button
            key={p.id}
            className="presetChip"
            data-on={presetId === p.id ? "1" : "0"}
            onClick={() => choosePreset(p)}
            title={p.base}
          >
            {p.label}
          </button>
        ))}
      </div>
      {preset ? (
        <p className="keyHint presetHint">
          {preset.keyHint ? <span>{preset.keyHint}</span> : null}
          {preset.keyUrl ? (
            <>
              {preset.keyHint ? " · " : null}
              <a href="#" onClick={(e) => { e.preventDefault(); if (native) void invoke("ares_open_url", { url: preset.keyUrl }).catch(() => null); }}>
                get a key ↗
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      <input
        className="keyInput"
        placeholder="Base URL — e.g. https://api.together.xyz/v1"
        value={base}
        onChange={(e) => { setBase(e.target.value); setPresetId(""); }}
      />
      <input
        className="keyInput"
        type="password"
        placeholder="API key (leave blank for keyless local endpoints)"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <div className="customProvRow">
        <button className="provChip" disabled={busy || !base.trim()} onClick={() => void discover()}>
          {busy ? "Discovering…" : "Discover models"}
        </button>
        {models.length ? (
          <select className="customProvModel" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input
            className="keyInput customProvModelText"
            placeholder="…or type a model id"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        )}
        <button className="primary" disabled={!base.trim() || !model.trim()} onClick={save}>Save</button>
      </div>
      {msg ? <p className="keyHint" data-ok={ok === null ? "" : ok ? "1" : "0"}>{msg}</p> : null}
    </div>
  );
}
/** Providers that take a pasted API key (the rest use OAuth / local daemon / nothing). */
const KEYED_PROVIDERS: Array<{ id: string; brand: string; label: string; sub: string; placeholder: string }> = [
  { id: "anthropic", brand: "anthropic", label: "Anthropic", sub: "Claude models via API", placeholder: "sk-ant-…" },
  { id: "deepseek", brand: "deepseek", label: "DeepSeek", sub: "official api.deepseek.com", placeholder: "sk-…" },
  { id: "kimi", brand: "moonshot", label: "Kimi", sub: "api.kimi.com coding endpoint", placeholder: "sk-…" },
  { id: "openrouter", brand: "openrouter", label: "OpenRouter", sub: "hundreds of models, one key", placeholder: "sk-or-…" },
  { id: "ollama", brand: "ollama", label: "Ollama Cloud", sub: "cloud catalog + inference", placeholder: "ollama.com API key" },
];

// A small brand glyph per model so the picker reads like a gallery, not a
// wall of ids. Keyed off the catalog group first, then the id prefix that
// OpenRouter-style ids carry ("openai/…", "anthropic/…").
// Map a model (by group + id prefix) to a brand key for its logo. Covers both
// the native providers and the model FAMILY (id prefix) for OpenRouter's mixed
// catalog, so a "google/gemini-…" row shows Google's mark, not OpenRouter's.
function brandKey(m: { id: string; group?: string }): string {
  const id = m.id.toLowerCase();
  const prefix = id.split("/")[0] ?? "";
  const byPrefix: Record<string, string> = {
    openai: "openai", "o1": "openai", "o3": "openai", "gpt": "openai",
    anthropic: "anthropic", claude: "anthropic",
    google: "google", "gemini": "google", "gemma": "google",
    "meta-llama": "meta", meta: "meta", llama: "meta",
    mistralai: "mistral", mistral: "mistral", ministral: "mistral",
    deepseek: "deepseek", qwen: "qwen", qwq: "qwen", "x-ai": "xai", grok: "xai",
    cohere: "cohere", "command": "cohere", nvidia: "nvidia", microsoft: "microsoft",
    perplexity: "perplexity", "z-ai": "zai", moonshotai: "moonshot", moonshot: "moonshot",
  };
  if (byPrefix[prefix]) return byPrefix[prefix];
  const bare = id.split("/").pop() ?? id;
  for (const [k, v] of Object.entries(byPrefix)) if (bare.startsWith(k)) return v;
  const g = (m.group ?? "").toLowerCase();
  if (g.includes("ares")) return "ares";
  if (g.includes("anthropic")) return "anthropic";
  if (g.includes("openai")) return "openai";
  if (g.includes("deepseek")) return "deepseek";
  if (g.includes("ollama") || g.includes("library")) return "ollama";
  if (g.includes("openrouter")) return "openrouter";
  if (g.includes("mixture") || g.includes("moa")) return "moa";
  if (g.includes("custom")) return "custom";
  if (g.includes("mock") || g.includes("demo")) return "mock";
  return "generic";
}

// Original geometric brand marks — functional provider identifiers rendered as
// self-contained rounded tiles (bg + mark), so they read as real app icons
// instead of emoji. Not tracings of trademarked artwork; simple vector forms
// in each brand's signature color.
const BRAND_LOGOS: Record<string, { bg: string; fg: string; body: React.ReactNode }> = {
  ares: { bg: "#3a0f0f", fg: "#f0b046", body: <path d="M12 4l6 14h-3l-1-3h-4l-1 3H5z m0 5l-1.2 3h2.4z" /> },
  openai: { bg: "#0d1f1a", fg: "#10a37f", body: <path d="M12 5a4 4 0 0 1 3.9 3.1 4 4 0 0 1 .1 7.8A4 4 0 0 1 8.1 15 4 4 0 0 1 8 7.2 4 4 0 0 1 12 5m0 2.2a2.2 2.2 0 0 0-2.2 2.2v5.2a2.2 2.2 0 1 0 4.4 0V9.4A2.2 2.2 0 0 0 12 7.2" /> },
  anthropic: { bg: "#2b1a12", fg: "#d97757", body: <path d="M9.2 5h2.2l4.4 14h-2.4l-.9-3H8.6l-.9 3H5.3zM9.3 14h3.1L10.9 8.8z" /> },
  ollama: { bg: "#101a1c", fg: "#c9d6d3", body: <path d="M8 6c1 0 1.6.9 1.6 2.2 0 .5-.1 1-.3 1.4h5.4c-.2-.4-.3-.9-.3-1.4C14.4 6.9 15 6 16 6s1.7 1.1 1.7 2.7c0 1-.3 1.9-.8 2.5.6.7 1 1.7 1 2.8 0 2.5-2.2 4-5.9 4s-5.9-1.5-5.9-4c0-1.1.4-2.1 1-2.8-.5-.6-.8-1.5-.8-2.5C6.3 7.1 7 6 8 6m2.2 8.2a1 1 0 1 0 0 .1zm3.6 0a1 1 0 1 0 0 .1z" /> },
  deepseek: { bg: "#101a33", fg: "#4d6bfe", body: <path d="M18 7c-1.5 2.3-3.4 2.2-5.3 2.5-2.6.4-4 1.6-4.4 3.9-.3-1-1-1.6-2-1.9 1 .9 1.1 2.4.3 3.6C7.9 16 10 17 12.4 17c3.4 0 5.8-2.4 5.8-6 0-1.5-.3-2.9-.2-4z" /> },
  openrouter: { bg: "#1e1630", fg: "#9d7bea", body: <path d="M4 12h3.5M16.5 8.5 20 12l-3.5 3.5M7.5 12c1.8 0 2.2-4 4.5-4h4M7.5 12c1.8 0 2.2 4 4.5 4h4" fill="none" stroke="#9d7bea" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> },
  google: { bg: "#12151c", fg: "#4285f4", body: <path d="M12 4c1 3.8 3.2 6 7 7-3.8 1-6 3.2-7 7-1-3.8-3.2-6-7-7 3.8-1 6-3.2 7-7z" /> },
  meta: { bg: "#0a1830", fg: "#3b82f6", body: <path d="M4 15c1.6 0 2.6-1.4 3.8-3.4C9 9.7 9.8 8.6 11 8.6c1.4 0 2 1.8 2.6 3.6M20 15c-1.6 0-2.6-1.4-3.8-3.4C15 9.7 14.2 8.6 13 8.6c-1.4 0-2 1.8-2.6 3.6" fill="none" stroke="#3b82f6" strokeWidth="1.7" strokeLinecap="round" /> },
  mistral: { bg: "#201408", fg: "#f2a33c", body: <path d="M5 6h3v3H5zm5 0h3v3h-3zm5 0h3v3h-3zM5 11h3v3H5zm10 0h3v3h-3zM5 16h3v2H5zm5-5h3v3h-3zm0 5h3v2h-3zm5 0h3v2h-3z" /> },
  qwen: { bg: "#1c1030", fg: "#a56bf0", body: <path d="M12 4l7 4v8l-7 4-7-4V8zm0 2.3L7 9v6l5 2.7L17 15V9z" /> },
  xai: { bg: "#161616", fg: "#e8e8e8", body: <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="#e8e8e8" strokeWidth="1.8" strokeLinecap="round" /> },
  cohere: { bg: "#241416", fg: "#e06a5a", body: <path d="M9 9a3 3 0 1 0 3 3h6M9 9h4" fill="none" stroke="#e06a5a" strokeWidth="1.7" strokeLinecap="round" /> },
  nvidia: { bg: "#0f1a0a", fg: "#76b900", body: <path d="M6 9c3-1 6-1 8 0s2 4 0 6c-3-1.5-3-4.5-8-6z" /> },
  microsoft: { bg: "#101820", fg: "#3aa0ff", body: <path d="M5 5h5.5v5.5H5zm8.5 0H19v5.5h-5.5zM5 13.5h5.5V19H5zm8.5 0H19V19h-5.5z" /> },
  perplexity: { bg: "#0d1c1e", fg: "#4fd0c8", body: <path d="M12 4v16M6 8l6 4 6-4M6 16l6-4 6 4" fill="none" stroke="#4fd0c8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /> },
  zai: { bg: "#151530", fg: "#7f8bf0", body: <path d="M7 7h10l-7 10h7" fill="none" stroke="#7f8bf0" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /> },
  moonshot: { bg: "#12121c", fg: "#c9c9ff", body: <path d="M15 4a7 7 0 1 0 4 8 5.5 5.5 0 0 1-4-8z" /> },
  ares_gateway: { bg: "#3a0f0f", fg: "#f0b046", body: <path d="M12 4l6 14h-3l-1-3h-4l-1 3H5z" /> },
  moa: { bg: "#241430", fg: "#c86bd1", body: <path d="M12 5a2 2 0 1 1 0 .1zM6.5 15a2 2 0 1 1 0 .1zM17.5 15a2 2 0 1 1 0 .1zM12 5v3M12 8l-4.5 5M12 8l4.5 5" fill="none" stroke="#c86bd1" strokeWidth="1.5" strokeLinecap="round" /> },
  custom: { bg: "#1a1a1e", fg: "#9aa3ad", body: <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0-4v2m0 12v2M4 12h2m12 0h2M6 6l1.5 1.5M16.5 16.5 18 18" fill="none" stroke="#9aa3ad" strokeWidth="1.4" strokeLinecap="round" /> },
  mock: { bg: "#1a1a1e", fg: "#8a8f98", body: <path d="M8 9a1.5 1.5 0 1 1 0 .1zm8 0a1.5 1.5 0 1 1 0 .1zM8 15c1 1.2 2.4 1.8 4 1.8s3-.6 4-1.8" fill="none" stroke="#8a8f98" strokeWidth="1.4" strokeLinecap="round" /> },
  generic: { bg: "#1a1a1e", fg: "#c98a3a", body: <path d="M12 4l2.2 5.6L20 10l-4.5 3.4L17 19l-5-3-5 3 1.5-5.6L4 10l5.8-.4z" /> },
};

// The provider's OWN domain — we load its real favicon (the genuine logo it
// serves) at runtime and only fall back to the vector mark when offline / the
// image fails. Ares/MoA/custom have no external brand, so they use the mark.
const BRAND_DOMAINS: Record<string, string> = {
  openai: "openai.com", anthropic: "anthropic.com", google: "google.com",
  meta: "meta.com", mistral: "mistral.ai", deepseek: "deepseek.com",
  qwen: "qwen.ai", xai: "x.ai", cohere: "cohere.com", ollama: "ollama.com",
  openrouter: "openrouter.ai", nvidia: "nvidia.com", microsoft: "microsoft.com",
  perplexity: "perplexity.ai", zai: "z.ai", moonshot: "moonshot.ai",
};

function ProviderLogo({ brand, className }: { brand: string; className?: string }) {
  const domain = BRAND_DOMAINS[brand];
  const [failed, setFailed] = useState(false);
  const b = BRAND_LOGOS[brand] ?? BRAND_LOGOS.generic;
  if (domain && !failed) {
    // DuckDuckGo's favicon service returns the provider's real, normalized
    // logo; a clean light tile keeps dark marks visible in any theme.
    return (
      <span className={`brandLogo ${className ?? ""}`} aria-hidden="true">
        <img
          src={`https://icons.duckduckgo.com/ip3/${domain}.ico`}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <svg className={className} viewBox="0 0 24 24" role="img" aria-hidden="true">
      <rect x="0" y="0" width="24" height="24" rx="6" fill={b.bg} />
      <g fill={b.fg}>{b.body}</g>
    </svg>
  );
}

function ModelPicker({
  provider,
  value,
  onPick,
  native,
  searchOnly,
  compact,
}: {
  provider: string;
  value: string;
  onPick: (id: string) => void;
  native: boolean;
  /** Hide the free-text id input — rows are the only way to pick (hot-swap popover). */
  searchOnly?: boolean;
  /** Dense variant for routing lanes — shows the selected model + a compact list. */
  compact?: boolean;
}) {
  const { models, loading, error } = useModelCatalog(provider, native);
  const [open, setOpen] = useState(Boolean(searchOnly || compact));
  const [query, setQuery] = useState("");
  const [capability, setCapability] = useState<"all" | "tools" | "reasoning" | "vision" | "free">("all");
  const [showLibrary, setShowLibrary] = useState(false);
  // The model DETAIL page — click a card's ⓘ to open a big, readable view.
  const [detail, setDetail] = useState<ModelOption | null>(null);
  const q = query.trim().toLowerCase();
  const isLibrary = (m: ModelOption) => m.group.startsWith("Ollama Library");
  const libraryCount = models.filter(isLibrary).length;
  const visible = showLibrary || q ? models : models.filter((m) => !isLibrary(m));
  const byCapability = capability === "all" ? visible : visible.filter((model) => model.capabilities?.includes(capability));
  const filtered = q
    ? byCapability.filter((m) =>
        [m.id, m.label ?? "", m.hint ?? "", ...(m.capabilities ?? [])].join(" ").toLowerCase().includes(q),
      )
    : byCapability;
  const groups = [...new Set(filtered.map((m) => m.group))];
  const capabilityCount = (name: Exclude<typeof capability, "all">) => models.filter((m) => m.capabilities?.includes(name)).length;
  const choose = (id: string) => {
    onPick(id);
    if (!searchOnly && !compact) setOpen(false);
  };
  // Show the friendly name for the current pick when the catalog knows one
  // (e.g. "Model Ares (in house)" instead of a raw virtual id).
  const valueLabel = models.find((m) => m.id === value)?.label ?? value;

  return (
    <div className={compact ? "modelPicker compact" : "modelPicker"}>
      {compact && value ? <div className="lanePicked" title={value}>{value}</div> : null}
      {!searchOnly && !compact ? (
        <button className="modelCurrent" data-open={open ? "1" : "0"} onClick={() => setOpen((current) => !current)}>
          <span>
            <strong>{valueLabel || "Choose a model"}</strong>
            <em>{loading ? "Loading catalog..." : `${models.length} available models`}</em>
          </span>
          <i>{open ? "Close" : "Change"}</i>
        </button>
      ) : null}
      {open && !searchOnly && !compact ? (
        <input value={value} onChange={(e) => onPick(e.target.value)} spellCheck={false} placeholder="model id" />
      ) : null}
      {open ? <div className="modelSearchRow">
        <input
          className="modelSearch"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={loading ? "loading models…" : `search ${models.length} models`}
          spellCheck={false}
        />
        <span>{filtered.length}</span>
      </div> : null}
      {open ? <div className="modelFilters" aria-label="model capability filters">
        <button data-on={capability === "all" ? "1" : "0"} onClick={() => setCapability("all")}>all</button>
        {(["tools", "reasoning", "vision", "free"] as const).map((name) => {
          const count = capabilityCount(name);
          return (
            <button key={name} data-on={capability === name ? "1" : "0"} disabled={count === 0} onClick={() => setCapability(name)}>
              {name} <em>{count}</em>
            </button>
          );
        })}
        {libraryCount > 0 ? (
          <button data-on={showLibrary ? "1" : "0"} onClick={() => setShowLibrary((v) => !v)} title="The public ollama.com library — needs a local Ollama and a pull">
            library <em>{libraryCount}</em>
          </button>
        ) : null}
      </div> : null}
      {error && !/Local Ollama isn't running/.test(error) ? <div className="modelError">{error}</div> : null}
      {open ? <div className="modelList">
        {groups.map((g) => (
          <React.Fragment key={g}>
            <div className="modelGroup">
              <span>{g}</span>
              <em>{filtered.filter((m) => m.group === g).length}</em>
            </div>
            {filtered
              .filter((m) => m.group === g)
              .map((m, i) => (
                <button key={m.id} className="modelRow" data-on={m.id === value ? "1" : "0"} style={{ ["--i" as string]: i }} onClick={() => choose(m.id)}>
                  <ProviderLogo brand={brandKey(m)} className="modelGlyph" />
                  <span className="modelIdentity">
                    {/* Friendly name leads (white-labeled for gateway models); raw id demotes to a tag. */}
                    <span className="modelId">{m.label ?? m.id}</span>
                    <span className="modelTags">
                      {m.label && m.label !== m.id ? <span className="modelLabel">{m.id}</span> : null}
                      {m.capabilities?.slice(0, 3).map((cap) => <i key={cap}>{cap}</i>)}
                    </span>
                    {/* The discovery blurb — OpenRouter's per-model description, clamped
                        to two lines (full text on hover). This is what turns the list
                        into a "browse the good stuff" experience. */}
                    {m.description ? <span className="modelDesc" title={m.description}>{m.description}</span> : null}
                  </span>
                  {m.hint ? <span className="modelHint">{m.hint}</span> : null}
                  {!compact ? (
                    <span
                      className="modelInfo"
                      role="button"
                      tabIndex={0}
                      title="Details"
                      aria-label={`Details for ${m.label ?? m.id}`}
                      onClick={(e) => { e.stopPropagation(); setDetail(m); }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setDetail(m); } }}
                    >ⓘ</span>
                  ) : null}
                  <span className="modelTick" aria-hidden="true" />
                </button>
              ))}
          </React.Fragment>
        ))}
        {!loading && filtered.length === 0 ? <div className="modelHintEmpty">no models match</div> : null}
      </div> : null}
      {detail ? (
        <ModelDetail
          model={detail}
          selected={detail.id === value}
          onUse={(id) => { choose(id); setDetail(null); }}
          onBack={() => setDetail(null)}
        />
      ) : null}
    </div>
  );
}

// The big, readable model page — opened from a card's ⓘ. Shows the full
// description, context window, per-Mtok pricing, and every capability, with a
// primary "Use this model" action. Overlays the picker so all mount sites work.
function ModelDetail({ model, selected, onUse, onBack }: { model: ModelOption; selected: boolean; onUse: (id: string) => void; onBack: () => void }) {
  const price = model.pricing;
  const ctxK = model.contextLength ? Math.round(model.contextLength / 1000) : undefined;
  const isFree = model.capabilities?.includes("free");
  return (
    <div className="modelDetail" role="dialog" aria-label={`${model.label ?? model.id} details`}>
      <button className="mdBack" onClick={onBack}>← Back to models</button>
      <div className="mdHead">
        <ProviderLogo brand={brandKey(model)} className="mdGlyph" />
        <div className="mdTitle">
          <strong>{model.label ?? model.id}</strong>
          <span className="mdSub">{model.group}{model.label && model.label !== model.id ? ` · ${model.id}` : ""}</span>
        </div>
      </div>
      <div className="mdStats">
        {ctxK ? <div className="mdStat"><b>{ctxK >= 1000 ? `${(ctxK / 1000).toFixed(ctxK % 1000 ? 1 : 0)}M` : `${ctxK}k`}</b><span>context</span></div> : null}
        {isFree ? <div className="mdStat mdFree"><b>FREE</b><span>no token cost</span></div>
          : price?.input !== undefined ? <div className="mdStat"><b>${price.input.toFixed(2)}</b><span>/M input</span></div> : null}
        {!isFree && price?.output !== undefined ? <div className="mdStat"><b>${price.output.toFixed(2)}</b><span>/M output</span></div> : null}
      </div>
      {model.capabilities && model.capabilities.length > 0 ? (
        <div className="mdCaps">
          {model.capabilities.map((c) => <span key={c} className="mdCap" data-cap={c}>{c}</span>)}
        </div>
      ) : null}
      {model.description ? <p className="mdDesc">{model.description}</p>
        : model.hint ? <p className="mdDesc mdDescThin">{model.hint}</p>
        : <p className="mdDesc mdDescThin">No description available for this model.</p>}
      <button className="mdUse" data-on={selected ? "1" : "0"} onClick={() => onUse(model.id)}>
        {selected ? "✓ Current model" : "Use this model"}
      </button>
    </div>
  );
}

type SettingsTab = "account" | "model" | "appearance" | "voice" | "skills" | "plugins" | "mind" | "usage" | "routing" | "keys" | "consciousness" | "permissions" | "advanced" | "updates" | "about" | "workspaces" | "profile" | "iphone" | "scheduled";

interface SkillSurface {
  id: string;
  label: string;
  icon?: string;
  kind?: "button" | "toggle";
  input?: unknown;
  hint?: string;
}
/** What Ares knows and is doing (see cli/entry/daemon/cognitiveState.ts).
 *  Read-only: this panel is an instrument, not a control surface. */
interface CognitiveStateVm {
  sessionId: string;
  at: string;
  missions: Array<{ id: string; statement: string; status: string; progress: number; steps: number; contract?: string }>;
  objective?: string;
  phase?: string;
  steering: string[];
  currentStep?: string;
  todos: Array<{ content: string; status: string }>;
  evidence: Array<{ label: string; command: string; verdict: "pass" | "fail" | "skip"; cached: boolean; durationMs: number; at: string; outputTail?: string }>;
  uncertainty: string[];
  workStatus?: string;
  recalled: Array<{ id: string; used: boolean }>;
  failures: Array<{ tool: string; signature: string; count: number; latest: string; at: string }>;
  recovery: string[];
  blockedApprovals: Array<{ tool: string; reason: string; at: string }>;
  touchedFiles: string[];
  liveness: Array<{ subsystem: string; state: "live" | "idle" | "dead" | "unknown"; detail: string; lastRunAt?: string }>;
}

/** A roster persona as the daemon wires it (see cli/entry/daemon/personas.ts). */
interface PersonaVm {
  name: string;
  label: string;
  description: string;
  /** The persona prompt itself — needed so Edit can load it back. */
  body: string;
  greeting: string;
  glyph: string;
  tone: "ember" | "mint" | "ivory";
  autonomy: "auto" | "suggest" | "manual";
  triggers: string[];
  tools: string[];
  source: "builtin" | "roster";
  model?: string;
  effort?: string;
  maxTurns?: number;
  file: string;
  modifiedAt?: number;
}
interface SkillInfo {
  name: string;
  description: string;
  status: string;
  category: string;
  enabled: boolean;
  provides?: string[];
  surfaces?: SkillSurface[];
  runnable?: boolean;
  modifiedAt?: number;
}
/** The daemon's plugin host, as reported by plugins_list. */
interface PluginStatusVm {
  name: string;
  state: "active" | "pending" | "failed";
  waitingOn: string[];
  error?: string;
}
interface MaintenanceRunVm {
  job: string;
  at: number;
  durationMs: number;
  note?: string;
}
interface PluginsVm {
  plugins: PluginStatusVm[];
  recentMaintenance: MaintenanceRunVm[];
}
/** One memory row from a mind_overview_result frame — the owner's "what I know" surface. */
interface MindRowVm {
  id: string;
  kind: "semantic" | "procedural" | "episodic";
  content: string;
  strength: number;
  currentStrength: number;
  activations: number;
  ageDays: number;
  tags?: string[];
  confidence?: number;
}
interface MindOverviewVm {
  semantic: MindRowVm[];
  procedural: MindRowVm[];
  episodic: MindRowVm[];
}
interface UsageStats {
  sessions: number;
  apiCalls: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  auxiliaryTokensIn: number;
  auxiliaryTokensOut: number;
  daily: Array<{ date: string; in: number; out: number }>;
  models: Array<{ model: string; provider?: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number; costUsd?: number }>;
  /** Per-provider rollup with estimated spend (live OpenRouter pricing). */
  providers?: Array<{ provider: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number; costUsd?: number }>;
}

/** The iPhone app's Settings: grouped rows, each with a coloured icon tile. */
const SETTINGS_GROUPS: Array<{ label: string; tabs: SettingsTab[] }> = [
  { label: "You", tabs: ["profile", "account", "iphone"] },
  { label: "Agents & models", tabs: ["model", "routing", "workspaces", "scheduled", "permissions", "keys"] },
  { label: "Look & sound", tabs: ["appearance", "voice"] },
  { label: "Abilities", tabs: ["skills", "plugins", "mind"] },
  // Consciousness is off the list (owner, 2026-10-23: "remove consciousness").
  { label: "Ares", tabs: ["usage", "advanced", "updates", "about"] },
];
const SETTINGS_TILES: Record<SettingsTab, { icon: string; bg: string }> = {
  account: { icon: "@", bg: "#0a84ff" },
  profile: { icon: "☺", bg: "#ff375f" },
  iphone: { icon: "▯", bg: "#5e5ce6" },
  scheduled: { icon: "◷", bg: "#ff9f0a" },
  model: { icon: "✦", bg: "#7c5cff" },
  routing: { icon: "⇄", bg: "#ff9f0a" },
  workspaces: { icon: "▣", bg: "#30d158" },
  permissions: { icon: "⛨", bg: "#5e6573" },
  keys: { icon: "⚿", bg: "#ffb340" },
  appearance: { icon: "◐", bg: "#0a84ff" },
  voice: { icon: "◉", bg: "#ff375f" },
  skills: { icon: "✚", bg: "#5856d6" },
  plugins: { icon: "⚙", bg: "#8e8e93" },
  mind: { icon: "✺", bg: "#ff5fa2" },
  usage: { icon: "▤", bg: "#30b0c7" },
  consciousness: { icon: "◎", bg: "#af52de" },
  advanced: { icon: "⋯", bg: "#636366" },
  updates: { icon: "★", bg: "#ff7a1a" },
  about: { icon: "i", bg: "#636366" },
};
const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; glyph: string }> = [
  { id: "model", label: "Model", glyph: "task" },
  { id: "account", label: "Ares Account", glyph: "dot" },
  { id: "routing", label: "Routing", glyph: "search" },
  { id: "workspaces", label: "Workspaces (VPS)", glyph: "shell" },
  { id: "profile", label: "Your profile", glyph: "dot" },
  { id: "iphone", label: "iPhone", glyph: "dot" },
  { id: "scheduled", label: "Scheduled", glyph: "task" },
  { id: "appearance", label: "Appearance", glyph: "edit" },
  { id: "voice", label: "Voice", glyph: "dot" },
  { id: "skills", label: "Skills & Tools", glyph: "file" },
  { id: "plugins", label: "Engine Room", glyph: "shell" },
  { id: "mind", label: "Mind", glyph: "dot" },
  { id: "usage", label: "Usage", glyph: "web" },
  { id: "keys", label: "API Keys", glyph: "shell" },
  { id: "consciousness", label: "Consciousness", glyph: "dot" },
  { id: "permissions", label: "Permissions", glyph: "shell" },
  { id: "advanced", label: "Advanced", glyph: "dot" },
  { id: "updates", label: "What's New", glyph: "dot" },
  { id: "about", label: "About", glyph: "dot" },
];

/** Ares Account — connect to the owner's gateway (doingteam.com), then live
 *  credits / usage / models. Data arrives via gateway_account daemon frames;
 *  grants toast app-wide the moment the owner pushes them. */
function GatewayAccountPane({
  account,
  onDaemonCommand,
  onUseModel,
  activeModel,
}: {
  account: GatewayAccountVm | null;
  onDaemonCommand: (cmd: Record<string, unknown>) => void;
  /** Clicking a granted model switches the live session to it. */
  onUseModel?: (id: string) => void;
  activeModel?: string | null;
}) {
  const [url, setUrl] = useState("https://www.doingteam.com");
  const [token, setToken] = useState("");
  useEffect(() => {
    onDaemonCommand({ type: "gateway_status" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const connected = account?.connected === true;
  return (
    <div className="settingsPane">
      <h3 className="paneTitle">Ares Account</h3>
      {!connected ? (
        <div className="gwConnect">
          {/* Preferred path when the gateway supports it: one-click browser
              sign-in, no token paste. Gated on oauthSupported so it stays hidden
              until doingteam's OAuth endpoints go live. */}
          {account?.oauthSupported ? (
            <>
              <p className="paneHint">
                Sign in with your <strong>doingteam.com</strong> account — models, credits, and usage sync live. No token to copy.
              </p>
              <button
                className="btn gwSignin"
                onClick={() => onDaemonCommand({ type: "gateway_signin", url: url.trim() })}
              >
                Sign in with doingteam
              </button>
              <details className="gwPasteFallback">
                <summary>Paste a token instead</summary>
                <input className="txt" placeholder="gateway url" value={url} onChange={(ev) => setUrl(ev.target.value)} />
                <input
                  className="txt"
                  placeholder="ares_… token (shown once on the site)"
                  type="password"
                  value={token}
                  onChange={(ev) => setToken(ev.target.value)}
                />
                <button
                  className="btn"
                  disabled={!token.trim()}
                  onClick={() => {
                    onDaemonCommand({ type: "gateway_connect", url: url.trim(), token: token.trim() });
                    setToken("");
                  }}
                >
                  Connect
                </button>
              </details>
            </>
          ) : (
            <>
              <p className="paneHint">
                Sign up at <strong>doingteam.com</strong>, then Account → <em>Connect Ares</em> gives you a token. Paste it
                here — credits, models, and usage sync live.
              </p>
              <input className="txt" placeholder="gateway url" value={url} onChange={(ev) => setUrl(ev.target.value)} />
              <input
                className="txt"
                placeholder="ares_… token (shown once on the site)"
                type="password"
                value={token}
                onChange={(ev) => setToken(ev.target.value)}
              />
              <button
                className="btn"
                disabled={!token.trim()}
                onClick={() => {
                  onDaemonCommand({ type: "gateway_connect", url: url.trim(), token: token.trim() });
                  setToken("");
                }}
              >
                Connect
              </button>
            </>
          )}
          {account?.reason ? <p className="paneHint gwBad">Not connected: {account.reason}</p> : null}
        </div>
      ) : (
        <div className="gwAccount">
          <div className="gwRow">
            <div className="gwAvatar">
              {account?.profile?.avatar_url ? (
                <img src={account.profile.avatar_url} alt="" />
              ) : (
                <span>{(account?.profile?.display_name ?? "A").slice(0, 1).toUpperCase()}</span>
              )}
            </div>
            <div>
              <strong>{account?.profile?.display_name ?? "warrior"}</strong>
              <span className="gwStatus" data-status={account?.profile?.status ?? ""}> {account?.profile?.status}</span>
            </div>
            <div className="gwBalance">${(account?.balance_usd ?? 0).toFixed(2)}</div>
          </div>
          <div className="gwUsage">
            today · {(account?.usage?.input_tokens ?? 0).toLocaleString()} in / {(account?.usage?.output_tokens ?? 0).toLocaleString()} out
            · ${(account?.usage?.cost_usd ?? 0).toFixed(4)}
          </div>
          <div className="gwModels">
            {(account?.models ?? []).map((m) => (
              <button
                key={m.id}
                className="gwModel gwModelBtn"
                data-active={activeModel === m.id ? "1" : "0"}
                title="use this model"
                onClick={() => onUseModel?.(m.id)}
              >
                <span>
                  {m.is_house ? <em className="gwHouse">ARES</em> : null} {m.display_name ?? m.id}
                </span>
                <span className="gwModelMeta">
                  {m.is_free ? <em className="gwFree">FREE</em> : null}
                  {typeof m.cap_remaining_microcents === "number" ? (
                    <em className="gwCap">${(m.cap_remaining_microcents / 1e6).toFixed(2)} left</em>
                  ) : null}
                  {activeModel === m.id ? <em className="gwActive">●</em> : null}
                </span>
              </button>
            ))}
            {(account?.models ?? []).length === 0 ? <p className="paneHint">No models assigned yet — the owner grants them.</p> : null}
          </div>
          <button className="btn subtle" onClick={() => onDaemonCommand({ type: "gateway_status" })}>
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}

/** The owner's memory surface — what Ares believes, correctable in place.
 *  Rows arrive via mind_overview_result (owner scope only; the daemon never
 *  widens to guest pools). Edit → mind_edit, delete → mind_forget (one-step
 *  confirm); both replies trigger a fresh mind_overview pull upstream, so this
 *  pane never shows an optimistic guess. Strength bars are STATIC fills —
 *  photosensitive doctrine: nothing flashes, nothing animates. */
function MindPane({
  mind,
  onDaemonCommand,
}: {
  mind: MindOverviewVm | null;
  onDaemonCommand: (cmd: Record<string, unknown>) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const rows = mind ? [...mind.semantic, ...mind.procedural, ...mind.episodic] : [];
  // Scale bars against the strongest memory on screen so relative vividness
  // reads at a glance; a lone weak row still shows a sliver, never an empty bar.
  const maxStrength = Math.max(0.001, ...rows.map((r) => r.currentStrength));
  const sections: Array<{ label: string; hint: string; rows: MindRowVm[] }> = mind
    ? [
        { label: "What I believe", hint: "semantic", rows: mind.semantic },
        { label: "What I can do", hint: "procedural", rows: mind.procedural },
        { label: "What happened", hint: "episodic", rows: mind.episodic },
      ]
    : [];
  const renderRow = (r: MindRowVm) => {
    const editing = editingId === r.id;
    return (
      <div key={r.id} className="skillRow mindRow">
        <div className="skillInfo">
          <strong>
            <span className="mindKind" data-kind={r.kind}>{r.kind}</span>
            <span className="mindBar" title={`strength ${r.currentStrength.toFixed(2)} (stored ${r.strength.toFixed(1)})`}>
              <i style={{ width: `${Math.max(4, Math.round((r.currentStrength / maxStrength) * 100))}%` }} />
            </span>
            <span className="skillCat">×{r.activations} · {r.ageDays}d{r.confidence !== undefined ? ` · conf ${r.confidence.toFixed(2)}` : ""}</span>
          </strong>
          {editing ? (
            <textarea
              className="txt mindEditBox"
              value={draft}
              rows={3}
              autoFocus
              onChange={(ev) => setDraft(ev.target.value)}
            />
          ) : (
            <span className="mindContent" title={r.content}>{r.content}</span>
          )}
        </div>
        <div className="skillRowActions">
          {editing ? (
            <>
              <button
                className="btn tiny"
                disabled={!draft.trim()}
                onClick={() => {
                  onDaemonCommand({ type: "mind_edit", id: r.id, text: draft.trim() });
                  setEditingId(null);
                }}
              >
                Save
              </button>
              <button className="btn tiny ghost" onClick={() => setEditingId(null)}>Cancel</button>
            </>
          ) : (
            <>
              <button
                className="btn tiny ghost"
                title="Correct this memory — your wording replaces it, confidence jumps to 1"
                onClick={() => { setEditingId(r.id); setDraft(r.content); setConfirmId(null); }}
              >
                ✎ Edit
              </button>
              {confirmId === r.id ? (
                <button
                  className="btn tiny mindForgetConfirm"
                  title="Really delete this memory"
                  onClick={() => { onDaemonCommand({ type: "mind_forget", id: r.id }); setConfirmId(null); }}
                >
                  Forget?
                </button>
              ) : (
                <button className="btn tiny ghost" title="Delete this memory" onClick={() => { setConfirmId(r.id); setEditingId(null); }}>
                  ✕
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="settingsPane">
      <h3 className="paneTitle">Mind</h3>
      <p className="paneHint">
        What I believe about you and this work, ranked by how alive each memory is.
        Correct anything wrong in place — your word outranks mine — or delete it outright.
      </p>
      {!mind ? (
        <div className="paneEmpty">Waiting for the daemon…</div>
      ) : rows.length === 0 ? (
        <div className="paneEmpty">I hold no owner-scoped memories yet.</div>
      ) : (
        sections.map((s) =>
          s.rows.length === 0 ? null : (
            <div key={s.hint}>
              <label className="fieldLabel">{s.label} · {s.hint}</label>
              <div className="skillList">{s.rows.map(renderRow)}</div>
            </div>
          ),
        )
      )}
      <button className="btn tiny ghost" onClick={() => onDaemonCommand({ type: "mind_overview" })}>↻ Refresh</button>
    </div>
  );
}


/** The context figure for a session: what the engine reported on its last
 *  turn, or, for a session that predates that report, its last usage line. */
function sessionContext(session: SessionVm | undefined): { prompt?: number; window?: number | null } {
  if (!session) return {};
  if (typeof session.contextPromptTokens === "number") return { prompt: session.contextPromptTokens, window: session.contextWindowTokens ?? null };
  for (let i = session.items.length - 1; i >= 0; i--) {
    const it = session.items[i];
    if (it.kind === "usage" && (it.input > 0 || it.cacheRead > 0)) return { prompt: Math.round((it.input + it.cacheRead) / Math.max(1, it.modelCalls)), window: null };
  }
  return {};
}

function contextFraction(prompt?: number, window?: number | null): number {
  if (!prompt || !window || window <= 0) return 0;
  return Math.min(1, prompt / window);
}
function contextLabel(prompt?: number, window?: number | null): string {
  if (!prompt) return "fresh";
  if (!window) return fmtTokens(prompt);
  return `${Math.round((prompt / window) * 100)}%`;
}
function contextTone(prompt?: number, window?: number | null): string {
  const f = contextFraction(prompt, window);
  return f >= 0.9 ? "bad" : f >= 0.7 ? "warn" : "ok";
}
function resetsIn(iso?: string): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "resets now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 48) {
    const d = new Date(iso);
    return `Resets ${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return `Resets in ${h > 0 ? `${h} hr ` : ""}${m} min`;
}

/** One provider's rolling limits as rows: label · resets · percent, with a bar. */
function UsageRows({ usage, dense }: { usage: ProviderUsageView; dense?: boolean }) {
  return (
    <div className="usageRows" data-dense={dense ? "1" : "0"}>
      {usage.windows.map((w) => (
        <div className="usageRowLine" key={w.label} data-tone={w.utilization >= 0.9 ? "bad" : w.utilization >= 0.7 ? "warn" : "ok"}>
          <div className="usageRowHead">
            <strong>{w.label}</strong>
            <span>{resetsIn(w.resetsAt)}</span>
            <b>{Math.round(w.utilization * 100)}%</b>
          </div>
          <i className="usageMeter"><em style={{ width: `${Math.round(w.utilization * 100)}%` }} /></i>
        </div>
      ))}
      {usage.extra ? <div className="usageExtraLine">{usage.extra.currency === "USD" || !usage.extra.currency ? "$" : `${usage.extra.currency} `}{usage.extra.cost.toFixed(2)} {usage.extra.note ?? "extra"}</div> : null}
      {usage.models?.length ? (
        <div className="usageModelsLine">
          {usage.models.slice(0, dense ? 3 : 6).map((m) => <span key={m.name}>{m.name} <em>{m.requestCount.toLocaleString()}</em></span>)}
        </div>
      ) : null}
    </div>
  );
}

function ProviderUsageCard({ usage, error, onRefresh }: { usage: ProviderUsageView | null; error: string | null; onRefresh: () => void }) {
  if (!usage) return <div className="usageCardLine muted">{error ? `Usage unavailable — ${error}` : "Loading usage…"}<button className="usageRefreshBtn" onClick={onRefresh}>↻</button></div>;
  return (
    <div className="usageCardLine" title={`From ${usage.source} · ${new Date(usage.fetchedAt).toLocaleTimeString()}`}>
      <div className="usageCardHead">
        <span>{usage.plan ? `${usage.label} · ${usage.plan}` : usage.label}</span>
        {error ? <em className="muted">stale — {error}</em> : null}
        <button className="usageRefreshBtn" onClick={onRefresh} title="Refresh">↻</button>
      </div>
      <UsageRows usage={usage} />
    </div>
  );
}

/** The Claude-Desktop-style card: context fill first, then every linked
 *  provider's plan limits, then the door to the full Usage pane. */
function ContextPopover({ promptTokens, windowTokens, usage, onRefresh, onClose, onDetails }: {
  promptTokens?: number;
  windowTokens?: number | null;
  usage: { providers: ProviderUsageView[]; errors: Record<string, string>; at: number } | null;
  onRefresh: () => void;
  onClose: () => void;
  onDetails: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // the segment that opened it toggles it; a mousedown there must not
    // close-then-reopen
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && t.closest(".contextSeg")) return;
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose();
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  const frac = contextFraction(promptTokens, windowTokens);
  const providers = usage?.providers ?? [];
  const errors = usage?.errors ?? {};
  return (
    <div className="contextPop" ref={ref} role="dialog" aria-label="Context and usage">
      <div className="contextPopSection">
        <div className="usageRowHead">
          <strong>Context window</strong>
          <b>{promptTokens ? `${fmtTokens(promptTokens)} / ${windowTokens ? fmtTokens(windowTokens) : "?"} (${Math.round(frac * 100)}%)` : "nothing sent yet"}</b>
        </div>
        <i className="usageMeter" data-tone={contextTone(promptTokens, windowTokens)}><em style={{ width: `${Math.round(frac * 100)}%` }} /></i>
        <p className="contextPopHint">The prompt Ares sent on the last request, against the window it budgets for this model. Compaction trims history as it fills.</p>
      </div>
      {providers.length === 0 ? (
        <div className="contextPopSection">
          <div className="usageRowHead"><strong>Plan usage limits</strong><button className="usageRefreshBtn" onClick={onRefresh}>↻</button></div>
          <p className="contextPopHint">{Object.keys(errors).length ? Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join(" · ") : usage ? "No linked provider reports plan limits. Sign in to Claude or add an Ollama Cloud key to see them here." : "Loading…"}</p>
        </div>
      ) : providers.map((u) => (
        <div className="contextPopSection" key={u.provider}>
          <div className="usageRowHead">
            <strong>{u.label}{u.plan ? ` · ${u.plan}` : ""}</strong>
            {errors[u.provider] ? <span className="muted">stale</span> : null}
            <button className="usageRefreshBtn" onClick={onRefresh} title="Refresh">↻</button>
          </div>
          <UsageRows usage={u} dense />
        </div>
      ))}
      <button className="contextPopMore" onClick={onDetails}>See detailed breakdown</button>
    </div>
  );
}

/** What is running behind the chat, so a restart never hides a loop. */
function ForgeBackgroundPanel({ jobs, agents, opStatus, recovery, recoveryMode, onStop, onStopAgent, onResume, onDiscard, onHalt, onRefresh }: {
  jobs: BackgroundJobVm[];
  agents: SubagentJobWire[];
  opStatus: { activeCount?: number; halted?: boolean; running?: boolean } | null;
  recovery: { count: number; previews: Array<{ inputId: string; goal: string }> } | null;
  recoveryMode: { mode: "ask" | "auto" | "never"; pinnedByEnv: boolean };
  onStop: (id: string) => void;
  onStopAgent: (jobId: string) => void;
  onResume: () => void;
  onDiscard: () => void;
  onHalt: () => void;
  onRefresh: () => void;
}) {
  const live = agents.filter((a) => /run|active|working|pending|queued/i.test(a.status));
  const done = agents.filter((a) => !live.includes(a)).slice(0, 8);
  const running = jobs.filter((j) => j.status === "running");
  return (
    <div className="forgeBody bgPanel">
      <div className="bgPanelHead">
        <strong>Background</strong>
        <span>{live.length} agent{live.length === 1 ? "" : "s"} · {running.length} process{running.length === 1 ? "" : "es"}</span>
        <button className="ghost" onClick={onRefresh}>Refresh</button>
      </div>
      {recovery ? (
        <div className="bgCard" data-tone="warn">
          <div className="bgCardBody">
            <strong>Unfinished from last time</strong>
            <span>{recovery.previews[0]?.goal ? `“${compact(recovery.previews[0].goal, 160)}”` : "a pending request"}{recovery.count > 1 ? ` and ${recovery.count - 1} more` : ""} — found, not run.</span>
          </div>
          <div className="bgCardActions">
            <button className="btn primary" onClick={onResume}>Resume</button>
            <button className="btn ghost" onClick={onDiscard}>Discard</button>
          </div>
        </div>
      ) : null}
      <div className="bgNote">On restart Ares {recoveryMode.mode === "auto" ? "resumes unfinished work automatically" : recoveryMode.mode === "never" ? "discards unfinished work" : "asks before resuming unfinished work"}{recoveryMode.pinnedByEnv ? " (pinned by ARES_STARTUP_RECOVERY)" : ""}. Change it in Settings → Starting up.</div>
      {opStatus && (opStatus.activeCount || opStatus.running) ? (
        <div className="bgCard">
          <div className="bgCardBody"><strong>Operator loop</strong><span>{opStatus.activeCount ?? 0} active mission{(opStatus.activeCount ?? 0) === 1 ? "" : "s"}{opStatus.halted ? " · halted" : " · running unattended"}</span></div>
          {!opStatus.halted ? <div className="bgCardActions"><button className="btn ghost" onClick={onHalt}>Halt</button></div> : null}
        </div>
      ) : null}
      <div className="bgSection">Agents</div>
      {live.length === 0 ? <div className="bgEmpty">No agents working right now.</div> : live.map((a) => (
        <div className="bgCard" key={a.jobId} data-live="1">
          <div className="bgCardBody">
            <strong>{a.description || a.kind || a.jobId}</strong>
            <span>{a.status}{a.startedAt ? ` · since ${new Date(a.startedAt).toLocaleTimeString()}` : ""}</span>
          </div>
          <div className="bgCardActions"><button className="btn ghost" onClick={() => onStopAgent(a.jobId)}>Stop</button></div>
        </div>
      ))}
      {done.length ? <div className="bgDone">{done.map((a) => <span key={a.jobId}>{a.description || a.kind || a.jobId} <em>{a.status}</em></span>)}</div> : null}
      <div className="bgSection">Processes</div>
      {jobs.length === 0 ? <div className="bgEmpty">No background processes for this session.</div> : jobs.map((j) => (
        <div className="bgCard" key={j.id} data-live={j.status === "running" ? "1" : "0"}>
          <div className="bgCardBody">
            <strong>{j.description || j.command}</strong>
            <span>{j.status}{j.suspended ? " · suspended" : ""}{j.cwd ? ` · ${compact(j.cwd, 48)}` : ""}</span>
          </div>
          {j.status === "running" ? <div className="bgCardActions"><button className="btn ghost" onClick={() => onStop(j.id)}>Stop</button></div> : null}
        </div>
      ))}
    </div>
  );
}

type OllamaUsageState = { usage: OllamaUsageView | null; error: string | null; at: number };

/** Ollama Cloud account usage for the pasted key: session + weekly limit
 *  bars, top models this week, billed extra over four weeks. */
function OllamaUsageLine({ state, onRefresh, detailed }: { state: OllamaUsageState | null; onRefresh?: () => void; detailed?: boolean }) {
  if (!state) return <div className="ollUsage muted">Loading usage…</div>;
  const u = state.usage;
  if (!u) return <div className="ollUsage muted">Usage unavailable{state.error ? ` — ${state.error}` : ""}{onRefresh ? <button className="ollUsageRefresh" onClick={onRefresh}>retry</button> : null}</div>;
  const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
  const tone = (v: number) => (v >= 0.9 ? "bad" : v >= 0.7 ? "warn" : "ok");
  const top = u.weekly.models.slice(0, detailed ? 5 : 3);
  return (
    <div className="ollUsage" title={`Fetched ${new Date(u.fetchedAt).toLocaleTimeString()} from ollama.com`}>
      <div className="ollUsageBars">
        <span className="ollUsageBar" data-tone={tone(u.session.usage)}><i style={{ width: pct(u.session.usage) }} /><b>session {pct(u.session.usage)}</b></span>
        <span className="ollUsageBar" data-tone={tone(u.weekly.usage)}><i style={{ width: pct(u.weekly.usage) }} /><b>week {pct(u.weekly.usage)}</b></span>
        {u.extra.cost > 0 ? <span className="ollUsageExtra">+${u.extra.cost.toFixed(2)} billed · 4 wks</span> : null}
        {onRefresh ? <button className="ollUsageRefresh" onClick={onRefresh} title="Refresh from ollama.com">↻</button> : null}
      </div>
      {top.length ? (
        <div className="ollUsageModels">
          {top.map((m) => <span key={m.name}>{m.name} <em>{m.requestCount.toLocaleString()}</em></span>)}
          {state.error ? <span className="muted">stale — {state.error}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function Settings({
  recoveryMode,
  setRecoveryMode,
  prefs,
  onApply,
  onClose,
  native,
  skills,
  plugins,
  mind,
  usage,
  pointMaps,
  onDeletePointMap,
  providerUsage,
  anthropicSignedIn,
  ollamaUsage,
  keyStatus,
  gatewayAccount,
  permissions,
  onPermissions,
  oauthProviders,
  consciousness,
  aresNetwork,
  onDaemonCommand,
  onLivePref,
  onAnthropicSignIn,
  initialTab,
  onPreviewVoice,
  listProviderVoices,
  voiceEngine,
  onRepairVoice,
  onOpenModelBrowser,
  openaiAuth,
  onOpenaiSignIn,
  kimiAuth,
  onKimiSignIn,
  onLaunchLivingSurface,
  workspacesSlot,
  extraSlots,
  skillsTopSlot,
}: {
  /** Settings → Workspaces, built by the app (it owns the boxes' state). */
  workspacesSlot?: React.ReactNode;
  /** Panes the app builds (it owns their state): Profile, iPhone, Scheduled. */
  extraSlots?: Partial<Record<SettingsTab, React.ReactNode>>;
  /** Above the Skills list: sharing with other people's agents. */
  skillsTopSlot?: React.ReactNode;
  recoveryMode: { mode: "ask" | "auto" | "never"; pinnedByEnv: boolean };
  setRecoveryMode: React.Dispatch<React.SetStateAction<{ mode: "ask" | "auto" | "never"; pinnedByEnv: boolean }>>;
  prefs: Prefs;
  onApply: (p: Prefs, keys: Record<string, string>) => void;
  onClose: () => void;
  native: boolean;
  skills: SkillInfo[];
  plugins: PluginsVm | null;
  mind: MindOverviewVm | null;
  usage: UsageStats | null;
  pointMaps: PointMapSpec[];
  onDeletePointMap: (id: string) => void;
  providerUsage?: { providers: ProviderUsageView[]; errors: Record<string, string>; at: number } | null;
  anthropicSignedIn?: boolean;
  ollamaUsage?: OllamaUsageState | null;
  keyStatus: Record<string, boolean>;
  gatewayAccount: GatewayAccountVm | null;
  permissions: PermSettings;
  onPermissions: (next: PermSettings) => void;
  oauthProviders: OAuthProviderVm[];
  consciousness: ConsciousnessVm;
  aresNetwork: AresNetworkVm;
  onDaemonCommand: (cmd: Record<string, unknown>) => void;
  onLivePref: (patch: Partial<Prefs>) => void;
  onAnthropicSignIn: () => void;
  initialTab?: SettingsTab;
  onPreviewVoice?: (voiceId: string) => void;
  listProviderVoices?: () => Promise<VoiceInfo[]>;
  voiceEngine: { phase: string; detail: string };
  onRepairVoice: () => void;
  onOpenModelBrowser: () => void;
  openaiAuth: { signingIn: boolean; connected: boolean; email: string | null; plan: string | null };
  onOpenaiSignIn: () => void;
  kimiAuth: { signingIn: boolean; connected: boolean; detail: string | null };
  onKimiSignIn: () => void;
  onLaunchLivingSurface: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "model");
  const [draft, setDraftPrefs] = useState<Prefs>(prefs);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [skillQuery, setSkillQuery] = useState("");
  const providerModels = useRef<Record<string, string>>({ [prefs.provider]: prefs.model });

  // pull live data when entering data-backed tabs
  useEffect(() => {
    if (!native) return;
    if (tab === "skills") { onDaemonCommand({ type: "skills_list" }); onDaemonCommand({ type: "agents_sharing" }); }
    if (tab === "scheduled") onDaemonCommand({ type: "jobs_list" });
    if (tab === "iphone") onDaemonCommand({ type: "remote_devices" });
    if (tab === "plugins") onDaemonCommand({ type: "plugins_list" });
    if (tab === "mind") onDaemonCommand({ type: "mind_overview" });
    if (tab === "usage") onDaemonCommand({ type: "usage_stats", days: 30 });
    if (tab === "appearance") onDaemonCommand({ type: "pointmaps_list" });
    if (tab === "consciousness") {
      onDaemonCommand({ type: "consciousness_status" });
      onDaemonCommand({ type: "ares_network_status" });
    }
  }, [tab, native, onDaemonCommand]);

  const setEngine = (patch: Partial<EngineConfig>) => setDraftPrefs({ ...draft, engine: { ...draft.engine, ...patch } });
  const setProvider = (provider: string) => {
    providerModels.current[draft.provider] = draft.model;
    setDraftPrefs({
      ...draft,
      provider,
      model: providerModels.current[provider] ?? defaultModelForProvider(provider),
    });
  };
  const setModel = (model: string) => {
    providerModels.current[draft.provider] = model;
    setDraftPrefs({ ...draft, model });
  };
  const closeSettings = () => {
    if (draft.theme !== prefs.theme) onLivePref({ theme: prefs.theme });
    onClose();
  };

  return (
    <div className="scrim center" onClick={closeSettings}>
      <div className="settingsShell" onClick={(e) => e.stopPropagation()}>
        <aside className="settingsNav">
          <div className="settingsBrand">
            <div className="settingsHeroMark" aria-hidden="true" />
            <strong>Settings</strong>
          </div>
          {SETTINGS_GROUPS.map((g) => (
            <div key={g.label} className="setGroup">
              <div className="setGroupLabel">{g.label}</div>
              {g.tabs.map((id) => {
                const t = SETTINGS_TABS.find((x) => x.id === id);
                if (!t) return null;
                const tile = SETTINGS_TILES[id];
                return (
                  <button key={t.id} data-tab={t.id} data-on={tab === t.id ? "1" : "0"} onClick={() => setTab(t.id)}>
                    <span className="setTile" style={{ background: tile.bg }} aria-hidden="true">{tile.icon}</span>
                    <i className="glyph" data-glyph={t.glyph} /> {t.label}
                  </button>
                );
              })}
            </div>
          ))}
          <div className="settingsNavFoot">
            <button className="ghost" onClick={closeSettings}>
              Close
            </button>
          </div>
        </aside>

        <div className="settingsMain">
          {tab === "workspaces" ? workspacesSlot : null}
          {extraSlots?.[tab] ?? null}
          {tab === "model" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Starting up</h3>
              <p className="paneHint">A request that was still running when Ares last closed is found again when you open that session. What happens then:</p>
              <select
                className="settingsSelect"
                value={recoveryMode.mode}
                disabled={recoveryMode.pinnedByEnv}
                title={recoveryMode.pinnedByEnv ? "Pinned by ARES_STARTUP_RECOVERY in the environment" : "Applies to every session"}
                onChange={(e) => {
                  const mode = e.target.value as "ask" | "auto" | "never";
                  setRecoveryMode((r) => ({ ...r, mode }));
                  void invoke("ares_daemon_command", { command: { type: "startup_recovery_mode", mode } }).catch(() => null);
                }}
              >
                <option value="ask">Ask me — show it with Resume / Discard, run nothing (default)</option>
                <option value="auto">Resume it automatically when the session opens</option>
                <option value="never">Discard it</option>
              </select>
              <h3 className="paneTitle">Model</h3>
              <p className="paneHint">The main model for new sessions. Hot-swap the active chat from the composer.</p>
              <label className="fieldLabel">Current model</label>
              <button className="settingsModelCard" onClick={onOpenModelBrowser} title="Open the full model browser">
                <ProviderLogo brand={brandKey({ id: prefs.model, group: prefs.provider })} className="settingsModelLogo" />
                <span className="settingsModelBody">
                  <strong>{prefs.model}</strong>
                  <em>{PROVIDER_IDENTITY[prefs.provider]?.title ?? prefs.provider}{prefs.routingMode === "auto" ? " · auto-routing on" : ""}</em>
                </span>
                <span className="settingsModelBrowse">Browse models →</span>
              </button>
              <label className="fieldLabel">Reasoning</label>
              <div className="modelNativeReasoning">
                <strong>Model-native</strong>
                <span>Ares negotiates the real reasoning capability supported by this model. There is no simulated global thinking mode.</span>
              </div>
            </div>
          ) : null}

          {tab === "routing" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Routing</h3>
              <p className="paneHint">Assign a model to each task lane. Unassigned lanes use the main model.</p>
              {ROUTE_LANES.map((lane) => {
                const entry = draft.routing[lane];
                const setLane = (e: { provider: string; model: string } | undefined) => {
                  const routing = { ...draft.routing };
                  if (e) routing[lane] = e;
                  else delete routing[lane];
                  setDraftPrefs({ ...draft, routing });
                };
                return (
                  <div key={lane} className="routeLane" data-on={entry ? "1" : "0"}>
                    <button className="laneToggle" onClick={() => setLane(entry ? undefined : { provider: draft.provider, model: draft.model })}>
                      <span className="laneIcon" aria-hidden="true">{LANE_ICONS[lane]}</span>
                      <span className="laneName">
                        <strong>{lane}</strong>
                        <em>{LANE_HINTS[lane]}</em>
                      </span>
                      <span className="laneAssign" title={entry ? `${entry.provider} · ${entry.model}` : "main model"}>{entry ? `${entry.provider} · ${entry.model}` : "main model"}</span>
                      <span className="laneSwitch" data-on={entry ? "1" : "0"} aria-hidden="true"><i /></span>
                    </button>
                    {entry ? (
                      <div className="laneBody">
                        <div className="segment mini">
                          {/* Lanes take concrete providers only — no MoA (an ensemble is itself a router). */}
                          {PROVIDERS.filter((p) => p !== "mock" && p !== "moa").map((p) => (
                            <button
                              key={p}
                              data-on={entry.provider === p ? "1" : "0"}
                              onClick={() => setLane({ provider: p, model: defaultModelForProvider(p) })}
                            >
                              {p}
                            </button>
                          ))}
                        </div>
                        <ModelPicker provider={entry.provider} value={entry.model} onPick={(id) => setLane({ ...entry, model: id })} native={native} compact />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {tab === "appearance" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Appearance</h3>
              <label className="fieldLabel">Mode</label>
              <div className="segment glassModes">
                {([["light", "Light"], ["dark", "Dark"], ["auto", "Auto"]] as const).map(([id, label]) => (
                  <button
                    key={id}
                    data-on={(draft.glassMode ?? "light") === id ? "1" : "0"}
                    onClick={() => {
                      setDraftPrefs({ ...draft, glassMode: id });
                      onLivePref({ glassMode: id });
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="paneHint">Auto follows your computer: light by day, dark at night if Windows is set that way.</p>
              <div className="livingLaunchCard">
                <div className="livingLaunchSignal"><i /><i /><i /></div>
                <div className="livingLaunchCopy">
                  <span>EXPERIMENTAL INTERFACE</span>
                  <strong>Self-Generating UI <b>BETA</b></strong>
                  <p>Name your wildest dream — a chat room, a game, a control room — and Ares builds it live: working software it reshapes around you as you speak.</p>
                </div>
                <button onClick={onLaunchLivingSurface} disabled={!native}>LAUNCH ARES ↗</button>
              </div>
              {/* One surface: Messages (owner, 2026-10-21: "hide all other themes, mandate the messages"). The accent still re-tints it. */}
              <label className="fieldLabel">Accent</label>
              <div className="accentRow">
                {ACCENTS.map((a) => (
                  <button
                    key={a.id}
                    className="accentDot"
                    data-on={draft.accent === a.id ? "1" : "0"}
                    title={a.label}
                    aria-label={a.label}
                    onClick={() => {
                      setDraftPrefs({ ...draft, accent: a.id });
                      onLivePref({ accent: a.id });
                    }}
                  >
                    <span style={{ background: a.swatch }} />
                  </button>
                ))}
              </div>
              {draft.surface === "cyber" ? (
                <>
                  <label className="fieldLabel">Point map</label>
                  <p className="paneHint">The GPU point cloud behind the room. Pick one, switch it off, or ask Ares for a new one — “design me a point map called Aurora, calm and wide” — and it lands in this list.</p>
                  <div className="pointMapRow">
                    <button className="pointMapCard" data-on={draft.pointMapOff ? "1" : "0"} onClick={() => { const next = { ...draft, pointMapOff: !draft.pointMapOff }; setDraftPrefs(next); onLivePref({ pointMapOff: next.pointMapOff }); }}>
                      <span className="pointMapPreview" data-kind="off" aria-hidden="true" />
                      <strong>Off</strong>
                      <em>Just the room, no cloud</em>
                    </button>
                    {pointMaps.map((m) => (
                      <button key={m.id} className="pointMapCard" data-on={!draft.pointMapOff && (draft.pointMap ?? "nebula") === m.id ? "1" : "0"} onClick={() => { const next = { ...draft, pointMap: m.id, pointMapOff: false }; setDraftPrefs(next); onLivePref({ pointMap: m.id, pointMapOff: false }); }} title={m.note ?? m.name}>
                        <span className="pointMapPreview" data-kind={m.kind} aria-hidden="true" />
                        <strong>{m.name}{m.by === "ares" ? <i className="pointMapBy">Ares</i> : m.by === "owner" ? <i className="pointMapBy">you</i> : null}</strong>
                        <em>{m.note ?? m.kind}</em>
                        {m.by !== "builtin" ? <b className="pointMapDel" role="button" title="Delete this map" onClick={(ev) => { ev.stopPropagation(); onDeletePointMap(m.id); }}>✕</b> : null}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              <label className="fieldLabel">Turn token warning</label>
              <div className="displayModes">
                {([[0, "Off", "Never warn."], [250_000, "250k", "Warn early on heavy turns."], [500_000, "500k", "The default."], [1_000_000, "1M", "Only for very long runs."]] as const).map(([value, label, hint]) => (
                  <button key={label} data-on={(draft.turnTokenWarn ?? 500_000) === value ? "1" : "0"} onClick={() => setDraftPrefs({ ...draft, turnTokenWarn: value })}>
                    <strong>{label}</strong>
                    <span>{hint}</span>
                  </button>
                ))}
              </div>
              <label className="fieldLabel">Tool call display</label>
              <div className="displayModes">
                <button data-on={draft.toolDisplay === "product" ? "1" : "0"} onClick={() => setDraftPrefs({ ...draft, toolDisplay: "product" })}>
                  <strong>Product</strong>
                  <span>Concise, human-friendly tool activity.</span>
                </button>
                <button data-on={draft.toolDisplay === "technical" ? "1" : "0"} onClick={() => setDraftPrefs({ ...draft, toolDisplay: "technical" })}>
                  <strong>Technical</strong>
                  <span>Raw tool inputs and outputs, full detail.</span>
                </button>
              </div>
            </div>
          ) : null}

          {tab === "voice" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Voice</h3>
              <p className="paneHint">Speak with Ares hands-free. The local voice engine runs on your machine — private, no cloud.</p>
              <VoiceEngineStatus voiceEngine={voiceEngine} onRepair={onRepairVoice} />
              <VoiceSettings draft={draft} setDraftPrefs={setDraftPrefs} onLivePref={onLivePref} providerSkill={skills.find((s) => s.enabled && (s.provides ?? []).includes("tts"))} onPreviewVoice={onPreviewVoice} listProviderVoices={listProviderVoices} />
            </div>
          ) : null}

          {tab === "skills" ? (
            <div className="settingsPane">
              {skillsTopSlot}
              <h3 className="paneTitle">Skills & Tools</h3>
              <p className="paneHint">What your agents know how to do. Search, test, and switch off anything you don't want them using.</p>
              <div className="skillOverview">
                <span><strong>{skills.filter((s) => s.enabled).length}</strong> enabled</span>
                <span><strong>{skills.filter((s) => s.runnable).length}</strong> executable</span>
                <span><strong>{new Set(skills.flatMap((s) => s.provides ?? [])).size}</strong> capabilities</span>
              </div>
              <input className="txt skillFilter" type="search" placeholder="Filter skills, categories, capabilities…" value={skillQuery} onChange={(e) => setSkillQuery(e.target.value)} />
              {skills.length === 0 ? (
                <div className="paneEmpty">No skills yet. Ares proposes skills from repeated workflows; approved ones land here.</div>
              ) : (
                <div className="skillList">
                  {skills.filter((s) => {
                    const q = skillQuery.trim().toLowerCase();
                    return !q || [s.name, s.description, s.category, ...(s.provides ?? [])].join(" ").toLowerCase().includes(q);
                  }).map((s) => (
                    <div key={s.name} className="skillRow">
                      <div className="skillInfo">
                        <strong>
                          {s.name}
                          <span className="skillCat">{s.category}</span>
                          {(s.provides ?? []).map((p) => <span key={p} className="skillCat provides">{p}</span>)}
                          <span className="skillReady" data-ready={s.runnable ? "1" : "0"}>{s.runnable ? "executable" : "prompt"}</span>
                        </strong>
                        <span>{s.description}</span>
                      </div>
                      <div className="skillRowActions">
                        {s.runnable ? <button className="btn tiny ghost" disabled={!s.enabled} title="Run this skill's health check" onClick={() => onDaemonCommand({ type: "skill_invoke", name: s.name, input: { op: "healthcheck", source: "settings" } })}>▶ Test</button> : null}
                        <button className="btn tiny ghost" title="Publish this skill to the SkillHub" onClick={() => onDaemonCommand({ type: "skillhub_publish", name: s.name })}>
                          ⬆ Upload
                        </button>
                        <button
                          className="toggle"
                          data-on={s.enabled ? "1" : "0"}
                          onClick={() => onDaemonCommand({ type: "skill_toggle", name: s.name, enabled: !s.enabled })}
                        >
                          <i />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="skillHubSection"><SkillHubBrowser onDaemonCommand={onDaemonCommand} /></div>
            </div>
          ) : null}

          {tab === "plugins" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Engine Room</h3>
              <p className="paneHint">The daemon's plugin host: every mounted capability, what it is waiting on, and the maintenance work that actually ran. If something here reads "failed", Ares is running without it.</p>
              {!plugins ? (
                <div className="paneEmpty">Waiting for the daemon…</div>
              ) : (
                <>
                  <div className="skillOverview">
                    <span><strong>{plugins.plugins.filter((p) => p.state === "active").length}</strong> active</span>
                    <span><strong>{plugins.plugins.filter((p) => p.state === "pending").length}</strong> waiting</span>
                    <span><strong>{plugins.plugins.filter((p) => p.state === "failed").length}</strong> failed</span>
                  </div>
                  <div className="skillList">
                    {plugins.plugins.map((p) => (
                      <div key={p.name} className="skillRow">
                        <div className="skillInfo">
                          <strong>
                            {p.name}
                            <span className="skillReady" data-ready={p.state === "active" ? "1" : "0"}>{p.state}</span>
                          </strong>
                          <span>
                            {p.state === "failed"
                              ? p.error ?? "setup failed"
                              : p.state === "pending" && p.waitingOn.length > 0
                                ? `waiting on ${p.waitingOn.join(", ")}`
                                : "running"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <label className="fieldLabel">Recent maintenance</label>
                  {plugins.recentMaintenance.length === 0 ? (
                    <div className="paneEmpty">Nothing noteworthy yet — quiet passes stay off the ledger.</div>
                  ) : (
                    <div className="skillList">
                      {plugins.recentMaintenance.map((run, i) => (
                        <div key={`${run.job}-${run.at}-${i}`} className="skillRow">
                          <div className="skillInfo">
                            <strong>
                              {run.job}
                              <span className="skillCat">{new Date(run.at).toLocaleTimeString()}</span>
                              <span className="skillCat">{run.durationMs}ms</span>
                            </strong>
                            {run.note ? <span>{run.note}</span> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <button className="btn tiny ghost" onClick={() => onDaemonCommand({ type: "plugins_list" })}>↻ Refresh</button>
                </>
              )}
            </div>
          ) : null}

          {tab === "mind" ? <MindPane mind={mind} onDaemonCommand={onDaemonCommand} /> : null}

          {tab === "usage" ? <UsagePane usage={usage} onDaemonCommand={onDaemonCommand} native={native} /> : null}

          {tab === "account" ? (
            <GatewayAccountPane account={gatewayAccount} onDaemonCommand={onDaemonCommand} activeModel={draft.provider === "ares" ? draft.model : null} onUseModel={(id) => { onLivePref({ provider: "ares", model: id }); onDaemonCommand({ type: "model_switch", provider: "ares", model: id }); }} />
          ) : null}
          {tab === "keys" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">API Keys</h3>
              <p className="paneHint">Keys are encrypted by the daemon under ~/.ares and never touch this window's storage.</p>

              <div className="keyGroupLabel">Sign in — no key needed</div>
              <div className="keyCard signIn">
                <ProviderLogo brand="anthropic" className="keyLogo" />
                <div className="keyCardBody">
                  <strong>Claude (Pro / Max)</strong>
                  <em>Use your Claude subscription — nothing to paste.</em>
                </div>
                <button className="keySignInBtn" onClick={onAnthropicSignIn}>Sign in with browser</button>
              </div>
              <div className="keyCard signIn" data-on={openaiAuth.connected ? "1" : "0"}>
                <ProviderLogo brand="openai" className="keyLogo" />
                <div className="keyCardBody">
                  <div className="keyCardHead">
                    <strong>ChatGPT (Plus / Pro / Max)</strong>
                    {openaiAuth.connected ? <span className="keyPill" data-on="1">connected{openaiAuth.plan ? ` · ${openaiAuth.plan}` : ""}</span> : null}
                  </div>
                  <em>{openaiAuth.connected ? (openaiAuth.email ? `Signed in as ${openaiAuth.email} — GPT models use your subscription.` : "GPT models run on your ChatGPT subscription.") : "Run GPT models on your ChatGPT subscription — no API key."}</em>
                </div>
                <button className="keySignInBtn" disabled={openaiAuth.signingIn} onClick={onOpenaiSignIn}>
                  {openaiAuth.signingIn ? "Waiting…" : openaiAuth.connected ? "Re-sign in" : "Sign in with browser"}
                </button>
              </div>
              <div className="keyCard signIn" data-on={kimiAuth.connected ? "1" : "0"}>
                <ProviderLogo brand="moonshot" className="keyLogo" />
                <div className="keyCardBody">
                  <div className="keyCardHead">
                    <strong>Kimi (subscription)</strong>
                    {kimiAuth.connected ? <span className="keyPill" data-on="1">connected{kimiAuth.detail ? ` · ${kimiAuth.detail}` : ""}</span> : null}
                  </div>
                  <em>{kimiAuth.connected ? "Kimi models run on your Kimi subscription." : "Run Kimi models on your Kimi subscription — no API key."}</em>
                  {kimiAuth.connected ? <ProviderUsageCard usage={(providerUsage?.providers ?? []).find((u) => u.provider === "kimi") ?? null} error={providerUsage?.errors?.kimi ?? null} onRefresh={() => onDaemonCommand({ type: "provider_usage", force: true })} /> : null}
                </div>
                <button className="keySignInBtn" disabled={kimiAuth.signingIn} onClick={onKimiSignIn}>
                  {kimiAuth.signingIn ? "Waiting…" : kimiAuth.connected ? "Re-sign in" : "Sign in with browser"}
                </button>
              </div>

              <div className="keyGroupLabel">Provider keys</div>
              {KEYED_PROVIDERS.map((kp) => {
                const on = !!keyStatus[kp.id];
                return (
                  <div key={kp.id} className="keyCard" data-on={on ? "1" : "0"}>
                    <ProviderLogo brand={kp.brand} className="keyLogo" />
                    <div className="keyCardBody">
                      <div className="keyCardHead">
                        <strong>{kp.label}</strong>
                        <span className="keyPill" data-on={on ? "1" : "0"}>{on ? "connected" : "not set"}</span>
                      </div>
                      <input className="keyInput" value={keys[kp.id] ?? ""} type="password" placeholder={on ? "•••••••• saved — paste to replace" : kp.placeholder} onChange={(e) => setKeys({ ...keys, [kp.id]: e.target.value })} />
                      <em className="keySub">{kp.sub}</em>
                      {kp.id === "ollama" && on ? <ProviderUsageCard usage={(providerUsage?.providers ?? []).find((u) => u.provider === "ollama") ?? null} error={providerUsage?.errors?.ollama ?? null} onRefresh={() => onDaemonCommand({ type: "provider_usage", force: true })} /> : null}
                      {kp.id === "anthropic" && (on || anthropicSignedIn) ? <ProviderUsageCard usage={(providerUsage?.providers ?? []).find((u) => u.provider === "anthropic") ?? null} error={providerUsage?.errors?.anthropic ?? null} onRefresh={() => onDaemonCommand({ type: "provider_usage", force: true })} /> : null}
                    </div>
                    {on ? (
                      <button className="keyClearBtn" title="Remove this key" onClick={() => onDaemonCommand({ type: "provider_key", provider: kp.id, key: "" })}>✕</button>
                    ) : null}
                  </div>
                );
              })}

              <div className="keyGroupLabel">Search & tools</div>
              <div className="keyCard" data-on={keyStatus.brave ? "1" : "0"}>
                <ProviderLogo brand="generic" className="keyLogo" />
                <div className="keyCardBody">
                  <div className="keyCardHead">
                    <strong>Brave Search</strong>
                    <span className="keyPill" data-on={keyStatus.brave ? "1" : "0"}>{keyStatus.brave ? "connected" : "not set"}</span>
                  </div>
                  <input className="keyInput" value={keys.brave ?? ""} type="password" placeholder={keyStatus.brave ? "•••••••• saved — paste to replace" : "BSA…"} onChange={(e) => setKeys({ ...keys, brave: e.target.value })} />
                  <em className="keySub">upgrades web + image search</em>
                </div>
                {keyStatus.brave ? (
                  <button className="keyClearBtn" title="Remove this key" onClick={() => onDaemonCommand({ type: "provider_key", provider: "brave", key: "" })}>✕</button>
                ) : null}
              </div>

              <div className="keyGroupLabel">Custom / OpenAI-compatible</div>
              <CustomProviderBlock onDaemonCommand={onDaemonCommand} native={native} />

              <p className="keyHint">OpenAI signs in with ChatGPT OAuth. Local Ollama needs no key — the Ollama Cloud key adds ollama.com discovery + inference.</p>
            </div>
          ) : null}

          {tab === "permissions" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Permissions</h3>
              <p className="paneHint">Decide what Ares does on its own vs. what it asks you first. Applies on the next turn.</p>
              <div className="engineRow">
                <div className="engineInfo">
                  <strong>Act freely (no prompts)</strong>
                  <span>Ares acts on everything without asking — files, commands, web, even sensitive actions. Off = guarded (sensitive asks).</span>
                </div>
                <button className="toggle" data-on={permissions.mode === "free" ? "1" : "0"}
                  onClick={() => onPermissions({ ...permissions, mode: permissions.mode === "free" ? "guarded" : "free" })}>
                  <i />
                </button>
              </div>
              {(["fileWrite", "shell", "network", "sensitive"] as const).map((cat) => {
                const meta = {
                  fileWrite: ["Auto-approve file writes", "Create/edit files without asking."],
                  shell: ["Auto-approve shell commands", "Run terminal commands without asking."],
                  network: ["Auto-approve web & network", "Fetch pages and call the web without asking."],
                  sensitive: ["Auto-approve sensitive actions", "Credentials, payments, email, destructive, computer control. Off by default — these ask."],
                }[cat];
                const on = permissions.mode === "free" ? true : permissions[cat];
                return (
                  <div className="engineRow" key={cat} data-dim={permissions.mode === "free" ? "1" : "0"}>
                    <div className="engineInfo">
                      <strong>{meta[0]}</strong>
                      <span>{meta[1]}</span>
                    </div>
                    <button className="toggle" data-on={on ? "1" : "0"} disabled={permissions.mode === "free"}
                      onClick={() => onPermissions({ ...permissions, [cat]: !permissions[cat] })}>
                      <i />
                    </button>
                  </div>
                );
              })}
              <div className="engineRow">
                <div className="engineInfo">
                  <strong>Fleets inherit my permissions</strong>
                  <span>Background agents (ULTRA fleets) act on what you've allowed. Off = fleets can only read, never act.</span>
                </div>
                <button className="toggle" data-on={permissions.fleetsInherit ? "1" : "0"}
                  onClick={() => onPermissions({ ...permissions, fleetsInherit: !permissions.fleetsInherit })}>
                  <i />
                </button>
              </div>
            </div>
          ) : null}

          {tab === "advanced" ? (
            <div className="settingsPane">
              <h3 className="paneTitle">Advanced</h3>
              <p className="paneHint">Run-tuning knobs. Most apply on the next turn; the toggle and intervals apply live.</p>
              <EngineRow label="Max agent turns" hint="Hard ceiling on tool-calling rounds before Ares stops." value={draft.engine.maxTurns ?? 80} onChange={(v) => setEngine({ maxTurns: v })} />
              <EngineRow label="Gather-stall rounds" hint="Consecutive gather-only rounds before the deliver-now nudge." value={draft.engine.gatherStallRounds ?? 10} onChange={(v) => setEngine({ gatherStallRounds: v })} />
              <EngineRow label="Tool result char cap" hint="Max chars of a tool result fed back to the model." value={draft.engine.toolResultChars ?? 24000} onChange={(v) => setEngine({ toolResultChars: v })} />
              <EngineRow label="Subagent turn limit" hint="Max turns a delegated subagent may take." value={draft.engine.subagentTurnLimit ?? 50} onChange={(v) => setEngine({ subagentTurnLimit: v })} />
              <div className="engineRow">
                <div className="engineInfo">
                  <strong>Operator auto-tick</strong>
                  <span>Advance durable missions while the daemon idles.</span>
                </div>
                <button className="toggle" data-on={draft.engine.operatorAutotick !== false ? "1" : "0"} onClick={() => setEngine({ operatorAutotick: !(draft.engine.operatorAutotick !== false) })}>
                  <i />
                </button>
              </div>
              <EngineRow label="Auto-tick interval (min)" hint="Minutes between idle mission ticks." value={draft.engine.operatorTickMinutes ?? 30} onChange={(v) => setEngine({ operatorTickMinutes: v })} />
              <div className="engineRow">
                <div className="engineInfo">
                  <strong>Desktop control of browser windows</strong>
                  <span>Let Ares drive your real Chrome/Edge with the physical mouse. Off keeps web pages from ever steering your cursor; the sandboxed Browser tool still works either way.</span>
                </div>
                <button className="toggle" data-on={draft.engine.computerUseBrowser === true ? "1" : "0"} onClick={() => setEngine({ computerUseBrowser: !(draft.engine.computerUseBrowser === true) })}>
                  <i />
                </button>
              </div>
            </div>
          ) : null}

          {tab === "consciousness" ? (
            <ConsciousnessPane native={native} state={consciousness} network={aresNetwork} onDaemonCommand={onDaemonCommand} />
          ) : null}

          {tab === "updates" ? (
            <div className="settingsPane updatesPane">
              <div className="updatesHead">
                <div>
                  <h3 className="updatesTitle">What's New</h3>
                  <p className="paneHint">Every release, kept here so you can read it any time — not just when the popup flashes by.</p>
                </div>
                <button
                  className="updatesReplay"
                  onClick={() => window.dispatchEvent(new CustomEvent("ares:show-whatsnew"))}
                >
                  Show release popup
                </button>
                <button
                  className="updatesReplay"
                  onClick={() => window.dispatchEvent(new CustomEvent("ares:show-forge-intro"))}
                >
                  Forge tour
                </button>
              </div>
              <div className="updatesList">
                {CHANGELOG.map((e) => (
                  <div key={e.version} className="updatesEntry">
                    <div className="updatesEntryHead">
                      <span className="updatesVer">v{e.version}</span>
                      <span className="updatesEntryTitle">{e.title}</span>
                      <span className="updatesDate">{e.date}</span>
                    </div>
                    <p className="updatesTagline">{e.tagline}</p>
                    <ul className="updatesHighlights">
                      {e.highlights.map((h) => (
                        <li key={h.title}>
                          <span className="updatesIcon" aria-hidden="true">{h.icon}</span>
                          <span><strong>{h.title}</strong> — {h.blurb}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {tab === "about" ? (
            <div className="settingsPane aboutPane">
              <div className="aboutMark" aria-hidden="true" />
              <h3 className="aboutName">ARES</h3>
              <p className="aboutTag">the battle-tested agent</p>
              <div className="aboutGrid">
                <div><span>Version</span><strong>v{APP_VERSION}</strong></div>
                <div><span>Engine</span><strong>queryEngine · 80-turn default</strong></div>
                <div><span>Providers</span><strong>ollama · openai · anthropic · deepseek · openrouter</strong></div>
                <div><span>Daemon</span><strong>{native ? "attached" : "demo mode"}</strong></div>
              </div>
              <p className="paneHint">A general-purpose autonomous agent — elite at coding, research, and durable missions.</p>
            </div>
          ) : null}
        </div>

        <footer className="settingsFooter">
          <span className="settingsFooterHint">Applies live where safe · no session restart</span>
          <button className="primary" onClick={() => onApply(draft, keys)}>
            Apply changes
          </button>
        </footer>
      </div>
    </div>
  );
}

const SERVICE_PROVIDERS = [
  { id: "google", label: "Google", desc: "Calendar, Gmail, Contacts" },
  { id: "spotify", label: "Spotify", desc: "Music playback & playlists" },
  { id: "github", label: "GitHub", desc: "Repos, issues, PRs" },
  { id: "discord", label: "Discord", desc: "Guilds & messages" },
  { id: "reddit", label: "Reddit", desc: "Posts & messages" },
  { id: "notion", label: "Notion", desc: "Pages & databases" },
  { id: "slack", label: "Slack", desc: "Channels & messages" },
  { id: "todoist", label: "Todoist", desc: "Tasks & projects" },
  { id: "twitch", label: "Twitch", desc: "Streams & subscriptions" },
  { id: "linkedin", label: "LinkedIn", desc: "Profile & connections" },
  { id: "dropbox", label: "Dropbox", desc: "Files & sharing" },
];

interface HubSkillMeta { id: string; name: string; description: string; author?: string; provides?: string[]; downloads?: number }

// SkillHub browser — search the doingteam registry and install skills. Gated on
// `reachable` (from the daemon's probe) so it stays a quiet "coming soon" line
// until the backend is live rather than dead-ending. Talks to the daemon via
// commands + window-event responses (bridged in the app-level handler).
function SkillHubBrowser({ onDaemonCommand }: { onDaemonCommand: (cmd: Record<string, unknown>) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HubSkillMeta[]>([]);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");

  useEffect(() => {
    const onList = (e: Event) => {
      const d = (e as CustomEvent).detail as { reachable?: boolean; skills?: HubSkillMeta[] };
      setReachable(d.reachable ?? false);
      setResults(Array.isArray(d.skills) ? d.skills : []);
      setBusy(false);
    };
    const onInstalled = (e: Event) => {
      const d = (e as CustomEvent).detail as { ok?: boolean; name?: string; error?: string };
      setInstalling(null);
      setNote(d.ok ? `Installed ${d.name} — enable it above.` : `Install failed: ${d.error ?? "unknown"}`);
      window.setTimeout(() => setNote(""), 4000);
    };
    window.addEventListener("ares:skillhub_list", onList);
    window.addEventListener("ares:skillhub_installed", onInstalled);
    return () => { window.removeEventListener("ares:skillhub_list", onList); window.removeEventListener("ares:skillhub_installed", onInstalled); };
  }, []);

  // Probe once on mount.
  useEffect(() => { setBusy(true); onDaemonCommand({ type: "skillhub_list", text: "" }); }, [onDaemonCommand]);

  const search = () => { setBusy(true); onDaemonCommand({ type: "skillhub_list", text: query }); };
  const install = (id: string) => { setInstalling(id); onDaemonCommand({ type: "skillhub_install", id }); };

  if (reachable === false) {
    return <p className="paneHint">🌐 SkillHub — the shared skill registry on doingteam. Not live yet; when it is, you'll browse and one-click install community skills right here.</p>;
  }
  return (
    <div className="skillHub">
      <div className="skillHubHead">
        <strong>🌐 SkillHub</strong>
        <span className="paneHint">Browse & install skills the community published.</span>
      </div>
      <div className="skillHubSearch">
        <input className="txt" placeholder="Search skills — e.g. spotify, weather, video…" value={query}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") search(); }} />
        <button className="btn" onClick={search} disabled={busy}>{busy ? "…" : "Search"}</button>
      </div>
      {note ? <div className="skillHubNote">{note}</div> : null}
      {results.length === 0 ? (
        <div className="paneEmpty">{busy ? "Searching the hub…" : "No skills found. Try another search."}</div>
      ) : (
        <div className="skillHubGrid">
          {results.map((s) => (
            <div key={s.id} className="skillHubCard">
              <div className="skillHubCardHead">
                <strong>{s.name}</strong>
                {(s.provides ?? []).map((p) => <span key={p} className="skillHubTag">{p}</span>)}
              </div>
              <p>{s.description}</p>
              <div className="skillHubCardFoot">
                <span>{s.author ? `by ${s.author}` : ""}{typeof s.downloads === "number" ? ` · ${s.downloads}↓` : ""}</span>
                <button className="btn tiny" onClick={() => install(s.id)} disabled={installing === s.id}>
                  {installing === s.id ? "Installing…" : "Install"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The active-skills dock — a floating, animated tray. Core voice controls (a
// living orb reflecting idle/listening/speaking, quick on/off, conversation
// mode) sit alongside buttons that enabled skills contribute via their
// `surfaces` manifest. A surface can only invoke its own skill.
function SkillDock({
  voiceEnabled,
  onToggleVoice,
  speaking,
  listening,
  convoMode,
  onToggleConvo,
  wakeWord,
  wakeStatus,
  onToggleWake,
  onStopVoice,
  providerLabel,
  skills,
  onSurface,
  toast,
  voiceEngine,
  onRepairVoice,
}: {
  voiceEnabled: boolean;
  onToggleVoice: (on: boolean) => void;
  speaking: boolean;
  listening: boolean;
  convoMode: boolean;
  onToggleConvo: (on: boolean) => void;
  wakeWord: boolean;
  wakeStatus: "off" | "arming" | "armed" | "offline";
  onToggleWake: (on: boolean) => void;
  onStopVoice: () => void;
  providerLabel: string;
  skills: SkillInfo[];
  onSurface: (skill: SkillInfo, surface: SkillSurface) => void;
  toast: { name: string; text: string; ok: boolean } | null;
  voiceEngine: { phase: string; detail: string };
  onRepairVoice: () => void;
}) {
  const [open, setOpen] = useState(false);
  const withSurfaces = skills.filter((s) => s.enabled && (s.surfaces?.length ?? 0) > 0);
  const orbState = speaking ? "speaking" : listening ? "listening" : voiceEnabled ? "ready" : "off";
  const surfaceCount = withSurfaces.reduce((n, s) => n + (s.surfaces?.length ?? 0), 0);
  const wakeSuffix = !wakeWord
    ? ""
    : voiceEngine.phase === "error" || voiceEngine.phase === "missing"
      ? " · offline"
      : voiceEngine.phase !== "running"
        ? " · warming up…"
        : wakeStatus === "armed"
          ? " · listening"
          : wakeStatus === "arming"
            ? " · connecting…"
            : "";

  return (
    <div className="skillDock" data-open={open ? "1" : "0"}>
      {toast ? <div className="skillDockToast" data-ok={toast.ok ? "1" : "0"}>{toast.text}</div> : null}
      {open ? (
        <div className="skillDockPanel">
          <div className="skillDockHead">
            <strong>Voice</strong>
            <span className="skillDockProvider">{providerLabel}</span>
          </div>
          <div className="skillDockRow">
            <button className="skillDockBtn" data-on={voiceEnabled ? "1" : "0"} onClick={() => onToggleVoice(!voiceEnabled)}>
              {voiceEnabled ? "🔊 Speaking on" : "🔇 Speak replies"}
            </button>
            <button className="skillDockBtn" data-on={convoMode ? "1" : "0"} disabled={!voiceEnabled} onClick={() => onToggleConvo(!convoMode)}>
              💬 Conversation
            </button>
            <button className="skillDockBtn" data-on={wakeWord ? "1" : "0"} onClick={() => onToggleWake(!wakeWord)} title="Say “Hey Ares”, then just talk — it sends when you stop.">
              👂 Hey Ares{wakeSuffix}
            </button>
            {speaking ? <button className="skillDockBtn stop" onClick={onStopVoice}>⏹ Stop</button> : null}
          </div>
          {(wakeWord && wakeStatus === "offline") || voiceEngine.phase === "setup" || voiceEngine.phase === "starting" || voiceEngine.phase === "error" || voiceEngine.phase === "missing" ? (
            voiceEngine.phase === "setup" || voiceEngine.phase === "starting" ? (
              <p className="skillDockHint">
                <span className="skillDockSpin" aria-hidden="true" /> {voiceEngine.detail || "Setting up the local voice engine…"}
              </p>
            ) : voiceEngine.phase === "error" ? (
              <p className="skillDockHint warn">
                {voiceEngine.detail || "The local voice engine hit a problem."}{" "}
                <button className="skillDockRepair" onClick={onRepairVoice}>Repair</button>
              </p>
            ) : voiceEngine.phase === "missing" ? (
              <p className="skillDockHint warn">{voiceEngine.detail || "The voice service files aren't in this install."}</p>
            ) : (
              <p className="skillDockHint warn">
                Connecting to the local voice engine — “Hey Ares” will arm itself the moment it's up.{" "}
                <button className="skillDockRepair" onClick={onRepairVoice}>Repair</button>
              </p>
            )
          ) : null}
          {withSurfaces.length > 0 ? (
            <>
              <div className="skillDockHead"><strong>Skills</strong><span className="skillDockProvider">{surfaceCount} action{surfaceCount === 1 ? "" : "s"}</span></div>
              <div className="skillDockSurfaces">
                {withSurfaces.map((s) => (s.surfaces ?? []).map((surf) => (
                  <button key={`${s.name}:${surf.id}`} className="skillDockSurface" title={surf.hint ?? s.description} onClick={() => onSurface(s, surf)}>
                    <span className="skillDockIcon" aria-hidden="true">{surf.icon ?? "✦"}</span>
                    <span>{surf.label}</span>
                  </button>
                )))}
              </div>
            </>
          ) : (
            <p className="skillDockHint">Enabled skills that declare buttons appear here.</p>
          )}
        </div>
      ) : null}
      <button className="skillDockOrb" data-state={orbState} onClick={() => setOpen((v) => !v)} title="Voice & skills" aria-label="Voice and skills">
        <span className="skillDockOrbCore" />
        {(speaking || listening) ? <span className="skillDockOrbPulse" /> : null}
      </button>
    </div>
  );
}

// Live health of the local voice engine + one honest Repair button. Repair
// wipes and rebuilds the Python venv (the fix for a setup that half-installed
// on an incompatible Python and crash-looped).
function VoiceEngineStatus({ voiceEngine, onRepair }: { voiceEngine: { phase: string; detail: string }; onRepair: () => void }) {
  const phase = voiceEngine.phase;
  const tone = phase === "running" ? "ok" : phase === "setup" || phase === "starting" ? "busy" : phase === "error" || phase === "missing" ? "warn" : "idle";
  const label =
    phase === "running" ? "Voice engine running"
    : phase === "starting" ? "Starting the voice engine…"
    : phase === "setup" ? (voiceEngine.detail || "Setting up the voice engine…")
    : phase === "error" ? (voiceEngine.detail || "The voice engine hit a problem.")
    : phase === "missing" ? (voiceEngine.detail || "The voice service isn't installed.")
    : "Voice engine idle";
  const busy = phase === "setup" || phase === "starting";
  return (
    <div className="voiceEngineStatus" data-tone={tone}>
      <span className="voiceEngineDot" data-tone={tone}>{busy ? <i className="skillDockSpin" /> : null}</span>
      <span className="voiceEngineLabel">{label}</span>
      {phase !== "running" && phase !== "missing" ? (
        <button className="voiceEngineRepair" disabled={busy} onClick={onRepair}>{busy ? "Working…" : "Repair"}</button>
      ) : null}
    </div>
  );
}

// The Voice Hub — enable spoken replies, pick a voice from the local sidecar's
// catalog (or a TTS-provider skill once registered), and set the rate. Applies
// live via onLivePref so the toggle takes effect without a session restart.
function VoiceSettings({
  draft,
  setDraftPrefs,
  onLivePref,
  providerSkill,
  onPreviewVoice,
  listProviderVoices,
}: {
  draft: Prefs;
  setDraftPrefs: (p: Prefs) => void;
  onLivePref: (patch: Partial<Prefs>) => void;
  providerSkill?: SkillInfo;
  onPreviewVoice?: (voiceId: string) => void;
  listProviderVoices?: () => Promise<VoiceInfo[]>;
}) {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [defaultVoice, setDefaultVoice] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "offline">("loading");

  useEffect(() => {
    const ac = new AbortController();
    // When a provider skill is the active voice engine, its catalog IS the
    // picker — you choose among the voices that will actually speak. The
    // sidecar catalog is the fallback.
    if (listProviderVoices) {
      let cancelled = false;
      void listProviderVoices().then((provided) => {
        if (cancelled) return;
        if (provided.length > 0) {
          setVoices(provided);
          setDefaultVoice(provided[0]?.id ?? "");
          setStatus("ready");
        } else {
          fetchVoices(ac.signal).then(({ voices, default: def }) => {
            setVoices(voices);
            setDefaultVoice(def);
            setStatus(voices.length ? "ready" : "offline");
          });
        }
      });
      return () => { cancelled = true; ac.abort(); };
    }
    fetchVoices(ac.signal).then(({ voices, default: def }) => {
      setVoices(voices);
      setDefaultVoice(def);
      setStatus(voices.length ? "ready" : "offline");
    });
    return () => ac.abort();
  }, [listProviderVoices]);

  const setEnabled = (on: boolean) => {
    // On first enable with no chosen voice, adopt the sidecar default so it
    // speaks immediately instead of silently doing nothing.
    const voiceId = draft.voiceId || defaultVoice || voices[0]?.id || "";
    const patch: Partial<Prefs> = { voiceEnabled: on, voiceId };
    setDraftPrefs({ ...draft, ...patch });
    onLivePref(patch);
  };
  const pickVoice = (id: string) => { setDraftPrefs({ ...draft, voiceId: id }); onLivePref({ voiceId: id }); };
  const setSpeed = (n: number) => { setDraftPrefs({ ...draft, voiceSpeed: n }); onLivePref({ voiceSpeed: n }); };

  return (
    <div className="voiceHub">
      <label className="fieldLabel">Voice — speak replies aloud</label>
      <div className="displayModes">
        <button data-on={draft.voiceEnabled ? "1" : "0"} onClick={() => setEnabled(true)}>
          <strong>On</strong>
          <span>Ares reads its replies aloud (emoji, markdown &amp; code stripped).</span>
        </button>
        <button data-on={!draft.voiceEnabled ? "1" : "0"} onClick={() => setEnabled(false)}>
          <strong>Off</strong>
          <span>Text only.</span>
        </button>
      </div>
      <p className="paneHint">
        {status === "loading" ? "Checking the local voice engine…"
          : status === "offline" && providerSkill ? `Using ${providerSkill.name} for speech. Built-in local voice is offline, but replies still speak through the skill.`
          : status === "offline" ? "Local voice engine offline. A TTS-provider skill can also supply voices."
          : `${voices.length} voice${voices.length === 1 ? "" : "s"} · local (Kokoro), private & offline`}
      </p>
      {status === "ready" ? (
        <>
          <label className="fieldLabel">Voice{providerSkill ? ` — via ${providerSkill.name}` : ""}</label>
          <div className="voiceGrid">
            {voices.map((v) => (
              <div key={v.id} className="voiceCard" data-on={(draft.voiceId || defaultVoice) === v.id ? "1" : "0"} title={v.character}>
                <button className="voiceCardPick" onClick={() => pickVoice(v.id)}>
                  <strong>{v.label}</strong>
                  <em>{[v.accent, v.gender].filter(Boolean).join(" · ")}{v.id === defaultVoice ? " · recommended" : ""}</em>
                </button>
                {onPreviewVoice ? (
                  <button className="voicePreview" title={`Hear ${v.label}`} aria-label={`Preview ${v.label}`} onClick={() => onPreviewVoice(v.id)}>
                    ▶
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <label className="fieldLabel">Speed — {(draft.voiceSpeed ?? 1).toFixed(2)}×</label>
          <input
            className="voiceSpeed"
            type="range" min={0.5} max={2} step={0.05}
            value={draft.voiceSpeed ?? 1}
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
        </>
      ) : null}
      <label className="fieldLabel">Hands-free</label>
      <div className="displayModes">
        <button
          data-on={draft.wakeWord ? "1" : "0"}
          onClick={() => { const on = !draft.wakeWord; setDraftPrefs({ ...draft, wakeWord: on }); onLivePref({ wakeWord: on }); }}
        >
          <strong>“Hey Ares” wake word</strong>
          <span>Say it, then speak — Ares listens, and sends the moment you stop talking. Local &amp; private.</span>
        </button>
        <button
          data-on={draft.voiceNotify !== false ? "1" : "0"}
          onClick={() => { const on = draft.voiceNotify === false; setDraftPrefs({ ...draft, voiceNotify: on }); onLivePref({ voiceNotify: on }); }}
        >
          <strong>Spoken heads-up</strong>
          <span>When a background task finishes while you're away, Ares says so out loud.</span>
        </button>
      </div>
    </div>
  );
}

function ServicesPane({
  native,
  providers,
  onDaemonCommand,
}: {
  native: boolean;
  providers: OAuthProviderVm[];
  onDaemonCommand: (cmd: Record<string, unknown>) => void;
}) {
  const [setupFor, setSetupFor] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // Fetch live status whenever the pane mounts.
  useEffect(() => {
    if (native) onDaemonCommand({ type: "oauth_status" });
  }, [native]);

  // Stop the connecting spinner once the provider reports connected.
  useEffect(() => {
    if (pending && providers.find((p) => p.id === pending)?.connected) setPending(null);
  }, [providers, pending]);

  const byId = (id: string) => providers.find((p) => p.id === id);

  const connect = (id: string) => {
    setPending(id);
    onDaemonCommand({ type: "oauth_start", provider: id });
    // Safety: clear the spinner after the flow's own timeout window.
    setTimeout(() => setPending((p) => (p === id ? null : p)), 60_000);
  };
  const disconnect = (id: string) => onDaemonCommand({ type: "oauth_disconnect", provider: id });
  const saveCredentials = (id: string) => {
    if (!clientId.trim() || !clientSecret.trim()) return;
    onDaemonCommand({ type: "oauth_set_credentials", provider: id, clientId: clientId.trim(), clientSecret: clientSecret.trim() });
    setSetupFor(null); setClientId(""); setClientSecret("");
  };

  return (
    <div className="settingsPane">
      <h3 className="paneTitle">Connected Services</h3>
      <p className="paneHint">
        Sign in so Ares can manage your calendar, play music, send emails, and more — through YOUR account.
        {!native && " (Connect to the daemon to manage services.)"}
      </p>
      <div className="servicesGrid">
        {SERVICE_PROVIDERS.map((svc) => {
          const p = byId(svc.id);
          const connected = p?.connected ?? false;
          const hasApp = p?.hasApp ?? false;
          const isPending = pending === svc.id;
          return (
            <div key={svc.id} className="serviceCard" data-connected={connected ? "1" : "0"}>
              <div className="serviceInfo">
                <strong>{svc.label}</strong>
                <span>{svc.desc}</span>
              </div>
              <div className="serviceActions">
                {connected ? (
                  <>
                    <span className="serviceStatus connected">Connected</span>
                    <button className="ghost small" onClick={() => disconnect(svc.id)} disabled={!native}>Disconnect</button>
                  </>
                ) : isPending ? (
                  <span className="serviceStatus" style={{ color: "var(--bronze-hi)" }}>Authorizing…</span>
                ) : hasApp ? (
                  <button className="primary small" onClick={() => connect(svc.id)} disabled={!native}>Connect</button>
                ) : (
                  <button className="ghost small" onClick={() => setSetupFor(setupFor === svc.id ? null : svc.id)} disabled={!native}>
                    {setupFor === svc.id ? "Cancel" : "Set up app"}
                  </button>
                )}
              </div>
              {setupFor === svc.id ? (
                <div className="serviceSetup">
                  <p className="paneHint">
                    Register an OAuth app on {svc.label}'s developer console, set the redirect URI to
                    <code> http://localhost:53691/oauth/callback</code>, then paste its credentials:
                  </p>
                  <input className="keyInput" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                  <input className="keyInput" placeholder="Client Secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
                  <button className="primary small" onClick={() => saveCredentials(svc.id)} disabled={!clientId.trim() || !clientSecret.trim()}>Save credentials</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="paneHint" style={{ marginTop: "1rem" }}>
        Connecting opens your browser to sign in — Ares acts through your real account, never a bot.
        You can also connect from Telegram with /connect. Browser-only services (DoorDash, Amazon, OpenTable)
        work through Ares's browser automation — no sign-in needed.
      </p>
    </div>
  );
}

function AnthropicSignIn({
  status,
  error,
  browser,
  url,
  onRetry,
  onClose,
}: {
  status: "idle" | "opening" | "waiting" | "done" | "error";
  error?: string;
  browser?: "opening" | "opened" | "failed";
  url?: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  const browserFailed = browser === "failed";
  return (
    <div className="scrim center" onClick={onClose}>
      <div className="authModal" onClick={(e) => e.stopPropagation()}>
        <div className="authModalMark" aria-hidden="true" />
        <h3>Sign in with Claude</h3>
        {status === "done" ? (
          <p className="authOk">✓ Signed in — reconnecting the Garrison…</p>
        ) : status === "error" ? (
          <>
            <p className="authErr">{error ?? "Sign-in failed."}</p>
            <div className="authActions">
              <button className="ghost" onClick={onClose}>Cancel</button>
              <button className="primary" onClick={onRetry}>Try again</button>
            </div>
          </>
        ) : (
          <>
            <p className="authModalHint">
              {browserFailed
                ? "Use your Claude Pro or Max subscription — no API key, no per-token billing. Ares could not open your browser, so open the link below yourself; the sign-in still completes automatically once you approve."
                : "Use your Claude Pro or Max subscription — no API key, no per-token billing. Approve access in the browser window that just opened and you'll be signed in automatically."}
            </p>
            <ol className="authSteps">
              <li data-on={browser === "opened" ? "1" : "0"} data-failed={browserFailed ? "1" : undefined}>
                {browserFailed ? "Could not open your browser" : browser === "opened" ? "Browser opened to Claude" : "Opening your browser…"}
              </li>
              <li data-on={status === "waiting" ? "1" : "0"}>Approve access</li>
              <li data-on="0">Signing in automatically…</li>
            </ol>
            {browserFailed && url ? (
              <p className="authModalHint authManualUrl">
                <span>Open this URL manually:</span>
                <code>{url}</code>
              </p>
            ) : null}
            <div className="authActions">
              <button className="ghost" onClick={onRetry}>Reopen browser</button>
              <button className="ghost" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ConsciousnessPane({
  native,
  state,
  network,
  onDaemonCommand,
}: {
  native: boolean;
  state: ConsciousnessVm;
  network: AresNetworkVm;
  onDaemonCommand: (cmd: Record<string, unknown>) => void;
}) {
  const [netUrl, setNetUrl] = useState(network.url);
  const [netToken, setNetToken] = useState("");
  useEffect(() => {
    if (network.url && !netUrl) setNetUrl(network.url);
  }, [network.url, netUrl]);
  const readyCount = state.models.filter((m) => m.present).length;
  const totalCount = state.models.length || 3;
  const phase = !state.enabled
    ? "Dormant"
    : state.downloading
      ? "Awakening…"
      : state.paused
        ? "Looking away"
        : state.ready
          ? "Awake"
          : "Enabled";
  const toggle = () =>
    onDaemonCommand({ type: state.enabled ? "consciousness_disable" : "consciousness_enable" });

  return (
    <div className="settingsPane">
      <h3 className="paneTitle">Consciousness</h3>
      <p className="paneHint">
        An embedded local brain that watches the screen and powers memory — it runs <em>inside</em> Ares,
        with no provider, key, or network. Awakening pulls its models once (~600&nbsp;MB): a tiny vision
        model (the eyes) and an embedding model (vector memory).
      </p>

      <div className="consciousHead">
        <div>
          <span className="consciousPhase" data-awake={state.ready ? "1" : "0"} data-on={state.enabled ? "1" : "0"}>
            {phase}
          </span>
          <span className="paneHint"> · {readyCount}/{totalCount} models ready</span>
        </div>
        <div className="consciousBtns">
          {state.downloading ? (
            <button className="provChip" disabled={!native} onClick={() => onDaemonCommand({ type: "consciousness_cancel" })}>
              Cancel
            </button>
          ) : null}
          <button className="provChip" data-on={state.enabled ? "1" : "0"} disabled={!native || state.downloading} onClick={toggle}>
            {state.enabled ? "Make dormant" : "Awaken"}
          </button>
        </div>
      </div>

      {state.models.length > 0 || state.enabled ? (
        <div className="consciousModels">
          {state.models.map((m) => {
            const pct = m.present ? 100 : state.progress[m.id] ?? 0;
            const right = m.present ? "ready" : state.downloading ? `${pct}%` : `${(m.bytes / 1048576).toFixed(0)} MB`;
            return (
              <div key={m.id} className="consciousModel">
                <div className="consciousModelHead">
                  <span>{m.label}</span>
                  <span className="paneHint">{right}</span>
                </div>
                <div className="updateBanner__bar">
                  <div className="updateBanner__barFill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          {state.enabled ? (
            (() => {
              const epct = state.engineInstalled ? 100 : state.progress.engine ?? 0;
              const right = state.engineInstalled ? "installed" : state.downloading ? `${epct}%` : "~16 MB";
              return (
                <div className="consciousModel">
                  <div className="consciousModelHead">
                    <span>Vision engine (llama.cpp)</span>
                    <span className="paneHint">{right}</span>
                  </div>
                  <div className="updateBanner__bar">
                    <div className="updateBanner__barFill" style={{ width: `${epct}%` }} />
                  </div>
                </div>
              );
            })()
          ) : null}
        </div>
      ) : null}

      {state.error ? <p className="paneHint" style={{ color: "var(--crimson)" }}>{state.error}</p> : null}

      {state.enabled ? (
        <div className="consciousWatch">
          <div className="consciousModelHead">
            <strong>The eyes</strong>
            <span className="paneHint">
              {state.paused
                ? "looking away"
                : state.engineAvailable
                  ? state.watching
                    ? "watching"
                    : "ready"
                  : state.engineInstalled
                    ? "engine present, models pending"
                    : "engine not installed"}
            </span>
          </div>
          {!state.engineInstalled ? (
            <p className="paneHint">
              The local vision engine binary isn't installed yet. Drop a <code>llama-mtmd-cli</code> build into{" "}
              <code>&lt;home&gt;/engine</code> (or set <code>ARES_LLAMA_MTMD</code>) and the eyes open — no other change needed.
            </p>
          ) : null}
          {state.lastComment ? (
            <p className="consciousRemark">“{state.lastComment}”</p>
          ) : state.lastObservation ? (
            <p className="paneHint">Watching quietly · last read: {state.lastObservation}</p>
          ) : null}
          <div className="consciousBtns" style={{ marginTop: 12 }}>
            {state.paused ? (
              <button className="provChip" data-on="1" disabled={!native} onClick={() => onDaemonCommand({ type: "consciousness_resume" })}>
                Resume
              </button>
            ) : (
              <button className="provChip" disabled={!native || !state.watching} onClick={() => onDaemonCommand({ type: "consciousness_look_away", seconds: 300 })}>
                Look away (5 min)
              </button>
            )}
            <button className="provChip" data-danger="1" disabled={!native} onClick={() => onDaemonCommand({ type: "consciousness_killswitch" })}>
              Killswitch
            </button>
          </div>
        </div>
      ) : null}

      <p className="paneHint">
        Local + private: screen frames are read by the on-device model and never leave the machine. It stays silent
        unless something's genuinely worth a word.
      </p>

      <div className="consciousWatch" style={{ marginTop: 18 }}>
        <div className="consciousModelHead">
          <strong>Ares Network</strong>
          <span className="paneHint">
            {network.busy
              ? "syncing…"
              : network.connected
                ? `connected · ${network.records ?? "?"} records · ${network.writers ?? "?"} writers`
                : network.enabled
                  ? "reconnecting…"
                  : network.configured
                    ? "off"
                    : "not connected"}
          </span>
        </div>
        <p className="paneHint">
          One memory for every Ares: the Oricle estate hosted on your server. Connecting pulls the whole estate
          here, then every session on this machine uploads as it happens and every other instance's memories
          arrive within a minute. Same memory on the desktop, on Telegram, on the laptop — and it survives any
          model, machine, or version of Ares.
        </p>
        {!network.libFound ? (
          <p className="paneHint" style={{ color: "var(--crimson)" }}>
            The Oricle library isn't installed on this machine (expected at D:\Oricle\dist or ARES_ORICLE_LIB).
          </p>
        ) : null}
        <div className="consciousBtns" style={{ marginTop: 8, flexWrap: "wrap", gap: 8 }}>
          <input
            className="keyInput"
            style={{ flex: "1 1 260px", minWidth: 200 }}
            placeholder="https://memory.yourdomain.com"
            value={netUrl}
            disabled={!native || network.busy}
            onChange={(ev) => setNetUrl(ev.target.value)}
            spellCheck={false}
          />
          <input
            className="keyInput"
            style={{ flex: "1 1 200px", minWidth: 160 }}
            type="password"
            placeholder={network.configured ? "token (saved)" : "network token"}
            value={netToken}
            disabled={!native || network.busy}
            onChange={(ev) => setNetToken(ev.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="consciousBtns" style={{ marginTop: 8 }}>
          <button
            className="provChip"
            data-on={network.connected ? "1" : "0"}
            disabled={!native || network.busy || !netUrl.trim() || (!netToken.trim() && !network.configured)}
            onClick={() => onDaemonCommand({ type: "ares_network_connect", url: netUrl.trim(), token: netToken.trim() || undefined })}
          >
            {network.connected ? "Reconnect" : "Connect to Ares Network"}
          </button>
          <button className="provChip" disabled={!native || network.busy || !network.connected} onClick={() => onDaemonCommand({ type: "ares_network_sync" })}>
            Sync now
          </button>
          {network.enabled ? (
            <button className="provChip" data-danger="1" disabled={!native || network.busy} onClick={() => onDaemonCommand({ type: "ares_network_disconnect" })}>
              Disconnect
            </button>
          ) : null}
        </div>
        {network.connected || network.lastSyncAt ? (
          <p className="paneHint">
            {network.estateName ? `${network.estateName} (${network.estateId ?? ""})` : network.estateId ?? ""}
            {network.estateDir ? ` · local copy ${network.estateDir}` : ""}
            {network.lastSyncAt ? ` · last sync ${new Date(network.lastSyncAt).toLocaleTimeString()} (+${network.lastPushed ?? 0} up, +${network.lastPulled ?? 0} down)` : ""}
            {typeof network.totalPushed === "number" ? ` · session total ${network.totalPushed} up / ${network.totalPulled ?? 0} down` : ""}
          </p>
        ) : null}
        {network.error ? <p className="paneHint" style={{ color: "var(--crimson)" }}>{network.error}</p> : null}

        <div className="consciousModelHead" style={{ marginTop: 14 }}>
          <strong>Host the network from this machine</strong>
          <span className="paneHint">{network.hosting?.active ? "hosting" : network.hosting ? "on · starts with the garrison" : "off"}</span>
        </div>
        <p className="paneHint">
          Turn this on for the machine that stays up (the laptop server). Its tunneled origin then answers the
          network under <code>/oricle</code> — same domain, one token that only you hold. Other machines paste
          that URL and token above.
        </p>
        <div className="consciousBtns" style={{ marginTop: 6 }}>
          <button
            className="provChip"
            data-on={network.hosting ? "1" : "0"}
            disabled={!native}
            onClick={() => onDaemonCommand({ type: "ares_network_host", enabled: !network.hosting })}
          >
            {network.hosting ? "Stop hosting" : "Host here"}
          </button>
        </div>
        {network.hosting?.active ? (
          <p className="paneHint" style={{ userSelect: "text" }}>
            {network.hosting.estateName ? `${network.hosting.estateName} · ` : ""}
            URL: <code>{network.hosting.url ?? "(waiting for the tunnel)"}</code>
            {network.hosting.token ? (
              <>
                {" "}· token: <code>{network.hosting.token}</code>
              </>
            ) : null}
          </p>
        ) : null}
        {network.hosting?.error ? <p className="paneHint" style={{ color: "var(--crimson)" }}>{network.hosting.error}</p> : null}
      </div>
    </div>
  );
}

function EngineRow({
  label,
  hint,
  value,
  onChange,
  min = 1,
  max = 1_000_000,
  step = 1,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="engineRow">
      <div className="engineInfo">
        <strong>{label}</strong>
        <span>{hint}</span>
      </div>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          // Ignore empty/NaN (a cleared field shouldn't silently become 0 and
          // hobble the agent) and clamp to the knob's safe range.
          const raw = Number(e.target.value);
          if (e.target.value === "" || !Number.isFinite(raw)) return;
          onChange(Math.min(max, Math.max(min, Math.round(raw))));
        }}
      />
    </div>
  );
}

function UsagePane({ usage, onDaemonCommand, native }: { usage: UsageStats | null; onDaemonCommand: (cmd: Record<string, unknown>) => void; native: boolean }) {
  const [range, setRange] = useState(30);
  const maxDay = useMemo(() => Math.max(1, ...(usage?.daily ?? []).map((d) => d.in + d.out)), [usage]);
  return (
    <div className="settingsPane">
      <div className="usageHead">
        <h3 className="paneTitle">Usage</h3>
        <div className="segment mini">
          {[7, 30, 90].map((d) => (
            <button key={d} data-on={range === d ? "1" : "0"} onClick={() => { setRange(d); if (native) onDaemonCommand({ type: "usage_stats", days: d }); }}>
              {d}d
            </button>
          ))}
        </div>
      </div>
      {!usage ? (
        <div className="paneEmpty">{native ? "Loading usage…" : "Usage history needs the daemon."}</div>
      ) : (
        <>
          {/* One question first: what did it cost. Everything else supports it
              (owner, 2026-10-23: "usage looks trash"). */}
          <div className="usageHero">
            <span>Spent in the last {range} days</span>
            <strong>{fmtSpend(usage)}</strong>
            <em>an estimate from each provider's list prices</em>
          </div>
          <div className="usageStats">
            <div className="usageCard"><strong>{usage.sessions.toLocaleString()}</strong><span>chats</span></div>
            <div className="usageCard"><strong>{usage.apiCalls.toLocaleString()}</strong><span>model calls</span></div>
            <div className="usageCard" title="Input the models had not seen before. This is what you pay full price for."><strong>{fmtTokens(Math.max(0, usage.tokensIn - usage.cacheReadTokens))}</strong><span>tokens read</span></div>
            <div className="usageCard" title="What the models wrote."><strong>{fmtTokens(usage.tokensOut)}</strong><span>tokens written</span></div>
          </div>
          {usage.cacheReadTokens > 0 ? (
            <p className="usageNote">Plus {fmtTokens(usage.cacheReadTokens)} re-read from cache. Every call re-reads the conversation; cached re-reads cost a fraction, so they barely move the total.</p>
          ) : null}
          {usage.daily.length > 0 ? (
            <div className="usageBlock">
              <div className="usageBlockHead"><b>Tokens per day</b><em>busiest: {fmtTokens(maxDay)}</em></div>
              <div className="usageChart">
                {usage.daily.map((d) => (
                  <div key={d.date} className="usageBar" title={`${d.date}: ${fmtTokens(d.in)} read · ${fmtTokens(d.out)} written`}>
                    <span className="barIn" style={{ height: `${Math.max(2, ((d.in + d.out) / maxDay) * 100)}%` }} />
                  </div>
                ))}
              </div>
              <div className="usageAxis"><span>{usage.daily[0]!.date.slice(5)}</span><span>{usage.daily.at(-1)!.date.slice(5)}</span></div>
            </div>
          ) : null}
          {(() => {
            const share = (cost: number | undefined, tokens: number, all: Array<{ cost?: number; tokens: number }>) => {
              const costs = all.map((x) => x.cost ?? 0);
              const totalCost = costs.reduce((a, b) => a + b, 0);
              if (totalCost > 0) return ((cost ?? 0) / totalCost) * 100;
              const totalTok = all.reduce((a, x) => a + x.tokens, 0) || 1;
              return (tokens / totalTok) * 100;
            };
            const providers = (usage.providers ?? []).map((p) => ({ key: p.provider, name: p.provider, sub: `${p.calls.toLocaleString()} calls`, cost: p.costUsd, tokens: Math.max(0, p.tokensIn - p.cacheReadTokens) + p.tokensOut }));
            const models = usage.models.slice(0, 8).map((m) => ({ key: `${m.provider ?? ""}/${m.model}`, name: m.model, sub: `${m.provider ? `${m.provider} · ` : ""}${m.calls.toLocaleString()} calls`, cost: m.costUsd, tokens: Math.max(0, m.tokensIn - m.cacheReadTokens) + m.tokensOut }));
            const block = (title: string, rows: typeof providers) => rows.length === 0 ? null : (
              <div className="usageBlock">
                <div className="usageBlockHead"><b>{title}</b></div>
                {rows.map((r) => (
                  <div key={r.key} className="usageRow">
                    <div className="usageRowText"><strong>{r.name}</strong><em>{r.sub} · {fmtTokens(r.tokens)} tokens</em></div>
                    <span className="usageCost" data-unpriced={r.cost === undefined ? "1" : "0"} title={r.cost === undefined ? "No list price for this one (a subscription, a local model, or a price Ares doesn't know), so it isn't in the total." : undefined}>{r.cost !== undefined ? `$${r.cost.toFixed(2)}` : "no price"}</span>
                    <div className="usageShare"><i style={{ width: `${Math.max(1.5, share(r.cost, r.tokens, rows))}%` }} /></div>
                  </div>
                ))}
              </div>
            );
            return <>{block("By provider", providers)}{block("Top models", models)}</>;
          })()}
        </>
      )}
    </div>
  );
}

// ─── Mount ─────────────────────────────────────────────────────────────────

class AresErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error?: Error }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface the failure in a controlled way instead of letting the WebView
    // show the generic "Something went wrong" crash page.
    console.error("Ares UI crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="errorBoundary">
          <div className="errorBoundaryMark" aria-hidden="true"></div>
          <h2>Ares hit a rendering problem</h2>
          <p>{this.state.error?.message ?? "Something went wrong."}</p>
          <button onClick={() => this.setState({ hasError: false, error: undefined })} className="primary">
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function PresenceOverlay() {
  const [presence, setPresence] = useState<PresenceSnapshot>({ visible: false, mode: "idle", caption: "", detail: "" });

  useEffect(() => {
    document.body.dataset.presence = "1";
    let disposed = false;
    void invoke<PresenceSnapshot>("ares_presence_status")
      .then((snapshot) => { if (!disposed && snapshot) setPresence(snapshot); })
      .catch(() => null);
    let unlisten: (() => void) | null = null;
    void listen<PresenceSnapshot>("ares:presence-state", (event) => {
      if (!disposed && event.payload) setPresence(event.payload);
    }).then((un) => { if (disposed) un(); else unlisten = un; });
    return () => {
      disposed = true;
      unlisten?.();
      delete document.body.dataset.presence;
    };
  }, []);

  const stateLabel = presence.mode === "listening"
    ? "HEARING"
    : presence.mode === "speaking"
      ? "ARES"
      : presence.mode === "working"
        ? "WORKING"
        : "HEARD";
  return (
    <div className="presenceSurface" data-mode={presence.mode} data-visible={presence.visible ? "1" : "0"}>
      <div className="presenceEdge" aria-hidden="true" />
      {presence.caption ? (
        <div className="desktopCaption" aria-live="off">
          <span className="desktopCaptionState"><i aria-hidden="true" />{stateLabel}</span>
          <span className="desktopCaptionText">{presence.caption}</span>
          {presence.detail ? <span className="desktopCaptionDetail">{presence.detail}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

// Catch top-level runtime errors and promise rejections so a single bad event
// or effect doesn't hard-crash the WebView renderer.
window.addEventListener("error", (e) => {
  console.error("Ares unhandled error:", e.error);
  e.preventDefault();
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("Ares unhandled rejection:", e.reason);
  e.preventDefault();
});

const rootEl = document.getElementById("root");
if (rootEl) {
  const query = new URLSearchParams(window.location.search);
  const isPresenceSurface = query.get("presence") === "1";
  const livingHash = window.location.hash.match(/^#living\/([a-z0-9_-]+)$/i);
  const isLivingSurface = query.get("living") === "1" || Boolean(livingHash);
  const livingSessionId = livingHash?.[1] || query.get("session") || `sess_living_${Date.now()}`;
  if (isPresenceSurface) document.body.dataset.presence = "1";
  // Vite HMR re-evaluates this module — reuse the root across hot reloads.
  const holder = window as unknown as { __aresRoot?: ReturnType<typeof createRoot> };
  holder.__aresRoot ??= createRoot(rootEl);
  holder.__aresRoot.render(
    isPresenceSurface
      ? <PresenceOverlay />
      : isLivingSurface
        ? <AresErrorBoundary><LivingSurface sessionId={livingSessionId} /></AresErrorBoundary>
        : <AresErrorBoundary><App /></AresErrorBoundary>,
  );
}
