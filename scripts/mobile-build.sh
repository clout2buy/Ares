#!/usr/bin/env bash
# Native rebuild + TestFlight submit (only needed when native deps/config change).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
set -a; . "$HOME/.ares/asc/key.env"; set +a
export EAS_BUILD_NO_EXPO_GO_WARNING=true
"$HERE/mobile-wire-eas.sh" wire
trap '"$HERE/mobile-wire-eas.sh" unwire' EXIT
cd "$HERE/../mobile"
npx eas-cli build --platform ios --profile production --auto-submit --non-interactive --wait
