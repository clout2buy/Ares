import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  ".ares",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const INSTRUCTION_FILES = new Set(["AGENTS.md", "ARES.md", "CLAUDE.md"]);
const ROOT_LANDMARKS = new Set([
  "Cargo.toml",
  "Makefile",
  "README.md",
  "biome.json",
  "go.mod",
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "requirements.txt",
  "tsconfig.json",
  "turbo.json",
]);

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ".c": "C",
  ".cpp": "C++",
  ".cs": "C#",
  ".css": "CSS",
  ".go": "Go",
  ".html": "HTML",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".kt": "Kotlin",
  ".mjs": "JavaScript",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".swift": "Swift",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".vue": "Vue",
};

export interface RepositoryPackageMap {
  path: string;
  name?: string;
  scripts: string[];
  sourceRoots: string[];
  testRoots: string[];
  entrypoints: string[];
}

export interface RepositoryMap {
  schemaVersion: 1;
  workspace: string;
  fingerprint: string;
  scannedFiles: number;
  truncated: boolean;
  languages: Array<{ name: string; files: number }>;
  rootLandmarks: string[];
  instructions: string[];
  topLevel: Array<{ path: string; files: number }>;
  packages: RepositoryPackageMap[];
  testFiles: number;
}

export interface RepositoryMapOptions {
  /** Bound startup work on enormous repositories. Defaults to 8,000 files. */
  maxFiles?: number;
  /** Bound the reminder injected into the model. Defaults to 8,000 chars. */
  maxReminderChars?: number;
}

interface WalkResult {
  files: string[];
  truncated: boolean;
}

/**
 * Build a deterministic, bounded map of a repository. This deliberately avoids
 * an LLM summary: the same checkout produces the same ordering and fingerprint,
 * so long sessions can refresh their bearings without accumulating invented
 * architecture. Generated artifacts and Ares' own state are excluded.
 */
export async function buildRepositoryMap(
  workspace: string,
  options: RepositoryMapOptions = {},
): Promise<RepositoryMap> {
  const root = path.resolve(workspace);
  const maxFiles = Math.max(100, options.maxFiles ?? 8_000);
  const walked = await walkRepository(root, maxFiles);
  const files = walked.files.sort((a, b) => a.localeCompare(b));
  const languages = new Map<string, number>();
  const topLevel = new Map<string, number>();
  const instructions: string[] = [];
  const rootLandmarks: string[] = [];
  const packageJsonFiles: string[] = [];
  let testFiles = 0;

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    const language = LANGUAGE_BY_EXT[ext];
    if (language) languages.set(language, (languages.get(language) ?? 0) + 1);
    const first = rel.split("/")[0] || ".";
    topLevel.set(first, (topLevel.get(first) ?? 0) + 1);
    const base = path.posix.basename(rel);
    if (INSTRUCTION_FILES.has(base)) instructions.push(rel);
    if (!rel.includes("/") && ROOT_LANDMARKS.has(base)) rootLandmarks.push(rel);
    if (base === "package.json") packageJsonFiles.push(rel);
    if (isTestPath(rel)) testFiles++;
  }

  const packages = await Promise.all(
    packageJsonFiles.slice(0, 80).map((rel) => describePackage(root, rel, files, packageJsonFiles)),
  );
  const fingerprint = createHash("sha256")
    .update(files.join("\n"))
    .update("\0")
    .update(packages.map((pkg) => `${pkg.path}:${pkg.name ?? ""}:${pkg.scripts.join(",")}`).join("\n"))
    .digest("hex")
    .slice(0, 16);

  return {
    schemaVersion: 1,
    workspace: root,
    fingerprint,
    scannedFiles: files.length,
    truncated: walked.truncated,
    languages: [...languages.entries()]
      .map(([name, count]) => ({ name, files: count }))
      .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
    rootLandmarks: rootLandmarks.sort(),
    instructions: instructions.sort(),
    topLevel: [...topLevel.entries()]
      .map(([entryPath, count]) => ({ path: entryPath, files: count }))
      .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
      .slice(0, 24),
    packages: packages.sort((a, b) => a.path.localeCompare(b.path)),
    testFiles,
  };
}

/** Render the map as a compact system reminder, not a wall of inventory. */
export function renderRepositoryMap(
  map: RepositoryMap,
  options: Pick<RepositoryMapOptions, "maxReminderChars"> = {},
): string {
  const packageLines = map.packages.slice(0, 36).map((pkg) => {
    const details = [
      pkg.name ? `name=${pkg.name}` : "",
      pkg.sourceRoots.length ? `src=${pkg.sourceRoots.join(",")}` : "",
      pkg.testRoots.length ? `tests=${pkg.testRoots.join(",")}` : "",
      pkg.entrypoints.length ? `entry=${pkg.entrypoints.join(",")}` : "",
      pkg.scripts.length ? `scripts=${pkg.scripts.join(",")}` : "",
    ].filter(Boolean);
    return `- ${pkg.path}${details.length ? ` (${details.join("; ")})` : ""}`;
  });
  const lines = [
    "REPOSITORY CARTOGRAPHY (deterministic; use this to orient before editing)",
    `fingerprint=${map.fingerprint}; scanned=${map.scannedFiles}${map.truncated ? "+ (bounded scan)" : ""}; tests=${map.testFiles}`,
    `languages: ${map.languages.slice(0, 10).map((item) => `${item.name} ${item.files}`).join(", ") || "none detected"}`,
    `root landmarks: ${map.rootLandmarks.join(", ") || "none"}`,
    `instruction files: ${map.instructions.join(", ") || "none"}`,
    `top-level density: ${map.topLevel.map((item) => `${item.path}(${item.files})`).join(", ") || "empty"}`,
  ];
  if (packageLines.length) lines.push("package/module boundaries:", ...packageLines);
  lines.push(
    "Treat this as a navigation index, not proof of behavior. Read the owning instructions, callers, tests, and local conventions before changing a boundary.",
  );
  const text = lines.join("\n");
  const max = Math.max(1_000, options.maxReminderChars ?? 8_000);
  return text.length <= max ? text : `${text.slice(0, max - 80)}\n... repository map truncated to ${max} characters`;
}

export async function repositoryMapReminder(
  workspace: string,
  options: RepositoryMapOptions = {},
): Promise<string> {
  return renderRepositoryMap(await buildRepositoryMap(workspace, options), options);
}

async function walkRepository(root: string, maxFiles: number): Promise<WalkResult> {
  const files: string[] = [];
  const pending = [root];
  let truncated = false;
  while (pending.length > 0) {
    const dir = pending.shift()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) pending.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(toPosix(path.relative(root, abs)));
      if (files.length >= maxFiles) {
        truncated = pending.length > 0 || entries.at(-1) !== entry;
        return { files, truncated };
      }
    }
  }
  return { files, truncated };
}

async function describePackage(
  root: string,
  packageJsonRel: string,
  allFiles: readonly string[],
  allPackageJsonFiles: readonly string[],
): Promise<RepositoryPackageMap> {
  const packageDir = path.posix.dirname(packageJsonRel) === "." ? "." : path.posix.dirname(packageJsonRel);
  const prefix = packageDir === "." ? "" : `${packageDir}/`;
  const descendantPrefixes = allPackageJsonFiles
    .map((file) => path.posix.dirname(file) === "." ? "." : path.posix.dirname(file))
    .filter((candidate) => candidate !== packageDir && isInsidePackage(candidate, packageDir))
    .map((candidate) => `${candidate}/`);
  // A package owns files up to (but not through) a nested package boundary.
  // Without this partition, the root package appears to own every monorepo
  // test and a parent package absorbs all descendant source roots.
  const local = allFiles
    .filter((file) => file.startsWith(prefix) && !descendantPrefixes.some((child) => file.startsWith(child)))
    .map((file) => file.slice(prefix.length));
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(await fs.readFile(path.join(root, packageJsonRel), "utf8")) as Record<string, unknown>;
  } catch {
    // A malformed package is still a useful boundary; leave metadata empty.
  }
  const scripts = Object.keys((parsed.scripts as Record<string, unknown> | undefined) ?? {}).sort().slice(0, 16);
  const entryCandidates = new Set<string>();
  for (const key of ["main", "module", "types", "bin"]) {
    const value = parsed[key];
    if (typeof value === "string") entryCandidates.add(toPosix(value));
    if (value && typeof value === "object") {
      for (const candidate of Object.values(value as Record<string, unknown>)) {
        if (typeof candidate === "string") entryCandidates.add(toPosix(candidate));
      }
    }
  }
  for (const candidate of ["src/index.ts", "src/index.tsx", "src/main.ts", "src/main.tsx", "index.ts", "index.js"]) {
    if (local.includes(candidate)) entryCandidates.add(candidate);
  }
  const sourceRoots = uniqueRoots(local.filter((file) => /^(src|lib|app|cmd)\//.test(file)));
  const testRoots = uniqueRoots(local.filter(isTestPath));
  return {
    path: packageDir,
    ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
    scripts,
    sourceRoots,
    testRoots,
    entrypoints: [...entryCandidates].sort().slice(0, 12),
  };
}

function isInsidePackage(candidate: string, owner: string): boolean {
  if (owner === ".") return candidate !== ".";
  return candidate.startsWith(`${owner}/`);
}

function uniqueRoots(files: readonly string[]): string[] {
  return [...new Set(files.map((file) => file.split("/").slice(0, file.startsWith("packages/") ? 2 : 1).join("/")))]
    .filter(Boolean)
    .sort()
    .slice(0, 12);
}

function isTestPath(file: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.py$/.test(file);
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

// ─── Project checks — what "run the tests" concretely means HERE ────────────
//
// The verifier used to decide behavioral-vs-static by regex over a command's
// LABEL, so an unusual runner (a custom `test` script, a Makefile target)
// degraded to static and the completion gate refused it. Derive the project's
// own test/build/lint/typecheck commands from its manifests once, and let the
// derived test command be behavioral regardless of how it is spelled.

export type ProjectCheckKind = "test" | "build" | "lint" | "typecheck";

export interface ProjectCheckCommand {
  kind: ProjectCheckKind;
  /** Shell-shaped command line, normalized to single spaces ("pnpm test"). */
  command: string;
  program: string;
  args: string[];
  /** Manifest the command was derived from ("package.json:test", "Cargo.toml", "Makefile:test"…). */
  source: string;
}

export interface ProjectChecks {
  workspace: string;
  test?: ProjectCheckCommand;
  build?: ProjectCheckCommand;
  lint?: ProjectCheckCommand;
  typecheck?: ProjectCheckCommand;
  /** Every derived test command — a polyglot repo has several, all behavioral. */
  tests: ProjectCheckCommand[];
  /** Package/crate/module names (root + workspace members) — a manual
   *  `pnpm --filter <name> test` / `cargo test -p <name>` targets one of these. */
  packageNames: string[];
  /** Test roots relative to the workspace, posix ("tests", "packages/core/test"). */
  testRoots: string[];
}

const projectChecksCache = new Map<string, { at: number; checks: ProjectChecks }>();
const PROJECT_CHECKS_TTL_MS = 5 * 60_000;

/** Cached per workspace (5 min) — manifests rarely change mid-session and the
 *  cartography walk behind packageNames/testRoots is bounded but not free. */
export async function resolveProjectChecks(workspace: string): Promise<ProjectChecks> {
  const key = path.resolve(workspace);
  const cached = projectChecksCache.get(key);
  if (cached && Date.now() - cached.at < PROJECT_CHECKS_TTL_MS) return cached.checks;
  const checks = await deriveProjectChecks(key).catch((): ProjectChecks => ({
    workspace: key,
    tests: [],
    packageNames: [],
    testRoots: [],
  }));
  projectChecksCache.set(key, { at: Date.now(), checks });
  if (projectChecksCache.size > 32) {
    const oldest = [...projectChecksCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) projectChecksCache.delete(oldest[0]);
  }
  return checks;
}

/** Test-only: drop the cache so a rewritten temp workspace is re-derived. */
export function resetProjectChecksCache(): void {
  projectChecksCache.clear();
}

async function deriveProjectChecks(root: string): Promise<ProjectChecks> {
  const exists = (rel: string) => fs.stat(path.join(root, rel)).then(() => true, () => false);
  const readText = (rel: string) => fs.readFile(path.join(root, rel), "utf8").catch(() => null);
  const checks: ProjectChecks = { workspace: root, tests: [], packageNames: [], testRoots: [] };
  const take = (cmd: ProjectCheckCommand) => {
    if (cmd.kind === "test") checks.tests.push(cmd);
    if (!checks[cmd.kind]) checks[cmd.kind] = cmd;
  };
  const make = (kind: ProjectCheckKind, program: string, args: string[], source: string): ProjectCheckCommand => ({
    kind,
    command: [program, ...args].join(" "),
    program,
    args,
    source,
  });

  // package.json scripts — the project's own words for test/build/lint/typecheck.
  const pkgRaw = await readText("package.json");
  if (pkgRaw !== null) {
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    } catch {
      // A malformed manifest still leaves the other ecosystems derivable.
    }
    const scripts = (pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}) as Record<string, unknown>;
    const [pnpm, yarn] = await Promise.all([exists("pnpm-lock.yaml"), exists("yarn.lock")]);
    const pm = pnpm ? "pnpm" : yarn ? "yarn" : "npm";
    const realScript = (name: string): boolean => {
      const body = scripts[name];
      return typeof body === "string" && body.trim().length > 0 && !/^(?:echo\s+)?["']?(?:no tests?|error: no test specified)/i.test(body.trim());
    };
    // `<pm> test` is a lifecycle alias everywhere; other scripts need `run`.
    if (realScript("test")) take(make("test", pm, ["test"], "package.json:test"));
    for (const name of Object.keys(scripts).sort()) {
      if (/^test:/.test(name) && realScript(name)) take(make("test", pm, ["run", name], `package.json:${name}`));
    }
    for (const [name, kind] of [["build", "build"], ["lint", "lint"], ["typecheck", "typecheck"], ["check", "typecheck"]] as const) {
      if (realScript(name)) take(make(kind, pm, ["run", name], `package.json:${name}`));
    }
    if (typeof pkg.name === "string") checks.packageNames.push(pkg.name);
  }

  // Cargo: `cargo test` is the behavioral bar; `cargo check`/`build` are static.
  const cargoRaw = await readText("Cargo.toml");
  if (cargoRaw !== null) {
    take(make("test", "cargo", ["test"], "Cargo.toml"));
    take(make("build", "cargo", ["build"], "Cargo.toml"));
    take(make("typecheck", "cargo", ["check"], "Cargo.toml"));
    const crate = cargoRaw.match(/^\s*\[package\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m);
    if (crate) checks.packageNames.push(crate[1]);
  }

  // Python: any pytest configuration surface means `pytest` is the suite.
  const [pyproject, pytestIni, setupCfg] = await Promise.all([
    readText("pyproject.toml"),
    exists("pytest.ini"),
    readText("setup.cfg"),
  ]);
  if (pyproject !== null || pytestIni || (setupCfg !== null && /\[tool:pytest\]/.test(setupCfg))) {
    take(make("test", "pytest", [], pytestIni ? "pytest.ini" : pyproject !== null ? "pyproject.toml" : "setup.cfg"));
    const pyName = pyproject?.match(/^\s*\[project\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m)
      ?? pyproject?.match(/^\s*\[tool\.poetry\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m);
    if (pyName) checks.packageNames.push(pyName[1]);
  }

  // Go: package-level test + vet + build.
  const goMod = await readText("go.mod");
  if (goMod !== null) {
    take(make("test", "go", ["test", "./..."], "go.mod"));
    take(make("build", "go", ["build", "./..."], "go.mod"));
    take(make("typecheck", "go", ["vet", "./..."], "go.mod"));
    const mod = goMod.match(/^module\s+(\S+)/m);
    if (mod) checks.packageNames.push(mod[1], mod[1].split("/").at(-1) ?? mod[1]);
  }

  // Makefile targets — only the conventional names; `make` itself is a build.
  const makefile = await readText("Makefile");
  if (makefile !== null) {
    const targets = new Set([...makefile.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)].map((m) => m[1]));
    if (targets.has("test")) take(make("test", "make", ["test"], "Makefile:test"));
    if (targets.has("build")) take(make("build", "make", ["build"], "Makefile:build"));
    if (targets.has("lint")) take(make("lint", "make", ["lint"], "Makefile:lint"));
    if (targets.has("typecheck")) take(make("typecheck", "make", ["typecheck"], "Makefile:typecheck"));
  }

  // Cartography supplies workspace-member names and every test root, bounded.
  const map = await buildRepositoryMap(root, { maxFiles: 4_000 }).catch(() => null);
  if (map) {
    for (const pkg of map.packages) {
      if (pkg.name) checks.packageNames.push(pkg.name);
      const prefix = pkg.path === "." ? "" : `${pkg.path}/`;
      for (const testRoot of pkg.testRoots) checks.testRoots.push(`${prefix}${testRoot}`);
    }
  }
  for (const dir of ["test", "tests", "__tests__", "spec", "specs"]) {
    if (await exists(dir)) checks.testRoots.push(dir);
  }
  checks.packageNames = [...new Set(checks.packageNames)].sort();
  checks.testRoots = [...new Set(checks.testRoots)].sort();
  return checks;
}
