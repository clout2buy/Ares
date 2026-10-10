// /gateway/avatars and /gateway/avatar/<id> — an agent's picture on the phone.
//
// Mounted inside RemoteAgentServer.handlePhoneApi AFTER its bearer check (via
// the phoneApi.avatars hook), so every route is owner-only. The app is built
// against these shapes — do not change them:
//
//   GET    /gateway/avatars
//          200 {max, types:["image/jpeg","image/png","image/webp"],
//               avatars:[{id,contentType,bytes,version,updatedAt}]}
//          Also the app's capability probe: a box without this 404s it.
//   GET    /gateway/avatar/<id>
//          200 the image bytes (ETag "<version>", If-None-Match honoured → 304)
//          404 {error, code:"no_avatar"}
//   PUT    /gateway/avatar/<id>          (POST is accepted too)
//          body: the raw image bytes, OR JSON {"image":"data:image/<t>;base64,<b64>"}
//          (content-type application/json; a bare base64 string also works)
//          200 {avatar:{id,contentType,bytes,version,updatedAt}}
//          413 too_large · 415 unsupported_type · 400 bad_image / bad_id
//          404 unknown_agent (not a persona and not "ares")
//   DELETE /gateway/avatar/<id>   and   POST /gateway/avatar/<id>/delete
//          200 {ok:true, removed:boolean} — idempotent, unknown ids included
//
// Errors are {error, code}. The generic router 404 carries no code, which is
// how the app tells "unknown agent" from "this box has no avatar endpoint".
//
// Trust nothing the client says about the file: the type is sniffed from the
// decoded bytes (JPEG, PNG or WebP magic, nothing else — no SVG, which can
// carry script), the extension on disk comes from that sniff only, and the
// declared content-type / filename never matter. Bytes are served back with a
// sandboxing CSP and nosniff so even a mislabelled file can't run in a viewer.
//
// Storage is <home>/phone/avatars/<id>.<jpg|png|webp>, one file per agent,
// written tmp + rename. A small in-memory index (id -> ext, size, version)
// is loaded once at boot so the persona list can stamp its `avatar` version
// synchronously.

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** base64 is 4/3 of the image; the slack covers the JSON wrapper, the data:
 *  prefix and MIME-style line wrapping (escaped CRLFs). */
const JSON_BODY_LIMIT = Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 256 * 1024;
/** After the cap is hit, keep discarding (never buffering) this much more so the
 *  client reads our 413 instead of a reset; past it the connection is dropped. */
const DISCARD_MAX_BYTES = 8 * 1024 * 1024;
const DISCARD_MAX_MS = 10_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FILE_RE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.(jpg|png|webp)$/;

type Ext = "jpg" | "png" | "webp";
const EXTS: Ext[] = ["jpg", "png", "webp"];
const TYPE_OF: Record<Ext, (typeof AVATAR_TYPES)[number]> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export interface AvatarMeta {
  id: string;
  contentType: string;
  bytes: number;
  version: string;
  updatedAt: string;
}

export type AvatarErrorCode = "bad_id" | "too_large" | "unsupported_type";

export class AvatarError extends Error {
  readonly code: AvatarErrorCode;
  constructor(code: AvatarErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The image kind from the leading bytes, or null. The only source of truth
 *  for the stored type. */
export function detectImage(bytes: Uint8Array): { ext: Ext; contentType: string } | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", contentType: TYPE_OF.jpg };
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return { ext: "png", contentType: TYPE_OF.png };
  // RIFF <4-byte size> WEBP
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return { ext: "webp", contentType: TYPE_OF.webp };
  return null;
}

function versionOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

interface Entry {
  id: string;
  ext: Ext;
  bytes: number;
  version: string;
  mtimeMs: number;
}

function metaOf(e: Entry): AvatarMeta {
  return { id: e.id, contentType: TYPE_OF[e.ext], bytes: e.bytes, version: e.version, updatedAt: new Date(e.mtimeMs).toISOString() };
}

/** What the HTTP layer needs from a store (tests and the persona runtime pass
 *  fakes or the real one). */
export interface AvatarStoreLike {
  list(): AvatarMeta[];
  meta(id: string): AvatarMeta | undefined;
  read(id: string): Promise<{ meta: AvatarMeta; bytes: Buffer } | undefined>;
  put(id: string, bytes: Buffer): Promise<AvatarMeta>;
  remove(id: string): Promise<boolean>;
}

export class AvatarStore implements AvatarStoreLike {
  readonly dir: string;
  private readonly index = new Map<string, Entry>();
  private readonly now: () => Date;
  /** Writes are serialized so the index and the directory can't disagree. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(home: string, opts: { now?: () => Date } = {}) {
    this.dir = path.resolve(home, "phone", "avatars");
    this.now = opts.now ?? (() => new Date());
  }

  /** Index what is on disk. Unreadable, oversized or mislabelled files are
   *  skipped, never served; leftover tmp files from a crash are swept. */
  async load(): Promise<void> {
    this.index.clear();
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (/^\..*\.tmp$/.test(name)) {
        await fs.rm(path.join(this.dir, name), { force: true }).catch(() => undefined);
        continue;
      }
      const m = FILE_RE.exec(name);
      if (!m) continue;
      const id = m[1]!;
      const ext = m[2] as Ext;
      try {
        const full = this.fileFor(id, ext);
        const st = await fs.lstat(full);
        if (!st.isFile() || st.size === 0 || st.size > AVATAR_MAX_BYTES) continue;
        const bytes = await fs.readFile(full);
        if (detectImage(bytes)?.ext !== ext) continue;
        const entry: Entry = { id, ext, bytes: bytes.length, version: versionOf(bytes), mtimeMs: st.mtimeMs };
        const prior = this.index.get(id);
        if (!prior || entry.mtimeMs > prior.mtimeMs) this.index.set(id, entry);
      } catch {
        // an unreadable file never blocks boot
      }
    }
  }

  list(): AvatarMeta[] {
    return [...this.index.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(metaOf);
  }

  meta(id: string): AvatarMeta | undefined {
    const e = this.index.get(id);
    return e ? metaOf(e) : undefined;
  }

  /** Sync: the current version of an agent's picture, for the persona list. */
  version(id: string): string | undefined {
    return this.index.get(id)?.version;
  }

  /** The bytes, re-verified against the file itself: the type, size and version
   *  reported always describe exactly what is returned. */
  async read(id: string): Promise<{ meta: AvatarMeta; bytes: Buffer } | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const e = this.index.get(id);
      if (!e) return undefined;
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(this.fileFor(id, e.ext));
      } catch {
        // Replaced under us (a put finished): look again. Otherwise it is gone.
        if (this.index.get(id) !== e) continue;
        this.index.delete(id);
        return undefined;
      }
      if (detectImage(bytes)?.ext !== e.ext || bytes.length > AVATAR_MAX_BYTES) {
        if (this.index.get(id) === e) this.index.delete(id);
        return undefined;
      }
      let current = e;
      const version = versionOf(bytes);
      if (version !== e.version || bytes.length !== e.bytes) {
        current = { ...e, bytes: bytes.length, version };
        if (this.index.get(id) === e) this.index.set(id, current);
      }
      return { meta: metaOf(current), bytes };
    }
    return undefined;
  }

  put(id: string, bytes: Buffer): Promise<AvatarMeta> {
    return this.serial(async () => {
      if (bytes.length > AVATAR_MAX_BYTES) throw new AvatarError("too_large", "image is larger than 2 MiB");
      const kind = detectImage(bytes);
      if (!kind) throw new AvatarError("unsupported_type", "not a JPEG, PNG or WebP image");
      const final = this.fileFor(id, kind.ext);
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fs.chmod(this.dir, 0o700).catch(() => undefined);
      const tmp = path.join(this.dir, `.${id}.${randomBytes(6).toString("hex")}.tmp`);
      try {
        await fs.writeFile(tmp, bytes, { mode: 0o600, flag: "wx" });
        await fs.rename(tmp, final);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      // Index first, then drop the other-extension sibling: a GET holding the
      // old entry retries against the new one instead of finding nothing.
      const entry: Entry = { id, ext: kind.ext, bytes: bytes.length, version: versionOf(bytes), mtimeMs: this.now().getTime() };
      this.index.set(id, entry);
      for (const other of EXTS) if (other !== kind.ext) await fs.rm(this.fileFor(id, other), { force: true }).catch(() => undefined);
      return metaOf(entry);
    });
  }

  /** true when there was a picture to remove. Only ever touches an id the
   *  index knows, so a differently-cased id can't reach another agent's file
   *  on a case-insensitive filesystem. */
  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      if (!ID_RE.test(id) || !this.index.has(id)) return false;
      this.index.delete(id);
      for (const ext of EXTS) await fs.rm(this.fileFor(id, ext), { force: true }).catch(() => undefined);
      return true;
    });
  }

  /** The one place a path is built: a valid id and a fixed extension, and then
   *  a check that the result is still directly inside the avatars directory. */
  private fileFor(id: string, ext: Ext): string {
    if (!ID_RE.test(id)) throw new AvatarError("bad_id", "invalid agent id");
    const full = path.resolve(this.dir, `${id}.${ext}`);
    if (path.dirname(full) !== this.dir || !full.startsWith(this.dir + path.sep)) throw new AvatarError("bad_id", "invalid agent id");
    return full;
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

export interface AvatarsApiDeps {
  store: AvatarStoreLike;
  /** True for "ares" and every saved persona: only those can hold a picture. */
  known: (id: string) => boolean;
  log?: (line: string) => void;
}

type BodyRead = { ok: true; bytes: Buffer } | { ok: false; reason: "too_large" | "aborted" };

/**
 * Collect a request body up to `limit` bytes. Past the limit nothing more is
 * kept: what was held is dropped and the rest is read-and-discarded (bounded
 * in bytes and time) so the caller can answer 413 on a connection the client
 * is still writing to. A raw `for await` would destroy the socket on the way
 * out, and the client would see a reset instead of the answer.
 */
function readBounded(req: IncomingMessage, limit: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let kept = 0;
    let seen = 0;
    let over = false;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: BodyRead) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      chunks = [];
      resolve(r);
    };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) over = true;
    const startDiscard = () => {
      over = true;
      chunks = [];
      kept = 0;
      timer ??= setTimeout(() => finish({ ok: false, reason: "too_large" }), DISCARD_MAX_MS);
    };
    if (over) startDiscard();
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      seen += chunk.length;
      if (!over && kept + chunk.length > limit) startDiscard();
      if (!over) {
        chunks.push(chunk);
        kept += chunk.length;
        return;
      }
      if (seen > limit + DISCARD_MAX_BYTES) finish({ ok: false, reason: "too_large" });
    });
    req.on("end", () => finish(over ? { ok: false, reason: "too_large" } : { ok: true, bytes: Buffer.concat(chunks, kept) }));
    req.on("error", () => finish({ ok: false, reason: "aborted" }));
    req.on("close", () => finish(over ? { ok: false, reason: "too_large" } : { ok: false, reason: "aborted" }));
    if (req.destroyed) finish({ ok: false, reason: "aborted" });
  });
}

class BadImage extends Error {}

/** The image bytes out of a JSON body: {"image":"data:image/<t>;base64,<b64>"}
 *  or {"image":"<b64>"}. The declared type is ignored; the bytes decide. */
function decodeJsonImage(raw: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BadImage("body must be JSON like {\"image\":\"data:image/jpeg;base64,...\"}");
  }
  const image = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).image : undefined;
  if (typeof image !== "string") throw new BadImage("image (base64 string) required");
  let b64 = image.trim();
  if (/^data:/i.test(b64)) {
    const m = /^data:[^,]*;base64,/i.exec(b64);
    if (!m) throw new BadImage("image must be a base64 data URI");
    b64 = b64.slice(m[0].length);
  }
  b64 = b64.replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1 || (b64.includes("=") && b64.length % 4 !== 0)) {
    throw new BadImage("image is not valid base64");
  }
  const unpadded = b64.replace(/=+$/, "").length;
  if (Math.floor((unpadded * 3) / 4) > AVATAR_MAX_BYTES) throw new AvatarError("too_large", "image is larger than 2 MiB");
  return Buffer.from(b64, "base64");
}

function etagMatches(header: string | undefined, version: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === `"${version}"`);
}

/**
 * Handle /gateway/avatars and /gateway/avatar/*. Returns false when the path
 * isn't ours. The caller has ALREADY verified the bearer token. Never throws:
 * the server awaits this outside its own try/catch.
 */
export async function handleAvatarsApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: AvatarsApiDeps): Promise<boolean> {
  const p = url.pathname;
  const isList = p === "/gateway/avatars" || p === "/gateway/avatars/";
  if (!isList && !p.startsWith("/gateway/avatar/")) return false;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const fail = (status: number, code: string, error: string, headers?: Record<string, string>) => json(status, { error, code }, headers);
  const methodNotAllowed = (allow: string) => fail(405, "method_not_allowed", "method not allowed", { allow });
  const method = req.method ?? "GET";
  try {
    if (isList) {
      if (method !== "GET") { methodNotAllowed("GET"); return true; }
      json(200, { max: AVATAR_MAX_BYTES, types: [...AVATAR_TYPES], avatars: deps.store.list() });
      return true;
    }

    // <id> or <id>/delete. Anything else under /gateway/avatar/ (slashes, an
    // empty id) is a malformed id, not a missing endpoint.
    const segs = p.slice("/gateway/avatar/".length).replace(/\/$/, "").split("/");
    const isDeleteRoute = segs.length === 2 && segs[1] === "delete";
    let id = "";
    if (segs.length === 1 || isDeleteRoute) {
      try { id = decodeURIComponent(segs[0]!); } catch { id = ""; }
    }
    if (!ID_RE.test(id)) { fail(400, "bad_id", "invalid agent id"); return true; }

    if (isDeleteRoute) {
      if (method !== "POST") { methodNotAllowed("POST"); return true; }
      const removed = await deps.store.remove(id);
      if (removed) deps.log?.(`avatars: removed ${id}`);
      json(200, { ok: true, removed });
      return true;
    }

    if (method === "GET") {
      const meta = deps.store.meta(id);
      if (!meta) { fail(404, "no_avatar", "no avatar for this agent"); return true; }
      const common = {
        etag: `"${meta.version}"`,
        "cache-control": "private, no-cache",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      };
      if (etagMatches(req.headers["if-none-match"], meta.version)) {
        res.writeHead(304, common);
        res.end();
        return true;
      }
      const found = await deps.store.read(id);
      if (!found) { fail(404, "no_avatar", "no avatar for this agent"); return true; }
      res.writeHead(200, { ...common, etag: `"${found.meta.version}"`, "content-type": found.meta.contentType, "content-length": found.bytes.length });
      res.end(found.bytes);
      return true;
    }

    if (method === "DELETE") {
      const removed = await deps.store.remove(id);
      if (removed) deps.log?.(`avatars: removed ${id}`);
      json(200, { ok: true, removed });
      return true;
    }

    if (method !== "PUT" && method !== "POST") { methodNotAllowed("GET, PUT, POST, DELETE"); return true; }

    if (!deps.known(id)) { fail(404, "unknown_agent", `unknown agent: ${id.slice(0, 40)}`); return true; }

    // JSON only when it says so; anything else is taken as the raw image and
    // judged by its bytes, so a mislabelled upload still works and a bad one
    // still fails on content, never on a header.
    const ctype = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const asJson = ctype === "application/json";
    const body = await readBounded(req, asJson ? JSON_BODY_LIMIT : AVATAR_MAX_BYTES);
    if (!body.ok) {
      if (body.reason === "too_large") fail(413, "too_large", "image is larger than 2 MiB", { connection: "close" });
      return true;
    }
    let bytes: Buffer;
    try {
      bytes = asJson ? decodeJsonImage(body.bytes) : body.bytes;
    } catch (err) {
      if (err instanceof AvatarError) { fail(413, "too_large", err.message); return true; }
      if (err instanceof BadImage) { fail(400, "bad_image", err.message); return true; }
      throw err;
    }
    if (bytes.length === 0) {
      fail(415, "unsupported_type", "empty image");
      return true;
    }
    try {
      const avatar = await deps.store.put(id, bytes);
      deps.log?.(`avatars: set ${id} (${avatar.contentType}, ${avatar.bytes} bytes)`);
      json(200, { avatar });
    } catch (err) {
      if (err instanceof AvatarError) {
        if (err.code === "too_large") fail(413, "too_large", err.message);
        else fail(415, "unsupported_type", "unsupported image type: use JPEG, PNG or WebP");
        return true;
      }
      throw err;
    }
    return true;
  } catch (err) {
    deps.log?.(`avatars ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) json(500, { error: "internal error", code: "internal" });
    return true;
  }
}

/** The hook RemoteAgentServer's phoneApi.avatars expects. */
export function createAvatarsApi(deps: AvatarsApiDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  return (req, res, url) => handleAvatarsApi(req, res, url, deps);
}
