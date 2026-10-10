// Places — find real places: geocode an address, name a coordinate, search
// "coffee near the office".
//
// Free by default: OpenStreetMap's Nominatim (geocode / reverse / free-text)
// and Overpass (what is AROUND a point). Both are community services with a
// usage policy — an identifying User-Agent and at most one Nominatim request
// per second — and breaking it gets the box's IP banned for every tool, so the
// throttle is module-wide, not per call. Results are cached in memory for an
// hour: the same lookup inside a conversation (and the model does repeat
// itself) never goes back to the network.
//
// When the owner has connected a Google Places key (Connect service
// "google-places"), search prefers Google Places API (New) text search —
// better coverage, ratings and hours. Geocode/reverse stay on Nominatim: that
// key is for the Places API, and a different Google API may not be enabled.

import { z } from "zod";
import { getCredential } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";

export const PLACES_USER_AGENT = "Ares/1.0 (doingbox)";
const NOMINATIM = "https://nominatim.openstreetmap.org";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const GOOGLE_TEXT_SEARCH = "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_FIELDS = [
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.primaryType",
  "places.regularOpeningHours",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.rating",
].join(",");
const CACHE_TTL_MS = 60 * 60_000;
const CACHE_MAX = 300;
const MAX_RESULTS = 10;

export interface Place {
  name: string;
  address?: string;
  lat: number;
  lon: number;
  category?: string;
  openingHours?: string;
  phone?: string;
  website?: string;
  rating?: number;
  distanceM?: number;
  mapsUrl: string;
  source: "osm" | "google";
}

// ─── Throttle + cache ────────────────────────────────────────────────────────

export interface ThrottleClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: ThrottleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Serialize calls so each STARTS at least `gapMs` after the previous one
 * started. A chain rather than a timestamp check: two lookups fired in the
 * same tick must still go out a second apart.
 */
export function makeThrottle(gapMs: number, clock: ThrottleClock = realClock): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<void> = Promise.resolve();
  let lastStart = -Infinity;
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const wait = lastStart + gapMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
      lastStart = clock.now();
    });
    chain = run.catch(() => undefined);
    return run.then(fn);
  };
}

/** 1.1s rather than 1.0: the policy is "an absolute maximum of 1 request per
 *  second", and timer jitter must not tip us over it. */
const nominatimThrottle = makeThrottle(1_100);
const cache = new Map<string, { at: number; value: unknown }>();

/** Test seam: forget cached lookups. */
export function clearPlacesCache(): void {
  cache.clear();
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
  return res.json();
}

// ─── Request construction (exported for tests) ───────────────────────────────

export function nominatimSearchUrl(query: string, opts: { limit?: number; viewbox?: [number, number, number, number] } = {}): string {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    extratags: "1",
    limit: String(opts.limit ?? 5),
  });
  if (opts.viewbox) {
    params.set("viewbox", opts.viewbox.join(","));
    params.set("bounded", "1");
  }
  return `${NOMINATIM}/search?${params}`;
}

export function nominatimReverseUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon), format: "jsonv2", addressdetails: "1", extratags: "1" });
  return `${NOMINATIM}/reverse?${params}`;
}

/** Everyday words → the OSM tag values that mean them. */
const TAG_WORDS: Record<string, string[]> = {
  coffee: ["cafe"],
  cafe: ["cafe"],
  restaurant: ["restaurant"],
  food: ["restaurant", "fast_food"],
  bar: ["bar", "pub"],
  pub: ["pub", "bar"],
  gas: ["fuel"],
  petrol: ["fuel"],
  grocery: ["supermarket", "convenience", "greengrocer"],
  groceries: ["supermarket", "convenience", "greengrocer"],
  supermarket: ["supermarket"],
  pharmacy: ["pharmacy", "chemist"],
  drugstore: ["pharmacy", "chemist"],
  gym: ["fitness_centre"],
  hotel: ["hotel"],
  atm: ["atm"],
  bank: ["bank"],
  parking: ["parking"],
  hospital: ["hospital"],
  bakery: ["bakery"],
  park: ["park"],
};

function regexSafe(text: string): string {
  return text.replace(/[^\p{L}\p{N} '-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export function overpassQuery(query: string, lat: number, lon: number, radiusM: number, limit = 40): string {
  const q = regexSafe(query);
  const words = q.toLowerCase().split(" ").filter(Boolean);
  const tags = new Set<string>();
  for (const word of words) {
    const singular = word.endsWith("s") ? word.slice(0, -1) : word;
    for (const tag of TAG_WORDS[word] ?? TAG_WORDS[singular] ?? []) tags.add(tag);
    if (/^[a-z_]{3,}$/.test(singular)) tags.add(singular);
  }
  const around = `(around:${Math.round(radiusM)},${lat},${lon})`;
  const tagAlt = [...tags].join("|");
  const clauses = [
    ...(q ? [`nwr${around}["name"~"${q}",i];`, `nwr${around}["cuisine"~"${q.toLowerCase().replace(/ /g, "_")}",i];`] : []),
    ...(tagAlt ? ["amenity", "shop", "tourism", "leisure"].map((k) => `nwr${around}["${k}"~"^(${tagAlt})$"];`) : []),
  ];
  return `[out:json][timeout:25];(${clauses.join("")});out center tags ${limit};`;
}

export function googleTextSearchBody(query: string, center?: { lat: number; lon: number }, radiusM?: number): Record<string, unknown> {
  return {
    textQuery: query,
    maxResultCount: MAX_RESULTS,
    ...(center
      ? { locationBias: { circle: { center: { latitude: center.lat, longitude: center.lon }, radius: Math.min(50_000, Math.max(1, radiusM ?? 2_000)) } } }
      : {}),
  };
}

export function mapsLink(name: string, lat: number, lon: number): string {
  return `https://maps.apple.com/?q=${encodeURIComponent(name)}&ll=${lat},${lon}`;
}

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function fromNominatim(row: Record<string, unknown>): Place | null {
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const extra = (row.extratags ?? {}) as Record<string, unknown>;
  const address = str(row.display_name);
  const name = str(row.name) ?? address?.split(",")[0] ?? "Unnamed place";
  const category = [str(row.category), str(row.type)].filter(Boolean).join(":") || undefined;
  return {
    name,
    ...(address ? { address } : {}),
    lat,
    lon,
    ...(category ? { category } : {}),
    ...(str(extra.opening_hours) ? { openingHours: str(extra.opening_hours) } : {}),
    ...(str(extra.phone) ?? str(extra["contact:phone"]) ? { phone: str(extra.phone) ?? str(extra["contact:phone"]) } : {}),
    ...(str(extra.website) ?? str(extra["contact:website"]) ? { website: str(extra.website) ?? str(extra["contact:website"]) } : {}),
    mapsUrl: mapsLink(name, lat, lon),
    source: "osm",
  };
}

function fromOverpass(el: Record<string, unknown>, origin: { lat: number; lon: number }): Place | null {
  const center = (el.center ?? {}) as Record<string, unknown>;
  const lat = Number(el.lat ?? center.lat);
  const lon = Number(el.lon ?? center.lon);
  const tags = (el.tags ?? {}) as Record<string, unknown>;
  const name = str(tags.name);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const street = [str(tags["addr:housenumber"]), str(tags["addr:street"])].filter(Boolean).join(" ");
  const address = [street, str(tags["addr:city"]), str(tags["addr:postcode"])].filter(Boolean).join(", ");
  const kindKey = ["amenity", "shop", "tourism", "leisure"].find((k) => str(tags[k]));
  return {
    name,
    ...(address ? { address } : {}),
    lat,
    lon,
    ...(kindKey ? { category: `${kindKey}:${str(tags[kindKey])}${str(tags.cuisine) ? ` (${str(tags.cuisine)})` : ""}` } : {}),
    ...(str(tags.opening_hours) ? { openingHours: str(tags.opening_hours) } : {}),
    ...(str(tags.phone) ?? str(tags["contact:phone"]) ? { phone: str(tags.phone) ?? str(tags["contact:phone"]) } : {}),
    ...(str(tags.website) ?? str(tags["contact:website"]) ? { website: str(tags.website) ?? str(tags["contact:website"]) } : {}),
    distanceM: distanceM(origin, { lat, lon }),
    mapsUrl: mapsLink(name, lat, lon),
    source: "osm",
  };
}

function fromGoogle(row: Record<string, unknown>, origin?: { lat: number; lon: number }): Place | null {
  const loc = (row.location ?? {}) as Record<string, unknown>;
  const lat = Number(loc.latitude);
  const lon = Number(loc.longitude);
  const name = str((row.displayName as Record<string, unknown> | undefined)?.text);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const hours = (row.regularOpeningHours as Record<string, unknown> | undefined)?.weekdayDescriptions;
  return {
    name,
    ...(str(row.formattedAddress) ? { address: str(row.formattedAddress) } : {}),
    lat,
    lon,
    ...(str(row.primaryType) ? { category: str(row.primaryType) } : {}),
    ...(Array.isArray(hours) && hours.length ? { openingHours: hours.join("; ") } : {}),
    ...(str(row.nationalPhoneNumber) ? { phone: str(row.nationalPhoneNumber) } : {}),
    ...(str(row.websiteUri) ? { website: str(row.websiteUri) } : {}),
    ...(typeof row.rating === "number" ? { rating: row.rating } : {}),
    ...(origin ? { distanceM: distanceM(origin, { lat, lon }) } : {}),
    mapsUrl: mapsLink(name, lat, lon),
    source: "google",
  };
}

// ─── Operations ──────────────────────────────────────────────────────────────

const osmHeaders = { "user-agent": PLACES_USER_AGENT, accept: "application/json", "accept-language": "en" };

export async function geocode(query: string, signal?: AbortSignal, limit = 5): Promise<Place[]> {
  const url = nominatimSearchUrl(query, { limit });
  const rows = await cached(url, () => nominatimThrottle(() => getJson(url, { headers: osmHeaders }, signal)));
  return (Array.isArray(rows) ? rows : []).map((r) => fromNominatim(r as Record<string, unknown>)).filter((p): p is Place => p !== null);
}

export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<Place | null> {
  const url = nominatimReverseUrl(lat, lon);
  const row = await cached(url, () => nominatimThrottle(() => getJson(url, { headers: osmHeaders }, signal)));
  return row && typeof row === "object" && !(row as Record<string, unknown>).error ? fromNominatim(row as Record<string, unknown>) : null;
}

function parseLatLon(text: string | undefined): { lat: number; lon: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text ?? "");
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export async function searchPlaces(
  query: string,
  opts: { near?: string; radiusM?: number; signal?: AbortSignal; googleKey?: string } = {},
): Promise<{ places: Place[]; center?: { lat: number; lon: number; label?: string } }> {
  const radiusM = Math.min(50_000, Math.max(100, opts.radiusM ?? 2_000));
  let center: { lat: number; lon: number; label?: string } | undefined = parseLatLon(opts.near) ?? undefined;
  if (!center && opts.near?.trim()) {
    const hit = (await geocode(opts.near, opts.signal, 1))[0];
    if (!hit) throw new Error(`couldn't find "${opts.near}" to search near`);
    center = { lat: hit.lat, lon: hit.lon, label: hit.address ?? hit.name };
  }

  if (opts.googleKey) {
    const body = googleTextSearchBody(query, center, radiusM);
    const key = `google:${JSON.stringify(body)}`;
    const json = await cached(key, () =>
      getJson(GOOGLE_TEXT_SEARCH, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": opts.googleKey!, "x-goog-fieldmask": GOOGLE_FIELDS },
        body: JSON.stringify(body),
      }, opts.signal),
    );
    const rows = ((json as Record<string, unknown>)?.places as unknown[] | undefined) ?? [];
    const places = rows.map((r) => fromGoogle(r as Record<string, unknown>, center)).filter((p): p is Place => p !== null);
    return { places: places.slice(0, MAX_RESULTS), ...(center ? { center } : {}) };
  }

  if (!center) return { places: await geocode(query, opts.signal, MAX_RESULTS) };

  const data = overpassQuery(query, center.lat, center.lon, radiusM);
  try {
    const json = await cached(`overpass:${data}`, () =>
      getJson(OVERPASS, {
        method: "POST",
        headers: { "user-agent": PLACES_USER_AGENT, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ data }).toString(),
      }, opts.signal),
    );
    const elements = ((json as Record<string, unknown>)?.elements as unknown[] | undefined) ?? [];
    const seen = new Set<string>();
    const places = elements
      .map((e) => fromOverpass(e as Record<string, unknown>, center!))
      .filter((p): p is Place => p !== null)
      .filter((p) => {
        const k = `${p.name}|${p.lat.toFixed(4)}|${p.lon.toFixed(4)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
    if (places.length > 0) return { places: places.slice(0, MAX_RESULTS), center };
  } catch {
    // Overpass is a volunteer service and is often busy — fall through to a
    // bounded Nominatim search rather than failing the lookup.
  }
  const d = radiusM / 111_000;
  const url = nominatimSearchUrl(query, { limit: MAX_RESULTS, viewbox: [center.lon - d, center.lat + d, center.lon + d, center.lat - d] });
  const rows = await cached(url, () => nominatimThrottle(() => getJson(url, { headers: osmHeaders }, opts.signal)));
  const places = (Array.isArray(rows) ? rows : [])
    .map((r) => fromNominatim(r as Record<string, unknown>))
    .filter((p): p is Place => p !== null)
    .map((p) => ({ ...p, distanceM: distanceM(center!, p) }))
    .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
  return { places, center };
}

// ─── Tool ────────────────────────────────────────────────────────────────────

const inputSchema = z
  .object({
    action: z.enum(["geocode", "reverse", "search"]).describe(
      "geocode: address/place name → coordinates. reverse: coordinates → address. search: find places (\"sushi\", \"pharmacy\", \"Blue Bottle\") optionally near somewhere.",
    ),
    query: z.string().optional().describe("geocode/search: what to look for."),
    lat: z.number().optional().describe("reverse: latitude."),
    lon: z.number().optional().describe("reverse: longitude."),
    near: z.string().optional().describe("search: a place name/address or \"lat,lon\" to search around."),
    radius_m: z.number().int().positive().optional().describe("search: radius in meters around `near` (default 2000, max 50000)."),
  })
  .strict();

export interface PlacesOutput {
  places: Place[];
  center?: { lat: number; lon: number; label?: string };
  source?: "osm" | "google";
  message: string;
}

function render(p: Place): string {
  const bits = [
    p.name,
    p.category ? `(${p.category})` : "",
    p.distanceM !== undefined ? `${p.distanceM} m` : "",
    p.address ? `— ${p.address}` : "",
    p.openingHours ? `· hours: ${p.openingHours}` : "",
    p.phone ? `· ${p.phone}` : "",
    p.website ? `· ${p.website}` : "",
    p.rating !== undefined ? `· ★${p.rating}` : "",
    `· ${p.mapsUrl}`,
  ];
  return bits.filter(Boolean).join(" ");
}

export const PlacesTool = buildTool<typeof inputSchema, PlacesOutput>({
  name: "Places",
  description:
    "Find real places and addresses: geocode (address → lat/lon), reverse (lat/lon → address), search (\"coffee\", \"pharmacy\", a business name) near a place or \"lat,lon\". " +
    "Returns name, address, coordinates, category, opening hours/phone/website when known, and an Apple Maps link to give the owner. " +
    "Uses OpenStreetMap (free); prefers Google Places when the owner connected a key (Connect service \"google-places\"). Use it before recommending or booking somewhere.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  watchdogTimeoutMs: 90_000,
  activityDescription: (i) =>
    i.action === "reverse" ? `Looking up ${i.lat},${i.lon}` : i.action === "geocode" ? `Locating ${i.query ?? "a place"}` : `Searching places: ${i.query ?? ""}${i.near ? ` near ${i.near}` : ""}`,
  async call(input, ctx): Promise<ToolResult<PlacesOutput>> {
    const fail = (message: string): ToolResult<PlacesOutput> => ({ output: { places: [], message }, display: message, failure: message });
    try {
      if (input.action === "reverse") {
        if (typeof input.lat !== "number" || typeof input.lon !== "number") return fail("reverse needs lat and lon.");
        const place = await reverseGeocode(input.lat, input.lon, ctx.signal);
        if (!place) return fail(`Nothing found at ${input.lat},${input.lon}.`);
        return { output: { places: [place], source: "osm", message: render(place) }, display: render(place) };
      }
      if (!input.query?.trim()) return fail(`${input.action} needs query.`);
      if (input.action === "geocode") {
        const places = await geocode(input.query, ctx.signal);
        const message = places.length ? places.map(render).join("\n") : `No match for "${input.query}".`;
        return { output: { places, source: "osm", message }, display: message.slice(0, 300) };
      }
      const googleKey = await getCredential("GOOGLE_PLACES_API_KEY").catch(() => undefined);
      const { places, center } = await searchPlaces(input.query, { near: input.near, radiusM: input.radius_m, signal: ctx.signal, googleKey });
      const message = places.length
        ? places.map(render).join("\n")
        : `No "${input.query}" found${input.near ? ` within ${input.radius_m ?? 2000} m of ${input.near}` : ""} — widen radius_m or rephrase.`;
      return { output: { places, ...(center ? { center } : {}), source: googleKey ? "google" : "osm", message }, display: message.slice(0, 300) };
    } catch (err) {
      return fail(`Places lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
