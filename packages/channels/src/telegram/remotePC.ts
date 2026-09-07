// Remote PC Telegram flow — lets the owner ask Ares to help with someone else's
// PC on the fly. The owner says "my friend needs help with his pc" → Ares sends
// a link → the owner forwards it → the friend clicks it, a tiny connector
// downloads and runs → the PC dials home → Ares texts the owner "Connected to
// SARAH-LAPTOP" and a quiet "Ares Connected" popup fades in on Sarah's screen.
// No confirmation tap: the owner asked for the link, the link is one-time, and
// the point is to be inside as fast as possible.
//
// From then on the owner drives from Telegram (or the desktop) — "find his
// project, fix the build error" — via the RemotePC tool.

/** What the bridge needs from the remote agent server layer.
 *  Injected at garrison startup; absent in test / standalone contexts → graceful
 *  degradation (the bridge just doesn't offer the remote-PC flow). */
export interface RemotePcBridgeDeps {
  /** Generate a one-time connect link. `scope` says whether it reaches the
   *  internet (tunnel) or only this LAN — the owner must be told the latter. */
  generateToken: (label: string) => Promise<{ url: string; scope: "public" | "lan" }>;
  /** All currently registered (but perhaps not yet "activated") remote PCs. */
  listPcs: () => Array<{ id: string; hostname: string; os: string; label: string; ip: string }>;
  /** Execute a shell command on a connected PC. */
  exec: (pcId: string, command: string) => Promise<{ output: string; exitCode?: number }>;
  /** Push a popup notification to a connected PC. */
  notify: (pcId: string, message: string) => void;
  /** Drop a PC's connection (the owner tapped Disconnect). */
  disconnect?: (pcId: string) => void;
  /** Subscribe to PC connect events; returns an unsubscribe function. */
  onPcConnected: (cb: (pc: { id: string; hostname: string; os: string; label: string; ip: string }) => void) => () => void;
  /** Subscribe to PC disconnect events; returns an unsubscribe function. */
  onPcDisconnected: (cb: (pc: { id: string; hostname: string }) => void) => () => void;
}

// ─── Intent detection ──────────────────────────────────────────────────────

/**
 * Fast path for phrasings that can ONLY mean "someone else's machine": the slash
 * command, or a possessive + device word ("at Sarah's PC", "connect to Dave's
 * laptop", "a coworker's computer"). Returns null for everything else.
 *
 * Deliberately narrow. A match here short-circuits the message — it never
 * reaches the agent — so a false positive turns "my deploy isn't working" into
 * a remote-connect link instead of help. Vaguer asks ("my friend needs help",
 * "IT shadowing") fall through to the agent, which has the RemotePC tool's
 * generate_link action and the judgment to use it.
 */
export function detectRemotePcIntent(text: string): { label: string } | null {
  const t = text.trim();

  // Slash command: /remote-pc [name] or /pc [name]
  const slashMatch = /^\/(?:remote[-_]?pc|pc)(?:\s+([\s\S]+))?$/i.exec(t);
  if (slashMatch) {
    const label = slashMatch[1]?.trim() || "coworker's PC";
    return { label: /'s pc$/i.test(label) ? label : `${label}'s PC` };
  }

  const DEVICE = "(?:pc|computer|laptop|machine|workstation|desktop)";
  const PERSON = "(?:coworker|colleague|friend|buddy|teammate|neighbou?r|boss|client)";
  const NAME = "(\\w[\\w'-]*(?:\\s+\\w[\\w'-]*)?)";
  const POSSESSIVE = "(?:'|’)s";
  // A captured name must be capitalised — "the server's PC" is a common noun, not a person.
  const named = (m: RegExpExecArray) => (/^[A-Z]/.test(m[1]) ? `${m[1]}'s PC` : null);
  const patterns: Array<[RegExp, (m: RegExpExecArray) => string | null]> = [
    // "I'm at / on / connect to / remote into a coworker's PC"
    [new RegExp(`\\b(?:at|on|to|into)\\s+(?:a\\s+|my\\s+)?${PERSON}${POSSESSIVE}?\\s+${DEVICE}\\b`, "i"), () => "coworker's PC"],
    // "I'm at / on / connect to / remote into Sarah's PC"
    [new RegExp(`\\b(?:at|on|to|into)\\s+${NAME}${POSSESSIVE}\\s+${DEVICE}\\b`, "i"), named],
    // "Sarah's laptop isn't working / won't boot / keeps crashing"
    [new RegExp(`\\b${NAME}${POSSESSIVE}\\s+${DEVICE}\\s+(?:isn'?t|is\\s+not|won'?t|doesn'?t|keeps?|has\\s+(?:an?\\s+)?(?:issue|problem))\\b`, "i"), named],
  ];

  for (const [re, labelFn] of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    const label = labelFn(m);
    if (label) return { label };
  }
  return null;
}

// ─── Callback data keys ────────────────────────────────────────────────────

export const REMOTEPC_DISCONNECT_PREFIX = "ares:remotepc:disconnect:";

export function parseRemotePcCallback(data: string): { action: "disconnect"; pcId: string } | null {
  if (data.startsWith(REMOTEPC_DISCONNECT_PREFIX)) {
    return { action: "disconnect", pcId: data.slice(REMOTEPC_DISCONNECT_PREFIX.length) };
  }
  return null;
}

// ─── Message builders ──────────────────────────────────────────────────────

/** Text sent to the owner after they trigger a remote PC connection. The link
 *  goes on its own line so Telegram renders it as one tappable, forwardable unit. */
export function buildLinkMessage(label: string, url: string, scope: "public" | "lan" = "public"): string {
  const lines = [
    `Here's the link for ${label} — forward it to them:`,
    "",
    url,
    "",
    "They tap it, run the download, and I'm in. No install, no account. I'll message you here the moment their PC connects.",
    "",
    "Link is one-time and expires in 10 minutes.",
  ];
  if (scope === "lan") {
    lines.push(
      "",
      "⚠️ This link only works on your local network — I couldn't open a tunnel to the internet. If they're somewhere else, tell me to \"set up the tunnel\" and I'll fix that.",
    );
  }
  return lines.join("\n");
}

/** Text + inline keyboard sent to the owner the moment a PC dials in and is
 *  connected. One button: Disconnect. */
export function buildPcConnectedMessage(pc: { id: string; hostname: string; os: string; ip: string; label: string; username?: string }): {
  text: string;
  keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const who = pc.username && pc.username !== "unknown" ? ` · ${pc.username}` : "";
  return {
    text: [
      `🟢 Connected to ${pc.label}`,
      `${pc.hostname} · ${pc.os}${who}`,
      "",
      "Tell me what to do — \"find his project and fix the build\", \"check why it's slow\", \"what's eating the disk\". I'll work on their machine and report back here.",
    ].join("\n"),
    keyboard: [[{ text: "Disconnect", callback_data: `${REMOTEPC_DISCONNECT_PREFIX}${pc.id}` }]],
  };
}

/** Contextual prefix injected into garrison session messages when a PC is active. */
export function buildPcContextPrefix(pc: { hostname: string; os: string; ip: string; id: string; label?: string }): string {
  return (
    `[Ares Remote: you are connected to ${pc.label ? `${pc.label} — ` : ""}${pc.hostname} (${pc.os}, ${pc.ip}), ` +
    `PC id="${pc.id}". The owner is helping this person from their phone. Use the RemotePC tool: ` +
    `exec_on_pc to run shell commands on it (explore, diagnose, edit files, build), notify_pc to show them a popup. ` +
    `Work on THEIR machine, not the owner's. Keep replies short — they're read on a phone.]\n\n`
  );
}
