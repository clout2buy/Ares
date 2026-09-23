// Outlook — the owner's Microsoft mail, calendar and contacts through
// Microsoft Graph (Outlook.com, Hotmail, Live and Microsoft 365 accounts
// alike; connect service "outlook", OAuth provider "microsoft").
//
// Same contract as Gmail: reads run freely; anything that puts words in
// front of someone else (send / reply / forward) asks with the exact
// recipient, subject and body; drafts don't ask (they sit in Drafts);
// creating an event asks like GoogleCalendar does, since attendees get
// invitations. Graph's own reply/forward endpoints are used so threading,
// quoting and attachments-on-forward behave exactly as in Outlook itself.

import { z } from "zod";
import { getValidAccessToken, OAUTH_PROVIDERS } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { capText, previewForApproval } from "./googleApi.js";

export const GRAPH = "https://graph.microsoft.com/v1.0";

const inputSchema = z.object({
  action: z.enum([
    "list_messages", "search", "read_message", "send", "draft", "reply", "forward",
    "list_events", "create_event", "search_contacts",
  ]).describe(
    "list_messages: recent inbox mail. search: full-text mail search (query). read_message: one message by id. " +
    "send: a new email (to, subject, body). draft: save a draft (with message_id: a reply draft). reply: reply to message_id (reply_all for everyone). " +
    "forward: forward message_id to `to` with an optional note. list_events: upcoming calendar events. " +
    "create_event: add an event (title, start, end, attendees). search_contacts: find a contact by name/email.",
  ),
  message_id: z.string().optional().describe("Message id — read_message, reply, forward, reply drafts."),
  to: z.string().optional().describe("Recipient address(es), comma-separated — send, draft, forward."),
  cc: z.string().optional().describe("Cc address(es), comma-separated."),
  subject: z.string().optional().describe("Subject — send, draft."),
  body: z.string().optional().describe("Plain-text body. For reply/forward: the text above the quoted original."),
  reply_all: z.boolean().optional().describe("reply/draft: reply to everyone."),
  query: z.string().optional().describe("search / search_contacts: what to look for."),
  max_results: z.number().optional().describe("Max results (default 10, max 50)."),
  title: z.string().optional().describe("create_event: the event title."),
  start: z.string().optional().describe("create_event: ISO-8601 start (with offset or Z), or YYYY-MM-DD for all-day."),
  end: z.string().optional().describe("create_event: ISO-8601 end; default start + 1h (all-day: the next day)."),
  time_zone: z.string().optional().describe("create_event: IANA/Windows zone for a start/end given WITHOUT an offset (default UTC)."),
  location: z.string().optional().describe("create_event: location."),
  attendees: z.array(z.string()).optional().describe("create_event: attendee emails — they receive invitations."),
  days: z.number().optional().describe("list_events: days ahead (default 7)."),
});

type Input = z.infer<typeof inputSchema>;

interface GraphAddress { emailAddress?: { name?: string; address?: string } }
interface GraphMessage {
  id: string;
  subject?: string;
  from?: GraphAddress;
  replyTo?: GraphAddress[];
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  conversationId?: string;
}
interface GraphEvent { id: string; subject?: string; start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string }; location?: { displayName?: string }; webLink?: string; isAllDay?: boolean }
interface GraphContact { id: string; displayName?: string; emailAddresses?: Array<{ address?: string }>; mobilePhone?: string; businessPhones?: string[]; homePhones?: string[]; companyName?: string }

export interface OutlookOutput {
  messages?: Array<{ id: string; from: string; subject: string; preview: string; received: string }>;
  message?: { id: string; from: string; to: string; subject: string; body: string; received: string };
  draft?: { id: string };
  events?: Array<{ id: string; title: string; start: string; end: string; location?: string }>;
  event?: { id: string; link?: string };
  contacts?: Array<{ name: string; emails: string[]; phones: string[]; company?: string }>;
  message_text: string;
}

/** OData query string. Graph wants literal `$top`, not `%24top`. */
export function odata(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

async function graph(path: string, init: RequestInit & { prefer?: string } = {}): Promise<Response> {
  const token = await getValidAccessToken(OAUTH_PROVIDERS.microsoft!);
  const { prefer, ...rest } = init;
  const res = await fetch(`${GRAPH}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(rest.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let detail = text;
    try { detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text; } catch { /* raw */ }
    throw new Error(`Microsoft Graph ${res.status}: ${detail.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  return res;
}

async function graphJson<T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
  const res = await graph(path, init);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export function recipients(list: string | undefined): Array<{ emailAddress: { address: string } }> {
  return (list ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } }));
}

function addr(a: GraphAddress | undefined): string {
  const e = a?.emailAddress;
  if (!e) return "";
  return e.name && e.address && e.name !== e.address ? `${e.name} <${e.address}>` : e.address ?? e.name ?? "";
}

const textBody = (content: string) => ({ contentType: "Text", content });
const TEXT_BODY = 'outlook.body-content-type="text"';
const MESSAGE_SELECT = "id,subject,from,replyTo,toRecipients,ccRecipients,receivedDateTime,bodyPreview";

/** An ISO time → Graph's dateTimeTimeZone. With an offset/Z it is converted
 *  to UTC; a bare local time keeps the caller's zone. */
export function graphTime(value: string, zone = "UTC"): { dateTime: string; timeZone: string } {
  if (/(Z|[+-]\d\d:?\d\d)$/i.test(value.trim())) return { dateTime: new Date(value).toISOString().replace(/\.\d{3}Z$/, ""), timeZone: "UTC" };
  return { dateTime: value.trim(), timeZone: zone };
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function eventBody(input: Input): Record<string, unknown> {
  const allDay = !input.start!.includes("T");
  const start = allDay ? { dateTime: `${input.start}T00:00:00`, timeZone: input.time_zone ?? "UTC" } : graphTime(input.start!, input.time_zone);
  const end = allDay
    ? { dateTime: `${input.end ?? nextDay(input.start!)}T00:00:00`, timeZone: input.time_zone ?? "UTC" }
    : input.end
      ? graphTime(input.end, input.time_zone)
      : /(Z|[+-]\d\d:?\d\d)$/i.test(input.start!)
        ? graphTime(new Date(new Date(input.start!).getTime() + 3_600_000).toISOString())
        : { dateTime: new Date(new Date(`${input.start}Z`).getTime() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, ""), timeZone: input.time_zone ?? "UTC" };
  return {
    subject: input.title,
    ...(input.body ? { body: textBody(input.body) } : {}),
    start,
    end,
    ...(allDay ? { isAllDay: true } : {}),
    ...(input.location ? { location: { displayName: input.location } } : {}),
    ...(input.attendees?.length ? { attendees: input.attendees.map((address) => ({ emailAddress: { address }, type: "required" })) } : {}),
  };
}

async function replyTarget(messageId: string, replyAll: boolean): Promise<{ to: string; cc?: string; subject: string }> {
  const m = await graphJson<GraphMessage>(`/me/messages/${encodeURIComponent(messageId)}${odata({ $select: MESSAGE_SELECT })}`);
  const to = (m.replyTo?.length ? m.replyTo : [m.from]).map(addr).filter(Boolean).join(", ");
  const cc = replyAll ? [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map(addr).filter(Boolean).join(", ") : "";
  const subject = /^\s*re\s*:/i.test(m.subject ?? "") ? m.subject ?? "" : `RE: ${m.subject ?? ""}`;
  return { to, ...(cc ? { cc } : {}), subject };
}

function sendPrompt(verb: string, to: string, subject: string, body: string | undefined, cc?: string): string {
  return `${verb} via Outlook\nTo: ${to}${cc ? `\nCc: ${cc}` : ""}\nSubject: ${subject}\n\n${previewForApproval(body)}`;
}

export const OutlookTool = buildTool<typeof inputSchema, OutlookOutput>({
  name: "Outlook",
  description:
    "Microsoft Outlook / Hotmail / Microsoft 365 via Microsoft Graph: list, search and read mail; send, draft, reply and forward; " +
    "list and create calendar events; search contacts. Requires Outlook connected via Connect (service \"outlook\").",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  async checkPermissions(input) {
    switch (input.action) {
      case "send":
        return { kind: "ask", prompt: sendPrompt("Send an email", input.to ?? "(no recipient)", input.subject ?? "(no subject)", input.body, input.cc), suggestion: "allow_once" };
      case "reply": {
        const t = input.message_id ? await replyTarget(input.message_id, Boolean(input.reply_all)).catch(() => null) : null;
        return { kind: "ask", prompt: sendPrompt(input.reply_all ? "Reply all" : "Reply", t?.to ?? `the sender of message ${input.message_id ?? "?"}`, t?.subject ?? "RE: (original)", input.body, t?.cc), suggestion: "allow_once" };
      }
      case "forward":
        return { kind: "ask", prompt: sendPrompt(`Forward message ${input.message_id ?? "?"}`, input.to ?? "(no recipient)", "FW: (original subject)", input.body || "(no note — the original message only)", input.cc), suggestion: "allow_once" };
      case "create_event":
        return { kind: "ask", prompt: `Create an Outlook calendar event "${input.title ?? ""}" at ${input.start ?? "?"}${input.attendees?.length ? ` and invite ${input.attendees.join(", ")}` : ""}`, suggestion: "allow_once" };
      default:
        return { kind: "allow" };
    }
  },
  activityDescription: (input) => {
    switch (input.action) {
      case "list_messages": return "Checking Outlook inbox";
      case "search": return `Searching Outlook: ${input.query ?? ""}`;
      case "read_message": return "Reading email";
      case "send": return `Sending email to ${input.to ?? ""}`;
      case "draft": return "Saving a draft";
      case "reply": return "Replying";
      case "forward": return `Forwarding to ${input.to ?? ""}`;
      case "list_events": return "Checking Outlook calendar";
      case "create_event": return `Creating event: ${input.title ?? ""}`;
      case "search_contacts": return `Looking up ${input.query ?? "a contact"}`;
      default: return "Outlook";
    }
  },
  async call(input: Input): Promise<ToolResult<OutlookOutput>> {
    const fail = (message_text: string): ToolResult<OutlookOutput> => ({ output: { message_text }, display: message_text });
    const top = Math.min(input.max_results ?? 10, 50);
    switch (input.action) {
      case "list_messages":
      case "search": {
        if (input.action === "search" && !input.query) return fail("query is required for search.");
        // $search can't be combined with $orderby (Graph sorts search hits by relevance).
        const path = input.action === "search"
          ? `/me/messages${odata({ $search: `"${input.query!.replace(/"/g, "")}"`, $top: top, $select: MESSAGE_SELECT })}`
          : `/me/mailFolders/inbox/messages${odata({ $top: top, $select: MESSAGE_SELECT, $orderby: "receivedDateTime desc" })}`;
        const data = await graphJson<{ value?: GraphMessage[] }>(path);
        const messages = (data.value ?? []).map((m) => ({ id: m.id, from: addr(m.from), subject: m.subject ?? "", preview: m.bodyPreview ?? "", received: m.receivedDateTime ?? "" }));
        return { output: { messages, message_text: messages.map((m) => `${m.received} | ${m.from} [${m.id}]\n  ${m.subject}\n  ${m.preview}`).join("\n\n") || "No messages found." }, display: `${messages.length} messages` };
      }
      case "read_message": {
        if (!input.message_id) return fail("message_id is required for read_message.");
        const m = await graphJson<GraphMessage>(`/me/messages/${encodeURIComponent(input.message_id)}${odata({ $select: `${MESSAGE_SELECT},body` })}`, { prefer: TEXT_BODY });
        const message = { id: m.id, from: addr(m.from), to: (m.toRecipients ?? []).map(addr).join(", "), subject: m.subject ?? "", body: capText(m.body?.content ?? "", 10_000), received: m.receivedDateTime ?? "" };
        return { output: { message, message_text: `From: ${message.from}\nTo: ${message.to}\nDate: ${message.received}\nSubject: ${message.subject}\n\n${message.body}` }, display: message.subject };
      }
      case "send": {
        if (!input.to || !input.subject || !input.body) return fail("to, subject, and body are required.");
        await graph("/me/sendMail", {
          method: "POST",
          body: JSON.stringify({ message: { subject: input.subject, body: textBody(input.body), toRecipients: recipients(input.to), ...(input.cc ? { ccRecipients: recipients(input.cc) } : {}) }, saveToSentItems: true }),
        });
        return { output: { message_text: `Email sent to ${input.to}.` }, display: `Sent to ${input.to}` };
      }
      case "draft": {
        if (!input.body) return fail("body is required for draft.");
        let draft: GraphMessage;
        if (input.message_id) {
          const verb = input.reply_all ? "createReplyAll" : "createReply";
          draft = await graphJson<GraphMessage>(`/me/messages/${encodeURIComponent(input.message_id)}/${verb}`, { method: "POST", body: JSON.stringify({ comment: input.body }) });
        } else {
          draft = await graphJson<GraphMessage>("/me/messages", {
            method: "POST",
            body: JSON.stringify({ subject: input.subject ?? "", body: textBody(input.body), toRecipients: recipients(input.to), ...(input.cc ? { ccRecipients: recipients(input.cc) } : {}) }),
          });
        }
        return { output: { draft: { id: draft.id }, message_text: `Draft saved (${draft.id}) in Outlook's Drafts — nothing was sent.` }, display: "Draft saved" };
      }
      case "reply": {
        if (!input.message_id || !input.body) return fail("message_id and body are required for reply.");
        const verb = input.reply_all ? "replyAll" : "reply";
        await graph(`/me/messages/${encodeURIComponent(input.message_id)}/${verb}`, { method: "POST", body: JSON.stringify({ comment: input.body }) });
        return { output: { message_text: `Replied${input.reply_all ? " to all" : ""} in the same conversation.` }, display: "Replied" };
      }
      case "forward": {
        if (!input.message_id || !input.to) return fail("message_id and to are required for forward.");
        await graph(`/me/messages/${encodeURIComponent(input.message_id)}/forward`, {
          method: "POST",
          body: JSON.stringify({ comment: input.body ?? "", toRecipients: recipients(input.to) }),
        });
        return { output: { message_text: `Forwarded to ${input.to} (with the original's attachments).` }, display: `Forwarded to ${input.to}` };
      }
      case "list_events": {
        const now = new Date();
        const until = new Date(now.getTime() + (input.days ?? 7) * 86_400_000);
        const data = await graphJson<{ value?: GraphEvent[] }>(
          `/me/calendarView${odata({ startDateTime: now.toISOString(), endDateTime: until.toISOString(), $orderby: "start/dateTime", $top: 50, $select: "id,subject,start,end,location,isAllDay" })}`,
          { prefer: 'outlook.timezone="UTC"' },
        );
        const events = (data.value ?? []).map((e) => ({ id: e.id, title: e.subject ?? "(no title)", start: e.start?.dateTime ?? "", end: e.end?.dateTime ?? "", ...(e.location?.displayName ? { location: e.location.displayName } : {}) }));
        return { output: { events, message_text: events.map((e) => `${e.start} UTC — ${e.title}${e.location ? ` @ ${e.location}` : ""}`).join("\n") || "No upcoming events." }, display: `${events.length} events` };
      }
      case "create_event": {
        if (!input.title || !input.start) return fail("title and start are required for create_event.");
        const ev = await graphJson<GraphEvent>("/me/events", { method: "POST", body: JSON.stringify(eventBody(input)) });
        return { output: { event: { id: ev.id, ...(ev.webLink ? { link: ev.webLink } : {}) }, message_text: `Event created: ${input.title}${input.attendees?.length ? ` (invited ${input.attendees.join(", ")})` : ""}` }, display: `Created: ${input.title}` };
      }
      case "search_contacts": {
        if (!input.query) return fail("query is required for search_contacts.");
        const q = input.query.trim().toLowerCase();
        const select = "displayName,emailAddresses,mobilePhone,businessPhones,homePhones,companyName";
        // Graph's contacts endpoint has no $search: an exact address uses the
        // one $filter it supports; anything else is matched here.
        const path = /^[^\s@]+@[^\s@]+$/.test(q)
          ? `/me/contacts${odata({ $filter: `emailAddresses/any(a:a/address eq '${q.replace(/'/g, "''")}')`, $select: select })}`
          : `/me/contacts${odata({ $top: 500, $select: select })}`;
        const data = await graphJson<{ value?: GraphContact[] }>(path);
        const contacts = (data.value ?? [])
          .map((c) => ({
            name: c.displayName ?? "",
            emails: (c.emailAddresses ?? []).map((e) => e.address ?? "").filter(Boolean),
            phones: [c.mobilePhone, ...(c.businessPhones ?? []), ...(c.homePhones ?? [])].filter((p): p is string => Boolean(p)),
            ...(c.companyName ? { company: c.companyName } : {}),
          }))
          .filter((c) => [c.name, ...c.emails, ...c.phones, c.company ?? ""].some((v) => v.toLowerCase().includes(q)))
          .slice(0, top);
        return { output: { contacts, message_text: contacts.map((c) => [c.name, ...c.emails, ...c.phones, c.company].filter(Boolean).join(" · ")).join("\n") || `No contact matches "${input.query}".` }, display: `${contacts.length} contacts` };
      }
      default:
        return fail("Unknown action.");
    }
  },
});
