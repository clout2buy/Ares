#!/usr/bin/env node
// coding-bench - real coding tasks in throwaway git repos, graded by oracles.
//
//   node scripts/elite/coding-bench.mjs                       # scripted (deterministic, CI-safe)
//   node scripts/elite/coding-bench.mjs --tasks js-bugfix-offbyone,ts-fix-type-error
//   node scripts/elite/coding-bench.mjs --repo /path/to/other/checkout   # bench a different build (before/after)
//   node scripts/elite/coding-bench.mjs --json out.json
//   ARES_ELITE_LIVE=1 node scripts/elite/coding-bench.mjs --provider live --budget 15 --live-provider openrouter
//
// What runs: the REAL QueryEngine loop with the REAL Read/Write/Edit/Grep/Glob/
// Bash (+Diff/Bisect where the build has them) tools against a fresh git repo
// per task. The model is either
//   scripted - a deterministic stand-in per task (see coding-bench-tasks.mjs):
//              it carries the realistic slips the harness must absorb. A
//              scripted pass proves the HARNESS carries the task to a verified
//              finish; it does NOT measure model skill.
//   live     - a real provider, OFF by default. Needs ARES_ELITE_LIVE=1 AND an
//              explicit --budget N (a hard cap on model calls across the whole
//              run; the run stops the moment it is spent). No budget, no run.
//
// Per task it records: success (oracle: tests/build pass, diff in scope, diff
// under the cap - never the agent's claim), turns, tool calls, tool errors,
// retries (an error followed by the same tool again), wall time, diff size,
// and tool-result bytes (the context the tools cost the model).
//
// No secrets are read or printed. Temp repos live under the OS temp dir and are
// deleted on exit (--keep to inspect).

import { spawn } from "node:child_process";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TASKS } from "./coding-bench-tasks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- args

export { TASKS };

export function parseArgs(argv) {
  const a = { provider: "scripted", budget: 0, tasks: null, repo: path.resolve(HERE, "..", ".."), json: null, keep: false, liveProvider: "openrouter", label: "", maxTurns: 40 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--provider") a.provider = next();
    else if (k === "--budget") a.budget = Number(next());
    else if (k === "--tasks") a.tasks = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--repo") a.repo = path.resolve(next());
    else if (k === "--json") a.json = next();
    else if (k === "--keep") a.keep = true;
    else if (k === "--verbose") a.verbose = true;
    else if (k === "--live-provider") a.liveProvider = next();
    else if (k === "--label") a.label = next();
    else if (k === "--max-turns") a.maxTurns = Number(next());
    else if (k === "-h" || k === "--help") a.help = true;
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

const USAGE = `Usage: node scripts/elite/coding-bench.mjs [--provider scripted|live] [--budget N] [--tasks a,b] [--repo DIR] [--json FILE] [--keep] [--label TEXT]
  live mode is OFF unless ARES_ELITE_LIVE=1 and --budget N (hard cap on model calls) are both given.`;

// ---------------------------------------------------------------- shell helpers

function sh(cwd, command, { bash = false, timeoutMs = 120_000, env } = {}) {
  return new Promise((resolve) => {
    const child = bash
      ? spawn("bash", ["-lc", command], { cwd, windowsHide: true, env: { ...process.env, ...env } })
      : spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, ...env } });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (c) => (out += c));
    child.stderr?.on("data", (c) => (out += c));
    child.on("error", () => { clearTimeout(timer); resolve({ code: 127, out }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

async function git(cwd, args, { allowFail = false } = {}) {
  const r = await sh(cwd, `git ${args}`);
  if (r.code !== 0 && !allowFail) throw new Error(`git ${args} failed: ${r.out.slice(0, 300)}`);
  return r;
}

async function detectPython() {
  for (const cmd of ["python3", "python"]) {
    const r = await sh(process.cwd(), `${cmd} -c "import sys;print(sys.version_info[0])"`);
    if (r.code === 0 && r.out.trim().startsWith("3")) return cmd;
  }
  return null;
}

function findTsc(repo) {
  try {
    const req = createRequire(path.join(repo, "package.json"));
    return path.join(path.dirname(req.resolve("typescript/package.json")), "bin", "tsc");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- fixtures

async function materialize(task, h) {
  const ws = await fs.mkdtemp(path.join(h.tmpRoot, `${task.id}-`));
  const files = { ".gitignore": ".ares/\nnode_modules/\n", ...task.files };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
  await git(ws, "init -q -b main");
  await git(ws, 'config user.email "bench@ares.local"');
  await git(ws, 'config user.name "Ares Bench"');
  await git(ws, "config core.autocrlf false");
  await git(ws, "add -A");
  await git(ws, 'commit -q -m "baseline"');
  if (task.setup) await task.setup(ws, h);
  return ws;
}

async function diffStats(ws, allowed) {
  const tracked = await git(ws, "diff --numstat HEAD", { allowFail: true });
  const untracked = await git(ws, "ls-files --others --exclude-standard", { allowFail: true });
  let lines = 0;
  const files = [];
  for (const l of tracked.out.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
    if (!m) continue;
    lines += (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
    files.push(m[3]);
  }
  for (const f of untracked.out.split(/\r?\n/).filter(Boolean)) {
    files.push(f);
    const text = await fs.readFile(path.join(ws, f), "utf8").catch(() => "");
    lines += text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  }
  const inScope = (f) => (allowed ?? []).some((p) => f === p || f.startsWith(p));
  return { lines, files, outOfScope: allowed ? files.filter((f) => !inScope(f.replace(/\\/g, "/"))) : [] };
}

// ---------------------------------------------------------------- scripted provider

function toolResultsOf(messages) {
  const last = [...messages].reverse().find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
  if (!last) return [];
  return last.content
    .filter((b) => b.type === "tool_result")
    .map((b) => ({
      isError: b.is_error === true,
      text: typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n"),
    }));
}

function makeScriptedProvider(task, h, counters) {
  let gen = null;
  let n = 0;
  const base = (id, blocks, stopReason) => ({
    type: "message_done",
    message: { id, role: "assistant", content: blocks, createdAt: new Date().toISOString() },
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason,
  });
  return {
    name: "scripted-bench",
    async *stream(req) {
      counters.modelCalls++;
      const results = toolResultsOf(req.messages);
      let step;
      if (!gen) {
        gen = task.script(h);
        step = await gen.next();
      } else {
        step = await gen.next(results[0] ?? { isError: false, text: "" });
      }
      // A generator `return {text}` and a final `yield {text}` both end the run.
      const value = step.value;
      if (!value || value.text !== undefined || step.done) {
        const text = value?.text ?? "Done.";
        counters.finalText = text;
        yield { type: "text_delta", text };
        yield base(`m_${++n}`, [{ type: "text", text }], "end_turn");
        return;
      }
      const id = `tu_${++n}`;
      yield { type: "tool_use_start", id, name: value.name };
      yield { type: "tool_use_input_done", id, input: value.input };
      yield base(`m_${n}`, [{ type: "tool_use", id, name: value.name, input: value.input }], "tool_use");
    },
  };
}

// ---------------------------------------------------------------- live provider (opt-in, hard-capped)

export class BudgetExceeded extends Error {
  constructor(budget) {
    super(`live model-call budget of ${budget} is spent`);
    this.name = "BudgetExceeded";
  }
}

/** Wrap any provider so that stream() calls beyond `budget` throw. Shared across tasks. */
export function withCallBudget(provider, budget, shared) {
  return {
    ...provider,
    name: provider.name,
    async *stream(req, ...rest) {
      if (shared.calls >= budget) throw new BudgetExceeded(budget);
      shared.calls++;
      yield* provider.stream(req, ...rest);
    },
  };
}

async function resolveLiveProvider(repo, name) {
  const core = await import(pathToFileURL(path.join(repo, "packages", "core", "dist", "index.js")).href);
  const env = process.env;
  if (name === "anthropic" && env.ANTHROPIC_API_KEY) return { provider: new core.AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }), model: env.ARES_EVAL_MODEL || core.DEFAULT_ANTHROPIC_MODEL };
  if (name === "openai" && env.OPENAI_API_KEY) return { provider: new core.OpenAIResponsesProvider({ apiKey: env.OPENAI_API_KEY }), model: env.ARES_EVAL_MODEL || "gpt-4.1" };
  if (name === "openrouter" && env.OPENROUTER_API_KEY) {
    const model = env.ARES_EVAL_MODEL || "anthropic/claude-sonnet-4.5";
    return { provider: new core.OpenRouterProvider({ apiKey: env.OPENROUTER_API_KEY, model }), model };
  }
  throw new Error(`live provider '${name}' needs its API key in the environment (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY); keys are never printed`);
}

// ---------------------------------------------------------------- one task

async function runTask(task, ctx) {
  const { tools, QueryEngine, adaptToolForEngine, args, h } = ctx;
  const started = Date.now();
  const row = { id: task.id, category: task.category, success: false, detail: "", turns: 0, toolCalls: 0, toolErrors: 0, shellFails: 0, retries: 0, wallMs: 0, diffLines: 0, resultBytes: 0, outOfScope: [], modelCalls: 0 };

  if (task.needs === "tsc" && !h.tsc) return { ...row, skipped: true, detail: "typescript not installed in the bench repo" };
  if (task.needs === "bash" && process.platform === "win32") return { ...row, skipped: true, detail: "needs a POSIX shell" };
  if (!h.python && /py-/.test(task.id)) return { ...row, skipped: true, detail: "python3 not found" };

  const ws = await materialize(task, h);
  const counters = { modelCalls: 0, finalText: "" };
  const stamps = new Map();
  const enrich = (base) => ({ ...base, workspace: ws, sessionId: `bench_${task.id}`, signal: base.signal ?? new AbortController().signal, permissionMode: "workspace-write", fileReadStamps: stamps });
  const engineTools = tools.map((t) => adaptToolForEngine(t, enrich));

  let provider;
  let model = "scripted-bench";
  if (args.provider === "live") {
    if (ctx.shared.calls >= args.budget) return { ...row, skipped: true, detail: "live budget spent" };
    const live = await ctx.getLive();
    provider = withCallBudget(live.provider, args.budget, ctx.shared);
    model = live.model;
  } else {
    provider = makeScriptedProvider(task, { ...h, tools: ctx.toolNames }, counters);
  }

  const system =
    args.provider === "live" && ctx.buildSystemPrompt
      ? ctx.buildSystemPrompt("workspace-write", undefined, { tools: ctx.toolNames })
      : "You are Ares, an expert coding agent. Work in the repository, make the smallest correct change, run the tests, and report honestly.";
  const engine = QueryEngine.forTesting({ provider, model, systemPrompt: system, tools: engineTools, workspace: ws, maxTurns: args.maxTurns }, `sess_bench_${task.id}`);
  engine.appendUserMessage(task.prompt);

  const names = new Map();
  let lastErrorTool = null;
  let finalText = "";
  let budgetStopped = false;
  try {
    for await (const ev of engine.streamTurn()) {
      if (ev.type === "tool_start") names.set(ev.id, ev.name);
      if (ev.type === "tool_end" || ev.type === "tool_error") {
        row.toolCalls++;
        const name = names.get(ev.id) ?? "?";
        const body = ev.type === "tool_end" ? JSON.stringify(ev.output ?? "") : String(ev.error ?? "") + (ev.output ? JSON.stringify(ev.output) : "");
        row.resultBytes += body.length;
        // A failing shell command (red test, failing build) is the workflow, not a
        // harness problem; every other tool error - and a shell call the harness
        // itself rejected (<tool_use_error>) - is a wasted round trip.
        const harnessError = ev.type === "tool_error" && (name !== "Bash" || /<tool_use_error>|Repository instructions/i.test(String(ev.error ?? "")));
        if (args.verbose) console.error(`  [${task.id}] ${ev.type} ${name}: ${body.slice(0, 200).replace(/\s+/g, " ")}`);
        if (ev.type === "tool_error" && !harnessError) row.shellFails++;
        if (harnessError && lastErrorTool === name) row.retries++;
        lastErrorTool = harnessError ? name : null;
        if (harnessError) row.toolErrors++;
      }
      if (ev.type === "text_delta") finalText += ev.text;
      if (ev.type === "error" && /budget/i.test(ev.error?.message ?? "")) budgetStopped = true;
    }
  } catch (e) {
    if (e instanceof BudgetExceeded || e?.name === "BudgetExceeded") budgetStopped = true;
    else row.detail = `engine error: ${String(e?.message ?? e).slice(0, 160)}`;
  }
  row.modelCalls = args.provider === "live" ? ctx.shared.calls : counters.modelCalls;
  row.turns = counters.modelCalls || Math.max(0, row.toolCalls + 1);
  if (budgetStopped) {
    row.detail = "stopped: live budget spent";
  }

  const stats = await diffStats(ws, task.allowed);
  row.diffLines = stats.lines;
  row.outOfScope = stats.outOfScope;

  // The oracle judges the workspace, never the agent's words.
  let verdict;
  try {
    verdict = await task.oracle(ws, h, counters.finalText || finalText);
  } catch (e) {
    verdict = { ok: false, detail: `oracle error: ${String(e?.message ?? e).slice(0, 120)}` };
  }
  const cap = task.maxDiffLines ?? Infinity;
  const problems = [];
  if (!verdict.ok) problems.push(verdict.detail);
  if (row.outOfScope.length) problems.push(`out-of-scope diff: ${row.outOfScope.slice(0, 3).join(", ")}`);
  if (row.diffLines > cap) problems.push(`diff too large (${row.diffLines} > ${cap} lines)`);
  row.success = problems.length === 0;
  row.detail = row.success ? verdict.detail : [row.detail, ...problems].filter(Boolean).join("; ");
  row.wallMs = Date.now() - started;
  if (!args.keep) await fs.rm(ws, { recursive: true, force: true }).catch(() => undefined);
  else row.workspace = ws;
  return row;
}

// ---------------------------------------------------------------- driver

export async function runBench(args, overrides = {}) {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "ares-bench-home-"));
  const tmpDev = mkdtempSync(path.join(os.tmpdir(), "ares-bench-dev-"));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "ares-bench-"));
  const prevHome = process.env.ARES_HOME;
  const prevDev = process.env.ARES_DEVICES_HOME;
  process.env.ARES_HOME = tmpHome;
  process.env.ARES_DEVICES_HOME = tmpDev;
  // When the bench itself runs under `node --test`, children inherit
  // NODE_TEST_CONTEXT and a nested `node --test` silently reports success
  // without running anything - that would turn every oracle into a rubber stamp.
  const prevCtx = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const toolsMod = await import(pathToFileURL(path.join(args.repo, "packages", "tools", "dist", "index.js")).href);
    const coreMod = await import(pathToFileURL(path.join(args.repo, "packages", "core", "dist", "index.js")).href);
    const candidates = ["ReadTool", "WriteTool", "EditTool", "GrepTool", "GlobTool", "BashTool", "DiffTool", "BisectTool"];
    const tools = candidates.map((n) => toolsMod[n]).filter(Boolean);
    const toolNames = new Set(tools.map((t) => t.schema.name));
    let buildSystemPrompt;
    if (args.provider === "live" && !overrides.live) {
      const tp = await import(pathToFileURL(path.join(args.repo, "packages", "cli", "dist", "entry", "turnPipeline.js")).href);
      buildSystemPrompt = tp.buildSystemPrompt;
    }
    const h = {
      tmpRoot,
      sh,
      git,
      python: (await detectPython()) ?? "python3",
      tsc: findTsc(args.repo),
      read: (ws, rel) => fs.readFile(path.join(ws, rel), "utf8"),
      write: async (ws, rel, text) => {
        await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
        await fs.writeFile(path.join(ws, rel), text, "utf8");
      },
    };
    if (!(await detectPython())) h.python = null;
    const shared = { calls: 0 };
    let live;
    const ctx = {
      tools,
      toolNames,
      QueryEngine: coreMod.QueryEngine,
      adaptToolForEngine: toolsMod.adaptToolForEngine,
      args,
      h,
      shared,
      buildSystemPrompt,
      getLive: async () => (live ??= overrides.live ?? (await resolveLiveProvider(args.repo, args.liveProvider))),
    };
    const pool = overrides.tasks ?? TASKS;
    const selected = args.tasks ? pool.filter((t) => args.tasks.includes(t.id)) : pool;
    const rows = [];
    for (const task of selected) rows.push(await runTask(task, ctx));
    return summarize(rows, args, [...toolNames], shared.calls);
  } finally {
    if (prevCtx !== undefined) process.env.NODE_TEST_CONTEXT = prevCtx;
    if (prevHome === undefined) delete process.env.ARES_HOME;
    else process.env.ARES_HOME = prevHome;
    if (prevDev === undefined) delete process.env.ARES_DEVICES_HOME;
    else process.env.ARES_DEVICES_HOME = prevDev;
    for (const d of [tmpHome, tmpDev, ...(args.keep ? [] : [tmpRoot])]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function summarize(rows, args, toolNames, liveCalls) {
  const ran = rows.filter((r) => !r.skipped);
  const sum = (k) => ran.reduce((a, r) => a + (r[k] ?? 0), 0);
  return {
    schemaVersion: 1,
    label: args.label,
    provider: args.provider,
    repo: args.repo,
    tools: toolNames.sort(),
    tasks: rows,
    totals: {
      ran: ran.length,
      skipped: rows.length - ran.length,
      passed: ran.filter((r) => r.success).length,
      successRate: ran.length ? ran.filter((r) => r.success).length / ran.length : 0,
      turns: sum("turns"),
      toolCalls: sum("toolCalls"),
      toolErrors: sum("toolErrors"),
      shellFails: sum("shellFails"),
      retries: sum("retries"),
      resultBytes: sum("resultBytes"),
      diffLines: sum("diffLines"),
      wallMs: sum("wallMs"),
      liveModelCalls: liveCalls,
    },
  };
}

export function renderTable(report) {
  const pad = (s, n) => String(s).padEnd(n);
  const lines = [`coding-bench  provider=${report.provider}${report.label ? `  label=${report.label}` : ""}  tools=${report.tools.join(",")}`, ""];
  lines.push(pad("task", 34) + pad("ok", 5) + pad("turns", 7) + pad("calls", 7) + pad("errs", 6) + pad("red", 5) + pad("retry", 7) + pad("diff", 6) + pad("bytes", 8) + pad("ms", 7) + "detail");
  for (const r of report.tasks) {
    lines.push(
      pad(r.id, 34) + pad(r.skipped ? "skip" : r.success ? "PASS" : "FAIL", 5) + pad(r.turns, 7) + pad(r.toolCalls, 7) + pad(r.toolErrors, 6) + pad(r.shellFails, 5) + pad(r.retries, 7) + pad(r.diffLines, 6) + pad(r.resultBytes, 8) + pad(r.wallMs, 7) + (r.success ? "" : r.detail),
    );
  }
  const t = report.totals;
  lines.push("", `passed ${t.passed}/${t.ran} (${(t.successRate * 100).toFixed(0)}%), skipped ${t.skipped}; turns ${t.turns}, tool calls ${t.toolCalls}, harness errors ${t.toolErrors}, red shell runs ${t.shellFails}, retries ${t.retries}, result bytes ${t.resultBytes}, diff lines ${t.diffLines}, wall ${(t.wallMs / 1000).toFixed(1)}s${report.provider === "live" ? `, live model calls ${t.liveModelCalls}` : ""}`);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.provider === "live") {
    if (process.env.ARES_ELITE_LIVE !== "1" || !(args.budget >= 1)) {
      console.error("live mode is OFF by default. Set ARES_ELITE_LIVE=1 and pass --budget N (hard cap on model calls). Refusing to run.");
      return 2;
    }
    if (args.budget > 200) {
      console.error("--budget above 200 model calls is refused; split the run.");
      return 2;
    }
  } else if (args.provider !== "scripted") {
    console.error(`unknown provider '${args.provider}' (scripted | live)`);
    return 2;
  }
  const report = await runBench(args);
  console.log(renderTable(report));
  if (args.json) await fs.writeFile(args.json, JSON.stringify(report, null, 2), "utf8");
  return report.totals.passed === report.totals.ran ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => { console.error(err?.stack ?? err); process.exit(3); });
}
