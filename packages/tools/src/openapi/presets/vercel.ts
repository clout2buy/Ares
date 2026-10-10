// Vercel REST API - the exemplar preset: read the projects, deployments, logs,
// domains and env-var NAMES of the owner's account; redeploy / rollback / change a
// domain only after the owner says yes.
//
// Curated from the vendor's OpenAPI document https://openapi.vercel.sh/ (fetched
// 2026-09-30: OpenAPI 3.0.3, 442 operations); every path, method and parameter name
// below was checked against it (scripts/api-preset-verify.mjs). Docs:
// https://vercel.com/docs/rest-api (authentication: https://vercel.com/docs/rest-api#authentication).
//
// Deliberately left out: anything that returns a secret in plain text (env vars are
// never requested with decrypt=true), buying or transferring a domain (money), and
// deleting a project or a deployment's files.

import { JSON_BODY, bool, csv, definePreset, del, get, int, num, obj, p, patch, post, str, type JsonObject } from "./_kit.js";

const team = (): JsonObject[] => [
  p("teamId", "query", str("The team id (team_...) when the project belongs to a team; from listTeams")),
  p("slug", "query", str("The team slug, instead of teamId")),
];

const SINCE_UNTIL = (what: string) => [
  p("since", "query", num(`Only ${what} created after this time (epoch milliseconds)`)),
  p("until", "query", num(`Only ${what} created before this time (epoch milliseconds); the cursor for the next page`)),
];

export default definePreset({
  id: "vercel",
  label: "Vercel",
  blurb: "Your Vercel projects, deployments, build and runtime logs, domains and env var names. Reads run freely; redeploy, rollback and domain changes ask.",
  connect: "vercel",
  oauth: { mcp: "vercel", scopes: ["a Vercel access token for the account (and team) that owns the project"] },
  baseUrl: "https://api.vercel.com",
  verifyOperationId: "getUser",
  ratePerMin: 60,
  keywords: ["vercel", "deploy", "deployment", "next.js hosting", "build log"],
  domain: "vercel.com",
  source: {
    kind: "vendor-openapi",
    specUrl: "https://openapi.vercel.sh/",
    docsUrl: "https://vercel.com/docs/rest-api",
    fetchedOn: "2026-09-30",
  },
  notes: {
    rateLimits: "Per-endpoint limits, commonly 100+ requests a minute, answered with HTTP 429 and X-RateLimit-* headers; the Api tool waits out a short Retry-After and retries.",
    pagination: "Lists answer {pagination:{count,next,prev}}; `next` is a millisecond timestamp passed back as `until` (domains, deployments) or `from` (projects). Pass pages to follow it.",
    auth: "Authorization: Bearer <Vercel access token>. A team's projects need teamId (or slug) on every call - listTeams gives it.",
    scopes: "The token must belong to a user who can see the project.",
    gotchas: [
      "Env var values come back encrypted (or hidden); only names, targets and types are useful - pass fields \"key,target,type,id\".",
      "Rolling back = pointing production at an earlier READY production deployment (requestRollback).",
    ],
  },
  ops: [
    get("/v2/user", "getUser", "The signed-in Vercel user: id, username, email, default team", [], { tags: ["user"], keywords: ["who am i", "my vercel account"], vendor: "GET /v2/user" }),
    get("/v2/teams", "listTeams", "Teams the user belongs to (their ids go in teamId)", [p("limit", "query", num("Maximum number of teams")), ...SINCE_UNTIL("teams")], {
      tags: ["teams"],
      keywords: ["my teams", "which team"],
      paginate: { style: "token", param: "until", next: "pagination.next", items: "teams", limitParam: "limit" },
      vendor: "GET /v2/teams",
    }),
    get(
      "/v10/projects",
      "listProjects",
      "The account's projects: name, id, framework, latest deployments, production domains",
      [
        p("search", "query", str("Only projects whose name contains this")),
        p("repo", "query", str("Only projects connected to this repo (owner/name)")),
        p("from", "query", str("Continuation token: the previous page's pagination.next")),
        p("limit", "query", str("How many projects (default 20)")),
        ...team(),
      ],
      {
        tags: ["projects"],
        keywords: ["my projects", "my sites", "list projects"],
        paginate: { style: "token", param: "from", next: "pagination.next", items: "projects", limitParam: "limit" },
        vendor: "GET /v10/projects",
      },
    ),
    get("/v9/projects/{idOrName}", "getProject", "One project: framework, build settings, link to git, latest deployments, targets", [p("idOrName", "path", str("Project id (prj_...) or name")), ...team()], {
      tags: ["projects"],
      vendor: "GET /v9/projects/{idOrName}",
    }),
    get(
      "/v7/deployments",
      "listDeployments",
      "Deployments, newest first: state, url, target (production/preview), creator, git commit",
      [
        p("projectId", "query", str("Only this project (id or name)")),
        p("target", "query", str("Only this environment, e.g. production or preview")),
        p("state", "query", str("Only this state: BUILDING, ERROR, INITIALIZING, QUEUED, READY or CANCELED (comma-separated for several)")),
        p("branch", "query", str("Only deployments of this git branch")),
        p("sha", "query", str("Only deployments of this commit")),
        p("users", "query", str("Only deployments created by these user ids (comma-separated)")),
        p("rollbackCandidate", "query", bool("Only deployments that production could roll back to")),
        p("limit", "query", num("How many (default 20)")),
        ...SINCE_UNTIL("deployments"),
        ...team(),
      ],
      {
        tags: ["deployments"],
        keywords: ["what did I deploy", "deployed today", "recent deployments", "latest deploy", "failed deploys", "is my site up"],
        paginate: { style: "token", param: "until", next: "pagination.next", items: "deployments", limitParam: "limit" },
        vendor: "GET /v7/deployments",
      },
    ),
    get("/v13/deployments/{idOrUrl}", "getDeployment", "One deployment by id or hostname: state, error, build output, aliases, git source", [
      p("idOrUrl", "path", str("Deployment id (dpl_...) or its hostname")),
      p("withGitRepoInfo", "query", str("true to include the commit sha, branch and repo")),
      ...team(),
    ], { tags: ["deployments"], keywords: ["why did the build fail", "deployment status"], vendor: "GET /v13/deployments/{idOrUrl}" }),
    get(
      "/v3/deployments/{idOrUrl}/events",
      "getBuildLogs",
      "Build logs of a deployment: one event per line of output (use direction backward and a limit for the tail)",
      [
        p("idOrUrl", "path", str("Deployment id (dpl_...) or hostname")),
        p("direction", "query", str("Order by time", { enum: ["backward", "forward"], default: "forward" })),
        p("limit", "query", num("How many events (-1 for all; keep it small, e.g. 200)")),
        p("follow", "query", int("1 would stream live events; leave it 0", { enum: [0, 1] })),
        p("since", "query", num("Only events after this time (epoch ms)")),
        p("until", "query", num("Only events before this time (epoch ms)")),
        p("statusCode", "query", str("Only events with this HTTP status or range")),
        ...team(),
      ],
      { tags: ["logs"], keywords: ["build logs", "build output", "why did it fail", "deployment logs"], vendor: "GET /v3/deployments/{idOrUrl}/events" },
    ),
    get("/v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs", "getRuntimeLogs", "Runtime (function) logs of a deployment", [
      p("projectId", "path", str("Project id (prj_...)")),
      p("deploymentId", "path", str("Deployment id (dpl_...)")),
      ...team(),
    ], { tags: ["logs"], keywords: ["runtime logs", "function logs", "errors in production"], vendor: "GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs" }),
    get("/v2/deployments/{id}/aliases", "listDeploymentAliases", "The URLs (aliases) a deployment is reachable at", [p("id", "path", str("Deployment id (dpl_...)")), ...team()], {
      tags: ["deployments"],
      vendor: "GET /v2/deployments/{id}/aliases",
    }),
    get("/v5/domains", "listDomains", "Domains registered or added on the account", [p("limit", "query", num("How many domains")), ...SINCE_UNTIL("domains"), ...team()], {
      tags: ["domains"],
      keywords: ["my domains"],
      paginate: { style: "token", param: "until", next: "pagination.next", items: "domains", limitParam: "limit" },
      vendor: "GET /v5/domains",
    }),
    get("/v5/domains/{domain}", "getDomain", "One domain: registrar, nameservers, expiry, verification", [p("domain", "path", str("The domain name, e.g. example.com")), ...team()], {
      tags: ["domains"],
      vendor: "GET /v5/domains/{domain}",
    }),
    get("/v6/domains/{domain}/config", "getDomainConfig", "Is a domain configured correctly for Vercel? Misconfiguration, recommended records, nameservers", [
      p("domain", "path", str("The domain name")),
      p("projectIdOrName", "query", str("The project it is (to be) attached to")),
      ...team(),
    ], { tags: ["domains"], keywords: ["domain not working", "dns config"], vendor: "GET /v6/domains/{domain}/config" }),
    get("/v5/domains/{domain}/records", "listDnsRecords", "DNS records Vercel hosts for a domain", [
      p("domain", "path", str("The domain name")),
      p("limit", "query", str("How many records")),
      ...SINCE_UNTIL("records"),
      ...team(),
    ], { tags: ["dns"], vendor: "GET /v5/domains/{domain}/records" }),
    get("/v9/projects/{idOrName}/domains", "listProjectDomains", "Domains attached to one project, with verification and redirect", [
      p("idOrName", "path", str("Project id or name")),
      p("production", "query", str("true: only production domains", { enum: ["true", "false"] })),
      p("verified", "query", str("true/false: only verified or unverified", { enum: ["true", "false"] })),
      p("limit", "query", num("How many (max 100)")),
      ...SINCE_UNTIL("domains"),
      ...team(),
    ], {
      tags: ["domains", "projects"],
      keywords: ["domains of a project", "project domains"],
      paginate: { style: "token", param: "until", next: "pagination.next", items: "domains", limitParam: "limit" },
      vendor: "GET /v9/projects/{idOrName}/domains",
    }),
    get("/v10/projects/{idOrName}/env", "listEnvVars", "A project's environment variables: names, targets, types (values are encrypted - never decrypted here)", [
      p("idOrName", "path", str("Project id or name")),
      p("gitBranch", "query", str("Only variables for this branch (preview target)")),
      ...team(),
    ], { tags: ["env"], keywords: ["env vars", "environment variables", "which env vars are set"], vendor: "GET /v10/projects/{idOrName}/env" }),

    // ── changes: every one asks ──
    post(
      "/v13/deployments",
      "createDeployment",
      "Redeploy an existing deployment (pass deploymentId) or start a new one for a project; asks the owner",
      [
        p("forceNew", "query", str("1 forces a new deployment even if an identical one exists", { enum: ["0", "1"] })),
        ...team(),
      ],
      {
        tags: ["deployments"],
        risk: "write",
        keywords: ["redeploy", "deploy again", "trigger a deploy"],
        vendor: "POST /v13/deployments",
        body: JSON_BODY(
          obj(
            "Redeploy: {name, deploymentId, target}",
            {
              name: str("The project name"),
              project: str("The project id, when different from name"),
              deploymentId: str("The id of the deployment to redeploy (keeps its settings and env vars)"),
              target: str("production, preview or a custom environment", { enum: ["production", "preview", "staging"] }),
              withLatestCommit: bool("Redeploy with the branch's latest commit instead of the original one"),
              meta: obj("Free-form key/value metadata"),
            },
            ["name"],
          ),
        ),
      },
    ),
    post("/v1/projects/{projectId}/rollback/{deploymentId}", "rollbackProduction", "Point production at an earlier production deployment (rollback); asks the owner", [
      p("projectId", "path", str("Project id (prj_...)")),
      p("deploymentId", "path", str("The deployment to roll back TO (an earlier READY production one)")),
      p("description", "query", str("Why (shown on the rollback)")),
      ...team(),
    ], { tags: ["projects"], risk: "write", keywords: ["roll back", "rollback", "revert production"], vendor: "POST /v1/projects/{projectId}/rollback/{deploymentId}" }),
    post("/v10/projects/{projectId}/promote/{deploymentId}", "promoteDeployment", "Point production at a given deployment (promote a preview to production); asks the owner", [
      p("projectId", "path", str("Project id (prj_...)")),
      p("deploymentId", "path", str("The deployment to promote")),
      ...team(),
    ], { tags: ["projects"], risk: "write", keywords: ["promote to production"], vendor: "POST /v10/projects/{projectId}/promote/{deploymentId}" }),
    patch("/v12/deployments/{id}/cancel", "cancelDeployment", "Cancel a deployment that is building; the owner decides", [p("id", "path", str("Deployment id (dpl_...)")), ...team()], {
      tags: ["deployments"],
      risk: "destructive",
      keywords: ["stop the build", "cancel build"],
      vendor: "PATCH /v12/deployments/{id}/cancel",
    }),
    post("/v10/projects/{idOrName}/domains", "addProjectDomain", "Attach a domain to a project (optionally as a redirect); asks the owner", [p("idOrName", "path", str("Project id or name")), ...team()], {
      tags: ["domains"],
      risk: "write",
      keywords: ["add a domain", "attach domain"],
      vendor: "POST /v10/projects/{idOrName}/domains",
      body: JSON_BODY(
        obj(
          "The domain to add",
          { name: str("The domain, e.g. www.example.com"), gitBranch: str("Serve this git branch (preview domains)"), redirect: str("Redirect to this domain instead of serving"), redirectStatusCode: int("301, 302, 307 or 308", { enum: [301, 302, 307, 308] }) },
          ["name"],
        ),
      ),
    }),
    post("/v9/projects/{idOrName}/domains/{domain}/verify", "verifyProjectDomain", "Ask Vercel to re-check a project domain's DNS; asks the owner", [
      p("idOrName", "path", str("Project id or name")),
      p("domain", "path", str("The domain")),
      ...team(),
    ], { tags: ["domains"], risk: "write", vendor: "POST /v9/projects/{idOrName}/domains/{domain}/verify" }),
    del("/v9/projects/{idOrName}/domains/{domain}", "removeProjectDomain", "Detach a domain from a project; the owner decides", [
      p("idOrName", "path", str("Project id or name")),
      p("domain", "path", str("The domain")),
      ...team(),
    ], { tags: ["domains"], keywords: ["remove a domain"], vendor: "DELETE /v9/projects/{idOrName}/domains/{domain}" }),
    post("/v10/projects/{idOrName}/env", "createEnvVar", "Add an environment variable to a project; asks the owner (the value is a secret: only send what the owner gave)", [
      p("idOrName", "path", str("Project id or name")),
      p("upsert", "query", str("true replaces an existing variable of the same name")),
      ...team(),
    ], {
      tags: ["env"],
      risk: "write",
      keywords: ["set an env var", "add environment variable"],
      vendor: "POST /v10/projects/{idOrName}/env",
      body: JSON_BODY(
        obj(
          "The variable",
          {
            key: str("Name, e.g. API_URL"),
            value: str("Value"),
            type: str("encrypted, plain or sensitive (sensitive can never be read back)", { enum: ["encrypted", "plain", "sensitive"] }),
            target: csv("production, preview and/or development"),
            gitBranch: str("Preview only: one branch"),
            comment: str("A note"),
          },
          ["key", "value", "type"],
        ),
      ),
    }),
    patch("/v9/projects/{idOrName}/env/{id}", "editEnvVar", "Change an environment variable; asks the owner", [
      p("idOrName", "path", str("Project id or name")),
      p("id", "path", str("The variable's id (from listEnvVars)")),
      ...team(),
    ], {
      tags: ["env"],
      risk: "write",
      vendor: "PATCH /v9/projects/{idOrName}/env/{id}",
      body: JSON_BODY(obj("Fields to change", { key: str("Name"), value: str("Value"), type: str("encrypted, plain or sensitive", { enum: ["encrypted", "plain", "sensitive"] }), target: csv("production, preview, development"), comment: str("A note") })),
    }),
    del("/v9/projects/{idOrName}/env/{id}", "removeEnvVar", "Delete an environment variable; the owner decides", [
      p("idOrName", "path", str("Project id or name")),
      p("id", "path", str("The variable's id (from listEnvVars)")),
      ...team(),
    ], { tags: ["env"], vendor: "DELETE /v9/projects/{idOrName}/env/{id}" }),
  ],
  recipes: [
    {
      ask: "what did I deploy today",
      steps: [
        {
          op: "listDeployments",
          params: { limit: 20, since: 1788048000000 },
          fields: "uid,name,url,state,target,created,creator.username,meta.githubCommitMessage",
          note: "since = epoch milliseconds of local midnight today; add projectId to narrow to one project",
        },
      ],
    },
    {
      ask: "why did the last build of my-app fail",
      steps: [
        { op: "listDeployments", params: { projectId: "my-app", state: "ERROR", limit: 1 }, fields: "uid,url,created,meta.githubCommitMessage", note: "the newest failed deployment" },
        { op: "getBuildLogs", params: { idOrUrl: "dpl_example", direction: "backward", limit: 200 }, note: "the tail of its build output holds the error" },
      ],
    },
    {
      ask: "which domains does my-app have, and are they set up right",
      steps: [
        { op: "listProjectDomains", params: { idOrName: "my-app" }, fields: "name,verified,redirect" },
        { op: "getDomainConfig", params: { domain: "example.com", projectIdOrName: "my-app" }, note: "misconfigured: true means the DNS records are wrong" },
      ],
    },
    {
      ask: "which env vars does my-app have (names only)",
      steps: [{ op: "listEnvVars", params: { idOrName: "my-app" }, fields: "key,target,type,id", note: "values are encrypted; never ask for them" }],
    },
    {
      ask: "redeploy my-app's current production deployment",
      steps: [
        { op: "listDeployments", params: { projectId: "my-app", target: "production", state: "READY", limit: 1 }, fields: "uid,url,created" },
        { op: "createDeployment", body: { name: "my-app", deploymentId: "dpl_example", target: "production" }, note: "asks the owner first" },
      ],
    },
    {
      ask: "roll production back to the previous deployment",
      steps: [
        { op: "listDeployments", params: { projectId: "my-app", target: "production", rollbackCandidate: true, limit: 5 }, fields: "uid,url,created,meta.githubCommitMessage" },
        { op: "rollbackProduction", params: { projectId: "prj_example", deploymentId: "dpl_example" }, note: "asks the owner first; pick the deployment BEFORE the bad one" },
      ],
    },
  ],
  searchChecks: [
    ["what did I deploy today", "listDeployments"],
    ["build logs", "getBuildLogs"],
    ["which env vars are set", "listEnvVars"],
    ["redeploy", "createDeployment"],
    ["roll back production", "rollbackProduction"],
    ["domains of a project", "listProjectDomains"],
    ["my teams", "listTeams"],
  ],
});

