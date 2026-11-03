// The plain-English activity line (owner, 2026-10-20: "poeple shouldnt se
// tool calls... it should say like doing this, then after now im doing this"
// and "i hate not knowing what its doing turn stuck?"). The mapping table
// lives in @ares/protocol (the daemon stamps it on events as activityLine);
// the desktop folds events into a 3-line step history in tauri/src/activityLine.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { toolActivity, reminderActivity, activityLineFor, withRetryCountdown, modelFriendlyName } from "../packages/protocol/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function bundle(tmp, name, file) {
  const outfile = path.join(tmp, name);
  await esbuild({ entryPoints: [path.join(here, "..", "tauri", "src", ...file.split("/"))], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

test("tool calls map to plain words, never tool names or raw commands", () => {
  assert.equal(toolActivity("Read", { file_path: "D:\\games\\parkour.html" }).now, "Reading parkour.html");
  assert.equal(toolActivity("Read", { file_path: "/x/parkour.html" }).done, "Read parkour.html");
  assert.equal(toolActivity("Edit", { file_path: "src/a.ts" }).now, "Editing a.ts");
  assert.equal(toolActivity("Write", { file_path: "src/b.ts" }).done, "Wrote b.ts");
  assert.equal(toolActivity("Bash", { command: "pnpm test" }).now, "Running the tests");
  assert.equal(toolActivity("PowerShell", { command: "node --test tests/x.test.mjs" }).now, "Running the tests");
  assert.equal(toolActivity("Bash", { command: "npx tsc -b packages/core" }).now, "Building the project");
  assert.equal(toolActivity("Bash", { command: "npm install three" }).now, "Installing what it needs");
  assert.equal(toolActivity("Bash", { command: "git commit -m wip" }).now, "Saving the changes in git");
  assert.equal(toolActivity("Bash", { command: "git status --short" }).now, "Checking git");
  assert.equal(toolActivity("Bash", { command: "python scripts/make_map.py --big" }).now, "Running make_map.py");
  assert.equal(toolActivity("Bash", { command: "Remove-Item -Recurse foo; echo $x | sort" }).now, "Running a command");
  assert.equal(toolActivity("Bash", { command: "npm run dev", run_in_background: true }).now, "Starting a background process");
  assert.equal(toolActivity("WebSearch", { query: "best parkour games 2026" }).now, "Searching the web for best parkour games 2026");
  assert.equal(toolActivity("WebFetch", { url: "https://www.example.com/a/b?c=1" }).now, "Reading example.com");
  assert.equal(toolActivity("Grep", { pattern: "jumpHeight" }).now, "Searching the code for “jumpHeight”");
  assert.equal(toolActivity("Grep", { pattern: "foo\\(.*\\)\\s+bar" }).now, "Searching the code", "regex soup stays out of the line");
  assert.equal(toolActivity("Task", { description: "audit the save system" }).now, "A helper is on: audit the save system");
  assert.equal(toolActivity("Weather", {}).now, "Checking the weather");
  assert.equal(toolActivity("mcp_notion_search", {}).now, "Using notion");
  assert.equal(toolActivity("ComputerScreenshot", {}).now, "Using the computer");
  assert.equal(toolActivity("TodoWrite", { todos: [] }), null, "plumbing never gets a line");
  assert.equal(toolActivity("ToolSearch", {}), null);
  for (const name of ["Read", "Bash", "WebSearch", "Task", "SomethingNew"]) {
    const p = toolActivity(name, { command: "rm -rf / && curl evil", file_path: "x.txt", query: "q" });
    assert.doesNotMatch(p.now, /rm -rf|curl evil|[{}]/);
  }
});

test("provider waits read as waiting on someone, with a countdown", () => {
  const now = 1_000_000;
  const busy = reminderActivity("claude-opus-4-1 is overloaded upstream — retrying in 20.0s (attempt 1/6). Your message is safe.", "claude-opus-4-1", now);
  assert.equal(busy.now, "Waiting on Claude (overloaded)");
  assert.equal(busy.retryAt, now + 20_000);
  assert.equal(withRetryCountdown(busy.now, busy.retryAt, now + 2_000), "Waiting on Claude (overloaded, retrying in 18s)");
  assert.equal(withRetryCountdown(busy.now, busy.retryAt, now + 25_000), "Waiting on Claude (overloaded, retrying now)");
  assert.equal(reminderActivity("provider hiccup (http_429); retrying in 5.0s — attempt 1/4", "claude-sonnet-4", now).now, "Waiting on Claude (rate limited)");
  assert.equal(reminderActivity("Can't reach the model's server (fetch failed) — waiting for the connection, retrying in 3.0s (attempt 2/6).", "glm-5.2", now).now, "Waiting for the internet connection");
  assert.match(reminderActivity("Provider stalled 2 times at this prompt size; retrying with a smaller recent-history window (40,000 tokens).", "x", now).now, /Trimming this chat/);
  assert.equal(reminderActivity("Repository map: ...", "x", now), null);
  assert.equal(modelFriendlyName("deepseek-v4-pro"), "DeepSeek");
  assert.equal(modelFriendlyName(undefined), "the model");
});

test("the daemon stamps the same line on events for the phone and Telegram", () => {
  assert.equal(activityLineFor({ type: "tool_start", name: "Bash", input: { command: "pnpm test" } }), "Running the tests");
  assert.equal(activityLineFor({ type: "compaction", method: "summary" }), "Compacted memory of this chat");
  assert.equal(activityLineFor({ type: "compaction", method: "micro" }), undefined);
  assert.equal(activityLineFor({ type: "permission_request", toolName: "Bash", input: { command: "git push" } }), "Waiting for your OK: pushing to GitHub");
  assert.equal(activityLineFor({ type: "text_delta", text: "hi" }), undefined);
});

test("steps fold into 'Read x ✓ / Now running the tests' with merging, elapsed and stuck", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-activity-"));
  try {
    const A = await bundle(tmp, "activity.mjs", "activityLine.ts");
    const t0 = 5_000_000;
    let steps = A.foldActivity(undefined, { type: "turn_start" }, { nowMs: t0 });
    assert.deepEqual(A.activityView(steps, t0, t0).lines.map((l) => l.text), ["Getting ready"]);
    steps = A.foldActivity(steps, { type: "turn_phase", label: "recalling memory" }, { nowMs: t0 + 100, preparing: true, busy: true });
    assert.equal(A.activityView(steps, t0 + 100, t0 + 100).lines[0].text, "Recalling memory");
    steps = A.foldActivity(steps, { type: "provider_attempt_started", attemptId: "a" }, { nowMs: t0 + 200, busy: true });
    steps = A.foldActivity(steps, { type: "thinking_delta", text: "hm" }, { nowMs: t0 + 300, busy: true });
    assert.deepEqual(A.activityView(steps, t0 + 300, t0 + 300).lines.map((l) => l.text), ["Thinking"]);

    // Read → done, then the tests: "Read parkour.html ✓ / Now running the tests".
    steps = A.foldActivity(steps, { type: "tool_start", id: "t1", name: "Read", input: { file_path: "C:/g/parkour.html" } }, { nowMs: t0 + 1_000, busy: true });
    steps = A.foldActivity(steps, { type: "tool_end", id: "t1" }, { nowMs: t0 + 1_500, busy: true });
    steps = A.foldActivity(steps, { type: "provider_attempt_started", attemptId: "b" }, { nowMs: t0 + 1_600, busy: true });
    steps = A.foldActivity(steps, { type: "tool_start", id: "t2", name: "Bash", input: { command: "npm test" } }, { nowMs: t0 + 2_000, busy: true });
    let view = A.activityView(steps, t0 + 5_000, t0 + 5_000);
    assert.deepEqual(view.lines.map((l) => [l.text, l.done]), [["Read parkour.html", true], ["Now running the tests", false]]);
    assert.equal(view.lines[1].elapsed, undefined, "no clock under 10s");
    view = A.activityView(steps, t0 + 16_000, t0 + 15_000);
    assert.equal(view.lines[1].elapsed, "14s", "per-step clock once past 10s");
    assert.equal(view.stuck, false);

    // A minute of silence: "Still on: running the tests (1m 20s)" + Stop offered.
    view = A.activityView(steps, t0 + 82_000, t0 + 2_000);
    assert.equal(view.stuck, true);
    assert.equal(view.lines.at(-1).text, "Still on: running the tests (1m 20s)");

    // Back-to-back edits merge: "Editing 3 files" → "Edited 3 files".
    steps = A.foldActivity(steps, { type: "tool_end", id: "t2" }, { nowMs: t0 + 90_000, busy: true });
    for (const [i, f] of ["a.ts", "b.ts", "c.ts"].entries()) {
      steps = A.foldActivity(steps, { type: "tool_start", id: `e${i}`, name: "Edit", input: { file_path: `src/${f}` } }, { nowMs: t0 + 91_000 + i, busy: true });
      if (i < 2) steps = A.foldActivity(steps, { type: "tool_end", id: `e${i}` }, { nowMs: t0 + 91_500 + i, busy: true });
    }
    view = A.activityView(steps, t0 + 92_000, t0 + 92_000);
    assert.deepEqual(view.lines.map((l) => l.text), ["Read parkour.html", "Ran the tests", "Now editing 3 files"]);
    steps = A.foldActivity(steps, { type: "tool_end", id: "e2" }, { nowMs: t0 + 93_000, busy: true });
    // Never more than three lines: the oldest falls off.
    steps = A.foldActivity(steps, { type: "tool_start", id: "w", name: "WebSearch", input: { query: "jump arcs" } }, { nowMs: t0 + 94_000, busy: true });
    view = A.activityView(steps, t0 + 94_000, t0 + 94_000);
    assert.deepEqual(view.lines.map((l) => l.text), ["Ran the tests", "Edited 3 files", "Now searching the web for jump arcs"]);
    assert.equal(A.jobLine(steps, true), "Searching the web for jump arcs");
    assert.equal(A.jobLine(steps, false), undefined);

    // Plumbing tools leave no trace; a rate-limit wait counts down; the turn's end clears it all.
    steps = A.foldActivity(steps, { type: "tool_end", id: "w" }, { nowMs: t0 + 95_000, busy: true });
    steps = A.foldActivity(steps, { type: "tool_start", id: "td", name: "TodoWrite", input: {} }, { nowMs: t0 + 95_100, busy: true });
    steps = A.foldActivity(steps, { type: "system_reminder_injected", text: "provider hiccup (http_429); retrying in 20.0s — attempt 1/4" }, { nowMs: t0 + 96_000, model: "claude-opus-4-1", busy: true });
    view = A.activityView(steps, t0 + 96_000, t0 + 96_000);
    assert.equal(view.lines.at(-1).text, "Now waiting on Claude (rate limited, retrying in 20s)");
    steps = A.foldActivity(steps, { type: "turn_end", status: "completed" }, { nowMs: t0 + 97_000, busy: true });
    assert.equal(A.activityView(steps, t0 + 97_000, t0 + 97_000).lines.at(-1).text, "Now wrapping up");
    steps = A.foldActivity(steps, { type: "turn_settled" }, { nowMs: t0 + 98_000, busy: true });
    assert.equal(steps, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a drafting Write names its file as soon as the path streams in, and foldEvent carries the steps", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-activity-fold-"));
  try {
    const { foldEvent } = await bundle(tmp, "fold.mjs", "state/foldEvent.ts");
    let s = { id: "s", title: "t", items: [], busy: false, workflowMode: "build", tokensIn: 0, cacheReadTokens: 0, tokensOut: 0, todos: [], steerQueued: 0 };
    s = foldEvent(s, { type: "turn_start" });
    s = foldEvent(s, { type: "provider_attempt_started", attemptId: "a" });
    s = foldEvent(s, { type: "tool_use_start", id: "w1", name: "Write" });
    assert.equal(s.activitySteps.at(-1).now, "Writing a file");
    s = foldEvent(s, { type: "tool_use_input_delta", id: "w1", deltaJson: "{\"file_path\":\"D:/g/parkour.html\",\"content\":\"<h" });
    assert.equal(s.activitySteps.at(-1).now, "Writing parkour.html");
    s = foldEvent(s, { type: "tool_start", id: "w1", name: "Write", input: { file_path: "D:/g/parkour.html", content: "<html>" } });
    assert.equal(s.activitySteps.filter((x) => !x.transient).length, 1, "the draft became the running step, not a second line");
    s = foldEvent(s, { type: "tool_end", id: "w1", output: {}, durationMs: 5 });
    s = foldEvent(s, { type: "compaction", method: "summary", summarizedMessages: 4, tokensBefore: 90000, tokensAfter: 20000 });
    assert.deepEqual(s.activitySteps.map((x) => x.done), ["Wrote parkour.html", "Compacted memory of this chat"]);
    s = foldEvent(s, { type: "interrupt_settled" });
    assert.equal(s.activitySteps, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
