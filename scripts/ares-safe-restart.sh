#!/usr/bin/env bash
# ares-safe-restart <unit> [reason]
#
# The ONLY sanctioned way for an agent to restart the daemon it lives in.
# A plain `systemctl restart ares-garrison` from inside an agent turn kills that
# turn mid-tool: the call never returns and the owner's phone shows the agent
# go dark (incident 2026-10-01). This script instead:
#   1. detaches into its own transient systemd unit, so the restart it performs
#      cannot kill it (a child of the garrison dies with the garrison cgroup);
#   2. waits until the daemon reports zero running turns (GET /health), so the
#      caller's own reply finishes first; gives up waiting after a ceiling and
#      restarts anyway, because a wedged turn must not block a fix forever;
#   3. restarts, then polls /health until it is ok again, and logs the outcome.
#
# Usage: ares-safe-restart ares-garrison "pick up DISPLAY drop-in"
set -euo pipefail

UNIT="${1:-}"
REASON="${2:-unspecified}"
LOG="${ARES_SAFE_RESTART_LOG:-/home/mrdoing/.ares/safe-restart.log}"
IDLE_CEILING_S="${ARES_SAFE_RESTART_IDLE_CEILING_S:-900}"
HEALTH_TIMEOUT_S="${ARES_SAFE_RESTART_HEALTH_TIMEOUT_S:-90}"

case "$UNIT" in
  ares-garrison|ares-garrison.service) UNIT=ares-garrison; PORT=7421 ;;
  ares-partner|ares-partner.service) UNIT=ares-partner; PORT=17421 ;;
  ares-instance-*) UNIT="${UNIT%.service}"; PORT="" ;;
  *) echo "usage: ares-safe-restart <ares-garrison|ares-partner|ares-instance-NAME> [reason]" >&2; exit 2 ;;
esac

log() { printf '%s [%s] %s\n' "$(date -Is)" "$UNIT" "$*" | tee -a "$LOG" >&2; }

health() {
  [ -n "$PORT" ] || { systemctl is-active --quiet "$UNIT" && echo '{"ok":true}'; return; }
  curl -fsS -m 4 "http://127.0.0.1:$PORT/health" 2>/dev/null || true
}

running_turns() {
  # Older builds do not report runningTurns; treat that as unknown (-1) and
  # fall back to the ceiling rather than restarting blind under a live turn.
  health | python3 -c 'import sys,json
try: print(int(json.load(sys.stdin).get("runningTurns",-1)))
except Exception: print(-1)'
}

if [ "${ARES_SAFE_RESTART_DETACHED:-}" != "1" ]; then
  touch "$LOG" 2>/dev/null || true
  # Re-exec in a transient unit outside the caller's cgroup, then return
  # immediately so the calling agent can finish its reply.
  name="ares-safe-restart-$(date +%s)"
  sudo -n systemd-run --unit="$name" --collect --quiet \
    --setenv=ARES_SAFE_RESTART_DETACHED=1 \
    --setenv=ARES_SAFE_RESTART_LOG="$LOG" \
    --setenv=ARES_SAFE_RESTART_IDLE_CEILING_S="$IDLE_CEILING_S" \
    --setenv=ARES_SAFE_RESTART_HEALTH_TIMEOUT_S="$HEALTH_TIMEOUT_S" \
    "$(readlink -f "$0")" "$UNIT" "$REASON"
  echo "queued: $UNIT restarts once no turn is running (transient unit $name). Log: $LOG"
  exit 0
fi

log "requested: $REASON"
waited=0
# Give the caller a moment to finish the tool call that queued us, so its own
# turn is visible as running and we wait for it instead of racing it.
sleep 5
while :; do
  n="$(running_turns)"
  if [ "$n" = "0" ]; then break; fi
  if [ "$waited" -ge "$IDLE_CEILING_S" ]; then
    log "still $n running turn(s) after ${IDLE_CEILING_S}s; restarting anyway (startup recovery replays interrupted turns)"
    break
  fi
  sleep 5; waited=$((waited + 5))
done
[ "$waited" -gt 0 ] && log "idle after ${waited}s"

systemctl restart "$UNIT"
start=$(date +%s)
until printf '%s' "$(health)" | grep -q '"ok":true'; do
  if [ $(( $(date +%s) - start )) -ge "$HEALTH_TIMEOUT_S" ]; then
    log "FAILED: not healthy ${HEALTH_TIMEOUT_S}s after restart; state=$(systemctl is-active "$UNIT" || true)"
    exit 1
  fi
  sleep 2
done
log "ok: healthy $(( $(date +%s) - start ))s after restart"
