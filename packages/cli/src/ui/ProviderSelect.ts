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
  ollama: "◈", openai: "◐", anthropic: "✦", deepseek: "⬡", openrouter: "⬢", moa: "🜲", mock: "○",
};

function statusFor(r: Readiness, theme: SlateTheme): { text: string; color: string } {
  if (r === "ready") return { text: "● ready", color: theme.success };
  if (r === "oauth") return { text: "◐ sign in", color: theme.secondary };
  return { text: "○ no key", color: theme.danger };
}

const CARD_W = 26;
const PER_ROW = 3;

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
