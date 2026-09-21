/**
 * Detached shell supervisor.
 *
 * A background command cannot be made restart-safe by retaining a ChildProcess
 * object: that object and its pipes die with the Ares host. This tiny process is
 * the durable OS boundary. It owns the command, appends tagged output to a
 * stable spool, and continuously publishes a token-bound state file. A new Ares
 * process can prove liveness/terminal state without pretending Node can
 * reconstruct old pipes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface ShellSupervisorManifest {
  version: 1;
  jobId: string;
  token: string;
  program: string;
  args: string[];
  cwd: string;
  outputPath: string;
  statePath: string;
  createdAtMs: number;
}

export interface ShellSupervisorState {
  version: 1;
  jobId: string;
  token: string;
  supervisorPid: number;
  childPid: number | null;
  phase: "launching" | "running" | "completed" | "failed" | "cancelled";
  startedAtMs: number;
  heartbeatAtMs: number;
  finishedAtMs: number | null;
  exitCode: number | null;
  signal: string | null;
  outputBytes: number;
  error: string | null;
}

const HEARTBEAT_MS = 1_000;

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error("ShellSupervisor requires a manifest path");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ShellSupervisorManifest;
  validateManifest(manifest);
  await mkdir(path.dirname(manifest.outputPath), { recursive: true });
  await mkdir(path.dirname(manifest.statePath), { recursive: true });

  const startedAtMs = Date.now();
  let child: ChildProcess | null = null;
  let terminal = false;
  let cancelling = false;
  let writeChain = Promise.resolve();
  let state: ShellSupervisorState = {
    version: 1,
    jobId: manifest.jobId,
    token: manifest.token,
    supervisorPid: process.pid,
    childPid: null,
    phase: "launching",
    startedAtMs,
    heartbeatAtMs: startedAtMs,
    finishedAtMs: null,
    exitCode: null,
    signal: null,
    outputBytes: await fileSize(manifest.outputPath),
    error: null,
  };
  const persist = () => {
    const snapshot = { ...state };
    // A failed write must reject THIS persist (settle wants the truth) without
    // poisoning the chain: one sharing-violation loss must not doom every
    // subsequent heartbeat and — fatally — the terminal write.
    writeChain = writeChain.catch(() => undefined).then(() => writeStateAtomic(manifest.statePath, snapshot));
    return writeChain;
  };
  await persist();

  const capture = createWriteStream(manifest.outputPath, { flags: "a" });
  let captureFailure: string | null = null;
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const paused = new Set<NodeJS.ReadableStream>();
  capture.on("error", (error) => {
    captureFailure = error.message;
    for (const stream of paused) {
      if (typeof stream.resume === "function") stream.resume();
    }
    paused.clear();
    try { child?.kill("SIGTERM"); } catch { /* terminal reconciliation decides */ }
  });
  const append = (stream: "stdout" | "stderr", text: string, source?: NodeJS.ReadableStream) => {
    if (!text || captureFailure) return;
    const rendered = `[${stream}] ${text}`;
    state.outputBytes += Buffer.byteLength(rendered);
    if (!capture.write(rendered) && source && typeof source.pause === "function") {
      source.pause();
      paused.add(source);
      capture.once("drain", () => {
        if (paused.delete(source) && typeof source.resume === "function") source.resume();
      });
    }
  };

  const settle = async (
    phase: Extract<ShellSupervisorState["phase"], "completed" | "failed" | "cancelled">,
    exitCode: number | null,
    signal: string | null,
    error: string | null,
  ) => {
    if (terminal) return;
    terminal = true;
    clearInterval(heartbeat);
    const stdoutTail = stdoutDecoder.end();
    const stderrTail = stderrDecoder.end();
    append("stdout", stdoutTail);
    append("stderr", stderrTail);
    if (!capture.destroyed && !capture.closed) {
      await new Promise<void>((resolve) => capture.end(resolve));
    }
    const settledPhase = captureFailure && phase === "completed" ? "failed" : phase;
    state = {
      ...state,
      phase: settledPhase,
      heartbeatAtMs: Date.now(),
      finishedAtMs: Date.now(),
      exitCode,
      signal,
      outputBytes: await fileSize(manifest.outputPath),
      error: error ?? captureFailure,
    };
    await persist();
  };

  // Signal the child's whole PROCESS GROUP, not just the shell. A `bash -c`
  // running a pipeline (`docker exec … | tail`) does not forward signals to its
  // children with job control off, so killing only the shell orphans the
  // grandchildren — and if one holds the stdout pipe open, the child's `close`
  // event never fires and this supervisor wedges forever (the freeze a hung
  // `docker exec … | tail` caused: the exec orphaned to PID 1, tail kept the
  // pipe, no terminal event, the turn hung). The child leads its own group
  // (spawned detached), so negate the pid to reach the group; fall back to the
  // bare child if that send fails (already gone, or Windows).
  const signalTree = (sig: NodeJS.Signals) => {
    if (!child?.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };

  const terminate = () => {
    if (terminal || cancelling) return;
    cancelling = true;
    if (child?.pid) {
      signalTree("SIGTERM");
      const force = setTimeout(() => signalTree("SIGKILL"), 2_000);
      force.unref();
      // Belt-and-suspenders: if a survivor in another PID namespace (a
      // container process reached via `docker exec`) keeps the output pipe
      // open, `close` still never comes. Settle as cancelled once SIGKILL has
      // had time to land, so a wedged pipe can never hang the turn again.
      const giveUp = setTimeout(() => {
        void settle("cancelled", null, "SIGKILL", "terminated; a surviving child held the output pipe open")
          .finally(() => process.exit(0));
      }, 5_000);
      giveUp.unref();
    } else {
      void settle("cancelled", null, "SIGTERM", null).finally(() => process.exit(0));
    }
  };
  process.on("SIGTERM", terminate);
  process.on("SIGINT", terminate);

  child = spawn(manifest.program, manifest.args, {
    cwd: manifest.cwd,
    windowsHide: true,
    shell: false,
    // Lead a new process group (POSIX) so terminate() can signal the whole
    // pipeline — shell AND its docker-exec/tail grandchildren — at once. Stdio
    // stays piped; the child is never unref'd, so supervision is unchanged.
    detached: process.platform !== "win32",
  });
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", stdoutDecoder.write(chunk), child?.stdout ?? undefined));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", stderrDecoder.write(chunk), child?.stderr ?? undefined));
  child.once("spawn", () => {
    state = {
      ...state,
      childPid: child?.pid ?? null,
      phase: "running",
      heartbeatAtMs: Date.now(),
    };
    void persist();
  });
  child.once("error", (error) => {
    void settle(cancelling ? "cancelled" : "failed", null, null, error.message)
      .finally(() => process.exit(cancelling ? 0 : 1));
  });
  child.once("close", (code, signal) => {
    const phase = cancelling ? "cancelled" : code === 0 ? "completed" : "failed";
    void settle(phase, code, signal, null).finally(() => process.exit((phase === "completed" && !captureFailure) || phase === "cancelled" ? 0 : 1));
  });

  const heartbeat = setInterval(() => {
    if (terminal) return;
    state = { ...state, heartbeatAtMs: Date.now() };
    void fileSize(manifest.outputPath).then((size) => {
      state = { ...state, outputBytes: size };
      return persist();
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();
}

function validateManifest(value: ShellSupervisorManifest): void {
  if (value.version !== 1 || !value.jobId || !value.token || !value.program || !value.cwd) {
    throw new Error("Invalid shell supervisor manifest");
  }
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
    throw new Error("Invalid shell supervisor arguments");
  }
  if (!path.isAbsolute(value.outputPath) || !path.isAbsolute(value.statePath)) {
    throw new Error("Shell supervisor paths must be absolute");
  }
}

async function writeStateAtomic(filename: string, state: ShellSupervisorState): Promise<void> {
  const temp = `${filename}.${process.pid}.tmp`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(JSON.stringify(state) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  // On Windows, renaming over a state file that a registry poll currently holds
  // open fails with a sharing violation — and the rm fallback fails the same
  // way. Readers hold the file only for a sub-millisecond readFileSync, so the
  // collision is transient: retry briefly. Losing the TERMINAL write here is
  // how a completed job gets misread as orphaned by the next host.
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rename(temp, filename);
      return;
    } catch (error) {
      lastError = error;
    }
    try {
      await rm(filename, { force: true });
      await rename(temp, filename);
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError;
}

async function fileSize(filename: string): Promise<number> {
  return stat(filename).then((value) => value.size).catch(() => 0);
}

void main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Ares shell supervisor failed: ${message}\n`);
  process.exitCode = 1;
});
