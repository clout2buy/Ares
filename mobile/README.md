# Moved

The Ares iPhone app (**AgentAres**) now lives in its own repository so any
agent can pick it up and ship a change without carrying the monorepo:

    ~/ares-app          (on doingbox)

Its history came with it via `git subtree split`. Start at `ares-app/AGENTS.md`.

- JS/UI change → `./ota.sh "what changed"` — reaches installed phones in
  seconds, over the air.
- Native change (dependency, `app.json`, icon) → `./build.sh` — TestFlight.
- `./doctor.sh` says which of the two your change needs.

The garrison side of the phone surface is still here: the gateway proxy and
the phone API (`/gateway/file`, `/gateway/shot`, `/gateway/stt`,
`/gateway/tts`) live in `packages/cli/src/remoteAgentServer.ts`, wired up in
`packages/cli/src/entry/garrisonCmd.ts`.
