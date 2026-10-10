// Tickets — find events through the Ticketmaster Discovery API.
//
// Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
//   GET https://app.ticketmaster.com/discovery/v2/events.json?apikey=…&keyword=&city=&stateCode=&countryCode=
//       &startDateTime=YYYY-MM-DDTHH:mm:ssZ&endDateTime=…&classificationName=&size=&sort=date,asc
//   GET https://app.ticketmaster.com/discovery/v2/events/{id}.json?apikey=…
// The consumer key rides in the query string (that is how Discovery
// authenticates), which is why it's read from the vault per call and never
// echoed back. Discovery is read-only: there is no purchase API for ordinary
// developers. Buying means opening the event's ticket URL in the Browser and
// getting the owner's OK on the total at checkout — the tool says so.

import { z } from "zod";
import { getCredential } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { apiJson, failResult, okResult } from "./_lifeHttp.js";

const API = "https://app.ticketmaster.com/discovery/v2";

const inputSchema = z
  .object({
    action: z.enum(["search", "event"]).describe("search: find events. event: details and the ticket URL for one event id."),
    keyword: z.string().optional().describe("search: artist, team, show or venue."),
    city: z.string().optional().describe("search: city name, e.g. Austin."),
    state_code: z.string().optional().describe("search: US/CA state code, e.g. TX."),
    country_code: z.string().length(2).optional().describe("search: ISO country, e.g. US."),
    start_date: z.string().optional().describe("search: earliest date, YYYY-MM-DD."),
    end_date: z.string().optional().describe("search: latest date, YYYY-MM-DD."),
    category: z.string().optional().describe("search: music, sports, arts & theatre, film, family…"),
    id: z.string().optional().describe("event: the event id from search."),
    limit: z.number().int().positive().max(50).default(10),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface TicketEvent {
  id: string;
  name: string;
  date?: string;
  time?: string;
  venue?: string;
  city?: string;
  url?: string;
  priceRange?: string;
  status?: string;
}

export interface TicketsOutput {
  events?: TicketEvent[];
  event?: TicketEvent & { info?: string; seatmap?: string };
  message: string;
}

const NOT_CONNECTED =
  "Ticketmaster isn't connected. Call Connect with service \"ticketmaster\" — the owner pastes a free Consumer Key in a secure form — then retry.";

const BUYING = "Discovery can't buy tickets: to buy, open the ticket URL with the Browser and show the owner the seats and total before checkout.";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Discovery wants second-precision UTC with no millis. */
export function ticketmasterSearchUrl(input: Input, apikey: string): string {
  const params = new URLSearchParams({ apikey, size: String(input.limit), sort: "date,asc" });
  if (input.keyword) params.set("keyword", input.keyword);
  if (input.city) params.set("city", input.city);
  if (input.state_code) params.set("stateCode", input.state_code.toUpperCase());
  if (input.country_code) params.set("countryCode", input.country_code.toUpperCase());
  if (input.category) params.set("classificationName", input.category);
  if (input.start_date && DATE.test(input.start_date)) params.set("startDateTime", `${input.start_date}T00:00:00Z`);
  if (input.end_date && DATE.test(input.end_date)) params.set("endDateTime", `${input.end_date}T23:59:59Z`);
  return `${API}/events.json?${params}`;
}

function toEvent(e: Record<string, any>): TicketEvent {
  const venue = e._embedded?.venues?.[0];
  const price = Array.isArray(e.priceRanges) ? e.priceRanges[0] : undefined;
  return {
    id: String(e.id),
    name: String(e.name),
    ...(e.dates?.start?.localDate ? { date: String(e.dates.start.localDate) } : {}),
    ...(e.dates?.start?.localTime ? { time: String(e.dates.start.localTime).slice(0, 5) } : {}),
    ...(venue?.name ? { venue: String(venue.name) } : {}),
    ...(venue?.city?.name ? { city: String(venue.city.name) } : {}),
    ...(e.url ? { url: String(e.url) } : {}),
    ...(price ? { priceRange: `${price.min ?? "?"}–${price.max ?? "?"} ${price.currency ?? ""}`.trim() } : {}),
    ...(e.dates?.status?.code ? { status: String(e.dates.status.code) } : {}),
  };
}

function line(e: TicketEvent): string {
  return `${e.name} — ${[e.date, e.time].filter(Boolean).join(" ")}${e.venue ? ` at ${e.venue}` : ""}${e.city ? `, ${e.city}` : ""}${e.priceRange ? ` (${e.priceRange})` : ""} [id ${e.id}]`;
}

export const TicketsTool = buildTool<typeof inputSchema, TicketsOutput>({
  name: "Tickets",
  description:
    "Find concerts, sports, theatre and other events via Ticketmaster: search by keyword, city and dates, then get one event's details and ticket URL. " +
    "It cannot buy — buying is the Browser on the ticket URL, with the owner approving the total. If Ticketmaster isn't connected, call Connect service \"ticketmaster\" first.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  watchdogTimeoutMs: 30_000,
  activityDescription: (input) => (input.action === "search" ? `Searching events${input.keyword ? ` for ${input.keyword}` : ""}${input.city ? ` in ${input.city}` : ""}` : "Getting event details"),
  async call(input: Input, ctx): Promise<ToolResult<TicketsOutput>> {
    const apikey = (await getCredential("TICKETMASTER_API_KEY"))?.trim();
    if (!apikey) return failResult<TicketsOutput>(NOT_CONNECTED);
    try {
      if (input.action === "event") {
        if (!input.id) return failResult<TicketsOutput>("event needs an id from search.");
        const e: Record<string, any> = await apiJson("Ticketmaster", `${API}/events/${encodeURIComponent(input.id)}.json?${new URLSearchParams({ apikey })}`, { signal: ctx.signal });
        const event = { ...toEvent(e), ...(typeof e.info === "string" ? { info: e.info.slice(0, 600) } : {}), ...(e.seatmap?.staticUrl ? { seatmap: String(e.seatmap.staticUrl) } : {}) };
        return okResult({ event, message: `${line(event)}${event.url ? `\nTickets: ${event.url}` : ""}\n${BUYING}` }, line(event));
      }
      const json = await apiJson("Ticketmaster", ticketmasterSearchUrl(input, apikey), { signal: ctx.signal });
      const events = (((json._embedded as Record<string, unknown> | undefined)?.events as Array<Record<string, any>> | undefined) ?? []).map(toEvent);
      const message = events.length ? `${events.length} event(s):\n${events.map(line).join("\n")}\n${BUYING}` : "No events matched — try a broader keyword, another city or wider dates.";
      return okResult({ events, message }, events.length ? `${events.length} events` : "No events");
    } catch (err) {
      return failResult<TicketsOutput>((err instanceof Error ? err.message : String(err)).replace(apikey, "***"));
    }
  },
});
