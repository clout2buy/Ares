import { z } from "zod";
import { getValidAccessToken, OAUTH_PROVIDERS } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

const inputSchema = z.object({
  action: z.enum(["list_messages", "read_message", "send", "search"]).describe(
    "list_messages: recent inbox messages. " +
    "read_message: read a specific message by id. " +
    "send: compose and send an email. " +
    "search: search messages with Gmail query syntax.",
  ),
  message_id: z.string().optional().describe("Message id — required for read_message."),
  to: z.string().optional().describe("Recipient email — required for send."),
  subject: z.string().optional().describe("Email subject — required for send."),
  body: z.string().optional().describe("Email body (plain text) — required for send."),
  query: z.string().optional().describe("Gmail search query (e.g. 'from:boss is:unread'). Used with search."),
  max_results: z.number().optional().describe("Max messages to return (default 10, max 25)."),
});

type Input = z.infer<typeof inputSchema>;

export interface GmailOutput {
  messages?: Array<{ id: string; from: string; subject: string; snippet: string; date: string }>;
  message?: { id: string; from: string; to: string; subject: string; body: string; date: string };
  sent?: { id: string };
  message_text: string;
}

async function gmailFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getValidAccessToken(OAUTH_PROVIDERS.google);
  const res = await fetch(`${GMAIL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res;
}

function decodeBase64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function headerVal(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function buildRfc2822(to: string, subject: string, body: string): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=UTF-8`,
    "",
    body,
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

export const GmailTool = buildTool<typeof inputSchema, GmailOutput>({
  name: "Gmail",
  description:
    "Read and send emails via Gmail. List recent messages, read a specific email, search, or send. " +
    "Requires Google to be connected via the Connect tool first.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  // SENDING mail is an irreversible OUTWARD effect — it must cross the gate, never
  // auto-allow. Reads (list/search/read) stay free. Without this, 'send' rode the
  // workspace-write auto-allow and bypassed the conscience gate entirely.
  async checkPermissions(input) {
    if (input.action === "send")
      return { kind: "ask", prompt: `Send an email to ${input.to ?? "a recipient"} via Gmail`, suggestion: "allow_once" };
    return { kind: "allow" };
  },
  activityDescription: (input) => {
    switch (input.action) {
      case "list_messages": return "Checking inbox";
      case "read_message": return "Reading email";
      case "send": return `Sending email to ${input.to ?? ""}`;
      case "search": return `Searching: ${input.query ?? ""}`;
      default: return "Gmail";
    }
  },
  async call(input: Input): Promise<ToolResult<GmailOutput>> {
    switch (input.action) {
      case "list_messages":
      case "search": {
        const max = Math.min(input.max_results ?? 10, 25);
        const params = new URLSearchParams({ maxResults: String(max) });
        if (input.query) params.set("q", input.query);
        const listRes = await gmailFetch(`/messages?${params}`);
        const listData = await listRes.json() as { messages?: Array<{ id: string }> };
        if (!listData.messages?.length) return { output: { messages: [], message_text: "No messages found." }, display: "No messages." };

        const messages = await Promise.all(
          listData.messages.slice(0, max).map(async (m) => {
            const res = await gmailFetch(`/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
            const msg = await res.json() as { id: string; snippet: string; payload?: { headers?: Array<{ name: string; value: string }> } };
            const hdrs = msg.payload?.headers ?? [];
            return {
              id: msg.id,
              from: headerVal(hdrs, "From"),
              subject: headerVal(hdrs, "Subject"),
              snippet: msg.snippet,
              date: headerVal(hdrs, "Date"),
            };
          }),
        );
        const lines = messages.map((m) => `${m.date} | ${m.from}\n  ${m.subject}\n  ${m.snippet}`);
        return { output: { messages, message_text: lines.join("\n\n") }, display: `${messages.length} messages` };
      }

      case "read_message": {
        if (!input.message_id) return { output: { message_text: "message_id is required." }, display: "Missing message_id." };
        const res = await gmailFetch(`/messages/${input.message_id}?format=full`);
        const msg = await res.json() as { id: string; payload?: { headers?: Array<{ name: string; value: string }>; body?: { data?: string }; parts?: Array<{ mimeType?: string; body?: { data?: string } }> } };
        const hdrs = msg.payload?.headers ?? [];
        let body = "";
        if (msg.payload?.body?.data) {
          body = decodeBase64Url(msg.payload.body.data);
        } else if (msg.payload?.parts) {
          const textPart = msg.payload.parts.find((p) => p.mimeType === "text/plain");
          if (textPart?.body?.data) body = decodeBase64Url(textPart.body.data);
        }
        const message = {
          id: msg.id,
          from: headerVal(hdrs, "From"),
          to: headerVal(hdrs, "To"),
          subject: headerVal(hdrs, "Subject"),
          body: body.slice(0, 10000),
          date: headerVal(hdrs, "Date"),
        };
        return { output: { message, message_text: `From: ${message.from}\nTo: ${message.to}\nDate: ${message.date}\nSubject: ${message.subject}\n\n${message.body}` }, display: message.subject };
      }

      case "send": {
        if (!input.to || !input.subject || !input.body) {
          return { output: { message_text: "to, subject, and body are required." }, display: "Missing fields." };
        }
        const raw = buildRfc2822(input.to, input.subject, input.body);
        const res = await gmailFetch("/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
        const sent = await res.json() as { id: string };
        return { output: { sent: { id: sent.id }, message_text: `Email sent to ${input.to}.` }, display: `Sent to ${input.to}` };
      }

      default:
        return { output: { message_text: "Unknown action." }, display: "Unknown action." };
    }
  },
});
