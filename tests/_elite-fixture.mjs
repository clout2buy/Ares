// Fixtures for the self-improvement pipeline tests: a throwaway git "forge" (author clone + bare
// remote + live checkout), a fake gateway the live checkout "serves", and a stub `systemctl` shim on
// PATH. Nothing here touches a real ~/Ares, ~/.ares or service.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { promises as fsp, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

const EMPTY_GITCONFIG = path.join(os.tmpdir(), `ares-elite-empty-gitconfig-${process.pid}`);
writeFileSync(EMPTY_GITCONFIG, "");
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG, GIT_CONFIG_NOSYSTEM: "1",
};

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export const NODE_OK = 'node -e "process.exit(0)"';
const BUILD_FAILS_ON_MARKER = `node -e "process.exit(require('fs').readFileSync('VERSION','utf8').includes('BUILDFAIL')?1:0)"`;
export const FAST_COMMANDS = { install: NODE_OK, build: BUILD_FAILS_ON_MARKER, lint: NODE_OK, test: "node tests-run.mjs" };

export async function makeForge(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-elite-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const bare = path.join(root, "remote.git");
  const author = path.join(root, "author");
  const live = path.join(root, "live");
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  const work = path.join(root, "work");
  const tmp = path.join(root, "tmp");
  for (const d of [home, state, bin, path.join(home, "garrison")]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(home, "garrison", "token"), "0123456789abcdef0123456789abcdef\n");

  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: { ...process.env, ...GIT_ENV } });
  execFileSync("git", ["init", "-q", "-b", "main", author], { env: { ...process.env, ...GIT_ENV } });
  mkdirSync(path.join(author, "packages/cli/src"), { recursive: true });
  mkdirSync(path.join(author, "tests"), { recursive: true });
  writeFileSync(path.join(author, "VERSION"), "v1\n");
  writeFileSync(path.join(author, "app.js"), "export const x = 1;\n");
  writeFileSync(path.join(author, "packages/cli/src/policyGate.ts"), "export const gate = true;\n");
  writeFileSync(path.join(author, "tests/foo.test.mjs"), "test('a', () => {});\ntest('b', () => {});\n");
  writeFileSync(path.join(author, "tests-run.mjs"),
    "import fs from 'node:fs';\nconst bad = fs.readFileSync('VERSION','utf8').includes('FAILTEST');\n" +
    "console.log(bad ? '# tests 3\\n# pass 2\\n# fail 1\\n# skipped 0' : '# tests 3\\n# pass 3\\n# fail 0\\n# skipped 0');\nprocess.exit(bad ? 1 : 0);\n");
  git(author, "add", "-A");
  git(author, "commit", "-q", "-m", "base");
  git(author, "remote", "add", "origin", bare);
  git(author, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", bare, live], { env: { ...process.env, ...GIT_ENV } });

  // The stub systemctl: "restart" makes the fake service run whatever VERSION the live tree has now.
  writeFileSync(path.join(bin, "systemctl.mjs"), [
    "import fs from 'node:fs'; import path from 'node:path';",
    "const st = process.env.ARES_TEST_STATE;",
    "if (process.argv[2] === 'restart') {",
    "  const f = path.join(st, 'restarts');",
    "  const n = Number(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 0) + 1;",
    "  fs.writeFileSync(f, String(n));",
    "  if (fs.existsSync(path.join(st, 'restart-fails'))) process.exit(1);",
    "  fs.copyFileSync(path.join(process.env.ARES_TEST_LIVE, 'VERSION'), path.join(st, 'running-version'));",
    "}",
    "",
  ].join("\n"));
  writeFileSync(path.join(bin, "systemctl"), '#!/bin/sh\nexec node "$(dirname "$0")/systemctl.mjs" "$@"\n');
  chmodSync(path.join(bin, "systemctl"), 0o755);
  writeFileSync(path.join(bin, "systemctl.cmd"), '@echo off\r\nnode "%~dp0systemctl.mjs" %*\r\n');
  writeFileSync(path.join(state, "running-version"), "v1\n");

  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.ARES_TEST_STATE = state;
  process.env.ARES_TEST_LIVE = live;

  const calls = { notify: [], ask: 0 };
  const server = http.createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const running = readFileSync(path.join(state, "running-version"), "utf8");
    const broken = running.includes("BREAK");
    const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const p = req.url.split("?")[0];
      if (p === "/health") return broken ? json(500, { ok: false }) : json(200, { ok: true });
      if (auth !== "0123456789abcdef0123456789abcdef") return json(401, { error: "unauthorized" });
      if (p === "/gateway/health") return json(200, { ok: true });
      if (p === "/gateway/health/deep") return running.includes("DEEPBAD") ? json(200, { ok: false }) : running.includes("NODEEP") ? json(404, {}) : json(200, { ok: true });
      if (p === "/gateway/goals") return running.includes("GOALS500") ? json(500, {}) : json(200, { goals: [] });
      if (p === "/gateway/memory") return json(200, { items: [] });
      if (p === "/gateway/maintainer") return json(200, { activeTurns: Number(existsSync(path.join(state, "turns")) ? readFileSync(path.join(state, "turns"), "utf8") : 0) });
      if (p === "/gateway/ask" && req.method === "POST") { calls.ask++; return running.includes("ASKBAD") ? json(503, { error: "no brain" }) : json(200, { reply: "ARES-SMOKE-OK", status: "done" }); }
      if (p === "/gateway/maintainer/notify" && req.method === "POST") { calls.notify.push(JSON.parse(body || "{}")); return json(200, { ok: true }); }
      return json(404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const f = {
    root, bare, author, live, home, state, work, tmp, baseUrl, calls,
    restarts: () => Number(existsSync(path.join(state, "restarts")) ? readFileSync(path.join(state, "restarts"), "utf8").trim() : 0),
    running: () => readFileSync(path.join(state, "running-version"), "utf8").trim(),
    setTurns: (n) => writeFileSync(path.join(state, "turns"), String(n)),
    head: (dir = live) => git(dir, "rev-parse", "HEAD"),
    /** Commit `files` on a new branch off main in the author clone, push it, return its sha. */
    commit(branch, files, message = "change") {
      git(author, "checkout", "-q", "-B", branch, "main");
      for (const [name, content] of Object.entries(files)) {
        const full = path.join(author, name);
        if (content === null) { git(author, "rm", "-q", "-f", name); continue; }
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      git(author, "add", "-A");
      git(author, "commit", "-q", "-m", message);
      git(author, "push", "-q", "-f", "origin", branch);
      return git(author, "rev-parse", "HEAD");
    },
    verifyOpts: (sha, extra = {}) => ({
      sha, repo: author, home, liveDir: live, workRoot: work, tmpRoot: tmp, commands: FAST_COMMANDS, ...extra,
    }),
    deployOpts: (sha, extra = {}) => ({
      sha, live, home, baseUrl, fetchFrom: bare, sudo: "", yes: true, pollMs: 20, drainPollMs: 20, readyTimeoutMs: 1500,
      commands: { install: NODE_OK, build: BUILD_FAILS_ON_MARKER }, ...extra,
    }),
  };
  return f;
}
