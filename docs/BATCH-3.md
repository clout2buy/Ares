# Batch 3: what shipped, how to run it, what to register

Batch 3 is `release/batch-2b` plus eight slices, merged on `release/batch-3`:

| slice | branch | what it is |
|---|---|---|
| memory + goals | `feat5/memory-goals` | the phone's Memory screen (read / correct / forget) and a Goals runner that works assigned goals on a schedule; `session.send` is idempotent on the client's message id |
| briefings + location | `feat5/briefings-location` | morning/evening briefing cards; "when I arrive at / leave a place" rules |
| notify | `feat5/notify-live` | approve from the lock screen, Live Activity pushes, widget nudges |
| inbox + shortcuts | `feat5/inbox-shortcuts` | the Share-sheet inbox; the owner's iPhone Shortcuts as skills and proposed Shortcuts |
| watch + voice | `feat5/watch-voice` | the agent handoff timeline (`/gateway/timeline`) |
| OAuth core | `feat6/oauth-core` | one OAuth engine for every connection, the truth matrix, phone contract v2 (`docs/CONNECTIONS-OAUTH.md`) |
| presets | `feat6/presets` + `presets-a..f` | the Api tool's connected-account presets (35 services) on a shared kit |

Every route below is owner-bearer authenticated like the rest of `/gateway/*`, bodies are size-capped, no response or log ever carries a
token, and every action that changes something lands in the audit trail. Nothing here weakens the remote-autonomy gate: whatever a route
starts is an ordinary owner turn through `SessionManager`, so the owner pause, the kill switch and permission prompts still apply.

## 1. Routes and contracts

Authoritative shapes are in the header comment of each handler file; this is the map.

### Goals and memory (`packages/cli/src/phoneGoals.ts`, `phoneMemory.ts`, `goalRunner.ts`, `entry/goalsMemoryWiring.ts`)

* `GET /gateway/goals` `{goals, agents, canRun}`; `POST /gateway/goals` (create, `clientId` makes it idempotent);
  `POST /gateway/goals/update | status | close | note | delete | checkin`; `GET /gateway/goals/notes?id=&limit=&before=`.
  `checkin` answers 202 `{started}`, 409 `{reason}` (no agent / not active / paused / already running), 501 when this box cannot run goals.
* `GET /gateway/memory?q=&kind=&limit=&offset=`, `GET /gateway/memory/item?id=`, `POST /gateway/memory/edit {id, content}`,
  `POST /gateway/memory/forget {id}`. Owner pool only (never `guest:*`), secret-shaped text redacted before it leaves the box
  (`redacted: true`), edits and forgets go through Mnemosyne's single writer (409 if another process holds the memory lock).
* The `goals` scheduler hook wakes the assigned agent on each due goal (every 5 minutes by default, `goalsCheckEveryMs`).
* `session.send` accepts a client message id and is idempotent (a retried send is not a second turn).

### Briefings and location (`phoneBriefings.ts`, `phoneLocation.ts`, `entry/briefingWiring.ts`)

* `GET /gateway/briefings[?limit=]`, `GET /gateway/briefings/<id>`, `POST /gateway/briefings/run {kind: morning|evening}` (202),
  `GET|POST /gateway/briefings/settings`. Facts are read by the garrison (weather, calendar, mail, reminders, goals, agent activity,
  waiting approvals); a source that is not connected is reported missing, never invented. Cards live in `<home>/briefings/`.
* `phoneAsk` answers "what's my briefing" from today's card with no model call (`ask.briefing`).
* `GET /gateway/location`, `GET|POST /gateway/location/places`, `DELETE /gateway/location/places/<id>[?cascade=1]`,
  `GET|POST /gateway/location/rules`, `DELETE /gateway/location/rules/<id>`, `POST /gateway/location/event {placeId, transition, at?}`,
  `GET /gateway/location/recent`. A rule fires an owner turn on its agent's thread; per-rule dedupe, an hourly cap, stale events
  (queued arrivals from yesterday) never fire, the owner pause skips every rule. iOS monitors at most 20 regions, so only places used
  by enabled rules count.
* The `briefing` scheduler hook ticks every minute; the attempt latches in `<home>/briefings/state.json` so a restart never repeats one.

### Notifications, approvals, Live Activity (`phoneApprovals.ts`, `phoneLiveActivity.ts`, `phonePush.ts`)

* `GET /gateway/approvals`; `POST /gateway/approvals/respond {id | (sessionId, requestId) | approvalId, decision: allow_once|deny, via?}`
  answers `applied`, `already_resolved`, `needs_app` (403: money, credentials, mail, publishing, irreversible shell and any per-call owner
  decision can only be Denied or opened from a banner, never allowed; enforced server side), `not_found`.
* `POST /gateway/liveactivity/register | unregister`, `GET /gateway/liveactivity` (no tokens in the answer). The garrison drives the
  activity over APNs from its own turn lifecycle (start after 8 s, progress updates rate-limited, "needs approval" immediately, end with a
  one-line result). Dead tokens are dropped, a 429 backs off for a minute.
* APNs categories used on pushes: `ARES_APPROVAL` (quick), `ARES_APPROVAL_STRICT`, `ARES_TEXT_REPLY`, `ARES_DEVICE_WAKE`.

### Inbox and Shortcuts (`phoneInbox.ts`, `phoneShortcuts.ts`, `tools/shortcutBuilder.ts`, `tools/deviceShortcuts.ts`)

* `POST /gateway/inbox` (multipart or JSON; links, text, files; 25 MB / 10 items; file type comes from the bytes, the path from an index and
  slug, never from the client; executables refused; everything the share says is fenced `<untrusted_input>`), `GET /gateway/inbox[/<id>]`,
  `POST /gateway/inbox/<id>/retry`, `DELETE /gateway/inbox/<id>[?force=1]`. The view echoes `clientId`. Stored under `<home>/inbox/<id>/`.
* `GET|POST /gateway/shortcuts`, `GET|POST /gateway/shortcuts/history`, `GET /gateway/shortcuts/proposals`,
  `GET /gateway/shortcuts/proposals/<id>/file` (an UNSIGNED `.shortcut`, iOS may refuse it), `DELETE /gateway/shortcuts/proposals/<id>`.
  Sensitivity is opt-out: only `sensitive: false` makes a Shortcut routine. Running a Shortcut stays an iPhone capability behind the gate.

### Timeline (`phoneTimeline.ts`)

* `GET /gateway/timeline?since=<rev>&limit=&agent=&status=&wait=<ms>&epoch=` `{epoch, cursor, now, reset?, events[], agents[]}`. A revision
  cursor plus an optional long poll (at most 25 s); a different `epoch` means start over. Folds Task / fleet / coding-backend / family
  handoffs from live owner sessions and rollout tails; guest sessions are never read.

### Connections v2 (OAuth core; full contract in `docs/CONNECTIONS-OAUTH.md` section 1)

* `POST /gateway/connections/start {service, v: 2, mode?, returnTo?}` answers one of `open | device | setup | fields | unsupported | connected`
  (a request without `v: 2` gets the old shape); `GET /gateway/connections/poll?id=`; `POST /gateway/connections/setup`;
  `POST /gateway/connections/complete` (loopback-intercept flows); `GET /gateway/connections` gains `auth, setupDone, oauthClass, verification,
  scopes, account, health`; `test`, `disconnect` (now revokes at the vendor, RFC 7009), `custom` unchanged.
* The engine (`packages/core/src/oauthEngine.ts` ...): PKCE S256, state binding + RFC 9207 `iss`, single-use flows, RFC 7591 DCR, RFC 8414 /
  9728 discovery, CIMD (`/oauth/client.json`), RFC 8628 device grant, refresh rotation single-flight, revocation. CLI:
  `ares connectors clients list|set <service> <client_id> [secret]|clear <service>`. The truth matrix is `oauthMatrix.ts` + `oauthMatrixData.ts`.

### Api presets (connected accounts)

35 services: vercel, github, google (Gmail, Calendar, Drive, Docs, Sheets, Tasks, YouTube, People), microsoft-graph, slack, notion, linear,
atlassian, spotify, dropbox, figma, asana, todoist, trello, stripe, shopify, cloudflare, supabase, sentry, pagerduty, strava, zoom, reddit,
twitch, meta-graph, airtable, hubspot, calendly, mailchimp, discord, linkedin, typeform, x-twitter, xero, salesforce. (Fitbit is not a preset:
its Web API shuts down 2026-10-30. The single-letter id `x` is rejected by `validateApiId`; the service is `x-twitter`, connect id `x`.)

How a call gets its token (`packages/tools/src/openapi/connectedToken.ts`), first hit wins:
`setConnectedTokenProvider` override, then `API_<ID>_KEY` (vault or env), then `oauth.credentials`, then the OAuth grant in `oauth/<provider>`
through `getValidAccessToken` (refreshed), then the remote-MCP bundle the hub stored for the registry id. The provider id is the preset's own
or the one the registry/matrix names for `oauth.connect`.

* Registry-connected (OAuth): the `oauth.connect` of every preset is a real Connect id AND an `oauthMatrix` row (`tests/presets-oauth-wiring.test.mjs`).
* Form-connected (own `api-<id>` card): shopify, mailchimp, trello (API key + token), cloudflare (scoped API token).
* Salesforce: `oauth.baseUrlFromToken: "instance_url"`: the API host is the instance URL Salesforce returned with the token, accepted only
  on `*.salesforce.com`, `*.force.com`, `*.salesforce-setup.com`, `*.salesforce.mil` over https. `API_SALESFORCE_BASEURL` overrides it.
* Discord: operations tagged `bot` send `Authorization: Bot <token>` using the token of the `discord-bot` connector
  (`mcp.stdio.discord-bot.token`, or `DISCORD_BOT_TOKEN`); user operations keep the OAuth bearer.
* Meta Graph connects through `facebook` (Facebook Login for Pages; Instagram via the linked Page). A connection made only through
  Instagram Login (`instagram`) is not used by this preset.

## 2. Environment knobs and kill switches

| variable | effect |
|---|---|
| `ARES_BRIEFINGS=0` | no briefing is generated (scheduled or manual) |
| `ARES_LOCATION_RULES=0` | every location rule is skipped (events are still recorded as skipped) |
| `ARES_BRIEFING_TIMEOUT_MS` | cap for the briefing turn (default 8 minutes) |
| `ARES_OWNER_TIMEZONE` | IANA zone for briefing times; else the box's zone (the owner can also set it in briefing settings) |
| `ARES_OWNER_LOCATION` | the owner's place for the weather source of a briefing |
| `API_<ID>_KEY`, `API_<ID>_BASEURL`, `API_<ID>_CLIENT_ID` | headless credentials for any preset (vault wins, env is the fallback) |
| `DISCORD_BOT_TOKEN` | headless bot token for the Discord preset's bot operations |
| `ARES_PRESETS_PARTIAL` | removed: the suite now requires the whole roster |

Owner control plane (kill switch / pause / jobs): the pause stops goals, briefings, location rules, inbox turns and notification-driven work.
The new scheduler jobs are named `goals` (Goal check-ins) and `briefing` (Morning and evening briefings); both can be held and run from the
jobs list like `heartbeat`, `dream`, `gauntlet`.

## 3. The owner's one-time registrations

Where Ares has no official client id for a vendor the app shows a setup screen with exactly this; afterwards fill `OFFICIAL_OAUTH_CLIENTS`
(`oauthClients.ts`) and it becomes one tap for everyone. Redirect URI for every web-flow app: `https://ares.mistiqueai.com/oauth/callback`.
Full per-vendor detail (scopes, gates) is `docs/CONNECTIONS-OAUTH.md` section 4; `ares connectors clients set <service> <client_id> [secret]`
(or the phone's setup screen) stores them in the vault.

1. GitHub: OAuth App, tick Enable Device Flow, paste client_id (https://github.com/settings/developers).
2. Google: Web application client; move the consent screen from Testing to In production or the grant dies every 7 days; paste client_id + secret.
3. Slack: one app in the owner's own workspace (not distributed), enable the MCP feature, add the redirect; paste client_id + secret.
4. Notion, Linear, Atlassian: nothing (the MCP servers register Ares themselves; registering a client is optional insurance).
5. Spotify: app with Web API, redirect (loopback literal IP rules apply); paste client_id.
6. Microsoft (`outlook`): Entra app, any account type incl. personal, Allow public client flows = Yes; paste client_id.
7. Vercel: Integration in the Integrations Console (MCP DCR allowlists redirects); paste client_id + secret.
8. Meta (`instagram`, `facebook`, `threads`): one Meta app in Development mode, redirect added, owner added as a tester; paste client_id + secret.
9. Class c apps needed for the REST presets that have no MCP sign-in: Strava (callback domain `ares.mistiqueai.com`), Zoom (General user-managed
   app), Reddit (new apps need Reddit's manual approval), X (public client), Typeform, LinkedIn (needs a Company Page), Xero (Auth Code with PKCE, no
   secret), Salesforce (External Client App with `api refresh_token`, PKCE on), Discord (application; bot token separately via `discord-bot`),
   Twitch (public client), Figma, Dropbox, Asana, Airtable, HubSpot, PagerDuty.
10. Token-only (no OAuth for third parties; labelled as keys in the app): Trello (key + token), Cloudflare (scoped API token), Shopify (Admin API
    token + store address), Mailchimp (API key + server prefix), Stripe (restricted key).

## 4. Deployment notes

* No `package.json` or lockfile changes versus `release/batch-2b`: `pnpm install --frozen-lockfile` is a no-op, no new dependency. (The connect
  hub's Instagram browser now resolves `playwright` through `@ares/connectors`.)
* `pnpm build`, then restart the garrison once: the new hooks (goals, memory, briefings, location, notify, inbox, shortcuts, timeline, connections v2)
  are wired at boot, and the two scheduler jobs only start with the process.
* Create nothing by hand: `<home>/briefings/`, `<home>/location/`, `<home>/inbox/` are created on first use (0700).
* APNs: Live Activity and approval pushes need the existing push configuration (`pushConfigured`); without it those routes answer honestly and nothing is sent.
* iOS app: the notification categories, Live Activity widget and Share extension need the TestFlight rebuild batched by the app side; the server
  routes degrade gracefully without them.
* Before relying on a remote-MCP token as a REST bearer (Linear, Notion, Atlassian, Supabase, Airtable, Calendly ...), try one call per service:
  the engine sends the vendor-issued token to that vendor's own REST host only, but whether the vendor accepts an MCP-issued token on its REST API
  is vendor behaviour (unverified here). The headless override `API_<ID>_KEY` always works.
