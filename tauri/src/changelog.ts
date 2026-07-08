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
    version: "0.20.1",
    date: "July 2026",
    title: "Ares through the harness",
    tagline: "Claude Code and Codex can now be operating harnesses while the agent, account, and model stay Ares.",
    highlights: [
      {
        icon: "A",
        title: "Codex runs as Ares",
        tag: "New",
        blurb: "Codex delegation now uses an Ares custom provider, Ares account token, and isolated Codex home, so the harness works without touching your Codex login.",
      },
      {
        icon: "!",
        title: "No borrowed logins",
        tag: "Safer",
        blurb: "Every delegated run is wrapped as Ares through the local harness, and any path that could fall back to a separate Claude or Codex login is refused.",
      },
      {
        icon: ">",
        title: "Smarter backend choice",
        tag: "Polished",
        blurb: "Auto delegation now skips the broken Bun-backed Claude shim and chooses a real Ares-bound harness when one is available.",
      },
    ],
  },
  {
    version: "0.20.0",
    date: "July 2026",
    title: "Elite coding, cleaner story",
    tagline: "The transcript reads like structured work now, exploration got 10x cheaper, and long sessions keep their file state through compaction.",
    highlights: [
      {
        icon: "🧭",
        title: "Cheap, wide exploration",
        tag: "Faster",
        blurb: "A new explorer scout fans out searches on a fast, inexpensive model and reports back conclusions with citations — wide codebase exploration without burning frontier-model tokens or clogging the main context.",
      },
      {
        icon: "📌",
        title: "Long sessions keep their footing",
        tag: "Safer",
        blurb: "When a long session compresses its history to free space, the files being worked on are now re-read and pinned fresh — the first edit after compression is never a blind edit against a remembered version.",
      },
      {
        icon: "🧵",
        title: "A transcript that reads like work",
        tag: "Polished",
        blurb: "Your messages get a chevron, replies get a clean gutter, tools tuck under the turn with their results hanging off them — and a wall of repeated errors collapses to one line with a ×count.",
      },
    ],
  },
  {
    version: "0.19.1",
    date: "July 2026",
    title: "Unkillable writes",
    tagline: "Locked files and giant folders can no longer take a file-write down with them.",
    highlights: [
      {
        icon: "🛡️",
        title: "A snapshot can't kill your work",
        tag: "Safer",
        blurb: "Building in a folder with locked files (like a running browser's cache) used to make every file-write die with a permission error before it even started. Undo snapshots now skip what they can't read, stay out of home-directory-sized folders entirely, and can never take a tool down with them.",
      },
      {
        icon: "🫁",
        title: "Room to breathe",
        tag: "Polished",
        blurb: "The terminal transcript adds a breath of air before each of your messages — exchanges read as turns, not one dense wall.",
      },
    ],
  },
  {
    version: "0.19.0",
    date: "July 2026",
    title: "Tactical: coding got fast",
    tagline: "The bookkeeping tax on every edit is gone, deep thinking spends itself where it pays, and you can steer Ares mid-task without killing the run.",
    highlights: [
      {
        icon: "⚡",
        title: "Edits without the wait",
        tag: "Faster",
        blurb: "Every file edit used to trigger a full workspace snapshot — seconds of dead time per edit on a big project, twice. Snapshots are now incremental: the same undo safety, at milliseconds.",
      },
      {
        icon: "🎯",
        title: "Thinks where it counts",
        tag: "Faster",
        blurb: "Full reasoning depth goes to the opening plan and to failure recovery; routine steps in between run light. On DeepSeek that's the difference between a minute of silent 'thinking' before each step and just doing the step.",
      },
      {
        icon: "🕹️",
        title: "Steer it mid-task",
        tag: "New",
        blurb: "Type while Ares is working and your message reaches it within one tool step — course-correct without cancelling. And in the terminal, clicks now land exactly where you aim.",
      },
      {
        icon: "🛠️",
        title: "Edits that just land",
        tag: "Safer",
        blurb: "Smart-quote drift, odd spaces, and misjudged indentation no longer bounce an edit back for a retry — a canonical matcher rescues them safely, and anything ambiguous still refuses loudly.",
      },
    ],
  },
  {
    version: "0.18.1",
    date: "July 2026",
    title: "In-House, front and center",
    tagline: "The In-House account provider is back on the picker — one balance, frontier models, no keys to manage.",
    highlights: [
      {
        icon: "◆",
        title: "In-House on the picker",
        tag: "New",
        blurb: "The In-House (Ares account) provider now leads the provider grid — pick it to run frontier models billed to your account balance, with no API keys to juggle.",
      },
    ],
  },
  {
    version: "0.18.0",
    date: "July 2026",
    title: "A living terminal — and no more silent stalls",
    tagline: "The terminal's main screen came alive: live tool cards, clickable everything, and the bug that froze a turn forever on an invisible question is dead.",
    highlights: [
      {
        icon: "🃏",
        title: "Tools you can watch",
        tag: "New",
        blurb: "Every tool call is now a living card — a spinner and a ticking timer while it runs, a ✓ with its duration and a peek at its output when it lands. When several run at once you'll see \"⚡ N tools in flight\".",
      },
      {
        icon: "🖱️",
        title: "Click it, don't type it",
        tag: "New",
        blurb: "The terminal's bottom bar (Models · Effort · Themes · Settings · Ultra) and the model name in the header are clickable now, replies render real formatting, and the header shimmers while Ares works.",
      },
      {
        icon: "🛡️",
        title: "No more frozen turns",
        tag: "Safer",
        blurb: "When a tool needs your permission, a card now appears right in the frame — answer with a key or a click. Before, that question was invisible and Ares waited on it forever; a time ceiling now guarantees a stuck prompt can never freeze a turn again.",
      },
    ],
  },
  {
    version: "0.17.0",
    date: "July 2026",
    title: "The new terminal look is here — and builds that finish",
    tagline: "The redesigned CLI is now the default, the chat noise is gone, and when Ares fans a big job out to a team it can no longer research forever and ship nothing.",
    highlights: [
      {
        icon: "🖥️",
        title: "The new terminal UI, by default",
        tag: "New",
        blurb: "The calm cool-teal redesign of the `ares` CLI is now what you get out of the box — new intro, provider grid, and live activity view, all in one consistent look. (Prefer the old fire theme? Launch with ARES_TUI=classic.)",
      },
      {
        icon: "🤖",
        title: "Fleets that actually build",
        tag: "Safer",
        blurb: "When Ares delegates a big build to a team of agents, it can no longer spend 20 minutes researching and planning and then stop without writing a line of code — a research-only build plan is now rejected up front, so the work ends in real, verified files.",
      },
      {
        icon: "🧹",
        title: "A quieter chat",
        tag: "Polished",
        blurb: "The repeating internal-plumbing lines that used to clutter the transcript every turn are gone — you see your conversation and the work, not the machinery.",
      },
    ],
  },
  {
    version: "0.16.0",
    date: "July 2026",
    title: "A new terminal look — in preview",
    tagline: "The ares command-line interface got a complete ground-up redesign. Try it now, make it default when it's dialed in.",
    highlights: [
      {
        icon: "🖥️",
        title: "The terminal UI, reborn",
        tag: "New",
        blurb: "The `ares` CLI got a full ground-up redesign — a calm, cool-teal look with a new intro, a provider grid, and a live activity view. It's an opt-in preview: launch with ARES_TUI=slate to try it. It becomes the default once it's dialed in.",
      },
      {
        icon: "🎯",
        title: "Sharper coding instincts",
        tag: "Polished",
        blurb: "Tighter guidance on making the smallest correct change and on how Ares briefs its helper agents — less over-engineering, cleaner delegation.",
      },
    ],
  },
  {
    version: "0.15.0",
    date: "July 2026",
    title: "Pick a whole council as your model",
    tagline: "Mixture-of-Agents: choose an ensemble in the model picker and a committee of frontier models drafts the answer, then one synthesizes the best of all of them.",
    highlights: [
      {
        icon: "🜲",
        title: "Mixture-of-Agents, one click",
        tag: "New",
        blurb: "There's a new \"Mixture of Agents\" provider in the model picker. Choose an ensemble like \"Frontier Council\" and Ares runs your prompt through several models independently, then a synthesizer takes the strongest reasoning from each into one answer — with tools, like any model.",
      },
      {
        icon: "🧩",
        title: "Uses whatever you've got",
        tag: "Polished",
        blurb: "An ensemble uses whichever of its members you have configured — the rest simply sit out, so it's useful the moment you have any of them keyed. Your pick sticks across restarts, too.",
      },
    ],
  },
  {
    version: "0.14.3",
    date: "July 2026",
    title: "\"Done\" means proven",
    tagline: "Ares can now send in an adversarial verifier that tries to break the work before calling it finished.",
    highlights: [
      {
        icon: "🧪",
        title: "It verifies against reality",
        tag: "Safer",
        blurb: "On non-trivial coding work, Ares can dispatch a verification specialist whose only job is to try to break the result — it runs the real build, tests, and edge-case probes, and it literally can't edit the code, so it can't fudge a pass. \"Done\" now means checked, not claimed.",
      },
    ],
  },
  {
    version: "0.14.2",
    date: "July 2026",
    title: "Model pages, not just rows",
    tagline: "Click the ⓘ on any model to open a full page — description, context window, pricing, capabilities.",
    highlights: [
      {
        icon: "🗂️",
        title: "A real page for every model",
        tag: "New",
        blurb: "The model list was just rows. Now each card has an ⓘ that opens a big, readable page: the full description, context window, per-million input/output pricing, and every capability — then one click to use it. Especially good across OpenRouter's huge catalog.",
      },
    ],
  },
  {
    version: "0.14.1",
    date: "July 2026",
    title: "Your call: delegate, or Ares does it",
    tagline: "Ares now asks before handing a job to Claude Code — and codes sharper when it does it itself.",
    highlights: [
      {
        icon: "🎛️",
        title: "The delegation choice is yours",
        tag: "New",
        blurb: "On a big coding job, Ares pops a choice — \"Use Claude Code (on your Ares account), or I'll do it myself?\" One click. Pick Claude Code and the cut-scene plays; pick Ares and it codes in-house.",
      },
      {
        icon: "🎯",
        title: "Sharper, no gold-plating",
        tag: "Polished",
        blurb: "Ares's coding instincts got tighter: do exactly what's asked (no speculative extras), never touch code it hasn't read, comment only where the why isn't obvious, and never check off a task while anything's still failing.",
      },
    ],
  },
  {
    version: "0.14.0",
    date: "July 2026",
    title: "The delegation cut-scene",
    tagline: "Watch Ares hand a job to Claude Code — a little animated scene, live, right in the chat.",
    highlights: [
      {
        icon: "🎬",
        title: "Ares delegates, on screen",
        tag: "New",
        blurb: "When Ares drives an external coder like Claude Code on your Ares account, a live animated scene shows it happening — Ares and the backend as characters, a delegation beam, a phase timeline, and a running file tally. \"Completely overpowered.\"",
      },
      {
        icon: "🔥",
        title: "See exactly what's running",
        tag: "Polished",
        blurb: "The scene narrates each act — sizing up the job, bringing the backend online, driving it, done — with the files it touched, so a long delegated run never looks frozen.",
      },
    ],
  },
  {
    version: "0.13.13",
    date: "July 2026",
    title: "Your model stays put — and a richer model browser",
    tagline: "The model you pick no longer drifts to Ollama or a routed model, and the model list now shows real descriptions.",
    highlights: [
      {
        icon: "📍",
        title: "Your pick stops drifting",
        tag: "Safer",
        blurb: "In manual mode the readout now always shows the model YOU chose — a one-off route or a fallback after a hiccup won't make it look like your selection changed. Auto-routing is opt-in only, never turned on behind your back.",
      },
      {
        icon: "✨",
        title: "Browse models, not just IDs",
        tag: "New",
        blurb: "The model picker now shows a real description under each model — a genuine \"discover the good ones\" browse, especially across OpenRouter's huge catalog, with capabilities, context, and pricing at a glance.",
      },
    ],
  },
  {
    version: "0.13.12",
    date: "July 2026",
    title: "Your model sticks — and easier account setup",
    tagline: "Ares now remembers the model you pick, and getting started can connect your Ares account in one click.",
    highlights: [
      {
        icon: "📌",
        title: "It remembers your model",
        tag: "Safer",
        blurb: "Pick an Ares-account or custom-endpoint model and it now sticks across restarts instead of snapping back to the default. Every provider's choice is remembered.",
      },
      {
        icon: "🚀",
        title: "One-click account on setup",
        tag: "New",
        blurb: "The welcome screen now offers \"Connect Ares account\" right alongside local Ollama and API keys — the zero-setup path to models is front and center.",
      },
    ],
  },
  {
    version: "0.13.11",
    date: "July 2026",
    title: "Helper agents ask instead of dying",
    tagline: "When Ares sends helper agents into a folder outside your workspace, they now ask you for access — before, they all silently failed.",
    highlights: [
      {
        icon: "🔑",
        title: "Helpers ask for folder access",
        tag: "Safer",
        blurb: "Research helpers working in a folder outside your workspace now pop a normal permission prompt instead of instantly failing. One approval covers the whole crew.",
      },
      {
        icon: "🛠️",
        title: "Big scans actually finish",
        tag: "New",
        blurb: "\"Scan this whole mods folder\" style jobs used to die on the first file when the folder wasn't pre-approved. Now they ask once and get to work.",
      },
    ],
  },
  {
    version: "0.13.10",
    date: "July 2026",
    title: "No more frozen chats from a big image",
    tagline: "Pasting a large screenshot could silently lock a conversation — that's fixed, and images are now auto-shrunk on the way in.",
    highlights: [
      {
        icon: "🖼️",
        title: "Screenshots just work",
        tag: "Safer",
        blurb: "Paste any screenshot and Ares shrinks it to a vision-safe size before sending — no quality loss the model can see, and no more oversized uploads getting rejected.",
      },
      {
        icon: "🔓",
        title: "Chats can't get stuck anymore",
        tag: "Safer",
        blurb: "If a message ever grows too large to send, Ares now trims and retries on its own instead of freezing. Sessions that were jammed heal themselves on the next message.",
      },
    ],
  },
  {
    version: "0.13.9",
    date: "July 2026",
    title: "Updates that don't jam — and Light Mode",
    tagline: "Fixed the \"node.exe in use\" update error, added a light theme, and made the model list a gallery.",
    highlights: [
      {
        icon: "🩹",
        title: "Updates install cleanly",
        tag: "Safer",
        blurb: "The updater was hitting \"Error opening file for writing … node.exe\" because a running Ares process still held the file. It now reliably shuts those down and waits for the file to free before installing.",
      },
      {
        icon: "☀️",
        title: "Daylight — a light theme",
        tag: "New",
        blurb: "Prefer a bright workspace? Settings → Appearance now has Daylight: the forge at high noon, warm parchment and iron ink instead of obsidian.",
      },
      {
        icon: "🎨",
        title: "The model picker reads like a gallery",
        tag: "Polished",
        blurb: "Every model now shows a provider glyph with a subtle stagger-in, so the list is scannable at a glance instead of a wall of ids.",
      },
    ],
  },
  {
    version: "0.13.8",
    date: "July 2026",
    title: "Ares on Linux — for real this time",
    tagline: "Native Linux installers, and the lag is gone.",
    highlights: [
      {
        icon: "🐧",
        title: "Linux installers",
        tag: "New",
        blurb: "Every release now ships an AppImage (with auto-updates) and a .deb alongside the Windows installer — same runtime, same features, same account.",
      },
      {
        icon: "⚡",
        title: "The lag fix",
        tag: "Faster",
        blurb: "Linux's webview was rendering Ares's blur effects and flame on the CPU — that was the slideshow. Ares now disables the buggy renderer path and runs a lite visual mode on Linux: same look, smooth feel.",
      },
    ],
  },
  {
    version: "0.13.7",
    date: "July 2026",
    title: "Bug reports that actually send",
    tagline: "Big coding sessions no longer hit \"too large\" — reports now compress before upload.",
    highlights: [
      {
        icon: "📦",
        title: "Large chats send fine now",
        tag: "Safer",
        blurb: "Long coding sessions were too big to upload (\"Request Entity Too Large\"). Reports are now compressed before sending — a 15MB session becomes ~1-2MB — so even marathon sessions go through.",
      },
    ],
  },
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
