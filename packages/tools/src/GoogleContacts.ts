// Google Contacts (People API) — "what's Sam's number", "save this address".
//
// searchContacts is served from a lazily built cache: Google documents that
// the FIRST search after a while returns empty until a warm-up request (an
// empty query) primes it. So an empty result triggers one warm-up and one
// retry — otherwise "no contact named Sam" would be a lie on a cold cache.

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import { GOOGLE_API, googleJson } from "./googleApi.js";

const FIELDS = "names,emailAddresses,phoneNumbers,organizations";

const inputSchema = z.object({
  action: z.enum(["search", "list", "create"]).describe(
    "search: find contacts by name, email or phone (query). list: the owner's contacts. create: save a new contact.",
  ),
  query: z.string().optional().describe("search: name, email or phone fragment."),
  given_name: z.string().optional().describe("create: first name."),
  family_name: z.string().optional().describe("create: last name."),
  email: z.string().optional().describe("create: email address."),
  phone: z.string().optional().describe("create: phone number."),
  company: z.string().optional().describe("create: organization."),
  max_results: z.number().optional().describe("search/list: max contacts (default 20, max 100)."),
});

type Input = z.infer<typeof inputSchema>;

interface Person {
  resourceName: string;
  names?: Array<{ displayName?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  phoneNumbers?: Array<{ value?: string }>;
  organizations?: Array<{ name?: string }>;
}

export interface Contact { id: string; name: string; emails: string[]; phones: string[]; company?: string }

export interface GoogleContactsOutput {
  contacts?: Contact[];
  contact?: Contact;
  message: string;
}

function toContact(p: Person): Contact {
  const company = p.organizations?.[0]?.name;
  return {
    id: p.resourceName,
    name: p.names?.[0]?.displayName ?? "",
    emails: (p.emailAddresses ?? []).map((e) => e.value ?? "").filter(Boolean),
    phones: (p.phoneNumbers ?? []).map((e) => e.value ?? "").filter(Boolean),
    ...(company ? { company } : {}),
  };
}

function line(c: Contact): string {
  return [c.name || "(no name)", ...c.emails, ...c.phones, c.company].filter(Boolean).join(" · ");
}

export const GoogleContactsTool = buildTool<typeof inputSchema, GoogleContactsOutput>({
  name: "GoogleContacts",
  description: "Google Contacts: search the owner's contacts by name/email/phone, list them, or save a new contact. Requires Google connected via Connect.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (input) => {
    switch (input.action) {
      case "search": return `Looking up ${input.query ?? "a contact"}`;
      case "list": return "Listing contacts";
      case "create": return `Saving contact ${[input.given_name, input.family_name].filter(Boolean).join(" ")}`;
      default: return "Google Contacts";
    }
  },
  async call(input: Input): Promise<ToolResult<GoogleContactsOutput>> {
    const fail = (message: string): ToolResult<GoogleContactsOutput> => ({ output: { message }, display: message });
    const max = String(Math.min(input.max_results ?? 20, 100));
    switch (input.action) {
      case "search": {
        if (!input.query) return fail("query is required for search.");
        const url = (q: string) => `${GOOGLE_API.people}/people:searchContacts?${new URLSearchParams({ query: q, readMask: FIELDS, pageSize: String(Math.min(Number(max), 30)) })}`;
        let data = await googleJson<{ results?: Array<{ person: Person }> }>("Contacts", url(input.query));
        if (!data.results?.length) {
          await googleJson("Contacts", url("")).catch(() => undefined);
          data = await googleJson<{ results?: Array<{ person: Person }> }>("Contacts", url(input.query));
        }
        const contacts = (data.results ?? []).map((r) => toContact(r.person));
        return { output: { contacts, message: contacts.map(line).join("\n") || `No contact matches "${input.query}".` }, display: `${contacts.length} contacts` };
      }
      case "list": {
        const params = new URLSearchParams({ personFields: FIELDS, pageSize: max, sortOrder: "LAST_MODIFIED_DESCENDING" });
        const data = await googleJson<{ connections?: Person[] }>("Contacts", `${GOOGLE_API.people}/people/me/connections?${params}`);
        const contacts = (data.connections ?? []).map(toContact);
        return { output: { contacts, message: contacts.map(line).join("\n") || "No contacts." }, display: `${contacts.length} contacts` };
      }
      case "create": {
        if (!input.given_name && !input.family_name && !input.email) return fail("create needs at least a name or an email.");
        const body = {
          ...(input.given_name || input.family_name ? { names: [{ ...(input.given_name ? { givenName: input.given_name } : {}), ...(input.family_name ? { familyName: input.family_name } : {}) }] } : {}),
          ...(input.email ? { emailAddresses: [{ value: input.email }] } : {}),
          ...(input.phone ? { phoneNumbers: [{ value: input.phone }] } : {}),
          ...(input.company ? { organizations: [{ name: input.company }] } : {}),
        };
        const person = await googleJson<Person>("Contacts", `${GOOGLE_API.people}/people:createContact?personFields=${FIELDS}`, { method: "POST", body: JSON.stringify(body) });
        const contact = toContact(person);
        return { output: { contact, message: `Saved ${line(contact)}.` }, display: "Contact saved" };
      }
      default:
        return fail("Unknown action.");
    }
  },
});
