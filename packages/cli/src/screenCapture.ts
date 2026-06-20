// Screen capture for the Consciousness watch loop. Local + dependency-free:
// on Windows it shells out to PowerShell (System.Drawing) to grab the primary
// screen to a temp PNG; the vision engine reads that file. Kept tiny and
// downscaled so the local VLM stays cheap. The captured frame never leaves the
// machine — it's written to a temp file, read by the local model, and reused
// (overwritten) each tick.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";

export interface CaptureResult {
  path: string;
  width: number;
  height: number;
}

export function defaultCapturePath(): string {
  return path.join(tmpdir(), "ares-watch-frame.png");
}

/** PowerShell that captures the primary screen, scales it down (so the local
 *  VLM is fast), and saves a PNG. Single-quoted to the shell; no interpolation. */
function windowsCaptureScript(outPath: string, maxWidth: number): string {
  // Escape backslashes/quotes for embedding into the PS string literal.
  const safe = outPath.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Follow the user across monitors: capture the screen that holds the FOREGROUND
# window (where they're actually working), not just the primary. Capturing the
# whole virtual desktop on a multi-monitor rig squishes it into an unreadable
# strip, so we pick the active monitor instead.
Add-Type -Name Fg -Namespace AresW -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'
$hwnd = [AresW.Fg]::GetForegroundWindow()
$screen = if ($hwnd -ne [System.IntPtr]::Zero) { [System.Windows.Forms.Screen]::FromHandle($hwnd) } else { [System.Windows.Forms.Screen]::PrimaryScreen }
$b = $screen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$maxW = ${maxWidth}
if ($bmp.Width -gt $maxW) {
  $scale = $maxW / $bmp.Width
  $nw = [int]($bmp.Width * $scale)
  $nh = [int]($bmp.Height * $scale)
  $small = New-Object System.Drawing.Bitmap $nw, $nh
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.DrawImage($bmp, 0, 0, $nw, $nh)
  $small.Save('${safe}', [System.Drawing.Imaging.ImageFormat]::Png)
  $sg.Dispose(); $small.Dispose()
} else {
  $bmp.Save('${safe}', [System.Drawing.Imaging.ImageFormat]::Png)
}
$g.Dispose(); $bmp.Dispose()
Write-Output ("{0}x{1}" -f $b.Width, $b.Height)
`.trim();
}

export class ScreenCaptureUnsupportedError extends Error {
  constructor() {
    super(`screen capture not supported on ${process.platform}`);
    this.name = "ScreenCaptureUnsupportedError";
  }
}

/** Capture the screen to a temp PNG and return its path + native dimensions. */
export async function captureScreen(opts: { outPath?: string; maxWidth?: number; timeoutMs?: number } = {}): Promise<CaptureResult> {
  if (process.platform !== "win32") throw new ScreenCaptureUnsupportedError();
  const outPath = opts.outPath ?? defaultCapturePath();
  const maxWidth = opts.maxWidth ?? 1280;
  const script = windowsCaptureScript(outPath, maxWidth);
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const dims = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`screen capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`screen capture failed (${code}): ${err.slice(0, 300)}`));
      else resolve(out.trim());
    });
  });

  // Confirm the file actually landed.
  await stat(outPath);
  const m = /^(\d+)x(\d+)$/.exec(dims);
  return { path: outPath, width: m ? Number(m[1]) : 0, height: m ? Number(m[2]) : 0 };
}
