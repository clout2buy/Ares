// The one HTTP helper the "life" connector tools share (Hue, Tesla, Tickets,
// FlightStatus, FlightBooking, Withings, Tailscale, Bank). Each of those is a
// thin JSON API behind a key from the vault; what they have in common is how a
// failure should read to the model: the service's own message, the status, and
// never an HTML error page or a stack.

import type { ToolResult } from "./_shared.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Pull a human sentence out of whatever error body a service returns. */
function errorText(json: unknown, fallback: string): string {
  if (!json || typeof json !== "object") return fallback;
  const record = json as Record<string, unknown>;
  const candidates: unknown[] = [
    record.message,
    record.error_description,
    record.error,
    record.detail,
    record.title,
    (record.fault as Record<string, unknown> | undefined)?.faultstring,
    Array.isArray(record.errors) ? (record.errors[0] as Record<string, unknown> | undefined)?.message ?? (record.errors[0] as Record<string, unknown> | undefined)?.title : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 300);
    if (candidate && typeof candidate === "object" && typeof (candidate as Record<string, unknown>).message === "string") {
      return String((candidate as Record<string, unknown>).message).slice(0, 300);
    }
  }
  return fallback;
}

export async function apiJson(
  label: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init.body !== undefined && typeof init.body !== "string" ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const text = await res.text().catch(() => "");
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) throw new ApiError(`${label}: ${errorText(json, `HTTP ${res.status}`)} (HTTP ${res.status})`, res.status);
  return Array.isArray(json) ? { items: json } : ((json ?? {}) as Record<string, unknown>);
}

export function failResult<O extends { message: string }>(message: string, extra?: Omit<O, "message">): ToolResult<O> {
  return { output: { ...(extra ?? {}), message } as O, display: message.slice(0, 200), failure: message };
}

export function okResult<O extends { message: string }>(output: O, display?: string): ToolResult<O> {
  return { output, display: (display ?? output.message).slice(0, 200) };
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : typeof value === "number" ? String(value) : undefined;
}
