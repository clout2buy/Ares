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
import { getShortcutDirectory, isSensitiveShortcut, resolveShortcut, sanitizeShortcutList, shortcutsPromptLine, type ShortcutMeta, type ShortcutOutcome } from "./deviceShortcuts.js";
import { buildProposal } from "./shortcutBuilder.js";
import { STEP_KINDS } from "./shortcutBuilder.js";

const inputSchema = z
  .object({
    action: z
      .enum(["status", "invoke", "shortcuts", "propose_shortcut"])
      .describe(
        "status: which phones are connected and what each one currently lets you do (capability, enabled, permission, risk). invoke: run one capability on the phone. shortcuts: the owner's registered Shortcuts (spoken alias, exact name, when to use) you may run with shortcut.run. propose_shortcut: suggest a NEW Shortcut for the owner to add (nothing runs; they review the steps).",
      ),
    proposal: z
      .object({
        name: z.string().max(100).describe("The Shortcut's name."),
        description: z.string().max(300).optional(),
        steps: z
          .array(
            z
              .object({
                do: z.enum(STEP_KINDS).describe("text, ask, notify, open_url, get_url, set_volume, wait, speak, show_result, alert, comment, set_focus"),
                text: z.string().max(4000).optional().describe("text / speak / show_result / comment"),
                prompt: z.string().max(300).optional().describe("ask"),
                default: z.string().max(500).optional().describe("ask"),
                title: z.string().max(100).optional().describe("notify / alert"),
                body: z.string().max(500).optional().describe("notify"),
                message: z.string().max(500).optional().describe("alert"),
                url: z.string().max(2000).optional().describe("open_url / get_url (http or https)"),
                method: z.enum(["GET", "POST"]).optional().describe("get_url"),
                json: z.record(z.string()).optional().describe("get_url POST: string fields of the JSON body"),
                level: z.number().min(0).max(1).optional().describe("set_volume, 0 to 1"),
                seconds: z.number().min(0).max(3600).optional().describe("wait"),
                on: z.boolean().optional().describe("set_focus"),
                mode: z.string().max(40).optional().describe("set_focus, e.g. Do Not Disturb"),
              })
              .strict(),
          )
          .min(1)
          .max(30),
      })
      .strict()
      .optional()
      .describe("propose_shortcut: the Shortcut to suggest, in the documented step subset."),
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
  shortcuts?: Array<DeviceShortcut & { device: string; lastRun?: ShortcutMeta["lastRun"] }>;
  proposal?: { id: string; name: string; recipe: string[]; file: { available: boolean; reason?: string } };
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


/** The Shortcut library for one phone: what the owner synced (aliases, when to use, sensitivity) plus whatever the live socket advertised. */
function libraryFor(deviceId: string | undefined): ShortcutMeta[] {
  const bridge = getDeviceBridge();
  const devices = bridge?.list() ?? [];
  const picked = (deviceId && deviceId !== "default" ? devices.find((d) => d.id === deviceId || d.name === deviceId) : undefined) ?? devices.find((d) => d.connected) ?? devices[0];
  const live = sanitizeShortcutList(picked?.shortcuts ?? []);
  const dir = getShortcutDirectory();
  return dir ? dir.merged(picked?.id ?? (deviceId && deviceId !== "default" ? deviceId : undefined), live) : live;
}

/** shortcut.run's args.name as the owner would say it, resolved to the exact Shortcut (or why not). */
function resolveRun(device: string | undefined, args: Record<string, unknown> | undefined) {
  const name = typeof args?.name === "string" ? args.name : "";
  const library = libraryFor(device);
  return { library, resolution: resolveShortcut(library, name), name };
}

/** The class a call is gated at. Only shortcut.run is special: a Shortcut the owner explicitly marked routine rides "write"; every other case keeps the floor. */
function callRisk(device: string | undefined, capability: string, args: Record<string, unknown> | undefined): DeviceRisk {
  const base = gatingRisk(getDeviceBridge(), device, capability);
  if (capability !== "shortcut.run" || base === "read") return base;
  const { resolution } = resolveRun(device, args);
  return resolution.kind === "match" && !isSensitiveShortcut(resolution.shortcut) ? "write" : base;
}

/** True when `input` names a Shortcut the owner explicitly marked routine (the policy gate lets only those skip the owner prompt). */
export function isRoutineShortcutCall(input: { device?: string; args?: Record<string, unknown> }): boolean {
  return callRisk(input.device, "shortcut.run", input.args) === "write";
}

const BASE_DESCRIPTION =
  "Phone Hands: act on the owner's iPhone through the Ares app — read and create calendar events, reminders, send a notification, look up a contact, read a health summary, run a Shortcut, open a URL, and (when the phone advertises them) location, battery, clipboard, speech, brightness, network, steps, latest photos, compose mail/text, ask for Face ID confirmation. " +
  "ALWAYS call `status` first in a session: the phone decides what exists, what is enabled and what iOS permission it has; never assume a capability. Then `invoke` {capability,args,reason}. Give a short human `reason` every time — it is shown on the phone. " +
  "Prefer read capabilities to look before you write. Risk classes: read runs freely; write asks the owner (unless they granted standing permission); sensitive (deleting events, contacts, health, location, clipboard, photos, Shortcuts, opening URLs) asks the owner on EVERY call. " +
  "Shortcuts: the owner gives each one a spoken alias and a line on when to use it (`shortcuts` lists them). \"Run my bedtime routine\" means find the alias or name that fits, then invoke shortcut.run {name}; a Shortcut they marked routine runs with less friction, any other asks every time. If two fit, ask which. `propose_shortcut` suggests a new Shortcut as steps; it changes nothing until the owner adds it, and iOS only imports signed Shortcuts, so it arrives as a recipe. " +
  "It works when the app is open; if it is closed Ares wakes it with a push and waits — on `not_connected` tell the owner to open the Ares app, don't retry in a loop. Running a Shortcut needs the app OPEN on screen. " +
  "Every call is audited and shown in the phone's Activity tab. Errors are typed: capability_unavailable (phone doesn't offer it), disabled_by_owner, permission_denied (iOS permission not granted — ask the owner to allow it in Settings), timeout, not_connected, paused, forbidden. " +
  "Never put secrets in args. Not available in guest chats.";

const baseTool = buildTool<typeof inputSchema, IPhoneOutput>({
  name: "iPhone",
  description: BASE_DESCRIPTION,
  safety: "external-state",
  dynamicSafety: (input) => {
    if (input.action !== "invoke") return "read-only";
    return callRisk(input.device, input.capability ?? "", input.args) === "read" ? "read-only" : "external-state";
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
    const risk: DeviceRisk = callRisk(input.device, capability, input.args);
    if (risk === "read") return { kind: "allow" };
    const device = bridge?.list().find((d) => d.connected)?.name ?? "your iPhone";
    let what = input.reason?.trim() || `use ${capability}`;
    let shown = input.args;
    if (capability === "shortcut.run") {
      const r = resolveRun(input.device, input.args).resolution;
      // The prompt names the exact Shortcut the owner will be running, whatever words were used to ask for it.
      if (r.kind === "match") shown = { ...input.args, name: r.shortcut.name };
      what = input.reason?.trim() || `run your Shortcut "${r.kind === "match" ? r.shortcut.name : String(input.args?.name ?? "").slice(0, 60)}"`;
    }
    const args = summarizeArgs(shown);
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
        const library = devices.flatMap((d) => libraryFor(d.id));
        const aliased = library.filter((s) => s.alias);
        const tail = library.length ? `\nShortcuts: ${library.length} in the owner's library${aliased.length ? ` (aliases: ${aliased.slice(0, 12).map((s) => `"${s.alias}" -> ${s.name}`).join("; ")})` : ""}. Use action shortcuts for details.` : "";
        return okResult<IPhoneOutput>({ devices, message: devices.map(describeDevice).join("\n") + tail }, `${devices.length} phone(s)`);
      }
      case "shortcuts": {
        const shortcuts = bridge.list().flatMap((d) => libraryFor(d.id).map((s) => ({ ...s, device: d.id })));
        if (!shortcuts.length) return okResult<IPhoneOutput>({ shortcuts, message: "No Shortcuts are registered on the phone." });
        return okResult<IPhoneOutput>({
          shortcuts,
          message: shortcuts
            .map((s) => `${s.alias ? `"${s.alias}" -> ` : ""}${s.name}${s.acceptsInput ? " (takes input)" : ""}${s.whenToUse ? ` — use when: ${s.whenToUse}` : s.description ? ` — ${s.description}` : ""}${s.sensitive === false ? " [routine]" : " [asks every time]"}${s.lastRun ? ` (last run ${s.lastRun.at.slice(0, 16).replace("T", " ")}: ${s.lastRun.outcome})` : ""}`)
            .join("\n"),
        });
      }
      case "propose_shortcut": {
        const dir = getShortcutDirectory();
        if (!dir) return failResult<IPhoneOutput>("Shortcut proposals live in the always-on garrison. Use a garrison-backed session.");
        if (!input.proposal) return failResult<IPhoneOutput>("propose_shortcut needs proposal {name, steps[]}.");
        let built;
        try {
          built = buildProposal(input.proposal);
        } catch (err) {
          return failResult<IPhoneOutput>(`invalid_args: ${err instanceof Error ? err.message : String(err)}`, { errorCode: "invalid_args" });
        }
        const stored = await dir.addProposal({ name: built.name, ...(built.description ? { description: built.description } : {}), steps: built.steps, recipe: built.recipe, file: built.file });
        return okResult<IPhoneOutput>(
          {
            proposal: { id: stored.id, name: stored.name, recipe: stored.recipe, file: stored.file },
            message: `Proposed "${stored.name}" (${stored.id}). It is waiting in the Ares app under Shortcuts for the owner to review; nothing was added or run. iOS only imports signed Shortcuts, so they follow the recipe${stored.file.available ? " (an unsigned file is offered too and iOS may refuse it)" : ""}:\n${stored.recipe.join("\n")}`,
          },
          `proposed ${stored.name}`,
        );
      }
      case "invoke": {
        if (!input.capability) return failResult<IPhoneOutput>("invoke needs capability (see status).");
        const reason = input.reason?.trim() || `Ares wants to use ${input.capability}`;
        let args = input.args ?? {};
        let ranName: string | undefined;
        if (input.capability === "shortcut.run") {
          // The owner's words (an alias, "my bedtime routine") become the exact Shortcut name before anything is sent.
          const { resolution } = resolveRun(input.device, args);
          if (resolution.kind === "ambiguous") {
            return failResult<IPhoneOutput>(`invalid_args: more than one Shortcut fits "${String(args.name ?? "").slice(0, 60)}": ${resolution.candidates.map((c) => (c.alias ? `"${c.alias}" (${c.name})` : c.name)).join(", ")}. Ask the owner which one.`, { capability: input.capability, errorCode: "invalid_args" });
          }
          if (resolution.kind === "match") {
            args = { ...args, name: resolution.shortcut.name };
            ranName = resolution.shortcut.name;
          } else if (typeof args.name === "string") ranName = args.name.trim().slice(0, 100);
        }
        const started = Date.now();
        const r = await bridge.invoke(input.device ?? "default", input.capability, args, {
          reason,
          sessionId: ctx.sessionId,
          actor: "ares",
          signal: ctx.signal,
          ...(input.timeout_seconds ? { timeoutMs: input.timeout_seconds * 1000 } : {}),
        });
        if (input.capability === "shortcut.run" && ranName) {
          // One history for every run, whoever started it: it feeds the app's "last result" and the audit trail.
          const outcome: ShortcutOutcome = r.ok ? "ok" : r.error.code === "timeout" ? "timeout" : r.error.code === "capability_unavailable" || r.error.code === "not_connected" || r.error.code === "disabled_by_owner" ? "unavailable" : /declined/.test(r.error.message) ? "declined" : "error";
          const result = r.ok ? (r.result as { result?: unknown } | null)?.result : undefined;
          await getShortcutDirectory()?.recordRun(r.device ?? (typeof input.device === "string" ? input.device : "default"), {
            name: ranName,
            outcome,
            ms: Date.now() - started,
            actor: "ares",
            ...(typeof result === "string" ? { summary: result } : !r.ok ? { summary: r.error.message } : {}),
          }).catch(() => undefined);
        }
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

/** The tool as the engine sees it: the description carries the owner's Shortcut aliases as they are RIGHT NOW (read each time the schema is). */
export const IPhoneTool: typeof baseTool = {
  ...baseTool,
  schema: Object.defineProperty({ ...baseTool.schema }, "description", {
    enumerable: true,
    configurable: true,
    get: () => {
      const dir = getShortcutDirectory();
      const line = dir ? shortcutsPromptLine(dir.merged(undefined)) : "";
      return `${BASE_DESCRIPTION}${line}`;
    },
  }),
};

export type { Input as IPhoneInput };
