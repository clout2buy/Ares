// FlightStatus — live flight status through FlightAware AeroAPI v4.
//
// Spec: https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml
//   base https://aeroapi.flightaware.com/aeroapi, key in the `x-apikey` header
//   GET /flights/{ident}                      → {flights:[…]} ~14 days around now
//   GET /airports/{id}/flights/arrivals       → {arrivals:[…]}   (last 24 h)
//   GET /airports/{id}/flights/departures     → {departures:[…]} (last 24 h)
// AeroAPI is METERED: every call is billed to the owner's FlightAware account,
// so the tool fetches one page (max_pages=1) and the description tells the
// model not to poll.

import { z } from "zod";
import { getCredential } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { apiJson, failResult, okResult, str } from "./_lifeHttp.js";

const API = "https://aeroapi.flightaware.com/aeroapi";

const inputSchema = z
  .object({
    action: z.enum(["flight", "arrivals", "departures"]).describe("flight: status of a flight by ident. arrivals / departures: recent flights at an airport."),
    ident: z.string().optional().describe("flight: airline code + number (UA123, BAW283) or a tail number."),
    airport: z.string().optional().describe("arrivals/departures: ICAO or IATA code (KSFO or SFO)."),
    limit: z.number().int().positive().max(15).default(8),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface FlightSummary {
  ident: string;
  status: string;
  origin?: string;
  destination?: string;
  departure?: string;
  arrival?: string;
  gateOrigin?: string;
  gateDestination?: string;
  progress?: number;
  cancelled?: boolean;
  faFlightId?: string;
}

export interface FlightStatusOutput {
  flights?: FlightSummary[];
  message: string;
}

const NOT_CONNECTED =
  "FlightAware AeroAPI isn't connected. Call Connect with service \"flightaware\" — the owner pastes an AeroAPI key in a secure form (queries are billed to their FlightAware account) — then retry.";

function airportCode(a: Record<string, unknown> | undefined): string | undefined {
  return a ? str(a.code_iata) ?? str(a.code) : undefined;
}

export function summarizeFlight(f: Record<string, any>): FlightSummary {
  return {
    ident: String(f.ident_iata ?? f.ident ?? "?"),
    status: String(f.status ?? "unknown"),
    ...(airportCode(f.origin) ? { origin: airportCode(f.origin) } : {}),
    ...(airportCode(f.destination) ? { destination: airportCode(f.destination) } : {}),
    ...((f.actual_out ?? f.estimated_out ?? f.scheduled_out) ? { departure: String(f.actual_out ?? f.estimated_out ?? f.scheduled_out) } : {}),
    ...((f.actual_in ?? f.estimated_in ?? f.scheduled_in) ? { arrival: String(f.actual_in ?? f.estimated_in ?? f.scheduled_in) } : {}),
    ...(f.gate_origin ? { gateOrigin: String(f.gate_origin) } : {}),
    ...(f.gate_destination ? { gateDestination: String(f.gate_destination) } : {}),
    ...(typeof f.progress_percent === "number" ? { progress: f.progress_percent } : {}),
    ...(f.cancelled ? { cancelled: true } : {}),
    ...(f.fa_flight_id ? { faFlightId: String(f.fa_flight_id) } : {}),
  };
}

function line(f: FlightSummary): string {
  return `${f.ident} ${f.origin ?? "?"}→${f.destination ?? "?"}: ${f.cancelled ? "CANCELLED" : f.status}${f.departure ? `, dep ${f.departure}` : ""}${f.arrival ? `, arr ${f.arrival}` : ""}${f.gateOrigin ? `, gate ${f.gateOrigin}` : ""}`;
}

/** Of ~14 days of one ident, the flight the owner means: the one in the air,
 *  else the next to depart, else the latest to have landed. */
export function relevantFlight(flights: Array<Record<string, any>>, now = Date.now()): Record<string, any> | undefined {
  const airborne = flights.find((f) => typeof f.progress_percent === "number" && f.progress_percent > 0 && f.progress_percent < 100);
  if (airborne) return airborne;
  const departs = (f: Record<string, any>) => Date.parse(f.estimated_out ?? f.scheduled_out ?? f.scheduled_off ?? "") || 0;
  const upcoming = flights.filter((f) => departs(f) >= now - 3_600_000).sort((a, b) => departs(a) - departs(b));
  return upcoming[0] ?? [...flights].sort((a, b) => departs(b) - departs(a))[0];
}

export const FlightStatusTool = buildTool<typeof inputSchema, FlightStatusOutput>({
  name: "FlightStatus",
  description:
    "Live flight status via FlightAware AeroAPI: one flight by ident (UA123), or recent arrivals/departures at an airport. Each call is a billed query on the owner's AeroAPI account — don't poll. " +
    "If AeroAPI isn't connected, call Connect service \"flightaware\" first. (Booking flights is FlightBooking.)",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  watchdogTimeoutMs: 30_000,
  activityDescription: (input) => (input.action === "flight" ? `Checking flight ${input.ident ?? ""}`.trim() : `Checking ${input.airport ?? "airport"} ${input.action}`),
  async call(input: Input, ctx): Promise<ToolResult<FlightStatusOutput>> {
    const key = (await getCredential("FLIGHTAWARE_API_KEY"))?.trim();
    if (!key) return failResult<FlightStatusOutput>(NOT_CONNECTED);
    const headers = { "x-apikey": key };
    try {
      if (input.action === "flight") {
        const ident = input.ident?.replace(/\s+/g, "").toUpperCase();
        if (!ident) return failResult<FlightStatusOutput>("flight needs ident, e.g. UA123.");
        const json = await apiJson("AeroAPI", `${API}/flights/${encodeURIComponent(ident)}?max_pages=1`, { headers, signal: ctx.signal });
        const raw = (json.flights as Array<Record<string, any>> | undefined) ?? [];
        const pick = relevantFlight(raw);
        if (!pick) return okResult({ flights: [], message: `No flights found for ${ident} in the last/next two weeks.` });
        const flights = [summarizeFlight(pick)];
        return okResult({ flights, message: line(flights[0]!) });
      }
      const airport = input.airport?.trim().toUpperCase();
      if (!airport) return failResult<FlightStatusOutput>(`${input.action} needs airport, e.g. SFO or KSFO.`);
      const json = await apiJson("AeroAPI", `${API}/airports/${encodeURIComponent(airport)}/flights/${input.action}?max_pages=1`, { headers, signal: ctx.signal });
      const flights = ((json[input.action] as Array<Record<string, any>> | undefined) ?? []).slice(0, input.limit).map(summarizeFlight);
      return okResult({ flights, message: flights.length ? flights.map(line).join("\n") : `No recent ${input.action} at ${airport}.` }, `${flights.length} ${input.action}`);
    } catch (err) {
      return failResult<FlightStatusOutput>(err instanceof Error ? err.message : String(err));
    }
  },
});
