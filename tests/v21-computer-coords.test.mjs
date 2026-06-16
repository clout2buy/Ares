// Verifies ComputerUse coordinate mapping — image-space (what the vision model
// returns) → absolute virtual-desktop coordinates (what the OS click API needs),
// across resizes, multi-monitor layouts, and negative/non-zero virtual origins.
// Pure math; no real desktop.

import test from "node:test";
import assert from "node:assert/strict";

import { mapImageToVirtual, shotScale } from "../packages/tools/dist/index.js";

const map = (ix, iy, shot) => mapImageToVirtual(ix, iy, shot);

// ── 1. Single 1920x1080, no resize (image == capture, origin 0) ───────────────

test("single 1920x1080, no downscale: image coords pass straight through", () => {
  const shot = { originX: 0, originY: 0, captureW: 1920, captureH: 1080, imageW: 1920, imageH: 1080 };
  assert.deepEqual(shotScale(shot), { scaleX: 1, scaleY: 1 });
  assert.deepEqual(map(0, 0, shot), { x: 0, y: 0 });
  assert.deepEqual(map(960, 540, shot), { x: 960, y: 540 }, "center");
  assert.deepEqual(map(1920, 1080, shot), { x: 1920, y: 1080 }, "bottom-right corner");
  assert.deepEqual(map(1920, 0, shot), { x: 1920, y: 0 }, "top-right corner");
  assert.deepEqual(map(0, 1080, shot), { x: 0, y: 1080 }, "bottom-left corner");
});

// ── 2. 3840x1080 dual monitor, downscaled to 1568x441 ─────────────────────────

test("3840x1080 dual, downscaled to 1568x441: corners and seam map exactly", () => {
  const shot = { originX: 0, originY: 0, captureW: 3840, captureH: 1080, imageW: 1568, imageH: 441 };
  const { scaleX, scaleY } = shotScale(shot);
  assert.ok(Math.abs(scaleX - 3840 / 1568) < 1e-9);
  assert.ok(Math.abs(scaleY - 1080 / 441) < 1e-9);
  assert.deepEqual(map(0, 0, shot), { x: 0, y: 0 });
  assert.deepEqual(map(1568, 441, shot), { x: 3840, y: 1080 }, "far corner maps to full capture");
  assert.deepEqual(map(784, 0, shot), { x: 1920, y: 0 }, "image mid maps to the monitor seam at x=1920");
  assert.deepEqual(map(1176, 220, shot), { x: 2880, y: 539 }, "a target on the right monitor");
});

// ── 3. Virtual origin at negative X (a monitor LEFT of primary) ────────────────

test("negative virtual origin: a left-of-primary monitor maps without skew", () => {
  // Two 1920x1080 side by side, secondary on the LEFT → vs.X = -1920.
  const shot = { originX: -1920, originY: 0, captureW: 3840, captureH: 1080, imageW: 1568, imageH: 441 };
  assert.deepEqual(map(0, 0, shot), { x: -1920, y: 0 }, "top-left of the LEFT monitor is negative");
  assert.deepEqual(map(1568, 441, shot), { x: 1920, y: 1080 }, "bottom-right of the primary");
  assert.deepEqual(map(784, 0, shot), { x: 0, y: 0 }, "image mid maps to the primary's top-left (0,0)");
});

test("negative virtual origin on Y too (monitor stacked above)", () => {
  const shot = { originX: 0, originY: -1080, captureW: 1920, captureH: 2160, imageW: 1568, imageH: 1764 };
  assert.deepEqual(map(0, 0, shot), { x: 0, y: -1080 }, "top of the upper monitor is negative Y");
});

// ── 4. Primary monitor not equal to the virtual origin (round-trip) ───────────

test("primary not at virtual origin: a primary-monitor target round-trips", () => {
  // vs origin is the LEFT secondary at -1920; the primary sits at physical (0,0).
  const shot = { originX: -1920, originY: 0, captureW: 3840, captureH: 1080, imageW: 1568, imageH: 441 };
  const { scaleX, scaleY } = shotScale(shot);
  for (const [vx, vy] of [[0, 0], [100, 200], [1919, 1079], [-1000, 500]]) {
    // Inverse: where would this virtual point appear in the model's image?
    const ix = Math.round((vx - shot.originX) / scaleX);
    const iy = Math.round((vy - shot.originY) / scaleY);
    const back = map(ix, iy, shot);
    assert.ok(Math.abs(back.x - vx) <= 2 && Math.abs(back.y - vy) <= 3, `(${vx},${vy}) round-trips ~exactly, got (${back.x},${back.y})`);
  }
});

// ── 5. Degenerate / no-shot guards ────────────────────────────────────────────

test("guards: zero image dimensions fall back to 1:1 instead of dividing by zero", () => {
  const shot = { originX: 0, originY: 0, captureW: 1920, captureH: 1080, imageW: 0, imageH: 0 };
  assert.deepEqual(shotScale(shot), { scaleX: 1, scaleY: 1 });
  assert.deepEqual(map(50, 60, shot), { x: 50, y: 60 });
});

test("identity shot (no screenshot yet) treats coords as physical", () => {
  const shot = { originX: 0, originY: 0, captureW: 1, captureH: 1, imageW: 1, imageH: 1 };
  assert.deepEqual(map(10, 10, shot), { x: 10, y: 10 });
});

// ── Asymmetric scale (rounding divergence) is handled per-axis ────────────────

test("per-axis scale: non-proportional image dims don't skew one axis", () => {
  // Contrived: capture 2000x1000 shown as 1000x250 (scaleX=2, scaleY=4).
  const shot = { originX: 0, originY: 0, captureW: 2000, captureH: 1000, imageW: 1000, imageH: 250 };
  assert.deepEqual(shotScale(shot), { scaleX: 2, scaleY: 4 });
  assert.deepEqual(map(500, 125, shot), { x: 1000, y: 500 }, "center maps with independent X/Y scale");
  assert.deepEqual(map(1000, 250, shot), { x: 2000, y: 1000 });
});
