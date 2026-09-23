// A live browser page on the owner's phone — the pieces two surfaces share.
//
// The connect hub's sign-in browser (/connect/<flow>) and the watch/take-over
// view of Ares's own browser (/watch/<token>) both stream JPEG frames of ONE
// page and relay the owner's taps and typing into it. The input path is the
// security boundary of both — an unauthenticated capability URL driving a
// real browser — so it lives here once: taps are clamped to the viewport,
// typing is length-capped, keys are whitelisted, and navigation is https only.

export interface BrowserInput {
  type?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  dy?: number;
  url?: string;
}

export const ALLOWED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Space"]);

export function clamp01(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

/** Relay one whitelisted owner input into a Playwright page. Anything not on
 *  the list is dropped silently — the page is never told why. */
export async function applyBrowserInput(page: any, viewport: { width: number; height: number }, event: BrowserInput): Promise<void> {
  switch (event.type) {
    case "tap": {
      const x = clamp01(event.x) * viewport.width;
      const y = clamp01(event.y) * viewport.height;
      await page.mouse.click(x, y);
      return;
    }
    case "type":
      if (typeof event.text === "string" && event.text.length <= 500) await page.keyboard.type(event.text, { delay: 25 });
      return;
    case "key":
      if (event.key && ALLOWED_KEYS.has(event.key)) await page.keyboard.press(event.key === "Space" ? " " : event.key);
      return;
    case "scroll":
      await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, Number(event.dy) || 0)));
      return;
    case "back":
      await page.goBack({ timeout: 15_000 }).catch(() => undefined);
      return;
    case "reload":
      await page.reload({ timeout: 20_000 }).catch(() => undefined);
      return;
    case "goto": {
      const target = typeof event.url === "string" ? event.url.trim() : "";
      if (/^https:\/\//i.test(target)) await page.goto(target, { timeout: 30_000, waitUntil: "domcontentloaded" }).catch(() => undefined);
      return;
    }
  }
}

/** One JPEG of the page plus where it is. */
export async function captureFrame(page: any, quality = 60): Promise<{ jpeg: Buffer; url: string; title: string }> {
  return {
    jpeg: (await page.screenshot({ type: "jpeg", quality, timeout: 10_000 })) as Buffer,
    url: String(page.url()),
    title: String(await page.title().catch(() => "")),
  };
}

/** The page's CSS viewport, for mapping a tap's 0..1 coordinates to pixels. */
export function viewportOf(page: any, fallback = { width: 1280, height: 800 }): { width: number; height: number } {
  try {
    const size = page.viewportSize?.();
    if (size && size.width > 0 && size.height > 0) return size;
  } catch {
    // fall through
  }
  return fallback;
}

/** Layout for a full-screen live page: a top bar, the frame, a bottom input dock. */
export const LIVE_VIEW_CSS = `
html,body{height:100%;overflow:hidden}
.top{position:fixed;top:0;left:0;right:0;padding:calc(env(safe-area-inset-top) + .5rem) .75rem .5rem;background:#0b0d10ee;display:flex;gap:.5rem;align-items:center;z-index:2;border-bottom:1px solid #1d2229}
.top .site{flex:1;min-width:0}
.top .site b{display:block;font-size:.95rem}
.top .site span{display:block;font-size:.72rem;color:#7d8693;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{border:0;border-radius:999px;padding:.55rem .9rem;font-weight:650;font-size:.9rem;margin:0;width:auto}
.done{background:#3fd18b;color:#04140c}
.cancel{background:#1b2027;color:#c7cdd6}
#stage{position:fixed;left:0;right:0;top:3.6rem;bottom:7.6rem;display:flex;align-items:flex-start;justify-content:center;background:#000;touch-action:none}
#screen{max-width:100%;max-height:100%;display:block;user-select:none;-webkit-user-select:none}
#spinner{position:absolute;top:40%;color:#7d8693;font-size:.9rem}
.bottom{position:fixed;left:0;right:0;bottom:0;padding:.5rem .6rem calc(env(safe-area-inset-bottom) + .5rem);background:#0b0d10;border-top:1px solid #1d2229}
.row{display:flex;gap:.4rem}
.row input{flex:1;margin:0;padding:.65rem .75rem;font-size:16px}
.row button{margin:0;width:auto;padding:.6rem .8rem;border-radius:.7rem;font-size:.9rem}
.keys{margin-top:.45rem}
.keys button{flex:1;background:#1b2027;color:#dfe4ea;font-weight:600}
.hint{font-size:.72rem;color:#7d8693;text-align:center;margin:.35rem 0 0}
`;

/** The owner's input dock: a text box, Send, and the whitelisted keys. */
export const LIVE_INPUT_DOCK = `<div class="row"><input id="text" type="text" placeholder="Type here, then Send" autocomplete="off" autocapitalize="off" spellcheck="false"><button id="send">Send</button></div>
<div class="row keys"><button data-key="Enter">Enter</button><button data-key="Backspace">⌫</button><button data-key="Tab">Tab</button><button data-act="back">Back</button><button data-act="reload">↻</button></div>`;
