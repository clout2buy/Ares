// Provider selection — a 3×2 grid of provider cards (Ares has 6 providers).
// Pure presentation: the launcher passes the provider list + readiness + which
// index is selected; this renders. Mouse-first — the launcher maps clicks to
// selection/confirm.

import React from "react";
import { Box, Text } from "ink";
import type { SlateTheme } from "./theme.js";
import { GridCard, HintBar } from "./primitives.js";
import { Logo } from "./Logo.js";

const h = React.createElement;

export type Readiness = "ready" | "needs-key" | "oauth";
export interface ProviderCardData {
  id: string;
  title: string;
  body: string;
  readiness: Readiness;
}

const ICONS: Record<string, string> = {
  ares: "◆", ollama: "◈", openai: "◐", anthropic: "✦", deepseek: "⬡", openrouter: "⬢", moa: "🜲", mock: "○",
};

function statusFor(r: Readiness, theme: SlateTheme): { text: string; color: string } {
  if (r === "ready") return { text: "● ready", color: theme.success };
  if (r === "oauth") return { text: "◐ sign in", color: theme.secondary };
  return { text: "○ no key", color: theme.danger };
}

const CARD_W = 26;
const PER_ROW = 3;
const CARD_H = 5; // round border (2) + icon/title + body + status
const CELL_W = CARD_W + 2; // marginX 1 each side

/**
 * Pure hit-testing for the provider grid — mirrors the EXACT flexbox math the
 * renderer uses (the launcher's old hardcoded classic zones were why clicks
 * landed nowhere near the slate cards). Coordinates are 1-based terminal
 * (x, y); the screen is the full terminal (the launcher clears to home and the
 * wrapper Box is height=rows with justifyContent:"center", alignItems center).
 * Returns the provider index under the point, or null.
 */
export function providerHitTest(
  x: number,
  y: number,
  columns: number,
  rows: number,
  count: number,
  hasVersion: boolean,
): number | null {
  const cardRows = Math.ceil(count / PER_ROW);
  // Content rows: logo 6 · version 0/1 · spacer · title · spacer · cards · spacer · hints
  const contentH = 6 + (hasVersion ? 1 : 0) + 3 + cardRows * CARD_H + 2;
  const topGap = Math.max(0, Math.floor((rows - contentH) / 2));
  const firstCardTop = topGap + 6 + (hasVersion ? 1 : 0) + 3 + 1; // 1-based
  const rowIdx = Math.floor((y - firstCardTop) / CARD_H);
  if (y < firstCardTop || rowIdx < 0 || rowIdx >= cardRows) return null;

  const inRow = Math.min(PER_ROW, count - rowIdx * PER_ROW);
  const rowWidth = inRow * CELL_W;
  const left0 = Math.max(0, Math.floor((columns - rowWidth) / 2)); // 0-based
  const colIdx = Math.floor((x - 1 - left0) / CELL_W);
  if (x - 1 < left0 || colIdx < 0 || colIdx >= inRow) return null;

  const index = rowIdx * PER_ROW + colIdx;
  return index < count ? index : null;
}

export function ProviderSelect(props: {
  theme: SlateTheme;
  providers: ProviderCardData[];
  selectedIndex: number;
  tick: number;
  width: number;
  version?: string;
}): React.ReactElement {
  const { theme, providers, selectedIndex, tick, width, version } = props;
  const rows: ProviderCardData[][] = [];
  for (let i = 0; i < providers.length; i += PER_ROW) rows.push(providers.slice(i, i + PER_ROW));

  return h(
    Box,
    { width, flexDirection: "column", alignItems: "center" },
    h(Logo, { theme }),
    version ? h(Text, { color: theme.muted }, `v${version}`) : null,
    h(Box, { height: 1 }),
    h(Text, { color: theme.muted }, "Select a provider"),
    h(Box, { height: 1 }),
    ...rows.map((row, ri) =>
      h(
        Box,
        { key: `row-${ri}`, flexDirection: "row" },
        ...row.map((p, ci) => {
          const idx = ri * PER_ROW + ci;
          return h(
            Box,
            { key: p.id, marginX: 1 },
            h(GridCard, {
              theme,
              icon: ICONS[p.id] ?? "○",
              title: p.title,
              body: p.body,
              status: statusFor(p.readiness, theme),
              selected: idx === selectedIndex,
              tick,
              width: CARD_W,
            }),
          );
        }),
      ),
    ),
    h(Box, { height: 1 }),
    h(HintBar, { text: "click a card · click again to confirm", theme }),
  );
}
