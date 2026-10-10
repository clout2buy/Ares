// bootstrap-forge.sh: dry run is inert, init builds ~/forge from a remote and the live commit,
// self-edits go to auto/<date>-<slug> worktrees outside the live tree, and no secret is ever
// accepted in a URL or printed.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";

import { makeForge, git } from "./_elite-fixture.mjs";

const SCRIPT = path.resolve("scripts/elite/bootstrap-forge.sh").replaceAll("\\", "/");
const fwd = (p) => p.replaceAll("\\", "/");
const hasBash = (() => { try { execFileSync("bash", ["-c", "true"], { stdio: "ignore" }); return true; } catch { return false; } })();

function sh(f, args, env = {}) {
  const forge = fwd(path.join(f.root, "forge"));
  const r = spawnSync("bash", [SCRIPT, "--forge", forge, "--live", fwd(f.live), "--remote", fwd(f.bare), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: fwd(f.root), GIT_CONFIG_GLOBAL: path.join(f.root, ".gitconfig"), GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.invalid", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, forge: path.join(f.root, "forge") };
}

test("bootstrap: --dry-run prints the plan and creates nothing", { skip: !hasBash }, async (t) => {
  const f = await makeForge(t);
  const r = sh(f, ["--dry-run", "init"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\(dry-run\)/);
  assert.ok(!existsSync(r.forge), "no forge directory was created");
});

test("bootstrap: init builds the bare forge, wires rook, records the live commit; re-running is harmless", { skip: !hasBash }, async (t) => {
  const f = await makeForge(t);
  let r = sh(f, ["init"]);
  assert.equal(r.code, 0, r.err);
  const bare = path.join(r.forge, "ares");
  assert.equal(git(bare, "config", "--get", "remote.rook.url").replaceAll("\\", "/"), fwd(f.bare));
  assert.equal(git(bare, "rev-parse", "refs/live/head"), f.head(), "the live commit is known to the forge");
  assert.equal(git(bare, "rev-parse", "refs/remotes/rook/main"), f.head());
  for (const d of ["work", "tmp", "bin"]) assert.ok(existsSync(path.join(r.forge, d)), d);
  r = sh(f, ["init"]);
  assert.equal(r.code, 0, r.err);
  // the live checkout was only read from
  assert.equal(git(f.live, "status", "--porcelain"), "");
});

test("bootstrap: new-worktree makes auto/<date>-<slug> from the live commit, outside the live tree; rm-worktree refuses strangers", { skip: !hasBash }, async (t) => {
  const f = await makeForge(t);
  sh(f, ["init"]);
  const a = sh(f, ["new-worktree", "Fix the Flaky Test!"]);
  assert.equal(a.code, 0, a.err);
  const dir = a.out.trim().split("\n").at(-1);
  const day = new Date().toISOString().slice(0, 10);
  assert.ok(existsSync(path.join(dir, ".git")));
  assert.match(a.err, new RegExp(`branch: auto/${day}-fix-the-flaky-test`));
  assert.equal(git(dir, "rev-parse", "HEAD"), f.head());
  assert.ok(!path.resolve(dir).startsWith(path.resolve(f.live)), "never inside ~/Ares");
  const b = sh(f, ["new-worktree", "Fix the Flaky Test!"]);
  assert.match(b.err, /-2/, "a second worktree for the same slug gets its own branch");
  const bad = sh(f, ["rm-worktree", fwd(f.live)]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /not under/);
  assert.ok(existsSync(f.live));
  assert.equal(sh(f, ["rm-worktree", dir]).code, 0);
  assert.ok(!existsSync(dir));
});

test("bootstrap: a URL with credentials is refused, and a deploy key is recorded by path only", { skip: !hasBash }, async (t) => {
  const f = await makeForge(t);
  const secretUrl = "https://x-access-token:ghp_" + "Z".repeat(36) + "@github.com/o/r";
  const r = sh(f, ["--dry-run", "init"], { ARES_FORGE_REMOTE: secretUrl });
  const bad = spawnSync("bash", [SCRIPT, "--forge", fwd(path.join(f.root, "forge2")), "--remote", secretUrl, "--dry-run", "init"], { encoding: "utf8", env: { ...process.env, HOME: fwd(f.root) } });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /contains credentials/);
  assert.ok(!(bad.stdout + bad.stderr).includes("ZZZZ"), "the secret is never echoed");
  void r;

  const key = path.join(f.root, "deploy_key");
  writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n"); // ares-secret-scan: ignore (a fake key to prove it is never printed)
  const ok = sh(f, ["--offline", "init"], { ARES_FORGE_SSH_KEY: fwd(key) });
  assert.equal(ok.code, 0, ok.err);
  assert.ok(!(ok.out + ok.err).includes("SECRETKEYMATERIAL"), "key contents never printed");
  assert.match(git(path.join(ok.forge, "ares"), "config", "--get", "core.sshCommand"), /deploy_key/);
});

test("bootstrap: the forge refuses to live inside the live tree", { skip: !hasBash }, async (t) => {
  const f = await makeForge(t);
  const r = spawnSync("bash", [SCRIPT, "--forge", fwd(path.join(f.live, "forge")), "--live", fwd(f.live), "--remote", fwd(f.bare), "--dry-run", "init"], { encoding: "utf8", env: { ...process.env, HOME: fwd(f.root) } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must not live inside the live tree/);
  void readFileSync; void fsp;
});
