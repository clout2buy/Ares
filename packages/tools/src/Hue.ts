// Hue — the owner's Philips Hue lights, straight over the home LAN.
//
// The garrison box sits on the owner's home network, so there is no cloud
// account in the loop: Ares talks to the bridge itself with the CLIP v1 API.
//   discovery  https://discovery.meethue.com (bridges that phoned home from
//              this public IP; rate-limited to ~1 request / 15 min), then
//              mDNS `_hue._tcp.local` on the LAN as the fallback
//   pairing    POST /api {"devicetype":"ares#doingbox"} answers error 101
//              "link button not pressed" until the owner presses the round
//              button; within 30 s of the press it answers {success:{username}}
//   control    GET /api/<user>/lights|groups|scenes,
//              PUT /api/<user>/lights/<id>/state, PUT /api/<user>/groups/<id>/action
// Docs: https://developers.meethue.com/develop/get-started-2/ ,
//       https://developers.meethue.com/develop/application-design-guidance/hue-bridge-discovery/ ,
//       https://developers.meethue.com/develop/application-design-guidance/color-conversion-formulas-rgb-to-xy-and-back/
//
// Transport: v1 still answers on plain http on the LAN, so that is tried
// first. A bridge that refuses http gets https with its self-signed Signify
// certificate — accepted only when the certificate's CN is the bridge id we
// paired with (the bridge's cert CN is its id), so a random box on the LAN
// cannot stand in for it.
//
// ARES_HUE_PAIR_WINDOW_MS  how long pairing keeps polling for the button press
//                          (default 12000 — the hub gives its form verifier 20 s in all, discovery included).

import { request as httpsRequest } from "node:https";
import dgram from "node:dgram";
import { z } from "zod";
import { getCredential, setCredential } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";

export interface HueBridgeRef {
  id: string;
  ip: string;
}

const DISCOVERY_URL = "https://discovery.meethue.com/";

function pairWindowMs(): number {
  const raw = Number(process.env.ARES_HUE_PAIR_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 12_000;
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

// ─── transport ───────────────────────────────────────────────────────────────

function httpsInsecure(url: string, method: string, body: string | undefined, bridgeId: string | undefined, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method, rejectUnauthorized: false, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}, ...(signal ? { signal } : {}), timeout: 10_000 },
      (res) => {
        const cert = (res.socket as import("node:tls").TLSSocket).getPeerCertificate?.();
        const cn = String((cert?.subject as unknown as Record<string, unknown> | undefined)?.CN ?? "").toLowerCase();
        if (bridgeId && cn && cn !== bridgeId.toLowerCase()) {
          res.destroy();
          reject(new Error(`the device at that address presented certificate "${cn}", not Hue bridge ${bridgeId}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error(`the bridge answered HTTP ${res.statusCode} with no JSON`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("the bridge did not answer")));
    req.on("error", reject);
    req.end(body);
  });
}

/** One CLIP v1 call: http first, the bridge's https as the fallback. */
export async function hueCall(ip: string, path: string, opts: { method?: string; body?: unknown; bridgeId?: string; signal?: AbortSignal } = {}): Promise<unknown> {
  const method = opts.method ?? "GET";
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const timeout = AbortSignal.timeout(8_000);
  try {
    const res = await fetch(`http://${ip}${path}`, {
      method,
      ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    return await res.json();
  } catch (err) {
    // A host that didn't answer at all won't answer https either; only a
    // refused/odd http answer is worth the second try.
    if (opts.signal?.aborted || timeout.aborted) throw err;
    return httpsInsecure(`https://${ip}${path}`, method, body, opts.bridgeId, opts.signal);
  }
}

function hueErrors(result: unknown): string[] {
  if (!Array.isArray(result)) return [];
  return result
    .map((row) => (row as { error?: { description?: string } }).error?.description)
    .filter((d): d is string => typeof d === "string");
}

// ─── discovery & pairing ─────────────────────────────────────────────────────

/** Ask a candidate address whether it is a Hue bridge (the unauthenticated
 *  config subset answers with its bridgeid). */
async function probeBridge(ip: string, signal?: AbortSignal): Promise<HueBridgeRef | null> {
  try {
    const config = (await hueCall(ip, "/api/0/config", { ...(signal ? { signal } : {}) })) as { bridgeid?: string };
    return typeof config?.bridgeid === "string" ? { id: config.bridgeid.toLowerCase(), ip } : null;
  } catch {
    return null;
  }
}

/** The DNS query for PTR _hue._tcp.local, asking for a unicast answer. */
function mdnsQuery(): Buffer {
  const labels = ["_hue", "_tcp", "local"];
  const name = Buffer.concat([...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([header, name, Buffer.from([0x00, 0x0c, 0x80, 0x01])]);
}

/** mDNS on the LAN: every responder to a `_hue._tcp` query IS a bridge, so
 *  the reply's source address is all we need (confirmed by probeBridge). */
export function mdnsHueAddresses(timeoutMs = 2_500): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    let socket: dgram.Socket;
    try {
      socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    const done = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...found]);
    };
    socket.on("error", done);
    socket.on("message", (msg, rinfo) => {
      if (msg.includes("_hue")) found.add(rinfo.address);
    });
    socket.bind(0, () => {
      socket.send(mdnsQuery(), 5353, "224.0.0.251", () => undefined);
      setTimeout(done, timeoutMs).unref?.();
    });
  });
}

/** Every Hue bridge this box can see: the cloud list, else mDNS. */
export async function discoverHueBridges(opts: { signal?: AbortSignal; mdns?: boolean } = {}): Promise<HueBridgeRef[]> {
  const candidates = new Set<string>();
  try {
    const timeout = AbortSignal.timeout(5_000);
    const res = await fetch(DISCOVERY_URL, { signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout });
    if (res.ok) {
      const rows = (await res.json()) as Array<{ internalipaddress?: string }>;
      for (const row of Array.isArray(rows) ? rows : []) if (row.internalipaddress && IPV4.test(row.internalipaddress)) candidates.add(row.internalipaddress);
    }
  } catch {
    // offline or rate-limited — the LAN still works
  }
  if (!candidates.size && opts.mdns !== false) for (const ip of await mdnsHueAddresses()) candidates.add(ip);
  const probed = await Promise.all([...candidates].map((ip) => probeBridge(ip, opts.signal)));
  return probed.filter((b): b is HueBridgeRef => b !== null);
}

export interface HuePairing {
  bridge: HueBridgeRef;
  username: string;
}

/**
 * Pair with the bridge whose link button was pressed. Polls every bridge
 * found until one hands out a username or the window closes — the owner may
 * press the button just before or just after tapping Connect.
 */
export async function pairHueBridge(opts: { signal?: AbortSignal; devicetype?: string; bridges?: HueBridgeRef[]; windowMs?: number; pollMs?: number } = {}): Promise<HuePairing> {
  const bridges = opts.bridges ?? (await discoverHueBridges({ ...(opts.signal ? { signal: opts.signal } : {}) }));
  if (!bridges.length) throw new Error("no Hue bridge answered on this network — check it's powered and plugged into the router the Ares box is on");
  const devicetype = (opts.devicetype ?? "ares#doingbox").slice(0, 40);
  const deadline = Date.now() + (opts.windowMs ?? pairWindowMs());
  const pollMs = opts.pollMs ?? 1_000;
  let lastError = "";
  for (;;) {
    for (const bridge of bridges) {
      let result: unknown;
      try {
        result = await hueCall(bridge.ip, "/api", { method: "POST", body: { devicetype }, bridgeId: bridge.id, ...(opts.signal ? { signal: opts.signal } : {}) });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      const username = Array.isArray(result) ? (result[0] as { success?: { username?: string } })?.success?.username : undefined;
      if (username) return { bridge, username };
      lastError = hueErrors(result)[0] ?? "the bridge refused";
    }
    if (Date.now() + pollMs > deadline || opts.signal?.aborted) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (/link button/i.test(lastError)) throw new Error("the bridge's link button wasn't pressed — press the round button on top of the bridge, then tap Connect within 30 seconds");
  throw new Error(`the bridge refused pairing: ${lastError}`);
}

// ─── color ───────────────────────────────────────────────────────────────────

const NAMED: Record<string, string> = {
  red: "#ff0000", green: "#00ff00", blue: "#0000ff", white: "#ffffff", warm: "#ffb46b", "warm white": "#ffb46b",
  orange: "#ff8000", yellow: "#ffd700", purple: "#8000ff", pink: "#ff69b4", cyan: "#00ffff",
};

/** sRGB hex → CIE xy, the formula Hue publishes (gamma-expand, Wide RGB D65). */
export function hexToXy(color: string): [number, number] | null {
  const hex = NAMED[color.trim().toLowerCase()] ?? color.trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const expand = (c: number) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92);
  const r = expand(((n >> 16) & 255) / 255);
  const g = expand(((n >> 8) & 255) / 255);
  const b = expand((n & 255) / 255);
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return [0.3227, 0.329];
  return [Math.round((X / sum) * 10_000) / 10_000, Math.round((Y / sum) * 10_000) / 10_000];
}

// ─── the tool ────────────────────────────────────────────────────────────────

const inputSchema = z
  .object({
    action: z
      .enum(["lights", "rooms", "scenes", "set", "scene"])
      .describe("lights / rooms / scenes: list them with their state. set: change a light or a room (on, brightness, color). scene: activate a scene."),
    target: z.string().optional().describe("set: a light or room name (or id), or 'all'. scene: optional room name to disambiguate."),
    on: z.boolean().optional().describe("set: turn on (true) or off (false)."),
    brightness: z.number().min(0).max(100).optional().describe("set: 0-100 percent (0 turns it off)."),
    color: z.string().optional().describe("set: #rrggbb hex, or red/green/blue/white/warm/orange/yellow/purple/pink/cyan."),
    scene: z.string().optional().describe("scene: the scene's name or id."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface HueOutput {
  lights?: Array<{ id: string; name: string; on: boolean; brightness: number; reachable: boolean }>;
  rooms?: Array<{ id: string; name: string; type: string; anyOn: boolean; lights: number }>;
  scenes?: Array<{ id: string; name: string; room?: string }>;
  message: string;
}

const NOT_CONNECTED =
  "The Hue bridge isn't paired, so Ares can't reach the lights. Call Connect with service \"hue\" — the owner presses the button on the bridge and taps Connect — then retry.";

interface HueCreds {
  ip: string;
  user: string;
  bridgeId?: string;
}

async function hueCreds(): Promise<HueCreds | null> {
  const ip = (await getCredential("HUE_BRIDGE_IP"))?.trim();
  const user = (await getCredential("HUE_USERNAME"))?.trim();
  const bridgeId = (await getCredential("HUE_BRIDGE_ID"))?.trim();
  return ip && user ? { ip, user, ...(bridgeId ? { bridgeId } : {}) } : null;
}

/** A call against the paired bridge. When DHCP moved it, find it again by id
 *  and remember the new address. */
async function bridgeCall(c: HueCreds, path: string, signal: AbortSignal, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const call = (ip: string) => hueCall(ip, `/api/${encodeURIComponent(c.user)}${path}`, { ...init, signal, ...(c.bridgeId ? { bridgeId: c.bridgeId } : {}) });
  try {
    return await call(c.ip);
  } catch (err) {
    if (!c.bridgeId || signal.aborted) throw err;
    const moved = (await discoverHueBridges({ signal })).find((b) => b.id === c.bridgeId);
    if (!moved || moved.ip === c.ip) throw err;
    await setCredential("HUE_BRIDGE_IP", moved.ip);
    c.ip = moved.ip;
    return call(moved.ip);
  }
}

function asMap(result: unknown): Record<string, Record<string, any>> {
  const errors = hueErrors(result);
  if (errors.length) throw new Error(`Hue: ${errors[0]}`);
  return result && typeof result === "object" ? (result as Record<string, Record<string, any>>) : {};
}

function findByName(map: Record<string, Record<string, any>>, wanted: string): [string, Record<string, any>] | undefined {
  const w = wanted.trim().toLowerCase();
  return Object.entries(map).find(([id, v]) => id === w || String(v.name ?? "").toLowerCase() === w) ?? Object.entries(map).find(([, v]) => String(v.name ?? "").toLowerCase().includes(w));
}

/** The CLIP v1 state body for a `set`. Exported for tests. */
export function hueStateBody(input: Pick<Input, "on" | "brightness" | "color">): Record<string, unknown> | { error: string } {
  const body: Record<string, unknown> = {};
  if (input.on !== undefined) body.on = input.on;
  if (input.brightness !== undefined) {
    if (input.brightness === 0) body.on = false;
    else {
      body.on = true;
      body.bri = Math.max(1, Math.min(254, Math.round((input.brightness / 100) * 254)));
    }
  }
  if (input.color) {
    const xy = hexToXy(input.color);
    if (!xy) return { error: `"${input.color}" isn't a color I know — use #rrggbb or a basic color name.` };
    body.xy = xy;
    if (body.on === undefined) body.on = true;
  }
  if (!Object.keys(body).length) return { error: "set needs on, brightness or color." };
  return body;
}

export const HueTool = buildTool<typeof inputSchema, HueOutput>({
  name: "Hue",
  description:
    "The owner's Philips Hue lights on the home LAN: list lights, rooms and scenes; turn a light or room on/off, set brightness (0-100) and color (#hex or a basic name); activate a scene. " +
    "If the bridge isn't paired, call Connect service \"hue\" first.",
  safety: "external-state",
  dynamicSafety: (input) => (input.action === "set" || input.action === "scene" ? "external-state" : "read-only"),
  concurrency: "exclusive",
  inputZod: inputSchema,
  watchdogTimeoutMs: 45_000,
  activityDescription: (input) => {
    switch (input.action) {
      case "set": return `Setting ${input.target ?? "the lights"}`;
      case "scene": return `Activating scene ${input.scene ?? ""}`.trim();
      default: return `Listing Hue ${input.action}`;
    }
  },
  async call(input: Input, ctx): Promise<ToolResult<HueOutput>> {
    const c = await hueCreds();
    if (!c) return failResult<HueOutput>(NOT_CONNECTED);
    const signal = ctx.signal;
    try {
      switch (input.action) {
        case "lights": {
          const map = asMap(await bridgeCall(c, "/lights", signal));
          const lights = Object.entries(map).map(([id, l]) => ({
            id,
            name: String(l.name),
            on: Boolean(l.state?.on),
            brightness: Math.round(((Number(l.state?.bri) || 0) / 254) * 100),
            reachable: l.state?.reachable !== false,
          }));
          const message = lights.length ? lights.map((l) => `${l.name}: ${l.on ? `on ${l.brightness}%` : "off"}${l.reachable ? "" : " (unreachable)"}`).join("; ") : "No lights on this bridge.";
          return okResult({ lights, message });
        }
        case "rooms": {
          const map = asMap(await bridgeCall(c, "/groups", signal));
          const rooms = Object.entries(map)
            .filter(([, g]) => g.type === "Room" || g.type === "Zone")
            .map(([id, g]) => ({ id, name: String(g.name), type: String(g.type), anyOn: Boolean(g.state?.any_on), lights: Array.isArray(g.lights) ? g.lights.length : 0 }));
          const message = rooms.length ? rooms.map((r) => `${r.name} (${r.lights} lights, ${r.anyOn ? "on" : "off"})`).join("; ") : "No rooms set up on this bridge.";
          return okResult({ rooms, message });
        }
        case "scenes": {
          const scenes = asMap(await bridgeCall(c, "/scenes", signal));
          const groups = asMap(await bridgeCall(c, "/groups", signal));
          const list = Object.entries(scenes).map(([id, s]) => ({ id, name: String(s.name), ...(s.group && groups[s.group] ? { room: String(groups[s.group]!.name) } : {}) }));
          const message = list.length ? list.map((s) => `${s.name}${s.room ? ` (${s.room})` : ""}`).join("; ") : "No scenes on this bridge.";
          return okResult({ scenes: list, message });
        }
        case "set": {
          const body = hueStateBody(input);
          if ("error" in body) return failResult<HueOutput>(String(body.error));
          const target = (input.target ?? "all").trim();
          let path: string;
          let name: string;
          if (/^all$/i.test(target)) {
            path = "/groups/0/action";
            name = "all lights";
          } else {
            const groups = asMap(await bridgeCall(c, "/groups", signal));
            const room = findByName(Object.fromEntries(Object.entries(groups).filter(([, g]) => g.type === "Room" || g.type === "Zone")), target);
            if (room) {
              path = `/groups/${room[0]}/action`;
              name = String(room[1].name);
            } else {
              const light = findByName(asMap(await bridgeCall(c, "/lights", signal)), target);
              if (!light) return failResult<HueOutput>(`No light or room called "${target}" — call Hue lights or rooms to see the names.`);
              path = `/lights/${light[0]}/state`;
              name = String(light[1].name);
            }
          }
          const result = await bridgeCall(c, path, signal, { method: "PUT", body });
          const errors = hueErrors(result);
          if (errors.length) return failResult<HueOutput>(`Hue refused: ${errors.join("; ")}`);
          const parts = [body.on === false ? "off" : "on", body.bri !== undefined ? `${input.brightness}%` : "", input.color ? input.color : ""].filter(Boolean);
          return okResult({ message: `${name}: ${parts.join(", ")}.` });
        }
        case "scene": {
          if (!input.scene) return failResult<HueOutput>("scene needs the scene's name — call Hue scenes to list them.");
          const scenes = asMap(await bridgeCall(c, "/scenes", signal));
          let pool = scenes;
          if (input.target) {
            const room = findByName(asMap(await bridgeCall(c, "/groups", signal)), input.target);
            if (room) pool = Object.fromEntries(Object.entries(scenes).filter(([, s]) => s.group === room[0]));
          }
          const hit = findByName(pool, input.scene);
          if (!hit) return failResult<HueOutput>(`No scene called "${input.scene}" — call Hue scenes to list them.`);
          const group = hit[1].group ? String(hit[1].group) : "0";
          const result = await bridgeCall(c, `/groups/${group}/action`, signal, { method: "PUT", body: { scene: hit[0] } });
          const errors = hueErrors(result);
          if (errors.length) return failResult<HueOutput>(`Hue refused: ${errors.join("; ")}`);
          return okResult({ message: `Scene "${hit[1].name}" is on.` });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failResult<HueOutput>(`Couldn't reach the Hue bridge at ${c.ip}: ${message}. If it moved or was reset, call Connect service "hue" again.`);
    }
  },
});
