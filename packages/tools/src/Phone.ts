// Phone — Ares's own phone numbers, through the owner's Twilio account.
//
// "Get yourself a phone number" is a real purchase: Twilio bills the number
// monthly to the owner's Twilio balance. So buy_number and release_number
// always cross the permission gate with the live monthly price in the prompt
// (policyGate classifies them as payment_or_purchase), and send_sms crosses it
// as outbound communication. Search, list, balance and reading messages are
// free. Credentials come from the vault (Connect service "twilio" fills them
// through a secure form — never the chat).

import { z } from "zod";
import { getCredential } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";

const API = "https://api.twilio.com/2010-04-01";
const PRICING = "https://pricing.twilio.com/v1/PhoneNumbers/Countries";

const inputSchema = z
  .object({
    action: z
      .enum(["search_numbers", "buy_number", "list_numbers", "release_number", "send_sms", "messages", "balance"])
      .describe(
        "search_numbers: find numbers available to buy. buy_number: purchase one (asks the owner, shows the monthly price). " +
          "list_numbers: numbers you own. release_number: give one back (asks the owner). send_sms: text from one of your numbers (asks the owner). " +
          "messages: recent SMS sent/received. balance: Twilio account balance.",
      ),
    country: z.string().length(2).default("US").describe("ISO country code for search/buy pricing, e.g. US, GB, CA."),
    type: z.enum(["Local", "TollFree", "Mobile"]).default("Local").describe("Number type to search."),
    area_code: z.string().optional().describe("search_numbers: area code, e.g. 415."),
    contains: z.string().optional().describe("search_numbers: digits/letters the number should contain, e.g. 'ARES'."),
    phone_number: z.string().optional().describe("E.164 number, e.g. +14155550123. buy_number/release_number: the number. send_sms: the FROM number (defaults to your first number)."),
    to: z.string().optional().describe("send_sms: recipient in E.164; messages: filter by recipient."),
    body: z.string().max(1600).optional().describe("send_sms: the text."),
    friendly_name: z.string().optional().describe("buy_number: a label for the number, e.g. 'Ares'."),
    limit: z.number().int().positive().max(50).default(10),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface PhoneOutput {
  numbers?: Array<{ phoneNumber: string; friendlyName?: string; locality?: string; region?: string; sid?: string; sms?: boolean; voice?: boolean }>;
  purchased?: { sid: string; phoneNumber: string };
  sent?: { sid: string; status: string };
  messages?: Array<{ from: string; to: string; body: string; direction: string; status: string; date: string }>;
  balance?: { amount: string; currency: string };
  monthlyPrice?: string;
  message: string;
}

interface Creds {
  sid: string;
  token: string;
}

async function creds(): Promise<Creds | null> {
  const sid = (await getCredential("TWILIO_ACCOUNT_SID"))?.trim();
  const token = (await getCredential("TWILIO_AUTH_TOKEN"))?.trim();
  return sid && token ? { sid, token } : null;
}

async function twilio(c: Creds, method: "GET" | "POST" | "DELETE", url: string, signal: AbortSignal, form?: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString("base64")}`,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    signal,
  });
  if (res.status === 204) return {};
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = typeof json.message === "string" ? json.message : `HTTP ${res.status}`;
    throw new Error(`Twilio: ${detail}${typeof json.code === "number" ? ` (code ${json.code})` : ""}`);
  }
  return json;
}

/** Monthly price of a number type in a country, e.g. "$1.15/month". Best effort. */
export async function twilioMonthlyPrice(c: Creds, country: string, type: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const json = await twilio(c, "GET", `${PRICING}/${country.toUpperCase()}`, signal ?? new AbortController().signal);
    const prices = json.phone_number_prices as Array<{ number_type?: string; current_price?: string; base_price?: string }> | undefined;
    const want = type === "TollFree" ? "toll free" : type.toLowerCase();
    const row = prices?.find((p) => (p.number_type ?? "").toLowerCase() === want);
    const unit = typeof json.price_unit === "string" ? json.price_unit.toUpperCase() : "USD";
    const amount = row?.current_price ?? row?.base_price;
    return amount ? `${unit === "USD" ? "$" : `${unit} `}${amount}/month` : undefined;
  } catch {
    return undefined;
  }
}

const E164 = /^\+[1-9]\d{6,14}$/;

const NOT_CONNECTED =
  "Twilio isn't connected, so Ares has no phone account to use. Call Connect with service \"twilio\" — the owner enters the Account SID and Auth Token in a secure form on their phone — then retry.";

export const PhoneTool = buildTool<typeof inputSchema, PhoneOutput>({
  name: "Phone",
  description:
    "Ares's own phone numbers and SMS through the owner's Twilio account: search numbers, buy one (the owner approves the monthly price), " +
    "list numbers, release one, send an SMS from one, read recent messages, check the balance. If Twilio isn't connected, call Connect service \"twilio\" first. " +
    "Note: US carriers block SMS from unregistered 10DLC numbers — after buying a US local number, tell the owner texting to US phones needs A2P 10DLC registration in the Twilio console (toll-free numbers need toll-free verification).",
  safety: "external-state",
  concurrency: "exclusive",
  inputZod: inputSchema,
  watchdogTimeoutMs: 45_000,
  async checkPermissions(input) {
    if (input.action === "buy_number") {
      const c = await creds();
      const price = c ? await twilioMonthlyPrice(c, input.country, input.type) : undefined;
      return {
        kind: "ask",
        prompt: `Buy phone number ${input.phone_number ?? "(unspecified)"} on your Twilio account${price ? ` — ${price}, billed monthly until released` : " — billed monthly until released"}`,
        suggestion: "allow_once",
      };
    }
    if (input.action === "release_number") {
      return { kind: "ask", prompt: `Release ${input.phone_number ?? "a number"} — it goes back to Twilio and may not be recoverable`, suggestion: "allow_once" };
    }
    if (input.action === "send_sms") {
      return { kind: "ask", prompt: `Text ${input.to ?? "?"}: "${(input.body ?? "").slice(0, 160)}"`, suggestion: "allow_once" };
    }
    return { kind: "allow" };
  },
  activityDescription: (input) => {
    switch (input.action) {
      case "search_numbers": return `Searching ${input.country} phone numbers`;
      case "buy_number": return `Buying ${input.phone_number ?? "a phone number"}`;
      case "list_numbers": return "Listing phone numbers";
      case "release_number": return `Releasing ${input.phone_number ?? "a number"}`;
      case "send_sms": return `Texting ${input.to ?? ""}`.trim();
      case "messages": return "Reading text messages";
      case "balance": return "Checking Twilio balance";
      default: return "Phone";
    }
  },
  async call(input: Input, ctx): Promise<ToolResult<PhoneOutput>> {
    const c = await creds();
    if (!c) return { output: { message: NOT_CONNECTED }, display: "Twilio not connected", failure: NOT_CONNECTED };
    const account = `${API}/Accounts/${encodeURIComponent(c.sid)}`;
    const fail = (message: string): ToolResult<PhoneOutput> => ({ output: { message }, display: message, failure: message });

    switch (input.action) {
      case "search_numbers": {
        const params = new URLSearchParams({ PageSize: String(input.limit) });
        if (input.area_code) params.set("AreaCode", input.area_code);
        if (input.contains) params.set("Contains", input.contains);
        const json = await twilio(c, "GET", `${account}/AvailablePhoneNumbers/${input.country.toUpperCase()}/${input.type}.json?${params}`, ctx.signal);
        const rows = (json.available_phone_numbers as Array<Record<string, unknown>> | undefined) ?? [];
        const numbers = rows.map((r) => {
          const caps = (r.capabilities ?? {}) as Record<string, unknown>;
          return {
            phoneNumber: String(r.phone_number),
            friendlyName: typeof r.friendly_name === "string" ? r.friendly_name : undefined,
            locality: typeof r.locality === "string" ? r.locality : undefined,
            region: typeof r.region === "string" ? r.region : undefined,
            sms: caps.SMS === true || caps.sms === true,
            voice: caps.voice === true,
          };
        });
        const monthlyPrice = await twilioMonthlyPrice(c, input.country, input.type, ctx.signal);
        const message = numbers.length
          ? `${numbers.length} available${monthlyPrice ? ` at ${monthlyPrice}` : ""}: ${numbers.map((n) => `${n.phoneNumber}${n.locality ? ` (${n.locality}, ${n.region})` : ""}`).join("; ")}`
          : "No numbers matched — try another area code or drop the filter.";
        return { output: { numbers, ...(monthlyPrice ? { monthlyPrice } : {}), message }, display: message.slice(0, 200) };
      }
      case "buy_number": {
        if (!input.phone_number || !E164.test(input.phone_number)) return fail("buy_number needs phone_number in E.164 form (+14155550123) — pick one from search_numbers.");
        const json = await twilio(c, "POST", `${account}/IncomingPhoneNumbers.json`, ctx.signal, {
          PhoneNumber: input.phone_number,
          FriendlyName: input.friendly_name ?? "Ares",
        });
        const purchased = { sid: String(json.sid), phoneNumber: String(json.phone_number) };
        const message = `Bought ${purchased.phoneNumber} (${purchased.sid}).`;
        return { output: { purchased, message }, display: message };
      }
      case "list_numbers": {
        const json = await twilio(c, "GET", `${account}/IncomingPhoneNumbers.json?PageSize=${input.limit}`, ctx.signal);
        const rows = (json.incoming_phone_numbers as Array<Record<string, unknown>> | undefined) ?? [];
        const numbers = rows.map((r) => ({
          phoneNumber: String(r.phone_number),
          friendlyName: typeof r.friendly_name === "string" ? r.friendly_name : undefined,
          sid: String(r.sid),
        }));
        const message = numbers.length ? numbers.map((n) => `${n.phoneNumber}${n.friendlyName ? ` (${n.friendlyName})` : ""}`).join(", ") : "No numbers on this Twilio account yet.";
        return { output: { numbers, message }, display: message };
      }
      case "release_number": {
        if (!input.phone_number) return fail("release_number needs phone_number.");
        const json = await twilio(c, "GET", `${account}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(input.phone_number)}`, ctx.signal);
        const row = ((json.incoming_phone_numbers as Array<Record<string, unknown>> | undefined) ?? [])[0];
        if (!row) return fail(`${input.phone_number} isn't on this Twilio account.`);
        await twilio(c, "DELETE", `${account}/IncomingPhoneNumbers/${String(row.sid)}.json`, ctx.signal);
        const message = `Released ${input.phone_number}.`;
        return { output: { message }, display: message };
      }
      case "send_sms": {
        if (!input.to || !E164.test(input.to)) return fail("send_sms needs `to` in E.164 form (+14155550123).");
        if (!input.body?.trim()) return fail("send_sms needs a body.");
        let from = input.phone_number;
        if (!from) {
          const owned = await twilio(c, "GET", `${account}/IncomingPhoneNumbers.json?PageSize=1`, ctx.signal);
          from = String(((owned.incoming_phone_numbers as Array<Record<string, unknown>> | undefined) ?? [])[0]?.phone_number ?? "");
          if (!from) return fail("You don't own a Twilio number yet — search_numbers, then buy_number (with the owner's OK).");
        }
        const json = await twilio(c, "POST", `${account}/Messages.json`, ctx.signal, { To: input.to, From: from, Body: input.body });
        const sent = { sid: String(json.sid), status: String(json.status) };
        const message = `Text to ${input.to} from ${from}: ${sent.status}.`;
        return { output: { sent, message }, display: message };
      }
      case "messages": {
        const params = new URLSearchParams({ PageSize: String(input.limit) });
        if (input.to) params.set("To", input.to);
        if (input.phone_number) params.set("From", input.phone_number);
        const json = await twilio(c, "GET", `${account}/Messages.json?${params}`, ctx.signal);
        const rows = (json.messages as Array<Record<string, unknown>> | undefined) ?? [];
        const messages = rows.map((r) => ({
          from: String(r.from),
          to: String(r.to),
          body: String(r.body ?? ""),
          direction: String(r.direction),
          status: String(r.status),
          date: String(r.date_sent ?? r.date_created ?? ""),
        }));
        const message = messages.length ? `${messages.length} message(s).` : "No messages.";
        return { output: { messages, message }, display: message };
      }
      case "balance": {
        const json = await twilio(c, "GET", `${account}/Balance.json`, ctx.signal);
        const balance = { amount: String(json.balance), currency: String(json.currency) };
        const message = `Twilio balance: ${balance.amount} ${balance.currency}.`;
        return { output: { balance, message }, display: message };
      }
    }
  },
});
