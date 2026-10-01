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


`POST /complete` waits up to 20 s for the CLI to finish before answering, so the usual answer is already
`signed_in`; `pending` means keep polling. A finished flow answers its verdict again and is never replayed.
`login` on a provider that is already `signed_in` answers `signed_in` unless the body has `force: true`.

## What each provider supports

| id | kind | A loopback | B device | C paste | verified how |
|---|---|---|---|---|---|
| `claude-code` | coding-agent | yes (default) | no | yes (`method:"paste"`, also the automatic fallback) | REAL `claude` 2.1.280 on Rook, run to the URL under a throwaway HOME, through the broker; completion proven with a mock only |
| `codex` | coding-agent | yes (default) | yes (`method:"device"` runs `codex login --device-auth`) | no | NOT installed on Rook: mock only; behaviour is from the CLI's documented flow |
| `kimi-cli` | coding-agent | no | yes (parse a `XXXX-XXXX` code + URL from the output) | no | NOT installed on Rook: generic parser, unverified; reported `unknown` while the binary is absent |
| `ares-anthropic` | model | yes: `runAnthropicLoginFlow`, listener `127.0.0.1:53692/callback` | no | no | in-process; token exchange mocked; file `~/.ares/anthropic-oauth.json` read back by `loadAnthropicTokens` / `resolveAnthropicAccessToken` |
| `ares-openai` | model | yes: `runOpenAILoginFlow`, listener `127.0.0.1:1455/auth/callback` | no (the issuer's device endpoint sits behind a bot challenge, see openaiAuth.ts) | no | in-process; exchange mocked; file `~/.ares/auth.json` |
| `ares-kimi` | model | no | yes: `runKimiLoginFlow` device flow | no | in-process; endpoints mocked; file `~/.ares/kimi-auth.json` |

Not covered: GitHub Copilot (Ares has no Copilot login) and `gh` (its login prompts interactively before it prints a code).
Ares's two loopback listeners (53692 Anthropic, 1455 OpenAI/Codex) are fixed ports: the CLI `codex login` also uses 1455, so
`codex` and `ares-openai` cannot be signed in at the same moment (the second fails honestly with "port in use").

## Real CLI findings (Rook, 2026-10-01)

`claude auth login` (Claude Code 2.1.280, native binary, `~/.local/bin/claude`), run with `HOME=<throwaway>`, `BROWSER`
and `xdg-open` on PATH pointing at the recording shim, stdin/stdout on a pty (`script -qefc`), no terminal:

* It "opens the browser" by executing `$BROWSER <url>` (also `xdg-open`). The shim received
  `https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-...&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A<PORT>%2Fcallback&scope=...&code_challenge=...&code_challenge_method=S256&state=...`
  and `ss -ltnp` showed `claude` listening on `127.0.0.1:<PORT>` (a RANDOM port per run, e.g. 40799), path `/callback`. This is mechanism A.
* On stdout it prints `Opening browser to sign in...`, `If the browser didn't open, visit: <URL>` (an OSC-8 hyperlink, so
  the escapes must be stripped) where THAT URL carries `redirect_uri=https://platform.claude.com/oauth/code/callback`
  (the manual flow), then the prompt `Paste code here if prompted > `. This is mechanism C, available simultaneously.
* `claude auth status --json` answers `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty",...}` in a clean HOME;
  that is what the listing uses. The credential is `~/.claude/.credentials.json`. `claude auth logout` signs out.
* Headless Linux does NOT stop it from using loopback: no DISPLAY is needed because the browser is the phone.
* Killing the pty child frees the port (verified); no process is left behind after a cancel.

`gh auth login --web` was probed too and is NOT wired: it asks interactive questions (git protocol) before printing its one-time code.

`codex` and `kimi` are not installed on Rook, so their output is unverified. Codex's documented login prints a loopback
URL (`http://localhost:1455/auth/callback` redirect) and, with `--device-auth`, a URL plus code; the broker handles both
generically (URL from the shim or stdout, code matched by `[A-Z0-9]{3,5}-[A-Z0-9]{3,5}`). If the real output differs the flow
fails with a scrubbed message after 20 s rather than hanging.

## Agents asking for a provider sign-in (`Connect {service: "provider:<id>"}`)

An agent never prints an OAuth link or asks for a code. `Connect` with `service: "provider:claude-code"` (also `codex`,
`kimi-cli`, `ares-anthropic`, `ares-openai`, `ares-kimi`) reads the provider's state from this broker first:

* `signed_in`: answers at once with the account, no card.
* `unknown` (CLI not installed): a plain failure the agent relays; no card.
* otherwise: emits ONE `tool_progress` card `{ kind: "connect_request", flowId, service: "provider:<id>", label, mode: "provider",
  providerId, method, reason?, expired?, instructions }` (no `url`) and returns AT ONCE. The app answers the card with its own
  Providers flow for that id (`useProviderLogin`: auth session / device code / paste only when `method` says so).
* The garrison watches the provider (the broker's sign-in event plus a 5 s state poll, 10 minute cap) and, when it reads
  `signed_in`, wakes the asking session once with a short note (`sessions.send`, queued) and emits `connect_result`.

Code: `packages/core/src/providerSignIn.ts` (host interface), `packages/tools/src/connectProvider.ts`,
`packages/cli/src/providerSignInHost.ts`, wiring in `garrisonCmd.ts`.
