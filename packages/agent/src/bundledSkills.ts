// Bundled skills — capability providers that ship with Ares itself (today:
// `godot`). They live as plain files under packages/agent/skills/<name> in
// the repo and under runtime/skills/<name> in the packaged desktop app, and
// are installed into the user's ~/.ares/skills on scaffold so the registry,
// the Capability tool and the provider runtime see them like any learned
// skill. The core never special-cases them (docs/CODING-HARNESS-ARCHITECTURE
// §3.11): a user-edited copy is left alone; only copies Ares installed
// (marked with .ares-bundled) are refreshed when the bundled version is newer.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MARKER = ".ares-bundled";

export function bundledSkillsRoots(): string[] {
  return [
    path.resolve(__dirname, "..", "skills"), // packages/agent/dist/.. → packages/agent/skills; runtime/cli/.. → runtime/skills
    path.resolve(__dirname, "..", "..", "skills"),
  ];
}

export async function bundledSkillsDir(): Promise<string | null> {
  for (const candidate of bundledSkillsRoots()) {
    const info = await fs.stat(candidate).catch(() => null);
    if (info?.isDirectory()) return candidate;
  }
  return null;
}

export interface BundledSkillInstall {
  name: string;
  action: "installed" | "updated" | "kept" | "user-owned";
  version: string | null;
  dir: string;
}

async function readVersion(dir: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "capability.json"), "utf8")) as { version?: string };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    try {
      const md = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
      return md.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  }
}

function newer(a: string | null, b: string | null): boolean {
  if (!a) return false;
  if (!b) return true;
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Copy every bundled skill into `skillsDir` that is missing or stale. */
export async function installBundledSkills(skillsDir: string, options: { force?: boolean; only?: string[] } = {}): Promise<BundledSkillInstall[]> {
  const source = await bundledSkillsDir();
  if (!source) return [];
  const out: BundledSkillInstall[] = [];
  const entries = await fs.readdir(source, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (options.only && !options.only.includes(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(skillsDir, entry.name);
    const bundledVersion = await readVersion(from);
    const existing = await fs.stat(to).catch(() => null);
    if (existing?.isDirectory()) {
      const marker = await fs.readFile(path.join(to, MARKER), "utf8").catch(() => null);
      if (marker === null && !options.force) {
        out.push({ name: entry.name, action: "user-owned", version: await readVersion(to), dir: to });
        continue;
      }
      const installedVersion = await readVersion(to);
      if (!options.force && !newer(bundledVersion, installedVersion)) {
        out.push({ name: entry.name, action: "kept", version: installedVersion, dir: to });
        continue;
      }
      await fs.rm(to, { recursive: true, force: true });
      await fs.cp(from, to, { recursive: true });
      await fs.writeFile(path.join(to, MARKER), `${bundledVersion ?? ""}\n`, "utf8");
      out.push({ name: entry.name, action: "updated", version: bundledVersion, dir: to });
      continue;
    }
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.cp(from, to, { recursive: true });
    await fs.writeFile(path.join(to, MARKER), `${bundledVersion ?? ""}\n`, "utf8");
    out.push({ name: entry.name, action: "installed", version: bundledVersion, dir: to });
  }
  return out;
}
