// The connector catalog: the remote MCP servers Ares knows how to connect to
// with one click. Every entry is a real, publicly documented remote endpoint;
// `auth` says what the click does — "oauth" runs the standard OAuth dance
// (RFC 9728 discovery, dynamic registration, PKCE), "key" asks for the
// service's API key, "none" just connects. `transport` is a hint the client
// verifies at connect time. The public MCP registry covers the long tail;
// this list is what people reach for first, curated for reliability.

export type McpAuthKind = "oauth" | "key" | "none";
export type McpTransportKind = "http" | "sse" | "auto";
export type McpCategory =
  | "dev" | "deploy" | "data" | "design" | "docs" | "project" | "comms" | "payments" | "commerce" | "ai" | "search" | "productivity" | "monitoring" | "security";

export interface McpCatalogEntry {
  id: string;
  name: string;
  url: string;
  auth: McpAuthKind;
  transport: McpTransportKind;
  category: McpCategory;
  blurb: string;
  /** Words people say when they mean this service; drives suggestions. */
  keywords: string[];
  /** Where to mint a key when auth is "key". */
  keyUrl?: string;
  /** Header the key travels in when the server does not take a bearer. */
  keyHeader?: string;
  docs?: string;
}

export const MCP_CATEGORIES: Array<{ id: McpCategory; label: string }> = [
  { id: "dev", label: "Code & repos" },
  { id: "deploy", label: "Deploy & infra" },
  { id: "data", label: "Databases" },
  { id: "project", label: "Projects & tasks" },
  { id: "docs", label: "Docs & knowledge" },
  { id: "design", label: "Design" },
  { id: "comms", label: "Messaging" },
  { id: "payments", label: "Payments" },
  { id: "commerce", label: "Commerce" },
  { id: "monitoring", label: "Monitoring" },
  { id: "security", label: "Security" },
  { id: "ai", label: "AI & models" },
  { id: "search", label: "Search & web" },
  { id: "productivity", label: "Productivity" },
];

export const MCP_CATALOG: McpCatalogEntry[] = [
  // ── code & repos ─────────────────────────────────────────────────────────
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", auth: "oauth", transport: "http", category: "dev", blurb: "Repos, issues, pull requests, code search and Actions.", keywords: ["github", "repo", "repository", "pull request", "pr", "issue", "gh"], docs: "https://github.com/github/github-mcp-server" },
  { id: "gitlab", name: "GitLab", url: "https://gitlab.com/api/v4/mcp", auth: "oauth", transport: "http", category: "dev", blurb: "Projects, merge requests, pipelines and issues on GitLab.com.", keywords: ["gitlab", "merge request", "mr"] },
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", auth: "oauth", transport: "http", category: "monitoring", blurb: "Search, query and debug errors and performance issues.", keywords: ["sentry", "error tracking", "crash", "exception"] },
  { id: "semgrep", name: "Semgrep", url: "https://mcp.semgrep.ai/mcp", auth: "none", transport: "http", category: "security", blurb: "Static analysis and security scanning of code.", keywords: ["semgrep", "sast", "security scan", "vulnerability"] },
  { id: "context7", name: "Context7", url: "https://mcp.context7.com/mcp", auth: "none", transport: "http", category: "docs", blurb: "Up-to-date library and framework documentation for code.", keywords: ["context7", "library docs", "api docs", "documentation"] },
  { id: "deepwiki", name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", auth: "none", transport: "http", category: "docs", blurb: "Ask questions about any public GitHub repository.", keywords: ["deepwiki", "repo docs", "explain repo"] },
  { id: "jam", name: "Jam", url: "https://mcp.jam.dev/mcp", auth: "oauth", transport: "http", category: "dev", blurb: "Bug reports with console logs, network and repro steps.", keywords: ["jam", "bug report", "repro"] },
  // ── deploy & infra ──────────────────────────────────────────────────────
  { id: "vercel", name: "Vercel", url: "https://mcp.vercel.com", auth: "oauth", transport: "http", category: "deploy", blurb: "Projects, deployments, logs and domains.", keywords: ["vercel", "deploy", "deployment", "next.js hosting"] },
  { id: "netlify", name: "Netlify", url: "https://netlify-mcp.netlify.app/mcp", auth: "oauth", transport: "http", category: "deploy", blurb: "Sites, deploys, forms and environment variables.", keywords: ["netlify"] },
  { id: "cloudflare-docs", name: "Cloudflare Docs", url: "https://docs.mcp.cloudflare.com/sse", auth: "none", transport: "sse", category: "docs", blurb: "Search Cloudflare's documentation.", keywords: ["cloudflare docs"] },
  { id: "cloudflare-bindings", name: "Cloudflare Workers", url: "https://bindings.mcp.cloudflare.com/sse", auth: "oauth", transport: "sse", category: "deploy", blurb: "Workers, KV, R2, D1 and bindings on your account.", keywords: ["cloudflare", "workers", "kv", "r2", "d1"] },
  { id: "cloudflare-observability", name: "Cloudflare Observability", url: "https://observability.mcp.cloudflare.com/sse", auth: "oauth", transport: "sse", category: "monitoring", blurb: "Logs and analytics for your Workers.", keywords: ["cloudflare logs", "workers logs"] },
  { id: "render", name: "Render", url: "https://mcp.render.com/mcp", auth: "key", transport: "http", category: "deploy", blurb: "Services, deploys, logs and databases on Render.", keywords: ["render.com", "render"], keyUrl: "https://dashboard.render.com/settings#api-keys" },
  { id: "neon", name: "Neon", url: "https://mcp.neon.tech/mcp", auth: "oauth", transport: "http", category: "data", blurb: "Serverless Postgres: projects, branches, SQL.", keywords: ["neon", "postgres", "neon db"] },
  { id: "supabase", name: "Supabase", url: "https://mcp.supabase.com/mcp", auth: "oauth", transport: "http", category: "data", blurb: "Databases, auth, storage and edge functions.", keywords: ["supabase"] },
  { id: "prisma", name: "Prisma Postgres", url: "https://mcp.prisma.io/mcp", auth: "oauth", transport: "http", category: "data", blurb: "Manage Prisma Postgres databases.", keywords: ["prisma"] },
  { id: "mongodb", name: "MongoDB Atlas", url: "https://mcp.mongodb.com/mcp", auth: "oauth", transport: "http", category: "data", blurb: "Clusters, collections and queries on Atlas.", keywords: ["mongodb", "mongo", "atlas"] },
  { id: "plaid", name: "Plaid", url: "https://api.dashboard.plaid.com/mcp/sse", auth: "oauth", transport: "sse", category: "payments", blurb: "Plaid dashboard: items, institutions and usage.", keywords: ["plaid"] },
  // ── projects & tasks ────────────────────────────────────────────────────
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth", transport: "http", category: "project", blurb: "Issues, projects, cycles and team workflows.", keywords: ["linear", "linear issue", "ticket"] },
  { id: "atlassian", name: "Atlassian (Jira & Confluence)", url: "https://mcp.atlassian.com/v1/sse", auth: "oauth", transport: "sse", category: "project", blurb: "Jira issues and Confluence pages.", keywords: ["jira", "confluence", "atlassian"] },
  { id: "asana", name: "Asana", url: "https://mcp.asana.com/sse", auth: "oauth", transport: "sse", category: "project", blurb: "Tasks, projects and goals.", keywords: ["asana"] },
  { id: "monday", name: "monday.com", url: "https://mcp.monday.com/mcp", auth: "oauth", transport: "http", category: "project", blurb: "Boards, items and workflows.", keywords: ["monday", "monday.com"] },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", auth: "oauth", transport: "http", category: "docs", blurb: "Search, read and update your Notion workspace.", keywords: ["notion", "notion page", "notion database"] },
  { id: "clickup", name: "ClickUp", url: "https://mcp.clickup.com/mcp", auth: "oauth", transport: "http", category: "project", blurb: "Tasks, docs and spaces.", keywords: ["clickup"] },
  { id: "todoist", name: "Todoist", url: "https://ai.todoist.net/mcp", auth: "oauth", transport: "http", category: "productivity", blurb: "Tasks and projects in Todoist.", keywords: ["todoist", "todo"] },
  // ── design ──────────────────────────────────────────────────────────────
  { id: "figma", name: "Figma", url: "https://mcp.figma.com/mcp", auth: "oauth", transport: "http", category: "design", blurb: "Read designs, components and variables from Figma files.", keywords: ["figma", "design file", "mockup"] },
  { id: "canva", name: "Canva", url: "https://mcp.canva.com/mcp", auth: "oauth", transport: "http", category: "design", blurb: "Create and edit Canva designs.", keywords: ["canva"] },
  { id: "invideo", name: "invideo", url: "https://mcp.invideo.io/sse", auth: "oauth", transport: "sse", category: "design", blurb: "Generate videos from prompts.", keywords: ["invideo", "video generation"] },
  // ── messaging & comms ───────────────────────────────────────────────────
  { id: "intercom", name: "Intercom", url: "https://mcp.intercom.com/mcp", auth: "oauth", transport: "http", category: "comms", blurb: "Conversations, contacts and help center.", keywords: ["intercom", "support inbox"] },
  { id: "hubspot", name: "HubSpot", url: "https://mcp.hubspot.com/anthropic", auth: "oauth", transport: "http", category: "comms", blurb: "CRM contacts, companies, deals and tickets.", keywords: ["hubspot", "crm"] },
  { id: "close", name: "Close CRM", url: "https://mcp.close.com/mcp", auth: "oauth", transport: "http", category: "comms", blurb: "Leads, opportunities and activity in Close.", keywords: ["close crm", "close.com"] },
  // ── payments & commerce ─────────────────────────────────────────────────
  { id: "stripe", name: "Stripe", url: "https://mcp.stripe.com", auth: "oauth", transport: "http", category: "payments", blurb: "Customers, payments, subscriptions and docs.", keywords: ["stripe", "payment", "subscription", "invoice"] },
  { id: "paypal", name: "PayPal", url: "https://mcp.paypal.com/mcp", auth: "oauth", transport: "http", category: "payments", blurb: "Invoices, orders, subscriptions and disputes.", keywords: ["paypal"] },
  { id: "square", name: "Square", url: "https://mcp.squareup.com/sse", auth: "oauth", transport: "sse", category: "commerce", blurb: "Payments, orders, catalog and customers.", keywords: ["square", "squareup"] },
  { id: "shopify", name: "Shopify Dev", url: "https://shopify.dev/mcp", auth: "none", transport: "http", category: "commerce", blurb: "Shopify APIs, docs and schema search.", keywords: ["shopify", "shopify dev"] },
  { id: "wix", name: "Wix", url: "https://mcp.wix.com/sse", auth: "oauth", transport: "sse", category: "commerce", blurb: "Sites, stores and bookings on Wix.", keywords: ["wix"] },
  { id: "dodo", name: "Dodo Payments", url: "https://mcp.dodopayments.com/sse", auth: "oauth", transport: "sse", category: "payments", blurb: "Products, payments and subscriptions.", keywords: ["dodo payments"] },
  { id: "mercadopago", name: "Mercado Pago", url: "https://mcp.mercadopago.com/mcp", auth: "oauth", transport: "http", category: "payments", blurb: "Mercado Pago integration docs and tools.", keywords: ["mercado pago", "mercadopago"] },
  // ── ai & search ─────────────────────────────────────────────────────────
  { id: "huggingface", name: "Hugging Face", url: "https://huggingface.co/mcp", auth: "oauth", transport: "http", category: "ai", blurb: "Models, datasets, papers and Spaces.", keywords: ["hugging face", "huggingface", "hf", "model hub"] },
  { id: "zapier", name: "Zapier", url: "https://mcp.zapier.com/api/mcp/mcp", auth: "key", transport: "http", category: "productivity", blurb: "8,000+ apps through your Zapier actions.", keywords: ["zapier", "zap", "automation"], keyUrl: "https://mcp.zapier.com" },
  { id: "firecrawl", name: "Firecrawl", url: "https://mcp.firecrawl.dev/mcp", auth: "key", transport: "http", category: "search", blurb: "Scrape, crawl and extract from any site.", keywords: ["firecrawl", "scrape", "crawl"], keyUrl: "https://firecrawl.dev/app/api-keys", keyHeader: "Authorization" },
  { id: "exa", name: "Exa", url: "https://mcp.exa.ai/mcp", auth: "key", transport: "http", category: "search", blurb: "Neural web search and page contents.", keywords: ["exa", "web search"], keyUrl: "https://dashboard.exa.ai/api-keys" },
  { id: "tavily", name: "Tavily", url: "https://mcp.tavily.com/mcp/", auth: "key", transport: "http", category: "search", blurb: "Search and extract for agents.", keywords: ["tavily"], keyUrl: "https://app.tavily.com/home" },
  { id: "perplexity", name: "Perplexity", url: "https://mcp.perplexity.ai/mcp", auth: "key", transport: "http", category: "search", blurb: "Answers with citations from Perplexity.", keywords: ["perplexity"], keyUrl: "https://www.perplexity.ai/settings/api" },
  // ── productivity & docs ─────────────────────────────────────────────────
  { id: "box", name: "Box", url: "https://mcp.box.com", auth: "oauth", transport: "http", category: "docs", blurb: "Files, folders and content in Box.", keywords: ["box", "box.com"] },
  { id: "dropbox", name: "Dropbox", url: "https://mcp.dropbox.com/mcp", auth: "oauth", transport: "http", category: "docs", blurb: "Files and folders in Dropbox.", keywords: ["dropbox"] },
  { id: "airtable", name: "Airtable", url: "https://mcp.airtable.com/mcp", auth: "oauth", transport: "http", category: "data", blurb: "Bases, tables and records.", keywords: ["airtable"] },
  { id: "webflow", name: "Webflow", url: "https://mcp.webflow.com/sse", auth: "oauth", transport: "sse", category: "design", blurb: "Sites, CMS collections and pages.", keywords: ["webflow"] },
  { id: "fireflies", name: "Fireflies", url: "https://api.fireflies.ai/mcp", auth: "oauth", transport: "http", category: "productivity", blurb: "Meeting transcripts and summaries.", keywords: ["fireflies", "meeting notes", "transcript"] },
  { id: "calendly", name: "Calendly", url: "https://mcp.calendly.com/mcp", auth: "oauth", transport: "http", category: "productivity", blurb: "Event types, scheduled events and availability.", keywords: ["calendly", "scheduling"] },
];

export function catalogById(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

export function catalogByUrl(url: string): McpCatalogEntry | undefined {
  const norm = url.replace(/\/+$/, "").toLowerCase();
  const exact = MCP_CATALOG.find((e) => e.url.replace(/\/+$/, "").toLowerCase() === norm);
  if (exact) return exact;
  // same host, different path (a server that moved from /sse to /mcp, or a
  // trailing segment the owner typed) still belongs to the same service
  try {
    const host = new URL(url).host.toLowerCase();
    return MCP_CATALOG.find((e) => { try { return new URL(e.url).host.toLowerCase() === host; } catch { return false; } });
  } catch {
    return undefined;
  }
}

/** Catalog services a piece of text is plainly about — for "connect X?" cards. */
export function catalogMentions(text: string): McpCatalogEntry[] {
  const lower = text.toLowerCase();
  const out: McpCatalogEntry[] = [];
  for (const entry of MCP_CATALOG) {
    if (entry.keywords.some((k) => k.length >= 3 && new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(lower))) out.push(entry);
  }
  return out;
}
