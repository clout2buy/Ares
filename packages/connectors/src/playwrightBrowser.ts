// Playwright adapter — the real engine, opt-in (Ares v5 / O6).
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

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccessibilityNode, BrowserConnector } from "./types.js";

export interface PlaywrightOptions {
  headless?: boolean;
}

export function findInstalledChromium(): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.PROGRAMFILES
            ? path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe")
            : "",
          process.env["PROGRAMFILES(X86)"]
            ? path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe")
            : "",
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe")
            : "",
          process.env.PROGRAMFILES
            ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")
            : "",
          process.env["PROGRAMFILES(X86)"]
            ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe")
            : "",
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
            : "",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];

  return candidates.find((candidate) => candidate && existsSync(candidate));
}

/** One browser-launch strategy: extra options merged into launchPersistentContext. */
export interface LaunchAttempt {
  label: string;
  options: { executablePath?: string; channel?: string };
}

/**
 * Ordered launch strategies, best fingerprint first, so the browser actually
 * starts on a real user's machine instead of demanding `playwright install`:
 *   1. the user's real Edge/Chrome by detected path (best anti-bot fingerprint),
 *   2/3. Playwright's channel lookup for msedge / chrome — finds installs the
 *        hardcoded path probe missed (per-user dirs, non-standard locations),
 *   4. Playwright's bundled Chromium — the floor that works whenever a browsers
 *      dir is present (PLAYWRIGHT_BROWSERS_PATH, e.g. the shipped Tauri runtime).
 * The first one that launches wins.
 */
export function browserLaunchAttempts(executablePath: string | undefined): LaunchAttempt[] {
  const attempts: LaunchAttempt[] = [];
  if (executablePath) attempts.push({ label: `executable:${executablePath}`, options: { executablePath } });
  attempts.push({ label: "channel:msedge", options: { channel: "msedge" } });
  attempts.push({ label: "channel:chrome", options: { channel: "chrome" } });
  attempts.push({ label: "bundled-chromium", options: {} });
  return attempts;
}

/** Parse Playwright's aria snapshot YAML (lines like `- button "Submit"`) into
 *  the {role, name, selector} nodes the connector contract uses. */
function parseAriaSnapshot(yaml: string): AccessibilityNode[] {
  const out: AccessibilityNode[] = [];
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim();
    const m = line.match(/^-\s+([a-z]+)(?:\s+"([^"]*)")?/i);
    if (!m) continue;
    const role = m[1];
    const name = m[2];
    out.push({ role, name, selector: name ? `${role}:${name}` : role });
  }
  return out;
}

/** A page plus how to release it — close() disconnects a CDP attach (the user's
 *  real browser keeps running) or closes a Playwright-launched context. */
export interface AcquiredPage {
  page: any;
  close: () => Promise<void>;
  /** Which strategy won, for diagnostics (e.g. "cdp:http://127.0.0.1:9222" or "launch:channel:msedge"). */
  strategy: string;
}

export interface AcquireOptions {
  /** Explicit CDP endpoint (ARES_BROWSER_CDP_URL). Tried first when set. */
  cdpUrl?: string;
  /** Opt-in localhost CDP auto-discovery (ARES_BROWSER_CDP_DISCOVERY=1). OFF by default. */
  discovery?: boolean;
  /** Ports to probe when discovery is on. Defaults to [9222]. */
  discoveryPorts?: number[];
  executablePath?: string;
  headless: boolean;
  userDataDir: string;
  viewport: { width: number; height: number };
}

/** Parse "9222,9223" → [9222, 9223]; undefined/empty → undefined. */
export function parseCdpPorts(raw: string | undefined): number[] | undefined {
  if (!raw) return undefined;
  const ports = raw
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p <= 65_535);
  return ports.length ? ports : undefined;
}

/**
 * Acquire a usable page by the configured strategy order:
 *   1. explicit CDP endpoint (attach to the user's REAL logged-in browser),
 *   2. opt-in localhost CDP discovery (gated — never grabs a random browser by default),
 *   3-6. launch a persistent-profile browser (detected exe → msedge → chrome → bundled).
 * Attaching reuses the existing context/page (real cookies, extensions, sessions);
 * close() only DISCONNECTS an attached browser, it never kills it.
 * Injectable `pw` (the Playwright module) so the ordering is unit-testable.
 */
export async function acquireBrowserPage(pw: any, opts: AcquireOptions): Promise<AcquiredPage> {
  const cdpTargets: string[] = [];
  if (opts.cdpUrl) cdpTargets.push(opts.cdpUrl);
  if (opts.discovery) {
    for (const port of opts.discoveryPorts ?? [9222]) cdpTargets.push(`http://127.0.0.1:${port}`);
  }
  for (const url of cdpTargets) {
    try {
      const browser = await pw.chromium.connectOverCDP(url, { timeout: 5_000 });
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      // close() on a CDP-connected browser disconnects Playwright; the real
      // browser the user launched keeps running.
      return { page, strategy: `cdp:${url}`, close: async () => { await browser.close(); } };
    } catch {
      // Unreachable / refused → try the next target, then fall back to launching.
    }
  }

  let lastError: unknown;
  for (const attempt of browserLaunchAttempts(opts.executablePath)) {
    try {
      const context = await pw.chromium.launchPersistentContext(opts.userDataDir, {
        headless: opts.headless,
        viewport: opts.viewport,
        ...attempt.options,
      });
      const page = context.pages()[0] ?? (await context.newPage());
      return { page, strategy: `launch:${attempt.label}`, close: async () => { await context.close(); } };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `BROWSER_UNAVAILABLE: no CDP endpoint reachable and no Edge/Chrome/Chromium runtime could launch. Last error: ${String(lastError)}`,
  );
}

export async function createPlaywrightBrowser(opts: PlaywrightOptions = {}): Promise<BrowserConnector> {
  const moduleName: string = "playwright";
  let pw: any;
  try {
    pw = await import(moduleName);
  } catch {
    // Terminal, non-actionable message ON PURPOSE: the model must NOT try to
    // "install" anything (that loops for minutes outside a dev checkout). It
    // should switch tools. Surfaced verbatim to the agent.
    throw new Error(
      "BROWSER_UNAVAILABLE: the headless browser is not available in this build. Do not attempt to install it. Use WebFetch to read page text, or ImageSearch to get image URLs, instead.",
    );
  }

  // A PERSISTENT profile under ~/.ares — durable cookies/logins survive across
  // sessions and daemon restarts (so "log into my accounts / manage dashboards"
  // is possible), and pointing at the user's real Chrome/Edge build gives a
  // genuine fingerprint that passes most anti-bot checks a stock headless fails.
  const userDataDir = process.env.ARES_HOME
    ? path.join(process.env.ARES_HOME, "browser-profile")
    : path.join(os.tmpdir(), "ares-browser-profile");
  // Prefer attaching to the user's REAL running browser (their logged-in profile,
  // cookies, extensions — the thing that actually beats Cloudflare/anti-bot) when
  // a CDP endpoint is configured; otherwise launch a persistent-profile browser.
  // Auto-discovery is OFF unless explicitly enabled — Ares never grabs a random
  // open browser on its own.
  const acquired = await acquireBrowserPage(pw, {
    cdpUrl: process.env.ARES_BROWSER_CDP_URL?.trim() || undefined,
    discovery: process.env.ARES_BROWSER_CDP_DISCOVERY === "1",
    discoveryPorts: parseCdpPorts(process.env.ARES_BROWSER_CDP_PORTS),
    executablePath: findInstalledChromium(),
    headless: opts.headless ?? true,
    userDataDir,
    viewport: { width: 1280, height: 800 },
  });
  const page = acquired.page;

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
      // Bounded waits — a stock 30s default means every miss is a half-minute hang.
      await page.goto(url, { timeout: 15_000, waitUntil: "domcontentloaded" });
      return { url: page.url(), title: await page.title() };
    },
    async accessibilityTree() {
      // page.accessibility was removed in newer Playwright — calling .snapshot()
      // on it threw "Cannot read properties of undefined (reading 'snapshot')".
      // Use it when present, else the modern aria snapshot (built for agents).
      if (page.accessibility?.snapshot) {
        const snapshot = await page.accessibility.snapshot().catch(() => null);
        if (snapshot) return flatten(snapshot);
      }
      const yaml: string = await page
        .locator("body")
        .ariaSnapshot()
        .catch(() => "");
      return parseAriaSnapshot(yaml);
    },
    async fillByLabel(label, value) {
      await page.getByLabel(label).first().fill(value, { timeout: 5_000 });
    },
    async clickByRole(role, name) {
      const locator = page.getByRole(role, { name });
      try {
        await locator.click({ timeout: 5_000 });
      } catch (err) {
        // Strict-mode multi-match throws immediately — fall back to the first
        // candidate instead of hanging/failing the whole action.
        const count = await locator.count().catch(() => 0);
        if (count > 1) await locator.first().click({ timeout: 5_000 });
        else throw err;
      }
    },
    async screenshot() {
      const buffer: Buffer = await page.screenshot();
      return { format: "png", bytes: buffer.toString("base64") };
    },
    async state() {
      return { url: page.url(), title: await page.title() };
    },
    async close() {
      await acquired.close();
    },
  };
}
