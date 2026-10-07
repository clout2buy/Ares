// Live feed hub — the Forge's window onto an engine Ares is driving, and the
// owner's hands into it.
//
// A capability provider streams `live_frame` progress while an operation
// runs (the browser screencast's sibling). When the operation ends but the
// target keeps running — a game left alive with keepAlive, an editor that
// stays open — the provider announces a `live_control` with the loopback
// endpoint that serves frames. This hub keeps polling that endpoint so the
// owner keeps watching between Ares's turns, and forwards the owner's keys
// and mouse into the running game. Engine-agnostic: the only contract is
// the newline-JSON RPC (`{id, method, params}` → `{id, ok, result}`) and
// the method names the provider named in its live_control.

import net from "node:net";

export interface LiveControl {
  source: string;
  side: string;
  host?: string;
  port: number;
  method?: string;
  label?: string;
  state?: "running" | "detached" | "available" | "ended" | string;
  project?: string;
  pid?: number | null;
  /** Window title hint for native embedding (the project name for a game). */
  windowTitle?: string;
  inputMethods?: { key?: string; mouse?: string };
}

export interface LiveInputEvent {
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

export interface LiveFeedEmit {
  (obj: Record<string, unknown>, sessionId?: string): void;
}

export interface LiveFeedOptions {
  emit: LiveFeedEmit;
  fps?: number;
  maxWidth?: number;
  quality?: number;
  /** Consecutive failed frame polls before the feed is declared lost. */
  maxMisses?: number;
  rpc?: typeof rpcCall;
}

let rpcId = 0;

/** One request → one response over a fresh loopback socket (mirrors the
 * provider-side client; kept dependency-free on purpose). */
export function rpcCall(host: string, port: number, method: string, params: Record<string, unknown> = {}, timeoutMs = 5_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    const socket = net.createConnection({ host, port });
    let buf = "";
    let done = false;
    const finish = (err: Error | null, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`rpc ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.setNoDelay(true);
    socket.once("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as { ok?: boolean; error?: string; result?: unknown };
        if (msg.ok === false) finish(new Error(msg.error ?? `rpc ${method} failed`));
        else finish(null, msg.result);
      } catch (error) {
        finish(new Error(`rpc ${method}: bad response: ${String(error)}`));
      }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => finish(new Error(`rpc ${method}: ${error.code ?? error.message}`)));
    socket.once("close", () => finish(new Error(`rpc ${method}: connection closed`)));
  });
}

interface Watch {
  control: LiveControl;
  sessionId?: string;
  timer: NodeJS.Timeout;
  busy: boolean;
  misses: number;
  frames: number;
  startedAt: number;
}

export class LiveFeedHub {
  private watch: Watch | null = null;
  /** The most recent control announced per side, so the UI can ask to watch
   * something the provider only offered (an open editor). */
  private readonly offers = new Map<string, { control: LiveControl; sessionId?: string; at: number }>();
  private readonly emit: LiveFeedEmit;
  private readonly fps: number;
  private readonly maxWidth: number;
  private readonly quality: number;
  private readonly maxMisses: number;
  private readonly rpc: typeof rpcCall;

  constructor(options: LiveFeedOptions) {
    this.emit = options.emit;
    this.fps = options.fps ?? 5;
    this.maxWidth = options.maxWidth ?? 960;
    this.quality = options.quality ?? 0.6;
    this.maxMisses = options.maxMisses ?? 8;
    this.rpc = options.rpc ?? rpcCall;
  }

  /** A provider's live_control progress event. */
  onControl(control: LiveControl, sessionId?: string): void {
    if (!control || typeof control.port !== "number" || !control.source) return;
    const key = `${control.source}:${control.side}`;
    if (control.state === "ended") {
      this.offers.delete(key);
      if (this.watch && this.sameTarget(this.watch.control, control)) this.stop("ended");
      else this.emit({ type: "live_feed", state: "offer_gone", source: control.source, side: control.side, label: control.label }, sessionId);
      return;
    }
    this.offers.set(key, { control, sessionId, at: Date.now() });
    if (control.state === "running") {
      // The provider streams its own frames while the operation runs; pause
      // our polling for the same target so the pane is not fed twice.
      if (this.watch && this.sameTarget(this.watch.control, control)) this.stop("provider_streaming", false);
      this.emit({ type: "live_feed", state: "streaming", source: control.source, side: control.side, label: control.label, interactive: control.side === "game" }, sessionId);
      return;
    }
    if (control.state === "detached") {
      // Left running for the owner — keep the window open and the hands live.
      this.start(control, sessionId);
      return;
    }
    this.emit({ type: "live_feed", state: "offered", source: control.source, side: control.side, label: control.label, interactive: control.side === "game" }, sessionId);
  }

  /** UI request: watch a named offer, or an explicit endpoint. */
  startWatching(request: Partial<LiveControl> & { source?: string; side?: string }, sessionId?: string): boolean {
    const key = `${request.source ?? "godot"}:${request.side ?? "game"}`;
    const offer = this.offers.get(key);
    const control: LiveControl | null = typeof request.port === "number"
      ? { source: request.source ?? "godot", side: request.side ?? "game", host: request.host ?? "127.0.0.1", port: request.port, method: request.method ?? (request.side === "editor" ? "editor.frame" : "frame"), label: request.label ?? offer?.control.label, project: request.project ?? offer?.control.project, pid: request.pid ?? offer?.control.pid ?? null, windowTitle: request.windowTitle ?? offer?.control.windowTitle }
      : offer?.control ?? null;
    if (!control) {
      this.emit({ type: "live_feed", state: "unavailable", source: request.source ?? "godot", side: request.side ?? "game", error: "nothing to watch — run the game or open the editor first" }, sessionId);
      return false;
    }
    this.start(control, sessionId ?? offer?.sessionId);
    return true;
  }

  stopWatching(): void {
    this.stop("stopped");
  }

  status(): { watching: LiveControl | null; offers: LiveControl[]; frames: number } {
    return { watching: this.watch?.control ?? null, offers: [...this.offers.values()].map((o) => o.control), frames: this.watch?.frames ?? 0 };
  }

  /** Forward the owner's input to the watched (or offered) game. */
  async input(events: LiveInputEvent[], sessionId?: string): Promise<{ sent: number; error?: string }> {
    const target = this.watch?.control ?? this.offers.get("godot:game")?.control ?? [...this.offers.values()].map((o) => o.control).find((c) => c.side === "game");
    if (!target) return { sent: 0, error: "no running game to send input to" };
    if (target.side !== "game") return { sent: 0, error: "the editor feed is view-only; interaction needs a running game" };
    const host = target.host ?? "127.0.0.1";
    let sent = 0;
    let lastError: string | undefined;
    for (const ev of events.slice(0, 64)) {
      try {
        if (ev.kind === "key" && ev.key) {
          await this.rpc(host, target.port, target.inputMethods?.key ?? "input.key", { key: ev.key, pressed: ev.pressed !== false, shift: !!ev.shift, ctrl: !!ev.ctrl, alt: !!ev.alt }, 2_000);
        } else if (ev.kind === "mouse") {
          const params: Record<string, unknown> = { x: Number(ev.x ?? 0), y: Number(ev.y ?? 0) };
          if (ev.relative) params.relative = true;
          if (typeof ev.button === "number") {
            params.button = ev.button;
            params.pressed = ev.pressed !== false;
            params.move = ev.move ?? true;
          }
          if (typeof ev.mask === "number") params.mask = ev.mask;
          await this.rpc(host, target.port, target.inputMethods?.mouse ?? "input.mouse", params, 2_000);
        } else if (ev.kind === "wheel") {
          const button = (ev.delta ?? 0) < 0 ? 4 : 5; // MOUSE_BUTTON_WHEEL_UP / DOWN
          await this.rpc(host, target.port, target.inputMethods?.mouse ?? "input.mouse", { x: Number(ev.x ?? 0), y: Number(ev.y ?? 0), button, ms: 30 }, 2_000);
        } else continue;
        sent += 1;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (lastError && sent === 0) this.emit({ type: "live_feed", state: "input_failed", source: target.source, side: target.side, error: lastError }, sessionId);
    return { sent, error: lastError };
  }

  dispose(): void {
    this.stop("disposed", false);
    this.offers.clear();
  }

  private sameTarget(a: LiveControl, b: LiveControl): boolean {
    return a.source === b.source && a.side === b.side && a.port === b.port;
  }

  private start(control: LiveControl, sessionId?: string): void {
    if (this.watch && this.sameTarget(this.watch.control, control)) return;
    if (this.watch) this.stop("switched", false);
    const interval = Math.max(100, Math.round(1000 / this.fps));
    const watch: Watch = { control, sessionId, busy: false, misses: 0, frames: 0, startedAt: Date.now(), timer: setInterval(() => void this.tick(), interval) };
    this.watch = watch;
    this.emit({ type: "live_feed", state: "watching", source: control.source, side: control.side, label: control.label, interactive: control.side === "game", project: control.project, pid: control.pid ?? null, windowTitle: control.windowTitle }, sessionId);
    void this.tick();
  }

  private stop(reason: string, announce = true): void {
    const watch = this.watch;
    if (!watch) return;
    clearInterval(watch.timer);
    this.watch = null;
    if (announce) this.emit({ type: "live_feed", state: reason === "lost" ? "lost" : "stopped", reason, source: watch.control.source, side: watch.control.side, label: watch.control.label, frames: watch.frames }, watch.sessionId);
  }

  private async tick(): Promise<void> {
    const watch = this.watch;
    if (!watch || watch.busy) return;
    watch.busy = true;
    try {
      const result = (await this.rpc(watch.control.host ?? "127.0.0.1", watch.control.port, watch.control.method ?? "frame", { max_width: this.maxWidth, quality: this.quality }, 2_500)) as { image?: string; width?: number; height?: number } | null;
      if (result?.image) {
        watch.misses = 0;
        watch.frames += 1;
        this.emit({ type: "live_frame", source: watch.control.source, side: watch.control.side, label: watch.control.label, image: result.image, width: result.width, height: result.height, interactive: watch.control.side === "game" }, watch.sessionId);
      } else watch.misses += 1;
    } catch {
      watch.misses += 1;
    } finally {
      watch.busy = false;
    }
    if (this.watch === watch && watch.misses >= this.maxMisses) {
      this.offers.delete(`${watch.control.source}:${watch.control.side}`);
      this.stop("lost");
    }
  }
}
