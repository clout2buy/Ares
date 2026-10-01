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

(Sections 2-6 follow in this file.)
