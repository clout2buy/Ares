// Shortcuts as skills. Pinned here:
//   1. The library: sanitizing, strict vs lenient, alias uniqueness, opt-out sensitivity.
//   2. Resolution: "run my bedtime routine" -> the exact Shortcut; never a guess between two.
//   3. The iPhone tool: aliases in the description / status / shortcuts, alias -> exact
//      name before anything is sent, sensitive = per-call owner decision, only an
//      explicitly routine Shortcut rides the lighter class, runs are recorded + audited.
//   4. The policy gate (what "Hey Siri, ask Ares to run <alias>" goes through).
//   5. Proposals: the documented step subset, the recipe, the unsigned plist, honest limits.
//   6. The HTTP routes through a REAL RemoteAgentServer behind the owner bearer.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DeviceBridge } from "../packages/garrison/dist/index.js";
import {
  IPhoneTool,
  ShortcutDirectory,
  ShortcutValidationError,
  aliasKey,
  buildProposal,
  buildShortcutFile,
  encodeBplist,
  PlistReal,
  resolveShortcut,
  sanitizeShortcutList,
  setDeviceBridge,
  setShortcutDirectory,
  shortcutsPromptLine,
} from "../packages/tools/dist/index.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { createShortcutsApi } from "../packages/cli/dist/phoneShortcuts.js";
import { classifyToolRequest, remoteAutonomyDecision } from "../packages/cli/dist/policyGate.js";

const OWNER = "owner-tok";
const toolCtx = (over = {}) => ({ workspace: "/w", sessionId: "s1", signal: new AbortController().signal, permissionMode: "workspace-write", fileReadStamps: new Map(), ...over });
const cap = (id, risk = "read") => ({ id, enabled: true, permission: "granted", risk, description: `${id} desc` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIBRARY = [
  { name: "Good Night", alias: "bedtime routine", whenToUse: "when the owner is winding down for sleep", sensitive: false },
  { name: "Send ETA", alias: "tell her I'm late", whenToUse: "text a running-late note", acceptsInput: true },
  { name: "Lock House", alias: "lock up", sensitive: true },
  { name: "Morning", alias: "morning routine", sensitive: false },
  { name: "Focus Work" },
];

async function tempDir(t) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-shortcuts-"));
  t.after(() => fsp.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  return d;
}

/** A directory with the library synced for phone "ph1", a bridge with that phone, and an audit log; torn down with the test. */
async function rig(t, { shortcuts = LIBRARY, install = true } = {}) {
  const dir = await tempDir(t);
  const audits = [];
  const directory = new ShortcutDirectory(path.join(dir, "device", "shortcuts.json"), { audit: (e) => audits.push(e) });
  await directory.load();
  if (shortcuts) await directory.put("ph1", sanitizeShortcutList(shortcuts));
  const bridge = new DeviceBridge({ audit: () => {}, isPaused: () => false });
  const sent = [];
  assert.equal(bridge.hello("c1", (f) => sent.push(f), { device: { id: "ph1", name: "Rook phone" }, capabilities: [cap("device.info"), cap("shortcut.run", "sensitive"), cap("calendar.list_events")] }), null);
  if (install) {
    setDeviceBridge(bridge);
    setShortcutDirectory(directory);
    t.after(() => { setDeviceBridge(null); setShortcutDirectory(null); });
  }
  return { dir, directory, bridge, sent, audits };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. the library
// ═════════════════════════════════════════════════════════════════════════════

test("sanitizeShortcutList: lenient drops junk and repeats; strict names the problem", () => {
  const raw = [
    { name: "  Good   Night ", alias: "Bedtime Routine!", whenToUse: "sleep", sensitive: false, acceptsInput: true, extra: "ignored" },
    { name: "good night" },
    { name: "Other", alias: "bedtime routine" },
    { name: "" },
    { nope: 1 },
    null,
    { name: "x".repeat(101) },
    { name: "Ctl" + String.fromCharCode(0) + "Name", alias: "   " },
  ];
  const out = sanitizeShortcutList(raw);
  assert.deepEqual(out, [
    { name: "Good Night", alias: "Bedtime Routine!", whenToUse: "sleep", acceptsInput: true, sensitive: false },
    { name: "Other" },
    { name: "Ctl Name" },
  ]);
  assert.throws(() => sanitizeShortcutList(raw, { strict: true }), ShortcutValidationError);
  assert.throws(() => sanitizeShortcutList([{ name: "A", alias: "go" }, { name: "B", alias: "Go!" }], { strict: true }), /alias "Go!" is used by both "A" and "B"/);
  assert.throws(() => sanitizeShortcutList([{ name: "A" }, { name: "a" }], { strict: true }), /two Shortcuts are named/);
  assert.throws(() => sanitizeShortcutList("nope", { strict: true }), /array/);
  assert.equal(aliasKey("Bedtime  Routine!"), aliasKey("bedtime routine"));
});

test("the device bridge keeps alias, whenToUse and sensitive from the live hello, and nothing else", () => {
  const bridge = new DeviceBridge({ audit: () => {}, isPaused: () => false });
  bridge.hello("c", () => {}, { device: { id: "ph1", name: "P" }, capabilities: [], shortcuts: [{ name: "A", alias: "alpha", whenToUse: "w", sensitive: false, acceptsInput: true, evil: "x" }, { name: "B", sensitive: "yes" }] });
  assert.deepEqual(bridge.list()[0].shortcuts, [{ name: "A", acceptsInput: true, alias: "alpha", whenToUse: "w", sensitive: false }, { name: "B" }]);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. resolution
// ═════════════════════════════════════════════════════════════════════════════

test("resolveShortcut: exact name, exact alias, filler words, partial words, ambiguity, nothing", () => {
  const lib = sanitizeShortcutList(LIBRARY);
  const pick = (said) => resolveShortcut(lib, said);
  assert.deepEqual([pick("Good Night").kind, pick("Good Night").via], ["match", "name"]);
  assert.equal(pick("good night").shortcut.name, "Good Night");
  assert.deepEqual([pick("bedtime routine").shortcut.name, pick("bedtime routine").via], ["Good Night", "alias"]);
  assert.equal(pick("my bedtime routine").shortcut.name, "Good Night", "'my' is not part of the name");
  assert.equal(pick("run the Bedtime Routine shortcut please").shortcut.name, "Good Night");
  assert.equal(pick("Bedtime-Routine!").shortcut.name, "Good Night");
  assert.equal(pick("lock up").shortcut.name, "Lock House");
  assert.equal(pick("bedtime").shortcut.name, "Good Night", "one word of a unique alias is enough when nothing else fits");
  assert.equal(pick("tell her i'm late").shortcut.name, "Send ETA");

  const amb = pick("routine");
  assert.equal(amb.kind, "ambiguous", "two aliases contain 'routine': never a guess");
  assert.deepEqual(amb.candidates.map((c) => c.name).sort(), ["Good Night", "Morning"]);
  const none = pick("launch the missiles");
  assert.equal(none.kind, "none");
  assert.equal(resolveShortcut(lib, "").kind, "none");
  assert.equal(resolveShortcut([], "anything").kind, "none");
});

test("shortcutsPromptLine: aliases first, capped, says who asks", () => {
  const line = shortcutsPromptLine(sanitizeShortcutList(LIBRARY));
  assert.match(line, /"bedtime routine" -> Good Night \(use when: when the owner is winding down for sleep; routine\)/);
  assert.match(line, /"lock up" -> Lock House \(asks the owner every time\)/);
  assert.ok(line.indexOf("bedtime routine") < line.indexOf("Focus Work"), "aliased Shortcuts lead");
  const many = Array.from({ length: 80 }, (_, i) => ({ name: `Shortcut number ${i}`, alias: `alias number ${i}`, whenToUse: "x".repeat(60) }));
  assert.ok(shortcutsPromptLine(sanitizeShortcutList(many)).length < 1500);
  assert.equal(shortcutsPromptLine([]), "");
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. the iPhone tool
// ═════════════════════════════════════════════════════════════════════════════

test("tool: the description, status and shortcuts all carry the aliases", async (t) => {
  await rig(t);
  assert.match(IPhoneTool.schema.description, /"bedtime routine" -> Good Night/);
  assert.match(IPhoneTool.schema.description, /propose_shortcut/);
  const status = await IPhoneTool.call({ action: "status" }, toolCtx());
  assert.match(status.output.message, /Shortcuts: 5 in the owner's library \(aliases: "bedtime routine" -> Good Night/);
  const list = await IPhoneTool.call({ action: "shortcuts" }, toolCtx());
  assert.equal(list.output.shortcuts.length, 5);
  assert.match(list.output.message, /"bedtime routine" -> Good Night — use when: when the owner is winding down for sleep \[routine\]/);
  assert.match(list.output.message, /"lock up" -> Lock House \[asks every time\]/);
  assert.match(list.output.message, /Focus Work \[asks every time\]/, "unmarked = sensitive");
  setShortcutDirectory(null);
  assert.doesNotMatch(IPhoneTool.schema.description, /"bedtime routine" -> Good Night/, "the description follows the live library");
});

test("tool: invoke resolves the owner's words to the exact name BEFORE sending, and records the run", async (t) => {
  const r = await rig(t);
  const pr = IPhoneTool.call({ action: "invoke", capability: "shortcut.run", args: { name: "my bedtime routine" }, reason: "Run the bedtime routine" }, toolCtx());
  for (let i = 0; i < 100 && r.sent.length < 1; i++) await sleep(5);
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0].args, { name: "Good Night" }, "the phone only ever sees the exact name");
  r.bridge.response("c1", { id: r.sent[0].id, ok: true, result: { ran: "Good Night", result: "lights off" } });
  const out = await pr;
  assert.equal(out.failure, undefined);
  const lib = r.directory.get("ph1").shortcuts.find((s) => s.name === "Good Night");
  assert.equal(lib.lastRun.outcome, "ok");
  assert.equal(lib.lastRun.actor, "ares");
  assert.equal(lib.lastRun.summary, "lights off");
  assert.equal(r.directory.history(5)[0].name, "Good Night");
  assert.ok(r.audits.some((a) => a.action === "iPhone.shortcut.run" && a.actor === "ares" && a.target === "Good Night" && a.result === "ok"), "the run is audited");
});

test("tool: an ambiguous phrase is refused with the candidates, nothing is sent", async (t) => {
  const r = await rig(t);
  const out = await IPhoneTool.call({ action: "invoke", capability: "shortcut.run", args: { name: "routine" } }, toolCtx());
  assert.match(out.failure, /^invalid_args: more than one Shortcut fits "routine"/);
  assert.match(out.failure, /"bedtime routine" \(Good Night\)/);
  assert.match(out.failure, /Ask the owner which one/);
  assert.equal(r.sent.length, 0);
});

test("tool: a failed run is recorded as such; the phone's own error text is kept", async (t) => {
  const r = await rig(t);
  const pr = IPhoneTool.call({ action: "invoke", capability: "shortcut.run", args: { name: "lock up" } }, toolCtx());
  for (let i = 0; i < 100 && r.sent.length < 1; i++) await sleep(5);
  r.bridge.response("c1", { id: r.sent[0].id, ok: false, error: { code: "declined_by_owner", message: "The owner declined this request." } });
  const out = await pr;
  assert.match(out.failure, /declined_by_owner/);
  assert.equal(r.directory.history(1)[0].outcome, "declined");
  assert.ok(r.audits.some((a) => a.result === "error: declined"));
});

test("permissions: sensitive and unknown Shortcuts are a per-call owner decision; only an explicitly routine one is lighter", async (t) => {
  await rig(t);
  const check = (name, extra = {}) => IPhoneTool.checkPermissions({ action: "invoke", capability: "shortcut.run", args: { name }, ...extra }, toolCtx());
  const sensitive = await check("lock up");
  assert.equal(sensitive.kind, "ask");
  assert.equal(sensitive.ownerDecision, true);
  assert.match(sensitive.prompt, /Lock House/, "the prompt names the exact Shortcut");
  const unmarked = await check("Focus Work");
  assert.equal(unmarked.ownerDecision, true, "unmarked is sensitive");
  const unknown = await check("something that is not there");
  assert.equal(unknown.ownerDecision, true, "unknown is sensitive");
  const routine = await check("bedtime routine", { reason: "Run the bedtime routine" });
  assert.equal(routine.kind, "ask");
  assert.ok(!routine.ownerDecision, "routine rides the standing-grant class");
  assert.match(routine.prompt, /Good Night/);
  const ambiguous = await check("routine");
  assert.equal(ambiguous.ownerDecision, true, "two candidates never get the light class");
  const bypass = await IPhoneTool.checkPermissions({ action: "invoke", capability: "shortcut.run", args: { name: "lock up" } }, toolCtx({ permissionMode: "bypass" }));
  assert.equal(bypass.ownerDecision, true, "even bypass mode cannot silence a sensitive Shortcut");
  const guest = await IPhoneTool.checkPermissions({ action: "shortcuts" }, toolCtx({ sessionId: "guest" }));
  assert.equal(guest.kind, "allow", "ownership is enforced by the bridge in call()");
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. the policy gate (Siri / Ask goes through exactly this)
// ═════════════════════════════════════════════════════════════════════════════

test("gate: classification and the remote-autonomy decision for shortcut.run", async (t) => {
  await rig(t);
  const req = (action, args, ownerDecision) => ({ toolName: "iPhone", reason: "r", input: { action, ...(args ? { capability: "shortcut.run", args } : {}) }, ...(ownerDecision ? { ownerDecision: true } : {}) });
  assert.equal(classifyToolRequest(req("shortcuts")), null, "listing changes nothing");
  assert.equal(classifyToolRequest(req("status")), null);
  assert.equal(classifyToolRequest({ toolName: "iPhone", reason: "r", input: { action: "propose_shortcut", proposal: {} } }), null, "a proposal changes nothing on the phone");
  assert.equal(classifyToolRequest(req("invoke", { name: "lock up" })), "browser_submit");
  assert.equal(classifyToolRequest(req("invoke", { name: "Focus Work" })), "browser_submit", "unmarked");
  assert.equal(classifyToolRequest(req("invoke", { name: "unknown thing" })), "browser_submit");
  assert.equal(classifyToolRequest(req("invoke", { name: "routine" })), "browser_submit", "ambiguous");
  assert.equal(classifyToolRequest(req("invoke", { name: "bedtime routine" })), null, "an explicitly routine Shortcut is not escalated by the box");
  assert.equal(classifyToolRequest({ toolName: "iPhone", reason: "r", input: { action: "invoke", capability: "url.open", args: { url: "https://x.y" } } }), "browser_submit");

  // What a voice ask ("Hey Siri, ask Ares to run lock up") does with that: ask the owner's phone.
  assert.equal(remoteAutonomyDecision(req("invoke", { name: "lock up" }, true)), "ask");
  assert.equal(remoteAutonomyDecision(req("invoke", { name: "lock up" })), "ask");
  assert.equal(remoteAutonomyDecision(req("invoke", { name: "bedtime routine" })), "allow", "routine runs hands-free from the box's side");
  assert.equal(remoteAutonomyDecision(req("shortcuts")), "allow");
  setShortcutDirectory(null);
  assert.equal(classifyToolRequest(req("invoke", { name: "bedtime routine" })), "browser_submit", "with no library synced everything is sensitive");
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. proposals
// ═════════════════════════════════════════════════════════════════════════════

/** Decode with python's plistlib when the box has python3; otherwise a header check only. */
function decodePlist(buf) {
  try {
    const out = execFileSync("python3", ["-c", "import sys,plistlib,json\nd=plistlib.loads(sys.stdin.buffer.read())\nprint(json.dumps(d))"], { input: buf, encoding: "utf8" });
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

test("encodeBplist: strings (ascii and unicode), numbers, reals, bools, nesting, and many objects", () => {
  const value = {
    s: "plain",
    u: "caf" + String.fromCharCode(0xe9) + " " + String.fromCharCode(0x2713),
    long: "x".repeat(300),
    i: 7,
    big: 70000,
    real: new PlistReal(1),
    half: 0.5,
    t: true,
    f: false,
    arr: [1, "two", [3], { four: 4 }],
    many: Array.from({ length: 300 }, (_, i) => `item${i}`),
  };
  const buf = encodeBplist(value);
  assert.equal(buf.subarray(0, 8).toString("latin1"), "bplist00");
  const back = decodePlist(buf);
  if (back) {
    assert.equal(back.s, "plain");
    assert.equal(back.u, value.u);
    assert.equal(back.long.length, 300);
    assert.deepEqual([back.i, back.big, back.real, back.half, back.t, back.f], [7, 70000, 1, 0.5, true, false]);
    assert.deepEqual(back.arr, [1, "two", [3], { four: 4 }]);
    assert.equal(back.many.length, 300);
    assert.equal(back.many[299], "item299");
  }
});

test("buildProposal: validates the documented subset and writes a numbered recipe", () => {
  const built = buildProposal({
    name: "  Wind down  ",
    description: "Quiet the phone",
    steps: [
      { do: "ask", prompt: "How was the day?", default: "fine" },
      { do: "set_volume", level: 0.3 },
      { do: "notify", title: "Wind down", body: "Time to rest" },
      { do: "get_url", url: "https://example.com/hook", method: "POST", json: { mood: "calm" } },
      { do: "open_url", url: "https://example.com/" },
      { do: "wait", seconds: 2 },
      { do: "show_result", text: "Done" },
    ],
  });
  assert.equal(built.name, "Wind down");
  assert.equal(built.recipe.length, 7);
  assert.match(built.recipe[0], /^1\. Add Ask for Input .*"How was the day\?".*"fine"/);
  assert.match(built.recipe[1], /Set Volume and set it to 30%/);
  assert.match(built.recipe[3], /Get Contents of URL for https:\/\/example\.com\/hook \(method POST\).*"mood"/);
  assert.deepEqual(built.file, { available: true });
  const file = buildShortcutFile(built.steps);
  assert.equal(file.subarray(0, 8).toString("latin1"), "bplist00");
  const plist = decodePlist(file);
  if (plist) {
    const ids = plist.WFWorkflowActions.map((a) => a.WFWorkflowActionIdentifier.replace("is.workflow.actions.", ""));
    assert.deepEqual(ids, ["ask", "setvolume", "notification", "downloadurl", "url", "openurl", "delay", "showresult"]);
    assert.equal(plist.WFWorkflowActions[1].WFWorkflowActionParameters.WFVolume, 0.3);
    assert.equal(plist.WFWorkflowActions[3].WFWorkflowActionParameters.WFHTTPMethod, "POST");
  }
});

test("buildProposal: a recipe-only step means no file, said plainly; bad input is rejected with the step number", () => {
  const focus = buildProposal({ name: "Quiet", steps: [{ do: "text", text: "hi" }, { do: "set_focus", mode: "Do Not Disturb", on: true }] });
  assert.equal(focus.file.available, false);
  assert.match(focus.file.reason, /Step 2 \(set focus\)/);
  assert.match(focus.recipe[1], /Set Focus, choose "Do Not Disturb" and turn it On/);
  assert.equal(buildShortcutFile(focus.steps), null);

  const bad = (steps, re) => assert.throws(() => buildProposal({ name: "X", steps }), (e) => e instanceof ShortcutValidationError && re.test(e.message));
  bad([], /at least one step/);
  bad([{ do: "format_disk" }], /step 1: "do" must be one of/);
  bad([{ do: "text" }], /step 1 \(text\) text is required/);
  bad([{ do: "open_url", url: "javascript:alert(1)" }], /http or https/);
  bad([{ do: "get_url", url: "file:///etc/passwd" }], /http or https/);
  bad([{ do: "get_url", url: "https://x.y", method: "DELETE" }], /GET or POST/);
  bad([{ do: "get_url", url: "https://x.y", json: { a: "b" } }], /needs method POST/);
  bad([{ do: "set_volume", level: 5 }], /0 to 1/);
  bad([{ do: "wait", seconds: -1 }], /0 to 3600/);
  bad(Array.from({ length: 31 }, () => ({ do: "text", text: "x" })), /at most 30/);
  assert.throws(() => buildProposal({ name: "", steps: [{ do: "text", text: "x" }] }), /name is required/);
});

test("tool: propose_shortcut stores a proposal, says nothing ran and that signing blocks a direct import", async (t) => {
  const r = await rig(t);
  const out = await IPhoneTool.call({ action: "propose_shortcut", proposal: { name: "Wind down", steps: [{ do: "notify", title: "Rest" }, { do: "wait", seconds: 1 }] } }, toolCtx());
  assert.equal(out.failure, undefined);
  assert.match(out.output.message, /nothing was added or run/);
  assert.match(out.output.message, /only imports signed Shortcuts/);
  assert.match(out.output.message, /1\. Add Show Notification/);
  assert.equal(r.directory.proposals().length, 1);
  assert.equal(r.sent.length, 0, "nothing was sent to the phone");
  const again = await IPhoneTool.call({ action: "propose_shortcut", proposal: { name: "wind down", steps: [{ do: "text", text: "x" }] } }, toolCtx());
  assert.equal(r.directory.proposals().length, 1, "the same name replaces the old proposal");
  assert.ok(again.output.proposal.id);
  const bad = await IPhoneTool.call({ action: "propose_shortcut", proposal: { name: "X", steps: [{ do: "open_url", url: "ftp://x" }] } }, toolCtx());
  assert.match(bad.failure, /^invalid_args:/);
  const missing = await IPhoneTool.call({ action: "propose_shortcut" }, toolCtx());
  assert.match(missing.failure, /needs proposal/);
});

// ═════════════════════════════════════════════════════════════════════════════
// directory persistence
// ═════════════════════════════════════════════════════════════════════════════

test("directory: survives a restart, keeps the last run across a sync that omits it, bounds the history", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "shortcuts.json");
  let clock = Date.UTC(2026, 8, 30, 12, 0, 0);
  const a = new ShortcutDirectory(file, { now: () => clock });
  await a.load();
  await a.put("ph1", sanitizeShortcutList(LIBRARY));
  await a.recordRun("ph1", { name: "Good Night", outcome: "ok", actor: "owner", ms: 900, summary: "ran" });
  await a.addProposal({ name: "P", steps: [{ do: "text", text: "x" }], recipe: ["1. Add Text"], file: { available: true } });
  const b = new ShortcutDirectory(file);
  await b.load();
  const lib = b.get("ph1");
  assert.equal(lib.shortcuts.length, 5);
  assert.equal(lib.shortcuts.find((s) => s.name === "Good Night").lastRun.actor, "owner");
  assert.equal(b.proposals().length, 1);
  await b.put("ph1", sanitizeShortcutList(LIBRARY));
  assert.equal(b.get("ph1").shortcuts.find((s) => s.name === "Good Night").lastRun.outcome, "ok", "a sync without a run keeps the known one");
  for (let i = 0; i < 80; i++) await b.recordRun("ph1", { name: "Morning", outcome: "ok", actor: "ares" });
  assert.equal(b.history(500).length, 60, "history is bounded");
  assert.equal(b.get("nobody"), undefined);
  assert.equal(b.get().device, "ph1", "no device named = the most recently synced");
  if (process.platform !== "win32") assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. HTTP, through a real RemoteAgentServer
// ═════════════════════════════════════════════════════════════════════════════

async function serve(t) {
  const dir = await tempDir(t);
  const audits = [];
  const directory = new ShortcutDirectory(path.join(dir, "shortcuts.json"), { audit: (e) => audits.push(e) });
  await directory.load();
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: OWNER, phoneApi: { shortcuts: createShortcutsApi({ directory }) } });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (method, p, { body, token = OWNER, raw } = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    if (raw) return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };
  return { call, directory, audits };
}

test("http: every route needs the owner bearer", async (t) => {
  const s = await serve(t);
  for (const [m, p] of [["GET", "/gateway/shortcuts"], ["POST", "/gateway/shortcuts"], ["GET", "/gateway/shortcuts/history"], ["POST", "/gateway/shortcuts/history"], ["GET", "/gateway/shortcuts/proposals"], ["DELETE", "/gateway/shortcuts/proposals/scp_00000000"], ["GET", "/gateway/shortcuts/proposals/scp_00000000/file"]]) {
    assert.equal((await s.call(m, p, { token: null })).status, 401, `${m} ${p}`);
    assert.equal((await s.call(m, p, { token: "guest" })).status, 401);
  }
  assert.equal(s.directory.devices().length, 0);
});

test("http: sync the library, read it back, reject what the app should show an error for", async (t) => {
  const s = await serve(t);
  assert.deepEqual((await s.call("GET", "/gateway/shortcuts")).json.shortcuts, []);
  const put = await s.call("POST", "/gateway/shortcuts", { body: { device: "ph1", shortcuts: LIBRARY } });
  assert.equal(put.status, 200);
  assert.equal(put.json.shortcuts.length, 5);
  const got = (await s.call("GET", "/gateway/shortcuts")).json;
  assert.equal(got.device, "ph1");
  assert.deepEqual(got.devices, ["ph1"]);
  assert.equal(got.shortcuts[0].alias, "bedtime routine");
  assert.equal(got.limits.shortcuts, 200);
  assert.equal((await s.call("GET", "/gateway/shortcuts?device=nobody")).json.shortcuts.length, 0);

  const bad = async (body, re) => {
    const r = await s.call("POST", "/gateway/shortcuts", { body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(r.json.error, re);
  };
  await bad({ shortcuts: [] }, /device/);
  await bad({ device: "bad id!", shortcuts: [] }, /device/);
  await bad({ device: "ph1", shortcuts: "x" }, /array/);
  await bad({ device: "ph1", shortcuts: [{ name: "A", alias: "go" }, { name: "B", alias: "GO" }] }, /alias/);
  await bad({ device: "ph1", shortcuts: [{ nope: 1 }] }, /name/);
  await bad("{nope", /JSON/);
  await bad({ device: "ph1", shortcuts: Array.from({ length: 201 }, (_, i) => ({ name: `s${i}` })) }, /at most 200/);
  assert.equal((await s.call("GET", "/gateway/shortcuts")).json.shortcuts.length, 5, "a refused sync changes nothing");
  assert.equal((await s.call("POST", "/gateway/shortcuts", { body: "x".repeat(300 * 1024) })).status, 413);
  assert.equal((await s.call("PUT", "/gateway/shortcuts")).status, 405);
  assert.equal((await s.call("GET", "/gateway/shortcuts/nope")).status, 404);
});

test("http: the owner's own runs are audited and kept; bad outcomes are refused", async (t) => {
  const s = await serve(t);
  await s.call("POST", "/gateway/shortcuts", { body: { device: "ph1", shortcuts: LIBRARY } });
  const ok = await s.call("POST", "/gateway/shortcuts/history", { body: { device: "ph1", name: "Good Night", outcome: "ok", ms: 1200, summary: "lights off" } });
  assert.equal(ok.status, 200);
  assert.ok(s.audits.some((a) => a.actor === "owner" && a.action === "iPhone.shortcut.run" && a.target === "Good Night" && a.result === "ok"));
  const hist = (await s.call("GET", "/gateway/shortcuts/history")).json.history;
  assert.equal(hist[0].name, "Good Night");
  assert.equal(hist[0].actor, "owner");
  const lib = (await s.call("GET", "/gateway/shortcuts")).json.shortcuts.find((x) => x.name === "Good Night");
  assert.equal(lib.lastRun.summary, "lights off");
  for (const body of [{ device: "ph1", name: "X", outcome: "great" }, { device: "ph1", outcome: "ok" }, { name: "X", outcome: "ok" }]) {
    assert.equal((await s.call("POST", "/gateway/shortcuts/history", { body })).status, 400);
  }
});

test("http: proposals are listed, downloadable as an UNSIGNED plist, 409 when a step has no encoding, and dismissable", async (t) => {
  const s = await serve(t);
  const ok = buildProposal({ name: "Wind down", steps: [{ do: "notify", title: "Rest" }] });
  const a = await s.directory.addProposal({ name: ok.name, steps: ok.steps, recipe: ok.recipe, file: ok.file });
  const focus = buildProposal({ name: "Quiet", steps: [{ do: "set_focus", on: true }] });
  const b = await s.directory.addProposal({ name: focus.name, steps: focus.steps, recipe: focus.recipe, file: focus.file });
  const list = (await s.call("GET", "/gateway/shortcuts/proposals")).json.proposals;
  assert.deepEqual(list.map((p) => p.name), ["Quiet", "Wind down"]);
  assert.equal(list[1].file.available, true);
  assert.equal(JSON.stringify(list).includes("steps"), false, "the list carries the recipe, not the raw steps");
  const file = await s.call("GET", `/gateway/shortcuts/proposals/${a.id}/file`, { raw: true });
  assert.equal(file.status, 200);
  assert.equal(file.bytes.subarray(0, 8).toString("latin1"), "bplist00");
  assert.equal(file.headers.get("x-ares-signed"), "false");
  assert.match(file.headers.get("content-disposition"), /filename="Wind-down\.shortcut"/);
  const noFile = await s.call("GET", `/gateway/shortcuts/proposals/${b.id}/file`);
  assert.equal(noFile.status, 409);
  assert.match(noFile.json.error, /no file encoding/);
  assert.equal((await s.call("GET", "/gateway/shortcuts/proposals/scp_ffffffff")).status, 404);
  assert.equal((await s.call("GET", "/gateway/shortcuts/proposals/..%2f..%2fetc")).status, 404);
  assert.deepEqual((await s.call("DELETE", `/gateway/shortcuts/proposals/${a.id}`)).json, { ok: true, removed: true });
  assert.equal((await s.call("GET", `/gateway/shortcuts/proposals/${a.id}`)).status, 404);
});
