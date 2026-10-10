// Gmail API v1 operations of the Google preset. Curated from the discovery document
// https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest (fetched 2026-09-30).
// Host https://gmail.googleapis.com; the mailbox is always the signed-in user, so the
// {userId} path variable is fixed to "me" here (vendor: keeps the verifier matching).
//
// Left out on purpose: permanent delete (messages.delete / batchDelete / threads.delete),
// settings (forwarding, delegates, filters create, vacation, send-as: they redirect or
// expose the mailbox), import/insert, push watch.

import { JSON_BODY, arrOf, int, multi, obj, p, post, get, str, bool, type OpRow } from "../_kit.js";
import { HOST, fields, pageToken } from "./_common.js";

const server = HOST.gmail;
const V = "/gmail/v1/users/{userId}";

const RAW = str(
  "The whole message as RFC 2822 text, base64url-encoded, e.g. base64url('To: a@example.com\\r\\nSubject: Hi\\r\\nContent-Type: text/plain; charset=UTF-8\\r\\n\\r\\nHello'). The owner sees this text before anything is sent.",
);

const LABEL_BODY = (what: string) => JSON_BODY(obj(what, { addLabelIds: csvArr("Label ids to add, e.g. STARRED, IMPORTANT or a user label id"), removeLabelIds: csvArr("Label ids to remove, e.g. UNREAD takes a message out of unread, INBOX archives it") }));
function csvArr(description: string) {
  return arrOf(description, { type: "string" });
}

export const gmailOps: OpRow[] = [
  get("/gmail/v1/users/me/profile", "gmailGetProfile", "The signed-in Gmail account: email address, total messages and threads, current historyId", [fields("emailAddress,messagesTotal")], {
    server,
    tags: ["gmail", "account"],
    keywords: ["my email address", "who am i google", "gmail profile"],
    vendor: `GET ${V}/profile`,
  }),
  get(
    "/gmail/v1/users/me/messages",
    "gmailListMessages",
    "Search or list message ids (and thread ids) with Gmail search syntax; fetch each with gmailGetMessage",
    [
      p("q", "query", str("Gmail search, exactly as in the search box: is:unread, from:alice, subject:invoice, newer_than:2d, has:attachment, label:work, in:inbox")),
      p("labelIds", "query", multi("Only messages carrying ALL of these label ids (INBOX, UNREAD, STARRED, SENT, DRAFT, ...)")),
      p("maxResults", "query", int("How many (default 100, max 500)")),
      p("includeSpamTrash", "query", bool("Include Spam and Trash (default false)")),
      pageToken(),
    ],
    {
      server,
      tags: ["gmail", "mail"],
      keywords: ["my unread mail", "unread emails", "search my email", "emails from", "inbox", "find an email", "recent emails"],
      paginate: { style: "token", param: "pageToken", next: "nextPageToken", items: "messages", limitParam: "maxResults" },
      vendor: `GET ${V}/messages`,
    },
  ),
  get(
    "/gmail/v1/users/me/messages/{id}",
    "gmailGetMessage",
    "One message: headers, snippet, labels and (format full) the MIME parts with base64url bodies. Use format metadata for a cheap look",
    [
      p("id", "path", str("Message id from gmailListMessages")),
      p("format", "query", str("minimal = ids and labels; metadata = headers only; full = headers and bodies; raw = the whole RFC 2822 text", { enum: ["minimal", "metadata", "full", "raw"], default: "full" })),
      p("metadataHeaders", "query", multi("With format=metadata: only these headers, e.g. From, To, Subject, Date")),
      fields("id,threadId,labelIds,snippet,payload(headers)"),
    ],
    { server, tags: ["gmail", "mail"], keywords: ["read an email", "open the email", "email body"], vendor: `GET ${V}/messages/{id}` },
  ),
  get(
    "/gmail/v1/users/me/messages/{messageId}/attachments/{id}",
    "gmailGetAttachment",
    "One attachment of a message as base64url data (its attachmentId is in the message payload parts)",
    [p("messageId", "path", str("The message id")), p("id", "path", str("The attachmentId from the message part's body"))],
    { server, tags: ["gmail"], keywords: ["email attachment", "download attachment"], vendor: `GET ${V}/messages/{messageId}/attachments/{id}` },
  ),
  get(
    "/gmail/v1/users/me/threads",
    "gmailListThreads",
    "Search or list conversation threads (ids plus a snippet) with Gmail search syntax",
    [
      p("q", "query", str("Gmail search, e.g. is:unread from:alice newer_than:7d")),
      p("labelIds", "query", multi("Only threads carrying ALL of these label ids")),
      p("maxResults", "query", int("How many (default 100, max 500)")),
      p("includeSpamTrash", "query", bool("Include Spam and Trash (default false)")),
      pageToken(),
    ],
    {
      server,
      tags: ["gmail", "mail"],
      keywords: ["email threads", "conversations", "email conversation"],
      paginate: { style: "token", param: "pageToken", next: "nextPageToken", items: "threads", limitParam: "maxResults" },
      vendor: `GET ${V}/threads`,
    },
  ),
  get(
    "/gmail/v1/users/me/threads/{id}",
    "gmailGetThread",
    "A whole conversation: every message in it, oldest first",
    [
      p("id", "path", str("Thread id from gmailListThreads or a message's threadId")),
      p("format", "query", str("metadata = headers only; full = with bodies; minimal = ids and labels", { enum: ["minimal", "metadata", "full"], default: "full" })),
      p("metadataHeaders", "query", multi("With format=metadata: only these headers")),
      fields("id,messages(id,snippet,labelIds,payload(headers))"),
    ],
    { server, tags: ["gmail", "mail"], keywords: ["read the thread", "whole conversation"], vendor: `GET ${V}/threads/{id}` },
  ),
  get("/gmail/v1/users/me/labels", "gmailListLabels", "All labels (system and user) with ids, names and types", [], {
    server,
    tags: ["gmail", "labels"],
    keywords: ["my labels", "gmail folders"],
    vendor: `GET ${V}/labels`,
  }),
  get("/gmail/v1/users/me/labels/{id}", "gmailGetLabel", "One label with its message and thread totals and unread counts (INBOX gives the unread count)", [p("id", "path", str("Label id, e.g. INBOX, UNREAD or a user label id"))], {
    server,
    tags: ["gmail", "labels"],
    keywords: ["how many unread", "unread count"],
    vendor: `GET ${V}/labels/{id}`,
  }),
  get(
    "/gmail/v1/users/me/drafts",
    "gmailListDrafts",
    "Draft ids (each wraps a message id)",
    [p("q", "query", str("Gmail search over drafts")), p("maxResults", "query", int("How many (default 100)")), p("includeSpamTrash", "query", bool("Include drafts in Spam and Trash")), pageToken()],
    {
      server,
      tags: ["gmail", "drafts"],
      keywords: ["my drafts", "unsent emails"],
      paginate: { style: "token", param: "pageToken", next: "nextPageToken", items: "drafts", limitParam: "maxResults" },
      vendor: `GET ${V}/drafts`,
    },
  ),
  get(
    "/gmail/v1/users/me/drafts/{id}",
    "gmailGetDraft",
    "One draft with its message",
    [p("id", "path", str("Draft id")), p("format", "query", str("minimal, metadata, full or raw", { enum: ["minimal", "metadata", "full", "raw"], default: "full" }))],
    { server, tags: ["gmail", "drafts"], vendor: `GET ${V}/drafts/{id}` },
  ),
  get("/gmail/v1/users/me/settings/filters", "gmailListFilters", "The mailbox's automatic filters (criteria and actions); read only", [], {
    server,
    tags: ["gmail", "settings"],
    keywords: ["my gmail filters", "email rules"],
    vendor: `GET ${V}/settings/filters`,
  }),

  // ── changes ──
  post(
    "/gmail/v1/users/me/drafts",
    "gmailCreateDraft",
    "Save a draft (nothing is sent). Pass threadId to make it a reply inside a conversation; asks the owner",
    [],
    {
      server,
      tags: ["gmail", "drafts"],
      risk: "write",
      keywords: ["write a draft", "draft an email", "save as draft"],
      vendor: `POST ${V}/drafts`,
      body: JSON_BODY(obj("The draft", { message: obj("The message", { raw: RAW, threadId: str("Reply inside this thread (also put Subject: Re: ... and In-Reply-To in the headers)") }, ["raw"]) }, ["message"])),
    },
  ),
  post(
    "/gmail/v1/users/me/messages/send",
    "gmailSendMessage",
    "SEND an email now to the recipients in the To/Cc/Bcc headers of `raw`; the owner approves the exact message first",
    [],
    {
      server,
      tags: ["gmail", "mail"],
      risk: "message",
      message: { to: ["body.raw"], text: ["body.raw"] },
      keywords: ["send an email", "email someone", "reply to the email", "send mail"],
      vendor: `POST ${V}/messages/send`,
      body: JSON_BODY(obj("The message", { raw: RAW, threadId: str("Send as part of this thread (a reply)") }, ["raw"])),
    },
  ),
  post(
    "/gmail/v1/users/me/drafts/send",
    "gmailSendDraft",
    "SEND an existing draft now; the owner approves first",
    [],
    {
      server,
      tags: ["gmail", "drafts"],
      risk: "message",
      message: { to: ["body.id"], text: ["body.id"] },
      keywords: ["send the draft"],
      vendor: `POST ${V}/drafts/send`,
      body: JSON_BODY(obj("Which draft", { id: str("The draft id from gmailListDrafts") }, ["id"])),
    },
  ),
  post("/gmail/v1/users/me/messages/{id}/modify", "gmailModifyMessage", "Add or remove labels on one message (mark read = remove UNREAD, archive = remove INBOX, star = add STARRED); asks the owner", [p("id", "path", str("Message id"))], {
    server,
    tags: ["gmail", "labels"],
    risk: "write",
    keywords: ["mark as read", "archive an email", "star an email", "label an email"],
    vendor: `POST ${V}/messages/{id}/modify`,
    body: LABEL_BODY("Labels to change"),
  }),
  post("/gmail/v1/users/me/threads/{id}/modify", "gmailModifyThread", "Add or remove labels on every message of a thread; asks the owner", [p("id", "path", str("Thread id"))], {
    server,
    tags: ["gmail", "labels"],
    risk: "write",
    keywords: ["archive the conversation", "mark thread read"],
    vendor: `POST ${V}/threads/{id}/modify`,
    body: LABEL_BODY("Labels to change"),
  }),
  post("/gmail/v1/users/me/messages/batchModify", "gmailBatchModifyMessages", "Add or remove labels on up to 1000 messages at once; asks the owner", [], {
    server,
    tags: ["gmail", "labels"],
    risk: "write",
    keywords: ["mark all as read", "archive many emails", "bulk label"],
    vendor: `POST ${V}/messages/batchModify`,
    body: JSON_BODY(
      obj("Which messages and labels", { ids: csvArr("Message ids (up to 1000)"), addLabelIds: csvArr("Label ids to add"), removeLabelIds: csvArr("Label ids to remove") }, ["ids"]),
    ),
  }),
  post("/gmail/v1/users/me/labels", "gmailCreateLabel", "Create a user label; asks the owner", [], {
    server,
    tags: ["gmail", "labels"],
    risk: "write",
    keywords: ["new label", "create a label"],
    vendor: `POST ${V}/labels`,
    body: JSON_BODY(obj("The label", { name: str("Label name; use / for nesting, e.g. Clients/Acme"), labelListVisibility: str("labelShow, labelShowIfUnread or labelHide", { enum: ["labelShow", "labelShowIfUnread", "labelHide"] }), messageListVisibility: str("show or hide", { enum: ["show", "hide"] }) }, ["name"])),
  }),
  post("/gmail/v1/users/me/messages/{id}/untrash", "gmailUntrashMessage", "Bring a message back out of the Trash; asks the owner", [p("id", "path", str("Message id"))], {
    server,
    tags: ["gmail"],
    risk: "write",
    keywords: ["restore email from trash"],
    vendor: `POST ${V}/messages/{id}/untrash`,
  }),
  post("/gmail/v1/users/me/messages/{id}/trash", "gmailTrashMessage", "Move one message to the Trash (recoverable for 30 days); the owner decides", [p("id", "path", str("Message id"))], {
    server,
    tags: ["gmail"],
    risk: "destructive",
    keywords: ["delete an email", "trash an email"],
    vendor: `POST ${V}/messages/{id}/trash`,
  }),
  post("/gmail/v1/users/me/threads/{id}/trash", "gmailTrashThread", "Move a whole conversation to the Trash (recoverable for 30 days); the owner decides", [p("id", "path", str("Thread id"))], {
    server,
    tags: ["gmail"],
    risk: "destructive",
    keywords: ["delete the conversation", "trash the thread"],
    vendor: `POST ${V}/threads/{id}/trash`,
  }),
];

