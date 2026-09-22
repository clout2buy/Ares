# Ares on iPhone

The Ares iOS app (`mobile/`, Expo) talks to the garrison over
`wss://ares.mistiqueai.com/gateway` — a public HTTPS origin fronted by the
doingbox Cloudflare tunnel, so it works on **cellular, any Wi-Fi, anywhere**.

Two ways to run it. Pick based on whether you want a permanent, auto-updating
app (needs a $99/yr Apple Developer account) or a free-but-fragile sideload.

---

## The real setup — $99/yr, auto-updating, works forever

Gives: a standalone icon, TestFlight install (no cable), **push code → phone
updates itself** (OTA), and push notifications. This is the one to use.

**One-time:**
1. Enroll: <https://developer.apple.com/programs/> ($99/yr).
2. Free Expo account: <https://expo.dev> → create one.
3. On the box (or any machine with the repo):
   ```bash
   cd mobile
   npm i -g eas-cli
   eas login                 # your Expo account
   eas init                  # creates the EAS project, fills app.json projectId
   eas update:configure      # fills the OTA update URL in app.json
   eas build --platform ios --profile production   # first signed build; asks for Apple login, creates certs
   eas submit --platform ios                        # → TestFlight
   ```
4. Install **TestFlight** on the iPhone, accept the invite, install Ares.
5. Pair: gateway `ares.mistiqueai.com`, token from `~/.ares/garrison/token`
   (or scan the pairing QR).

**Day to day (from the box):**
- JS/UI change → `scripts/mobile-ota.sh "what changed"` → installed phones pull it on next open. Seconds, no rebuild.
- Native change (new SDK, new native module) → `scripts/mobile-build.sh` → new TestFlight build.
- Always use these scripts, never `eas build`/`eas update` by hand: the runtime fingerprint hashes `eas.json`, and the scripts keep it byte-identical between build and update (the ASC submit fields are wired in for the run and restored after). An update published against a different `eas.json` targets a runtime no build has and is silently never fetched.

**From then on — auto-update on push:**
- In the GitHub repo: Settings → Secrets and variables → Actions
  - Variable `IOS_SIGNING_ENABLED` = `true`
  - Secret `EXPO_TOKEN` = an Expo access token (`eas token:create` or expo.dev → settings)
- Now every push:
  - **JS change** → the `ota-update` job runs `eas update` → the phone pulls it
    on next open. Seconds. No reinstall, no review.
  - **Native change** (new SDK / native module) → the `testflight` job rebuilds
    and ships to TestFlight.

Native changes are rare; day to day, `git push` = the app updates itself.

---

## The free path — no Apple account, 7-day expiry

Gives: a real icon that **stops working every 7 days** unless a computer
re-signs it. No push notifications. Fine to try it; not something to rely on.

1. Grant the box's GitHub token the `workflow` scope (once):
   ```bash
   gh auth refresh -h github.com -s workflow
   ```
   Then the `.github/workflows/ios.yml` build can be pushed and will run.
2. Push under `mobile/` (or run the workflow manually) → the `build-unsigned`
   job builds `Ares-unsigned.ipa` on a cloud Mac → download it from the Actions
   run's artifacts.
3. On your **Windows PC**: install AltStore (AltServer), plug in the iPhone
   once, sign in with a free Apple ID, drag the `.ipa` in.
4. AltServer auto-refreshes the app over Wi-Fi before the 7-day expiry, as long
   as the PC is on and on the same network periodically.

---

## Reachability

- **Anywhere (cellular/Wi-Fi):** default. The app dials the public tunnel origin.
- **In-house / LAN:** also works via the tunnel. A LAN-direct fallback (dialing
  the box's `192.168.1.237:7422` when the internet is down but you're home) is a
  possible add-on — not wired yet.

## Serving (dev)

`ares-mobile-dev.service` runs `expo start --tunnel` for Expo Go development.
The Expo Go URL depends on `mobile/.expo/settings.json` (`urlRandomness`);
deleting that file changes the URL.
