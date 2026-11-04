// Field report, 2026-11-03: a tester could not approve a prompt, and typing
// "bug report" sent them to a third-party sign-in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { catalogMentions } from "../packages/core/dist/index.js";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("describing a bug does not offer the Jam connector, naming Jam does", () => {
  for (const text of ["let's file a bug report", "can you repro this"]) {
    assert.deepEqual(catalogMentions(text).map((e) => e.id), []);
  }
  assert.deepEqual(catalogMentions("connect jam please").map((e) => e.id), ["jam"]);
});

test("the Now screen sends a decision the desktop shell accepts", () => {
  const view = source("tauri/src/messagesViews.tsx");
  assert.match(view, /ask\.id, "allow_once"\)\}>Allow</);
  assert.doesNotMatch(view, /ask\.id, "allow"\)/);
  assert.match(source("tauri/src-tauri/src/main.rs"), /"allow_once" \| "allow_always" \| "deny"/);
});

test("the light surface overrides the dark approval button", () => {
  assert.match(source("tauri/src/glass.css"), /\.nowAsk \{\s*background: rgba\(255/);
  assert.match(source("tauri/src/modern.css"), /\.gateAllow \{[^}]*!important/);
  assert.match(source("tauri/src/glass.css"), /\.gateAllow:hover \{\s*background: var\(--g-orange\) !important/);
});

test("Report a bug is reachable without knowing a slash command", () => {
  assert.match(source("tauri/src/shell.tsx"), /aria-label="Report a bug"/);
  assert.match(source("tauri/src/App.tsx"), /label: "Report a bug", hint: "\/bug/);
});
