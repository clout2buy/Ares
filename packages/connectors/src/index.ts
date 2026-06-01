// @crix/connectors — the reach into the world (Crix v5 / O6+).
//
// A vendor-neutral BrowserConnector (DOM-first + screenshot), browser actions
// as audited Effects (they flow through the O2 rails), and the screenshot
// filmstrip for visual proof. The engine is swappable: MockBrowser for tests,
// Playwright (opt-in) for real headless autonomy, more adapters later.

export type {
  BrowserConnector,
  AccessibilityNode,
  Screenshot,
  BrowserState,
} from "./types.js";

export { MockBrowser, type MockPage } from "./mockBrowser.js";

export { Filmstrip, type FilmstripEntry } from "./filmstrip.js";

export { navigateEffect, fillEffect, clickEffect, type BrowserEffectOptions } from "./effects.js";

export { createPlaywrightBrowser, type PlaywrightOptions } from "./playwrightBrowser.js";
