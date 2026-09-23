// Home, car, travel, health and money — the "life" connectors.
//
// Parity with the consumer assistants (Meta's Muse connectors): lights, the
// car, tickets, flights, the scale, the tailnet and the bank. Each is one
// registry entry the connect hub already knows how to turn into a card; the
// deferred tool named in `howToUse` does the work once it's connected.
//
// Two of these store something OTHER than what the owner typed, which is why
// ConnectService grew `stores`:
//   hue        zero fields — the hub's verifier finds the bridge on the LAN and
//              pairs with it while the owner holds the link button; what gets
//              stored is the bridge address and the username it issued
//   simplefin  the owner pastes a one-time Setup Token; the verifier claims it
//              and stores only the resulting Access URL (the token is spent)

import type { ConnectService } from "./connectServices.js";
import { PLAID_SERVICE } from "./plaidService.js";

export const LIFE_SERVICES: ConnectService[] = [
  {
    id: "hue",
    label: "Philips Hue",
    kind: "api-key",
    domain: "philips-hue.com",
    blurb: "Lights, rooms and scenes on your Hue bridge.",
    keywords: ["hue", "philips hue", "hue lights", "smart lights", "turn on the lights", "turn off the lights", "dim the lights", "light scene"],
    keyUrl: "https://www.philips-hue.com/",
    fields: [],
    stores: ["HUE_BRIDGE_IP", "HUE_USERNAME"],
    formHint: "Press the round button on top of your Hue bridge, then tap Connect within 30 seconds. Ares finds the bridge on your home network by itself.",
    howToUse: "Use the Hue tool: lights / rooms / scenes to see what exists, then set (on, brightness 0-100, color as #hex) on a light or room, or scene to activate one.",
  },
  {
    id: "tessie",
    label: "Tesla (via Tessie)",
    kind: "api-key",
    domain: "tessie.com",
    blurb: "Your Tesla: state, location, climate, charging, locks.",
    keywords: ["tessie", "tesla", "my tesla", "precondition the car", "charge my car", "unlock my car", "lock my car"],
    keyUrl: "https://my.tessie.com/settings/api",
    fields: [{ credential: "TESSIE_API_TOKEN", label: "API access token", secret: true, help: "Tessie → Settings → API → Generate access token." }],
    howToUse: "Use the Tesla tool: vehicles, state, location, climate_on/off, charge_start/stop, charge_limit. lock is free; unlock, remote_start, trunk, frunk, honk and flash ask the owner first.",
  },
  {
    id: "ticketmaster",
    label: "Ticketmaster",
    kind: "api-key",
    domain: "ticketmaster.com",
    blurb: "Find concerts, sports and shows near you, with ticket links.",
    keywords: ["ticketmaster", "concert tickets", "event tickets", "concerts near me", "shows near me", "live events"],
    keyUrl: "https://developer.ticketmaster.com/",
    fields: [{ credential: "TICKETMASTER_API_KEY", label: "Consumer Key", secret: true, help: "developer.ticketmaster.com → My Apps → your app's Consumer Key (free)." }],
    howToUse: "Use the Tickets tool: search (keyword, city, dates) and event (details + ticket URL). The API cannot buy tickets — to buy, open the ticket URL with the Browser and confirm the total with the owner before checkout.",
  },
  {
    id: "flightaware",
    label: "FlightAware AeroAPI",
    kind: "api-key",
    domain: "flightaware.com",
    blurb: "Live flight status and airport arrivals/departures. Metered: FlightAware bills per query.",
    keywords: ["flightaware", "aeroapi", "flight status", "flight tracker", "track a flight", "is my flight on time", "airport arrivals", "airport departures"],
    keyUrl: "https://www.flightaware.com/aeroapi/portal/",
    fields: [{ credential: "FLIGHTAWARE_API_KEY", label: "AeroAPI key", secret: true, help: "AeroAPI portal → API keys. Queries are billed to your FlightAware account." }],
    howToUse: "Use the FlightStatus tool: flight (by ident like UA123), arrivals or departures (by airport code). Each call is a billed AeroAPI query — don't poll.",
  },
  {
    id: "duffel",
    label: "Duffel (flight booking)",
    kind: "api-key",
    domain: "duffel.com",
    blurb: "Search real airline offers and book flights. Use a test token (duffel_test_…) to try it free.",
    keywords: ["duffel", "book a flight", "flight booking", "flight prices", "airfare", "plane tickets", "cheap flights"],
    keyUrl: "https://app.duffel.com/",
    fields: [{ credential: "DUFFEL_ACCESS_TOKEN", label: "Access token", placeholder: "duffel_test_… or duffel_live_…", secret: true, help: "Duffel dashboard → Developers → Access tokens. A test token books simulated flights only." }],
    howToUse: "Use the FlightBooking tool: search (slices, passengers, cabin), offer (re-price one), book (asks the owner with the exact price — live tokens charge your Duffel balance). The tool says whether the token is test or live.",
  },
  {
    id: "withings",
    label: "Withings",
    kind: "oauth-app",
    oauthProvider: "withings",
    domain: "withings.com",
    blurb: "Weight, body composition, activity and sleep from your Withings devices.",
    keywords: ["withings", "smart scale", "my weight", "my sleep", "sleep score", "health data", "body composition"],
    howToUse: "Use the Withings tool: measurements (weight, fat %, blood pressure, heart rate), activity (steps, calories per day), sleep (nightly summary).",
    appSetup: {
      consoleUrl: "https://developer.withings.com/dashboard/",
      steps: [
        "Open the Withings Partner Hub (developer.withings.com) and sign in with your Withings account.",
        "Create an application for the Public API (Public Cloud) — any name, e.g. Ares.",
        "Set the Callback URL to the redirect URI shown below (it must match exactly).",
        "Copy the app's Client ID and Secret into the form below.",
      ],
    },
  },
  {
    id: "tailscale",
    label: "Tailscale",
    kind: "api-key",
    domain: "tailscale.com",
    blurb: "See and manage the devices on your tailnet.",
    keywords: ["tailscale", "tailnet", "my tailnet devices"],
    keyUrl: "https://login.tailscale.com/admin/settings/keys",
    fields: [{ credential: "TAILSCALE_API_KEY", label: "API access token", placeholder: "tskey-api-…", secret: true, help: "Admin console → Settings → Keys → Generate access token. It expires after at most 90 days." }],
    howToUse: "Use the Tailscale tool: devices, device (details). authorize, deauthorize, expire and key_expiry change who is on the owner's network and ask first.",
  },
  // Plaid BEFORE simplefin: "connect my bank" means the one-tap Plaid card;
  // SimpleFIN stays the alternative for owners who already use it.
  PLAID_SERVICE,
  {
    id: "simplefin",
    label: "Bank accounts (SimpleFIN)",
    kind: "api-key",
    domain: "simplefin.org",
    blurb: "Read-only balances and transactions from your banks through SimpleFIN Bridge (a small yearly fee, paid to SimpleFIN). The alternative to Plaid for owners who already use SimpleFIN.",
    keywords: ["simplefin", "bank", "bank account", "bank balance", "my balance", "my transactions", "checking account", "savings account", "credit card balance"],
    keyUrl: "https://beta-bridge.simplefin.org/",
    fields: [{ credential: "SIMPLEFIN_SETUP_TOKEN", label: "Setup Token", secret: true, help: "SimpleFIN Bridge → connect your banks → New app connection → copy the Setup Token. It works once; Ares trades it for read-only access." }],
    stores: ["SIMPLEFIN_ACCESS_URL"],
    howToUse: "Use the Bank tool: accounts (balances), transactions, spending_summary, recurring (subscriptions/bills) and new_charges. Read-only — it cannot move money.",
  },
  {
    id: "peloton",
    label: "Peloton",
    kind: "browser",
    domain: "onepeloton.com",
    blurb: "Workouts and classes (no public API — Ares uses the website).",
    keywords: ["peloton", "onepeloton"],
    loginUrl: "https://members.onepeloton.com/login",
    howToUse: "You are signed in to Peloton in Ares's browser. Peloton has no public API: use the Browser tool on members.onepeloton.com to read workouts or stack classes. Anything that buys (subscriptions, gear) needs the owner's OK first.",
  },
];
