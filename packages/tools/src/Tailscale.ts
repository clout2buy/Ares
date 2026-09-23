// Tailscale — the devices on the owner's tailnet.
//
// Spec: https://api.tailscale.com/api/v2?outputOpenapiSchema=true
//   base https://api.tailscale.com/api/v2, Authorization: Bearer tskey-api-…
//   GET  /tailnet/-/devices                  ("-" = the token's own tailnet)
//   GET  /device/{id}?fields=all
//   POST /device/{id}/authorized  {authorized: bool}
//   POST /device/{id}/expire                 (forces re-authentication)
//   POST /device/{id}/key         {keyExpiryDisabled: bool}
// Authorizing, deauthorizing and expiring change who is on the owner's
// private network, so each asks first and policyGate treats them like
// credentials (never autonomous).

import { z } from "zod";
import { getCredential } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { apiJson, failResult, okResult } from "./_lifeHttp.js";

const API = "https://api.tailscale.com/api/v2";

export const TAILSCALE_ASK_ACTIONS: ReadonlySet<string> = new Set(["authorize", "deauthorize", "expire", "key_expiry"]);

const inputSchema = z
  .object({
    action: z
      .enum(["devices", "device", "authorize", "deauthorize", "expire", "key_expiry"])
      .describe("devices: list. device: details. authorize / deauthorize: allow or cut a device off (asks). expire: force it to log in again (asks). key_expiry: enable/disable key expiry (asks)."),
    device: z.string().optional().describe("A device id, name or hostname."),
    disable_expiry: z.boolean().optional().describe("key_expiry: true to disable key expiry, false to re-enable it."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface TailscaleDevice {
  id: string;
  name: string;
  hostname?: string;
  os?: string;
  addresses?: string[];
  authorized?: boolean;
  lastSeen?: string;
  keyExpiryDisabled?: boolean;
  expires?: string;
  updateAvailable?: boolean;
}

export interface TailscaleOutput {
  devices?: TailscaleDevice[];
  device?: TailscaleDevice;
  message: string;
}

const NOT_CONNECTED =
  "Tailscale isn't connected. Call Connect with service \"tailscale\" — the owner pastes an API access token (tskey-api-…) in a secure form — then retry.";

const PROMPTS: Record<string, (d: string, input: Input) => string> = {
  authorize: (d) => `Authorize ${d} to join your tailnet`,
  deauthorize: (d) => `Cut ${d} off your tailnet (deauthorize)`,
  expire: (d) => `Expire ${d}'s key — it must log in to Tailscale again`,
  key_expiry: (d, input) => `${input.disable_expiry ? "Disable" : "Re-enable"} key expiry for ${d}`,
};

function toDevice(d: Record<string, any>): TailscaleDevice {
  return {
    id: String(d.nodeId ?? d.id),
    name: String(d.name ?? d.hostname ?? "?"),
    ...(d.hostname ? { hostname: String(d.hostname) } : {}),
    ...(d.os ? { os: String(d.os) } : {}),
    ...(Array.isArray(d.addresses) ? { addresses: d.addresses.map(String) } : {}),
    ...(typeof d.authorized === "boolean" ? { authorized: d.authorized } : {}),
    ...(d.lastSeen ? { lastSeen: String(d.lastSeen) } : {}),
    ...(typeof d.keyExpiryDisabled === "boolean" ? { keyExpiryDisabled: d.keyExpiryDisabled } : {}),
    ...(d.expires ? { expires: String(d.expires) } : {}),
    ...(typeof d.updateAvailable === "boolean" ? { updateAvailable: d.updateAvailable } : {}),
  };
}

function line(d: TailscaleDevice): string {
  return `${d.name}${d.os ? ` (${d.os})` : ""}${d.addresses?.[0] ? ` ${d.addresses[0]}` : ""}${d.authorized === false ? " — NOT authorized" : ""}${d.lastSeen ? `, seen ${d.lastSeen}` : ""}`;
}

export const TailscaleTool = buildTool<typeof inputSchema, TailscaleOutput>({
  name: "Tailscale",
  description:
    "The owner's Tailscale tailnet: list devices, device details; authorize/deauthorize a device, expire its key or toggle key expiry (each asks the owner). " +
    "If Tailscale isn't connected, call Connect service \"tailscale\" first.",
  safety: "external-state",
  dynamicSafety: (input) => (TAILSCALE_ASK_ACTIONS.has(input.action) ? "external-state" : "read-only"),
  concurrency: "exclusive",
  inputZod: inputSchema,
  watchdogTimeoutMs: 30_000,
  async checkPermissions(input) {
    if (!TAILSCALE_ASK_ACTIONS.has(input.action)) return { kind: "allow" };
    return { kind: "ask", prompt: PROMPTS[input.action]!(input.device ?? "a device", input), suggestion: "allow_once" };
  },
  activityDescription: (input) => (input.action === "devices" ? "Listing tailnet devices" : `Tailscale ${input.action.replace(/_/g, " ")} ${input.device ?? ""}`.trim()),
  async call(input: Input, ctx): Promise<ToolResult<TailscaleOutput>> {
    const key = (await getCredential("TAILSCALE_API_KEY"))?.trim();
    if (!key) return failResult<TailscaleOutput>(NOT_CONNECTED);
    const ts = (method: string, path: string, body?: unknown) =>
      apiJson("Tailscale", `${API}${path}`, { method, headers: { authorization: `Bearer ${key}` }, ...(body !== undefined ? { body } : {}), signal: ctx.signal });
    try {
      const list = async () => (((await ts("GET", "/tailnet/-/devices")).devices as Array<Record<string, any>>) ?? []).map(toDevice);
      if (input.action === "devices") {
        const devices = await list();
        return okResult({ devices, message: devices.length ? devices.map(line).join("\n") : "No devices on this tailnet." }, `${devices.length} devices`);
      }
      if (!input.device) return failResult<TailscaleOutput>(`${input.action} needs device (an id, name or hostname).`);
      const wanted = input.device.trim().toLowerCase();
      const devices = await list();
      const hit =
        devices.find((d) => d.id.toLowerCase() === wanted || d.name.toLowerCase() === wanted || d.hostname?.toLowerCase() === wanted) ??
        devices.find((d) => d.name.toLowerCase().split(".")[0] === wanted);
      if (!hit) return failResult<TailscaleOutput>(`No device matches "${input.device}" — call Tailscale devices to see the names.`);
      const id = encodeURIComponent(hit.id);
      switch (input.action) {
        case "device": {
          const device = toDevice(await ts("GET", `/device/${id}?fields=all`));
          return okResult({ device, message: `${line(device)}${device.expires ? `; key expires ${device.expires}` : ""}${device.updateAvailable ? "; update available" : ""}` });
        }
        case "authorize":
        case "deauthorize":
          await ts("POST", `/device/${id}/authorized`, { authorized: input.action === "authorize" });
          return okResult({ message: `${hit.name} ${input.action === "authorize" ? "authorized" : "deauthorized"}.` });
        case "expire":
          await ts("POST", `/device/${id}/expire`, {});
          return okResult({ message: `${hit.name}'s key is expired; it must log in again.` });
        case "key_expiry":
          if (input.disable_expiry === undefined) return failResult<TailscaleOutput>("key_expiry needs disable_expiry (true or false).");
          await ts("POST", `/device/${id}/key`, { keyExpiryDisabled: input.disable_expiry });
          return okResult({ message: `Key expiry ${input.disable_expiry ? "disabled" : "re-enabled"} for ${hit.name}.` });
      }
      return failResult<TailscaleOutput>("unknown action");
    } catch (err) {
      return failResult<TailscaleOutput>(err instanceof Error ? err.message : String(err));
    }
  },
});
