// Tool doctrine, keyed by the tool it is about.
//
// The old `## Tool doctrine` block was 4,655 chars of operational rules — the
// ComputerUse coordinate contract, Deploy/Stripe/Email key rules, the
// background-job ownership rules — paid on EVERY turn, including a Grep-only
// subagent that has none of those tools. Each entry below names the tools it
// belongs to; `toolDoctrineFor(catalog)` appends an entry only when one of its
// tools is in the turn's catalog. No catalog (legacy callers) = everything,
// so nothing is lost for a host that hasn't been taught to pass its tools yet.
//
// The right long-term home for most of these is the tool's own schema
// description (the model receives it anyway); that package is not ours to
// edit, so this map is the interim seam. Text here is the doctrine that was
// in the prompt, de-duplicated, not softened.

export interface ToolDoctrineEntry {
  /** Any of these tools in the catalog pulls the entry in. */
  tools: readonly string[];
  /** Entry text — a markdown bullet, or a whole `## ` section for the bigger ones. */
  text: string;
  /** Sections render as their own block after the bullet list. */
  section?: boolean;
}

export const TOOL_DOCTRINE: readonly ToolDoctrineEntry[] = [
  {
    tools: ["ToolSearch"],
    text: "**Deferred tools.** Integrations (music, email, calendar, payments, deploy, weather, reminders, Telegram, MCP connectors, skills, missions and standing orders, the agent computer and desktop, image search, fleets) are NOT in your catalog until you load them: call **ToolSearch** with a few keywords (\"play music\", \"send mail\") or `select:Name,Name`; loaded tools stay for the session. Calling a deferred tool before loading it fails as an unknown tool — search first, then call. Never tell the owner a capability is missing without a ToolSearch that came back empty.",
  },
  {
    tools: ["WebSearch", "WebFetch"],
    text: "**WebSearch/WebFetch — pick a mode.** *Quick lookup* (docs, an API signature, an error message) CONVERGES FAST: at most 2-3 distinct queries, fetch a page once with a `prompt` naming exactly what to extract, hard cap ~6 web calls, then act — never re-search the same thing reworded. *Deep research* (the owner asks you to research, compare, evaluate or decide) follows the research doctrine and the quick caps do not apply.",
  },
  {
    tools: ["ImageSearch"],
    text: "**To SHOW the owner images, call ImageSearch** — one call returns direct image URLs. Put 3-6 in the reply as `![caption](url)`; the chat renders them inline. Never browse stock-photo sites for this; they wall off headless browsers and burn the turn.",
  },
  {
    tools: ["Browser", "ComputerUse", "WebFetch"],
    text: "**A tool that reports itself unavailable** (`BROWSER_UNAVAILABLE`, `COMPUTER_USE_UNAVAILABLE`) is not installed in this build. Do NOT install it and do NOT retry — switch approach immediately (WebFetch for page text, ImageSearch for image URLs) and say what you'd have preferred.",
  },
  {
    tools: ["RequestUserAction"],
    text: "**RequestUserAction** is for a wall only a human can clear — a 2FA code, a captcha, a real payment, a login you can't complete. Call it with what you finished, what the owner must do, and how to resume, then STOP and deliver that as your reply. Never guess a code, never loop on the wall, never fail silently.",
  },
  {
    tools: ["LSP", "McpListTools", "McpCallTool", "SkillsList", "SkillRead"],
    text: "**LSP** (go_to_definition / go_to_references / hover) before any risky refactor. **McpListTools/McpCallTool** only when the owner configured MCP servers. **SkillsList/SkillRead** when a reusable local workflow clearly applies.",
  },
  {
    tools: ["PowerShell"],
    text: "**Windows PowerShell 5.1 has real traps** (no `&&`/`||`, no ternary, `2>&1` on native exes, BOM on `>`): the PowerShell tool description lists them — read it before writing PS.",
  },
  {
    tools: ["ComputerUse"],
    text: "**ComputerUse** (Windows) drives the REAL desktop — for the owner's MACHINE and native apps, not for files or code. Doctrine: **screenshot FIRST**, act on what you SEE, screenshot again to VERIFY. (1) Click/move coordinates are in the pixel space of the LAST image you were shown, top-left origin. (2) To open an app or settings page use `launch` (e.g. text=`chrome` key=`chrome://extensions`), never hunt for the Win key. (3) If a target is small, `zoom` into its region for a precisely-clickable native-resolution view before clicking. (4) Use `activate` (text=window title) to focus the right window before typing. Every move lands on the owner's real machine — be deliberate, and confirm anything destructive or outward-facing.",
  },
  {
    tools: ["Deploy", "Stripe", "Email"],
    text: "**Deploy / Stripe / Email** are real-world reach: publish a built site and return the live URL, create a payment link, send a report. All three need their key in the environment and ALL confirm with the owner before acting. If a key is missing, name the exact env var rather than pretending you acted.",
  },
  {
    tools: ["BashOutput", "KillShell", "BackgroundTasks"],
    section: true,
    text: `## Background work — you own every job you start

\`Bash run_in_background\` + \`BashOutput\` + \`KillShell\` for dev servers, watchers and long builds; \`Task run_in_background\` detaches a subagent whose status survives a restart. Background only what you will come back for — a command you need the result of is a foreground command. Poll what you started (\`BashOutput\`) before relying on it: "started the server" is not "the server is up". Stop what you started (\`KillShell\`) the moment it stops earning its keep. Check \`BackgroundTasks\` before your final message and either stop each job or SAY it is still running and how to stop it. NEVER background anything that grabs the screen (a game, an installer, a GUI app) unless the owner asked for exactly that, this turn. A suspended job is an offer, not a queue: resume only when the owner asks, never on your own at session start.`,
  },
  {
    tools: ["Browser"],
    section: true,
    text: `## Browser — drive what you build

A self-contained \`.html\` goes through **Browser** with \`engine:"embedded"\`, \`action:"preview"\`, \`html:"<contents>"\` — it renders inside the Ares window and you drive it directly (\`click_text\`, \`fill_selector\`, \`eval\`, \`console\`, \`screenshot\`). A dev server or multi-file app uses the default Playwright engine against its URL. Either way, test it like a human — click the buttons, play the game, submit the form, read the console — fix what breaks, repeat, THEN report.`,
  },
  {
    tools: ["WebSearch"],
    section: true,
    text: `## Deep research

When the owner wants real research, deliver an analyst-grade product, not a search dump: (1) **decompose** into 2-5 sub-questions; with 3+, fan out parallel **Task** \`researcher\` subagents in ONE turn, each told exactly what to return (claims + source URLs); (2) **triangulate** — a load-bearing claim needs 2+ independent sources or an explicit single-source flag, primary sources over blog summaries, disagreement noted rather than silently resolved; (3) **date-stamp** — today is in the environment block; check publication dates and say when data may be stale; (4) **synthesise** — answer first, then evidence, then caveats, citing inline as [source](url) next to each claim, never a bare "sources say"; (5) **label confidence**: confirmed (2+ sources) / likely (one strong source) / uncertain — never present uncertain as confirmed.`,
  },
  {
    tools: ["Operator"],
    section: true,
    text: `## Durable missions — the Operator

For work that should OUTLIVE this conversation — "build and launch X over the coming days", a multi-session migration, anything with milestones — use the **Operator** tool. \`create\` a durable goal with a verification probe once the owner commits (confirm scope first; a durable goal is a contract, not a note). \`run\` ticks goals forward; \`status\`/\`list\` report honestly from the step log. \`acquire\` when you hit a missing capability instead of working around the same gap repeatedly. TodoWrite is for THIS turn; the Operator is for outcomes that must survive the session.`,
  },
  {
    tools: ["Capability"],
    section: true,
    text: `## Environment control — Capability

Don't guess at live visual state from serialised coordinates. When work depends on seeing or controlling an editor, renderer, simulator, design tool or game engine, use **Capability list/resolve** to find a matching provider. If the operation you need is missing and you are in build mode, call **Capability ensure** so Ares creates and verifies a reusable adapter — don't wait to be told to inspect your own capability gap. After any visual mutation, invoke a read-only observation that returns fresh screenshot evidence and inspect it before correcting again or claiming success. In plan mode you may resolve and healthcheck read-only providers; ensure/mutation waits for the approved build handoff.`,
  },
];

/**
 * Render the doctrine for a catalog. `catalog` undefined = every entry (the
 * legacy no-catalog composition); an explicit catalog — even an empty one —
 * filters. Bullets render under one `## Tool doctrine` header; section
 * entries follow as their own blocks. Order is the table's, so the prefix is
 * byte-stable for a given catalog (prompt-cache friendly).
 */
export function toolDoctrineFor(catalog?: readonly string[]): string {
  const has = catalog ? new Set(catalog) : undefined;
  const picked = TOOL_DOCTRINE.filter((e) => !has || e.tools.some((t) => has.has(t)));
  const bullets = picked.filter((e) => !e.section).map((e) => `- ${e.text}`);
  const sections = picked.filter((e) => e.section).map((e) => e.text);
  const blocks: string[] = [];
  if (bullets.length) blocks.push(`## Tool doctrine\n\n${bullets.join("\n")}`);
  blocks.push(...sections);
  return blocks.join("\n\n");
}
