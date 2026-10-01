// Cloudflare REST API - the owner's zones (domains), DNS records, zone settings,
// Workers, Pages projects and deployments, D1 / R2 / KV inventory. Reads run freely;
// DNS edits, cache invalidation, setting changes and Pages retries ask the owner;
// deleting a DNS record is the owner's decision.
//
// Curated from the vendor's OpenAPI document
// https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json
// (fetched 2026-09-30: OpenAPI 3.0.3, 3,636 operations; the document's own paths carry
// the /client/v4 prefix, which is this preset's base URL, so each op's `vendor` shows
// the long form). Docs: https://developers.cloudflare.com/api/
//
// Deliberately left out: API-token management, Worker secrets and script downloads
// (a script body can embed credentials), R2 object reads, anything that spends money
// (plan changes, paid add-ons, registrar transfers), and firewall/WAF rule writes.

import { JSON_BODY, arrOf, bool, definePreset, del, get, int, obj, p, patch, post, str, type JsonObject } from "./_kit.js";

const zone = (): JsonObject[] => [p("zone_id", "path", str("The zone id (32 hex characters) from listZones"))];
const account = (): JsonObject[] => [p("account_id", "path", str("The account id (32 hex characters) from listAccounts"))];

const PAGE = { style: "page" as const, param: "page", limitParam: "per_page", items: "result" };

const paging = (maxPerPage: number): JsonObject[] => [
  p("page", "query", int("Page number, starting at 1")),
  p("per_page", "query", int(`Results per page (max ${maxPerPage})`)),
];

export default definePreset({
  id: "cloudflare",
  label: "Cloudflare",
  blurb: "Your Cloudflare zones, DNS records, Workers, Pages deployments and storage inventory. Reads run freely; DNS edits, cache purges and setting changes ask.",
  connect: "cloudflare",
  oauth: {
    provider: "cloudflare",
    scopes: ["Zone: Read", "DNS: Edit", "Cache Purge", "Workers Scripts: Read", "Cloudflare Pages: Edit", "Account Settings: Read"],
  },
  baseUrl: "https://api.cloudflare.com/client/v4",
  verifyOperationId: "verifyToken",
  ratePerMin: 60,
  keywords: ["cloudflare", "dns", "zone", "domain", "worker", "pages", "cache", "cdn"],
  domain: "cloudflare.com",
  source: {
    kind: "vendor-openapi",
    specUrl: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
    docsUrl: "https://developers.cloudflare.com/api/",
    fetchedOn: "2026-09-30",
  },
  notes: {
    rateLimits: "1,200 requests per five minutes per user (about 240 a minute), shared across the dashboard, API and tokens; over it answers HTTP 429 and blocks for five minutes. The preset paces itself well below that.",
    pagination: "Lists answer {success, errors, messages, result, result_info:{page, per_page, total_pages, total_count}}; pass pages to follow page numbers. Zones allow per_page 5-50, DNS records up to 5,000,000 (keep it near 100).",
    auth: "Authorization: Bearer <API token>. Every answer is wrapped in {success, errors, messages, result}; read `result` (success false means the call failed even on HTTP 200 for some errors).",
    scopes: "A token only sees what its permissions and zone/account resources allow; a 403 names the missing permission group (e.g. Zone > DNS > Edit).",
    gotchas: [
      "Most calls need a zone_id or account_id, not a name: call listZones (filter name=example.com) or listAccounts first.",
      "verifyToken checks a USER token; an account-owned token verifies at /accounts/{account_id}/tokens/verify instead and answers 401 here - then use listAccounts as the liveness check.",
      "createDnsRecord/updateDnsRecord: proxied true routes traffic through Cloudflare (orange cloud); ttl 1 means automatic. A wrong record can take a site offline: the owner approves each one.",
      "invalidateCachedContent with purge_everything empties the zone's entire cache and can spike the origin; prefer files, tags, hosts or prefixes.",
      "Worker secrets, script source, API tokens and R2 object bodies are deliberately not exposed.",
      "The OAuth provider id `cloudflare` and registry entry are being added by the OAuth engineer; until then connect with an API token.",
    ],
  },
  ops: [
    // ── identity ──
    get("/user/tokens/verify", "verifyToken", "Check the connected API token is valid and active: id, status, expiry", [], {
      tags: ["user"],
      keywords: ["is my cloudflare token working", "who am i"],
      vendor: "GET /client/v4/user/tokens/verify",
    }),
    get("/accounts", "listAccounts", "Cloudflare accounts the token can see: ids and names (account_id for Workers, Pages, R2)", [p("name", "query", str("Only accounts whose name matches")), ...paging(50)], {
      tags: ["accounts"],
      keywords: ["my cloudflare accounts", "account id"],
      paginate: { ...PAGE },
      vendor: "GET /client/v4/accounts",
    }),

    // ── zones ──
    get(
      "/zones",
      "listZones",
      "Zones (domains) on the account: id, name, status, plan, nameservers",
      [
        p("name", "query", str("Only the zone with this domain name, e.g. example.com")),
        p("status", "query", str("Only this status", { enum: ["initializing", "pending", "active", "moved"] })),
        p("account.id", "query", str("Only zones of this account id")),
        p("order", "query", str("Sort by", { enum: ["name", "status", "account.id", "account.name", "plan.id"] })),
        p("direction", "query", str("Sort direction", { enum: ["asc", "desc"] })),
        ...paging(50),
      ],
      { tags: ["zones"], keywords: ["my domains", "my zones", "list domains", "zone id"], paginate: { ...PAGE }, vendor: "GET /client/v4/zones" },
    ),
    get("/zones/{zone_id}", "getZone", "One zone: status, plan, nameservers, original registrar and DNS host, activation date", zone(), { tags: ["zones"], vendor: "GET /client/v4/zones/{zone_id}" }),
    get("/zones/{zone_id}/settings", "listZoneSettings", "All zone settings and their current values (ssl, security_level, cache_level, development_mode ...)", zone(), {
      tags: ["settings"],
      keywords: ["zone settings", "ssl mode", "security level", "is development mode on"],
      vendor: "GET /client/v4/zones/{zone_id}/settings",
    }),
    patch("/zones/{zone_id}/settings/{setting_id}", "editZoneSetting", "Change one zone setting (e.g. development_mode, security_level, ssl); asks the owner", [
      ...zone(),
      p("setting_id", "path", str("The setting name, e.g. development_mode, security_level, ssl, always_use_https, cache_level")),
    ], {
      tags: ["settings"],
      risk: "write",
      keywords: ["turn on development mode", "change ssl mode", "under attack mode"],
      vendor: "PATCH /client/v4/zones/{zone_id}/settings/{setting_id}",
      body: JSON_BODY(obj("The new value", { value: str("The setting's value, e.g. on, off, low, high, full, strict") }, ["value"])),
    }),
    get("/zones/{zone_id}/pagerules", "listPageRules", "Legacy Page Rules of a zone: URL pattern, actions, status", [
      ...zone(),
      p("status", "query", str("Only this status", { enum: ["active", "disabled"] })),
      p("order", "query", str("Sort by", { enum: ["status", "priority"] })),
      p("direction", "query", str("Sort direction", { enum: ["asc", "desc"] })),
    ], { tags: ["zones"], keywords: ["page rules", "redirect rules"], vendor: "GET /client/v4/zones/{zone_id}/pagerules" }),
    get("/zones/{zone_id}/dns_analytics/report", "getDnsAnalytics", "DNS query analytics for a zone (counts by dimension over a time window)", [
      ...zone(),
      p("metrics", "query", str("Comma-separated metrics, e.g. queryCount,uncachedCount")),
      p("dimensions", "query", str("Comma-separated dimensions, e.g. queryName,queryType")),
      p("since", "query", str("Start of the window (ISO 8601)")),
      p("until", "query", str("End of the window (ISO 8601)")),
      p("limit", "query", int("Maximum rows (keep it small, e.g. 20)")),
      p("sort", "query", str("Sort, e.g. -queryCount for the largest first")),
    ], { tags: ["analytics"], keywords: ["dns queries", "dns traffic"], vendor: "GET /client/v4/zones/{zone_id}/dns_analytics/report" }),

    // ── DNS records ──
    get(
      "/zones/{zone_id}/dns_records",
      "listDnsRecords",
      "DNS records of a zone: id, type, name, content, ttl, proxied",
      [
        ...zone(),
        p("type", "query", str("Only this record type", { enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "HTTPS", "SVCB", "PTR", "TLSA"] })),
        p("name", "query", str("Only the record with exactly this full name, e.g. www.example.com")),
        p("name.contains", "query", str("Only names containing this text")),
        p("content", "query", str("Only records whose content is exactly this, e.g. an IP address")),
        p("content.contains", "query", str("Only records whose content contains this text")),
        p("proxied", "query", bool("true: only proxied (orange cloud) records")),
        p("comment.contains", "query", str("Only records whose comment contains this text")),
        p("search", "query", str("Free text matched against name, content and comment")),
        p("order", "query", str("Sort by", { enum: ["type", "name", "content", "ttl", "proxied"] })),
        p("direction", "query", str("Sort direction", { enum: ["asc", "desc"] })),
        ...paging(5000),
      ],
      { tags: ["dns"], keywords: ["dns records", "what does my domain point to", "mx records", "txt record", "cname"], paginate: { ...PAGE }, vendor: "GET /client/v4/zones/{zone_id}/dns_records" },
    ),
    get("/zones/{zone_id}/dns_records/{dns_record_id}", "getDnsRecord", "One DNS record", [...zone(), p("dns_record_id", "path", str("The record id from listDnsRecords"))], {
      tags: ["dns"],
      vendor: "GET /client/v4/zones/{zone_id}/dns_records/{dns_record_id}",
    }),
    post("/zones/{zone_id}/dns_records", "createDnsRecord", "Add a DNS record to a zone; asks the owner", zone(), {
      tags: ["dns"],
      risk: "write",
      keywords: ["add a dns record", "point a subdomain", "create cname"],
      vendor: "POST /client/v4/zones/{zone_id}/dns_records",
      body: JSON_BODY(
        obj(
          "The record",
          {
            type: str("Record type", { enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "HTTPS"] }),
            name: str("Full name or @ for the apex, e.g. www.example.com"),
            content: str("The value: an IP address for A/AAAA, a hostname for CNAME/MX, text for TXT"),
            ttl: int("Seconds; 1 means automatic"),
            proxied: bool("true routes traffic through Cloudflare (A, AAAA, CNAME only)"),
            priority: int("Priority for MX and SRV records"),
            comment: str("A note shown in the dashboard"),
          },
          ["type", "name", "content", "ttl"],
        ),
      ),
    }),
    patch("/zones/{zone_id}/dns_records/{dns_record_id}", "updateDnsRecord", "Change fields of an existing DNS record; asks the owner", [...zone(), p("dns_record_id", "path", str("The record id from listDnsRecords"))], {
      tags: ["dns"],
      risk: "write",
      keywords: ["change a dns record", "update the ip", "turn the proxy on or off"],
      vendor: "PATCH /client/v4/zones/{zone_id}/dns_records/{dns_record_id}",
      body: JSON_BODY(
        obj("Only the fields to change", {
          name: str("Full name"),
          content: str("The new value"),
          ttl: int("Seconds; 1 means automatic"),
          proxied: bool("true routes traffic through Cloudflare"),
          comment: str("A note"),
        }),
      ),
    }),
    del("/zones/{zone_id}/dns_records/{dns_record_id}", "deleteDnsRecord", "Delete a DNS record; the owner decides", [...zone(), p("dns_record_id", "path", str("The record id from listDnsRecords"))], {
      tags: ["dns"],
      keywords: ["remove a dns record"],
      vendor: "DELETE /client/v4/zones/{zone_id}/dns_records/{dns_record_id}",
    }),

    // ── cache ──
    post("/zones/{zone_id}/purge_cache", "invalidateCachedContent", "Purge cached content (specific URLs, tags, hosts, prefixes, or everything); asks the owner", zone(), {
      tags: ["cache"],
      risk: "write",
      keywords: ["purge cache", "clear the cache", "flush cdn", "invalidate"],
      vendor: "POST /client/v4/zones/{zone_id}/purge_cache",
      body: JSON_BODY(
        obj("Send ONE of these", {
          files: arrOf("Full URLs to purge", { type: "string" }),
          tags: arrOf("Cache-Tag values to purge", { type: "string" }),
          hosts: arrOf("Hostnames to purge", { type: "string" }),
          prefixes: arrOf("URL prefixes to purge, without the scheme", { type: "string" }),
          purge_everything: bool("true empties the whole zone cache (heavy on the origin)"),
        }),
      ),
    }),

    // ── Workers ──
    get("/accounts/{account_id}/workers/scripts", "listWorkers", "Worker scripts of an account: name, last modified, routes, handlers", [...account(), p("tags", "query", str("Filter by tags: comma-separated tag:yes or tag:no"))], {
      tags: ["workers"],
      keywords: ["my workers", "cloudflare workers"],
      vendor: "GET /client/v4/accounts/{account_id}/workers/scripts",
    }),
    get("/accounts/{account_id}/workers/scripts/{script_name}/deployments", "listWorkerDeployments", "Deployment history of a Worker: versions and rollout percentages", [...account(), p("script_name", "path", str("The Worker name"))], {
      tags: ["workers"],
      keywords: ["worker deployments", "which worker version is live"],
      vendor: "GET /client/v4/accounts/{account_id}/workers/scripts/{script_name}/deployments",
    }),
    get("/accounts/{account_id}/workers/scripts/{script_name}/schedules", "getWorkerCronTriggers", "Cron triggers of a Worker", [...account(), p("script_name", "path", str("The Worker name"))], {
      tags: ["workers"],
      vendor: "GET /client/v4/accounts/{account_id}/workers/scripts/{script_name}/schedules",
    }),
    get("/accounts/{account_id}/workers/domains", "listWorkerDomains", "Custom domains attached to Workers", account(), { tags: ["workers"], vendor: "GET /client/v4/accounts/{account_id}/workers/domains" }),

    // ── Pages ──
    get("/accounts/{account_id}/pages/projects", "listPagesProjects", "Pages projects: name, production URL, domains, latest deployment, git source", [...account(), ...paging(100)], {
      tags: ["pages"],
      keywords: ["my pages sites", "cloudflare pages projects"],
      paginate: { ...PAGE },
      vendor: "GET /client/v4/accounts/{account_id}/pages/projects",
    }),
    get("/accounts/{account_id}/pages/projects/{project_name}", "getPagesProject", "One Pages project: build config, domains, canonical deployment", [...account(), p("project_name", "path", str("The Pages project name"))], {
      tags: ["pages"],
      vendor: "GET /client/v4/accounts/{account_id}/pages/projects/{project_name}",
    }),
    get("/accounts/{account_id}/pages/projects/{project_name}/deployments", "listPagesDeployments", "Deployments of a Pages project, newest first: id, environment, stage status, commit, URL", [
      ...account(),
      p("project_name", "path", str("The Pages project name")),
      p("env", "query", str("Only this environment", { enum: ["production", "preview"] })),
      ...paging(100),
    ], {
      tags: ["pages"],
      keywords: ["latest pages deployment", "did the pages build succeed", "pages deploys"],
      paginate: { ...PAGE },
      vendor: "GET /client/v4/accounts/{account_id}/pages/projects/{project_name}/deployments",
    }),
    get("/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/history/logs", "getPagesDeploymentLogs", "Build log lines of a Pages deployment", [
      ...account(),
      p("project_name", "path", str("The Pages project name")),
      p("deployment_id", "path", str("The deployment id from listPagesDeployments")),
    ], {
      tags: ["pages"],
      keywords: ["pages build log", "why did the pages build fail"],
      vendor: "GET /client/v4/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/history/logs",
    }),
    get("/accounts/{account_id}/pages/projects/{project_name}/domains", "listPagesDomains", "Custom domains of a Pages project and their verification status", [...account(), p("project_name", "path", str("The Pages project name"))], {
      tags: ["pages"],
      vendor: "GET /client/v4/accounts/{account_id}/pages/projects/{project_name}/domains",
    }),
    post("/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/retry", "retryPagesDeployment", "Retry a failed Pages deployment build; asks the owner", [
      ...account(),
      p("project_name", "path", str("The Pages project name")),
      p("deployment_id", "path", str("The deployment id from listPagesDeployments")),
    ], {
      tags: ["pages"],
      risk: "write",
      keywords: ["retry the pages build", "rebuild pages"],
      vendor: "POST /client/v4/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/retry",
    }),

    // ── storage inventory ──
    get("/accounts/{account_id}/d1/database", "listD1Databases", "D1 databases of an account: name, id, size, created", [...account(), p("name", "query", str("Only databases whose name contains this")), ...paging(1000)], {
      tags: ["d1"],
      keywords: ["my d1 databases"],
      vendor: "GET /client/v4/accounts/{account_id}/d1/database",
    }),
    get("/accounts/{account_id}/r2/buckets", "listR2Buckets", "R2 buckets of an account: name, location, created", account(), { tags: ["r2"], keywords: ["my r2 buckets", "object storage"], vendor: "GET /client/v4/accounts/{account_id}/r2/buckets" }),
    get("/accounts/{account_id}/storage/kv/namespaces", "listKvNamespaces", "Workers KV namespaces of an account: id and title", [...account(), ...paging(100)], {
      tags: ["kv"],
      keywords: ["my kv namespaces"],
      paginate: { ...PAGE },
      vendor: "GET /client/v4/accounts/{account_id}/storage/kv/namespaces",
    }),
    get("/accounts/{account_id}/cfd_tunnel", "listTunnels", "Cloudflare Tunnels: name, id, status, connections", [
      ...account(),
      p("is_deleted", "query", bool("true: list deleted tunnels instead")),
      p("name", "query", str("Only tunnels with this name")),
      ...paging(1000),
    ], { tags: ["tunnels"], keywords: ["my tunnels", "is my tunnel up"], paginate: { ...PAGE }, vendor: "GET /client/v4/accounts/{account_id}/cfd_tunnel" }),
    get("/accounts/{account_id}/audit_logs", "listAuditLogs", "Account audit log: who changed what and when", [
      ...account(),
      p("since", "query", str("Start of the window (ISO 8601 or YYYY-MM-DD)")),
      p("before", "query", str("End of the window (ISO 8601 or YYYY-MM-DD)")),
      p("actor.email", "query", str("Only this actor")),
      p("action.type", "query", str("Only this action, e.g. create, delete, update")),

    ], { tags: ["audit"], keywords: ["what changed in cloudflare", "who edited dns"], vendor: "GET /client/v4/accounts/{account_id}/audit_logs" }),
  ],
  recipes: [
    {
      ask: "what does www.example.com point to",
      steps: [
        { op: "listZones", params: { name: "example.com" }, fields: "result.id,result.name,result.status", note: "the zone id comes from here" },
        { op: "listDnsRecords", params: { zone_id: "023e105f4ecef8ad9ca31a8372d0c353", name: "www.example.com" }, fields: "result.id,result.type,result.name,result.content,result.proxied,result.ttl" },
      ],
    },
    {
      ask: "list all the DNS records for example.com",
      steps: [
        { op: "listZones", params: { name: "example.com" }, fields: "result.id,result.name" },
        { op: "listDnsRecords", params: { zone_id: "023e105f4ecef8ad9ca31a8372d0c353", per_page: 100, order: "type" }, fields: "result.type,result.name,result.content,result.proxied", note: "pass pages to get more than one page" },
      ],
    },
    {
      ask: "did my last Pages deploy succeed",
      steps: [
        { op: "listAccounts", fields: "result.id,result.name" },
        { op: "listPagesDeployments", params: { account_id: "01a7362d577a6c3019a474fd6f485823", project_name: "my-site", per_page: 3 }, fields: "result.id,result.environment,result.created_on,result.latest_stage.name,result.latest_stage.status,result.deployment_trigger.metadata.commit_message" },
        { op: "getPagesDeploymentLogs", params: { account_id: "01a7362d577a6c3019a474fd6f485823", project_name: "my-site", deployment_id: "dep-id-from-above" }, note: "only when the stage status is failure; the last lines hold the error" },
      ],
    },
    {
      ask: "which Workers do I have deployed",
      steps: [
        { op: "listAccounts", fields: "result.id,result.name" },
        { op: "listWorkers", params: { account_id: "01a7362d577a6c3019a474fd6f485823" }, fields: "result.id,result.modified_on,result.handlers" },
      ],
    },
    {
      ask: "add a CNAME for blog.example.com pointing at my-blog.pages.dev",
      steps: [
        { op: "listZones", params: { name: "example.com" }, fields: "result.id,result.name" },
        { op: "listDnsRecords", params: { zone_id: "023e105f4ecef8ad9ca31a8372d0c353", name: "blog.example.com" }, fields: "result.id,result.type,result.content", note: "make sure it does not already exist" },
        { op: "createDnsRecord", params: { zone_id: "023e105f4ecef8ad9ca31a8372d0c353" }, body: { type: "CNAME", name: "blog.example.com", content: "my-blog.pages.dev", ttl: 1, proxied: true }, note: "asks the owner first" },
      ],
    },
    {
      ask: "clear the cache for example.com/styles.css",
      steps: [
        { op: "listZones", params: { name: "example.com" }, fields: "result.id,result.name" },
        { op: "invalidateCachedContent", params: { zone_id: "023e105f4ecef8ad9ca31a8372d0c353" }, body: { files: ["https://example.com/styles.css"] }, note: "asks the owner first; prefer files over purge_everything" },
      ],
    },
  ],
  searchChecks: [
    ["my domains", "listZones"],
    ["dns records", "listDnsRecords"],
    ["add a dns record", "createDnsRecord"],
    ["purge cache", "invalidateCachedContent"],
    ["did the pages build succeed", "listPagesDeployments"],
    ["my workers", "listWorkers"],
    ["delete a dns record", "deleteDnsRecord"],
  ],
});
