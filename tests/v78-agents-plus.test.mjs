// Agents, more (owner, 2026-10-20): "agent memory in / across rooms, while
// also your personal agent in DMs remember and improve too, while recognizing
// being in rooms. and kill switch, profiles including your own … agents
// should be able to schedule jobs … live previews too", and "each users
// agents can share with other agents if users allow".
//
// Pinned here:
//   1. Lessons: an agent saves short lessons that ride in every chat and seat;
//      a near-duplicate replaces the old one; the cap holds.
//   2. Scheduled jobs: "daily 9am" / "every 30m" / "in 2h" parse; a due job
//      wakes its agent once (claimed before the turn), a busy agent is retried,
//      a one-off is done after it runs, the floor is 15 minutes.
//   3. Sharing is off until the owner turns it on, a share from another
//      owner's agent waits in the inbox (never straight into an agent), and a
//      shared skill installs as text only with our own frontmatter.
//   4. The kill switch pauses the room and interrupts every running seat —
//      also when the pause arrives from someone else's side.
//   5. Profiles carry a face (emoji + colour), sanitised.
//   6. VPS previews are private tunnels to 127.0.0.1, reused, closed on remove.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { DesktopAgents } from "../packages/cli/dist/entry/daemon/agents.js";
import { DesktopRooms } from "../packages/cli/dist/entry/daemon/rooms.js";
import { DesktopJobs, parseWhen, nextRun, jobTurnText } from "../packages/cli/dist/entry/daemon/jobs.js";
import { AgentSharing, parseShare, lessonMessage, skillMessage, sanitizeSharedSkill } from "../packages/cli/dist/entry/daemon/sharing.js";
import { DesktopWorkspaces } from "../packages/cli/dist/entry/daemon/workspaces.js";
import { DirectoryStore, toProfile } from "../packages/cli/dist/directoryServer.js";
import { desktopAgentLayerBlock } from "../packages/cli/dist/entry/prompt/texting.js";
import { makeAgentsTool } from "../packages/cli/dist/entry/agentsTool.js";
import { setAgentsHost } from "../packages/cli/dist/entry/agentScope.js";

const tmp = (p = "ares-plus-") => fs.mkdtemp(path.join(os.tmpdir(), p));
const tick = () => new Promise((r) => setTimeout(r, 30));

function agentsOn(home, busy = () => false, delivered = []) {
  return new DesktopAgents({
    home,
    defaultBrain: () => ({ provider: "mock", model: "m" }),
    deliver: (sessionId, goal, inputId) => delivered.push({ sessionId, goal, inputId }),
    busy,
    emit: () => undefined,
  });
}

test("lessons ride in the agent's layer, dedupe, and the tool saves them", async () => {
  const h = await tmp();
  const agents = agentsOn(h);
  await agents.load();
  const bob = await agents.create({ name: "bob", instructions: "engineer" });
  await agents.learn(bob.id, { add: "Cupid likes neon colours and short replies", from: "room Neon Brawl" });
  await agents.learn(bob.id, { add: "Cupid likes neon colours and short replies, no emoji", from: "room Neon Brawl" });
  await agents.learn(bob.id, { add: "Always open the room link, never a screenshot" });
  const lessons = agents.get(bob.id).lessons;
  assert.equal(lessons.length, 2, "a near-duplicate replaced the older lesson");
  assert.match(lessons[0].text, /no emoji/);
  const layer = agents.layerFor(bob.id);
  assert.match(layer, /## What you've learned/);
  assert.match(layer, /no emoji \(room Neon Brawl\)/);

  // the tool, from bob's own chat
  await agents.bind(bob.id, "sess_bob");
  setAgentsHost(agents.host());
  const tool = makeAgentsTool();
  const out = await tool.call({ action: "lesson", add_lesson: "Fetch before editing a shared file", learned_in: "room Agency" }, { sessionId: "sess_bob" });
  assert.match(out.display, /bob has 3 lessons/);
  await tool.call({ action: "lesson", remove_lesson: "screenshot" }, { sessionId: "sess_bob" });
  assert.equal(agents.get(bob.id).lessons.length, 2);
  // survives a reload
  const again = agentsOn(h);
  await again.load();
  assert.equal(again.get(bob.id).lessons.length, 2);
  // a block with no lessons still tells the agent how to save one
  assert.match(desktopAgentLayerBlock({ name: "x", instructions: "y" }, []), /action lesson, add_lesson/);
  setAgentsHost(undefined);
});

test("schedules parse, and a due job wakes its agent exactly once", async () => {
  const now = new Date(2026, 9, 20, 8, 0, 0);
  assert.deepEqual(parseWhen("daily 9am", now), { kind: "daily", time: "09:00" });
  assert.deepEqual(parseWhen("every 30m", now), { kind: "every", minutes: 30 });
  assert.deepEqual(parseWhen("hourly", now), { kind: "every", minutes: 60 });
  assert.deepEqual(parseWhen("weekly mon 5:30pm", now), { kind: "weekly", day: 1, time: "17:30" });
  assert.equal(parseWhen("in 2h", now).kind, "once");
  assert.throws(() => parseWhen("every 5m", now), /15 minutes/);
  assert.throws(() => parseWhen("whenever", now), /couldn't read/);
  assert.equal(nextRun({ kind: "daily", time: "09:00" }, now).getHours(), 9);
  assert.equal(nextRun({ kind: "daily", time: "07:00" }, now).getDate(), 21, "past today → tomorrow");

  const h = await tmp();
  let clock = now.getTime();
  const woke = [];
  let busy = false;
  const jobs = new DesktopJobs({
    home: h,
    emit: () => undefined,
    agentExists: (id) => id === "p_bob",
    roomName: (id) => (id === "room_1" ? "Neon Brawl" : undefined),
    wake: async (job, text) => (busy ? undefined : (woke.push({ job: job.id, text }), "sess_bob")),
    now: () => clock,
  });
  await jobs.load();
  await assert.rejects(jobs.add({ agentId: "p_nobody", task: "x", when: "hourly", createdBy: "owner" }), /unknown agent/);
  const daily = await jobs.add({ agentId: "p_bob", task: "Post the top 3 AI stories", when: "daily 9am", roomId: "room_1", createdBy: "agent" });
  const once = await jobs.add({ agentId: "p_bob", task: "Remind the owner to stretch", when: "in 30m", createdBy: "owner" });
  assert.equal(await jobs.tick(), 0, "nothing due at 8:00");

  clock += 31 * 60_000; // 8:31 — the one-off is due
  busy = true;
  assert.equal(await jobs.tick(), 0, "busy agent: retried later, not stacked");
  busy = false;
  assert.equal(await jobs.tick(), 1);
  assert.equal(jobs.get(once.id).status, "done");
  assert.equal(await jobs.tick(), 0, "never twice");

  clock = new Date(2026, 9, 20, 9, 0, 30).getTime();
  assert.equal(await jobs.tick(), 1);
  const ran = woke.at(-1);
  assert.equal(ran.job, daily.id);
  assert.match(ran.text, /Scheduled job "Post the top 3 AI stories" — daily at 09:00\./);
  assert.match(ran.text, /Rooms say \(room: "Neon Brawl"\)/);
  assert.equal(new Date(jobs.get(daily.id).nextRunAt).getDate(), 21, "claimed: next run is tomorrow");
  assert.equal(jobs.get(daily.id).lastRun.threadId, "sess_bob");

  await jobs.change(daily.id, "pause");
  await jobs.change(daily.id, "run");
  assert.equal(jobs.get(daily.id).nextRunAt <= new Date(clock).toISOString(), true);
  // persisted
  const again = new DesktopJobs({ home: h, emit: () => undefined, agentExists: () => true, roomName: () => "x", wake: async () => "s" });
  assert.equal((await again.load()).length, 2);
  await jobs.dropAgent("p_bob");
  assert.equal(jobs.list().length, 0);
  assert.match(jobTurnText({ ...daily, roomId: undefined }, undefined), /tell your owner the result/);
});

test("sharing: off by default, shares wait in the inbox, skills install as text only", async () => {
  const h = await tmp();
  const s = new AgentSharing({ home: h, emit: () => undefined });
  await s.load();
  assert.deepEqual(s.get(), { give: false, take: false });
  const item = { kind: "lesson", text: "Ship a playable link first", roomId: "room_1", roomName: "Neon Brawl", fromAgent: "Bop", fromOwner: "Cupid" };
  assert.equal(await s.receive(item), undefined, "take is off: nothing kept");
  await s.set({ take: true });
  const kept = await s.receive(item);
  assert.ok(kept?.id);
  assert.equal(await s.receive(item), undefined, "the same share once");
  assert.equal(s.items().length, 1);
  const again = new AgentSharing({ home: h, emit: () => undefined });
  await again.load();
  assert.equal(again.get().take, true);
  assert.equal(again.items().length, 1);
  await again.take(kept.id);
  assert.equal(again.items().length, 0);

  assert.deepEqual(parseShare(lessonMessage("Bop", "Ship a playable link first")), { kind: "lesson", agent: "Bop", text: "Ship a playable link first" });
  assert.deepEqual(parseShare(skillMessage("Bop", "game-juice", "Screen shake and hit-stop")), { kind: "skill", skill: "game-juice", agent: "Bop", text: "Screen shake and hit-stop" });
  assert.equal(parseShare("hey what's up"), undefined);

  const md = sanitizeSharedSkill("---\nname: evil\nstatus: ready\nhandler: handler.js\n---\nUse screen shake on hits.", { skill: "game-juice", text: "Screen shake", fromAgent: "Bop", fromOwner: "Cupid" });
  assert.match(md, /^---\nname: game-juice\ndescription: Screen shake\ncategory: shared\nstatus: shared\nshared_from: Bop \(Cupid's agent\)\n---/);
  assert.doesNotMatch(md, /handler/);
  assert.match(md, /Use screen shake on hits\./);
  assert.throws(() => sanitizeSharedSkill("---\na: b\n---\n", { skill: "x", text: "", fromAgent: "Bop" }), /empty/);
});

test("rooms: a teach is refused without permission; another owner's share reaches the inbox; the kill switch stops everyone", async () => {
  const h = await tmp();
  const ws = await tmp();
  const delivered = [];
  const busySet = new Set();
  const interrupted = [];
  const received = [];
  let give = false;
  const agents = agentsOn(h, (sid) => busySet.has(sid), delivered);
  const rooms = new DesktopRooms({
    home: h,
    workspace: ws,
    agents,
    deliver: (sessionId, goal, inputId) => delivered.push({ sessionId, goal, inputId }),
    busy: (sid) => busySet.has(sid),
    emit: () => undefined,
    publicOrigin: async () => "https://host.example",
    relayer: () => undefined,
    interrupt: (sid) => { interrupted.push(sid); busySet.delete(sid); },
    sharing: { give: () => give, take: () => true, receive: async (item) => { received.push(item); }, skill: async () => undefined },
  });
  await agents.load();
  const bob = await agents.create({ name: "bob", instructions: "engineer" });
  await rooms.load();
  const r = await rooms.create({ name: "Neon Brawl", purpose: "a game", agents: [bob.id] });
  await rooms.postAsOwner(r.id, "@bob hi");
  const seat = rooms.get(r.id).threads[bob.id];
  assert.ok(seat);

  const host = rooms.host();
  await assert.rejects(host.teach(seat, { lesson: "x" }), /hasn't turned on sharing/);
  give = true;
  await host.teach(seat, { lesson: "Fetch before you edit" });
  assert.match((await rooms.store.messages(r.id)).at(-1).text, /^📘 Lesson from bob: Fetch before you edit$/);
  await tick();
  assert.equal(received.length, 0, "our own agent's share never lands in our inbox");

  // a guest's agent (another owner) shares a lesson
  const cur = rooms.get(r.id);
  await rooms.store.save({
    ...cur,
    members: [
      ...cur.members,
      { kind: "person", id: "me_guest1", name: "Cupid", home: "me_guest1", joinedAt: new Date().toISOString() },
      { kind: "agent", id: "p_bop", name: "Bop", home: "me_guest1", owner: "person:me_guest1:me_guest1", joinedAt: new Date().toISOString() },
    ],
  });
  const seq = (await rooms.store.lastSeq(r.id)) + 1;
  await rooms.store.append(r.id, { seq, id: `rm_g${seq}`, at: new Date().toISOString(), from: { kind: "agent", id: "p_bop", name: "Bop", home: "me_guest1" }, text: lessonMessage("Bop", "Keep hitboxes generous"), kind: "text" });
  await rooms.postAsOwner(r.id, "nice"); // anything that drains the room
  await tick();
  assert.equal(received.length, 1);
  assert.deepEqual({ kind: received[0].kind, text: received[0].text, fromAgent: received[0].fromAgent, fromOwner: received[0].fromOwner, roomName: received[0].roomName }, { kind: "lesson", text: "Keep hitboxes generous", fromAgent: "Bop", fromOwner: "Cupid", roomName: "Neon Brawl" });

  // the kill switch
  busySet.add(seat);
  const res = await rooms.stopAgents(r.id);
  assert.equal(res.stopped, 1);
  assert.deepEqual(interrupted, [seat]);
  assert.equal(rooms.get(r.id).rules.paused, true);
  assert.match((await rooms.store.messages(r.id)).map((m) => m.text).join("\n"), /paused the agents/);

  // a pause that arrives from the other side also stops our running seats
  await rooms.update(r.id, { rules: { ...rooms.get(r.id).rules, paused: false } });
  busySet.add(seat);
  interrupted.length = 0;
  await rooms.update(r.id, { rules: { ...rooms.get(r.id).rules, paused: true } });
  await tick();
  assert.deepEqual(interrupted, [seat], "the flip to paused interrupts, whoever flipped it");

  // the private chat shows the room and what's been said
  assert.match(rooms.privateLayerFor(bob.id), /Neon Brawl \(paused\)/);
  rooms.stop();
});

test("profiles carry a face, sanitised", async () => {
  const h = await tmp();
  const store = new DirectoryStore(h);
  await store.load();
  const claimed = await store.claim({ username: "crix", displayName: "Crix", installId: "me_1" });
  const user = claimed.user ?? claimed;
  const next = await store.update(user, { emoji: "🦊", color: "#ff375f", bio: "building games" });
  const p = toProfile(next);
  assert.equal(p.emoji, "🦊");
  assert.equal(p.color, "#ff375f");
  const bad = await store.update(next, { emoji: "<script>", color: "red" });
  assert.equal(toProfile(bad).emoji, undefined);
  assert.equal(toProfile(bad).color, undefined);
});

test("VPS previews are private tunnels: 127.0.0.1 only, reused, closed on remove", async () => {
  const h = await tmp();
  const run = async (cmd, args) => {
    if (cmd === "ssh-keygen") {
      const f = args[args.indexOf("-f") + 1];
      await fs.writeFile(f, "PRIVATE");
      await fs.writeFile(`${f}.pub`, "ssh-ed25519 AAAA test\n");
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  const w = new DesktopWorkspaces({ home: h, run, emit: () => undefined });
  await w.load();
  const box = await w.add({ host: "203.0.113.7", label: "Game box" });
  const spawned = [];
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit("exit", 0); };
    spawned.push({ cmd, args, child });
    return child;
  };
  const a = await w.forward(box.id, 8080, { spawnImpl, localPort: 45123 });
  assert.equal(a.url, "http://127.0.0.1:45123/");
  assert.equal(a.reused, false);
  const L = spawned[0].args[spawned[0].args.indexOf("-L") + 1];
  assert.equal(L, "127.0.0.1:45123:127.0.0.1:8080", "bound to this PC's loopback only");
  assert.ok(spawned[0].args.includes("-N"));
  const b = await w.forward(box.id, 8080, { spawnImpl });
  assert.equal(b.reused, true);
  assert.equal(spawned.length, 1);
  await assert.rejects(w.forward(box.id, 70000, { spawnImpl }), /port must be/);
  await w.remove(box.id);
  assert.equal(spawned[0].child.killed, true);
});
