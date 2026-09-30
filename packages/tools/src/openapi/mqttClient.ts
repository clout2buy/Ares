// A small, dependency-free MQTT 3.1.1 client: CONNECT, PUBLISH (QoS 0/1),
// SUBSCRIBE (QoS 0/1), PING, DISCONNECT, over TCP or TLS. Enough for an agent to
// read and drive a broker (Home Assistant, zigbee2mqtt, Tasmota, ESPHome) and
// small enough to audit — the alternative was a dependency tree in the one
// process that holds the owner's credentials.
//
// Bounded by design: packets over MAX_PACKET are refused, every wait has a
// deadline, and the network guard (netGuard.ts) classifies the broker's address
// inside the socket's own lookup, so a hostile DNS answer cannot redirect it.
// Brokers are usually on the LAN, so private addresses are allowed here;
// link-local, metadata and other non-routable ranges never are.

import net from "node:net";
import tls from "node:tls";
import { guardedLookup, assertAddressClass, classifyAddress, NetBlockedError, type Resolver } from "./netGuard.js";

export const MAX_PACKET = 512 * 1024;

export interface MqttEndpoint {
  host: string;
  port: number;
  tls: boolean;
  insecureTls: boolean;
  username?: string;
  password?: string;
}

/** mqtt://user:pass@host:1883 · mqtts://host · (?insecure=1 accepts a self-signed broker certificate) */
export function parseMqttUrl(raw: string): MqttEndpoint {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("the broker URL is not valid (expected mqtt://[user:pass@]host[:1883] or mqtts://host[:8883])");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!["mqtt", "tcp", "mqtts", "ssl", "tls"].includes(scheme)) throw new Error(`unsupported broker scheme "${scheme}" (use mqtt:// or mqtts://)`);
  const secure = scheme === "mqtts" || scheme === "ssl" || scheme === "tls";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("the broker URL has no host");
  return {
    host,
    port: url.port ? Number(url.port) : secure ? 8883 : 1883,
    tls: secure,
    insecureTls: url.searchParams.get("insecure") === "1" || url.searchParams.get("insecure") === "true",
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

export interface MqttMessage {
  topic: string;
  payload: Buffer;
  qos: 0 | 1 | 2;
  retain: boolean;
  receivedAt: number;
}

export interface MqttConnectOptions extends MqttEndpoint {
  clientId?: string;
  keepAliveSec?: number;
  connectTimeoutMs?: number;
  signal?: AbortSignal;
  resolver?: Resolver;
}

const CONNACK_TEXT: Record<number, string> = {
  1: "the broker does not support MQTT 3.1.1",
  2: "the broker rejected the client id",
  3: "the broker is unavailable",
  4: "the username or password is wrong",
  5: "not authorised (check the username and the broker's ACL)",
};

function utf8(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  if (b.length > 65535) throw new Error("string too long for MQTT");
  return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]);
}

function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 128;
    out.push(digit);
  } while (n > 0);
  return Buffer.from(out);
}

function packet(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), varint(body.length), body]);
}

export function validateTopicName(topic: string): string | null {
  if (!topic) return "a topic is required";
  if (/[+#]/.test(topic)) return "a published topic may not contain the wildcards + or #";
  if (topic.startsWith("$")) return "topics starting with $ belong to the broker";
  if (topic.includes("\u0000")) return "the topic contains a NUL character";
  if (Buffer.byteLength(topic) > 1024) return "the topic is too long";
  return null;
}

export function validateTopicFilter(filter: string): string | null {
  if (!filter) return "a topic filter is required";
  if (filter.includes("\u0000")) return "the filter contains a NUL character";
  if (Buffer.byteLength(filter) > 1024) return "the filter is too long";
  const parts = filter.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.includes("#") && (part !== "#" || i !== parts.length - 1)) return "# must be the whole last level of a filter";
    if (part.includes("+") && part !== "+") return "+ must be a whole level of a filter";
  }
  return null;
}

export class MqttClient {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;
  private pendingAck = new Map<number, { resolve: (codes: number[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private handlers = new Set<(m: MqttMessage) => void>();
  private pingTimer?: NodeJS.Timeout;
  private connack?: { resolve: () => void; reject: (e: Error) => void };
  private error?: Error;
  private breakNow!: (e: Error) => void;
  /** Rejects if the connection fails or the broker hangs up while we are listening (never after our own close()). */
  readonly broken: Promise<never>;

  private constructor(private readonly socket: net.Socket) {
    this.broken = new Promise<never>((_, reject) => (this.breakNow = reject));
    this.broken.catch(() => {}); // observed only by those who race it
  }

  static async connect(opts: MqttConnectOptions): Promise<MqttClient> {
    // The literal-address and name checks; DNS answers are classified in `lookup`.
    const literal = net.isIP(opts.host) !== 0;
    if (literal) assertAddressClass(classifyAddress(opts.host), opts.host, { allowLan: true });
    else if (["metadata", "metadata.google.internal", "instance-data"].includes(opts.host.toLowerCase())) throw new NetBlockedError(`${opts.host} is a cloud metadata host. It is always blocked.`);
    const lookup = literal ? undefined : guardedLookup({ allowLan: true }, { resolver: opts.resolver });
    const timeoutMs = opts.connectTimeoutMs ?? 10_000;
    const socket: net.Socket = await new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      const s = opts.tls
        ? tls.connect({ host: opts.host, port: opts.port, ...(literal ? {} : { servername: opts.host }), rejectUnauthorized: !opts.insecureTls, ...(lookup ? { lookup } : {}) })
        : net.connect({ host: opts.host, port: opts.port, ...(lookup ? { lookup } : {}) });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`could not reach the broker at ${opts.host}:${opts.port} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      s.once("error", onError);
      s.once(opts.tls ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        s.off("error", onError);
        resolve(s);
      });
      if (opts.signal) {
        if (opts.signal.aborted) s.destroy(new Error("cancelled"));
        else opts.signal.addEventListener("abort", () => s.destroy(new Error("cancelled")), { once: true });
      }
    });
    const client = new MqttClient(socket);
    client.attach();
    const keepAlive = opts.keepAliveSec ?? 30;
    const flags = 0x02 | (opts.username ? 0x80 : 0) | (opts.password ? 0x40 : 0);
    const body = Buffer.concat([
      utf8("MQTT"),
      Buffer.from([4, flags, keepAlive >> 8, keepAlive & 255]),
      utf8(opts.clientId ?? `ares-${Math.random().toString(16).slice(2, 10)}`),
      ...(opts.username ? [utf8(opts.username)] : []),
      ...(opts.password ? [utf8(opts.password)] : []),
    ]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.close();
        reject(new Error("the broker did not answer the connection request"));
      }, timeoutMs);
      client.connack = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      socket.write(packet(1, 0, body));
    });
    if (keepAlive > 0) {
      client.pingTimer = setInterval(() => client.write(Buffer.from([0xc0, 0])), Math.max(5, keepAlive / 2) * 1000);
      client.pingTimer.unref?.();
    }
    return client;
  }

  private write(data: Buffer): void {
    if (!this.closed) this.socket.write(data);
  }

  private attach(): void {
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      try {
        this.drain();
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
    this.socket.on("error", (err) => this.fail(err));
    this.socket.on("close", () => this.fail(new Error("the broker closed the connection")));
  }

  private fail(err: Error): void {
    if (!this.error) this.error = err;
    if (!this.closed) this.breakNow(err);
    this.connack?.reject(err);
    this.connack = undefined;
    for (const p of this.pendingAck.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pendingAck.clear();
    this.close();
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < 2) return;
      let multiplier = 1;
      let length = 0;
      let i = 1;
      let byte: number;
      do {
        if (i >= this.buffer.length) return; // need more bytes
        byte = this.buffer[i]!;
        length += (byte & 127) * multiplier;
        multiplier *= 128;
        i++;
        if (i > 5) throw new Error("malformed packet from the broker");
      } while (byte & 128);
      if (length > MAX_PACKET) throw new Error(`the broker sent a ${length}-byte packet (limit ${MAX_PACKET})`);
      if (this.buffer.length < i + length) return;
      const header = this.buffer[0]!;
      const body = this.buffer.subarray(i, i + length);
      this.buffer = this.buffer.subarray(i + length);
      this.handle(header >> 4, header & 15, body);
    }
  }

  private handle(type: number, flags: number, body: Buffer): void {
    switch (type) {
      case 2: {
        // CONNACK
        const code = body[1] ?? 255;
        if (code === 0) this.connack?.resolve();
        else this.connack?.reject(new Error(CONNACK_TEXT[code] ?? `the broker refused the connection (code ${code})`));
        this.connack = undefined;
        return;
      }
      case 3: {
        // PUBLISH
        const qos = ((flags >> 1) & 3) as 0 | 1 | 2;
        const retain = (flags & 1) === 1;
        const tlen = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + tlen).toString("utf8");
        let at = 2 + tlen;
        let id = 0;
        if (qos > 0) {
          id = body.readUInt16BE(at);
          at += 2;
        }
        const payload = Buffer.from(body.subarray(at));
        if (qos === 1) this.write(packet(4, 0, Buffer.from([id >> 8, id & 255])));
        else if (qos === 2) this.write(packet(5, 0, Buffer.from([id >> 8, id & 255])));
        const message: MqttMessage = { topic, payload, qos, retain, receivedAt: Date.now() };
        for (const h of this.handlers) h(message);
        return;
      }
      case 4: // PUBACK
      case 9: {
        // SUBACK
        const id = body.readUInt16BE(0);
        const pending = this.pendingAck.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingAck.delete(id);
          pending.resolve(type === 9 ? [...body.subarray(2)] : []);
        }
        return;
      }
      case 6:
        // PUBREL (we never ask for QoS 2, but answer a broker that sends it anyway)
        this.write(packet(7, 0, body.subarray(0, 2)));
        return;
      default:
        return; // PINGRESP and anything else
    }
  }

  private ack(id: number, what: string, ms = 10_000): Promise<number[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAck.delete(id);
        reject(new Error(`the broker did not acknowledge the ${what} within ${Math.round(ms / 1000)}s`));
      }, ms);
      this.pendingAck.set(id, { resolve, reject, timer });
    });
  }

  private id(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= 65535 ? 1 : this.nextId + 1;
    return id;
  }

  onMessage(handler: (m: MqttMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async publish(topic: string, payload: Buffer, opts: { qos?: 0 | 1; retain?: boolean } = {}): Promise<void> {
    if (this.closed) throw this.error ?? new Error("not connected");
    const bad = validateTopicName(topic);
    if (bad) throw new Error(bad);
    const qos = opts.qos ?? 0;
    const id = qos > 0 ? this.id() : 0;
    const body = Buffer.concat([utf8(topic), ...(qos > 0 ? [Buffer.from([id >> 8, id & 255])] : []), payload]);
    const waiting = qos > 0 ? this.ack(id, "publish") : undefined;
    this.write(packet(3, (qos << 1) | (opts.retain ? 1 : 0), body));
    await waiting;
  }

  /** Returns the granted QoS per filter (0x80 = refused). */
  async subscribe(filters: string[], qos: 0 | 1 = 0): Promise<number[]> {
    if (this.closed) throw this.error ?? new Error("not connected");
    for (const f of filters) {
      const bad = validateTopicFilter(f);
      if (bad) throw new Error(bad);
    }
    const id = this.id();
    const body = Buffer.concat([Buffer.from([id >> 8, id & 255]), ...filters.flatMap((f) => [utf8(f), Buffer.from([qos])])]);
    const waiting = this.ack(id, "subscription");
    this.write(packet(8, 2, body));
    return waiting;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.handlers.clear();
    try {
      this.socket.end(Buffer.from([0xe0, 0]));
    } catch {
      // already gone
    }
    setTimeout(() => this.socket.destroy(), 500).unref();
  }
}
