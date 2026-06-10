// @ares/tools — one file per tool.
// Each exports a Tool<I, O> built with buildTool() from _shared.ts.

export * from "./_shared.js";

export { ReadTool } from "./Read.js";
export { WriteTool } from "./Write.js";
export { EditTool } from "./Edit.js";
export { ApplyIntentTool, type ApplyIntentOutput } from "./ApplyIntent.js";
export { safeOverwrite, assessShrink, type SafeOverwriteOptions, type SafeOverwriteResult, type ShrinkVerdict } from "./safeWrite.js";
export { GlobTool } from "./Glob.js";
export { GrepTool } from "./Grep.js";
export { BashTool } from "./Bash.js";
export { PowerShellTool } from "./PowerShell.js";
export { LspTool, type LspOutput, type LspLocation } from "./LSP.js";
export { TodoStore, makeTodoWriteTool, type TodoWriteOutput } from "./TodoWrite.js";
export { makeTaskTool, type SubagentRunner, type TaskOutput } from "./Task.js";
export {
  makeWebFetchTool,
  htmlToText,
  type WebFetchOutput,
  type Summarizer,
} from "./WebFetch.js";
export {
  makeWebSearchTool,
  duckDuckGoLite,
  parseDuckDuckGoLite,
  type WebSearchResult,
  type WebSearchOutput,
  type SearchBackend,
} from "./WebSearch.js";
export {
  CodebaseSearchTool,
  type CodebaseSearchHit,
  type CodebaseSearchOutput,
} from "./CodebaseSearch.js";
export { FindAndEditTool, type FindAndEditOutput, type FindAndEditChange } from "./FindAndEdit.js";
export { CodeModeTool, type CodeModeOutput } from "./CodeMode.js";
export {
  ShellRegistry,
  type ShellSnapshot,
  type ShellLaunchOptions,
} from "./ShellRegistry.js";
export { makeBashOutputTool, type BashOutputResult } from "./BashOutput.js";
export { makeKillShellTool, type KillShellOutput } from "./KillShell.js";
export { McpListToolsTool, McpCallTool, type McpListOutput, type McpCallOutput } from "./Mcp.js";
export { SkillsListTool, SkillReadTool, type SkillsListOutput, type SkillReadOutput, type SkillSummary } from "./Skills.js";
export { MemoryTool, type MemoryOutput, type MemoryItem } from "./Memory.js";
export { makeEnterPlanModeTool, makeExitPlanModeTool, type PlanModeState } from "./PlanMode.js";

import { ReadTool } from "./Read.js";
import { WriteTool } from "./Write.js";
import { EditTool } from "./Edit.js";
import { ApplyIntentTool } from "./ApplyIntent.js";
import { GlobTool } from "./Glob.js";
import { GrepTool } from "./Grep.js";
import { BashTool } from "./Bash.js";
import { PowerShellTool } from "./PowerShell.js";
import { LspTool } from "./LSP.js";
import { CodebaseSearchTool } from "./CodebaseSearch.js";
import { FindAndEditTool } from "./FindAndEdit.js";
import { CodeModeTool } from "./CodeMode.js";
import { McpListToolsTool, McpCallTool } from "./Mcp.js";
import { SkillsListTool, SkillReadTool } from "./Skills.js";
import { MemoryTool } from "./Memory.js";

/** The default tool set wired into a fresh Session. */
export const DEFAULT_TOOLS = process.platform === "win32"
  ? [
      ReadTool,
      WriteTool,
      EditTool,
      ApplyIntentTool,
      GlobTool,
      GrepTool,
      CodebaseSearchTool,
      LspTool,
      PowerShellTool,
      BashTool,
      FindAndEditTool,
      CodeModeTool,
      McpListToolsTool,
      McpCallTool,
      SkillsListTool,
      SkillReadTool,
      MemoryTool,
    ] as const
  : [
      ReadTool,
      WriteTool,
      EditTool,
      ApplyIntentTool,
      GlobTool,
      GrepTool,
      CodebaseSearchTool,
      LspTool,
      BashTool,
      PowerShellTool,
      FindAndEditTool,
      CodeModeTool,
      McpListToolsTool,
      McpCallTool,
      SkillsListTool,
      SkillReadTool,
      MemoryTool,
    ] as const;
