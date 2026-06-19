// Telegram OAuth connect flow — sends inline keyboard buttons so the owner can
// authorize services directly from Telegram. Tapping "Connect Google" opens the
// browser to the consent page; the callback server (oauthCallback) catches the
// redirect and stores the tokens.
//
// Usage from the bridge: when the agent needs a service and gets OAUTH_NOT_AUTHORIZED,
// the bridge calls promptConnect() which sends the inline button. The owner taps it,
// authorizes, and the next request succeeds.

import type { InlineKeyboardMarkup, TgMessage, SendMessageOptions } from "./api.js";

/** Minimal shapes mirroring @ares/core's OAuth types so channels stays dependency-free. */
export interface OAuthProviderConfig { provider: string; authorizeUrl: string; tokenUrl: string; scopes: string[]; extraAuthorizeParams?: Record<string, string> }
export interface OAuthTokens { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string; tokenType?: string }

export interface ConnectFlowApi {
  sendMessage(chatId: number, text: string, opts?: SendMessageOptions): Promise<TgMessage>;
}

export interface ConnectFlowDeps {
  api: ConnectFlowApi;
  startOAuthFlow: (opts: {
    provider: OAuthProviderConfig;
    scopes?: string[];
    home?: string;
    onAuthorizeUrl?: (url: string) => void | Promise<void>;
    onSuccess?: (tokens: OAuthTokens) => void | Promise<void>;
    onError?: (error: Error) => void | Promise<void>;
  }) => Promise<OAuthTokens>;
  providers: Record<string, OAuthProviderConfig>;
  providerLabels: Record<string, string>;
  connectedProviders: (providers: Record<string, OAuthProviderConfig>, home?: string) => Promise<Record<string, boolean>>;
  home?: string;
  log?: (line: string) => void;
}

/** Send the "connect services" menu to a chat. Shows which are connected and
 *  which aren't, with inline buttons for unconnected ones. */
export async function sendConnectMenu(
  deps: ConnectFlowDeps,
  chatId: number,
): Promise<void> {
  const status = await deps.connectedProviders(deps.providers, deps.home);
  const lines = ["🔗 Service Connections\n"];
  const buttons: Array<{ text: string; callback_data: string }[]> = [];

  for (const [id, cfg] of Object.entries(deps.providers)) {
    const label = deps.providerLabels[id] ?? id;
    const connected = status[id];
    if (connected) {
      lines.push(`✅ ${label}`);
    } else {
      lines.push(`⬜ ${label}`);
      buttons.push([{ text: `Connect ${label.split(" (")[0]}`, callback_data: `ares:connect:${id}` }]);
    }
  }

  if (buttons.length === 0) {
    lines.push("\nAll services connected.");
  } else {
    lines.push("\nTap a button below to connect:");
  }

  const replyMarkup: InlineKeyboardMarkup | undefined = buttons.length > 0
    ? { inline_keyboard: buttons }
    : undefined;

  await deps.api.sendMessage(chatId, lines.join("\n"), replyMarkup ? { replyMarkup } : undefined);
}

/** Handle a connect callback from an inline button tap. Starts the OAuth flow
 *  and sends the authorize URL as a clickable link. */
export async function handleConnectCallback(
  deps: ConnectFlowDeps,
  chatId: number,
  providerId: string,
): Promise<void> {
  const cfg = deps.providers[providerId];
  if (!cfg) {
    await deps.api.sendMessage(chatId, `Unknown service: ${providerId}`);
    return;
  }

  const label = deps.providerLabels[providerId] ?? providerId;

  try {
    await deps.api.sendMessage(chatId, `🔄 Starting ${label} authorization...\nA link will appear — tap it to sign in.`);

    await deps.startOAuthFlow({
      provider: cfg,
      home: deps.home,
      onAuthorizeUrl: async (url) => {
        const replyMarkup: InlineKeyboardMarkup = {
          inline_keyboard: [[{ text: `Sign in with ${label.split(" (")[0]}`, callback_data: "noop" }]],
        };
        // Send the URL as a clickable text message since Telegram inline buttons
        // can't open arbitrary URLs without url field. Use a plain link instead.
        await deps.api.sendMessage(
          chatId,
          `🔑 Tap the link below to authorize ${label}:\n\n${url}`,
        );
      },
      onSuccess: async (_tokens) => {
        await deps.api.sendMessage(chatId, `✅ ${label} connected successfully! You can now use it.`);
        deps.log?.(`oauth: ${providerId} connected for chat ${chatId}`);
      },
      onError: async (err) => {
        await deps.api.sendMessage(chatId, `❌ ${label} connection failed: ${err.message}`);
        deps.log?.(`oauth: ${providerId} failed for chat ${chatId}: ${err.message}`);
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log?.(`oauth: ${providerId} flow error: ${msg}`);
  }
}

/** Parse a connect-related callback_data. Returns the provider id or null. */
export function parseConnectCallback(data: string): string | null {
  const match = /^ares:connect:(.+)$/.exec(data);
  return match ? match[1] : null;
}
