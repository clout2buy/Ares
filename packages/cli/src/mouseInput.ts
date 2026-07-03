// SGR mouse engine — the TUI's pointer input. The owner's device has NO arrow
// keys, so every surface must be clickable; this module is the wire format half
// of that: enable/disable terminal mouse tracking (with guaranteed cleanup on
// every exit path — a terminal left in mouse mode is broken for the user), and
// a PURE parser that turns the SGR byte stream Ink hands useInput into typed
// events. No Ink imports — the parser is unit-tested without a terminal
// (tests/tui-mouse.test.mjs).

export type MouseEventKind = "down" | "drag" | "up" | "wheel-up" | "wheel-down";

export interface SgrMouseEvent {
  /** Raw SGR button code (base button + modifier/motion bits). */
  button: number;
  /** 1-based terminal column. */
  x: number;
  /** 1-based terminal row. */
  y: number;
  kind: MouseEventKind;
}

// ?1002 = button-event tracking (press/release/drag — a superset of ?1000),
// ?1006 = SGR encoding (coordinates beyond col 223, explicit release codes).
const ENABLE_SEQ = "\x1b[?1002h\x1b[?1006h";
const DISABLE_SEQ = "\x1b[?1002l\x1b[?1006l";

/** Mouse tracking is only sane on a real terminal, and the owner can kill it
 *  outright with ARES_NO_MOUSE=1 (e.g. terminals whose native selection they
 *  prefer). Pure so tests can probe both gates. */
export function mouseTrackingSupported(
  env: Record<string, string | undefined> = process.env,
  tty: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if (env.ARES_NO_MOUSE === "1" || env.ARES_NO_MOUSE === "true") return false;
  return tty;
}

// ─── Enable/disable with exit-path guarantees ────────────────────────────────

let trackingActive = false;
let exitHooksInstalled = false;

/** Restore the terminal. Idempotent and synchronous — safe from an "exit"
 *  handler or a signal handler. Exported so runInkChat can belt-and-braces it
 *  after Ink unmounts. */
export function disableMouseTracking(): void {
  if (!trackingActive) return;
  trackingActive = false;
  try {
    process.stdout.write(DISABLE_SEQ);
  } catch {
    // stdout already gone (broken pipe on shutdown) — nothing left to restore.
  }
}

/** Enter SGR mouse mode. Returns false (and does nothing) when unsupported.
 *  The FIRST enable installs process-level cleanup hooks so the terminal is
 *  restored on every exit path:
 *  - normal exit / app.exit / uncaught exception → "exit" fires (sync write ok)
 *  - SIGINT/SIGTERM/SIGHUP with no other handler → Node would die WITHOUT
 *    firing "exit", so we restore + re-exit with the conventional 128+signal
 *    code ourselves. (Under Ink raw-mode, ⌃C never raises SIGINT — it arrives
 *    as input and exits through Ink — so this only covers external kills.) */
export function enableMouseTracking(
  env: Record<string, string | undefined> = process.env,
  tty: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if (!mouseTrackingSupported(env, tty)) return false;
  if (!exitHooksInstalled) {
    exitHooksInstalled = true;
    process.on("exit", disableMouseTracking);
    const signals: Array<[NodeJS.Signals, number]> = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]];
    for (const [signal, code] of signals) {
      process.on(signal, () => {
        disableMouseTracking();
        // Only force-exit when we're the lone listener — anyone else who
        // registered gets to decide the process's fate.
        if (process.listenerCount(signal) <= 1) process.exit(code);
      });
    }
  }
  if (trackingActive) return true;
  trackingActive = true;
  process.stdout.write(ENABLE_SEQ);
  return true;
}

/** Test/introspection hook: is the terminal currently in mouse mode? */
export function mouseTrackingActive(): boolean {
  return trackingActive;
}

// ─── The pure SGR parser ─────────────────────────────────────────────────────

// ESC [ < btn ; x ; y (M=press/drag/wheel, m=release). Ink's useInput can strip
// the leading ESC — and occasionally the "[" too — so both prefixes are
// optional. Digits are required for all three fields.
const SGR_PATTERN = /(?:\x1b\[|\[)?<(\d+);(\d+);(\d+)([mM])/g;

function kindFor(button: number, release: boolean): MouseEventKind {
  // Bit 6 (64) without the motion bit = scroll wheel: 64 up, 65 down (66/67 are
  // horizontal wheel — fold them onto vertical so lists still move).
  if (button >= 64 && button < 96) return button & 1 ? "wheel-down" : "wheel-up";
  if (release) return "up";
  // Bit 5 (32) = motion-while-pressed — the drag stream ?1002 unlocks.
  if (button & 32) return "drag";
  return "down";
}

/** Parse every complete SGR mouse sequence in `input`. Returns null when the
 *  chunk contains none — callers then treat it as keyboard input. Pure. */
export function parseSgrMouse(input: string): SgrMouseEvent[] | null {
  const text = String(input ?? "");
  if (!text.includes("<")) return null;
  const events: SgrMouseEvent[] = [];
  SGR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_PATTERN.exec(text))) {
    const button = Number(match[1]);
    events.push({
      button,
      x: Number(match[2]),
      y: Number(match[3]),
      kind: kindFor(button, match[4] === "m"),
    });
  }
  return events.length > 0 ? events : null;
}

/** True when the chunk looks like a PARTIAL mouse sequence (terminal buffers
 *  split mid-sequence) — swallow it rather than let "<64;12" land in the
 *  composer. A lone typed "<" (generics, HTML) is NOT a fragment: we require
 *  either an escape/bracket prefix or at least one digit after the "<". */
export function isMouseFragment(input: string): boolean {
  const text = String(input ?? "");
  const m = /(?:\x1b\[|\[)?<(\d*(?:;\d*){0,2})[mM]?$/.exec(text);
  if (!m) return false;
  if (/^(?:\x1b\[|\[)</.test(m[0])) return true;
  return /\d/.test(m[1]);
}
