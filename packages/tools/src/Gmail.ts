// Gmail — read, triage and write the owner's mail, at parity with a human
// using the Gmail app: search/read, send, draft, threaded reply, forward,
// labels, archive, trash, unsubscribe, and one-time sign-in codes.
//
// Everything that puts words in front of someone else (send / reply /
// forward / unsubscribe-by-mail) asks first, and the ask carries the exact
// recipient, subject and body — the owner approves the TEXT, not "an email".
// Trash asks too. Drafts, labels and archive don't: they are private and
// reversible. find_code is its own contract (see the section below): the
// code it finds never reaches the model.

import { z } from "zod";
import { getValidAccessToken, OAUTH_PROVIDERS, mintSecretHandle } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { previewForApproval } from "./googleApi.js";
import {
  addressesIn,
  allowedSenderDomains,
  authenticatedFor,
  extractCodes,
  htmlToText,
  matchesMaskedRecipient,
  parseSiteOrigin,
  senderDomainAllowed,
} from "./oneTimeCode.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** A code handle lives this long and redeems once. */
export const CODE_HANDLE_TTL_MS = 5 * 60_000;
export const CODE_LOOKBACK_DEFAULT_MIN = 10;
export const CODE_LOOKBACK_MAX_MIN = 15;

const ACTIONS = [
  "list_messages", "read_message", "search", "send", "draft", "reply", "forward",
  "list_labels", "add_labels", "remove_labels", "archive", "trash", "unsubscribe", "find_code",
] as const;

const inputSchema = z.object({
  action: z.enum(ACTIONS).describe(
    "list_messages: recent inbox messages. read_message: read one message by id. search: Gmail query syntax. " +
    "send: send a new email (to, subject, body). draft: save a draft (add message_id to draft a threaded reply). " +
    "reply: threaded reply to message_id (reply_all for everyone). forward: forward message_id to `to` with an optional note in body. " +
    "list_labels / add_labels / remove_labels (message_id + labels by name). archive: remove from inbox. trash: move to trash. " +
    "unsubscribe: use the message's List-Unsubscribe (one-click or mailto). " +
    "find_code: look up a one-time code a website just emailed, for the Browser to fill — needs site, step, channel, recipient_masked; returns a handle, never the code.",
  ),
  message_id: z.string().optional().describe("Message id — for read_message, reply, forward, labels, archive, trash, unsubscribe; optional for draft (makes it a threaded reply draft)."),
  to: z.string().optional().describe("Recipient address(es), comma-separated — send, draft, forward."),
  cc: z.string().optional().describe("Cc address(es), comma-separated."),
  subject: z.string().optional().describe("Subject — send and draft (replies/forwards derive it)."),
  body: z.string().optional().describe("Plain-text body. For forward: a note above the forwarded message."),
  reply_all: z.boolean().optional().describe("reply/draft-reply: include every original recipient."),
  labels: z.array(z.string()).optional().describe("Label names (or ids) for add_labels / remove_labels."),
  query: z.string().optional().describe("Gmail search query (e.g. 'from:boss is:unread'). Used with search."),
  max_results: z.number().optional().describe("Max messages to return (default 10, max 25)."),
  site: z.string().optional().describe("find_code: exact https origin of the page showing the challenge, e.g. https://www.doordash.com"),
  step: z.string().optional().describe("find_code: what the challenge is — 'sign-in', 'checkout verification'…"),
  channel: z.string().optional().describe("find_code: where the page said it sent the code. Only 'email' is supported."),
  recipient_masked: z.string().optional().describe("find_code: the masked address the page says it sent to, exactly as shown (e.g. c•••@gmail.com)."),
  within_minutes: z.number().int().min(1).max(CODE_LOOKBACK_MAX_MIN).optional().describe(`find_code: how far back to look (default ${CODE_LOOKBACK_DEFAULT_MIN}, max ${CODE_LOOKBACK_MAX_MIN}).`),
});

type Input = z.infer<typeof inputSchema>;

type Header = { name: string; value: string };
interface GmailPart { mimeType?: string; filename?: string; headers?: Header[]; body?: { data?: string; size?: number }; parts?: GmailPart[] }
interface GmailMessage { id: string; threadId?: string; snippet?: string; internalDate?: string; labelIds?: string[]; payload?: GmailPart }

export interface GmailOutput {
  messages?: Array<{ id: string; from: string; subject: string; snippet: string; date: string }>;
  message?: { id: string; threadId?: string; from: string; to: string; subject: string; body: string; date: string };
  sent?: { id: string; threadId?: string };
  draft?: { id: string };
  labels?: Array<{ id: string; name: string; type?: string }>;
  unsubscribed?: { method: "one-click" | "mailto" | "link"; target: string };
  /** find_code: an opaque handle for Browser fill_secret — never the code. */
  code?: { handle: string; sender: string; receivedAt: string; site: string };
  message_text: string;
}

async function gmailFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getValidAccessToken(OAUTH_PROVIDERS.google);
  const res = await fetch(`${GMAIL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${(await res.text().catch(() => res.statusText)).slice(0, 400)}`);
  return res;
}

async function gmailJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await gmailFetch(path, init)).json()) as T;
}

function decodeBase64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function headerVal(headers: Header[] | undefined, name: string): string {
  return (headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function headerVals(headers: Header[] | undefined, name: string): string[] {
  return (headers ?? []).filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value);
}

/** The readable body of a (possibly deeply nested multipart) message:
 *  text/plain wins; else text/html flattened to text. */
export function gmailBodyText(part: GmailPart | undefined): string {
  if (!part) return "";
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: GmailPart) => {
    if (p.filename) return; // attachments are not the body
    const type = (p.mimeType ?? "").toLowerCase();
    if (p.body?.data && type === "text/plain") plain.push(decodeBase64Url(p.body.data));
    else if (p.body?.data && type === "text/html") html.push(decodeBase64Url(p.body.data));
    else if (p.body?.data && !p.parts && !type.startsWith("multipart/")) plain.push(decodeBase64Url(p.body.data));
    for (const child of p.parts ?? []) walk(child);
  };
  walk(part);
  if (plain.join("").trim()) return plain.join("\n").trim();
  return htmlToText(html.join("\n"));
}

/** RFC 2047 for non-ASCII header values (subjects with accents, emoji). */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

/** Strip CR/LF so a subject or address can never inject extra headers. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export interface MimeInput {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

/** The base64url RFC 2822 message Gmail's send/draft endpoints take. */
export function buildRfc2822(msg: MimeInput): string {
  const lines = [
    `To: ${oneLine(msg.to)}`,
    ...(msg.cc ? [`Cc: ${oneLine(msg.cc)}`] : []),
    `Subject: ${encodeHeader(oneLine(msg.subject))}`,
    ...(msg.inReplyTo ? [`In-Reply-To: ${oneLine(msg.inReplyTo)}`] : []),
    ...(msg.references ? [`References: ${oneLine(msg.references)}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    msg.body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");
}

function prefixed(prefix: "Re:" | "Fwd:", subject: string): string {
  const re = prefix === "Re:" ? /^\s*re\s*:/i : /^\s*(fwd?|fw)\s*:/i;
  return re.test(subject) ? subject : `${prefix} ${subject}`.trim();
}

// ─── Reply context (shared by the permission prompt and the call) ─────────

interface ReplyContext {
  threadId?: string;
  to: string;
  cc?: string;
  subject: string;
  inReplyTo?: string;
  references?: string;
}

const REPLY_HEADERS = ["From", "Reply-To", "To", "Cc", "Subject", "Message-ID", "Message-Id", "References"];

async function ownAddress(): Promise<string> {
  const profile = await gmailJson<{ emailAddress?: string }>("/profile");
  return (profile.emailAddress ?? "").toLowerCase();
}

async function replyContext(messageId: string, replyAll: boolean): Promise<ReplyContext> {
  const params = new URLSearchParams({ format: "metadata" });
  for (const h of REPLY_HEADERS) params.append("metadataHeaders", h);
  const msg = await gmailJson<GmailMessage>(`/messages/${encodeURIComponent(messageId)}?${params}`);
  const hdrs = msg.payload?.headers ?? [];
  const messageIdHeader = headerVal(hdrs, "Message-ID") || headerVal(hdrs, "Message-Id");
  const refs = headerVal(hdrs, "References");
  const primary = headerVal(hdrs, "Reply-To") || headerVal(hdrs, "From");
  let cc: string | undefined;
  if (replyAll) {
    const me = await ownAddress().catch(() => "");
    const primaryAddrs = new Set(addressesIn([primary]));
    const others = addressesIn([headerVal(hdrs, "To"), headerVal(hdrs, "Cc")]).filter((a) => a !== me && !primaryAddrs.has(a));
    if (others.length) cc = [...new Set(others)].join(", ");
  }
  return {
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
    to: primary,
    ...(cc ? { cc } : {}),
    subject: prefixed("Re:", headerVal(hdrs, "Subject")),
    ...(messageIdHeader ? { inReplyTo: messageIdHeader, references: [refs, messageIdHeader].filter(Boolean).join(" ") } : {}),
  };
}

// ─── Unsubscribe (RFC 2369 List-Unsubscribe + RFC 8058 one-click) ─────────

export interface UnsubscribePlan {
  method: "one-click" | "mailto" | "link" | "none";
  target: string;
  mailto?: { to: string; subject: string; body: string };
}

/** Pick how to unsubscribe from a message's List-Unsubscribe headers.
 *  One-click POST only when the sender opted in with List-Unsubscribe-Post
 *  (RFC 8058) — a bare https link may need a human, so it is returned, not hit. */
export function planUnsubscribe(listUnsubscribe: string, listUnsubscribePost: string): UnsubscribePlan {
  const entries = [...listUnsubscribe.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  const https = entries.find((e) => /^https:\/\//i.test(e));
  const mailto = entries.find((e) => /^mailto:/i.test(e));
  if (https && /List-Unsubscribe\s*=\s*One-Click/i.test(listUnsubscribePost)) return { method: "one-click", target: https };
  if (mailto) {
    const url = new URL(mailto);
    const to = decodeURIComponent(url.pathname);
    return {
      method: "mailto",
      target: to,
      mailto: { to, subject: url.searchParams.get("subject") ?? "unsubscribe", body: url.searchParams.get("body") ?? "unsubscribe" },
    };
  }
  if (https) return { method: "link", target: https };
  return { method: "none", target: "" };
}

async function unsubscribeHeaders(messageId: string): Promise<{ from: string; plan: UnsubscribePlan }> {
  const params = new URLSearchParams({ format: "metadata" });
  for (const h of ["From", "List-Unsubscribe", "List-Unsubscribe-Post"]) params.append("metadataHeaders", h);
  const msg = await gmailJson<GmailMessage>(`/messages/${encodeURIComponent(messageId)}?${params}`);
  const hdrs = msg.payload?.headers ?? [];
  return { from: headerVal(hdrs, "From"), plan: planUnsubscribe(headerVal(hdrs, "List-Unsubscribe"), headerVal(hdrs, "List-Unsubscribe-Post")) };
}

// ─── find_code ────────────────────────────────────────────────────────────
//
// The contract, each rule load-bearing (see oneTimeCode.ts for the why):
// every field is required; the search is scoped to the last N minutes and
// the site's own sender domain; each candidate is OPENED and must be
// DKIM/DMARC-authenticated and addressed to the masked recipient; the code
// comes from the body; exactly one distinct code or nothing. The code is
// minted into a single-use, site-bound, 5-minute secret handle — the model,
// the chat and the rollout only ever see the handle.

const NO_CODE = "no unambiguous code; stop and ask the owner";

export function findCodeInputProblem(input: Input): string | null {
  const missing = (["site", "step", "channel", "recipient_masked"] as const).filter((k) => !String(input[k] ?? "").trim());
  if (missing.length) return `find_code refused: missing ${missing.join(", ")}. The browser task must supply the challenge page's https origin, the step, the channel and the masked recipient it shows.`;
  if (!parseSiteOrigin(input.site)) return "find_code refused: site must be the exact https origin of the challenge page (e.g. https://www.doordash.com) — no path, no query.";
  if (input.channel!.trim().toLowerCase() !== "email") return `find_code refused: channel "${input.channel}" is not supported — only email.`;
  if (!input.recipient_masked!.includes("@")) return "find_code refused: recipient_masked must be the masked email address the page shows (e.g. c•••@gmail.com).";
  return null;
}

interface CodeHit { code: string; sender: string; receivedAt: number }

async function findCode(input: Input): Promise<ToolResult<GmailOutput>> {
  const problem = findCodeInputProblem(input);
  if (problem) return { output: { message_text: problem }, display: "find_code refused", failure: problem };
  const site = parseSiteOrigin(input.site)!;
  const minutes = Math.min(input.within_minutes ?? CODE_LOOKBACK_DEFAULT_MIN, CODE_LOOKBACK_MAX_MIN);
  const cutoff = Date.now() - minutes * 60_000;
  const domains = allowedSenderDomains(site);
  const fromClause = domains.length === 1 ? `from:${domains[0]}` : `from:(${domains.join(" OR ")})`;
  const q = `${fromClause} after:${Math.floor(cutoff / 1000)}`;
  const list = await gmailJson<{ messages?: Array<{ id: string }> }>(`/messages?${new URLSearchParams({ q, maxResults: "10", includeSpamTrash: "false" })}`);

  const hits: CodeHit[] = [];
  for (const { id } of list.messages ?? []) {
    const msg = await gmailJson<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
    const hdrs = msg.payload?.headers ?? [];
    const receivedAt = Number(msg.internalDate ?? 0);
    if (!receivedAt || receivedAt < cutoff) continue;
    const from = headerVal(hdrs, "From");
    const senderDomain = senderDomainAllowed(from, domains);
    if (!senderDomain) continue;
    if (!authenticatedFor(headerVals(hdrs, "Authentication-Results"), senderDomain)) continue;
    const recipients = addressesIn([...headerVals(hdrs, "To"), ...headerVals(hdrs, "Cc"), ...headerVals(hdrs, "Delivered-To")]);
    if (!recipients.some((a) => matchesMaskedRecipient(a, input.recipient_masked!))) continue;
    for (const code of extractCodes(gmailBodyText(msg.payload))) hits.push({ code, sender: from, receivedAt });
  }

  const distinct = [...new Set(hits.map((h) => h.code))];
  if (distinct.length !== 1) {
    const why = distinct.length === 0
      ? `no authenticated message from ${domains.join("/")} to ${input.recipient_masked} in the last ${minutes} min carried a code`
      : `${distinct.length} different codes matched`;
    const message = `${NO_CODE} (${why}). Do not retry another way.`;
    return { output: { message_text: message }, display: "No unambiguous code", failure: message };
  }
  const latest = hits.filter((h) => h.code === distinct[0]).sort((a, b) => b.receivedAt - a.receivedAt)[0]!;
  const handle = mintSecretHandle(distinct[0]!, { site: site.origin, purpose: `${input.step!.trim()} code` }, { ttlMs: CODE_HANDLE_TTL_MS, uses: 1 });
  const receivedAt = new Date(latest.receivedAt).toISOString();
  const code = { handle, sender: latest.sender, receivedAt, site: site.origin };
  return {
    output: {
      code,
      message_text: `Code found (from ${latest.sender} at ${receivedAt}) and held as ${handle} — single use, 5 minutes, only for ${site.origin}. Fill it with the Browser's fill_secret action; you never see the code itself.`,
    },
    display: `Code ready for ${site.hostname}`,
  };
}

// ─── The tool ─────────────────────────────────────────────────────────────

function sendPrompt(verb: string, to: string, subject: string, body: string | undefined, cc?: string): string {
  return `${verb} via Gmail\nTo: ${to}${cc ? `\nCc: ${cc}` : ""}\nSubject: ${subject}\n\n${previewForApproval(body)}`;
}

export const GmailTool = buildTool<typeof inputSchema, GmailOutput>({
  name: "Gmail",
  description:
    "Read and write the owner's Gmail: list, search and read mail; send, draft, reply (threaded) and forward; " +
    "list/add/remove labels, archive, trash, unsubscribe; and look up a one-time code a website just emailed (find_code). " +
    "Requires Google to be connected via the Connect tool first.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  // SENDING mail is an irreversible OUTWARD effect — it must cross the gate, never
  // auto-allow, and the owner approves the exact text. Reads stay free.
  async checkPermissions(input) {
    switch (input.action) {
      case "send":
        return { kind: "ask", prompt: sendPrompt("Send an email", input.to ?? "(no recipient)", input.subject ?? "(no subject)", input.body, input.cc), suggestion: "allow_once" };
      case "reply": {
        const ctx = input.message_id ? await replyContext(input.message_id, Boolean(input.reply_all)).catch(() => null) : null;
        return { kind: "ask", prompt: sendPrompt(input.reply_all ? "Reply all" : "Reply", ctx?.to ?? `the sender of message ${input.message_id ?? "?"}`, ctx?.subject ?? "(re: original)", input.body, ctx?.cc), suggestion: "allow_once" };
      }
      case "forward":
        return { kind: "ask", prompt: sendPrompt(`Forward message ${input.message_id ?? "?"}`, input.to ?? "(no recipient)", "Fwd: (original subject)", input.body || "(no note — the original message only)", input.cc), suggestion: "allow_once" };
      case "trash":
        return { kind: "ask", prompt: `Move Gmail message ${input.message_id ?? "?"} to the trash`, suggestion: "allow_once" };
      case "unsubscribe": {
        const info = input.message_id ? await unsubscribeHeaders(input.message_id).catch(() => null) : null;
        const how = info?.plan.method === "mailto" ? `by emailing ${info.plan.target}` : info?.plan.method === "one-click" ? `via one-click (${info.plan.target})` : "";
        return { kind: "ask", prompt: `Unsubscribe from ${info?.from || "this sender"}${how ? ` ${how}` : ""}`, suggestion: "allow_once" };
      }
      case "find_code":
        return {
          kind: "ask",
          prompt: `Read the ${input.step ?? "sign-in"} code ${input.site ?? "a site"} emailed to ${input.recipient_masked ?? "you"}, so Ares can fill it on that site (Ares will not see the code)`,
          suggestion: "allow_once",
        };
      default:
        return { kind: "allow" };
    }
  },
  activityDescription: (input) => {
    switch (input.action) {
      case "list_messages": return "Checking inbox";
      case "read_message": return "Reading email";
      case "send": return `Sending email to ${input.to ?? ""}`;
      case "draft": return "Saving a draft";
      case "reply": return "Replying";
      case "forward": return `Forwarding to ${input.to ?? ""}`;
      case "search": return `Searching: ${input.query ?? ""}`;
      case "list_labels": return "Listing labels";
      case "add_labels":
      case "remove_labels": return "Updating labels";
      case "archive": return "Archiving";
      case "trash": return "Moving to trash";
      case "unsubscribe": return "Unsubscribing";
      case "find_code": return `Looking up a code from ${input.site ?? "a site"}`;
      default: return "Gmail";
    }
  },
  async call(input: Input): Promise<ToolResult<GmailOutput>> {
    const need = (field: keyof Input): ToolResult<GmailOutput> | null =>
      input[field] ? null : { output: { message_text: `${String(field)} is required for ${input.action}.` }, display: `Missing ${String(field)}.` };

    switch (input.action) {
      case "list_messages":
      case "search": {
        const max = Math.min(input.max_results ?? 10, 25);
        const params = new URLSearchParams({ maxResults: String(max) });
        if (input.query) params.set("q", input.query);
        else if (input.action === "list_messages") params.set("labelIds", "INBOX");
        const listData = await gmailJson<{ messages?: Array<{ id: string }> }>(`/messages?${params}`);
        if (!listData.messages?.length) return { output: { messages: [], message_text: "No messages found." }, display: "No messages." };
        const messages = await Promise.all(
          listData.messages.slice(0, max).map(async (m) => {
            const msg = await gmailJson<GmailMessage>(`/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
            const hdrs = msg.payload?.headers ?? [];
            return { id: msg.id, from: headerVal(hdrs, "From"), subject: headerVal(hdrs, "Subject"), snippet: msg.snippet ?? "", date: headerVal(hdrs, "Date") };
          }),
        );
        const lines = messages.map((m) => `${m.date} | ${m.from} [${m.id}]\n  ${m.subject}\n  ${m.snippet}`);
        return { output: { messages, message_text: lines.join("\n\n") }, display: `${messages.length} messages` };
      }

      case "read_message": {
        const missing = need("message_id");
        if (missing) return missing;
        const msg = await gmailJson<GmailMessage>(`/messages/${encodeURIComponent(input.message_id!)}?format=full`);
        const hdrs = msg.payload?.headers ?? [];
        const message = {
          id: msg.id,
          ...(msg.threadId ? { threadId: msg.threadId } : {}),
          from: headerVal(hdrs, "From"),
          to: headerVal(hdrs, "To"),
          subject: headerVal(hdrs, "Subject"),
          body: gmailBodyText(msg.payload).slice(0, 10000),
          date: headerVal(hdrs, "Date"),
        };
        return { output: { message, message_text: `From: ${message.from}\nTo: ${message.to}\nDate: ${message.date}\nSubject: ${message.subject}\n\n${message.body}` }, display: message.subject };
      }

      case "send": {
        if (!input.to || !input.subject || !input.body) return { output: { message_text: "to, subject, and body are required." }, display: "Missing fields." };
        const raw = buildRfc2822({ to: input.to, ...(input.cc ? { cc: input.cc } : {}), subject: input.subject, body: input.body });
        const sent = await gmailJson<{ id: string; threadId?: string }>("/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
        return { output: { sent: { id: sent.id, ...(sent.threadId ? { threadId: sent.threadId } : {}) }, message_text: `Email sent to ${input.to}.` }, display: `Sent to ${input.to}` };
      }

      case "draft": {
        if (!input.body) return { output: { message_text: "body is required for draft." }, display: "Missing body." };
        let message: { raw: string; threadId?: string };
        if (input.message_id) {
          const ctx = await replyContext(input.message_id, Boolean(input.reply_all));
          message = {
            raw: buildRfc2822({ to: input.to ?? ctx.to, ...(input.cc ?? ctx.cc ? { cc: input.cc ?? ctx.cc } : {}), subject: input.subject ?? ctx.subject, body: input.body, ...(ctx.inReplyTo ? { inReplyTo: ctx.inReplyTo, references: ctx.references } : {}) }),
            ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
          };
        } else {
          message = { raw: buildRfc2822({ to: input.to ?? "", ...(input.cc ? { cc: input.cc } : {}), subject: input.subject ?? "", body: input.body }) };
        }
        const draft = await gmailJson<{ id: string }>("/drafts", { method: "POST", body: JSON.stringify({ message }) });
        return { output: { draft: { id: draft.id }, message_text: `Draft saved (${draft.id}). It is in Gmail's Drafts — nothing was sent.` }, display: "Draft saved" };
      }

      case "reply": {
        const missing = need("message_id") ?? need("body");
        if (missing) return missing;
        const ctx = await replyContext(input.message_id!, Boolean(input.reply_all));
        const raw = buildRfc2822({ to: ctx.to, ...(ctx.cc ? { cc: ctx.cc } : {}), subject: ctx.subject, body: input.body!, ...(ctx.inReplyTo ? { inReplyTo: ctx.inReplyTo, references: ctx.references } : {}) });
        const sent = await gmailJson<{ id: string; threadId?: string }>("/messages/send", { method: "POST", body: JSON.stringify({ raw, ...(ctx.threadId ? { threadId: ctx.threadId } : {}) }) });
        return { output: { sent: { id: sent.id, ...(sent.threadId ? { threadId: sent.threadId } : {}) }, message_text: `Replied to ${ctx.to}${ctx.cc ? ` (cc ${ctx.cc})` : ""} in the same thread.` }, display: `Replied to ${ctx.to}` };
      }

      case "forward": {
        const missing = need("message_id") ?? need("to");
        if (missing) return missing;
        const msg = await gmailJson<GmailMessage>(`/messages/${encodeURIComponent(input.message_id!)}?format=full`);
        const hdrs = msg.payload?.headers ?? [];
        const quoted = [
          "---------- Forwarded message ---------",
          `From: ${headerVal(hdrs, "From")}`,
          `Date: ${headerVal(hdrs, "Date")}`,
          `Subject: ${headerVal(hdrs, "Subject")}`,
          `To: ${headerVal(hdrs, "To")}`,
          "",
          gmailBodyText(msg.payload),
        ].join("\n");
        const body = input.body ? `${input.body}\n\n${quoted}` : quoted;
        const raw = buildRfc2822({ to: input.to!, ...(input.cc ? { cc: input.cc } : {}), subject: prefixed("Fwd:", headerVal(hdrs, "Subject")), body });
        const sent = await gmailJson<{ id: string; threadId?: string }>("/messages/send", { method: "POST", body: JSON.stringify({ raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) }) });
        return { output: { sent: { id: sent.id }, message_text: `Forwarded to ${input.to} (message text only — attachments are not re-attached).` }, display: `Forwarded to ${input.to}` };
      }

      case "list_labels": {
        const data = await gmailJson<{ labels?: Array<{ id: string; name: string; type?: string }> }>("/labels");
        const labels = (data.labels ?? []).map((l) => ({ id: l.id, name: l.name, ...(l.type ? { type: l.type } : {}) }));
        return { output: { labels, message_text: labels.map((l) => `${l.name} (${l.id})`).join("\n") || "No labels." }, display: `${labels.length} labels` };
      }

      case "add_labels":
      case "remove_labels": {
        const missing = need("message_id");
        if (missing) return missing;
        if (!input.labels?.length) return { output: { message_text: "labels is required." }, display: "Missing labels." };
        const data = await gmailJson<{ labels?: Array<{ id: string; name: string }> }>("/labels");
        const all = data.labels ?? [];
        const ids: string[] = [];
        const unknown: string[] = [];
        for (const wanted of input.labels) {
          const hit = all.find((l) => l.id === wanted || l.name.toLowerCase() === wanted.toLowerCase());
          if (hit) ids.push(hit.id);
          else unknown.push(wanted);
        }
        if (unknown.length) return { output: { message_text: `Unknown label(s): ${unknown.join(", ")}. Use list_labels to see what exists.` }, display: "Unknown label", failure: `unknown labels: ${unknown.join(", ")}` };
        const key = input.action === "add_labels" ? "addLabelIds" : "removeLabelIds";
        await gmailFetch(`/messages/${encodeURIComponent(input.message_id!)}/modify`, { method: "POST", body: JSON.stringify({ [key]: ids }) });
        return { output: { message_text: `${input.action === "add_labels" ? "Added" : "Removed"} ${input.labels.join(", ")}.` }, display: "Labels updated" };
      }

      case "archive": {
        const missing = need("message_id");
        if (missing) return missing;
        await gmailFetch(`/messages/${encodeURIComponent(input.message_id!)}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: ["INBOX"] }) });
        return { output: { message_text: "Archived (removed from the inbox; still in All Mail)." }, display: "Archived" };
      }

      case "trash": {
        const missing = need("message_id");
        if (missing) return missing;
        await gmailFetch(`/messages/${encodeURIComponent(input.message_id!)}/trash`, { method: "POST" });
        return { output: { message_text: "Moved to trash (recoverable for 30 days)." }, display: "Trashed" };
      }

      case "unsubscribe": {
        const missing = need("message_id");
        if (missing) return missing;
        const { from, plan } = await unsubscribeHeaders(input.message_id!);
        if (plan.method === "one-click") {
          // RFC 8058: a POST with exactly this body, no cookies, no redirects followed.
          const res = await fetch(plan.target, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "List-Unsubscribe=One-Click",
            redirect: "manual",
          });
          if (res.status >= 400) throw new Error(`one-click unsubscribe failed: HTTP ${res.status}`);
          return { output: { unsubscribed: { method: "one-click", target: plan.target }, message_text: `Unsubscribed from ${from} (one-click).` }, display: "Unsubscribed" };
        }
        if (plan.method === "mailto" && plan.mailto) {
          const raw = buildRfc2822({ to: plan.mailto.to, subject: plan.mailto.subject, body: plan.mailto.body });
          await gmailFetch("/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
          return { output: { unsubscribed: { method: "mailto", target: plan.mailto.to }, message_text: `Sent an unsubscribe request to ${plan.mailto.to} for ${from}.` }, display: "Unsubscribe sent" };
        }
        if (plan.method === "link") {
          return { output: { unsubscribed: { method: "link", target: plan.target }, message_text: `${from} only offers an unsubscribe web page: ${plan.target} — open it with the Browser to finish (it may ask for a confirmation click).` }, display: "Unsubscribe link" };
        }
        return { output: { message_text: `${from} has no List-Unsubscribe header. Look for an unsubscribe link in the body, or filter it with a label.` }, display: "No unsubscribe option", failure: "no List-Unsubscribe header" };
      }

      case "find_code":
        return findCode(input);

      default:
        return { output: { message_text: "Unknown action." }, display: "Unknown action." };
    }
  },
});
