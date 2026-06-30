// ShellRegistry — tracks background shells launched via Bash/PowerShell
// when run_in_background=true. BashOutput polls; KillShell terminates.
//
// Per-session: the CLI/Session holds one ShellRegistry and passes it to
// the tools that need it via the RichToolContext extension below.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { toolError } from "./_shared.js";

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

  async spawn(opts: ShellLaunchOptions): Promise<ShellSnapshot> {
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
    // Persistent listeners — attached BEFORE we await the launch so a process
    // that spawns then dies instantly (or errors after spawn) is still tracked.
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

    // Don't return a false 'running' before the OS confirms the child launched.
    // ENOENT/EACCES on the binary, or fd exhaustion under heavy fan-out, fires
    // async via 'error' — if we snapshot synchronously the caller gets a
    // shell_id for a process that never started. Race spawn vs error: the
    // persistent listeners above stay attached either way.
    await new Promise<void>((res, rej) => {
      child.once("spawn", res);
      child.once("error", rej);
    }).catch((err: NodeJS.ErrnoException) => {
      throw toolError(`Background shell failed to launch: ${err.code ?? err.message}`);
    });

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      setTimeout(() => {
        if (state.status === "running") void this.kill(id, "timeout");
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

  /**
   * Terminate a shell. Resolves to `true` only when the OS actually confirms
   * the kill — on win32 that means awaiting taskkill's exit (it's otherwise
   * fire-and-forget, so a synchronous `true` would be a claim we can't back).
   * If taskkill errors we fall back to child.kill() and report THAT outcome
   * rather than asserting success we never observed.
   */
  async kill(id: string, reason: "user" | "timeout" = "user"): Promise<boolean> {
    const s = this.shells.get(id);
    if (!s) return false;
    if (s.status !== "running") return false;
    void reason;
    let confirmed = false;
    try {
      if (process.platform === "win32" && s.child.pid) {
        // child.kill() only signals the direct child (bash.exe/pwsh.exe); its
        // grandchildren (e.g. a `pnpm dev` node server) survive and keep the
        // port. taskkill /T kills the whole tree, /F forces it. Await its exit
        // so the flag reflects a real kill, not a fired-and-forgotten one.
        confirmed = await new Promise<boolean>((resolve) => {
          const tk = spawn("taskkill", ["/PID", String(s.child.pid), "/T", "/F"], { stdio: "ignore" });
          tk.on("error", () => {
            try {
              resolve(s.child.kill());
            } catch {
              resolve(false);
            }
          });
          tk.on("close", (code) => resolve(code === 0));
        });
      } else {
        confirmed = s.child.kill("SIGTERM");
      }
    } catch {
      confirmed = false;
    }
    // Only flip the STORED state to "killed" once the kill is CONFIRMED — else a
    // taskkill that failed (e.g. exit 1 "access denied" on a protected
    // grandchild) would leave a still-running process reported as "killed", the
    // exact state-lie we're guarding against. On failure leave status "running"
    // so snapshot()/poll() stay honest; the child's own close handler still
    // updates it if the process later dies. When confirmed, mark killed (the
    // close handler preserves "killed" over "exited").
    if (confirmed && s.status === "running") {
      s.status = "killed";
      s.finishedAt = new Date().toISOString();
      s.events.emit("end");
    }
    return confirmed;
  }

  /** Kill everything; called on session shutdown. */
  async killAll(): Promise<number> {
    let n = 0;
    for (const id of this.shells.keys()) if (await this.kill(id)) n++;
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
