// ComputerUse — drive the REAL desktop: screenshot, move, click, type, key,
// scroll. The capability that turns "an agent that types" into "an agent that
// operates your machine" — delete a Chrome extension, click through a native
// dialog, drive an app that has no API.
//
// Windows-first and ZERO new dependencies: it shells out to the built-in
// PowerShell + .NET (System.Windows.Forms / System.Drawing + a tiny user32
// P/Invoke). No nut.js, no robotjs, no native module to install — so it can
// never hit the "install loop" the headless browser used to. On non-Windows
// hosts it returns a terminal, non-retriable error telling the model to stop.
//
// Screenshots come back as IMAGE tool-results (EngineToolResult.images), so a
// vision-capable model literally sees the pixels and can act on what's on screen.

import { z } from "zod";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildTool } from "./_shared.js";

const inputSchema = z
  .object({
    action: z
      .enum([
        "screenshot",
        "zoom",
        "window",
        "windows",
        "move",
        "click",
        "double_click",
        "right_click",
        "type",
        "key",
        "scroll",
        "cursor",
        "launch",
        "activate",
      ])
      .describe(
        "screenshot: capture the whole screen (downscaled, returned as an image you can see). window: capture ONLY the focused window — cleaner than a full multi-monitor shot when working in one app; clicks still map. windows: list the open top-level windows (title, process, position, minimized/visible) so you can pick what to activate/capture instead of guessing a title. zoom: capture a rectangle at x,y of size w×h so small text/targets are legible and precisely clickable. move: move cursor to x,y. click/double_click/right_click: at x,y (or current position). type: send literal text. key: a key combo — SendKeys notation (^c=Ctrl+C, %{F4}=Alt+F4, {ENTER}, {TAB}, ~=Enter) OR a Windows-key chord like 'WIN', 'WIN+R', 'WIN+I'. scroll: wheel by amount (negative=down). cursor: report the current cursor position. launch: start an app/URI (text=program, a common name like 'settings'/'notepad'/'calc', or a ms-settings:/chrome:// URI; key=optional arguments) — use this to OPEN things, never the Win key. activate: bring a window to the foreground by title substring (text).",
      ),
    x: z.number().int().optional().describe("Target X for move/click/zoom — in the pixel coordinates of the LAST image you were shown (top-left origin)."),
    y: z.number().int().optional().describe("Target Y for move/click/zoom — in the pixel coordinates of the LAST image you were shown (top-left origin)."),
    w: z.number().int().positive().optional().describe("Zoom region width in screen pixels (default 800)."),
    h: z.number().int().positive().optional().describe("Zoom region height in screen pixels (default 600)."),
    text: z.string().optional().describe("Literal text for type; program/URI for launch; window-title substring for activate."),
    key: z.string().optional().describe("Key combo for the key action, or launch arguments."),
    amount: z.number().int().optional().describe("Wheel notches for scroll (negative scrolls down). Default 3."),
  })
  .strict();

export interface WindowInfo {
  title: string;
  process?: string;
  /** Top-left + size in absolute virtual-desktop pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  visible: boolean;
}

export interface ComputerUseOutput {
  ok: boolean;
  action: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Downscale factor of the last shown image (physical px per image px). */
  scale?: number;
  /** Open top-level windows (for the `windows` action). */
  windows?: WindowInfo[];
  error?: string;
  /** Where the screenshot PNG was also saved on disk (for desktop preview). */
  screenshotPath?: string;
  note?: string;
  /** True when a post-action verification capture was taken and attached. */
  verified?: boolean;
  /** Whether the screen changed vs. the pre-action capture (undefined = no baseline). */
  changed?: boolean;
  /** Audit line for keyboard-tier actions: what was injected, and into which window. */
  audit?: string;
}

const MOUSE_ACTIONS = new Set(["move", "click", "double_click", "right_click"]);

/**
 * Per-action permission tiers. The static schema safety stays "external-state"
 * (conservative for the watchdog class + conductor filtering); the PERMISSION
 * decision uses the per-input tier via dynamicSafety:
 *   - read-only (no confirmation cost): screenshot / zoom / window / windows /
 *     cursor — they only observe the screen.
 *   - standard (external-state ask): move / click / scroll / launch / activate.
 *   - risky (external-state ask + audit line + env gate): type / key — they
 *     inject keystrokes into whatever holds focus. ARES_COMPUTERUSE_ALLOW_TYPING=0
 *     blocks them outright (default: allowed).
 */
const READ_ONLY_ACTIONS = new Set(["screenshot", "zoom", "window", "windows", "cursor"]);
const TYPING_ACTIONS = new Set(["type", "key"]);

/**
 * Everything needed to map a click from the IMAGE the model saw back to an
 * absolute point on the real (possibly multi-monitor) desktop:
 *   - origin{X,Y}: the virtual-desktop top-left (vs.X/vs.Y), which on multi-monitor
 *     rigs is NOT (0,0) and can be NEGATIVE (a monitor left/above the primary).
 *   - capture{W,H}: the physical pixels captured (the full virtual desktop, or a
 *     zoom region).
 *   - image{W,H}: the dimensions of the image actually shown to the model after
 *     downscaling (the long edge is capped to the vision limit).
 */
export interface ShotMeta {
  originX: number;
  originY: number;
  captureW: number;
  captureH: number;
  imageW: number;
  imageH: number;
}

const IDENTITY_SHOT: ShotMeta = { originX: 0, originY: 0, captureW: 1, captureH: 1, imageW: 1, imageH: 1 };

/** State-changing actions that get a post-action verification capture. */
const VERIFY_ACTIONS = new Set(["click", "double_click", "right_click", "type", "key", "scroll"]);

function captureHash(imageBase64: string): string {
  return createHash("sha1").update(imageBase64).digest("hex");
}

function shotMetaFrom(result: PsResult): ShotMeta {
  return {
    originX: result.originX ?? 0,
    originY: result.originY ?? 0,
    captureW: result.captureW && result.captureW > 0 ? result.captureW : (result.width ?? 1),
    captureH: result.captureH && result.captureH > 0 ? result.captureH : (result.height ?? 1),
    imageW: result.width && result.width > 0 ? result.width : 1,
    imageH: result.height && result.height > 0 ? result.height : 1,
  };
}

function unchangedNote(action: string): string {
  return MOUSE_ACTIONS.has(action)
    ? `screen unchanged after ${action} — the click may have missed`
    : `screen unchanged after ${action} — the input may not have registered`;
}

/**
 * Map an image-space coordinate (what the model returns) to an absolute
 * virtual-desktop coordinate (what the OS click API needs). Two steps, PURE:
 *   1. image → physical capture: multiply by a PER-AXIS scale derived from the
 *      real captured/image dimensions (not an assumed single factor, so rounding
 *      and any aspect divergence can't skew it).
 *   2. physical capture → absolute virtual desktop: add the capture origin, so a
 *      negative / non-(0,0) virtual origin is handled and there's no monitor-width
 *      skew.
 */
export function mapImageToVirtual(ix: number, iy: number, shot: ShotMeta): { x: number; y: number } {
  const scaleX = shot.imageW > 0 ? shot.captureW / shot.imageW : 1;
  const scaleY = shot.imageH > 0 ? shot.captureH / shot.imageH : 1;
  return {
    x: Math.round(shot.originX + ix * scaleX),
    y: Math.round(shot.originY + iy * scaleY),
  };
}

/** Per-axis scale factors for the last capture (physical px per image px). */
export function shotScale(shot: ShotMeta): { scaleX: number; scaleY: number } {
  return {
    scaleX: shot.imageW > 0 ? shot.captureW / shot.imageW : 1,
    scaleY: shot.imageH > 0 ? shot.captureH / shot.imageH : 1,
  };
}

/** Debug-only trace of a coordinate mapping — stderr, gated, never in normal logs. */
function traceMapping(action: string, ix: number, iy: number, shot: ShotMeta, mapped: { x: number; y: number }): void {
  if (process.env.ARES_COMPUTER_DEBUG !== "1") return;
  const { scaleX, scaleY } = shotScale(shot);
  process.stderr.write(
    `[ComputerUse] ${action} model=(${ix},${iy}) image=${shot.imageW}x${shot.imageH} ` +
      `capture=${shot.captureW}x${shot.captureH} origin=(${shot.originX},${shot.originY}) ` +
      `scale=(${scaleX.toFixed(3)},${scaleY.toFixed(3)}) -> virtual=(${mapped.x},${mapped.y})\n`,
  );
}

export type ComputerActionRunner = (input: z.infer<typeof inputSchema>, shot: ShotMeta) => Promise<PsResult>;

export function makeComputerUseTool(runner: ComputerActionRunner = runComputerAction) {
  // Per-tool capture state: the mapping metadata of the last image the model
  // saw, plus its content hash for post-action change detection.
  let lastShot: ShotMeta = { ...IDENTITY_SHOT };
  let lastShotHash: string | null = null;
  const realDesktop = runner === runComputerAction;

  return buildTool({
    name: "ComputerUse",
    description:
      "Control the REAL desktop (mouse, keyboard, screen) — LAST RESORT, for native apps only (no API, no web page): a settings dialog, a desktop-only app, an installer. NEVER use this for anything inside a web page or browser — use the Browser tool instead: it drives the page directly without stealing the user's mouse, is faster, and doesn't break when the user moves their own cursor. Doctrine: SCREENSHOT FIRST to see the screen, act on what you SEE (coordinates are screen pixels from the top-left). After click/type/key/scroll a post-action screenshot is attached automatically — LOOK at it to confirm the effect before acting again. Windows only. Note: this hijacks the user's actual mouse/keyboard — be deliberate.",
    safety: "external-state",
    concurrency: "exclusive",
    inputZod: inputSchema,
    dynamicSafety: (i) => (READ_ONLY_ACTIONS.has(i.action) ? "read-only" : "external-state"),

    // Per-action semantic checks: catch the calls that fail (or silently no-op)
    // deep in the PowerShell driver, with a one-sentence fix.
    async validateInput(i) {
      if (TYPING_ACTIONS.has(i.action) && process.env.ARES_COMPUTERUSE_ALLOW_TYPING === "0") {
        return {
          ok: false,
          message: `${i.action} is blocked: keyboard input is disabled (ARES_COMPUTERUSE_ALLOW_TYPING=0). Use click-based UI interaction, or ask the owner to re-enable typing.`,
        };
      }
      if (i.action === "type" && !i.text) {
        return { ok: false, message: "type needs `text` — the literal characters to type into the focused window." };
      }
      if (i.action === "key" && !i.key) {
        return { ok: false, message: "key needs `key` — a SendKeys combo like ^c, %{F4}, {ENTER}, or a WIN chord like WIN+R." };
      }
      if (i.action === "launch" && !i.text?.trim()) {
        return { ok: false, message: "launch needs `text` — a program name (notepad), full path, or URI (ms-settings:)." };
      }
      if (i.action === "activate" && !i.text?.trim()) {
        return { ok: false, message: "activate needs `text` — a substring of the target window's title (use `windows` to list them)." };
      }
      if (
        i.action === "activate" &&
        process.env.ARES_COMPUTERUSE_ALLOW_BROWSER !== "1" &&
        /\b(chrome|edge|firefox|brave|opera|vivaldi|browser|x —|youtube|twitter)\b/i.test(i.text ?? "")
      ) {
        // Default-closed: a web page steering the model must never reach the
        // physical mouse. The OWNER can lift it (their machine, their call).
        return {
          ok: false,
          message: "ComputerUse cannot activate browser windows. Use Browser tabs/attach/open: it controls the page without stealing the owner's mouse and renders the Ares cursor in-page. If the owner explicitly wants Ares driving their real browser with the mouse, they can flip Settings → Advanced → 'Desktop control of browser windows' — tell them that, don't work around it.",
        };
      }
      if ((i.action === "move" || i.action === "zoom") && (i.x === undefined || i.y === undefined)) {
        return { ok: false, message: `${i.action} needs both x and y — pixel coordinates from the LAST image you were shown.` };
      }
      if (MOUSE_ACTIONS.has(i.action) && (i.x === undefined) !== (i.y === undefined)) {
        return { ok: false, message: `${i.action} got only one of x/y — pass BOTH coordinates, or neither to act at the current cursor position.` };
      }
      return { ok: true };
    },

    activityDescription: (i) => {
      if (i.action === "screenshot") return "Capturing the screen";
      if (i.action === "window") return "Capturing the active window";
      if (i.action === "windows") return "Listing open windows";
      if (i.action === "launch") return `Launching ${i.text ?? "an app"}`;
      if (i.action === "type") return "Typing on the desktop";
      if (i.action === "key") return `Pressing ${i.key ?? "a key"}`;
      if (MOUSE_ACTIONS.has(i.action) && i.x !== undefined) return `${i.action} at ${i.x},${i.y}`;
      return `Computer: ${i.action}`;
    },

    async call(i, _ctx): Promise<{ output: ComputerUseOutput; display: string; images?: Array<{ mediaType: string; data: string }> }> {
      if (process.env.ARES_COMPUTER_USE === "0") {
        throw new Error("COMPUTER_USE_DISABLED: ComputerUse is turned off (ARES_COMPUTER_USE=0).");
      }
      if (realDesktop && process.platform !== "win32") {
        // Terminal, non-retriable — do NOT try to install anything, switch tools.
        throw new Error(
          "COMPUTER_USE_UNAVAILABLE: desktop control is Windows-only in this build. Use the Browser tool for web tasks, or do the work through files/CLI instead.",
        );
      }

      const result = await runner(i, lastShot);
      if (!result.ok) {
        throw new Error(`ComputerUse ${i.action} failed: ${result.error ?? "unknown error"}`);
      }

      if (i.action === "windows") {
        const windows = result.windows ?? [];
        return {
          output: { ok: true, action: "windows", windows, note: `${windows.length} open window(s). Use 'activate' (by title) or 'window' to capture the focused one.` },
          display: `Listed ${windows.length} window(s)`,
        };
      }

      if ((i.action === "screenshot" || i.action === "zoom" || i.action === "window") && result.image) {
        // Remember the full mapping metadata so the NEXT click/move converts the
        // model's image-space coordinate back to the right spot on the real desktop.
        lastShot = shotMetaFrom(result);
        lastShotHash = captureHash(result.image);
        // Persist a copy under ARES_HOME (asset-protocol scope) so the desktop can
        // preview it; fall back to tmp if home isn't set.
        let screenshotPath: string | undefined;
        try {
          const base = process.env.ARES_HOME
            ? path.join(process.env.ARES_HOME, "screenshots")
            : path.join(os.tmpdir(), "ares-screenshots");
          await fs.mkdir(base, { recursive: true });
          screenshotPath = path.join(base, `shot-${Date.now()}.png`);
          await fs.writeFile(screenshotPath, Buffer.from(result.image, "base64"));
        } catch {
          screenshotPath = undefined;
        }
        const { scaleX } = shotScale(lastShot);
        const native = scaleX <= 1.001 ? "(native resolution)" : `(downscaled ${scaleX.toFixed(2)}×)`;
        const output: ComputerUseOutput = {
          ok: true,
          action: i.action,
          width: result.width,
          height: result.height,
          scale: scaleX,
          screenshotPath,
          note: `Captured ${native}. Give click/move coordinates in THIS image's pixel space (top-left origin); they're mapped to the real screen automatically. If a target is small or text is hard to read, 'zoom' into its region for a native-resolution view.`,
        };
        return {
          output,
          display: `Captured ${i.action} ${result.width}×${result.height}`,
          images: [{ mediaType: "image/png", data: result.image }],
        };
      }

      const output: ComputerUseOutput = {
        ok: true,
        action: i.action,
        x: result.x,
        y: result.y,
      };
      let display = describeDone(i, result);
      // Keyboard tier: an explicit audit line — what was injected, into which
      // window — so a transcript reviewer (and the model) can see exactly where
      // the keystrokes went. Survives the verification note below.
      if (TYPING_ACTIONS.has(i.action)) {
        const focus = result.focus?.trim() ? `"${result.focus.trim()}"` : "the focused window";
        output.audit =
          i.action === "type"
            ? `typed ${(i.text ?? "").length} chars into ${focus}`
            : `pressed ${i.key ?? ""} in ${focus}`;
        display = output.audit.charAt(0).toUpperCase() + output.audit.slice(1);
      }
      let images: Array<{ mediaType: string; data: string }> | undefined;

      // Vision verification: after a state-changing action, take ONE post-action
      // capture (same region the model last saw), attach it so the model SEES the
      // effect, and hash-compare against the pre-action capture — "clicked blind"
      // becomes "clicked, looked, and knows whether anything happened". No retry
      // loops here; self-correction is the model's job. ARES_COMPUTERUSE_VERIFY=0
      // disables.
      if (VERIFY_ACTIONS.has(i.action) && process.env.ARES_COMPUTERUSE_VERIFY !== "0") {
        // 120ms settles a click's visual effect on modern UIs; the old 350ms
        // was a large slice of the per-action wall clock users complained about.
        const settleMs = Number(process.env.ARES_COMPUTERUSE_SETTLE_MS ?? 120);
        if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
        const hadBaseline = lastShotHash !== null && lastShot.captureW > 1;
        const captureInput = (hadBaseline
          ? { action: "zoom", x: lastShot.originX, y: lastShot.originY, w: lastShot.captureW, h: lastShot.captureH }
          : { action: "screenshot" }) as z.infer<typeof inputSchema>;
        const capture = await runner(captureInput, lastShot).catch(
          (err): PsResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
        if (capture.ok && capture.image) {
          const postHash = captureHash(capture.image);
          const changed = hadBaseline ? postHash !== lastShotHash : undefined;
          lastShot = shotMetaFrom(capture);
          lastShotHash = postHash;
          output.verified = true;
          output.changed = changed;
          output.note =
            changed === false
              ? unchangedNote(i.action)
              : changed
                ? "screen changed after the action — post-action screenshot attached; coordinates now refer to THIS image"
                : "post-action screenshot attached (no prior capture to compare against); coordinates now refer to THIS image";
          display = changed === false
            ? `${display} — ${unchangedNote(i.action)}`
            : `${display} — verified (screen ${changed ? "changed" : "captured"})`;
          images = [{ mediaType: "image/png", data: capture.image }];
        } else {
          output.note = `post-action verification capture failed (${capture.error ?? "unknown error"}) — take a screenshot to confirm the effect`;
        }
      }

      return { output, display, images };
    },
  });
}

export const ComputerUseTool = makeComputerUseTool();

function describeDone(i: z.infer<typeof inputSchema>, r: PsResult): string {
  switch (i.action) {
    case "cursor":
      return `Cursor at ${r.x},${r.y}`;
    case "move":
      return `Moved to ${r.x},${r.y}`;
    case "type":
      return `Typed ${(i.text ?? "").length} chars`;
    case "key":
      return `Pressed ${i.key ?? ""}`;
    case "scroll":
      return `Scrolled ${i.amount ?? 3}`;
    default:
      return `${i.action} done`;
  }
}

interface PsResult {
  ok: boolean;
  action?: string;
  image?: string;
  /** Image dimensions shown to the model (after downscaling). */
  width?: number;
  height?: number;
  /** Physical pixels captured (full virtual desktop, or the zoom region). */
  captureW?: number;
  captureH?: number;
  scale?: number;
  /** Virtual-desktop origin of the capture (vs.X/vs.Y, or the captured window/region top-left). */
  originX?: number;
  originY?: number;
  x?: number;
  y?: number;
  windows?: WindowInfo[];
  /** Foreground-window title at type/key time (for the audit line). */
  focus?: string;
  error?: string;
}

/** Escape literal text for SendKeys: wrap special chars, turn newlines/tabs
 *  into real key presses. */
function escapeSendKeys(text: string): string {
  return text
    .replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`)
    .replace(/\r\n|\r|\n/g, "{ENTER}")
    .replace(/\t/g, "{TAB}");
}

let scriptPathPromise: Promise<string> | null = null;

async function ensureScript(): Promise<string> {
  scriptPathPromise ??= (async () => {
    const file = path.join(os.tmpdir(), "ares-computeruse.ps1");
    await fs.writeFile(file, POWERSHELL_DRIVER, "utf8");
    return file;
  })();
  return scriptPathPromise;
}

// ── Persistent PowerShell host ──────────────────────────────────────────────
// The old design spawned a FRESH powershell.exe per action, paying the
// Add-Type C# JIT (~1-3s) every single click — the dominant share of the
// 5-15s/action users saw. The host compiles once, then executes actions from
// a stdin JSON-line loop for the life of the process.

interface PsHost {
  child: import("node:child_process").ChildProcessWithoutNullStreams;
  pending: Array<{ resolve: (r: PsResult) => void; timer: NodeJS.Timeout }>;
  buffer: string;
}

let psHost: PsHost | null = null;
let actionChain: Promise<unknown> = Promise.resolve();

async function ensureHost(): Promise<PsHost> {
  if (psHost && psHost.child.exitCode === null && !psHost.child.killed) return psHost;
  const script = await ensureScript();
  const ps = process.env.ARES_POWERSHELL || "powershell";
  const child = spawn(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
    windowsHide: true,
  });
  const host: PsHost = { child, pending: [], buffer: "" };
  const marker = "ARES_RESULT:";
  child.stdout.on("data", (b: Buffer) => {
    host.buffer += b.toString("utf8");
    let idx = host.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = host.buffer.slice(0, idx).trim();
      host.buffer = host.buffer.slice(idx + 1);
      if (line.includes(marker)) {
        const waiter = host.pending.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          try {
            waiter.resolve(JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as PsResult);
          } catch {
            waiter.resolve({ ok: false, error: "unparseable driver result" });
          }
        }
      }
      idx = host.buffer.indexOf("\n");
    }
  });
  const failAll = (why: string) => {
    if (psHost === host) psHost = null;
    for (const waiter of host.pending.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, error: why });
    }
  };
  child.on("error", (err) => failAll(`PowerShell host failed: ${err.message}`));
  child.on("close", (code) => failAll(`PowerShell host exited (${code ?? "killed"})`));
  psHost = host;
  return host;
}

async function runComputerAction(input: z.infer<typeof inputSchema>, shot: ShotMeta): Promise<PsResult> {
  // Mouse actions: convert the model's image-space coordinates to physical
  // screen pixels. zoom: x,y are already physical (the region's top-left).
  let physX: number | null = input.x ?? null;
  let physY: number | null = input.y ?? null;
  if (MOUSE_ACTIONS.has(input.action) && input.x !== undefined && input.y !== undefined) {
    const p = mapImageToVirtual(input.x, input.y, shot);
    physX = p.x;
    physY = p.y;
    traceMapping(input.action, input.x, input.y, shot, p);
  }
  const payload = JSON.stringify({
    action: input.action,
    x: physX,
    y: physY,
    w: input.w ?? null,
    h: input.h ?? null,
    // Literal text must be SendKeys-escaped so +^%~(){}[] aren't read as
    // modifiers, and newlines/tabs become real key presses. launch/activate
    // use the raw text (program path / window title), not SendKeys-escaped.
    text: input.action === "type" ? escapeSendKeys(input.text ?? "") : (input.text ?? ""),
    key: input.key ?? "",
    amount: input.amount ?? 3,
  });
  // Serialize actions: the host answers strictly in order, so pending waiters
  // are matched FIFO — never interleave two writes.
  const run = actionChain.then(async (): Promise<PsResult> => {
    const attempt = (): Promise<PsResult> =>
      new Promise<PsResult>((resolve) => {
        void ensureHost().then((host) => {
          const timer = setTimeout(() => {
            // Wedged action: kill the host (next call respawns it) and report.
            try { host.child.kill(); } catch { /* already dead */ }
            resolve({ ok: false, error: "computer action timed out after 20s" });
          }, 20_000);
          host.pending.push({ resolve, timer });
          host.child.stdin.write(payload + "\n", (err) => {
            if (err) {
              clearTimeout(timer);
              const i = host.pending.findIndex((w) => w.timer === timer);
              if (i >= 0) host.pending.splice(i, 1);
              resolve({ ok: false, error: `PowerShell host write failed: ${err.message}` });
            }
          });
        }).catch((err: unknown) => resolve({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      });
    let result = await attempt();
    // One transparent retry on host death (stale host from a previous timeout).
    if (!result.ok && /host (failed|exited)|write failed/i.test(result.error ?? "")) {
      result = await attempt();
    }
    return result;
  });
  actionChain = run.catch(() => undefined);
  return run;
}

// The driver: a PERSISTENT host. Setup (Add-Type JIT) runs once, then actions
// arrive as JSON lines on stdin; each prints exactly one `ARES_RESULT:{json}`
// line. Passing an action-file path still works (legacy one-shot mode).
const POWERSHELL_DRIVER = String.raw`param([string]$ActionFile)
$ErrorActionPreference = 'Stop'
function Out-Result($obj) { [Console]::Out.WriteLine("ARES_RESULT:" + ($obj | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct AresRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class AresIn {
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out AresRect rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  function Set-Pos($x, $y) { [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$x, [int]$y) }
  function Get-FocusTitle {
    try {
      $h = [AresIn]::GetForegroundWindow()
      if ($h -eq [IntPtr]::Zero) { return '' }
      $sb = New-Object System.Text.StringBuilder 512
      [void][AresIn]::GetWindowText($h, $sb, 512)
      return $sb.ToString()
    } catch { return '' }
  }
  function Mouse($down, $up) {
    [AresIn]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [AresIn]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero)
  }
  # Capture an arbitrary screen rectangle, downscaling so the long edge is <=
  # 1568px (the model's vision limit; above it the API silently shrinks the image
  # and small UI text becomes unaimable). Reports captured size, image size,
  # scale, and origin so a click in the image maps back to the exact screen pixel.
  function Capture-Region($rx, $ry, $rw, $rh) {
    $bmp = New-Object System.Drawing.Bitmap($rw, $rh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen([int]$rx, [int]$ry, 0, 0, (New-Object System.Drawing.Size([int]$rw, [int]$rh)))
    $g.Dispose()
    $maxEdge = [Math]::Max($rw, $rh)
    $scale = 1.0
    if ($maxEdge -gt 1568) { $scale = $maxEdge / 1568.0 }
    $outW = [int][Math]::Round($rw / $scale)
    $outH = [int][Math]::Round($rh / $scale)
    $img = $bmp
    if ($scale -gt 1.0) {
      $img = New-Object System.Drawing.Bitmap($outW, $outH)
      $sg = [System.Drawing.Graphics]::FromImage($img)
      $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $sg.DrawImage($bmp, 0, 0, $outW, $outH)
      $sg.Dispose()
    }
    $ms = New-Object System.IO.MemoryStream
    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($scale -gt 1.0) { $img.Dispose() }
    $bmp.Dispose()
    return @{ image = [Convert]::ToBase64String($ms.ToArray()); width = $outW; height = $outH; captureW = [int]$rw; captureH = [int]$rh; scale = $scale; originX = [int]$rx; originY = [int]$ry }
  }
  function Invoke-AresAction($a) {
  try {
  switch ($a.action) {
    'screenshot' {
      $s = Capture-Region $vs.X $vs.Y $vs.Width $vs.Height
      Out-Result @{ ok = $true; action = 'screenshot'; image = $s.image; width = $s.width; height = $s.height; captureW = $s.captureW; captureH = $s.captureH; scale = $s.scale; originX = $s.originX; originY = $s.originY }
    }
    'zoom' {
      $zx = [int]$a.x; $zy = [int]$a.y
      $zw = [int]$a.w; $zh = [int]$a.h
      if ($zw -le 0) { $zw = 800 }
      if ($zh -le 0) { $zh = 600 }
      $s = Capture-Region $zx $zy $zw $zh
      Out-Result @{ ok = $true; action = 'zoom'; image = $s.image; width = $s.width; height = $s.height; captureW = $s.captureW; captureH = $s.captureH; scale = $s.scale; originX = $s.originX; originY = $s.originY }
    }
    'window' {
      $h = [AresIn]::GetForegroundWindow()
      if ($h -eq [IntPtr]::Zero) { Out-Result @{ ok = $false; error = 'no foreground window' } }
      else {
        $r = New-Object AresRect
        if (-not [AresIn]::GetWindowRect($h, [ref]$r)) { Out-Result @{ ok = $false; error = 'could not read the foreground window rect' } }
        else {
          $ww = $r.Right - $r.Left; $wh = $r.Bottom - $r.Top
          if ($ww -le 0 -or $wh -le 0) { Out-Result @{ ok = $false; error = 'foreground window has no visible area (minimized?)' } }
          else {
            $s = Capture-Region $r.Left $r.Top $ww $wh
            Out-Result @{ ok = $true; action = 'window'; image = $s.image; width = $s.width; height = $s.height; captureW = $s.captureW; captureH = $s.captureH; scale = $s.scale; originX = $s.originX; originY = $s.originY }
          }
        }
      }
    }
    'windows' {
      $list = @()
      foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle })) {
        $h = $p.MainWindowHandle
        $r = New-Object AresRect
        if ([AresIn]::GetWindowRect($h, [ref]$r)) {
          $list += @{ title = $p.MainWindowTitle; process = $p.ProcessName; x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top); minimized = [bool][AresIn]::IsIconic($h); visible = [bool][AresIn]::IsWindowVisible($h) }
        }
      }
      Out-Result @{ ok = $true; action = 'windows'; windows = @($list) }
    }
    'launch' {
      $target = ([string]$a.text).Trim()
      $argline = [string]$a.key
      # Resolve a few common names so "open settings"/"launch notepad" just work.
      $aliases = @{ 'settings' = 'ms-settings:'; 'notepad' = 'notepad.exe'; 'calc' = 'calc.exe'; 'calculator' = 'calc.exe'; 'explorer' = 'explorer.exe'; 'files' = 'explorer.exe'; 'cmd' = 'cmd.exe'; 'terminal' = 'wt.exe'; 'task manager' = 'taskmgr.exe'; 'control panel' = 'control.exe'; 'paint' = 'mspaint.exe' }
      $key = $target.ToLower()
      if ($aliases.ContainsKey($key)) { $target = $aliases[$key] }
      try {
        if ($argline -ne '') { Start-Process -FilePath $target -ArgumentList $argline -ErrorAction Stop }
        else { Start-Process -FilePath $target -ErrorAction Stop }
        Out-Result @{ ok = $true; action = 'launch' }
      } catch {
        Out-Result @{ ok = $false; error = ("could not launch '" + $target + "': " + $_.Exception.Message + ". Try a full path, an executable name (notepad.exe), or a shell URI (ms-settings:).") }
      }
    }
    'activate' {
      Add-Type -AssemblyName Microsoft.VisualBasic
      [Microsoft.VisualBasic.Interaction]::AppActivate([string]$a.text)
      Out-Result @{ ok = $true; action = 'activate' }
    }
    'cursor' {
      $p = [System.Windows.Forms.Cursor]::Position
      Out-Result @{ ok = $true; action = 'cursor'; x = $p.X; y = $p.Y }
    }
    'move' {
      Set-Pos $a.x $a.y
      Out-Result @{ ok = $true; action = 'move'; x = [int]$a.x; y = [int]$a.y }
    }
    'click' {
      if ($a.x -ne $null) { Set-Pos $a.x $a.y; Start-Sleep -Milliseconds 20 }
      Mouse 0x0002 0x0004
      $p = [System.Windows.Forms.Cursor]::Position
      Out-Result @{ ok = $true; action = 'click'; x = $p.X; y = $p.Y }
    }
    'double_click' {
      if ($a.x -ne $null) { Set-Pos $a.x $a.y; Start-Sleep -Milliseconds 20 }
      Mouse 0x0002 0x0004; Start-Sleep -Milliseconds 60; Mouse 0x0002 0x0004
      $p = [System.Windows.Forms.Cursor]::Position
      Out-Result @{ ok = $true; action = 'double_click'; x = $p.X; y = $p.Y }
    }
    'right_click' {
      if ($a.x -ne $null) { Set-Pos $a.x $a.y; Start-Sleep -Milliseconds 20 }
      Mouse 0x0008 0x0010
      $p = [System.Windows.Forms.Cursor]::Position
      Out-Result @{ ok = $true; action = 'right_click'; x = $p.X; y = $p.Y }
    }
    'scroll' {
      $notches = [int]$a.amount
      if ($notches -eq 0) { $notches = 3 }
      $delta = $notches * 120
      if ($delta -lt 0) { $delta = $delta + 4294967296 }
      [AresIn]::mouse_event(0x0800, 0, 0, [uint32]$delta, [IntPtr]::Zero)
      Out-Result @{ ok = $true; action = 'scroll' }
    }
    'type' {
      $focus = Get-FocusTitle
      [System.Windows.Forms.SendKeys]::SendWait([string]$a.text)
      Out-Result @{ ok = $true; action = 'type'; focus = $focus }
    }
    'key' {
      $k = [string]$a.key
      $focus = Get-FocusTitle
      if ($k -match '^(?i:win)\b') {
        # SendKeys can't press the Windows key. Hold LWIN (0x5B) and tap the rest.
        $rest = ($k -replace '^(?i:win)\s*\+?\s*', '')
        [AresIn]::keybd_event(0x5B, 0, 0, [IntPtr]::Zero)
        if ($rest.Length -gt 0) { [System.Windows.Forms.SendKeys]::SendWait($rest) }
        Start-Sleep -Milliseconds 40
        [AresIn]::keybd_event(0x5B, 0, 2, [IntPtr]::Zero)
        Out-Result @{ ok = $true; action = 'key'; focus = $focus }
      } else {
        [System.Windows.Forms.SendKeys]::SendWait($k)
        Out-Result @{ ok = $true; action = 'key'; focus = $focus }
      }
    }
    default { Out-Result @{ ok = $false; error = ("unknown action: " + $a.action) } }
  }
  } catch {
    Out-Result @{ ok = $false; error = $_.Exception.Message }
  }
  }

  if ($ActionFile) {
    # Legacy one-shot mode: action JSON in a file, exit after.
    $a = Get-Content -Raw -LiteralPath $ActionFile | ConvertFrom-Json
    Invoke-AresAction $a
  } else {
    # Host mode: JSON action per stdin line, result per stdout line, forever.
    while ($true) {
      $line = [Console]::In.ReadLine()
      if ($null -eq $line) { break }
      $line = $line.Trim()
      if ($line -eq '') { continue }
      try { $a = $line | ConvertFrom-Json } catch { Out-Result @{ ok = $false; error = 'unparseable action json' }; continue }
      Invoke-AresAction $a
    }
  }
}
catch {
  Out-Result @{ ok = $false; error = $_.Exception.Message }
}
`;
