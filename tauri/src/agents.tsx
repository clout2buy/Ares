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
import { convertFileSrc } from "@tauri-apps/api/core";
import { playRig, POSE_SCRIPTS, poseStateOf, type PoseName, type RigState } from "./avatarRig";

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

/** Pose frames by agent id (file paths, rendered by the daemon after a new
 *  picture is set): what the base animation script plays for that avatar. */
export const AgentPosesContext = createContext<Record<string, Partial<Record<PoseName, string>>>>({});

/** Living clips by agent id: one seamless video loop per state (idle,
 *  thinking, working, creating), rendered once per picture by the daemon. */
export const AgentClipsContext = createContext<Record<string, Partial<Record<string, string>>>>({});

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

/**
 * The agent's buddy (owner, 2026-10-24): an Ares ember, our own mascot next to
 * Grok's ball, Muse's plush and Dots' blobs. It is a small flame in the
 * agent's colour, lit by SVG lighting filters so it reads as a soft 3D model
 * rather than a flat drawing, with a warm core and glossy eyes. Its build,
 * eyes, brows, mouth and the odd extra (blush, specs, a stray spark) come from
 * the seed, so each agent always looks like itself.
 * Idle it breathes, blinks and glances left and right; working, it sways and
 * its eyes read back and forth while sparks rise. Motion is transform-only and
 * nothing changes brightness (photosensitive doctrine).
 */
export function AgentBuddy({ seed, color, busy }: { seed: string; color: string; busy?: boolean }) {
  const h = hashOf(seed);
  // FNV's low bits barely move between similar names; scramble before picking
  let h2 = hashOf(`${seed}~`);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 0x45d9f3b);
  h2 = (Math.imul(h2 ^ (h2 >>> 16), 0x45d9f3b) ^ (h2 >>> 16)) >>> 0;
  const sx = 0.92 + (h % 4) * 0.05; // slim .. chubby
  const tipY = 6 + ((h >>> 2) % 4) * 3.5; // tall flame .. short
  const tipX = 56 + ((h >>> 4) % 3) * 3; // how far the tip curls over
  const tongue = 26 + ((h >>> 6) % 4) * 5; // the side flame: tall .. just a shoulder
  const flip = ((h >>> 9) & 1) === 1 ? -1 : 1; // which side it curls to
  const eyes = h2 % 6; // 0 tall ovals · 1 shiny rounds · 2 happy arcs · 3 sleepy · 4 small dots · 5 wink
  const brows = (h2 >>> 3) % 5; // 0 none · 1 determined · 2 raised · 3 worried · 4 none
  const mouth = (h2 >>> 6) % 6; // 0 none · 1 smile · 2 o · 3 smirk · 4 fang grin · 5 cat
  const blush = ((h2 >>> 9) & 1) === 1;
  const specs = (h2 >>> 10) % 6 === 0;
  const sparks = (h2 >>> 13) % 3 === 0;
  const blinkDelay = ((h >>> 15) % 50) / 10;
  const lookDelay = ((h2 >>> 16) % 60) / 10;
  const id = `e${h.toString(36)}`;
  const ink = "#15131c";
  const bottom = 86;
  const w = 28 * sx;
  // one flame, drawn curling right and mirrored by `flip`: a round belly, a
  // small tongue off one shoulder, and the main tip curling over the top
  const body = `M50 ${bottom}C31 ${bottom} 22 75 22 61C22 49 25 ${tongue + 9} 29 ${tongue}C32 ${tongue + 8} 35 42 40 44C39 32 47 ${tipY + 12} ${tipX} ${tipY}C${tipX - 3} ${tipY + 13} 78 36 78 58C78 75 69 ${bottom} 50 ${bottom}Z`;
  const shape = `translate(50 0) scale(${flip * sx} 1) translate(-50 0)`;
  const ey = 61;
  const gap = 9.5 + (sx - 0.92) * 8;
  const glossy = (cx: number, rx: number, ry: number) => (
    <g>
      <ellipse cx={cx} cy={ey} rx={rx} ry={ry} fill={`url(#${id}e)`} />
      <ellipse cx={cx + rx * 0.3} cy={ey - ry * 0.42} rx={rx * 0.34} ry={ry * 0.26} fill="#fff" opacity=".9" />
    </g>
  );
  const eye = (cx: number, side: -1 | 1) => {
    if (eyes === 5 && side === 1) return <path d={`M${cx - 4.4} ${ey + 0.5}Q${cx} ${ey - 4} ${cx + 4.4} ${ey + 0.5}`} stroke={ink} strokeWidth="3" fill="none" strokeLinecap="round" />;
    switch (eyes) {
      case 0: return glossy(cx, 3.8, 6.4);
      case 1: case 5: return glossy(cx, 5.2, 5.6);
      case 2: return <path d={`M${cx - 4.6} ${ey + 1.6}Q${cx} ${ey - 4.4} ${cx + 4.6} ${ey + 1.6}`} stroke={ink} strokeWidth="3.2" fill="none" strokeLinecap="round" />;
      case 3: return <path d={`M${cx - 4.8} ${ey - 1}h9.6a4.8 4.8 0 0 1-9.6 0Z`} fill={ink} />;
      default: return glossy(cx, 3.1, 3.4);
    }
  };
  const brow = (cx: number, side: -1 | 1) => {
    const y = ey - (eyes === 0 ? 10.5 : 9);
    if (brows === 1) return <path d={`M${cx - 4 * side} ${y - 1.6}L${cx + 4 * side} ${y + 1.2}`} />;
    if (brows === 2) return <path d={`M${cx - 4} ${y}Q${cx} ${y - 3.2} ${cx + 4} ${y}`} />;
    if (brows === 3) return <path d={`M${cx - 4 * side} ${y + 1.2}L${cx + 4 * side} ${y - 1.6}`} />;
    return null;
  };
  const my = ey + 9;
  const mouthEl =
    mouth === 1 ? <path d={`M46 ${my - 1}Q50 ${my + 3} 54 ${my - 1}`} stroke={ink} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      : mouth === 2 ? <ellipse cx="50" cy={my} rx="2.3" ry="2.6" fill={ink} />
        : mouth === 3 ? <path d={`M46.5 ${my}Q51 ${my + 2} 54.5 ${my - 2}`} stroke={ink} strokeWidth="2.2" fill="none" strokeLinecap="round" />
          : mouth === 4 ? <g><path d={`M45 ${my - 1.5}H55Q54 ${my + 4} 50 ${my + 4}Q46 ${my + 4} 45 ${my - 1.5}Z`} fill={ink} /><path d={`M47 ${my - 1.5}l1 2.4 1-2.4Z`} fill="#fff" /></g>
            : mouth === 5 ? <path d={`M46 ${my - 1}Q48 ${my + 2} 50 ${my - 1}Q52 ${my + 2} 54 ${my - 1}`} stroke={ink} strokeWidth="2" fill="none" strokeLinecap="round" />
              : null;
  return (
    <svg viewBox="9 6 82 82" className="agentFace agentBuddy" data-busy={busy ? "1" : "0"} aria-hidden="true" style={{ ["--blink-delay" as string]: `${blinkDelay}s`, ["--look-delay" as string]: `${lookDelay}s` }}>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: `color-mix(in srgb, ${color} 12%, #fbfbfd)` }} />
          <stop offset="100%" style={{ stopColor: `color-mix(in srgb, ${color} 30%, #e9ebf0)` }} />
        </linearGradient>
        <radialGradient id={`${id}b`} cx="40%" cy="45%" r="70%">
          <stop offset="0%" style={{ stopColor: `color-mix(in srgb, ${color} 72%, white)` }} />
          <stop offset="60%" stopColor={color} />
          <stop offset="100%" style={{ stopColor: `color-mix(in srgb, ${color} 75%, black)` }} />
        </radialGradient>
        <radialGradient id={`${id}c`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fff3d6" stopOpacity=".7" />
          <stop offset="100%" stopColor="#fff3d6" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}e`} cx="40%" cy="35%" r="75%">
          <stop offset="0%" stopColor="#3a3548" />
          <stop offset="100%" stopColor="#0d0b12" />
        </radialGradient>
        {/* the 3D: a blurred height map of the body, lit from the top left */}
        <filter id={`${id}p`} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="hgt" />
          <feDiffuseLighting in="hgt" surfaceScale="7" diffuseConstant="1.15" lightingColor="#fff" result="dif">
            <feDistantLight azimuth="235" elevation="48" />
          </feDiffuseLighting>
          <feComposite in="dif" in2="SourceAlpha" operator="in" result="difIn" />
          <feBlend in="SourceGraphic" in2="difIn" mode="multiply" result="shaded" />
          <feSpecularLighting in="hgt" surfaceScale="7" specularConstant=".85" specularExponent="22" lightingColor="#fff" result="spc">
            <fePointLight x="30" y="18" z="70" />
          </feSpecularLighting>
          <feComposite in="spc" in2="SourceAlpha" operator="in" result="spcIn" />
          <feComposite in="shaded" in2="spcIn" operator="arithmetic" k1="0" k2="1" k3=".75" k4="0" />
        </filter>
      </defs>
      <rect x="0" y="0" width="100" height="100" fill={`url(#${id}g)`} />
      <ellipse className="buddyShadow" cx="50" cy={bottom + 3} rx={w * 0.7} ry="3" fill="#14161e" opacity=".18" style={{ transformOrigin: `50px ${bottom + 3}px` }} />
      <g className="buddyBody" style={{ transformOrigin: `50px ${bottom}px` }}>
        <g filter={`url(#${id}p)`}>
          <path d={body} fill={`url(#${id}b)`} transform={shape} />
        </g>
        <ellipse cx="50" cy="73" rx={w * 0.55} ry="10" fill={`url(#${id}c)`} />
        <g className="buddyFace">
          <g className="agentFaceEyes">
            <g className="agentFaceLids" style={{ transformOrigin: `50px ${ey}px` }}>{eye(50 - gap, -1)}{eye(50 + gap, 1)}</g>
          </g>
          {brows % 4 ? <g stroke={ink} strokeWidth="2" strokeLinecap="round" fill="none">{brow(50 - gap, -1)}{brow(50 + gap, 1)}</g> : null}
          {specs ? <g fill="none" stroke={ink} strokeWidth="1.6" opacity=".85"><circle cx={50 - gap} cy={ey} r="7.6" /><circle cx={50 + gap} cy={ey} r="7.6" /><path d={`M${50 - gap + 7.6} ${ey - 1}Q50 ${ey - 3} ${50 + gap - 7.6} ${ey - 1}`} /></g> : null}
          {blush ? <g fill="#ff6b8a" opacity=".4"><ellipse cx={50 - gap - 5.5} cy={ey + 6.5} rx="3.8" ry="2.3" /><ellipse cx={50 + gap + 5.5} cy={ey + 6.5} rx="3.8" ry="2.3" /></g> : null}
          {mouthEl ? <g className="agentFaceMouth" style={{ transformOrigin: `50px ${my}px` }}>{mouthEl}</g> : null}
        </g>
      </g>
      {sparks || busy ? (
        <g className="buddySparks" style={{ fill: `color-mix(in srgb, ${color} 40%, #ffd27a)` }}>
          <circle cx={flip > 0 ? 76 : 24} cy="40" r="1.8" />
          <circle cx={flip > 0 ? 70 : 30} cy="30" r="1.3" />
          <circle cx={flip > 0 ? 80 : 20} cy="24" r="1" />
        </g>
      ) : null}
    </svg>
  );
}

/** A file the daemon made (a path on disk) or one shipped with the app ("/…"). */
const assetUrl = (p: string) => (p.startsWith("/") && !p.startsWith("//") && !/^\/[a-z]:/i.test(p) ? p : convertFileSrc(p));

/** The default flame guy (owner, 2026-10-24): one 3D ember mascot whose pose
 *  frames and living clips ship with the app (public/buddy). Every agent
 *  without a photo plays it, tinted to its own colour. */
const BASE_POSES: Partial<Record<PoseName, string>> = Object.fromEntries(
  (["blink", "look_left", "look_right", "thinking", "thinking_b", "working", "working_b", "creating", "creating_b"] as PoseName[]).map((p) => [p, `/buddy/${p}.jpg`]),
);
const BASE_CLIPS: Partial<Record<string, string>> = Object.fromEntries(["idle", "thinking", "working", "creating"].map((s) => [s, `/buddy/clip_${s}.mp4`]));
/** Rotate the flame's orange (about 24deg of hue) to the agent's colour. */
function hueShift(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round(h * 60 - 24);
}

/** A photo that comes alive: the base pose script plays the avatar's own
 *  frames (blink, glances, chin-tap, typing, shaping), stacked and swapped in
 *  place, with the gentle tier-0 breath underneath. Frames missing for a pose
 *  hold the still. */
function PosedPhoto({ src, poses, clips, busy, activity, hue }: { src: string; poses: Partial<Record<PoseName, string>>; clips?: Partial<Record<string, string>>; busy?: boolean; activity?: string; hue?: number }) {
  const stage = useRef<HTMLDivElement | null>(null);
  const state = poseStateOf(busy, activity);
  const [frame, setFrame] = useState<{ on: PoseName; prev: PoseName; fade: number }>({ on: "rest", prev: "rest", fade: 0 });
  const urls = useMemo(() => {
    const out: Partial<Record<PoseName, string>> = { rest: src };
    for (const [k, v] of Object.entries(poses)) if (v) out[k as PoseName] = assetUrl(v);
    return out;
  }, [src, poses]);
  useEffect(() => (stage.current ? playRig(stage.current, busy ? "working" : "idle") : undefined), [busy]);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const script = POSE_SCRIPTS[state];
    let i = 0;
    let timer = 0;
    const step = () => {
      const [name, ms, fade] = script[i % script.length]!;
      const next = urls[name] ? name : "rest";
      setFrame((f) => (f.on === next ? f : { on: next, prev: f.on, fade }));
      i += 1;
      timer = window.setTimeout(step, ms);
    };
    step();
    return () => window.clearTimeout(timer);
  }, [state, urls]);
  // the state's living clip, once it has loaded, plays over the frames
  const clip = clips?.[state];
  const clipUrl = useMemo(() => (clip ? assetUrl(clip) : undefined), [clip]);
  const [clipReady, setClipReady] = useState<string | undefined>(undefined);
  const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  return (
    <div ref={stage} className="posedPhoto" data-clip={clipUrl && clipReady === clipUrl ? "1" : "0"} style={{ ["--fade" as string]: `${frame.fade}ms`, ...(hue ? { filter: `hue-rotate(${hue}deg)` } : {}) }}>
      {clipUrl && !still ? <video key={clipUrl} className="posedClip" src={clipUrl} muted loop autoPlay playsInline preload="auto" onCanPlay={() => setClipReady(clipUrl)} /> : null}
      {(Object.entries(urls) as Array<[PoseName, string]>).map(([name, url]) => (
        <img key={name} src={url} alt="" draggable={false} data-on={name === frame.on ? "1" : "0"} data-prev={name === frame.prev && name !== frame.on ? "1" : "0"} />
      ))}
    </div>
  );
}

/** A photo that moves: the rig's tier-0 clip for `state` plays on the whole
 *  picture (see avatarRig.ts). */
function RiggedPhoto({ src, state }: { src: string; state: RigState }) {
  const ref = useRef<HTMLImageElement | null>(null);
  useEffect(() => (ref.current ? playRig(ref.current, state) : undefined), [state]);
  return <img ref={ref} src={src} alt="" draggable={false} />;
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
  activity,
}: {
  agent: Pick<AgentVm, "id" | "name" | "emoji" | "color"> | null;
  size?: number;
  busy?: boolean;
  unread?: boolean;
  title?: string;
  /** Override the stored photo (the editor's live preview); "" forces none. */
  photo?: string;
  /** The live activity line, which picks the pose loop (thinking, working, creating). */
  activity?: string;
}) {
  const photos = useContext(AgentPhotoContext);
  const allPoses = useContext(AgentPosesContext);
  const allClips = useContext(AgentClipsContext);
  const isAres = !agent || agent.id === ARES_AGENT_ID;
  const id = agent?.id ?? ARES_AGENT_ID;
  const color = isAres ? "#c8794a" : agent!.color ?? AGENT_COLORS[0]!;
  const src = photo !== undefined ? photo : photos[id];
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
          photo === undefined && allPoses[id] ? <PosedPhoto src={src} poses={allPoses[id]!} clips={allClips[id]} busy={busy} activity={activity} /> : <RiggedPhoto src={src} state={busy ? "working" : "idle"} />
        ) : isAres ? (
          <svg viewBox="0 0 24 24" aria-hidden="true" className="agentAresMark">
            <path d="M12 2.5 20 7v10l-8 4.5L4 17V7Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M12 6.5 16.5 9v6L12 17.5 7.5 15V9Z" fill="currentColor" opacity=".9" />
          </svg>
        ) : (
          <PosedPhoto src="/buddy/rest.jpg" poses={BASE_POSES} clips={BASE_CLIPS} busy={busy} activity={activity} hue={hueShift(color)} />
        )}
      </span>
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
            <p>{existing ? "Their own memory, their own Forge, their own model." : "Someone you can text. They remember your chats and can build things for you."}</p>
          </div>
          <button className="agentClose" onClick={onClose} aria-label="Close">×</button>
        </header>


        {/* New people get one clear path (owner, 2026-10-23: "confusing for new
            people"): pick a starting point, name them, say their job, pick a
            look. The model is already chosen; the rest folds under More options. */}
        {!existing ? (
          <div className="agentStart">
            <span className="agentStepLabel">Start from</span>
            <div className="agentTemplates">
              {AGENT_TEMPLATES.map((t) => (
                <button key={t.name} className="agentTemplate" data-on={draft.instructions === t.role ? "1" : "0"} title={t.role} onClick={() => setDraft((d) => ({ ...d, name: d.name.trim() && !AGENT_TEMPLATES.some((x) => x.name === d.name.trim()) ? d.name : takenNames.includes(t.name) ? d.name : t.name, emoji: t.emoji, color: t.color, instructions: t.role }))}>
                  <span>{t.emoji}</span>
                  {t.name}
                </button>
              ))}
            </div>
            <em className="agentFieldHint">Tap one to fill everything in, or start blank and write your own.</em>
          </div>
        ) : null}

        <label className="agentField">
          <span>Name</span>
          <input ref={nameRef} value={draft.name} maxLength={40} placeholder="e.g. Bob" spellCheck={false} onChange={(e) => set("name", e.target.value)} />
          {nameClash ? <em className="agentFieldErr">{draft.name.trim().toLowerCase() === "ares" ? "Ares is the default agent" : "That name is taken"}</em> : null}
        </label>

        <label className="agentField">
          <span>What's their job?</span>
          <textarea
            value={draft.instructions}
            rows={4}
            maxLength={4000}
            placeholder="Brief them like you'd brief a person. e.g. You're my finance guy. Keep me posted when I get charged for anything over $50."
            onChange={(e) => set("instructions", e.target.value)}
          />
          <em className="agentFieldHint">Plain words are fine. You can change it any time, or just tell them in chat.</em>
        </label>

        <div className="agentField">
          <span>Look</span>
          <div className="agentSwatches">
            {AGENT_COLORS.map((c) => (
              <button key={c} data-on={draft.color === c ? "1" : "0"} style={{ background: c }} onClick={() => set("color", c)} aria-label={`colour ${c}`} />
            ))}
          </div>
          <div className="agentEmojiGrid">
            {(showIdeas ? AGENT_EMOJI : AGENT_EMOJI.slice(0, 11)).map((e) => (
              <button key={e} data-on={draft.emoji === e ? "1" : "0"} onClick={() => set("emoji", draft.emoji === e ? "" : e)} aria-label={`badge ${e}`}>{e}</button>
            ))}
            <button className="agentEmojiMore" onClick={() => setShowIdeas((v) => !v)}>{showIdeas ? "Less" : "More"}</button>
          </div>
          <div className="agentPhotoRow">
            <button className="agentGhost" onClick={() => fileRef.current?.click()}>{shownPhoto ? "Choose another photo" : "Upload a photo instead"}</button>
            {shownPhoto ? <button className="agentGhost" onClick={() => set("photo", "")}>Remove photo</button> : null}
          </div>
          {photoErr ? <em className="agentFieldErr">{photoErr}</em> : null}
        </div>

        <div className="agentFieldRow">
          <label className="agentField">
            <span>Thinks with</span>
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

        <details className="agentMore" open={Boolean(existing && (draft.effort || draft.chatModel || draft.rules || draft.workspaceId))}>
          <summary>More options</summary>

          <label className="agentField">
            <span>Effort</span>
            <select value={draft.effort} onChange={(e) => set("effort", e.target.value)}>
              <option value="">Same as everyone (the global dial)</option>
              {AGENT_EFFORTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <em className="agentFieldHint">How hard they think before answering. Higher is smarter and slower.</em>
          </label>

          <label className="agentField">
            <span>Standing rules, one per line</span>
            <textarea
              value={draft.rules}
              rows={3}
              maxLength={6000}
              placeholder={"In group chats, keep it to one line\nAlways @ the person you're answering"}
              onChange={(e) => set("rules", e.target.value)}
            />
            <em className="agentFieldHint">{draft.name.trim() || "They"} follow these in every chat and room. Saying "from now on…" in chat adds one here.</em>
          </label>

          <label className="agentField">
            <span>Model in group chats</span>
            <input value={draft.chatModel} maxLength={160} spellCheck={false} placeholder={draft.provider === "anthropic" ? "claude-haiku-5-5 (fast default)" : `${draft.model || "same as above"}`} onChange={(e) => set("chatModel", e.target.value)} />
            <em className="agentFieldHint">A faster model for chatting in rooms; real work still uses the one above. Leave empty for the default.</em>
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
        </details>

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
/** Under the input bar: this agent's provider, model and effort, changeable
 *  in place. Each pick saves to the agent (same as editing it), so it sticks.
 *  A new provider only saves together with one of its models: picking it
 *  opens that provider's model list, and closing without a pick keeps both. */
export function AgentComposerMeta({
  agent,
  providers,
  requestCatalog,
  onChange,
}: {
  agent: AgentVm;
  providers: string[];
  requestCatalog: (provider: string) => void;
  onChange: (patch: { provider?: string; model?: string; reasoningLevel?: string }) => void;
}) {
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const provider = pendingProvider ?? agent.provider;
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    setModels([]);
    const onCatalog = (ev: Event) => {
      const detail = (ev as CustomEvent<{ provider?: string; models?: Array<{ id?: string }> }>).detail;
      if (detail?.provider !== provider) return;
      setModels((detail.models ?? []).map((m) => String(m.id ?? "")).filter(Boolean));
    };
    window.addEventListener("ares:model-catalog", onCatalog);
    if (provider) requestCatalog(provider);
    return () => window.removeEventListener("ares:model-catalog", onCatalog);
  }, [provider, requestCatalog]);
  const options = pendingProvider ? models : [...new Set([agent.model, ...models])].filter(Boolean);
  const effort = agent.reasoningLevel ?? "";
  const efforts: Array<[string, string]> = [["", "Default"], ...AGENT_EFFORTS];
  const providerList = [...new Set([agent.provider, ...providers])].filter(Boolean);
  const [open, setOpenState] = useState<"provider" | "model" | "effort" | null>(null);
  const setOpen = (next: typeof open | ((o: typeof open) => typeof open)) => {
    setOpenState((o) => {
      const value = typeof next === "function" ? next(o) : next;
      if (value !== "model") setPendingProvider(null);
      return value;
    });
  };
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const pickProvider = (p: string) => {
    if (p === agent.provider) { setOpen(null); return; }
    setOpenState("model");
    setPendingProvider(p);
  };
  const pickModel = (m: string) => {
    onChange(pendingProvider ? { provider: pendingProvider, model: m } : { model: m });
    setOpen(null);
  };
  const rows: Array<[string, string]> = open === "provider" ? providerList.map((p): [string, string] => [p, p])
    : open === "model" ? options.map((m): [string, string] => [m, m])
    : efforts;
  return (
    <div className="composerMeta" ref={boxRef}>
      <button type="button" className="composerPick" data-open={open === "provider" ? "1" : "0"} onClick={() => setOpen((o) => (o === "provider" ? null : "provider"))} title={`Where ${agent.name}'s model runs`}>
        <span>provider</span>{agent.provider || "—"}
      </button>
      <i className="composerMetaDot" aria-hidden="true" />
      <button type="button" className="composerPick" data-open={open === "model" ? "1" : "0"} onClick={() => setOpen((o) => (o === "model" ? null : "model"))} title={`${agent.name}'s model (${agent.provider})`}>
        <span>model</span>{agent.model || "—"}
      </button>
      <i className="composerMetaDot" aria-hidden="true" />
      <button type="button" className="composerPick" data-open={open === "effort" ? "1" : "0"} onClick={() => setOpen((o) => (o === "effort" ? null : "effort"))} title={`How hard ${agent.name} thinks before answering`}>
        <span>effort</span>{efforts.find(([v]) => v === effort)?.[1] ?? effort}
      </button>
      {open ? (
        <div className="composerMenu" role="listbox" data-kind={open}>
          {open === "model" && pendingProvider ? <div className="composerMenuHead">Pick a {pendingProvider} model</div> : null}
          {open === "model" && rows.length === 0 ? <div className="composerMenuHead">Loading models…</div> : null}
          {rows.map(([v, label]) => {
            const on = open === "provider" ? v === agent.provider : open === "model" ? !pendingProvider && v === agent.model : v === effort;
            return (
              <button type="button" role="option" aria-selected={on} key={v || "default"} data-on={on ? "1" : "0"} onClick={() => (open === "provider" ? pickProvider(v) : open === "model" ? pickModel(v) : (onChange({ reasoningLevel: v }), setOpen(null)))}>
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

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
