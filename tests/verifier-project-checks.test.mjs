// Verifier strength from cartography, not regex.
//
//   - resolveProjectChecks(workspace) derives {test, build, lint, typecheck}
//     from package.json scripts, Cargo.toml, pyproject/pytest.ini/setup.cfg,
//     go.mod, and Makefile targets.
//   - verificationStrength() treats a derived test command as behavioral no
//     matter how its label is spelled (the regex stays as fallback).
//   - The `no_checks` hatch is partially closed: a model-chosen manual command
//     only counts as behavioral proof when it plausibly exercised a changed
//     file's module (whole suite, or references the file / its dir / its
//     package / a test root); otherwise it is static and the gate says why.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  QueryEngine,
  manualVerificationScoped,
  resetProjectChecksCache,
  resolveProjectChecks,
  verificationStrength,
} from "../packages/core/dist/index.js";

async function workspace(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), "ares-project-checks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body, "utf8");
  }
  resetProjectChecksCache();
  return root;
}

const cmd = (c) => c?.command;

test("npm workspace: test/test:*/build/lint/typecheck from package.json scripts (pnpm when locked)", async (t) => {
  const root = await workspace(t, {
    "package.json": JSON.stringify({
      name: "@acme/app",
      scripts: { test: "vitest run", "test:unit": "vitest run unit", build: "tsc -b", lint: "eslint .", typecheck: "tsc --noEmit" },
    }),
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    "tests/app.test.mjs": "// t\n",
    "src/app.ts": "export const a = 1;\n",
  });
  const checks = await resolveProjectChecks(root);
  assert.equal(cmd(checks.test), "pnpm test");
  assert.deepEqual(checks.tests.map(cmd), ["pnpm test", "pnpm run test:unit"]);
  assert.equal(cmd(checks.build), "pnpm run build");
  assert.equal(cmd(checks.lint), "pnpm run lint");
  assert.equal(cmd(checks.typecheck), "pnpm run typecheck");
  assert.ok(checks.packageNames.includes("@acme/app"));
  assert.ok(checks.testRoots.includes("tests"), `test roots: ${checks.testRoots}`);
});

test("npm workspace: `check` fills typecheck, placeholder test script is ignored, npm without a pnpm lock", async (t) => {
  const root = await workspace(t, {
    "package.json": JSON.stringify({ name: "plain", scripts: { test: 'echo "Error: no test specified" && exit 1', check: "tsc -p ." } }),
  });
  const checks = await resolveProjectChecks(root);
  assert.equal(checks.test, undefined);
  assert.equal(cmd(checks.typecheck), "npm run check");
});

test("cargo workspace: cargo test/build/check + crate name", async (t) => {
  const root = await workspace(t, {
    "Cargo.toml": '[package]\nname = "mycrate"\nversion = "0.1.0"\n',
    "src/lib.rs": "pub fn f() {}\n",
  });
  const checks = await resolveProjectChecks(root);
  assert.equal(cmd(checks.test), "cargo test");
  assert.equal(cmd(checks.build), "cargo build");
  assert.equal(cmd(checks.typecheck), "cargo check");
  assert.ok(checks.packageNames.includes("mycrate"));
});

test("python workspace: pyproject / pytest.ini / setup.cfg [tool:pytest] all mean `pytest`", async (t) => {
  const a = await workspace(t, { "pyproject.toml": '[project]\nname = "mypkg"\n', "tests/test_x.py": "def test_x(): pass\n" });
  const ca = await resolveProjectChecks(a);
  assert.equal(cmd(ca.test), "pytest");
  assert.ok(ca.packageNames.includes("mypkg"));
  assert.ok(ca.testRoots.includes("tests"));
  const b = await workspace(t, { "pytest.ini": "[pytest]\n" });
  assert.equal(cmd((await resolveProjectChecks(b)).test), "pytest");
  const c = await workspace(t, { "setup.cfg": "[tool:pytest]\ntestpaths = tests\n" });
  assert.equal(cmd((await resolveProjectChecks(c)).test), "pytest");
  const d = await workspace(t, { "setup.cfg": "[metadata]\nname = x\n" });
  assert.equal((await resolveProjectChecks(d)).test, undefined, "setup.cfg without a pytest section is not a test surface");
});

test("go workspace: go test ./... + module names", async (t) => {
  const root = await workspace(t, { "go.mod": "module github.com/acme/mymod\n\ngo 1.22\n", "main.go": "package main\n" });
  const checks = await resolveProjectChecks(root);
  assert.equal(cmd(checks.test), "go test ./...");
  assert.equal(cmd(checks.build), "go build ./...");
  assert.equal(cmd(checks.typecheck), "go vet ./...");
  assert.ok(checks.packageNames.includes("mymod"));
  assert.ok(checks.packageNames.includes("github.com/acme/mymod"));
});

test("Makefile: conventional targets only", async (t) => {
  const root = await workspace(t, { Makefile: "CC := gcc\n\nall: build\n\nbuild:\n\t$(CC) main.c\n\ntest: build\n\t./run-tests.sh\n\nclean:\n\trm -f a.out\n" });
  const checks = await resolveProjectChecks(root);
  assert.equal(cmd(checks.test), "make test");
  assert.equal(cmd(checks.build), "make build");
  assert.equal(checks.lint, undefined);
});

test("polyglot: every ecosystem's test command is collected; the first wins the `test` slot", async (t) => {
  const root = await workspace(t, {
    "package.json": JSON.stringify({ name: "poly", scripts: { test: "node --test" } }),
    "Cargo.toml": '[package]\nname = "polycrate"\n',
    "go.mod": "module poly\n",
  });
  const checks = await resolveProjectChecks(root);
  assert.equal(cmd(checks.test), "npm test");
  assert.deepEqual(checks.tests.map(cmd), ["npm test", "cargo test", "go test ./..."]);
});

test("verificationStrength: a derived test command is behavioral regardless of its label", async (t) => {
  const root = await workspace(t, {
    "package.json": JSON.stringify({ name: "x", scripts: { test: "./scripts/run-everything.sh" } }),
    "pnpm-lock.yaml": "",
    Makefile: "test:\n\t./t.sh\n",
  });
  const checks = await resolveProjectChecks(root);
  const custom = [{ program: "pnpm", args: ["test"], cwd: root, label: "custom-runner" }];
  assert.equal(verificationStrength(custom, checks), "behavioral");
  assert.equal(verificationStrength(custom, null), "static", "without cartography the label regex is the fallback");
  const make = [{ program: "make", args: ["test", "-j4"], cwd: root, label: "make" }];
  assert.equal(verificationStrength(make, checks), "behavioral", "extra flags on a derived command still match");
  const build = [{ program: "make", args: ["build"], cwd: root, label: "make" }];
  assert.equal(verificationStrength(build, checks), "static");
  // The regex fallback is intact for verifier-derived labels.
  assert.equal(verificationStrength([{ program: "node", args: ["--test", "a.mjs"], cwd: root, label: "tests(1)" }], null), "behavioral");
  assert.equal(verificationStrength([{ program: "node", args: ["--check", "a.mjs"], cwd: root, label: "node-check" }], null), "syntax");
});

test("manualVerificationScoped: whole suite, references, and the rejected static case", async (t) => {
  const root = await workspace(t, {
    "package.json": JSON.stringify({ name: "@acme/core", scripts: { test: "node --test" } }),
    "tests/feature.test.mjs": "",
    "src/feature.ts": "",
  });
  const checks = await resolveProjectChecks(root);
  const changed = [path.join(root, "src", "feature.ts")];
  const scoped = (c) => manualVerificationScoped(c, changed, root, checks);
  assert.equal(scoped("npm test"), true, "bare whole-suite invocation");
  assert.equal(scoped("cargo test"), true, "bare family even from another ecosystem");
  assert.equal(scoped("npm test -- --reporter=dot"), true, "derived test command plus flags");
  assert.equal(scoped("node --test tests/feature.test.mjs"), true, "references the file stem and a test root");
  assert.equal(scoped("vitest run src/feature.spec.ts"), true, "references the file's directory");
  assert.equal(scoped("pnpm --filter @acme/core test"), true, "references the package name");
  assert.equal(scoped("pytest -k feature"), true, "references the stem");
  assert.equal(scoped("node --test tests/other.test.mjs"), true, "any test root counts (heuristic, permissive by design)");
  assert.equal(scoped("npx tsc --noemit -p ."), false, "a typecheck referencing nothing changed is static");
  assert.equal(scoped("cargo test -p unrelated"), false, "a scoped run of a different package is not proof");
  assert.equal(manualVerificationScoped("npx tsc --noemit -p .", [], root, checks), false);
});

// ─── The gate: no_checks hatch rejected vs accepted ───────────────────────────

function scriptedProvider(scripts) {
  let call = 0;
  return {
    name: "scripted",
    async *stream() {
      const script = scripts[Math.min(call++, scripts.length - 1)];
      if (script.tool) {
        const id = `tu_${call}`;
        yield { type: "tool_use_start", id, name: script.tool.name };
        yield { type: "tool_use_input_done", id, input: script.tool.input };
        yield {
          type: "message_done",
          message: { id: `m_${call}`, role: "assistant", content: [{ type: "tool_use", id, name: script.tool.name, input: script.tool.input }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield { type: "text_delta", text: script.text };
      yield {
        type: "message_done",
        message: { id: `m_${call}`, role: "assistant", content: [{ type: "text", text: script.text }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function editTool(file) {
  return {
    schema: { name: "Edit", description: "edit", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call() { return { output: "edited", touchedFiles: [file] }; },
  };
}

function bashTool() {
  return {
    schema: { name: "Bash", description: "shell", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call(input) { return { output: { command: input.command, exitCode: 0, timedOut: false, stdout: "ok", stderr: "" } }; },
  };
}

async function runNoChecksScenario(root, command) {
  const noChecks = () => ({
    mutationGeneration: 1,
    passedCommands: 0,
    failedCommands: 0,
    skippedCommands: 0,
    latestRunGeneration: 1,
    latestRunStatus: "no_checks",
    latestLabels: [],
  });
  const engine = QueryEngine.forTesting({
    provider: scriptedProvider([
      { tool: { name: "Edit", input: { file_path: "src/feature.ts" } } },
      { tool: { name: "Bash", input: { command, description: "check" } } },
      { text: "done" },
      { text: "still done" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    tools: [editTool(path.join(root, "src", "feature.ts")), bashTool()],
    workspace: root,
    requireVerificationEvidence: true,
    verificationEvidence: noChecks,
  }, `sess_nochecks_${command.replace(/\W+/g, "_")}`);
  engine.appendUserMessage("change the feature");
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
}

test("no_checks hatch: a green typecheck that exercised nothing changed is REJECTED and the gate says why", async (t) => {
  const root = await workspace(t, {
    "package.json": JSON.stringify({ name: "@acme/core", scripts: { test: "node --test" } }),
    "tests/feature.test.mjs": "",
    "src/feature.ts": "",
  });
  const events = await runNoChecksScenario(root, "npx tsc --noEmit -p .");
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.workStatus, "unverified");
  assert.equal(end.status, "needs_verification");
  const nag = events.find((e) => e.type === "system_reminder_injected" && /did NOT count/.test(e.text));
  assert.ok(nag, "the proof gate explains why the manual run did not count");
  assert.match(nag.text, /npx tsc --noemit -p \./);
  assert.ok(end.unverified.checksRun.some((c) => /NOT counted/.test(c)), "the structured gap says why the run did not count");
});

test("no_checks hatch: a green run that names the changed module is ACCEPTED", async (t) => {
  const root = await workspace(t, {
    "package.json": JSON.stringify({ name: "@acme/core", scripts: { test: "node --test" } }),
    "tests/feature.test.mjs": "",
    "src/feature.ts": "",
  });
  const events = await runNoChecksScenario(root, "node --test tests/feature.test.mjs");
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.workStatus, "verified");
  assert.equal(end.status, "completed");
});
