import { z } from "zod";
import { getValidAccessToken, OAUTH_PROVIDERS } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";

const GCAL = "https://www.googleapis.com/calendar/v3";

const inputSchema = z.object({
  action: z.enum(["list_events", "create_event", "delete_event", "list_calendars"]).describe(
    "list_events: upcoming events (default: next 7 days). " +
    "create_event: add an event with title, start, end. " +
    "delete_event: remove an event by id. " +
    "list_calendars: show all calendars.",
  ),
  calendar_id: z.string().optional().describe("Calendar id (default: primary)."),
  event_id: z.string().optional().describe("Event id — required for delete_event."),
  title: z.string().optional().describe("Event title — required for create_event."),
  description: z.string().optional().describe("Event description."),
  location: z.string().optional().describe("Event location."),
  start: z.string().optional().describe("ISO-8601 datetime or YYYY-MM-DD for all-day. Required for create_event."),
  end: z.string().optional().describe("ISO-8601 datetime or YYYY-MM-DD. Defaults to start + 1h."),
  days: z.number().optional().describe("Number of days ahead to list (default 7)."),
});

type Input = z.infer<typeof inputSchema>;

export interface GoogleCalendarOutput {
  events?: Array<{ id: string; title: string; start: string; end: string; location?: string }>;
  calendars?: Array<{ id: string; summary: string; primary?: boolean }>;
  created?: { id: string; link?: string };
  deleted?: boolean;
  message: string;
}

async function gcalFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getValidAccessToken(OAUTH_PROVIDERS.google);
  const res = await fetch(`${GCAL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Google Calendar API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res;
}

export const GoogleCalendarTool = buildTool<typeof inputSchema, GoogleCalendarOutput>({
  name: "GoogleCalendar",
  description:
    "Manage Google Calendar — list upcoming events, create events, delete events, list calendars. " +
    "Requires Google to be connected via the Connect tool first.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (input) => {
    switch (input.action) {
      case "list_events": return "Checking calendar";
      case "create_event": return `Creating event: ${input.title ?? ""}`;
      case "delete_event": return "Deleting event";
      case "list_calendars": return "Listing calendars";
      default: return "Google Calendar";
    }
  },
  async call(input: Input): Promise<ToolResult<GoogleCalendarOutput>> {
    switch (input.action) {
      case "list_calendars": {
        const res = await gcalFetch("/users/me/calendarList");
        const data = await res.json() as { items?: Array<{ id: string; summary: string; primary?: boolean }> };
        const calendars = (data.items ?? []).map((c) => ({ id: c.id, summary: c.summary, primary: c.primary }));
        return { output: { calendars, message: calendars.map((c) => `${c.primary ? "★" : "·"} ${c.summary} (${c.id})`).join("\n") }, display: `${calendars.length} calendars` };
      }

      case "list_events": {
        const cal = encodeURIComponent(input.calendar_id ?? "primary");
        const now = new Date();
        const end = new Date(now.getTime() + (input.days ?? 7) * 86400000);
        const params = new URLSearchParams({
          timeMin: now.toISOString(),
          timeMax: end.toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "25",
        });
        const res = await gcalFetch(`/calendars/${cal}/events?${params}`);
        const data = await res.json() as { items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string }> };
        const events = (data.items ?? []).map((e) => ({
          id: e.id,
          title: e.summary ?? "(no title)",
          start: e.start?.dateTime ?? e.start?.date ?? "",
          end: e.end?.dateTime ?? e.end?.date ?? "",
          location: e.location,
        }));
        if (events.length === 0) return { output: { events: [], message: "No upcoming events." }, display: "No upcoming events." };
        const lines = events.map((e) => {
          const d = new Date(e.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
          const t = e.start.includes("T") ? new Date(e.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "all day";
          return `${d} ${t} — ${e.title}${e.location ? ` @ ${e.location}` : ""}`;
        });
        return { output: { events, message: lines.join("\n") }, display: lines.join("\n") };
      }

      case "create_event": {
        if (!input.title || !input.start) return { output: { message: "title and start are required." }, display: "Missing title or start." };
        const cal = encodeURIComponent(input.calendar_id ?? "primary");
        const isAllDay = !input.start.includes("T");
        const startObj = isAllDay ? { date: input.start } : { dateTime: input.start };
        const endInput = input.end ?? (isAllDay ? input.start : new Date(new Date(input.start).getTime() + 3600000).toISOString());
        const endObj = isAllDay ? { date: endInput } : { dateTime: endInput };
        const body = { summary: input.title, description: input.description, location: input.location, start: startObj, end: endObj };
        const res = await gcalFetch(`/calendars/${cal}/events`, { method: "POST", body: JSON.stringify(body) });
        const created = await res.json() as { id: string; htmlLink?: string };
        return { output: { created: { id: created.id, link: created.htmlLink }, message: `Event created: ${input.title}` }, display: `Created: ${input.title}` };
      }

      case "delete_event": {
        if (!input.event_id) return { output: { message: "event_id is required." }, display: "Missing event_id." };
        const cal = encodeURIComponent(input.calendar_id ?? "primary");
        await gcalFetch(`/calendars/${cal}/events/${encodeURIComponent(input.event_id)}`, { method: "DELETE" });
        return { output: { deleted: true, message: `Deleted event ${input.event_id}.` }, display: "Event deleted." };
      }

      default:
        return { output: { message: "Unknown action." }, display: "Unknown action." };
    }
  },
});
