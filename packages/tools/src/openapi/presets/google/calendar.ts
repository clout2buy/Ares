// Google Calendar API v3 operations of the Google preset. Curated from the discovery
// document https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest (fetched
// 2026-09-30). Host https://www.googleapis.com (the preset's base), paths /calendar/v3/...
//
// Left out on purpose: ACL (sharing a calendar), calendar create/update/delete/clear,
// ownership transfer, push watch channels, import.

import { JSON_BODY, arrOf, bool, del, get, int, multi, obj, p, patch, post, str, type JsonObject, type OpRow } from "../_kit.js";
import { fields, pageToken } from "./_common.js";

const cal = (): JsonObject =>
  p("calendarId", "path", str("Calendar id: primary for the owner's main calendar, or an id/email from calendarListCalendars", { default: "primary" }));

const sendUpdates = (what: string): JsonObject =>
  p("sendUpdates", "query", str(`Whether guests are emailed about ${what}: all, externalOnly or none (default none for the API; pass none to stay quiet)`, { enum: ["all", "externalOnly", "none"] }));

const TIME = obj("A moment: dateTime (RFC 3339, e.g. 2026-10-02T15:00:00-04:00) with an optional timeZone, OR date (YYYY-MM-DD) for an all-day event", {
  dateTime: str("RFC 3339 timestamp with offset"),
  date: str("YYYY-MM-DD, for all-day events"),
  timeZone: str("IANA zone, e.g. America/New_York"),
});

const EVENT_FIELDS: Record<string, JsonObject> = {
  summary: str("Title"),
  description: str("Notes"),
  location: str("Where"),
  start: TIME,
  end: TIME,
  attendees: arrOf("Guests; they are emailed an invitation unless sendUpdates=none", obj("A guest", { email: str("Email address"), optional: bool("Optional attendee") })),
  recurrence: arrOf("RRULE lines, e.g. RRULE:FREQ=WEEKLY;BYDAY=MO", { type: "string" }),
  reminders: obj("{useDefault: true} or {useDefault:false, overrides:[{method:popup|email, minutes:N}]}"),
  colorId: str("Event color id 1-11"),
  visibility: str("default, public, private or confidential", { enum: ["default", "public", "private", "confidential"] }),
  transparency: str("opaque (busy) or transparent (free)", { enum: ["opaque", "transparent"] }),
  status: str("confirmed, tentative or cancelled", { enum: ["confirmed", "tentative", "cancelled"] }),
  conferenceData: obj("Pass {createRequest:{requestId:'unique',conferenceSolutionKey:{type:'hangoutsMeet'}}} together with conferenceDataVersion=1 to add a Meet link"),
};

export const calendarOps: OpRow[] = [
  get(
    "/calendar/v3/users/me/calendarList",
    "calendarListCalendars",
    "The calendars the owner can see: id, name, access role, time zone, primary flag",
    [
      p("minAccessRole", "query", str("Only calendars where the owner has at least this role", { enum: ["freeBusyReader", "reader", "writer", "owner"] })),
      p("showHidden", "query", bool("Include hidden calendars")),
      p("maxResults", "query", int("How many (default 100, max 250)")),
      pageToken(),
      fields("items(id,summary,primary,accessRole,timeZone),nextPageToken"),
    ],
    {
      tags: ["calendar"],
      keywords: ["my calendars", "which calendars do I have"],
      paginate: { style: "token", param: "pageToken", next: "nextPageToken", items: "items", limitParam: "maxResults" },
      vendor: "GET /calendar/v3/users/me/calendarList",
    },
  ),
  get(
    "/calendar/v3/calendars/{calendarId}/events",
    "calendarListEvents",
    "Events in a time window, with singleEvents=true and orderBy=startTime giving a clean chronological agenda (recurring events expanded)",
    [
      cal(),
      p("timeMin", "query", str("Only events ending after this RFC 3339 time with offset, e.g. 2026-10-01T00:00:00-04:00")),
      p("timeMax", "query", str("Only events starting before this RFC 3339 time with offset")),
      p("singleEvents", "query", bool("true expands recurring events into individual occurrences (needed for orderBy=startTime)")),
      p("orderBy", "query", str("startTime (needs singleEvents=true) or updated", { enum: ["startTime", "updated"] })),
      p("q", "query", str("Free-text search in title, description, location and attendees")),
      p("eventTypes", "query", multi("Only these kinds: default, birthday, focusTime, outOfOffice, workingLocation, fromGmail")),
      p("showDeleted", "query", bool("Include cancelled events")),
      p("updatedMin", "query", str("Only events changed after this RFC 3339 time")),
      p("timeZone", "query", str("IANA zone for the times in the answer (default: the calendar's)")),
      p("maxResults", "query", int("How many (default 250, max 2500)")),
      pageToken(),
      fields("items(id,summary,start,end,location,attendees(email,responseStatus),htmlLink),nextPageToken"),
    ],
    {
      tags: ["calendar", "events"],
      keywords: ["what's on my calendar", "my schedule today", "my agenda", "upcoming meetings", "am I free", "events this week", "what do I have tomorrow"],
      paginate: { style: "token", param: "pageToken", next: "nextPageToken", items: "items", limitParam: "maxResults" },
      vendor: "GET /calendar/v3/calendars/{calendarId}/events",
    },
  ),
  get(
    "/calendar/v3/calendars/{calendarId}/events/{eventId}",
    "calendarGetEvent",
    "One event in full: attendees and their replies, conference link, recurrence, description",
    [cal(), p("eventId", "path", str("Event id from calendarListEvents")), p("timeZone", "query", str("IANA zone for the times in the answer")), fields("summary,start,end,attendees,hangoutLink,description")],
    { tags: ["calendar", "events"], keywords: ["event details", "who is invited"], vendor: "GET /calendar/v3/calendars/{calendarId}/events/{eventId}" },
  ),
  get(
    "/calendar/v3/calendars/{calendarId}/events/{eventId}/instances",
    "calendarListEventInstances",
    "The occurrences of one recurring event inside a time window",
    [
      cal(),
      p("eventId", "path", str("The recurring event's id")),
      p("timeMin", "query", str("Occurrences ending after this RFC 3339 time")),
      p("timeMax", "query", str("Occurrences starting before this RFC 3339 time")),
      p("maxResults", "query", int("How many (default 250)")),
      pageToken(),
    ],
    {
      tags: ["calendar", "events"],
      keywords: ["next occurrences", "recurring event dates"],
      paginate: { style: "token", param: "pageToken", next: "nextPageToken", items: "items", limitParam: "maxResults" },
      vendor: "GET /calendar/v3/calendars/{calendarId}/events/{eventId}/instances",
    },
  ),
  post(
    "/calendar/v3/freeBusy",
    "queryCalendarFreeBusy",
    "When are these calendars busy between two times? Returns busy blocks per calendar (a read, nothing is changed)",
    [],
    {
      tags: ["calendar", "availability"],
      risk: "read",
      keywords: ["am I free", "when is she free", "find a time", "availability", "free busy"],
      vendor: "POST /calendar/v3/freeBusy",
      body: JSON_BODY(
        obj(
          "The window and calendars",
          { timeMin: str("Window start, RFC 3339 with offset"), timeMax: str("Window end, RFC 3339 with offset"), timeZone: str("IANA zone for the answer"), items: arrOf("Calendars to check", obj("One calendar", { id: str("primary or a calendar id/email") })) },
          ["timeMin", "timeMax", "items"],
        ),
      ),
    },
  ),

  // ── changes ──
  post(
    "/calendar/v3/calendars/{calendarId}/events",
    "calendarCreateEvent",
    "Create an event; guests in `attendees` are emailed an invitation unless sendUpdates=none; asks the owner",
    [cal(), sendUpdates("the new event"), p("conferenceDataVersion", "query", int("1 to let conferenceData add a Google Meet link", { enum: [0, 1] }))],
    {
      tags: ["calendar", "events"],
      risk: "write",
      keywords: ["schedule a meeting", "add to my calendar", "create an event", "book a meeting", "put it on my calendar"],
      vendor: "POST /calendar/v3/calendars/{calendarId}/events",
      body: JSON_BODY(obj("The event: summary, start and end are the usual minimum", EVENT_FIELDS, ["start", "end"])),
    },
  ),
  post(
    "/calendar/v3/calendars/{calendarId}/events/quickAdd",
    "calendarQuickAddEvent",
    "Create an event from one plain sentence ('Lunch with Sam Friday 1pm'); asks the owner",
    [cal(), p("text", "query", str("The sentence describing the event")), sendUpdates("the new event")],
    {
      tags: ["calendar", "events"],
      risk: "write",
      keywords: ["quick add event", "remind me on my calendar"],
      vendor: "POST /calendar/v3/calendars/{calendarId}/events/quickAdd",
    },
  ),
  patch(
    "/calendar/v3/calendars/{calendarId}/events/{eventId}",
    "calendarUpdateEvent",
    "Change fields of an event (only the fields in the body change); guests are emailed unless sendUpdates=none; asks the owner",
    [cal(), p("eventId", "path", str("Event id")), sendUpdates("the change"), p("conferenceDataVersion", "query", int("1 to let conferenceData add a Meet link", { enum: [0, 1] }))],
    {
      tags: ["calendar", "events"],
      risk: "write",
      keywords: ["reschedule a meeting", "move my meeting", "change the event", "rename the event"],
      vendor: "PATCH /calendar/v3/calendars/{calendarId}/events/{eventId}",
      body: JSON_BODY(obj("The fields to change", EVENT_FIELDS)),
    },
  ),
  post(
    "/calendar/v3/calendars/{calendarId}/events/{eventId}/move",
    "calendarMoveEvent",
    "Move an event to another calendar; asks the owner",
    [cal(), p("eventId", "path", str("Event id")), p("destination", "query", str("The id of the calendar to move it to", {}), true), sendUpdates("the move")],
    { tags: ["calendar", "events"], risk: "write", vendor: "POST /calendar/v3/calendars/{calendarId}/events/{eventId}/move" },
  ),
  del(
    "/calendar/v3/calendars/{calendarId}/events/{eventId}",
    "calendarDeleteEvent",
    "Delete an event (guests are told unless sendUpdates=none); the owner decides",
    [cal(), p("eventId", "path", str("Event id")), sendUpdates("the cancellation")],
    { tags: ["calendar", "events"], keywords: ["cancel the meeting", "delete the event", "remove from calendar"], vendor: "DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}" },
  ),
];
