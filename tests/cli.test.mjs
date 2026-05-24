import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { TurnRecorder } from "../packages/core/dist/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

function runInteractive(lines) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CRIX_OPENAI_OAUTH_TOKEN;
    delete env.OPENAI_API_KEY;
    delete env.OLLAMA_API_KEY;
    env.CRIX_DISABLE_BROWSER_OPEN = "1";
    const child = spawn(process.execPath, ["packages/cli/dist/index.js", "cli"], {
      cwd: repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    child.stderr.on("data", (data) => {
      output += data.toString();
    });
    child.on("error", reject);

    const timers = lines.map((line, index) =>
      setTimeout(() => {
        child.stdin.write(`${line}\n`);
      }, 40 + index * 80),
    );
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`interactive CLI timed out\n${output}`));
    }, 5_000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      for (const timer of timers) clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

test("interactive CLI treats casual text as chat and accepts crix-prefixed commands", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-no-auth-"));
  const { code, output } = await runInteractive(["hi", "crix help", "make yourself better", "crix exit"]);

  assert.equal(code, 0, output);
  assert.match(output, /mode\s+natural language, tool-first, evidence guarded/);
  assert.match(output, /input\s+type the task normally; say provider\/model\/status only when needed/);
  assert.doesNotMatch(output, /controls\s+\/model/);
  assert.match(output, /Crix is idle and ready for a natural request\./);
  assert.match(output, /Crix TypeScript agent harness/);
  assert.match(output, /\btool\s+list_dir/);
  assert.doesNotMatch(output, /unknown command/i);
});

test("interactive CLI supports natural provider, model, agents, and status controls", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-live-"));
  const { code, output } = await runInteractive([
    "provider openai",
    "model 2",
    "agents",
    "status",
    "exit",
  ]);

  assert.equal(code, 0, output);
  assert.match(output, /provider: OpenAI/);
  assert.match(output, /model: gpt-5\.4/);
  assert.match(output, /crix openai:gpt-5\.4 >/);
  assert.match(output, /architect: Architect/);
  assert.match(output, /active: openai:gpt-5\.4/);
  assert.doesNotMatch(output, /unknown command/i);
});

test("interactive CLI executes live tool and subagent runs instead of narrating them", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-demo-"));
  const { code, output } = await runInteractive([
    "inspect the tool runtime",
    "inspect agent orchestration",
    "agent researcher inspect current harness",
    "exit",
  ]);

  assert.equal(code, 0, output);
  assert.match(output, /Workspace tool audit/);
  assert.match(output, /\+-- tool list_dir/);
  assert.match(output, /\| state\s+running/);
  assert.match(output, /\| status\s+ok \d+ms/);
  assert.match(output, /\| result\s+\d+ entries/);
  assert.match(output, /\+-- tool read_file/);
  assert.match(output, /\+-- tool glob/);
  assert.match(output, /\+-- tool grep_search/);
  assert.match(output, /\+-- tool skill_list/);
  assert.match(output, /\+-- tool proof_report/);
  assert.match(output, /Workspace tool audit - \d+ real calls/);
  assert.match(output, /Evidence - \d+ calls:/);
  assert.match(output, /tool audit complete: \d+\/\d+ passed/);
  assert.doesNotMatch(output, /tool demo/i);
  assert.doesNotMatch(output, /fatal: not a git repository/);
  assert.match(output, /Agent orchestration/);
  assert.match(output, /\+-- agent spawn_agent:researcher/);
  assert.match(output, /\+-- agent spawn_agent:reviewer/);
  assert.match(output, /agent orchestration complete: 2\/2 passed/);
  assert.doesNotMatch(output, /Calling: `list_dir`/);
  assert.doesNotMatch(output, /unknown command/i);
});

test("interactive CLI does not rerun tools for meta questions about prior tool output", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-meta-"));
  const { code, output } = await runInteractive([
    "dont do any work, just figure out. when i said flex tools were they real or fake because it was instance response",
    "exit",
  ]);

  assert.equal(code, 0, output);
  assert.doesNotMatch(output, /Workspace tool audit|Harness tool audit/);
  assert.doesNotMatch(output, /\+-- tool list_dir/);
});

test("interactive CLI keeps greetings and behavior complaints out of repo scans", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-conversation-only-"));
  const { code, output } = await runInteractive([
    "provider openai",
    "hey",
    "man tf",
    "i never asked u to do that",
    "is it something in ur coding that makes u do that? its honestly something im trying to trouble shoot",
    "exit",
  ]);

  assert.equal(code, 0, output);
  assert.match(output, /Crix is idle and ready for a natural request\./);
  assert.match(output, /No local tools or repo scan ran\./);
  assert.doesNotMatch(output, /Repo scout|Repo deep scan/);
  assert.doesNotMatch(output, /\+-- tool list_dir/);
  assert.doesNotMatch(output, /turn saved/);
  assert.doesNotMatch(output, /OpenAI chat failed/);
  assert.doesNotMatch(output, /I inspected .* with 0 real tool calls/);
});

test("interactive CLI flexes tools with real write/read/verify calls", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-flex-real-"));
  const { code, output } = await runInteractive([
    "flex some tools",
    "exit",
  ]);

  assert.equal(code, 0, output);
  assert.match(output, /Tool flex/);
  assert.match(output, /\+-- tool write_file/);
  assert.match(output, /\+-- tool read_file/);
  assert.match(output, /\+-- tool run_verification/);
  assert.match(output, /node --check/);
  assert.match(output, /tool audit complete: \d+\/\d+ passed/);
});

test("interactive CLI refuses canned HTML scaffolds when provider/tool execution fails", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-html-"));
  const { code, output } = await runInteractive([
    "ok make me an html then open it",
    "exit",
  ]);

  assert.equal(code, 0, output);
  assert.match(output, /Goal run/);
  assert.match(output, /provider\s+unavailable|goal run failed:/);
  assert.match(output, /No canned scaffold fallback was used|fallback\s+disabled/);
  assert.doesNotMatch(output, /Task: local app scaffold/);
  assert.doesNotMatch(output, /\+-- tool write_file/);
  assert.doesNotMatch(output, /\.crix[\\/]artifacts[\\/]tui[\\/]generated-app[\\/]index\.html/);
  assert.doesNotMatch(output, /I\u2019ll create|I'll create|I need to quickly inspect/);
  assert.doesNotMatch(output, /unknown command/i);
});

test("interactive CLI does not generate a hardcoded game fallback", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-game-html-"));
  const { code, output } = await runInteractive([
    "provider openai",
    "make game html then open it",
    "exit",
  ]);

  assert.equal(code, 0, output);
  assert.match(output, /Goal run/);
  assert.match(output, /No canned scaffold fallback was used|fallback\s+disabled/);
  assert.doesNotMatch(output, /Task: local app scaffold/);
  assert.doesNotMatch(output, /Neon Drift/);
});

test("interactive CLI does not create canned static apps in explicit target paths", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-target-home-"));
  const target = path.join(await mkdtemp(path.join(os.tmpdir(), "crix-cli-target-parent-")), "nuts");
  const { code, output } = await runInteractive([
    `make me a simple notes app at ${target} and open it when done`,
    "exit",
  ]);

  assert.equal(code, 0, output);
  assert.match(output, /Goal run/);
  assert.match(output, new RegExp(target.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  assert.match(output, /No canned scaffold fallback was used|fallback\s+disabled/);
  assert.equal(existsSync(path.join(target, "index.html")), false);
  assert.doesNotMatch(output, /Task: local app scaffold/);
  assert.doesNotMatch(output, /Nuts Notes/);
  assert.doesNotMatch(output, /Say `inspect` or `learn it`/);
});

test("interactive CLI scouts a provided repo path read-only instead of claiming no filesystem access", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-scout-home-"));
  const target = await mkdtemp(path.join(os.tmpdir(), "crix-cli-scout-repo-"));
  await mkdir(path.join(target, "src"), { recursive: true });
  await writeFile(path.join(target, "package.json"), JSON.stringify({
    name: "sample-scout-repo",
    packageManager: "pnpm@10.33.0",
    scripts: { build: "tsc -b", test: "node --test" },
  }, null, 2));
  await writeFile(path.join(target, "README.md"), "# Sample Scout Repo\n");
  await writeFile(path.join(target, "tsconfig.json"), "{}\n");
  await writeFile(path.join(target, "src", "index.ts"), "export function toolRuntime() { return 'agent provider model tui'; }\n");

  const { code, output } = await runInteractive([
    `ok heres a repo, learn it and lmk what u see. dont change anything ${target}`,
    "exit",
  ]);

  assert.equal(code, 0, output);
  assert.match(output, /Repo scout/);
  assert.match(output, /mode\s+read-only/);
  assert.match(output, /\+-- tool list_dir/);
  assert.match(output, /\+-- tool read_file/);
  assert.doesNotMatch(output, /\+-- tool codebase_retrieval/);
  assert.match(output, /package\s+sample-scout-repo via pnpm@10\.33\.0/);
  assert.match(output, /dirs\s+\d+ shallow inspected/);
  assert.match(output, /Pitch/);
  assert.match(output, /No files changed\./);
  assert.doesNotMatch(output, /don.t currently have filesystem\/tool access/i);
});

test("interactive CLI answers repo opinion prompts through agent-first tools", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-agent-first-home-"));
  const target = await mkdtemp(path.join(os.tmpdir(), "crix-cli-agent-first-repo-"));
  await writeFile(path.join(target, "package.json"), JSON.stringify({
    name: "agent-first-cli-repo",
    packageManager: "pnpm@10.33.0",
  }, null, 2));
  await writeFile(path.join(target, "README.md"), "# Agent First CLI Repo\n");

  const { code, output } = await runInteractive([
    `what u think about ${target} ?`,
    "exit",
  ]);

  assert.equal(code, 0, output);
  assert.match(output, /\btool\s+list_dir/);
  assert.match(output, /\btool\s+read_file/);
  assert.match(output, /agent-first-cli-repo|Agent First CLI Repo/);
  assert.doesNotMatch(output, /no automatic opinion|with your permission/i);

  const shown = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "sessions", "agent", "latest", "--workspace", target], {
    cwd: repoRoot,
  });
  assert.match(shown.stdout, /agent session: agent_session_/);
  assert.match(shown.stdout, /provider:/);
  assert.match(shown.stdout, /grants: \d+/);
  assert.match(shown.stdout, /messages: \d+/);
});

test("interactive CLI remembers a mentioned workspace and scouts it on inspect or learn it", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-session-workspace-home-"));
  const target = await mkdtemp(path.join(os.tmpdir(), "crix-cli-session-workspace-"));
  await writeFile(path.join(target, "package.json"), `\uFEFF${JSON.stringify({
    name: "session-workspace",
    scripts: { test: "node --test" },
  }, null, 2)}`);
  await writeFile(path.join(target, "README.md"), "# Session Workspace\n");

  const { code, output } = await runInteractive([
    `${target} is u!`,
    "inspect",
    "learn it",
    "exit",
  ]);

  assert.equal(code, 0, output);
  assert.match(output, new RegExp(`workspace: ${target.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
  assert.match(output, new RegExp(target.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  assert.match(output, /Repo scout/);
  assert.match(output, /package\s+session-workspace/);
  assert.match(output, /No files changed\./);
  assert.doesNotMatch(output, /don.t have repository tool access/i);
  assert.doesNotMatch(output, /send one of these/i);
});

test("interactive CLI deep scans the active workspace instead of falling back to chat", async () => {
  process.env.CRIX_HOME = await mkdtemp(path.join(os.tmpdir(), "crix-cli-deep-home-"));
  const target = await mkdtemp(path.join(os.tmpdir(), "crix-cli-deep-workspace-"));
  await mkdir(path.join(target, "packages", "core", "src"), { recursive: true });
  await writeFile(path.join(target, "package.json"), JSON.stringify({
    name: "deep-workspace",
    scripts: { check: "tsc -b" },
  }, null, 2));
  await writeFile(path.join(target, "README.md"), "# Deep Workspace\n");
  await writeFile(path.join(target, "packages", "core", "src", "index.ts"), "export function runToolCard() { throw new Error('placeholder'); }\n");

  const { code, output } = await runInteractive([
    `${target}`,
    "deep scan it",
    "exit",
  ]);

  assert.equal(code, 0, output);
  assert.match(output, /Repo deep scan/);
  assert.match(output, /\+-- tool file_outline/);
  assert.match(output, /\+-- tool grep_search/);
  assert.match(output, /outlines\s+\d+ files, \d+ symbols/);
  assert.match(output, /risks\s+\d+ marker hits/);
  assert.doesNotMatch(output, /What should I deep scan/i);
  assert.doesNotMatch(output, /I don.t currently have executable repo tools/i);
});

test("sessions command lists and shows recent run proof", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "crix-cli-sessions-workspace-"));
  const planPath = path.join(workspace, "plan.json");
  await writeFile(planPath, JSON.stringify({
    goal: "cli session visibility",
    summary: "write session marker",
    steps: [{ id: "write", title: "write marker", safety: "workspace-write", type: "write_file", path: "marker.txt", content: "ok\n" }],
    verification: []
  }), "utf8");

  await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "run", "--workspace", workspace, "--plan", planPath], {
    cwd: repoRoot,
  });
  const list = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "sessions", "--workspace", workspace], {
    cwd: repoRoot,
  });
  const show = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "sessions", "show", "latest", "--workspace", workspace], {
    cwd: repoRoot,
  });
  const compact = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "sessions", "compact", "latest", "--workspace", workspace], {
    cwd: repoRoot,
  });
  const history = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "sessions", "history", "latest", "--workspace", workspace], {
    cwd: repoRoot,
  });
  const resume = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "sessions", "resume", "latest", "--workspace", workspace], {
    cwd: repoRoot,
  });
  const fork = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "sessions", "fork", "latest", "--workspace", workspace], {
    cwd: repoRoot,
  });

  assert.match(list.stdout, /sessions: 1/);
  assert.match(list.stdout, /cli session visibility/);
  assert.match(list.stdout, /\[passed\]/);
  assert.match(show.stdout, /session: session_/);
  assert.match(show.stdout, /status: passed/);
  assert.match(show.stdout, /proof: .*proof\.json/);
  assert.match(show.stdout, /turn: turn_/);
  assert.match(show.stdout, /turn artifact: .*\.crix.*artifacts.*turns.*\.json/);
  assert.match(show.stdout, /session_started/);
  assert.match(compact.stdout, /compact: .*compact\.json/);
  assert.match(compact.stdout, /turn: turn_/);
  assert.match(compact.stdout, /turns: 1/);
  assert.match(compact.stdout, /messages: \d+/);
  assert.match(history.stdout, /rehydrated turns: 1/);
  assert.match(history.stdout, /rehydrated messages: \d+/);
  assert.match(history.stdout, /last timeline:/);
  assert.match(resume.stdout, /resumed: session_/);
  assert.match(resume.stdout, /rehydrated messages: \d+/);
  assert.match(fork.stdout, /forked: session_.* -> session_/);
});

test("turns command lists and shows structured turn artifacts", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "crix-cli-turns-workspace-"));
  const turn = new TurnRecorder({ metadata: { source: "cli-test" } });
  const item = turn.startItem({ kind: "agent_call", title: "spawn_agent:reviewer", input: { agent: "reviewer" } });
  turn.completeItem(item.id, { summary: "review complete", output: "ok" });
  await turn.writeArtifact(workspace);

  const list = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "turns", "--workspace", workspace], {
    cwd: repoRoot,
  });
  const show = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "turns", "show", "latest", "--workspace", workspace], {
    cwd: repoRoot,
  });

  assert.match(list.stdout, /turns: 1/);
  assert.match(list.stdout, /source: cli-test/);
  assert.match(show.stdout, /turn: turn_/);
  assert.match(show.stdout, /agent_call completed: spawn_agent:reviewer/);
  assert.match(show.stdout, /review complete/);
});

test("login does not re-run device auth when OpenAI auth is already configured", async () => {
  const env = {
    ...process.env,
    CRIX_HOME: await mkdtemp(path.join(os.tmpdir(), "crix-cli-auth-")),
    CRIX_OPENAI_OAUTH_TOKEN: "existing-token",
  };
  delete env.OPENAI_API_KEY;

  const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "login"], {
    cwd: repoRoot,
    env,
  });

  assert.match(result.stdout, /openai-auth: already configured/);
  assert.match(result.stdout, /Use `login --force`/);
  assert.doesNotMatch(result.stdout, /Enter this one-time code/);
});

test("ollama login is a no-op because Crix uses local Ollama", async () => {
  const env = {
    ...process.env,
    CRIX_HOME: await mkdtemp(path.join(os.tmpdir(), "crix-cli-ollama-")),
  };
  delete env.OLLAMA_API_KEY;

  const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "ollama", "login"], {
    cwd: repoRoot,
    env,
  });

  assert.match(result.stdout, /no Crix login is needed/);
  assert.match(result.stdout, /local Ollama/);
  assert.doesNotMatch(result.stdout, /Paste Ollama API key/);
});

test("ollama models shows local-first suggestions without a login prompt", async () => {
  const env = {
    ...process.env,
    CRIX_HOME: await mkdtemp(path.join(os.tmpdir(), "crix-cli-ollama-models-")),
  };
  delete env.OLLAMA_API_KEY;

  const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "ollama", "models"], {
    cwd: repoRoot,
    env,
  });

  assert.match(result.stdout, /Ollama local-first model suggestions:/);
  assert.match(result.stdout, /qwen3-coder/);
  assert.match(result.stdout, /Installed local models come from: ollama list/);
  assert.doesNotMatch(result.stdout, /Paste Ollama API key/);
});
