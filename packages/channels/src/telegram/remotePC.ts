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
