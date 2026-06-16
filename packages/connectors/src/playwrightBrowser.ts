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

  const executablePath = findInstalledChromium();
  // A PERSISTENT profile under ~/.ares — durable cookies/logins survive across
  // sessions and daemon restarts (so "log into my accounts / manage dashboards"
  // is possible), and pointing at the user's real Chrome/Edge build gives a
  // genuine fingerprint that passes most anti-bot checks a stock headless fails.
  const userDataDir = process.env.ARES_HOME
    ? path.join(process.env.ARES_HOME, "browser-profile")
    : path.join(os.tmpdir(), "ares-browser-profile");
  // Try each strategy in turn — detected exe, then Edge/Chrome channels, then
  // bundled Chromium — so a packaged app launches without `playwright install`.
  const baseOptions = { headless: opts.headless ?? true, viewport: { width: 1280, height: 800 } };
  let context: any;
  let lastError: unknown;
  for (const attempt of browserLaunchAttempts(executablePath)) {
    try {
      context = await pw.chromium.launchPersistentContext(userDataDir, { ...baseOptions, ...attempt.options });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!context) {
    throw new Error(
      `BROWSER_UNAVAILABLE: Playwright loaded, but no Edge/Chrome/Chromium runtime could launch. Last error: ${String(lastError)}`,
    );
  }
  const page = context.pages()[0] ?? (await context.newPage());

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
      await context.close();
    },
  };
}
