// The Living Memory store (Ares v6 / M1).
//
// Durable, pluggable-home memory with the behaviors no filing-cabinet store has:
//   remember()    — spreading-activation recall that ALSO strengthens what it
//                   surfaces (recalling makes it stick) and wires co-activated
//                   memories together (fire together → wire together).
//   consolidate() — "sleep": forget trivial episodes, and crystallize recurring
//                   themes into lasting semantic knowledge.
//
// The store is just a path away from living anywhere — point `open()` at a
// flashdrive and Ares's whole memory lives there.

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../io.js";
import { mindPaths } from "../paths.js";
import { currentStrength, reinforce } from "./strength.js";
import { recall, type RecallOptions, type RecallResult } from "./recall.js";
import { buildIdf } from "./idf.js";
import { clusterByConcept, detectRecurringFailures, type Phraser } from "./synthesis.js";
import { MEMORY_SCHEMA_VERSION, type MemoryKind, type MemoryNode } from "./types.js";

export interface ConsolidationReport {
  pruned: number;
  deduped: number;
  promoted: string[];
  kept: number;
}

export interface SynthesisReport {
  /** New insight (recurring-pattern) nodes written. */
  insights: number;
  /** New belief (recurring-failure) nodes written. */
  beliefs: number;
  /** Existing synthesis nodes reinforced/extended instead of duplicated. */
  updated: number;
}

const PRUNE_FLOOR = 0.05;
const MIN_RECURRENCE = 3;
const MAX_MEMORY_CONTENT_CHARS = 2_000;
const THEME_STOPWORDS = new Set([
  "about", "after", "again", "also", "always", "before", "being", "built", "check",
  "clean", "could", "ares", "data", "directly", "doing", "done", "error", "files",
  "follows", "found", "have", "homie", "inspect", "issue", "just", "lmao", "look",
  "memory", "model", "noticed", "output", "right", "self", "some", "state", "still",
  "system", "there", "thing", "think", "this", "threw", "turn", "using", "which",
  "with", "work", "would",
]);

function resolveFile(root: string): string {
  return root.endsWith(".jsonl") ? root : path.join(root, "memory.jsonl");
}

function salientTokens(content: string): string[] {
  const seen = new Set<string>();
  for (const t of content.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (isThemeToken(t)) seen.add(t);
  }
  return [...seen];
}

export class MemoryStore {
  private constructor(
    private readonly file: string,
    private readonly nodes: Map<string, MemoryNode>,
    /**
     * Raw JSONL lines from a *newer* schema version this binary doesn't
     * understand. Held verbatim and re-written on every persist() so an older
     * Ares can never silently destroy memory a newer one wrote.
     */
    private readonly quarantined: string[] = [],
  ) {}

  /** Open (or create) a memory store at a root dir/file — the pluggable home. */
  static async open(root?: string): Promise<MemoryStore> {
    const file = root ? resolveFile(root) : mindPaths().memoryFile;
    const nodes = new Map<string, MemoryNode>();
    const quarantined: string[] = [];
    let repaired = false;
    try {
      const raw = await fs.readFile(file, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: MemoryNode;
        try {
          parsed = JSON.parse(trimmed) as MemoryNode;
        } catch {
          // Genuinely corrupt (half-written / invalid JSON): skip — don't crash.
          continue;
        }
        // A record from a NEWER schema than we understand: never load it (we'd
        // mangle fields we don't know), never drop it. Hold it verbatim so the
        // next persist() rewrites it untouched — non-destructive forward-compat.
        if (typeof parsed.v === "number" && parsed.v > MEMORY_SCHEMA_VERSION) {
          quarantined.push(trimmed);
          continue;
        }
        // Missing `v` = the pre-versioned shape → backfill to version 1.
        const versioned = typeof parsed.v === "number" ? parsed : { ...parsed, v: MEMORY_SCHEMA_VERSION };
        repaired ||= versioned.v !== parsed.v;
        const node = sanitizeNode(versioned);
        repaired ||= node.content !== parsed.content;
        nodes.set(node.id, node);
      }
    } catch {
      // no memory yet
    }
    const ids = new Set(nodes.keys());
    for (const [id, node] of nodes) {
      const links = [...new Set(node.links)].filter((link) => link !== id && ids.has(link));
      if (links.length !== node.links.length) {
        nodes.set(id, { ...node, links });
        repaired = true;
      }
    }
    const store = new MemoryStore(file, nodes, quarantined);
    if (repaired) await store.persist();
    return store;
  }

  /** In-memory store (no file) — for tests and ephemeral runs. */
  static memory(): MemoryStore {
    return new MemoryStore("", new Map());
  }

  all(): MemoryNode[] {
    return [...this.nodes.values()];
  }

  get(id: string): MemoryNode | undefined {
    return this.nodes.get(id);
  }

  count(): number {
    return this.nodes.size;
  }

  async add(input: {
    kind: MemoryKind;
    content: string;
    tags?: string[];
    source?: string;
    strength?: number;
    at?: Date;
  }): Promise<MemoryNode> {
    const at = (input.at ?? new Date()).toISOString();
    const node: MemoryNode = {
      v: MEMORY_SCHEMA_VERSION,
      id: `mem_${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      content: trimMemoryContent(input.content),
      at,
      strength: input.strength ?? 1,
      activations: 0,
      lastActivatedAt: at,
      links: [],
      tags: input.tags,
      source: input.source,
    };
    this.nodes.set(node.id, node);
    await this.persist();
    return node;
  }

  async link(aId: string, bId: string): Promise<void> {
    this.linkPair(aId, bId);
    await this.persist();
  }

  private linkPair(aId: string, bId: string): void {
    if (aId === bId) return;
    const a = this.nodes.get(aId);
    const b = this.nodes.get(bId);
    if (!a || !b) return;
    if (!a.links.includes(bId)) this.nodes.set(aId, { ...a, links: [...a.links, bId] });
    if (!b.links.includes(aId)) this.nodes.set(bId, { ...b, links: [...b.links, aId] });
  }

  private deleteNode(id: string): void {
    if (!this.nodes.delete(id)) return;
    for (const node of this.all()) {
      if (node.links.includes(id)) {
        this.nodes.set(node.id, { ...node, links: node.links.filter((link) => link !== id) });
      }
    }
  }

  /**
   * Recall a constellation of memories AND strengthen them. Surfacing a memory
   * reinforces it (so what's used stays vivid), and the top co-activated pair is
   * linked (Hebbian association forms from use).
   */
  async remember(cue: string, opts: RecallOptions = {}): Promise<RecallResult[]> {
    const now = opts.now ?? new Date();
    const results = recall(cue, this.all(), opts);
    for (const r of results) {
      const current = this.nodes.get(r.node.id);
      if (current) this.nodes.set(current.id, reinforce(current, now));
    }
    if (results.length >= 2) this.linkPair(results[0].node.id, results[1].node.id);
    await this.persist();
    return results.map((r) => ({ ...r, node: this.nodes.get(r.node.id) ?? r.node }));
  }

  /**
   * Read-only recall: surface the same constellation as remember() but WITHOUT
   * reinforcing, linking, or persisting. For inspection paths (status recaps,
   * "what were we doing?") that must not mutate memory just by looking.
   */
  peek(cue: string, opts: RecallOptions = {}): RecallResult[] {
    return recall(cue, this.all(), opts);
  }

  /** Sleep: forget trivial episodes; crystallize recurring themes into knowledge. */
  async consolidate(opts: { now?: Date } = {}): Promise<ConsolidationReport> {
    const now = opts.now ?? new Date();
    let pruned = 0;
    let deduped = 0;
    const promoted: string[] = [];

    // 1. Forget faded one-off episodes and stale filler "theme" semantics.
    for (const node of this.all()) {
      // Never prune crystallized insight/belief nodes the deep dream synthesized.
      if (node.source === "synthesis") continue;
      if (node.kind === "episodic" && currentStrength(node, now) < PRUNE_FLOOR) {
        this.deleteNode(node.id);
        pruned++;
        continue;
      }
      if (isNoiseThemeSemantic(node)) {
        this.deleteNode(node.id);
        pruned++;
      }
    }

    // 2. Merge exact duplicates into one stronger node and redirect links.
    deduped += this.mergeDuplicateContent(now);

    // 3. Promote recurring episodic themes into durable semantic knowledge.
    const byToken = new Map<string, MemoryNode[]>();
    for (const node of this.all()) {
      if (node.kind !== "episodic") continue;
      if (!isThemeEligibleEpisode(node)) continue;
      for (const token of salientTokens(node.content)) {
        let bucket = byToken.get(token);
        if (!bucket) {
          bucket = [];
          byToken.set(token, bucket);
        }
        bucket.push(node);
      }
    }
    for (const [token, episodes] of byToken) {
      if (episodes.length < MIN_RECURRENCE) continue;
      const tag = `theme:${token}`;
      if (this.all().some((n) => n.kind === "semantic" && n.tags?.includes(tag))) continue;
      const semantic = await this.add({
        kind: "semantic",
        content: `Recurring theme "${token}" observed across ${episodes.length} episodes.`,
        tags: [tag],
        strength: 1.5,
        at: now,
      });
      for (const ep of episodes) this.linkPair(semantic.id, ep.id);
      promoted.push(token);
    }

    await this.persist();
    return { pruned, deduped, promoted, kept: this.nodes.size };
  }

  /**
   * Dreaming synthesis: cluster recurring episodes into durable "insight" nodes
   * and recurring failure signatures into "belief" nodes — the real "what should
   * I believe now" pass. Idempotent by tag (re-running reinforces, never dupes),
   * provider-free by default; an optional injected phraser writes richer prose
   * without coupling @ares/mind to any model.
   */
  async synthesize(opts: { now?: Date; synthesizer?: Phraser; minMembers?: number } = {}): Promise<SynthesisReport> {
    const now = opts.now ?? new Date();
    // Synthesize over raw memory only — exclude prior synthesis output so its own
    // content can never perturb the IDF corpus or shift a cluster key (which would
    // break idempotency: the same recurring set must always map to the same tag).
    const nodes = this.all().filter((n) => n.source !== "synthesis");
    const idf = buildIdf(nodes);
    const candidates = [
      ...clusterByConcept(nodes, idf, { minMembers: opts.minMembers }),
      ...detectRecurringFailures(nodes, idf),
    ];
    let insights = 0;
    let beliefs = 0;
    let updated = 0;
    for (const c of candidates) {
      const tag = `${c.kind}:${c.key}`;
      const members = c.members
        .map((id) => this.nodes.get(id))
        .filter((n): n is MemoryNode => Boolean(n));
      if (members.length === 0) continue;
      const phrased = opts.synthesizer ? await opts.synthesizer(c, members).catch(() => null) : null;
      const content = phrased ?? c.defaultText;
      const existing = this.all().find((n) => n.kind === "semantic" && n.tags?.includes(tag));
      if (existing) {
        this.nodes.set(existing.id, {
          ...existing,
          content,
          confidence: Math.min(1, (existing.confidence ?? 0.5) + 0.1),
          derivedFrom: [...new Set([...(existing.derivedFrom ?? []), ...c.members])],
          strength: existing.strength + 0.5,
        });
        for (const m of members) this.linkPair(existing.id, m.id);
        updated++;
        continue;
      }
      const node = await this.add({
        kind: "semantic",
        content,
        tags: [tag],
        source: "synthesis",
        strength: 1.5 + Math.min(2, c.salience * 0.1),
        at: now,
      });
      const created = this.nodes.get(node.id);
      if (created) {
        this.nodes.set(node.id, { ...created, confidence: c.kind === "belief" ? 0.6 : 0.5, derivedFrom: c.members });
      }
      for (const m of members) this.linkPair(node.id, m.id);
      if (c.kind === "belief") beliefs++;
      else insights++;
    }
    await this.persist();
    return { insights, beliefs, updated };
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    // Active nodes first, then any quarantined newer-schema lines verbatim — so
    // a round-trip through an older binary never destroys forward-version data.
    const lines = [...this.all().map((n) => JSON.stringify(n)), ...this.quarantined];
    await writeFileAtomic(this.file, lines.length ? lines.join("\n") + "\n" : "");
  }

  private mergeDuplicateContent(now: Date): number {
    const byContent = new Map<string, MemoryNode[]>();
    for (const node of this.all()) {
      const key = normalizeForDedup(node.content);
      if (!key) continue;
      const bucket = byContent.get(key) ?? [];
      bucket.push(node);
      byContent.set(key, bucket);
    }

    let merged = 0;
    for (const group of byContent.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => {
        const strengthDelta = currentStrength(b, now) - currentStrength(a, now);
        if (strengthDelta !== 0) return strengthDelta;
        return b.activations - a.activations;
      });
      const keeper = sorted[0];
      const duplicates = sorted.slice(1);
      const duplicateIds = new Set(duplicates.map((node) => node.id));
      const allGroupIds = new Set(group.map((node) => node.id));
      const links = new Set<string>();
      const tags = new Set<string>();
      let activations = 0;
      let strength = 0;
      let lastActivatedAt = keeper.lastActivatedAt;

      for (const node of group) {
        activations += node.activations;
        strength += node.strength;
        if (node.lastActivatedAt > lastActivatedAt) lastActivatedAt = node.lastActivatedAt;
        for (const link of node.links) {
          if (!allGroupIds.has(link)) links.add(link);
        }
        for (const tag of node.tags ?? []) tags.add(tag);
      }

      this.nodes.set(keeper.id, {
        ...keeper,
        strength: Math.min(50, strength),
        activations,
        lastActivatedAt,
        links: [...links],
        tags: tags.size ? [...tags] : keeper.tags,
      });

      for (const duplicate of duplicates) this.nodes.delete(duplicate.id);
      for (const node of this.all()) {
        if (node.id === keeper.id) continue;
        const redirected = [...new Set(node.links.map((link) => (duplicateIds.has(link) ? keeper.id : link)))]
          .filter((link) => link !== node.id);
        if (redirected.length !== node.links.length || redirected.some((link, i) => link !== node.links[i])) {
          this.nodes.set(node.id, { ...node, links: redirected });
        }
      }
      merged += duplicates.length;
    }
    return merged;
  }
}

function sanitizeNode(node: MemoryNode): MemoryNode {
  const content = trimMemoryContent(node.content);
  return content === node.content ? node : { ...node, content };
}

function trimMemoryContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_MEMORY_CONTENT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_MEMORY_CONTENT_CHARS)}\n[truncated memory: ${trimmed.length - MAX_MEMORY_CONTENT_CHARS} chars omitted]`;
}

function normalizeForDedup(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

function isThemeToken(token: string): boolean {
  return token.length >= 5 && !THEME_STOPWORDS.has(token);
}

function isThemeEligibleEpisode(node: MemoryNode): boolean {
  const content = node.content.toLowerCase();
  if (/^(hi|hey|hello|yo|sup)\b/.test(content)) return false;
  if (/^(lol|lmao|haha|bet|ok|okay|cool|nice|word|true|facts|nun much|nothing much)\b/.test(content)) return false;
  if (/^decided to answer the user by using the strongest available tools\b/.test(content)) return false;
  return salientTokens(content).length >= 2;
}

function isNoiseThemeSemantic(node: MemoryNode): boolean {
  if (node.kind !== "semantic") return false;
  const tag = node.tags?.find((t) => t.startsWith("theme:"));
  const token = tag?.slice("theme:".length) ?? node.content.match(/^Recurring theme "([^"]+)"/)?.[1];
  return Boolean(token && !isThemeToken(token.toLowerCase()));
}
