// ToolSearch — discovery for the deferred tool tier.
//
// Keyword and `select:` forms, unknown names reported (not silently dropped),
// and the loaded set persisting on the session's DeferredToolRegistry in load
// order — the engine appends loaded tools to the catalog in exactly that order.

import test from "node:test";
import assert from "node:assert/strict";
import { makeToolSearchTool, DeferredToolRegistry, TOOL_SEARCH_DESCRIPTION } from "../packages/tools/dist/index.js";

const CATALOG = [
  { name: "Spotify", description: "Control Spotify playback: play a song, artist, album or playlist, pause, skip." },
  { name: "Gmail", description: "Read, search and send email through the owner's Gmail account." },
  { name: "Weather", description: "Current conditions and forecast for a location." },
  { name: "Deploy", description: "Publish a built site to hosting and return the live URL." },
  { name: "Remind", description: "Schedule a reminder or alarm for later." },
];

const ctxFor = (registry) => ({
  workspace: process.cwd(),
  sessionId: "s1",
  signal: new AbortController().signal,
  permissionMode: "workspace-write",
  fileReadStamps: new Map(),
  deferredTools: registry,
});

test("keyword search matches by description and marks the hit loaded on the context registry", async () => {
  const registry = new DeferredToolRegistry(CATALOG);
  const tool = makeToolSearchTool();
  const { output, display } = await tool.call({ query: "play some music" }, ctxFor(registry));
  assert.deepEqual(output.matches.map((m) => m.name), ["Spotify"]);
  assert.deepEqual(output.loaded, ["Spotify"]);
  assert.deepEqual([...registry.loaded()], ["Spotify"]);
  assert.match(display, /Loaded Spotify/);
});

test("select: form loads exact names, reports unknown ones, and the loaded set persists in load order", async () => {
  const registry = new DeferredToolRegistry(CATALOG);
  const tool = makeToolSearchTool();
  await tool.call({ query: "play some music" }, ctxFor(registry));
  const { output } = await tool.call({ query: "select:Weather, gmail, Nonesuch" }, ctxFor(registry));
  assert.deepEqual(output.matches.map((m) => m.name), ["Weather", "Gmail"]);
  assert.deepEqual(output.unknown, ["Nonesuch"]);
  assert.deepEqual(output.loaded, ["Spotify", "Weather", "Gmail"]);
  assert.ok(registry.isLoaded("weather"));
  // Re-loading is idempotent.
  await tool.call({ query: "select:Spotify" }, ctxFor(registry));
  assert.deepEqual([...registry.loaded()], ["Spotify", "Weather", "Gmail"]);
});

test("no match returns the available names so the next query can be exact", async () => {
  const registry = new DeferredToolRegistry(CATALOG);
  const tool = makeToolSearchTool();
  const { output } = await tool.call({ query: "zzqx" }, ctxFor(registry));
  assert.deepEqual(output.matches, []);
  assert.deepEqual(output.available, CATALOG.map((d) => d.name));
});

test("max_results caps keyword hits and the ranking is deterministic", async () => {
  const registry = new DeferredToolRegistry(CATALOG);
  const tool = makeToolSearchTool();
  const a = await tool.call({ query: "a song email forecast", max_results: 2 }, ctxFor(new DeferredToolRegistry(CATALOG)));
  const b = await tool.call({ query: "a song email forecast", max_results: 2 }, ctxFor(registry));
  assert.equal(a.output.matches.length, 2);
  assert.deepEqual(a.output.matches, b.output.matches);
});

test("without a context registry the tool falls back to registryFor / a per-session registry", async () => {
  const registry = new DeferredToolRegistry(CATALOG);
  const tool = makeToolSearchTool({ registryFor: () => registry });
  const ctx = ctxFor(undefined);
  delete ctx.deferredTools;
  const { output } = await tool.call({ query: "select:Deploy" }, ctx);
  assert.deepEqual(output.loaded, ["Deploy"]);
  assert.deepEqual([...registry.loaded()], ["Deploy"]);
});

test("the description names every deferred category so the model knows what exists", () => {
  for (const category of ["music", "email", "calendar", "payments", "deploy", "weather", "reminders", "Telegram", "MCP", "skills", "missions", "agent computer"]) {
    assert.match(TOOL_SEARCH_DESCRIPTION, new RegExp(category, "i"), `category ${category} listed`);
  }
});
