// Connect — manage service connections (OAuth2 providers).
//
// The agent calls this when it needs a service that isn't connected yet, or when
// the owner explicitly asks to connect/disconnect/list services. On Telegram, the
// flow sends an inline button with the auth URL; on desktop, it opens the browser.

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
} from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";

const inputSchema = z.object({
  action: z.enum(["list", "status", "set_credentials", "disconnect"]).describe(
    "list: show all available services and their connection status. " +
    "status: check if a specific provider is connected. " +
    "set_credentials: store OAuth client_id and client_secret for a provider. " +
    "disconnect: remove stored tokens for a provider.",
  ),
  provider: z.string().optional().describe("The provider id (google, spotify, github, etc). Required for status/set_credentials/disconnect."),
  client_id: z.string().optional().describe("OAuth client ID — required for set_credentials."),
  client_secret: z.string().optional().describe("OAuth client secret — required for set_credentials."),
});

type Input = z.infer<typeof inputSchema>;

export interface ConnectOutput {
  providers?: Array<{ id: string; label: string; connected: boolean; hasApp: boolean }>;
  provider?: string;
  connected?: boolean;
  hasApp?: boolean;
  message: string;
}

export const ConnectTool = buildTool<typeof inputSchema, ConnectOutput>({
  name: "Connect",
  description:
    "Manage service connections for OAuth2 providers (Google, Spotify, GitHub, etc). " +
    "Use 'list' to see available services and their status. " +
    "Use 'set_credentials' to store the OAuth app's client_id and client_secret before connecting. " +
    "Use 'disconnect' to remove a provider's tokens. " +
    "When a service is not connected and the owner wants to use it, tell them they need to connect it " +
    "and guide them through the process.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (input) => {
    switch (input.action) {
      case "list": return "Checking service connections";
      case "status": return `Checking ${input.provider ?? "service"} connection`;
      case "set_credentials": return `Storing ${input.provider ?? "service"} credentials`;
      case "disconnect": return `Disconnecting ${input.provider ?? "service"}`;
      default: return "Managing connections";
    }
  },
  async call(input: Input): Promise<ToolResult<ConnectOutput>> {
    switch (input.action) {
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
