// Pre-configured OAuth2 provider definitions for every service Ares connects to.
//
// Each config bundles the authorize/token URLs, default scopes, and any provider
// quirks (Google needs access_type=offline&prompt=consent to issue a refresh
// token; Spotify needs nothing extra). Adding a service is one object literal.
//
// The owner supplies their registered OAuth app's client_id and client_secret
// ONCE (via the UI, Telegram /connect, or the CLI). The framework stores them
// encrypted in the credential vault and handles the rest forever.

import type { OAuthProviderConfig } from "./oauth.js";

export const GOOGLE_OAUTH: OAuthProviderConfig = {
  provider: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/contacts.readonly",
    // Google Workspace beyond mail + calendar rides the SAME owner-registered
    // app: one consent covers Drive, Docs, Sheets, Slides, Forms, Tasks and
    // Contacts. Full `drive` (not drive.file) because "find the budget sheet"
    // means files Ares did not create; contacts (write) so "save Sam's number"
    // works, contacts.readonly kept so an older grant still reads.
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/forms.body",
    "https://www.googleapis.com/auth/forms.responses.readonly",
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/contacts",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ],
  extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
};

export const SPOTIFY_OAUTH: OAuthProviderConfig = {
  provider: "spotify",
  authorizeUrl: "https://accounts.spotify.com/authorize",
  tokenUrl: "https://accounts.spotify.com/api/token",
  scopes: [
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "playlist-read-private",
    "playlist-modify-public",
    "playlist-modify-private",
    "user-library-read",
    "user-library-modify",
    "user-read-recently-played",
  ],
};

export const GITHUB_OAUTH: OAuthProviderConfig = {
  provider: "github",
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  scopes: ["repo", "read:user", "read:org"],
};

export const REDDIT_OAUTH: OAuthProviderConfig = {
  provider: "reddit",
  authorizeUrl: "https://www.reddit.com/api/v1/authorize",
  tokenUrl: "https://www.reddit.com/api/v1/access_token",
  scopes: ["identity", "read", "submit", "privatemessages"],
  extraAuthorizeParams: { duration: "permanent" },
};

export const DISCORD_OAUTH: OAuthProviderConfig = {
  provider: "discord",
  authorizeUrl: "https://discord.com/oauth2/authorize",
  tokenUrl: "https://discord.com/api/oauth2/token",
  scopes: ["identify", "guilds", "messages.read"],
};

export const NOTION_OAUTH: OAuthProviderConfig = {
  provider: "notion",
  authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  scopes: [],
  extraAuthorizeParams: { owner: "user" },
};

export const SLACK_OAUTH: OAuthProviderConfig = {
  provider: "slack",
  authorizeUrl: "https://slack.com/oauth/v2/authorize",
  tokenUrl: "https://slack.com/api/oauth.v2.access",
  scopes: ["channels:read", "channels:history", "chat:write", "users:read"],
};

export const TODOIST_OAUTH: OAuthProviderConfig = {
  provider: "todoist",
  authorizeUrl: "https://todoist.com/oauth/authorize",
  tokenUrl: "https://todoist.com/oauth/access_token",
  scopes: ["data:read_write"],
};

export const TWITCH_OAUTH: OAuthProviderConfig = {
  provider: "twitch",
  authorizeUrl: "https://id.twitch.tv/oauth2/authorize",
  tokenUrl: "https://id.twitch.tv/oauth2/token",
  scopes: ["user:read:email", "channel:read:subscriptions"],
};

export const LINKEDIN_OAUTH: OAuthProviderConfig = {
  provider: "linkedin",
  authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
  tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
  scopes: ["openid", "profile", "email"],
};

export const DROPBOX_OAUTH: OAuthProviderConfig = {
  provider: "dropbox",
  authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
  tokenUrl: "https://api.dropboxapi.com/oauth2/token",
  scopes: [],
  extraAuthorizeParams: { token_access_type: "offline" },
};

/**
 * Microsoft identity platform v2 (Outlook.com, Hotmail, Microsoft 365). Tenant
 * "common" so one Azure app registration signs in personal AND work/school
 * accounts. Graph scopes by short name (they default to graph.microsoft.com);
 * offline_access is what makes Microsoft issue a refresh token at all. The
 * token endpoint takes the stock client_secret_post form, and `scope` is
 * optional on both redemption and refresh (the grant's scopes carry over),
 * so oauth.ts needs no Microsoft special case. Refresh tokens rotate —
 * parseTokenResponse already keeps whichever one came back last.
 */
export const MICROSOFT_OAUTH: OAuthProviderConfig = {
  provider: "microsoft",
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scopes: [
    "offline_access",
    "User.Read",
    "Mail.ReadWrite",
    "Mail.Send",
    "Calendars.ReadWrite",
    "Contacts.ReadWrite",
  ],
  // An owner with a work and a personal account must be able to pick which.
  extraAuthorizeParams: { prompt: "select_account" },
};

/** All known providers, keyed by their stable id. */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  google: GOOGLE_OAUTH,
  spotify: SPOTIFY_OAUTH,
  github: GITHUB_OAUTH,
  reddit: REDDIT_OAUTH,
  discord: DISCORD_OAUTH,
  notion: NOTION_OAUTH,
  slack: SLACK_OAUTH,
  todoist: TODOIST_OAUTH,
  twitch: TWITCH_OAUTH,
  linkedin: LINKEDIN_OAUTH,
  dropbox: DROPBOX_OAUTH,
  microsoft: MICROSOFT_OAUTH,
};

/** Human-readable labels for the connect UI. */
export const PROVIDER_LABELS: Record<string, string> = {
  google: "Google (Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts)",
  spotify: "Spotify",
  github: "GitHub",
  reddit: "Reddit",
  discord: "Discord",
  notion: "Notion",
  slack: "Slack",
  todoist: "Todoist",
  twitch: "Twitch",
  linkedin: "LinkedIn",
  dropbox: "Dropbox",
  microsoft: "Microsoft (Outlook mail, calendar, contacts)",
};

export function getProviderConfig(provider: string): OAuthProviderConfig | undefined {
  return OAUTH_PROVIDERS[provider.toLowerCase()];
}

export function listProviders(): Array<{ id: string; label: string; connected?: boolean }> {
  return Object.entries(OAUTH_PROVIDERS).map(([id, _cfg]) => ({
    id,
    label: PROVIDER_LABELS[id] ?? id,
  }));
}
