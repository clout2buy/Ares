// A BrowserConnector over the page driver (pageDriverSource.ts): Ares acts in
// the copy of a served page the owner has open — the Forge's frame in the
// browser preview — instead of launching a hidden browser and streaming it.
// Same-origin only: leaving the served folder means leaving this connector.
import type { AccessibilityNode, BrowserConnector, BrowserState, ConsoleEntry, PointerGesture, Screenshot } from "@ares/connectors";
import { PAGE_GONE, drivablePage, drivePage, rootChangedSince, waitForDrivablePage } from "./previewServer.js";

/** Where a loopback URL outside this connector's folder is served now (a dev
 *  server fronted by Ares, another served folder), with its open page. */
export interface ServedReroute {
  root: string;
  origin: string;
  url: string;
  page: { id: string; url: string };
}

export interface ServedPageOptions {
  /** Origins that ARE this page under another name: the dev server Ares
   *  fronts (http://127.0.0.1:5183 behind the served proxy origin), a
   *  remembered port re-served elsewhere. Navigating there stays here. */
  aliases?: Record<string, string>;
  /** Show another loopback address in the Forge and drive it from here on
   *  (any port on localhost / 127.0.0.1 / [::1]). Null when nothing answers. */
  reroute?: (url: string) => Promise<ServedReroute | null>;
}

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])$/i;

export function createServedPageBrowser(
  rootAtStart: string,
  originAtStart: string,
  page: { id: string; url: string },
  opts: ServedPageOptions = {},
): BrowserConnector {
  let root = rootAtStart;
  let origin = originAtStart;
  const aliases = new Map(Object.entries(opts.aliases ?? {}));
  let pageId = page.id;
  let lastUrl = page.url;
  // Always the newest open copy: a reload (Ares's own edit, the owner's ↻)
  // replaces the page, and commands must follow it rather than wait out a
  // copy that is gone. If the copy leaves mid-command, wait for the next one
  // and run it there once.
  // Act on the CURRENT code: if a file under the folder changed after this
  // copy loaded (the agent just edited it), reload once and use the new copy.
  // The Forge no longer reloads mid-turn on every edit, which used to load
  // half-applied changes between two edits and report their errors.
  const freshen = async (op: string): Promise<void> => {
    if (op === "navigate") return;
    const page = await drivablePage(root);
    if (!page || !(await rootChangedSince(root, page.loadedAt).catch(() => false))) return;
    const since = Date.now();
    await drivePage(root, page.id, "navigate", { url: page.url }, 5_000).catch(() => undefined);
    const next = await waitForDrivablePage(root, 10_000, { since });
    if (next) pageId = next.id;
  };
  const run = async <T>(op: string, args?: unknown, timeoutMs?: number): Promise<T> => {
    await freshen(op);
    const newest = await drivablePage(root);
    if (newest) pageId = newest.id;
    try {
      return (await drivePage(root, pageId, op, args, timeoutMs)) as T;
    } catch (err) {
      if (!(err instanceof Error && (err.message === PAGE_GONE || /no longer open/.test(err.message)))) throw err;
      const next = await waitForDrivablePage(root, 10_000);
      if (!next) throw new Error("the page closed or reloaded and did not come back");
      pageId = next.id;
      return (await drivePage(root, pageId, op, args, timeoutMs)) as T;
    }
  };
  const state = async (): Promise<BrowserState> => {
    const s = await run<BrowserState>("state");
    lastUrl = s.url;
    return s;
  };
  return {
    name: "forge-page",
    get strategy() {
      return `page:${origin}`;
    },
    async navigate(url: string): Promise<BrowserState> {
      let target = new URL(url, lastUrl || origin);
      const alias = aliases.get(target.origin);
      if (alias) target = new URL(`${target.pathname}${target.search}${target.hash}`, alias);
      if (target.origin !== origin) {
        // Field (Oct 20 - Nov 2): "http://127.0.0.1:5183/ is outside the served
        // folder" x7 — the owner's own dev server refused because the page in
        // the Forge was a different local origin. Any loopback port opens.
        const moved = LOOPBACK_HOST.test(target.hostname) && opts.reroute ? await opts.reroute(target.href) : null;
        if (!moved) {
          throw new Error(LOOPBACK_HOST.test(target.hostname)
            ? `Nothing is running at ${target.origin}. Start the project's dev server in the background, wait until it listens, then open ${target.href} again — it shows in the Forge.`
            : `${target.href} is a website, not this local page: open it with Browser {action:"open", url} and it shows in the Forge view.`);
        }
        aliases.set(target.origin, moved.origin);
        root = moved.root;
        origin = moved.origin;
        pageId = moved.page.id;
        lastUrl = moved.page.url;
        target = new URL(moved.url);
      }
      if (lastUrl && target.href === new URL(lastUrl).href) return state();
      const since = Date.now();
      await run("navigate", { url: target.href }, 5_000).catch(() => undefined);
      const next = await waitForDrivablePage(root, 10_000, { since });
      if (!next) throw new Error("the page did not come back after navigating");
      pageId = next.id;
      return state();
    },
    async accessibilityTree(): Promise<AccessibilityNode[]> {
      const nodes = await run<Array<{ role: string; name?: string; value?: string }>>("tree");
      return nodes.map((n) => ({ role: n.role, name: n.value ? `${n.name ?? ""} = ${n.value}` : n.name, selector: `${n.role}:${n.name ?? ""}` }));
    },
    async fillByLabel(label: string, value: string): Promise<void> { await run("fill", { label, value }); },
    async fillBySelector(selector: string, value: string): Promise<void> { await run("fill", { selector, value }); },
    async clickByRole(role: string, name: string): Promise<void> { await run("clickRole", { role, name }); },
    async clickByText(query: string): Promise<void> { await run("clickText", { query }); },
    async screenshot(): Promise<Screenshot> { return run<Screenshot>("screenshot", undefined, 20_000); },
    state,
    async close(): Promise<void> { /* the owner's page stays open */ },
    async consoleLogs(opts?: { onlyErrors?: boolean; limit?: number }): Promise<ConsoleEntry[]> {
      const logs = await run<Array<{ level: string; text: string; at: string }>>("console", opts ?? {});
      return logs.map((l) => ({ type: l.level, text: l.text, at: l.at }));
    },
    async evaluate(js: string): Promise<unknown> { return run("eval", { js }); },
    async press(keys: string, opts?: { holdMs?: number; repeat?: number }): Promise<void> {
      const ms = (opts?.holdMs ?? 0) * Math.max(1, opts?.repeat ?? 1);
      await run("press", { keys, holdMs: opts?.holdMs, repeat: opts?.repeat }, 30_000 + ms);
    },
    async pointer(gesture: PointerGesture): Promise<void> { await run("pointer", gesture); },
    async waitFor(until, timeoutMs): Promise<{ met: boolean; waitedMs: number }> {
      return run("waitFor", { ...until, timeoutMs }, timeoutMs + 5_000);
    },
  };
}
