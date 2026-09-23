// Connectable services — ONE registry behind "Ares, check my email".
//
// Before this file there were three disjoint worlds: the OAuth-app providers
// (Gmail, Spotify … owner-registered apps, oauthProviders.ts), the remote MCP
// catalog (Stripe, Supabase, Vercel … dynamic registration, mcpCatalog.ts),
// and nothing at all for API-key services (Twilio) or sites with no API
// (DoorDash). The agent had no single place to ask "what can I connect, and
// how?", so it improvised — or told the owner to paste keys into chat.
//
// Every service here resolves to one of five connect kinds; the garrison's
// connect hub turns each into a single link the owner opens on their phone:
//   mcp-oauth  remote MCP server, OAuth with dynamic client registration
//   mcp-key    remote MCP server that takes an API key
//   oauth-app  classic OAuth with an owner-registered app (Google…); the first
//              connect walks the owner through registering it
//   api-key    a plain API (Twilio) — a secure form, never the chat
//   browser    a site with no API (DoorDash) — the owner signs in on a live
//              browser Ares then drives with the same session

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCP_CATALOG, type McpCatalogEntry } from "./mcpCatalog.js";
import { OAUTH_PROVIDERS } from "./oauthProviders.js";
import { loadTokens } from "./oauth.js";
import { getCredential } from "./credentials.js";
import { loadRemoteMcpServers } from "./mcpConnect.js";

export type ConnectKind = "mcp-oauth" | "mcp-key" | "oauth-app" | "api-key" | "browser";

export interface ConnectField {
  /** Vault credential name the value is stored under. */
  credential: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  help?: string;
}

export interface ConnectService {
  id: string;
  label: string;
  kind: ConnectKind;
  blurb: string;
  keywords: string[];
  /** What the agent does once connected — returned verbatim after a connect. */
  howToUse: string;
  mcpUrl?: string;
  keyHeader?: string;
  keyUrl?: string;
  /** oauth-app: the provider id in OAUTH_PROVIDERS. */
  oauthProvider?: string;
  /** oauth-app: how to register the app, shown on the first connect. */
  appSetup?: { consoleUrl: string; steps: string[] };
  /** api-key: the fields the secure form asks for. */
  fields?: ConnectField[];
  /** browser: where sign-in starts, and the site's registrable domain. */
  loginUrl?: string;
  domain?: string;
}

const MCP_USE = (id: string) =>
  `Its tools are live now: call McpListTools with server "${id}" to see them, then McpCallTool (or the mcp_${id}_* tools after a Connectors refresh).`;

const GOOGLE_SETUP = {
  consoleUrl: "https://console.cloud.google.com/apis/credentials",
  steps: [
    "Open console.cloud.google.com and create (or pick) a project.",
    "APIs & Services → Library: enable the Gmail API, Google Calendar API and People API.",
    "OAuth consent screen: choose External, fill in the app name and your email, add yourself under Test users, then press Publish app (an app left in Testing mode loses access every 7 days).",
    "Credentials → Create credentials → OAuth client ID → Web application. Under Authorized redirect URIs add the redirect URI shown below.",
    "Copy the Client ID and Client secret into the form below.",
  ],
};

function genericAppSetup(consoleUrl: string, name: string) {
  return {
    consoleUrl,
    steps: [
      `Open the ${name} developer console and create an app.`,
      "Add the redirect URI shown below as an allowed redirect / callback URL.",
      "Copy the app's Client ID and Client secret into the form below.",
    ],
  };
}

/** Services whose only interface is a website: sign in once, Ares drives it. */
const BROWSER_SITES: Array<Omit<ConnectService, "kind" | "howToUse"> & { howToUse?: string }> = [
  { id: "doordash", label: "DoorDash", blurb: "Order food delivery.", keywords: ["doordash", "door dash", "food delivery", "order food", "takeout"], loginUrl: "https://www.doordash.com/consumer/login/", domain: "doordash.com" },
  { id: "ubereats", label: "Uber Eats", blurb: "Order food delivery.", keywords: ["uber eats", "ubereats"], loginUrl: "https://www.ubereats.com/login-redirect/", domain: "ubereats.com" },
  { id: "uber", label: "Uber", blurb: "Request rides.", keywords: ["uber ride", "call an uber", "get me an uber"], loginUrl: "https://auth.uber.com/", domain: "uber.com" },
  { id: "instacart", label: "Instacart", blurb: "Grocery delivery.", keywords: ["instacart", "groceries", "grocery delivery"], loginUrl: "https://www.instacart.com/login", domain: "instacart.com" },
  { id: "amazon", label: "Amazon", blurb: "Shopping and orders.", keywords: ["amazon", "amazon order"], loginUrl: "https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0", domain: "amazon.com" },
  { id: "opentable", label: "OpenTable", blurb: "Restaurant reservations.", keywords: ["opentable", "reservation", "book a table"], loginUrl: "https://www.opentable.com/", domain: "opentable.com" },
];

const HANDWRITTEN: ConnectService[] = [
  {
    id: "google",
    label: "Google (Gmail & Calendar)",
    kind: "oauth-app",
    oauthProvider: "google",
    blurb: "Read, search and send Gmail; read and edit Google Calendar.",
    keywords: ["google", "gmail", "email", "e-mail", "inbox", "mail", "calendar", "google calendar", "contacts"],
    howToUse: "Use the Gmail tool (search / list_messages / read_message / send) and the GoogleCalendar tool.",
    appSetup: GOOGLE_SETUP,
  },
  {
    id: "spotify",
    label: "Spotify",
    kind: "oauth-app",
    oauthProvider: "spotify",
    blurb: "Playback, playlists and your library.",
    keywords: ["spotify", "playlist", "play music on spotify"],
    howToUse: "Use the Spotify tool.",
    appSetup: genericAppSetup("https://developer.spotify.com/dashboard", "Spotify"),
  },
  {
    id: "twilio",
    label: "Twilio (phone numbers & SMS)",
    kind: "api-key",
    blurb: "Buy phone numbers, send and read SMS, place calls.",
    keywords: ["twilio", "phone number", "sms", "text message", "texting number", "buy a number", "get a number"],
    keyUrl: "https://console.twilio.com/",
    howToUse: "Use the Phone tool: search_numbers, buy_number (asks the owner first — it costs money), list_numbers, send_sms, messages.",
    fields: [
      { credential: "TWILIO_ACCOUNT_SID", label: "Account SID", placeholder: "AC…", help: "Twilio Console → Account Info." },
      { credential: "TWILIO_AUTH_TOKEN", label: "Auth Token", secret: true, help: "Twilio Console → Account Info (press show)." },
    ],
  },
  {
    id: "stripe-key",
    label: "Stripe (secret key)",
    kind: "api-key",
    blurb: "Create payment links with the native Stripe tool.",
    keywords: ["stripe secret key", "stripe key", "payment link"],
    keyUrl: "https://dashboard.stripe.com/apikeys",
    howToUse: "Use the Stripe tool to create payment links. For everything else in Stripe, connect service \"stripe\" (OAuth).",
    fields: [{ credential: "STRIPE_SECRET_KEY", label: "Secret key", placeholder: "sk_live_… or sk_test_…", secret: true, help: "Stripe Dashboard → Developers → API keys. Use a restricted or test key if you prefer." }],
  },
  {
    id: "resend",
    label: "Resend (send email as Ares)",
    kind: "api-key",
    blurb: "Send email from Ares's own address.",
    keywords: ["resend", "send email from ares"],
    keyUrl: "https://resend.com/api-keys",
    howToUse: "Use the Email tool to send.",
    fields: [
      { credential: "RESEND_API_KEY", label: "API key", placeholder: "re_…", secret: true },
      { credential: "ARES_EMAIL_FROM", label: "From address", placeholder: "Ares <ares@yourdomain.com>", help: "Must be on a domain verified in Resend." },
    ],
  },
];

function fromCatalog(entry: McpCatalogEntry): ConnectService | null {
  if (entry.auth === "none") return null;
  return {
    id: entry.id,
    label: entry.name,
    kind: entry.auth === "oauth" ? "mcp-oauth" : "mcp-key",
    blurb: entry.blurb,
    keywords: entry.keywords,
    howToUse: MCP_USE(entry.id),
    mcpUrl: entry.url,
    ...(entry.keyHeader ? { keyHeader: entry.keyHeader } : {}),
    ...(entry.keyUrl ? { keyUrl: entry.keyUrl } : {}),
    ...(entry.auth === "key"
      ? { fields: [{ credential: `mcp.key.${entry.id}`, label: "API key", secret: true, ...(entry.keyUrl ? { help: `Create one at ${entry.keyUrl}` } : {}) }] }
      : {}),
  };
}

function browserService(site: (typeof BROWSER_SITES)[number]): ConnectService {
  return {
    ...site,
    kind: "browser",
    howToUse:
      site.howToUse ??
      `You are signed in to ${site.label} in Ares's browser. Use the Browser tool on ${site.domain}. Anything that spends money (placing an order, checkout) must be confirmed with the owner first — show them the cart and total.`,
  };
}

export const CONNECT_SERVICES: ConnectService[] = [
  ...HANDWRITTEN,
  ...MCP_CATALOG.map(fromCatalog).filter((s): s is ConnectService => s !== null),
  ...BROWSER_SITES.map(browserService),
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

/** A bare domain or URL the registry doesn't know becomes a browser sign-in. */
function adHocBrowserService(query: string): ConnectService | null {
  const trimmed = query.trim();
  let host = "";
  try {
    host = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /\s/.test(trimmed)) return null;
  const domain = host.replace(/^www\./, "");
  return browserService({
    id: `site:${domain}`,
    label: domain,
    blurb: `Sign in to ${domain}.`,
    keywords: [domain],
    loginUrl: `https://${host}/`,
    domain,
  });
}

/**
 * Resolve what the agent asked for ("gmail", "Stripe", "doordash.com", "a
 * phone number") to one service. Exact id, then label, then keyword — and a
 * domain nobody registered becomes a browser sign-in for that site.
 */
export function resolveConnectService(query: string): ConnectService | null {
  const q = normalize(query);
  if (!q) return null;
  const byId = CONNECT_SERVICES.find((s) => s.id === q || s.id === q.replace(/ /g, "-"));
  if (byId) return byId;
  const byLabel = CONNECT_SERVICES.find((s) => normalize(s.label) === q);
  if (byLabel) return byLabel;
  const byKeyword = CONNECT_SERVICES.find((s) => s.keywords.some((k) => normalize(k) === q));
  if (byKeyword) return byKeyword;
  const contains = CONNECT_SERVICES.find((s) => s.keywords.some((k) => k.length >= 4 && q.includes(normalize(k))));
  if (contains) return contains;
  if (q.startsWith("site ")) return adHocBrowserService(query.trim().slice(5));
  return adHocBrowserService(query);
}

// ─── Browser sign-ins on disk ────────────────────────────────────────────────

function aresHome(home?: string): string {
  return home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
}

/** Saved Playwright storage state per signed-in site. The Browser tool loads
 *  these into whatever browser it launches, so one sign-in serves every
 *  session. They hold live session cookies — never serve this directory. */
export function browserSessionsDir(home?: string): string {
  return path.join(aresHome(home), "browser-sessions");
}

export function browserSessionFile(serviceId: string, home?: string): string {
  return path.join(browserSessionsDir(home), `${serviceId.replace(/[^a-z0-9._-]+/gi, "_")}.json`);
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function isServiceConnected(service: ConnectService, home?: string): Promise<boolean> {
  switch (service.kind) {
    case "mcp-oauth":
    case "mcp-key": {
      const servers = await loadRemoteMcpServers(home).catch(() => ({} as Record<string, unknown>));
      return Boolean(servers[service.id]);
    }
    case "oauth-app": {
      const cfg = service.oauthProvider ? OAUTH_PROVIDERS[service.oauthProvider] : undefined;
      if (!cfg) return false;
      const tokens = await loadTokens(cfg.provider, { home }).catch(() => undefined);
      return Boolean(tokens?.accessToken);
    }
    case "api-key": {
      for (const field of service.fields ?? []) {
        if (!(await getCredential(field.credential, { home }))) return false;
      }
      return true;
    }
    case "browser": {
      try {
        await fs.access(browserSessionFile(service.id, home));
        return true;
      } catch {
        return false;
      }
    }
  }
}

// ─── The broker the garrison installs ────────────────────────────────────────

export interface ConnectPrompt {
  flowId: string;
  service: string;
  label: string;
  kind: ConnectKind;
  /** The one link the owner opens. */
  url: string;
  /** One line for the card: what tapping it will do. */
  instructions: string;
}

export interface ConnectOutcome {
  ok: boolean;
  detail: string;
}

/**
 * Implemented by a host with a public address the owner's phone can reach
 * (the garrison). Absent in a plain CLI, where Connect says so plainly.
 */
export interface ConnectBroker {
  start(service: ConnectService, opts?: { reason?: string }): Promise<ConnectPrompt>;
  wait(flowId: string, opts: { signal: AbortSignal; timeoutMs: number }): Promise<ConnectOutcome>;
}

let broker: ConnectBroker | null = null;

export function setConnectBroker(next: ConnectBroker | null): void {
  broker = next;
}

export function getConnectBroker(): ConnectBroker | null {
  return broker;
}
