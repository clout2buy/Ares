// Connect — get the owner's account connected, the moment a task needs it.
//
// "Check my email" with no Gmail connected used to end in a lecture about
// registering OAuth apps, or keys pasted into chat. Now the agent calls
// Connect {action:"connect", service:"gmail"}: the garrison's connect hub
// mints ONE link (OAuth sign-in, a secure key form, or a live browser to sign
// in on), the phone and Telegram show it as a card, and this call WAITS until
// the owner finishes — then the agent carries on with the task it was doing.
// The registry of what can be connected, and how, is core/connectServices.ts.

import { z } from "zod";
import {
  getValidAccessToken,
  loadTokens,
  deleteCredential,
  setCredential,
  hasCredential,
  listCredentialNames,
  clientIdName,
  clientSecretName,
  OAUTH_PROVIDERS,
  PROVIDER_LABELS,
  getProviderConfig,
  listProviders,
  connectedProviders,
  CONNECT_SERVICES,
  resolveConnectService,
  isServiceConnected,
  getConnectBroker,
} from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";

const inputSchema = z.object({
  action: z.enum(["connect", "services", "list", "status", "set_credentials", "disconnect"]).describe(
    "connect: get a service connected NOW — shows the owner a one-tap card on their phone/Telegram (sign in, enter a key in a secure form, or sign in on a live browser) and waits until they finish. " +
    "services: every connectable service and whether it is connected. " +
    "list: show the classic OAuth providers and their connection status. " +
    "status: check if a specific provider is connected. " +
    "set_credentials: store OAuth client_id and client_secret for a provider. " +
    "disconnect: remove stored tokens for a provider.",
  ),
  service: z.string().optional().describe("For connect: what to connect — a service id or plain name (gmail, stripe, supabase, vercel, twilio, doordash) or any website domain to sign in to (e.g. 'chipotle.com')."),
  reason: z.string().optional().describe("For connect: one short line shown on the card — why you need it (e.g. 'to check your inbox')."),
  provider: z.string().optional().describe("The provider id (google, spotify, github, etc). Required for status/set_credentials/disconnect."),
  client_id: z.string().optional().describe("OAuth client ID — required for set_credentials."),
  client_secret: z.string().optional().describe("OAuth client secret — required for set_credentials."),
});

type Input = z.infer<typeof inputSchema>;

/** How long a connect waits for the owner to finish on their phone. */
export const CONNECT_WAIT_MS = 10 * 60_000;

export interface ConnectOutput {
  service?: string;
  kind?: string;
  services?: Array<{ id: string; label: string; kind: string; connected: boolean }>;
  providers?: Array<{ id: string; label: string; connected: boolean; hasApp: boolean }>;
  provider?: string;
  connected?: boolean;
  hasApp?: boolean;
  message: string;
}

export const ConnectTool = buildTool<typeof inputSchema, ConnectOutput>({
  name: "Connect",
  description:
    "Connect the owner's accounts the moment a task needs one. When a request needs a service you can't reach yet — " +
    "email/Gmail, calendar, Stripe, Supabase, Vercel, GitHub, Notion, Linear, a phone number (Twilio), DoorDash/Uber Eats/Instacart/Amazon, " +
    "or ANY website that needs a login — call action 'connect' with the service. The owner gets a one-tap card on their phone " +
    "(OAuth sign-in, a secure key form, or a live browser to sign in on) and this call waits until they finish, then tells you " +
    "exactly how to use the new connection — continue the original task right away. Never ask the owner to paste keys or passwords into chat. " +
    "'services' lists everything connectable and what is already connected. 'disconnect' removes a classic OAuth provider's tokens.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  // connect waits for a human to finish signing in (bounded at CONNECT_WAIT_MS).
  watchdogTimeoutMs: CONNECT_WAIT_MS + 30_000,
  // Storing credentials or disconnecting an account touches secrets / external
  // account state — must cross the gate. Listing/status stay free.
  async checkPermissions(input) {
    if (input.action === "set_credentials" || input.action === "disconnect")
      return { kind: "ask", prompt: `${input.action === "set_credentials" ? "Store credentials for" : "Disconnect"} ${input.provider ?? "a service"}`, suggestion: "allow_once" };
    return { kind: "allow" };
  },
  activityDescription: (input) => {
    switch (input.action) {
      case "connect": return `Connecting ${input.service ?? "a service"}`;
      case "services": return "Checking connectable services";
      case "list": return "Checking service connections";
      case "status": return `Checking ${input.provider ?? "service"} connection`;
      case "set_credentials": return `Storing ${input.provider ?? "service"} credentials`;
      case "disconnect": return `Disconnecting ${input.provider ?? "service"}`;
      default: return "Managing connections";
    }
  },
  async call(input: Input, ctx): Promise<ToolResult<ConnectOutput>> {
    switch (input.action) {
      case "connect":
        return connectService(input, ctx);

      case "services": {
        const services = await Promise.all(
          CONNECT_SERVICES.map(async (svc) => ({ id: svc.id, label: svc.label, kind: svc.kind, connected: await isServiceConnected(svc) })),
        );
        const connected = services.filter((svc) => svc.connected).map((svc) => svc.label);
        const message =
          `Connected: ${connected.length ? connected.join(", ") : "nothing yet"}.\n` +
          `Connectable (${services.length}): ${services.map((svc) => `${svc.id}${svc.connected ? " ✓" : ""}`).join(", ")}. ` +
          "Any other website can be connected by passing its domain.";
        return { output: { services, message }, display: `${connected.length} connected of ${services.length}` };
      }

      case "list": {
        const status = await connectedProviders(OAUTH_PROVIDERS);
        const providers = await Promise.all(
          listProviders().map(async (p) => {
            const cfg = OAUTH_PROVIDERS[p.id];
            const hasApp = cfg
              ? (await hasCredential(clientIdName(cfg))) && (await hasCredential(clientSecretName(cfg)))
              : false;
            return {
              id: p.id,
              label: p.label,
              connected: status[p.id] ?? false,
              hasApp,
            };
          }),
        );
        const lines = providers.map(
          (p) => `${p.connected ? "✅" : "⬜"} ${p.label}${p.hasApp ? "" : " (no OAuth app set)"}`,
        );
        return {
          output: { providers, message: lines.join("\n") },
          display: lines.join("\n"),
        };
      }

      case "status": {
        if (!input.provider) return { output: { message: "Provider is required for status check." }, display: "Missing provider." };
        const cfg = getProviderConfig(input.provider);
        if (!cfg) return { output: { message: `Unknown provider: ${input.provider}` }, display: `Unknown provider: ${input.provider}` };
        const tokens = await loadTokens(cfg.provider);
        const connected = tokens !== undefined && tokens.accessToken !== undefined;
        const hasApp = (await hasCredential(clientIdName(cfg))) && (await hasCredential(clientSecretName(cfg)));
        const label = PROVIDER_LABELS[cfg.provider] ?? cfg.provider;
        const msg = connected
          ? `${label} is connected.`
          : hasApp
            ? `${label} has OAuth app credentials but is not connected yet. The owner needs to authorize it.`
            : `${label} is not set up. The owner needs to register an OAuth app and provide the client_id and client_secret first.`;
        return {
          output: { provider: cfg.provider, connected, hasApp, message: msg },
          display: msg,
        };
      }

      case "set_credentials": {
        if (!input.provider) return { output: { message: "Provider is required." }, display: "Missing provider." };
        const cfg = getProviderConfig(input.provider);
        if (!cfg) return { output: { message: `Unknown provider: ${input.provider}` }, display: `Unknown provider: ${input.provider}` };
        if (!input.client_id || !input.client_secret) {
          return { output: { message: "Both client_id and client_secret are required." }, display: "Missing credentials." };
        }
        await setCredential(clientIdName(cfg), input.client_id);
        await setCredential(clientSecretName(cfg), input.client_secret);
        const label = PROVIDER_LABELS[cfg.provider] ?? cfg.provider;
        return {
          output: { provider: cfg.provider, message: `${label} OAuth app credentials stored. The owner can now authorize it.` },
          display: `${label} credentials saved.`,
        };
      }

      case "disconnect": {
        if (!input.provider) return { output: { message: "Provider is required." }, display: "Missing provider." };
        const cfg = getProviderConfig(input.provider);
        if (!cfg) return { output: { message: `Unknown provider: ${input.provider}` }, display: `Unknown provider: ${input.provider}` };
        await deleteCredential(`oauth/${cfg.provider}`);
        const label = PROVIDER_LABELS[cfg.provider] ?? cfg.provider;
        return {
          output: { provider: cfg.provider, connected: false, message: `${label} disconnected.` },
          display: `${label} disconnected.`,
        };
      }

      default:
        return { output: { message: "Unknown action." }, display: "Unknown action." };
    }
  },
});

async function connectService(
  input: Input,
  ctx: { signal: AbortSignal; emitProgress?(data: unknown): void },
): Promise<ToolResult<ConnectOutput>> {
  const asked = (input.service ?? input.provider ?? "").trim();
  if (!asked) {
    const message = "Say which service to connect (e.g. service: \"gmail\", \"stripe\", \"doordash\", or a website domain).";
    return { output: { message }, display: "No service named", failure: message };
  }
  const service = resolveConnectService(asked);
  if (!service) {
    const message = `I don't know how to connect "${asked}". Call Connect action "services" for the list, or pass the site's domain (e.g. "example.com") to sign in on the browser.`;
    return { output: { message }, display: `Unknown service: ${asked}`, failure: message };
  }
  if (await isServiceConnected(service)) {
    const message = `${service.label} is already connected. ${service.howToUse}`;
    return { output: { service: service.id, kind: service.kind, connected: true, message }, display: `${service.label} already connected` };
  }
  const broker = getConnectBroker();
  if (!broker) {
    const message =
      `${service.label} isn't connected, and this Ares has no public address for the owner to connect it from their phone ` +
      "(connect cards need the garrison). Tell the owner to connect it from the Ares desktop app, or run Ares as a garrison.";
    return { output: { service: service.id, kind: service.kind, connected: false, message }, display: message, failure: message };
  }
  let prompt;
  try {
    prompt = await broker.start(service, { reason: input.reason });
  } catch (err) {
    const message = `Couldn't start connecting ${service.label}: ${err instanceof Error ? err.message : String(err)}`;
    return { output: { service: service.id, kind: service.kind, connected: false, message }, display: message, failure: message };
  }
  // The card: the phone and Telegram render this progress event as a
  // one-tap connect button while the call waits.
  ctx.emitProgress?.({
    kind: "connect_request",
    flowId: prompt.flowId,
    service: prompt.service,
    label: prompt.label,
    mode: prompt.kind,
    url: prompt.url,
    instructions: prompt.instructions,
    ...(input.reason ? { reason: input.reason.slice(0, 200) } : {}),
  });
  const outcome = await broker.wait(prompt.flowId, { signal: ctx.signal, timeoutMs: CONNECT_WAIT_MS });
  ctx.emitProgress?.({ kind: "connect_result", flowId: prompt.flowId, service: prompt.service, label: prompt.label, ok: outcome.ok, detail: outcome.detail.slice(0, 300) });
  if (!outcome.ok) {
    const message =
      `${service.label} was not connected: ${outcome.detail} ` +
      "Tell the owner in one line and offer to try again; don't work around it.";
    return { output: { service: service.id, kind: service.kind, connected: false, message }, display: `${service.label}: not connected`, failure: message };
  }
  const message = `${service.label} is connected. ${outcome.detail ? `${outcome.detail} ` : ""}${service.howToUse} Continue the owner's original request now.`;
  return { output: { service: service.id, kind: service.kind, connected: true, message }, display: `${service.label} connected` };
}
