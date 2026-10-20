// The Forge's native view, from the daemon's side.
//
// Owner, 2026-10-20: "never a screenshot again… every site can load in ares
// preview." The desktop lays a real browser over the Forge panel
// (tauri/src-tauri/src/forge_view.rs) and starts this daemon with
// ARES_FORGE_CDP_URL, that browser's DevTools endpoint. The Browser tool then
// attaches Playwright to THAT page: Ares clicks and types in the page the
// owner is watching, the owner can take over at any moment, and nothing is
// streamed as frames. Without the variable (CLI, garrison, phone, Telegram)
// the Browser tool keeps its own background browser, as before.

/** The view's DevTools endpoint, or "" when no desktop Forge is attached. */
export function forgeCdpUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ARES_FORGE_CDP_URL ?? "").trim().replace(/\/+$/, "");
}

/** The strategy name a connector attached to the Forge view reports. */
export function isForgeStrategy(strategy: string | undefined, cdpUrl: string): boolean {
  return Boolean(cdpUrl) && strategy === `cdp:${cdpUrl}`;
}

/** Wait until the view's endpoint answers. The view is made the first time
 *  the Forge shows a page, so the first call after launch waits a moment. */
export async function forgeViewUp(cdpUrl: string, waitMs: number, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!cdpUrl) return false;
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    try {
      const res = await fetchImpl(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((r) => setTimeout(r, Math.min(250, left)));
  }
}

/** How long the first call waits for the view to come up
 *  (ARES_FORGE_VIEW_WAIT_MS, default 15 s). */
export function forgeWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ARES_FORGE_VIEW_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : 15_000;
}

/** One chat drives the Forge at a time: it is ONE page, and two agents
 *  clicking in it at once would wreck each other's work. A chat holds it
 *  while it keeps using it; after ARES_FORGE_HOLD_MS (default 2 min) without
 *  a Browser call, the next chat may take it. The others use the background
 *  browser meanwhile, and say so. */
let holder: { id: string; at: number } | null = null;

export function claimForge(sessionId: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  const n = Number(env.ARES_FORGE_HOLD_MS);
  const holdMs = Number.isFinite(n) && n >= 0 ? n : 120_000;
  if (!holder || holder.id === sessionId || now - holder.at > holdMs) {
    holder = { id: sessionId, at: now };
    return true;
  }
  return false;
}

/** Tests only. */
export function resetForgeHolder(): void {
  holder = null;
}

const told = new Map<string, string>();

/** What the Forge shows right now, as one line for the agent's next turn —
 *  only when it changed since this chat was last told. So "fill this in",
 *  "what's wrong with this page", "click that" land on the page the owner
 *  is looking at. Read from the view's DevTools listing (no Playwright, no
 *  attach): cheap, and nothing happens to the page. The title is the
 *  site's own text, so it is quoted and clipped, never instructions. */
export async function forgeScreenNote(sessionId: string, cdpUrl = forgeCdpUrl(), fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!cdpUrl || !sessionId) return null;
  let list: Array<{ type?: string; url?: string; title?: string }>;
  try {
    const res = await fetchImpl(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return null;
    list = (await res.json()) as typeof list;
  } catch {
    return null;
  }
  const page = Array.isArray(list) ? list.find((t) => t.type === "page" && /^https?:\/\//i.test(t.url ?? "")) : undefined;
  if (!page?.url) return null;
  if (told.get(sessionId) === page.url) return null;
  told.set(sessionId, page.url);
  const title = (page.title ?? "").replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, 80);
  return `The Forge (the owner's side panel, a real browser) is showing ${title ? `the page titled "${title}" (quoted from the site) at ` : ""}${page.url.slice(0, 300)}. ` +
    `When the owner says "this page", "here", "this" or "on screen", they mean it: Browser state / screenshot / tree read it and every Browser action works on it as it is — no need to open it again.`;
}

/** Tests only. */
export function resetForgeScreenNotes(): void {
  told.clear();
}
