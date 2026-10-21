// "challenge me": a bundled python-challenge skill, routed deterministically
// (the skill catalog is deferred and the prompt has no room for a trigger), with
// short follow-ups ("done", "hint") kept in coaching mode while it is open.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { challengeReminder } from "../packages/cli/dist/entry/turnPipeline.js";
import { installBundledSkills } from "../packages/agent/dist/index.js";
import { SkillsListTool, SkillReadTool } from "../packages/tools/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.join(here, "..", "packages", "agent", "skills", "python-challenge");

test("challenge me starts coaching; follow-ups stay in it; other messages do not", () => {
  for (const start of ["challenge me", "Challenge me!", "ares, challenge me with something harder", "give me a python challenge", "give me another challenge", "next challenge"]) {
    const r = challengeReminder(start, false);
    assert.equal(r.active, true, start);
    assert.match(r.text, /SkillRead python-challenge/, start);
  }
  assert.deepEqual(challengeReminder("hint", false), { active: false }, "no challenge open: a bare hint is just a message");
  const follow = challengeReminder("done, here's my code", true);
  assert.equal(follow.active, true);
  assert.match(follow.text, /in progress/);
  assert.match(challengeReminder("check my code please", true).text, /never write their solution/);
  assert.deepEqual(challengeReminder("what's the weather", true), { active: true }, "unrelated chat keeps the challenge open without a reminder");
  assert.deepEqual(challengeReminder("stop the challenge", true), { active: false });
  assert.equal(challengeReminder("I challenge you to a duel", false).active, false);
});

test("the skill ships complete and installs where SkillRead finds it", async () => {
  const skill = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  for (const ref of skill.matchAll(/`references\/([a-z-]+\.md)`/g)) {
    assert.ok(existsSync(path.join(skillDir, "references", ref[1])), `references/${ref[1]} exists`);
  }
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-challenge-"));
  const previous = process.env.ARES_HOME;
  process.env.ARES_HOME = home;
  try {
    const installed = await installBundledSkills(path.join(home, "skills"), { only: ["python-challenge"] });
    assert.equal(installed[0]?.name, "python-challenge");
    const ctx = { workspace: home, signal: new AbortController().signal, permissionMode: "workspace-write" };
    const listed = await SkillsListTool.call({ query: "challenge" }, ctx);
    assert.ok(listed.output.skills.some((s) => s.name === "python-challenge" && /challenge me/.test(s.description)));
    const read = await SkillReadTool.call({ name: "python-challenge" }, ctx);
    assert.match(read.output.content, /never write their solution|You do not\s+write their solution/);
  } finally {
    if (previous === undefined) delete process.env.ARES_HOME; else process.env.ARES_HOME = previous;
    try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* the OS reaps temp */ }
  }
});
