// Universal API connector: the service definitions the `Api` tool works from.
//
// One OpenAPI spec + one credential recipe = a whole service, instead of a
// hand-written connector per service. A service is described by an
// ApiServiceDef (what host, how it authenticates, how fast it may be called);
// the parsed spec lives beside it on disk; secrets live ONLY in the credential
// vault (credentials.ts), under names derived from the service id.
//
//   <home>/api-services/<id>/def.json    the definition (no secrets)
//   <home>/api-services/<id>/spec.json   the owner's spec, as JSON
//   <home>/api-services/audit.jsonl      one line per call (no values)
//
// This file is the leaf half: types, naming, the preset catalogue, the disk
// store and the connect-hub entry for a service. The spec engine and the tool
// are in @ares/tools.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { aresHome } from "./providers/openaiAuth.js";
import type { ConnectField, ConnectService } from "./connectServices.js";

export type ApiAuth =
  | { type: "none" }
  | { type: "apiKey"; in: "header" | "query" | "cookie"; name: string; optional?: boolean; defaultValue?: string; label?: string }
  | { type: "bearer"; header?: string; scheme?: string; optional?: boolean; label?: string }
  | { type: "basic" }
  | { type: "oauth2cc"; tokenUrl: string; scope?: string };

export interface ApiServiceDef {
  /** 2-40 chars: lowercase letters, digits, dashes. */
  id: string;
  label: string;
  blurb: string;
  specSource: { kind: "preset" } | { kind: "url"; url: string } | { kind: "inline" };
  /** The one origin (plus optional path prefix) calls go to. */
  baseUrl?: string;
  /** Ask the owner for the base URL in the connect form (Home Assistant). */
  baseUrlField?: { label: string; placeholder?: string; help?: string };
  /** Other origins an operation's own `servers` entry may name. Nothing else is ever called. */
  extraOrigins?: string[];
  auth: ApiAuth;
  /** The owner allows this service on a private/LAN address over plain http. */
  allowLan?: boolean;
  /** Accept a self-signed TLS certificate (a LAN service over https). Only with allowLan. */
  insecureTls?: boolean;
  /** Fixed non-secret request headers (User-Agent, Accept). */
  headers?: Record<string, string>;
  /** Minimum gap between calls (Nominatim: one per second). */
  minIntervalMs?: number;
  /** Calls per minute (default 60). */
  ratePerMin?: number;
  /** The operation the connect form's live check calls (a read). */
  verifyOperationId?: string;
  /** POST-style operations that are really reads (GraphQL, search). */
  readOperationIds?: string[];
  /** A response shim for formats that are not JSON. */
  transform?: "atom";
  keywords?: string[];
  domain?: string;
  howToUse?: string;
}

export const API_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;

export function validateApiId(id: string): string | null {
  if (!API_ID_RE.test(id)) return "a service id is 2-40 lowercase letters, digits and dashes (e.g. \"my-crm\")";
  return null;
}

/** The vault name of one of a service's credentials. Also the env var that
 *  stands in for it (getCredential falls back to process.env[name]). */
export function apiCred(id: string, part: "KEY" | "USER" | "PASS" | "CLIENT_ID" | "CLIENT_SECRET" | "BASEURL"): string {
  return `API_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${part}`;
}

/** The connect-hub id of an Api service. */
export function apiConnectId(id: string): string {
  return `api-${id}`;
}

export function isApiConnectId(connectId: string): boolean {
  return connectId.startsWith("api-");
}

const UA = "AresAgent/1.0 (personal assistant; +https://github.com/clout2buy/ares)";

// ─── Presets: ready-made services with bundled, trimmed specs (in @ares/tools) ──

export const API_PRESET_DEFS: ApiServiceDef[] = [
  {
    id: "open-meteo",
    label: "Open-Meteo",
    blurb: "Weather forecasts, history and place-name geocoding. Free, no key.",
    specSource: { kind: "preset" },
    baseUrl: "https://api.open-meteo.com",
    extraOrigins: ["https://geocoding-api.open-meteo.com", "https://air-quality-api.open-meteo.com", "https://archive-api.open-meteo.com"],
    auth: { type: "none" },
    headers: { "user-agent": UA },
    ratePerMin: 30,
    verifyOperationId: "searchLocation",
    keywords: ["open meteo", "openmeteo"],
    howToUse: "Api search/describe/call service open-meteo: searchLocation turns a place name into latitude/longitude, then forecast / archive / airQuality take those coordinates.",
  },
  {
    id: "wikipedia",
    label: "Wikipedia",
    blurb: "Article summaries, page search and page content from English Wikipedia. Free, no key.",
    specSource: { kind: "preset" },
    baseUrl: "https://en.wikipedia.org",
    auth: { type: "none" },
    headers: { "user-agent": UA },
    ratePerMin: 60,
    verifyOperationId: "searchPages",
    keywords: ["wikipedia"],
  },
  {
    id: "wikidata",
    label: "Wikidata",
    blurb: "Structured facts about people, places and things: entity search, entity data and SPARQL. Free, no key.",
    specSource: { kind: "preset" },
    baseUrl: "https://www.wikidata.org",
    extraOrigins: ["https://query.wikidata.org"],
    auth: { type: "none" },
    headers: { "user-agent": UA },
    ratePerMin: 30,
    verifyOperationId: "searchEntities",
    keywords: ["wikidata"],
  },
  {
    id: "nominatim",
    label: "OpenStreetMap Nominatim",
    blurb: "Geocoding and reverse geocoding on OpenStreetMap. Free, no key; limited to one request per second by its usage policy.",
    specSource: { kind: "preset" },
    baseUrl: "https://nominatim.openstreetmap.org",
    auth: { type: "none" },
    headers: { "user-agent": UA },
    minIntervalMs: 1100,
    ratePerMin: 50,
    verifyOperationId: "search",
    keywords: ["nominatim", "openstreetmap"],
  },
  {
    id: "open-library",
    label: "Open Library",
    blurb: "Book search, editions, works, authors and ISBN lookup. Free, no key.",
    specSource: { kind: "preset" },
    baseUrl: "https://openlibrary.org",
    auth: { type: "none" },
    headers: { "user-agent": UA },
    ratePerMin: 60,
    verifyOperationId: "searchBooks",
    keywords: ["open library", "openlibrary"],
  },
  {
    id: "arxiv",
    label: "arXiv",
    blurb: "Search preprints in physics, maths, computer science and more. Free, no key. Results are converted from Atom to JSON.",
    specSource: { kind: "preset" },
    baseUrl: "https://export.arxiv.org",
    auth: { type: "none" },
    headers: { "user-agent": UA },
    minIntervalMs: 3100,
    ratePerMin: 15,
    transform: "atom",
    verifyOperationId: "searchPapers",
    keywords: ["arxiv"],
  },
  {
    id: "hacker-news",
    label: "Hacker News",
    blurb: "Top, new and best stories, items, comments and users on Hacker News. Free, no key.",
    specSource: { kind: "preset" },
    baseUrl: "https://hacker-news.firebaseio.com",
    auth: { type: "none" },
    headers: { "user-agent": UA },
    ratePerMin: 120,
    verifyOperationId: "maxItem",
    keywords: ["hacker news", "hackernews"],
  },
  {
    id: "usgs-earthquakes",
    label: "USGS Earthquakes",
    blurb: "Real-time and historical earthquakes worldwide from the US Geological Survey. Free, no key.",
    specSource: { kind: "preset" },
    baseUrl: "https://earthquake.usgs.gov",
    auth: { type: "none" },
    headers: { "user-agent": UA },
    ratePerMin: 30,
    verifyOperationId: "countEarthquakes",
    keywords: ["usgs earthquakes", "usgs"],
  },
  {
    id: "frankfurter",
    label: "Frankfurter (FX rates)",
    blurb: "Foreign-exchange reference rates from the European Central Bank, current and historical. Free, no key.",
    specSource: { kind: "preset" },
    baseUrl: "https://api.frankfurter.dev",
    auth: { type: "none" },
    headers: { "user-agent": UA },
    ratePerMin: 60,
    verifyOperationId: "currencies",
    keywords: ["frankfurter"],
  },
  {
    id: "coingecko",
    label: "CoinGecko",
    blurb: "Crypto prices, markets and search. Works without a key at a low rate limit; a free demo key raises it.",
    specSource: { kind: "preset" },
    baseUrl: "https://api.coingecko.com",
    auth: { type: "apiKey", in: "header", name: "x-cg-demo-api-key", optional: true, label: "Demo API key (optional)" },
    headers: { "user-agent": UA },
    ratePerMin: 10,
    verifyOperationId: "supportedVsCurrencies",
    keywords: ["coingecko"],
    domain: "coingecko.com",
  },
  {
    id: "nasa-apod",
    label: "NASA APOD",
    blurb: "NASA's Astronomy Picture of the Day. Works on NASA's shared DEMO_KEY; a free key from api.nasa.gov lifts the limit.",
    specSource: { kind: "preset" },
    baseUrl: "https://api.nasa.gov",
    auth: { type: "apiKey", in: "query", name: "api_key", optional: true, defaultValue: "DEMO_KEY", label: "NASA API key (optional)" },
    headers: { "user-agent": UA },
    ratePerMin: 20,
    verifyOperationId: "apod",
    keywords: ["nasa apod", "apod"],
    domain: "nasa.gov",
  },
  {
    id: "home-assistant",
    label: "Home Assistant",
    blurb: "Your Home Assistant: entity states, services (lights, climate, scenes, scripts), events and history, over the LAN.",
    specSource: { kind: "preset" },
    baseUrlField: { label: "Home Assistant address", placeholder: "http://homeassistant.local:8123", help: "The address you open Home Assistant at, without /api." },
    auth: { type: "bearer", label: "Long-lived access token" },
    allowLan: true,
    ratePerMin: 120,
    verifyOperationId: "apiRoot",
    readOperationIds: ["renderTemplate", "checkConfig"],
    keywords: ["home assistant", "homeassistant"],
    domain: "home-assistant.io",
    howToUse: "Api search/describe/call service home-assistant: states / getState to read entities, callService (domain + service, e.g. light turn_on) to act. Acting asks the owner first.",
  },
];

export function apiPresetDef(id: string): ApiServiceDef | undefined {
  return API_PRESET_DEFS.find((d) => d.id === id);
}

// ─── Disk store (user-added services) ────────────────────────────────────────

export function apiServicesDir(home?: string): string {
  return path.join(home ?? aresHome(), "api-services");
}

export function apiServiceDir(id: string, home?: string): string {
  if (validateApiId(id)) throw new Error(`bad service id: ${id}`);
  return path.join(apiServicesDir(home), id);
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(5).toString("hex")}.tmp`;
  writeFileSync(tmp, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

export function saveApiServiceDef(def: ApiServiceDef, home?: string): void {
  writeJsonAtomic(path.join(apiServiceDir(def.id, home), "def.json"), { ...def, addedAt: new Date().toISOString() });
}

export function saveApiServiceSpec(id: string, rawSpecJson: string, home?: string): void {
  writeJsonAtomic(path.join(apiServiceDir(id, home), "spec.json"), rawSpecJson);
}

export function readApiServiceSpecText(id: string, home?: string): string | null {
  try {
    return readFileSync(path.join(apiServiceDir(id, home), "spec.json"), "utf8");
  } catch {
    return null;
  }
}

export function loadApiServiceDef(id: string, home?: string): ApiServiceDef | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(apiServiceDir(id, home), "def.json"), "utf8")) as ApiServiceDef;
    return parsed && parsed.id === id ? parsed : null;
  } catch {
    return null;
  }
}

export function listApiServiceDefs(home?: string): ApiServiceDef[] {
  const dir = apiServicesDir(home);
  if (!existsSync(dir)) return [];
  const out: ApiServiceDef[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || validateApiId(entry.name)) continue;
    const def = loadApiServiceDef(entry.name, home);
    if (def) out.push(def);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function removeApiServiceFiles(id: string, home?: string): boolean {
  const dir = apiServiceDir(id, home);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** A preset, or the owner's own service. Presets win: their ids are reserved. */
export function resolveApiServiceDef(id: string, home?: string): ApiServiceDef | null {
  return apiPresetDef(id) ?? loadApiServiceDef(id, home);
}

// ─── The connect-hub entry ───────────────────────────────────────────────────

/** The fields the secure phone form asks for, derived from the auth recipe. */
export function apiConnectFields(def: ApiServiceDef): ConnectField[] {
  const fields: ConnectField[] = [];
  if (def.baseUrlField) {
    fields.push({
      credential: apiCred(def.id, "BASEURL"),
      label: def.baseUrlField.label,
      ...(def.baseUrlField.placeholder ? { placeholder: def.baseUrlField.placeholder } : {}),
      ...(def.baseUrlField.help ? { help: def.baseUrlField.help } : {}),
    });
  }
  const auth = def.auth;
  switch (auth.type) {
    case "apiKey":
    case "bearer":
      fields.push({ credential: apiCred(def.id, "KEY"), label: auth.label ?? (auth.type === "bearer" ? "Access token" : "API key"), secret: true });
      break;
    case "basic":
      fields.push({ credential: apiCred(def.id, "USER"), label: "Username" });
      fields.push({ credential: apiCred(def.id, "PASS"), label: "Password", secret: true });
      break;
    case "oauth2cc":
      fields.push({ credential: apiCred(def.id, "CLIENT_ID"), label: "Client ID" });
      fields.push({ credential: apiCred(def.id, "CLIENT_SECRET"), label: "Client secret", secret: true });
      break;
    case "none":
      break;
  }
  return fields;
}

/** The registry entry for a service that needs something from the owner
 *  (a key, a token, an address). Keyless services need no card: null. */
export function apiConnectService(def: ApiServiceDef): ConnectService | null {
  const fields = apiConnectFields(def);
  if (!fields.length) return null;
  return {
    id: apiConnectId(def.id),
    label: def.label,
    kind: "api-key",
    blurb: def.blurb,
    keywords: [def.id, def.label.toLowerCase(), ...(def.keywords ?? [])],
    ...(def.domain ? { domain: def.domain } : {}),
    fields,
    howToUse:
      def.howToUse ??
      `Use the Api tool with service "${def.id}": search to find an operation, describe to see its parameters, call to run it. Anything that changes data asks the owner first.`,
  };
}

/** The MQTT broker (the Mqtt tool). One secret field: the broker URL with its credentials. */
export const MQTT_CONNECT_SERVICE: ConnectService = {
  id: "mqtt",
  label: "MQTT broker",
  kind: "api-key",
  blurb: "Your smart-home message bus (Mosquitto, Home Assistant, zigbee2mqtt): read topics, publish commands.",
  keywords: ["mqtt", "mosquitto", "zigbee2mqtt", "mqtt broker"],
  keyUrl: "https://mosquitto.org/",
  fields: [
    {
      credential: "MQTT_URL",
      label: "Broker URL",
      placeholder: "mqtt://user:password@192.168.1.10:1883",
      secret: true,
      help: "mqtt://[user:password@]host[:1883], or mqtts://host[:8883] for TLS (add ?insecure=1 for a self-signed certificate).",
    },
  ],
  howToUse: "Use the Mqtt tool: status, tree (what topics exist), subscribe / retained (read), publish (asks the owner first).",
};

/** Presets' connect entries (plus MQTT) — part of the static registry. */
export const API_CONNECT_SERVICES: ConnectService[] = [
  ...API_PRESET_DEFS.map(apiConnectService).filter((s): s is ConnectService => s !== null),
  MQTT_CONNECT_SERVICE,
];

/** Resolve "api-<id>" for a user service straight from disk (sync), so a
 *  service added in another process still connects. */
export function apiConnectServiceFromDisk(connectId: string, home?: string): ConnectService | null {
  if (!isApiConnectId(connectId)) return null;
  const id = connectId.slice(4);
  if (validateApiId(id)) return null;
  const preset = apiPresetDef(id);
  if (preset) return apiConnectService(preset);
  const def = loadApiServiceDef(id, home);
  return def ? apiConnectService(def) : null;
}
