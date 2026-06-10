import { currentStrength } from "./strength.js";
import type { MemoryKind, MemoryNode } from "./types.js";

export interface DuplicateMemoryGroup {
  content: string;
  ids: string[];
}

export interface MemoryDoctorReport {
  total: number;
  byKind: Record<MemoryKind, number>;
  generatedThemeSemantics: number;
  noisyThemeSemantics: number;
  duplicateGroups: DuplicateMemoryGroup[];
  orphanLinks: Array<{ id: string; missing: string[] }>;
  lowStrengthEpisodes: number;
  oversized: Array<{ id: string; chars: number }>;
  strongest: Array<{ id: string; kind: MemoryKind; strength: number; content: string }>;
  recommendations: string[];
}

const MAX_EXPECTED_MEMORY_CHARS = 2_100;
const LOW_STRENGTH_FLOOR = 0.05;
const NOISE_THEME_TOKENS = new Set([
  "about", "again", "check", "clean", "ares", "files", "found", "homie", "issue",
  "just", "lmao", "memory", "model", "right", "self", "state", "still", "thing",
  "think", "using", "work",
]);

export function diagnoseMemory(nodes: readonly MemoryNode[], opts: { now?: Date } = {}): MemoryDoctorReport {
  const now = opts.now ?? new Date();
  const ids = new Set(nodes.map((n) => n.id));
  const byKind: Record<MemoryKind, number> = { episodic: 0, semantic: 0, procedural: 0 };
  const duplicateBuckets = new Map<string, string[]>();
  const orphanLinks: MemoryDoctorReport["orphanLinks"] = [];
  const oversized: MemoryDoctorReport["oversized"] = [];
  let generatedThemeSemantics = 0;
  let noisyThemeSemantics = 0;
  let lowStrengthEpisodes = 0;

  for (const node of nodes) {
    byKind[node.kind]++;
    const normalized = normalizeContent(node.content);
    duplicateBuckets.set(normalized, [...(duplicateBuckets.get(normalized) ?? []), node.id]);

    const missing = node.links.filter((id) => !ids.has(id));
    if (missing.length) orphanLinks.push({ id: node.id, missing });
    if (node.content.length > MAX_EXPECTED_MEMORY_CHARS) oversized.push({ id: node.id, chars: node.content.length });
    if (node.kind === "episodic" && currentStrength(node, now) < LOW_STRENGTH_FLOOR) lowStrengthEpisodes++;
    if (isGeneratedThemeSemantic(node)) generatedThemeSemantics++;
    if (isNoisyThemeSemantic(node)) noisyThemeSemantics++;
  }

  const duplicateGroups = [...duplicateBuckets.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([content, ids]) => ({ content, ids }));

  const strongest = [...nodes]
    .sort((a, b) => currentStrength(b, now) - currentStrength(a, now))
    .slice(0, 8)
    .map((node) => ({
      id: node.id,
      kind: node.kind,
      strength: Number(currentStrength(node, now).toFixed(3)),
      content: node.content.slice(0, 160),
    }));

  const recommendations = buildRecommendations({
    total: nodes.length,
    generatedThemeSemantics,
    noisyThemeSemantics,
    duplicateGroups,
    orphanLinks,
    lowStrengthEpisodes,
    oversized,
  });

  return {
    total: nodes.length,
    byKind,
    generatedThemeSemantics,
    noisyThemeSemantics,
    duplicateGroups,
    orphanLinks,
    lowStrengthEpisodes,
    oversized,
    strongest,
    recommendations,
  };
}

function buildRecommendations(report: {
  total: number;
  generatedThemeSemantics: number;
  noisyThemeSemantics: number;
  duplicateGroups: DuplicateMemoryGroup[];
  orphanLinks: MemoryDoctorReport["orphanLinks"];
  lowStrengthEpisodes: number;
  oversized: MemoryDoctorReport["oversized"];
}): string[] {
  const out: string[] = [];
  if (report.total === 0) out.push("Memory is empty; bootstrap identity and capture durable user preferences first.");
  if (report.noisyThemeSemantics > 0 || report.lowStrengthEpisodes > 0) out.push("Run `ares mind consolidate` to prune faded episodes and filler recurring themes.");
  if (report.duplicateGroups.length > 0) out.push("Review duplicate memory groups; repeated exact content should usually be one stronger node, not many weak copies.");
  if (report.orphanLinks.length > 0) out.push("Repair orphan links by reopening the store and consolidating, or by pruning corrupt entries.");
  if (report.oversized.length > 0) out.push("Oversized entries should be summarized before they enter memory.");
  if (out.length === 0) out.push("Memory shape is healthy.");
  return out;
}

function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

function isGeneratedThemeSemantic(node: MemoryNode): boolean {
  return node.kind === "semantic" && Boolean(themeToken(node));
}

function isNoisyThemeSemantic(node: MemoryNode): boolean {
  const token = themeToken(node);
  return Boolean(token && NOISE_THEME_TOKENS.has(token.toLowerCase()));
}

function themeToken(node: MemoryNode): string | undefined {
  const tag = node.tags?.find((t) => t.startsWith("theme:"));
  if (tag) return tag.slice("theme:".length);
  return node.content.match(/^Recurring theme "([^"]+)"/)?.[1];
}
