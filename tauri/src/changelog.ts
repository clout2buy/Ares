// The living changelog that powers the "What's New" modal.
//
// One entry per release, NEWEST FIRST. Written for humans, not engineers: every
// highlight is a benefit the user can feel, not a technical note. Keep blurbs to
// a single line. This file is the single source of truth — the modal renders
// straight from it, and the update trigger compares the top entry's `version`
// against the running app version.
//
// Honesty rule: an entry only describes what actually ships in that build. A
// release isn't shipped until the version is bumped and the installer is built,
// so an entry may be written ahead of the features landing — but every line here
// must be true by the time that version reaches a user.

export interface ChangeHighlight {
  /** A single emoji or short glyph shown in the badge. */
  icon: string;
  /** Punchy benefit title (2–4 words). */
  title: string;
  /** One-line, non-technical explanation of why it's good. */
  blurb: string;
  /** Optional pill tag, e.g. "New", "Faster", "Safer". */
  tag?: "New" | "Safer" | "Faster" | "Polished";
}

export interface ChangelogEntry {
  /** Must match the app version (package.json) to fire the update modal. */
  version: string;
  /** Human date, e.g. "June 2026". */
  date: string;
  /** The release's headline name. */
  title: string;
  /** A one-sentence hook shown under the title. */
  tagline: string;
  highlights: ChangeHighlight[];
}

// Newest first. The modal showcases CHANGELOG[0]; older entries are reachable
// from the "earlier updates" strip.
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.13.6",
    date: "July 2026",
    title: "Connect anything — type /mcp",
    tagline: "A Directory of tools & apps. Click, approve in your browser, and Ares can use them.",
    highlights: [
      {
        icon: "🔌",
        title: "The connector Directory",
        tag: "New",
        blurb: "Type /mcp (or Ctrl+K → Connectors) to open a searchable gallery — Notion, Linear, Sentry, GitHub, Vercel, Atlassian, Stripe, Supabase and more. Click one, approve access in your browser, and its tools are instantly live for the agent.",
      },
      {
        icon: "🌐",
        title: "Any MCP server, by URL",
        tag: "New",
        blurb: "Not in the list? Paste any remote MCP server's URL and Ares connects to it generically — it discovers the server's login, registers itself, and does the secure OAuth handshake with no setup on your end.",
      },
      {
        icon: "🔐",
        title: "Tokens stay encrypted",
        tag: "Safer",
        blurb: "Connector access tokens are stored encrypted on your machine and refreshed automatically — never written in plain text, never leaving your device.",
      },
    ],
  },
  {
    version: "0.13.5",
    date: "July 2026",
    title: "Any AI provider, one click",
    tagline: "Google, NVIDIA, Groq, xAI and more — pick it, paste your key, done.",
    highlights: [
      {
        icon: "⚡",
        title: "Click-to-pick provider list",
        tag: "New",
        blurb: "The Custom provider now has a gallery — Google AI Studio, NVIDIA, Groq, xAI, Together, Fireworks, Mistral, and more. Click one and the base URL fills itself, with a link to grab a key. No more hunting for endpoints.",
      },
      {
        icon: "🛠️",
        title: "Discovery that actually works",
        tag: "Faster",
        blurb: "Model discovery now runs through Ares instead of the browser, so providers that used to be 'declined' (NVIDIA, Google, most hosted APIs block browser requests) now list their models and just work.",
      },
    ],
  },
  {
    version: "0.13.4",
    date: "July 2026",
    title: "Report a bug in one click",
    tagline: "Something break? Send the whole chat to the owner so Ares gets fixed.",
    highlights: [
      {
        icon: "🐛",
        title: "Report bug button",
        tag: "New",
        blurb: "In the status bar next to Export: press it, add a note about what went wrong, and Ares uploads the entire session — every message, all generated code, every tool call and result, and any errors — to your Ares account.",
      },
      {
        icon: "🔬",
        title: "So coding failures actually get fixed",
        tag: "New",
        blurb: "The owner sees exactly what happened — the HTML game it built, which tool calls failed and why — and can diagnose and improve Ares from real sessions instead of guesswork.",
      },
    ],
  },
  {
    version: "0.13.3",
    date: "July 2026",
    title: "Ares routes cleanly",
    tagline: "Pick Ares and it just runs your in-house model through credits — never your own keys.",
    highlights: [
      {
        icon: "✅",
        title: "Picking Ares just works",
        tag: "Safer",
        blurb: "The default now resolves to your in-house model on the gateway, so it runs the first time instead of erroring on an unknown id.",
      },
      {
        icon: "🔒",
        title: "Never falls back to local keys",
        tag: "Safer",
        blurb: "If your Ares account can't run a turn (credits, access), Ares tells you to check your account — it no longer silently switches to another provider's API key.",
      },
      {
        icon: "🎯",
        title: "Your models, by name",
        tag: "Polished",
        blurb: "The Ares tab lists exactly what your account was granted, and the footer chip and picker show the real display name — not a raw internal id or borrowed catalog.",
      },
    ],
  },
  {
    version: "0.13.2",
    date: "July 2026",
    title: "Ares leads the way",
    tagline: "One provider to rule them: Ares first in the picker, your granted models one click away.",
    highlights: [
      {
        icon: "🏛️",
        title: "Ares is now a first-class provider",
        tag: "New",
        blurb: "Open the model picker under the input bar and Ares sits on top — it routes through your account credits to whatever models you've been granted. No keys, no setup.",
      },
      {
        icon: "🖱️",
        title: "Click a model, use a model",
        tag: "New",
        blurb: "The models in your Ares Account panel are buttons now: click one and the session switches to it instantly, with your remaining spend shown right on the row.",
      },
      {
        icon: "🧹",
        title: "A cleaner owner hub",
        tag: "Polished",
        blurb: "The website's admin got a total revamp — four clear tabs, grant AND deduct credits, one-click model access chips, and model discovery with auto-pricing as the main flow.",
      },
    ],
  },
  {
    version: "0.13.1",
    date: "July 2026",
    title: "Your Ares account",
    tagline: "Sign in with credits — your models, usage, and limits, one click from the wordmark.",
    highlights: [
      {
        icon: "⚔️",
        title: "Account under the wordmark",
        tag: "New",
        blurb: "Click the ARES wordmark for a clean panel: your credit balance, the models you can use with their spend limits, and today's usage. Pick any model right from there.",
      },
      {
        icon: "🔌",
        title: "Connect once, route through credits",
        tag: "New",
        blurb: "Paste your account token and Ares routes every turn through the gateway on your credits — real cost metered live, no keys to manage.",
      },
      {
        icon: "🛠️",
        title: "Steadier long turns",
        tag: "Safer",
        blurb: "A big file write that streams quietly no longer gets cut short, parallel tool calls all finish cleanly instead of spinning, and connecting is rock-solid.",
      },
    ],
  },
  {
    version: "0.13.0",
    date: "July 2026",
    title: "The war room opens",
    tagline: "The biggest Ares yet: a terminal that burns, a desktop that breathes, and an agent that proves its work.",
    highlights: [
      {
        icon: "🔥",
        title: "A terminal with a soul",
        tag: "New",
        blurb: "The TUI got the full forge treatment — a cinematic fire intro, living flame accents, tool calls that strike like a hammer, and everything clickable: models, themes, settings, no arrow keys needed.",
      },
      {
        icon: "🎚️",
        title: "The effort slider",
        tag: "New",
        blurb: "Drag how hard Ares thinks — and when you slide it to ULTRA, you'll know. Stalled thinking now auto-recovers by stepping down a notch and finishing instead of spinning.",
      },
      {
        icon: "✅",
        title: "It can't bluff \"done\" anymore",
        tag: "Safer",
        blurb: "Every edit is verified on every surface — desktop included — and Ares refuses to finish while its own changes are broken. Fifty red errors arrive triaged into the few root causes that matter.",
      },
      {
        icon: "🏛️",
        title: "HELM is alive + the Forged look",
        tag: "Polished",
        blurb: "The war room streams live missions, cost, and earned-trust meters — and the whole desktop wears a new spring-animated skin (Legacy is one toggle away).",
      },
      {
        icon: "🧠",
        title: "1M-token memory lane",
        tag: "Faster",
        blurb: "Opus 4.8, DeepSeek v4, and GLM 5.1 now use their full million-token windows — with an honest fuel gauge and smarter caching so long sessions stay affordable.",
      },
      {
        icon: "📈",
        title: "It keeps score on itself",
        tag: "New",
        blurb: "A 50-task coding exam, friction telemetry on every turn, and an `ares friction` report that names exactly what to sharpen next. Ares now improves on evidence, not vibes.",
      },
    ],
  },
  {
    version: "0.12.1",
    date: "June 2026",
    title: "Sharper hands",
    tagline: "A fast follow-up: skills that don't false-alarm, eyes for your images, and fewer needless prompts.",
    highlights: [
      {
        icon: "🛠️",
        title: "Skills that finish",
        tag: "Safer",
        blurb: "A skill that takes a while — generating an image or a video — is no longer cut off and reported as failed while it's still working. It runs to completion and reports the real result.",
      },
      {
        icon: "🖼️",
        title: "Ares can see your images",
        tag: "New",
        blurb: "Ares can now actually view image files — judge a render it made, read a screenshot, inspect a diagram — instead of choking on raw data.",
      },
      {
        icon: "🔓",
        title: "Fewer needless prompts",
        tag: "Polished",
        blurb: "Harmless commands like listing or formatting a table of files no longer trip a false “this can delete data” warning, so you approve less and move faster.",
      },
      {
        icon: "🧩",
        title: "Self-built skills work first try",
        tag: "Polished",
        blurb: "When Ares forges a new skill for itself, it scaffolds a correct, ready-to-run template — far fewer false starts when it extends its own abilities.",
      },
    ],
  },
  {
    version: "0.12.0",
    date: "June 2026",
    title: "Does what it says",
    tagline: "The reliability release — Ares stops dropping tool calls, won't claim work it didn't finish, and the effort dial finally changes how hard it thinks.",
    highlights: [
      {
        icon: "🎚️",
        title: "The effort dial works",
        tag: "New",
        blurb: "Set how hard Ares thinks and it now actually changes the model's effort on every provider — plus a real Off for when you just want speed.",
      },
      {
        icon: "🎯",
        title: "No more silent tool fails",
        tag: "Safer",
        blurb: "When a tool call gets garbled or cut off mid-stream, Ares catches it and retries instead of pretending it ran — far fewer mystery stalls.",
      },
      {
        icon: "🧾",
        title: "Honest about “done”",
        tag: "Safer",
        blurb: "Ares can't report success when the build is still red, an answer got cut off, or a background agent crashed — what it tells you matches what actually happened.",
      },
      {
        icon: "✏️",
        title: "Edits you can trust",
        tag: "Safer",
        blurb: "After changing a file, Ares re-reads the real result and shows you the edited lines — no more working from a stale copy and editing blind.",
      },
      {
        icon: "⏱️",
        title: "Won't freeze or rush you",
        tag: "Polished",
        blurb: "Background tasks, web checks, and tool servers all have real deadlines so nothing wedges — and taking your time to approve an action no longer makes a tool “time out”.",
      },
    ],
  },
  {
    version: "0.11.2",
    date: "June 2026",
    title: "You're in control",
    tagline: "Decide what Ares does on its own, see every release any time, and let ULTRA actually unleash the fleet.",
    highlights: [
      {
        icon: "🎛️",
        title: "Permissions you can flip",
        tag: "New",
        blurb: "A new Permissions tab: act freely with no prompts, or stay guarded and choose exactly what auto-approves — files, commands, web, sensitive actions — plus whether background fleets inherit your permissions.",
      },
      {
        icon: "📰",
        title: "Updates that stick around",
        tag: "New",
        blurb: "A “What's New” tab keeps every release note in one place, and a button re-opens the popup any time — no more missing what changed.",
      },
      {
        icon: "🛰️",
        title: "ULTRA unleashes the fleet",
        tag: "Faster",
        blurb: "Slide to ULTRA and Ares now actually fans the work out to a parallel agent fleet by default — and the agents have room to finish instead of dying mid-task.",
      },
    ],
  },
  {
    version: "0.11.1",
    date: "June 2026",
    title: "Updates that don't jam",
    tagline: "A hotfix for the broken updater, plus an agent that's straight with you about what it actually did.",
    highlights: [
      {
        icon: "🔧",
        title: "Updates apply cleanly",
        tag: "Safer",
        blurb: "The in-app update could fail with “node in use” and leave Ares stuck or unable to restart. It now shuts the engine down first and frees the files, so updates land and the app comes back — no ghost process.",
      },
      {
        icon: "🧠",
        title: "Straight about what's done",
        tag: "Safer",
        blurb: "Ares now checks against what you actually asked for — not a convenient stand-in — and reports failures plainly instead of declaring a fix that didn't land.",
      },
      {
        icon: "🤝",
        title: "Fleets that don't lie",
        tag: "Polished",
        blurb: "Multi-agent runs surface failures instead of reporting success when agents died, and can work on a project outside the main folder once you approve it.",
      },
    ],
  },
  {
    version: "0.11.0",
    date: "June 2026",
    title: "Built to be handed to someone else",
    tagline: "Ares grew up — smoother to start, harder to break, and it shows you everything it's doing.",
    highlights: [
      {
        icon: "🔌",
        title: "Bring any AI",
        tag: "New",
        blurb: "Plug in any provider's URL + key — Together, Groq, a gateway, even a model on your own machine — and Ares pulls its whole model list automatically.",
      },
      {
        icon: "🚀",
        title: "Lands running",
        tag: "New",
        blurb: "A guided first run takes you from zero to your first answer — if no AI is set up yet, Ares walks you straight to it instead of failing cryptically.",
      },
      {
        icon: "🛡️",
        title: "Hard to kill",
        tag: "Safer",
        blurb: "An unexpected error no longer takes the whole app down with it — Ares stays up, keeps your chat alive, and quietly saves a crash report you can hand back to us.",
      },
      {
        icon: "🔁",
        title: "Never goes quiet",
        tag: "Safer",
        blurb: "If a key runs dry or a model rate-limits, Ares backs off, switches to a working provider on its own, and tells you what happened instead of dead-ending.",
      },
      {
        icon: "✅",
        title: "Checks its own work",
        tag: "Safer",
        blurb: "After it edits code, Ares quietly runs your types and tests — so when it says “done,” it actually built.",
      },
      {
        icon: "✨",
        title: "The little things",
        tag: "Polished",
        blurb: "“Always allow” finally sticks between sessions, and the Telegram channel rides out flaky networks instead of hanging.",
      },
    ],
  },
];
