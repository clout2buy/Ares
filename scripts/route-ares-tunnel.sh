#!/usr/bin/env bash
# Route ares.mistiqueai.com → the garrison's remote-agent server (7422) through
# the doingbox named Cloudflare tunnel, and pin the garrison's public address
# so it stops spawning a quick tunnel of its own. Run as root. Idempotent.
#
# The garrison itself is NOT restarted here: whoever runs this (Ares, from a
# garrison session) would cut their own turn short. Restart it afterwards:
#   sudo systemctl restart ares-garrison.service
set -euo pipefail

CFG=/etc/cloudflared/config.yml
HOST=ares.mistiqueai.com
DROPIN=/etc/systemd/system/ares-garrison.service.d/remote.conf

if grep -q "hostname: $HOST" "$CFG"; then
  echo "ingress: $HOST already routed"
else
  cp "$CFG" "$CFG.bak.$(date +%s)"
  python3 - "$CFG" "$HOST" <<'PY'
import sys
cfg, host = sys.argv[1], sys.argv[2]
s = open(cfg).read()
rule = (
    "  # Ares on the phone: the garrison's remote-agent server (gateway proxy at\n"
    "  # /gateway, remote-PC links, the Ares network under /oricle). Above the\n"
    "  # wildcard on purpose — ingress is first match.\n"
    f"  - hostname: {host}\n"
    "    service: http://localhost:7422\n"
)
anchor = '  - hostname: "*.mistiqueai.com"\n'
assert anchor in s, "wildcard rule not found"
open(cfg, "w").write(s.replace(anchor, rule + anchor))
print(f"ingress: added {host}")
PY
  cloudflared tunnel --config "$CFG" ingress validate
  systemctl restart cloudflared
  echo "cloudflared: restarted"
fi

mkdir -p "$(dirname "$DROPIN")"
cat > "$DROPIN" <<CONF
# The permanent public address for the remote-agent server, fronted by the
# doingbox named tunnel ($CFG → localhost:7422). With a stable origin the
# garrison stops spawning a quick tunnel of its own, and the phone app's
# wss://$HOST/gateway never goes stale.
[Service]
Environment=ARES_REMOTE_PUBLIC_URL=https://$HOST
CONF
systemctl daemon-reload
echo "garrison: drop-in written ($DROPIN); restart ares-garrison.service to apply"

sleep 3
curl -s --max-time 20 "https://$HOST/health" && echo || echo "(health not answering yet — the tunnel may need a few seconds)"
