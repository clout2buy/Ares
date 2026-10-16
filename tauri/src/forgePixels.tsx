// 2-bit pixel effects for the Forge (owner, 2026-10-15): the panel does not
// slide out, it RESOLVES out of blue pixel blocks; the stage resolves the same
// way when a page lands; the idle core pulses blocky rings. Four-tone palette,
// dithered edges, a wave that travels from the centre. Everything is a slow
// drift or a single short transition — nothing strobes (photosensitive
// doctrine: NOTHING flashes).

import { useEffect, useRef } from "react";

/** Four blues, dark → light. The wave front uses the light end. */
const BLUE_PALETTE = ["#07122b", "#15347a", "#2f6df0", "#9cc5ff"];
/** The explain-mode palette: when Ares shows something it generated, the
 *  Forge goes warm (gold/ember) and flips back to blue for real projects. */
const GOLD_PALETTE = ["#2b1a07", "#7a4a15", "#f0a32f", "#ffe29c"];
const PALETTE = BLUE_PALETTE;

/** Deterministic 0..1 noise per cell (xorshift on the cell index). */
function cellNoise(ix: number, iy: number, seed: number): number {
  let h = (ix * 73856093) ^ (iy * 19349663) ^ (seed * 83492791);
  h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
  return ((h >>> 0) % 10000) / 10000;
}

function fitCanvas(canvas: HTMLCanvasElement): { w: number; h: number; dpr: number } | null {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}

/**
 * A pixel-dissolve overlay. `runKey` changing starts a run: mode "in" starts
 * fully covered in blocks and clears them in a dithered wave from the centre
 * (the content underneath appears); mode "out" does the reverse. The canvas
 * is pointer-transparent and hides itself when idle.
 */
export function ForgePixelReveal({
  runKey,
  mode = "in",
  cell = 10,
  durationMs = 720,
  palette = "blue",
  onDone,
}: {
  runKey: number;
  mode?: "in" | "out";
  cell?: number;
  durationMs?: number;
  palette?: "blue" | "gold";
  onDone?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || runKey === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const PALETTE = palette === "gold" ? GOLD_PALETTE : BLUE_PALETTE;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    canvas.style.display = "block";
    const start = performance.now();
    const seed = runKey * 7 + (mode === "out" ? 3 : 0);
    let raf = 0;

    const frame = (now: number) => {
      const fit = fitCanvas(canvas);
      if (!fit) return;
      const { w, h, dpr } = fit;
      const raw = Math.min(1, (now - start) / (reduce ? 1 : durationMs));
      // ease-out so the last blocks linger briefly at the edges
      const t = mode === "in" ? 1 - Math.pow(1 - raw, 2.2) : Math.pow(raw, 1.8);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cols = Math.ceil(w / cell);
      const rows = Math.ceil(h / cell);
      const cx = cols / 2;
      const cy = rows / 2;
      const maxD = Math.hypot(cx, cy) || 1;
      for (let iy = 0; iy < rows; iy++) {
        for (let ix = 0; ix < cols; ix++) {
          // threshold: distance from the centre (the wave) + noise (the dither)
          const d = Math.hypot(ix + 0.5 - cx, iy + 0.5 - cy) / maxD;
          const n = cellNoise(ix, iy, seed);
          const threshold = d * 0.72 + n * 0.28;
          // "in": a block stays until the wave passes its threshold.
          // "out": a block appears once the wave passes it.
          const covered = mode === "in" ? threshold > t : threshold < t;
          if (!covered) continue;
          const edge = Math.abs(threshold - t); // distance to the wave front
          const tone = edge < 0.04 ? 3 : edge < 0.1 ? 2 : edge < 0.2 ? 1 : 0;
          ctx.fillStyle = PALETTE[tone]!;
          ctx.fillRect(ix * cell, iy * cell, cell - 1, cell - 1);
        }
      }
      if (raw < 1) {
        raf = requestAnimationFrame(frame);
      } else {
        if (mode === "in") {
          ctx.clearRect(0, 0, w, h);
          canvas.style.display = "none";
        }
        doneRef.current?.();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [runKey, mode, cell, durationMs, palette]);

  return <canvas ref={ref} className="forgePixelCanvas" aria-hidden="true" style={{ display: "none" }} />;
}

/**
 * The panel's rim, in pixels: a dotted 2-bit border on a 6px grid, a bright
 * pulse travelling the perimeter once every ~8s, a few slow twinkles, and
 * solid L-brackets in the corners. Replaces the CSS border (owner: "instead
 * of panel border its pixels").
 */
export function ForgePixelRim({ cell = 6, lapMs = 8000, palette = "blue" }: { cell?: number; lapMs?: number; palette?: "blue" | "gold" }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const PALETTE = palette === "gold" ? GOLD_PALETTE : BLUE_PALETTE;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const fit = fitCanvas(canvas);
      if (!fit) return;
      const { w, h, dpr } = fit;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cols = Math.max(2, Math.floor(w / cell));
      const rows = Math.max(2, Math.floor(h / cell));
      // perimeter walk: top (l→r), right (t→b), bottom (r→l), left (b→t)
      const perim: Array<[number, number]> = [];
      for (let x = 0; x < cols; x++) perim.push([x, 0]);
      for (let y = 1; y < rows; y++) perim.push([cols - 1, y]);
      for (let x = cols - 2; x >= 0; x--) perim.push([x, rows - 1]);
      for (let y = rows - 2; y >= 1; y--) perim.push([0, y]);
      const P = perim.length;
      const t = reduce ? 0.25 : ((now - start) % lapMs) / lapMs;
      const head = t * P;
      for (let i = 0; i < P; i++) {
        const [x, y] = perim[i]!;
        const n = cellNoise(x, y, 11);
        let tone = -1;
        // distance behind the pulse head (the trail)
        let behind = head - i;
        if (behind < 0) behind += P;
        if (behind < 4) tone = 3;
        else if (behind < 12) tone = 2;
        else if (behind < 26) tone = 1;
        else if (n < 0.42) tone = 0; // the dotted base border
        // slow twinkle: a few cells breathe up one tone over ~3s
        if (!reduce && n > 0.93) {
          const ph = Math.sin((now - start) / 1500 + n * 40);
          if (ph > 0.6) tone = Math.min(3, Math.max(tone, 1) + 1);
        }
        // corners: solid 3-cell L brackets
        const nearCorner = (x < 3 && (y === 0 || y === rows - 1)) || (x > cols - 4 && (y === 0 || y === rows - 1)) || (y < 3 && (x === 0 || x === cols - 1)) || (y > rows - 4 && (x === 0 || x === cols - 1));
        if (nearCorner) tone = Math.max(tone, 2);
        if (tone < 0) continue;
        ctx.globalAlpha = tone === 0 ? 0.55 : tone === 1 ? 0.75 : 1;
        ctx.fillStyle = PALETTE[tone]!;
        ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1);
      }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [cell, lapMs, palette]);
  return <canvas ref={ref} className="forgeRimCanvas" aria-hidden="true" />;
}

// ── pixel icons ─────────────────────────────────────────────────────────────
// 8×8 bitmaps (the Ares mark is 11×11). '.' = empty, '1'..'3' = palette tone.
const ICONS: Record<string, string[]> = {
  ares: [
    ".....3.....",
    "....333....",
    "...33.33...",
    "...3...3...",
    "..33...33..",
    "..3.....3..",
    ".33.....33.",
    ".333333333.",
    "33.......33",
    "3.........3",
    "3.........3",
  ],
  live: ["...22...", ".2....2.", "2......2", "2..33..2", "2..33..2", "2......2", ".2....2.", "...22..."],
  artifacts: [".22222..", ".2...22.", ".2...222", ".2.....2", ".2.333.2", ".2.....2", ".2.333.2", ".2222222"],
  background: ["..2222..", ".2....2.", "2..3...2", "2..3...2", "2..333.2", "2......2", ".2....2.", "..2222.."],
  error: ["...33...", "...33...", "...33...", "...33...", "...33...", "........", "...33...", "...33..."],
  warn: ["...33...", "...33...", "..3..3..", "..3333..", ".3.33.3.", ".3....3.", "3..33..3", "33333333"],
  host: [".222....", "2...2...", "22222222", "2......2", "2......2", "2......2", "2......2", "22222222"],
  fps: [".......3", ".....3.3", ".....3.3", "...3.3.3", "...3.3.3", ".3.3.3.3", ".3.3.3.3", "33333333"],
  reload: ["..2222..", ".2....2.", "2......2", "2..3...3", "2...333.", "2....3..", ".2....2.", "..2222.."],
  rescue: ["..22....", ".2..2...", "2....2..", "2....2..", ".2..2.3.", "..22.3.3", ".....3.3", "......3."],
  watch: ["........", "..2222..", ".2....2.", "2..33..2", "2..33..2", ".2....2.", "..2222..", "........"],
  clock: ["..2222..", ".2....2.", "2...3..2", "2...3..2", "2...33.2", "2......2", ".2....2.", "..2222.."],
  idle: ["........", "........", "..2..2..", ".2.22.2.", "2..22..2", "2......2", ".2....2.", "..2222.."],
};

const PALETTES: Record<string, string[]> = {
  blue: PALETTE,
  green: ["#07301f", "#13704a", "#2ec98b", "#b8ffe0"],
  ember: ["#3a1407", "#9c3e12", "#ff8a3a", "#ffd9b0"],
  gold: ["#3a2a07", "#9c7412", "#ffc23a", "#fff0b0"],
  red: ["#3a0b07", "#9c2212", "#ff5740", "#ffc0b0"],
  dim: ["#0e1527", "#1b2743", "#334a7a", "#5a74a8"],
};

export type PixelIconName = keyof typeof ICONS;

/** A crisp pixel-art icon, rendered as SVG rects so it scales without blur. */
export function PixelIcon({
  name,
  size = 12,
  palette = "blue",
  className,
  title,
}: {
  name: PixelIconName;
  size?: number;
  palette?: keyof typeof PALETTES;
  className?: string;
  title?: string;
}) {
  const rows = ICONS[name] ?? ICONS.idle!;
  const h = rows.length;
  const w = rows[0]!.length;
  const colors = PALETTES[palette] ?? PALETTE;
  const rects: Array<{ x: number; y: number; c: string }> = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch === ".") continue;
      const tone = Math.max(0, Math.min(3, Number(ch)));
      rects.push({ x, y, c: colors[tone]! });
    }
  });
  return (
    <svg className={`pxi${className ? ` ${className}` : ""}`} width={size} height={Math.round((size * h) / w)} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      {rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.c} />)}
    </svg>
  );
}

/**
 * The idle core: blocky rings pulsing outward from the centre on an 8px grid,
 * dithered at the edges, a new ring every ~2.6s. Low alpha, slow — ambient.
 */
export function ForgePixelPulse({ cell = 8, period = 2600 }: { cell?: number; period?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const fit = fitCanvas(canvas);
      if (!fit) return;
      const { w, h, dpr } = fit;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cols = Math.ceil(w / cell);
      const rows = Math.ceil(h / cell);
      const cx = cols / 2;
      const cy = rows / 2;
      const maxR = Math.hypot(cx, cy);
      const phase = reduce ? 0.35 : ((now - start) % period) / period; // 0..1
      const rings = [phase, (phase + 0.5) % 1]; // two rings half a period apart
      for (let iy = 0; iy < rows; iy++) {
        for (let ix = 0; ix < cols; ix++) {
          const r = Math.hypot(ix + 0.5 - cx, iy + 0.5 - cy) / maxR;
          let best = 0;
          for (const p of rings) {
            const ringR = p * 1.05;
            const dist = Math.abs(r - ringR);
            const band = 0.07;
            if (dist < band) {
              const strength = (1 - dist / band) * (1 - p); // fades as it expands
              if (strength > best) best = strength;
            }
          }
          if (best <= 0.05) continue;
          // dither: drop every other cell at the faint end of the band
          const checker = (ix + iy) % 2 === 0;
          if (best < 0.35 && !checker) continue;
          const tone = best > 0.75 ? 3 : best > 0.5 ? 2 : best > 0.25 ? 1 : 0;
          ctx.globalAlpha = 0.18 + best * 0.45;
          ctx.fillStyle = PALETTE[tone]!;
          ctx.fillRect(ix * cell, iy * cell, cell - 1, cell - 1);
        }
      }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [cell, period]);
  return <canvas ref={ref} className="forgePulseCanvas" aria-hidden="true" />;
}
