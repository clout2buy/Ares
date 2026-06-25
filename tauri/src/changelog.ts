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
