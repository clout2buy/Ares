#!/usr/bin/env bash
# Ship a JS-only change to installed builds over the air.
#   scripts/mobile-ota.sh "what changed"
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MSG="${1:-update}"
set -a; . "$HOME/.ares/asc/key.env"; set +a
"$HERE/mobile-wire-eas.sh" wire
trap '"$HERE/mobile-wire-eas.sh" unwire' EXIT
cd "$HERE/../mobile"
npx eas-cli update --branch production --environment production --message "$MSG" --non-interactive
