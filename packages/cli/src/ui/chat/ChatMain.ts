// The composed main screen — Header · ActivityHUD · Transcript · (spacer) ·
// StatusBar · InputDeck. This is the seam: inkTui keeps all its wiring and just
// renders <ChatMain> with mapped props, so the whole integration is snapshot-
// verifiable with a fixture (not blind).

import React from "react";
import { Box } from "ink";
import { SLATE } from "../theme.js";
import { Header } from "./Header.js";
import { StatusBar } from "./StatusBar.js";
import { Transcript, type LogLine } from "./LogRow.js";
import { InputDeck } from "./InputDeck.js";
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
  stats: { msgs: number; tokens?: number; ttft?: number; total?: number; agents?: number };
  git?: { branch?: string; dirty?: boolean };
  busy: boolean;
  tick: number;
  input: string;
  thinking?: boolean;
  currentTool?: string;
  feed?: ActivityItem[];
  fleet?: { summary: string; rows: FleetRowVm[] };
  themeName: string;
  version: string;
  width: number;
  height: number;
}

export function ChatMain(props: ChatMainProps): React.ReactElement {
  const { snapshot, lines, stats, git, busy, tick, input, thinking, currentTool, feed, fleet, themeName, version, width, height } = props;
  const mode = snapshot.mode === "plan" ? "plan" : snapshot.mode === "bypass" ? "bypass" : null;
  return h(
    Box,
    { flexDirection: "column", width, height, backgroundColor: SLATE.bg },
    h(Header, {
      theme: SLATE, model: snapshot.model, tokens: stats.tokens, workspace: snapshot.workspace,
      branch: git?.branch, dirty: git?.dirty, mode, width,
    }),
    h(ActivityHUD, { theme: SLATE, tick, thinking: busy && thinking, currentTool, feed, fleet }),
    h(Transcript, { theme: SLATE, lines, width }),
    h(Box, { flexGrow: 1 }),
    h(InputDeck, { theme: SLATE, value: input, focused: true, thinking: busy, tick, width }),
    h(StatusBar, {
      theme: SLATE, working: busy, tick, ttft: stats.ttft, total: stats.total,
      msgs: stats.msgs, agents: stats.agents, themeName, version, width,
    }),
  );
}
