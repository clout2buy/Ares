// Pre-configured OAuth2 provider definitions for every service Ares connects to.
//
// Each config bundles the authorize/token URLs, default scopes, and any provider
// quirks (Google needs access_type=offline&prompt=consent to issue a refresh
// token; Reddit wants HTTP Basic client auth and a User-Agent; Notion a JSON
// token body; Twitch a `scopes` parameter on its device grant). Adding a service
// is one object literal; docs/CONNECTIONS-OAUTH.md says where each value was
// read, and oauthMatrix.ts carries the evidence per service.
//
// Which client id Ares presents is NOT here: oauthClients.ts resolves the
// owner's own registered app (vault), else Ares's official one, else the
// product shows the one-time setup. Public clients (device flow, PKCE) need no
// secret: `publicClient: true`.

import type { OAuthProviderConfig } from "./oauth.js";
import { WITHINGS_OAUTH } from "./withingsOAuth.js";
import { facebookExchange, instagramExchange, instagramRefresh, threadsExchange, threadsRefresh, unwrapInstagramToken } from "./oauthVendorQuirks.js";

export const GOOGLE_OAUTH: OAuthProviderConfig = {
  provider: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  deviceUrl: "https://oauth2.googleapis.com/device/code",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  pkce: true,
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
    // YouTube and the Photos PICKER (the Library API only sees app-created
    // media since 2025; reading the owner's library is a human-picked session).
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ],
  extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
};

export const SPOTIFY_OAUTH: OAuthProviderConfig = {
  provider: "spotify",
  authorizeUrl: "https://accounts.spotify.com/authorize",
  tokenUrl: "https://accounts.spotify.com/api/token",
  revokeUrl: "https://accounts.spotify.com/oauth2/revoke/v1",
  userinfoUrl: "https://api.spotify.com/v1/me",
  // Authorization Code with PKCE: a client id is enough (no secret).
  pkce: true,
  publicClient: true,
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

/** GitHub: device flow with a public client id (an OAuth App with "Enable Device Flow"); the web flow is the alternative. */
export const GITHUB_OAUTH: OAuthProviderConfig = {
  provider: "github",
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  deviceUrl: "https://github.com/login/device/code",
  userinfoUrl: "https://api.github.com/user",
  publicClient: true,
  pkce: true,
  scopes: ["repo", "read:org", "read:user", "user:email", "notifications", "read:project", "gist"],
};

/** Reddit: HTTP Basic client auth, a descriptive User-Agent, permanent duration for a refresh token. New apps need Reddit's manual approval. */
export const REDDIT_OAUTH: OAuthProviderConfig = {
  provider: "reddit",
  authorizeUrl: "https://www.reddit.com/api/v1/authorize",
  tokenUrl: "https://www.reddit.com/api/v1/access_token",
  revokeUrl: "https://www.reddit.com/api/v1/revoke_token",
  userinfoUrl: "https://oauth.reddit.com/api/v1/me",
  clientAuth: "client_secret_basic",
  tokenHeaders: { "user-agent": "ares-agent/1.0 (personal agent; contact the owner)" },
  publicClient: true,
  scopes: ["identity", "read", "history", "mysubreddits", "submit", "vote", "privatemessages", "save"],
  extraAuthorizeParams: { duration: "permanent" },
};

/** Discord user OAuth: identity and servers only. Reading messages needs a bot (token-only), not a user token. */
export const DISCORD_OAUTH: OAuthProviderConfig = {
  provider: "discord",
  authorizeUrl: "https://discord.com/oauth2/authorize",
  tokenUrl: "https://discord.com/api/oauth2/token",
  revokeUrl: "https://discord.com/api/oauth2/token/revoke",
  userinfoUrl: "https://discord.com/api/v10/users/@me",
  pkce: true,
  scopes: ["identify", "guilds", "guilds.members.read", "email"],
};

export const NOTION_OAUTH: OAuthProviderConfig = {
  provider: "notion",
  authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  // Notion wants HTTP Basic client auth and a JSON body.
  clientAuth: "client_secret_basic",
  tokenBody: "json",
  scopes: [],
  extraAuthorizeParams: { owner: "user" },
};

export const SLACK_OAUTH: OAuthProviderConfig = {
  provider: "slack",
  authorizeUrl: "https://slack.com/oauth/v2/authorize",
  tokenUrl: "https://slack.com/api/oauth.v2.access",
  revokeUrl: "https://slack.com/api/auth.revoke",
  scopes: ["channels:read", "channels:history", "chat:write", "users:read"],
};

export const TODOIST_OAUTH: OAuthProviderConfig = {
  provider: "todoist",
  authorizeUrl: "https://todoist.com/oauth/authorize",
  tokenUrl: "https://todoist.com/oauth/access_token",
  scopes: ["data:read_write"],
};

/** Twitch: a PUBLIC client can use the Device Code Grant (endpoint is live though absent from discovery). */
export const TWITCH_OAUTH: OAuthProviderConfig = {
  provider: "twitch",
  authorizeUrl: "https://id.twitch.tv/oauth2/authorize",
  tokenUrl: "https://id.twitch.tv/oauth2/token",
  deviceUrl: "https://id.twitch.tv/oauth2/device",
  revokeUrl: "https://id.twitch.tv/oauth2/revoke",
  userinfoUrl: "https://id.twitch.tv/oauth2/userinfo",
  publicClient: true,
  // Twitch spells the parameter `scopes` on the device request AND its token poll.
  deviceScopeParam: "scopes",
  deviceTokenParams: { scopes: "user:read:email user:read:follows user:read:subscriptions channel:read:subscriptions clips:edit chat:read chat:edit" },
  scopes: ["user:read:email", "user:read:follows", "user:read:subscriptions", "channel:read:subscriptions", "clips:edit", "chat:read", "chat:edit"],
};

export const LINKEDIN_OAUTH: OAuthProviderConfig = {
  provider: "linkedin",
  authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
  tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
  revokeUrl: "https://www.linkedin.com/oauth/v2/revoke",
  userinfoUrl: "https://api.linkedin.com/v2/userinfo",
  scopes: ["openid", "profile", "email", "w_member_social"],
};

export const DROPBOX_OAUTH: OAuthProviderConfig = {
  provider: "dropbox",
  authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
  tokenUrl: "https://api.dropboxapi.com/oauth2/token",
  // PKCE: an app key is enough; token_access_type=offline issues the refresh token.
  pkce: true,
  publicClient: true,
  scopes: ["account_info.read", "files.metadata.read", "files.content.read", "files.content.write", "sharing.read"],
  extraAuthorizeParams: { token_access_type: "offline" },
};

/**
 * Microsoft identity platform v2 (Outlook.com, Hotmail, Microsoft 365, OneDrive).
 * Tenant "common" so one Azure app registration signs in personal AND work/school
 * accounts. Graph scopes by short name (they default to graph.microsoft.com);
 * offline_access is what makes Microsoft issue a refresh token at all. A PUBLIC
 * client (Entra: "Allow public client flows") needs NO secret and NO redirect for
 * the device code flow, which is what the phone uses; an owner who registered a
 * confidential web app keeps the code flow. The token endpoint takes the stock
 * client_secret_post form, and `scope` is optional on both redemption and
 * refresh (the grant's scopes carry over), so oauth.ts needs no Microsoft
 * special case. Refresh tokens rotate: parseTokenResponse keeps whichever one
 * came back last.
 */
export const MICROSOFT_OAUTH: OAuthProviderConfig = {
  provider: "microsoft",
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  deviceUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
  userinfoUrl: "https://graph.microsoft.com/oidc/userinfo",
  publicClient: true,
  pkce: true,
  scopes: [
    "offline_access",
    "User.Read",
    "Mail.ReadWrite",
    "Mail.Send",
    "Calendars.ReadWrite",
    "Contacts.ReadWrite",
    "Files.ReadWrite",
  ],
  // An owner with a work and a personal account must be able to pick which.
  extraAuthorizeParams: { prompt: "select_account" },
};

/** Zoom: General (user-managed) OAuth app; PKCE lets a public client skip the secret. */
export const ZOOM_OAUTH: OAuthProviderConfig = {
  provider: "zoom",
  authorizeUrl: "https://zoom.us/oauth/authorize",
  tokenUrl: "https://zoom.us/oauth/token",
  revokeUrl: "https://zoom.us/oauth/revoke",
  userinfoUrl: "https://api.zoom.us/v2/users/me",
  clientAuth: "client_secret_basic",
  pkce: true,
  publicClient: true,
  scopes: ["meeting:read:search", "meeting:write:meeting", "cloud_recording:read:content", "my_notes:read:content", "docs:read:export"],
};

/** Strava: comma-separated scopes; the refresh token ROTATES on every refresh. */
export const STRAVA_OAUTH: OAuthProviderConfig = {
  provider: "strava",
  authorizeUrl: "https://www.strava.com/oauth/authorize",
  tokenUrl: "https://www.strava.com/oauth/token",
  userinfoUrl: "https://www.strava.com/api/v3/athlete",
  scopeSeparator: ",",
  scopes: ["read", "activity:read_all", "profile:read_all", "activity:write"],
  extraAuthorizeParams: { approval_prompt: "auto" },
};

/** X (Twitter) API v2: OAuth 2.0 PKCE; a public (native) client uses the client id alone. Pay-per-use credits gate the API. */
export const X_OAUTH: OAuthProviderConfig = {
  provider: "x",
  authorizeUrl: "https://x.com/i/oauth2/authorize",
  tokenUrl: "https://api.x.com/2/oauth2/token",
  revokeUrl: "https://api.x.com/2/oauth2/revoke",
  userinfoUrl: "https://api.x.com/2/users/me",
  clientAuth: "client_secret_basic",
  pkce: true,
  publicClient: true,
  scopes: ["tweet.read", "tweet.write", "users.read", "offline.access", "dm.read", "dm.write", "like.read", "like.write", "follows.read", "follows.write", "bookmark.read"],
};

export const TYPEFORM_OAUTH: OAuthProviderConfig = {
  provider: "typeform",
  authorizeUrl: "https://admin.typeform.com/oauth/authorize",
  tokenUrl: "https://api.typeform.com/oauth/token",
  userinfoUrl: "https://api.typeform.com/me",
  pkce: true,
  scopes: ["offline_access", "accounts:read", "forms:read", "forms:write", "responses:read"],
};

/** Salesforce: authorization code + PKCE via an External Client App; the response's instance_url is where the API lives. */
export const SALESFORCE_OAUTH: OAuthProviderConfig = {
  provider: "salesforce",
  authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize",
  tokenUrl: "https://login.salesforce.com/services/oauth2/token",
  revokeUrl: "https://login.salesforce.com/services/oauth2/revoke",
  userinfoUrl: "https://login.salesforce.com/services/oauth2/userinfo",
  pkce: true,
  publicClient: true,
  keepTokenFields: ["instance_url"],
  scopes: ["api", "refresh_token"],
};

/** Xero: Auth Code with PKCE (public client, no secret). API calls need the tenant id from /connections. */
export const XERO_OAUTH: OAuthProviderConfig = {
  provider: "xero",
  authorizeUrl: "https://login.xero.com/identity/connect/authorize",
  tokenUrl: "https://identity.xero.com/connect/token",
  revokeUrl: "https://identity.xero.com/connect/revocation",
  userinfoUrl: "https://identity.xero.com/connect/userinfo",
  clientAuth: "none",
  pkce: true,
  publicClient: true,
  scopes: ["offline_access", "openid", "profile", "email", "accounting.transactions.read", "accounting.contacts.read", "accounting.settings.read"],
};

/**
 * Instagram API with Instagram Login (Business/Creator accounts only; Basic
 * Display ended 2024-12-04). Comma-separated scopes; the code exchange yields a
 * 1h token that oauthVendorQuirks swaps for a 60-day one and renews weekly.
 */
export const INSTAGRAM_OAUTH: OAuthProviderConfig = {
  provider: "instagram",
  authorizeUrl: "https://www.instagram.com/oauth/authorize",
  tokenUrl: "https://api.instagram.com/oauth/access_token",
  userinfoUrl: "https://graph.instagram.com/v23.0/me?fields=user_id,username,account_type",
  pkce: false,
  scopeSeparator: ",",
  scopes: ["instagram_business_basic", "instagram_business_manage_messages", "instagram_business_manage_comments", "instagram_business_content_publish"],
  unwrapTokenResponse: unwrapInstagramToken,
  afterExchange: instagramExchange,
  customRefresh: instagramRefresh,
  refreshAheadMs: 7 * 24 * 3600_000,
};

/** Facebook Login (Pages the owner administers; personal profile data has no API). */
export const FACEBOOK_OAUTH: OAuthProviderConfig = {
  provider: "facebook",
  authorizeUrl: "https://www.facebook.com/v23.0/dialog/oauth",
  tokenUrl: "https://graph.facebook.com/v23.0/oauth/access_token",
  userinfoUrl: "https://graph.facebook.com/v23.0/me?fields=id,name",
  pkce: false,
  scopeSeparator: ",",
  scopes: ["public_profile", "pages_show_list", "pages_read_engagement", "pages_manage_posts", "pages_manage_engagement", "pages_read_user_content"],
  afterExchange: facebookExchange,
  // No refresh grant: swapping the long-lived token again renews it.
  customRefresh: facebookExchange,
  refreshAheadMs: 7 * 24 * 3600_000,
};

/** Threads API: works for ordinary personal profiles (the owner added as a Threads Tester). */
export const THREADS_OAUTH: OAuthProviderConfig = {
  provider: "threads",
  authorizeUrl: "https://threads.com/oauth/authorize",
  tokenUrl: "https://graph.threads.net/oauth/access_token",
  userinfoUrl: "https://graph.threads.net/v1.0/me?fields=id,username",
  pkce: false,
  scopeSeparator: ",",
  scopes: ["threads_basic", "threads_content_publish", "threads_read_replies", "threads_manage_replies", "threads_manage_insights"],
  afterExchange: threadsExchange,
  customRefresh: threadsRefresh,
  refreshAheadMs: 7 * 24 * 3600_000,
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
  withings: WITHINGS_OAUTH,
  zoom: ZOOM_OAUTH,
  strava: STRAVA_OAUTH,
  x: X_OAUTH,
  typeform: TYPEFORM_OAUTH,
  salesforce: SALESFORCE_OAUTH,
  xero: XERO_OAUTH,
  instagram: INSTAGRAM_OAUTH,
  facebook: FACEBOOK_OAUTH,
  threads: THREADS_OAUTH,
};

/** Human-readable labels for the connect UI. */
export const PROVIDER_LABELS: Record<string, string> = {
  google: "Google (Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts, YouTube, Photos)",
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
  microsoft: "Microsoft (Outlook mail, calendar, contacts, OneDrive)",
  withings: "Withings (health)",
  zoom: "Zoom",
  strava: "Strava",
  x: "X (Twitter)",
  typeform: "Typeform",
  salesforce: "Salesforce",
  xero: "Xero",
  instagram: "Instagram (Business and Creator accounts)",
  facebook: "Facebook (Pages)",
  threads: "Threads",
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
