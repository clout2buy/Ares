#!/usr/bin/env bash
# bootstrap-forge.sh - set up ~/forge on the box: the place where Ares edits ITSELF.
#
#   ~/forge/ares        bare repo: remote "rook" (the private GitHub repo) + refs/live/head (what ~/Ares runs)
#   ~/forge/work/       throwaway worktrees, one per self-edit, branch auto/<date>-<slug>
#   ~/forge/tmp/        TMPDIR for verify runs (a stray /tmp/package.json fails the workspace-freedom test)
#   ~/forge/bin/        the verify/deploy entry points (symlinks into the checkout this was run from)
#
# Self-edits NEVER happen in ~/Ares (the live tree). They happen in a worktree from `new-worktree`,
# get verified with ares-verify, and reach ~/Ares only through ares-deploy after the owner approves.
#
# Usage:
#   bootstrap-forge.sh [init]                 create/refresh the forge (idempotent)
#   bootstrap-forge.sh sync                   fetch rook + record the live commit
#   bootstrap-forge.sh status                 what is set up, what credentials are in use (never the secret)
#   bootstrap-forge.sh new-worktree <slug>    -> prints the path of a fresh worktree on auto/<date>-<slug>
#   bootstrap-forge.sh rm-worktree <path>     remove a worktree this script made (refuses anything else)
#   bootstrap-forge.sh clean [--days N]       remove worktrees/tmp older than N days (default 2)
# Options (before the command): --dry-run  --forge DIR  --remote URL  --live DIR  --offline
#
# Credentials (the script never prints, logs or asks for a secret; see docs/ELITE-SELFIMPROVE.md):
#   1. deploy key (preferred):  ARES_FORGE_SSH_KEY=~/.ssh/ares-forge  (read+write deploy key on the repo;
#      remote URL becomes git@github.com:<owner>/<repo>.git)
#   2. fine-grained PAT in the Ares vault: store it ONCE, out of chat:
#         printf %s "$TOKEN" | node scripts/elite/forge-credential.mjs store
#      and this script wires git's credential helper to read it back from the vault.
#   3. nothing: fine for a public remote, and for a local path remote used in tests.
# A remote URL with a password or token embedded in it is refused.

set -euo pipefail

DRY=0
OFFLINE=0
FORGE="${ARES_FORGE_DIR:-$HOME/forge}"
LIVE="${ARES_LIVE_DIR:-$HOME/Ares}"
REMOTE="${ARES_FORGE_REMOTE:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --offline) OFFLINE=1; shift ;;
    --forge) FORGE="$2"; shift 2 ;;
    --remote) REMOTE="$2"; shift 2 ;;
    --live) LIVE="$2"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) break ;;
  esac
done
CMD="${1:-init}"; [ $# -gt 0 ] && shift || true

BARE="$FORGE/ares"
WORK="$FORGE/work"
TMPD="$FORGE/tmp"
BIN="$FORGE/bin"

say() { printf '%s\n' "$*"; }
# Echo what would run; run it unless --dry-run. Arguments are quoted, never eval'd.
do_() {
  if [ "$DRY" = 1 ]; then printf '+ (dry-run)'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
die() { printf 'bootstrap-forge: %s\n' "$*" >&2; exit 1; }

# Refuse anything that puts a secret in a URL (it would land in .git/config and in `git remote -v`).
check_url() {
  case "$1" in
    *://*:*@*|*://*@*:*) die "the remote URL contains credentials; use a deploy key (ARES_FORGE_SSH_KEY) or the vault credential helper instead" ;;
  esac
}

default_remote() {
  if [ -n "$REMOTE" ]; then printf '%s' "$REMOTE"; return; fi
  if [ -d "$LIVE/.git" ] || [ -f "$LIVE/.git" ]; then
    local u; u="$(git -C "$LIVE" remote get-url rook 2>/dev/null || true)"
    [ -n "$u" ] && { printf '%s' "$u"; return; }
  fi
  printf '%s' "https://github.com/clout2buy/ares-rook"
}

ssh_form() {
  # https://github.com/o/r(.git) -> git@github.com:o/r.git
  case "$1" in
    https://github.com/*) local p="${1#https://github.com/}"; p="${p%.git}"; printf 'git@github.com:%s.git' "$p" ;;
    *) printf '%s' "$1" ;;
  esac
}

in_forge() { git -C "$BARE" "$@"; }

wire_credentials() {
  # Deploy key
  if [ -n "${ARES_FORGE_SSH_KEY:-}" ]; then
    [ -f "$ARES_FORGE_SSH_KEY" ] || die "ARES_FORGE_SSH_KEY points at a file that does not exist"
    do_ git -C "$BARE" config core.sshCommand "ssh -i $ARES_FORGE_SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
    do_ git -C "$BARE" remote set-url rook "$(ssh_form "$(default_remote)")"
    say "credentials: deploy key $(basename "$ARES_FORGE_SSH_KEY") (path only; the key is never read here)"
    return
  fi
  # Vault-backed PAT: git calls the helper, the helper decrypts from the Ares vault. Nothing is stored in git config but the helper command.
  case "$(default_remote)" in
    https://github.com/*)
      do_ git -C "$BARE" config credential.https://github.com.helper "!node $HERE/forge-credential.mjs"
      do_ git -C "$BARE" config credential.https://github.com.useHttpPath true
      say "credentials: Ares vault entry FORGE_GITHUB_TOKEN via forge-credential.mjs (store it once: printf %s \"\$TOKEN\" | node $HERE/forge-credential.mjs store)"
      ;;
    *) say "credentials: none needed for this remote" ;;
  esac
}

cmd_init() {
  local url; url="$(default_remote)"
  check_url "$url"
  command -v git >/dev/null || die "git is not installed"
  case "$FORGE" in "$LIVE"|"$LIVE"/*) die "the forge must not live inside the live tree ($LIVE)" ;; esac
  say "forge:  $FORGE"
  say "remote: rook = $(printf '%s' "$url" | sed -E 's#//[^/@]*@#//#')"
  say "live:   $LIVE (read-only: only its HEAD commit is fetched)"
  do_ mkdir -p "$WORK" "$TMPD" "$BIN"
  if [ ! -d "$BARE" ]; then
    do_ git init -q --bare "$BARE"
  else
    say "bare repo exists; refreshing configuration"
  fi
  if [ "$DRY" = 1 ] || ! git -C "$BARE" remote get-url rook >/dev/null 2>&1; then
    do_ git -C "$BARE" remote add rook "$url"
  else
    do_ git -C "$BARE" remote set-url rook "$url"
  fi
  # Remote branches live under refs/remotes/rook/*; refs/heads/* is ours alone (auto/*), so a prune can never delete our work.
  do_ git -C "$BARE" config remote.rook.fetch '+refs/heads/*:refs/remotes/rook/*'
  do_ git -C "$BARE" config gc.auto 0
  wire_credentials
  # entry points (symlinks, so a deployed update of the checkout updates them too)
  for s in ares-verify.mjs ares-deploy.mjs; do
    do_ ln -sfn "$HERE/$s" "$BIN/${s%.mjs}"
  done
  if [ "$OFFLINE" = 0 ]; then cmd_sync; else say "offline: skipping fetch"; fi
  say "ready. Next: $0 new-worktree <slug>   (edit there, never in $LIVE)"
}

cmd_sync() {
  [ -d "$BARE" ] || [ "$DRY" = 1 ] || die "no forge yet; run: $0 init"
  if [ "$OFFLINE" = 1 ]; then say "offline: not fetching rook"; else
    do_ git -C "$BARE" fetch -q --prune rook || say "warning: fetching rook failed (credentials?); continuing with what is already here"
  fi
  # Record what the box is running so worktrees start from it and verify can diff against it. Read-only on the live tree.
  if [ -e "$LIVE/.git" ]; then
    do_ git -C "$BARE" fetch -q --no-tags "$LIVE" '+HEAD:refs/live/head' || say "warning: could not read the live commit"
  fi
}

cmd_status() {
  say "forge: $FORGE"
  [ -d "$BARE" ] || { say "  not set up (run: $0 init)"; return 0; }
  say "  remote: $(git -C "$BARE" remote get-url rook 2>/dev/null | sed -E 's#//[^/@]*@#//#')"
  if git -C "$BARE" config --get core.sshCommand >/dev/null 2>&1; then say "  credentials: deploy key"; \
  elif git -C "$BARE" config --get credential.https://github.com.helper >/dev/null 2>&1; then say "  credentials: vault helper"; \
  else say "  credentials: none"; fi
  say "  live commit: $(git -C "$BARE" rev-parse --short refs/live/head 2>/dev/null || echo unknown)"
  say "  rook branches: $(git -C "$BARE" for-each-ref --format=x refs/remotes/rook | wc -l | tr -d ' ')"
  say "  auto branches: $(git -C "$BARE" for-each-ref --format='%(refname:short)' refs/heads/auto | wc -l | tr -d ' ')"
  say "  worktrees:"; git -C "$BARE" worktree list | sed 's/^/    /'
}

cmd_new_worktree() {
  local slug="${1:-}"; [ -n "$slug" ] || die "usage: new-worktree <slug>"
  slug="$(printf '%s' "$slug" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-32 | sed -E 's/-+$//')"
  [ -n "$slug" ] || die "slug has no usable characters"
  local day branch dir base n=1
  day="$(date +%Y-%m-%d)"
  branch="auto/$day-$slug"
  while git -C "$BARE" show-ref --verify --quiet "refs/heads/$branch"; do n=$((n+1)); branch="auto/$day-$slug-$n"; done
  dir="$WORK/${branch//\//-}"
  if git -C "$BARE" rev-parse --verify --quiet refs/live/head >/dev/null; then base=refs/live/head
  elif git -C "$BARE" rev-parse --verify --quiet refs/remotes/rook/main >/dev/null; then base=refs/remotes/rook/main
  else die "no base commit; run: $0 sync"; fi
  do_ git -C "$BARE" worktree add -q -b "$branch" "$dir" "$base"
  say "$dir"
  say "branch: $branch (from $(git -C "$BARE" rev-parse --short "$base" 2>/dev/null || echo "$base"))" >&2
}

cmd_rm_worktree() {
  local dir="${1:-}"; [ -n "$dir" ] || die "usage: rm-worktree <path>"
  local real_work real_dir
  real_work="$(cd "$WORK" 2>/dev/null && pwd -P)" || die "no worktree directory yet"
  real_dir="$(cd "$(dirname "$dir")" 2>/dev/null && pwd -P)/$(basename "$dir")" || die "no such path: $dir"
  case "$real_dir" in
    "$real_work"/*) ;;
    *) die "refusing to remove $dir: not under $WORK" ;;
  esac
  do_ git -C "$BARE" worktree remove --force "$dir"
  do_ git -C "$BARE" worktree prune
}

cmd_clean() {
  local days=2; [ "${1:-}" = "--days" ] && days="${2:-2}"
  do_ git -C "$BARE" worktree prune
  if [ "$DRY" = 1 ]; then
    find "$WORK" "$TMPD" -mindepth 1 -maxdepth 1 -mtime "+$days" 2>/dev/null | sed 's/^/+ (dry-run) would remove /' || true
  else
    find "$WORK" "$TMPD" -mindepth 1 -maxdepth 1 -mtime "+$days" -exec rm -rf {} + 2>/dev/null || true
    git -C "$BARE" worktree prune
  fi
}

case "$CMD" in
  init) cmd_init ;;
  sync) cmd_sync ;;
  status) cmd_status ;;
  new-worktree) cmd_new_worktree "$@" ;;
  rm-worktree) cmd_rm_worktree "$@" ;;
  clean) cmd_clean "$@" ;;
  *) die "unknown command: $CMD (init|sync|status|new-worktree|rm-worktree|clean)" ;;
esac
