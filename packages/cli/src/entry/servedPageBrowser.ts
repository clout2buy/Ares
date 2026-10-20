// A BrowserConnector over the page driver (pageDriverSource.ts): Ares acts in
// the copy of a served page the owner has open — the Forge's frame in the
// browser preview — instead of launching a hidden browser and streaming it.
// Same-origin only: leaving the served folder means leaving this connector.
import type { AccessibilityNode, BrowserConnector, BrowserState, ConsoleEntry, PointerGesture, Screenshot } from "@ares/connectors";
import { PAGE_GONE, drivablePage, drivePage, waitForDrivablePage } from "./previewServer.js";

export function createServedPageBrowser(root: string, origin: string, page: { id: string; url: string }): BrowserConnector {
  let pageId = page.id;
  let lastUrl = page.url;
  // Always the newest open copy: a reload (Ares's own edit, the owner's ↻)
  // replaces the page, and commands must follow it rather than wait out a
  // copy that is gone. If the copy leaves mid-command, wait for the next one
  // and run it there once.
  const run = async <T>(op: string, args?: unknown, timeoutMs?: number): Promise<T> => {
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
    strategy: `page:${origin}`,
    async navigate(url: string): Promise<BrowserState> {
      const target = new URL(url, lastUrl || origin);
      if (target.origin !== origin) throw new Error(`${target.href} is outside the served folder (${origin}); the Forge page can only go to its own pages`);
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
