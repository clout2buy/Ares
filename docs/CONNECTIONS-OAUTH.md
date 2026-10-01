# Connections: OAuth only

The owner's rule: **every service that has an OAuth path connects through OAuth, and nothing asks for a pasted
token while a real OAuth path exists.** This document is the contract the phone app builds against (section 1),
the truth table of what OAuth each service really offers (section 3, generated from
`packages/core/src/oauthMatrix.ts`), and the one-time registrations the owner does (section 4).

## 1. Phone contract (stable; the app engineer builds against this)

All routes are owner-bearer authenticated, like every `/gateway/*` route. Bodies are JSON, capped at 8 KB.
No response, log line or error ever contains a token, a code, a client secret or a verifier.

### 1.1 `POST /gateway/connections/start`

Request `{ "service": "github", "v": 2, "mode"?: "oauth" | "browser", "returnTo"?: "ares://oauth" }`

* `v: 2` opts in to the state machine below. **A request without `v: 2` (the shipped app build) gets the old shape
  unchanged**: `{ url, flowId, kind, service, label, instructions }` where `url` is the hub page
  `https://<origin>/connect/<flow>`; that page itself walks the owner through consent, a device code, the one-time
  setup, or the experimental browser. Everything below is additive.
* `returnTo` may only be exactly `ares://oauth`. When set, the provider's redirect lands on the garrison callback
  (`https://ares.mistiqueai.com/oauth/callback`), the garrison finishes the token exchange, then answers with a
  `302 ares://oauth?service=<id>&state=connected|failed&pollId=<pollId>` so an in-app auth session
  (ASWebAuthenticationSession / expo-web-browser `openAuthSessionAsync`) closes by itself. Anything else is ignored.
* `mode: "browser"` is only meaningful for services that have an experimental browser-session path
  (Instagram, Facebook, Messenger, Threads, and the browser-only sites). It starts that path explicitly.

Response, one of (discriminate on `state`):

```jsonc
// 1. Open this URL in the in-app auth session, then poll.
{ "state": "open", "service": "linear", "label": "Linear", "url": "https://...", "pollId": "...",
  "returnTo": "ares://oauth",            // present when the request asked for it
  "intercept": { "redirectPrefix": "http://localhost:53682/oauth/callback" },   // OPTIONAL, see 1.4
  "experimental": true }                 // OPTIONAL: browser-session paths only

// 2. Device authorization (RFC 8628): show the code, open verificationUrl, poll. The garrison polls the provider.
{ "state": "device", "service": "github", "label": "GitHub", "userCode": "WDJB-MJHT",
  "verificationUrl": "https://github.com/login/device", "verificationUrlComplete": "https://github.com/login/device?user_code=WDJB-MJHT",
  "expiresInSec": 900, "intervalSec": 5, "pollId": "..." }

// 3. The owner must register an app on the vendor console once (only when Ares has no official client id for it).
{ "state": "setup", "service": "slack", "label": "Slack", "redirectUri": "https://ares.mistiqueai.com/oauth/callback",
  "scopes": ["channels:read", "..."], "consoleUrl": "https://api.slack.com/apps",
  "appType": "Create New App -> From scratch",
  "steps": [ { "title": "Create the app", "body": "..." } ],
  "fields": [ { "key": "client_id", "label": "Client ID", "secret": false, "hint": "..." },
              { "key": "client_secret", "label": "Client Secret", "secret": true, "hint": "..." } ] }
// then POST /gateway/connections/setup {service, values:{client_id, client_secret}} and call start again.

// 4. Honest fallback for services with NO OAuth at all (class e). NOT OAuth; the UI must say so.
{ "state": "fields", "service": "twilio", "label": "Twilio", "notOAuth": true,
  "reason": "Twilio has no OAuth for personal use: it only issues API keys.",
  "fields": [ { "key": "TWILIO_ACCOUNT_SID", "label": "Account SID", "secret": false, "hint": "..." } ],
  "submit": "/gateway/connections/setup" }

// 5. No API exists. Honest, no fake flow.
{ "state": "unsupported", "service": "doordash", "label": "DoorDash", "reason": "DoorDash has no consumer API ...",
  "alternative": { "mode": "browser", "label": "Experimental: sign in on a live browser", "experimental": true } }

// 6. Already connected (idempotent).
{ "state": "connected", "service": "github", "label": "GitHub" }
```

Errors keep the existing meaning: `400` no service, `404` unknown service, `503` no connect hub, `502` the hub
could not start (no public address, provider unreachable). `502` bodies carry `{error}` only.

### 1.2 `GET /gateway/connections/poll?id=<pollId>`

`200 { "state": "pending" | "connected" | "failed" | "expired", "service": "<id>", "error"?: "<short, safe text>" }`.
Poll every `intervalSec` (device) or 1.5 s (open). A flow lives 15 minutes (device flows: the provider's
`expires_in`). `404 { error }` for an unknown id. After `connected` the app should refresh `GET /gateway/connections`.

### 1.3 `POST /gateway/connections/setup`

`{ "service": "slack", "values": { "client_id": "...", "client_secret": "..." } }`

* For a `state:"setup"` service: stores the client in the encrypted vault and answers
  `{ ok: true, state: "ready", next: "start" }`; the app then calls `start` again. `{ "service": "...", "clear": true }`
  forgets a stored client.
* For a `state:"fields"` service (class e): verifies the credential against the vendor where a check exists,
  stores it, and answers `{ ok: true, state: "connected" }`. A wrong value answers `400 { ok: false, error }`.

### 1.4 `POST /gateway/connections/complete` (only for `intercept`)

Some servers only register clients with loopback redirects (Vercel's MCP allowlists `http://localhost:<port>/...`
and rejects the garrison's https redirect). For those, `start` answers `state:"open"` with
`intercept.redirectPrefix`. The provider redirects the in-app browser to that loopback address, which does not exist
on the phone: the app watches navigation, and when the URL starts with `redirectPrefix` it cancels the load and calls

`POST /gateway/connections/complete { "pollId": "...", "url": "<the full intercepted URL>" }` -> `{ state }`

The garrison validates `state` (bound to the flow, single use) and the prefix, then exchanges the code.

### 1.5 `GET /gateway/connections` (listing), additive fields

Existing fields are unchanged (`id,label,kind,domain,blurb,connected,category,account,connectedAt,lastUsedAt,health,healthDetail,scopes,capabilities,usedBy,custom`). New, all optional:

| field | meaning |
|---|---|
| `auth` | `"oauth"` (one tap) / `"oauth-setup"` (one-time app registration needed) / `"device"` / `"key"` (API key, honest fallback, not OAuth) / `"browser"` (experimental) / `"unsupported"` |
| `setupDone` | `true` when no registration is needed or it is done (an official client id is shipped, or one is in the vault) |
| `oauthClass` | `a`..`f`, `n` (see section 3) |
| `verification` | `LIVE-VERIFIED` / `FLOW-VERIFIED-AGAINST-MOCK` / `UNVERIFIED` |
| `scopes` | granted scopes when connected; otherwise the scopes Ares will ask for |
| `account` | display name or email of the connected account, when cheaply known (userinfo) |
| `health` | `ok` / `expired` / `error` from a real token check (section 5), with `healthDetail` |

`kind` keeps its old values (`mcp-oauth`, `mcp-key`, `oauth-app`, `api-key`, `browser`) so the shipped app still
renders; new behaviour is read from `auth`.

`POST /gateway/connections/test`, `disconnect`, `custom`, `custom/remove` are unchanged. `disconnect` now also
revokes the token at the vendor (RFC 7009) where the vendor offers a revocation endpoint.


## 2. Engine (what changed)

* `packages/core/src/oauthEngine.ts`: authorization code + PKCE (S256 only), `state` binding with RFC 9207 `iss` check and single-use flows, RFC 7591 registration with a typed `invalid_redirect_uri` refusal, RFC 8414 / OIDC / RFC 9728 discovery, Client ID Metadata Documents (the garrison serves `/oauth/client.json`), RFC 8628 device flow (pending / slow_down / denied / expired), refresh with rotation and **single-flight**, RFC 7009 revocation. Endpoints must be https (http only on loopback). No token, code, secret or verifier ever appears in an error, a log line or a phone response; tokens persist only in the AES-256-GCM vault.
* `oauthClients.ts`: client resolution is vault, then Ares's official client (`OFFICIAL_OAUTH_CLIENTS`, empty until the owner registers the Ares app on a vendor and the lead pastes the id), then the one-time setup. CLI: `ares connectors clients list|set <service> <client_id> [secret]|clear <service>`; the phone's `/gateway/connections/setup` writes to the same vault slot.
* `oauthMatrix.ts` / `oauthPlan.ts`: the matrix and the pure plan the hub, the routes and the consistency test share. `oauthVendorQuirks.ts`: Meta's 60-day token swap and renewal (no refresh_token grant).
* Connect flow order for a remote MCP server: registry client, else DCR on the garrison redirect, else Client ID Metadata Document, else DCR with the loopback redirect (the v2 app intercepts it), else setup. **A pasted token is never offered where an OAuth path exists.** Class e services show honest, labelled key fields.
* Why Vercel fell back to a token: `mcp.vercel.com` allowlists redirect URIs ("only supports AI clients that have been reviewed and approved"); live probe 2026-09-30: DCR accepts `http://localhost:<port>` and a few named clients, answers `invalid_redirect_uri` for `https://ares.mistiqueai.com/oauth/callback` and `ares://oauth`, and refuses the device grant to a DCR client. The old hub treated that as "paste a token". Now Ares registers with a loopback redirect and the phone app intercepts it (section 1.4). "Sign in with Vercel" REST permissions are in private beta, so the REST route is a Vercel Integration (Integrations Console), documented, not shipped.
* Why Instagram opened a remote browser: Instagram Basic Display ended 2024-12-04 and Meta offers no personal-account API. Official OAuth exists for Business/Creator accounts (Instagram Login), Facebook Pages and Threads; those are class c now (one Meta app, Development mode works for the app's own admins/testers without App Review). Personal feeds/DMs stay browser-only and are started only on request, labelled experimental.

## 3. The truth matrix

133 rows. Classes: a=38, b=10, c=24, d=5, e=34, f=4, n=18. Verification: LIVE-VERIFIED=70, FLOW-VERIFIED-AGAINST-MOCK=15, UNVERIFIED=48.
Source of truth: `packages/core/src/oauthMatrix.ts` + `oauthMatrixData.ts`; discovery documents saved under `tests/fixtures/oauth/` (`mcp/` from `node scripts/oauth-probe.mjs`, `idp/` from the audit) and parsed by `tests/oauth-matrix.test.mjs`. LIVE-VERIFIED = a document fetched and parsed on 2026-09-30; FLOW-VERIFIED-AGAINST-MOCK = the engine flow for its kind is exercised against the in-test server, vendor facts are from docs; UNVERIFIED = documentation only. Whether a vendor's DCR accepts the garrison's https redirect was deliberately NOT probed by registering clients (only Vercel, for the owner's complaint); the runtime falls back (CIMD, loopback, setup) when one refuses.

| id | class | flow | verification | registry | what the owner does once |
|---|---|---|---|---|---|
| airtable | a+c | mcp-dcr | LIVE-VERIFIED | existing | none if DCR accepts Ares redirect; else register an OAuth integration at airtable.com/create/oauth (class c; PKCE mandatory, secre |
| atlassian | a+c | mcp-dcr | LIVE-VERIFIED | existing | none if v2 DCR accepts the Ares redirect; otherwise register an OAuth 2.0 (3LO) app in developer.atlassian.com |
| calendly | a+ce | mcp-dcr | LIVE-VERIFIED | existing | none if DCR accepts the Ares redirect; fallback a Calendly OAuth app or Personal Access Token |
| canva | a+c | mcp-dcr | LIVE-VERIFIED | existing | none if DCR accepts the Ares redirect; else Canva Connect integration in the Developer Portal (class c, PKCE S256 required, Basic  |
| clickup | a+c | mcp-dcr | LIVE-VERIFIED | existing | none if DCR accepts the Ares redirect |
| close | a+ce | mcp-dcr | LIVE-VERIFIED | existing | none if DCR accepts the Ares redirect (mcp.write_destructive is a separate opt-in scope). |
| cloudflare-bindings | a | mcp-dcr | LIVE-VERIFIED | existing | none |
| cloudflare-observability | a | mcp-dcr | LIVE-VERIFIED | existing | none |
| dodo | a | mcp-dcr | LIVE-VERIFIED | existing | none |
| exa | a | mcp-dcr | LIVE-VERIFIED | existing | none |
| fireflies | a+e | mcp-dcr | LIVE-VERIFIED | existing | none if DCR accepts Ares redirect; fallback an API key from the Fireflies dashboard (class e) |
| gitlab | a+dc | mcp-dcr | LIVE-VERIFIED | existing | none if DCR accepts the https redirect (plus enable 'Allow access to the MCP server' on the group); else register a non-confidenti |
| granola | a+d | mcp-dcr | LIVE-VERIFIED | existing | none (DCR). If an https redirect is refused, the AS advertises the device grant. |
| huggingface | a+d | mcp-dcr | LIVE-VERIFIED | existing | none |
| intercom | a+c | mcp-dcr | LIVE-VERIFIED | existing | none if DCR accepts the Ares redirect; otherwise bearer API token fallback (documented). |
| jam | a | mcp-dcr | LIVE-VERIFIED | existing | none |
| linear | a+c | mcp-dcr | LIVE-VERIFIED | existing | none (if DCR accepts the https redirect) |
| mailchimp | a+c | mcp-dcr | LIVE-VERIFIED | excluded (excluded) | none if DCR accepts the Ares redirect; fallback: register an app once at the Mailchimp Registered Apps page and paste client id/se |
| mercadopago | a+d | mcp-dcr | LIVE-VERIFIED | existing | none (Mercado Pago login) |
| monday | a+c | mcp-dcr | LIVE-VERIFIED | existing | none if DCR accepts Ares redirect; else create an OAuth app in monday Developer Center (class c). |
| neon | a | mcp-dcr | LIVE-VERIFIED | existing | none |
| netlify | a | mcp-dcr | LIVE-VERIFIED | existing | none |
| notion | a+ce | mcp-dcr | LIVE-VERIFIED | existing | none (if DCR accepts Ares redirect) |
| paypal | a+c | mcp-dcr | LIVE-VERIFIED | existing | none (PayPal login + consent) |
| perplexity | a | mcp-dcr | LIVE-VERIFIED | existing | none (sign-in; API usage presumably billed to account API credits, UNVERIFIED) |
| plaid-dashboard | a | mcp-dcr | LIVE-VERIFIED | existing | none |
| printify | a | mcp-dcr | LIVE-VERIFIED | existing | none |
| prisma | a | mcp-dcr | LIVE-VERIFIED | existing | none |
| semgrep | a+d | mcp-dcr | LIVE-VERIFIED | existing | none |
| sentry | a | mcp-dcr | LIVE-VERIFIED | existing | none |
| square | a+ce | mcp-dcr | LIVE-VERIFIED | existing | none |
| stripe | a+e | mcp-dcr | LIVE-VERIFIED | existing | none (sign in to Stripe and pick the account on the consent screen) |
| supabase | a+c | mcp-dcr | LIVE-VERIFIED | existing | none |
| tavily | a | mcp-dcr | LIVE-VERIFIED | existing | none |
| todoist | a+c | mcp-dcr | LIVE-VERIFIED | existing | none (DCR / CIMD); fallback: create app in Todoist App Management console |
| webflow | a+c | mcp-dcr | LIVE-VERIFIED | existing | none if DCR accepts the Ares redirect. |
| wix | a+ce | mcp-dcr | LIVE-VERIFIED | existing | none if DCR accepts the Ares redirect (docs say 'you typically do not need to create an OAuth app'). |
| zapier | a+e | mcp-dcr | LIVE-VERIFIED | existing | none if DCR accepts the Ares redirect; user signs in to Zapier and picks the actions/apps for the MCP server. |
| asana | b+c | mcp-preregistered | LIVE-VERIFIED | existing | Create an Asana MCP app in the Asana developer console, set redirect https://ares.mistiqueai.com/oauth/callback, paste client id + |
| box | b+c | mcp-preregistered | LIVE-VERIFIED | existing | A Box admin enables 'Box MCP server' under Admin Console > Integrations, adds integration credentials with redirect https://ares.m |
| hubspot | b+ce | mcp-preregistered | LIVE-VERIFIED | existing | Create a developer account, make one 'MCP connector / MCP auth app', add Ares redirect URL, paste client id + secret. |
| instacart | b+ef | mcp-preregistered | LIVE-VERIFIED | existing | Request an Instacart Connect OAuth client (redirect https://ares.mistiqueai.com/oauth/callback), or take a Developer Platform API  |
| mongodb | b+a | mcp-preregistered | LIVE-VERIFIED | existing | Try an Ares-hosted CIMD client_id; if rejected, register an Atlas OAuth/service-account client once and paste id (+secret). |
| pagerduty | b+e | mcp-preregistered | LIVE-VERIFIED | added | Create a PagerDuty Scoped OAuth app once (Integrations > App Registration), set redirect https://ares.mistiqueai.com/oauth/callbac |
| slack | b+c | mcp-preregistered | LIVE-VERIFIED | added | Create one Slack app in the owner's own workspace, enable Agents & AI Apps > Model Context Protocol, add the Ares redirect URL and |
| uber | b+f | mcp-preregistered | LIVE-VERIFIED | existing | Unknown / likely not self-serve; stay on browser for bookings. |
| ubereats | b+f | mcp-preregistered | LIVE-VERIFIED | existing | Unknown: probably needs Uber to allowlist the Ares client; otherwise browser session. |
| vercel | b+cd | mcp-preregistered | LIVE-VERIFIED | existing | For a REST-API OAuth token today: create a Vercel Integration (Integrations Console > Create) with Redirect URL https://ares.misti |
| discord | c | code-pkce | LIVE-VERIFIED | added | Create a Discord application once and register the Ares redirect; paste client id + secret. |
| dropbox | c+b | code-pkce | LIVE-VERIFIED | existing | Create a scoped 'Full Dropbox' app in the Dropbox App Console, tick the permissions, add redirect https://ares.mistiqueai.com/oaut |
| dropbox-sign | c+e | code-secret | FLOW-VERIFIED-AGAINST-MOCK | excluded (excluded) | Create an API App in Dropbox Sign with OAuth, set callback, paste client id + secret (or use a plain API key). |
| facebook | c+df | code-secret | FLOW-VERIFIED-AGAINST-MOCK | existing | Create ONE Meta app (type Business) with Facebook Login for Business, add the Ares callback, keep it in Development mode; the owne |
| figma | c+b | code-secret | LIVE-VERIFIED | existing | Create an OAuth app at figma.com/developers/apps with redirect https://ares.mistiqueai.com/oauth/callback, paste client id + secre |
| fitbit | c | code-pkce | FLOW-VERIFIED-AGAINST-MOCK | excluded (excluded) | DO NOT BUILD: Fitbit Web API support ended 2026-09-30 and the API stops working 2026-10-30; use the Google Health API under the go |
| google | c+bd | code-secret | LIVE-VERIFIED | existing | Keep the existing Web client; move the OAuth consent screen from 'Testing' to 'In production' (no verification submitted) so refre |
| google-photos | c | code-secret | FLOW-VERIFIED-AGAINST-MOCK | scope | Enable 'Photos Library API' and 'Google Photos Picker API' in the same Cloud project and request the photos scopes on the existing |
| instagram | c+f | code-secret | FLOW-VERIFIED-AGAINST-MOCK | existing | Create ONE Meta app with the Instagram use case, set Business Login redirect URI to the Ares tunnel callback, add the owner's Inst |
| linkedin | c+f | code-secret | LIVE-VERIFIED | added | Create a LinkedIn developer app (requires associating a LinkedIn Company Page), add the 'Sign In with LinkedIn using OpenID Connec |
| messenger | c+f | code-secret | FLOW-VERIFIED-AGAINST-MOCK | scope | Same Meta app as facebook; add the Messenger product, subscribe the app to the Page, and use the owner's Facebook Page. |
| quickbooks | c+e | code-secret | LIVE-VERIFIED | excluded (excluded) | Create an Intuit developer app, add the redirect URI, paste client id+secret; production keys needed for the real company. |
| reddit | c+f | code-secret | FLOW-VERIFIED-AGAINST-MOCK | added | Since 2025-11-11 new Reddit API apps need Reddit's manual approval (Responsible Builder Policy, ~2-4 weeks, may be denied); an exi |
| salesforce | c+d | code-pkce | LIVE-VERIFIED | added | In their Salesforce org, create one External Client App (OAuth scopes api/refresh_token/mcp_api, PKCE on, device flow enabled), pa |
| shopify-store | c+ea | code-secret | FLOW-VERIFIED-AGAINST-MOCK | excluded (excluded) | Create an app in the Shopify Dev Dashboard, set scopes, install on own store, paste client id+secret (or a legacy shpat_ token). |
| spotify | c | code-pkce | LIVE-VERIFIED | existing | Create one Spotify app in the dashboard, add redirect https://ares.mistiqueai.com/oauth/callback, tick Web API, paste client id; o |
| strava | c | code-secret | FLOW-VERIFIED-AGAINST-MOCK | added | Create one API application at strava.com/settings/api with callback domain ares.mistiqueai.com and paste client id + secret. |
| threads | c | code-secret | FLOW-VERIFIED-AGAINST-MOCK | existing | Create ONE Meta app using the 'Access the Threads API' use case, add the Ares redirect, add the owner's Threads profile as Threads |
| trello | c+e | code-pkce | FLOW-VERIFIED-AGAINST-MOCK | excluded (excluded) | Create an OAuth 2.0 app in the Atlassian developer console (Trello API), add redirect https://ares.mistiqueai.com/oauth/callback,  |
| typeform | c+a | code-pkce | LIVE-VERIFIED | added | Register an app at admin.typeform.com (Developer apps), set redirect URI, paste client id/secret. (AS advertises DCR + 'none' auth |
| withings | c | code-secret | FLOW-VERIFIED-AGAINST-MOCK | existing | Create one Public Health Data API application in the Withings developer dashboard with callback https://ares.mistiqueai.com/oauth/ |
| x | c | code-pkce | FLOW-VERIFIED-AGAINST-MOCK | added | Create a project/app at the X developer console, choose a public (native) client type, set callback https://ares.mistiqueai.com/oa |
| xero | c+e | code-pkce | LIVE-VERIFIED | added | Create a Xero app of type Auth Code with PKCE, add the redirect, paste the client id (no secret). |
| zoom | c+db | code-pkce | LIVE-VERIFIED | added | Create a General (user-managed) OAuth app in the Zoom App Marketplace, add redirect https://ares.mistiqueai.com/oauth/callback and |
| github | d+c | device | LIVE-VERIFIED | existing | Register ONE GitHub OAuth App once, tick 'Enable Device Flow', paste the client_id into Ares (no secret needed); every later phone |
| onedrive | d+c | device | FLOW-VERIFIED-AGAINST-MOCK | scope | None beyond outlook: same Entra app; just include Files.ReadWrite (add Files.ReadWrite.All only for SharePoint/shared files). |
| outlook | d+c | device | LIVE-VERIFIED | existing | Register ONE Entra app (free, any Microsoft account can create it) as multi-tenant+personal with 'Allow public client flows' = Yes |
| twitch | d+c | device | LIVE-VERIFIED | added | Register one app on dev.twitch.tv with Client Type = Public, any redirect (http://localhost), paste client id; no secret. |
| youtube | d+c | device | FLOW-VERIFIED-AGAINST-MOCK | scope | Recommended: none beyond google -- add the youtube scope to the existing Google Web client consent (incremental), enable 'YouTube  |
| api-coingecko | e | api-key | UNVERIFIED | existing | Optional demo key (works keyless at low rate limits). |
| api-home-assistant | e+c | api-key | UNVERIFIED | existing | None beyond giving Ares the HA base URL and logging in to HA in the phone browser. |
| api-nasa-apod | e | api-key | UNVERIFIED | existing | Free key from api.nasa.gov (DEMO_KEY works with tight limits). |
| brave-search | e | api-key | UNVERIFIED | existing | Create a free API key at brave.com/search/api and paste it. |
| caldav | e+c | api-key | UNVERIFIED | existing | Server URL + username + app password. |
| carddav | e | api-key | UNVERIFIED | existing | Server URL + username + app password. |
| discord-bot | e | api-key | UNVERIFIED | existing | Create application + bot in Developer Portal, copy bot token, use the invite URL (OAuth2 URL generator, scope=bot) to add it to th |
| duffel | e | api-key | UNVERIFIED | existing | Create an access token in the Duffel dashboard (test or live) and paste it. |
| firecrawl | e | api-key | UNVERIFIED | existing | Optional: paste API key from firecrawl.dev; the MCP also runs KEYLESS with usage limits. |
| flightaware | e | api-key | UNVERIFIED | existing | Create an AeroAPI key (personal tier) and paste it. |
| gemini | e+c | api-key | LIVE-VERIFIED | existing | Reuse the Google OAuth client (Cloud Console) and add the scope; owner must be a test user on the consent screen. |
| gitlab-token | e+ad | api-key | UNVERIFIED | existing | Superseded by the OAuth sibling entry; keep only as manual fallback. |
| google-places | e+c | api-key | UNVERIFIED | existing | Create a Maps Platform API key (billing enabled) and paste it. |
| home-assistant | e+c | api-key | UNVERIFIED | existing | None beyond giving Ares the HA base URL and logging in to HA in the phone browser. |
| hue | e+c | api-key | UNVERIFIED | existing | Local path: press the bridge link button when Ares pairs (Rook must be on the same LAN). Remote OAuth path: register a Remote Hue  |
| icloud | e | api-key | LIVE-VERIFIED | existing | Generate an app-specific password at account.apple.com and paste it with the Apple ID. |
| imap | e+cd | api-key | UNVERIFIED | existing | Host + user + app password (Fastmail, iCloud, generic); for Gmail/Outlook use the provider OAuth class instead. |
| mongodb-uri | e | api-key | UNVERIFIED | existing | Superseded by the OAuth sibling entry; keep only as manual fallback. |
| mqtt | e | api-key | UNVERIFIED | existing | Broker URL + user/password. |
| notion-token | e+ac | api-key | UNVERIFIED | existing | Superseded by the hosted 'notion' OAuth entry; token path is only a fallback. |
| openai | e | api-key | LIVE-VERIFIED | existing | Paste an OpenAI API key (billing account). |
| plaid | e | api-key | UNVERIFIED | existing | Sign up for Plaid, paste client_id + secret; link each bank through Plaid Hosted Link on the phone (bank-side OAuth happens inside |
| render | e+b | api-key | LIVE-VERIFIED | existing | Obtain a Render OAuth client_id (no documented self-service console - UNVERIFIED); until then use the API key. |
| resend | e+a | api-key | LIVE-VERIFIED | existing | None if DCR accepts the Ares https callback; owner just signs in to Resend and picks the team. |
| sentry-token | e+a | api-key | UNVERIFIED | existing | Superseded by the OAuth sibling entry; keep only as manual fallback. |
| shopify-dev | e | none | UNVERIFIED | existing | none |
| simplefin | e | api-key | UNVERIFIED | existing | Create a SimpleFIN Bridge account (paid), generate a Setup Token, paste it once; Ares claims it to get the access URL. |
| slack-bot | e+c | api-key | LIVE-VERIFIED | existing | Same Slack app as 'slack' (or a second one): add bot scopes + redirect URL, then Ares runs the install flow and stores the xoxb to |
| stripe-key | e | api-key | UNVERIFIED | existing | Dashboard > Developers > API keys > create a restricted read-only key and paste it. |
| supabase-token | e+a | api-key | UNVERIFIED | existing | Superseded by the OAuth sibling entry; keep only as manual fallback. |
| tailscale | e | api-key | LIVE-VERIFIED | existing | Create a scoped OAuth client (client_credentials) or API access token in the admin console and paste it. |
| tessie | e+c | api-key | LIVE-VERIFIED | existing | Generate an access token in Tessie developer settings and paste it (no OAuth for third parties exists). |
| ticketmaster | e | api-key | UNVERIFIED | existing | Create a free key at developer.ticketmaster.com and paste it. |
| twilio | e+c | api-key | UNVERIFIED | existing | Create an OAuth app in the Twilio Console (client id/secret) -- or just keep Account SID + Auth Token/API key. |
| amazon | f+c | browser | UNVERIFIED | existing | none |
| doordash | f+b | browser | UNVERIFIED | existing | Join the DoorDash MCP waitlist and request an OAuth client with redirect https://ares.mistiqueai.com/oauth/callback; else stay on  |
| opentable | f | browser | UNVERIFIED | existing | none |
| peloton | f | browser | UNVERIFIED | existing | none |
| arxiv | n | none | UNVERIFIED | existing | none |
| docker | n | none | UNVERIFIED | existing | none |
| duckduckgo | n | none | UNVERIFIED | existing | none |
| fetch | n | none | UNVERIFIED | existing | none |
| filesystem | n | none | UNVERIFIED | existing | none |
| git | n | none | UNVERIFIED | existing | none |
| invideo | n | none | UNVERIFIED | existing | none (the SSE endpoint is open; generation is gated in the browser via links the tool returns) |
| kubernetes | n | none | UNVERIFIED | existing | none |
| memory | n | none | UNVERIFIED | existing | none |
| obsidian | n | none | UNVERIFIED | existing | none |
| open-meteo | n | none | UNVERIFIED | existing | none |
| playwright | n | none | UNVERIFIED | existing | none |
| postgres | n | none | UNVERIFIED | existing | none |
| sequential-thinking | n | none | UNVERIFIED | existing | none |
| sqlite | n | none | UNVERIFIED | existing | none |
| time | n | none | UNVERIFIED | existing | none |
| wikipedia | n | none | UNVERIFIED | existing | none |
| youtube-transcript | n | none | UNVERIFIED | existing | none |

### Exclusions (documented, not wired)

* **mailchimp**: Mailchimp's remote MCP lives under a /claude/ path that suggests client allowlisting, and the classic OAuth needs a per-datacenter API host; not wired until confirmed.
* **dropbox-sign**: Dropbox Sign OAuth rests on documentation only (no discovery document, no MCP); nothing could be exercised.
* **fitbit**: Fitbit Web API support ended 2026-09-30 and the API stops working 2026-10-30; the successor (Google Health API) is not documented well enough to wire yet.
* **quickbooks**: QuickBooks needs the per-company realmId captured from the redirect and Intuit's production-key review before it can reach a real company.
* **shopify-store**: Shopify OAuth is per store ({shop}.myshopify.com) and needs a Dev Dashboard app per store; not shippable generically in this pass.
* **trello**: Trello's new OAuth 2.0 goes through an Atlassian developer-console app and its scopes could not be verified; the legacy API-key flow is being deprecated.
* **home-assistant**: IndieAuth login exists but needs the owner's instance and is unverified; the token path stays, labelled.
* **Discord**: user OAuth only identifies the owner and lists servers; messages need a bot token (class e).

## 4. One-time registrations (priority order)

Where Ares has no official client id for a vendor, the app shows a setup screen with exactly this. Fill `OFFICIAL_OAUTH_CLIENTS` (oauthClients.ts) afterwards and it becomes one tap for everyone. Redirect URI for every web-flow app: `https://ares.mistiqueai.com/oauth/callback`.

1. **GitHub** (`github`, class d+c)
   * Console: https://github.com/settings/developers
   * App type: OAuth App (scope-based, non-expiring token). Alternative: GitHub App with Device Flow enabled (permission-based, expiring tokens; whether refresh needs the client secret is not stated in the docs read
   * Callback / device flow: Enable Device Flow
   * Scopes: `repo read:org read:user user:email notifications read:project gist`
   * Paste into Ares: client_id
   * Gate: None for personal use. Orgs with OAuth App access restrictions must approve the app before org data is visible.
2. **Google** (`google`, class c+bd)
   * Console: https://console.cloud.google.com/auth/overview
   * App type: OAuth client type 'Web application' (full scopes). 'TVs and Limited Input devices' only if device flow is wanted and then ONLY for the 7 allowed scopes.
   * Callback / device flow: Web-application client: exact-match registered redirect URIs, https allowed (Ares tunnel redirect already registered by owner). Device flow needs no redirect. Google MCP servers use whatever redirect 
   * Scopes: `openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/forms.body https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/contacts`
   * Paste into Ares: client_id + client_secret
   * Gate: Sensitive scopes (calendar, drive.*, documents, spreadsheets, presentations, tasks, contacts, forms) and restricted scopes (gmail.modify/readonly/send are restricted via mail.google.com family, full drive) require Google verification for public apps; unverifie
3. **Slack** (`slack`, class b+c)
   * Console: https://api.slack.com/apps
   * App type: Create New App > From scratch (workspace-owned, NOT distributed/unlisted)
   * Callback / device flow: Slack app 'Redirect URLs' list, exact-match. Docs say redirect_uri must be https for the normal install flow; Anthropic's own Slack MCP plugin registers http://localhost:3118/oauth/callback so loopbac
   * Scopes: `search:read.public search:read.private search:read.im search:read.mpim search:read.users channels:history groups:history im:history mpim:history channels:read users:read chat:write reactions:write canvases:read`
   * Paste into Ares: client_id + client_secret
   * Gate: Slack docs: 'Only directory-published apps or internal apps may use MCP; unlisted apps are prohibited.' A workspace-internal (non-distributed) app should qualify; this is doc-only and NOT verified live. Marketplace review is only needed to serve other workspac
4. **Notion** (`notion`, class a+ce)
   * Console: n/a (dynamic registration)
   * App type: none needed: the server registers Ares itself
   * Callback / device flow: UNVERIFIED (DCR probe is lead's)
   * Scopes: `default`
   * Paste into Ares: nothing (optional: only if the vendor refuses automatic registration)
   * Gate: none (if DCR accepts Ares redirect)
5. **Spotify** (`spotify`, class c)
   * Console: https://developer.spotify.com/dashboard
   * App type: App with 'Web API' (and optionally Web Playback SDK) selected
   * Callback / device flow: Doc (fetched): HTTPS required unless loopback; loopback must be literal IP http://127.0.0.1:PORT or http://[::1]:PORT; 'localhost' is prohibited; all existing apps had to comply by Nov 2025. The Ares 
   * Scopes: `user-read-private user-read-email user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-modify-private playlist-modify-public user-library-read user-library-modify user-top-read user-read-recently-played`
   * Paste into Ares: client_id
   * Gate: None for one owner: Development mode = owner must have Premium, max 5 authenticated allowlisted users, lower quota. Extended Quota Mode is closed to individuals since May 2025 (org with 250k MAU) -- irrelevant.
6. **Microsoft** (`outlook`, class d+c)
   * Console: https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade
   * App type: App registration, Supported account types 'Accounts in any organizational directory and personal Microsoft accounts' (signInAudience AzureADandPersonalMicrosoftAccount)
   * Callback / device flow: Authentication > Advanced settings > Allow public client flows = Yes
   * Scopes: `offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite Tasks.ReadWrite`
   * Paste into Ares: client_id
   * Gate: None for personal accounts (user self-consents). Work/school tenants: user consent may be blocked by tenant policy -> admin consent needed; the listed delegated scopes are user-consentable by default (Graph reference confirms only Calendars.ReadWrite delegated
7. **Linear** (`linear`, class a+c)
   * Console: n/a (dynamic registration)
   * App type: none needed: the server registers Ares itself
   * Callback / device flow: UNVERIFIED: DCR acceptance of the Ares https redirect is for the lead's probe
   * Scopes: `read write`
   * Paste into Ares: nothing (optional: only if the vendor refuses automatic registration)
   * Gate: none (if DCR accepts the https redirect)
8. **Atlassian** (`atlassian`, class a+c)
   * Console: n/a (dynamic registration)
   * App type: none needed: the server registers Ares itself
   * Callback / device flow: UNVERIFIED: DCR redirect acceptance for lead's probe; Atlassian docs do not state an allowlist
   * Scopes: `offline_access read:me read:jira:agent-interface write:jira:agent-interface search:jira:agent-interface read:confluence:agent-interface write:confluence:agent-interface search:confluence:agent-interface`
   * Paste into Ares: nothing (optional: only if the vendor refuses automatic registration)
   * Gate: none if v2 DCR accepts the Ares redirect; otherwise register an OAuth 2.0 (3LO) app in developer.atlassian.com
9. **Vercel** (`vercel`, class b+cd)
   * Console: https://vercel.com/dashboard/integrations/console
   * App type: Integration (connectable account / external), NOT native marketplace product
   * Callback / device flow: MCP DCR: allowlist only (lead's finding; Ares https rejected). Integration OAuth: single Redirect URL configured in the console; localhost allowed for dev.
   * Scopes: `openid offline_access`
   * Paste into Ares: client_id + client_secret
   * Gate: Docs: submitted integrations get a Community badge and are installable via the slug URL / deploy button without marketplace listing (listing needs 500 installs + review). The doc says 'once your integration is approved'; whether approval is instant or manual f
10. **Meta** (`instagram`, class c+f)
   * Console: https://developers.facebook.com/apps/
   * App type: Meta app (Business type, 'Instagram' use case / product 'Instagram API with Instagram Login'); console labels are UNVERIFIED, Meta redesigns them often
   * Callback / device flow: Exact match to 'OAuth redirect URIs' registered in App Dashboard (docs warn dashboard may append a trailing slash). Examples are https; Ares tunnel is https so OK. Authorize page is instagram.com logi
   * Scopes: `instagram_business_basic instagram_business_manage_messages instagram_business_manage_comments instagram_business_content_publish`
   * Paste into Ares: client_id + client_secret
   * Gate: None while the app stays in Development mode and the only authorizing account has a role on the app: Standard Access (default) works for app admins/developers/testers without App Review (Meta app-roles doc: roles 'can grant the app any permission while it is i

Note: Notion, Linear and Atlassian are class a (their MCP servers register Ares themselves, live-verified discovery), so registering an official Ares client is optional insurance in case a server later allowlists redirects like Vercel did. Google also needs its consent screen moved from Testing to In production, or the connection dies every 7 days.

## 5. Health

`POST /gateway/connections/test` and the list's `health`: oauth-app services read the vendor's userinfo with a transparently refreshed token (a refresh the vendor rejects as invalid_grant marks the grant `needsReauth`, shown as `expired`); MCP services probe tools/list with the stored bearer and read the same `needsReauth` flag. `account` is recorded at connect time from the vendor's identity endpoint and refreshed by each test.

## 6. The Api-tool presets (batch 3)

The presets (packages/tools/src/openapi/presets) follow this registry. Each one names the registry id the owner connects (`oauth.connect`: strava, zoom, x, discord, salesforce, linear, github, ...) and the Api service id the model calls (`x-twitter` for the connect id `x`, `meta-graph` for `facebook`, `microsoft-graph` for `outlook`). The token comes from this engine at call time: the vault slot `oauth/<provider>` through `getValidAccessToken` (refreshed transparently) for oauth-app services, the MCP bundle `mcp.token.<connect id>` for remote-MCP sign-ins. Services with no registry OAuth (Trello, Cloudflare, Shopify, Mailchimp) connect through their own `api-<id>` secure form. Salesforce reads its API host from the token response (`instance_url`); Discord bot operations use the `discord-bot` connector's token as `Authorization: Bot`. Fitbit is not a preset (its Web API shuts down 2026-10-30).
