// Over-the-air updates. In a standalone build this pulls the newest JS bundle
// EAS Update has published and swaps to it — so `git push` → `eas update`
// (in CI) → the app is current the next time it opens or returns to the
// foreground. Inert in Expo Go / dev, where the dev server already live-reloads.

import { AppState, type AppStateStatus } from "react-native";
import * as Updates from "expo-updates";

/** Check now; if a newer bundle exists, fetch and reload into it. */
export async function applyUpdateIfAny(): Promise<boolean> {
  if (__DEV__ || !Updates.isEnabled) return false;
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return false;
    await Updates.fetchUpdateAsync();
    await Updates.reloadAsync();
    return true;
  } catch {
    // A failed check never blocks the app — it runs the bundle it has.
    return false;
  }
}

/** Wire this once at startup: check on launch and every return to foreground. */
export function watchForUpdates(): () => void {
  void applyUpdateIfAny();
  const onChange = (state: AppStateStatus) => {
    if (state === "active") void applyUpdateIfAny();
  };
  const sub = AppState.addEventListener("change", onChange);
  return () => sub.remove();
}
