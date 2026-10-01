// /gateway/file and /gateway/shot — what the phone is handed when it opens
// something Ares made: a page, a render, a clip, a voice note, a document.
//
// Three jobs live here so remoteAgentServer.ts keeps only the routing:
//
//   1. WHAT may be served: the extension table (ARTIFACT_TYPES) and the rule
//      that decides whether one path may leave the machine (mayServe).
//   2. HOW it is served: streamed, never buffered, with HTTP Range (206),
//      HEAD, and the client-abort cleanup that AVPlayer needs — it will not
//      start a progressive mp4 against a server that answers 200 with the
//      whole body and no Accept-Ranges.
//   3. The sandbox a served PAGE runs in (PAGE_CSP).
//
// The containment rules (roots, NEVER_SERVE, symlink re-check) are unchanged
// from when they lived in remoteAgentServer.ts; they only moved.

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";

/** Plain text, shown not run: served as text/plain so a webview can never
 *  execute it, whatever the extension says (`.js`, `.ts`, `.sh`, `.xml`…). */
const TEXT_PLAIN = "text/plain; charset=utf-8";

const CODE_EXTS = [
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".lua", ".sql", ".sh", ".bash", ".zsh", ".ps1",
  ".css", ".scss",
];

/** What /gateway/file will hand a phone, by extension: things you LOOK at.
 *  Anything else is 404 — the owner's token is not a licence to read
 *  arbitrary files. */
export const ARTIFACT_TYPES: Record<string, string> = {
  // ── pages (sandboxed by PAGE_CSP) and images ──
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  // ── documents ──
  ".pdf": "application/pdf",
  ".txt": TEXT_PLAIN,
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // ── what Imagine makes (media/<date>/…): speech, podcasts, video clips ──
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".caf": "audio/x-caf",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".3gp": "video/3gpp",
  ".webm": "video/webm",
  // ── 3D ──
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".usdz": "model/vnd.usdz+zip",
  // ── data, code, archives (RESTRICTED_EXTS: not served from the Ares home itself) ──
  ".json": "application/json; charset=utf-8",
  ".jsonl": TEXT_PLAIN,
  ".ndjson": TEXT_PLAIN,
  ".log": TEXT_PLAIN,
  ".xml": TEXT_PLAIN,
  ".yaml": TEXT_PLAIN,
  ".yml": TEXT_PLAIN,
  ".toml": TEXT_PLAIN,
  ".zip": "application/zip",
  ...Object.fromEntries(CODE_EXTS.map((ext) => [ext, TEXT_PLAIN])),
};

/** The kinds of file that can carry machine secrets (tokens, sessions, config,
 *  logs). Files of these kinds are served from everywhere an artifact root
 *  reaches EXCEPT the Ares home proper: ~/.ares holds auth.json,
 *  kimi-auth.json, remote-devices.json, vaults… and "a token that opens the
 *  house must not open those". Under the home only media/, forge/ and
 *  screenshots/ — the places Ares puts things it MADE — are open to them. */
const RESTRICTED_EXTS = new Set<string>([
  ".json", ".jsonl", ".ndjson", ".log", ".xml", ".yaml", ".yml", ".toml", ".zip", ...CODE_EXTS,
]);

/** The subdirectories of the Ares home where made things go. */
const HOME_MADE_DIRS = ["media", "forge", "screenshots"];

/** Places under an artifact root that hold secrets or machinery, never
 *  artifacts — refused whatever the extension. The workspace is a root now
 *  (Ares builds pages there), and the workspace holds the signing key dir,
 *  a .git, and node_modules. */
// browser-sessions holds live sign-in cookies (Connect → browser); never serve it.
export const NEVER_SERVE = /(^|[\\/])(\.git|node_modules|asc|\.ssh|\.gnupg|garrison|browser-sessions|browser-profile)([\\/]|$)|(^|[\\/])[^\\/]*\.(env|pem|p8|p12|key|mobileprovision)$|credentials\.json$|ui\.json$/i;

export function insideAny(wanted: string, roots: string[]): boolean {
  if (NEVER_SERVE.test(wanted)) return false;
  return roots.map((r) => path.resolve(r)).some((root) => wanted === root || wanted.startsWith(root + path.sep));
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** The home-proper guard for RESTRICTED_EXTS. True when `p` is not in the Ares
 *  home, or is in one of its made-things dirs, or is in a root that merely
 *  happens to live under the home (a workspace kept at ~/.ares/workspace). A
 *  workspace that CONTAINS the home (workspace = $HOME) does not exempt it. */
function restrictedLocationOk(p: string, roots: string[], home: string): boolean {
  const h = path.resolve(home);
  if (!within(p, h)) return true;
  const exempt = [
    ...HOME_MADE_DIRS.map((d) => path.join(h, d)),
    ...roots.map((r) => path.resolve(r)).filter((r) => r !== h && within(r, h)),
  ];
  return insideAny(p, exempt);
}

/** The whole rule for one path: a type we show, under a root, NEVER_SERVE-clean,
 *  and — for data/code/archives — not in the Ares home proper. */
export function mayServe(wanted: string, roots: string[], home?: string): boolean {
  const ext = path.extname(wanted).toLowerCase();
  if (!ARTIFACT_TYPES[ext]) return false;
  if (!insideAny(wanted, roots)) return false;
  if (home && RESTRICTED_EXTS.has(ext) && !restrictedLocationOk(wanted, roots, home)) return false;
  return true;
}

/** The second look, after symlinks are followed: `real` must still be inside a
 *  root, and a link that points INTO the home may not smuggle out a restricted
 *  file under an innocent name (`bait.png` → ~/.ares/auth.json). */
export function realPathOk(real: string, roots: string[], home?: string): boolean {
  if (!insideAny(real, roots)) return false;
  if (home && RESTRICTED_EXTS.has(path.extname(real).toLowerCase()) && !restrictedLocationOk(real, roots, home)) return false;
  return true;
}

/**
 * The sandbox a page Ares wrote runs in on the phone. It may draw (WebGL,
 * canvas, inline scripts) but never phone home: no connect-src, no external
 * script/style/font, no frames, no objects — default-src 'none' covers all of
 * those.
 *
 * img-src / media-src allow 'self' so a page Ares made can show its SIBLING
 * picture, audio or video (`<img src="cat.png">`, `<video src="clip.mp4">`)
 * served from this same server. That is image/media loading only: there is no
 * script-src 'self', so a sibling .js can never run, and no connect-src, so
 * nothing can be fetched or posted; 'self' also cannot name a foreign origin,
 * so nothing can be sent out. The path on this origin is still gated by the
 * server (bearer, roots, NEVER_SERVE, symlink re-check) — the CSP widens what
 * the page may REQUEST, not what the server will ANSWER. Relative URLs only
 * resolve to a sibling when the page is opened at a path-shaped URL, hence
 * GET /gateway/file/<absolute path> alongside ?path=.
 */
export const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src data:; connect-src 'none'";

/**
 * Largest file /gateway/file will stream (4 GiB). The old handler buffered the
 * whole file in the Node heap with no cap at all; streaming makes size a
 * bandwidth question instead of a memory one, so this is only a sanity ceiling
 * (a runaway render, a mis-pointed path in a world-writable root) — far above
 * any video Ares makes. Over the cap is 413, not a silent truncation.
 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;

export type ByteRange = { start: number; end: number };

/**
 * Parse a Range header against a file of `size` bytes (RFC 9110 §14).
 *   - null            → serve the whole file (no header, another unit, a
 *                       malformed spec, or several ranges — all of which the
 *                       RFC lets a server answer with a plain 200);
 *   - "unsatisfiable" → 416;
 *   - {start,end}     → 206, inclusive, end clamped to the last byte.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (header === undefined) return null;
  const m = /^\s*bytes\s*=\s*(.*)$/i.exec(header);
  if (!m) return null;
  const specs = (m[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (specs.length !== 1) return null; // none is malformed; many = multipart/byteranges, not offered
  const spec = /^(\d{0,15})-(\d{0,15})$/.exec(specs[0] ?? "");
  if (!spec) return null;
  const [, first = "", last = ""] = spec;
  if (first === "" && last === "") return null;
  if (first === "") {
    // Suffix: the last n bytes (a suffix longer than the file is the whole file).
    const n = Number(last);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return null; // invalid spec: ignore the header
  if (start >= size) return "unsatisfiable";
  return { start, end: last === "" ? size - 1 : Math.min(Number(last), size - 1) };
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
}

/**
 * Stream one already-vetted file. The caller has done the path work (roots,
 * NEVER_SERVE, realpath); `real` is the symlink-free path and `type` its
 * content type. Returns "missing" when nothing was written because the file
 * could not be opened as a regular file (caller answers 404), "sent" otherwise.
 *
 * The file is opened once and every decision after that — size, regular-file
 * check, the bytes — is made on that descriptor, so a swap between the check
 * and the read cannot change what is sent. O_NOFOLLOW refuses a last-moment
 * symlink; O_NONBLOCK keeps a FIFO someone planted from blocking the open
 * (it is then rejected as not-a-regular-file).
 */
export async function serveFile(req: IncomingMessage, res: ServerResponse, real: string, type: string): Promise<"sent" | "missing"> {
  let fh: FileHandle;
  try {
    fh = await open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return "missing";
  }
  let closed = false;
  const closeHandle = () => { if (!closed) { closed = true; void fh.close().catch(() => {}); } };
  try {
    const st = await fh.stat();
    if (!st.isFile()) { closeHandle(); return "missing"; }
    const size = st.size;
    if (size > MAX_FILE_BYTES) {
      closeHandle();
      sendJson(req, res, 413, { error: "file too large" });
      return "sent";
    }

    const lastModified = st.mtime.toUTCString();
    const etag = `"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers: Record<string, string | number> = {
      "content-type": type,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=60",
      "last-modified": lastModified,
      etag,
      // Never let a viewer second-guess the type: a served .js is text, a served
      // .json is data, whatever a sniffer thinks the bytes look like.
      "x-content-type-options": "nosniff",
    };
    // A page Ares wrote runs in the phone's viewer with no network: it may draw
    // (WebGL, canvas, inline scripts) but never phone home. SVG is a document
    // that can carry script too, so it gets the same box.
    if (type.startsWith("text/html") || type === "image/svg+xml") headers["content-security-policy"] = PAGE_CSP;

    let range = parseRange(firstHeader(req.headers.range), size);
    // If-Range: honour the range only if the validator still matches; otherwise
    // the client's partial copy is stale and it gets the whole, current file.
    const ifRange = firstHeader(req.headers["if-range"]);
    if (range && range !== "unsatisfiable" && ifRange !== undefined && ifRange !== etag && ifRange !== lastModified) range = null;

    if (range === "unsatisfiable") {
      closeHandle();
      sendJson(req, res, 416, { error: "range not satisfiable" }, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
      return "sent";
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
    headers["content-length"] = length;
    res.writeHead(range ? 206 : 200, headers);

    if (req.method === "HEAD" || length === 0) {
      closeHandle();
      res.end();
      return "sent";
    }
    // The stream owns the handle from here (autoClose). pipeline() is what makes
    // a dropped client release it: when `res` closes early the source is
    // destroyed, which closes the descriptor — a phone that backgrounds the app
    // mid-video must not leave one open per abandoned request.
    const stream = fh.createReadStream({ start, end });
    closed = true;
    pipeline(stream, res, () => { /* premature close / mid-read error: pipeline already tore both ends down */ });
    return "sent";
  } catch (err) {
    closeHandle();
    if (!res.headersSent) { sendJson(req, res, 404, { error: "not found" }); return "sent"; }
    res.destroy(err instanceof Error ? err : undefined);
    return "sent";
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
