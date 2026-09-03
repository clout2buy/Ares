// Git-backed checkpoint layer.
//
// When the workspace lives inside a git repository, checkpoints are git TREE
// objects instead of the blob store under .ares/checkpoints/blobs. The trees
// are built through a SHADOW INDEX (GIT_INDEX_FILE pointing at
// .ares/checkpoints/shadow-index) so the user's real index, HEAD, and branches
// are never read from or written to — `git status` before and after a
// checkpoint/restore is identical apart from the files a restore rewrote.
//
// Why git instead of the home-grown blob layer:
//   - no 2MB per-file cap (the blob layer silently skipped big files → holes in
//     /undo that only surfaced when a restore "forgot" a file);
//   - .gitignore semantics for free (untracked files ARE included, ignored ones
//     are not — dist/, node_modules/, build outputs);
//   - delta compression + one `git gc` reclaims everything, versus the 1.2GB of
//     loose content-addressed blobs one machine accumulated;
//   - incremental staging is git's native fast path (stat-cache), so a full
//     `add -A` on an already-populated shadow index is ~100ms on a 30k-file repo.
//
// Every tree is anchored by a commit object under
// refs/ares/checkpoints/<session>/<checkpoint> (parent = the session's previous
// checkpoint commit) so `git gc` keeps it. Anchoring is DEFERRED off the
// pre-tool hot path (two extra spawns) onto the per-workspace chain; a tree
// written seconds ago is safe from gc's default two-week prune window anyway.
//
// All git work for one workspace is serialized in-process (shared shadow
// index). Cross-process contention surfaces as `index.lock` and is retried.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/** `ARES_CHECKPOINT_GIT=0` forces the legacy blob layer even inside a repo. */
export function gitCheckpointsEnabled(): boolean {
  return process.env.ARES_CHECKPOINT_GIT !== "0";
}

interface GitRun {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function runGit(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string | Buffer } = {}): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...opts.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
    child.stdin.on("error", () => {}); // git may exit before reading stdin
    child.stdin.end(opts.input ?? "");
  });
}

/** Retry on another process holding the shadow index (or a ref) lock. */
async function runGitLocked(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string | Buffer } = {}): Promise<GitRun> {
  for (let attempt = 0; ; attempt++) {
    const result = await runGit(cwd, args, opts);
    if (result.code === 0 || attempt >= 5 || !/\.lock['"]?:? .*(exists|File exists)|Unable to create .*\.lock/i.test(result.stderr)) return result;
    await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
  }
}

function fail(what: string, run: GitRun): Error {
  return new Error(`git ${what} failed (${run.code}): ${run.stderr.trim().slice(0, 300)}`);
}

// ─── per-workspace state ─────────────────────────────────────────────────────

const rootCache = new Map<string, Promise<string | null>>();
const chains = new Map<string, Promise<unknown>>();

/** Serialize one workspace's git work in-process (shared shadow index). The
 *  blob layer's create/gc share this chain too — see checkpoints.ts. */
export function serializedForWorkspace<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(workspace);
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  chains.set(key, next.catch(() => undefined));
  return next;
}

/**
 * The repository toplevel for a workspace, or null when the workspace is not
 * inside a git repo (or git is missing). Cached per workspace for the process
 * — positive AND negative — because `rev-parse` is a spawn we cannot afford
 * before every Edit. The knob is checked live (tests flip it), the lookup is not.
 */
export async function gitCheckpointRoot(workspace: string, opts: { ignoreKnob?: boolean } = {}): Promise<string | null> {
  if (!opts.ignoreKnob && !gitCheckpointsEnabled()) return null;
  const key = path.resolve(workspace);
  let pending = rootCache.get(key);
  if (!pending) {
    pending = runGit(key, ["rev-parse", "--show-toplevel"])
      .then((run) => {
        if (run.code !== 0) return null;
        const top = run.stdout.toString("utf8").trim();
        return top ? path.resolve(top) : null;
      })
      .catch(() => null);
    rootCache.set(key, pending);
  }
  return pending;
}

/** Tests only: forget cached repo lookups (e.g. after `git init` in a dir). */
export function resetGitCheckpointCache(): void {
  rootCache.clear();
}

function shadowIndexPath(workspace: string): string {
  return path.join(workspace, ".ares", "checkpoints", "shadow-index");
}

const shadowExcludeReady = new Map<string, Promise<string>>();

/**
 * `.ares` must never be staged (it holds the rollouts and this very index; a
 * restore would rewrite the session's own log). A `:(exclude).ares` pathspec
 * cannot do it: when `.ares/` is ALSO gitignored, git refuses the whole add
 * ("The following paths are ignored"). So `.ares/` goes into a shadow excludes
 * file passed as core.excludesFile — seeded with the user's global excludes
 * so their `.idea/`/`.DS_Store` patterns keep applying inside snapshots (else
 * a restore would delete IDE state files created after the checkpoint).
 * Resolved once per workspace per process: zero extra spawns on the hot path.
 */
function shadowExcludesFile(workspace: string): Promise<string> {
  const key = path.resolve(workspace);
  let pending = shadowExcludeReady.get(key);
  if (!pending) {
    pending = (async () => {
      const file = path.join(workspace, ".ares", "checkpoints", "shadow-exclude");
      const configured = await runGit(workspace, ["config", "--get", "core.excludesFile"]).catch(() => null);
      let globalPath = configured?.code === 0 ? configured.stdout.toString("utf8").trim() : "";
      if (globalPath.startsWith("~/")) globalPath = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", globalPath.slice(2));
      if (!globalPath) {
        const xdg = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".config");
        globalPath = path.join(xdg, "git", "ignore");
      }
      const inherited = await fs.readFile(globalPath, "utf8").catch(() => "");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${inherited.trimEnd()}
# ares: never snapshot the session store
.ares/
`, "utf8");
      return file;
    })();
    shadowExcludeReady.set(key, pending);
  }
  return pending;
}

async function shadowEnv(workspace: string): Promise<Record<string, string>> {
  const index = shadowIndexPath(workspace);
  await fs.mkdir(path.dirname(index), { recursive: true });
  const excludes = await shadowExcludesFile(workspace);
  return { GIT_INDEX_FILE: index, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: excludes };
}

/** Workspace-relative POSIX path, or null when outside the workspace. */
function relInside(workspace: string, file: string): string | null {
  const full = path.isAbsolute(file) ? file : path.join(workspace, file);
  const rel = path.relative(workspace, full).replace(/\\/g, "/");
  if (!rel || rel === "." || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return null;
  if (rel === ".ares" || rel.startsWith(".ares/") || rel === ".git" || rel.startsWith(".git/")) return null;
  return rel;
}

/** Stage the workspace subtree into the shadow index (`.ares` is kept out by
 *  the shadow excludes file — see shadowExcludesFile). */
async function stage(workspace: string, env: Record<string, string>, targetFiles?: readonly string[]): Promise<void> {
  if (targetFiles && targetFiles.length > 0) {
    const targets = targetFiles.map((file) => relInside(workspace, file)).filter((rel): rel is string => rel !== null);
    if (targets.length === 0) return; // nothing snapshotable changed
    // `add -A -- <paths>` records edits AND deletions of exactly those paths.
    // A never-seen or gitignored target makes git refuse the pathspec; fall
    // back to the full staging pass rather than snapshot a stale index.
    const targeted = await runGitLocked(workspace, ["add", "-A", "--", ...targets], { env });
    if (targeted.code === 0) return;
  }
  const full = await runGitLocked(workspace, ["add", "-A", "--", "."], { env });
  if (full.code !== 0) throw fail("add", full);
}

async function writeTree(workspace: string, env: Record<string, string>): Promise<string> {
  const run = await runGit(workspace, ["write-tree"], { env });
  if (run.code !== 0) throw fail("write-tree", run);
  return run.stdout.toString("utf8").trim();
}

/** Snapshot the workspace subtree as a tree object. Declared targets (Edit/
 *  Write) stage incrementally; shells and hooks stage everything. Caller must
 *  already be inside `serializedForWorkspace`. */
export async function gitSnapshotTree(workspace: string, targetFiles?: readonly string[]): Promise<string> {
  const env = await shadowEnv(workspace);
  await stage(workspace, env, targetFiles);
  return writeTree(workspace, env);
}

// ─── anchoring (refs) ────────────────────────────────────────────────────────

function refSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$|\.\.|\.lock$/g, "") || "x";
}

export function checkpointRefName(sessionId: string, checkpointId: string): string {
  return `refs/ares/checkpoints/${refSegment(sessionId)}/${refSegment(checkpointId)}`;
}

const ANCHOR_ENV = {
  GIT_AUTHOR_NAME: "Ares",
  GIT_AUTHOR_EMAIL: "ares@localhost",
  GIT_COMMITTER_NAME: "Ares",
  GIT_COMMITTER_EMAIL: "ares@localhost",
};

/** Make the commit that pins `tree` and point the session/checkpoint ref at
 *  it. Returns the commit sha. Identity is fixed so this never depends on (or
 *  leaks into) the user's git config. */
export async function gitAnchorTree(
  workspace: string,
  sessionId: string,
  checkpointId: string,
  tree: string,
  parentCommit?: string,
): Promise<string> {
  const args = ["commit-tree", tree, "-m", `ares checkpoint ${checkpointId}`];
  if (parentCommit) args.push("-p", parentCommit);
  const commit = await runGit(workspace, args, { env: ANCHOR_ENV });
  if (commit.code !== 0) throw fail("commit-tree", commit);
  const sha = commit.stdout.toString("utf8").trim();
  const ref = await runGitLocked(workspace, ["update-ref", checkpointRefName(sessionId, checkpointId), sha]);
  if (ref.code !== 0) throw fail("update-ref", ref);
  return sha;
}

/** All refs under refs/ares/checkpoints/. */
export async function gitListCheckpointRefs(workspace: string): Promise<string[]> {
  const run = await runGit(workspace, ["for-each-ref", "--format=%(refname)", "refs/ares/checkpoints/"]);
  if (run.code !== 0) return [];
  return run.stdout.toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** Delete refs in one transaction so `git gc` can reclaim their objects. */
export async function gitDeleteRefs(workspace: string, refs: readonly string[]): Promise<void> {
  if (refs.length === 0) return;
  const input = refs.map((ref) => `delete ${ref}\n`).join("");
  const run = await runGitLocked(workspace, ["update-ref", "--stdin"], { input });
  if (run.code !== 0) throw fail("update-ref --stdin", run);
}

// ─── diff / restore ──────────────────────────────────────────────────────────

type NameStatus = Array<{ status: string; path: string }>;

/** `git diff --cached` of the checkpoint tree against the (freshly staged)
 *  shadow index = checkpoint vs. live workspace, untracked files included.
 *  `--relative` keeps paths workspace-relative and scoped to the subtree. */
async function nameStatus(workspace: string, env: Record<string, string>, tree: string, pathspecs: readonly string[]): Promise<NameStatus> {
  const run = await runGit(workspace, ["diff", "--cached", "--relative", "--name-status", "-z", "--no-renames", tree, "--", ...pathspecs], { env });
  if (run.code !== 0) throw fail("diff --name-status", run);
  const parts = run.stdout.toString("utf8").split("\0");
  const out: NameStatus = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index];
    const file = parts[index + 1];
    if (status && file) out.push({ status: status[0], path: file });
  }
  return out;
}

function resolvePathspecs(workspace: string, files?: readonly string[]): string[] | null {
  if (!files || files.length === 0) return [];
  const rels = [...new Set(files.map((file) => relInside(workspace, file)).filter((rel): rel is string => rel !== null))];
  return rels.length === 0 ? null : rels;
}

export async function gitDiffNames(
  workspace: string,
  tree: string,
): Promise<{ added: string[]; modified: string[]; deleted: string[] }> {
  const env = await shadowEnv(workspace);
  await stage(workspace, env);
  const rows = await nameStatus(workspace, env, tree, []);
  const pick = (statuses: string) => rows.filter((row) => statuses.includes(row.status)).map((row) => row.path).sort();
  return { added: pick("A"), modified: pick("MT"), deleted: pick("D") };
}

export async function gitDiffUnified(
  workspace: string,
  tree: string,
  files: readonly string[] | undefined,
  opts: { maxChars: number; contextLines: number },
): Promise<{ diff: string; files: string[]; truncated: boolean }> {
  const pathspecs = resolvePathspecs(workspace, files);
  if (pathspecs === null) return { diff: "", files: [], truncated: false }; // only out-of-workspace paths named
  const env = await shadowEnv(workspace);
  await stage(workspace, env, files && files.length > 0 ? files : undefined);
  const rows = await nameStatus(workspace, env, tree, pathspecs);
  if (rows.length === 0) return { diff: "", files: [], truncated: false };
  const patch = await runGit(
    workspace,
    ["-c", "core.quotePath=false", "diff", "--cached", "--relative", "--no-color", "--no-ext-diff", "--no-renames", `--unified=${opts.contextLines}`, tree, "--", ...pathspecs],
    { env },
  );
  if (patch.code !== 0) throw fail("diff", patch);
  let text = patch.stdout.toString("utf8");
  let truncated = false;
  if (text.length > opts.maxChars) {
    text = text.slice(0, opts.maxChars);
    truncated = true;
  }
  return { diff: text, files: rows.map((row) => row.path).sort(), truncated };
}

/** Read blobs out of a tree in ONE `cat-file --batch` round trip. Keys are
 *  workspace-relative paths; the prefix maps them to tree-relative paths. */
async function readTreeBlobs(workspace: string, tree: string, prefix: string, rels: readonly string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (rels.length === 0) return out;
  const specs = rels.map((rel) => `${tree}:${prefix ? `${prefix}/${rel}` : rel}`);
  const run = await runGit(workspace, ["cat-file", "--batch"], { input: specs.join("\n") + "\n" });
  if (run.code !== 0) throw fail("cat-file --batch", run);
  const buf = run.stdout;
  let offset = 0;
  for (const rel of rels) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl < 0) break;
    const header = buf.subarray(offset, nl).toString("utf8");
    offset = nl + 1;
    const parts = header.split(" ");
    if (parts[1] === "missing" || parts.length < 3) continue;
    const size = Number(parts[2]);
    out.set(rel, Buffer.from(buf.subarray(offset, offset + size)));
    offset += size + 1; // trailing LF after each object
  }
  return out;
}

/** Executable bits for the given tree-relative paths (Linux/macOS restores). */
async function treeModes(workspace: string, tree: string, prefix: string, rels: readonly string[]): Promise<Map<string, string>> {
  const modes = new Map<string, string>();
  if (process.platform === "win32" || rels.length === 0) return modes;
  const run = await runGit(workspace, ["ls-tree", "-r", "-z", "--full-tree", tree, "--", ...rels.map((rel) => (prefix ? `${prefix}/${rel}` : rel))]);
  if (run.code !== 0) return modes;
  for (const entry of run.stdout.toString("utf8").split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode] = entry.slice(0, tab).split(" ");
    const full = entry.slice(tab + 1);
    modes.set(prefix && full.startsWith(`${prefix}/`) ? full.slice(prefix.length + 1) : full, mode);
  }
  return modes;
}

/**
 * Bring the workspace back to `tree`, touching ONLY the paths that differ:
 * files added since are deleted, modified/deleted ones are rewritten from the
 * tree. Never runs `git checkout`/`reset` — the user's HEAD, index, and
 * branches are not involved at any point. Returns workspace-relative paths.
 */
export async function gitRestoreTree(
  workspace: string,
  root: string,
  tree: string,
): Promise<{ restored: number; deleted: number; files: string[] }> {
  const env = await shadowEnv(workspace);
  await stage(workspace, env);
  const rows = await nameStatus(workspace, env, tree, []);
  const prefix = path.relative(root, workspace).replace(/\\/g, "/");
  const toDelete = rows.filter((row) => row.status === "A").map((row) => row.path);
  const toWrite = rows.filter((row) => row.status !== "A").map((row) => row.path);
  const blobs = await readTreeBlobs(workspace, tree, prefix, toWrite);
  const modes = await treeModes(workspace, tree, prefix, toWrite);

  let deleted = 0;
  for (const rel of toDelete) {
    if (relInside(workspace, rel) === null) continue;
    await fs.rm(path.join(workspace, rel), { force: true });
    deleted++;
  }
  let restored = 0;
  for (const rel of toWrite) {
    const bytes = blobs.get(rel);
    if (!bytes || relInside(workspace, rel) === null) continue;
    const target = path.join(workspace, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    if (modes.get(rel) === "100755") await fs.chmod(target, 0o755).catch(() => {});
    restored++;
  }
  // Re-stage so the shadow index matches disk again; otherwise the next
  // INCREMENTAL checkpoint (which only re-stages its Edit target) would carry
  // the pre-restore content of every file we just rewrote.
  await stage(workspace, env);
  return { restored, deleted, files: [...toDelete, ...toWrite].sort() };
}

// ─── branch surfacing ────────────────────────────────────────────────────────
//
// Checkpoint anchors are already commit objects chained per session, which
// means a session's work IS a branch in everything but name. Naming it hands
// the task to ordinary git: review it, merge it, or delete it — no bespoke
// merge machinery to maintain, no way for Ares to outgrow the owner's tools.

/** Resolve a ref/commit-ish inside the workspace repo, or null. */
export async function gitResolveCommit(workspace: string, ref: string): Promise<string | null> {
  const run = await runGit(workspace, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return run.code === 0 ? run.stdout.toString("utf8").trim() : null;
}

/** Anchor a bare tree as a parentless commit (fallback for a checkpoint whose
 *  deferred anchor never landed — the tree still exists and is branchable). */
export async function gitCommitTree(workspace: string, tree: string, message: string): Promise<string> {
  const run = await runGit(workspace, ["commit-tree", tree, "-m", message], {
    env: {
      GIT_AUTHOR_NAME: "ares", GIT_AUTHOR_EMAIL: "ares@localhost",
      GIT_COMMITTER_NAME: "ares", GIT_COMMITTER_EMAIL: "ares@localhost",
    },
  });
  if (run.code !== 0) throw fail("commit-tree", run);
  return run.stdout.toString("utf8").trim();
}

/** Create a real local branch at a commit. Refuses an existing branch — the
 *  owner's branches are never force-moved by tooling. */
export async function gitCreateBranch(workspace: string, branchName: string, commit: string): Promise<void> {
  const check = await runGit(workspace, ["check-ref-format", "--branch", branchName]);
  if (check.code !== 0) throw new Error(`invalid branch name: ${branchName}`);
  const exists = await gitResolveCommit(workspace, `refs/heads/${branchName}`);
  if (exists) throw new Error(`branch already exists: ${branchName}`);
  const run = await runGit(workspace, ["branch", branchName, commit]);
  if (run.code !== 0) throw fail("branch", run);
}
