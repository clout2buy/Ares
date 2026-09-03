// coding-v5: the repo-scale suite.
//
// v1–v4 are single-concern fixtures: one module, one test, one fix. Frontier
// models pin them at 100% (2026-08-15 baseline), so the score no longer ranks
// anything. What still separates a good coding agent from a fluent one is
// WORK ACROSS FILES: reading the module the symptom is not in, keeping four
// callers honest through a refactor, threading an option down three layers
// without short-circuiting it at the top, learning a contract from a test
// instead of from the prompt, and — the hardest one — recognizing a spec that
// cannot be implemented as written and planning instead of guessing.
//
// Every fixture is a small multi-package-shaped workspace (3–6 files, a real
// `npm test` script over node --test, and at least one CRLF file so
// line-ending discipline is exercised). Grading is reality-only, with two
// probes v1–v4 lacked:
//   diffScope      — the set of changed files ⊆ an allowed set (fixing the
//                    cause, not the symptom; refactors that stay in their lane)
//   planBeforeEdit — a TodoWrite/plan call precedes the first edit
//
// Registered in GAUNTLET_SUITES as "coding-v5" but never the default —
// selecting it is an explicit `--suite coding-v5`, so existing trend cells
// keep their comparability.

import type { GauntletTask } from "./gauntlet.js";

const PKG = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: "fixture", version: "1.4.2", type: "module", scripts: { test: "node --test tests/*.test.mjs" }, ...extra }, null, 2) + "\n";

/** Join lines with CRLF — the file the fixture keeps in Windows line endings. */
const crlf = (...lines: string[]): string => lines.join("\r\n") + "\r\n";

export const CODING_GAUNTLET_V5: GauntletTask[] = [
  {
    id: "v5-add-endpoint",
    title: "Add an endpoint across handler, router, test, and docs",
    prompt:
      "Add a GET /version endpoint to this service. It must return { status: 200, body: { version } } where version is READ from package.json at runtime (never hardcoded). Follow the existing structure exactly: a new handler module under src/handlers/, a route entry in src/router.mjs, a NEW test file tests/version.test.mjs that covers it, and a line for it in docs/API.md. Do not edit tests/app.test.mjs or package.json. Run the tests (node --test tests/*.test.mjs) to confirm everything passes.",
    files: {
      "package.json": PKG(),
      "src/handlers/health.mjs": `/** GET /health — liveness. */
export function health() {
  return { status: 200, body: { ok: true } };
}
`,
      "src/router.mjs": `// Route table: method + path -> handler. Handlers receive { method, path }
// and return { status, body }. Add new routes here; app.mjs never changes.
import { health } from "./handlers/health.mjs";

export const routes = [
  { method: "GET", path: "/health", handler: health },
];

export function findRoute(method, path) {
  return routes.find((r) => r.method === method && r.path === path) ?? null;
}
`,
      "src/app.mjs": `import { findRoute } from "./router.mjs";

export function dispatch(method, path) {
  const route = findRoute(method, path);
  if (!route) return { status: 404, body: { error: "not found" } };
  return route.handler({ method, path });
}
`,
      "docs/API.md": crlf(
        "# API",
        "",
        "| Method | Path | Response |",
        "| --- | --- | --- |",
        "| GET | /health | `{ ok: true }` |",
      ),
      "tests/app.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/app.mjs";

test("GET /health is alive", () => {
  assert.deepEqual(dispatch("GET", "/health"), { status: 200, body: { ok: true } });
});

test("unknown routes 404", () => {
  assert.equal(dispatch("GET", "/nope").status, 404);
});
`,
    },
    protectedFiles: ["tests/app.test.mjs", "package.json"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/app.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      { kind: "command", cmd: "node", args: ["--test", "tests/version.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      { kind: "file", path: "tests/version.test.mjs", contains: "/version" },
      { kind: "file", path: "docs/API.md", contains: "/version" },
      { kind: "command", cmd: "node", args: ["-e", "import('./src/app.mjs').then(({dispatch})=>{const r=dispatch('GET','/version');if(!r||r.status!==200||!r.body||r.body.version!=='1.4.2')process.exit(9)})"], expectExit: 0, timeoutMs: 15_000 },
      { kind: "diffScope", allowed: ["src/handlers/", "src/router.mjs", "src/app.mjs", "tests/version.test.mjs", "docs/API.md"] },
    ],
    maxTurns: 48,
  },
  {
    id: "v5-cause-not-symptom",
    title: "Fix a bug where the symptom and the cause live in different modules",
    prompt:
      "tests/cart.test.mjs is failing: cart totals come out wrong whenever an item's price has cents. Find the ROOT cause and fix it THERE — do not work around it in cart.mjs or receipt.mjs, and do not edit any test. Run the whole suite (node --test tests/*.test.mjs) to confirm.",
    files: {
      "package.json": PKG(),
      "src/parsePrice.mjs": `/** "$12.50" -> 12.50 (a number of dollars). */
export function parsePrice(text) {
  const digits = String(text).replace(/[^0-9.]/g, "");
  return parseInt(digits, 10);
}
`,
      "src/catalog.mjs": crlf(
        "export const CATALOG = [",
        '  { sku: "A1", name: "Widget", price: "$12.50" },',
        '  { sku: "B2", name: "Gadget", price: "$3.25" },',
        '  { sku: "C3", name: "Doohickey", price: "$0.99" },',
        '  { sku: "D4", name: "Gizmo", price: "$7" },',
        "];",
      ),
      "src/cart.mjs": `import { CATALOG } from "./catalog.mjs";
import { parsePrice } from "./parsePrice.mjs";

export function total(lines) {
  let sum = 0;
  for (const { sku, qty } of lines) {
    const item = CATALOG.find((i) => i.sku === sku);
    if (!item) throw new Error("unknown sku " + sku);
    sum += parsePrice(item.price) * qty;
  }
  return Math.round(sum * 100) / 100;
}
`,
      "src/receipt.mjs": `import { total } from "./cart.mjs";

export function receipt(lines) {
  return "TOTAL $" + total(lines).toFixed(2);
}
`,
      "tests/parsePrice.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { parsePrice } from "../src/parsePrice.mjs";

test("whole-dollar prices parse", () => {
  assert.equal(parsePrice("$12"), 12);
  assert.equal(parsePrice("7"), 7);
});
`,
      "tests/cart.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/cart.mjs";
import { receipt } from "../src/receipt.mjs";

test("totals keep the cents", () => {
  assert.equal(total([{ sku: "A1", qty: 1 }, { sku: "B2", qty: 2 }]), 19);
  assert.equal(total([{ sku: "C3", qty: 3 }]), 2.97);
  assert.equal(total([{ sku: "D4", qty: 2 }]), 14);
});

test("the receipt renders the exact total", () => {
  assert.equal(receipt([{ sku: "A1", qty: 1 }, { sku: "C3", qty: 1 }]), "TOTAL $13.49");
});
`,
    },
    protectedFiles: ["tests/cart.test.mjs", "tests/parsePrice.test.mjs", "package.json"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/cart.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      { kind: "command", cmd: "node", args: ["--test", "tests/parsePrice.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      { kind: "command", cmd: "node", args: ["-e", "import('./src/parsePrice.mjs').then(({parsePrice})=>{if(parsePrice('$12.50')!==12.5||parsePrice('$0.99')!==0.99||parsePrice('$7')!==7)process.exit(9)})"], expectExit: 0, timeoutMs: 15_000 },
      // The fix belongs at the cause. Touching cart/receipt/catalog means the
      // symptom was patched, not the bug.
      { kind: "diffScope", allowed: ["src/parsePrice.mjs"] },
    ],
    maxTurns: 48,
  },
  {
    id: "v5-refactor-shared-helper",
    title: "Refactor a helper used by four modules without breaking their tests",
    prompt:
      "Replace the ad-hoc slug helper: create src/util/text.mjs exporting `toSlug(text, { separator } = {})` (separator defaults to \"-\"; behavior otherwise identical to today's slugify), switch EVERY caller (src/posts.mjs, src/tags.mjs, src/users.mjs, src/routes.mjs) to import toSlug from src/util/text.mjs, and DELETE src/util/slug.mjs so nothing can import it any more. Public behavior must not change: tests/paths.test.mjs must keep passing untouched. Run the suite to confirm.",
    files: {
      "package.json": PKG(),
      "src/util/slug.mjs": `export function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
`,
      "src/posts.mjs": `import { slugify } from "./util/slug.mjs";

export function postPath(title) {
  return "/posts/" + slugify(title);
}
`,
      "src/tags.mjs": `import { slugify } from "./util/slug.mjs";

export function tagKey(tag) {
  return "tag:" + slugify(tag);
}
`,
      "src/users.mjs": `import { slugify } from "./util/slug.mjs";

export function handle(displayName) {
  return "@" + slugify(displayName);
}
`,
      "src/routes.mjs": crlf(
        'import { slugify } from "./util/slug.mjs";',
        "",
        "export function route(section, title) {",
        '  return "/" + slugify(section) + "/" + slugify(title);',
        "}",
      ),
      "tests/paths.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { postPath } from "../src/posts.mjs";
import { tagKey } from "../src/tags.mjs";
import { handle } from "../src/users.mjs";
import { route } from "../src/routes.mjs";

test("posts", () => assert.equal(postPath("Hello, World!"), "/posts/hello-world"));
test("tags", () => assert.equal(tagKey("  Node JS  "), "tag:node-js"));
test("users", () => assert.equal(handle("Ada Lovelace"), "@ada-lovelace"));
test("routes", () => assert.equal(route("Dev Notes", "CRLF & You"), "/dev-notes/crlf-you"));
`,
    },
    protectedFiles: ["tests/paths.test.mjs", "package.json"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/paths.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      { kind: "file", path: "src/util/text.mjs", contains: "toSlug" },
      { kind: "command", cmd: "node", args: ["-e", "import('node:fs').then(async(fs)=>{if(fs.existsSync('src/util/slug.mjs'))process.exit(9);for(const f of['src/posts.mjs','src/tags.mjs','src/users.mjs','src/routes.mjs']){const t=fs.readFileSync(f,'utf8');if(!t.includes('util/text.mjs')||t.includes('util/slug.mjs'))process.exit(8)}const{toSlug}=await import('./src/util/text.mjs');if(toSlug('Hello World')!=='hello-world'||toSlug('Hello World',{separator:'_'})!=='hello_world')process.exit(7)})"], expectExit: 0, timeoutMs: 15_000 },
      { kind: "diffScope", allowed: ["src/util/text.mjs", "src/util/slug.mjs", "src/posts.mjs", "src/tags.mjs", "src/users.mjs", "src/routes.mjs"] },
    ],
    maxTurns: 48,
  },
  {
    id: "v5-thread-option",
    title: "Thread a new option down three layers",
    prompt:
      "Add a `--repeat <n>` CLI option. The greeting must be produced n times joined by a single newline (n defaults to 1). Thread the option through ALL THREE layers — parse it in src/cli.mjs, pass it through src/service.mjs, and apply it in src/format.mjs (the formatting layer owns rendering; do not short-circuit the repeat in cli.mjs or service.mjs). Add tests/cli-repeat.test.mjs covering it. Existing tests must keep passing untouched. Run the suite.",
    files: {
      "package.json": PKG(),
      "src/constants.mjs": crlf('export const DEFAULT_NAME = "world";', 'export const GREETING = "Hello";'),
      "src/cli.mjs": `import { greet } from "./service.mjs";
import { DEFAULT_NAME } from "./constants.mjs";

export function parseArgs(argv) {
  const opts = { name: DEFAULT_NAME, shout: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") opts.name = argv[++i];
    else if (arg === "--shout") opts.shout = true;
  }
  return opts;
}

export function main(argv) {
  const opts = parseArgs(argv);
  return greet(opts.name, { shout: opts.shout });
}
`,
      "src/service.mjs": `import { formatGreeting } from "./format.mjs";

export function greet(name, opts = {}) {
  return formatGreeting(name, { shout: opts.shout === true });
}
`,
      "src/format.mjs": `import { GREETING } from "./constants.mjs";

export function formatGreeting(name, { shout = false } = {}) {
  const text = GREETING + ", " + name + "!";
  return shout ? text.toUpperCase() : text;
}
`,
      "tests/cli.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.mjs";

test("default greeting", () => assert.equal(main([]), "Hello, world!"));
test("--name", () => assert.equal(main(["--name", "Ada"]), "Hello, Ada!"));
test("--shout", () => assert.equal(main(["--shout", "--name", "Ada"]), "HELLO, ADA!"));
`,
    },
    protectedFiles: ["tests/cli.test.mjs", "package.json", "src/constants.mjs"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/cli.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      { kind: "command", cmd: "node", args: ["--test", "tests/cli-repeat.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      { kind: "file", path: "tests/cli-repeat.test.mjs", contains: "--repeat" },
      { kind: "command", cmd: "node", args: ["-e", "Promise.all([import('./src/cli.mjs'),import('./src/format.mjs')]).then(([{main},{formatGreeting}])=>{if(main(['--name','Ada','--repeat','2'])!=='Hello, Ada!\\nHello, Ada!')process.exit(9);if(main(['--repeat','3','--shout'])!=='HELLO, WORLD!\\nHELLO, WORLD!\\nHELLO, WORLD!')process.exit(8);if(main(['--repeat','1'])!=='Hello, world!')process.exit(7);if(formatGreeting('Bo',{repeat:2})!=='Hello, Bo!\\nHello, Bo!')process.exit(6)})"], expectExit: 0, timeoutMs: 15_000 },
      { kind: "diffScope", allowed: ["src/cli.mjs", "src/service.mjs", "src/format.mjs", "tests/cli-repeat.test.mjs"] },
    ],
    maxTurns: 48,
  },
  {
    id: "v5-contract-in-the-test",
    title: "Make a failing test pass — the test is the only spec",
    prompt:
      "tests/retry.test.mjs fails. The test IS the contract: read it carefully and make src/retry.mjs satisfy every case (injected sleep, delayMs as a number or a function, shouldRetry, onRetry, the exact AggregateError shape). Do not edit tests or the callers. Run the suite to confirm.",
    files: {
      "package.json": PKG(),
      "src/retry.mjs": `/** retry(fn, opts) — see tests/retry.test.mjs for the contract. */
export async function retry(fn, opts = {}) {
  const attempts = opts.attempts ?? 3;
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 0));
    }
  }
  throw lastError;
}
`,
      "src/backoff.mjs": crlf(
        "/** Exponential backoff in ms for the 1-based attempt that just failed. */",
        "export function expo(attempt) {",
        "  return Math.min(4000, 100 * 2 ** (attempt - 1));",
        "}",
      ),
      "src/http.mjs": `import { retry } from "./retry.mjs";
import { expo } from "./backoff.mjs";

/** fetchJson(url, { fetch, sleep }) retries 5xx responses with backoff. */
export function fetchJson(url, deps) {
  return retry(
    async () => {
      const res = await deps.fetch(url);
      if (res.status >= 500) throw Object.assign(new Error("server " + res.status), { status: res.status });
      return res.json();
    },
    { attempts: 4, delayMs: expo, sleep: deps.sleep, shouldRetry: (err) => typeof err.status === "number" && err.status >= 500 },
  );
}
`,
      "tests/retry.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.mjs";

function flaky(failures, result = "ok") {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls <= failures) throw new Error("fail " + calls);
    return result;
  };
  fn.calls = () => calls;
  return fn;
}

test("succeeds once the function stops failing; 3 attempts by default; delayMs defaults to 0", async () => {
  const fn = flaky(2);
  const sleeps = [];
  const out = await retry(fn, { sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(out, "ok");
  assert.equal(fn.calls(), 3);
  assert.deepEqual(sleeps, [0, 0]);
});

test("delayMs may be a number or a function of the 1-based attempt that just failed", async () => {
  const sleeps = [];
  await retry(flaky(2), { delayMs: 50, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, [50, 50]);
  sleeps.length = 0;
  await retry(flaky(2), { delayMs: (attempt) => attempt * 10, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, [10, 20]);
});

test("exhaustion rejects with an AggregateError carrying every error, in order", async () => {
  const fn = flaky(10);
  await assert.rejects(retry(fn, { attempts: 4, sleep: async () => {} }), (err) => {
    assert.ok(err instanceof AggregateError, "AggregateError");
    assert.equal(err.message, "retry: 4 attempts failed");
    assert.deepEqual(err.errors.map((e) => e.message), ["fail 1", "fail 2", "fail 3", "fail 4"]);
    return true;
  });
  assert.equal(fn.calls(), 4);
});

test("shouldRetry(err, attempt) returning false rethrows the ORIGINAL error immediately", async () => {
  const fn = flaky(10);
  let sleeps = 0;
  await assert.rejects(
    retry(fn, { shouldRetry: (err) => !/fail 2/.test(err.message), sleep: async () => { sleeps++; } }),
    (err) => err instanceof Error && !(err instanceof AggregateError) && err.message === "fail 2",
  );
  assert.equal(fn.calls(), 2);
  assert.equal(sleeps, 1);
});

test("onRetry(err, attempt, delayMs) fires before each sleep", async () => {
  const seen = [];
  await retry(flaky(2), { delayMs: 5, sleep: async () => {}, onRetry: (err, attempt, delay) => seen.push([err.message, attempt, delay]) });
  assert.deepEqual(seen, [["fail 1", 1, 5], ["fail 2", 2, 5]]);
});

test("attempts < 1 rejects with a RangeError before calling fn", async () => {
  let called = false;
  await assert.rejects(retry(async () => { called = true; }, { attempts: 0 }), RangeError);
  assert.equal(called, false);
});
`,
    },
    protectedFiles: ["tests/retry.test.mjs", "src/http.mjs", "src/backoff.mjs", "package.json"],
    allProbesRequired: true,
    probes: [
      { kind: "command", cmd: "node", args: ["--test", "tests/retry.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      // An unlisted edge the contract implies: attempts:1 never sleeps and
      // still reports the aggregate shape; the consumer module still works.
      { kind: "command", cmd: "node", args: ["-e", "Promise.all([import('./src/retry.mjs'),import('./src/http.mjs')]).then(async([{retry},{fetchJson}])=>{let sleeps=0;try{await retry(async()=>{throw new Error('x')},{attempts:1,sleep:async()=>{sleeps++}});process.exit(9)}catch(e){if(!(e instanceof AggregateError)||e.errors.length!==1||sleeps!==0)process.exit(8)}let n=0;const out=await fetchJson('u',{fetch:async()=>({status:n++<2?503:200,json:async()=>({ok:1})}),sleep:async()=>{}});if(out.ok!==1||n!==3)process.exit(7)})"], expectExit: 0, timeoutMs: 15_000 },
      { kind: "diffScope", allowed: ["src/retry.mjs"] },
    ],
    maxTurns: 48,
  },
  {
    id: "v5-ambiguous-spec-plan-first",
    title: "An ambiguous ticket: plan and ask before touching code",
    prompt:
      "Ticket 88 (docs/TICKET-88.md) asks for CSV export of \"the report\". Read it carefully: it contradicts itself about the delimiter and the header row, and never says which report. Do NOT guess, and do NOT change anything under src/ or tests/. Lay out your plan with the TodoWrite tool FIRST, then write docs/PLAN-88.md listing the open questions (one per line, each ending with '?') followed by the approach you would take once they are answered. Leave the code untouched until the questions are answered; you may run the existing tests to understand the current behavior.",
    files: {
      "package.json": PKG(),
      "docs/TICKET-88.md": crlf(
        "# TICKET-88: export the report as CSV",
        "",
        "Reporter (sales ops): We need to download the report as CSV so finance can",
        "open it in Excel. Please use semicolons, our Excel is set to EU locale.",
        "",
        "Comment (finance): Standard CSV please, comma separated, and DO include a",
        "header row so the columns are labelled.",
        "",
        "Comment (sales ops): No header row - the import tool chokes on it.",
        "",
        "Comment (PM): Just ship it, whichever report is easiest.",
      ),
      "src/report.mjs": `/** salesReport(rows) -> [{ sku, units, revenue }] aggregated per sku, sorted by sku. */
export function salesReport(rows) {
  const bySku = new Map();
  for (const row of rows) {
    const cur = bySku.get(row.sku) ?? { sku: row.sku, units: 0, revenue: 0 };
    cur.units += row.qty;
    cur.revenue += row.qty * row.price;
    bySku.set(row.sku, cur);
  }
  return [...bySku.values()].sort((a, b) => (a.sku < b.sku ? -1 : 1));
}

/** inventoryReport(stock) -> [{ sku, onHand }] sorted by sku. */
export function inventoryReport(stock) {
  return [...stock].map((s) => ({ sku: s.sku, onHand: s.onHand })).sort((a, b) => (a.sku < b.sku ? -1 : 1));
}
`,
      "src/export.mjs": `export function toJson(rows) {
  return JSON.stringify(rows);
}
`,
      "src/format.mjs": `export function money(n) {
  return "$" + n.toFixed(2);
}
`,
      "tests/report.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { salesReport, inventoryReport } from "../src/report.mjs";
import { toJson } from "../src/export.mjs";

test("sales report aggregates per sku", () => {
  const out = salesReport([{ sku: "B", qty: 1, price: 2 }, { sku: "A", qty: 2, price: 1.5 }, { sku: "B", qty: 3, price: 2 }]);
  assert.deepEqual(out, [{ sku: "A", units: 2, revenue: 3 }, { sku: "B", units: 4, revenue: 8 }]);
});

test("inventory report is sorted", () => {
  assert.deepEqual(inventoryReport([{ sku: "Z", onHand: 1 }, { sku: "A", onHand: 2 }]), [{ sku: "A", onHand: 2 }, { sku: "Z", onHand: 1 }]);
});

test("json export", () => {
  assert.equal(toJson([{ a: 1 }]), '[{"a":1}]');
});
`,
    },
    protectedFiles: ["docs/TICKET-88.md", "src/report.mjs", "src/export.mjs", "src/format.mjs", "tests/report.test.mjs", "package.json"],
    allProbesRequired: true,
    probes: [
      { kind: "planBeforeEdit" },
      { kind: "file", path: "docs/PLAN-88.md", contains: "?" },
      { kind: "file", path: "docs/PLAN-88.md", contains: "delimiter" },
      { kind: "command", cmd: "node", args: ["--test", "tests/report.test.mjs"], expectExit: 0, timeoutMs: 60_000 },
      // The only file that may change is the plan. Everything else changing
      // means the agent guessed.
      { kind: "diffScope", allowed: ["docs/PLAN-88.md"] },
    ],
    maxTurns: 32,
  },
];
