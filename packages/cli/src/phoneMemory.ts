// /gateway/memory — "what do you remember about me", on the phone.
//
// The living memory (mind/memory.jsonl, the substrate Mnemosyne is the single
// writer of) made visible and correctable by its owner: list and search what
// Ares holds, see where each thing came from and which agent learned it, fix
// a wrong one, forget one. Mounted inside RemoteAgentServer.handlePhoneApi
// AFTER its bearer check (via the phoneApi.memory hook), so every route is
// owner-only; the owner's pool only — a Telegram guest's memories (guest:*)
// never appear here. Shapes (the app is built against these):
//
//   GET  /gateway/memory?q=&kind=all|semantic|procedural|episodic&limit=&offset=
//        200 {items:[MemoryItem…] newest first, total, counts:{semantic,procedural,episodic},
//             offset, limit, nextOffset?}
//        `total` is the matches for this query; `counts` is the size of memory
//        itself (before any filter), the figures the screen quotes.
//   GET  /gateway/memory/item?id=
//        200 {item} · 404
//   POST /gateway/memory/edit    {id, content}
//        200 {item} · 400 (empty, over 2000 chars) · 404 · 409 (another process holds the memory lock)
//   POST /gateway/memory/forget  {id}
//        200 {ok:true} · 404 · 409
//
//   MemoryItem = {id, kind:"semantic"|"procedural"|"episodic", text, at, editedAt?,
//                 editedByOwner?, uses, confidence?, tags?, redacted?,
//                 source:{kind:"conversation"|"reflection"|"task"|"dreaming"|"synthesis"|"mission"|"other",
//                         label, sessionId?, agentId?, agentName?}}
//
// Secret-shaped text (keys, tokens, card numbers, "password is ...") is
// replaced before it leaves the box; the item says `redacted:true`. Edits and
// forgets go through Mnemosyne's wire when it answers (so the correction is
// made on the store the next recall persists, and cannot be undone by it),
// else directly under the consolidation lock — `ares mind edit`'s own rule.
// Every edit and forget lands in the audit trail (never the text itself).

import type { IncomingMessage, ServerResponse } from "node:http";
import { MemoryStore, OWNER_SCOPE, nodesInScope, withConsolidationLock, type MemoryEditResult, type MemoryKind, type MemoryNode } from "@ares/mind";
import { MEMORY_PAGE_DEFAULT, selectMemories, type MemoryPage, type MemoryQuery } from "@ares/mnemosyne";
import { scrubSecrets } from "./mcpProbe.js";

/** The slice of the Mnemosyne client this module drives (structural, so tests fake it). */
export interface MemoryWire {
  listMemories(query: MemoryQuery): Promise<MemoryPage>;
  editMemory(id: string, content: string): Promise<MemoryEditResult>;
  forgetMemory(id: string): Promise<void>;
}

export interface MemoryApiDeps {
  /** The living-memory file, for the direct path when the wire is not there. */
  memoryFile: string;
  /** The single-writer wire, when reachable. null/absent = go direct. */
  wire?: () => Promise<MemoryWire | null>;
  /** Which agent owns a conversation: a persona, "ares" for the default thread, undefined if unknown. */
  agentOfSession?: (sessionId: string) => { id: string; name?: string } | undefined;
  audit?: (entry: { actor: string; action: string; target?: string; params?: unknown; result?: string }) => void;
  log?: (line: string) => void;
}

export const MEMORY_TEXT_MAX = 2_000;
export const MEMORY_PAGE_LIMIT_MAX = 100;
const QUERY_MAX = 200;

export type MemorySourceKind = "conversation" | "reflection" | "task" | "dreaming" | "synthesis" | "mission" | "other";

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  at: string;
  editedAt?: string;
  editedByOwner?: true;
  uses: number;
  confidence?: number;
  tags?: string[];
  redacted?: true;
  source: { kind: MemorySourceKind; label: string; sessionId?: string; agentId?: string; agentName?: string };
}

// ── Secrets ──────────────────────────────────────────────────────────────────

const EXTRA_SECRET_PATTERNS: RegExp[] = [
  /\b(pass(?:word|code|phrase)?|passwd|pwd|pin|cvv|cvc|secret|api[ _-]?key|token)\b(\s*(?:is|was|=|:)\s*)\S+/gi,
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:\d[ -]?){13,19}\b/g,
];

/** Secret-shaped text out; says whether anything was taken out. */
export function redactMemoryText(text: string): { text: string; redacted: boolean } {
  let out = scrubSecrets(text);
  for (const re of EXTRA_SECRET_PATTERNS) out = out.replace(re, (m, label, sep) => (typeof label === "string" && typeof sep === "string" ? `${label}${sep}[redacted]` : "[redacted]"));
  return { text: out, redacted: out !== text };
}

// ── Provenance ───────────────────────────────────────────────────────────────

const FIXED_SOURCES: Record<string, { kind: MemorySourceKind; label: string }> = {
  "conversation-reflection": { kind: "reflection", label: "Learned while reflecting on a conversation" },
  "after-action": { kind: "task", label: "Learned after finishing a task" },
  synthesis: { kind: "synthesis", label: "Pieced together from several memories" },
  "light-dreaming": { kind: "dreaming", label: "Noticed while idle" },
  "deep-dreaming": { kind: "dreaming", label: "Noticed while idle" },
  "rem-dreaming": { kind: "dreaming", label: "Noticed while idle" },
  mission: { kind: "mission", label: "From a mission" },
};

export function memorySource(node: Pick<MemoryNode, "source">, agentOfSession?: MemoryApiDeps["agentOfSession"]): MemoryItem["source"] {
  const raw = (node.source ?? "").trim().slice(0, 200);
  if (!raw) return { kind: "other", label: "Remembered earlier" };
  const fixed = FIXED_SOURCES[raw];
  if (fixed) return fixed;
  const agent = agentOfSession?.(raw);
  if (agent) {
    return { kind: "conversation", label: "From a conversation", sessionId: raw, agentId: agent.id, ...(agent.name ? { agentName: agent.name } : {}) };
  }
  // Something with a session-shaped id that no live thread owns: an earlier conversation.
  if (/^[A-Za-z0-9_-]{8,}$/.test(raw) && /[0-9]/.test(raw)) return { kind: "conversation", label: "From an earlier conversation", sessionId: raw };
  return { kind: "other", label: "Remembered earlier" };
}

export function memoryItem(node: MemoryNode, agentOfSession?: MemoryApiDeps["agentOfSession"]): MemoryItem {
  const { text, redacted } = redactMemoryText(node.content.slice(0, MEMORY_TEXT_MAX));
  return {
    id: node.id,
    kind: node.kind,
    text,
    at: node.at,
    ...(node.editedAt ? { editedAt: node.editedAt } : {}),
    ...(node.editedBy === "owner" ? { editedByOwner: true as const } : {}),
    uses: node.activations,
    ...(node.confidence !== undefined ? { confidence: node.confidence } : {}),
    ...(node.tags?.length ? { tags: node.tags.slice(0, 8).map((t) => t.slice(0, 40)) } : {}),
    ...(redacted ? { redacted: true as const } : {}),
    source: memorySource(node, agentOfSession),
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

class BadRequest extends Error {}

async function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > limit) throw new BadRequest("body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new BadRequest("body must be JSON"); }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const KINDS = new Set<string>(["semantic", "procedural", "episodic"]);
const ROUTES = new Set(["GET /gateway/memory", "GET /gateway/memory/item", "POST /gateway/memory/edit", "POST /gateway/memory/forget"]);

const notFound = (id: string): Error => Object.assign(new Error(`no memory ${id}`), { code: "not-found" });
const isNotFound = (err: unknown): boolean => (err as { code?: string })?.code === "not-found" || /^no memory\b/.test(err instanceof Error ? err.message : "");

export function createMemoryApi(deps: MemoryApiDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  const audit = (action: string, target: string, params: unknown, result = "ok") => {
    try { deps.audit?.({ actor: "owner", action, target, ...(params !== undefined ? { params } : {}), result }); } catch { /* an observer never breaks a route */ }
  };

  /** The page, via the wire when it answers, else straight off the file. */
  const page = async (q: MemoryQuery): Promise<MemoryPage> => {
    const wire = await deps.wire?.().catch(() => null);
    if (wire) {
      try { return await wire.listMemories(q); } catch (err) { deps.log?.(`memory: wire list failed, reading the file (${err instanceof Error ? err.message : String(err)})`); }
    }
    return selectMemories((await MemoryStore.open(deps.memoryFile)).all(), q);
  };

  const edit = async (id: string, content: string): Promise<MemoryNode> => {
    const wire = await deps.wire?.().catch(() => null);
    if (wire) {
      try { return (await wire.editMemory(id, content)).after; } catch (err) {
        if (isNotFound(err)) throw notFound(id);
        deps.log?.(`memory: wire edit failed, editing the file (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    const store = await MemoryStore.open(deps.memoryFile);
    const result = await withConsolidationLock(deps.memoryFile, () => store.edit(id, content));
    if (result === undefined) {
      if (store.get(id) === undefined) throw notFound(id);
      throw Object.assign(new Error("memory is busy"), { code: "busy" });
    }
    return result.after;
  };

  const forget = async (id: string): Promise<void> => {
    const wire = await deps.wire?.().catch(() => null);
    if (wire) {
      try { await wire.forgetMemory(id); return; } catch (err) {
        if (isNotFound(err)) throw notFound(id);
        deps.log?.(`memory: wire forget failed, editing the file (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    const store = await MemoryStore.open(deps.memoryFile);
    const done = await withConsolidationLock(deps.memoryFile, () => store.forget(id));
    if (done === undefined) {
      if (store.get(id) === undefined) throw notFound(id);
      throw Object.assign(new Error("memory is busy"), { code: "busy" });
    }
    if (!done) throw notFound(id);
  };

  return async (req, res, url) => {
    const route = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
    if (!ROUTES.has(route)) return false;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (route === "GET /gateway/memory") {
        const q = (url.searchParams.get("q") ?? "").trim().slice(0, QUERY_MAX);
        const kind = (url.searchParams.get("kind") ?? "all").trim().toLowerCase();
        if (kind !== "all" && !KINDS.has(kind)) throw new BadRequest("kind must be all, semantic, procedural or episodic");
        const rawLimit = Number(url.searchParams.get("limit") ?? MEMORY_PAGE_DEFAULT);
        const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : MEMORY_PAGE_DEFAULT, 1), MEMORY_PAGE_LIMIT_MAX);
        const rawOffset = Number(url.searchParams.get("offset") ?? 0);
        const offset = Math.max(Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0, 0);
        const result = await page({ scope: OWNER_SCOPE, ...(kind !== "all" ? { kinds: [kind as MemoryKind] } : {}), ...(q ? { query: q } : {}), limit, offset });
        // Belt and braces: whatever answered, only the owner's pool leaves.
        const nodes = nodesInScope(result.nodes, OWNER_SCOPE);
        const next = offset + result.nodes.length;
        json(200, {
          items: nodes.map((n) => memoryItem(n, deps.agentOfSession)),
          total: result.total,
          counts: result.counts,
          offset,
          limit,
          ...(next < result.total ? { nextOffset: next } : {}),
        });
        return true;
      }

      if (route === "GET /gateway/memory/item") {
        const id = (url.searchParams.get("id") ?? "").trim();
        if (!ID.test(id)) throw new BadRequest("id required");
        const store = await MemoryStore.open(deps.memoryFile);
        const node = store.get(id);
        if (!node || nodesInScope([node], OWNER_SCOPE).length === 0) { json(404, { error: "unknown memory" }); return true; }
        json(200, { item: memoryItem(node, deps.agentOfSession) });
        return true;
      }

      const body = await readBody(req);
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!ID.test(id)) throw new BadRequest("id required");

      if (route === "POST /gateway/memory/edit") {
        if (typeof body.content !== "string") throw new BadRequest("content must be text");
        const content = body.content.replace(/\r\n?/g, "\n").trim();
        if (!content) throw new BadRequest("content required (use forget to remove a memory)");
        if (content.length > MEMORY_TEXT_MAX) throw new BadRequest(`content must be at most ${MEMORY_TEXT_MAX} characters`);
        // Only the owner's pool is editable from here.
        const existing = (await MemoryStore.open(deps.memoryFile)).get(id);
        if (existing && nodesInScope([existing], OWNER_SCOPE).length === 0) { json(404, { error: "unknown memory" }); return true; }
        const after = await edit(id, content);
        audit("memory.edit", id, { chars: content.length });
        json(200, { item: memoryItem(after, deps.agentOfSession) });
        return true;
      }

      // POST /gateway/memory/forget
      const existing = (await MemoryStore.open(deps.memoryFile)).get(id);
      if (existing && nodesInScope([existing], OWNER_SCOPE).length === 0) { json(404, { error: "unknown memory" }); return true; }
      await forget(id);
      audit("memory.forget", id, { kind: existing?.kind });
      json(200, { ok: true });
      return true;
    } catch (err) {
      if (err instanceof BadRequest) json(err.message === "body too large" ? 413 : 400, { error: err.message });
      else if (isNotFound(err)) json(404, { error: "unknown memory" });
      else if ((err as { code?: string })?.code === "busy") json(409, { error: "memory is busy; try again in a moment" });
      else {
        deps.log?.(`memory ${route} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) json(500, { error: "internal error" });
      }
      return true;
    }
  };
}
