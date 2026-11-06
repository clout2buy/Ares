// What leaves the machine in a bug report or a downloaded chat, and what does
// not. The report has to show everything about what Ares DID: which tools ran,
// in what order, what failed and how long it took. It must not carry what the
// owner's project IS: their files, their code, their name, where things live.
//
// Two levels, chosen by the owner every time:
//   private  — secrets, names, emails and paths replaced; file contents and
//              code replaced with a size and a hash; tool output kept only
//              where it reports an error. The default.
//   full     — secrets, names, emails and paths replaced; everything else kept,
//              for a bug that lives in the code Ares wrote.
// Both drop streaming deltas: a tool call's input and the reply's text are in
// their final events, and the deltas were most of the bytes.

import { createHash } from "node:crypto";
import { redactSecrets } from "./secretRedact.js";
import type { ContentBlock, Message, RolloutEntry } from "./types.js";

export type ReportLevel = "private" | "full";

/** The things that identify this person or this machine. */
export interface ScrubIdentity {
  home?: string;
  workspace?: string;
  aresHome?: string;
  username?: string;
  hostname?: string;
  /** Anything else that must never leave, as literal strings. */
  extra?: string[];
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<![\w/])\+?\d[\d\s().-]{8,14}\d(?![\w/])/g;
const IPV4_RE = /\b(?!(?:10|127|0)\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** A user folder on any OS, for when the username is not known. */
const USER_DIR_RE = /((?:[A-Za-z]:)?[\\/](?:Users|home)[\\/])([^\\/\s"'<>|:]+)/g;

const CONTENT_KEYS = new Set(["content", "new_string", "old_string", "html", "css", "js", "script", "source", "body", "patch", "diff", "text", "add_css", "code", "stdin"]);
const ERROR_LINE_RE = /\b(error|exception|failed|failure|fatal|panic|traceback|denied|refused|not found|no such|cannot|unable|timed? ?out|EACCES|ENOENT|EPERM|TS\d{4}|warning)\b/i;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A path as a pattern that matches either slash and either case on Windows. */
function pathRe(p: string): RegExp {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]+/).map(escapeRe);
  return new RegExp(parts.join("[\\\\/]+"), /^[A-Za-z]:/.test(p) ? "gi" : "g");
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

/** What stands in for text that is not sent: enough to tell two files apart. */
export function digest(text: string, label: string): string {
  const lines = text.length ? text.split("\n").length : 0;
  return `[${label}: ${text.length} chars, ${lines} lines, sha256:${sha(text)}]`;
}

/** Every string the identity names, replaced. Secrets always. */
export function scrubText(text: string, id: ScrubIdentity = {}): string {
  if (!text) return text;
  // Emails and numbers first: replacing a name inside an address would leave
  // the domain behind in a shape the address pattern no longer matches.
  let out = redactSecrets(text).replace(EMAIL_RE, "<email>").replace(IPV4_RE, "<ip>").replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, "").length;
    const date = /\d{4}[-.]\d{2}[-.]\d{2}/.test(m);
    const address = /^\d{1,3}(\.\d{1,3}){3}$/.test(m.trim());
    return digits < 10 || date || address ? m : "<phone>";
  });
  const paths: Array<[string | undefined, string]> = [[id.workspace, "<workspace>"], [id.aresHome, "<ares-home>"], [id.home, "~"]];
  // Longest first, so the workspace inside the home folder keeps its own name.
  for (const [p, token] of paths.filter((x): x is [string, string] => Boolean(x[0]) && x[0]!.length > 3).sort((a, b) => b[0].length - a[0].length)) out = out.replace(pathRe(p), token);
  out = out.replace(USER_DIR_RE, "$1<user>");
  for (const extra of id.extra ?? []) if (extra.length > 2) out = out.replace(new RegExp(escapeRe(extra), "gi"), "<private>");
  if (id.username && id.username.length > 2) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(id.username)}(?![A-Za-z0-9])`, "gi"), "<user>");
  if (id.hostname && id.hostname.length > 2) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(id.hostname)}(?![A-Za-z0-9])`, "gi"), "<host>");
  return out;
}

/** Code fences in prose become their digest; the words around them stay. */
export function digestFences(text: string): string {
  return text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, lang: string, body: string) => digest(body, `code${lang.trim() ? ` ${lang.trim()}` : ""}`));
}

/** Tool output in the private level: the lines that say something went wrong, and a digest of the rest. */
export function errorsOnly(text: string, max = 40): string {
  const lines = text.split("\n");
  const kept = lines.filter((l) => ERROR_LINE_RE.test(l)).slice(0, max).map((l) => l.slice(0, 400));
  if (kept.length === lines.length && text.length < 2000) return text;
  return `${digest(text, "output")}${kept.length ? `\n${kept.join("\n")}` : ""}`;
}

function scrubValue(value: unknown, id: ScrubIdentity, level: ReportLevel, key = ""): unknown {
  if (typeof value === "string") {
    if (level === "private" && CONTENT_KEYS.has(key) && value.length > 80) return digest(value, key);
    return scrubText(value, id);
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, id, level, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubValue(v, id, level, k);
    return out;
  }
  return value;
}

function scrubOutput(value: unknown, id: ScrubIdentity, level: ReportLevel): unknown {
  if (level === "full") return scrubValue(value, id, level);
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return errorsOnly(scrubText(text, id));
}

function scrubBlock(block: ContentBlock, id: ScrubIdentity, level: ReportLevel): ContentBlock {
  switch (block.type) {
    case "text":
      return { ...block, text: level === "private" ? digestFences(scrubText(block.text, id)) : scrubText(block.text, id) };
    case "thinking":
      return { type: "thinking", text: level === "private" ? digest(block.text, "thinking") : scrubText(block.text, id) };
    case "system_reminder":
      return { ...block, text: level === "private" ? digest(block.text, "system reminder") : scrubText(block.text, id) };
    case "image":
      return { type: "image", source: { kind: "url", url: `[image${block.source.kind === "base64" ? ` ${block.source.mediaType}, ${Math.round(block.source.data.length * 0.75 / 1024)} KB` : ""}]` } };
    case "tool_use":
      return { ...block, input: scrubValue(block.input, id, level) };
    case "tool_result": {
      const content = typeof block.content === "string" ? (scrubOutput(block.content, id, level) as string) : block.content.map((c) => scrubBlock(c, id, level) as never);
      return { ...block, content };
    }
    default:
      return block;
  }
}

export function scrubMessage(message: Message, id: ScrubIdentity, level: ReportLevel): Message {
  return { ...message, content: message.content.map((b) => scrubBlock(b, id, level)) };
}

const DROPPED = new Set(["text_delta", "thinking_delta", "tool_use_start", "tool_use_input_delta", "tool_use_input_done", "stream_heartbeat", "tool_progress"]);

export interface ScrubbedRollout {
  events: RolloutEntry[];
  /** What was taken out, in the owner's words, for the dialog and the report header. */
  removed: string[];
}

export function scrubRollout(entries: readonly RolloutEntry[], id: ScrubIdentity, level: ReportLevel): ScrubbedRollout {
  const events: RolloutEntry[] = [];
  for (const entry of entries) {
    const e = entry.event as Record<string, unknown> & { type: string };
    if (DROPPED.has(e.type)) continue;
    let event: Record<string, unknown>;
    switch (e.type) {
      case "turn_start":
      case "input_admitted":
        event = { ...e, userMessage: scrubMessage(e.userMessage as Message, id, level) };
        break;
      case "message_done":
        event = { ...e, message: scrubMessage(e.message as Message, id, level) };
        break;
      case "tool_start":
        event = { ...e, input: scrubValue(e.input, id, level), activityDescription: scrubText(String(e.activityDescription ?? ""), id) };
        break;
      case "tool_end":
        event = { ...e, output: scrubOutput(e.output, id, level) };
        break;
      case "tool_error":
        event = { ...e, error: scrubText(String(e.error ?? ""), id), output: scrubOutput(e.output, id, level) };
        break;
      case "system_reminder_injected":
        event = { ...e, text: level === "private" ? digest(String(e.text ?? ""), "system reminder") : scrubText(String(e.text ?? ""), id) };
        break;
      default:
        event = scrubValue(e, id, level) as Record<string, unknown>;
    }
    events.push({ ts: entry.ts, seq: entry.seq, event: event as RolloutEntry["event"] });
  }
  const removed = [
    "API keys, tokens and passwords",
    "your user name, computer name, email addresses and phone numbers",
    "where your files live (paths are relative to <workspace> and ~)",
    "streamed text and typing deltas (the final messages carry them)",
    ...(level === "private" ? ["the contents of files Ares read or wrote, and every block of code: replaced by a size and a hash", "tool output except the lines that report an error", "Ares's memory and reminders", "Ares's thinking"] : []),
  ];
  return { events, removed };
}
