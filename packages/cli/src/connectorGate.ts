// Risk classes for the account-connector tools (Gmail, Google Workspace,
// Outlook) — what the structured gate in policyGate.ts sees.
//
// This matters more than each tool's own checkPermissions: on the garrison
// (Telegram / phone) a request the gate classifies as null is AUTO-ALLOWED,
// tool ask or not. So every action that reaches other people or destroys
// something must land in a REMOTE_GATED category here:
//   email_send          anything that puts words or files in front of someone
//                       else — send, reply, forward, unsubscribe (a mail or a
//                       POST to the sender), sharing a file, publishing a form
//   shell_destructive   irreversible-ish deletes: Gmail trash, Drive trash/delete
//   browser_submit      calendar events (attendees get invitations), matching
//                       how GoogleCalendar create is classed
//   credential_or_secret  reading a one-time sign-in code: an owner decision
//                       every time, and never with nobody watching
// Drafts, labels, archive and creating/editing the owner's own docs are
// private and reversible → null (runs freely). Tools not listed → undefined,
// so the caller's own switch decides.

import type { ActionCategory } from "@ares/effects";

type Classes = Record<string, ActionCategory>;

const CONNECTOR_CLASSES: Record<string, Classes> = {
  Gmail: {
    send: "email_send",
    reply: "email_send",
    forward: "email_send",
    unsubscribe: "email_send",
    draft: "email_draft",
    trash: "shell_destructive",
    find_code: "credential_or_secret",
  },
  Outlook: {
    send: "email_send",
    reply: "email_send",
    forward: "email_send",
    draft: "email_draft",
    create_event: "browser_submit",
  },
  GoogleDrive: {
    share: "email_send",
    trash: "shell_destructive",
    delete: "shell_destructive",
  },
  GoogleForms: {
    publish: "email_send",
  },
  GoogleDocs: {},
  GoogleSheets: {},
  GoogleSlides: {},
  GoogleTasks: {},
  GoogleContacts: {},
};

/**
 * The category for a connector tool call, null when that action is benign,
 * or undefined when `toolName` isn't a connector this table owns.
 */
export function connectorCategory(toolName: string, action: string): ActionCategory | null | undefined {
  const classes = CONNECTOR_CLASSES[toolName];
  if (!classes) return undefined;
  return classes[action] ?? null;
}
