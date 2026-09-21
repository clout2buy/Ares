// GatewayClient — the phone's socket to the garrison. One connection, hello
// on open, exponential-backoff reconnect while wanted, and a FIFO for
// session.create (the wire has no correlation id, exactly as the Telegram
// bridge handles it).

import type { ClientFrame, ServerFrame, SessionSummary } from "./wire";

export type GatewayStatus = "idle" | "connecting" | "open" | "closed" | "unauthorized";

type FrameListener = (frame: ServerFrame) => void;
type StatusListener = (status: GatewayStatus, detail?: string) => void;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class GatewayClient {
  private ws?: WebSocket;
  private wanted = false;
  private backoff = RECONNECT_MIN_MS;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private readonly frameListeners = new Set<FrameListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly createQueue: Array<(session: SessionSummary) => void> = [];
  private _status: GatewayStatus = "idle";

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly clientName = "ares-ios",
  ) {}

  get status(): GatewayStatus {
    return this._status;
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  connect(): void {
    this.wanted = true;
    this.open();
  }

  close(): void {
    this.wanted = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
    this.setStatus("closed");
  }

  send(frame: ClientFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  /** Create a session and resolve with it once the gateway confirms. */
  createSession(): Promise<SessionSummary> {
    return new Promise((resolve, reject) => {
      if (!this.send({ type: "session.create", surface: "mobile" })) {
        reject(new Error("not connected"));
        return;
      }
      this.createQueue.push(resolve);
    });
  }

  private setStatus(status: GatewayStatus, detail?: string): void {
    this._status = status;
    for (const listener of this.statusListeners) listener(status, detail);
  }

  private open(): void {
    if (!this.wanted) return;
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : String(err));
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", token: this.token, client: this.clientName, proto: 1 } satisfies ClientFrame));
    };
    ws.onmessage = (message) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(message.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "welcome") {
        this.backoff = RECONNECT_MIN_MS;
        this.setStatus("open");
      } else if (frame.type === "error" && /unauthorized|bad token/i.test(String((frame as { message?: string }).message ?? ""))) {
        // A rejected token never gets better by retrying.
        this.wanted = false;
        this.setStatus("unauthorized", String((frame as { message?: string }).message));
      } else if (frame.type === "session.created") {
        const resolve = this.createQueue.shift();
        if (resolve) resolve((frame as { session: SessionSummary }).session);
      }
      for (const listener of this.frameListeners) listener(frame);
    };
    ws.onerror = () => {
      /* onclose follows and carries the reconnect */
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this._status !== "unauthorized") this.scheduleReconnect(event.reason || `closed (${event.code})`);
    };
  }

  private scheduleReconnect(detail: string): void {
    if (!this.wanted) return;
    this.setStatus("closed", detail);
    const delay = this.backoff;
    this.backoff = Math.min(RECONNECT_MAX_MS, this.backoff * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }
}
