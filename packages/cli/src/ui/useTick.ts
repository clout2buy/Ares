import { useEffect, useState } from "react";
import { motionEnabled } from "../tuiElite.js";

// One global animation tick — every derived phase (spinner frame, pulse, cursor
// blink, type-on progress) is a pure function of it, so there is a single
// setInterval for the whole app. Frozen at 0 when motion is disabled, which is
// exactly what makes render-harness snapshots deterministic.
export function useTick(ms = 80): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!motionEnabled()) return;
    const id = setInterval(() => setTick((t) => (t + 1) % 1_000_000), ms);
    return () => clearInterval(id);
  }, [ms]);
  return motionEnabled() ? tick : 0;
}

// ── Pure phase helpers (fns of tick) — shared by every animated primitive ──
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** Braille spinner frame. Advances every 2 ticks (≈6fps at 80ms). */
export function spinnerFrame(tick: number): string {
  return SPINNER[Math.floor(tick / 2) % SPINNER.length];
}
/** Two-state pulse (e.g. selection border primary⇄secondary). Flips every 5. */
export function pulse(tick: number): boolean {
  return Math.floor(tick / 5) % 2 === 0;
}
/** Cursor blink — on for 4 ticks, off for 4. */
export function cursorOn(tick: number): boolean {
  return Math.floor(tick / 4) % 2 === 0;
}
