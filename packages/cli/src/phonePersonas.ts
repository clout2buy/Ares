// /gateway/personas — the phone's "new chat with an agent" screen.
//
// Mounted inside RemoteAgentServer.handlePhoneApi AFTER its bearer check (via
// the phoneApi.personas hook), so every route is owner-only. Shapes (the app
// is built against these — do not change them):
//
//   GET  /gateway/personas
//        200 {personas:[{id,name,emoji?,color?,provider,model,reasoningLevel?,
//                        instructions,sessionId,lastMessage?,lastAt?,busy}]}
//        The implicit default "ares" persona is always first (sessionId is its
//        current default thread, "" when none exists yet).
//   POST /gateway/personas            {name,provider,model,instructions,emoji?,color?,reasoningLevel?}
//        200 {persona} · 400 invalid field / unknown provider or model
//   POST /gateway/personas/<id>       {name?,emoji?,color?,provider?,model?,reasoningLevel?,instructions?}
//        200 {persona} · 400 invalid · 404 unknown persona (and "ares", which is not editable here)
//   POST /gateway/personas/<id>/delete
//        200 {ok:true} · 404 unknown persona — archives the thread, keeps its rollout
//
// All the garrison coupling (sessions, the model catalog, the live runtime)
// arrives as hooks so this module is testable with fakes.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_PERSONA_ID,
  PERSONA_INSTRUCTIONS_MAX,
  PERSONA_NAME_MAX,
  PERSONA_SETUP_PROMPT,
  impliesMonitoring,
  newPersonaId,
  type Persona,
  type PersonaStore,
} from "./personas.js";

export interface PersonaView {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  provider: string;
  model: string;
  reasoningLevel?: string;
  instructions: string;
  sessionId: string;
  lastMessage?: string;
  lastAt?: string;
  busy: boolean;
}

export interface PersonasApiDeps {
  store: PersonaStore;
  /** The cockpit's provider list (/gateway/control). */
  providers: () => string[];
  /** The cockpit's model catalog for one provider (/gateway/control/models). */
  models: (provider: string) => Promise<Array<{ id: string }>>;
  /** Legal reasoning levels. */
  reasoningLevels: () => string[];
  /** The default assistant: its brain and current phone thread. */
  defaultPersona: () => Promise<{ provider: string; model: string; reasoningLevel?: string; sessionId?: string }>;
  /** Create the persona's dedicated thread (persona already staged in the store). */
  createSession: (persona: Persona) => Promise<string>;
  /** Archive a thread (never deletes its rollout). */
  archiveSession: (sessionId: string) => Promise<void>;
  /** Is a turn running in this thread right now? */
  busy: (sessionId: string) => boolean;
  /** Newest line in a thread for the list preview. */
  lastMessage: (sessionId: string) => Promise<{ text: string; at?: string } | undefined>;
  /** Push an edited persona into its live thread (prompt, model, effort). */
  apply: (persona: Persona, changed: { brain: boolean; layer: boolean; effort: boolean }) => Promise<void>;
  /** Start a turn in a thread without waiting for it. */
  kickoff: (sessionId: string, text: string) => void;
  log?: (line: string) => void;
  now?: () => Date;
}

class BadRequest extends Error {}

async function readBody(req: IncomingMessage, limit = 32 * 1024): Promise<Record<string, unknown>> {
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

type Patch = Partial<Pick<Persona, "name" | "emoji" | "color" | "provider" | "model" | "reasoningLevel" | "instructions">>;

/** Validate the editable fields present in `body`. `required` lists the ones
 *  that must be there (create). Unknown fields are ignored. */
function parsePatch(body: Record<string, unknown>, required: Array<keyof Patch>, levels: string[]): Patch {
  const out: Patch = {};
  const take = (key: keyof Patch): string | undefined => {
    const v = body[key];
    if (v === undefined || v === null) {
      if (required.includes(key)) throw new BadRequest(`${key} required`);
      return undefined;
    }
    if (typeof v !== "string") throw new BadRequest(`${key} must be a string`);
    return v.trim();
  };
  const name = take("name");
  if (name !== undefined) {
    if (!name) throw new BadRequest("name required");
    if (name.length > PERSONA_NAME_MAX) throw new BadRequest(`name must be at most ${PERSONA_NAME_MAX} characters`);
    out.name = name;
  }
  const instructions = take("instructions");
  if (instructions !== undefined) {
    if (!instructions) throw new BadRequest("instructions required");
    if (instructions.length > PERSONA_INSTRUCTIONS_MAX) throw new BadRequest(`instructions must be at most ${PERSONA_INSTRUCTIONS_MAX} characters`);
    out.instructions = instructions;
  }
  const provider = take("provider");
  if (provider !== undefined) {
    if (!provider) throw new BadRequest("provider required");
    out.provider = provider;
  }
  const model = take("model");
  if (model !== undefined) {
    if (!model) throw new BadRequest("model required");
    out.model = model;
  }
  const emoji = take("emoji");
  if (emoji !== undefined) {
    if ([...emoji].length > 8) throw new BadRequest("emoji must be a single emoji");
    out.emoji = emoji;
  }
  const color = take("color");
  if (color !== undefined) {
    if (color && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) throw new BadRequest("color must be a #hex colour");
    out.color = color;
  }
  const reasoningLevel = take("reasoningLevel");
  if (reasoningLevel !== undefined) {
    const level = reasoningLevel.toLowerCase();
    if (level && !levels.includes(level)) throw new BadRequest(`reasoningLevel must be one of: ${levels.join(", ")}`);
    out.reasoningLevel = level;
  }
  return out;
}

/** 400 unless the provider is in the cockpit list and the model in its catalog. */
async function assertBrain(deps: PersonasApiDeps, provider: string, model: string): Promise<void> {
  if (!deps.providers().includes(provider)) throw new BadRequest(`unknown provider: ${provider}`);
  let catalog: Array<{ id: string }>;
  try {
    catalog = await deps.models(provider);
  } catch (err) {
    throw new BadRequest(`couldn't load ${provider}'s models: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!catalog.some((m) => m.id === model)) throw new BadRequest(`unknown model for ${provider}: ${model}`);
}

/** Drop empty optional strings so the stored file stays tidy. */
function tidy(p: Persona): Persona {
  const out: Persona = { ...p };
  if (!out.emoji) delete out.emoji;
  if (!out.color) delete out.color;
  if (!out.reasoningLevel) delete out.reasoningLevel;
  return out;
}

async function view(deps: PersonasApiDeps, p: Persona): Promise<PersonaView> {
  const last = p.sessionId ? await deps.lastMessage(p.sessionId).catch(() => undefined) : undefined;
  return {
    id: p.id,
    name: p.name,
    ...(p.emoji ? { emoji: p.emoji } : {}),
    ...(p.color ? { color: p.color } : {}),
    provider: p.provider,
    model: p.model,
    ...(p.reasoningLevel ? { reasoningLevel: p.reasoningLevel } : {}),
    instructions: p.instructions,
    sessionId: p.sessionId,
    ...(last ? { lastMessage: last.text } : {}),
    ...(last?.at ? { lastAt: last.at } : {}),
    busy: p.sessionId ? deps.busy(p.sessionId) : false,
  };
}

async function defaultView(deps: PersonasApiDeps): Promise<PersonaView> {
  const d = await deps.defaultPersona();
  const sessionId = d.sessionId ?? "";
  return view(deps, {
    id: DEFAULT_PERSONA_ID,
    name: "Ares",
    provider: d.provider,
    model: d.model,
    ...(d.reasoningLevel ? { reasoningLevel: d.reasoningLevel } : {}),
    instructions: "",
    sessionId,
    createdAt: "",
    updatedAt: "",
  });
}

/**
 * Handle a /gateway/personas* request. Returns false when the path isn't ours.
 * The caller has ALREADY verified the bearer token.
 */
export async function handlePersonasApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: PersonasApiDeps): Promise<boolean> {
  const route = url.pathname.replace(/\/+$/, "");
  if (route !== "/gateway/personas" && !route.startsWith("/gateway/personas/")) return false;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();
  try {
    await deps.store.ensureLoaded();
    if (route === "/gateway/personas") {
      if (req.method === "GET") {
        const personas = [await defaultView(deps), ...(await Promise.all(deps.store.list().map((p) => view(deps, p))))];
        json(200, { personas });
        return true;
      }
      if (req.method === "POST") {
        const patch = parsePatch(await readBody(req), ["name", "provider", "model", "instructions"], deps.reasoningLevels());
        await assertBrain(deps, patch.provider!, patch.model!);
        const at = now();
        const persona: Persona = tidy({
          id: newPersonaId(),
          name: patch.name!,
          emoji: patch.emoji,
          color: patch.color,
          provider: patch.provider!,
          model: patch.model!,
          reasoningLevel: patch.reasoningLevel,
          instructions: patch.instructions!,
          sessionId: "",
          createdAt: at,
          updatedAt: at,
        });
        // Staged first: the session factory looks the persona up while the
        // thread is being built, so the very first turn already wears the role.
        deps.store.stage(persona);
        try {
          persona.sessionId = await deps.createSession(persona);
          await deps.store.save(persona);
        } catch (err) {
          deps.store.unstage(persona.id);
          throw err;
        }
        deps.log?.(`personas: created ${persona.id} "${persona.name}" on ${persona.provider}/${persona.model} (thread ${persona.sessionId})`);
        if (impliesMonitoring(persona.instructions)) deps.kickoff(persona.sessionId, PERSONA_SETUP_PROMPT);
        json(200, { persona: await view(deps, persona) });
        return true;
      }
      json(405, { error: "method not allowed" });
      return true;
    }

    const m = /^\/gateway\/personas\/([^/]+)(\/delete)?$/.exec(route);
    if (!m || req.method !== "POST") {
      json(404, { error: "not found" });
      return true;
    }
    const id = decodeURIComponent(m[1]!);
    const existing = deps.store.get(id);
    if (!existing) {
      json(404, { error: `unknown persona: ${id.slice(0, 40)}` });
      return true;
    }
    if (m[2]) {
      await deps.store.remove(id);
      if (existing.sessionId) await deps.archiveSession(existing.sessionId).catch((err) => deps.log?.(`personas: archive ${existing.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`));
      deps.log?.(`personas: deleted ${id} "${existing.name}"`);
      json(200, { ok: true });
      return true;
    }
    const patch = parsePatch(await readBody(req), [], deps.reasoningLevels());
    const provider = patch.provider ?? existing.provider;
    const model = patch.model ?? existing.model;
    const brain = provider !== existing.provider || model !== existing.model;
    // Switching provider without naming a model can't keep the old model id.
    if (brain) await assertBrain(deps, provider, model);
    const next: Persona = tidy({
      ...existing,
      ...patch,
      provider,
      model,
      updatedAt: now(),
    });
    const layer = next.name !== existing.name || next.instructions !== existing.instructions;
    const effort = (next.reasoningLevel ?? "") !== (existing.reasoningLevel ?? "");
    await deps.store.save(next);
    if (brain || layer || effort) await deps.apply(next, { brain, layer, effort });
    json(200, { persona: await view(deps, next) });
    return true;
  } catch (err) {
    if (err instanceof BadRequest) {
      json(400, { error: err.message });
      return true;
    }
    deps.log?.(`personas ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) json(500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
