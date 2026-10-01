// Supabase Management API - the owner's organizations, projects, database branches,
// migrations, edge functions, logs, advisors and health. Reads (including read-only
// SQL) run freely; applying migrations, running SQL that can write, merging branches
// and restarting ask the owner; pausing or resetting is the owner's decision.
//
// Curated from the vendor's OpenAPI document https://api.supabase.com/api/v1-json
// (fetched 2026-09-30: OpenAPI 3.0.0, 170 operations); every path, method and
// parameter name below was checked against it (scripts/api-preset-verify.mjs).
// Docs: https://supabase.com/docs/reference/api/introduction
//
// Deliberately left out: anything that reveals or mints credentials (project API
// keys, secrets, signing keys, database password, CLI login roles, claim tokens,
// the auth config that embeds SMTP and OAuth client secrets), deleting a project,
// and anything that changes billing (add-ons, compute size, creating branches,
// read replicas, upgrades, disk resizing).

import { JSON_BODY, arrOf, bool, definePreset, get, int, obj, p, post, str, type JsonObject } from "./_kit.js";

const ref = (): JsonObject[] => [p("ref", "path", str("The project ref: the 20-letter id in the project URL (from listProjects)"))];

export default definePreset({
  id: "supabase",
  label: "Supabase",
  blurb: "Your Supabase projects: database queries, migrations, edge functions, branches, logs, advisors and health. Reads run freely; anything that can change data asks.",
  connect: "supabase",
  oauth: { scopes: ["a Supabase personal access token or OAuth token with access to the organization and projects"] },
  baseUrl: "https://api.supabase.com",
  verifyOperationId: "listOrganizations",
  ratePerMin: 60,
  keywords: ["supabase", "postgres", "database", "edge function", "migration", "sql"],
  domain: "supabase.com",
  source: {
    kind: "vendor-openapi",
    specUrl: "https://api.supabase.com/api/v1-json",
    docsUrl: "https://supabase.com/docs/reference/api/introduction",
    fetchedOn: "2026-09-30",
  },
  notes: {
    rateLimits: "The Management API allows about 120 requests a minute per user across all endpoints, answered with HTTP 429; the Api tool waits out a short Retry-After. Logs queries are heavier: keep windows small.",
    pagination: "Lists are not paged: they answer the whole array.",
    auth: "Authorization: Bearer <token>, where the token is a personal access token (sbp_...) or an OAuth access token from a Supabase OAuth app. This is the Management API (api.supabase.com), not a project's own REST endpoint (<ref>.supabase.co) and not a service-role key.",
    scopes: "The token sees every organization and project its owner can. Read-only SQL runs as the supabase_read_only_user role.",
    gotchas: [
      "queryDatabase executes SQL as the read-only role and is the default for questions; executeSql can change or destroy data and always asks the owner (put read_only:true in its body to make it refuse writes).",
      "getProjectLogs queries the unified log stream in the ClickHouse SQL dialect, filter by the `source` column (edge_logs, postgres_logs, auth_logs ...); the window must be 24 hours or less, and with no timestamps only the last minute is searched. The older logs.all endpoint is removed (HTTP 410).",
      "A paused project answers most calls with an error: pauseProject takes the whole app offline, restoreProject brings it back.",
      "Project API keys, secrets, the database password and signing keys are never exposed here; use the dashboard. Creating branches, changing compute or add-ons is billed and is not exposed.",
      "UNVERIFIED: whether the token from the hosted Supabase MCP sign-in (mcp.supabase.com) is accepted by this Management API; the preset therefore does not borrow the MCP token and expects a token from the Supabase connect flow.",
    ],
  },
  ops: [
    // ── organizations and projects ──
    get("/v1/organizations", "listOrganizations", "Organizations the token can see: id, slug, name", [], { tags: ["organizations"], keywords: ["my supabase organizations", "who am i"], vendor: "GET /v1/organizations" }),
    get("/v1/organizations/{slug}", "getOrganization", "One organization: name, plan, billing email", [p("slug", "path", str("The organization slug from listOrganizations"))], {
      tags: ["organizations"],
      vendor: "GET /v1/organizations/{slug}",
    }),
    get("/v1/organizations/{slug}/members", "listOrganizationMembers", "Members of an organization: user, role", [p("slug", "path", str("The organization slug"))], {
      tags: ["organizations"],
      keywords: ["who is on my team"],
      vendor: "GET /v1/organizations/{slug}/members",
    }),
    get("/v1/projects", "listProjects", "All projects: ref, name, region, status (ACTIVE_HEALTHY, PAUSED ...), organization", [], {
      tags: ["projects"],
      keywords: ["my supabase projects", "list projects", "project ref"],
      vendor: "GET /v1/projects",
    }),
    get("/v1/projects/{ref}", "getProject", "One project: name, region, status, Postgres version, database host", ref(), { tags: ["projects"], vendor: "GET /v1/projects/{ref}" }),
    get(
      "/v1/projects/{ref}/health",
      "getProjectHealth",
      "Health of a project's services: is the database, API, auth, realtime and storage up",
      [
        ...ref(),
        p("services", "query", str("Comma-separated services to check: auth, db, db_postgres_user, pooler, realtime, rest, storage, pg_bouncer"), true),
        p("timeout_ms", "query", int("Per-service timeout in milliseconds (0-10000)")),
      ],
      { tags: ["projects"], keywords: ["is my supabase up", "project health", "is the database healthy"], vendor: "GET /v1/projects/{ref}/health" },
    ),
    post("/v1/projects/{ref}/restart", "restartProject", "Restart a project's services (a few minutes of downtime); asks the owner", ref(), {
      tags: ["projects"],
      risk: "write",
      keywords: ["restart supabase"],
      vendor: "POST /v1/projects/{ref}/restart",
    }),
    post("/v1/projects/{ref}/pause", "pauseProject", "Pause a project: the database and API go offline until restored; the owner decides", ref(), {
      tags: ["projects"],
      risk: "destructive",
      keywords: ["pause the project"],
      vendor: "POST /v1/projects/{ref}/pause",
    }),
    post("/v1/projects/{ref}/restore", "restoreProject", "Restore (un-pause) a paused project; asks the owner", ref(), {
      tags: ["projects"],
      risk: "write",
      keywords: ["unpause", "resume the project", "bring it back online"],
      vendor: "POST /v1/projects/{ref}/restore",
    }),

    // ── database ──
    post("/v1/projects/{ref}/database/query/read-only", "queryDatabase", "Run a SELECT (or other read-only SQL) as the read-only role and get the rows; runs freely", ref(), {
      tags: ["database"],
      risk: "read",
      keywords: ["run a sql query", "query the database", "how many rows", "select from table", "count users"],
      vendor: "POST /v1/projects/{ref}/database/query/read-only",
      body: JSON_BODY(obj("The query", { query: str("SQL text, e.g. select count(*) from auth.users"), parameters: arrOf("Values for $1, $2 ... placeholders", {}) }, ["query"])),
    }),
    post("/v1/projects/{ref}/database/query", "executeSql", "Run SQL that may change data or schema (insert, update, delete, DDL); asks the owner with the exact SQL", ref(), {
      tags: ["database"],
      risk: "write",
      keywords: ["update a row", "insert a row", "alter table", "run sql that writes"],
      vendor: "POST /v1/projects/{ref}/database/query",
      body: JSON_BODY(
        obj(
          "The statement",
          { query: str("SQL text"), parameters: arrOf("Values for $1, $2 ... placeholders", {}), read_only: bool("true makes the statement fail if it tries to write") },
          ["query"],
        ),
      ),
    }),
    get("/v1/projects/{ref}/database/migrations", "listMigrations", "Applied migration versions and names, oldest first", ref(), {
      tags: ["database"],
      keywords: ["migration history", "which migrations have run"],
      vendor: "GET /v1/projects/{ref}/database/migrations",
    }),
    post("/v1/projects/{ref}/database/migrations", "applyMigration", "Apply a SQL migration and record it in the history; asks the owner with the exact SQL", ref(), {
      tags: ["database"],
      risk: "write",
      keywords: ["apply a migration", "run a migration", "create a table"],
      vendor: "POST /v1/projects/{ref}/database/migrations",
      body: JSON_BODY(
        obj("The migration", { query: str("The migration SQL"), name: str("Short snake_case name, e.g. add_profiles_table"), rollback: str("Optional SQL that undoes it") }, ["query"]),
      ),
    }),
    get("/v1/projects/{ref}/database/context", "getDatabaseMetadata", "Database metadata: schemas, tables and columns, to write correct SQL", ref(), {
      tags: ["database"],
      keywords: ["what tables do i have", "database schema", "list tables"],
      vendor: "GET /v1/projects/{ref}/database/context",
    }),
    get("/v1/projects/{ref}/types/typescript", "generateTypescriptTypes", "TypeScript types for the database schema", [...ref(), p("included_schemas", "query", str("Comma-separated schemas to include (default public)"))], {
      tags: ["database"],
      keywords: ["generate types"],
      vendor: "GET /v1/projects/{ref}/types/typescript",
    }),
    get("/v1/projects/{ref}/database/backups", "listBackups", "Backups of the database: status, region, whether PITR is enabled", ref(), {
      tags: ["database"],
      keywords: ["do i have backups", "latest backup"],
      vendor: "GET /v1/projects/{ref}/database/backups",
    }),
    get("/v1/projects/{ref}/config/disk/util", "getDiskUtilization", "Database disk usage: size, used, available", ref(), { tags: ["database"], keywords: ["how much disk"], vendor: "GET /v1/projects/{ref}/config/disk/util" }),

    // ── logs, advisors, usage ──
    get(
      "/v1/projects/{ref}/analytics/endpoints/logs",
      "getProjectLogs",
      "Search a project's logs (API edge logs, Postgres, auth, functions) with SQL over a time window of at most 24 hours",
      [
        ...ref(),
        p("sql", "query", str("Query in the ClickHouse SQL dialect, e.g. select timestamp, event_message from edge_logs where status_code >= 500 order by timestamp desc limit 20")),
        p("iso_timestamp_start", "query", str("Window start, ISO 8601 UTC, e.g. 2026-09-30T00:00:00Z")),
        p("iso_timestamp_end", "query", str("Window end, ISO 8601 UTC; at most 24 hours after the start")),
      ],
      { tags: ["logs"], keywords: ["project logs", "errors in the last hour", "api errors", "postgres logs", "edge function logs"], vendor: "GET /v1/projects/{ref}/analytics/endpoints/logs" },
    ),
    get("/v1/projects/{ref}/analytics/endpoints/usage.api-counts", "getApiUsageCounts", "API request counts over an interval, per service", [
      ...ref(),
      p("interval", "query", str("Window", { enum: ["15min", "30min", "1hr", "3hr", "1day", "3day", "7day"] })),
    ], { tags: ["logs"], keywords: ["api traffic", "how many requests"], vendor: "GET /v1/projects/{ref}/analytics/endpoints/usage.api-counts" }),
    get("/v1/projects/{ref}/analytics/endpoints/functions.combined-stats", "getFunctionStats", "Invocation, error and latency statistics of one edge function", [
      ...ref(),
      p("interval", "query", str("Window", { enum: ["15min", "1hr", "3hr", "1day"] }), true),
      p("function_id", "query", str("The function id from listFunctions"), true),
    ], { tags: ["logs", "functions"], keywords: ["function errors", "function invocations"], vendor: "GET /v1/projects/{ref}/analytics/endpoints/functions.combined-stats" }),
    get("/v1/projects/{ref}/advisors/security", "getSecurityAdvisors", "Security advisor findings: tables without row level security, exposed views and similar", ref(), {
      tags: ["advisors"],
      keywords: ["security check", "is my database secure", "missing rls", "security advisors"],
      vendor: "GET /v1/projects/{ref}/advisors/security",
    }),
    get("/v1/projects/{ref}/advisors/performance", "getPerformanceAdvisors", "Performance advisor findings: missing indexes, unused indexes, slow policies", ref(), {
      tags: ["advisors"],
      keywords: ["performance check", "missing indexes", "slow database"],
      vendor: "GET /v1/projects/{ref}/advisors/performance",
    }),

    // ── edge functions and storage ──
    get("/v1/projects/{ref}/functions", "listFunctions", "Edge functions: slug, name, status, version, last updated", ref(), {
      tags: ["functions"],
      keywords: ["my edge functions", "deployed functions"],
      vendor: "GET /v1/projects/{ref}/functions",
    }),
    get("/v1/projects/{ref}/functions/{function_slug}", "getFunction", "One edge function: status, version, verify_jwt, entrypoint", [...ref(), p("function_slug", "path", str("The function slug from listFunctions"))], {
      tags: ["functions"],
      vendor: "GET /v1/projects/{ref}/functions/{function_slug}",
    }),
    get("/v1/projects/{ref}/storage/buckets", "listStorageBuckets", "Storage buckets: name, public or private, created", ref(), {
      tags: ["storage"],
      keywords: ["my storage buckets"],
      vendor: "GET /v1/projects/{ref}/storage/buckets",
    }),

    // ── database branches ──
    get("/v1/projects/{ref}/branches", "listBranches", "Database branches of a project: id, name, status, git branch", ref(), {
      tags: ["branches"],
      keywords: ["preview branches", "supabase branches"],
      vendor: "GET /v1/projects/{ref}/branches",
    }),
    get("/v1/branches/{branch_id_or_ref}/diff", "diffBranch", "Schema diff between a branch and its parent (what a merge would change)", [p("branch_id_or_ref", "path", str("The branch id or its project ref from listBranches"))], {
      tags: ["branches"],
      keywords: ["what would the merge change"],
      vendor: "GET /v1/branches/{branch_id_or_ref}/diff",
    }),
    post("/v1/branches/{branch_id_or_ref}/merge", "mergeBranch", "Merge a database branch's migrations into production; asks the owner", [p("branch_id_or_ref", "path", str("The branch id or its project ref"))], {
      tags: ["branches"],
      risk: "write",
      keywords: ["merge the branch"],
      vendor: "POST /v1/branches/{branch_id_or_ref}/merge",
    }),
    post("/v1/branches/{branch_id_or_ref}/reset", "resetBranch", "Reset a database branch to its migrations, discarding its data; the owner decides", [p("branch_id_or_ref", "path", str("The branch id or its project ref"))], {
      tags: ["branches"],
      risk: "destructive",
      vendor: "POST /v1/branches/{branch_id_or_ref}/reset",
    }),
  ],
  recipes: [
    {
      ask: "is my supabase project healthy",
      steps: [
        { op: "listProjects", fields: "ref,name,status,region", note: "ref is the project id for every other call" },
        { op: "getProjectHealth", params: { ref: "abcdefghijklmnopqrst", services: "auth,db,realtime,rest,storage" }, note: "each service answers healthy: true or an error" },
      ],
    },
    {
      ask: "how many users signed up this week",
      steps: [
        {
          op: "queryDatabase",
          params: { ref: "abcdefghijklmnopqrst" },
          body: { query: "select count(*) as signups from auth.users where created_at > now() - interval '7 days'" },
          note: "read-only SQL, runs freely; inspect the schema first with getDatabaseMetadata if unsure of table names",
        },
      ],
    },
    {
      ask: "any errors in my API in the last hour",
      steps: [
        {
          op: "getProjectLogs",
          params: {
            ref: "abcdefghijklmnopqrst",
            sql: "select timestamp, event_message from edge_logs where status_code >= 500 order by timestamp desc limit 20",
            iso_timestamp_start: "2026-09-30T11:00:00Z",
            iso_timestamp_end: "2026-09-30T12:00:00Z",
          },
          note: "set the window to the last hour in UTC; swap the source (postgres_logs, auth_logs) for other errors",
        },
      ],
    },
    {
      ask: "is my database secure",
      steps: [
        { op: "getSecurityAdvisors", params: { ref: "abcdefghijklmnopqrst" }, fields: "lints.name,lints.level,lints.title,lints.detail", note: "tables without row level security are the usual finding" },
        { op: "getPerformanceAdvisors", params: { ref: "abcdefghijklmnopqrst" }, fields: "lints.name,lints.level,lints.title" },
      ],
    },
    {
      ask: "what migrations have been applied and what tables exist",
      steps: [
        { op: "listMigrations", params: { ref: "abcdefghijklmnopqrst" } },
        { op: "getDatabaseMetadata", params: { ref: "abcdefghijklmnopqrst" }, note: "schemas, tables and columns" },
      ],
    },
    {
      ask: "add a notes table to my database",
      steps: [
        { op: "getDatabaseMetadata", params: { ref: "abcdefghijklmnopqrst" }, note: "check the table does not already exist" },
        {
          op: "applyMigration",
          params: { ref: "abcdefghijklmnopqrst" },
          body: { name: "add_notes_table", query: "create table public.notes (id bigint generated always as identity primary key, body text not null, created_at timestamptz not null default now()); alter table public.notes enable row level security;" },
          note: "asks the owner first; always enable row level security on new tables",
        },
      ],
    },
  ],
  searchChecks: [
    ["my supabase projects", "listProjects"],
    ["run a sql query", "queryDatabase"],
    ["apply a migration", "applyMigration"],
    ["project logs", "getProjectLogs"],
    ["is my database secure", "getSecurityAdvisors"],
    ["is my supabase up", "getProjectHealth"],
    ["my edge functions", "listFunctions"],
    ["pause the project", "pauseProject"],
  ],
});
