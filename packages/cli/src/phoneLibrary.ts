// /gateway/goals and /gateway/artifacts — the Goals tab and the
// Artifacts | Media library.
//
// Mounted inside RemoteAgentServer.handlePhoneApi AFTER its bearer check.
// Shapes (the app is built against these):
//
//   GET  /gateway/goals          200 {goals:[{id,title,category,status,progress?,target?,plan?,note?,nextCheckIn?,createdAt,updatedAt}]}
//   POST /gateway/goals/close    {id, status:"done"|"dropped"} → 200 {ok:true} · 404 unknown
//   GET  /gateway/artifacts      200 {items:[{path,name,kind,size,modifiedAt}]} newest first
//
// Artifacts are the things Ares MADE — pages, documents, images, audio,
// video — found under its media and forge dirs and the workspace it builds
// in. Every listed path is one /gateway/file will actually serve (the caller
// passes that exact rule in as `servable`), so a tap never 404s and the
// library can never list something the file server would refuse (secrets,
// .git, node_modules, browser sessions).

import { promises as fs } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GoalsStore } from "@ares/tools";

export type ArtifactKind = "page" | "document" | "image" | "video" | "audio";

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  ".html": "page",
  ".htm": "page",
  ".pdf": "document",
  ".md": "document",
  ".txt": "document",
  ".csv": "document",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".svg": "image",
  ".mp4": "video",
  ".mp3": "audio",
};

const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", "dist", ".next", "build", ".cache", "coverage", ".turbo", "screenshots", "browser-profile", "browser-sessions", "garrison", "sessions", "tool-results", "checkpoints"]);
const MAX_ITEMS = 300;
const MAX_FILES_SCANNED = 20_000;

export interface ArtifactItem {
  path: string;
  name: string;
  kind: ArtifactKind;
  size: number;
  modifiedAt: string;
}

export interface LibraryOptions {
  /** Where Ares puts what it makes: [dir, maxDepth][] */
  roots: Array<[string, number]>;
  /** The file server's own rule — only list what it will serve. */
  servable: (absPath: string) => boolean;
  home?: string;
}

export async function listArtifacts(opts: LibraryOptions): Promise<ArtifactItem[]> {
  const found = new Map<string, ArtifactItem>();
  let scanned = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (scanned > MAX_FILES_SCANNED) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      scanned += 1;
      if (entry.name.startsWith(".") && entry.name !== ".ares") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0 && !SKIP_DIRS.has(entry.name)) await walk(full, depth - 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = KIND_BY_EXT[path.extname(entry.name).toLowerCase()];
      if (!kind || found.has(full) || !opts.servable(full)) continue;
      // Docs the repo ships (README, CHANGELOG, AGENTS…) aren't things Ares made.
      if (kind === "document" && /^(readme|changelog|license|agents|claude|ares|contributing|security)\b/i.test(entry.name)) continue;
      try {
        const st = await fs.stat(full);
        if (st.size === 0) continue;
        found.set(full, { path: full, name: entry.name, kind, size: st.size, modifiedAt: st.mtime.toISOString() });
      } catch {
        // vanished mid-scan
      }
    }
  };
  for (const [root, depth] of opts.roots) await walk(root, depth);
  return [...found.values()].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, MAX_ITEMS);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function handleLibraryApi(req: IncomingMessage, res: ServerResponse, url: URL, opts: LibraryOptions): Promise<boolean> {
  const route = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
  if (!["GET /gateway/goals", "POST /gateway/goals/close", "GET /gateway/artifacts"].includes(route)) return false;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  try {
    if (route === "GET /gateway/goals") {
      json(200, { goals: await new GoalsStore(opts.home).list() });
    } else if (route === "POST /gateway/goals/close") {
      const body = await readJson(req);
      const id = typeof body.id === "string" ? body.id : "";
      const status = body.status === "dropped" ? "dropped" : "done";
      const ok = await new GoalsStore(opts.home).mutate((goals) => {
        const goal = goals.find((g) => g.id === id);
        if (!goal) return false;
        goal.status = status;
        if (status === "done") goal.progress = 1;
        delete goal.nextCheckIn;
        goal.updatedAt = new Date().toISOString();
        return true;
      });
      json(ok ? 200 : 404, ok ? { ok: true } : { error: "unknown goal" });
    } else {
      json(200, { items: await listArtifacts(opts) });
    }
  } catch (err) {
    json(500, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}
