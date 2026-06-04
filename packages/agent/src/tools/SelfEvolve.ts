// SelfEvolve — the agent's hands on its own mind.
//
// Lets the agent read, rewrite, append, or patch the global brain files
// (SOUL.md, HEARTBEAT.md, USER.md, MEMORY.md, IDENTITY.md, CAPABILITIES.md) and append to
// today's raw daily memory log — all without invoking the workspace Write
// tool. Self-territory; no permission ritual. Every change is logged to the
// daily memory as a `self_evolve` entry so the agent can introspect later.

import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { buildTool } from "@crix/tools";
import { agentPaths, crixAgentHome } from "../paths.js";
import { exists, writeFileAtomic } from "../files.js";
import { emitLifecycle } from "../lifecycle/bus.js";
import { countAppendedItems, gainForTarget } from "../voice.js";

const TARGETS = ["soul", "heartbeat", "user", "memory", "identity", "capabilities", "daily"] as const;
type Target = (typeof TARGETS)[number];

const inputSchema = z
  .object({
    target: z
      .enum(TARGETS)
      .describe("Which mind file to edit: soul, heartbeat, user, memory, identity, capabilities, or daily (today's raw log)."),
    action: z
      .enum(["read", "append", "replace_section", "replace_file", "note"])
      .describe(
        "read: return current contents. append: append text to end. replace_section: replace a `## Heading` block. replace_file: overwrite entire file (use with care). note: append a timestamped note (daily only).",
      ),
    text: z
      .string()
      .optional()
      .describe("New content. Required for append, replace_section, replace_file, note."),
    section: z
      .string()
      .optional()
      .describe("Section heading to replace, without the '## ' prefix. Required for replace_section."),
    reason: z
      .string()
      .optional()
      .describe("Short human-readable reason for the change. Logged to daily memory for traceability."),
  })
  .strict();

export interface SelfEvolveOutput {
  target: Target;
  action: string;
  filePath: string;
  bytesBefore: number;
  bytesAfter: number;
  contents?: string;
  loggedTo?: string;
}

export const SelfEvolveTool = buildTool({
  name: "SelfEvolve",
  description:
    "Rewrite the agent's own mind files (SOUL/HEARTBEAT/USER/MEMORY/IDENTITY/CAPABILITIES) or append to today's daily memory log. Self-territory under ~/.crix/ — no permission ritual needed. Prefer this over Write/Edit for any personal-evolution change so the daily log captures the why. Actions: read, append, replace_section, replace_file, note.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `SelfEvolve ${i.action} ${i.target}`,

  async call(input, _ctx): Promise<{ output: SelfEvolveOutput; touchedFiles?: string[]; display: string }> {
    const home = crixAgentHome(process.env.CRIX_HOME);
    const paths = agentPaths(home);
    const filePath = resolveTargetPath(input.target, paths);
    const before = await readIfExists(filePath);
    const bytesBefore = before.length;

    if (input.action === "read") {
      return {
        output: {
          target: input.target,
          action: "read",
          filePath,
          bytesBefore,
          bytesAfter: bytesBefore,
          contents: before,
        },
        display: `read ${input.target} (${bytesBefore}b)`,
      };
    }

    if (!input.text || !input.text.trim()) {
      throw new Error(`SelfEvolve.${input.action} requires non-empty text`);
    }

    let nextContent: string;
    if (input.action === "append") {
      const sep = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
      nextContent = `${before}${sep}${input.text}`;
      if (!nextContent.endsWith("\n")) nextContent += "\n";
    } else if (input.action === "replace_file") {
      nextContent = input.text.endsWith("\n") ? input.text : `${input.text}\n`;
    } else if (input.action === "replace_section") {
      if (!input.section || !input.section.trim()) {
        throw new Error("SelfEvolve.replace_section requires a section heading");
      }
      nextContent = replaceSection(before, input.section.trim(), input.text.trim());
    } else if (input.action === "note") {
      if (input.target !== "daily") {
        throw new Error("SelfEvolve.note is only valid for target=daily");
      }
      const stamp = new Date().toISOString();
      const body = input.text.trim();
      const sep = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
      nextContent = `${before}${sep}\n- ${stamp} — ${body}\n`;
    } else {
      throw new Error(`SelfEvolve: unsupported action ${String(input.action)}`);
    }

    await writeFileAtomic(filePath, nextContent);
    const bytesAfter = nextContent.length;
    const loggedTo = await appendEvolutionLog(paths.memoryDir, {
      timestamp: new Date().toISOString(),
      target: input.target,
      action: input.action,
      file: filePath,
      bytesBefore,
      bytesAfter,
      reason: input.reason,
    });

    // Compute an accurate delta. Append = items added. replace_section = 1
    // (one section swapped). replace_file = 1 (whole-file overwrite).
    // note = 1 (one timestamped entry).
    const delta =
      input.action === "append" ? countAppendedItems(input.text)
        : input.action === "replace_section" ? 1
        : input.action === "replace_file" ? 1
        : input.action === "note" ? 1
        : 1;
    const target = input.target.toUpperCase();
    const gain = gainForTarget(target, delta, input.action);
    emitLifecycle({
      type: "self_evolve",
      target: input.target,
      action: input.action,
      bytesBefore,
      bytesAfter,
      gain,
    });

    return {
      output: {
        target: input.target,
        action: input.action,
        filePath,
        bytesBefore,
        bytesAfter,
        loggedTo,
      },
      touchedFiles: [filePath, loggedTo].filter((p): p is string => Boolean(p)),
      display: `+${delta} ${target} — ${input.action} (${bytesBefore}→${bytesAfter}b)`,
    };
  },
});

function resolveTargetPath(target: Target, paths: ReturnType<typeof agentPaths>): string {
  switch (target) {
    case "soul": return paths.soul;
    case "heartbeat": return paths.heartbeat;
    case "user": return paths.user;
    case "memory": return paths.memory;
    case "identity": return paths.identity;
    case "capabilities": return paths.capabilities;
    case "daily": return path.join(paths.memoryDir, `${todayIso()}.md`);
  }
}

async function readIfExists(file: string): Promise<string> {
  if (!(await exists(file))) return "";
  return fs.readFile(file, "utf8");
}

function replaceSection(content: string, heading: string, replacement: string): string {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+/.test(line) && line.replace(/^##\s+/, "").trim() === heading);
  if (start === -1) {
    // Section doesn't exist yet — append it.
    const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    return `${content}${sep}\n## ${heading}\n\n${replacement}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const next = [...lines.slice(0, start + 1), "", replacement, ...(end < lines.length ? ["", ...lines.slice(end)] : [""])];
  return next.join("\n");
}

async function appendEvolutionLog(memoryDir: string, entry: {
  timestamp: string;
  target: Target;
  action: string;
  file: string;
  bytesBefore: number;
  bytesAfter: number;
  reason?: string;
}): Promise<string> {
  const file = path.join(memoryDir, `${todayIso()}.md`);
  await fs.mkdir(memoryDir, { recursive: true });
  const line = `- ${entry.timestamp} — self_evolve ${entry.action} ${entry.target} (${entry.bytesBefore}→${entry.bytesAfter} bytes)${entry.reason ? ` — ${entry.reason}` : ""}\n`;
  if (!(await exists(file))) {
    await fs.writeFile(file, `# ${todayIso()} raw memory\n\n${line}`, "utf8");
  } else {
    await fs.appendFile(file, line, "utf8");
  }
  return file;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
