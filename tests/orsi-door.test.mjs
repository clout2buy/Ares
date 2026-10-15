import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { composeSystemPrompt } from "../packages/cli/dist/entry/prompt/index.js";
import { currentRules, evolvedRulesBlock, DEFAULT_RULES, genomePath } from "../packages/cli/dist/entry/orsiOverlay.js";
import { TurnCollector, doorConfig } from "../packages/cli/dist/entry/orsiDoor.js";

test("the evolved rules ride the prompt after the laws and before the tool doctrine", () => {
  const prompt = composeSystemPrompt({
    laws: "## LAWS\nnever X",
    evolved: evolvedRulesBlock("Read before you edit."),
    surfaces: { tools: "## TOOLS\nt", workflows: "", environment: "## ENV\ne" },
  });
  const laws = prompt.indexOf("## LAWS"), rules = prompt.indexOf("## Operating rules"), tools = prompt.indexOf("## TOOLS");
  assert.ok(laws >= 0 && rules > laws && tools > rules, prompt);
  assert.equal(evolvedRulesBlock("   "), "");
});

test("currentRules is the seed without a genome file and the evolved text with one (mtime-cached)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orsi-overlay-"));
  assert.equal(currentRules(home), DEFAULT_RULES);
  await fs.writeFile(genomePath(home), JSON.stringify({ genome: { rules: "Act, then verify." } }));
  assert.equal(currentRules(home), "Act, then verify.");
  await fs.writeFile(genomePath(home), JSON.stringify({ genome: {} }));
  const later = new Date(Date.now() + 5000);
  await fs.utimes(genomePath(home), later, later);
  assert.equal(currentRules(home), DEFAULT_RULES);
  await fs.writeFile(genomePath(home), "not json");
  await fs.utimes(genomePath(home), new Date(Date.now() + 9000), new Date(Date.now() + 9000));
  assert.equal(currentRules(home), DEFAULT_RULES);
});

test("TurnCollector turns engine events into the door's trace shape; doorConfig is a no-op without env", () => {
  const c = new TurnCollector("fix the bug");
  c.observe({ type: "tool_start", id: "1", name: "Read", input: { path: "a.ts" } });
  c.observe({ type: "tool_end", id: "1", output: "contents" });
  c.observe({ type: "tool_start", id: "2", name: "Shell", input: { cmd: "npm test" } });
  c.observe({ type: "tool_error", id: "2", error: "ENOENT" });
  c.observe({ type: "text_delta", text: "done" });
  c.observe({ type: "turn_end", status: "completed", usage: { inputTokens: 10, outputTokens: 5 } });
  const r = c.report();
  assert.deepEqual(r.trace, [
    { call: "Read", args: { path: "a.ts" } }, { result: "contents" },
    { call: "Shell", args: { cmd: "npm test" } }, { result: "error: ENOENT" },
  ]);
  assert.equal(r.reply, "done");
  assert.equal(r.status, "completed");
  assert.equal(r.tokens, 15);
  assert.equal(doorConfig({}), null);
  assert.deepEqual(doorConfig({ ORSI_DOOR: "https://d/", ORSI_TOKEN: "t" }), { door: "https://d", token: "t" });
});

test("membership file joins the door without env; env wins; leave removes it", async () => {
  const { doorConfig, membershipPath, readMembership, leave } = await import("../packages/cli/dist/entry/orsiDoor.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orsi-member-"));
  assert.equal(doorConfig({}, home), null);
  await fs.writeFile(membershipPath(home), JSON.stringify({ door: "https://d/", token: "t1", agent: "ares-x", fleet: "ares", install_id: "i", joined_at: "now", consent: true }));
  assert.deepEqual(doorConfig({}, home), { door: "https://d", token: "t1" });
  assert.equal(readMembership(home).agent, "ares-x");
  assert.deepEqual(doorConfig({ ORSI_DOOR: "https://env", ORSI_TOKEN: "e" }, home), { door: "https://env", token: "e" });
  await fs.writeFile(membershipPath(home), JSON.stringify({ door: "https://d/", token: "t1", consent: false }));
  assert.equal(doorConfig({}, home), null, "no consent, no door");
  assert.equal(await leave(home), true);
  assert.equal(readMembership(home), null);
});

test("a new genome version fires onLearned with the rules; same version is silent", async () => {
  const { refreshGenome, onLearned } = await import("../packages/cli/dist/entry/orsiDoor.js");
  const { genomePath } = await import("../packages/cli/dist/entry/orsiOverlay.js");
  const http = await import("node:http");
  let payload = { genome: { rules: "Act, then verify." }, version: "v1" };
  const srv = http.createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(payload)); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const cfg = { door: `http://127.0.0.1:${srv.address().port}`, token: "t" };
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orsi-learn-"));
  const heard = [];
  const off = onLearned((l) => heard.push(l));
  try {
    await refreshGenome(cfg, home);                       // first fetch: nothing to compare against
    await refreshGenome(cfg, home);                       // same version: silent
    assert.equal(heard.length, 0);
    payload = { genome: { rules: "Read back after writing." }, version: "v2", proposal: "p2" };
    await refreshGenome(cfg, home);
    assert.deepEqual(heard, [{ version: "v2", proposal: "p2", rules: "Read back after writing." }]);
    assert.equal(JSON.parse(await fs.readFile(genomePath(home), "utf8")).version, "v2");
  } finally {
    off();
    srv.close();
  }
});
