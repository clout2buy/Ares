// @crix/tools — one file per tool.
// Each exports a Tool<I, O> built with buildTool() from _shared.ts.

export * from "./_shared.js";

export { ReadTool } from "./Read.js";
export { WriteTool } from "./Write.js";
export { EditTool } from "./Edit.js";
export { GlobTool } from "./Glob.js";
export { GrepTool } from "./Grep.js";
export { BashTool } from "./Bash.js";
export { PowerShellTool } from "./PowerShell.js";
export { TodoStore, makeTodoWriteTool, type TodoWriteOutput } from "./TodoWrite.js";

import { ReadTool } from "./Read.js";
import { WriteTool } from "./Write.js";
import { EditTool } from "./Edit.js";
import { GlobTool } from "./Glob.js";
import { GrepTool } from "./Grep.js";
import { BashTool } from "./Bash.js";
import { PowerShellTool } from "./PowerShell.js";

/** The default tool set wired into a fresh Session. */
export const DEFAULT_TOOLS = process.platform === "win32"
  ? [
      ReadTool,
      WriteTool,
      EditTool,
      GlobTool,
      GrepTool,
      PowerShellTool,
      BashTool,
    ] as const
  : [
      ReadTool,
      WriteTool,
      EditTool,
      GlobTool,
      GrepTool,
      BashTool,
      PowerShellTool,
    ] as const;
