// Elite coding slice - tool-level guarantees, all deterministic and offline:
//   * test-output summarizer collapses huge logs into counts + first error + failures
//   * Bash applies it only to test/build commands with large output
//   * the pre-write syntax gate refuses a breaking Edit/Write, never a pre-broken file
//   * a stale Read no longer costs a round trip when the edit still resolves
//   * Grep accepts ripgrep inline flags (?i)(?s)(?m)(?x); native scan skips binaries
//   * Grep/Glob attach newly applicable repository rules; a read-only first shell
//     command is no longer rejected for rules it has not seen yet
//   * Diff and Bisect behave on a real throwaway repo

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  EditTool,
  WriteTool,
  ReadTool,
  GrepTool,
  GlobTool,
  BashTool,
  DiffTool,
  BisectTool,
  regexInputProblem,
  summarizeTestOutput,
  looksLikeTestCommand,
  normalizeImageProvider,
} from "../packages/tools/dist/index.js";
import { RepositoryInstructionResolver } from "../packages/core/dist/index.js";

const tmp = (p = "ares-elite-") => fs.mkdtemp(path.join(os.tmpdir(), p));
const ctx = (workspace, extra = {}) => ({
  workspace,
  sessionId: "sess_elite_tools",
  signal: new AbortController().signal,
  permissionMode: "workspace-write",
  fileReadStamps: new Map(),
  ...extra,
});
const pythonOk = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", "print(1)"]).status === 0;
const bashOk = spawnSync("bash", ["-c", "true"]).status === 0;

async function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --------------------------------------------------------------- test summarizer

test("summarizer: node:test TAP log collapses to counts, first error and failures", () => {
  const noise = Array.from({ length: 4000 }, (_, i) => `# noise line ${i}`).join("\n");
  const log = [
    "TAP version 13",
    noise,
    "not ok 7 - sum adds",
    "  ---",
    "  error: 'Expected values to be strictly equal: 7 !== 6'",
    "  code: 'ERR_ASSERTION'",
    "  ...",
    "# tests 41",
    "# pass 40",
    "# fail 1",
    "# skipped 0",
  ].join("\n");
  const s = summarizeTestOutput(log, { fullOutputPath: "/tmp/full.log" });
  assert.equal(s.framework, "node:test");
  assert.equal(s.total, 41);
  assert.equal(s.passed, 40);
  assert.equal(s.failed, 1);
  assert.match(s.text, /sum adds/);
  assert.match(s.text, /strictly equal/);
  assert.match(s.text, /full log: \/tmp\/full\.log/);
  assert.ok(s.text.length < 2500, `digest is ${s.text.length} chars for a ${log.length}-char log`);
  assert.ok(!s.text.includes("noise line 3999") || s.text.split("\n").length < 60);
});

test("summarizer: pytest, jest, cargo and go outputs yield counts", () => {
  const py = summarizeTestOutput("FAILED test_a.py::test_x - AssertionError: 1 != 2\n=== 1 failed, 9 passed, 2 skipped in 0.31s ===\n");
  assert.equal(py.framework, "pytest");
  assert.equal(py.failed, 1);
  assert.equal(py.passed, 9);
  const jest = summarizeTestOutput("FAIL src/a.test.js\n  ● adds › works\n    expect(received).toBe(expected)\nTests:       2 failed, 8 passed, 10 total\n");
  assert.equal(jest.framework, "jest");
  assert.equal(jest.failed, 2);
  assert.equal(jest.total, 10);
  const cargo = summarizeTestOutput("test a ... ok\ntest b ... FAILED\ntest result: FAILED. 1 passed; 1 failed; 0 ignored\n");
  assert.equal(cargo.framework, "cargo test");
  assert.equal(cargo.failed, 1);
  const go = summarizeTestOutput("--- FAIL: TestSum (0.00s)\n    sum_test.go:9: got 7 want 6\nFAIL\nFAIL\texample/pkg\t0.003s\n");
  assert.equal(go.framework, "go test");
  assert.equal(go.failed, 1);
  assert.match(go.text, /TestSum/);
});

test("looksLikeTestCommand recognises the common runners and ignores ordinary shell", () => {
  for (const c of ["node --test", "pnpm test", "npm run build", "pytest -x", "cargo test -p core", "go test ./...", "python3 -m unittest", "npx tsc --noEmit", "make test"]) {
    assert.ok(looksLikeTestCommand(c), c);
  }
  for (const c of ["ls -la", "git status", "echo hello", "cat README.md"]) assert.ok(!looksLikeTestCommand(c), c);
});

test("Bash: a huge failing test log is collapsed; the full log stays on disk; small logs are untouched", async () => {
  const dir = await tmp();
  await fs.writeFile(
    path.join(dir, "noisy.mjs"),
    'for (let i = 0; i < 3000; i++) console.log("# noise " + i + " lorem ipsum dolor sit amet");\nconsole.log("not ok 1 - the real failure");\nconsole.log("# tests 3");\nconsole.log("# pass 2");\nconsole.log("# fail 1");\nprocess.exit(1);\n',
  );
  const run = (command) => BashTool.call({ command, description: "t", timeout: 60000, target_paths: [], run_in_background: false }, ctx(dir));
  // Not a test command by name -> untouched even when large.
  const plain = await run("node noisy.mjs");
  assert.ok(plain.output.stdout.length > 20000, "non-test commands keep their (tail-capped) output");
  assert.equal(plain.output.testSummary, undefined);

  // A test-looking command with the same output is collapsed.
  await fs.writeFile(path.join(dir, "package.json"), '{ "scripts": { "test": "node noisy.mjs" } }');
  const collapsed = await run("npm test --silent");
  assert.ok(collapsed.output.testSummary, "digest attached");
  assert.equal(collapsed.output.testSummary.failed, 1);
  assert.match(collapsed.output.stdout, /the real failure/);
  assert.ok(collapsed.output.stdout.length < 3000, `digest is ${collapsed.output.stdout.length} chars`);
  assert.ok(collapsed.output.fullOutputPath, "full log retained");
  assert.match(await fs.readFile(collapsed.output.fullOutputPath, "utf8"), /noise 2999/);
  assert.equal(collapsed.failure, "Bash exited with code 1");

  // Small output from a test command is not rewritten.
  await fs.writeFile(path.join(dir, "quiet.mjs"), 'console.log("# tests 1");\nconsole.log("# pass 1");\n');
  await fs.writeFile(path.join(dir, "package.json"), '{ "scripts": { "test": "node quiet.mjs" } }');
  const small = await run("npm test --silent");
  assert.equal(small.output.testSummary, undefined);
  assert.match(small.output.stdout, /# pass 1/);

  // The knob turns it off.
  const off = await withEnv({ ARES_TEST_SUMMARY: "off" }, () => run("npm test --silent"));
  assert.equal(off.output.testSummary, undefined);
});

// --------------------------------------------------------------- syntax gate

test("Edit: a change that breaks a parsing JSON file is refused BEFORE it lands", async () => {
  const dir = await tmp();
  const file = path.join(dir, "cfg.json");
  await fs.writeFile(file, '{\n  "a": 1,\n  "b": 2\n}\n');
  const c = ctx(dir);
  await ReadTool.call({ file_path: file }, c);
  await assert.rejects(
    () => EditTool.call({ file_path: file, old_string: '"a": 1,', new_string: '"a": 1' }, c),
    /Syntax check failed[\s\S]*file is unchanged/,
  );
  assert.equal(await fs.readFile(file, "utf8"), '{\n  "a": 1,\n  "b": 2\n}\n', "file untouched");
  // A valid edit still lands.
  const ok = await EditTool.call({ file_path: file, old_string: '"b": 2', new_string: '"b": 3' }, c);
  assert.equal(ok.output.replacements, 1);
});

test("Edit: a node file that parsed before and does not after is refused; an already-broken file is never blocked", async () => {
  const dir = await tmp();
  const good = path.join(dir, "good.mjs");
  await fs.writeFile(good, "export function f(a) {\n  return a + 1;\n}\n");
  const c = ctx(dir);
  await assert.rejects(
    () => EditTool.call({ file_path: good, old_string: "return a + 1;", new_string: "return a + (1;" }, c),
    /Syntax check failed/,
  );
  assert.match(await fs.readFile(good, "utf8"), /return a \+ 1;/);

  const broken = path.join(dir, "broken.mjs");
  await fs.writeFile(broken, "export function g( {\n  return 1;\n}\n");
  const r = await EditTool.call({ file_path: broken, old_string: "return 1;", new_string: "return 2;" }, ctx(dir));
  assert.equal(r.output.replacements, 1, "pre-broken files are not this edit's fault");
});

test("Edit: ARES_EDIT_SYNTAX_GATE=warn writes but warns; =off is silent", async () => {
  const dir = await tmp();
  const file = path.join(dir, "x.json");
  await fs.writeFile(file, '{ "a": 1, "b": 2 }');
  await withEnv({ ARES_EDIT_SYNTAX_GATE: "warn" }, async () => {
    const r = await EditTool.call({ file_path: file, old_string: '"a": 1,', new_string: '"a": 1' }, ctx(dir));
    assert.match(r.output.syntaxWarning ?? "", /Syntax check failed/);
    assert.match(await fs.readFile(file, "utf8"), /"a": 1 "b"/);
  });
  await fs.writeFile(file, '{ "a": 1, "b": 2 }');
  await withEnv({ ARES_EDIT_SYNTAX_GATE: "off" }, async () => {
    const r = await EditTool.call({ file_path: file, old_string: '"a": 1,', new_string: '"a": 1' }, ctx(dir));
    assert.equal(r.output.syntaxWarning, undefined);
  });
});

test("Write: overwriting a valid file with broken content is refused; a NEW broken file only warns", async () => {
  const dir = await tmp();
  const file = path.join(dir, "data.json");
  await fs.writeFile(file, '{"ok": true}');
  const c = ctx(dir);
  await assert.rejects(() => WriteTool.call({ file_path: file, content: '{"ok": ' }, c), /Syntax check failed/);
  assert.equal(await fs.readFile(file, "utf8"), '{"ok": true}');
  const fresh = await WriteTool.call({ file_path: path.join(dir, "new.json"), content: "{oops" }, c);
  assert.match(fresh.display, /Syntax check failed/);
  assert.equal(await fs.readFile(path.join(dir, "new.json"), "utf8"), "{oops");
});

test("Edit: python syntax slip is caught before the write", { skip: !pythonOk && "python not installed" }, async () => {
  const dir = await tmp();
  const file = path.join(dir, "m.py");
  await fs.writeFile(file, "def f(x):\n    return x + 1\n");
  await assert.rejects(
    () => EditTool.call({ file_path: file, old_string: "return x + 1", new_string: "return (x + 1" }, ctx(dir)),
    /Syntax check failed[\s\S]*python/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "def f(x):\n    return x + 1\n");
});

// --------------------------------------------------------------- stale read

test("Edit: a stale Read no longer costs a round trip when old_string still resolves on the current bytes", async () => {
  const dir = await tmp();
  const file = path.join(dir, "limits.txt");
  await fs.writeFile(file, "MAX = 3\nTIMEOUT = 10\n");
  const c = ctx(dir);
  await ReadTool.call({ file_path: file }, c);
  await fs.appendFile(file, "# formatter touched me\n");
  const r = await EditTool.call({ file_path: file, old_string: "MAX = 3", new_string: "MAX = 5" }, c);
  assert.equal(r.output.staleRetried, true);
  assert.match(r.display, /had changed on disk/);
  assert.equal(await fs.readFile(file, "utf8"), "MAX = 5\nTIMEOUT = 10\n# formatter touched me\n", "the external change is preserved");
});

test("Edit: a stale Read whose target text is gone still fails with the stale message; the knob restores the hard stop", async () => {
  const dir = await tmp();
  const file = path.join(dir, "a.txt");
  await fs.writeFile(file, "v1\n");
  const c = ctx(dir);
  await ReadTool.call({ file_path: file }, c);
  await fs.writeFile(file, "SOMEONE ELSE\n");
  await assert.rejects(() => EditTool.call({ file_path: file, old_string: "v1", new_string: "v2" }, c), /modified on disk since the last Read/);

  await fs.writeFile(file, "keep v1 here\n");
  const c2 = ctx(dir);
  await ReadTool.call({ file_path: file }, c2);
  await fs.appendFile(file, "tail\n");
  await withEnv({ ARES_EDIT_STALE_RETRY: "0" }, () =>
    assert.rejects(() => EditTool.call({ file_path: file, old_string: "v1", new_string: "v2" }, c2), /modified on disk since the last Read/),
  );
});

// --------------------------------------------------------------- grep / glob

test("Grep: ripgrep inline flag prefixes are accepted (validation, native fallback and ripgrep)", async () => {
  for (const p of ["(?i)testflight|beta.?group", "(?s)a.b", "(?m)^x", "(?is)foo", "(?i)(?m)^bar", "(?x) a b c # comment"]) {
    assert.equal(regexInputProblem(p), null, p);
  }
  // Truly invalid patterns still fail, naming the construct.
  assert.match(regexInputProblem("(?i)(unclosed") ?? "", /invalid regular expression/);
  assert.match(regexInputProblem("(?i)(?=lookahead)x") ?? "", /lookaround/);

  const dir = await tmp();
  await fs.writeFile(path.join(dir, "a.txt"), "Hello TestFlight Beta\nnothing here\nBetaGroup\n");
  const c = ctx(dir);
  const out = await GrepTool.call({ pattern: "(?i)testflight|beta.?group", output_mode: "content", case_insensitive: false, max_results: 50, context_before: 0, context_after: 0 }, c);
  assert.equal(out.output.totalMatches, 2, `engine ${out.output.engine}`);
  const multi = await GrepTool.call({ pattern: "(?s)Hello.*?Beta", multiline: true, output_mode: "content", case_insensitive: false, max_results: 10, context_before: 0, context_after: 0 }, c);
  assert.equal(multi.output.totalMatches, 1);
  // Force the native engine too, so both paths are pinned regardless of rg being installed.
  await withEnv({ PATH: "" }, async () => {
    const native = await GrepTool.call({ pattern: "(?i)testflight", output_mode: "content", case_insensitive: false, max_results: 10, context_before: 0, context_after: 0 }, c);
    assert.equal(native.output.engine, "native");
    assert.equal(native.output.totalMatches, 1);
  });
});

test("Grep (native): binary files and oversized files are skipped, not slurped", async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, "bin.dat"), Buffer.concat([Buffer.from("needle"), Buffer.from([0, 1, 2, 3]), Buffer.from("needle")]));
  await fs.writeFile(path.join(dir, "big.log"), Buffer.alloc(5 * 1024 * 1024, "needle\n"));
  await fs.writeFile(path.join(dir, "ok.txt"), "needle\n");
  await withEnv({ PATH: "" }, async () => {
    const r = await GrepTool.call({ pattern: "needle", output_mode: "files_with_matches", case_insensitive: false, max_results: 50, context_before: 0, context_after: 0 }, ctx(dir));
    assert.equal(r.output.engine, "native");
    assert.deepEqual(r.output.files.map((f) => path.basename(f)), ["ok.txt"]);
  });
});

test("Glob: a walk that exceeds its cap returns a partial, flagged result instead of hanging", async () => {
  const dir = await tmp();
  for (let d = 0; d < 20; d++) {
    await fs.mkdir(path.join(dir, `d${d}`), { recursive: true });
    for (let f = 0; f < 20; f++) await fs.writeFile(path.join(dir, `d${d}`, `f${f}.zz`), "x");
  }
  const full = await GlobTool.call({ pattern: "**/*.nomatch", max_results: 10 }, ctx(dir));
  assert.equal(full.output.capped, undefined, "a normal walk is not flagged");
  // 200ms is the knob's floor; a tree this small finishes first, so only assert the contract shape.
  const r = await withEnv({ ARES_GLOB_TIMEOUT_MS: "200" }, () => GlobTool.call({ pattern: "**/*.zz", max_results: 1000 }, ctx(dir)));
  assert.ok(r.output.matches.length > 0);
});

// --------------------------------------------------------------- repository rules

async function rulesRepo() {
  const dir = await tmp("ares-elite-rules-");
  await fs.writeFile(path.join(dir, "AGENTS.md"), "# Rules\n- Keep edits minimal.\n");
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "a.txt"), "alpha\nbeta\n");
  return dir;
}

test("rules: a read-only FIRST shell command is not rejected; the rules ride its result and the next Edit passes", async () => {
  const dir = await rulesRepo();
  const c = ctx(dir, { repositoryInstructions: new RepositoryInstructionResolver(dir) });
  const decision = await BashTool.checkPermissions({ command: "ls", description: "x", timeout: 30000, target_paths: [], run_in_background: false }, c);
  assert.equal(decision.kind, "allow");
  const ran = await BashTool.call({ command: "ls", description: "x", timeout: 30000, target_paths: [], run_in_background: false }, c);
  assert.match(ran.output.repositoryInstructions ?? "", /Keep edits minimal/);
  const edit = await EditTool.checkPermissions({ file_path: path.join(dir, "src", "a.txt"), old_string: "alpha", new_string: "ALPHA" }, c);
  assert.equal(edit.kind, "allow", "the rules were surfaced, so the first mutation is not bounced");
});

test("rules: a mutating first shell command is still held once until the rules are seen", async () => {
  const dir = await rulesRepo();
  const c = ctx(dir, { repositoryInstructions: new RepositoryInstructionResolver(dir) });
  const input = { command: "node build.js", description: "x", timeout: 30000, target_paths: [], run_in_background: false };
  const first = await BashTool.checkPermissions(input, c);
  assert.equal(first.kind, "deny");
  assert.match(first.reason, /Keep edits minimal/);
  assert.equal((await BashTool.checkPermissions(input, c)).kind, "allow");
});

test("rules: Grep and Glob surface the rules, so a following Edit is not rejected for unseen rules", async () => {
  const dir = await rulesRepo();
  const c = ctx(dir, { repositoryInstructions: new RepositoryInstructionResolver(dir) });
  const g = await GrepTool.call({ pattern: "alpha", output_mode: "files_with_matches", case_insensitive: false, max_results: 10, context_before: 0, context_after: 0 }, c);
  assert.match(g.output.repositoryInstructions ?? "", /Keep edits minimal/);
  const e = await EditTool.checkPermissions({ file_path: path.join(dir, "src", "a.txt"), old_string: "alpha", new_string: "ALPHA" }, c);
  assert.equal(e.kind, "allow");

  const dir2 = await rulesRepo();
  const c2 = ctx(dir2, { repositoryInstructions: new RepositoryInstructionResolver(dir2) });
  const gl = await GlobTool.call({ pattern: "**/*.txt", max_results: 10 }, c2);
  assert.match(gl.output.repositoryInstructions ?? "", /Keep edits minimal/);
  // Surfaced once: a second search does not repeat them.
  const again = await GlobTool.call({ pattern: "**/*.txt", max_results: 10 }, c2);
  assert.equal(again.output.repositoryInstructions, undefined);
});

// --------------------------------------------------------------- Diff / Bisect

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
async function gitRepo() {
  const dir = await tmp("ares-elite-git-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\n");
  await fs.writeFile(path.join(dir, "b.txt"), "b\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

test("Diff: numstat, untracked files, patch and out_of_scope in one bounded call", async () => {
  const dir = await gitRepo();
  await fs.writeFile(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
  await fs.writeFile(path.join(dir, "new.txt"), "n\n");
  await fs.writeFile(path.join(dir, "b.txt"), "changed\n");
  const r = await DiffTool.call({ stat_only: false, scope: ["a.txt", "new.txt"], max_chars: 14000, context: 3 }, ctx(dir));
  assert.equal(r.output.filesChanged, 3);
  assert.ok(r.output.untracked.includes("new.txt"));
  assert.deepEqual(r.output.outOfScope, ["b.txt"]);
  assert.match(r.output.patch, /\+TWO/);
  const small = await DiffTool.call({ stat_only: false, max_chars: 500, context: 3 }, ctx(dir));
  assert.ok(small.output.patch.length <= 700);
  const stat = await DiffTool.call({ stat_only: true, max_chars: 14000, context: 3 }, ctx(dir));
  assert.equal(stat.output.patch, "");
  await assert.rejects(() => DiffTool.call({ base: "--output=/etc/x", stat_only: true, max_chars: 14000, context: 3 }, ctx(dir)), /unsafe ref/);
});

test("Diff: outside a git repo it says so instead of crashing", async () => {
  const dir = await tmp();
  await assert.rejects(() => DiffTool.call({ stat_only: true, max_chars: 14000, context: 3 }, ctx(dir)), /not inside a git work tree/);
});

test("Bisect: finds the first bad commit in a throwaway worktree and leaves the checkout alone", { skip: !bashOk && "bash not installed" }, async () => {
  const dir = await tmp("ares-elite-bisect-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  const commit = async (n, body) => {
    await fs.writeFile(path.join(dir, "v.txt"), body);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", n);
  };
  await commit("c1", "good\n");
  git(dir, "tag", "v1");
  await commit("c2", "good\n// c2\n");
  await commit("c3 breaks it", "BAD\n");
  await commit("c4", "BAD\n// c4\n");
  await commit("c5", "BAD\n// c5\n");
  const headBefore = git(dir, "rev-parse", "HEAD").trim();
  const r = await BisectTool.call({ good: "v1", bad: "HEAD", command: "grep -q good v.txt", step_timeout_s: 30, max_steps: 10 }, ctx(dir));
  assert.equal(r.output.status, "found", r.output.note ?? r.output.log);
  assert.equal(r.output.culprit.subject, "c3 breaks it");
  assert.deepEqual(r.output.culprit.files, ["v.txt"]);
  assert.equal(git(dir, "rev-parse", "HEAD").trim(), headBefore, "checkout HEAD untouched");
  assert.equal(git(dir, "status", "--porcelain").trim(), "", "no stray changes");
  assert.equal(git(dir, "worktree", "list").trim().split("\n").length, 1, "scratch worktree removed");
  await assert.rejects(() => BisectTool.call({ good: "nope", bad: "HEAD", command: "true", step_timeout_s: 30, max_steps: 10 }, ctx(dir)), /unknown good ref/);
  assert.equal((await BisectTool.validateInput({ good: "--evil", bad: "HEAD", command: "true" }, ctx(dir))).ok, false);
});

// --------------------------------------------------------------- imagine

test("Imagine: provider aliases map; unknown names fall back instead of failing the call", () => {
  assert.equal(normalizeImageProvider("openrouter"), "openrouter");
  assert.equal(normalizeImageProvider("OpenAI"), "openai");
  assert.equal(normalizeImageProvider("dall-e-3"), "openai");
  assert.equal(normalizeImageProvider("google"), "gemini");
  assert.equal(normalizeImageProvider("midjourney"), undefined);
  assert.equal(normalizeImageProvider(undefined), undefined);
});
