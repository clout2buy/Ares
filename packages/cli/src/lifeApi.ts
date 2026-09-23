// The phone's Today tab: /gateway/tracking, /gateway/feed, /gateway/ideas.
//
// RemoteAgentServer authenticates the request (Bearer = gateway token) and
// hands anything it doesn't route itself to this handler, which answers the
// routes it owns and returns false for the rest. Keeping the logic here keeps
// the shared server file to a one-line seam. The response shapes are a
// contract with the app — change them only together with ~/ares-app.

import type { IncomingMessage, ServerResponse } from "node:http";
import { TrackingStore } from "@ares/tools";
import type { FeedService } from "./lifeFeed.js";
import type { IdeasService } from "./lifeIdeas.js";

export type LifeApiHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

export interface LifeApiOptions {
  home: string;
  feed?: FeedService;
  ideas?: IdeasService;
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

export function createLifeApi(opts: LifeApiOptions): LifeApiHandler {
  const tracking = new TrackingStore(opts.home);
  return async (req, res, url) => {
    const json = (status: number, body: unknown): true => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
      return true;
    };
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /gateway/tracking": {
          return json(200, { items: await tracking.forPhone() });
        }
        case "POST /gateway/tracking/close": {
          const body = await readJsonBody(req, 4 * 1024);
          const id = typeof body.id === "string" ? body.id.trim() : "";
          const status = body.status === "cancelled" ? "cancelled" : body.status === "done" || body.status === undefined ? "done" : null;
          if (!id) return json(400, { error: "id required" });
          if (!status) return json(400, { error: "status must be done or cancelled" });
          const item = await tracking.close(id, status);
          if (!item) return json(404, { error: "no such item" });
          return json(200, { ok: true });
        }
        case "GET /gateway/feed": {
          if (!opts.feed) return json(501, { error: "the feed is not running on this machine" });
          return json(200, await opts.feed.snapshot());
        }
        case "PUT /gateway/feed/prompt": {
          if (!opts.feed) return json(501, { error: "the feed is not running on this machine" });
          const body = await readJsonBody(req, 16 * 1024);
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          if (!prompt) return json(400, { error: "prompt required" });
          await opts.feed.setPrompt(prompt);
          return json(200, { ok: true });
        }
        case "POST /gateway/feed/refresh": {
          if (!opts.feed) return json(501, { error: "the feed is not running on this machine" });
          opts.feed.refresh();
          return json(200, { ok: true });
        }
        case "GET /gateway/ideas": {
          if (!opts.ideas) return json(501, { error: "ideas are not running on this machine" });
          return json(200, { ideas: await opts.ideas.get() });
        }
        default:
          return false;
      }
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (!res.headersSent) json(status, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
  };
}
