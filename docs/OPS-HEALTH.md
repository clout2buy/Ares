# Ops health: observe, self-clean, self-protect

The garrison reports its own health, cleans up after itself, tells the owner's
phone when something needs them, and backs up what cannot be regenerated. All of
it is read-only or reversible, and every piece has a kill switch.

Code: `packages/cli/src/` `systemSnapshot.ts` (health snapshot), `systemSignals.ts`
(errors, provider breakers, event-loop lag), `systemHousekeeping.ts` (cleanup),
`systemAlerts.ts` (push + feed), `systemBackup.ts` (backup/restore),
`systemWiring.ts` (composition for `garrison serve`), `phoneSystem.ts` (routes).
Restore: `scripts/elite/restore.mjs`. Measurements: `scripts/elite/ops-bench.mjs`,
`scripts/elite/backup-bench.mjs`.

## Routes (owner bearer, same origin as `/gateway`)

| Route | What |
| --- | --- |
| `GET /gateway/system[?fresh=1]` | the snapshot, cached 5 s |
| `GET /gateway/system/events?limit=&before=` | alert, housekeeping and backup feed, newest first |
| `GET /gateway/system/housekeeping` | `{summary, ledger[]}`: what was deleted and why |
| `POST /gateway/system/housekeeping {dryRun?}` | run now; returns the full report (409 if already running) |
| `GET /gateway/system/backup` | backup status |
| `POST /gateway/system/backup` | start a backup now (202), poll the GET |
| `POST /gateway/system/turns/stop {sessionId}` | interrupt one running turn |

The snapshot never fails because one source did: a collector that throws or
exceeds 2.5 s becomes `sources[name] = "error"` and a hole in the JSON; a source
this box does not wire is `"absent"`. Fields: garrison uptime/pid/version/sha,
heap and RSS, event-loop lag (mean/p99/max), CPU load, disk fill plus a
breakdown (home, logs, sessions, checkpoint blobs, WAL, worktrees; walked in the
background at most every 10 min), sessions and running turns with ages and a
`stuck` flag (>10 min), queue depth, pending approvals, provider breaker states,
connector health, scheduler jobs, push and tunnel status, deployed instances,
stray process counts, the last errors (scrubbed), the housekeeping summary, the
backup status, and `maintainer`/`deep` when those slices publish them.

`deep`: when the antihang slice's `/gateway/health/deep` exists, pass it as the
`deep` dependency of `createSystemService`; it is folded in verbatim and the app
shows its stuck-candidate and orphan counts. Nothing here depends on it.

`maintainer`: pass a `maintainer` function (any JSON object of plain values); the
app renders up to six of its scalar fields.

## Housekeeping (`ARES_HOUSEKEEPING=0` turns it all off)

Runs at boot (90 s after start, `ARES_HOUSEKEEPING_BOOT_DELAY_MS`) and hourly via
the scheduler's `housekeeping` hook. Each job reports `found / acted / bytes /
skipped`; a dry run (`POST ... {"dryRun":true}`) fills the same counters and
changes nothing. Every real action is a line in `<home>/housekeeping/ledger.jsonl`;
the last report is `<home>/housekeeping/last-report.json`.

Hard rules, enforced by a fence and not by each job's good intentions: only paths
strictly inside Ares's own directories (home, `<workspace>/.ares`,
`<workspace>/.claude/worktrees`, and Ares-prefixed temp dirs); never a symlink;
never vault, credentials, tokens, memory, personas, goals, the session database
or the audit log; never a git worktree with uncommitted or untracked changes
(and never `--force`); never a detached worktree whose commits exist nowhere else.

| Job | Default | Knob |
| --- | --- | --- |
| wire logs | gzip after 2 d, delete after 14 d, cap 300 MB | `ARES_HOUSEKEEPING_WIRELOG_COMPRESS_DAYS`, `_WIRELOG_DAYS`, `_WIRELOG_CAP_MB` |
| log files (`*.log`) | copy-truncate to a `.gz` over 20 MB, keep 3, delete rotations after 30 d | `_LOG_ROTATE_MB`, `_LOG_KEEP`, `_LOG_DAYS` |
| crash reports | delete after 45 d, always keep newest 20 | `_CRASH_DAYS`, `_CRASH_KEEP` |
| tool output spill | delete after 30 d | `_SPILL_DAYS` |
| screenshots | delete after 7 d | `_SCREENSHOT_DAYS` |
| checkpoint blobs | core's GC when blobs no checkpoint references exist | (core: `ARES_CHECKPOINT_*`) |
| SQLite WAL | fold (TRUNCATE when idle) above 64 MB | `_WAL_MB` |
| temp dirs (`/tmp/ares-*`, `shots-*`, `playwright-artifacts-*`) | delete after 3 d idle | `_TMP_DAYS` |
| git worktrees in Ares scratch locations | remove when clean and (merged, or stale over 7 d on a branch) | `_WORKTREE_DAYS` |
| instance build leftovers | staged `.image` context after 7 d; unused old `ares-instance:<rev>` images except the newest | `_IMAGE_DAYS` |
| stray processes | SIGTERM then SIGKILL for orphaned Ares browser processes older than 10 min | `_ORPHAN_MIN` |

At or above 80% disk the age limits halve. `ARES_HOUSEKEEPING_WORKSPACES` adds
workspaces (path-delimiter separated) whose `.ares` and worktrees are tidied.
Orphans are only processes whose command line carries an Ares browser profile
(`<home>/browser-profile`, `ares-login-*`) AND whose parent is init/systemd; a
browser the garrison itself is running has the garrison as its parent and is
never touched. The audit log is deliberately not rotated here.

## Alerts

Push goes through the existing APNs path. Conditions (de-duplicated by key; one
push per occurrence, a reminder after 6 h up to 3 times, "resolved" after two
clean evaluations, one-minute evaluation cadence):

disk over 85% (80-85% is feed only), memory pressure, repeated restart or crash
(3 starts in 30 min or 3 crash reports in an hour), provider outage over 5 min,
turn stuck over 10 min, connector expired, backup failed, deploy rolled back.

Quiet hours default 23:00-07:00 in the owner's zone (`ARES_ALERT_QUIET="HH:MM-HH:MM"`
or `off`); a non-critical alert raised then is held (visible in the feed) and sent
when quiet hours end if it is still true. Critical ones (disk at 95%, heap near
its limit, restart loop) pierce quiet hours. A failed push is retried after 10 min.

Deploy gate contract: after a rollback, write
`<home>/system/signals/deploy-rolled-back.json` as `{"at": "<ISO>", "reason": "..."}`.
The alert fires once and the marker is ignored after 24 h.

## Backups

Nightly after `ARES_BACKUP_HOUR` (default 03:00), also at boot if tonight's is
missing. To `~/backups/ares/<date>/` (`ARES_BACKUP_DIR`): `ares-<date>.arcbak`
(AES-256-GCM over gzip; one SHA-256 per file; the whole blob's SHA-256 in
`manifest.json`) plus the manifest. Each backup is verified (decrypt, every
checksum) before it counts. Retention: 7 daily plus 4 weekly; only dated dirs
with a manifest are ever pruned.

In: everything under the Ares home except bulky or derived trees (browser
profile, checkpoint blobs, wire logs, screenshots, media, snapshots, logs,
crashes, tool results, rollouts the kernel already holds), plus each workspace's
session-kernel database taken through SQLite (`VACUUM INTO`) from the live store.
If the state would pass `ARES_BACKUP_MAX_MB` (1024) the backup fails loudly
instead of leaving things out.

Key: `~/backups/ares/.backup.key` (0600, random), or `ARES_BACKUP_KEY` (32 bytes,
base64). The key is not inside the home it protects. **Copy it somewhere safe
(a password manager); a backup without it cannot be read.**

Offsite (off by default): set `ARES_BACKUP_OFFSITE_DIR` to a synced or mounted
directory; each night's `.arcbak` and manifest are copied there. The files are
already encrypted; keep the key separate from them.

Restore:

```
node scripts/elite/restore.mjs --from ~/backups/ares --verify            # integrity only
node scripts/elite/restore.mjs --from ~/backups/ares --dry-run           # what would be written
node scripts/elite/restore.mjs --from ~/backups/ares/2026-10-01 --to ~/.ares-restored
```

Stop the garrison before restoring over a live home; the safest flow is restore
into a fresh directory, check it, then swap. The script refuses to write over the
live home without `--force`, never overwrites an existing file without `--force`,
authenticates the whole archive before writing a byte, and rejects any entry path
that would leave the destination. Kernel databases land in `<to>/restored-kernel/`.

## Deploy notes

- Server: no new dependencies; restart needed (new scheduler hook, session event tap).
- New env knobs are all optional; defaults above.
- First boot after deploy runs housekeeping after 90 s. On Rook the first real run
  reclaims about 1 GB of orphaned checkpoint blobs and removes the clean, stale
  worktrees under `~/Ares/.claude/worktrees` (their branches are kept).
