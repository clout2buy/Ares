// coding-bench-tasks - the fixture repos, scripted agents and oracles for
// scripts/elite/coding-bench.mjs.
//
// Every task is a self-contained throwaway git repo (JS / Python / shell /
// TypeScript) with:
//   id, category   - what the task exercises
//   files          - the initial tree (committed as the baseline)
//   setup(ws, h)   - optional extra git state (branches, conflicts, history)
//   prompt         - what a live model is asked (used in --provider live)
//   script(h)      - the scripted agent: an async generator that yields tool
//                    calls ({name, input}) and receives each result as
//                    {isError, text}. It models a competent agent, seeded with
//                    the realistic slips the harness exists to absorb
//                    (drifted indentation, stale reads, syntax slips, ripgrep
//                    inline flags, first-touch repository rules).
//   oracle(ws, h)  - AUTOMATIC pass/fail: runs the project's tests / checks.
//                    Never reads the agent's claim.
//   allowed        - path prefixes the change may touch (anything else is an
//                    out-of-scope diff and fails the task)
//   maxDiffLines   - diff-size cap (added + removed) for a minimal change
//
// The scripted agents are deterministic stand-ins for model behaviour, so a
// scripted pass proves the HARNESS (tools, gates, loop) carries the task to a
// verified finish - it does not measure model skill. See docs/ELITE-CODING.md.

const OK_TEXT = (cmd) => `Done. Verified by running \`${cmd}\`: it passes.`;

/** node --test style oracle with N repetitions. */
const nodeTests = (reps = 1) => async (ws, h) => {
  for (let i = 0; i < reps; i++) {
    const r = await h.sh(ws, "node --test");
    if (r.code !== 0) return { ok: false, detail: `node --test failed (run ${i + 1}/${reps}): ${r.out.split("\n").filter((l) => /fail|not ok|Error/i.test(l)).slice(0, 2).join(" | ")}` };
  }
  return { ok: true, detail: reps > 1 ? `green x${reps}` : "tests green" };
};
const pyTests = async (ws, h) => {
  const r = await h.sh(ws, `${h.python} -m unittest discover -q`);
  return r.code === 0 ? { ok: true, detail: "unittest green" } : { ok: false, detail: `unittest failed: ${r.out.trim().split("\n").slice(-2).join(" | ")}` };
};

export const TASKS = [
  // 1 ------------------------------------------------------------------
  {
    id: "js-bugfix-offbyone",
    category: "bugfix",
    prompt: "range(1, 3) should return [1, 2, 3] but returns [1, 2]. Fix the bug; the tests in test/ show the contract. Run them before you finish.",
    files: {
      "package.json": '{ "name": "range-lib", "type": "module" }\n',
      "src/range.mjs": "export function range(start, end) {\n  const out = [];\n  for (let i = start; i < end; i++) {\n    out.push(i);\n  }\n  return out;\n}\n",
      "test/range.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { range } from "../src/range.mjs";\n\ntest("range is inclusive", () => {\n  assert.deepEqual(range(1, 3), [1, 2, 3]);\n  assert.deepEqual(range(2, 2), [2]);\n});\n',
    },
    allowed: ["src/range.mjs"],
    maxDiffLines: 6,
    async *script() {
      yield { name: "Bash", input: { command: "node --test", description: "baseline test run", timeout: 60000 } };
      yield { name: "Read", input: { file_path: "src/range.mjs" } };
      // Slip: the model copies the line with 4-space indentation (the file uses 2).
      yield { name: "Edit", input: { file_path: "src/range.mjs", old_string: "    for (let i = start; i < end; i++) {", new_string: "    for (let i = start; i <= end; i++) {" } };
      const r = yield { name: "Bash", input: { command: "node --test", description: "re-run tests", timeout: 60000 } };
      return { text: OK_TEXT("node --test") + (r.isError ? "" : "") };
    },
    oracle: nodeTests(),
  },
  // 2 ------------------------------------------------------------------
  {
    id: "py-bugfix-empty-average",
    category: "bugfix",
    prompt: "average([]) raises ZeroDivisionError; it should return 0.0. Fix it and run the unit tests.",
    files: {
      "calc.py": "def average(xs):\n    return sum(xs) / len(xs)\n\n\ndef total(xs):\n    return sum(xs)\n",
      "test_calc.py": "import unittest\nfrom calc import average, total\n\n\nclass CalcTests(unittest.TestCase):\n    def test_average(self):\n        self.assertEqual(average([2, 4]), 3)\n\n    def test_average_empty(self):\n        self.assertEqual(average([]), 0.0)\n\n    def test_total(self):\n        self.assertEqual(total([1, 2]), 3)\n\n\nif __name__ == '__main__':\n    unittest.main()\n",
    },
    allowed: ["calc.py"],
    maxDiffLines: 6,
    async *script(h) {
      yield { name: "Bash", input: { command: `${h.python} -m unittest discover -q`, description: "baseline", timeout: 60000 } };
      yield { name: "Read", input: { file_path: "calc.py" } };
      yield { name: "Edit", input: { file_path: "calc.py", old_string: "def average(xs):\n    return sum(xs) / len(xs)", new_string: "def average(xs):\n    if not xs:\n        return 0.0\n    return sum(xs) / len(xs)" } };
      yield { name: "Bash", input: { command: `${h.python} -m unittest discover -q`, description: "re-run", timeout: 60000 } };
      return { text: OK_TEXT("python -m unittest") };
    },
    oracle: pyTests,
  },
  // 3 ------------------------------------------------------------------
  {
    id: "js-feature-titlecase",
    category: "feature",
    prompt: "Spec (SPEC.md): add `titleCase(str)` to src/text.mjs - uppercase the first letter of every word, lowercase the rest. The tests are already written. Make them pass.",
    files: {
      "package.json": '{ "name": "text-lib", "type": "module" }\n',
      "SPEC.md": "# titleCase\n`titleCase('hello wORLD')` -> `'Hello World'`. Words are separated by single spaces. Empty string -> empty string.\n",
      "src/text.mjs": "export function trim(s) {\n  return s.trim();\n}\n\nexport function reverse(s) {\n  return [...s].reverse().join('');\n}\n",
      "test/text.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { titleCase, trim } from "../src/text.mjs";\n\ntest("titleCase", () => {\n  assert.equal(titleCase("hello wORLD"), "Hello World");\n  assert.equal(titleCase(""), "");\n});\n\ntest("trim still works", () => {\n  assert.equal(trim("  a "), "a");\n});\n',
    },
    allowed: ["src/text.mjs"],
    maxDiffLines: 12,
    async *script() {
      yield { name: "Read", input: { file_path: "SPEC.md" } };
      yield { name: "Read", input: { file_path: "src/text.mjs" } };
      yield { name: "Edit", input: { file_path: "src/text.mjs", old_string: "export function reverse(s) {", new_string: "export function titleCase(s) {\n  return s\n    .split(' ')\n    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))\n    .join(' ');\n}\n\nexport function reverse(s) {" } };
      yield { name: "Bash", input: { command: "node --test", description: "run tests", timeout: 60000 } };
      return { text: OK_TEXT("node --test") };
    },
    oracle: nodeTests(),
  },
  // 4 ------------------------------------------------------------------
  {
    id: "js-refactor-extract-fmt",
    category: "refactor",
    prompt: "src/report.mjs duplicates the money-formatting expression in two functions. Extract one `fmt` helper and use it in both. Behaviour must not change (tests are the safety net).",
    files: {
      "package.json": '{ "name": "report", "type": "module" }\n',
      "src/report.mjs": "export function line(name, cents) {\n  return `${name}: $${(cents / 100).toFixed(2)}`;\n}\n\nexport function summary(items) {\n  const sum = items.reduce((a, b) => a + b.cents, 0);\n  return `TOTAL: $${(sum / 100).toFixed(2)}`;\n}\n",
      "test/report.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { line, summary } from "../src/report.mjs";\n\ntest("line", () => assert.equal(line("a", 1250), "a: $12.50"));\ntest("summary", () => assert.equal(summary([{ cents: 100 }, { cents: 250 }]), "TOTAL: $3.50"));\n',
    },
    allowed: ["src/report.mjs"],
    maxDiffLines: 14,
    async *script() {
      yield { name: "Bash", input: { command: "node --test", description: "baseline", timeout: 60000 } };
      yield { name: "Read", input: { file_path: "src/report.mjs" } };
      yield {
        name: "Edit",
        input: {
          file_path: "src/report.mjs",
          edits: [
            { old_string: "export function line(name, cents) {\n  return `${name}: $${(cents / 100).toFixed(2)}`;", new_string: "const fmt = (cents) => `$${(cents / 100).toFixed(2)}`;\n\nexport function line(name, cents) {\n  return `${name}: ${fmt(cents)}`;" },
            { old_string: "return `TOTAL: $${(sum / 100).toFixed(2)}`;", new_string: "return `TOTAL: ${fmt(sum)}`;" },
          ],
        },
      };
      yield { name: "Bash", input: { command: "node --test", description: "tests after refactor", timeout: 60000 } };
      return { text: OK_TEXT("node --test") };
    },
    async oracle(ws, h) {
      const t = await nodeTests()(ws, h);
      if (!t.ok) return t;
      const src = await h.read(ws, "src/report.mjs");
      const n = (src.match(/toFixed\(2\)/g) ?? []).length;
      return n === 1 && /fmt/.test(src) ? { ok: true, detail: "helper extracted" } : { ok: false, detail: `expected one toFixed(2) and a fmt helper, found ${n}` };
    },
  },
  // 5 ------------------------------------------------------------------
  {
    id: "ts-fix-type-error",
    category: "build-fix",
    needs: "tsc",
    prompt: "`tsc --noEmit` fails. Fix the type error with the smallest change and make the build pass.",
    files: {
      "package.json": '{ "name": "ts-proj", "type": "module" }\n',
      "tsconfig.json": '{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ES2022", "moduleResolution": "bundler" }, "include": ["src"] }\n',
      "src/len.ts": "export function len(s: string): number {\n  return s.length;\n}\n",
      "src/main.ts": 'import { len } from "./len";\n\nconst n: string = len("hello");\nconsole.log(n);\n',
    },
    allowed: ["src/"],
    maxDiffLines: 4,
    async *script(h) {
      yield { name: "Bash", input: { command: `node "${h.tsc}" --noEmit -p .`, description: "typecheck", timeout: 120000 } };
      yield { name: "Read", input: { file_path: "src/main.ts" } };
      yield { name: "Edit", input: { file_path: "src/main.ts", old_string: 'const n: string = len("hello");', new_string: 'const n: number = len("hello");' } };
      yield { name: "Bash", input: { command: `node "${h.tsc}" --noEmit -p .`, description: "typecheck again", timeout: 120000 } };
      return { text: OK_TEXT("tsc --noEmit") };
    },
    async oracle(ws, h) {
      const r = await h.sh(ws, `node "${h.tsc}" --noEmit -p .`);
      return r.code === 0 ? { ok: true, detail: "tsc clean" } : { ok: false, detail: `tsc: ${r.out.trim().split("\n")[0]}` };
    },
  },
  // 6 ------------------------------------------------------------------
  {
    id: "js-fix-flaky-test",
    category: "flaky",
    prompt: "test/retry.test.mjs fails most runs (backoff has random jitter). Make the test deterministic-correct WITHOUT deleting its assertion. Run it several times.",
    files: {
      "package.json": '{ "name": "retry", "type": "module" }\n',
      "src/retry.mjs": "export function backoff(attempt) {\n  return Math.min(1000, 2 ** attempt * 100 + Math.floor(Math.random() * 50));\n}\n",
      "test/retry.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { backoff } from "../src/retry.mjs";\n\ntest("backoff(1) is 200ms", () => {\n  assert.equal(backoff(1), 200);\n});\n',
    },
    allowed: ["test/retry.test.mjs", "src/retry.mjs"],
    maxDiffLines: 8,
    async *script() {
      yield { name: "Bash", input: { command: "node --test", description: "run the flaky test", timeout: 60000 } };
      yield { name: "Read", input: { file_path: "test/retry.test.mjs" } };
      yield { name: "Edit", input: { file_path: "test/retry.test.mjs", old_string: '  assert.equal(backoff(1), 200);', new_string: '  const v = backoff(1);\n  assert.ok(v >= 200 && v < 250, `backoff(1)=${v} should be 200ms plus <50ms jitter`);' } };
      for (let i = 0; i < 3; i++) yield { name: "Bash", input: { command: "node --test", description: `repeat run ${i + 1}`, timeout: 60000 } };
      return { text: OK_TEXT("node --test (x3)") };
    },
    async oracle(ws, h) {
      const t = await nodeTests(6)(ws, h);
      if (!t.ok) return t;
      const test = await h.read(ws, "test/retry.test.mjs");
      return /backoff\(/.test(test) && /assert/.test(test) ? t : { ok: false, detail: "the assertion was removed" };
    },
  },
  // 7 ------------------------------------------------------------------
  {
    id: "git-resolve-merge-conflict",
    category: "merge",
    prompt: "`git merge feature` left a conflict in src/greet.mjs. Resolve it keeping BOTH intents (the new greeting AND the exported `shout`), finish the merge state (stage the file) and make the tests pass.",
    files: {
      "package.json": '{ "name": "greet", "type": "module" }\n',
      "src/greet.mjs": "export function greet(name) {\n  return `Hello, ${name}`;\n}\n",
      "test/greet.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greet, shout } from "../src/greet.mjs";\n\ntest("greet", () => assert.equal(greet("Ada"), "Welcome, Ada!"));\ntest("shout", () => assert.equal(shout("ada"), "ADA!"));\n',
    },
    async setup(ws, h) {
      await h.git(ws, "checkout -q -b feature");
      await h.write(ws, "src/greet.mjs", "export function greet(name) {\n  return `Welcome, ${name}!`;\n}\n");
      await h.git(ws, 'commit -qam "feature: friendlier greeting"');
      await h.git(ws, "checkout -q -");
      await h.write(ws, "src/greet.mjs", "export function shout(name) {\n  return `${name.toUpperCase()}!`;\n}\n\nexport function greet(name) {\n  return `Hello there, ${name}`;\n}\n");
      await h.git(ws, 'commit -qam "main: add shout"');
      await h.git(ws, "merge feature", { allowFail: true });
    },
    allowed: ["src/", "test/"],
    maxDiffLines: 30,
    async *script() {
      yield { name: "Bash", input: { command: "git status --short", description: "see the merge state", timeout: 30000 } };
      yield { name: "Read", input: { file_path: "src/greet.mjs" } };
      // Write the resolution whole: git versions lay the conflict hunk out differently (a newer
      // git on the release runner kept the shared lines outside the markers), so an exact
      // old_string over the markers only matched one git.
      yield {
        name: "Write",
        input: {
          file_path: "src/greet.mjs",
          content: "export function shout(name) {\n  return `${name.toUpperCase()}!`;\n}\n\nexport function greet(name) {\n  return `Welcome, ${name}!`;\n}\n",
        },
      };
      yield { name: "Bash", input: { command: "git add src/greet.mjs && node --test", description: "stage and test", timeout: 60000 } };
      return { text: OK_TEXT("node --test") };
    },
    async oracle(ws, h) {
      const t = await nodeTests()(ws, h);
      if (!t.ok) return t;
      const markers = await h.sh(ws, "git grep -n -E \"^(<<<<<<<|>>>>>>>)\" -- src test");
      if (markers.code === 0) return { ok: false, detail: "conflict markers remain" };
      const unmerged = await h.git(ws, "ls-files -u");
      return unmerged.out.trim() === "" ? { ok: true, detail: "resolved + staged" } : { ok: false, detail: "index still has unmerged entries" };
    },
  },
  // 8 ------------------------------------------------------------------
  {
    id: "js-write-tests-for-cart",
    category: "tests",
    prompt: "src/cart.mjs has no tests. Write test/cart.test.mjs covering total(), the discount threshold and the empty cart so that a regression in any of them is caught.",
    files: {
      "package.json": '{ "name": "cart", "type": "module" }\n',
      "src/cart.mjs": "export function total(items, { discountOver = 100, discount = 0.1 } = {}) {\n  const sum = items.reduce((a, i) => a + i.price * i.qty, 0);\n  return sum > discountOver ? sum * (1 - discount) : sum;\n}\n",
    },
    allowed: ["test/"],
    maxDiffLines: 40,
    async *script() {
      yield { name: "Read", input: { file_path: "src/cart.mjs" } };
      yield {
        name: "Write",
        input: {
          file_path: "test/cart.test.mjs",
          content:
            'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { total } from "../src/cart.mjs";\n\ntest("empty cart is 0", () => assert.equal(total([]), 0));\ntest("sums price x qty", () => assert.equal(total([{ price: 10, qty: 3 }, { price: 5, qty: 2 }]), 40));\ntest("discount applies strictly above the threshold", () => {\n  assert.equal(total([{ price: 100, qty: 1 }]), 100);\n  assert.equal(total([{ price: 200, qty: 1 }]), 180);\n});\ntest("custom discount", () => assert.equal(total([{ price: 200, qty: 1 }], { discountOver: 50, discount: 0.5 }), 100));\n',
        },
      };
      yield { name: "Bash", input: { command: "node --test", description: "run the new tests", timeout: 60000 } };
      return { text: OK_TEXT("node --test") };
    },
    // Mutation oracle: the tests must pass on the original AND fail on both mutants.
    async oracle(ws, h) {
      const t = await nodeTests()(ws, h);
      if (!t.ok) return t;
      const original = await h.read(ws, "src/cart.mjs");
      const mutants = [original.replace("sum > discountOver", "sum >= discountOver"), original.replace("i.price * i.qty", "i.price + i.qty")];
      let killed = 0;
      for (const m of mutants) {
        if (m === original) continue;
        await h.write(ws, "src/cart.mjs", m);
        const r = await h.sh(ws, "node --test");
        if (r.code !== 0) killed++;
      }
      await h.write(ws, "src/cart.mjs", original);
      return killed === 2 ? { ok: true, detail: "2/2 mutants killed" } : { ok: false, detail: `only ${killed}/2 mutants killed` };
    },
  },
  // 9 ------------------------------------------------------------------
  {
    id: "js-migrate-logger-api",
    category: "api-migration",
    prompt: "lib/logger.mjs dropped `createLogger(name).log(level, msg)` in favour of `getLogger(name).info(msg)` / `.warn(msg)` (see MIGRATION.md). Update every call site; the tests currently fail on import.",
    files: {
      "package.json": '{ "name": "svc", "type": "module" }\n',
      "MIGRATION.md": "# logger v2\n`createLogger(n).log('info', m)` -> `getLogger(n).info(m)`; `.log('warn', m)` -> `.warn(m)`.\n",
      "lib/logger.mjs": "const lines = [];\nexport const sink = lines;\nexport function getLogger(name) {\n  return {\n    info: (m) => lines.push(`[info] ${name}: ${m}`),\n    warn: (m) => lines.push(`[warn] ${name}: ${m}`),\n  };\n}\n",
      "src/users.mjs": 'import { createLogger } from "../lib/logger.mjs";\nconst log = createLogger("users");\nexport function addUser(u) {\n  log.log("info", `added ${u}`);\n  return u;\n}\n',
      "src/orders.mjs": 'import { createLogger } from "../lib/logger.mjs";\nconst log = createLogger("orders");\nexport function placeOrder(id) {\n  log.log("info", `placed ${id}`);\n  return id;\n}\n',
      "src/billing.mjs": 'import { createLogger } from "../lib/logger.mjs";\nconst log = createLogger("billing");\nexport function charge(n) {\n  if (n <= 0) log.log("warn", "non-positive charge");\n  return n;\n}\n',
      "test/svc.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { sink } from "../lib/logger.mjs";\nimport { addUser } from "../src/users.mjs";\nimport { placeOrder } from "../src/orders.mjs";\nimport { charge } from "../src/billing.mjs";\n\ntest("call sites log through the v2 API", () => {\n  addUser("ada"); placeOrder(7); charge(0);\n  assert.deepEqual(sink, ["[info] users: added ada", "[info] orders: placed 7", "[warn] billing: non-positive charge"]);\n});\n',
    },
    allowed: ["src/"],
    maxDiffLines: 20,
    async *script() {
      yield { name: "Read", input: { file_path: "MIGRATION.md" } };
      const g = yield { name: "Grep", input: { pattern: "createLogger", path: "src", output_mode: "files_with_matches" } };
      void g;
      const edits = [
        ["src/users.mjs", 'import { createLogger } from "../lib/logger.mjs";\nconst log = createLogger("users");', 'import { getLogger } from "../lib/logger.mjs";\nconst log = getLogger("users");', 'log.log("info", `added ${u}`);', "log.info(`added ${u}`);"],
        ["src/orders.mjs", 'import { createLogger } from "../lib/logger.mjs";\nconst log = createLogger("orders");', 'import { getLogger } from "../lib/logger.mjs";\nconst log = getLogger("orders");', 'log.log("info", `placed ${id}`);', "log.info(`placed ${id}`);"],
        ["src/billing.mjs", 'import { createLogger } from "../lib/logger.mjs";\nconst log = createLogger("billing");', 'import { getLogger } from "../lib/logger.mjs";\nconst log = getLogger("billing");', 'log.log("warn", "non-positive charge");', 'log.warn("non-positive charge");'],
      ];
      for (const [file, a, b, c, d] of edits) {
        yield { name: "Edit", input: { file_path: file, edits: [{ old_string: a, new_string: b }, { old_string: c, new_string: d }] } };
      }
      yield { name: "Bash", input: { command: "node --test", description: "run tests", timeout: 60000 } };
      return { text: OK_TEXT("node --test") };
    },
    oracle: nodeTests(),
  },
  // 10 -----------------------------------------------------------------
  {
    id: "sh-rotate-logs-script",
    category: "shell",
    needs: "bash",
    prompt: "Write scripts/rotate.sh: given a directory as $1, keep the 3 newest *.log files (by mtime) and delete the rest. Test it on a scratch directory.",
    files: { "README.md": "# ops\nUtility scripts live in scripts/.\n" },
    allowed: ["scripts/"],
    maxDiffLines: 20,
    async *script() {
      yield {
        name: "Write",
        input: {
          file_path: "scripts/rotate.sh",
          content: '#!/usr/bin/env bash\nset -euo pipefail\ndir="${1:?usage: rotate.sh DIR}"\ncd "$dir"\nls -1t -- *.log 2>/dev/null | tail -n +4 | while IFS= read -r f; do rm -f -- "$f"; done\n',
        },
      };
      yield { name: "Bash", input: { command: 'd=$(mktemp -d); for i in 1 2 3 4 5; do touch -d "$i hours ago" "$d/$i.log"; done; bash scripts/rotate.sh "$d"; ls "$d"; rm -rf "$d"', description: "scratch test", timeout: 30000 } };
      return { text: "Done. Verified on a scratch directory: 3 newest logs remain." };
    },
    async oracle(ws, h) {
      const script = `d=$(mktemp -d); for i in 1 2 3 4 5 6; do touch -d "$i hours ago" "$d/$i.log"; done; touch "$d/keep.txt"; bash scripts/rotate.sh "$d"; ls "$d" | tr '\\n' ' '; rm -rf "$d"`;
      const r = await h.sh(ws, script, { bash: true });
      return r.out.trim() === "1.log 2.log 3.log keep.txt" ? { ok: true, detail: "kept the 3 newest" } : { ok: false, detail: `unexpected survivors: ${r.out.trim().slice(0, 80)}` };
    },
  },
  // 11 -----------------------------------------------------------------
  {
    id: "js-rename-getuser-everywhere",
    category: "rename",
    prompt: "Rename `getUser` to `fetchUser` everywhere (definition, all call sites, tests). No behaviour change.",
    files: {
      "package.json": '{ "name": "rn", "type": "module" }\n',
      "src/user.mjs": "export function getUser(id) {\n  return { id, name: `user-${id}` };\n}\n",
      "src/a.mjs": 'import { getUser } from "./user.mjs";\nexport const a = (id) => getUser(id).name;\n',
      "src/b.mjs": 'import { getUser } from "./user.mjs";\nexport const b = (id) => getUser(id).id;\n',
      "src/c.mjs": 'import { getUser } from "./user.mjs";\nexport const c = (id) => `${getUser(id).name}!`;\n',
      "src/d.mjs": 'import { getUser } from "./user.mjs";\nexport const d = (ids) => ids.map(getUser);\n',
      "test/rn.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { getUser } from "../src/user.mjs";\nimport { a } from "../src/a.mjs";\nimport { d } from "../src/d.mjs";\n\ntest("rename safe", () => {\n  assert.equal(getUser(1).name, "user-1");\n  assert.equal(a(2), "user-2");\n  assert.equal(d([1, 2]).length, 2);\n});\n',
    },
    allowed: ["src/", "test/"],
    maxDiffLines: 30,
    async *script() {
      const g = yield { name: "Grep", input: { pattern: "getUser", output_mode: "files_with_matches" } };
      const files = [...new Set([...g.text.matchAll(/((?:src|test)[\\/][\w.-]+\.mjs)/g)].map((m) => m[1].replace(/\\/g, "/")))];
      for (const f of files.length ? files : ["src/user.mjs", "src/a.mjs", "src/b.mjs", "src/c.mjs", "src/d.mjs", "test/rn.test.mjs"]) {
        yield { name: "Edit", input: { file_path: f, old_string: "getUser", new_string: "fetchUser", replace_all: true } };
      }
      const left = yield { name: "Grep", input: { pattern: "getUser", output_mode: "count" } };
      void left;
      yield { name: "Bash", input: { command: "node --test", description: "run tests", timeout: 60000 } };
      return { text: OK_TEXT("node --test") };
    },
    async oracle(ws, h) {
      const t = await nodeTests()(ws, h);
      if (!t.ok) return t;
      const left = await h.sh(ws, 'git grep -n "getUser"');
      return left.code === 1 ? { ok: true, detail: "no getUser left" } : { ok: false, detail: "getUser still referenced" };
    },
  },
  // 12 -----------------------------------------------------------------
  {
    id: "js-perf-unique-linear",
    category: "performance",
    prompt: "unique() in src/dedupe.mjs is quadratic and the perf test (it counts Array#includes scan work) fails on 3000 items. Make it linear while preserving first-seen order.",
    files: {
      "package.json": '{ "name": "dd", "type": "module" }\n',
      "src/dedupe.mjs": "export function unique(items) {\n  const out = [];\n  for (const x of items) {\n    if (!out.includes(x)) out.push(x);\n  }\n  return out;\n}\n",
      "test/dedupe.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { unique } from "../src/dedupe.mjs";\n\ntest("order and values", () => assert.deepEqual(unique([3, 1, 3, 2, 1]), [3, 1, 2]));\n\ntest("linear: scan work stays small for 3000 items", () => {\n  const orig = Array.prototype.includes;\n  let steps = 0;\n  Array.prototype.includes = function (...a) { steps += this.length; return orig.apply(this, a); };\n  try {\n    const input = Array.from({ length: 3000 }, (_, i) => i % 2000);\n    assert.equal(unique(input).length, 2000);\n  } finally { Array.prototype.includes = orig; }\n  assert.ok(steps < 30000, `scanned ${steps} elements`);\n});\n',
    },
    allowed: ["src/dedupe.mjs"],
    maxDiffLines: 10,
    async *script() {
      yield { name: "Bash", input: { command: "node --test", description: "baseline", timeout: 60000 } };
      yield { name: "Read", input: { file_path: "src/dedupe.mjs" } };
      yield { name: "Edit", input: { file_path: "src/dedupe.mjs", old_string: "  const out = [];\n  for (const x of items) {\n    if (!out.includes(x)) out.push(x);\n  }\n  return out;", new_string: "  return [...new Set(items)];" } };
      yield { name: "Bash", input: { command: "node --test", description: "re-run", timeout: 60000 } };
      return { text: OK_TEXT("node --test") };
    },
    oracle: nodeTests(),
  },
  // 13 -----------------------------------------------------------------
  {
    id: "py-edit-syntax-slip",
    category: "edit-reliability",
    prompt: "Add an optional `max_len` argument to slug() in slug.py that truncates the result (default: no limit). Tests are in test_slug.py.",
    files: {
      "slug.py": "import re\n\n\ndef slug(text):\n    s = re.sub(r'[^a-z0-9]+', '-', text.lower())\n    return s.strip('-')\n",
      "test_slug.py": "import unittest\nfrom slug import slug\n\n\nclass SlugTests(unittest.TestCase):\n    def test_basic(self):\n        self.assertEqual(slug('Hello World!'), 'hello-world')\n\n    def test_max_len(self):\n        self.assertEqual(slug('Hello World!', max_len=5), 'hello')\n\n\nif __name__ == '__main__':\n    unittest.main()\n",
    },
    allowed: ["slug.py"],
    maxDiffLines: 8,
    async *script(h) {
      yield { name: "Read", input: { file_path: "slug.py" } };
      // Slip: unbalanced parenthesis in the new line.
      const r = yield {
        name: "Edit",
        input: { file_path: "slug.py", old_string: "def slug(text):\n    s = re.sub(r'[^a-z0-9]+', '-', text.lower())\n    return s.strip('-')", new_string: "def slug(text, max_len=None):\n    s = re.sub(r'[^a-z0-9]+', '-', text.lower()\n    s = s.strip('-')\n    return s[:max_len] if max_len else s" },
      };
      if (!r.isError) {
        // The break landed. A model finds out by running the tests, then repairs.
        yield { name: "Bash", input: { command: `${h.python} -m unittest discover -q`, description: "run tests", timeout: 60000 } };
        yield { name: "Read", input: { file_path: "slug.py" } };
        yield { name: "Edit", input: { file_path: "slug.py", old_string: "text.lower()\n    s = s.strip('-')", new_string: "text.lower())\n    s = s.strip('-')" } };
      } else {
        yield { name: "Edit", input: { file_path: "slug.py", old_string: "def slug(text):\n    s = re.sub(r'[^a-z0-9]+', '-', text.lower())\n    return s.strip('-')", new_string: "def slug(text, max_len=None):\n    s = re.sub(r'[^a-z0-9]+', '-', text.lower())\n    s = s.strip('-')\n    return s[:max_len] if max_len else s" } };
      }
      yield { name: "Bash", input: { command: `${h.python} -m unittest discover -q`, description: "re-run tests", timeout: 60000 } };
      return { text: OK_TEXT("python -m unittest") };
    },
    oracle: pyTests,
  },
  // 14 -----------------------------------------------------------------
  {
    id: "js-edit-after-external-change",
    category: "edit-reliability",
    prompt: "In src/limits.mjs raise MAX_RETRIES from 3 to 5. (A formatter may touch the file while you work.)",
    files: {
      "package.json": '{ "name": "lim", "type": "module" }\n',
      "src/limits.mjs": "export const MAX_RETRIES = 3;\nexport const TIMEOUT_MS = 1000;\n",
      "test/limits.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { MAX_RETRIES } from "../src/limits.mjs";\n\ntest("retries", () => assert.equal(MAX_RETRIES, 5));\n',
    },
    allowed: ["src/limits.mjs"],
    maxDiffLines: 6,
    async *script() {
      yield { name: "Read", input: { file_path: "src/limits.mjs" } };
      // A watcher/formatter appends a line between the model's Read and its Edit.
      yield { name: "Bash", input: { command: "printf '// formatted\\n' >> src/limits.mjs", description: "simulate an external formatter touching the file", timeout: 30000 } };
      const r = yield { name: "Edit", input: { file_path: "src/limits.mjs", old_string: "MAX_RETRIES = 3", new_string: "MAX_RETRIES = 5" } };
      if (r.isError) {
        yield { name: "Read", input: { file_path: "src/limits.mjs" } };
        yield { name: "Edit", input: { file_path: "src/limits.mjs", old_string: "MAX_RETRIES = 3", new_string: "MAX_RETRIES = 5" } };
      }
      yield { name: "Bash", input: { command: "node --test", description: "run tests", timeout: 60000 } };
      return { text: OK_TEXT("node --test") };
    },
    oracle: nodeTests(),
  },
  // 15 -----------------------------------------------------------------
  {
    id: "js-fix-with-noisy-test-output",
    category: "output-handling",
    prompt: "test/noisy.test.mjs fails somewhere in thousands of log lines. Find the failing assertion, fix the code, re-run.",
    files: {
      "package.json": '{ "name": "noisy", "type": "module" }\n',
      "src/sum.mjs": "export function sum(xs) {\n  return xs.reduce((a, b) => a + b, 1);\n}\n",
      "test/noisy.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "../src/sum.mjs";\n\nfor (let i = 0; i < 40; i++) {\n  test(`noise ${i}`, () => {\n    for (let j = 0; j < 150; j++) console.log(`noise ${i}.${j} lorem ipsum dolor sit amet consectetur`);\n    assert.ok(true);\n  });\n}\n\ntest("sum adds", () => {\n  assert.equal(sum([1, 2, 3]), 6);\n});\n',
    },
    allowed: ["src/sum.mjs"],
    maxDiffLines: 4,
    async *script() {
      yield { name: "Bash", input: { command: "node --test", description: "run the suite", timeout: 60000 } };
      yield { name: "Read", input: { file_path: "src/sum.mjs" } };
      yield { name: "Edit", input: { file_path: "src/sum.mjs", old_string: "(a, b) => a + b, 1)", new_string: "(a, b) => a + b, 0)" } };
      yield { name: "Bash", input: { command: "node --test", description: "re-run the suite", timeout: 60000 } };
      return { text: OK_TEXT("node --test") };
    },
    oracle: nodeTests(),
  },
  // 16 -----------------------------------------------------------------
  {
    id: "js-grep-inline-flag-pattern",
    category: "navigation",
    prompt: "The auth header name is built somewhere in src (the constant's capitalisation is unknown). Make the header `X-Authorization` instead of `X-Auth` and keep the tests green.",
    files: {
      "package.json": '{ "name": "http", "type": "module" }\n',
      "src/http.mjs": 'const AuthHeaderName = "X-Auth";\nexport function headers(token) {\n  return { [AuthHeaderName]: token };\n}\n',
      "src/other.mjs": 'export const unrelated = "X-Authority-ignore";\n',
      "test/http.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { headers } from "../src/http.mjs";\n\ntest("auth header", () => assert.deepEqual(headers("t"), { "X-Authorization": "t" }));\n',
    },
    allowed: ["src/http.mjs"],
    maxDiffLines: 4,
    async *script() {
      // Models routinely prefix ripgrep inline flags; the JS validator used to reject them.
      let g = yield { name: "Grep", input: { pattern: "(?i)authheadername", output_mode: "content" } };
      if (g.isError) g = yield { name: "Grep", input: { pattern: "authheadername", case_insensitive: true, output_mode: "content" } };
      yield { name: "Edit", input: { file_path: "src/http.mjs", old_string: 'const AuthHeaderName = "X-Auth";', new_string: 'const AuthHeaderName = "X-Authorization";' } };
      yield { name: "Bash", input: { command: "node --test", description: "run tests", timeout: 60000 } };
      return { text: OK_TEXT("node --test") };
    },
    oracle: nodeTests(),
  },
  // 17 -----------------------------------------------------------------
  {
    id: "git-regression-find-culprit",
    category: "regression",
    prompt: "The tests passed at tag `v1` and fail now. Find the commit that broke `add()` and fix it. Name the culprit commit in your report.",
    files: {
      "package.json": '{ "name": "calc", "type": "module" }\n',
      "src/calc.mjs": "export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n",
      "test/calc.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add, sub } from "../src/calc.mjs";\n\ntest("add", () => assert.equal(add(2, 3), 5));\ntest("sub", () => assert.equal(sub(5, 3), 2));\n',
    },
    async setup(ws, h) {
      await h.git(ws, "tag v1");
      const noise = ["docs: tweak readme", "chore: bump header", "style: whitespace"];
      let n = 0;
      for (const msg of noise) {
        await h.write(ws, "NOTES.md", `${"note ".repeat(++n)}\n`);
        await h.git(ws, `add -A`);
        await h.git(ws, `commit -qm "${msg}"`);
      }
      await h.write(ws, "src/calc.mjs", "export function add(a, b) {\n  return a - b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n");
      await h.git(ws, 'commit -qam "perf: simplify arithmetic helpers"');
      for (const msg of ["docs: more notes", "chore: lint config", "ci: pipeline"]) {
        await h.write(ws, "NOTES.md", `${"note ".repeat(++n)}\n`);
        await h.git(ws, `add -A`);
        await h.git(ws, `commit -qm "${msg}"`);
      }
    },
    allowed: ["src/calc.mjs"],
    maxDiffLines: 6,
    async *script(h) {
      let culprit = "";
      if (h.tools.has("Bisect")) {
        const r = yield { name: "Bisect", input: { good: "v1", bad: "HEAD", command: "node --test", step_timeout_s: 60 } };
        culprit = (r.text.match(/"sha":\s*"([0-9a-f]{7,40})"/) ?? [])[1] ?? "";
      } else {
        // What a model without the tool does: drive git bisect by hand.
        yield { name: "Bash", input: { command: "git bisect start HEAD v1", description: "start bisect", timeout: 30000 } };
        const r = yield { name: "Bash", input: { command: "git bisect run node --test", description: "bisect run", timeout: 120000 } };
        culprit = (r.text.match(/([0-9a-f]{40}) is the first '?bad'? commit/) ?? [])[1] ?? "";
        yield { name: "Bash", input: { command: "git bisect reset", description: "restore HEAD", timeout: 30000 } };
      }
      yield { name: "Read", input: { file_path: "src/calc.mjs" } };
      yield { name: "Edit", input: { file_path: "src/calc.mjs", old_string: "export function add(a, b) {\n  return a - b;", new_string: "export function add(a, b) {\n  return a + b;" } };
      yield { name: "Bash", input: { command: "node --test", description: "verify", timeout: 60000 } };
      return { text: `Culprit: ${culprit.slice(0, 10) || "unknown"} (perf: simplify arithmetic helpers). ${OK_TEXT("node --test")}` };
    },
    async oracle(ws, h, final) {
      const t = await nodeTests()(ws, h);
      if (!t.ok) return t;
      const head = await h.git(ws, 'log --format=%H --grep="simplify arithmetic" -1');
      const sha = head.out.trim().slice(0, 10);
      return final.includes(sha) ? { ok: true, detail: "fixed + culprit named" } : { ok: false, detail: "fixed, but the culprit commit was not identified" };
    },
  },
  // 18 -----------------------------------------------------------------
  {
    id: "rules-first-command-readonly",
    category: "repo-instructions",
    prompt: "(Repo has AGENTS.md rules.) List the repo, then change the greeting in src/hi.mjs to 'hello'.",
    files: {
      "package.json": '{ "name": "hi", "type": "module" }\n',
      "AGENTS.md": "# Rules\n- Keep edits minimal.\n- Run `node --test` before finishing.\n",
      "src/hi.mjs": 'export const hi = () => "hi";\n',
      "test/hi.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { hi } from "../src/hi.mjs";\n\ntest("greeting", () => assert.equal(hi(), "hello"));\n',
    },
    allowed: ["src/hi.mjs"],
    maxDiffLines: 4,
    async *script() {
      // The FIRST command is read-only: it must not burn a round trip on a rules rejection.
      const ls = { name: "Bash", input: { command: "ls", description: "list the repo", timeout: 30000 } };
      const first = yield ls;
      if (first.isError) yield ls; // the rules were surfaced by the rejection; a model retries
      yield { name: "Read", input: { file_path: "src/hi.mjs" } };
      const edit = { name: "Edit", input: { file_path: "src/hi.mjs", old_string: '"hi"', new_string: '"hello"' } };
      const e = yield edit;
      if (e.isError) yield edit;
      yield { name: "Bash", input: { command: "node --test", description: "run tests", timeout: 60000 } };
      return { text: OK_TEXT("node --test") };
    },
    oracle: nodeTests(),
  },
  // 19 -----------------------------------------------------------------
  {
    id: "rules-grep-then-edit",
    category: "repo-instructions",
    prompt: "(Repo has AGENTS.md rules.) Find where the version string is defined and bump it to 2.0.0.",
    files: {
      "package.json": '{ "name": "ver", "type": "module" }\n',
      "AGENTS.md": "# Rules\n- Bump versions only in src/version.mjs.\n",
      "src/version.mjs": 'export const VERSION = "1.0.0";\n',
      "test/version.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { VERSION } from "../src/version.mjs";\n\ntest("version", () => assert.equal(VERSION, "2.0.0"));\n',
    },
    allowed: ["src/version.mjs"],
    maxDiffLines: 4,
    async *script() {
      // Grep is the first workspace touch; the Edit that follows should not be rejected for unseen rules.
      yield { name: "Grep", input: { pattern: "VERSION", output_mode: "content" } };
      const edit = { name: "Edit", input: { file_path: "src/version.mjs", old_string: '"1.0.0"', new_string: '"2.0.0"' } };
      const e = yield edit;
      if (e.isError) yield edit; // rules were surfaced by the rejection; a model retries
      yield { name: "Bash", input: { command: "node --test", description: "run tests", timeout: 60000 } };
      return { text: OK_TEXT("node --test") };
    },
    oracle: nodeTests(),
  },
];

export const TASK_IDS = TASKS.map((t) => t.id);
