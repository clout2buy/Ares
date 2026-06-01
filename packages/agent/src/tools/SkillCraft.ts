// SkillCraft — agent forges its own skills under ~/.crix/skills/.
//
// A skill is just a directory with at minimum SKILL.md describing what it
// does, optionally a handler.js the agent or future sessions can execute.
// The agent uses SkillCraft when it notices a capability gap: instead of
// asking the user, it scaffolds a new skill, registers it, and updates
// CAPABILITIES.md.
//
// This is part of self-extension: the agent grows its own body.

import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { buildTool } from "@crix/tools";
import { agentPaths, crixAgentHome } from "../paths.js";
import { exists, writeFileAtomic } from "../files.js";
import { emitLifecycle } from "../lifecycle/bus.js";
import { gainForTarget } from "../voice.js";
import { dropCapability, upsertCapability } from "../self/store.js";

const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{1,63}$/;

const inputSchema = z
  .object({
    action: z
      .enum(["create", "update", "remove", "list", "read"])
      .describe("create a new skill, update an existing one (SKILL.md or handler), remove one, list all, or read one."),
    name: z
      .string()
      .optional()
      .describe("Skill name. Lowercase, snake_case or kebab-case. Required for create/update/remove/read."),
    description: z
      .string()
      .optional()
      .describe("Short description of what the skill does. Used as SKILL.md frontmatter for create."),
    skill_md: z
      .string()
      .optional()
      .describe("Full SKILL.md body. For create/update."),
    handler_js: z
      .string()
      .optional()
      .describe("Optional handler.js code. For create/update."),
    reason: z
      .string()
      .optional()
      .describe("Why this skill is being crafted. Logged for traceability."),
  })
  .strict();

export interface SkillCraftOutput {
  action: string;
  name?: string;
  skillDir?: string;
  files?: string[];
  list?: Array<{ name: string; description: string }>;
  skillMd?: string;
  handlerJs?: string | null;
}

export const SkillCraftTool = buildTool({
  name: "SkillCraft",
  description:
    "Forge your own skills under ~/.crix/skills/. When you notice a capability gap — something you'll need to do that you don't have a clean path for yet — scaffold a skill instead of asking. A skill is just SKILL.md (description, usage, examples) plus optional handler.js. After crafting, append the skill name to CAPABILITIES.md via SelfEvolve. You can also update / remove / list / read your own skills. This is part of your self-extension: you grow your own body.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `SkillCraft ${i.action}${i.name ? ` ${i.name}` : ""}`,

  async call(input, _ctx): Promise<{ output: SkillCraftOutput; touchedFiles?: string[]; display: string }> {
    const home = crixAgentHome(process.env.CRIX_HOME);
    const paths = agentPaths(home);
    await fs.mkdir(paths.skillsDir, { recursive: true });

    if (input.action === "list") {
      const entries = await listSkills(paths.skillsDir);
      return {
        output: { action: "list", list: entries },
        display: `${entries.length} skill(s) on file`,
      };
    }

    if (!input.name) throw new Error(`SkillCraft.${input.action} requires name`);
    if (!SKILL_NAME.test(input.name)) throw new Error(`SkillCraft: invalid name '${input.name}'. Use lowercase letters, digits, _ or -.`);
    const skillDir = path.join(paths.skillsDir, input.name);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const handlerPath = path.join(skillDir, "handler.js");

    if (input.action === "remove") {
      await fs.rm(skillDir, { recursive: true, force: true });
      try {
        await dropCapability(home, `skill/${input.name}`);
      } catch {
        // self-model is best-effort
      }
      const gain = gainForTarget("SKILL", -1, "removed");
      emitLifecycle({ type: "skill_crafted", name: input.name, action: "removed", gain });
      return {
        output: { action: "remove", name: input.name, skillDir },
        display: `-1 SKILL — removed ${input.name}`,
      };
    }

    if (input.action === "read") {
      if (!(await exists(skillMdPath))) throw new Error(`SkillCraft.read: skill '${input.name}' has no SKILL.md`);
      const skillMd = await fs.readFile(skillMdPath, "utf8");
      let handlerJs: string | null = null;
      if (await exists(handlerPath)) handlerJs = await fs.readFile(handlerPath, "utf8");
      return {
        output: { action: "read", name: input.name, skillDir, skillMd, handlerJs },
        display: `read skill ${input.name}`,
      };
    }

    // create / update
    const exists0 = await exists(skillMdPath);
    if (input.action === "create" && exists0) {
      throw new Error(`SkillCraft.create: skill '${input.name}' already exists. Use update instead.`);
    }
    if (input.action === "update" && !exists0) {
      throw new Error(`SkillCraft.update: skill '${input.name}' does not exist. Use create instead.`);
    }

    await fs.mkdir(skillDir, { recursive: true });
    const skillMdBody = input.skill_md ?? defaultSkillMd(input.name, input.description ?? "");
    await writeFileAtomic(skillMdPath, ensureTrailingNewline(skillMdBody));
    const touched: string[] = [skillMdPath];
    if (input.handler_js !== undefined) {
      await writeFileAtomic(handlerPath, ensureTrailingNewline(input.handler_js));
      touched.push(handlerPath);
    }

    // Auto-log to capabilities ledger so the agent's body of work is visible.
    await appendCapability(paths.capabilities, input.name, input.description ?? "(no description)", input.action);

    // Register the skill as a node in the machine-readable self-model so the
    // growth engine can track and reason over it. Best-effort.
    try {
      await upsertCapability(home, {
        id: `skill/${input.name}`,
        kind: "skill",
        name: input.name,
        status: "have",
        provenance: "SkillCraft",
        description: input.description,
        tags: input.handler_js !== undefined ? ["runnable"] : undefined,
      });
    } catch {
      // self-model is best-effort
    }

    const gain = gainForTarget("SKILL", 1, input.action);
    const lifecycleAction = input.action === "create" ? "created" : "updated";
    emitLifecycle({ type: "skill_crafted", name: input.name, action: lifecycleAction, gain });

    return {
      output: { action: input.action, name: input.name, skillDir, files: touched },
      touchedFiles: touched,
      display: `+1 SKILL — ${input.action} ${input.name}`,
    };
  },
});

async function listSkills(dir: string): Promise<Array<{ name: string; description: string }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: Array<{ name: string; description: string }> = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const md = path.join(dir, e.name, "SKILL.md");
      let desc = "(no SKILL.md)";
      try {
        const text = await fs.readFile(md, "utf8");
        const m = text.match(/^description:\s*(.+)$/m);
        if (m) desc = m[1].trim();
        else {
          const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0 && !l.startsWith("#"));
          if (firstLine) desc = firstLine.trim().slice(0, 200);
        }
      } catch {
        // SKILL.md missing or unreadable — keep default
      }
      out.push({ name: e.name, description: desc });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function defaultSkillMd(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
---

# ${name}

## What it does

${description || "(describe the capability this skill provides)"}

## When to use

(describe triggers)

## How it works

(describe the implementation: shell commands, handler.js function, package
dependencies, etc.)

## Examples

\`\`\`
(usage examples)
\`\`\`
`;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : text + "\n";
}

async function appendCapability(file: string, name: string, description: string, action: string): Promise<void> {
  if (!(await exists(file))) return; // CAPABILITIES.md not bootstrapped yet — silent skip.
  const line = `- ${new Date().toISOString().slice(0, 10)} — skill/${name} (${action}): ${description}\n`;
  await fs.appendFile(file, line, "utf8");
}
