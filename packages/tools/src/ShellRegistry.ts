// ShellRegistry — tracks background shells launched via Bash/PowerShell
// when run_in_background=true. BashOutput polls; KillShell terminates.
//
// Per-session: the CLI/Session holds one ShellRegistry and passes it to
// the tools that need it via the RichToolContext extension below.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const MAX_BUFFER_CHARS = 200_000;

export interface ShellLaunchOptions {
  program: string;
  args: string[];
  cwd: string;
  description: string;
  /** Soft timeout (kill after). Optional — backgrounded shells often run forever. */
  timeoutMs?: number;
}

export interface ShellSnapshot {
  id: string;
  description: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed" | "errored";
  exitCode: number | null;
  startedAt: string;
  finishedAt?: string;
  /** Total chars produced across stdout + stderr. */
  totalChars: number;
}

interface ShellState {
  id: string;
  child: ChildProcess;
  description: string;
  command: string;
  cwd: string;
  status: ShellSnapshot["status"];
  exitCode: number | null;
  startedAt: string;
  finishedAt?: string;
  /** Append-only ring buffer of stdout+stderr lines, with stream tag. */
  buffer: Array<{ stream: "stdout" | "stderr"; text: string; ts: number }>;
  totalChars: number;
  /** Per-consumer cursor: how many buffer entries have been read. */
  cursors: Map<string, number>;
  events: EventEmitter;
}

export class ShellRegistry {
  private readonly shells = new Map<string, ShellState>();
  private counter = 0;

  list(): ShellSnapshot[] {
    return [...this.shells.values()].map(snapshot);
  }

  has(id: string): boolean {
    return this.shells.has(id);
  }

  get(id: string): ShellSnapshot | undefined {
    const s = this.shells.get(id);
    return s ? snapshot(s) : undefined;
  }

  spawn(opts: ShellLaunchOptions): ShellSnapshot {
    const id = `sh_${(++this.counter).toString(36)}_${Date.now().toString(36)}`;
    const child = spawn(opts.program, opts.args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
    });
    const state: ShellState = {
      id,
      child,
      description: opts.description,
      command: `${opts.program} ${opts.args.join(" ")}`,
      cwd: opts.cwd,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      buffer: [],
      totalChars: 0,
      cursors: new Map(),
      events: new EventEmitter(),
    };

    const appendChunk = (stream: "stdout" | "stderr", buf: Buffer) => {
      const text = buf.toString("utf8");
      state.totalChars += text.length;
      state.buffer.push({ stream, text, ts: Date.now() });
      // Trim by total chars to keep memory bounded.
      while (state.totalChars > MAX_BUFFER_CHARS && state.buffer.length > 1) {
        const removed = state.buffer.shift()!;
        state.totalChars -= removed.text.length;
        for (const [k, v] of state.cursors) state.cursors.set(k, Math.max(0, v - 1));
      }
      state.events.emit("data");
    };

    child.stdout?.on("data", (b: Buffer) => appendChunk("stdout", b));
    child.stderr?.on("data", (b: Buffer) => appendChunk("stderr", b));
    child.on("error", () => {
      state.status = "errored";
      state.finishedAt = new Date().toISOString();
      state.events.emit("end");
    });
    child.on("close", (code) => {
      state.status = state.status === "killed" ? "killed" : "exited";
      state.exitCode = code;
      state.finishedAt = new Date().toISOString();
      state.events.emit("end");
    });

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      setTimeout(() => {
        if (state.status === "running") this.kill(id, "timeout");
      }, opts.timeoutMs);
    }

    this.shells.set(id, state);
    return snapshot(state);
  }

  /** Read all NEW output since the consumer last polled with this cursorKey. */
  poll(id: string, cursorKey: string, filter?: RegExp): {
    snapshot: ShellSnapshot;
    output: string;
    newChunks: number;
  } | null {
    const s = this.shells.get(id);
    if (!s) return null;
    const start = s.cursors.get(cursorKey) ?? 0;
    const newChunks = s.buffer.slice(start);
    s.cursors.set(cursorKey, s.buffer.length);
    let text = newChunks
      .map((c) => (c.stream === "stderr" ? `[stderr] ${c.text}` : c.text))
      .join("");
    if (filter) {
      text = text
        .split("\n")
        .filter((line) => filter.test(line))
        .join("\n");
    }
    return { snapshot: snapshot(s), output: text, newChunks: newChunks.length };
  }

  kill(id: string, reason: "user" | "timeout" = "user"): boolean {
    const s = this.shells.get(id);
    if (!s) return false;
    if (s.status !== "running") return false;
    s.status = "killed";
    s.finishedAt = new Date().toISOString();
    try {
      s.child.kill(process.platform === "win32" ? undefined : "SIGTERM");
    } catch {
      /* ignore */
    }
    s.events.emit("end");
    void reason;
    return true;
  }

  /** Kill everything; called on session shutdown. */
  killAll(): number {
    let n = 0;
    for (const id of this.shells.keys()) if (this.kill(id)) n++;
    return n;
  }
}

function snapshot(s: ShellState): ShellSnapshot {
  return {
    id: s.id,
    description: s.description,
    command: s.command,
    cwd: s.cwd,
    status: s.status,
    exitCode: s.exitCode,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    totalChars: s.totalChars,
  };
}
