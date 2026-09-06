#!/usr/bin/env bash
# One-line source install of the `ares` CLI for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/clout2buy/Ares/main/scripts/install.sh | bash
#
# What it does, in order — and nothing else:
#   1. checks for git and Node 22+ (tells you how to get them if missing)
#   2. clones the repo into $ARES_SRC (default ~/.ares-src) or pulls if it exists
#   3. enables pnpm through corepack (no global npm installs)
#   4. pnpm install + pnpm build
#   5. runs the repo's installer, which drops an `ares` launcher into
#      ${XDG_BIN_HOME:-~/.local/bin} — never sudo, never edits your PATH or rc files
#
# Re-running it updates an existing install. ~/.ares (config, vault, sessions)
# is never touched. Set ARES_REF to install a tag or branch (default: main).
set -euo pipefail

ARES_SRC="${ARES_SRC:-$HOME/.ares-src}"
ARES_REF="${ARES_REF:-main}"
REPO="${ARES_REPO:-https://github.com/clout2buy/Ares.git}"

say() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✕\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required. macOS: xcode-select --install · Debian/Ubuntu: sudo apt install git"
command -v node >/dev/null 2>&1 || die "Node 22+ is required. macOS: brew install node · or https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node 22+ is required (found $(node -v)). macOS: brew upgrade node"

if [ -d "$ARES_SRC/.git" ]; then
  say "updating $ARES_SRC ($ARES_REF)"
  git -C "$ARES_SRC" fetch --quiet --tags origin
  git -C "$ARES_SRC" checkout --quiet "$ARES_REF"
  # a branch fast-forwards; a tag is already exact
  git -C "$ARES_SRC" pull --quiet --ff-only origin "$ARES_REF" 2>/dev/null || true
else
  say "cloning into $ARES_SRC ($ARES_REF)"
  git clone --quiet --branch "$ARES_REF" "$REPO" "$ARES_SRC"
fi
cd "$ARES_SRC"

if ! command -v pnpm >/dev/null 2>&1; then
  say "enabling pnpm via corepack"
  corepack enable >/dev/null 2>&1 || die "corepack is missing — install pnpm: npm i -g pnpm"
fi

say "installing dependencies"
pnpm install --frozen-lockfile --silent || pnpm install --silent
say "building"
pnpm build >/dev/null
say "installing the ares launcher"
node scripts/install-cli.mjs

cat <<EOF

Done. Run:  ares

If your shell says "command not found", the launcher dir is not on PATH yet —
the installer printed the exact line to add. Update later with the same
one-liner; remove with:  node $ARES_SRC/scripts/uninstall-cli.mjs
EOF
