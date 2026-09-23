// Connect-hub verifiers for the "life" services (core/lifeServices.ts).
//
// Each proves the owner's key against the service with the cheapest
// authenticated GET it has, before anything is stored — a wrong key fails on
// the phone form, not three turns later in a tool call. Two go further than
// checking: they MAKE the credential that gets stored.
//   hue        the form has no fields. The verifier finds the bridge on the
//              LAN and pairs while the owner holds the link button; it hands
//              back the bridge address + issued username to store.
//   simplefin  the Setup Token is one-shot. The verifier claims it and hands
//              back only the Access URL; the spent token is never stored.
// A verifier that returns `store` replaces the typed values entirely.

import { claimSimplefinToken, pairHueBridge, simplefinAccounts } from "@ares/tools";

export type VerifyOutcome = string | void | { detail?: string; store?: Record<string, string> };
export type LifeVerify = (values: Record<string, string>, signal: AbortSignal) => Promise<VerifyOutcome>;

async function authedGet(label: string, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Record<string, any>> {
  const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal });
  if (res.status === 401 || res.status === 403) throw new Error(`${label} doesn't recognise that key`);
  if (!res.ok) throw new Error(`${label} answered HTTP ${res.status}`);
  return (await res.json().catch(() => ({}))) as Record<string, any>;
}

export const LIFE_VERIFIERS: Record<string, LifeVerify> = {
  async hue(_values, signal) {
    const paired = await pairHueBridge({ signal });
    return {
      detail: `Paired with Hue bridge ${paired.bridge.id} at ${paired.bridge.ip}.`,
      store: { HUE_BRIDGE_IP: paired.bridge.ip, HUE_USERNAME: paired.username, HUE_BRIDGE_ID: paired.bridge.id },
    };
  },
  // https://developer.tessie.com/reference/get-all-vehicles
  async tessie(values, signal) {
    const json = await authedGet("Tessie", "https://api.tessie.com/vehicles?only_active=true", { authorization: `Bearer ${values.TESSIE_API_TOKEN}` }, signal);
    const cars = (Array.isArray(json.results) ? json.results : []) as Array<Record<string, any>>;
    return cars.length ? `${cars.length} car(s): ${cars.map((c) => c.last_state?.display_name ?? c.vin).join(", ")}.` : "Connected, but Tessie shows no active cars yet.";
  },
  // https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
  async ticketmaster(values, signal) {
    await authedGet("Ticketmaster", `https://app.ticketmaster.com/discovery/v2/events.json?${new URLSearchParams({ apikey: values.TICKETMASTER_API_KEY!, size: "1" })}`, {}, signal);
    return "";
  },
  // AeroAPI has no free "whoami"; one static airport lookup is the cheapest billed query.
  async flightaware(values, signal) {
    await authedGet("FlightAware", "https://aeroapi.flightaware.com/aeroapi/airports/KSFO", { "x-apikey": values.FLIGHTAWARE_API_KEY! }, signal);
    return "AeroAPI key works (queries are billed to your FlightAware account).";
  },
  // https://duffel.com/docs/api/v2/airlines — a tiny list call proves the token.
  async duffel(values, signal) {
    const tok = values.DUFFEL_ACCESS_TOKEN!;
    await authedGet("Duffel", "https://api.duffel.com/air/airlines?limit=1", { authorization: `Bearer ${tok}`, "duffel-version": "v2" }, signal);
    return tok.startsWith("duffel_test_") ? "Test-mode token — bookings are simulated, nothing is charged." : "LIVE token — bookings charge your Duffel balance (Ares always asks first).";
  },
  // https://api.tailscale.com/api/v2 — GET /tailnet/-/devices
  async tailscale(values, signal) {
    const key = values.TAILSCALE_API_KEY!;
    if (!key.startsWith("tskey-api-")) throw new Error("an API access token starts with tskey-api- (an auth key, tskey-auth-, can't read the tailnet)");
    const json = await authedGet("Tailscale", "https://api.tailscale.com/api/v2/tailnet/-/devices", { authorization: `Bearer ${key}` }, signal);
    return `${Array.isArray(json.devices) ? json.devices.length : 0} device(s) on your tailnet.`;
  },
  // https://www.simplefin.org/protocol.html — claim, then prove the Access URL.
  async simplefin(values, signal) {
    const access = await claimSimplefinToken(values.SIMPLEFIN_SETUP_TOKEN!, signal);
    // The token is spent the moment the claim succeeds: from here on the
    // Access URL is stored whatever the check says, or it is lost for good.
    try {
      const { accounts } = await simplefinAccounts(access, { "balances-only": "1" }, signal);
      return { detail: `${accounts.length} account(s) linked, read-only.`, store: { SIMPLEFIN_ACCESS_URL: access } };
    } catch (err) {
      return { detail: `Connected, but the first balance check failed (${err instanceof Error ? err.message : String(err)}).`, store: { SIMPLEFIN_ACCESS_URL: access } };
    }
  },
};
