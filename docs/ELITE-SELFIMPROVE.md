# Ares improves itself, and the owner stays in control

Goal: Ares on the box (doingbox / "Rook") can find its own problems, fix them in a throwaway copy of
its own source, prove the fix, and ask the owner's phone "Deploy?" - 24/7, without the owner's PC.
Nothing reaches the live system without (1) a green, signed full-suite result, (2) the owner's explicit
yes, and (3) a deploy that smoke-tests itself and rolls itself back.

```
 telemetry ──> Maintainer ──> auto/<date>-<slug> worktree ──> coding task ──> ares-verify
 (crashes,     (nightly,       (never ~/Ares)                  (unattended     (build, lint, FULL suite,
  audit, bug    budgeted)                                       policy gate)    secrets, risk) = SIGNED result
  reports…)                                                                          │ green only
                                                                                     v
 phone: "Maintainer proposes: <title>. Deploy?" <── proposal JSON <───────────────────
        │ owner approves (card or REST)
        v
 signed approval receipt ──> ares-deploy: lock, idle/drain, ff ~/Ares, install, build, restart,
                              READY, smoke ──fail──> automatic rollback ──> record + phone push
```

## Invariants (do not weaken)

- **The live tree is never edited.** Self-edits happen in worktrees under `~/forge/work`. `~/Ares`
  changes only through `ares-deploy` (a fast-forward to a verified sha).
- **No deploy without a signed GREEN result** for exactly that commit and tree (`ares-verify`).
- **No deploy without the owner.** The Maintainer only *proposes*. A deploy needs a signed approval
  receipt that the Maintainer writes only after the owner's decision (approval card, or
  `POST /gateway/maintainer/proposals/<id>/approve`), or an operator flag (`--yes`) typed by a human.
- **Policy, owner pause/kill switch, tokens, approvals, secrets are HIGH-RISK files.** A diff touching
  them (or dependencies, or deleting/weakening tests, or the guardrails themselves) is labelled
  HIGH RISK on the card and needs an explicit acknowledgement on top of the approval.
- **Secrets never appear** in records, results, notifications, logs or chat. Credentials come from a
  deploy key or the encrypted vault; the scripts never print or ask for them.
- The owner's **pause** stops the Maintainer from starting; the **kill switch** (`stopAll`) aborts its
  run between steps. `ARES_MAINTAINER=0` disables it entirely.

## 1. The forge: `~/forge`

```
~/forge/ares      bare repo. remote "rook" = the private GitHub repo (refs/remotes/rook/*);
                  refs/live/head = the commit ~/Ares runs; refs/heads/auto/* = self-edits (ours alone)
~/forge/work/     throwaway worktrees, one per self-edit, removed when done
~/forge/tmp/      TMPDIR for verify runs (a stray /tmp/package.json fails the workspace-freedom test)
~/forge/bin/      ares-verify, ares-deploy (symlinks into the checkout that ran bootstrap)
```

Set up once (idempotent; `--dry-run` prints the plan and changes nothing):

```sh
bash scripts/elite/bootstrap-forge.sh --dry-run init
bash scripts/elite/bootstrap-forge.sh init            # remote = what ~/Ares already uses as "rook"
bash scripts/elite/bootstrap-forge.sh status          # what is set up; never prints a secret
bash scripts/elite/bootstrap-forge.sh sync            # fetch rook + record the live commit
bash scripts/elite/bootstrap-forge.sh new-worktree flaky-test   # -> ~/forge/work/auto-2026-10-01-flaky-test
bash scripts/elite/bootstrap-forge.sh rm-worktree <path>        # refuses anything outside ~/forge/work
bash scripts/elite/bootstrap-forge.sh clean --days 2
```

Options: `--forge DIR` (or `ARES_FORGE_DIR`), `--remote URL` (or `ARES_FORGE_REMOTE`), `--live DIR`
(or `ARES_LIVE_DIR`, default `~/Ares`), `--offline`, `--dry-run`. The forge refuses to live inside the
live tree. A remote URL with a password/token embedded is refused.

### Credentials (pushing `auto/*` branches back to GitHub is optional; fetching a private repo needs one)

Pick one. The scripts never print, log or request a secret, and nothing goes through chat.

1. **Deploy key (preferred).** Create a key on the box with `ssh-keygen -t ed25519 -f ~/.ssh/ares-forge`
   (no passphrase, 0600), add the `.pub` as a *deploy key* on `clout2buy/ares-rook` (write access only
   if you want to push `auto/*` branches), then `ARES_FORGE_SSH_KEY=~/.ssh/ares-forge bash
   scripts/elite/bootstrap-forge.sh init`. Only the key's *path* is stored (`core.sshCommand`).
2. **Fine-grained PAT in the Ares vault.** Token limited to the one repository, "Contents: read and
   write". Store it once, out of chat:
   `printf %s "$TOKEN" | node scripts/elite/forge-credential.mjs store`
   (encrypted AES-256-GCM in `~/.ares/credentials.json` as `FORGE_GITHUB_TOKEN`). Bootstrap wires git's
   credential helper to read it back from the vault for `https://github.com` only. `forge-credential.mjs
   status` says `present`/`missing`; `forget` removes it.

Nothing here pushes to GitHub by itself: auto branches reach the live box via the local forge. After a deploy, push the deployed `auto/*` branch to `rook`
yourself (or merge it) so the PC's repo catches up; until then a later PC-side deploy of an unrelated
branch will refuse as "not a fast-forward" and you must rebase it on the deployed commit.

## 2. `ares-verify`

```sh
node scripts/elite/ares-verify.mjs --sha <sha|ref> [--branch auto/..] [--base <sha>]
     [--repo ~/forge/ares] [--live-dir ~/Ares] [--keep] [--json]
# exit 0 green, 1 red, 2 setup/usage error
```

In a throwaway worktree of exactly that sha, with `TMPDIR` under `~/forge/tmp`, it runs, in order:
diff analysis (vs `--base`, default the live checkout's HEAD), secret scan of the *added* lines,
`pnpm install --frozen-lockfile --prefer-offline`, `pnpm build`, `pnpm lint` (tsc), and the full suite
`node --import ./tests/_isolate-home.mjs --test --test-concurrency=4 tests/*.test.mjs`. A step that
fails skips the later build steps but is recorded. The worktree and TMPDIR are always removed.
Overridable per step for tests: `--install-cmd --build-cmd --lint-cmd --test-cmd`.
The suite and the code under test never see `ARES_HOME` or the signing key.

Result: `<ARES_HOME>/elite/results/<sha>.json` (always written, red or green):

```json
{ "version": 1,
  "payload": { "schema": 1, "sha": "...", "tree": "...", "branch": "auto/..", "base": "...", "baseKnown": true,
               "host": "...", "verifiedAt": "ISO", "green": true,
               "steps": [{"name":"build","ok":true,"ms":41000,"detail":""}],
               "tests": {"total":3567,"pass":3539,"fail":0,"skipped":28,"failedNames":[]},
               "risk": {"class":"low|medium|high","reasons":[],"protectedFiles":[],"dependencyFiles":[],
                        "deletedTests":[],"weakenedTests":[],"hotspots":[],"requiresOwnerApproval":false},
               "diff": {"files":3,"added":40,"deleted":2,"files":["M path"]}, "secrets":[{"file":"","line":0,"rule":""}] },
  "sig": "hmac-sha256:<hex>" }
```

### Signing, and how deploy verifies it

`sig` = HMAC-SHA256 over the **canonical JSON** (keys sorted recursively) of `payload`. The key is
`ARES_VERIFY_KEY` (hex; the vault can inject it) or `<ARES_HOME>/elite/verify.key`, generated on first
use with mode 0600. `ares-deploy` recomputes the HMAC with constant-time comparison and refuses when:
no result file exists; the signature is invalid (any edit - flipping `green`, lowering `risk`, changing
test counts - breaks it); the result is for another commit or tree; it is RED; it is older than 72 h.
It additionally **recomputes risk and the secret scan itself** from `live..sha`, so a stale or lying
"low" cannot hide a policy-file change.

Honest limit: anyone who can read the key file can forge a result. This guards against accidents, a
broken Maintainer, and an agent that never read the key (the suite, the coding task and the verify
subprocesses are started without it); it is not a defence against root on the box.

### Risk classes

- **HIGH** (needs explicit acknowledgement): `packages/cli/src/policyGate*.ts`, `permissionPolicy.ts`,
  `entry/permissions.ts`, `packages/core/src/ownerPause*`, `ownerControl*`, `packages/garrison/src/token.ts`,
  `approvals*`, `packages/cli/src/phoneApprovals.ts`, `phoneOwnerControl.ts`, `keyVault.ts`,
  `packages/effects/src/{approval,killSwitch,policy,rails,budget,ledger}*`, any non-test/non-doc file
  whose path names vault/oauth/secret/credential/password/auth/token/remoteDevice*, the Maintainer
  itself, `scripts/elite/`, `.github/workflows/`, systemd `*.service`; **dependency changes**
  (`package.json` dependency lines, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`); **deleted test
  files**; test files that remove more `test(`/`it(`/`describe(` declarations than they add.
- **medium**: shared hotspots (`queryEngine.ts`, `garrisonCmd.ts`, `remoteAgentServer.ts`, `sessions.ts`,
  `scheduler.ts`, `server.ts`, prompt files, `tools/index.ts`).
- **low**: everything else.
- A **secret** in an added line (private keys, cloud/GitHub/Slack/Stripe/Google tokens, JWTs,
  hard-coded `password = "…"`) makes verify RED. Add `ares-secret-scan: ignore` on a line to allow a
  documented test fixture.

## 3. `ares-deploy`

```sh
node scripts/elite/ares-deploy.mjs (--sha <sha> | --branch <name>) [--dry-run]
     [--yes [--ack-high-risk]] | [--approval-receipt <file>]
     [--drain <minutes>] [--live ~/Ares] [--fetch-from rook|<path>] [--service ares-garrison]
     [--base-url http://127.0.0.1:7422] [--smoke-ask on|warn|off] [--ready-timeout 120] [--title ..] [--json]
```

Run by a human, by the lead, or by the Maintainer (after the owner approves). Order of play - every
refusal happens before anything on disk changes:

1. **lock** `<home>/elite/deploy.lock` (atomic; one deploy at a time; a dead holder's lock is reclaimed) -> exit 6.
2. live checkout sanity (clean tree) -> **fetch** (`--fetch-from`, default `rook`; the Maintainer uses the
   forge) -> resolve the sha -> **approved branch** (default `main`, `release/*`, `auto/*`, `feat*/*`;
   override `ARES_DEPLOY_APPROVED_BRANCHES` or `<home>/elite/approved-branches.json`).
3. **signed GREEN result** verified (above) -> risk/secrets recomputed -> must be a **fast-forward** of
   the live commit -> **owner approval**: a signed receipt (`--approval-receipt`, written by the
   Maintainer only on the owner's yes, bound to the sha, max 24 h old), or `--yes` (a human operator
   asserting it), or an interactive typed confirmation. A HIGH-RISK change additionally needs
   `ackHighRisk` in the receipt, or `--ack-high-risk` with `--yes`, or the longer typed phrase.
4. `--dry-run` stops here: prints the plan, writes nothing, takes no lock, restarts nothing.
5. **idle gate**: if any session is mid-turn (`GET /gateway/maintainer` -> `activeTurns`, else
   `/gateway/control`), refuse (exit 3) and tell the phone; with `--drain N` wait up to N minutes for
   idle (phone told "waiting", then deployed or "cancelled"), nothing changed on timeout.
6. **baseline smoke** against the *running old* service (so a check that was already failing is not
   blamed on the new code), record the **rollback point** (previous sha), fast-forward the live tree,
   `pnpm install --frozen-lockfile`, `pnpm build`.
7. **restart** `sudo -n systemctl restart ares-garrison` (set `ARES_DEPLOY_SUDO=""` to drop sudo), wait
   for **READY** (two consecutive 200s from `/health`, up to `--ready-timeout`), **smoke again**:
   `/health`, `/gateway/health`, `/gateway/health/deep` (404 = not on this build yet, skipped),
   `/gateway/goals`, `/gateway/memory`, and a scripted `POST /gateway/ask`. A check that passed before
   and fails now (or `/health` failing at all) triggers rollback.
8. **Automatic rollback** on any failure after the fast-forward: reset to the recorded sha, reinstall,
   rebuild, restart (only if the service was restarted), READY, smoke. If the rollback itself fails:
   status `rollback-failed`, exit 5, loud push - needs a human.
9. A **deploy record** `<home>/elite/deploys/<ts>-<sha8>-<id>.json` (status, shas, steps, smoke before/after,
   approval, risk, rollback; strings redacted) and a **phone push** (outbox + `POST
   /gateway/maintainer/notify`; undelivered messages stay in `<home>/elite/outbox` and the garrison
   delivers them on its next tick).

Exit codes: 0 deployed / already live / dry run - 1 refused - 3 busy - 4 rolled back - 5 rollback failed - 6 locked.
Statuses: `success`, `already-live`, `dry-run`, `refused`, `refused-busy`, `refused-locked`,
`rolled-back`, `rollback-failed`, `error` (an unexpected error after the live tree moved also rolls back).

**Restart survival.** A service restart kills every process in the unit's cgroup, including a deploy
started from inside it. The Maintainer therefore starts `ares-deploy` as its own transient unit:
`sudo -n systemd-run --collect --unit=ares-deploy-<id> --uid=<service user> node …` (or
`systemd-run --user` when only a lingering user manager is available; force with
`ARES_DEPLOY_LAUNCHER=system|user|none`). If neither is possible it refuses to launch and tells the owner
the exact manual command - it never runs a deploy that could die between restart and rollback.
After a restart the new garrison reconciles the proposal from the deploy record.

## 4. The Maintainer

Scheduler job `maintainer` (listed in the owner's jobs, pausable/holdable like the others), checked every
5 minutes; due once per local day from `ARES_MAINTAINER_TIME` (default 03:30) for a 5-hour window, only
while the owner has not paused Ares and no session is mid-turn (an unavailable night is not used up).

| Env | Default | Meaning |
| --- | --- | --- |
| `ARES_MAINTAINER` | on | `0` disables everything (hook idles, run-now refused) |
| `ARES_MAINTAINER_TIME` | `03:30` | local `HH:MM` the nightly window opens |
| `ARES_MAINTAINER_WINDOW_HOURS` | `5` | how long after that a late garrison may still start it |
| `ARES_MAINTAINER_BUDGET` | `40` | model **calls** per local day, hard cap (shared by manual runs) |
| `ARES_MAINTAINER_BUDGET_TOKENS` | `400000` | input+output **tokens** per local day, hard cap |
| `ARES_MAINTAINER_MAX_ISSUES` | `2` | issues attempted per run (`0` = collect and report only) |
| `ARES_MAINTAINER_TASK_CALLS` | `20` | calls per issue (also bounded by what is left today) |
| `ARES_MAINTAINER_TASK_MINUTES` | `20` | wall clock per coding task |
| `ARES_MAINTAINER_DRAIN_MIN` | `15` | how long an approved deploy waits for idle sessions |
| `ARES_MAINTAINER_PROPOSAL_TTL_HOURS` | `72` | a proposal nobody answers expires (nothing deployed) |
| `ARES_MAINTAINER_RETRY_DAYS` | `3` | an issue attempted (any outcome) is not retried for this long |
| `ARES_MAINTAINER_BUGREPORT_DIRS` | - | extra bug-report dirs (path-delimiter separated) |
| `ARES_FORGE_DIR`, `ARES_LIVE_DIR`, `ARES_ELITE_DIR` | `~/forge`, `~/Ares`, repo `scripts/elite` | locations |
| `ARES_DEPLOY_LAUNCHER` | auto | `system` / `user` / `none` |

**Each night**: (1) collect - crash artifacts (`~/.ares/crashes`), audit-log errors (grouped, 2+ occurrences,
denials and its own entries ignored), the reliability triage findings (failed turns/subagents, engine and
tool errors; product category only), bug reports (`~/.ares/bug-reports`, `bug_reports`, `.json`/`.json.gz`),
and red verifies of non-`auto/` branches; all redacted, flattened, bounded, and fenced as untrusted DATA
in the prompt. (2) rank - severity, recurrence, recency, source (owner reports and red verifies first);
skip issues with a pending proposal or attempted within the retry window. (3) per issue (at most N, within
budget): `auto/<date>-<slug>` worktree off the live commit -> the existing coding machinery
(`buildCodingTools` + `runForkedTurn`, the same as the gauntlet) with `pnpm install --offline && pnpm build`
prepared first, the **unattended policy gate** (anything needing a human is denied), a deny on any
tool input that mentions the live tree, a hard model-call/token cap and wall clock, registered with the
owner's kill switch -> commit on the auto branch -> `ares-verify` -> if **green**, a proposal. (4) Worktrees
are always removed; the branch stays in the forge.

**Proposal** `<home>/maintainer/proposals/<id>.json`: `{id, createdAt, runId, title, summary, issue,
branch, sha, base, risk:{class,reasons,requiresOwnerApproval}, diff:{files,added,deleted,paths},
test:{green,total,pass,fail,skipped,resultFile}, rollback:{previousSha,how}, status, decidedAt?, decidedBy?,
reason?, deployRecord?, deployedAt?}`. `status`: `pending` -> `deploying` -> `deployed` | `rolled-back` |
`failed`; or `rejected` / `expired`.

**Approval** goes through the existing staged-effects queue (the same one that gates sending mail):
kind `maintainer.deploy`, **irreversible** (so it opens the app - no Allow from a lock screen), reason
`Maintainer proposes: <title>. Deploy? Risk: low. 3 file(s), +40/-2. Tests 3539/3567 green. Auto-rollback
on a failed smoke test.` A HIGH-RISK proposal's card says `HIGH RISK: touches policy gate: …` instead of
`Risk: low`. Denied -> rejected; timed out (`ARES_APPROVAL_TIMEOUT_MS`, or the 72 h TTL) -> expired;
neither ever deploys. The approval queue is in memory, so after a garrison restart pending proposals
re-ask automatically. Approving writes a signed **receipt** (`<home>/maintainer/receipts/<id>.json`)
and starts `ares-deploy --approval-receipt … --drain N`.

**Morning report**: the briefing gains one section, **"Ares maintenance"** (`maintenance` in
`/gateway/briefings` settings, on by default, present only when the Maintainer is wired): did it run, how
many issues/attempts and budget used, proposals waiting (tap -> approvals), what it deployed, rollbacks.

## 5. Phone API (owner bearer on every route; every decision is audited as actor `owner`, action `maintainer.*`)

```
GET  /gateway/maintainer
     200 { enabled, time, running, forgeReady, lastRun: RunReport|null, nextRunAt, activeTurns, liveSha,
           budget:{day,callsUsed,callsLimit,tokensUsed,tokensLimit},
           proposals:[Proposal…newest 30], deploys:[{id,at,status,sha,previousSha,title,proposalId,risk,reason}…10] }
     RunReport = { id, trigger:"schedule"|"manual", startedAt, finishedAt, status:"running"|"done"|"skipped"|"error",
                   note?, issuesFound, issues:[{fingerprint,title,source,severity}],
                   attempts:[{title,fingerprint,outcome:"proposal"|"no-change"|"verify-red"|"coding-failed"|"budget"|"error"|"skipped",
                              branch?,proposalId?,reason?}], budget:{callsUsed,callsLimit,tokensUsed,tokensLimit} }
GET  /gateway/maintainer/proposals/<id>            200 { proposal } · 404
POST /gateway/maintainer/run                       202 { started:true, runId } · 409 { error, reason }
POST /gateway/maintainer/proposals/<id>/approve    {ackHighRisk?:boolean}
     202 { proposal }  (status "deploying"; poll GET /gateway/maintainer) · 404 · 409 not pending / another deploy
     running / HIGH-RISK without ackHighRisk:true
POST /gateway/maintainer/proposals/<id>/reject     {reason?}   200 { proposal } · 404 · 409
POST /gateway/maintainer/notify                    {title, body, data?}   200 { ok, pushed }   (used by ares-deploy;
     data keys limited to kind, deployId, status, sha, reason)
```

App side (later task): a "Maintenance" screen from `GET /gateway/maintainer`; proposal rows with risk
badge (HIGH RISK = red, requires a second confirm that sends `ackHighRisk:true`), Approve / Reject; "Run now";
deploy history. Push payload `data.kind == "deploy"` carries `status` (`deployed`/`rolled-back`/...) and `sha`.

## 6. Deploy notes (for the lead)

- **Restart of ares-garrison needed** to load the Maintainer hook, the routes and the briefing section.
- No new npm dependencies. New files: `scripts/elite/**`, `packages/cli/src/maintainer/**`,
  `packages/cli/src/entry/maintainer{Wiring,Coding}.ts`, tests `tests/elite-*.test.mjs`, `tests/_elite-fixture.mjs`.
- Shared-hotspot edits (small, additive): `scheduler.ts` (+`maintainer` hook, +5-minute timer, +job row),
  `garrisonCmd.ts` (import, hook line, audit filter, ~10-line `startMaintainer` block, `maintenance:` into
  briefing deps, `maintainer:` into `phoneApi`), `remoteAgentServer.ts` (+`maintainer` hook type and a
  3-line dispatch), `phoneBriefings.ts` + `briefingWiring.ts` (+`maintenance` section, only when a source is
  supplied), `ownerControlPlane.ts` (job name + title).
- One-time on the box: `bash scripts/elite/bootstrap-forge.sh init`, then one credential (deploy key or vault PAT),
  then a manual `ares-verify` + `ares-deploy --dry-run` to see it work before trusting the nightly run.
- The service user needs passwordless `sudo systemctl restart ares-garrison` (already so) **and**
  `sudo systemd-run` (or a lingering user systemd) for the Maintainer's own deploys. Without it, proposals are
  still created and approvals still work; the deploy step explains the manual command instead of risking a
  deploy that dies at the restart.
- Until the forge exists the Maintainer reports `forgeReady:false` and skips; nothing else changes.

## 7. Tests

`tests/elite-deploy.test.mjs` (verify, signing, risk, secret scan; deploy against a throwaway git forge with a
fake gateway and a stub `systemctl` on PATH: success, failed smoke -> rollback, regression in `health/deep`,
pre-existing failures not blamed, build failure -> rollback without restart, failed restart, lock held / dead
holder / simultaneous start, unsigned / red / tampered / wrong-commit / wrong-key results, high-risk gating,
stale "low" recomputed, receipts, idle gate + drain + drain timeout, dry run, branch / fast-forward / dirty-tree
refusals), `tests/elite-bootstrap.test.mjs`, `tests/elite-maintainer.test.mjs` (fake clock, scripted coding
runner, budget, approval gating: denied / timed out / approved / high-risk, restart re-ask, reconcile, outbox,
briefing section, the real `RemoteAgentServer` routes and bearer gate, telemetry, the real coding runner on a
mock provider, and one end-to-end pass through real worktrees, real `ares-verify` and real `ares-deploy`).
Nothing in the tests touches a real `~/Ares`, `~/.ares` or service.

## 8. Known limits

- A forged result needs the key file; `--yes` is an operator assertion an agent with shell access could also
  type. The shell policy gate (owner approval for mutating/`sudo` commands, unattended denial) is the wall
  there; do not give an unattended agent a passwordless shell and think `--yes` stops it.
- The real coding runner was exercised end to end only with a mock provider and a scripted runner; it has not
  been run against a live model (the budget cap exists for exactly that first run: start with
  `ARES_MAINTAINER_BUDGET=10 ARES_MAINTAINER_MAX_ISSUES=1` and `POST /gateway/maintainer/run`).
- Verification and deploy subprocesses are not owner-stoppable once started (the kill switch aborts the run
  between steps); a deploy has its own lock, idle gate and rollback instead.
- An in-place `pnpm build` overwrites `dist` while the old process still runs; node has loaded its modules, and
  the restart follows within seconds, but a lazily `import()`ed module could in theory see a half-written file.
