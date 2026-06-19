// Weather — free lookup via wttr.in (no API key, no signup).
//
// Returns current conditions + a short forecast. Used proactively in check-ins
// ("it's gonna be 95°F today, stay hydrated") and on-demand when the owner asks.

import { z } from "zod";
import { buildTool } from "./_shared.js";

const inputSchema = z
  .object({
    location: z.string().min(1).describe("City name, ZIP code, or coordinates (e.g. 'Houston', '77001', '29.76,-95.36')."),
    units: z.enum(["f", "c"]).default("f").describe("Temperature unit: 'f' for Fahrenheit, 'c' for Celsius."),
  })
  .strict();

export interface WeatherCondition {
  temp: string;
  feelsLike: string;
  description: string;
  humidity: string;
  wind: string;
}

export interface WeatherForecast {
  date: string;
  high: string;
  low: string;
  description: string;
}

export interface WeatherOutput {
  location: string;
  current: WeatherCondition;
  forecast: WeatherForecast[];
  raw?: string;
}

const WTTR_TIMEOUT_MS = 8_000;

async function fetchWeather(location: string, useFahrenheit: boolean): Promise<WeatherOutput> {
  const unitFlag = useFahrenheit ? "u" : "m";
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1&${unitFlag}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(WTTR_TIMEOUT_MS),
    headers: { "user-agent": "Ares/0.3", accept: "application/json" },
  });
  if (!res.ok) throw new Error(`wttr.in returned ${res.status}`);
  const data = (await res.json()) as WttrResponse;

  const cc = data.current_condition?.[0];
  const unit = useFahrenheit ? "°F" : "°C";
  const current: WeatherCondition = {
    temp: `${cc?.temp_F ?? cc?.temp_C ?? "?"}${unit}`,
    feelsLike: `${useFahrenheit ? cc?.FeelsLikeF : cc?.FeelsLikeC ?? "?"}${unit}`,
    description: cc?.weatherDesc?.[0]?.value ?? "Unknown",
    humidity: `${cc?.humidity ?? "?"}%`,
    wind: `${cc?.windspeedMiles ?? cc?.windspeedKmph ?? "?"}${useFahrenheit ? " mph" : " km/h"} ${cc?.winddir16Point ?? ""}`.trim(),
  };

  const forecast: WeatherForecast[] = (data.weather ?? []).slice(0, 3).map((w) => ({
    date: w.date ?? "?",
    high: `${useFahrenheit ? w.maxtempF : w.maxtempC ?? "?"}${unit}`,
    low: `${useFahrenheit ? w.mintempF : w.mintempC ?? "?"}${unit}`,
    description: w.hourly?.[4]?.weatherDesc?.[0]?.value ?? "—",
  }));

  const loc = data.nearest_area?.[0];
  const resolvedLocation = loc
    ? [loc.areaName?.[0]?.value, loc.region?.[0]?.value, loc.country?.[0]?.value].filter(Boolean).join(", ")
    : location;

  return { location: resolvedLocation, current, forecast };
}

function formatWeather(w: WeatherOutput): string {
  const lines = [
    `📍 ${w.location}`,
    `Now: ${w.current.temp} (feels ${w.current.feelsLike}), ${w.current.description}`,
    `Humidity: ${w.current.humidity} · Wind: ${w.current.wind}`,
  ];
  if (w.forecast.length > 0) {
    lines.push("");
    for (const f of w.forecast) {
      lines.push(`${f.date}: ${f.high}/${f.low} — ${f.description}`);
    }
  }
  return lines.join("\n");
}

export const WeatherTool = buildTool({
  name: "Weather",
  description:
    "Look up current weather and a 3-day forecast for any location. Free, no API key needed. Use proactively in check-ins or when the owner asks about weather.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) => `Checking weather for ${i.location}`,

  async call(i): Promise<{ output: WeatherOutput; display: string }> {
    const weather = await fetchWeather(i.location, i.units === "f");
    return { output: weather, display: formatWeather(weather) };
  },
});

/** Standalone fetch for use in scheduled check-ins (no tool context needed). */
export async function getWeatherText(location: string, fahrenheit = true): Promise<string> {
  try {
    const w = await fetchWeather(location, fahrenheit);
    return formatWeather(w);
  } catch (err) {
    return `Weather unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── wttr.in JSON types ──────────────────────────────────────────────────

interface WttrResponse {
  current_condition?: WttrCurrentCondition[];
  weather?: WttrWeatherDay[];
  nearest_area?: WttrArea[];
}

interface WttrCurrentCondition {
  temp_F?: string;
  temp_C?: string;
  FeelsLikeF?: string;
  FeelsLikeC?: string;
  humidity?: string;
  weatherDesc?: Array<{ value?: string }>;
  windspeedMiles?: string;
  windspeedKmph?: string;
  winddir16Point?: string;
}

interface WttrWeatherDay {
  date?: string;
  maxtempF?: string;
  maxtempC?: string;
  mintempF?: string;
  mintempC?: string;
  hourly?: Array<{ weatherDesc?: Array<{ value?: string }> }>;
}

interface WttrArea {
  areaName?: Array<{ value?: string }>;
  region?: Array<{ value?: string }>;
  country?: Array<{ value?: string }>;
}
