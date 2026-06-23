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
    version: "0.11.0",
    date: "June 2026",
    title: "Built to be handed to someone else",
    tagline: "Ares grew up — smoother to start, harder to break, and it shows you everything it's doing.",
    highlights: [
      {
        icon: "🚀",
        title: "Lands running",
        tag: "New",
        blurb: "A guided first-run takes you from zero to your first answer — no config files, no guessing.",
      },
      {
        icon: "🛡️",
        title: "Never goes quiet",
        tag: "Safer",
        blurb: "If a key or model hiccups, Ares recovers on its own and tells you what happened instead of dead-ending.",
      },
      {
        icon: "✅",
        title: "Shows its work",
        tag: "New",
        blurb: "Watch Ares check its own changes live — types, tests, and a clean diff of everything it touched.",
      },
      {
        icon: "💸",
        title: "Spend you can see",
        tag: "Safer",
        blurb: "Big autonomous runs now show live cost and stop at a ceiling you set. No surprise bills.",
      },
      {
        icon: "✨",
        title: "The little things",
        tag: "Polished",
        blurb: "Copy any reply, retry a turn in one tap, and “always allow” finally sticks between sessions.",
      },
      {
        icon: "🎭",
        title: "Watch it work",
        tag: "New",
        blurb: "A live window onto Ares driving a real browser — see every click and scroll as it happens.",
      },
    ],
  },
];
