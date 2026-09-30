// /gateway/instances — the phone's view of the separate Ares instances deployed
// on this Linux host (see @ares/tools aresInstances.ts). Everything here is the
// same operation the Instances tool and `ares instance` perform, behind the
// owner's bearer.
//
//   GET  /gateway/instances                      { supported, reason?, instances[] }
//   POST /gateway/instances {name, purpose?, model?}   202 — deploys in the background
//   POST /gateway/instances/<name>/start|stop|restart  200 { instance }
//   POST /gateway/instances/<name>/remove        200 { message }  (keeps the home; purge is chat-only)
//   GET  /gateway/instances/<name>/pair          200 { link, url } — carries the instance's token
//
// `supported` is false where there is no Docker / passwordless sudo — notably
// inside a guest's container — so the app can hide the feature instead of
// offering something that cannot work. Creation returns at once: a first deploy
// builds an image and can outlast the tunnel's request timeout, so the client
// polls the list, where the instance shows as "creating" until it answers.

import type { IncomingMessage, ServerResponse } from "node:http";
import { validateInstanceName, type InstanceStatus } from "@ares/tools";

export interface InstancesBox {
  preflight(): Promise<unknown>;
  list(): Promise<Array<{ name: string }>>;
  status(name: string): Promise<InstanceStatus>;
  create(opts: { name: string; purpose?: string; model?: string; log?: (line: string) => void }): Promise<InstanceStatus>;
  systemctl(action: "start" | "stop" | "restart", name: string): Promise<InstanceStatus>;
  remove(name: string, purge?: boolean): Promise<string>;
  pair(name: string): Promise<{ link?: string; url?: string; tokenPath: string }>;
}

export interface InstanceView {
  name: string;
  state: "running" | "starting" | "stopped" | "creating" | "failed";
  healthy: boolean;
  purpose?: string;
  provider?: string;
  model?: string;
  url?: string;
  createdAt?: string;
  error?: string;
}

const CAPABILITY_TTL_MS = 30_000;
const FAILURE_KEEP_MS = 10 * 60_000;

function view(s: InstanceStatus): InstanceView {
  const state = s.active === "active" ? (s.healthy ? "running" : "starting") : s.active === "failed" ? "failed" : "stopped";
  return {
    name: s.name,
    state,
    healthy: s.healthy,
    ...(s.purpose ? { purpose: s.purpose } : {}),
    provider: s.provider,
    model: s.model,
    ...(s.url ? { url: s.url } : {}),
    createdAt: s.createdAt,
  };
}

export function createInstancesApi(box: InstancesBox, log: (line: string) => void = () => {}, now: () => number = Date.now) {
  const creating = new Map<string, { startedAt: number; error?: string }>();
  let capability: { at: number; reason: string | null } | null = null;

  const unsupported = async (): Promise<string | null> => {
    if (capability && now() - capability.at < CAPABILITY_TTL_MS) return capability.reason;
    let reason: string | null = null;
    try {
      await box.preflight();
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    capability = { at: now(), reason };
    return reason;
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
    res.end(text);
  };

  const readJson = async (req: IncomingMessage, limit = 8 * 1024): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > limit) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    if (total === 0) return {};
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  };

  const listAll = async (): Promise<InstanceView[]> => {
    const out: InstanceView[] = [];
    for (const meta of await box.list()) {
      if (creating.has(meta.name)) continue;
      try {
        out.push(view(await box.status(meta.name)));
      } catch {
        out.push({ name: meta.name, state: "failed", healthy: false, error: "status unavailable" });
      }
    }
    for (const [name, c] of creating) {
      if (c.error && now() - c.startedAt > FAILURE_KEEP_MS) {
        creating.delete(name);
        continue;
      }
      out.push(c.error ? { name, state: "failed", healthy: false, error: c.error } : { name, state: "creating", healthy: false });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const parts = url.pathname.replace(/^\/gateway\/instances\/?/, "").split("/").filter(Boolean);
    if (!url.pathname.startsWith("/gateway/instances")) return false;
    try {
      if (parts.length === 0) {
        if (req.method === "GET") {
          const reason = await unsupported();
          if (reason) return send(res, 200, { supported: false, reason, instances: [] }), true;
          return send(res, 200, { supported: true, instances: await listAll() }), true;
        }
        if (req.method === "POST") {
          const reason = await unsupported();
          if (reason) return send(res, 409, { error: reason }), true;
          const body = await readJson(req);
          const name = typeof body.name === "string" ? body.name.trim() : "";
          const bad = validateInstanceName(name);
          if (bad) return send(res, 400, { error: bad }), true;
          const purpose = typeof body.purpose === "string" && body.purpose.trim() ? body.purpose.trim().slice(0, 600) : undefined;
          const model = typeof body.model === "string" && /^[A-Za-z0-9._:/-]{1,80}$/.test(body.model) ? body.model : undefined;
          if ([...creating.values()].some((c) => !c.error)) return send(res, 409, { error: "another instance is still being created" }), true;
          // A failed attempt is only a message; it must not lock the name.
          if (creating.get(name)?.error) creating.delete(name);
          if ((await box.list()).some((m) => m.name === name)) return send(res, 409, { error: `instance ${name} already exists — remove it first` }), true;
          creating.set(name, { startedAt: now() });
          void box
            .create({ name, purpose, model, log: (line) => log(`instances: ${name}: ${line}`) })
            .then(() => creating.delete(name))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              log(`instances: creating ${name} failed: ${message}`);
              creating.set(name, { startedAt: now(), error: message.slice(0, 400) });
            });
          return send(res, 202, { name, state: "creating" }), true;
        }
        return send(res, 405, { error: "method not allowed" }), true;
      }

      const name = parts[0];
      const action = parts[1];
      if (validateInstanceName(name)) return send(res, 404, { error: "not found" }), true;
      if (parts.length > 2) return send(res, 404, { error: "not found" }), true;

      if (req.method === "GET" && action === "pair") {
        const reason = await unsupported();
        if (reason) return send(res, 409, { error: reason }), true;
        const pair = await box.pair(name);
        if (!pair.link) return send(res, 409, { error: `${name} has no public address, so the phone cannot reach it` }), true;
        return send(res, 200, { link: pair.link, url: pair.url }), true;
      }
      if (req.method === "POST" && (action === "start" || action === "stop" || action === "restart")) {
        const reason = await unsupported();
        if (reason) return send(res, 409, { error: reason }), true;
        return send(res, 200, { instance: view(await box.systemctl(action, name)) }), true;
      }
      if (req.method === "POST" && action === "remove") {
        const reason = await unsupported();
        if (reason) return send(res, 409, { error: reason }), true;
        return send(res, 200, { message: await box.remove(name, false) }), true;
      }
      return send(res, action ? 405 : 404, { error: action ? "method not allowed" : "not found" }), true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no instance named/.test(message)) return send(res, 404, { error: message }), true;
      log(`instances: ${req.method} ${url.pathname} failed: ${message}`);
      return send(res, 500, { error: message.slice(0, 400) }), true;
    }
  };
}
