// ToolSearch — discovery for the DEFERRED tool tier.
//
// The engine sends a fixed core catalog every turn (prompt-cache stable) and
// keeps the integrations — music, mail, calendar, payments, deploy, weather,
// reminders, Telegram, MCP connectors, skills, missions, the agent computer —
// out of the schema list until the model asks for them. This tool is how it
// asks: a few keywords, or `select:Name,Name` when it already knows the name.
// A hit is returned AND marked loaded on the session's DeferredToolRegistry;
// the engine also reads the `loaded` array out of this tool's result in the
// transcript, so a loaded tool stays in the catalog for the rest of the
// session even across a daemon restart. The registry is the in-process memory
// that survives compaction; the transcript is the memory that survives the
// process. Neither is authoritative alone, which is why both exist.

import { z } from "zod";
import { buildTool } from "./_shared.js";

export interface DeferredToolDescriptor {
  name: string;
  /** One or two sentences — enough to pick the tool, not the full schema. */
  description: string;
  /** Optional short "when to reach for it" line. */
  usage?: string;
}

/**
 * Per-session record of which deferred tools have been loaded. Hosts create
 * one per session (a child session must not inherit its parent's loads —
 * different transcript, different cache prefix) and attach it to the tool
 * context as `deferredTools`. The catalog can be filled after construction
 * because the ToolSearch tool is itself part of the catalog being assembled.
 */
export class DeferredToolRegistry {
  private descriptors: DeferredToolDescriptor[];
  private readonly loadedNames: string[] = [];

  constructor(descriptors: readonly DeferredToolDescriptor[] = []) {
    this.descriptors = [...descriptors];
  }

  setCatalog(descriptors: readonly DeferredToolDescriptor[]): void {
    this.descriptors = [...descriptors];
  }

  catalog(): readonly DeferredToolDescriptor[] {
    return this.descriptors;
  }

  /** Load order is the catalog order the engine appends in — keep it. */
  loaded(): readonly string[] {
    return this.loadedNames;
  }

  isLoaded(name: string): boolean {
    const key = name.toLowerCase();
    return this.loadedNames.some((loaded) => loaded.toLowerCase() === key);
  }

  load(names: readonly string[]): void {
    for (const name of names) {
      const descriptor = this.find(name);
      if (descriptor && !this.isLoaded(descriptor.name)) this.loadedNames.push(descriptor.name);
    }
  }

  find(name: string): DeferredToolDescriptor | undefined {
    const key = name.trim().toLowerCase();
    return this.descriptors.find((descriptor) => descriptor.name.toLowerCase() === key);
  }

  /**
   * Keyword search: every whitespace-separated term is matched (case-blind,
   * substring) against name + description + usage; descriptors are ranked by
   * how many terms hit, name hits weighted highest, ties broken by catalog
   * order so identical queries return identical lists.
   */
  search(query: string, maxResults: number): DeferredToolDescriptor[] {
    const terms = query.toLowerCase().split(/[\s,]+/).map((term) => term.trim()).filter((term) => term.length > 1);
    if (terms.length === 0) return [];
    const scored = this.descriptors.map((descriptor, index) => {
      const name = descriptor.name.toLowerCase();
      const body = `${descriptor.description} ${descriptor.usage ?? ""}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name === term) score += 10;
        else if (name.includes(term) || term.includes(name)) score += 5;
        else if (body.includes(term)) score += 1;
        else if (term.endsWith("s") && body.includes(term.slice(0, -1))) score += 1;
      }
      return { descriptor, score, index };
    });
    return scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, maxResults)
      .map((entry) => entry.descriptor);
  }
}

const inputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe(
        "Keywords describing what you need (e.g. \"play music\", \"send email\", \"calendar\", \"deploy site\"), or the exact form `select:Name,Name` to load tools by name.",
      ),
    max_results: z.number().int().min(1).max(20).optional().describe("Maximum keyword matches to return (default 5)."),
  })
  .strict();

export interface ToolSearchOutput {
  query: string;
  /** Tools this call matched and loaded — these are now callable. */
  matches: DeferredToolDescriptor[];
  /** Every deferred tool loaded so far this session, in load order. */
  loaded: string[];
  /** `select:` names that are not deferred tools (typos, or already-core tools). */
  unknown: string[];
  /** When nothing matched: the names available, so the next query can be exact. */
  available?: string[];
}

export interface ToolSearchOptions {
  /** Registry lookup when the tool context carries none (single-session hosts). */
  registryFor?: (sessionId: string) => DeferredToolRegistry;
}

/**
 * Categories in the description are the model's only map of what is deferred —
 * keep it a complete list of KINDS (not names, which change) so "there is a
 * tool for X" is discoverable without seeing forty schemas.
 */
export const TOOL_SEARCH_DESCRIPTION =
  "Find and LOAD tools that are not in your catalog yet. Integrations are deferred until you ask for them: " +
  "music (Spotify), email (Gmail/Email), calendar (GoogleCalendar), payments (Stripe), deploy/hosting (Deploy), weather, reminders (Remind), " +
  "Telegram setup/roster, MCP connectors (Connect, McpListTools, McpCallTool), skills (SkillsList/SkillRead/SkillHub/SkillCraft/RunSkill), " +
  "durable missions and standing orders (Mission, StandingOrder, Operator, Watcher), self-management (Self, SelfEvolve, Bootstrap, Persona, LivingMind), " +
  "the agent computer and desktop (Computer*, ComputerUse), image search, alternate edit protocols (ApplyIntent, FindAndEdit, CodeMode), " +
  "fleets and external coding harnesses (Conductor, CodingBackend), and UI effects. " +
  "Pass a few keywords (\"play a song\", \"send mail\") or `select:Name,Name` for exact names. " +
  "Matches are loaded for the rest of the session and can be called on your next step. Calling a deferred tool before loading it fails as unknown.";

export function makeToolSearchTool(options: ToolSearchOptions = {}) {
  const fallbackRegistries = new Map<string, DeferredToolRegistry>();
  return buildTool({
    name: "ToolSearch",
    description: TOOL_SEARCH_DESCRIPTION,
    safety: "read-only",
    concurrency: "parallel-safe",
    inputZod: inputSchema,
    activityDescription: (i) => `Searching tools: ${i.query}`,

    async call(i, ctx): Promise<{ output: ToolSearchOutput; display: string }> {
      const registry =
        ctx.deferredTools ??
        options.registryFor?.(ctx.sessionId) ??
        (fallbackRegistries.get(ctx.sessionId) ?? (() => {
          const created = new DeferredToolRegistry();
          fallbackRegistries.set(ctx.sessionId, created);
          return created;
        })());
      const query = i.query.trim();
      const unknown: string[] = [];
      let matches: DeferredToolDescriptor[];
      if (/^select:/i.test(query)) {
        matches = [];
        for (const raw of query.slice("select:".length).split(",")) {
          const name = raw.trim();
          if (!name) continue;
          const descriptor = registry.find(name);
          if (descriptor) {
            if (!matches.includes(descriptor)) matches.push(descriptor);
          } else {
            unknown.push(name);
          }
        }
      } else {
        matches = registry.search(query, i.max_results ?? 5);
      }
      registry.load(matches.map((m) => m.name));
      const output: ToolSearchOutput = {
        query,
        matches,
        loaded: [...registry.loaded()],
        unknown,
      };
      if (matches.length === 0) output.available = registry.catalog().map((d) => d.name);
      const display =
        matches.length > 0
          ? `Loaded ${matches.map((m) => m.name).join(", ")}`
          : unknown.length > 0
            ? `No deferred tool named ${unknown.join(", ")}`
            : `No tool matched "${query}"`;
      return { output, display };
    },
  });
}
