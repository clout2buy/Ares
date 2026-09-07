// Remote PC Telegram flow — lets the owner ask Ares to connect to a coworker's
// PC on the fly. The owner says "I'm at Sarah's PC" → Ares sends a one-time
// download link → Sarah runs the Python script → Ares texts back "I see
// SARAH-LAPTOP, want me to connect? [Yes] [Skip]" → owner taps Yes → a
// transparent "Ares Connected" popup fades in on Sarah's screen.
//
// After connection the owner can tell Ares to run diagnostics, fix things, etc.
// via the remote_pc tool registered with the garrison session.

/** What the bridge needs from the remote agent server layer.
 *  Injected at garrison startup; absent in test / standalone contexts → graceful
 *  degradation (the bridge just doesn't offer the remote-PC flow). */
export interface RemotePcBridgeDeps {
  /** Generate a one-time download link for a remote PC. */
  generateToken: (label: string) => { url: string };
  /** All currently registered (but perhaps not yet "activated") remote PCs. */
  listPcs: () => Array<{ id: string; hostname: string; os: string; label: string; ip: string }>;
  /** Execute a shell command on a connected PC. */
  exec: (pcId: string, command: string) => Promise<{ output: string; exitCode?: number }>;
  /** Push a popup notification to a connected PC. */
  notify: (pcId: string, message: string) => void;
  /** Subscribe to PC connect events; returns an unsubscribe function. */
  onPcConnected: (cb: (pc: { id: string; hostname: string; os: string; label: string; ip: string }) => void) => () => void;
  /** Subscribe to PC disconnect events; returns an unsubscribe function. */
  onPcDisconnected: (cb: (pc: { id: string; hostname: string }) => void) => () => void;
}

// ─── Intent detection ──────────────────────────────────────────────────────

/**
 * Returns a human-readable label like "Sarah's PC" when the message sounds like
 * the owner is sitting at a coworker's machine and needs help. Returns null when
 * the message is ordinary chat.
 */
export function detectRemotePcIntent(text: string): { label: string } | null {
  const t = text.trim();

  // Slash command: /remote-pc [name] or /pc [name]
  const slashMatch = /^\/(?:remote[-_]?pc|pc)(?:\s+([\s\S]+))?$/i.exec(t);
  if (slashMatch) {
    const label = slashMatch[1]?.trim() || "coworker's PC";
    return { label: label.endsWith("'s PC") || label.endsWith("'s pc") ? label : `${label}'s PC` };
  }

  // Natural language — broad set of ways people describe sitting at or helping with someone's machine
  const DEVICE = "(?:pc|computer|laptop|machine|workstation|desktop)";
  const PERSON = "(?:coworker|colleague|friend|buddy|teammate|coworker|neighbour|neighbor|boss|client|guy|girl|person|dude)";
  const NAME   = "(\\w+(?:\\s+\\w+)?)";
  const patterns: Array<[RegExp, (m: RegExpExecArray) => string]> = [
    // "at/on a coworker's/friend's PC"
    [new RegExp(`\\b(?:i'?m?\\s+)?(?:at|on)\\s+(?:a\\s+)?${PERSON}(?:'s)?\\s+${DEVICE}\\b`, "i"), () => "coworker's PC"],
    // "at/on Sarah's PC"
    [new RegExp(`\\b(?:i'?m?\\s+)?(?:at|on)\\s+${NAME}'s\\s+${DEVICE}\\b`, "i"), (m) => `${m[1]}'s PC`],
    // "helping Sarah with her/his/their PC/laptop/issue"
    [new RegExp(`\\bhelping\\s+${NAME}\\s+with\\s+(?:his|her|their|a)?\\s*(?:${DEVICE}|issue|problem|stuff|things?|computer stuff)\\b`, "i"), (m) => `${m[1]}'s PC`],
    // "Sarah needs help / is having trouble / can't ..." — generic help request with a name
    [new RegExp(`\\b${NAME}\\s+(?:needs?\\s+help|is\\s+having\\s+(?:trouble|issues?|problems?)|can'?t|doesn'?t\\s+work|isn'?t\\s+working)\\b`, "i"), (m) => `${m[1]}'s PC`],
    // "my friend/coworker needs help / is having trouble"
    [new RegExp(`\\bmy\\s+${PERSON}\\s+(?:needs?\\s+help|is\\s+having\\s+(?:trouble|issues?|problems?)|can'?t|has\\s+(?:a\\s+)?(?:issue|problem))\\b`, "i"), () => "friend's PC"],
    // "Sarah's PC/laptop isn't working / has issues"
    [new RegExp(`\\b${NAME}'s\\s+${DEVICE}\\s+(?:isn'?t|is\\s+not|won'?t|doesn'?t|has\\s+(?:an?\\s+)?(?:issue|problem)|keeps?)`, "i"), (m) => `${m[1]}'s PC`],
    // "I'm helping my friend/coworker" (no device word needed)
    [new RegExp(`\\b(?:i'?m?\\s+)?helping\\s+(?:a\\s+)?(?:my\\s+)?${PERSON}\\b`, "i"), () => "coworker's PC"],
    // "IT shadowing"
    [/\b(?:it\s+)?shadow(?:ing)?\b/i, () => "shadowing PC"],
    // "remote/connect to a coworker/friend's PC"
    [new RegExp(`\\b(?:remote|connect)\\s+(?:to\\s+)?(?:a\\s+)?(?:my\\s+)?${PERSON}(?:'s)?\\s+${DEVICE}\\b`, "i"), () => "coworker's PC"],
    [new RegExp(`\\bconnect\\s+(?:to\\s+)?${NAME}'s\\s+${DEVICE}\\b`, "i"), (m) => `${m[1]}'s PC`],
  ];

  for (const [re, labelFn] of patterns) {
    const m = re.exec(t);
    if (m) return { label: labelFn(m) };
  }
  return null;
}

// ─── Callback data keys ────────────────────────────────────────────────────

export const REMOTEPC_CONNECT_PREFIX = "ares:remotepc:connect:";
export const REMOTEPC_SKIP_PREFIX = "ares:remotepc:skip:";

export function parseRemotePcCallback(data: string): { action: "connect" | "skip"; pcId: string } | null {
  if (data.startsWith(REMOTEPC_CONNECT_PREFIX)) {
    return { action: "connect", pcId: data.slice(REMOTEPC_CONNECT_PREFIX.length) };
  }
  if (data.startsWith(REMOTEPC_SKIP_PREFIX)) {
    return { action: "skip", pcId: data.slice(REMOTEPC_SKIP_PREFIX.length) };
  }
  return null;
}

// ─── Message builders ──────────────────────────────────────────────────────

/** Text sent to the owner after they trigger a remote PC connection. */
export function buildLinkMessage(label: string, url: string): string {
  return [
    `Got it. To connect Ares to ${label}:`,
    "",
    `1. Open this link on that PC: ${url}`,
    `2. Download and run the Python script (double-click or: python ares-connect.py)`,
    `3. Once it connects I'll let you know here.`,
    "",
    "Link expires in 10 minutes.",
  ].join("\n");
}

/** Text + inline keyboard sent to the owner when a PC dials in. */
export function buildPcSeenMessage(pc: { hostname: string; os: string; ip: string; label: string }): {
  text: string;
  keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    text: [
      `I see ${pc.label} — ${pc.hostname} (${pc.os}, ${pc.ip})`,
      "Want me to connect remotely?",
    ].join("\n"),
    keyboard: [
      [
        { text: "Connect ✓", callback_data: `${REMOTEPC_CONNECT_PREFIX}${pc.hostname}` },
        { text: "Skip ✗", callback_data: `${REMOTEPC_SKIP_PREFIX}${pc.hostname}` },
      ],
    ],
  };
}

/** Contextual prefix injected into garrison session messages when a PC is active. */
export function buildPcContextPrefix(pc: { hostname: string; os: string; ip: string; id: string }): string {
  return (
    `[Ares Remote: connected to ${pc.hostname} (${pc.os}, ${pc.ip}), ` +
    `PC id="${pc.id}". Use the RemotePC tool (list_pcs / exec_on_pc / notify_pc) ` +
    `to run commands or push notifications to this machine.]\n\n`
  );
}
