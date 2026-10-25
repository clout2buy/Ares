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
import { withFileLock } from "./consolidationLock.js";
import { currentStrength, livenessScore, reinforce, weaken } from "./strength.js";
import { recall, type RecallOptions, type RecallResult } from "./recall.js";
import { contentHash, type EmbedIndex, type Embedder } from "./embedIndex.js";
import { buildIdf } from "./idf.js";
import { isOperationalNoise } from "./noise.js";
import { clusterByConcept, detectRecurringFailures, type Phraser } from "./synthesis.js";
import { MEMORY_SCHEMA_VERSION, type CrucibleCheck, type HypothesisStatus, type MemoryKind, type MemoryNode, type ReflectionResult, type ReflectionSurface } from "./types.js";

export interface ConsolidationReport {
  pruned: number;
  deduped: number;
  promoted: string[];
  kept: number;
}

/** Input shape for adding a memory node (shared by add() and addMany()). */
export interface AddInput {
  kind: MemoryKind;
  content: string;
  tags?: string[];
  source?: string;
  strength?: number;
  at?: Date;
  status?: HypothesisStatus;
  check?: CrucibleCheck;
  /** Tenant this node belongs to (e.g. a Telegram chatId). Absent = the owner. */
  scope?: string;
}

export interface SynthesisReport {
  /** New insight (recurring-pattern) nodes written. */
  insights: number;
  /** New belief (recurring-failure) nodes written. */
  beliefs: number;
  /** Existing synthesis nodes reinforced/extended instead of duplicated. */
  updated: number;
}

/** One row of the owner-facing "what I know" overview. */
export interface MemoryOverviewRow {
  id: string;
  kind: MemoryKind;
  /** Clipped to ~{@link OVERVIEW_CONTENT_CLIP} chars — a surface, not a dump. */
  content: string;
  strength: number;
  currentStrength: number;
  activations: number;
  /** Days since the memory was formed (one-decimal precision). */
  ageDays: number;
  tags?: string[];
  confidence?: number;
}

/** The overview grouped by kind — what I believe / what I can do / what happened. */
export interface MemoryOverviewGroups {
  semantic: MemoryOverviewRow[];
  procedural: MemoryOverviewRow[];
  episodic: MemoryOverviewRow[];
}

export interface OverviewOptions {
  /** Tenant scope. Defaults to {@link OWNER_SCOPE} — guest:* pools are NEVER
   *  included unless a caller asks for that scope explicitly. */
  scope?: string;
  /** Max rows PER GROUP. Default: {@link overviewLimit} (ARES_MIND_OVERVIEW_LIMIT). */
  limit?: number;
  now?: Date;
}

/** Before/after pair from an owner edit — callers print the correction. */
export interface MemoryEditResult {
  before: MemoryNode;
  after: MemoryNode;
}

/** Per-group row cap for overview(). Tunable: ARES_MIND_OVERVIEW_LIMIT. */
export function overviewLimit(): number {
  const raw = Number(process.env.ARES_MIND_OVERVIEW_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15;
}

/** Overview rows clip content here — enough to recognize a belief, not a dump. */
const OVERVIEW_CONTENT_CLIP = 200;

const PRUNE_FLOOR = 0.05;
const EVIDENCE_CAP = 20;
const MAX_MEMORY_CONTENT_CHARS = 2_000;
/** Hard ceiling on how long remember() will wait for a cue embedding. */
const CUE_EMBED_TIMEOUT_MS = 300;
const EMBED_BATCH = 64;

function resolveFile(root: string): string {
  return root.endsWith(".jsonl") ? root : path.join(root, "memory.jsonl");
}

/** The owner's pool: unscoped nodes (everything pre-tenancy) plus "owner". */
export const OWNER_SCOPE = "owner";

/**
 * Scopes that are ISOLATED — they see only their own nodes, never the owner's
 * unscoped pool. A Telegram guest (`guest:<chatId>`) must not recall the
 * owner's projects or finances; the prefix convention (rather than a flag)
 * means every path that threads `scope` through — the Mnemosyne server, the
 * unified recall, the router — gets the isolation without new plumbing.
 */
export function isIsolatedScope(scope: string | undefined): boolean {
  return typeof scope === "string" && scope.startsWith("guest:");
}

/**
 * Filter a node pool by tenant scope. `undefined` scope (the default, backward
 * compatible) returns the pool untouched. A non-isolated `scope` keeps nodes
 * stamped with that exact scope PLUS unscoped nodes (pre-existing/owner
 * memories) — never nodes belonging to a DIFFERENT scope. An isolated scope
 * (see {@link isIsolatedScope}) keeps ONLY its own nodes.
 */
export function nodesInScope<N extends { scope?: string }>(nodes: readonly N[], scope: string | undefined): readonly N[] {
  if (scope === undefined) return nodes;
  if (isIsolatedScope(scope)) return nodes.filter((n) => n.scope === scope);
  // A desktop agent (agent:<id>) also knows what the owner told Ares directly,
  // whichever way those memories were stamped; it never sees another agent's.
  const ownerToo = scope.startsWith("agent:");
  return nodes.filter((n) => n.scope === scope || n.scope === undefined || (ownerToo && n.scope === OWNER_SCOPE));
}

const scopedNodes = nodesInScope<MemoryNode>;

/** What the loader could and could not make of the file — surfaced so a
 *  doctor/CLI can say "3 lines were unreadable" instead of silently thinning. */
export interface MemoryLoadReport {
  /** Lines that were not a memory record (invalid JSON, `null`, `{}`, `"x"`...).
   *  Skipped on load and counted; the lines around them load normally. */
  malformed: number;
  /** Lines from a newer schema than this binary understands (held verbatim). */
  newerSchema: number;
  /** Set when the file exists but could not be read at all (EACCES, EISDIR, a
   *  flaky drive). The store opens EMPTY and refuses every persist. */
  unreadable?: string;
}

/** The on-disk file, parsed: live nodes, pass-through lines, what was fixed. */
interface LoadedFile {
  nodes: Map<string, MemoryNode>;
  quarantined: string[];
  /** Something was backfilled/sanitized and the file deserves a rewrite. */
  repaired: boolean;
  report: MemoryLoadReport;
  /** Identity of the bytes we read — refresh() compares against this. */
  stamp: FileStamp | undefined;
}

interface FileStamp {
  mtimeMs: number;
  size: number;
}

/** A record is a memory node only if it has the string id we key by — `null`,
 *  `{}`, `"x"` and `[1]` all parse as JSON yet are not nodes. The old loader
 *  threw on `parsed.v` for these and the throw escaped to open()'s catch-all,
 *  which then persisted the half-loaded map over the file (#25). */
function isNodeRecord(value: unknown): value is MemoryNode & { v?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { id?: unknown }).id === "string";
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

async function statStamp(file: string): Promise<FileStamp | undefined> {
  try {
    const st = await fs.stat(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return undefined;
  }
}

/**
 * Parse the memory file. ONLY a missing file is "no memory yet". Any other
 * read failure marks the result unreadable (and the store refuses to write —
 * overwriting a file we could not read is how memories vanished in the field,
 * #25). Line by line: a malformed line is skipped and counted, and loading
 * CONTINUES to the next line — one bad byte must never cost the lines after it.
 */
async function loadFile(file: string): Promise<LoadedFile> {
  const nodes = new Map<string, MemoryNode>();
  const quarantined: string[] = [];
  const report: MemoryLoadReport = { malformed: 0, newerSchema: 0 };
  let repaired = false;
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (!isEnoent(err)) {
      report.unreadable = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mind] memory file unreadable — store is READ-ONLY until fixed: ${file}: ${report.unreadable}\n`);
    }
    return { nodes, quarantined, repaired, report, stamp: undefined };
  }
  const stamp = await statStamp(file);
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    if (!isNodeRecord(parsed)) {
      // Not a node (half-written line from a crash, or valid-but-foreign JSON).
      // Skip it, count it, keep going — the lines after it are still memory.
      // Not carried forward: a torn line is never recoverable, and the v8
      // doctrine is that every line of a persisted file parses.
      report.malformed++;
      continue;
    }
    // A record from a NEWER schema than we understand: never load it (we'd
    // mangle fields we don't know), never drop it. Hold it verbatim so the
    // next persist() rewrites it untouched — non-destructive forward-compat.
    if (typeof parsed.v === "number" && parsed.v > MEMORY_SCHEMA_VERSION) {
      report.newerSchema++;
      quarantined.push(trimmed);
      continue;
    }
    // Missing `v` = the pre-versioned shape → backfill to version 1.
    const versioned = typeof parsed.v === "number" ? (parsed as MemoryNode) : { ...(parsed as MemoryNode), v: MEMORY_SCHEMA_VERSION };
    repaired ||= versioned.v !== parsed.v;
    const node = sanitizeNode(versioned);
    repaired ||= node.content !== parsed.content;
    nodes.set(node.id, node);
  }
  const ids = new Set(nodes.keys());
  for (const [id, node] of nodes) {
    const links = [...new Set(node.links ?? [])].filter((link) => link !== id && ids.has(link));
    if (!Array.isArray(node.links) || links.length !== node.links.length) {
      nodes.set(id, { ...node, links });
      repaired = true;
    }
  }
  return { nodes, quarantined, repaired, report, stamp };
}

export class MemoryStore {
  /** V4 semantic seeds: optional embedder + sidecar index. Absent → classic store. */
  private embedder?: Embedder;
  private embedIndex?: EmbedIndex;
  /** Serializes background embedding refreshes; errors never escape the chain. */
  private embedQueue: Promise<void> = Promise.resolve();
  /** Serializes persist()/refresh() on this instance so two overlapping writes
   *  never interleave their merge steps. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  /**
   * The file as THIS instance last saw it (serialized per id), plus its stat
   * stamp. persist() is a three-way merge of base ↔ disk ↔ memory: a node we
   * did not change takes whatever is on disk now, so a sibling process's
   * writes since our open() survive ours (#24, #23). An empty base = we have
   * never read the file (in-memory store, or the file did not exist).
   */
  private base: Map<string, string>;
  private baseQuarantined: Set<string>;
  private stamp: FileStamp | undefined;

  private constructor(
    private readonly file: string,
    private readonly nodes: Map<string, MemoryNode>,
    /**
     * Raw JSONL lines from a *newer* schema version this binary doesn't
     * understand. Held verbatim and re-written on every persist() so an older
     * Ares can never silently destroy memory a newer one wrote.
     */
    private quarantined: string[] = [],
    /** What open() could and could not read. See {@link MemoryLoadReport}. */
    readonly loadReport: MemoryLoadReport = { malformed: 0, newerSchema: 0 },
    stamp?: FileStamp,
  ) {
    this.base = snapshot(nodes);
    this.baseQuarantined = new Set(quarantined);
    this.stamp = stamp;
  }

  /** Open (or create) a memory store at a root dir/file — the pluggable home. */
  static async open(root?: string): Promise<MemoryStore> {
    const file = root ? resolveFile(root) : mindPaths().memoryFile;
    const loaded = await loadFile(file);
    const store = new MemoryStore(file, loaded.nodes, loaded.quarantined, loaded.report, loaded.stamp);
    // A repair rewrite is a write like any other: it goes through the merge
    // and is refused when the file was unreadable.
    if (loaded.repaired && !loaded.report.unreadable) await store.persist();
    return store;
  }

  /** In-memory store (no file) — for tests and ephemeral runs. */
  static memory(): MemoryStore {
    return new MemoryStore("", new Map());
  }

  /** True when open() could not read an existing file: every persist() throws. */
  get readOnly(): boolean {
    return this.loadReport.unreadable !== undefined;
  }

  /**
   * Pick up what other processes wrote since we last touched the file. Cheap
   * (one stat) when nothing changed. A long-lived holder — the Mnemosyne
   * server keeps ONE store open for its whole life (#23) — calls this before
   * serving, so a recall reflects the CLI add that landed a minute ago instead
   * of the snapshot from boot. Nodes this instance has changed in memory and
   * not yet persisted keep their in-memory version.
   */
  async refresh(): Promise<boolean> {
    if (!this.file || this.readOnly) return false;
    const current = await statStamp(this.file);
    if (sameStamp(current, this.stamp)) return false;
    await this.enqueue(async () => {
      const disk = await loadFile(this.file);
      if (disk.report.unreadable) return;
      this.mergeFromDisk(disk);
      this.stamp = disk.stamp;
    });
    return true;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.catch(() => undefined).then(work);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Fold the on-disk state into memory. Per id:
   *   - changed by us since base (added/edited)  → ours wins
   *   - removed by us since base                 → stays removed (a deliberate
   *     forget()/prune beats a sibling's incidental reinforce of the same node)
   *   - untouched by us                          → disk's version (or gone, if
   *     disk dropped it)
   *   - unknown to us and to base                → a sibling's new node, kept
   * Then base := disk, so the next merge measures our changes from here.
   */
  private mergeFromDisk(disk: LoadedFile): void {
    const removedByUs = new Set<string>();
    for (const id of this.base.keys()) if (!this.nodes.has(id)) removedByUs.add(id);
    for (const [id, node] of disk.nodes) {
      if (removedByUs.has(id)) continue;
      const ours = this.nodes.get(id);
      const baseLine = this.base.get(id);
      const changedByUs = ours !== undefined && JSON.stringify(ours) !== baseLine;
      if (changedByUs) continue;
      this.nodes.set(id, node);
    }
    for (const id of [...this.nodes.keys()]) {
      if (disk.nodes.has(id)) continue;
      const baseLine = this.base.get(id);
      if (baseLine === undefined) continue; // ours, new
      const ours = this.nodes.get(id);
      if (ours !== undefined && JSON.stringify(ours) !== baseLine) continue; // ours, edited — keep
      this.nodes.delete(id); // a sibling forgot it, and we did not touch it
    }
    // Pass-through lines: union, minus the ones a sibling already dropped and
    // we never produced ourselves.
    const keep = new Set<string>(disk.quarantined);
    for (const line of this.quarantined) if (!this.baseQuarantined.has(line)) keep.add(line);
    this.quarantined = [...keep];
    this.base = snapshot(disk.nodes);
    this.baseQuarantined = new Set(disk.quarantined);
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

  async add(input: AddInput): Promise<MemoryNode> {
    const node = this.insert(input);
    await this.persist();
    // Embed at write time — but in the background. A turn never waits on a model.
    this.scheduleEmbedRefresh();
    return node;
  }

  /**
   * Add many nodes with a SINGLE persist() at the end. A bulk write (durable-fact
   * merges, dream candidate batches) that looped add() rewrote the whole JSONL
   * file once per node — N adds → N full-file rewrites, O(N²). This inserts all
   * in memory, then flushes once. Same nodes, same embed refresh, one write.
   */
  async addMany(inputs: readonly AddInput[]): Promise<MemoryNode[]> {
    if (inputs.length === 0) return [];
    const nodes = inputs.map((input) => this.insert(input));
    await this.persist();
    this.scheduleEmbedRefresh();
    return nodes;
  }

  /** Build + register a node in memory WITHOUT persisting — the shared core of
   *  add()/addMany(). Callers own the flush so a batch can write the file once. */
  private insert(input: AddInput): MemoryNode {
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
      status: input.status,
      check: input.check,
      scope: input.scope,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  /**
   * Wire semantic seeding: an embedder plus the sidecar vector index. From here
   * on add() refreshes vectors in the background, consolidate() settles them,
   * and remember() blends embedding similarity into its seeds — using only
   * vectors already in the index, never blocking a recall on embedding work.
   */
  attachEmbedder(embedder: Embedder, index: EmbedIndex): void {
    this.embedder = embedder;
    this.embedIndex = index;
  }

  /** Embed every stale node now and persist the sidecar. Embedder errors propagate. */
  async reindex(): Promise<void> {
    await this.embedQueue.catch(() => {});
    await this.refreshEmbeddings();
  }

  /** Background, best-effort refresh — serialized so writes never interleave. */
  private scheduleEmbedRefresh(): void {
    if (!this.embedder || !this.embedIndex) return;
    this.embedQueue = this.embedQueue
      .catch(() => {})
      .then(() => this.refreshEmbeddings())
      .catch(() => {
        // Best-effort by design: an unreachable embedder costs freshness, never
        // a turn. reindex() is the path that surfaces the error.
      });
  }

  /** Drop vectors for deleted nodes, embed stale ones, persist if anything moved. */
  private async refreshEmbeddings(): Promise<void> {
    const embedder = this.embedder;
    const index = this.embedIndex;
    if (!embedder || !index) return;
    let changed = false;
    for (const id of index.ids()) {
      if (!this.nodes.has(id)) {
        index.remove(id);
        changed = true;
      }
    }
    const live = this.all().map((n) => ({ id: n.id, content: n.content }));
    const contentById = new Map(live.map((n) => [n.id, n.content]));
    const stale = index.staleIds(live);
    for (let i = 0; i < stale.length; i += EMBED_BATCH) {
      const batch = stale.slice(i, i + EMBED_BATCH);
      const vectors = await embedder.embed(batch.map((id) => contentById.get(id) ?? ""));
      for (let j = 0; j < batch.length; j++) {
        const vector = vectors[j];
        if (!Array.isArray(vector) || vector.length === 0) continue;
        const content = contentById.get(batch[j]);
        if (content === undefined) continue;
        index.upsert(batch[j], contentHash(content), vector);
        changed = true;
      }
    }
    if (changed) await index.persist();
  }

  /**
   * Embed the cue with a hard timeout. Anything but a prompt, well-formed
   * vector — slow model, network error, empty result — yields undefined and
   * recall proceeds purely lexical. The embedder is not even consulted when the
   * index holds no vectors (nothing to compare against).
   */
  private async embedCue(cue: string): Promise<Float32Array | undefined> {
    const embedder = this.embedder;
    const index = this.embedIndex;
    if (!embedder || !index || index.size === 0) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<undefined>((resolve) => {
        // Deliberately NOT unref'd: this timer is the guarantee that a hung
        // embedder cannot hang remember() — an unref'd timer never fires when
        // it is the only thing left on the loop. Cleared in finally; worst
        // case it holds the process open for 300ms.
        timer = setTimeout(() => resolve(undefined), CUE_EMBED_TIMEOUT_MS);
      });
      const embedded = embedder.embed([cue]).then((vs) => vs[0]);
      // A rejection landing AFTER the timeout won the race must never surface
      // as an unhandled rejection — mark it handled up front.
      embedded.catch(() => {});
      const vector = await Promise.race([embedded, timeout]);
      if (!Array.isArray(vector) || vector.length === 0) return undefined;
      return Float32Array.from(vector);
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Recall options with vector seeding wired in — or untouched when unavailable. */
  private async withCueVectors(cue: string, opts: RecallOptions): Promise<RecallOptions> {
    if (opts.vectors) return opts; // caller brought their own
    const index = this.embedIndex;
    if (!index) return opts;
    const cueVector = await this.embedCue(cue);
    if (!cueVector) return opts; // lexical fallback — the V4 invariant
    return { ...opts, vectors: { get: (id) => index.get(id), cueVector } };
  }

  /** Crucible hypotheses awaiting trial. */
  candidates(): MemoryNode[] {
    return this.all().filter((n) => n.status === "candidate");
  }

  /**
   * V6 consequence wiring — the part no shipped agent has. An outcome landed
   * (probe verdict, verifier result, turn status); every memory that was IN
   * PLAY for that outcome gets the evidence appended and its strength moved by
   * the result, not by recall popularity: wins reinforce, losses weaken. The
   * caller decides what "in play" means (recall-injected ids, a skill used,
   * a belief acted on).
   */
  async recordOutcome(
    ids: readonly string[],
    outcome: { won: boolean; note: string; fingerprint?: string; now?: Date },
  ): Promise<number> {
    const now = outcome.now ?? new Date();
    let touched = 0;
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const entry = {
        at: now.toISOString(),
        won: outcome.won,
        note: outcome.note.slice(0, 240),
        ...(outcome.fingerprint !== undefined ? { fingerprint: outcome.fingerprint } : {}),
      };
      const evidence = [...(node.evidence ?? []), entry].slice(-EVIDENCE_CAP);
      const adjusted = outcome.won ? reinforce(node, now, 0.4) : weaken(node, now);
      this.nodes.set(id, { ...adjusted, evidence });
      touched++;
    }
    if (touched > 0) await this.persist();
    return touched;
  }

  /**
   * Reinforce nodes WITHOUT a recall: the router calls this when a write
   * collapsed into an existing near-duplicate, so "the owner asked the same
   * thing again" bumps the node it already has instead of minting a twin.
   * Unknown ids are ignored. Returns how many nodes moved.
   */
  async touch(ids: readonly string[], opts: { now?: Date } = {}): Promise<number> {
    const now = opts.now ?? new Date();
    let touched = 0;
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      this.nodes.set(id, reinforce(node, now));
      touched++;
    }
    if (touched > 0) await this.persist();
    return touched;
  }

  /** Crucible lifecycle transition (V7 trial verdicts). Records the reason as evidence. */
  async setStatus(
    id: string,
    status: HypothesisStatus,
    note: string,
    opts: { now?: Date } = {},
  ): Promise<MemoryNode | undefined> {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    const now = opts.now ?? new Date();
    const evidence = [
      ...(node.evidence ?? []),
      { at: now.toISOString(), won: status === "confirmed", note: note.slice(0, 240) },
    ].slice(-EVIDENCE_CAP);
    const next = { ...node, status, evidence };
    this.nodes.set(id, next);
    await this.persist();
    return next;
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
   * Forget a single memory node by id — the public counterpart to consolidate()'s
   * internal auto-prune. Until now the only way to remove a node was to be a weak
   * episodic memory caught by consolidate(); there was no way for a human (or an
   * `ares mind forget <id>` command) to delete one on purpose. Returns whether a
   * node with that id existed and was removed.
   */
  async forget(id: string): Promise<boolean> {
    const existed = this.nodes.has(id);
    if (!existed) return false;
    this.deleteNode(id);
    await this.persist();
    return true;
  }

  /**
   * Owner-initiated in-place correction — the "that's wrong, it's actually X"
   * affordance. This is a DELIBERATE exception to the MemoryRouter-only write
   * rule: the router exists to gate agent-originated writes (dedupe, noise
   * filters, channel policy), and a correction the owner typed must land
   * verbatim on the exact node — routed through dedupe it could collapse into
   * the very content being corrected. Confidence jumps to 1 (the owner said
   * so), `editedAt`/`editedBy:"owner"` record the provenance, and the embed
   * sidecar goes stale automatically because it keys vectors by content hash
   * (see EmbedIndex.staleIds) — the next refresh re-embeds the new content.
   * Returns the before/after pair, or undefined when no node has that id.
   */
  async edit(id: string, content: string, opts: { now?: Date } = {}): Promise<MemoryEditResult | undefined> {
    const before = this.nodes.get(id);
    if (!before) return undefined;
    const trimmed = trimMemoryContent(content);
    if (!trimmed) return undefined;
    const after: MemoryNode = {
      ...before,
      content: trimmed,
      confidence: 1,
      editedAt: (opts.now ?? new Date()).toISOString(),
      editedBy: "owner",
    };
    this.nodes.set(id, after);
    await this.persist();
    this.scheduleEmbedRefresh();
    return { before, after };
  }

  /**
   * The owner-facing "what I know about you" surface: top nodes by
   * {@link livenessScore} (decayed strength + recency — the same ranking the
   * context compiler trusts), grouped by kind so beliefs, skills, and episodes
   * read separately. Read-only by design: looking at your own memory must
   * never reinforce it (that's peek()'s doctrine too). Scope defaults to the
   * owner's pool — guest:* nodes never appear unless that scope is asked for
   * explicitly, so a shared screen can't leak a Telegram guest's memories.
   */
  overview(opts: OverviewOptions = {}): MemoryOverviewGroups {
    const now = opts.now ?? new Date();
    const limit = opts.limit ?? overviewLimit();
    const pool = scopedNodes(this.all(), opts.scope ?? OWNER_SCOPE);
    const groups: MemoryOverviewGroups = { semantic: [], procedural: [], episodic: [] };
    const ranked = [...pool].sort((a, b) => livenessScore(b, now) - livenessScore(a, now));
    for (const node of ranked) {
      const group = groups[node.kind];
      if (!group || group.length >= limit) continue;
      const clipped = node.content.length > OVERVIEW_CONTENT_CLIP
        ? `${node.content.slice(0, OVERVIEW_CONTENT_CLIP - 1)}…`
        : node.content;
      group.push({
        id: node.id,
        kind: node.kind,
        content: clipped,
        strength: node.strength,
        currentStrength: currentStrength(node, now),
        activations: node.activations,
        ageDays: ageDays(node.at, now),
        ...(node.tags ? { tags: node.tags } : {}),
        ...(node.confidence !== undefined ? { confidence: node.confidence } : {}),
      });
    }
    return groups;
  }

  /**
   * Recall a constellation of memories AND strengthen them. Surfacing a memory
   * reinforces it (so what's used stays vivid), and the top co-activated pair is
   * linked (Hebbian association forms from use).
   *
   * `scope` restricts the candidate pool to nodes owned by that tenant PLUS
   * unscoped (owner) nodes — never the reverse, so a guest scope can never see
   * another tenant's memories, and omitting scope entirely (the default) recalls
   * exactly as before.
   */
  async remember(cue: string, opts: RecallOptions & { scope?: string } = {}): Promise<RecallResult[]> {
    const now = opts.now ?? new Date();
    const pool = scopedNodes(this.all(), opts.scope);
    const results = recall(cue, pool, await this.withCueVectors(cue, opts));
    // Nothing surfaced → nothing to reinforce → nothing to write. A 0-hit
    // recall used to rewrite the whole file from this instance's snapshot;
    // from a server that opened the store at boot that erased every memory
    // written since (#23). No hit, no touch.
    if (results.length === 0) return results;
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
   *
   * `scope` behaves exactly as in remember() — see there.
   */
  peek(cue: string, opts: RecallOptions & { scope?: string } = {}): RecallResult[] {
    return recall(cue, scopedNodes(this.all(), opts.scope), opts);
  }

  /** Sleep: forget trivial episodes; crystallize recurring themes into knowledge. */
  async consolidate(opts: { now?: Date } = {}): Promise<ConsolidationReport> {
    const now = opts.now ?? new Date();
    let pruned = 0;
    let deduped = 0;
    const promoted: string[] = [];

    // 1. Forget faded one-off episodes and stale filler "theme" semantics.
    for (const node of this.all()) {
      // Operational noise (tool/provider error text) is never knowledge, no
      // matter its kind or source — stores populated BEFORE the write-spine
      // noise gate existed still carry these (a field index was 83% error
      // entries, 2026-08-06), and this sweep is what durably cleans them out.
      if (isOperationalNoise(node.content)) {
        this.deleteNode(node.id);
        pruned++;
        continue;
      }
      // Crystallized insight/belief nodes the deep dream synthesized are normally
      // spared pruning — but not unconditionally: a synthesized belief that keeps
      // getting DISPROVEN via recordOutcome (driven down to PRUNE_FLOOR by repeat
      // losses) is dead weight forever otherwise, a near-zero-strength node that
      // still surfaces as a recall candidate. Require enough evidence (>=3) so a
      // single early loss can't kill a fresh insight, and a losing majority.
      if (node.source === "synthesis") {
        if (isDisprovenSynthesis(node, now)) {
          this.deleteNode(node.id);
          pruned++;
        }
        continue;
      }
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

    // Theme promotion is GONE. Single-token "Recurring theme \"X\" observed
    // across N episodes" semantics carried no knowledge — just a token and a
    // count — and the stopword gate was unwinnable whack-a-mole: on the
    // owner's real store, 47 of 66 nodes were themes like "first", "every"
    // and "claude" (2026-08-10). Crystallization is synthesize()'s job — its
    // insight/belief nodes carry IDF-ranked multi-token keys, provenance
    // links, confidence, and optional phrased prose. isNoiseThemeSemantic now
    // treats EVERY legacy theme node as prunable filler (step 1 above).

    await this.persist();
    // Settle vectors with sleep: prune deleted ids, embed new/edited nodes.
    // Best-effort — consolidation must succeed even with the embedder down.
    await this.embedQueue.catch(() => {});
    await this.refreshEmbeddings().catch(() => {});
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

  /**
   * Write the store: read-modify-write under the cross-process file lock.
   * Every mutator used to rewrite the whole file from its own map, so two
   * processes writing in the same second kept only the later one (#24) and a
   * long-lived snapshot wiped everything newer on its first write (#23). Now:
   * take the lock, re-read the file, merge (see mergeFromDisk), write, release.
   * Refused outright when open() could not read the file — we will not
   * overwrite what we never saw (#25).
   */
  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve();
    if (this.readOnly) {
      return Promise.reject(new Error(`refusing to write memory: ${this.file} could not be read at open (${this.loadReport.unreadable})`));
    }
    return this.enqueue(() =>
      withFileLock(this.file, async () => {
        const disk = await loadFile(this.file);
        if (disk.report.unreadable) {
          throw new Error(`refusing to write memory: ${this.file} became unreadable (${disk.report.unreadable})`);
        }
        this.mergeFromDisk(disk);
        // Active nodes first, then pass-through lines verbatim — so a round-trip
        // through an older binary never destroys forward-version data.
        const lines = [...this.all().map((n) => JSON.stringify(n)), ...this.quarantined];
        await writeFileAtomic(this.file, lines.length ? lines.join("\n") + "\n" : "");
        this.base = snapshot(this.nodes);
        this.baseQuarantined = new Set(this.quarantined);
        this.stamp = await statStamp(this.file);
      }),
    );
  }

  /**
   * Merge exact-content duplicates WITHIN a tenant scope. The key carries the
   * scope: content alone merged a guest's node into the owner's (an isolation
   * break — the guest's activations and tags then rode on an owner memory) and
   * vice versa (#26). The keeper is the node that carries the most standing:
   * a confirmed hypothesis over a candidate, settled knowledge (semantic) over
   * an episode, then the strongest — so a merge never demotes what the store
   * already trusted most.
   */
  private mergeDuplicateContent(now: Date): number {
    const byContent = new Map<string, MemoryNode[]>();
    for (const node of this.all()) {
      const normalized = normalizeForDedup(node.content);
      if (!normalized) continue;
      const key = `${node.scope ?? ""}\u0000${normalized}`;
      const bucket = byContent.get(key) ?? [];
      bucket.push(node);
      byContent.set(key, bucket);
    }

    let merged = 0;
    for (const group of byContent.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => {
        const statusDelta = statusRank(b) - statusRank(a);
        if (statusDelta !== 0) return statusDelta;
        const kindDelta = kindRank(b) - kindRank(a);
        if (kindDelta !== 0) return kindDelta;
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

/** consolidate() as a {@link ReflectionSurface}: same call, uniform envelope. */
export const consolidateReflectionSurface: ReflectionSurface<{ store: MemoryStore; now?: Date }> = {
  name: "consolidate",
  async run({ store, now }): Promise<ReflectionResult> {
    const report = await store.consolidate(now === undefined ? {} : { now });
    const directives = [
      ...(report.pruned ? [`pruned ${report.pruned} faded memory(ies)`] : []),
      ...(report.deduped ? [`merged ${report.deduped} duplicate(s)`] : []),
      ...report.promoted.map((t) => `promoted theme "${t}"`),
    ];
    return { directives, persistedTo: "memory.jsonl" };
  },
};

/** synthesize() as a {@link ReflectionSurface}: same call, uniform envelope. */
export const synthesizeReflectionSurface: ReflectionSurface<{
  store: MemoryStore;
  now?: Date;
  synthesizer?: Phraser;
  minMembers?: number;
}> = {
  name: "synthesize",
  async run({ store, now, synthesizer, minMembers }): Promise<ReflectionResult> {
    const report = await store.synthesize({
      ...(now === undefined ? {} : { now }),
      ...(synthesizer === undefined ? {} : { synthesizer }),
      ...(minMembers === undefined ? {} : { minMembers }),
    });
    const directives = [
      ...(report.insights ? [`crystallized ${report.insights} insight(s)`] : []),
      ...(report.beliefs ? [`crystallized ${report.beliefs} belief(s)`] : []),
      ...(report.updated ? [`reinforced ${report.updated} synthesis node(s)`] : []),
    ];
    return { directives, persistedTo: "memory.jsonl" };
  },
};

function sanitizeNode(node: MemoryNode): MemoryNode {
  const content = trimMemoryContent(node.content);
  return content === node.content ? node : { ...node, content };
}

function trimMemoryContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_MEMORY_CONTENT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_MEMORY_CONTENT_CHARS)}\n[truncated memory: ${trimmed.length - MAX_MEMORY_CONTENT_CHARS} chars omitted]`;
}

/** Days since `at`, one-decimal precision; an unparseable timestamp reads as 0. */
function ageDays(at: string, now: Date): number {
  const formed = Date.parse(at);
  if (Number.isNaN(formed)) return 0;
  return Math.round(Math.max(0, now.getTime() - formed) / 86_400_000 * 10) / 10;
}

function normalizeForDedup(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Dedupe keeper precedence by Crucible status: confirmed > ordinary > candidate > archived. */
function statusRank(node: MemoryNode): number {
  switch (node.status) {
    case "confirmed": return 3;
    case undefined: return 2;
    case "candidate": return 1;
    default: return 0; // archived
  }
}

/** Dedupe keeper precedence by kind: knowledge outranks a skill pointer outranks an episode. */
function kindRank(node: MemoryNode): number {
  switch (node.kind) {
    case "semantic": return 2;
    case "procedural": return 1;
    default: return 0;
  }
}

/** Per-id serialized view of a node map — the merge's "what did we last see". */
function snapshot(nodes: ReadonlyMap<string, MemoryNode>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, node] of nodes) out.set(id, JSON.stringify(node));
  return out;
}

function sameStamp(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}


const MIN_PRUNE_EVIDENCE = 3;

/**
 * True when a synthesized (insight/belief) node has been driven to (or near)
 * PRUNE_FLOOR by repeated recordOutcome losses — i.e. reality kept disproving
 * it. Requires at least MIN_PRUNE_EVIDENCE outcomes with a losing majority so
 * one bad early trial can't prune a belief that hasn't had a fair shake yet.
 */
function isDisprovenSynthesis(node: MemoryNode, now: Date): boolean {
  const evidence = node.evidence ?? [];
  if (evidence.length < MIN_PRUNE_EVIDENCE) return false;
  const losses = evidence.filter((e) => !e.won).length;
  if (losses <= evidence.length / 2) return false;
  return currentStrength(node, now) < PRUNE_FLOOR;
}

/** EVERY theme node is filler now that theme promotion is gone: a single
 *  token plus a count is not knowledge, and synthesize() owns crystallization.
 *  This prunes the legacy population (47 of 66 nodes on one real store). */
function isNoiseThemeSemantic(node: MemoryNode): boolean {
  if (node.kind !== "semantic") return false;
  return Boolean(
    node.tags?.some((t) => t.startsWith("theme:")) ||
    /^Recurring theme "[^"]+" observed across \d+ episodes\.?$/.test(node.content),
  );
}
