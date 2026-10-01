# Provider logins from the phone (contract)

All routes sit behind the owner bearer, like every `/gateway/*` route. Bodies are JSON, capped at 8 KB.
No response, log line or audit row ever contains a token, an authorization code, or a callback URL query.

The box (Rook, headless Linux) cannot open a browser, and the phone cannot reach the box's `localhost`.
So the phone opens the provider's authorize URL in an in-app auth session. When the provider redirects to
the loopback address, the phone does not follow it: it intercepts that redirect URL and posts it back, and
the SERVER replays it against the loopback listener the login is waiting on. This is the same
`intercept` / `complete` shape as the Vercel connection (`docs/CONNECTIONS-OAUTH.md`).

## GET /gateway/providers

```
{ providers: [{
    id: string,                      // "claude-code" | "codex" | "kimi-cli" | "ares-anthropic" | "ares-openai" | "ares-kimi"
    label: string,
    kind: "coding-agent" | "model",  // CLIs the box drives vs Ares's own provider logins
    state: "signed_in" | "signed_out" | "expired" | "unknown" | "login_in_progress",
    account?: string,                // an email or plan label, never a token
    expiresAt?: number,              // epoch ms, when known
    method: "loopback" | "device" | "paste" | "key",   // the best way this provider can be signed in
    note?: string                    // e.g. "claude is not installed on this machine"
}] }
```

`unknown` = the CLI is not installed or its state cannot be read. `expired` = a credential exists but is dead
and cannot be refreshed.

## POST /gateway/providers/login  `{ id, v: 2, method? }`

`method` is optional: `"device"` (where the CLI has a device flow, today `codex`) or `"paste"` (force the
manual flow). Answers, by `state`:

| state | body | what the phone does |
|---|---|---|
| `open` | `{ state, id, url, pollId, intercept: { redirectPrefix } }` | open `url` in an in-app auth session (ASWebAuthenticationSession-style). When the navigation is about to go to a URL starting with `redirectPrefix`, cancel it and `POST /complete { pollId, callbackUrl }`. |
| `device` | `{ state, id, userCode, verificationUrl, verificationUrlComplete?, expiresInSec, intervalSec, pollId }` | show the code, open the URL, poll `/poll` every `intervalSec`. |
| `paste` | `{ state, id, url, pollId, hint }` | LAST RESORT. Open `url`; the provider shows a code; the user types it into an in-app field; `POST /complete { pollId, code }`. Label this "manual". |
| `signed_in` | `{ state, id }` | already signed in (the login was not started). |
| `unsupported` | `{ state, id, reason }` | show `reason`. |

Errors: `409 { error, state: "login_in_progress", pollId }` when a login for that provider is already running
(one at a time per provider; the existing `pollId` is returned so the phone can resume polling), `404` unknown
provider, `400` bad body, `502 { error }` when the login could not be started (scrubbed).

## POST /gateway/providers/complete  `{ pollId, callbackUrl? | code? }`

Exactly one of the two. Single use per flow. Answers `{ state: "signed_in" | "pending" | "failed", error? }`
(`pending` = replayed, still finishing: keep polling).

`callbackUrl` must be `http://localhost:<port><path>?...` (or `127.0.0.1` / `[::1]`) where `<port>` and `<path>`
are EXACTLY those the broker parsed from the CLI's own redirect_uri. The server never uses a client-supplied host:
it connects to `127.0.0.1:<its own port>` only (no SSRF). Anything else is `400`.
`code` is only accepted by `paste` flows and is written to the CLI's stdin (never logged).

## GET /gateway/providers/poll?id=<pollId>

`{ state: "pending" | "signed_in" | "failed" | "expired", error? }`. `404` for an unknown id.

## POST /gateway/providers/cancel  `{ pollId }` and POST /gateway/providers/logout  `{ id }`

Cancel kills the child / closes the listener. Logout signs the provider out (CLI `auth logout` or deleting Ares's
own credential file) and answers `{ ok, state }`.

## Rules

Flows expire after 10 minutes (child killed, state `expired`). The CLI runs under a pty (`script -qfc`) with a
scrubbed environment (HOME, PATH, LANG, USER, TERM only) and `BROWSER` / `xdg-open` pointing at a shim that
records the authorize URL instead of opening anything. Every login, completion and logout is audited
(`providers.login`, `providers.complete`, `providers.logout`).

(Per-provider support and the real-CLI findings are appended below.)
