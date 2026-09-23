// FlightBooking — search and book real airline offers through Duffel.
//
// Docs: https://duffel.com/docs/api/v2/offer-requests/create-offer-request ,
//       https://duffel.com/docs/api/v2/offers/get-offer-by-id ,
//       https://duffel.com/docs/api/v2/orders/create-order
//   headers  Authorization: Bearer <token>, Duffel-Version: v2
//   POST /air/offer_requests?return_offers=true  {data:{slices, passengers, cabin_class, max_connections}}
//   GET  /air/offers/{id}                        re-prices one offer (offers expire)
//   POST /air/orders  {data:{type:"instant", selected_offers:[id],
//                     payments:[{type:"balance", amount, currency}], passengers:[…]}}
//
// Booking is a purchase: `book` crosses the permission gate with the offer's
// CURRENT price, airline and route in the prompt, and policyGate classifies it
// as payment_or_purchase so it is never autonomous. The price the owner
// approved is remembered per offer; if Duffel re-prices before the order
// goes in (or the prompt could not show a price at all), the booking stops
// rather than paying a number nobody saw.
// A duffel_test_ token books simulated flights on Duffel Airways; a live token
// pays from the Duffel balance — every message says which mode is in use.

import { z } from "zod";
import { getCredential } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { apiJson, failResult, okResult } from "./_lifeHttp.js";

const API = "https://api.duffel.com";

const passengerSchema = z
  .object({
    given_name: z.string(),
    family_name: z.string(),
    born_on: z.string().describe("YYYY-MM-DD"),
    gender: z.enum(["m", "f"]),
    title: z.enum(["mr", "ms", "mrs", "miss", "dr"]),
    email: z.string(),
    phone_number: z.string().describe("E.164, e.g. +14155550123"),
  })
  .strict();

const inputSchema = z
  .object({
    action: z.enum(["search", "offer", "book"]).describe("search: find offers. offer: re-price one offer by id. book: buy an offer (asks the owner with the exact price)."),
    slices: z
      .array(z.object({ origin: z.string().describe("IATA airport or city, e.g. JFK"), destination: z.string(), departure_date: z.string().describe("YYYY-MM-DD") }).strict())
      .optional()
      .describe("search: one slice one-way, two for a return trip."),
    adults: z.number().int().min(1).max(9).default(1),
    children_ages: z.array(z.number().int().min(0).max(17)).optional().describe("search: ages of any children/infants."),
    cabin_class: z.enum(["economy", "premium_economy", "business", "first"]).optional(),
    max_connections: z.number().int().min(0).max(2).optional().describe("search: 0 for nonstop only."),
    offer_id: z.string().optional().describe("offer/book: the offer id (off_…)."),
    passengers: z.array(passengerSchema).optional().describe("book: one entry per traveller, in the same order as the search's passengers."),
    limit: z.number().int().positive().max(20).default(5),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface OfferSummary {
  id: string;
  price: string;
  airline: string;
  route: string;
  expiresAt?: string;
}

export interface FlightBookingOutput {
  mode?: "test" | "live";
  offers?: OfferSummary[];
  offer?: OfferSummary;
  order?: { id: string; bookingReference?: string; total: string };
  message: string;
}

const NOT_CONNECTED =
  "Duffel isn't connected. Call Connect with service \"duffel\" — the owner pastes a Duffel access token (a duffel_test_ token books simulated flights) — then retry.";

async function token(): Promise<string | undefined> {
  return (await getCredential("DUFFEL_ACCESS_TOKEN"))?.trim() || undefined;
}

export function duffelMode(tok: string): "test" | "live" {
  return tok.startsWith("duffel_test_") ? "test" : "live";
}

function duffel(tok: string, method: string, path: string, signal: AbortSignal | undefined, body?: unknown): Promise<Record<string, unknown>> {
  return apiJson("Duffel", `${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, "duffel-version": "v2" },
    ...(body !== undefined ? { body } : {}),
    ...(signal ? { signal } : {}),
  });
}

/** The offer-request body Duffel expects. Exported for tests. */
export function offerRequestBody(input: Input): Record<string, unknown> {
  const passengers = [
    ...Array.from({ length: input.adults }, () => ({ type: "adult" })),
    ...(input.children_ages ?? []).map((age) => ({ age })),
  ];
  return {
    data: {
      slices: (input.slices ?? []).map((s) => ({ origin: s.origin.toUpperCase(), destination: s.destination.toUpperCase(), departure_date: s.departure_date })),
      passengers,
      ...(input.cabin_class ? { cabin_class: input.cabin_class } : {}),
      ...(input.max_connections !== undefined ? { max_connections: input.max_connections } : {}),
    },
  };
}

export function summarizeOffer(o: Record<string, any>): OfferSummary {
  const route = (Array.isArray(o.slices) ? o.slices : [])
    .map((slice: Record<string, any>) => {
      const segs = Array.isArray(slice.segments) ? slice.segments : [];
      const first = segs[0];
      const last = segs[segs.length - 1];
      const from = first?.origin?.iata_code ?? slice.origin?.iata_code ?? "?";
      const to = last?.destination?.iata_code ?? slice.destination?.iata_code ?? "?";
      const flights = segs.map((s: Record<string, any>) => `${s.marketing_carrier?.iata_code ?? ""}${s.marketing_carrier_flight_number ?? ""}`).join("+");
      return `${from}→${to} ${first?.departing_at ?? ""}${segs.length > 1 ? ` (${segs.length - 1} stop)` : " nonstop"}${flights ? ` ${flights}` : ""}`;
    })
    .join(" | ");
  return {
    id: String(o.id),
    price: `${o.total_amount} ${o.total_currency}`,
    airline: String(o.owner?.name ?? "?"),
    route,
    ...(o.expires_at ? { expiresAt: String(o.expires_at) } : {}),
  };
}

/** The price the owner was shown in the permission prompt, per offer id. */
const approvedPrices = new Map<string, string>();

async function currentOffer(tok: string, offerId: string, signal?: AbortSignal): Promise<Record<string, any>> {
  const json = await duffel(tok, "GET", `/air/offers/${encodeURIComponent(offerId)}`, signal);
  return (json.data ?? {}) as Record<string, any>;
}

export const FlightBookingTool = buildTool<typeof inputSchema, FlightBookingOutput>({
  name: "FlightBooking",
  description:
    "Search and book flights through Duffel: search (origin, destination, dates, passengers, cabin) returns priced offers from real airlines; offer re-prices one; " +
    "book buys it — the owner approves the exact price first, and a live token charges the Duffel balance (a duffel_test_ token books simulated flights). " +
    "If Duffel isn't connected, call Connect service \"duffel\" first. (Live status of a flight is FlightStatus.)",
  safety: "external-state",
  dynamicSafety: (input) => (input.action === "book" ? "external-state" : "read-only"),
  concurrency: "exclusive",
  inputZod: inputSchema,
  watchdogTimeoutMs: 90_000,
  async checkPermissions(input) {
    if (input.action !== "book") return { kind: "allow" };
    const tok = await token();
    let summary: OfferSummary | undefined;
    if (tok && input.offer_id) {
      try {
        summary = summarizeOffer(await currentOffer(tok, input.offer_id));
        approvedPrices.set(summary.id, summary.price);
      } catch {
        summary = undefined;
      }
    }
    const mode = tok ? duffelMode(tok) : "live";
    const who = (input.passengers ?? []).map((p) => `${p.given_name} ${p.family_name}`).join(", ");
    return {
      kind: "ask",
      prompt: summary
        ? `Book ${summary.airline} ${summary.route} for ${who || "?"} — ${summary.price}${mode === "test" ? " (Duffel TEST mode, no real charge)" : ", charged to your Duffel balance"}`
        : `Book flight offer ${input.offer_id ?? "?"} for ${who || "?"} — price could not be confirmed`,
      suggestion: "allow_once",
    };
  },
  activityDescription: (input) =>
    input.action === "search" ? `Searching flights ${(input.slices ?? []).map((s) => `${s.origin}→${s.destination}`).join(", ")}`.trim() : input.action === "book" ? "Booking a flight" : "Checking a flight offer",
  async call(input: Input, ctx): Promise<ToolResult<FlightBookingOutput>> {
    const tok = await token();
    if (!tok) return failResult<FlightBookingOutput>(NOT_CONNECTED);
    const mode = duffelMode(tok);
    const tag = mode === "test" ? " [Duffel TEST mode — simulated]" : "";
    try {
      switch (input.action) {
        case "search": {
          if (!input.slices?.length) return failResult<FlightBookingOutput>("search needs slices: [{origin, destination, departure_date}].");
          const json = await duffel(tok, "POST", "/air/offer_requests?return_offers=true&supplier_timeout=20000", ctx.signal, offerRequestBody(input));
          const raw = (((json.data as Record<string, unknown> | undefined)?.offers as Array<Record<string, any>> | undefined) ?? [])
            .slice()
            .sort((a, b) => Number(a.total_amount) - Number(b.total_amount));
          const offers = raw.slice(0, input.limit).map(summarizeOffer);
          const message = offers.length
            ? `${offers.length} cheapest of ${raw.length} offers${tag}:\n${offers.map((o) => `${o.price} ${o.airline} ${o.route} [${o.id}]`).join("\n")}`
            : `No offers for that search${tag}.`;
          return okResult({ mode, offers, message }, `${offers.length} offers${tag}`);
        }
        case "offer": {
          if (!input.offer_id) return failResult<FlightBookingOutput>("offer needs offer_id.");
          const offer = summarizeOffer(await currentOffer(tok, input.offer_id, ctx.signal));
          return okResult({ mode, offer, message: `${offer.price} ${offer.airline} ${offer.route}${offer.expiresAt ? `, valid until ${offer.expiresAt}` : ""}${tag}` });
        }
        case "book": {
          if (!input.offer_id) return failResult<FlightBookingOutput>("book needs offer_id.");
          const passengers = input.passengers ?? [];
          const offer = await currentOffer(tok, input.offer_id, ctx.signal);
          const summary = summarizeOffer(offer);
          const approved = approvedPrices.get(summary.id);
          if (!approved) {
            return failResult<FlightBookingOutput>(`The owner hasn't approved a price for this offer (currently ${summary.price}) — not booked. Call book again so the approval shows the price.`, { mode });
          }
          if (approved !== summary.price) {
            approvedPrices.delete(summary.id);
            return failResult<FlightBookingOutput>(`The price changed from ${approved} to ${summary.price} since the owner approved it — not booked. Ask again with the new price.`, { mode });
          }
          const slots = (Array.isArray(offer.passengers) ? offer.passengers : []) as Array<{ id: string }>;
          if (!passengers.length || passengers.length !== slots.length) {
            return failResult<FlightBookingOutput>(`book needs ${slots.length || "one"} passenger(s) with name, born_on, gender, title, email and phone — got ${passengers.length}.`, { mode });
          }
          const json = await duffel(tok, "POST", "/air/orders", ctx.signal, {
            data: {
              type: "instant",
              selected_offers: [summary.id],
              payments: [{ type: "balance", amount: String(offer.total_amount), currency: String(offer.total_currency) }],
              passengers: passengers.map((p, i) => ({ ...p, id: slots[i]!.id })),
            },
          });
          approvedPrices.delete(summary.id);
          const data = (json.data ?? {}) as Record<string, any>;
          const order = { id: String(data.id), ...(data.booking_reference ? { bookingReference: String(data.booking_reference) } : {}), total: `${data.total_amount ?? offer.total_amount} ${data.total_currency ?? offer.total_currency}` };
          return okResult({ mode, order, message: `Booked ${summary.airline} ${summary.route} — ${order.total}${order.bookingReference ? `, booking reference ${order.bookingReference}` : ""} (order ${order.id})${tag}.` });
        }
      }
    } catch (err) {
      return failResult<FlightBookingOutput>(`${err instanceof Error ? err.message : String(err)}${tag}`, { mode });
    }
  },
});
