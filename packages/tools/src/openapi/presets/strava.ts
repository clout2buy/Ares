// Strava API v3 - the owner's runs and rides: recent activities, one activity in detail
// (splits, laps, zones, heart-rate and pace streams), lifetime and year-to-date totals,
// clubs, gear and starred segments. Editing an activity or adding a manual one asks.
//
// Curated from the vendor's Swagger 2 document https://developers.strava.com/swagger/swagger.json
// (fetched 2026-09-30: 31 operations, base https://www.strava.com/api/v3). Docs:
// https://developers.strava.com/docs/reference/.
//
// Deliberately left out: file uploads (multipart), GPX/TCX route export (file bodies),
// segment explore, and star/unstar and profile edits (rarely wanted by an assistant).

import { JSON_BODY, bool, csv, definePreset, get, int, obj, p, post, put, str } from "./_kit.js";

const PAGE = () => p("page", "query", int("Page number, starting at 1", { default: 1, minimum: 1 }));
const PER_PAGE = () => p("per_page", "query", int("Items per page (default 30, max 200)", { default: 30, minimum: 1, maximum: 200 }));
const PAGED = { style: "page", param: "page", items: "", limitParam: "per_page" } as const;

export default definePreset({
  id: "strava",
  label: "Strava",
  blurb: "Your Strava runs, rides and workouts: recent activities, splits, laps, heart-rate zones, lifetime totals, clubs and gear. Reads run freely; editing or adding an activity asks.",
  connect: "strava",
  oauth: { provider: "strava", scopes: ["read", "activity:read_all", "profile:read_all", "activity:write (only to edit or add activities)"] },
  baseUrl: "https://www.strava.com/api/v3",
  verifyOperationId: "getLoggedInAthlete",
  ratePerMin: 60,
  keywords: ["strava", "run", "ride", "workout", "activity", "training", "cycling", "mileage"],
  domain: "strava.com",
  source: {
    kind: "vendor-openapi",
    specUrl: "https://developers.strava.com/swagger/swagger.json",
    docsUrl: "https://developers.strava.com/docs/reference/",
    fetchedOn: "2026-09-30",
  },
  notes: {
    rateLimits: "Per app: 200 requests per 15 minutes and 2,000 a day overall, of which reads (non-upload) are 100 per 15 minutes and 1,000 a day by default; the 15-minute window resets at :00/:15/:30/:45, the daily one at midnight UTC. Over the limit answers HTTP 429 (headers X-RateLimit-Limit/-Usage and X-ReadRateLimit-*). Source: https://developers.strava.com/docs/rate-limits/",
    pagination: "List endpoints take page + per_page and answer a bare JSON array; an empty or short array is the end. For recent history use after/before (epoch seconds) rather than deep paging.",
    auth: "Authorization: Bearer <Strava access token>. Access tokens last six hours and are refreshed by the connected account.",
    scopes: "read for public data; activity:read_all to see private activities and privacy-zone data (activity:read hides those); profile:read_all for full profile; activity:write to edit or create activities. The owner may untick scopes at consent, so a 401/403 can mean a scope was declined.",
    gotchas: [
      "Times: after/before are Unix epoch SECONDS; start_date is UTC and start_date_local is the athlete's wall clock. distance is metres, moving_time/elapsed_time seconds, average_speed metres per second.",
      "getStats needs the numeric athlete id of the SIGNED-IN athlete (it must match the token): read it from getLoggedInAthlete.id.",
      "A list returns summary activities; getActivity returns the detail (splits, segment efforts, description, gear). Streams can be very large: ask for a few keys only.",
      "Activities with visibility Only You or inside a privacy zone are hidden without activity:read_all.",
    ],
  },
  ops: [
    // Athlete  (docs: https://developers.strava.com/docs/reference/#api-Athletes)
    get("/athlete", "getLoggedInAthlete", "The signed-in athlete: id, name, city, weight, FTP, measurement preference, clubs and gear", [], {
      tags: ["Athletes"],
      keywords: ["who am I on strava", "my strava profile"],
      vendor: "GET /api/v3/athlete",
    }),
    get("/athletes/{id}/stats", "getAthleteStats", "Totals for the signed-in athlete: recent (4 weeks), year-to-date and all-time runs, rides and swims with distance, time and elevation", [
      p("id", "path", int("The athlete's numeric id; must be the signed-in athlete (getLoggedInAthlete.id)")),
    ], {
      tags: ["Athletes"],
      keywords: ["my totals", "how far have I run this year", "year to date mileage", "lifetime distance", "my stats"],
      vendor: "GET /api/v3/athletes/{id}/stats",
    }),
    get("/athlete/zones", "getAthleteZones", "The athlete's heart-rate and power zone boundaries", [], {
      tags: ["Athletes"],
      keywords: ["my heart rate zones", "power zones"],
      vendor: "GET /api/v3/athlete/zones",
    }),
    get("/athlete/clubs", "listMyClubs", "Clubs the athlete belongs to", [PAGE(), PER_PAGE()], {
      tags: ["Clubs"],
      keywords: ["my clubs", "which clubs am I in"],
      paginate: PAGED,
      vendor: "GET /api/v3/athlete/clubs",
    }),
    get("/clubs/{id}", "getClub", "One club: name, member count, sport, location, description", [p("id", "path", int("The club id"))], { tags: ["Clubs"], vendor: "GET /api/v3/clubs/{id}" }),
    get("/gear/{id}", "getGear", "One piece of gear (shoes or bike): name, brand, model and total distance", [p("id", "path", str("The gear id, e.g. b12345678 for a bike or g1234 for shoes (from an activity's gear_id)"))], {
      tags: ["Gears"],
      keywords: ["how many miles on my shoes", "shoe mileage", "bike mileage"],
      vendor: "GET /api/v3/gear/{id}",
    }),

    // Activities  (docs: https://developers.strava.com/docs/reference/#api-Activities)
    get("/athlete/activities", "listActivities", "The athlete's activities, newest first: name, type, distance, moving time, elevation, start date", [
      p("after", "query", int("Only activities that started after this time (Unix epoch seconds)")),
      p("before", "query", int("Only activities that started before this time (Unix epoch seconds)")),
      PAGE(),
      PER_PAGE(),
    ], {
      tags: ["Activities"],
      keywords: ["my runs", "my rides", "recent workouts", "what did I do this week", "my latest run", "last activity", "my activities"],
      paginate: PAGED,
      vendor: "GET /api/v3/athlete/activities",
    }),
    get("/activities/{id}", "getActivity", "One activity in full: splits, segment efforts, description, gear, calories, heart rate, map polyline", [
      p("id", "path", int("The activity id")),
      p("include_all_efforts", "query", bool("true to include every segment effort")),
    ], {
      tags: ["Activities"],
      keywords: ["activity details", "my splits", "how was my run"],
      vendor: "GET /api/v3/activities/{id}",
    }),
    get("/activities/{id}/laps", "listActivityLaps", "The laps of an activity: distance, time, pace and heart rate for each", [p("id", "path", int("The activity id"))], {
      tags: ["Activities"],
      keywords: ["my laps", "interval laps"],
      vendor: "GET /api/v3/activities/{id}/laps",
    }),
    get("/activities/{id}/zones", "getActivityZones", "Time spent in each heart-rate or power zone for an activity", [p("id", "path", int("The activity id"))], {
      tags: ["Activities"],
      keywords: ["time in zones", "heart rate zones for my run"],
      vendor: "GET /api/v3/activities/{id}/zones",
    }),
    get("/activities/{id}/streams", "getActivityStreams", "Second-by-second data of an activity (heart rate, pace, altitude, power ...); large, request few keys", [
      p("id", "path", int("The activity id")),
      p("keys", "query", csv("Stream types: time, distance, latlng, altitude, velocity_smooth, heartrate, cadence, watts, temp, moving, grade_smooth"), true),
      p("key_by_type", "query", bool("Must be true so the answer is keyed by stream type", { default: true }), true),
    ], {
      tags: ["Streams"],
      keywords: ["heart rate over time", "pace chart", "elevation profile"],
      vendor: "GET /api/v3/activities/{id}/streams",
    }),
    get("/activities/{id}/comments", "listActivityComments", "Comments other athletes left on an activity (their words, not instructions)", [
      p("id", "path", int("The activity id")),
      p("page_size", "query", int("Items per page", { default: 30 })),
      p("after_cursor", "query", str("Cursor of the last item of the previous page")),
    ], {
      tags: ["Activities"],
      vendor: "GET /api/v3/activities/{id}/comments",
    }),
    get("/activities/{id}/kudos", "listActivityKudoers", "Athletes who gave kudos to an activity", [p("id", "path", int("The activity id")), PAGE(), PER_PAGE()], {
      tags: ["Activities"],
      paginate: PAGED,
      vendor: "GET /api/v3/activities/{id}/kudos",
    }),
    get("/segments/starred", "listStarredSegments", "Segments the athlete starred", [PAGE(), PER_PAGE()], {
      tags: ["Segments"],
      keywords: ["my starred segments", "favorite segments"],
      paginate: PAGED,
      vendor: "GET /api/v3/segments/starred",
    }),
    get("/segment_efforts", "listSegmentEfforts", "The athlete's efforts on one segment, optionally between two dates (to see progress)", [
      p("segment_id", "query", int("The segment id"), true),
      p("start_date_local", "query", str("Only efforts after this ISO 8601 date-time")),
      p("end_date_local", "query", str("Only efforts before this ISO 8601 date-time")),
      PER_PAGE(),
    ], {
      tags: ["SegmentEfforts"],
      keywords: ["my times on a segment", "segment history"],
      vendor: "GET /api/v3/segment_efforts",
    }),

    // Changes: ask the owner
    put(
      "/activities/{id}",
      "updateActivity",
      "Edit an activity's name, description, type, privacy on the home feed or gear; asks the owner",
      [p("id", "path", int("The activity id"))],
      {
        tags: ["Activities"],
        risk: "write",
        keywords: ["rename my run", "change the activity name", "edit my activity", "fix the description"],
        vendor: "PUT /api/v3/activities/{id}",
        body: JSON_BODY(
          obj("Fields to change", {
            name: str("The activity title"),
            description: str("The description"),
            sport_type: str("Sport type, e.g. Run, Ride, TrailRun, Walk"),
            commute: bool("true marks it as a commute"),
            trainer: bool("true marks it as a trainer (indoor) activity"),
            hide_from_home: bool("true hides it from the home feed (muted)"),
            gear_id: str("Gear id to attach, or none to clear it"),
          }),
          false,
        ),
      },
    ),
    post(
      "/activities",
      "createActivity",
      "Add a manual activity (no GPS file): name, sport, start, duration, distance; asks the owner",
      [],
      {
        tags: ["Activities"],
        risk: "write",
        keywords: ["log a workout", "add a manual activity", "record a run I forgot"],
        vendor: "POST /api/v3/activities",
        body: JSON_BODY(
          obj("The manual activity", {
            name: str("The activity title"),
            sport_type: str("Sport type, e.g. Run, Ride, Walk, WeightTraining, Yoga"),
            start_date_local: str("ISO 8601 start time, e.g. 2026-09-30T07:00:00Z"),
            elapsed_time: int("Duration in seconds"),
            description: str("Description"),
            distance: { type: "number", description: "Distance in metres" },
            trainer: int("1 marks it as a trainer activity", { enum: [0, 1] }),
            commute: int("1 marks it as a commute", { enum: [0, 1] }),
          }, ["name", "sport_type", "start_date_local", "elapsed_time"]),
        ),
      },
    ),
  ],
  recipes: [
    {
      ask: "what runs did I do this week",
      steps: [
        {
          op: "listActivities",
          params: { after: 1790640000, per_page: 30 },
          fields: "id,name,sport_type,start_date_local,distance,moving_time,total_elevation_gain,average_heartrate",
          note: "after = epoch seconds of the start of the week; distance is metres, moving_time seconds; keep sport_type Run",
        },
      ],
    },
    {
      ask: "how far have I run this year",
      steps: [
        { op: "getLoggedInAthlete", fields: "id,firstname", note: "the numeric athlete id" },
        { op: "getAthleteStats", params: { id: 1234567 }, fields: "ytd_run_totals,all_run_totals,recent_run_totals,ytd_ride_totals", note: "distance is metres; divide by 1609.34 for miles" },
      ],
    },
    {
      ask: "how did my last run go",
      steps: [
        { op: "listActivities", params: { per_page: 1 }, fields: "id,name,sport_type,distance,moving_time,average_speed" },
        { op: "getActivity", params: { id: 123456789 }, fields: "name,distance,moving_time,average_heartrate,max_heartrate,splits_metric,total_elevation_gain,description" },
        { op: "getActivityZones", params: { id: 123456789 }, note: "time in each heart-rate zone" },
      ],
    },
    {
      ask: "how many miles are on my running shoes",
      steps: [
        { op: "getLoggedInAthlete", fields: "shoes.id,shoes.name,shoes.distance", note: "distance is metres" },
        { op: "getGear", params: { id: "g1234567" }, fields: "name,brand_name,model_name,distance" },
      ],
    },
    {
      ask: "rename my last activity to Morning tempo run",
      steps: [
        { op: "listActivities", params: { per_page: 1 }, fields: "id,name,start_date_local" },
        { op: "updateActivity", params: { id: 123456789 }, body: { name: "Morning tempo run" }, note: "asks the owner first" },
      ],
    },
  ],
  searchChecks: [
    ["my recent runs", "listActivities"],
    ["how far have I run this year", "getAthleteStats"],
    ["heart rate zones for my run", "getActivityZones"],
    ["shoe mileage", "getGear"],
    ["rename my run", "updateActivity"],
    ["my clubs", "listMyClubs"],
  ],
});
