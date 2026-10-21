// The vendor-neutral browser interface (Ares v5 / O6 / concept C6).
//
// Ares owns this interface; the engine (Playwright, Chrome MCP, …) is a
// swappable adapter. DOM-first by design — find elements by role/label from the
// accessibility tree (precise, robust) and fall to pixels/vision only when
// structure can't express the target. Every adapter implements this same shape,
// so the rest of Ares never knows or cares which browser is underneath.

export interface AccessibilityNode {
  role: string;
  name?: string;
  /** A stable handle the connector can act on (label, role+name, or selector). */
  selector: string;
}

export interface Screenshot {
  format: "png";
  /** base64-encoded image bytes. */
  bytes: string;
  width?: number;
  height?: number;
}

export interface BrowserState {
  url: string;
  title?: string;
}

export interface ConsoleEntry {
  /** log | info | warn | error | debug */
  type: string;
  text: string;
  /** ISO timestamp when captured. */
  at: string;
}

/** What the page did on the network since Ares attached (Browser network). */
export interface NetworkReport {
  /** Requests that never got a response (DNS, refused, blocked, aborted). */
  failed: Array<{ url: string; method: string; error: string; at: string }>;
  /** Responses with status >= 400. */
  httpErrors: Array<{ url: string; method: string; status: number; at: string }>;
  /** WebSockets the page opened: what flowed and how they ended. */
  sockets: Array<{
    url: string;
    open: boolean;
    sent: number;
    received: number;
    /** Binary frames either way — a page doing JSON.parse(ev.data) on a Blob fails silently. */
    binary: number;
    last: Array<{ dir: "in" | "out"; type: "text" | "binary"; size: number; text?: string }>;
    /** How it closed, from the page's own close event (code + reason). */
    close?: { code: number; reason: string; clean: boolean };
    error?: string;
  }>;
}

/** A keyboard / pointer gesture at viewport CSS coordinates (canvas games, maps, drawing). */
export interface PointerGesture {
  kind: "click" | "double" | "move" | "down" | "up" | "drag" | "wheel";
  x: number;
  y: number;
  toX?: number;
  toY?: number;
  dx?: number;
  dy?: number;
  button?: "left" | "right" | "middle";
}

export interface BrowserConnector {
  readonly name: string;
  /** How this browser was acquired: "cdp:<url>" = attached to a real, already-
   *  running browser (the user's logged-in session); "launch:<label>" = a
   *  browser Ares launched itself (its own persistent profile). Lets callers
   *  tell the owner WHOSE browser the tabs/actions belong to. */
  readonly strategy?: string;
  navigate(url: string): Promise<BrowserState>;
  /** DOM-first targeting: the structured tree, preferred over pixels. */
  accessibilityTree(): Promise<AccessibilityNode[]>;
  fillByLabel(label: string, value: string): Promise<void>;
  clickByRole(role: string, name: string): Promise<void>;
  screenshot(): Promise<Screenshot>;
  state(): Promise<BrowserState>;
  close(): Promise<void>;
  /** Click the first element matching a CSS selector or visible text — the
   *  flexible path for verifying UI (buttons, links, tabs). Animates the cursor. */
  clickByText?(query: string): Promise<void>;
  /** Type into an element by CSS selector (when label targeting won't reach it). */
  fillBySelector?(selector: string, value: string): Promise<void>;
  /** Captured console output since the page loaded — read errors after acting. */
  consoleLogs?(opts?: { onlyErrors?: boolean; limit?: number }): Promise<ConsoleEntry[]>;
  /** Evaluate JS in the page and return the JSON-serializable result — inspect
   *  state, call functions, verify behavior. */
  evaluate?(js: string): Promise<unknown>;
  /** Tabs currently reachable through the browser control channel. This is
   *  intentionally metadata-only: cookies and storage never leave the browser. */
  tabs?(): Promise<Array<{ index: number; url: string; title?: string; active: boolean }>>;
  /** Rebind this connector to an already-open tab. Returns false when no tab
   *  matches, allowing the caller to navigate the Ares-owned page instead. */
  attachToExisting?(query: string): Promise<boolean>;
  /** The engine page Ares is driving RIGHT NOW (it changes on attach). For
   *  the owner's live watch/take-over view only — frames and whitelisted
   *  input for that one page. */
  livePage?(): unknown;
  /** Put a secret into a field in one step: no per-character typing, no
   *  frames emitted, no value in any returned text. Rejects when the field
   *  isn't there. The caller redacts errors. */
  fillSecret?(target: { selector?: string; label?: string }, value: string): Promise<void>;
  /** Submit the form owning `selector` (else click its submit button). */
  submitForm?(selector: string): Promise<boolean>;
  /** Real keyboard input: "Enter", "Control+L", "ArrowLeft", "w"; holdMs keeps
   *  it down (a game's move), repeat presses it again. */
  press?(keys: string, opts?: { holdMs?: number; repeat?: number }): Promise<void>;
  /** Mouse at exact viewport coordinates — for canvas/WebGL where there is no DOM to target. */
  pointer?(gesture: PointerGesture): Promise<void>;
  /** Wait until the page shows something (the owner signed in, a level loaded). */
  waitFor?(until: { url?: string; text?: string; selector?: string; gone?: boolean }, timeoutMs: number, signal?: AbortSignal): Promise<{ met: boolean; waitedMs: number }>;
  /** Failed requests, HTTP errors and WebSocket traffic since attach. */
  network?(opts?: { limit?: number }): Promise<NetworkReport>;
  /** DevTools in one call: uncaught errors with stacks, console errors, failed
   *  requests, long tasks, a frame-rate sample and page metrics (heap, DOM
   *  nodes, layouts) — what a person reads off the Console + Performance tabs. */
  devtools?(): Promise<DevtoolsReport>;
  /** A CPU profile over `ms`: where the page's time goes, by function. */
  profile?(ms: number): Promise<ProfileReport>;
}

export interface DevtoolsReport {
  /** Uncaught exceptions and unhandled rejections, newest last, with stacks. */
  errors: Array<{ message: string; stack?: string; at: string }>;
  /** console.error / console.warn tail. */
  console: ConsoleEntry[];
  failedRequests: NetworkReport["failed"];
  httpErrors: NetworkReport["httpErrors"];
  /** Main-thread tasks over 50 ms seen by the page (PerformanceObserver). */
  longTasks: Array<{ ms: number; at: number }>;
  /** rAF frames per second over a short sample (null when the page is hidden). */
  fps: number | null;
  metrics: { jsHeapMb?: number; domNodes?: number; layouts?: number; styleRecalcs?: number; listeners?: number; documents?: number; frames?: number };
  url: string;
}

export interface ProfileReport {
  sampledMs: number;
  /** Hottest functions by self time, as a share of sampled time. */
  top: Array<{ fn: string; where: string; selfMs: number; pct: number }>;
  /** Share of samples in (idle), (program) and (garbage collector). */
  idlePct: number;
  gcPct: number;
}
