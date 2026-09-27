// Saved sign-ins — one login on the phone serves every Ares browser.
//
// A site with no API (DoorDash, Instacart…) is connected by the owner signing
// in on a live browser the garrison streams to their phone. That browser is a
// throwaway; what survives is its Playwright storage state, written to
// <ARES_HOME>/browser-sessions/<service>.json. Every browser Ares launches
// loads those cookies before it navigates, so the session is signed in no
// matter which conversation's browser (or which profile lock) it ends up on.
// Re-read on change, so a sign-in finished mid-conversation takes effect on
// the very next navigation.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function savedSessionsDir(): string {
  const home = process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
  return path.join(home, "browser-sessions");
}

interface StorageState {
  cookies?: Array<Record<string, unknown>>;
}

/**
 * Returns a function that adds every saved session's cookies to `context`
 * the first time it sees each file version. Cheap when nothing changed (one
 * readdir + stats). Never throws — a broken file is skipped.
 */
export function savedSessionLoader(context: { addCookies(cookies: unknown[]): Promise<void> }, dir = savedSessionsDir()): () => Promise<number> {
  const applied = new Map<string, number>();
  return async () => {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return 0;
    }
    let added = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        const { mtimeMs } = await fs.stat(file);
        if (applied.get(file) === mtimeMs) continue;
        const state = JSON.parse(await fs.readFile(file, "utf8")) as StorageState;
        const cookies = Array.isArray(state.cookies) ? state.cookies : [];
        if (cookies.length) await context.addCookies(cookies);
        applied.set(file, mtimeMs);
        added += cookies.length;
      } catch {
        // unreadable or rejected cookie set — skip, the rest still load
      }
    }
    return added;
  };
}
