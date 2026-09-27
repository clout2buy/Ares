// The account-connector tools beyond Gmail/Calendar: the rest of Google
// Workspace (one "google" connection) and Outlook (one "outlook" connection).
//
// One array so DEFAULT_TOOLS spreads it once per platform instead of every
// new connector editing two hand-kept lists. None of these is core: they are
// deferred and found through ToolSearch by their descriptions — the Connect
// tool (core) is what the model reaches for first when an account is missing.

import { GoogleDriveTool } from "./GoogleDrive.js";
import { GoogleDocsTool } from "./GoogleDocs.js";
import { GoogleSheetsTool } from "./GoogleSheets.js";
import { GoogleSlidesTool } from "./GoogleSlides.js";
import { GoogleFormsTool } from "./GoogleForms.js";
import { GoogleTasksTool } from "./GoogleTasks.js";
import { GoogleContactsTool } from "./GoogleContacts.js";
import { OutlookTool } from "./Outlook.js";

export const CONNECTOR_TOOLS = [
  GoogleDriveTool,
  GoogleDocsTool,
  GoogleSheetsTool,
  GoogleSlidesTool,
  GoogleFormsTool,
  GoogleTasksTool,
  GoogleContactsTool,
  OutlookTool,
] as const;
