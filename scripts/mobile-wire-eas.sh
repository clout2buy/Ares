#!/usr/bin/env bash
# Wire (or unwire) the App Store Connect submit profile into mobile/eas.json.
#
# The ASC key ids never go to git, but EAS reads them from eas.json — so both
# `eas build` and `eas update` run with eas.json temporarily wired, then it is
# restored. The runtime FINGERPRINT hashes eas.json, so build and update must
# see the identical file or an OTA targets a runtime no build has. Always use
# mobile-build.sh / mobile-ota.sh; never call eas by hand with a clean eas.json.
set -euo pipefail
cd "$(dirname "$0")/../mobile"
case "${1:-}" in
  wire)
    set -a; . "$HOME/.ares/asc/key.env"; set +a
    node -e '
      const fs=require("fs");const e=JSON.parse(fs.readFileSync("eas.json","utf8"));
      e.submit.production.ios={ascApiKeyPath:process.env.ASC_KEY_PATH,ascApiKeyId:process.env.ASC_KEY_ID,ascApiKeyIssuerId:process.env.ASC_ISSUER_ID,ascAppId:process.env.ASC_APP_ID};
      fs.writeFileSync("eas.json",JSON.stringify(e,null,2)+"\n");' ;;
  unwire) git checkout -- eas.json ;;
  *) echo "usage: $0 wire|unwire" >&2; exit 2 ;;
esac
