// Email — actually send mail (Resend API).
//
// Real-world reach: progress reports, waitlist confirmations, outreach. Reads
// RESEND_API_KEY and a default sender from ARES_EMAIL_FROM (overridable per
// call). Outward-facing, so it asks the owner before sending.

import { z } from "zod";
import { getCredential } from "@ares/core";
import { buildTool } from "./_shared.js";

const inputSchema = z
  .object({
    to: z.string().email().describe("Recipient email address."),
    subject: z.string().min(1).describe("Email subject."),
    body: z.string().min(1).describe("Email body. Markdown/plain text; sent as text."),
    from: z.string().optional().describe("Sender (must be a verified Resend domain). Defaults to ARES_EMAIL_FROM."),
    html: z.boolean().default(false).describe("Treat body as HTML instead of plain text."),
  })
  .strict();

export interface EmailOutput {
  id: string;
  to: string;
  subject: string;
}

export const EmailTool = buildTool({
  name: "Email",
  description:
    "Send an email via Resend. Requires RESEND_API_KEY in the environment and a verified sender (ARES_EMAIL_FROM, or pass `from`). Use for progress reports, waitlist confirmations, and outreach. Outward-facing; confirm with the owner.",
  safety: "external-state",
  concurrency: "parallel-safe",
  // Generous headroom: aborting a committed POST mid-send risks a duplicate
  // email, so don't let the tight external-state default clip a slow-but-fine
  // send. Still bounded so a truly hung call can't stall the turn forever.
  watchdogTimeoutMs: 45_000,
  inputZod: inputSchema,
  activityDescription: (i) => `Emailing ${i.to}`,

  async checkPermissions(i, ctx) {
    if (ctx.permissionMode === "plan") return { kind: "deny", reason: "Email is disabled in plan mode." };
    return {
      kind: "ask",
      prompt: `Send an email to ${i.to} — subject "${i.subject}"?`,
      suggestion: "allow_once",
    };
  },

  async call(i, ctx): Promise<{ output: EmailOutput; display: string }> {
    const key = await getCredential("RESEND_API_KEY");
    if (!key) {
      throw new Error("EMAIL_NO_KEY: no RESEND_API_KEY in the credential vault or environment. Ask the owner to add it.");
    }
    const from = i.from ?? (await getCredential("ARES_EMAIL_FROM"));
    if (!from) {
      throw new Error("EMAIL_NO_SENDER: set ARES_EMAIL_FROM (a verified Resend sender) or pass `from`.");
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: i.to,
        subject: i.subject,
        ...(i.html ? { html: i.body } : { text: i.body }),
      }),
      signal: ctx.signal,
    });
    const json = (await res.json()) as { id?: string; message?: string };
    if (!res.ok) {
      throw new Error(`Email send failed: ${json.message ?? `HTTP ${res.status}`}`);
    }
    return {
      output: { id: json.id ?? "", to: i.to, subject: i.subject },
      display: `Sent email to ${i.to}`,
    };
  },
});
