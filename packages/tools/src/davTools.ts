// The open-standard personal-data tools as ONE array, so DEFAULT_TOOLS spreads
// it once per platform (same pattern as connectorTools.ts). All three are
// deferred: found through ToolSearch by their descriptions; the Connect tool
// (core) is what the model reaches for first when an account is missing.

import { CalendarTool, ContactsTool } from "./Dav.js";
import { MailTool } from "./ImapMail.js";

export const DAV_TOOLS = [CalendarTool, ContactsTool, MailTool] as const;
