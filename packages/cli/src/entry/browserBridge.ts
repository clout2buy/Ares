// Extracted from entry.ts — browserBridge.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { stdout } from "node:process";
import { buildTool } from "@ares/tools";
import { z } from "zod";
import { loadUiSettings, type UiSettings } from "../uiSettings.js";
import { TrustGovernor } from "@ares/operator";
import { MemoryStore } from "@ares/mind";
import { Filmstrip, clickEffect, createPlaywrightBrowser, fillEffect, navigateEffect, challengePrompt, type BrowserConnector, type HumanCheckHandler } from "@ares/connectors";
import { Budget, KillSwitch, Ledger, ownerLeash, runEffect, type RailsContext, type BudgetLimits } from "@ares/effects";
import { CliRuntimeContext } from "./runtime.js";

// ── Embedded-browser bridge: the daemon ⇄ UI request/response channel that lets
// the agent drive Ares's OWN in-app browser (the same-origin iframe in the Forge).
// exec() emits a webview_cmd event to stdout (→ UI), and awaits the matching
// webview_result command the UI sends back. No Playwright — the page renders and
// runs IN the Ares window.
interface WebviewResult { ok: boolean; result?: unknown; error?: string; }

class EmbeddedBrowserBridge {
  private readonly pending = new Map<string, (r: WebviewResult) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;
  emit: ((obj: Record<string, unknown>) => void) | null = null;
  get attached(): boolean { return this.emit !== null; }
  exec(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<WebviewResult> {
    if (!this.emit) return Promise.resolve({ ok: false, error: "embedded browser unavailable — open the Ares desktop window" });
    const cmdId = `wv_${process.pid}_${++this.seq}`;
    return new Promise<WebviewResult>((resolve) => {
      this.pending.set(cmdId, resolve);
      this.timers.set(cmdId, setTimeout(() => {
        this.pending.delete(cmdId); this.timers.delete(cmdId);
        resolve({ ok: false, error: "embedded browser timed out" });
      }, timeoutMs));
      this.emit!({ type: "webview_cmd", cmdId, op, ...args });
    });
  }
  resolve(cmdId: string, payload: WebviewResult): void {
    const r = this.pending.get(cmdId);
    if (!r) return;
    const t = this.timers.get(cmdId);
    if (t) clearTimeout(t);
    this.pending.delete(cmdId); this.timers.delete(cmdId);
    r(payload);
  }
}

export const embeddedBridge = new EmbeddedBrowserBridge();

const browserInput = z
  .object({
    action: z
      .enum(["open", "preview", "tree", "screenshot", "fill", "fill_selector", "click", "click_text", "console", "eval", "state", "close", "filmstrip"])
      .describe(
        "Browser action. DOM-first web actions: open/tree/fill/click/screenshot/state/close. " +
        "PREVIEW & VERIFY (drives a VISIBLE browser with an animated cursor so the owner watches Ares test the UI): " +
        "'preview' opens a URL visibly; 'click_text' clicks a button/link/tab by visible text or CSS selector; " +
        "'fill_selector' types into a CSS selector; 'console' reads console logs/errors after acting; " +
        "'eval' runs JS in the page to inspect state or call a function.",
      ),
    url: z.string().optional().describe("URL for open/preview (e.g. http://localhost:1420)."),
    label: z.string().optional().describe("Accessible label for fill."),
    value: z.string().optional().describe("Value for fill / fill_selector."),
    role: z.string().optional().describe("ARIA role for click."),
    name: z.string().optional().describe("Accessible name for click."),
    query: z.string().optional().describe("Visible text or CSS selector for click_text."),
    selector: z.string().optional().describe("CSS selector for fill_selector."),
    js: z.string().optional().describe("JS expression/IIFE to run in the page for eval (e.g. 'document.querySelectorAll(\".item\").length')."),
    onlyErrors: z.boolean().optional().describe("console: return only errors/warnings."),
    engine: z.enum(["playwright", "embedded"]).optional().describe(
      "Which browser: 'playwright' (default) drives a streamed headless browser for ANY url (localhost dev servers, real web). " +
      "'embedded' renders self-contained HTML you pass via `html` INSIDE the Ares window (same-origin) and drives it directly — use this to test the apps/games/UIs YOU build as a single .html, with a real visible cursor and zero popup. " +
      "Embedded actions: preview(html) to load, then click_text/fill_selector/eval/console/screenshot(snapshot).",
    ),
    html: z.string().optional().describe("Self-contained HTML to render in the embedded browser (engine:'embedded', action:'preview')."),
    headless: z.boolean().optional().describe("Run headless (invisible). DEFAULT true for plain web tasks — the owner does NOT want to watch navigation. The 'preview' action overrides this to VISIBLE so the owner can watch the UI test. Pass false to watch any action."),
    note: z.string().optional().describe("Optional note attached to screenshot frames."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum tree/filmstrip/console entries returned."),
  })
  .strict();

interface BrowserToolOutput {
  action: string;
  status: string;
  result?: unknown;
  filmstripDir: string;
}

export function makeBrowserTool(
  context: CliRuntimeContext,
  createBrowser: typeof createPlaywrightBrowser = createPlaywrightBrowser,
) {
  let browser: BrowserConnector | null = null;
  let filmstrip: Filmstrip | null = null;
  let sequence = 0;
  // Set per-call to the current turn's progress emitter, so the persistent
  // browser streams its live frames into THIS turn's UI panel.
  let frameSink: ((jpegBase64: string) => void) | null = null;

  const ensureBrowser = async (headless?: boolean): Promise<BrowserConnector> => {
    if (browser) {
      try {
        await browser.state();
      } catch (error) {
        // Users routinely close the visible preview window. Retaining that dead
        // connector made every subsequent action fail with "Target page,
        // context or browser has been closed". Re-acquire transparently on the
        // next call; unrelated state errors still surface honestly.
        if (!isClosedBrowserError(error)) throw error;
        await browser.close().catch(() => undefined);
        browser = null;
      }
    }
    if (!browser) {
      // CAPTCHA handoff: a challenge surfaces through the SAME Gate as approvals
      // (so it renders on Telegram/UI). The owner solves it in their CDP-attached
      // Chrome and approves → "solved"; deny → "skip". No Gate wired (plain CLI)
      // → challenges are detected but navigation just proceeds.
      const requestApproval = context.approvals?.requestApproval;
      const onChallenge: HumanCheckHandler | undefined = requestApproval
        ? async (info) => {
            const decision = await requestApproval({
              id: `captcha:${info.url}`.slice(0, 200),
              kind: "human-check",
              domain: "browser",
              irreversibility: "reversible",
              reason: challengePrompt(info),
            });
            return decision.verb === "deny" ? "skip" : "solved";
          }
        : undefined;
      browser = await createBrowser({
        headless: headless ?? true,
        onChallenge,
        onFrame: (jpeg) => frameSink?.(jpeg),
        paceMs: Number(process.env.ARES_BROWSER_PACE_MS) || 480,
      });
    }
    return browser;
  };

  const ensureFilmstrip = (): Filmstrip => {
    if (!filmstrip) {
      const dir = path.join(context.browserFilmstripRoot, `${new Date().toISOString().slice(0, 10)}-${process.pid}`);
      filmstrip = new Filmstrip(dir);
    }
    return filmstrip;
  };

  return buildTool({
    name: "Browser",
    description:
      "Ares's DOM-first eyes and hands for the web. Use APIs/MCP/CLI first when better, then this browser connector to open pages, inspect the accessibility tree, fill forms, click controls, screenshot, and record visual proof. Run HEADLESS by default (the owner does not want to see the browser) — only open it visibly (headless:false) when they explicitly ask to watch. When the task is to find/show images, gather the image URLs and put them in your reply; the chat renders image URLs as inline pictures. VERIFYING AN HTML APP YOU BUILT: write it to a .html file, then `preview` it (pass `html` to render it via a temp file, or pass a file `url`) and `screenshot` to SEE it — this is reliable; do NOT burn turns on the embedded engine's inline render. BUILDING HTML PAGES/DASHBOARDS: make them fully self-contained — inline ALL JS/CSS; never load libraries from a CDN (<script src=\"https://cdn...\">). The embedded webview and offline machines block remote scripts, so CDN-backed charts render as blank canvases while the rest of the page looks fine. Draw charts with inline SVG or hand-rolled canvas code instead of Chart.js-from-CDN. `eval` runs in the page's GLOBAL scope — it CANNOT read `let`/`const` declared inside a <script> block, so don't probe those; expose state on `window.*` (e.g. `window.app = state`) or read the DOM. After a `click`/`click_text`, `screenshot` again to confirm the change actually landed. A text 'snapshot' is NOT visual proof: canvas/WebGL content is invisible in it — only a real screenshot (pixels) verifies rendering.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: browserInput,
    activityDescription: (i) => {
      // Label honestly: opening a local file or driving the in-app page is NOT
      // "Browsing the web" — that wording made users think Ares went to the
      // internet instead of opening their file (bug report 4c5f1efc).
      const embedded = i.engine === "embedded" || (!i.url && !!i.html);
      const target = (u?: string) => {
        if (!u) return embedded ? "your page in the Ares window" : "a page";
        try {
          const parsed = new URL(u.includes("://") ? u : `https://${u}`);
          if (parsed.protocol === "file:")
            return `local file ${decodeURIComponent(parsed.pathname.split("/").pop() ?? "")}`.trim();
          if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return `local app ${parsed.host}`;
          return parsed.host.replace(/^www\./, "") || u;
        } catch {
          return u;
        }
      };
      if (i.action === "open") return `Opening ${target(i.url)}`;
      if (i.action === "preview") return `Previewing ${target(i.url)}`;
      if (i.action === "tree") return "Reading the page";
      if (i.action === "screenshot" || i.action === "filmstrip") return embedded ? "Reading the in-app page" : "Capturing the screen";
      if (i.action === "fill") return i.label ? `Filling “${i.label}”` : "Filling a field";
      if (i.action === "fill_selector") return i.selector ? `Typing into ${i.selector}` : "Filling a field";
      if (i.action === "click") return i.name ? `Clicking “${i.name}”` : "Clicking a control";
      if (i.action === "click_text") return i.query ? `Clicking “${i.query}”` : "Clicking a control";
      if (i.action === "console") return "Reading the console";
      if (i.action === "eval") return "Testing in the page";
      if (i.action === "state") return "Checking the page state";
      if (i.action === "close") return "Closing the browser";
      return embedded ? "Using the in-app browser" : "Browsing the web";
    },

    async call(i, ctx): Promise<{ output: BrowserToolOutput; display: string; images?: Array<{ mediaType: string; data: string }> }> {
      const strip = ensureFilmstrip();
      const emitTarget = (state: { url?: string; title?: string }) => {
        if (state.url) ctx?.emitProgress?.({ kind: "browser_target", url: state.url, title: state.title ?? "" });
      };
      // Route the browser's live frames into THIS turn's UI panel (the embedded
      // browser the owner watches). Cleared when the call ends.
      frameSink = ctx?.emitProgress
        ? (jpeg) => ctx.emitProgress?.({ kind: "browser_frame", image: jpeg } as Record<string, unknown>)
        : null;

      // ── EMBEDDED ENGINE — drive Ares's own in-app browser (same-origin HTML) ──
      if (i.engine === "embedded") {
        const done = (status: string, result: unknown, display: string) =>
          ({ output: { action: i.action, status, result, filmstripDir: filmstripDir(strip) } as BrowserToolOutput, display });
        const snap = async () => (await embeddedBridge.exec("snapshot")).result;
        if (i.action === "preview" || i.action === "open") {
          if (!i.html) throw new Error("embedded preview requires `html` (the self-contained page to render)");
          const r = await embeddedBridge.exec("load", { html: i.html });
          if (!r.ok) throw new Error(r.error ?? "embedded load failed");
          return done("ok", await snap(), "rendered in the embedded browser");
        }
        if (i.action === "click" || i.action === "click_text") {
          const r = await embeddedBridge.exec("click", { query: i.query ?? i.name ?? "" });
          if (!r.ok) throw new Error((r.result as { error?: string })?.error ?? r.error ?? "click failed");
          return done("ok", { click: r.result, page: await snap() }, `clicked "${i.query ?? i.name}"`);
        }
        if (i.action === "fill" || i.action === "fill_selector") {
          const r = await embeddedBridge.exec("type", { selector: i.selector ?? i.label ?? "", value: i.value ?? "" });
          if (!r.ok) throw new Error((r.result as { error?: string })?.error ?? r.error ?? "fill failed");
          return done("ok", r.result, `typed into ${i.selector ?? i.label}`);
        }
        if (i.action === "eval") {
          if (!i.js) throw new Error("eval requires js");
          const r = await embeddedBridge.exec("eval", { js: i.js });
          return done(r.ok ? "ok" : "error", r.result, "eval");
        }
        if (i.action === "console") {
          const r = await embeddedBridge.exec("console", { onlyErrors: i.onlyErrors });
          if (!r.ok) throw new Error(r.error ?? "embedded console failed");
          const logs = (r.result as unknown[]) ?? [];
          return done("ok", logs, `${logs.length} console entr${logs.length === 1 ? "y" : "ies"}`);
        }
        // tree / screenshot / state / snapshot → the page's DOM-text snapshot.
        const r = await embeddedBridge.exec("snapshot");
        // A dead bridge used to fall through as status:"ok" with an undefined
        // result in ~1ms — the model then "verified" pages it never saw.
        if (!r.ok) throw new Error(r.error ?? "embedded snapshot failed");
        if (i.action === "screenshot") {
          // The embedded engine has NO pixel capture. Never dress a DOM-text
          // dump up as a screenshot: canvas/WebGL/chart content is invisible in
          // text, so "status ok" here let models claim charts rendered when all
          // four canvases were blank (bug f0bbee26). Degrade loudly instead.
          return done(
            "degraded",
            {
              warning:
                "TEXT SNAPSHOT ONLY — the embedded engine cannot capture pixels. Canvas/WebGL/chart content is INVISIBLE here; do NOT claim anything rendered correctly based on this. To actually see the page, use action:'preview' with the playwright engine (pass the html or a file url) — that returns a real screenshot.",
              snapshot: r.result,
            },
            "text snapshot only — no pixels (use playwright preview to SEE the page)",
          );
        }
        return done("ok", r.result, "snapshot");
      }

      if (i.action === "filmstrip") {
        const result = (await strip.load()).slice(-(i.limit ?? 20));
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: `filmstrip ${result.length} frame(s)`,
        };
      }

      if (i.action === "close") {
        if (browser) await browser.close();
        browser = null;
        return {
          output: { action: i.action, status: "closed", filmstripDir: filmstripDir(strip) },
          display: "browser closed",
        };
      }

      // 'preview' drives a VISIBLE browser so the owner watches Ares test the UI.
      const br = await ensureBrowser(i.action === "preview" ? false : i.headless);

      if (i.action === "tree") {
        const result = (await br.accessibilityTree()).slice(0, i.limit ?? 80);
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: `accessibility tree: ${result.length} node(s)`,
        };
      }

      if (i.action === "state") {
        const result = await br.state();
        emitTarget(result);
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: `${result.title ?? "(untitled)"} ${result.url}`,
        };
      }

      if (i.action === "screenshot") {
        const [shot, state] = await Promise.all([br.screenshot(), br.state()]);
        emitTarget(state);
        const frame = await strip.record({ action: "manual screenshot", url: state.url, screenshot: shot, note: i.note });
        return {
          output: { action: i.action, status: "ok", result: frame, filmstripDir: filmstripDir(strip) },
          display: `screenshot frame ${frame.frame}`,
          // Hand the actual pixels to the model — without this it browses blind
          // off the accessibility tree alone and can't verify a click or read a
          // layout-dependent page. The viewport is 1280×800, under the vision limit.
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }

      // ── PREVIEW / VERIFY loop — visible cursor, click by text, console, eval ──
      if (i.action === "preview") {
        let url = i.url;
        if (!url && i.html) {
          // Inline HTML → write to a temp .html and open it. The reliable way to
          // preview a self-contained page (the embedded engine's inline render is
          // flaky — agents waste turns on its blank result; a real file always works).
          const tmp = path.join(os.tmpdir(), `ares-preview-${Date.now()}.html`);
          await writeFile(tmp, i.html, "utf8");
          url = pathToFileURL(tmp).href;
        }
        if (!url) throw new Error("Browser preview requires `url` (or `html` to render inline)");
        await br.navigate(url);
        const [shot, state] = await Promise.all([br.screenshot(), br.state()]);
        emitTarget(state);
        const frame = await strip.record({ action: "preview", url: state.url, screenshot: shot, note: i.note });
        return {
          output: { action: i.action, status: "ok", result: { ...state, frame: frame.frame }, filmstripDir: filmstripDir(strip) },
          display: `preview ${state.url}`,
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }

      if (i.action === "click_text") {
        if (!i.query) throw new Error("Browser click_text requires query (visible text or CSS selector)");
        if (!br.clickByText) throw new Error("click_text not supported by this browser");
        await br.clickByText(i.query);
        const [shot, state] = await Promise.all([br.screenshot(), br.state()]);
        emitTarget(state);
        await strip.record({ action: `click ${i.query}`, url: state.url, screenshot: shot });
        return {
          output: { action: i.action, status: "ok", result: state, filmstripDir: filmstripDir(strip) },
          display: `clicked "${i.query}"`,
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }

      if (i.action === "fill_selector") {
        if (!i.selector || i.value === undefined) throw new Error("Browser fill_selector requires selector and value");
        if (!br.fillBySelector) throw new Error("fill_selector not supported by this browser");
        await br.fillBySelector(i.selector, i.value);
        return {
          output: { action: i.action, status: "ok", filmstripDir: filmstripDir(strip) },
          display: `filled ${i.selector}`,
        };
      }

      if (i.action === "console") {
        if (!br.consoleLogs) throw new Error("console not supported by this browser");
        const logs = await br.consoleLogs({ onlyErrors: i.onlyErrors, limit: i.limit ?? 40 });
        return {
          output: { action: i.action, status: "ok", result: logs, filmstripDir: filmstripDir(strip) },
          display: `${logs.length} console entr${logs.length === 1 ? "y" : "ies"}${i.onlyErrors ? " (errors)" : ""}`,
        };
      }

      if (i.action === "eval") {
        if (!i.js) throw new Error("Browser eval requires js");
        if (!br.evaluate) throw new Error("eval not supported by this browser");
        const result = await br.evaluate(i.js);
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: "eval ok",
        };
      }

      const rails = await browserRailsContext(context);
      const idemPrefix = `browser:${process.pid}:${Date.now()}:${sequence++}`;
      if (i.action === "open") {
        if (!i.url) throw new Error("Browser open requires url");
        const effect = navigateEffect(br, i.url, { filmstrip: strip, idemPrefix });
        const result = await runEffect(effect, rails);
        emitTarget(await br.state());
        return {
          output: { action: i.action, status: result.status, result, filmstripDir: filmstripDir(strip) },
          display: `open ${i.url}: ${result.status}`,
        };
      }

      if (i.action === "fill") {
        if (!i.label) throw new Error("Browser fill requires label");
        if (i.value === undefined) throw new Error("Browser fill requires value");
        const effect = fillEffect(br, i.label, i.value, { filmstrip: strip, idemPrefix });
        const result = await runEffect(effect, rails);
        return {
          output: { action: i.action, status: result.status, result, filmstripDir: filmstripDir(strip) },
          display: `fill ${i.label}: ${result.status}`,
        };
      }

      if (!i.role || !i.name) throw new Error("Browser click requires role and name");
      const effect = clickEffect(br, i.role, i.name, { filmstrip: strip, idemPrefix });
      const result = await runEffect(effect, rails);
      return {
        output: { action: i.action, status: result.status, result, filmstripDir: filmstripDir(strip) },
        display: `click ${i.role}:${i.name}: ${result.status}`,
      };
    },
  });
}

function isClosedBrowserError(error: unknown): boolean {
  return /target (?:page|context|browser) has been closed|browser has been closed|page has been closed/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * V8 — which leash governs outward effects:
 *   guarded (default): autonomy is earned through the TrustGovernor.
 *   unleashed (dangerousBypass: true): the owner's dial, wide open.
 *   derives each domain's leash from the Crucible (confirmed procedures with
 *   net-positive records), and every level change lands in leash.jsonl next to
 *   the effects ledger with the evidence that justified it.
 */
async function resolveLeash(context: CliRuntimeContext): Promise<(domain: string) => number> {
  const settings = await loadUiSettings();
  if (settings.dangerousBypass === true) return ownerLeash();
  try {
    const store = await MemoryStore.open(context.mind.memoryFile);
    const leashLog = path.join(context.effects.effectsDir, "leash.jsonl");
    const governor = new TrustGovernor({
      nodes: () => store.all(),
      append: (change) =>
        mkdir(path.dirname(leashLog), { recursive: true })
          .then(() => appendFile(leashLog, JSON.stringify(change) + "\n"))
          .catch(() => undefined),
    });
    return (domain) => governor.leashOf(domain);
  } catch {
    // No readable memory: guarded mode falls back to the shortest leash.
    return ownerLeash({ trust: 1 });
  }
}

/** Budget ceilings from env — ARES_BUDGET_DAILY (dollars) and ARES_BUDGET_PER_DOMAIN
 *  ("domain=amount,domain2=amount2"). Mirrors the ARES_OPERATOR_* env-config
 *  convention used elsewhere in this file rather than a UiSettings field, since
 *  the budget ceiling is an operator-wide guardrail, not a per-session UI knob. */
function budgetLimitsFromEnv(): BudgetLimits {
  const limits: BudgetLimits = {};
  const daily = Number(process.env.ARES_BUDGET_DAILY);
  if (Number.isFinite(daily) && daily > 0) limits.daily = daily;
  const perDomainRaw = process.env.ARES_BUDGET_PER_DOMAIN;
  if (perDomainRaw) {
    const perDomain: Record<string, number> = {};
    for (const pair of perDomainRaw.split(",")) {
      const [domain, amountRaw] = pair.split("=").map((v) => v.trim());
      const amount = Number(amountRaw);
      if (domain && Number.isFinite(amount) && amount > 0) perDomain[domain] = amount;
    }
    if (Object.keys(perDomain).length) limits.perDomain = perDomain;
  }
  return limits;
}

async function browserRailsContext(context: CliRuntimeContext): Promise<RailsContext> {
  const paths = context.effects;
  return {
    ledger: await Ledger.open(paths.ledgerFile),
    // The ceiling only bites once some effect actually carries a nonzero
    // EffectCost.dollars — none do today (see EffectCost in @ares/effects).
    // This wiring makes the ceiling REAL and configurable for when that
    // changes; it is not an active spend guard yet.
    budget: new Budget(budgetLimitsFromEnv()),
    killSwitch: new KillSwitch(paths.killSwitchFile),
    leashOf: await resolveLeash(context),
    // When the gateway is up, a staged effect pauses for the owner instead of
    // being silently held. Absent it, the rails keep legacy hold-never-commit.
    requestApproval: context.approvals?.requestApproval,
  };
}

function filmstripDir(strip: Filmstrip): string {
  return (strip as unknown as { dir?: string }).dir ?? "filmstrip";
}
