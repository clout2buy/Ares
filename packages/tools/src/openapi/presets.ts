// Bundled, trimmed OpenAPI 3.0 specs for the preset services (their definitions —
// host, auth, rate limits — are API_PRESET_DEFS in @ares/core). Each spec names
// only the operations worth having and documents only the parameters worth
// setting, so `search`/`describe` stay small. Every preset here was called for
// real from doingbox during its test run (tests/universal-presets.test.mjs,
// ARES_UNIVERSAL_INTEGRATION=1); the ones that did not answer were dropped.

import type { JsonObject } from "./spec.js";

type Loc = "path" | "query" | "header";

const str = (description: string, extra: JsonObject = {}): JsonObject => ({ type: "string", description, ...extra });
const num = (description: string, extra: JsonObject = {}): JsonObject => ({ type: "number", description, ...extra });
const int = (description: string, extra: JsonObject = {}): JsonObject => ({ type: "integer", description, ...extra });
const bool = (description: string, extra: JsonObject = {}): JsonObject => ({ type: "boolean", description, ...extra });
/** A comma-separated list (style=form, explode=false). */
const csv = (description: string): JsonObject => ({ type: "array", items: { type: "string" }, description });

function p(name: string, where: Loc, schema: JsonObject, required = false, extra: JsonObject = {}): JsonObject {
  const { description, ...rest } = schema as { description?: string } & JsonObject;
  return {
    name,
    in: where,
    required: where === "path" ? true : required,
    ...(description ? { description } : {}),
    schema: rest,
    ...(rest.type === "array" ? { style: "form", explode: false } : {}),
    ...extra,
  };
}

function op(operationId: string, summary: string, parameters: JsonObject[], extra: JsonObject = {}): JsonObject {
  return { operationId, summary, parameters, responses: { "200": { description: "OK" } }, ...extra };
}

function spec(title: string, server: string, description: string, paths: JsonObject): JsonObject {
  return { openapi: "3.0.3", info: { title, version: "preset-1", description }, servers: [{ url: server }], paths };
}

const DAY = "YYYY-MM-DD";
const JSON_BODY = (schema: JsonObject, required = true): JsonObject => ({ required, content: { "application/json": { schema } } });

// ─── Open-Meteo ──────────────────────────────────────────────────────────────

const openMeteo = spec("Open-Meteo", "https://api.open-meteo.com", "Free weather API. Coordinates in, forecasts out. Find coordinates with searchLocation.", {
  "/v1/forecast": {
    get: op(
      "forecast",
      "Weather forecast for coordinates: current conditions, hourly and daily series",
      [
        p("latitude", "query", num("Latitude in degrees, e.g. 52.52"), true),
        p("longitude", "query", num("Longitude in degrees, e.g. 13.41"), true),
        p("current", "query", csv("Current variables, e.g. temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m")),
        p("hourly", "query", csv("Hourly variables, e.g. temperature_2m,precipitation_probability,rain,wind_speed_10m")),
        p("daily", "query", csv("Daily variables, e.g. temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset,weather_code")),
        p("timezone", "query", str("IANA zone or \"auto\" (needed when asking for daily variables)", { default: "auto" })),
        p("temperature_unit", "query", str("Unit", { enum: ["celsius", "fahrenheit"] })),
        p("wind_speed_unit", "query", str("Unit", { enum: ["kmh", "ms", "mph", "kn"] })),
        p("precipitation_unit", "query", str("Unit", { enum: ["mm", "inch"] })),
        p("forecast_days", "query", int("How many days ahead (1-16, default 7)", { minimum: 1, maximum: 16 })),
        p("past_days", "query", int("Include this many past days (0-92)", { minimum: 0, maximum: 92 })),
        p("start_date", "query", str(`First day ${DAY}`)),
        p("end_date", "query", str(`Last day ${DAY}`)),
      ],
      { tags: ["weather"] },
    ),
  },
  "/v1/search": {
    get: op(
      "searchLocation",
      "Geocoding: a place name to latitude/longitude, country, timezone and elevation",
      [
        p("name", "query", str("Place name or postcode, e.g. \"Berlin\""), true),
        p("count", "query", int("Results to return (1-100, default 10)", { minimum: 1, maximum: 100 })),
        p("language", "query", str("Language for names, e.g. en")),
        p("countryCode", "query", str("ISO-3166 alpha-2 filter, e.g. DE")),
      ],
      { tags: ["geocoding"], servers: [{ url: "https://geocoding-api.open-meteo.com" }] },
    ),
  },
  "/v1/archive": {
    get: op(
      "archive",
      "Historical weather (ERA5 reanalysis) for a date range at coordinates",
      [
        p("latitude", "query", num("Latitude"), true),
        p("longitude", "query", num("Longitude"), true),
        p("start_date", "query", str(`First day ${DAY}`), true),
        p("end_date", "query", str(`Last day ${DAY}`), true),
        p("hourly", "query", csv("Hourly variables, e.g. temperature_2m,precipitation")),
        p("daily", "query", csv("Daily variables, e.g. temperature_2m_max,temperature_2m_min,precipitation_sum")),
        p("timezone", "query", str("IANA zone or \"auto\"", { default: "auto" })),
      ],
      { tags: ["weather"], servers: [{ url: "https://archive-api.open-meteo.com" }] },
    ),
  },
  "/v1/air-quality": {
    get: op(
      "airQuality",
      "Air quality and pollen forecast for coordinates",
      [
        p("latitude", "query", num("Latitude"), true),
        p("longitude", "query", num("Longitude"), true),
        p("current", "query", csv("e.g. european_aqi,us_aqi,pm10,pm2_5")),
        p("hourly", "query", csv("e.g. pm10,pm2_5,ozone,uv_index")),
        p("timezone", "query", str("IANA zone or \"auto\"", { default: "auto" })),
        p("forecast_days", "query", int("Days ahead (1-7)", { minimum: 1, maximum: 7 })),
      ],
      { tags: ["weather"], servers: [{ url: "https://air-quality-api.open-meteo.com" }] },
    ),
  },
});

// ─── Wikipedia ───────────────────────────────────────────────────────────────

const wikipedia = spec("Wikipedia (English)", "https://en.wikipedia.org", "English Wikipedia's REST API.", {
  "/w/rest.php/v1/search/page": {
    get: op("searchPages", "Search article titles and text; returns title, key, excerpt, description", [
      p("q", "query", str("Search terms"), true),
      p("limit", "query", int("Results (1-100, default 10)", { minimum: 1, maximum: 100 })),
    ], { tags: ["search"] }),
  },
  "/api/rest_v1/page/summary/{title}": {
    get: op("getPageSummary", "Summary of one article: first paragraph, description, thumbnail, links", [
      p("title", "path", str("Article title, e.g. \"Alan Turing\" (spaces are fine)")),
    ], { tags: ["pages"] }),
  },
  "/api/rest_v1/page/random/summary": {
    get: op("randomSummary", "Summary of a random article", [], { tags: ["pages"] }),
  },
  "/w/rest.php/v1/page/{title}": {
    get: op("getPageSource", "An article's full wikitext source and metadata (large: use select)", [
      p("title", "path", str("Article title")),
    ], { tags: ["pages"] }),
  },
  "/api/rest_v1/feed/onthisday/{type}/{mm}/{dd}": {
    get: op("onThisDay", "Events, births, deaths or holidays on a calendar day", [
      p("type", "path", str("What to list", { enum: ["selected", "all", "events", "births", "deaths", "holidays"] })),
      p("mm", "path", str("Month, two digits, e.g. 07")),
      p("dd", "path", str("Day, two digits, e.g. 04")),
    ], { tags: ["feed"] }),
  },
});

// ─── Wikidata ────────────────────────────────────────────────────────────────

const wikidata = spec("Wikidata", "https://www.wikidata.org", "Structured knowledge: search entities (Q-items, P-properties), read them, run SPARQL.", {
  "/w/api.php": {
    get: op("searchEntities", "Find entities by name; returns id (Q42), label, description", [
      p("action", "query", str("Fixed", { enum: ["wbsearchentities"], default: "wbsearchentities" }), true),
      p("search", "query", str("Text to look for"), true),
      p("language", "query", str("Search language", { default: "en" }), true),
      p("format", "query", str("Fixed", { enum: ["json"], default: "json" }), true),
      p("type", "query", str("Entity type", { enum: ["item", "property", "lexeme"] })),
      p("limit", "query", int("Results (1-50, default 7)", { minimum: 1, maximum: 50 })),
    ], { tags: ["search"] }),
  },
  "/w/rest.php/wikibase/v1/entities/items/{item_id}": {
    get: op("getItem", "A full item: labels, descriptions, aliases, statements (large: use select)", [
      p("item_id", "path", str("Item id such as Q42")),
    ], { tags: ["items"] }),
  },
  "/w/rest.php/wikibase/v1/entities/items/{item_id}/labels": {
    get: op("getItemLabels", "An item's labels in every language", [p("item_id", "path", str("Item id such as Q42"))], { tags: ["items"] }),
  },
  "/w/rest.php/wikibase/v1/entities/items/{item_id}/descriptions": {
    get: op("getItemDescriptions", "An item's descriptions in every language", [p("item_id", "path", str("Item id such as Q42"))], { tags: ["items"] }),
  },
  "/sparql": {
    get: op("sparqlQuery", "Run a SPARQL query on the Wikidata Query Service (read-only, 60s limit)", [
      p("query", "query", str("SPARQL, e.g. SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q146 . SERVICE wikibase:label { bd:serviceParam wikibase:language \"en\". } } LIMIT 5"), true),
      p("format", "query", str("Fixed", { enum: ["json"], default: "json" }), true),
    ], { tags: ["sparql"], servers: [{ url: "https://query.wikidata.org" }] }),
  },
});

// ─── Nominatim ───────────────────────────────────────────────────────────────

const nominatim = spec("OpenStreetMap Nominatim", "https://nominatim.openstreetmap.org", "Geocoding on OpenStreetMap data. Usage policy: at most one request per second, identify the app, cache results.", {
  "/search": {
    get: op("search", "Address or place name to coordinates", [
      p("q", "query", str("Free-form query, e.g. \"10 Downing Street, London\""), true),
      p("format", "query", str("Output", { enum: ["jsonv2", "json", "geojson"], default: "jsonv2" }), true),
      p("limit", "query", int("Results (1-40, default 10)", { minimum: 1, maximum: 40 })),
      p("addressdetails", "query", int("1 to include the address broken into parts", { enum: [0, 1] })),
      p("countrycodes", "query", csv("Restrict to these ISO country codes, e.g. gb,ie")),
      p("accept-language", "query", str("Preferred language for names, e.g. en")),
    ], { tags: ["geocoding"] }),
  },
  "/reverse": {
    get: op("reverse", "Coordinates to the nearest address or place", [
      p("lat", "query", num("Latitude"), true),
      p("lon", "query", num("Longitude"), true),
      p("format", "query", str("Output", { enum: ["jsonv2", "json", "geojson"], default: "jsonv2" }), true),
      p("zoom", "query", int("Detail level 0-18 (18 = building, 10 = city)", { minimum: 0, maximum: 18 })),
      p("addressdetails", "query", int("1 to include address parts", { enum: [0, 1] })),
      p("accept-language", "query", str("Preferred language, e.g. en")),
    ], { tags: ["geocoding"] }),
  },
  "/lookup": {
    get: op("lookup", "Details of OSM objects by id", [
      p("osm_ids", "query", csv("e.g. N123456,W234567,R345678"), true),
      p("format", "query", str("Output", { enum: ["jsonv2", "json", "geojson"], default: "jsonv2" }), true),
    ], { tags: ["geocoding"] }),
  },
});

// ─── Open Library ────────────────────────────────────────────────────────────

const openLibrary = spec("Open Library", "https://openlibrary.org", "Open Library: books, editions, works and authors.", {
  "/search.json": {
    get: op("searchBooks", "Search books by text, title, author, subject or ISBN", [
      p("q", "query", str("Free-text query")),
      p("title", "query", str("Title")),
      p("author", "query", str("Author name")),
      p("subject", "query", str("Subject")),
      p("isbn", "query", str("ISBN-10 or ISBN-13")),
      p("limit", "query", int("Results per page (default 10)", { minimum: 1, maximum: 100 })),
      p("page", "query", int("Page number, from 1")),
      p("fields", "query", csv("Fields to return, e.g. key,title,author_name,first_publish_year,isbn,cover_i,number_of_pages_median")),
      p("sort", "query", str("Sort", { enum: ["new", "old", "rating", "editions", "random"] })),
    ], { tags: ["search"] }),
  },
  "/isbn/{isbn}.json": {
    get: op("getByIsbn", "An edition by ISBN", [p("isbn", "path", str("ISBN-10 or ISBN-13, digits only"))], { tags: ["books"] }),
  },
  "/works/{work_id}.json": {
    get: op("getWork", "A work (all editions of a book) by id, e.g. OL45804W", [p("work_id", "path", str("Work id like OL45804W"))], { tags: ["books"] }),
  },
  "/works/{work_id}/editions.json": {
    get: op("getWorkEditions", "The editions of a work", [
      p("work_id", "path", str("Work id like OL45804W")),
      p("limit", "query", int("Results (default 50)")),
      p("offset", "query", int("Skip this many")),
    ], { tags: ["books"] }),
  },
  "/authors/{author_id}.json": {
    get: op("getAuthor", "An author by id, e.g. OL23919A", [p("author_id", "path", str("Author id like OL23919A"))], { tags: ["authors"] }),
  },
  "/search/authors.json": {
    get: op("searchAuthors", "Search authors by name", [p("q", "query", str("Author name"), true), p("limit", "query", int("Results"))], { tags: ["authors"] }),
  },
  "/subjects/{subject}.json": {
    get: op("getSubject", "Works on a subject, e.g. love, science_fiction", [
      p("subject", "path", str("Subject slug, lowercase with underscores")),
      p("limit", "query", int("Results")),
      p("details", "query", bool("Include related subjects and publishers")),
    ], { tags: ["subjects"] }),
  },
});

// ─── arXiv ───────────────────────────────────────────────────────────────────

const arxiv = spec("arXiv", "https://export.arxiv.org", "arXiv preprint search. Responses are converted from Atom to {feed, entries[]}. Limit: one call every 3 seconds.", {
  "/api/query": {
    get: op("searchPapers", "Search papers (or fetch specific ones by id_list)", [
      p("search_query", "query", str("Query with field prefixes: all: ti: au: abs: cat: — joined by AND/OR/ANDNOT, e.g. \"ti:transformer AND cat:cs.LG\"")),
      p("id_list", "query", csv("Comma-separated arXiv ids, e.g. 1706.03762,2005.14165 (use instead of search_query)")),
      p("start", "query", int("Offset of the first result (default 0)", { minimum: 0 })),
      p("max_results", "query", int("How many results (default 10, max 100 is polite)", { minimum: 1, maximum: 2000 })),
      p("sortBy", "query", str("Sort field", { enum: ["relevance", "lastUpdatedDate", "submittedDate"] })),
      p("sortOrder", "query", str("Direction", { enum: ["ascending", "descending"] })),
    ], { tags: ["search"] }),
  },
});

// ─── Hacker News ─────────────────────────────────────────────────────────────

const hackerNews = spec("Hacker News", "https://hacker-news.firebaseio.com", "Hacker News official API (Firebase). Lists are arrays of item ids; getItem resolves one.", {
  "/v0/{list}.json": {
    get: op("listStories", "Story ids for a list — pass select \"0:15\" to keep the first 15", [
      p("list", "path", str("Which list", { enum: ["topstories", "newstories", "beststories", "askstories", "showstories", "jobstories"] })),
    ], { tags: ["lists"] }),
  },
  "/v0/item/{id}.json": {
    get: op("getItem", "A story, comment, job or poll by id: title, url, score, by, time, kids (comment ids)", [p("id", "path", int("Item id"))], { tags: ["items"] }),
  },
  "/v0/user/{id}.json": {
    get: op("getUser", "A user: karma, about, created, submitted item ids", [p("id", "path", str("Username (case-sensitive)"))], { tags: ["users"] }),
  },
  "/v0/maxitem.json": {
    get: op("maxItem", "The newest item id", [], { tags: ["items"] }),
  },
  "/v0/updates.json": {
    get: op("updates", "Item and profile ids that changed recently", [], { tags: ["items"] }),
  },
});

// ─── USGS ────────────────────────────────────────────────────────────────────

const FEEDS = ["significant", "4.5", "2.5", "1.0", "all"].flatMap((m) => ["hour", "day", "week", "month"].map((w) => `${m}_${w}`));
const quakeFilters = (): JsonObject[] => [
  p("starttime", "query", str("ISO8601 start, e.g. 2026-09-01 or 2026-09-01T00:00:00")),
  p("endtime", "query", str("ISO8601 end")),
  p("minmagnitude", "query", num("Minimum magnitude")),
  p("maxmagnitude", "query", num("Maximum magnitude")),
  p("latitude", "query", num("Centre latitude for a radius search")),
  p("longitude", "query", num("Centre longitude for a radius search")),
  p("maxradiuskm", "query", num("Radius in km (with latitude/longitude)", { maximum: 20001.6 })),
  p("mindepth", "query", num("Minimum depth km")),
  p("maxdepth", "query", num("Maximum depth km")),
  p("alertlevel", "query", str("PAGER alert", { enum: ["green", "yellow", "orange", "red"] })),
];
const usgs = spec("USGS Earthquakes", "https://earthquake.usgs.gov", "USGS earthquake catalogue (FDSN event service) and real-time feeds. GeoJSON.", {
  "/fdsnws/event/1/query": {
    get: op("queryEarthquakes", "Search the catalogue (GeoJSON features: mag, place, time, coordinates, url)", [
      p("format", "query", str("Output", { enum: ["geojson"], default: "geojson" }), true),
      ...quakeFilters(),
      p("limit", "query", int("Max events (default 20 here; service max 20000)", { minimum: 1, maximum: 20000, default: 20 })),
      p("orderby", "query", str("Order", { enum: ["time", "time-asc", "magnitude", "magnitude-asc"] })),
      p("eventid", "query", str("Fetch one event by id, e.g. us7000abcd")),
    ], { tags: ["catalogue"] }),
  },
  "/fdsnws/event/1/count": {
    get: op("countEarthquakes", "How many events match the filters", [p("format", "query", str("Output", { enum: ["geojson"], default: "geojson" }), true), ...quakeFilters()], { tags: ["catalogue"] }),
  },
  "/earthquakes/feed/v1.0/summary/{feed}.geojson": {
    get: op("summaryFeed", "A real-time summary feed, updated every minute", [
      p("feed", "path", str("Feed name: <min magnitude>_<window>", { enum: FEEDS })),
    ], { tags: ["feeds"] }),
  },
});

// ─── Frankfurter ─────────────────────────────────────────────────────────────

const frankfurter = spec("Frankfurter", "https://api.frankfurter.dev", "ECB reference exchange rates. Working days only; base defaults to EUR.", {
  "/v1/latest": {
    get: op("latest", "Latest rates", [
      p("base", "query", str("Base currency code (default EUR), e.g. USD")),
      p("symbols", "query", csv("Only these currencies, e.g. USD,GBP,JPY")),
    ], { tags: ["rates"] }),
  },
  "/v1/{date}": {
    get: op("historical", "Rates on a date (YYYY-MM-DD) or a time series with \"start..end\" (e.g. 2026-01-01..2026-01-31)", [
      p("date", "path", str("A date, or start..end")),
      p("base", "query", str("Base currency (default EUR)")),
      p("symbols", "query", csv("Only these currencies")),
    ], { tags: ["rates"] }),
  },
  "/v1/currencies": {
    get: op("currencies", "Supported currency codes and names", [], { tags: ["rates"] }),
  },
});

// ─── CoinGecko ───────────────────────────────────────────────────────────────

const coingecko = spec("CoinGecko", "https://api.coingecko.com", "Crypto prices and markets. Keyless calls are heavily rate-limited; a free demo key raises the limit.", {
  "/api/v3/simple/price": {
    get: op("simplePrice", "Current price of coins in other currencies", [
      p("ids", "query", csv("CoinGecko coin ids, e.g. bitcoin,ethereum (find ids with search)"), true),
      p("vs_currencies", "query", csv("Target currencies, e.g. usd,eur"), true),
      p("include_24hr_change", "query", bool("Include 24h change")),
      p("include_market_cap", "query", bool("Include market cap")),
      p("include_24hr_vol", "query", bool("Include 24h volume")),
      p("include_last_updated_at", "query", bool("Include the last update time")),
    ], { tags: ["prices"] }),
  },
  "/api/v3/simple/supported_vs_currencies": {
    get: op("supportedVsCurrencies", "Currency codes usable as vs_currencies", [], { tags: ["prices"] }),
  },
  "/api/v3/coins/markets": {
    get: op("coinsMarkets", "Top coins with price, market cap, volume and change", [
      p("vs_currency", "query", str("Quote currency, e.g. usd"), true),
      p("ids", "query", csv("Only these coin ids")),
      p("order", "query", str("Order", { enum: ["market_cap_desc", "market_cap_asc", "volume_desc", "volume_asc", "id_asc", "id_desc"] })),
      p("per_page", "query", int("Rows per page (1-250)", { minimum: 1, maximum: 250 })),
      p("page", "query", int("Page, from 1")),
    ], { tags: ["markets"] }),
  },
  "/api/v3/search": {
    get: op("search", "Find coin ids by name or symbol", [p("query", "query", str("Name or symbol"), true)], { tags: ["markets"] }),
  },
  "/api/v3/coins/{id}/market_chart": {
    get: op("marketChart", "Price, market cap and volume history for a coin", [
      p("id", "path", str("Coin id, e.g. bitcoin")),
      p("vs_currency", "query", str("Quote currency, e.g. usd"), true),
      p("days", "query", str("Days back: a number, or max"), true),
    ], { tags: ["markets"] }),
  },
  "/api/v3/search/trending": {
    get: op("trending", "Coins trending in the last 24h", [], { tags: ["markets"] }),
  },
});

// ─── NASA APOD ───────────────────────────────────────────────────────────────

const nasaApod = spec("NASA APOD", "https://api.nasa.gov", "Astronomy Picture of the Day. The api_key is supplied by Ares (DEMO_KEY unless the owner stored a key).", {
  "/planetary/apod": {
    get: op("apod", "The picture of the day, or of a date / range / N random ones", [
      p("date", "query", str(`A day ${DAY} (default today)`)),
      p("start_date", "query", str(`Range start ${DAY}`)),
      p("end_date", "query", str(`Range end ${DAY}`)),
      p("count", "query", int("N random pictures (1-100)", { minimum: 1, maximum: 100 })),
      p("thumbs", "query", bool("Return a thumbnail URL for video entries")),
    ], { tags: ["apod"] }),
  },
});

// ─── Home Assistant ──────────────────────────────────────────────────────────

const entityId = (): JsonObject => p("entity_id", "path", str("Entity id like light.kitchen or sensor.outdoor_temperature"));
const homeAssistant = spec("Home Assistant REST API", "http://homeassistant.local:8123", "Home Assistant's REST API (https://developers.home-assistant.io/docs/api/rest/). Read states; call services to act.", {
  "/api/": {
    get: op("apiRoot", "Check the API is up (\"API running.\")", [], { tags: ["core"] }),
  },
  "/api/config": {
    get: op("getConfig", "Instance configuration: location, units, version, components", [], { tags: ["core"] }),
  },
  "/api/states": {
    get: op("listStates", "Every entity's state (can be large: use select, e.g. \"*.entity_id\")", [], { tags: ["states"] }),
  },
  "/api/states/{entity_id}": {
    get: op("getState", "One entity's state and attributes", [entityId()], { tags: ["states"] }),
    post: op("setState", "Set an entity's state REPRESENTATION in Home Assistant (does not drive the device; use callService to act)", [entityId()], {
      tags: ["states"],
      requestBody: JSON_BODY({ type: "object", required: ["state"], properties: { state: { type: "string" }, attributes: { type: "object" } } }),
    }),
  },
  "/api/services": {
    get: op("listServices", "Every service by domain, with fields (use select, e.g. \"*.domain\")", [], { tags: ["services"] }),
  },
  "/api/services/{domain}/{service}": {
    post: op(
      "callService",
      "Call a service to act: light.turn_on, switch.toggle, climate.set_temperature, scene.turn_on, script.turn_on, media_player.media_pause …",
      [
        p("domain", "path", str("Service domain, e.g. light")),
        p("service", "path", str("Service name, e.g. turn_on")),
        p("return_response", "query", bool("Ask for the service's response data (for services that return one)")),
      ],
      {
        tags: ["services"],
        requestBody: JSON_BODY({ type: "object", description: "Service data, e.g. {\"entity_id\":\"light.kitchen\",\"brightness_pct\":40}. See listServices for each service's fields." }, false),
      },
    ),
  },
  "/api/events": {
    get: op("listEvents", "Event types that can be fired, with listener counts", [], { tags: ["events"] }),
  },
  "/api/events/{event_type}": {
    post: op("fireEvent", "Fire an event on the bus", [p("event_type", "path", str("Event type"))], { tags: ["events"], requestBody: JSON_BODY({ type: "object", description: "Event data" }, false) }),
  },
  "/api/history/period/{timestamp}": {
    get: op("getHistory", "State history for entities since a time", [
      p("timestamp", "path", str("Start, ISO8601, e.g. 2026-09-30T00:00:00+00:00")),
      p("filter_entity_id", "query", csv("Entity ids, comma separated (required for a sane answer)")),
      p("end_time", "query", str("End, ISO8601")),
      p("minimal_response", "query", bool("Only last_changed and state")),
      p("no_attributes", "query", bool("Skip attributes")),
      p("significant_changes_only", "query", bool("Only significant changes")),
    ], { tags: ["history"] }),
  },
  "/api/logbook/{timestamp}": {
    get: op("getLogbook", "Logbook entries since a time", [
      p("timestamp", "path", str("Start, ISO8601")),
      p("entity", "query", str("Filter to one entity id")),
      p("end_time", "query", str("End, ISO8601")),
    ], { tags: ["history"] }),
  },
  "/api/error_log": {
    get: op("getErrorLog", "The Home Assistant error log (plain text)", [], { tags: ["core"] }),
  },
  "/api/template": {
    post: op("renderTemplate", "Render a Jinja template against live state (read-only), e.g. {{ states('sensor.x') }}", [], {
      tags: ["core"],
      requestBody: JSON_BODY({ type: "object", required: ["template"], properties: { template: { type: "string" } } }),
    }),
  },
  "/api/config/core/check_config": {
    post: op("checkConfig", "Validate configuration.yaml without applying it", [], { tags: ["core"] }),
  },
  "/api/calendars": {
    get: op("listCalendars", "Calendar entities", [], { tags: ["calendars"] }),
  },
  "/api/calendars/{entity_id}": {
    get: op("getCalendarEvents", "A calendar's events in a window", [
      p("entity_id", "path", str("Calendar entity id, e.g. calendar.family")),
      p("start", "query", str("Window start, ISO8601"), true),
      p("end", "query", str("Window end, ISO8601"), true),
    ], { tags: ["calendars"] }),
  },
});

export const PRESET_SPECS: Record<string, JsonObject> = {
  "open-meteo": openMeteo,
  wikipedia,
  wikidata,
  nominatim,
  "open-library": openLibrary,
  arxiv,
  "hacker-news": hackerNews,
  "usgs-earthquakes": usgs,
  frankfurter,
  coingecko,
  "nasa-apod": nasaApod,
  "home-assistant": homeAssistant,
};
