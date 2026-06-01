// MockBrowser — a deterministic in-memory BrowserConnector for tests and dry
// runs. No real browser, no dependency. Pages carry an accessibility tree and
// remember filled fields and clicks, so DOM-first flows (fill-by-label, click-
// by-role) and the filmstrip can be exercised end-to-end without Playwright.

import type { AccessibilityNode, BrowserConnector, BrowserState, Screenshot } from "./types.js";

export interface MockPage {
  url: string;
  title?: string;
  tree: AccessibilityNode[];
}

export class MockBrowser implements BrowserConnector {
  readonly name = "mock";
  private current: BrowserState = { url: "about:blank" };
  readonly filled: Array<{ label: string; value: string }> = [];
  readonly clicks: Array<{ role: string; name: string }> = [];
  private shotCount = 0;

  constructor(private readonly pages: Record<string, MockPage> = {}) {}

  async navigate(url: string): Promise<BrowserState> {
    const page = this.pages[url];
    this.current = { url, title: page?.title };
    return this.current;
  }

  async accessibilityTree(): Promise<AccessibilityNode[]> {
    return this.pages[this.current.url]?.tree ?? [];
  }

  async fillByLabel(label: string, value: string): Promise<void> {
    this.filled.push({ label, value });
  }

  async clickByRole(role: string, name: string): Promise<void> {
    this.clicks.push({ role, name });
  }

  async screenshot(): Promise<Screenshot> {
    this.shotCount++;
    // Deterministic fake frame: base64 of a description of current state.
    const payload = `mock-shot#${this.shotCount} url=${this.current.url} filled=${this.filled.length} clicks=${this.clicks.length}`;
    return { format: "png", bytes: Buffer.from(payload, "utf8").toString("base64"), width: 800, height: 600 };
  }

  async state(): Promise<BrowserState> {
    return this.current;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
