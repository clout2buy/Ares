// Skills — discover markdown workflows from .crix/skills and ~/.crix/skills.

import { z } from "zod";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTool } from "./_shared.js";

const listInputSchema = z
  .object({
    query: z.string().optional().describe("Optional case-insensitive filter over skill name/description."),
  })
  .strict();

const readInputSchema = z
  .object({
    name: z.string().min(1).describe("Skill name returned by SkillsList."),
  })
  .strict();

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

export interface SkillsListOutput {
  roots: string[];
  skills: SkillSummary[];
}

export interface SkillReadOutput extends SkillSummary {
  content: string;
}

export const SkillsListTool = buildTool({
  name: "SkillsList",
  description:
    "List project/user skills. Skills are markdown workflow files named SKILL.md under .crix/skills/<name>/ or ~/.crix/skills/<name>/. Use when the user mentions a skill or asks for a reusable workflow.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: listInputSchema,
  activityDescription: (i) => (i.query ? `Listing skills matching ${i.query}` : "Listing skills"),

  async call(i, ctx): Promise<{ output: SkillsListOutput; display: string }> {
    const roots = skillRoots(ctx.workspace);
    const all = (await Promise.all(roots.map(scanRoot))).flat();
    const query = i.query?.trim().toLowerCase();
    const skills = query
      ? all.filter((s) => `${s.name}\n${s.description}`.toLowerCase().includes(query))
      : all;
    return {
      output: { roots, skills },
      display: `${skills.length} skill${skills.length === 1 ? "" : "s"}`,
    };
  },
});

export const SkillReadTool = buildTool({
  name: "SkillRead",
  description:
    "Read the SKILL.md content for a discovered skill. Use after SkillsList when a workflow applies to the current task.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: readInputSchema,
  activityDescription: (i) => `Reading skill ${i.name}`,

  async call(i, ctx): Promise<{ output: SkillReadOutput; display: string }> {
    const all = (await Promise.all(skillRoots(ctx.workspace).map(scanRoot))).flat();
    const skill = all.find((s) => s.name === i.name);
    if (!skill) throw new Error(`Unknown skill: ${i.name}`);
    return {
      output: { ...skill, content: await fs.readFile(skill.path, "utf8") },
      display: `read ${skill.name}`,
    };
  },
});

function skillRoots(workspace: string): string[] {
  const home = process.env.CRIX_HOME || path.join(os.homedir(), ".crix");
  return [path.join(home, "skills"), path.join(workspace, ".crix", "skills")];
}

async function scanRoot(root: string): Promise<SkillSummary[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "SKILL.md");
    const content = await fs.readFile(file, "utf8").catch(() => "");
    if (!content) continue;
    skills.push({
      name: entry.name,
      description: extractDescription(content),
      path: file,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function extractDescription(content: string): string {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatter) {
    const desc = frontmatter[1].match(/^description:\s*(.+)$/m);
    if (desc) return desc[1].replace(/^["']|["']$/g, "").trim();
  }
  const firstParagraph = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  return firstParagraph ?? "";
}
