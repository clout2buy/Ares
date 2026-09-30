// Mqtt — read and drive the owner's MQTT broker (Home Assistant, zigbee2mqtt,
// Tasmota, ESPHome, Shelly, Mosquitto on a NAS). The broker URL — credentials
// included — lives only in the credential vault as MQTT_URL (the owner enters
// it once in the secure form: Connect service "mqtt"); it never passes through
// the model.
//
//   status      connect and report; the cheapest check that the broker answers
//   subscribe   listen on a topic filter for N seconds / N messages, return them
//   retained    the retained messages under a filter (the last known state)
//   tree        a snapshot of the topics seen under a filter, with caps
//   publish     send a message — a WRITE: asks the owner; lock/alarm/door-like
//               topics and clearing a retained message are always their decision
//
// Everything is bounded: seconds, message count, bytes, topics, payload preview.

import { z } from "zod";
import { getCredential } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";
import { MqttClient, parseMqttUrl, validateTopicFilter, validateTopicName, type MqttMessage } from "./openapi/mqttClient.js";

const inputSchema = z
  .object({
    action: z
      .enum(["status", "subscribe", "retained", "tree", "publish"])
      .describe("status: test the broker. subscribe: collect messages on a filter. retained: the retained (last known) messages on a filter. tree: topics seen under a filter. publish: send a message (asks the owner)."),
    topic: z.string().optional().describe("subscribe/retained/tree: a topic filter (+ single level, # rest), e.g. zigbee2mqtt/# or home/+/temperature (default # for tree). publish: the exact topic (no wildcards)."),
    payload: z.union([z.string(), z.number(), z.boolean(), z.record(z.any()), z.array(z.any())]).optional().describe("publish: the message; an object/array is sent as JSON."),
    retain: z.boolean().optional().describe("publish: ask the broker to keep it as the topic's retained message."),
    qos: z.union([z.literal(0), z.literal(1)]).optional().describe("publish/subscribe: QoS 0 (default) or 1."),
    seconds: z.number().min(1).max(60).optional().describe("subscribe/tree: how long to listen (default 5; tree max 20)."),
    max_messages: z.number().int().min(1).max(200).optional().describe("subscribe: stop after this many messages (default 20)."),
    max_topics: z.number().int().min(1).max(1000).optional().describe("tree: how many topics to return (default 200)."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface MqttOutput {
  message: string;
  messages?: Array<{ topic: string; payload: string; retained: boolean; ageMs?: number; bytes: number }>;
  topics?: Array<{ topic: string; count: number; retained: boolean; last: string }>;
  dropped?: number;
  broker?: string;
}

const NOT_CONNECTED =
  "No MQTT broker is connected. Call Connect with service \"mqtt\" — the owner enters the broker URL (mqtt://user:pass@host:1883, or mqtts:// for TLS) in a secure form on their phone. Headless fallback: set MQTT_URL.";

const RISKY_TOPIC = /(^|[/_-])(lock|unlock|alarm|arm|disarm|siren|door|garage|gate|valve|heater|boiler|furnace|oven|stove|panic|security|camera)($|[/_-])/i;

export function publishNeedsOwnerDecision(topic: string, payload: unknown, retain: boolean | undefined): string | null {
  if (RISKY_TOPIC.test(topic)) return `the topic looks like it controls a lock, alarm, door or heater (${topic})`;
  const empty = payload === undefined || payload === "";
  if (retain && empty) return "an empty retained message deletes the topic's retained state";
  return null;
}

/** Printable text, or a base64 marker for binary. */
export function previewPayload(payload: Buffer, max = 2000): string {
  const text = payload.toString("utf8");
  // eslint-disable-next-line no-control-regex
  if (text.includes("�") || /[\u0000-\u0008\u000e-\u001f]/.test(text)) return `base64:${payload.subarray(0, Math.floor(max * 0.75)).toString("base64")}${payload.length > max * 0.75 ? "…" : ""}`;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function brokerUrl(): Promise<string | undefined> {
  return getCredential("MQTT_URL");
}

function describeBroker(url: string): string {
  try {
    const e = parseMqttUrl(url);
    return `${e.tls ? "mqtts" : "mqtt"}://${e.host}:${e.port}`;
  } catch {
    return "the broker";
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

const MAX_COLLECTED_BYTES = 1024 * 1024;

export const MqttTool = buildTool<typeof inputSchema, MqttOutput>({
  name: "Mqtt",
  description:
    "The owner's MQTT broker (smart-home bus: Home Assistant, zigbee2mqtt, Tasmota, ESPHome, Shelly). status / subscribe (listen for N seconds) / retained (last known values) / tree (what topics exist) read freely; publish sends a message and asks the owner first. " +
    "Not connected → Connect service \"mqtt\". Bounded: a listen is at most 60 s and 200 messages.",
  safety: "external-state",
  dynamicSafety: (input) => (input.action === "publish" ? "external-state" : "read-only"),
  ownerDecisions: true,
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  watchdogTimeoutMs: 90_000,
  maxResultSizeChars: 40_000,
  activityDescription: (input) => (input.action === "publish" ? `Publishing to ${input.topic ?? "MQTT"}` : input.action === "status" ? "Checking the MQTT broker" : `Listening on ${input.topic ?? "#"}`),
  async checkPermissions(input, ctx) {
    if (input.action !== "publish") return { kind: "allow" };
    if (ctx.permissionMode === "plan") return { kind: "deny", reason: "Mqtt can only read in plan mode." };
    const why = publishNeedsOwnerDecision(input.topic ?? "", input.payload, input.retain);
    if (why) return { kind: "ask", prompt: `Publish to MQTT topic ${input.topic} — ${why}. Payload: ${previewPayload(Buffer.from(typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload ?? "")), 200)}`, suggestion: "deny", ownerDecision: true };
    return { kind: "allow" };
  },
  async call(input: Input, ctx): Promise<ToolResult<MqttOutput>> {
    const url = await brokerUrl();
    if (!url) return failResult<MqttOutput>(NOT_CONNECTED);
    let endpoint;
    try {
      endpoint = parseMqttUrl(url);
    } catch (err) {
      return failResult<MqttOutput>(`The stored broker URL is invalid: ${err instanceof Error ? err.message : String(err)}. Ask the owner to reconnect MQTT.`);
    }
    const label = describeBroker(url);
    let client: MqttClient | undefined;
    try {
      client = await MqttClient.connect({ ...endpoint, signal: ctx.signal });
      switch (input.action) {
        case "status":
          return okResult({ broker: label, message: `Connected to ${label}.` });

        case "publish": {
          const bad = validateTopicName(input.topic ?? "");
          if (bad) return failResult<MqttOutput>(`publish: ${bad}.`);
          const payload = input.payload === undefined ? Buffer.alloc(0) : Buffer.from(typeof input.payload === "string" ? input.payload : typeof input.payload === "object" ? JSON.stringify(input.payload) : String(input.payload));
          if (payload.length > 256 * 1024) return failResult<MqttOutput>("publish: the payload is larger than 256 KB.");
          await client.publish(input.topic!, payload, { qos: input.qos ?? 0, retain: input.retain === true });
          return okResult({ broker: label, message: `Published ${payload.length} bytes to ${input.topic}${input.retain ? " (retained)" : ""}.` });
        }

        case "subscribe":
        case "retained":
        case "tree": {
          const filter = input.topic ?? (input.action === "tree" ? "#" : "");
          if (!filter) return failResult<MqttOutput>(`${input.action} needs topic (a filter such as home/# ).`);
          const bad = validateTopicFilter(filter);
          if (bad) return failResult<MqttOutput>(`${input.action}: ${bad}.`);
          const windowMs = Math.round((input.seconds ?? (input.action === "retained" ? 2 : 5)) * 1000);
          const cappedMs = Math.min(windowMs, input.action === "tree" ? 20_000 : 60_000);
          const maxMessages = input.max_messages ?? 20;
          const maxTopics = input.max_topics ?? 200;
          const includeSys = filter.startsWith("$SYS");
          const collected: MqttMessage[] = [];
          const topics = new Map<string, { count: number; retained: boolean; last: MqttMessage }>();
          let bytes = 0;
          let dropped = 0;
          let finished!: () => void;
          const done = new Promise<void>((r) => (finished = r));
          client.onMessage((m) => {
            if (!includeSys && m.topic.startsWith("$SYS")) return;
            if (input.action === "retained" && !m.retain) return;
            bytes += m.payload.length;
            if (bytes > MAX_COLLECTED_BYTES) {
              dropped++;
              return;
            }
            if (input.action === "tree") {
              const entry = topics.get(m.topic);
              if (entry) {
                entry.count++;
                entry.last = m;
              } else if (topics.size < 5000) topics.set(m.topic, { count: 1, retained: m.retain, last: m });
              else dropped++;
              return;
            }
            if (collected.length >= maxMessages) {
              dropped++;
              return;
            }
            collected.push(m);
            if (input.action === "subscribe" && collected.length >= maxMessages) finished();
          });
          const granted = await client.subscribe([filter], input.qos ?? 0);
          if (granted[0] === 0x80) return failResult<MqttOutput>(`The broker refused the subscription to ${filter} (not permitted for this user).`);
          await Promise.race([sleep(cappedMs, ctx.signal), done]);
          if (input.action === "tree") {
            const rows = [...topics.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .slice(0, maxTopics)
              .map(([topic, e]) => ({ topic, count: e.count, retained: e.retained, last: previewPayload(e.last.payload, 120) }));
            const extra = topics.size > rows.length ? ` (${topics.size - rows.length} more topics not shown; narrow the filter)` : "";
            return okResult({ broker: label, topics: rows, ...(dropped ? { dropped } : {}), message: `${topics.size} topic${topics.size === 1 ? "" : "s"} seen under ${filter} in ${Math.round(cappedMs / 1000)}s${extra}.${topics.size === 0 ? " Retained and periodic messages only appear when something publishes; try a longer window." : ""}` });
          }
          const now = Date.now();
          const messages = collected.map((m) => ({ topic: m.topic, payload: previewPayload(m.payload), retained: m.retain, ageMs: now - m.receivedAt, bytes: m.payload.length }));
          return okResult({
            broker: label,
            messages,
            ...(dropped ? { dropped } : {}),
            message: messages.length
              ? `${messages.length} message${messages.length === 1 ? "" : "s"} on ${filter}${dropped ? ` (${dropped} more dropped by the caps)` : ""}.`
              : input.action === "retained"
                ? `No retained messages under ${filter}.`
                : `Nothing arrived on ${filter} in ${Math.round(cappedMs / 1000)}s.`,
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failResult<MqttOutput>(`MQTT ${input.action} failed: ${message.replace(url, "[broker url]")}`);
    } finally {
      client?.close();
    }
  },
});
