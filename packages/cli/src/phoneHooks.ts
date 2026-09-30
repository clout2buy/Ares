// /gateway/hooks — inbound webhooks, and the phone's view of them.
//
//   POST   /gateway/hooks/<id>        THE DOOR. Unauthenticated by the owner's
//                                     bearer on purpose — the outside world
//                                     (a Shortcut, GitHub, cron, IFTTT) calls
//                                     it with the hook's own secret.
//                                     202 {ok, event} · 401 · 404 · 413 · 429
//   GET    /gateway/hooks             owner: {hooks[], baseUrl?, configured}
//   POST   /gateway/hooks             owner: {name, auth?, personaId?, template?, maxKb?, ratePerMin?}
//                                     201 {hook, secret?, recipe}  (secret shown ONCE)
//   DELETE /gateway/hooks/<id>        owner: {ok}
//   GET    /gateway/hooks/recent      owner: {events[]}  (what the door did lately)
//
// `inbound` is mounted BEFORE the bearer check in RemoteAgentServer and claims
// only `POST /gateway/hooks/<id>`; everything else on the path falls through to
// the bearer check and then to `manage`. The door's rules (authentication,
// replay, limits, the fence) live in @ares/tools hooksStore.ts. What this file
// adds is the HTTP: bounded reads, source rate limits, and the decision that an
// unknown id costs the same as a known one.

import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_MAX_BYTES,
  HOOK_ID_RE,
  ReplayCache,
  WindowLimiter,
  appendHookAudit,
  createHook,
  deleteHook,
  findHook,
  forgetHookSecret,
  listHooks,
  loadHookSecret,
  publicHook,
  recentHookAudit,
  renderHookTurn,
  setupRecipe,
  verifyHookAuth,
  type HookAuditEntry,
  type HookDef,
} from "@ares/tools";

export interface HooksApiOptions {
  home?: string;
  /** The public origin (the tunnel), for the URLs shown to the owner. */
  baseUrl: () => string | undefined;
  /** Start the turn. Resolves once it is admitted; the door does not wait for the turn to finish. */
  fire: (hook: HookDef, text: string, inputId: string) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
}

export interface HooksApi {
  inbound(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  manage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Counters for tests and diagnostics. */
  stats: { accepted: number; refused: number; dummyVerifications: number };
}

const PER_SOURCE_PER_MIN = 120;
const MISSES_PER_SOURCE_PER_MIN = 10;
const GLOBAL_PER_MIN = 1200;
const FORWARDED_HEADERS = ["content-type", "user-agent", "x-github-event", "x-github-delivery", "x-gitlab-event", "x-shopify-topic", "x-event-type", "x-request-id"];

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(text);
}

/** The address the request really came from: the tunnel's own connection is loopback, so trust its forwarded header only then. */
function sourceOf(req: IncomingMessage): string {
  const socketIp = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  if (socketIp === "127.0.0.1" || socketIp === "::1") {
    const forwarded = String(req.headers["cf-connecting-ip"] ?? String(req.headers["x-forwarded-for"] ?? "").split(",")[0] ?? "").trim();
    if (forwarded && net.isIP(forwarded)) return forwarded;
  }
  return socketIp;
}

async function readLimited(req: IncomingMessage, limit: number): Promise<{ ok: true; body: Buffer } | { ok: false }> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) return { ok: false };
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limit) return { ok: false };
    chunks.push(chunk as Buffer);
  }
  return { ok: true, body: Buffer.concat(chunks) };
}

export function createHooksApi(opts: HooksApiOptions): HooksApi {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const replay = new ReplayCache(now);
  const sourceLimiter = new WindowLimiter(60_000, now);
  const missLimiter = new WindowLimiter(60_000, now);
  const hookLimiter = new WindowLimiter(60_000, now);
  const globalLimiter = new WindowLimiter(60_000, now);
  const stats = { accepted: 0, refused: 0, dummyVerifications: 0 };
  const audit = (entry: Omit<HookAuditEntry, "ts">) => appendHookAudit({ ts: new Date(now()).toISOString(), ...entry }, opts.home);

  // The stand-in a request for an unknown id is verified against: same work, never succeeds.
  const dummyHook: Pick<HookDef, "auth" | "bearerHash"> = { auth: "bearer", bearerHash: undefined };
  const dummyHmacHook: Pick<HookDef, "auth" | "bearerHash"> = { auth: "hmac" };

  async function inbound(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method !== "POST") return false;
    const rest = url.pathname.replace(/^\/gateway\/hooks\//, "");
    if (!url.pathname.startsWith("/gateway/hooks/") || !rest || rest.includes("/") || rest === "recent") return false;
    const id = rest;
    const src = sourceOf(req);

    // 1. Who may even be heard: per-source and global limits, before any work.
    const wait = sourceLimiter.hit(src, PER_SOURCE_PER_MIN) || globalLimiter.hit("*", GLOBAL_PER_MIN);
    if (wait) {
      stats.refused++;
      send(res, 429, { error: "too many requests" }, { "retry-after": String(wait), connection: "close" });
      void audit({ result: "source_limited", src });
      req.destroy();
      return true;
    }

    // 2. Read the body (bounded) whatever the id is: an unknown id costs the same.
    const known = HOOK_ID_RE.test(id) ? await findHook(id, opts.home) : undefined;
    const limit = known?.maxBytes ?? DEFAULT_MAX_BYTES;
    const read = await readLimited(req, limit);
    if (!read.ok) {
      stats.refused++;
      send(res, 413, { error: "payload too large" }, { connection: "close" });
      void audit({ hook: known?.name, result: "oversize", src });
      req.destroy();
      return true;
    }
    const body = read.body;

    // 3. Authenticate — for an unknown id, against a stand-in, so the time is the same.
    let verdict;
    if (known) {
      const secret = known.auth === "hmac" ? await loadHookSecret(known, opts.home) : undefined;
      verdict = verifyHookAuth(known, secret, req.headers, body, replay, now());
    } else {
      stats.dummyVerifications++;
      await loadHookSecret({ id: "unknown-id-placeholder-0000" } as HookDef, opts.home); // same (cached) vault touch a real hmac hook makes
      const probe = req.headers["x-ares-signature"] || req.headers["x-hub-signature-256"] ? dummyHmacHook : dummyHook;
      verifyHookAuth(probe, "no-such-secret", req.headers, body, new ReplayCache(now), now());
      verdict = { ok: false as const, reason: "unknown" as const };
    }
    if (!verdict.ok) {
      const missWait = missLimiter.hit(src, MISSES_PER_SOURCE_PER_MIN);
      stats.refused++;
      if (verdict.reason === "unknown") {
        send(res, 404, { error: "not found" }, missWait ? { "retry-after": String(missWait) } : {});
        void audit({ result: "unknown", src, bytes: body.length, detail: createHash("sha256").update(id).digest("hex").slice(0, 8) });
      } else {
        send(res, 401, { error: "unauthorized", reason: verdict.reason });
        void audit({ hook: known!.name, result: verdict.reason, src, bytes: body.length });
      }
      return true;
    }
    const hook = known!;

    // 4. The hook's own rate limit (only for authenticated callers, so strangers cannot spend it).
    const hookWait = hookLimiter.hit(hook.id, hook.ratePerMin);
    if (hookWait) {
      stats.refused++;
      send(res, 429, { error: "this hook is rate limited" }, { "retry-after": String(hookWait) });
      void audit({ hook: hook.name, result: "rate_limited", src, bytes: body.length });
      return true;
    }

    // 5. Admit: fence the payload, start the turn, answer at once.
    const event = `evt_${randomBytes(6).toString("hex")}`;
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const v = req.headers[name];
      if (typeof v === "string" && v) headers[name] = v.slice(0, 300);
    }
    const query: Record<string, string> = {};
    let q = 0;
    for (const [k, v] of url.searchParams) {
      if (q++ >= 20) break;
      query[k.slice(0, 60)] = v.slice(0, 500);
    }
    const text = renderHookTurn(hook, {
      body: body.toString("utf8"),
      ...(typeof req.headers["content-type"] === "string" ? { contentType: req.headers["content-type"] } : {}),
      query,
      headers,
      receivedAt: new Date(now()),
    });
    stats.accepted++;
    void audit({ hook: hook.name, result: "accepted", src, bytes: body.length, event });
    send(res, 202, { ok: true, event });
    void opts
      .fire(hook, text, `hook_${hook.id.slice(0, 8)}_${event}`)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`hooks: firing ${hook.name} (${event}) failed: ${message}`);
        void audit({ hook: hook.name, result: "fire_failed", event, detail: message.slice(0, 200) });
      });
    return true;
  }

  async function manage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/gateway/hooks" && !url.pathname.startsWith("/gateway/hooks/")) return false;
    const rest = url.pathname.replace(/^\/gateway\/hooks\/?/, "");
    try {
      if (!rest) {
        if (req.method === "GET") {
          const base = opts.baseUrl();
          send(res, 200, { hooks: (await listHooks(opts.home)).map((h) => publicHook(h, base)), configured: Boolean(base), ...(base ? { baseUrl: base } : {}) });
          return true;
        }
        if (req.method === "POST") {
          const read = await readLimited(req, 16 * 1024);
          if (!read.ok) return send(res, 413, { error: "request too large" }), true;
          let body: Record<string, unknown> = {};
          try {
            const parsed: unknown = read.body.length ? JSON.parse(read.body.toString("utf8")) : {};
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
          } catch {
            return send(res, 400, { error: "body must be JSON" }), true;
          }
          const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
          const auth = str(body.auth, 10);
          if (auth && !["bearer", "hmac", "url"].includes(auth)) return send(res, 400, { error: "auth must be bearer, hmac or url" }), true;
          const created = await createHook(
            {
              name: str(body.name, 80) ?? "",
              ...(auth ? { auth: auth as "bearer" | "hmac" | "url" } : {}),
              personaId: str(body.personaId, 80),
              template: str(body.template, 4000),
              maxBytes: typeof body.maxKb === "number" ? body.maxKb * 1024 : undefined,
              ratePerMin: typeof body.ratePerMin === "number" ? body.ratePerMin : undefined,
            },
            opts.home,
          );
          const base = opts.baseUrl();
          log(`hooks: created "${created.hook.name}" (${created.hook.auth}) from the phone`);
          send(res, 201, { hook: publicHook(created.hook, base), ...(created.secret ? { secret: created.secret } : {}), recipe: setupRecipe(created.hook, base, created.secret), configured: Boolean(base) });
          return true;
        }
        return send(res, 405, { error: "method not allowed" }), true;
      }
      if (rest === "recent" && req.method === "GET") {
        send(res, 200, { events: await recentHookAudit(Number(url.searchParams.get("limit")) || 30, opts.home) });
        return true;
      }
      if (req.method === "DELETE" && !rest.includes("/")) {
        const removed = await deleteHook(rest, opts.home);
        if (removed) forgetHookSecret(removed.id);
        if (!removed) return send(res, 404, { error: "not found" }), true;
        log(`hooks: deleted "${removed.name}" from the phone`);
        send(res, 200, { ok: true });
        return true;
      }
      return send(res, 405, { error: "method not allowed" }), true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Validation problems (name taken, bad template) are the caller's; say so.
      const status = /hook name|already exists|template|limit is|auth must/.test(message) ? 400 : 500;
      if (status === 500) log(`hooks: ${req.method} ${url.pathname} failed: ${message}`);
      send(res, status, { error: message.slice(0, 300) });
      return true;
    }
  }

  return { inbound, manage, stats };
}

// ─── Firing a turn ───────────────────────────────────────────────────────────

/** The slice of SessionManager the firer drives (structural; see personaRuntime.ts). */
export interface HookSessionHost {
  create(opts: { surface?: "mobile"; tenant?: { role: "owner" }; personaId?: string }): { id: string };
  ensureLive(sessionId: string): Promise<unknown | null>;
  send(sessionId: string, text: string, options?: { inputId?: string }): Promise<void>;
}

export interface HookPersonas {
  store: { get(id: string): { sessionId?: string } | undefined };
  defaultThread(): Promise<string | undefined>;
}

/**
 * Turn a hook event into a turn in the right thread: the hook's agent, or the
 * main phone thread. The same owner-role mobile session a phone message lands
 * in — so the remote permission posture applies (anything dangerous asks the
 * owner's phone) — with the payload already fenced by renderHookTurn.
 */
export function makeHookFirer(deps: { sessions: HookSessionHost; personas: HookPersonas }): (hook: HookDef, text: string, inputId: string) => Promise<void> {
  return async (hook, text, inputId) => {
    let sessionId: string | undefined;
    if (hook.personaId) {
      const persona = deps.personas.store.get(hook.personaId);
      if (!persona) throw new Error(`agent ${hook.personaId} no longer exists`);
      sessionId = persona.sessionId ?? deps.sessions.create({ surface: "mobile", tenant: { role: "owner" }, personaId: hook.personaId }).id;
    } else {
      sessionId = (await deps.personas.defaultThread()) ?? deps.sessions.create({ surface: "mobile", tenant: { role: "owner" } }).id;
    }
    const live = await deps.sessions.ensureLive(sessionId);
    if (!live) throw new Error("the target thread could not be opened");
    await deps.sessions.send(sessionId, text, { inputId });
  };
}
