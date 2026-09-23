// Tesla — the owner's car through Tessie (https://developer.tessie.com).
//
// Tessie holds the Tesla Fleet API relationship and the vehicle command keys;
// Ares only needs the owner's Tessie API token (Bearer). Endpoints used, all
// on https://api.tessie.com:
//   GET  /vehicles?only_active=true        → {results:[{vin, last_state}]}
//   GET  /{vin}/state                      → the full current state
//   GET  /{vin}/location                   → {latitude, longitude, address, saved_location}
//   POST /{vin}/command/<name>?wait_for_completion=true
//        lock, unlock, start_climate, stop_climate, start_charging,
//        stop_charging, set_charge_limit?percent=, honk, flash, remote_start,
//        activate_rear_trunk, activate_front_trunk
//
// Anything that opens the car to the world or makes it act in public —
// unlock, remote start, trunk/frunk, honk, flash — asks the owner first, and
// policyGate classifies it so an unattended loop can never do it. Locking,
// climate and charging are the everyday "get the car ready" asks and run.

import { z } from "zod";
import { getCredential } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { apiJson, failResult, okResult } from "./_lifeHttp.js";

const API = "https://api.tessie.com";

const COMMANDS = {
  lock: "lock",
  unlock: "unlock",
  climate_on: "start_climate",
  climate_off: "stop_climate",
  charge_start: "start_charging",
  charge_stop: "stop_charging",
  charge_limit: "set_charge_limit",
  honk: "honk",
  flash: "flash",
  remote_start: "remote_start",
  trunk: "activate_rear_trunk",
  frunk: "activate_front_trunk",
} as const;

/** The actions that need the owner's explicit yes. */
export const TESLA_ASK_ACTIONS: ReadonlySet<string> = new Set(["unlock", "remote_start", "trunk", "frunk", "honk", "flash"]);

const inputSchema = z
  .object({
    action: z
      .enum(["vehicles", "state", "location", ...(Object.keys(COMMANDS) as [keyof typeof COMMANDS, ...Array<keyof typeof COMMANDS>])])
      .describe(
        "vehicles: list cars. state: battery, range, charging, climate, locks. location: where it is. " +
          "lock, climate_on/off, charge_start/stop, charge_limit: run directly. unlock, remote_start (keyless driving), trunk, frunk, honk, flash: ask the owner first.",
      ),
    vin: z.string().optional().describe("Which car (VIN). Defaults to the only / first active car."),
    percent: z.number().int().min(50).max(100).optional().describe("charge_limit: target battery percent (50-100)."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface TeslaOutput {
  vehicles?: Array<{ vin: string; name?: string; battery?: number }>;
  state?: Record<string, unknown>;
  location?: { latitude: number; longitude: number; address?: string; savedLocation?: string };
  result?: boolean;
  message: string;
}

const NOT_CONNECTED =
  "Tessie isn't connected, so Ares can't reach the car. Call Connect with service \"tessie\" — the owner pastes their Tessie API token in a secure form — then retry.";

const PROMPTS: Record<string, string> = {
  unlock: "Unlock your car",
  remote_start: "Remote start your car (keyless driving for 2 minutes — anyone at the car can drive it away)",
  trunk: "Open your car's rear trunk",
  frunk: "Open your car's front trunk",
  honk: "Honk your car's horn",
  flash: "Flash your car's lights",
};

async function token(): Promise<string | undefined> {
  return (await getCredential("TESSIE_API_TOKEN"))?.trim() || undefined;
}

async function tessie(tok: string, method: string, path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  return apiJson("Tessie", `${API}${path}`, { method, headers: { authorization: `Bearer ${tok}` }, signal });
}

async function resolveVin(tok: string, vin: string | undefined, signal: AbortSignal): Promise<string> {
  if (vin) return vin.trim().toUpperCase();
  const json = await tessie(tok, "GET", "/vehicles?only_active=true", signal);
  const first = ((json.results as Array<{ vin?: string }> | undefined) ?? [])[0]?.vin;
  if (!first) throw new Error("Tessie has no active vehicles on this account");
  return first;
}

function summarizeState(s: Record<string, any>): { state: Record<string, unknown>; line: string } {
  const charge = s.charge_state ?? {};
  const climate = s.climate_state ?? {};
  const vehicle = s.vehicle_state ?? {};
  const state = {
    name: s.display_name ?? vehicle.vehicle_name,
    battery: charge.battery_level,
    rangeMiles: charge.battery_range,
    charging: charge.charging_state,
    chargeLimit: charge.charge_limit_soc,
    insideTempC: climate.inside_temp,
    outsideTempC: climate.outside_temp,
    climateOn: climate.is_climate_on,
    locked: vehicle.locked,
    odometerMiles: vehicle.odometer,
    shift: s.drive_state?.shift_state ?? null,
    asleep: s.state === "asleep",
  };
  const bits = [
    state.battery !== undefined ? `${state.battery}% (${Math.round(Number(state.rangeMiles) || 0)} mi)` : "",
    state.charging ? `charging: ${state.charging}${state.chargeLimit ? `, limit ${state.chargeLimit}%` : ""}` : "",
    state.insideTempC !== undefined && state.insideTempC !== null ? `inside ${state.insideTempC}°C` : "",
    state.climateOn ? "climate on" : "",
    state.locked === true ? "locked" : state.locked === false ? "UNLOCKED" : "",
  ].filter(Boolean);
  return { state, line: `${state.name ?? "Car"}: ${bits.join(", ") || "no data"}.` };
}

export const TeslaTool = buildTool<typeof inputSchema, TeslaOutput>({
  name: "Tesla",
  description:
    "The owner's Tesla through Tessie: state (battery, range, charging, climate, locks), location, lock, climate on/off, charging start/stop, charge limit; " +
    "unlock, remote start, trunk, frunk, honk and flash ask the owner first. If Tessie isn't connected, call Connect service \"tessie\" first.",
  safety: "external-state",
  dynamicSafety: (input) => (input.action === "vehicles" || input.action === "state" || input.action === "location" ? "read-only" : "external-state"),
  concurrency: "exclusive",
  inputZod: inputSchema,
  // wait_for_completion wakes a sleeping car first — that alone can take ~30 s.
  watchdogTimeoutMs: 120_000,
  async checkPermissions(input) {
    if (TESLA_ASK_ACTIONS.has(input.action)) return { kind: "ask", prompt: `${PROMPTS[input.action]}${input.vin ? ` (${input.vin})` : ""}`, suggestion: "allow_once" };
    return { kind: "allow" };
  },
  activityDescription: (input) => (input.action === "vehicles" || input.action === "state" || input.action === "location" ? `Checking the car (${input.action})` : `Car: ${input.action.replace(/_/g, " ")}`),
  async call(input: Input, ctx): Promise<ToolResult<TeslaOutput>> {
    const tok = await token();
    if (!tok) return failResult<TeslaOutput>(NOT_CONNECTED);
    const signal = ctx.signal;
    try {
      if (input.action === "vehicles") {
        const json = await tessie(tok, "GET", "/vehicles?only_active=true", signal);
        const vehicles = ((json.results as Array<Record<string, any>> | undefined) ?? []).map((v) => ({
          vin: String(v.vin),
          ...(v.last_state?.display_name ? { name: String(v.last_state.display_name) } : {}),
          ...(v.last_state?.charge_state?.battery_level !== undefined ? { battery: Number(v.last_state.charge_state.battery_level) } : {}),
        }));
        return okResult({ vehicles, message: vehicles.length ? vehicles.map((v) => `${v.name ?? v.vin}${v.battery !== undefined ? ` ${v.battery}%` : ""}`).join("; ") : "No active vehicles on this Tessie account." });
      }
      const vin = await resolveVin(tok, input.vin, signal);
      if (input.action === "state") {
        const { state, line } = summarizeState(await tessie(tok, "GET", `/${encodeURIComponent(vin)}/state`, signal));
        return okResult({ state, message: line });
      }
      if (input.action === "location") {
        const json = await tessie(tok, "GET", `/${encodeURIComponent(vin)}/location`, signal);
        const location = {
          latitude: Number(json.latitude),
          longitude: Number(json.longitude),
          ...(typeof json.address === "string" ? { address: json.address } : {}),
          ...(typeof json.saved_location === "string" && json.saved_location ? { savedLocation: json.saved_location } : {}),
        };
        return okResult({ location, message: `The car is at ${location.savedLocation ? `${location.savedLocation} — ` : ""}${location.address ?? `${location.latitude}, ${location.longitude}`}.` });
      }
      const command = COMMANDS[input.action];
      const params = new URLSearchParams({ wait_for_completion: "true" });
      if (input.action === "charge_limit") {
        if (input.percent === undefined) return failResult<TeslaOutput>("charge_limit needs percent (50-100).");
        params.set("percent", String(input.percent));
      }
      const json = await tessie(tok, "POST", `/${encodeURIComponent(vin)}/command/${command}?${params}`, signal);
      const ok = json.result === true;
      const what = input.action === "charge_limit" ? `charge limit ${input.percent}%` : input.action.replace(/_/g, " ");
      if (!ok) return failResult<TeslaOutput>(`The car didn't confirm "${what}"${typeof json.reason === "string" ? `: ${json.reason}` : ""}.`, { result: false });
      return okResult({ result: true, message: `Done: ${what}.` });
    } catch (err) {
      return failResult<TeslaOutput>(err instanceof Error ? err.message : String(err));
    }
  },
});
