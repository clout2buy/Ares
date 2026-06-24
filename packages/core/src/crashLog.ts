// Crash safety for the long-lived processes external users actually run.
//
// The daemon (desktop bridge) and garrison (Telegram/gateway) are long-lived
// Node processes. Until now they had NO global error handlers: an
// `uncaughtException` or — on Node ≥15 where the default is `throw` — an
// `unhandledRejection` could tear the process down silently, leaving a coworker
// staring at a frozen window with nothing on disk to diagnose.
//
// This module is the net. It is intentionally dependency-free (only node:fs /
// node:path) and writes SYNCHRONOUSLY, because a crash handler runs while the
// event loop may already be unwinding — an async write would never flush.
//
// Posture (deliberate, for "handed to someone else"):
//   - uncaughtException → record + emit + EXIT. Process state is undefined after
//     one; continuing would corrupt sessions on disk. The Tauri supervisor
//     restarts the daemon.
//   - unhandledRejection → record + emit, but KEEP RUNNING. Installing a handler
//     suppresses Node's default termination, so a single stray rejection in a
//     best-effort background task no longer kills a coworker's live chat. Every
//     one is still written to the crash log, so nothing is masked from us.

import fs from "node:fs";
import path from "node:path";

export type CrashKind =
  | "uncaughtException"
  | "unhandledRejection"
  | "signal"
  | "manual";

export interface CrashRecord {
  /** ISO-8601 timestamp. */
  at: string;
  kind: CrashKind;
  /** Which process recorded it: "daemon" | "garrison" | "chat" | … */
  process: string;
  message: string;
  stack?: string;
  /** Free-form diagnostic context (active sessions, selection, etc.). */
  context?: Record<string, unknown>;
  /** Tail of recently-emitted events, for "what was happening just before". */
  recentEvents?: unknown[];
}

/** `~/.ares/crashes` — the home for crash artifacts. */
export function crashDir(home: string): string {
  return path.join(home, "crashes");
}

/**
 * Write one crash record synchronously. Best-effort: a failure here must never
 * throw (we are usually already mid-crash). Returns the file path, or null.
 */
export function writeCrashLogSync(home: string, record: CrashRecord): string | null {
  try {
    const dir = crashDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = record.at.replace(/[:.]/g, "-");
    const file = path.join(dir, `${record.process}-${stamp}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(record) + "\n");
    return file;
  } catch {
    return null;
  }
}

export interface CrashHandlerOptions {
  /** Immortal home (`aresHome()`); crashes land under `${home}/crashes`. */
  home: string;
  /** Label for this process: "daemon" | "garrison" | "chat". */
  process: string;
  /** Pulled lazily at crash time — active sessions, current model, etc. */
  getContext?: () => Record<string, unknown>;
  /** Pulled lazily at crash time — tail of recent events. */
  getRecentEvents?: () => unknown[];
  /** Surface a one-line human/NDJSON notice (stderr or the daemon wire). */
  emit?: (notice: { type: "crash"; kind: CrashKind; message: string; logFile: string | null }) => void;
  /** Graceful-shutdown hook for SIGTERM/SIGINT (flush, close sessions). */
  onSignal?: (signal: NodeJS.Signals) => void | Promise<void>;
  /** Exit the process after an uncaughtException. Default true. */
  exitOnUncaught?: boolean;
  /** Install SIGTERM/SIGINT handlers too. Default true. */
  handleSignals?: boolean;
}

/**
 * Install global crash handlers for a long-lived process. Idempotent per call
 * site; returns an uninstall function (used by tests and clean teardown).
 */
export function installGlobalCrashHandlers(opts: CrashHandlerOptions): () => void {
  const {
    home,
    process: label,
    getContext,
    getRecentEvents,
    emit,
    onSignal,
    exitOnUncaught = true,
    handleSignals = true,
  } = opts;

  let handlingFatal = false;

  const record = (kind: CrashKind, err: unknown): string | null => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    let context: Record<string, unknown> | undefined;
    let recentEvents: unknown[] | undefined;
    try {
      context = getContext?.();
    } catch {
      /* never let diagnostics throw */
    }
    try {
      recentEvents = getRecentEvents?.();
    } catch {
      /* never let diagnostics throw */
    }
    const logFile = writeCrashLogSync(home, {
      at: new Date().toISOString(),
      kind,
      process: label,
      message,
      stack,
      context,
      recentEvents,
    });
    try {
      emit?.({ type: "crash", kind, message, logFile });
    } catch {
      /* emit is best-effort too */
    }
    return logFile;
  };

  const onUncaught = (err: unknown): void => {
    if (handlingFatal) return;
    handlingFatal = true;
    record("uncaughtException", err);
    if (exitOnUncaught) {
      // Give stdout/stderr a tick to flush, then exit non-zero so the
      // supervisor knows it was a crash, not a clean stop.
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 50).unref?.();
    }
  };

  // Keep running — Node would otherwise terminate on Node ≥15. We log and move
  // on so one stray background rejection never kills a live session.
  const onRejection = (reason: unknown): void => {
    record("unhandledRejection", reason);
  };

  // A signal (normally the desktop closing → SIGTERM) is an EXPECTED shutdown,
  // not a crash — so we do NOT write a crash artifact (that would litter
  // ~/.ares/crashes on every clean close). We just surface a notice, run the
  // graceful-shutdown hook, then exit cleanly.
  const signalHandler = (signal: NodeJS.Signals) => (): void => {
    try {
      emit?.({ type: "crash", kind: "signal", message: `received ${signal}`, logFile: null });
    } catch {
      /* best-effort */
    }
    void Promise.resolve(onSignal?.(signal)).finally(() => {
      process.exit(0);
    });
  };

  const sigterm = signalHandler("SIGTERM");
  const sigint = signalHandler("SIGINT");

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  if (handleSignals) {
    process.once("SIGTERM", sigterm);
    process.once("SIGINT", sigint);
  }

  return () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
    if (handleSignals) {
      process.off("SIGTERM", sigterm);
      process.off("SIGINT", sigint);
    }
  };
}

/**
 * A small bounded ring buffer for "the last N events before the crash". The
 * daemon/garrison push every emitted event through `record`; the crash handler
 * reads `snapshot()`.
 */
export class EventRing {
  private readonly buf: unknown[] = [];
  constructor(private readonly max = 30) {}
  record(event: unknown): void {
    this.buf.push(event);
    if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
  }
  snapshot(): unknown[] {
    return this.buf.slice();
  }
}
