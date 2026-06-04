import path from "node:path";
import { agentPaths, crixAgentHome } from "./paths.js";
import { readTextIfExists, writeFileAtomic } from "./files.js";
import { emitLifecycle } from "./lifecycle/bus.js";

export interface ToolPatternObservation {
  key: string;
  description: string;
  observedAt: string;
}

export interface SkillProposal {
  name: string;
  path: string;
  hitCount: number;
  approved: false;
}

export async function recordToolPattern(opts: {
  home?: string;
  key: string;
  description: string;
  now?: Date;
}): Promise<void> {
  const home = crixAgentHome(opts.home);
  const paths = agentPaths(home);
  const file = path.join(paths.dreamsDir, "tool-patterns.json");
  const state = await readPatterns(file);
  state.push({ key: opts.key, description: opts.description, observedAt: (opts.now ?? new Date()).toISOString() });
  await writeFileAtomic(file, JSON.stringify(state.slice(-1000), null, 2) + "\n");
}

export async function proposeSkills(opts: {
  home?: string;
  minHits?: number;
  windowDays?: number;
  now?: Date;
} = {}): Promise<SkillProposal[]> {
  const home = crixAgentHome(opts.home);
  const paths = agentPaths(home);
  const file = path.join(paths.dreamsDir, "tool-patterns.json");
  const state = await readPatterns(file);
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - (opts.windowDays ?? 14) * 24 * 60 * 60_000;
  const groups = new Map<string, ToolPatternObservation[]>();
  for (const item of state) {
    if (new Date(item.observedAt).getTime() < cutoff) continue;
    const list = groups.get(item.key) ?? [];
    list.push(item);
    groups.set(item.key, list);
  }
  const proposals: SkillProposal[] = [];
  for (const [key, hits] of groups) {
    if (hits.length < (opts.minHits ?? 5)) continue;
    const name = slug(key);
    const skillDir = path.join(paths.skillsDir, name);
    const skillPath = path.join(skillDir, "SKILL.md");
    const content = [
      "---",
      `description: Learned Crix workflow for ${key}`,
      "status: proposed",
      "version: 1",
      "---",
      "",
      `# ${name}`,
      "",
      "This skill was proposed from repeated local observations.",
      "",
      "## Pattern",
      "",
      hits[0].description,
      "",
      "## Safety",
      "",
      "This is markdown-only until the user explicitly approves code or tool changes.",
    ].join("\n");
    await writeFileAtomic(skillPath, content + "\n");
    proposals.push({ name, path: skillPath, hitCount: hits.length, approved: false });
    emitLifecycle({ type: "skill_proposed", name });
  }
  return proposals;
}

async function readPatterns(file: string): Promise<ToolPatternObservation[]> {
  const raw = await readTextIfExists(file, 10_000_000);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ToolPatternObservation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "learned-skill";
}

