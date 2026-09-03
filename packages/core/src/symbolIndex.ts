// symbolIndex — multi-language symbol index with no parser dependency.
//
// WHY regex, not tree-sitter: Ares runs on the owner's machine, Windows-first,
// with no native build step beyond what's already there. A per-language grammar
// would add native addons (or WASM bundles) for a capability whose consumers —
// LSP.workspace_symbol, CodebaseSearch's `symbols:` sidebar, the coding prompt's
// "where is X defined" reflex — need NAMES, KINDS and LINES, not types. A
// line-oriented extractor per language gets ~95% of declarations right, degrades
// to "missed a symbol" (never "crashed the turn"), and stays diagnosable by
// reading one regex.
//
// WHY a cache keyed by git HEAD: the walk + extraction over a 5k-file repo costs
// hundreds of ms; a turn may query the index several times. The cache lives at
// <workspace>/.ares/index/symbols.json. Files are re-extracted only when their
// mtime+size changed; when HEAD matches the cached HEAD and git is available,
// `git status --porcelain` names the dirty set so unchanged files skip even the
// stat call. Non-git workspaces fall back to a full stat walk (still incremental
// per file — only changed files are re-read).

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "impl"
  | "module"
  | "variable"
  | "constant"
  | "macro";

export interface IndexedSymbol {
  name: string;
  kind: SymbolKind;
  /** Workspace-relative path with forward slashes (portable cache; join with index.workspace). */
  file: string;
  /** 1-based line of the declaration. */
  line: number;
  /** 1-based last line of the body when the extractor could bracket it. */
  endLine?: number;
  /** Enclosing class/struct/impl/module name when nested. */
  container?: string;
  exported?: boolean;
  /** Trimmed first line of the declaration (≤ 200 chars). */
  signature: string;
}

export interface SymbolIndexFileEntry {
  mtimeMs: number;
  size: number;
  symbols: IndexedSymbol[];
}

export interface SymbolIndexStats {
  files: number;
  extracted: number;
  reused: number;
  removed: number;
  mode: "git-status" | "walk" | "memo";
  truncated: boolean;
  durationMs: number;
}

export interface SymbolIndex {
  version: number;
  workspace: string;
  head: string | null;
  builtAt: number;
  files: Record<string, SymbolIndexFileEntry>;
  stats?: SymbolIndexStats;
}

export interface BuildSymbolIndexOptions {
  /** Override the cache file (default <workspace>/.ares/index/symbols.json). */
  cacheFile?: string;
  /** Skip the on-disk cache entirely (tests, one-shot scans). */
  noCache?: boolean;
  /** Reuse the in-process index for this workspace if it is younger than this. */
  maxAgeMs?: number;
  maxFiles?: number;
}

export interface QuerySymbolsOptions {
  kind?: SymbolKind | SymbolKind[];
  /** Restrict to one file (relative or absolute). */
  file?: string;
  limit?: number;
}

export interface SymbolMatch extends IndexedSymbol {
  score: number;
  /** Ranking tier that produced the score, for callers explaining results. */
  tier: "exact" | "prefix" | "fuzzy" | "substring" | "subsequence";
}

const INDEX_VERSION = 1;
const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 20_000;
const SIGNATURE_MAX = 200;

/** Mirrors checkpoints.ts + CodebaseSearch: heavy/state directories that never hold source we'd navigate. */
const IGNORED_DIRS = new Set([
  ".git",
  ".ares",
  ".crix",
  ".crypt",
  "AppData",
  "browser-profile",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pnpm-store",
  ".turbo",
  ".cache",
]);

type Lang =
  | "ts"
  | "python"
  | "rust"
  | "go"
  | "jvm"
  | "kotlin"
  | "c"
  | "ruby"
  | "php"
  | "shell";

const LANG_BY_EXT: Record<string, Lang> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "jvm",
  ".cs": "jvm",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cc": "c",
  ".cpp": "c",
  ".cxx": "c",
  ".hpp": "c",
  ".hh": "c",
  ".m": "c",
  ".mm": "c",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
};

export function symbolIndexLanguageFor(file: string): string | null {
  return LANG_BY_EXT[path.extname(file).toLowerCase()] ?? null;
}

export function symbolIndexCachePath(workspace: string): string {
  return path.join(workspace, ".ares", "index", "symbols.json");
}

export function symbolIndexMaxFiles(): number {
  const raw = Number(process.env.ARES_SYMBOL_INDEX_MAX_FILES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_FILES;
}

// ─── Build ─────────────────────────────────────────────────────────────

const memo = new Map<string, { index: SymbolIndex; at: number }>();

export async function buildSymbolIndex(workspace: string, opts: BuildSymbolIndexOptions = {}): Promise<SymbolIndex> {
  const t0 = Date.now();
  const root = path.resolve(workspace);
  const cached = memo.get(root);
  if (cached && opts.maxAgeMs !== undefined && Date.now() - cached.at <= opts.maxAgeMs) {
    return { ...cached.index, stats: { ...(cached.index.stats ?? emptyStats()), mode: "memo", durationMs: 0 } };
  }
  const cacheFile = opts.cacheFile ?? symbolIndexCachePath(root);
  const maxFiles = opts.maxFiles ?? symbolIndexMaxFiles();
  const previous = opts.noCache ? null : await readCache(cacheFile, root);
  const head = await gitHead(root);

  let stats: SymbolIndexStats;
  let files: Record<string, SymbolIndexFileEntry>;

  // Fast path: same commit as the cache and git can name the dirty set → touch
  // only those files. Any git hiccup drops to the stat walk, which is always
  // correct (it just costs one stat per file).
  const dirty = previous && head && previous.head === head ? await gitDirtyFiles(root) : null;
  if (previous && dirty) {
    files = { ...previous.files };
    let extracted = 0;
    let removed = 0;
    for (const rel of dirty) {
      const abs = path.join(root, rel);
      if (!symbolIndexLanguageFor(rel) || isIgnoredPath(rel)) continue;
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) {
        if (rel in files) {
          delete files[rel];
          removed++;
        }
        continue;
      }
      const prev = files[rel];
      if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) continue;
      const entry = await extractEntry(abs, rel, stat);
      if (entry) {
        files[rel] = entry;
        extracted++;
      } else if (rel in files) {
        delete files[rel];
        removed++;
      }
    }
    stats = {
      files: Object.keys(files).length,
      extracted,
      reused: Object.keys(files).length - extracted,
      removed,
      mode: "git-status",
      truncated: false,
      durationMs: 0,
    };
  } else {
    files = {};
    let extracted = 0;
    let reused = 0;
    let count = 0;
    let truncated = false;
    await walk(root, root, async (abs, rel) => {
      if (count >= maxFiles) {
        truncated = true;
        return false;
      }
      if (!symbolIndexLanguageFor(rel)) return true;
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > MAX_FILE_BYTES) return true;
      count++;
      const prev = previous?.files[rel];
      if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
        files[rel] = prev;
        reused++;
        return true;
      }
      const entry = await extractEntry(abs, rel, stat);
      if (entry) {
        files[rel] = entry;
        extracted++;
      }
      return true;
    });
    const removed = previous ? Object.keys(previous.files).filter((k) => !(k in files)).length : 0;
    stats = { files: count, extracted, reused, removed, mode: "walk", truncated, durationMs: 0 };
  }

  const index: SymbolIndex = { version: INDEX_VERSION, workspace: root, head, builtAt: Date.now(), files };
  stats.durationMs = Date.now() - t0;
  index.stats = stats;
  memo.set(root, { index, at: Date.now() });
  if (!opts.noCache && (stats.extracted > 0 || stats.removed > 0 || !previous || previous.head !== head)) {
    await writeCache(cacheFile, index).catch(() => {
      // Read-only workspace (or a locked file on Windows): the index still works
      // in-process; the next call simply pays the walk again.
    });
  }
  return index;
}

/** Drop the in-process memo (tests; after mass file operations). */
export function resetSymbolIndexMemo(workspace?: string): void {
  if (workspace) memo.delete(path.resolve(workspace));
  else memo.clear();
}

function emptyStats(): SymbolIndexStats {
  return { files: 0, extracted: 0, reused: 0, removed: 0, mode: "walk", truncated: false, durationMs: 0 };
}

async function extractEntry(
  abs: string,
  rel: string,
  stat: { mtimeMs: number; size: number },
): Promise<SymbolIndexFileEntry | null> {
  if (stat.size > MAX_FILE_BYTES) return null;
  const content = await fs.readFile(abs, "utf8").catch(() => null);
  if (content === null) return null;
  return { mtimeMs: stat.mtimeMs, size: stat.size, symbols: extractSymbols(rel, content) };
}

async function readCache(file: string, root: string): Promise<SymbolIndex | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as SymbolIndex;
    if (!parsed || parsed.version !== INDEX_VERSION || typeof parsed.files !== "object") return null;
    // A cache copied from another checkout path is worthless: mtimes differ.
    if (path.resolve(parsed.workspace) !== root) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(file: string, index: SymbolIndex): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const { stats: _stats, ...persisted } = index;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(persisted), "utf8");
  await fs.rename(tmp, file);
}

function isIgnoredPath(rel: string): boolean {
  return rel.split("/").some((seg) => IGNORED_DIRS.has(seg));
}

async function walk(
  root: string,
  dir: string,
  visit: (abs: string, rel: string) => Promise<boolean>,
): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      if (!(await walk(root, abs, visit))) return false;
    } else if (e.isFile()) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (!(await visit(abs, rel))) return false;
    }
  }
  return true;
}

// ─── git helpers (file reads first, one spawn only for the dirty set) ──

async function gitHead(root: string): Promise<string | null> {
  // Reading .git/HEAD directly avoids a spawn on every build; worktrees keep a
  // `.git` FILE pointing at the real gitdir, so follow that too.
  let gitDir = path.join(root, ".git");
  try {
    const st = await fs.stat(gitDir);
    if (st.isFile()) {
      const text = await fs.readFile(gitDir, "utf8");
      const m = text.match(/gitdir:\s*(.+)/);
      if (!m) return null;
      gitDir = path.resolve(root, m[1].trim());
    }
  } catch {
    return null;
  }
  try {
    const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    const ref = head.match(/^ref:\s*(.+)$/);
    if (!ref) return head || null;
    const refPath = ref[1].trim();
    const direct = await fs.readFile(path.join(gitDir, refPath), "utf8").catch(() => null);
    if (direct) return direct.trim();
    // Common gitdir for worktrees, then packed-refs.
    const commonDir = await fs.readFile(path.join(gitDir, "commondir"), "utf8").catch(() => null);
    const base = commonDir ? path.resolve(gitDir, commonDir.trim()) : gitDir;
    const fromCommon = await fs.readFile(path.join(base, refPath), "utf8").catch(() => null);
    if (fromCommon) return fromCommon.trim();
    const packed = await fs.readFile(path.join(base, "packed-refs"), "utf8").catch(() => "");
    for (const line of packed.split("\n")) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === refPath && sha) return sha;
    }
    return `unborn:${refPath}`;
  } catch {
    return null;
  }
}

async function gitDirtyFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["status", "--porcelain", "--untracked-files=all", "-z"], {
        cwd: root,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 5_000);
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const out = Buffer.concat(chunks).toString("utf8");
      const files: string[] = [];
      const records = out.split("\0").filter(Boolean);
      for (let k = 0; k < records.length; k++) {
        const rec = records[k];
        const status = rec.slice(0, 2);
        const file = rec.slice(3);
        if (!file) continue;
        files.push(file);
        // Renames/copies carry the origin path as the NEXT NUL record; both sides changed.
        if (/[RC]/.test(status) && records[k + 1]) files.push(records[++k]);
      }
      resolve(files);
    });
  });
}

// ─── Query ─────────────────────────────────────────────────────────────

export function querySymbols(index: SymbolIndex, query: string, opts: QuerySymbolsOptions = {}): SymbolMatch[] {
  const q = query.trim();
  if (!q) return [];
  const limit = opts.limit ?? 20;
  const kinds = opts.kind ? new Set(Array.isArray(opts.kind) ? opts.kind : [opts.kind]) : null;
  const fileFilter = opts.file ? relativeKey(index.workspace, opts.file) : null;
  const lower = q.toLowerCase();
  const out: SymbolMatch[] = [];
  for (const [file, entry] of Object.entries(index.files)) {
    if (fileFilter && file !== fileFilter) continue;
    for (const sym of entry.symbols) {
      if (kinds && !kinds.has(sym.kind)) continue;
      const ranked = rankName(sym.name, q, lower);
      if (!ranked) continue;
      out.push({ ...sym, score: ranked.score, tier: ranked.tier });
    }
  }
  out.sort(compareMatches);
  return out.slice(0, limit);
}

/** Every symbol declared in one file, in line order. Accepts relative or absolute paths. */
export function workspaceSymbolsFor(index: SymbolIndex, file: string): IndexedSymbol[] {
  const entry = index.files[relativeKey(index.workspace, file)];
  if (!entry) return [];
  return [...entry.symbols].sort((a, b) => a.line - b.line);
}

function relativeKey(workspace: string, file: string): string {
  const rel = path.isAbsolute(file) ? path.relative(workspace, file) : file;
  return rel.split(/[\\/]/).join("/");
}

function compareMatches(a: SymbolMatch, b: SymbolMatch): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.name.length !== b.name.length) return a.name.length - b.name.length;
  if ((a.exported ? 1 : 0) !== (b.exported ? 1 : 0)) return a.exported ? -1 : 1;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

/**
 * Tiered name ranking. Tiers never overlap in score so the ordering promise
 * (exact > prefix > camel/snake fuzzy > substring > loose subsequence) holds
 * regardless of within-tier bonuses.
 */
export function rankName(
  name: string,
  query: string,
  lowerQuery = query.toLowerCase(),
): { score: number; tier: SymbolMatch["tier"] } | null {
  const lowerName = name.toLowerCase();
  if (name === query) return { score: 100, tier: "exact" };
  if (lowerName === lowerQuery) return { score: 95, tier: "exact" };
  if (lowerName.startsWith(lowerQuery)) {
    return { score: 80 + Math.min(9, Math.round((9 * lowerQuery.length) / lowerName.length)), tier: "prefix" };
  }
  const fuzzy = camelFuzzy(nameWords(name), lowerQuery);
  if (fuzzy !== null) return { score: 60 + Math.min(9, fuzzy), tier: "fuzzy" };
  if (lowerName.includes(lowerQuery)) {
    return { score: 40 + Math.min(9, Math.round((9 * lowerQuery.length) / lowerName.length)), tier: "substring" };
  }
  if (lowerQuery.length >= 3 && isSubsequence(lowerName, lowerQuery)) return { score: 20, tier: "subsequence" };
  return null;
}

/** Split camelCase / snake_case / kebab-case identifiers into lowercase words. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+|\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * Query chars must land on word starts (each word contributes a prefix of
 * itself, words may be skipped). Returns a bonus (words touched, capped) or
 * null. Small inputs, so plain recursion is fine.
 */
function camelFuzzy(words: string[], query: string): number | null {
  if (query.length === 0 || words.length === 0) return null;
  let best: number | null = null;
  const go = (wi: number, qi: number, touched: number): void => {
    if (qi === query.length) {
      if (best === null || touched < best) best = touched;
      return;
    }
    if (wi >= words.length) return;
    const w = words[wi];
    // Consume a prefix of this word (must start at the word's first char).
    if (w[0] === query[qi]) {
      let k = 1;
      while (k < w.length && qi + k < query.length && w[k] === query[qi + k]) {
        go(wi + 1, qi + k, touched + 1);
        k++;
      }
      go(wi + 1, qi + k, touched + 1);
    }
    go(wi + 1, qi, touched); // skip word
  };
  go(0, 0, 0);
  if (best === null) return null;
  // Fewer words touched for the same query = tighter acronym match.
  return Math.max(0, 9 - (best as number));
}

function isSubsequence(hay: string, needle: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}

// ─── Extraction ────────────────────────────────────────────────────────

const KEYWORDS_NOT_NAMES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "new",
  "else",
  "do",
  "try",
  "sizeof",
  "typeof",
  "case",
  "default",
  "throw",
  "await",
  "yield",
  "delete",
  "void",
  "super",
  "this",
  "using",
  "lock",
  "foreach",
  "when",
  "with",
  "match",
  "assert",
  "defer",
  "go",
  "select",
  "elif",
  "unless",
  "until",
  "function",
  "constructor",
]);

/** Extract declarations from one file. Exported for tests and for callers that index in-memory text. */
export function extractSymbols(file: string, content: string): IndexedSymbol[] {
  const lang = LANG_BY_EXT[path.extname(file).toLowerCase()];
  if (!lang) return [];
  const lines = content.split(/\r?\n/);
  switch (lang) {
    case "python":
      return extractIndented(file, lines, pythonMatcher);
    case "ruby":
      return extractIndented(file, lines, rubyMatcher);
    default:
      return extractBraced(file, lines, lang);
  }
}

interface Decl {
  name: string;
  kind: SymbolKind;
  exported?: boolean;
  /** True when the declaration opens a scope that can hold nested symbols. */
  container?: boolean;
}

function sig(line: string): string {
  const t = line.trim();
  return t.length > SIGNATURE_MAX ? t.slice(0, SIGNATURE_MAX) + "…" : t;
}

// ── indentation-scoped languages (Python, Ruby) ────────────────────────

function pythonMatcher(line: string): Decl | null {
  let m = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
  if (m) return { name: m[1], kind: "function", exported: !m[1].startsWith("_"), container: true };
  m = line.match(/^\s*class\s+([A-Za-z_]\w*)\s*[:(]/);
  if (m) return { name: m[1], kind: "class", exported: !m[1].startsWith("_"), container: true };
  return null;
}

function rubyMatcher(line: string): Decl | null {
  let m = line.match(/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/);
  if (m) return { name: m[1], kind: line.includes("self.") ? "function" : "method", exported: true, container: true };
  m = line.match(/^\s*class\s+([A-Z]\w*(?:::[A-Z]\w*)*)/);
  if (m) return { name: m[1], kind: "class", exported: true, container: true };
  m = line.match(/^\s*module\s+([A-Z]\w*(?:::[A-Z]\w*)*)/);
  if (m) return { name: m[1], kind: "module", exported: true, container: true };
  return null;
}

function extractIndented(file: string, lines: string[], match: (line: string) => Decl | null): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  const open: { sym: IndexedSymbol; indent: number; kind: SymbolKind }[] = [];
  let lastCode = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const indent = line.match(/^\s*/)![0].length;
    while (open.length && indent <= open[open.length - 1].indent) {
      open.pop()!.sym.endLine = lastCode + 1;
    }
    lastCode = i;
    const d = match(line);
    if (!d) continue;
    const parent = open[open.length - 1];
    const sym: IndexedSymbol = {
      name: d.name,
      kind: parent && parent.kind === "class" && d.kind === "function" ? "method" : d.kind,
      file,
      line: i + 1,
      signature: sig(line),
    };
    if (parent) sym.container = parent.sym.name;
    if (d.exported !== undefined) sym.exported = d.exported && !parent;
    out.push(sym);
    open.push({ sym, indent, kind: sym.kind });
  }
  for (const o of open) o.sym.endLine = lastCode + 1;
  return out;
}

// ── brace-scoped languages ─────────────────────────────────────────────

const TS_MODIFIERS = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?/;

function tsMatcher(line: string, inClass: boolean): Decl | null {
  const exported = /^\s*export\b/.test(line);
  const rest = line.replace(TS_MODIFIERS, "");
  let m = rest.match(/^function\s*\*?\s*([A-Za-z_$][\w$]*)/);
  if (m) return { name: m[1], kind: "function", exported, container: true };
  m = rest.match(/^class\s+([A-Za-z_$][\w$]*)/);
  if (m) return { name: m[1], kind: "class", exported, container: true };
  m = rest.match(/^interface\s+([A-Za-z_$][\w$]*)/);
  if (m) return { name: m[1], kind: "interface", exported, container: true };
  m = rest.match(/^type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/);
  if (m) return { name: m[1], kind: "type", exported };
  m = rest.match(/^(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/);
  if (m) return { name: m[1], kind: "enum", exported, container: true };
  m = rest.match(/^namespace\s+([A-Za-z_$][\w$.]*)/);
  if (m) return { name: m[1], kind: "module", exported, container: true };
  m = rest.match(/^(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/);
  if (m) return { name: m[2], kind: "function", exported, container: true };
  m = rest.match(/^(const|let|var)\s+([A-Za-z_$][\w$]*)\b/);
  if (m) return { name: m[2], kind: m[1] === "const" ? "constant" : "variable", exported };
  if (inClass) {
    m = line.match(
      /^\s*(?:(?:public|private|protected|static|readonly|override|abstract|async|declare)\s+)*(?:get\s+|set\s+|\*\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::[^{;=]*)?\s*(?:\{|$)/,
    );
    if (m && !KEYWORDS_NOT_NAMES.has(m[1]) && !/^\s*(?:return|throw|await|new|if|else|for|while|switch)\b/.test(line)) {
      return { name: m[1], kind: "method", container: true };
    }
    m = line.match(/^\s*constructor\s*\(/);
    if (m) return { name: "constructor", kind: "method", container: true };
  }
  return null;
}

function rustMatcher(line: string): Decl | null {
  const exported = /^\s*pub\b/.test(line);
  const rest = line.replace(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern\s+"[^"]*"|extern)\s+)*/, "");
  let m = rest.match(/^fn\s+([A-Za-z_]\w*)/);
  if (m) return { name: m[1], kind: "function", exported, container: true };
  m = rest.match(/^struct\s+([A-Za-z_]\w*)/);
  if (m) return { name: m[1], kind: "struct", exported, container: true };
  m = rest.match(/^enum\s+([A-Za-z_]\w*)/);
  if (m) return { name: m[1], kind: "enum", exported, container: true };
  m = rest.match(/^trait\s+([A-Za-z_]\w*)/);
  if (m) return { name: m[1], kind: "trait", exported, container: true };
  m = rest.match(/^impl(?:<[^>]*>)?\s+(?:([A-Za-z_][\w:]*)(?:<[^>]*>)?\s+for\s+)?([A-Za-z_][\w:]*)/);
  if (m) return { name: m[1] ? `${m[1]} for ${m[2]}` : m[2], kind: "impl", container: true };
  m = rest.match(/^mod\s+([A-Za-z_]\w*)/);
  if (m) return { name: m[1], kind: "module", exported, container: true };
  m = rest.match(/^type\s+([A-Za-z_]\w*)/);
  if (m) return { name: m[1], kind: "type", exported };
  m = rest.match(/^(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)\s*:/);
  if (m) return { name: m[1], kind: "constant", exported };
  m = rest.match(/^macro_rules!\s+([A-Za-z_]\w*)/);
  if (m) return { name: m[1], kind: "macro", exported: /#\[macro_export\]/.test(line), container: true };
  return null;
}

function goMatcher(line: string): Decl | null {
  let m = line.match(/^func\s+\(\s*\w+\s+\*?([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s+([A-Za-z_]\w*)\s*\(/);
  if (m) return { name: m[2], kind: "method", exported: /^[A-Z]/.test(m[2]), container: true };
  m = line.match(/^func\s+([A-Za-z_]\w*)\s*[(\[]/);
  if (m) return { name: m[1], kind: "function", exported: /^[A-Z]/.test(m[1]), container: true };
  m = line.match(/^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\b/);
  if (m) return { name: m[1], kind: m[2] === "struct" ? "struct" : "interface", exported: /^[A-Z]/.test(m[1]), container: true };
  m = line.match(/^type\s+([A-Za-z_]\w*)\b/);
  if (m) return { name: m[1], kind: "type", exported: /^[A-Z]/.test(m[1]) };
  m = line.match(/^(?:var|const)\s+([A-Za-z_]\w*)\b/);
  if (m) return { name: m[1], kind: line.startsWith("const") ? "constant" : "variable", exported: /^[A-Z]/.test(m[1]) };
  return null;
}

/** Go method receivers name their container on the same line; surface it. */
function goReceiver(line: string): string | undefined {
  const m = line.match(/^func\s+\(\s*\w+\s+\*?([A-Za-z_]\w*)/);
  return m ? m[1] : undefined;
}

const JVM_TYPE_DECL = /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|inner|partial|readonly|unsafe|export)\s+)*(class|interface|record|enum|struct|object|trait|annotation\s+class)\s+([A-Za-z_]\w*)/;
// Method by signature: [modifiers] [<generics>] ReturnType name(args) [throws ...] {  — and no ';' (that's a prototype/abstract member).
const JVM_METHOD = /^\s*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|override|virtual|async|unsafe|extern|inline|suspend|open|default)\s+)*(?:<[^>]+>\s+)?(?:[A-Za-z_][\w.<>\[\],?\s]*?[\w>\]?])\s+([A-Za-z_]\w*)\s*\([^;]*\)?\s*(?:throws\s+[\w.,\s]+)?\s*(?:\{|$)/;
const CTOR = /^\s*(?:(?:public|private|protected|internal)\s+)?([A-Z]\w*)\s*\([^;]*\)\s*(?:throws\s+[\w.,\s]+)?\s*(?:\{|$)/;

function jvmMatcher(line: string, inType: boolean, lang: Lang): Decl | null {
  let m = line.match(JVM_TYPE_DECL);
  if (m) {
    const kindWord = m[1].replace(/\s+/g, " ");
    const kind: SymbolKind =
      kindWord === "interface" || kindWord === "trait" || kindWord === "annotation class"
        ? "interface"
        : kindWord === "enum"
        ? "enum"
        : kindWord === "struct"
        ? "struct"
        : kindWord === "object"
        ? "module"
        : "class";
    return { name: m[2], kind, exported: /\b(public|internal)\b/.test(line) || lang === "kotlin", container: true };
  }
  if (lang === "kotlin") {
    m = line.match(/^\s*(?:(?:public|private|protected|internal|override|open|abstract|suspend|inline|operator|infix|external|tailrec)\s+)*fun\s+(?:<[^>]+>\s+)?(?:[\w.<>?]+\.)?([A-Za-z_]\w*)\s*\(/);
    if (m) return { name: m[1], kind: inType ? "method" : "function", exported: !/\bprivate\b/.test(line), container: true };
    m = line.match(/^\s*(?:(?:public|private|protected|internal|const|override|open|lateinit)\s+)*(val|var)\s+([A-Za-z_]\w*)/);
    if (m && !inType) return { name: m[2], kind: m[1] === "val" ? "constant" : "variable", exported: !/\bprivate\b/.test(line) };
    return null;
  }
  if (line.trimEnd().endsWith(";") || /^\s*(?:return|throw|new|else)\b/.test(line)) return null;
  m = line.match(JVM_METHOD);
  if (m && !KEYWORDS_NOT_NAMES.has(m[1]) && !/^\s*(?:if|for|while|switch|catch|foreach|using|lock)\b/.test(line)) {
    return { name: m[1], kind: inType ? "method" : "function", exported: /\b(public|internal)\b/.test(line), container: true };
  }
  m = line.match(CTOR);
  if (m && inType && !KEYWORDS_NOT_NAMES.has(m[1])) return { name: m[1], kind: "method", exported: /\bpublic\b/.test(line), container: true };
  return null;
}

// C/C++: `ret name(args)` at column 0 (or inside class), followed by `{` here or on the next line.
const C_FUNC = /^\s*(?:(?:static|inline|extern|virtual|explicit|constexpr|const|unsigned|signed|volatile|template\s*<[^>]*>)\s+)*(?:[A-Za-z_][\w:<>,*&\s]*?[\w>*&])\s+\**&?\s*((?:[A-Za-z_][\w]*::)*(?:~?[A-Za-z_]\w*|operator\s*[^\s(]+))\s*\(([^;]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:->\s*[\w:<>*&\s]+)?\s*(?:\{|$)/;

function cMatcher(line: string, next: string, inType: boolean): Decl | null {
  let m = line.match(/^\s*(?:typedef\s+)?(struct|class|union|enum(?:\s+class)?)\s+([A-Za-z_]\w*)\s*(?:final\s*)?(?::[^{]*)?\{?\s*$/);
  if (m) {
    const w = m[1].split(/\s+/)[0];
    return { name: m[2], kind: w === "class" ? "class" : w === "enum" ? "enum" : "struct", exported: true, container: true };
  }
  m = line.match(/^\s*namespace\s+([A-Za-z_][\w:]*)\s*\{?\s*$/);
  if (m) return { name: m[1], kind: "module", exported: true, container: true };
  if (/^\s*#/.test(line) || line.trimEnd().endsWith(";") || /^\s*(?:return|else|throw)\b/.test(line)) return null;
  m = line.match(C_FUNC);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, "");
  const base = name.split("::").pop() ?? name;
  if (KEYWORDS_NOT_NAMES.has(base)) return null;
  // Signature that neither opens a brace here nor on the next line is a prototype.
  if (!/\{\s*$/.test(line) && !/^\s*\{/.test(next)) return null;
  const qualified = name.includes("::");
  return { name: base, kind: inType || qualified ? "method" : "function", exported: !/^\s*static\b/.test(line), container: true };
}

function phpMatcher(line: string, inClass: boolean): Decl | null {
  let m = line.match(/^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/);
  if (m) return { name: m[2], kind: m[1] === "class" ? "class" : m[1] === "enum" ? "enum" : "interface", exported: true, container: true };
  m = line.match(/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/);
  if (m) return { name: m[1], kind: inClass ? "method" : "function", exported: !/\bprivate\b/.test(line), container: true };
  return null;
}

function shellMatcher(line: string): Decl | null {
  let m = line.match(/^\s*function\s+([A-Za-z_][\w-]*)\s*(?:\(\s*\))?\s*\{?/);
  if (m) return { name: m[1], kind: "function", exported: true, container: true };
  m = line.match(/^\s*([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{?\s*$/);
  if (m) return { name: m[1], kind: "function", exported: true, container: true };
  return null;
}

function extractBraced(file: string, lines: string[], lang: Lang): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  // Open scopes: a symbol plus the brace depth at which its body opened.
  const open: { sym: IndexedSymbol; depth: number; pending: boolean }[] = [];
  const exportedNames = new Set<string>();
  let depth = 0;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = stripCommentsAndStrings(raw, inBlockComment);
    inBlockComment = stripped.inBlockComment;
    const line = stripped.text;
    const trimmed = line.trim();
    if (trimmed === "") continue;

    // Scope owner for this line = innermost open scope whose body has begun.
    const parent = innermostContainer(open, depth);
    const parentKind = parent?.sym.kind;
    const inType =
      parentKind === "class" || parentKind === "interface" || parentKind === "struct" || parentKind === "impl" || parentKind === "trait" || parentKind === "enum";

    let d: Decl | null = null;
    switch (lang) {
      case "ts":
        d = tsMatcher(line, parentKind === "class");
        collectTsExports(line, exportedNames);
        break;
      case "rust":
        d = rustMatcher(line);
        break;
      case "go":
        d = goMatcher(line);
        break;
      case "jvm":
      case "kotlin":
        d = jvmMatcher(line, inType, lang);
        break;
      case "c":
        d = cMatcher(line, nextNonEmpty(lines, i + 1), inType);
        break;
      case "php":
        d = phpMatcher(line, parentKind === "class" || parentKind === "interface");
        break;
      case "shell":
        d = shellMatcher(line);
        break;
    }

    const opens = countChar(line, "{");
    const closes = countChar(line, "}");

    if (d) {
      const sym: IndexedSymbol = { name: d.name, kind: d.kind, file, line: i + 1, signature: sig(raw) };
      if (lang === "rust" && parentKind === "impl" && d.kind === "function") sym.kind = "method";
      if (lang === "ts" && parentKind === "interface" && d.kind === "method") sym.kind = "method";
      const receiver = lang === "go" ? goReceiver(line) : undefined;
      if (receiver) sym.container = receiver;
      else if (parent) sym.container = parent.sym.name;
      if (d.exported !== undefined) sym.exported = d.exported;
      out.push(sym);
      if (d.container) {
        if (opens > closes) {
          open.push({ sym, depth, pending: false });
        } else if (opens > 0 && opens === closes) {
          sym.endLine = i + 1; // one-liner body
        } else if (/^\s*\{/.test(nextNonEmpty(lines, i + 1))) {
          open.push({ sym, depth, pending: true });
        } else {
          sym.endLine = i + 1; // declaration without a body (abstract, prototype, one-line arrow)
        }
      } else {
        sym.endLine = i + 1;
      }
    }

    // Pending scopes (brace on the next line) begin when we see their `{`.
    if (opens > 0) for (const o of open) if (o.pending) o.pending = false;
    depth += opens - closes;
    if (depth < 0) depth = 0;
    while (open.length && !open[open.length - 1].pending && depth <= open[open.length - 1].depth) {
      open.pop()!.sym.endLine = i + 1;
    }
  }
  for (const o of open) o.sym.endLine = lines.length;

  if (exportedNames.size) {
    for (const s of out) if (exportedNames.has(s.name) && !s.container) s.exported = true;
  }
  return out;
}

function innermostContainer(open: { sym: IndexedSymbol; depth: number; pending: boolean }[], depth: number) {
  for (let k = open.length - 1; k >= 0; k--) if (!open[k].pending && depth > open[k].depth) return open[k];
  return undefined;
}

function nextNonEmpty(lines: string[], from: number): string {
  for (let k = from; k < lines.length && k < from + 3; k++) if (lines[k].trim() !== "") return lines[k];
  return "";
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let k = 0; k < s.length; k++) if (s[k] === ch) n++;
  return n;
}

/** `export { a, b as c }` and `export default name` mark previously-seen declarations exported. */
function collectTsExports(line: string, into: Set<string>): void {
  const m = line.match(/^\s*export\s*\{([^}]*)\}/);
  if (m) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) into.add(name);
    }
  }
  const def = line.match(/^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/);
  if (def) into.add(def[1]);
}

/**
 * Blank out string literals and comments so braces inside them don't skew the
 * depth tracker. Line-local: a block comment that spans lines carries over via
 * the returned flag; template literals spanning lines are treated as code (rare
 * enough that a wrong endLine beats a missed symbol).
 */
function stripCommentsAndStrings(line: string, inBlockComment: boolean): { text: string; inBlockComment: boolean } {
  let out = "";
  let i = 0;
  let inBlock = inBlockComment;
  while (i < line.length) {
    const c = line[i];
    const next = line[i + 1];
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 2;
      } else i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "/") break;
    if (c === "#" && /^\s*$/.test(out) && !/^\s*#(?:include|define|if|endif|else|pragma)/.test(line)) break;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) {
        if (line[j] === "\\") j++;
        j++;
      }
      out += " ".repeat(Math.min(line.length, j + 1) - i);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return { text: out, inBlockComment: inBlock };
}
