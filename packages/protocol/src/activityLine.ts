// The plain-English activity line: what an agent is doing right now, in words
// an ordinary person reads without knowing what a tool call is ("Reading
// parkour.html", "Running the tests", "Waiting on Claude (rate limited,
// retrying in 20s)"). One table, shared by the desktop (live line + job line
// under each agent) and the daemon (stamped on events as `activityLine` so the
// phone and Telegram can show the same words later).
//
// Owner, 2026-10-20: "poeple shouldnt se tool calls... it should say like
// doing this, then after now im doing this". Pure, no imports: the desktop
// pulls this file in by relative path and the tests bundle it with esbuild.

/** A coarse family. Steps of the same family in a row merge ("Edited 3 files"). */
export type ActivityGroup =
  | "read" | "edit" | "create" | "search" | "web" | "browser" | "computer"
  | "test" | "build" | "install" | "git" | "shell" | "job"
  | "delegate" | "plan" | "memory" | "image" | "service"
  | "compact" | "wait" | "other";

export interface ActivityPhrase {
  group: ActivityGroup;
  /** Present tense, shown while it runs: "Reading parkour.html". */
  now: string;
  /** Past tense, shown faint with a check once it is done: "Read parkour.html". */
  done: string;
  /** The file this step is about (basename), when there is one — merging
   *  counts distinct files. */
  file?: string;
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};

const basename = (p: string): string => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? p;
};

const hostOf = (url: string): string => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url.trim());
  return m ? m[1].replace(/^www\./i, "") : clip(url, 40);
};

const str = (rec: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

const phrase = (group: ActivityGroup, now: string, done: string, file?: string): ActivityPhrase =>
  file ? { group, now, done, file } : { group, now, done };

/** The friendly name of the brain behind a model id, for "Waiting on Claude". */
export function modelFriendlyName(model: string | undefined): string {
  const m = (model ?? "").toLowerCase();
  if (!m) return "the model";
  if (/claude|opus|sonnet|haiku|fable|anthropic/.test(m)) return "Claude";
  if (/deepseek/.test(m)) return "DeepSeek";
  if (/gemini/.test(m)) return "Gemini";
  if (/grok|xai/.test(m)) return "Grok";
  if (/kimi|moonshot/.test(m)) return "Kimi";
  if (/glm|zhipu/.test(m)) return "GLM";
  if (/qwen/.test(m)) return "Qwen";
  if (/gpt|openai|^o\d/.test(m)) return "ChatGPT";
  if (/llama/.test(m)) return "Llama";
  return "the model";
}

/** What a shell command is FOR, never the command itself. */
function shellPhrase(command: string, background: boolean): ActivityPhrase {
  const c = command.replace(/\s+/g, " ").trim();
  if (background) return phrase("job", "Starting a background process", "Started a background process");
  if (/(^|[\s;&|(])((p?npm|yarn|bun)\s+(run\s+)?test\b|node\s+--test\b|vitest\b|jest\b|pytest\b|mocha\b|cargo\s+test\b|go\s+test\b|dotnet\s+test\b|pnpm\s+verify\b|npm\s+run\s+verify\b|playwright\s+test\b)/i.test(c)) {
    return phrase("test", "Running the tests", "Ran the tests");
  }
  if (/(^|[\s;&|(])((p?npm|yarn|bun)\s+(run\s+)?(build|typecheck)\b|tsc\b|vite\s+build\b|cargo\s+(build|check)\b|go\s+build\b|dotnet\s+build\b|make\b|gradle\w*\s|mvn\s)/i.test(c)) {
    return phrase("build", "Building the project", "Built the project");
  }
  if (/(^|[\s;&|(])((p?npm|yarn|bun)\s+(install|i|add|ci)\b|pip3?\s+install\b|cargo\s+add\b|winget\s+install\b|choco\s+install\b|apt(-get)?\s+install\b|brew\s+install\b)/i.test(c)) {
    return phrase("install", "Installing what it needs", "Installed what it needs");
  }
  if (/(^|[\s;&|(])(eslint|prettier|ruff|clippy|(p?npm|yarn)\s+(run\s+)?lint)\b/i.test(c)) {
    return phrase("build", "Checking the code style", "Checked the code style");
  }
  const git = /(^|[\s;&|(])git\s+(\w+)/i.exec(c);
  if (git) {
    const sub = git[2].toLowerCase();
    if (sub === "commit") return phrase("git", "Saving the changes in git", "Saved the changes in git");
    if (sub === "push") return phrase("git", "Pushing to GitHub", "Pushed to GitHub");
    if (sub === "pull" || sub === "fetch" || sub === "clone") return phrase("git", "Downloading code with git", "Downloaded code with git");
    return phrase("git", "Checking git", "Checked git");
  }
  const script = /^(?:node|python3?|py|deno\s+run|bun|ruby|php|tsx|ts-node|pwsh|powershell(?:\.exe)?(?:\s+-\w+)*)\s+("[^"]+"|'[^']+'|\S+\.(?:m?js|cjs|ts|py|rb|php|ps1))/i.exec(c);
  if (script) {
    const file = basename(script[1].replace(/^["']|["']$/g, ""));
    return phrase("shell", `Running ${file}`, `Ran ${file}`);
  }
  if (/^(ls|dir|Get-ChildItem|tree|find)\b/i.test(c)) return phrase("read", "Looking through the folders", "Looked through the folders");
  if (/^(cat|type|Get-Content|head|tail|sed\s+-n)\b/i.test(c)) return phrase("read", "Reading a file", "Read a file");
  if (/^(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i.test(c)) return phrase("web", "Fetching something from the web", "Fetched something from the web");
  return phrase("shell", "Running a command", "Ran a command");
}

/** Services the agent can work with, by tool name: [now, done]. */
const SERVICES: Record<string, [string, string]> = {
  Weather: ["Checking the weather", "Checked the weather"],
  Calendar: ["Checking the calendar", "Checked the calendar"],
  GoogleCalendar: ["Checking the calendar", "Checked the calendar"],
  Email: ["Working on email", "Worked on email"],
  Gmail: ["Working on email", "Worked on email"],
  Outlook: ["Working on email", "Worked on email"],
  Mail: ["Working on email", "Worked on email"],
  Contacts: ["Looking up contacts", "Looked up contacts"],
  GoogleContacts: ["Looking up contacts", "Looked up contacts"],
  GoogleDocs: ["Working in Google Docs", "Worked in Google Docs"],
  GoogleSheets: ["Working in Google Sheets", "Worked in Google Sheets"],
  GoogleSlides: ["Working in Google Slides", "Worked in Google Slides"],
  GoogleDrive: ["Looking in Google Drive", "Looked in Google Drive"],
  GoogleForms: ["Working in Google Forms", "Worked in Google Forms"],
  GoogleTasks: ["Checking tasks", "Checked tasks"],
  Remind: ["Setting a reminder", "Set a reminder"],
  Spotify: ["Working with Spotify", "Worked with Spotify"],
  Places: ["Looking up places", "Looked up places"],
  FlightStatus: ["Checking a flight", "Checked a flight"],
  FlightBooking: ["Looking at flights", "Looked at flights"],
  Telegram: ["Working with Telegram", "Worked with Telegram"],
  Phone: ["Working with the phone", "Worked with the phone"],
  iPhone: ["Working with the iPhone", "Worked with the iPhone"],
  RemotePC: ["Working on the other computer", "Worked on the other computer"],
  Deploy: ["Publishing it", "Published it"],
  Hue: ["Adjusting the lights", "Adjusted the lights"],
  Tesla: ["Talking to the car", "Talked to the car"],
  Bank: ["Looking at the bank account", "Looked at the bank account"],
  Stripe: ["Working with Stripe", "Worked with Stripe"],
  Track: ["Checking a delivery", "Checked a delivery"],
  ChangeSetting: ["Changing a setting", "Changed a setting"],
};

/** Tools that are plumbing, not progress: they never get a line. */
const INVISIBLE = /^(TodoWrite|ToolSearch|SkillsList|McpListTools|SetUiEffect|UpdatePlanDraft|EnterPlanMode)$/;

/**
 * The plain-English phrase for one tool call, or null when the call is
 * plumbing the owner never needs to see (TodoWrite, ToolSearch…). Never
 * returns a tool name, a raw command or JSON.
 */
export function toolActivity(name: string, input: unknown): ActivityPhrase | null {
  const rec = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const n = (name || "").trim();
  if (!n || INVISIBLE.test(n)) return null;
  const path = str(rec, "file_path", "path", "notebook_path");
  const file = path ? basename(path) : "";
  switch (n) {
    case "Read":
    case "NotebookRead":
      return file ? phrase("read", `Reading ${file}`, `Read ${file}`, file) : phrase("read", "Reading a file", "Read a file");
    case "Write":
      return file ? phrase("create", `Writing ${file}`, `Wrote ${file}`, file) : phrase("create", "Writing a file", "Wrote a file");
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "FindAndEdit":
    case "ApplyIntent":
    case "ApplyPatch":
      return file ? phrase("edit", `Editing ${file}`, `Edited ${file}`, file) : phrase("edit", "Editing files", "Edited files");
    case "Glob":
    case "LS":
      return phrase("read", "Looking for files", "Looked for files");
    case "Grep":
    case "CodebaseSearch": {
      const q = str(rec, "pattern", "query");
      return q && q.length <= 40 && /^[\w .,'"-]+$/.test(q)
        ? phrase("search", `Searching the code for “${q}”`, `Searched the code for “${q}”`)
        : phrase("search", "Searching the code", "Searched the code");
    }
    case "WebSearch":
    case "Brave":
    case "Tavily":
    case "DuckDuckGo":
    case "SearXNG": {
      const q = str(rec, "query", "q");
      return q ? phrase("web", `Searching the web for ${clip(q, 60)}`, `Searched the web for ${clip(q, 60)}`) : phrase("web", "Searching the web", "Searched the web");
    }
    case "ImageSearch": {
      const q = str(rec, "query", "q");
      return q ? phrase("web", `Looking for pictures of ${clip(q, 50)}`, `Looked for pictures of ${clip(q, 50)}`) : phrase("web", "Looking for pictures", "Looked for pictures");
    }
    case "WebFetch":
    case "Fetch": {
      const url = str(rec, "url");
      return url ? phrase("web", `Reading ${hostOf(url)}`, `Read ${hostOf(url)}`) : phrase("web", "Reading a web page", "Read a web page");
    }
    case "Browser": {
      const action = str(rec, "action");
      const url = str(rec, "url");
      if (action === "explain") return phrase("browser", "Drawing it out on the stage", "Drew it out on the stage");
      if (action === "model") return phrase("browser", "Shaping the 3D model", "Shaped the 3D model");
      if (url) return phrase("browser", `Opening ${hostOf(url)}`, `Opened ${hostOf(url)}`);
      return phrase("browser", "Using the browser", "Used the browser");
    }
    case "Bash":
    case "PowerShell":
    case "Shell": {
      const command = str(rec, "command");
      return command ? shellPhrase(command, rec.run_in_background === true) : phrase("shell", "Running a command", "Ran a command");
    }
    case "BashOutput":
    case "TaskOutput":
    case "BackgroundTasks":
      return phrase("job", "Checking on a background job", "Checked on a background job");
    case "KillShell":
    case "KillTask":
      return phrase("job", "Stopping a background job", "Stopped a background job");
    case "Task":
    case "Agent":
    case "Conductor": {
      const d = str(rec, "description", "goal");
      return d
        ? phrase("delegate", `A helper is on: ${clip(d, 60)}`, `Helper finished: ${clip(d, 60)}`)
        : phrase("delegate", "Handing part of this to a helper", "A helper finished its part");
    }
    case "CodingBackend":
      return phrase("delegate", "Handing the coding to a coding assistant", "The coding assistant finished");
    case "ExitPlanMode":
      return phrase("plan", "Laying out the plan for you", "Laid out the plan");
    case "Memory":
      return phrase("memory", "Checking memory", "Checked memory");
    case "SkillRead":
      return phrase("memory", "Reading up on how to do this", "Read up on how to do this");
    case "Imagine":
      return phrase("image", "Making a picture", "Made a picture");
    case "Diff":
      return phrase("read", "Looking at the changes", "Looked at the changes");
    case "Bisect":
      return phrase("test", "Tracking down where it broke", "Tracked down where it broke");
    case "LSP":
      return phrase("read", "Looking through the code", "Looked through the code");
    case "RequestUserAction":
      return phrase("wait", "Waiting for you", "You answered");
    case "Checkout":
      return phrase("service", "Getting a checkout ready", "Got a checkout ready");
  }
  if (/^Computer/.test(n)) return phrase("computer", "Using the computer", "Used the computer");
  const service = SERVICES[n];
  if (service) return phrase("service", service[0], service[1]);
  const mcp = /^mcp_([a-z0-9-]+)_/i.exec(n);
  const who = mcp ? mcp[1] : n.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return phrase("other", `Using ${who}`, `Used ${who}`);
}

export interface WaitPhrase {
  group: "wait" | "compact";
  now: string;
  /** Epoch ms of the next retry, when the reminder named one; surfaces count down. */
  retryAt?: number;
}

/**
 * A retry/stall/rate-limit reminder from the engine, as a waiting line
 * ("Waiting on Claude (overloaded, retrying in 20s)"). Null for every other
 * reminder: those are model plumbing. The " (… retrying in Ns)" tail is
 * rebuilt by surfaces from retryAt so it counts down instead of freezing.
 */
export function reminderActivity(text: string, model?: string, nowMs = Date.now()): WaitPhrase | null {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const who = modelFriendlyName(model);
  const secs = /retrying in ([\d.]+)s/i.exec(t);
  const retryAt = secs ? nowMs + Math.round(Number(secs[1]) * 1000) : undefined;
  const at = retryAt !== undefined ? { retryAt } : {};
  if (/smaller recent-history window/i.test(t)) return { group: "compact", now: "Trimming this chat so the model can answer" };
  if (/rate.limited: handing this turn to another provider/i.test(t)) return { group: "wait", now: `${who} is rate limited, switching to a backup` };
  if (/is overloaded upstream/i.test(t)) return { group: "wait", now: `Waiting on ${who} (overloaded)`, ...at };
  if (/can't reach the model's server/i.test(t)) return { group: "wait", now: "Waiting for the internet connection", ...at };
  if (/provider hiccup \((?:http_)?429\)|rate.?limit/i.test(t)) return { group: "wait", now: `Waiting on ${who} (rate limited)`, ...at };
  if (/provider hiccup/i.test(t)) return { group: "wait", now: `Waiting on ${who} (it hiccuped)`, ...at };
  if (/(stall|stalled).*retrying/i.test(t)) return { group: "wait", now: `${who} went quiet, asking again`, ...at };
  if (/^Provider failed|All configured providers failed|^Pinned (provider|\S+ failed)/i.test(t)) return { group: "wait", now: "Switching to a backup model" };
  return null;
}

/** "Waiting on Claude (rate limited)" + retryAt → "… (rate limited, retrying in 18s)". */
export function withRetryCountdown(now: string, retryAt: number | undefined, nowMs: number): string {
  if (retryAt === undefined) return now;
  const left = Math.max(0, Math.ceil((retryAt - nowMs) / 1000));
  const tail = left > 0 ? `retrying in ${left}s` : "retrying now";
  const m = /^(.*) \(([^)]*)\)$/.exec(now);
  return m ? `${m[1]} (${m[2]}, ${tail})` : `${now} (${tail})`;
}

/**
 * The one activity line for a daemon event, if that event starts a visible
 * step. The daemon stamps it on the event as `activityLine` so any surface
 * (phone, Telegram) can show the same words without its own table.
 */
export function activityLineFor(event: { type?: unknown; name?: unknown; input?: unknown; text?: unknown; method?: unknown; description?: unknown; toolName?: unknown }): string | undefined {
  switch (event.type) {
    case "tool_start":
      return typeof event.name === "string" ? toolActivity(event.name, event.input)?.now : undefined;
    case "system_reminder_injected":
      return typeof event.text === "string" ? reminderActivity(event.text)?.now : undefined;
    case "compaction":
      return event.method === "micro" ? undefined : "Compacted memory of this chat";
    case "subagent_start":
      return typeof event.description === "string" && event.description.trim()
        ? `A helper is on: ${clip(event.description, 60)}`
        : "Handing part of this to a helper";
    case "permission_request": {
      const p = typeof event.toolName === "string" ? toolActivity(event.toolName, event.input) : null;
      return p ? `Waiting for your OK: ${p.now.charAt(0).toLowerCase()}${p.now.slice(1)}` : "Waiting for your OK";
    }
    default:
      return undefined;
  }
}
