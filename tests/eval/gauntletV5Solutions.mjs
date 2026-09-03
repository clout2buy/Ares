// Scripted solutions for the coding-v5 (repo-scale) gauntlet — MOCK MODE ONLY.
//
// Each entry is the ordered tool-call script a solved-by-construction provider
// replays against the fixture. They exist so CI can prove the PLUMBING — the
// fixtures materialize, the CRLF files survive, node --test runs, the
// diffScope/planBeforeEdit probes judge the trace — with no model and no
// network. A 100% mock score says nothing about agent skill (see
// tests/eval/README.md); real numbers need `ares eval coding --suite coding-v5`
// with a real provider.
//
// Tool names match the real harness (Write/Edit/TodoWrite/Bash); the test
// supplies minimal fakes. Bash is used only for `rm` (the refactor task deletes
// a module), which is also how diffScope proves shell-made changes are caught.

const crlf = (...lines) => lines.join("\r\n") + "\r\n";

export const V5_SOLUTIONS = {
  "v5-add-endpoint": [
    {
      name: "Write",
      input: {
        file_path: "src/handlers/version.mjs",
        content:
          'import { readFileSync } from "node:fs";\n\n' +
          "/** GET /version — the package version, read at request time. */\n" +
          "export function version() {\n" +
          '  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));\n' +
          "  return { status: 200, body: { version: pkg.version } };\n" +
          "}\n",
      },
    },
    {
      name: "Edit",
      input: {
        file_path: "src/router.mjs",
        old_string: 'import { health } from "./handlers/health.mjs";',
        new_string: 'import { health } from "./handlers/health.mjs";\nimport { version } from "./handlers/version.mjs";',
      },
    },
    {
      name: "Edit",
      input: {
        file_path: "src/router.mjs",
        old_string: '  { method: "GET", path: "/health", handler: health },',
        new_string: '  { method: "GET", path: "/health", handler: health },\n  { method: "GET", path: "/version", handler: version },',
      },
    },
    {
      name: "Write",
      input: {
        file_path: "tests/version.test.mjs",
        content:
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { readFileSync } from "node:fs";\n' +
          'import { dispatch } from "../src/app.mjs";\n\n' +
          'test("GET /version reports the package version", () => {\n' +
          '  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));\n' +
          '  assert.deepEqual(dispatch("GET", "/version"), { status: 200, body: { version: pkg.version } });\n' +
          "});\n",
      },
    },
    {
      name: "Edit",
      input: {
        file_path: "docs/API.md",
        old_string: "| GET | /health | `{ ok: true }` |",
        new_string: "| GET | /health | `{ ok: true }` |\r\n| GET | /version | `{ version }` (from package.json) |",
      },
    },
  ],

  "v5-cause-not-symptom": [
    {
      name: "Edit",
      input: { file_path: "src/parsePrice.mjs", old_string: "return parseInt(digits, 10);", new_string: "return parseFloat(digits);" },
    },
  ],

  "v5-refactor-shared-helper": [
    {
      name: "Write",
      input: {
        file_path: "src/util/text.mjs",
        content:
          "/** toSlug(text, { separator }) — lowercase, non-alphanumerics collapsed to the separator, edges trimmed. */\n" +
          'export function toSlug(text, { separator = "-" } = {}) {\n' +
          "  const sep = separator.replace(/[.*+?^${}()|[\\]\\\\]/g, \"\\\\$&\");\n" +
          '  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, separator).replace(new RegExp("^(?:" + sep + ")+|(?:" + sep + ")+$", "g"), "");\n' +
          "}\n",
      },
    },
    { name: "Write", input: { file_path: "src/posts.mjs", content: 'import { toSlug } from "./util/text.mjs";\n\nexport function postPath(title) {\n  return "/posts/" + toSlug(title);\n}\n' } },
    { name: "Write", input: { file_path: "src/tags.mjs", content: 'import { toSlug } from "./util/text.mjs";\n\nexport function tagKey(tag) {\n  return "tag:" + toSlug(tag);\n}\n' } },
    { name: "Write", input: { file_path: "src/users.mjs", content: 'import { toSlug } from "./util/text.mjs";\n\nexport function handle(displayName) {\n  return "@" + toSlug(displayName);\n}\n' } },
    {
      name: "Write",
      input: {
        file_path: "src/routes.mjs",
        content: crlf('import { toSlug } from "./util/text.mjs";', "", "export function route(section, title) {", '  return "/" + toSlug(section) + "/" + toSlug(title);', "}"),
      },
    },
    { name: "Bash", input: { command: "rm src/util/slug.mjs" } },
  ],

  "v5-thread-option": [
    {
      name: "Write",
      input: {
        file_path: "src/cli.mjs",
        content:
          'import { greet } from "./service.mjs";\n' +
          'import { DEFAULT_NAME } from "./constants.mjs";\n\n' +
          "export function parseArgs(argv) {\n" +
          "  const opts = { name: DEFAULT_NAME, shout: false, repeat: 1 };\n" +
          "  for (let i = 0; i < argv.length; i++) {\n" +
          "    const arg = argv[i];\n" +
          '    if (arg === "--name") opts.name = argv[++i];\n' +
          '    else if (arg === "--shout") opts.shout = true;\n' +
          '    else if (arg === "--repeat") opts.repeat = Number(argv[++i]);\n' +
          "  }\n" +
          "  return opts;\n" +
          "}\n\n" +
          "export function main(argv) {\n" +
          "  const opts = parseArgs(argv);\n" +
          "  return greet(opts.name, { shout: opts.shout, repeat: opts.repeat });\n" +
          "}\n",
      },
    },
    {
      name: "Write",
      input: {
        file_path: "src/service.mjs",
        content:
          'import { formatGreeting } from "./format.mjs";\n\n' +
          "export function greet(name, opts = {}) {\n" +
          "  return formatGreeting(name, { shout: opts.shout === true, repeat: opts.repeat ?? 1 });\n" +
          "}\n",
      },
    },
    {
      name: "Write",
      input: {
        file_path: "src/format.mjs",
        content:
          'import { GREETING } from "./constants.mjs";\n\n' +
          "export function formatGreeting(name, { shout = false, repeat = 1 } = {}) {\n" +
          '  const text = GREETING + ", " + name + "!";\n' +
          "  const line = shout ? text.toUpperCase() : text;\n" +
          '  return Array.from({ length: Math.max(1, repeat | 0) }, () => line).join("\\n");\n' +
          "}\n",
      },
    },
    {
      name: "Write",
      input: {
        file_path: "tests/cli-repeat.test.mjs",
        content:
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { main } from "../src/cli.mjs";\n\n' +
          'test("--repeat repeats the greeting joined by newlines", () => {\n' +
          '  assert.equal(main(["--name", "Ada", "--repeat", "2"]), "Hello, Ada!\\nHello, Ada!");\n' +
          '  assert.equal(main(["--repeat", "1"]), "Hello, world!");\n' +
          "});\n",
      },
    },
  ],

  "v5-contract-in-the-test": [
    {
      name: "Write",
      input: {
        file_path: "src/retry.mjs",
        content:
          "/** retry(fn, opts) — the contract is tests/retry.test.mjs. */\n" +
          "export async function retry(fn, opts = {}) {\n" +
          "  const attempts = opts.attempts ?? 3;\n" +
          '  if (!(attempts >= 1)) throw new RangeError("attempts must be >= 1");\n' +
          "  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));\n" +
          "  const errors = [];\n" +
          "  for (let attempt = 1; attempt <= attempts; attempt++) {\n" +
          "    try {\n" +
          "      return await fn();\n" +
          "    } catch (err) {\n" +
          "      errors.push(err);\n" +
          "      if (opts.shouldRetry && !opts.shouldRetry(err, attempt)) throw err;\n" +
          "      if (attempt === attempts) break;\n" +
          '      const delay = typeof opts.delayMs === "function" ? opts.delayMs(attempt) : (opts.delayMs ?? 0);\n' +
          "      opts.onRetry?.(err, attempt, delay);\n" +
          "      await sleep(delay);\n" +
          "    }\n" +
          "  }\n" +
          "  throw new AggregateError(errors, `retry: ${attempts} attempts failed`);\n" +
          "}\n",
      },
    },
  ],

  "v5-ambiguous-spec-plan-first": [
    {
      name: "TodoWrite",
      input: {
        todos: [
          { content: "Read TICKET-88 and list the contradictions", status: "completed", activeForm: "Reading the ticket" },
          { content: "Write docs/PLAN-88.md with open questions and the approach", status: "completed", activeForm: "Writing the plan" },
          { content: "Do NOT touch src/ or tests/ until answered", status: "completed", activeForm: "Holding code changes" },
        ],
      },
    },
    {
      name: "Write",
      input: {
        file_path: "docs/PLAN-88.md",
        content:
          "# PLAN-88: CSV export — questions before code\n\n" +
          "Open questions:\n" +
          "- Which delimiter: comma (finance) or semicolon (sales ops, EU Excel)?\n" +
          "- Header row: included (finance) or omitted (sales ops import tool)?\n" +
          "- Which report is being exported: salesReport or inventoryReport?\n" +
          "- Should money columns be formatted with format.mjs or raw numbers?\n\n" +
          "Proposed approach once answered:\n" +
          "1. Add toCsv(rows, { delimiter, header }) to src/export.mjs with both options explicit.\n" +
          "2. Cover both delimiters and header on/off in tests/export.test.mjs.\n" +
          "3. Wire the chosen report through a single exportReport(kind) entry point.\n",
      },
    },
  ],
};
