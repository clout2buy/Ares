# Working on Ares, on the box it actually runs on

**Read [`ARES.md`](ARES.md) next** — it holds the architecture map and the
build/verify rules. This file is the part that only matters because you are
on Crix's live server.

## This machine is production

`doingbox` runs Crix's Ares 24/7 as `ares-garrison.service`. It is his
Telegram assistant and the backend for his iPhone app. People are using it
while you edit it.

- **Code changes do nothing until you build and restart.** The service runs
  compiled output: `pnpm build` then
  `sudo systemctl restart ares-garrison.service`. Editing a `.ts` file and
  declaring victory is a non-change.
- **A restart kills in-flight turns.** Telegram and the phone app both drop
  whatever they were doing. Restart deliberately, not reflexively, and say so.
- **Never declare done on a red suite.** `pnpm verify` (build + all tests)
  must be 100% green. One new failure is yours until proven otherwise.
- **After restarting, check it actually came up:**
  ```bash
  systemctl is-active ares-garrison.service
  journalctl -u ares-garrison.service --since "1 minute ago" --no-pager | tail -20
  ```
  You want `bridge online` and no errors. If it crash-loops, the fastest
  recovery is `git stash` + rebuild + restart, then diagnose from the stash.

## Do not touch

- **`~/.ares/`** — live state and secrets: the garrison token, `credentials.json`
  (API keys), `ui.json` (Telegram bot token), the Apple signing key under
  `asc/`, session rollouts. Read `CAPABILITIES.md` there if you need to know
  what Ares can already do; change nothing.
- **`~/.ares/ui.json` specifically** — the running garrison rewrites it. Editing
  it while the service is up silently wipes the Telegram config.

## The iPhone app is not in this repo

It lives in **`~/ares-app`** (its own git repo, with its own `AGENTS.md`).
`mobile/` here is a tombstone README. Shipping app changes is `./ota.sh` there
— nothing in this repo builds or deploys the app.

## Ground truth over assumption

This codebase is mostly working systems with real history. Before changing
behaviour, read the surrounding code and comments — many of them record a
specific incident and exist to stop it happening again. When something is
broken, find the cause in logs and session rollouts
(`~/.ares/garrison/sessions/*.jsonl`) rather than guessing; the answer is
usually in there.
