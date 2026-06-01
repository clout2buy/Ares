// The Living Memory store (Crix v6 / M1).
//
// Durable, pluggable-home memory with the behaviors no filing-cabinet store has:
//   remember()    — spreading-activation recall that ALSO strengthens what it
//                   surfaces (recalling makes it stick) and wires co-activated
//                   memories together (fire together → wire together).
//   consolidate() — "sleep": forget trivial episodes, and crystallize recurring
//                   themes into lasting semantic knowledge.
//
// The store is just a path away from living anywhere — point `open()` at a
// flashdrive and Crix's whole memory lives there.

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "@crix/agent";
import { mindPaths } from "../paths.js";
import { currentStrength, reinforce } from "./strength.js";
import { recall, type RecallOptions, type RecallResult } from "./recall.js";
import type { MemoryKind, MemoryNode } from "./types.js";

export interface ConsolidationReport {
  pruned: number;
  promoted: string[];
  kept: number;
}

const PRUNE_FLOOR = 0.05;
const MIN_RECURRENCE = 3;

function resolveFile(root: string): string {
  return root.endsWith(".jsonl") ? root : path.join(root, "memory.jsonl");
}

function salientTokens(content: string): string[] {
  const seen = new Set<string>();
  for (const t of content.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (t.length >= 4) seen.add(t);
  }
  return [...seen];
}

export class MemoryStore {
  private constructor(
    private readonly file: string,
    private readonly nodes: Map<string, MemoryNode>,
  ) {}

  /** Open (or create) a memory store at a root dir/file — the pluggable home. */
  static async open(root?: string): Promise<MemoryStore> {
    const file = root ? resolveFile(root) : mindPaths().memoryFile;
    const nodes = new Map<string, MemoryNode>();
    try {
      const raw = await fs.readFile(file, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const node = JSON.parse(trimmed) as MemoryNode;
          nodes.set(node.id, node);
        } catch {
          // skip corrupt line
        }
      }
    } catch {
      // no memory yet
    }
    return new MemoryStore(file, nodes);
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
      id: `mem_${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      content: input.content.trim(),
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

  /** Sleep: forget trivial episodes; crystallize recurring themes into knowledge. */
  async consolidate(opts: { now?: Date } = {}): Promise<ConsolidationReport> {
    const now = opts.now ?? new Date();
    let pruned = 0;
    const promoted: string[] = [];

    // 1. Forget faded one-off episodes (keep semantic knowledge + procedural skills).
    for (const node of this.all()) {
      if (node.kind === "episodic" && currentStrength(node, now) < PRUNE_FLOOR) {
        this.nodes.delete(node.id);
        pruned++;
      }
    }

    // 2. Promote recurring episodic themes into durable semantic knowledge.
    const byToken = new Map<string, MemoryNode[]>();
    for (const node of this.all()) {
      if (node.kind !== "episodic") continue;
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
    return { pruned, promoted, kept: this.nodes.size };
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    const body = this.all().map((n) => JSON.stringify(n)).join("\n");
    await writeFileAtomic(this.file, body.length ? body + "\n" : "");
  }
}
