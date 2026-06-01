// Playwright adapter — the real engine, opt-in (Crix v5 / O6).
//
// Headless, sandboxable, daemon-capable — the only browser stack that works
// when the terminal is closed (which the Chrome MCP, being interactively
// authenticated, cannot). Loaded by DYNAMIC import so this package builds and
// the MockBrowser works with zero browser dependency. To enable the real engine:
//
//   pnpm add -w playwright && npx playwright install chromium
//
// Internals are loosely typed on purpose (the dependency may be absent at build
// time); the returned object is checked against the BrowserConnector contract.

import type { AccessibilityNode, BrowserConnector } from "./types.js";

export interface PlaywrightOptions {
  headless?: boolean;
}

export async function createPlaywrightBrowser(opts: PlaywrightOptions = {}): Promise<BrowserConnector> {
  const moduleName: string = "playwright";
  let pw: any;
  try {
    pw = await import(moduleName);
  } catch {
    throw new Error("Playwright is not installed. Run: pnpm add -w playwright && npx playwright install chromium");
  }

  const browser = await pw.chromium.launch({ headless: opts.headless ?? true });
  const page = await browser.newPage();

  const flatten = (node: any, out: AccessibilityNode[] = []): AccessibilityNode[] => {
    if (node && typeof node.role === "string") {
      out.push({ role: node.role, name: node.name, selector: node.name ? `${node.role}:${node.name}` : node.role });
    }
    for (const child of node?.children ?? []) flatten(child, out);
    return out;
  };

  return {
    name: "playwright",
    async navigate(url) {
      await page.goto(url);
      return { url: page.url(), title: await page.title() };
    },
    async accessibilityTree() {
      const snapshot = await page.accessibility.snapshot();
      return snapshot ? flatten(snapshot) : [];
    },
    async fillByLabel(label, value) {
      await page.getByLabel(label).fill(value);
    },
    async clickByRole(role, name) {
      await page.getByRole(role, { name }).click();
    },
    async screenshot() {
      const buffer: Buffer = await page.screenshot();
      return { format: "png", bytes: buffer.toString("base64") };
    },
    async state() {
      return { url: page.url(), title: await page.title() };
    },
    async close() {
      await browser.close();
    },
  };
}
