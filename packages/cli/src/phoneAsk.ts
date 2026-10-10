// /gateway/ask — "Hey Siri, ask Ares …". One synchronous question from the
// phone, answered in words that read well aloud, inside Siri's ~25 s limit.
//
//   POST /gateway/ask       {text, surface?, session?}
//        200 { reply, status: "done" | "working", sessionId }
//        400 bad body · 429 a DIFFERENT ask is still running · 503 no brain
//   GET  /gateway/ask/last  { reply?, status, at? }   the last voice answer
//
// The question is an ordinary user turn on ONE dedicated, persistent owner
// session (title "Voice", surface "mobile"), created on first use and reused so
// Ares keeps context between asks. Nothing here reimplements a turn: it calls
// SessionManager.send and listens to the same event stream every surface does.
//
// Each ask carries a short hidden "(System: …)" steering note — the same
// mechanism Telegram uses — so the model answers in one to three spoken
// sentences. Every consumer that shows a transcript already strips a leading
// "(System: …)" preamble (personas.stripPreamble, the garrison's title healer).
//
// One exception to "every ask is a turn": "what's my briefing" (and its close
// spellings, see matchBriefingRequest) is answered from the briefing the garrison
// already wrote today (phoneBriefings.ts), with no model call and no session.
// When there is no briefing for today it falls through to an ordinary turn.
//
// Nothing is weakened: permission prompts, the remote-autonomy gate, the owner
// pause and the kill switch all sit below SessionManager.send and still apply.
// A turn that outlives the budget (a slow tool, a pause, an approval nobody
// answered) is NOT aborted — the caller just gets "working" and the eventual
// answer lands in /gateway/ask/last and in the app.

import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TurnEvent } from "@ares/protocol";

export const ASK_DEFAULT_BUDGET_MS = 22_000;
export const ASK_MAX_BUDGET_MS = 28_000;
export const ASK_MAX_TEXT = 2_000;
export const ASK_REPLY_CAP = 600;
/** A stored briefing is read out whole, so it gets a longer cap than a model reply. */
export const BRIEFING_REPLY_CAP = 900;
export const VOICE_SESSION_TITLE = "Voice";
export const WORKING_REPLY = "Still working on it. I'll keep going, check the app for the result.";
export const FAILED_REPLY = "Sorry, I couldn't get an answer just now. Check the app.";
export const STOPPED_REPLY = "I've been stopped, so I didn't do that.";
const CODE_REPLY = "I put the code in the app.";

/** The slice of SessionManager this endpoint drives (tests pass a fake). */
export interface AskSessionHost {
  create(opts: { surface?: "mobile"; title?: string }): { id: string };
  ensureLive(sessionId: string): Promise<unknown | null>;
  attach(sessionId: string, subscriber: (event: TurnEvent) => void): () => void;
  send(sessionId: string, text: string, options?: { inputId?: string }): Promise<void>;
}

export interface AskApiOptions {
  home: string;
  /** false/string = no provider or brain is available right now (→ 503). */
  available?: () => boolean | string;
  log?: (line: string) => void;
  now?: () => number;
  /** Overrides ARES_ASK_BUDGET_MS (still clamped to the hard max). */
  budgetMs?: number;
  /** Today's stored briefing, so a request for it needs no model call. Absent → asked like anything else. */
  briefing?: {
    today(kind?: "morning" | "evening"): Promise<{ id: string; spokenText: string } | undefined>;
  };
}

export type AskStatus = "done" | "working";
interface LastAnswer { reply?: string; status: AskStatus; at?: number }
interface AskRun { text: string; startedAt: number; result: Promise<string>; settled: boolean }

// ─── steering ─────────────────────────────────────────────────────────────

/** The hidden note that rides in front of every voice ask. Balanced parens
 *  only at the ends: the strippers scan parentheses, so none inside. */
export function voiceSteeringNote(surface: string = "siri"): string {
  return (
    `(System: The owner just asked this out loud through ${surface === "siri" ? "Siri" : `their phone's ${surface}`}; your reply is read aloud by a voice. ` +
    "Answer in one to three short spoken sentences. No markdown, no lists, no code, no links, no emoji. " +
    "Say numbers, dates and times the way a person says them. Lead with the answer. " +
    "If the answer is long or needs the screen, give the short version and offer to continue in the app. " +
    "You may use your tools if the question needs them, but do not narrate them. Your normal permission rules still apply unchanged.)"
  );
}

export function withVoiceSteering(text: string, surface?: string): string {
  return `${voiceSteeringNote(surface)}\n\n${text}`;
}

// ─── "what's my briefing" ─────────────────────────────────────────────────

const BRIEFING_LEAD = "(?:(?:hey |ok |okay )?ares[, ]+)?(?:please |can you |could you |would you |will you |go ahead and )*";
const BRIEFING_ASK = "(?:what is |what are |whats |what were |tell me |give me |give me a |read me |read out |read |play |show me |get me |i want |i need |let me hear |lets hear |start )?";
const BRIEFING_DET = "(?:my |the |todays |today )?";
const BRIEFING_KIND = "(?:(morning|evening|daily|todays) )?";
const BRIEFING_TAIL = "(?: for today| today| please| now| again)*";
const BRIEFING_RE = new RegExp(`^${BRIEFING_LEAD}${BRIEFING_ASK}${BRIEFING_DET}${BRIEFING_KIND}briefing${BRIEFING_TAIL}$`);
const BRIEF_ME_RE = /^(?:please )?brief me(?: please| now)?$/;

/** Is this utterance JUST a request for the owner's briefing? Strict on purpose:
 *  anything with an extra clause ("…and email it to Bob", "…on AI news") is a
 *  normal question and goes to the model. `kind` is set when they named one. */
export function matchBriefingRequest(text: string): { kind?: "morning" | "evening" } | null {
  if (typeof text !== "string" || text.length > 80) return null;
  const t = text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  if (BRIEF_ME_RE.test(t)) return {};
  const m = BRIEFING_RE.exec(t);
  if (!m) return null;
  const kind = m[1];
  return kind === "morning" || kind === "evening" ? { kind } : {};
}

// ─── plain speakable text ─────────────────────────────────────────────────

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "a link";
  }
}

function sentence(line: string): string {
  const t = line.trim();
  return /[.!?:;]["')\]]?$/.test(t) ? t : `${t}.`;
}

/** Convert a model reply into text a voice can read: no markdown, no fences,
 *  no URLs, no emoji, lists as sentences, at most ~600 chars at a sentence end. */
export function toSpeakable(input: string, cap: number = ASK_REPLY_CAP): string {
  let text = input.replace(/\r\n?/g, "\n");
  // Code: a fenced block (or an unterminated one) is never read out.
  let hadFence = false;
  text = text.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[^\n]*(?=\n|$)|$)/g, (_m, lead: string) => {
    hadFence = true;
    return `${lead}\u0000CODE\u0000`;
  });
  text = text.replace(/<[^>\n]+>/g, " ");
  // Images and links: keep the words, drop the address.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => alt);
  text = text.replace(/\[([^\]]+)\]\(([^)\s]*)[^)]*\)/g, (_m, label: string) => label);
  text = text.replace(/\bhttps?:\/\/[^\s)>\]]+/gi, (u) => {
    const tail = /[.,;:!?]+$/.exec(u)?.[0] ?? "";
    return domainOf(tail ? u.slice(0, -tail.length) : u) + tail;
  });
  text = text.replace(/\bwww\.[^\s)>\]]+/gi, (u) => u.replace(/^www\./i, "").split(/[/?#]/)[0] ?? u);
  text = text.replace(/`([^`\n]*)`/g, "$1");

  const out: string[] = [];
  let table = false;
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line) { out.push(""); table = false; continue; }
    if (line === "\u0000CODE\u0000") { out.push(line); continue; }
    if (/^([-*_=]\s*){3,}$/.test(line)) continue; // rule
    if (/^\|?[\s:|-]{3,}\|?$/.test(line) && line.includes("-")) { table = true; continue; } // table divider
    line = line.replace(/^#{1,6}\s+/, "").replace(/^>+\s?/, "");
    const bullet = /^([-*+•]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (bullet) line = sentence(bullet[2] ?? "");
    if (line.includes("|") && (table || /^\|.*\|$/.test(line))) {
      line = sentence(line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", "));
    }
    out.push(line);
  }
  text = out.join("\n");
  text = text.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a?: string, b?: string) => a ?? b ?? "");
  text = text.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2");
  text = text.replace(/~~([^~]+)~~/g, "$1").replace(/[*_~]{2,}/g, "");
  text = text.replace(EMOJI, "");
  // Paragraph and line breaks become sentence breaks.
  const paragraphs = text.split(/\n{2,}/).map((p) => p.split("\n").map((l) => l.trim()).filter(Boolean).join(" ")).filter(Boolean);
  text = paragraphs.join(" ");
  text = text.replace(/(\u0000CODE\u0000\s*)+/g, hadFence ? `${CODE_REPLY} ` : "").replace(/\u0000/g, "");
  text = text.replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  if (!text && hadFence) text = CODE_REPLY;
  return clampAtSentence(text, cap);
}

function clampAtSentence(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, cap);
  const ends = [...head.matchAll(/[.!?](?=["')\]]?(?:\s|$))/g)];
  const last = ends[ends.length - 1];
  if (last && last.index !== undefined && last.index + 1 >= cap * 0.35) return head.slice(0, last.index + 1).trim();
  const space = head.lastIndexOf(" ");
  return `${(space > cap * 0.5 ? head.slice(0, space) : head).replace(/[,;:\s]+$/, "")}.`;
}

// ─── the endpoint ─────────────────────────────────────────────────────────

function budgetFor(opts: AskApiOptions): number {
  const raw = opts.budgetMs ?? Number(process.env.ARES_ASK_BUDGET_MS);
  const ms = Number.isFinite(raw) && raw > 0 ? raw : ASK_DEFAULT_BUDGET_MS;
  return Math.min(ASK_MAX_BUDGET_MS, Math.max(10, Math.floor(ms)));
}

class BadAsk extends Error {}

function parseBody(body: unknown): { text: string; surface: string; session?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadAsk("body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.text !== "string") throw new BadAsk("text must be a string");
  const text = b.text.trim();
  if (text.length < 1) throw new BadAsk("text must not be empty");
  if (text.length > ASK_MAX_TEXT) throw new BadAsk(`text must be at most ${ASK_MAX_TEXT} characters`);
  let surface = "siri";
  if (b.surface !== undefined) {
    if (b.surface !== "siri" && b.surface !== "shortcut" && b.surface !== "widget") throw new BadAsk("surface must be siri, shortcut or widget");
    surface = b.surface;
  }
  if (b.session !== undefined && (typeof b.session !== "string" || b.session.length > 128)) throw new BadAsk("session must be a string of at most 128 characters");
  return { text, surface, ...(typeof b.session === "string" ? { session: b.session } : {}) };
}

/** Authentication is the caller's (handlePhoneApi's owner bearer check runs
 *  before any hook); this handler only ever sees an authenticated owner. */
export function createAskApi(host: AskSessionHost, opts: AskApiOptions) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const stateFile = path.join(opts.home, "voice-ask.json");
  let sessionId: string | undefined;
  let last: LastAnswer = { status: "done" };
  let loaded = false;
  let run: AskRun | null = null;

  const load = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const saved = JSON.parse(await fs.readFile(stateFile, "utf8")) as { sessionId?: unknown; last?: LastAnswer };
      if (typeof saved.sessionId === "string") sessionId = saved.sessionId;
      if (saved.last && typeof saved.last === "object" && typeof saved.last.reply === "string") {
        last = { reply: saved.last.reply.slice(0, ASK_REPLY_CAP + 50), status: "done", ...(typeof saved.last.at === "number" ? { at: saved.last.at } : {}) };
      }
    } catch { /* first use */ }
  };
  // Saves are serialized and atomic (temp + rename): the session id and the
  // last answer are written from two places and read back after a restart.
  let saving: Promise<void> = Promise.resolve();
  const save = () => {
    saving = saving
      .then(async () => {
        await fs.mkdir(opts.home, { recursive: true });
        const tmp = `${stateFile}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify({ sessionId, last }) + "\n", "utf8");
        await fs.rename(tmp, stateFile);
      })
      .catch(() => undefined);
    return saving;
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
    res.end(text);
  };

  const readJson = async (req: IncomingMessage, limit = 16 * 1024): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > limit) throw new BadAsk("request body too large");
      chunks.push(chunk as Buffer);
    }
    if (total === 0) throw new BadAsk("body must be JSON");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new BadAsk("body must be valid JSON");
    }
  };

  const ensureSession = async (): Promise<string> => {
    await load();
    if (sessionId) {
      const live = await host.ensureLive(sessionId).catch(() => null);
      if (live) return sessionId;
    }
    sessionId = host.create({ surface: "mobile", title: VOICE_SESSION_TITLE }).id;
    await save();
    return sessionId;
  };

  /** Start the turn; resolves with the speakable reply when it finishes. */
  const startRun = async (id: string, text: string, surface: string): Promise<AskRun> => {
    let segment = "";
    let previous = "";
    let failure = "";
    const detach = host.attach(id, (event) => {
      if (event.type === "text_delta") segment += event.text;
      else if (event.type === "tool_start") {
        // What was said before a tool ran is narration; the answer is what
        // comes after the last one (kept as a fallback if nothing follows).
        if (segment.trim()) previous = segment;
        segment = "";
      } else if (event.type === "error") failure = event.error.message ?? "";
    });
    const r: AskRun = { text, startedAt: now(), settled: false, result: Promise.resolve("") };
    r.result = host
      .send(id, withVoiceSteering(text, surface), { inputId: `ask_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` })
      .then(
        () => {
          const spoken = toSpeakable(segment.trim() ? segment : previous);
          if (spoken) return spoken;
          if (failure) log(`ask: turn produced no text (${failure.slice(0, 160)})`);
          return FAILED_REPLY;
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log(`ask: send failed (${message.slice(0, 200)})`);
          if (/stopped by owner/i.test(message)) return STOPPED_REPLY;
          throw err;
        },
      )
      .then((reply) => {
        last = { reply, status: "done", at: now() };
        void save();
        return reply;
      })
      .finally(() => {
        detach();
        r.settled = true;
        if (run === r) run = null;
      });
    // The turn outliving its caller must never become an unhandled rejection.
    r.result.catch(() => undefined);
    return r;
  };

  const race = async (r: AskRun, ms: number): Promise<{ reply: string } | "working"> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        r.result.then((reply) => ({ reply })),
        new Promise<"working">((resolve) => { timer = setTimeout(() => resolve("working"), ms); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const normalize = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

  async function ask(res: ServerResponse, req: IncomingMessage): Promise<void> {
    let body: { text: string; surface: string; session?: string };
    try {
      body = parseBody(await readJson(req));
    } catch (err) {
      if (err instanceof BadAsk) return send(res, 400, { error: err.message });
      throw err;
    }
    await load();
    // A stored briefing answers "what's my briefing" with no model call and no
    // session. Anything it cannot answer (none today, lookup failed) is asked normally.
    const wanted = opts.briefing ? matchBriefingRequest(body.text) : null;
    if (wanted && opts.briefing) {
      const card = await opts.briefing.today(wanted.kind).catch(() => undefined);
      const reply = card?.spokenText ? toSpeakable(card.spokenText, BRIEFING_REPLY_CAP) : "";
      if (card && reply) {
        last = { reply, status: "done", at: now() };
        void save();
        return send(res, 200, { reply, status: "done", sessionId: sessionId ?? "", source: "briefing", briefingId: card.id });
      }
    }
    const budget = budgetFor(opts);
    if (run && !run.settled) {
      const id = sessionId ?? "";
      if (normalize(run.text) !== normalize(body.text)) {
        return send(res, 429, { error: "a previous ask is still running", status: "working", reply: WORKING_REPLY, sessionId: id });
      }
      // A retry of the same question (Siri re-sends on a slow tunnel): wait on
      // the turn already running rather than starting a second one.
      const again = await race(run, budget);
      return send(res, 200, again === "working" ? { reply: WORKING_REPLY, status: "working", sessionId: id } : { reply: again.reply, status: "done", sessionId: id });
    }
    const why = opts.available?.();
    if (why === false || typeof why === "string") {
      return send(res, 503, { error: typeof why === "string" && why ? why : "no model is available right now" });
    }
    let id: string;
    let r: AskRun;
    try {
      id = await ensureSession();
      r = await startRun(id, body.text, body.surface);
      run = r;
    } catch (err) {
      log(`ask: could not start (${err instanceof Error ? err.message : String(err)})`);
      return send(res, 503, { error: err instanceof Error ? err.message.slice(0, 200) : "could not start the turn" });
    }
    let outcome: { reply: string } | "working";
    try {
      outcome = await race(r, budget);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "SessionBusyError") return send(res, 429, { error: "a previous ask is still running", status: "working", reply: WORKING_REPLY, sessionId: id });
      return send(res, 503, { error: err instanceof Error ? err.message.slice(0, 200) : "the turn failed to start" });
    }
    if (outcome === "working") return send(res, 200, { reply: WORKING_REPLY, status: "working", sessionId: id });
    return send(res, 200, { reply: outcome.reply, status: "done", sessionId: id });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname.replace(/\/+$/, "");
    if (p !== "/gateway/ask" && p !== "/gateway/ask/last") return false;
    try {
      if (p === "/gateway/ask/last") {
        if (req.method !== "GET") return send(res, 405, { error: "method not allowed" }), true;
        await load();
        const working = run && !run.settled;
        // While a question is in flight the previous answer would be a lie.
        return send(res, 200, working ? { status: "working", at: run!.startedAt } : last.reply !== undefined ? last : { status: "done" }), true;
      }
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
      await ask(res, req);
    } catch (err) {
      log(`ask: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) send(res, 500, { error: "ask failed" });
    }
    return true;
  };
}
