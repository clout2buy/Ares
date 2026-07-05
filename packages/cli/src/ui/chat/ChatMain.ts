// The composed main screen — Header · ActivityHUD · Transcript · (todos ·
// palette) · spacer · StatusBar · InputDeck · Toolbar. This is the seam: inkTui
// keeps all its wiring and just renders <ChatMain> with mapped props, so the
// whole integration is snapshot-verifiable with a fixture (not blind).
//
// The Toolbar is the LAST row on purpose: tuiChrome.toolbarRow(screenH) ===
// screenH, so the existing mouse pipeline's bottom-row hit-test drives slate
// clicks without any new geometry.

import React from "react";
import { Box } from "ink";
import { SLATE } from "../theme.js";
import { Header } from "./Header.js";
import { StatusBar } from "./StatusBar.js";
import { Transcript, type LogLine } from "./LogRow.js";
import { InputDeck } from "./InputDeck.js";
import { Toolbar } from "./Toolbar.js";
import { ActivityHUD, type ActivityItem, type FleetRowVm } from "./ActivityHUD.js";

const h = React.createElement;

/** Map the engine's rich LogLine tones down to the slate row model. */
export function mapTone(tone: string): LogLine["tone"] {
  switch (tone) {
    case "user": return "user";
    case "tool": return "tool";
    case "error": return "error";
    case "notice":
    case "verify": return "notice";
    case "muted":
    case "diff-meta":
    case "diff-file": return "muted";
    default: return "assistant"; // assistant + diff-add/del render as prose here
  }
}

export interface ChatMainProps {
  snapshot: { model: string; workspace: string; mode?: string };
  lines: LogLine[];
  stats: { msgs: number; tokens?: number; ttft?: number; total?: number; turnElapsed?: number; tools?: number; agents?: number };
  git?: { branch?: string; dirty?: boolean };
  busy: boolean;
  tick: number;
  input: string;
  thinking?: boolean;
  /** Live reasoning-token estimate this turn — proves deep thought is alive. */
  thinkingTokens?: number;
  currentTool?: string;
  feed?: ActivityItem[];
  fleet?: { summary: string; rows: FleetRowVm[] };
  /** >0 = the user scrolled up N lines; Transcript shows the marker. */
  scrolled?: number;
  /** Pre-built host nodes (todo strip, command palette) slotted under the
   *  transcript — the host owns their state; ChatMain owns their place. */
  todosNode?: React.ReactNode;
  paletteNode?: React.ReactNode;
  /** The permission card. MUST sit directly above the status bar (4 rows) so
   *  tuiChrome.permHitTest()'s buttons-row math (screenH-6) holds. */
  permNode?: React.ReactNode;
  themeName: string;
  version: string;
  width: number;
  height: number;
}

export function ChatMain(props: ChatMainProps): React.ReactElement {
  const {
    snapshot, lines, stats, git, busy, tick, input, thinking, thinkingTokens, currentTool, feed, fleet,
    scrolled, todosNode, paletteNode, permNode, themeName, version, width, height,
  } = props;
  const mode = snapshot.mode === "plan" ? "plan" : snapshot.mode === "bypass" ? "bypass" : null;
  return h(
    Box,
    { flexDirection: "column", width, height, backgroundColor: SLATE.bg },
    h(Header, {
      theme: SLATE, model: snapshot.model, tokens: stats.tokens, workspace: snapshot.workspace,
      branch: git?.branch, dirty: git?.dirty, mode, busy, tick, width,
    }),
    h(ActivityHUD, { theme: SLATE, tick, thinking: busy && thinking, thinkingTokens, currentTool, feed, fleet }),
    h(Transcript, { theme: SLATE, lines, tick, scrolled, width }),
    todosNode ?? null,
    paletteNode ?? null,
    h(Box, { flexGrow: 1 }),
    permNode ?? null,
    h(StatusBar, {
      theme: SLATE, working: busy, tick, ttft: stats.ttft, total: stats.total, turnElapsed: stats.turnElapsed,
      msgs: stats.msgs, tools: stats.tools, agents: stats.agents, themeName, version, width,
    }),
    h(InputDeck, { theme: SLATE, value: input, focused: true, thinking: busy, tick, width }),
    h(Toolbar, { theme: SLATE, width }),
  );
}
