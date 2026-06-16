// Verifies mission/project state packets — durable, compact "war map" memory
// that feeds the ContextCompiler's project tier without dumping logs.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadMissionState,
  saveMissionState,
  loadProjectState,
  saveProjectState,
  missionFragments,
  renderProjectFragment,
  renderMissionFragment,
  inferProjectId,
  safeProjectId,
  stateDir,
  defaultAresProject,
  defaultAresMission,
  compileContext,
  estimateTokensDefault,
} from "../packages/mind/dist/index.js";

const makeHome = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-v28-"));

// ── Compact rendering, under budget ───────────────────────────────────────────

test("project packet renders compactly (a briefing, not a JSON dump)", () => {
  const frag = renderProjectFragment(defaultAresProject());
  assert.equal(frag.tier, "project");
  assert.equal(frag.project, "ares", "tagged so the compiler can gate it");
  assert.ok(estimateTokensDefault(frag.content) < 400, `the war map is a dagger, not a landfill (${estimateTokensDefault(frag.content)}t)`);
  assert.match(frag.content, /github\.com\/clout2buy\/Ares/);
  assert.match(frag.content, /god-of-war/i, "carries the blunt command stance");
});

test("mission packet is procedural commander's intent, compact", () => {
  const frag = renderMissionFragment(defaultAresMission());
  assert.equal(frag.tier, "procedural", "doctrine is universal — not project-gated");
  assert.equal(frag.project, undefined);
  assert.ok(estimateTokensDefault(frag.content) < 400);
  assert.match(frag.content, /Verify before fixing/i);
  assert.match(frag.content, /MrDoing/);
});

// ── Inference / id safety ─────────────────────────────────────────────────────

test("inferProjectId derives a stable id from a repo URL or path", () => {
  assert.equal(inferProjectId({ repo: "https://github.com/clout2buy/Ares" }), "ares");
  assert.equal(inferProjectId({ repo: "git@github.com:clout2buy/Ares.git" }), "ares");
  assert.equal(inferProjectId({ path: "/home/n/Projects/MyApp/" }), "myapp");
  assert.equal(safeProjectId("Weird/Name *!"), "weird-name");
});

// ── The Ares packet is gated by the active project ────────────────────────────

test("an Ares task gets the Ares war map; an unrelated task does not", async () => {
  const onAres = await missionFragments({ activeProject: "ares" });
  assert.ok(onAres.some((f) => f.tier === "project" && /clout2buy\/Ares/.test(f.content)), "Ares packet present for the ares project");

  // The compiler is what actually gates it by active project.
  const inclAres = compileContext({ userMessage: "what's next on ares", activeProject: "ares", tokenBudget: 4000, fragments: onAres });
  assert.ok(inclAres.included.some((f) => f.tier === "project"), "Ares war map injected for an Ares task");

  const inclDinner = compileContext({ userMessage: "what should I cook", activeProject: "cooking", tokenBudget: 4000, fragments: onAres });
  assert.ok(!inclDinner.text.includes("clout2buy/Ares"), "Ares repo history stays OUT of an unrelated task");
});

test("an unrelated project id yields no project packet (only ares has a default)", async () => {
  const frags = await missionFragments({ activeProject: "some-random-app" });
  assert.ok(!frags.some((f) => f.tier === "project"), "no shipped default for an unknown project");
  assert.ok(frags.some((f) => f.source === "mission"), "but the mission doctrine is always there");
});

// ── Tier priority under budget ────────────────────────────────────────────────

test("the project war map survives before semantic/recent under budget pressure", () => {
  const project = renderProjectFragment(defaultAresProject());
  const fragments = [
    project,
    { tier: "semantic", content: "a tangential fact ".repeat(30) },
    { tier: "recent", content: "old chatter ".repeat(40) },
  ];
  const budget = estimateTokensDefault(project.content) + 10; // room for ~the project map only
  const packet = compileContext({ userMessage: "work on ares", activeProject: "ares", tokenBudget: budget, fragments });
  assert.ok(packet.included.some((f) => f.tier === "project"), "project map kept");
  assert.ok(!packet.included.some((f) => f.tier === "recent"), "recent chatter cut first");
});

// ── Save / load round-trip + schema ───────────────────────────────────────────

test("project state save/load round-trips and preserves the schema", async () => {
  const home = await makeHome();
  const state = {
    schemaVersion: 1,
    projectId: "myproj",
    name: "MyProj",
    repo: "https://example.com/x/myproj",
    pillars: { coding: "ok", memory: "wip" },
    nextActions: ["ship it"],
  };
  await saveProjectState(state, home);
  const loaded = await loadProjectState("myproj", home);
  assert.equal(loaded.name, "MyProj");
  assert.equal(loaded.schemaVersion, 1);
  assert.deepEqual(loaded.pillars, { coding: "ok", memory: "wip" });
  assert.deepEqual(loaded.nextActions, ["ship it"]);
});

test("mission state save/load round-trips", async () => {
  const home = await makeHome();
  const mission = { ...defaultAresMission(), currentCampaign: "a custom campaign" };
  await saveMissionState(mission, home);
  const loaded = await loadMissionState(home);
  assert.equal(loaded.currentCampaign, "a custom campaign");
  assert.equal(loaded.schemaVersion, 1);
});

// ── Graceful degradation ──────────────────────────────────────────────────────

test("a missing project packet returns null; a missing mission returns the default", async () => {
  const home = await makeHome();
  assert.equal(await loadProjectState("ghost", home), null);
  const mission = await loadMissionState(home);
  assert.equal(mission.name, "Ares Prime Mission", "no file → shipped default, no throw");
});

test("a corrupt packet degrades gracefully instead of throwing", async () => {
  const home = await makeHome();
  await fs.mkdir(stateDir(home), { recursive: true });
  await fs.writeFile(path.join(stateDir(home), "mission.json"), "{ this is not json", "utf8");
  await fs.mkdir(path.join(stateDir(home), "projects"), { recursive: true });
  await fs.writeFile(path.join(stateDir(home), "projects", "ares.json"), "<<broken>>", "utf8");
  const mission = await loadMissionState(home);
  assert.equal(mission.name, "Ares Prime Mission", "corrupt mission → default");
  const project = await loadProjectState("ares", home);
  assert.equal(project.name, "Ares", "corrupt ares packet → shipped default");
});

// ── Token budget is honored end-to-end ────────────────────────────────────────

test("mission + project fragments stay under a tight compiler budget", async () => {
  const frags = await missionFragments({ activeProject: "ares" });
  const packet = compileContext({ userMessage: "work", activeProject: "ares", tokenBudget: 300, fragments: frags });
  assert.ok(packet.tokens <= 300, `packet honors the budget (${packet.tokens} <= 300)`);
});
