// Garrison wiring for the Today tab (feed, ideas, tracking) and the media
// tool's voice. Kept out of garrisonCmd.ts so that file only gains a few
// lines: build the surfaces, hand the handler to the phone API, hand the
// daily check to the scheduler.

import { promises as fs } from "node:fs";
import path from "node:path";
import { sideQuery } from "@ares/core";
import type { SessionManager } from "@ares/garrison";
import { setImagineSpeech, type ImagineSpeech } from "@ares/tools";
import { FeedService } from "../lifeFeed.js";
import { IdeasService } from "../lifeIdeas.js";
import { createLifeApi, type LifeApiHandler } from "../lifeApi.js";
import type { ProviderSelection } from "./providers.js";

/** A feed run may research for this long before it is interrupted;
 *  ARES_FEED_TIMEOUT_MS (default 12 minutes). */
function feedTimeoutMs(): number {
  const n = Number(process.env.ARES_FEED_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 12 * 60_000;
}

interface FeedSessionFile {
  id?: string;
}

/**
 * Run one turn on the feed's dedicated garrison session and resolve with the
 * final assistant text. ONE session, reused every day (its id persists in
 * feed/session.json): a new session per edition would add a row to the
 * owner's session list every morning. Text before a tool call is narration,
 * so the buffer restarts at each tool_start — what's left is the answer.
 */
export async function runFeedTurn(sessions: SessionManager, home: string, text: string, timeoutMs = feedTimeoutMs()): Promise<string> {
  const file = path.join(home, "feed", "session.json");
  const saved = await fs.readFile(file, "utf8").then((raw) => (JSON.parse(raw) as FeedSessionFile).id).catch(() => undefined);
  let id = saved && (await sessions.ensureLive(saved).catch(() => null)) ? saved : undefined;
  if (!id) {
    id = sessions.create({ surface: "headless", tenant: { role: "owner" } }).id;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ id } satisfies FeedSessionFile) + "\n", "utf8");
  }
  let buffer = "";
  const detach = sessions.attach(id, (event) => {
    if (event.type === "text_delta") buffer += event.text;
    else if (event.type === "tool_start") buffer = "";
  });
  const sessionId = id;
  const timer = setTimeout(() => {
    try {
      sessions.interrupt(sessionId);
    } catch {
      // already gone
    }
  }, timeoutMs);
  timer.unref?.();
  try {
    await sessions.send(sessionId, text);
  } finally {
    clearTimeout(timer);
    detach();
  }
  return buffer;
}

export async function feedSessionId(home: string): Promise<string | undefined> {
  return fs.readFile(path.join(home, "feed", "session.json"), "utf8").then((raw) => (JSON.parse(raw) as FeedSessionFile).id).catch(() => undefined);
}

/** The "summarize" slot: the provider's cheap sub-model when it has one, else
 *  a bounded side query on the main model with thinking off — the same
 *  choice compaction makes (makeSpanSummarizer). */
export function summarizeSlotCompletion(selection: () => ProviderSelection) {
  return async (system: string, user: string, signal: AbortSignal): Promise<string> => {
    const current = selection();
    if (current.subModel?.summarize) return current.subModel.summarize({ input: user, instructions: system, signal });
    return sideQuery({ provider: current.provider, model: current.model, system, user, maxOutputTokens: 1_500, reasoningLevel: "off", signal, timeoutMs: 45_000 });
  };
}

export interface LifeSurfaces {
  handler: LifeApiHandler;
  feed: FeedService;
  ideas: IdeasService;
}

export function startLifeSurfaces(opts: {
  home: string;
  sessions: SessionManager;
  selection: () => ProviderSelection;
  speech?: ImagineSpeech;
  log: (line: string) => void;
}): LifeSurfaces {
  if (opts.speech) setImagineSpeech(opts.speech);
  const feed = new FeedService({
    home: opts.home,
    runTurn: (text) => runFeedTurn(opts.sessions, opts.home, text),
    log: opts.log,
  });
  let feedId: string | undefined;
  void feedSessionId(opts.home).then((id) => { feedId = id; });
  const ideas = new IdeasService({
    home: opts.home,
    complete: summarizeSlotCompletion(opts.selection),
    skipIds: () => new Set(feedId ? [feedId] : []),
    log: opts.log,
  });
  return { handler: createLifeApi({ home: opts.home, feed, ideas }), feed, ideas };
}
