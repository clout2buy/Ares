// Policy categories for the Marketplace tool (experimental Facebook Marketplace).
//
// Each Marketplace action that does anything beyond reading classifies into a
// category the gate already treats as an owner decision:
//   draft_message  → email_send       (the owner approves the exact words; it is
//                                      denied when nobody is present)
//   send           → email_send       (the message leaving; classified so a stray
//                                      generic ask is held / denied unattended too)
//   watch.add      → browser_submit   (a standing, recurring action on the account)
// Search, listing, inbox, watch.list / remove / check and status read or only
// adjust Ares's own state, so they classify as nothing and just run.
// `undefined` means "not this tool" so the caller carries on.
//
// Note draft_message is ALSO a per-call ownerDecision, which is what makes it
// ask under bypass / YOLO / ARES_TRUST_ALL (see remoteAutonomyDecision).

import type { ActionCategory } from "@ares/effects";

export const MARKETPLACE_TOOL = "Marketplace";

export function marketplaceToolCategory(toolName: string, action: string): ActionCategory | null | undefined {
  if (toolName !== MARKETPLACE_TOOL) return undefined;
  if (action === "draft_message" || action === "send") return "email_send";
  if (action === "watch.add") return "browser_submit";
  return null;
}
