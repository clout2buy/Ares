// iPhone — Phone Hands: let Ares actually DO things on the owner's phone.
//
// The Ares app keeps a socket to this garrison (or answers over HTTP after a
// silent push). Each capability it advertises — calendar, reminders, contacts,
// health, notifications, Shortcuts, location, clipboard … — is a real request
// the phone executes and answers. The live bridge is injected at daemon start
// (DeviceBridge, @ares/garrison); this tool is the model-facing face of it and
// owns the permission mapping: read runs, write asks (or rides a standing
// "always allow"), sensitive is a per-call owner decision that no standing
// grant and no "always" can answer.

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";
import {
  effectiveDeviceRisk,
  getDeviceBridge,
  gatingRisk,
  type DeviceCapability,
  type DeviceRisk,
  type DeviceShortcut,
  type DeviceStatusEntry,
} from "./deviceTypes.js";

const inputSchema = z
  .object({
    action: z
      .enum(["status", "invoke", "shortcuts"])
      .describe(
        "status: which phones are connected and what each one currently lets you do (capability, enabled, permission, risk). invoke: run one capability on the phone. shortcuts: the owner's registered Shortcuts you may run with shortcut.run.",
      ),
    capability: z.string().max(64).optional().describe("invoke: capability id exactly as listed by status, e.g. calendar.create_event."),
    args: z.record(z.unknown()).optional().describe("invoke: the capability's arguments, e.g. {title,start,end} for calendar.create_event. Dates are ISO-8601 with an offset."),
    reason: z.string().max(200).optional().describe("invoke: ONE short human sentence the phone shows the owner, e.g. \"Add 'Dentist' to your calendar\". Always give one."),
    device: z.string().max(128).optional().describe("Which phone (id or name from status). Omit for the default (the one that is connected)."),
    timeout_seconds: z.number().int().min(1).max(120).optional().describe("invoke: how long to wait for the phone to answer (default 25)."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface IPhoneOutput {
  message: string;
  devices?: DeviceStatusEntry[];
  shortcuts?: Array<DeviceShortcut & { device: string }>;
  result?: unknown;
  device?: string;
  capability?: string;
  errorCode?: string;
}

function describeCapability(c: DeviceCapability): string {
  const risk = effectiveDeviceRisk(c.id, c.risk);
  const state = !c.enabled ? "DISABLED by owner" : c.permission !== "granted" ? `permission ${c.permission}` : "ready";
  return `${c.id} [${risk}; ${state}] ${c.description}`;
}

function describeDevice(d: DeviceStatusEntry): string {
  const head = `${d.name} (${d.id})${d.model ? ` · ${d.model}` : ""}${d.os ? ` · ${d.os}` : ""} — ${d.connected ? "connected" : `offline since ${d.lastSeenAt}`}`;
  const caps = d.capabilities.length ? d.capabilities.map((c) => `  - ${describeCapability(c)}`).join("\n") : "  (no capabilities advertised)";
  return `${head}\n${caps}`;
}

function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args).slice(0, 6)) {
    let s = typeof v === "string" ? v : JSON.stringify(v);
    if (/^https?:\/\//.test(s)) s = s.replace(/[?#].*$/, "");
    parts.push(`${k}=${s.length > 60 ? `${s.slice(0, 57)}…` : s}`);
  }
  return parts.join(", ");
}

export const IPhoneTool = buildTool<typeof inputSchema, IPhoneOutput>({
  name: "iPhone",
  description:
    "Phone Hands: act on the owner's iPhone through the Ares app — read and create calendar events, reminders, send a notification, look up a contact, read a health summary, run a Shortcut, open a URL, and (when the phone advertises them) location, battery, clipboard, speech, brightness, network, steps, latest photos, compose mail/text, ask for Face ID confirmation. " +
    "ALWAYS call `status` first in a session: the phone decides what exists, what is enabled and what iOS permission it has; never assume a capability. Then `invoke` {capability,args,reason}. Give a short human `reason` every time — it is shown on the phone. " +
    "Prefer read capabilities to look before you write. Risk classes: read runs freely; write asks the owner (unless they granted standing permission); sensitive (deleting events, contacts, health, location, clipboard, photos, Shortcuts, opening URLs) asks the owner on EVERY call. " +
    "It works when the app is open; if it is closed Ares wakes it with a push and waits — on `not_connected` tell the owner to open the Ares app, don't retry in a loop. " +
    "Every call is audited and shown in the phone's Activity tab. Errors are typed: capability_unavailable (phone doesn't offer it), disabled_by_owner, permission_denied (iOS permission not granted — ask the owner to allow it in Settings), timeout, not_connected, paused, forbidden. " +
    "Never put secrets in args. Not available in guest chats.",
  safety: "external-state",
  dynamicSafety: (input) => {
    if (input.action !== "invoke") return "read-only";
    return gatingRisk(getDeviceBridge(), input.device, input.capability ?? "") === "read" ? "read-only" : "external-state";
  },
  concurrency: "exclusive",
  watchdogTimeoutMs: 4 * 60_000,
  ownerDecisions: true,
  ownPrompts: true,
  inputZod: inputSchema,
  activityDescription: (input) =>
    input.action === "invoke" ? `iPhone ${input.capability ?? "?"}${input.reason ? `: ${input.reason}` : ""}`.slice(0, 120) : `iPhone ${input.action}`,
  async checkPermissions(input, ctx) {
    const bridge = getDeviceBridge();
    if (!bridge) return { kind: "allow" }; // call() explains that Phone Hands lives in the garrison
    if (!bridge.isOwnerSession(ctx.sessionId)) {
      return { kind: "deny", reason: "The owner's phone is not available in guest chats." };
    }
    if (input.action !== "invoke") return { kind: "allow" };
    const capability = input.capability ?? "";
    const risk: DeviceRisk = gatingRisk(bridge, input.device, capability);
    if (risk === "read") return { kind: "allow" };
    const device = bridge?.list().find((d) => d.connected)?.name ?? "your iPhone";
    const what = input.reason?.trim() || `use ${capability}`;
    const args = summarizeArgs(input.args);
    const prompt = `Ares wants to ${risk === "sensitive" ? "access a sensitive part of" : "change something on"} ${device}: ${what} (${capability}${args ? `: ${args}` : ""}).`;
    if (risk === "write") return { kind: "ask", prompt, suggestion: "allow_once" };
    return { kind: "ask", prompt, suggestion: "allow_once", ownerDecision: true };
  },
  async call(input, ctx): Promise<ToolResult<IPhoneOutput>> {
    const bridge = getDeviceBridge();
    if (!bridge) return failResult<IPhoneOutput>("Phone Hands is not running in this process — it lives in the always-on garrison. Use a garrison-backed session.");
    if (!bridge.isOwnerSession(ctx.sessionId)) return failResult<IPhoneOutput>("The owner's phone is not available in guest chats.", { errorCode: "forbidden" });
    switch (input.action) {
      case "status": {
        const devices = bridge.list();
        if (!devices.length) {
          return okResult<IPhoneOutput>({ devices, message: "No phone has connected yet. The owner installs the Ares app and signs in to this garrison; it registers itself." });
        }
        return okResult<IPhoneOutput>({ devices, message: devices.map(describeDevice).join("\n") }, `${devices.length} phone(s)`);
      }
      case "shortcuts": {
        const shortcuts = bridge.list().flatMap((d) => d.shortcuts.map((s) => ({ ...s, device: d.id })));
        if (!shortcuts.length) return okResult<IPhoneOutput>({ shortcuts, message: "No Shortcuts are registered on the phone." });
        return okResult<IPhoneOutput>({
          shortcuts,
          message: shortcuts.map((s) => `${s.name}${s.acceptsInput ? " (takes input)" : ""}${s.description ? ` — ${s.description}` : ""}`).join("\n"),
        });
      }
      case "invoke": {
        if (!input.capability) return failResult<IPhoneOutput>("invoke needs capability (see status).");
        const reason = input.reason?.trim() || `Ares wants to use ${input.capability}`;
        const r = await bridge.invoke(input.device ?? "default", input.capability, input.args ?? {}, {
          reason,
          sessionId: ctx.sessionId,
          actor: "ares",
          signal: ctx.signal,
          ...(input.timeout_seconds ? { timeoutMs: input.timeout_seconds * 1000 } : {}),
        });
        if (!r.ok) {
          return failResult<IPhoneOutput>(`${r.error.code}: ${r.error.message}`, { capability: input.capability, errorCode: r.error.code, ...(r.device ? { device: r.device } : {}) });
        }
        const text = JSON.stringify(r.result ?? null);
        return okResult<IPhoneOutput>(
          { result: r.result, device: r.device, capability: input.capability, message: `${input.capability} ok (${r.durationMs}ms): ${text.length > 3000 ? `${text.slice(0, 3000)}…` : text}` },
          `${input.capability} ok`,
        );
      }
    }
  },
});

export type { Input as IPhoneInput };
