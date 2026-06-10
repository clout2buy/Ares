import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentPaths, aresAgentHome, workspaceToolsPath } from "../paths.js";
import { exists, readTextIfExists, renderTemplate, writeFileAtomic } from "../files.js";
import { readTemplate } from "../templates.js";
import { loadAgentConfig } from "../config.js";
import { vibeRulesMarkdown } from "./vibeRules.js";

export interface BootstrapProfile {
  userName: string;
  userTimezone?: string;
  languages?: string;
  style?: string;
  conventions?: string;
  agentName: string;
  creature: string;
  vibe: string;
  emoji: string;
  avatar?: string;
  bornAt?: Date;
}

export interface BootstrapState {
  home: string;
  required: boolean;
  bootstrapPath: string;
  identityPath: string;
  message: string;
}

export async function ensureAgentScaffold(opts: { home?: string; workspace?: string } = {}): Promise<BootstrapState> {
  const home = aresAgentHome(opts.home);
  const paths = agentPaths(home);
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.memoryDir, { recursive: true });
  await mkdir(paths.transcriptsDir, { recursive: true });
  await mkdir(paths.skillsDir, { recursive: true });
  await mkdir(paths.dreamsDir, { recursive: true });
  await loadAgentConfig(home);

  const identityExists = await exists(paths.identity);
  if (!identityExists && !(await exists(paths.bootstrap))) {
    await writeFileAtomic(paths.bootstrap, await readTemplate("BOOTSTRAP.md"));
  }

  if (opts.workspace) {
    await ensureWorkspaceTools(opts.workspace);
  }

  return {
    home,
    required: !identityExists,
    bootstrapPath: paths.bootstrap,
    identityPath: paths.identity,
    message: identityExists
      ? `Agent identity present at ${paths.identity}`
      : `Agent bootstrap required. Script is at ${paths.bootstrap}`,
  };
}

export async function completeBootstrap(profile: BootstrapProfile, opts: { home?: string; workspace?: string } = {}): Promise<BootstrapState> {
  const home = aresAgentHome(opts.home);
  const paths = agentPaths(home);
  await mkdir(paths.home, { recursive: true });
  const born = (profile.bornAt ?? new Date()).toISOString();
  const vibe = profile.vibe.trim() || "direct";
  const values = {
    NAME: clean(profile.agentName, "Ares"),
    CREATURE: clean(profile.creature, "coding agent"),
    VIBE: vibe,
    EMOJI: clean(profile.emoji, "*"),
    AVATAR: clean(profile.avatar ?? profile.emoji, "*"),
    ISO_TIMESTAMP: born,
    USER_NAME: clean(profile.userName, "User"),
    TIMEZONE: clean(profile.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, "unknown"),
    LANGUAGES: clean(profile.languages ?? "unknown"),
    STYLE: clean(profile.style ?? "direct"),
    CONVENTIONS: clean(profile.conventions ?? "project-local"),
    VIBE_RULES: vibeRulesMarkdown(vibe),
  };

  await writeFileAtomic(paths.identity, renderTemplate(await readTemplate("IDENTITY.md"), values));
  await writeFileAtomic(paths.soul, renderTemplate(await readTemplate("SOUL.md"), values));
  await writeFileAtomic(paths.user, renderTemplate(await readTemplate("USER.md"), values));
  if (!(await exists(paths.heartbeat))) await writeFileAtomic(paths.heartbeat, await readTemplate("HEARTBEAT.md"));
  if (!(await exists(paths.memory))) await writeFileAtomic(paths.memory, await readTemplate("MEMORY.md"));
  if (!(await exists(paths.capabilities))) await writeFileAtomic(paths.capabilities, await readTemplate("CAPABILITIES.md"));
  await loadAgentConfig(home);
  if (opts.workspace) await ensureWorkspaceTools(opts.workspace);
  await rm(paths.bootstrap, { force: true });

  return {
    home,
    required: false,
    bootstrapPath: paths.bootstrap,
    identityPath: paths.identity,
    message: `Agent bootstrap completed at ${paths.identity}`,
  };
}

export async function ensureWorkspaceTools(workspace: string): Promise<string> {
  const file = workspaceToolsPath(workspace);
  if (await exists(file)) return file;
  const detected = await detectWorkspaceTools(workspace);
  const rendered = renderTemplate(await readTemplate("TOOLS.md"), detected);
  await writeFileAtomic(file, rendered);
  return file;
}

export async function bootstrapReminder(home = aresAgentHome()): Promise<string | null> {
  const paths = agentPaths(home);
  if (await exists(paths.identity)) return null;
  const text = await readTextIfExists(paths.bootstrap);
  if (!text) return null;
  return `Ares agent bootstrap is required. Use this script to run the birth conversation:\n\n${text}`;
}

async function detectWorkspaceTools(workspace: string): Promise<Record<string, string>> {
  const pkgPath = path.join(workspace, "package.json");
  const pkg = await readPackageJson(pkgPath);
  const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  const hasPnpmLock = await exists(path.join(workspace, "pnpm-lock.yaml"));
  const hasYarnLock = await exists(path.join(workspace, "yarn.lock"));
  const hasNpmLock = await exists(path.join(workspace, "package-lock.json"));
  const pkgManager = hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : hasNpmLock ? "npm" : pkg?.packageManager ? String(pkg.packageManager).split("@")[0] : "pnpm";
  const scriptCmd = (name: string, fallback: string) =>
    typeof scripts[name] === "string" ? `${pkgManager} ${name}` : fallback;
  return {
    BUILD_CMD: scriptCmd("build", `${pkgManager} build`),
    TEST_CMD: scriptCmd("test", `${pkgManager} test`),
    VERIFY_CMD: scriptCmd("verify", `${pkgManager} verify`),
    FORMATTER: scripts.format ? `${pkgManager} format` : "project default",
    LINTER: scripts.lint ? `${pkgManager} lint` : "project default",
    INDENTATION: "project default",
    PKG_MANAGER: pkgManager,
    SHELL: process.platform === "win32" ? "PowerShell" : os.userInfo().shell || "sh",
  };
}

async function readPackageJson(file: string): Promise<Record<string, unknown> | null> {
  const raw = await readTextIfExists(file, 1_000_000);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clean(value: string, fallback = "unknown"): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

