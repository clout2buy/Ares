// The live activity HUD — deliberately FLAT (the anti-cutscene). Three stacked
// sections, all pure functions of tick:
//   1. thinking indicator (before any tool runs)
//   2. activity feed (last N tool calls with elapsed + ✓/✗)
//   3. fleet tree (a calm box-drawing squad list when subagents spawn)
// Height collapses to 0 when idle.

import React from "react";
import { Box, Text } from "ink";
import type { SlateTheme } from "../theme.js";
import { spinnerFrame, pulse } from "../useTick.js";
import { TitleTab } from "../primitives.js";

const h = React.createElement;

const KIND_ICON: Record<string, string> = {
  bash: "⚡", read: "📄", write: "📝", edit: "✏️", search: "🔍", fetch: "🌐", agent: "🤖", other: "⚙️",
};

export type ActStatus = "running" | "done" | "failed";
export interface ActivityItem {
  kind: string;
  label: string;
  elapsed?: string;
  status: ActStatus;
}
export interface FleetRowVm {
  glyph: string;
  name: string;
  activity: string;
  elapsed?: string;
  last?: boolean;
}

const THINK = ["Analyzing", "Planning", "Working", "Composing"];

export function ActivityHUD(props: {
  theme: SlateTheme;
  tick: number;
  thinking?: boolean;
  currentTool?: string;
  feed?: ActivityItem[];
  fleet?: { summary: string; rows: FleetRowVm[] };
}): React.ReactElement | null {
  const { theme, tick, thinking, currentTool, feed = [], fleet } = props;
  if (!thinking && feed.length === 0 && !fleet) return null;

  const kids: React.ReactNode[] = [];

  // 1. thinking / current tool
  if (thinking && feed.length === 0 && !fleet) {
    if (currentTool) {
      kids.push(h(Text, { key: "think", color: theme.active }, `⚡ Running ${currentTool}…`));
    } else {
      const phase = THINK[Math.floor(tick / 25) % THINK.length];
      kids.push(h(Text, { key: "think", color: pulse(tick) ? theme.primary : theme.secondary }, `✦ ${phase}…`));
    }
  }

  // 2. activity feed (last 5)
  for (const [i, a] of feed.slice(-5).entries()) {
    let icon: string;
    let iconColor: string;
    if (a.status === "running") {
      icon = pulse(tick) ? (KIND_ICON[a.kind] ?? "⚙️") : "·";
      iconColor = theme.secondary;
    } else if (a.status === "failed") {
      icon = "✗";
      iconColor = theme.danger;
    } else {
      icon = "✓";
      iconColor = theme.success;
    }
    kids.push(
      h(
        Text,
        { key: `a-${i}` },
        h(Text, { color: iconColor }, `${icon} `),
        h(Text, { color: a.status === "done" ? theme.muted : theme.text }, a.label),
        a.elapsed ? h(Text, { color: theme.faint }, `  ${a.elapsed}`) : null,
      ),
    );
  }

  // 3. fleet tree
  if (fleet && fleet.rows.length > 0) {
    kids.push(h(TitleTab, { key: "fleet-title", title: fleet.summary, color: theme.secondary, theme }));
    for (const [i, r] of fleet.rows.entries()) {
      kids.push(
        h(
          Text,
          { key: `f-${i}` },
          h(Text, { color: theme.line }, r.last ? "└─ " : "├─ "),
          h(Text, { color: theme.secondary, bold: true }, `${r.glyph} @${r.name}`),
          h(Text, { color: theme.line }, ": "),
          h(Text, { color: theme.muted }, r.activity),
          r.elapsed ? h(Text, { color: theme.faint }, `  ${r.elapsed}`) : null,
        ),
      );
    }
  }

  return h(Box, { flexDirection: "column", backgroundColor: theme.surface, paddingX: 1 }, ...kids);
}
