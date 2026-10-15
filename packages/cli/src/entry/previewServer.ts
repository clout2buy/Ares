// Static preview server: "open it in the Forge" for a project FOLDER.
//
// A file:// preview only works for a page that is self-contained. Anything
// real — <script type="module">, an import map, a root-relative asset, a
// relative fetch() — breaks under file:// (and under the desktop's asset
// protocol, which is what the Forge's Live tab turns a file:// target into).
// Field case (runestone, 2026-10-15): "open it in ur forge" rendered a grey
// page because the entry imported modules by path. The owner's bar: if a
// thing needs hosting for both of us to see it in the Forge, host it.
//
// So a local file handed to Browser preview/open is served from its folder on
// 127.0.0.1 and the http URL is what gets opened. One server per folder root,
// ephemeral port, loopback only, no directory listing, no traversal, no
// caching. The Forge embeds localhost origins directly.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "text/plain; charset=utf-8",
  ".mtl": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".xml": "application/xml; charset=utf-8",
  ".pdf": "application/pdf",
};

export interface ServedFolder {
  root: string;
  origin: string;
  server: Server;
}

const servers = new Map<string, Promise<ServedFolder>>();

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Map a request path to a file under root, or null when it escapes root. */
function resolveUnderRoot(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]!.split("#")[0]!);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

async function handle(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let file = resolveUnderRoot(root, req.url ?? "/");
  if (!file) {
    res.writeHead(403).end();
    return;
  }
  let stat = await fs.stat(file).catch(() => null);
  if (stat?.isDirectory()) {
    file = path.join(file, "index.html");
    stat = await fs.stat(file).catch(() => null);
  }
  if (!stat?.isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`not found under ${path.basename(root)}: ${req.url}`);
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

/** Serve `root` on 127.0.0.1 (one server per folder, reused across calls). */
export function serveFolder(root: string): Promise<ServedFolder> {
  const key = canonicalRoot(root);
  const existing = servers.get(key);
  if (existing) return existing;
  const started = new Promise<ServedFolder>((resolve, reject) => {
    const absRoot = path.resolve(root);
    const server = createServer((req, res) => {
      void handle(absRoot, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.on("error", (err) => {
      servers.delete(key);
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      // Never keep the daemon alive on our account; the server lives as long
      // as the process does and dies with it.
      server.unref();
      resolve({ root: absRoot, origin: `http://127.0.0.1:${port}`, server });
    });
  });
  servers.set(key, started);
  return started;
}

/** Local file or folder reference → { path, query } or null for anything else. */
function localTarget(input: string): { fsPath: string; suffix: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return { fsPath: fileURLToPath(url), suffix: `${url.search}${url.hash}` };
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-zA-Z]:[\\/]/.test(trimmed)) return null; // http:, data:, about: …
  if (path.isAbsolute(trimmed)) return { fsPath: trimmed, suffix: "" };
  return null;
}

export interface ServedTarget {
  url: string;
  root: string;
  origin: string;
}

/**
 * Turn a local file/folder reference into a served http URL. A file is
 * served from its own folder; a folder serves itself (index.html). Anything
 * that is not a local path (http, data, inline temp previews) returns null.
 */
export async function serveLocalTarget(input: string): Promise<ServedTarget | null> {
  const target = localTarget(input);
  if (!target) return null;
  const stat = await fs.stat(target.fsPath).catch(() => null);
  if (!stat) return null;
  const root = stat.isDirectory() ? target.fsPath : path.dirname(target.fsPath);
  const served = await serveFolder(root);
  const rel = stat.isDirectory() ? "" : path.basename(target.fsPath);
  return {
    url: `${served.origin}/${rel.split("/").map(encodeURIComponent).join("/")}${target.suffix}`,
    root: served.root,
    origin: served.origin,
  };
}

/** Close every preview server (tests, daemon shutdown). */
export async function stopPreviewServers(): Promise<void> {
  const open = [...servers.values()];
  servers.clear();
  await Promise.all(
    open.map((p) => p.then((s) => new Promise<void>((r) => s.server.close(() => r()))).catch(() => undefined)),
  );
}
