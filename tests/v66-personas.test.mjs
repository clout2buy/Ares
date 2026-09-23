// Personas — "create a new chat, with a name, and the model for that agent,
// along with a rundown of what it's for" (owner, 2026-09-23) — and the
// texting surface that makes every chat read like a person, not a tool log.
//
// Pinned here:
//   1. /gateway/personas CRUD with validation against the cockpit catalog;
//      creating a watcher persona kicks off its setup turn.
//   2. A persona thread is its own session, carries the persona layer in its
//      composed system prompt, and the default thread never does.
//   3. Alarms set from a persona's thread run back IN that thread and reach
//      the phone titled with the persona's name; Remind records the origin.
//   4. The phone/Telegram surface prompt carries the texting doctrine.
//   5. Archive hides a session from rehydration but keeps its rollout.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager, rehydrateSessions, rolloutPath } from "../packages/garrison/dist/index.js";
import { QueryEngine, MockEchoProvider } from "../packages/core/dist/index.js";
import { RemindTool, setRemindScheduler } from "../packages/tools/dist/index.js";
import { TelegramScheduler } from "../packages/channels/dist/telegram/scheduler.js";
import { PersonaStore, impliesMonitoring, lastThreadMessage, stripPreamble, firstLine, PERSONA_SETUP_PROMPT } from "../packages/cli/dist/personas.js";
import { handlePersonasApi } from "../packages/cli/dist/phonePersonas.js";
import { PersonaRuntime, scheduledTurnText } from "../packages/cli/dist/entry/personaRuntime.js";
import { textingSurfaceBlock, personaLayerBlock, sessionPromptLayers } from "../packages/cli/dist/entry/prompt/texting.js";

async function tempHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-personas-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

// ── a tiny HTTP harness around handlePersonasApi ────────────────────────────

async function serve(t, deps) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!(await handlePersonasApi(req, res, url, deps))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, route, body) => {
    const res = await fetch(base + route, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
}

function fakeDeps(home) {
  const calls = { created: [], archived: [], applied: [], kickoffs: [] };
  let seq = 0;
  const deps = {
    store: new PersonaStore(home),
    providers: () => ["deepseek", "openai"],
    models: async (provider) => (provider === "deepseek" ? [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] : [{ id: "gpt-5.5" }]),
    reasoningLevels: () => ["low", "medium", "high"],
    defaultPersona: async () => ({ provider: "deepseek", model: "deepseek-flash", reasoningLevel: "high", sessionId: "sess_default" }),
    createSession: async (persona) => {
      // The persona is staged before its thread is built — the factory sees it.
      assert.ok(deps.store.get(persona.id), "persona is staged while its thread is created");
      const id = `sess_p${++seq}`;
      calls.created.push({ id, persona: { ...persona } });
      return id;
    },
    archiveSession: async (sessionId) => { calls.archived.push(sessionId); },
    busy: (sessionId) => sessionId === "sess_default",
    lastMessage: async (sessionId) => (sessionId === "sess_default" ? { text: "morning!", at: "2026-09-23T08:00:00.000Z" } : undefined),
    apply: async (persona, changed) => { calls.applied.push({ persona, changed }); },
    kickoff: (sessionId, text) => { calls.kickoffs.push({ sessionId, text }); },
  };
  return { deps, calls };
}

const BOB = {
  name: "Bob",
  emoji: "💸",
  color: "#2E7D32",
  provider: "deepseek",
  model: "deepseek-flash",
  reasoningLevel: "high",
  instructions: "You're my finance guy. Keep me posted when I get charged, and help me budget my money.",
};

test("personas: create, list, edit and delete over /gateway/personas", async (t) => {
  const home = await tempHome(t);
  const { deps, calls } = fakeDeps(home);
  const call = await serve(t, deps);

  // Empty: only the implicit default, first, with its live thread.
  const empty = await call("GET", "/gateway/personas");
  assert.equal(empty.status, 200);
  assert.equal(empty.body.personas.length, 1);
  assert.deepEqual(empty.body.personas[0], {
    id: "ares", name: "Ares", provider: "deepseek", model: "deepseek-flash", reasoningLevel: "high",
    instructions: "", sessionId: "sess_default", lastMessage: "morning!", lastAt: "2026-09-23T08:00:00.000Z", busy: true,
  });

  const created = await call("POST", "/gateway/personas", BOB);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const bob = created.body.persona;
  assert.match(bob.id, /^p_[a-z0-9]+$/);
  assert.equal(bob.name, "Bob");
  assert.equal(bob.emoji, "💸");
  assert.equal(bob.color, "#2E7D32");
  assert.equal(bob.sessionId, "sess_p1", "its own dedicated thread");
  assert.equal(bob.busy, false);
  assert.notEqual(bob.sessionId, "sess_default", "never the default thread");

  // Stored as <home>/personas/<id>.json with the exact shape.
  const onDisk = JSON.parse(await fs.readFile(path.join(home, "personas", `${bob.id}.json`), "utf8"));
  assert.deepEqual(Object.keys(onDisk).sort(), ["color", "createdAt", "emoji", "id", "instructions", "model", "name", "provider", "reasoningLevel", "sessionId", "updatedAt"]);
  assert.equal(onDisk.sessionId, "sess_p1");

  // "keep me posted" → a setup turn in Bob's thread.
  assert.deepEqual(calls.kickoffs, [{ sessionId: "sess_p1", text: PERSONA_SETUP_PROMPT }]);
  assert.match(PERSONA_SETUP_PROMPT, /Set yourself up: read your role, connect what you need \(Connect\), and schedule any recurring checks/);

  // A persona that implies no monitoring gets no kickoff.
  const quiet = await call("POST", "/gateway/personas", { name: "Chef", provider: "openai", model: "gpt-5.5", instructions: "Suggest dinners I can cook in 20 minutes." });
  assert.equal(quiet.status, 200);
  assert.equal(calls.kickoffs.length, 1);

  const listed = await call("GET", "/gateway/personas");
  assert.deepEqual(listed.body.personas.map((p) => p.name), ["Ares", "Bob", "Chef"]);

  // Edit: a model change is a brain change; a rundown change is a layer change.
  const edited = await call("POST", `/gateway/personas/${bob.id}`, { model: "deepseek-v4-pro", instructions: "Finance only. Weekly budget recap on Sundays." });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.persona.model, "deepseek-v4-pro");
  assert.equal(edited.body.persona.sessionId, "sess_p1", "same thread after an edit");
  assert.deepEqual(calls.applied.at(-1).changed, { brain: true, layer: true, effort: false });
  const effort = await call("POST", `/gateway/personas/${bob.id}`, { reasoningLevel: "low" });
  assert.deepEqual(calls.applied.at(-1).changed, { brain: false, layer: false, effort: true });
  assert.equal(effort.body.persona.reasoningLevel, "low");

  // Reload from disk: the edits persisted.
  const reloaded = new PersonaStore(home);
  await reloaded.load();
  assert.equal(reloaded.get(bob.id).model, "deepseek-v4-pro");
  assert.equal(reloaded.bySession("sess_p1").id, bob.id);

  // Delete archives the thread; the persona is gone from the list.
  const del = await call("POST", `/gateway/personas/${bob.id}/delete`, {});
  assert.deepEqual(del, { status: 200, body: { ok: true } });
  assert.deepEqual(calls.archived, ["sess_p1"]);
  const after = await call("GET", "/gateway/personas");
  assert.deepEqual(after.body.personas.map((p) => p.name), ["Ares", "Chef"]);
  assert.equal((await call("POST", `/gateway/personas/${bob.id}`, { name: "Rob" })).status, 404);
  assert.equal((await call("POST", "/gateway/personas/ares", { name: "Zeus" })).status, 404, "the default is not editable here");
});

test("personas: validation answers 400 and creates nothing", async (t) => {
  const home = await tempHome(t);
  const { deps, calls } = fakeDeps(home);
  const call = await serve(t, deps);
  const bad = [
    [{ ...BOB, name: "" }, /name required/],
    [{ ...BOB, name: undefined }, /name required/],
    [{ ...BOB, instructions: undefined }, /instructions required/],
    [{ ...BOB, instructions: "x".repeat(4_001) }, /at most 4000/],
    [{ ...BOB, provider: "skynet" }, /unknown provider: skynet/],
    [{ ...BOB, model: "gpt-5.5" }, /unknown model for deepseek: gpt-5\.5/],
    [{ ...BOB, color: "green" }, /#hex/],
    [{ ...BOB, reasoningLevel: "ludicrous" }, /reasoningLevel must be one of/],
    [{ ...BOB, name: 42 }, /name must be a string/],
  ];
  for (const [body, why] of bad) {
    const res = await call("POST", "/gateway/personas", body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(res.body.error, why);
  }
  assert.equal(calls.created.length, 0);
  assert.deepEqual(await fs.readdir(path.join(home, "personas")).catch(() => []), []);

  const ok = await call("POST", "/gateway/personas", BOB);
  const res = await call("POST", `/gateway/personas/${ok.body.persona.id}`, { model: "nope" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /unknown model/);
});

// ── the persona layer on a real SessionManager ──────────────────────────────

function runtimeFor(home, pushes) {
  return new PersonaRuntime({
    home,
    resolveBrain: async (provider, model) => ({ provider, model }),
    live: { setBrain: async () => {}, setReasoningLevel: () => {}, refreshPrompt: () => {} },
    catalog: { providers: () => ["deepseek"], models: async () => [{ id: "deepseek-flash" }], reasoningLevels: () => ["high"] },
    defaultBrain: () => ({ provider: "deepseek", model: "deepseek-flash" }),
    push: async (m) => { pushes.push(m); },
  });
}

/** The garrison factory's composition, in miniature: base prompt + the
 *  runtime's per-session layers. Records what each session was built with. */
function composingFactory(home, runtime, seen) {
  return (req) => {
    const system = "BASE PROMPT" + runtime.promptLayers(req.sessionId, req.surface, req.personaId);
    seen.set(req.sessionId, { system, personaId: req.personaId, model: req.model });
    const engine = QueryEngine.forTesting(
      { provider: new MockEchoProvider(), model: req.model ?? "mock", systemPrompt: system, tools: [], workspace: home, signal: req.signal, requestPermission: req.requestPermission },
      req.sessionId,
    );
    return { engine, providerName: "mock-echo", model: req.model ?? "mock", workspace: home };
  };
}

async function personaManager(t) {
  const home = await tempHome(t);
  const pushes = [];
  const seen = new Map();
  const runtime = runtimeFor(home, pushes);
  await runtime.boot();
  const sessions = new SessionManager({ home, factory: composingFactory(home, runtime, seen), personas: runtime.sessionHooks() });
  runtime.attach(sessions);
  const { deps } = fakeDeps(home);
  // Real hooks this time: the runtime creates the session through the manager.
  const call = await serve(t, { ...deps, store: runtime.store, createSession: async (p) => { await runtime.prepareBrain(p); return sessions.create({ surface: "mobile", tenant: { role: "owner" }, personaId: p.id }).id; }, archiveSession: (id) => sessions.archive(id), kickoff: () => {} });
  return { home, pushes, seen, runtime, sessions, call };
}

test("a persona thread is its own session and its prompt carries the persona layer", async (t) => {
  const { seen, runtime, sessions, call } = await personaManager(t);
  const def = sessions.create({ surface: "mobile", tenant: { role: "owner" } });

  const created = await call("POST", "/gateway/personas", BOB);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const bob = created.body.persona;
  assert.notEqual(bob.sessionId, def.id);
  assert.equal(runtime.store.bySession(bob.sessionId).id, bob.id);

  const built = seen.get(bob.sessionId);
  assert.equal(built.personaId, bob.id, "the factory knew which persona it was building");
  assert.equal(built.model, "deepseek-flash", "the persona's model, not the default's");
  assert.match(built.system, /^BASE PROMPT/);
  assert.match(built.system, /You are Bob, one of the owner's personal agents, texting them from their phone\. Your role, in the owner's words:/);
  assert.match(built.system, /Keep me posted when I get charged/);
  assert.match(built.system, /Stay in that role/);
  assert.match(built.system, /you still have all of Ares's tools and memory|You still have all of Ares's tools and memory/);
  assert.match(built.system, /Never narrate your tools/, "a persona thread is a texting thread");

  // The default thread: texting, never a persona.
  const plain = seen.get(def.id).system;
  assert.match(plain, /Never narrate your tools/);
  assert.doesNotMatch(plain, /You are Bob/);

  // Summaries say which persona owns a thread.
  const summaries = sessions.list();
  assert.equal(summaries.find((s) => s.id === bob.sessionId).personaId, bob.id);
  assert.equal(summaries.find((s) => s.id === def.id).personaId, undefined);

  // WS-style create for a persona binds the NEW thread and archives the old.
  const again = sessions.create({ surface: "mobile", personaId: bob.id });
  assert.equal(runtime.store.get(bob.id).sessionId, again.id);
  assert.equal(seen.get(again.id).personaId, bob.id);
  assert.throws(() => sessions.create({ personaId: "p_doesnotexist" }), /unknown persona/);
});

test("an alarm set in a persona's thread runs back in that thread and pushes as the persona", async (t) => {
  const { home, pushes, sessions, call } = await personaManager(t);
  const bob = (await call("POST", "/gateway/personas", BOB)).body.persona;
  const def = sessions.create({ surface: "mobile" });

  // Remind records where it was asked, and the prompt to run.
  const added = [];
  setRemindScheduler({
    addAlarm: async (input) => { added.push(input); return { id: "a1", label: input.label, hour: input.hour, minute: input.minute }; },
    removeAlarm: async () => undefined,
    renderAlarms: async () => "",
  });
  t.after(() => setRemindScheduler(null));
  await RemindTool.call(
    { action: "add", label: "Charges check", hour: 9, minute: 0, prompt: "Check for new card charges since yesterday." },
    { sessionId: bob.sessionId, workspace: home, signal: new AbortController().signal },
  );
  assert.equal(added[0].sessionId, bob.sessionId);
  assert.equal(added[0].prompt, "Check for new card charges since yesterday.");

  // The scheduler routes the fired alarm instead of pinging Telegram.
  const sentToTelegram = [];
  const routed = [];
  const alarm = { id: "a1", label: "Charges check", hour: 9, minute: 0, prompt: added[0].prompt, sessionId: bob.sessionId, createdAt: "x" };
  await fs.writeFile(path.join(home, "telegram-schedule.json"), JSON.stringify({ alarms: [alarm, { ...alarm, id: "a2", label: "Plain ping", prompt: undefined, sessionId: undefined }] }));
  const scheduler = new TelegramScheduler({
    outbound: { sendToOwners: async (text) => { sentToTelegram.push(text); return { sent: 1, failed: 0 }; }, sendToChats: async () => ({ sent: 1, failed: 0 }) },
    home,
    now: () => new Date(2026, 8, 23, 9, 0, 30),
    tickMs: 60_000,
    routeAlarm: async (a, now) => { routed.push(a.id); return a.sessionId ? true : false; },
  });
  await scheduler.start();
  t.after(() => scheduler.stop());
  scheduler["tick"]();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(routed.sort(), ["a1", "a2"]);
  assert.equal(sentToTelegram.length, 1, "only the plain alarm pings Telegram");
  assert.match(sentToTelegram[0], /Plain ping/);

  // The runtime's routing: a turn in Bob's thread, then a push titled "Bob".
  const handled = await sessionsRoute(t, { home, sessions, pushes }, alarm, bob);
  assert.equal(handled, true);
  // A plain alarm from the default thread (no prompt, not a persona) stays Telegram's.
  const { runtime } = await personaManagerFromHome(home, sessions);
  assert.equal(await runtime.routeAlarm({ id: "a3", label: "x", sessionId: def.id }, new Date()), false);
  assert.equal(await runtime.routeAlarm({ id: "a4", label: "x" }, new Date()), false);
});

async function personaManagerFromHome(home, sessions) {
  const runtime = runtimeFor(home, []);
  await runtime.boot();
  runtime.attach(sessions);
  return { runtime };
}

async function sessionsRoute(t, { home, sessions, pushes }, alarm, bob) {
  const runtime = runtimeFor(home, pushes);
  await runtime.boot();
  runtime.attach(sessions);
  const handled = await runtime.routeAlarm(alarm, new Date(2026, 8, 23, 9, 0));
  // Wait for the turn + push.
  const start = Date.now();
  while (pushes.length === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 10));
  assert.equal(pushes.length, 1, "one push for the run");
  assert.equal(pushes[0].title, "Bob");
  assert.deepEqual(pushes[0].data, { kind: "persona_message", personaId: bob.id, sessionId: bob.sessionId });
  assert.ok(pushes[0].body.length > 0 && !pushes[0].body.includes("\n"), "body is the reply's first line");
  // The run landed in Bob's thread, carrying the alarm's prompt.
  const rollout = await fs.readFile(rolloutPath(home, bob.sessionId), "utf8");
  assert.match(rollout, /Check for new card charges since yesterday/);
  const last = await lastThreadMessage(rolloutPath(home, bob.sessionId));
  assert.equal(last.role, "assistant");
  return handled;
}

test("scheduled turn text and previews read like a conversation", () => {
  const text = scheduledTurnText({ id: "a", label: "Charges check", prompt: "Check charges." }, new Date(2026, 8, 23, 9, 0));
  assert.match(text, /^\(System: your scheduled check "Charges check" is due now/);
  assert.equal(stripPreamble(text), "Check charges.", "the preview strips the note, parentheses and all");
  assert.equal(stripPreamble("(System: a (nested) note)\n\n(System: another)\n\nhi"), "hi");
  assert.equal(firstLine("\n\n## Heads up\n\nsecond"), "Heads up");
  assert.ok(impliesMonitoring("keep me posted when I get charged"));
  assert.ok(impliesMonitoring("Every morning, tell me the weather"));
  assert.ok(impliesMonitoring("let me know if my flight is delayed"));
  assert.ok(!impliesMonitoring("Suggest dinners I can cook in 20 minutes."));
});

// ── the texting surface ─────────────────────────────────────────────────────

test("phone and Telegram sessions get texting guidance; desktop does not", () => {
  for (const surface of ["mobile", "telegram"]) {
    const block = textingSurfaceBlock(surface);
    assert.match(block, /like any other text conversation/);
    assert.match(block, /No markdown headers, no bullet walls/);
    assert.match(block, /Never narrate your tools or process\. No "let me check…", "I'll use the X tool"/);
    assert.match(block, /blank line — each paragraph shows as its own bubble/);
    assert.match(block, /Natural, not cutesy/);
  }
  assert.match(textingSurfaceBlock("mobile"), /Ares app on their iPhone/);
  assert.match(textingSurfaceBlock("telegram"), /Telegram on their phone/);
  for (const surface of ["desktop", "tui", "headless", undefined]) assert.equal(textingSurfaceBlock(surface), "");
  assert.equal(personaLayerBlock(null), "");
  assert.equal(sessionPromptLayers("desktop", null), "", "nothing appended to a desktop session");
  assert.match(personaLayerBlock({ name: "Bob", instructions: "finance" }), /You are Bob, one of the owner's personal agents/);
});

// ── archive ─────────────────────────────────────────────────────────────────

test("archive retires a session from rehydration but never deletes its rollout", async (t) => {
  const home = await tempHome(t);
  const runtime = runtimeFor(home, []);
  const sessions = new SessionManager({ home, factory: composingFactory(home, runtime, new Map()) });
  const keep = sessions.create({ surface: "mobile" });
  const gone = sessions.create({ surface: "mobile" });
  await sessions.send(keep.id, "hello");
  await sessions.send(gone.id, "goodbye");
  await sessions.flush();
  assert.equal(await sessions.archive(gone.id), true);
  assert.equal(sessions.has(gone.id), false);
  await fs.access(rolloutPath(home, gone.id));
  const prior = await rehydrateSessions(home);
  assert.deepEqual(prior.map((p) => p.id), [keep.id]);
  assert.equal(await sessions.ensureLive(gone.id), null, "a later attach can't resurrect it");
  assert.equal(await sessions.archive("sess_nope"), false);
});
