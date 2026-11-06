// A forged skill becomes a SKILL.md in the owner's skill root, where
// SkillsList already looks. The ledger keeps the revisions; this is the
// install step, idempotent and reversible by deleting the directory.

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function skillsRoot(): string {
  const home = process.env.ARES_HOME || path.join(os.homedir(), ".ares");
  return path.join(home, "skills");
}

export async function installSkillSource(name: string, source: string): Promise<string> {
  const dir = path.join(skillsRoot(), name);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  const text = /^---\n/.test(source) ? source : `---\nname: ${name}\ndescription: ${source.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim().slice(0, 200) ?? name}\n---\n\n${source}`;
  await writeFile(file, text, "utf8");
  return file;
}

/** A forged hook is a Node script the engine's HookManager runs (JSON on
 * stdin; a non-zero exit blocks a PreToolUse). Unlike a forged tool it runs
 * with the owner's full authority, so mounting it says so. */
function hooksFile(): string {
  return path.join(process.env.ARES_HOME || path.join(os.homedir(), ".ares"), "hooks.json");
}

async function readHooksConfig(): Promise<{ hooks: Array<Record<string, unknown>> } & Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(hooksFile(), "utf8")) as { hooks?: Array<Record<string, unknown>> };
    return { ...raw, hooks: Array.isArray(raw.hooks) ? raw.hooks : [] };
  } catch {
    return { hooks: [] };
  }
}

export async function installHook(name: string, source: string, event: string, matcher: string | undefined): Promise<string> {
  const home = process.env.ARES_HOME || path.join(os.homedir(), ".ares");
  const file = path.join(home, "extensions", name, "hook.mjs");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source, "utf8");
  const config = await readHooksConfig();
  config.hooks = config.hooks.filter((h) => h.forged !== name);
  config.hooks.push({ event, ...(matcher ? { matcher } : {}), command: `"${process.execPath}" "${file}"`, timeoutMs: 30_000, forged: name });
  await writeFile(hooksFile(), JSON.stringify(config, null, 2), "utf8");
  return file;
}

export async function uninstallHook(name: string): Promise<boolean> {
  const config = await readHooksConfig();
  const before = config.hooks.length;
  config.hooks = config.hooks.filter((h) => h.forged !== name);
  if (config.hooks.length === before) return false;
  await writeFile(hooksFile(), JSON.stringify(config, null, 2), "utf8");
  return true;
}

export async function uninstallSkill(name: string): Promise<boolean> {
  const dir = path.join(skillsRoot(), name);
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
