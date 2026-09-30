// Policy categories for the open-standard personal-data tools: Calendar and
// Contacts (CalDAV / CardDAV) and Mail (IMAP / SMTP).
//
// Each tool asks the owner itself (checkPermissions); this is the half that
// makes the ask STICK on the phone and in the unattended loop, where a request
// the gate classifies as null is auto-allowed and anything in a remote-gated
// category is denied without a human.
//   Mail send, reply                     → email_send (words in front of others)
//   Mail mark/flag/move                  → browser_submit (a real change to the
//                                          owner's mailbox; the GoogleCalendar class)
//   Calendar create/update event         → browser_submit
//   Calendar delete_event                → shell_destructive (irreversible)
//   Contacts create/update               → browser_submit
//   Contacts delete                      → shell_destructive
// Reads, and reminders (private, trivially undone), classify as nothing.
// `undefined` means "not one of these tools" so the caller carries on.

import type { ActionCategory } from "@ares/effects";

const MAIL: Record<string, ActionCategory> = {
  send: "email_send",
  reply: "email_send",
  mark_read: "browser_submit",
  mark_unread: "browser_submit",
  flag: "browser_submit",
  unflag: "browser_submit",
  move: "browser_submit",
};

const CALENDAR: Record<string, ActionCategory> = {
  create_event: "browser_submit",
  update_event: "browser_submit",
  delete_event: "shell_destructive",
};

const CONTACTS: Record<string, ActionCategory> = {
  create: "browser_submit",
  update: "browser_submit",
  delete: "shell_destructive",
};

export function davToolCategory(toolName: string, action: string): ActionCategory | null | undefined {
  switch (toolName) {
    case "Mail":
      return MAIL[action] ?? null;
    case "Calendar":
      return CALENDAR[action] ?? null;
    case "Contacts":
      return CONTACTS[action] ?? null;
    default:
      return undefined;
  }
}
