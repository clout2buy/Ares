// Connect-registry entries for services whose ONLY real connection is OAuth
// (class c/d in oauthMatrix.ts) and that are not remote MCP servers: the owner
// signs in with the vendor, the token lands in the vault under oauth/<provider>,
// and the universal Api tool (or a dedicated tool) calls the vendor's REST API
// with it. Vendors with a hosted MCP are catalog entries instead (mcpCatalog.ts).
//
// Meta's four sites used to be "browser" rows that streamed a remote-controlled
// browser to the phone. Meta has official OAuth for exactly the accounts that
// have an API (Instagram Business/Creator, Facebook Pages, Threads), so those
// connect through OAuth; the browser session survives only as an explicitly
// labelled EXPERIMENTAL fallback for the parts Meta offers no API for.

import type { ConnectService } from "./connectServices.js";

const API_USE = (label: string, id: string, apiId: string = id) =>
  `Connected through OAuth: the ${label} token is refreshed automatically and held in the vault. Call ${label}'s REST API with the Api tool (service "${apiId}") ` +
  `once its preset is installed; if there is no preset yet, say the connection is ready and ask the owner to add the ${label} API to the Api tool. Never ask for the token.`;

export const OAUTH_APP_SERVICES: ConnectService[] = [
  {
    id: "instagram",
    label: "Instagram",
    kind: "oauth-app",
    oauthProvider: "instagram",
    domain: "instagram.com",
    blurb: "Your Instagram Business or Creator account: posts, comments and messages through Meta's official API. Personal accounts have no API.",
    keywords: ["instagram", "insta", "ig", "instagram dms", "instagram messages", "instagram comments", "instagram posts"],
    howToUse:
      "Instagram is connected through Meta's official Instagram Login (Business or Creator account). " +
      API_USE("Instagram", "instagram") +
      " Personal (non-professional) accounts have no API: reading a personal feed or DMs would need the experimental browser session, which the owner must start explicitly.",
    browserFallback: { loginUrl: "https://www.instagram.com/accounts/login/", domain: "instagram.com", label: "Experimental: sign in to Instagram on a live browser" },
  },
  {
    id: "facebook",
    label: "Facebook",
    kind: "oauth-app",
    oauthProvider: "facebook",
    domain: "facebook.com",
    blurb: "Your Facebook Pages: posts, comments and the Page inbox (Messenger) through Meta's official API. A personal profile, feed, groups and chats have no API.",
    keywords: ["facebook", "fb", "facebook page", "facebook pages", "messenger", "facebook messenger", "fb messages", "page inbox"],
    howToUse: "Facebook is connected through Facebook Login for the Pages the owner administers. " + API_USE("Facebook", "facebook", "meta-graph") + " A personal profile, feed, Marketplace and chats have no API (experimental browser session only).",
    browserFallback: { loginUrl: "https://www.facebook.com/login/", domain: "facebook.com", label: "Experimental: sign in to Facebook on a live browser" },
  },
  {
    id: "threads",
    label: "Threads",
    kind: "oauth-app",
    oauthProvider: "threads",
    domain: "threads.com",
    blurb: "Your Threads profile: read and publish posts, manage replies, insights. Works for ordinary personal accounts.",
    keywords: ["threads", "threads app"],
    howToUse: "Threads is connected through Meta's Threads API. " + API_USE("Threads", "threads"),
    browserFallback: { loginUrl: "https://www.threads.com/login", domain: "threads.com", label: "Experimental: sign in to Threads on a live browser" },
  },
  {
    id: "discord",
    label: "Discord",
    kind: "oauth-app",
    oauthProvider: "discord",
    domain: "discord.com",
    blurb: "Your Discord identity and servers. Reading messages needs a bot, which Discord only offers as a token.",
    keywords: ["discord", "discord server", "discord servers"],
    howToUse: "Discord OAuth identifies the owner and lists their servers. " + API_USE("Discord", "discord") + " Reading or sending messages needs a bot token (Connect service discord-bot): the Api tool then sends bot operations as Bot <token>.",
  },
  {
    id: "zoom",
    label: "Zoom",
    kind: "oauth-app",
    oauthProvider: "zoom",
    domain: "zoom.us",
    blurb: "Search and schedule meetings, read recordings and notes.",
    keywords: ["zoom", "zoom meeting", "zoom call", "zoom recording"],
    howToUse: API_USE("Zoom", "zoom"),
  },
  {
    id: "strava",
    label: "Strava",
    kind: "oauth-app",
    oauthProvider: "strava",
    domain: "strava.com",
    blurb: "Your runs, rides and workouts.",
    keywords: ["strava", "my runs", "my rides", "workouts", "activities"],
    howToUse: API_USE("Strava", "strava"),
  },
  {
    id: "reddit",
    label: "Reddit",
    kind: "oauth-app",
    oauthProvider: "reddit",
    domain: "reddit.com",
    blurb: "Read, search and post on Reddit as you. New Reddit apps need Reddit's manual approval.",
    keywords: ["reddit", "subreddit", "reddit post"],
    howToUse: API_USE("Reddit", "reddit"),
  },
  {
    id: "x",
    label: "X (Twitter)",
    kind: "oauth-app",
    oauthProvider: "x",
    domain: "x.com",
    blurb: "Read and post on X as you. The X API is pay-per-use.",
    keywords: ["twitter", "x.com", "tweet", "x post", "my tweets", "tweet something"],
    howToUse: API_USE("X", "x", "x-twitter"),
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    kind: "oauth-app",
    oauthProvider: "linkedin",
    domain: "linkedin.com",
    blurb: "Your LinkedIn identity and posting as you. Reading feeds and messages is restricted to approved partners.",
    keywords: ["linkedin", "linkedin post"],
    howToUse: API_USE("LinkedIn", "linkedin"),
  },
  {
    id: "twitch",
    label: "Twitch",
    kind: "oauth-app",
    oauthProvider: "twitch",
    domain: "twitch.tv",
    blurb: "Your Twitch account: followed channels, subscriptions, clips, chat.",
    keywords: ["twitch", "twitch stream", "twitch channel"],
    howToUse: API_USE("Twitch", "twitch"),
  },
  {
    id: "typeform",
    label: "Typeform",
    kind: "oauth-app",
    oauthProvider: "typeform",
    domain: "typeform.com",
    blurb: "Your forms and their responses.",
    keywords: ["typeform", "typeform responses", "typeform form"],
    howToUse: API_USE("Typeform", "typeform"),
  },
  {
    id: "salesforce",
    label: "Salesforce",
    kind: "oauth-app",
    oauthProvider: "salesforce",
    domain: "salesforce.com",
    blurb: "Your Salesforce org: records, reports and search.",
    keywords: ["salesforce", "sfdc", "salesforce crm"],
    howToUse: API_USE("Salesforce", "salesforce") + " The org's API host is kept as the token's instance_url.",
  },
  {
    id: "xero",
    label: "Xero",
    kind: "oauth-app",
    oauthProvider: "xero",
    domain: "xero.com",
    blurb: "Read your Xero accounting: invoices, contacts, settings.",
    keywords: ["xero", "xero invoices", "xero accounting"],
    howToUse: API_USE("Xero", "xero") + " Calls need the xero-tenant-id header from GET /connections.",
  },
];
