// "What do you remember about me", on the phone: list, search, correct, forget.
// Real RemoteAgentServer (the production owner-bearer gate) over a real
// MemoryStore file; and the single-writer path through a real Mnemosyne server,
// where the point is that a correction made from the phone cannot be undone by
// the next recall's persist.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

import { MemoryStore } from "../packages/mind/dist/index.js";
import { MnemosyneClient, MnemosyneServer, ensureToken, mnemosynePaths, selectMemories } from "../packages/mnemosyne/dist/index.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { createMemoryApi, memoryItem, memorySource, redactMemoryText } from "../packages/cli/dist/phoneMemory.js";

async function tempHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-phone-memory-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return home;
}

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY);
const SESS_COACH = "sess_11111111-2222-3333-4444-555555555555";
const SESS_DEFAULT = "sess_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SESS_GONE = "sess_99999999-0000-1111-2222-333333333333";

/** A memory file with a little of everything, including a guest's pool. */
async function seed(home) {
  const file = mnemosynePaths(home).memoryFile;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const store = await MemoryStore.open(file);
  const ids = {};
  ids.pref = (await store.add({ kind: "semantic", content: "Crix prefers dark mode and short replies", source: "conversation-reflection", tags: ["preference"], at: ago(30) })).id;
  ids.coach = (await store.add({ kind: "semantic", content: "Crix is training for a 10k in December", source: SESS_COACH, at: ago(10) })).id;
  ids.deploy = (await store.add({ kind: "procedural", content: "To deploy the app run ota.sh from the app folder", source: "after-action", at: ago(5) })).id;
  ids.episode = (await store.add({ kind: "episodic", content: "Asked about flights to Lisbon in March", source: SESS_DEFAULT, at: ago(2) })).id;
  ids.old = (await store.add({ kind: "episodic", content: "Asked about a session that no longer exists", source: SESS_GONE, at: ago(60) })).id;
  ids.secret = (await store.add({ kind: "semantic", content: "My api key is sk-abcdefghijklmnopqrstuvwx and my password is hunter2 for the router", at: ago(1) })).id;
  ids.guest = (await store.add({ kind: "semantic", content: "A guest likes pineapple pizza", scope: "guest:42", source: SESS_DEFAULT, at: ago(1) })).id;
  ids.noSource = (await store.add({ kind: "semantic", content: "Birthday is in June", at: ago(90) })).id;
  return { file, ids };
}

const AGENTS = { [SESS_COACH]: { id: "p_coach01", name: "Coach" }, [SESS_DEFAULT]: { id: "ares", name: "Ares" } };

async function serve(t, home, extra = {}) {
  const audits = [];
  const file = mnemosynePaths(home).memoryFile;
  const api = createMemoryApi({ memoryFile: file, agentOfSession: (sid) => AGENTS[sid], audit: (e) => audits.push(e), ...extra });
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "owner-tok", home, phoneApi: { memory: api } });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (method, p, body, token = "owner-tok") => {
    const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, audits, file };
}

test("auth: every memory route is owner-only, and nothing changes without it", async (t) => {
  const home = await tempHome(t);
  const { file, ids } = await seed(home);
  const s = await serve(t, home);
  const before = await fsp.readFile(file, "utf8");
  for (const [method, p, body] of [
    ["GET", "/gateway/memory"],
    ["GET", `/gateway/memory/item?id=${ids.pref}`],
    ["POST", "/gateway/memory/edit", { id: ids.pref, content: "hacked" }],
    ["POST", "/gateway/memory/forget", { id: ids.pref }],
  ]) {
    assert.equal((await s.call(method, p, body, null)).status, 401, `${method} ${p} without a token`);
    assert.equal((await s.call(method, p, body, "guest-tok")).status, 401, `${method} ${p} with a guest token`);
  }
  assert.equal(await fsp.readFile(file, "utf8"), before);
  assert.deepEqual(s.audits, []);
});

test("list: the owner's pool only, honest counts, newest first, grouped by kind on request", async (t) => {
  const home = await tempHome(t);
  const { ids } = await seed(home);
  const s = await serve(t, home);
  const all = (await s.call("GET", "/gateway/memory")).body;
  assert.equal(all.total, 7, "eight nodes on disk, one of them a guest's");
  assert.deepEqual(all.counts, { semantic: 4, procedural: 1, episodic: 2 });
  assert.ok(!all.items.some((i) => i.id === ids.guest), "a guest's memory never appears");
  assert.ok(!JSON.stringify(all).includes("pineapple"));
  assert.deepEqual(all.items.map((i) => i.id), [ids.secret, ids.episode, ids.deploy, ids.coach, ids.pref, ids.old, ids.noSource]);
  assert.equal(all.nextOffset, undefined);

  const facts = (await s.call("GET", "/gateway/memory?kind=semantic")).body;
  assert.equal(facts.total, 4);
  assert.deepEqual(facts.counts, all.counts, "counts describe memory, not the filter");
  assert.ok(facts.items.every((i) => i.kind === "semantic"));
  assert.equal((await s.call("GET", "/gateway/memory?kind=procedural")).body.items[0].id, ids.deploy);
  assert.equal((await s.call("GET", "/gateway/memory?kind=nonsense")).status, 400);
});

test("search: every word must match the text, the tags or the source; no match is an empty list, not an error", async (t) => {
  const home = await tempHome(t);
  const { ids } = await seed(home);
  const s = await serve(t, home);
  assert.deepEqual((await s.call("GET", "/gateway/memory?q=dark%20replies")).body.items.map((i) => i.id), [ids.pref]);
  assert.deepEqual((await s.call("GET", "/gateway/memory?q=DEPLOY")).body.items.map((i) => i.id), [ids.deploy]);
  assert.deepEqual((await s.call("GET", "/gateway/memory?q=preference")).body.items.map((i) => i.id), [ids.pref], "tags are searched");
  assert.deepEqual((await s.call("GET", "/gateway/memory?q=lisbon%20june")).body.items, [], "AND, not OR");
  const none = (await s.call("GET", "/gateway/memory?q=zebra")).body;
  assert.equal(none.total, 0);
  assert.equal(none.counts.semantic, 4, "the size of memory is still reported");
  assert.deepEqual((await s.call("GET", "/gateway/memory?q=pineapple")).body.items, [], "a guest's words are not searchable from the owner's screen");
  assert.equal((await s.call("GET", `/gateway/memory?q=${"x".repeat(5000)}`)).status, 200, "an oversize query is clipped, not an error");
});

test("paging: limit is capped at 100, offsets walk the list, nextOffset says when there is more", async (t) => {
  const home = await tempHome(t);
  const file = mnemosynePaths(home).memoryFile;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const store = await MemoryStore.open(file);
  for (let i = 0; i < 130; i++) await store.addMany([{ kind: "semantic", content: `fact number ${i}`, at: new Date(Date.now() - i * 1000) }]);
  const s = await serve(t, home);
  const p1 = (await s.call("GET", "/gateway/memory?limit=1000")).body;
  assert.equal(p1.items.length, 100);
  assert.equal(p1.limit, 100);
  assert.equal(p1.total, 130);
  assert.equal(p1.nextOffset, 100);
  const p2 = (await s.call("GET", `/gateway/memory?limit=1000&offset=${p1.nextOffset}`)).body;
  assert.equal(p2.items.length, 30);
  assert.equal(p2.nextOffset, undefined);
  assert.equal(new Set([...p1.items, ...p2.items].map((i) => i.id)).size, 130, "no row twice, none missed");
  assert.equal((await s.call("GET", "/gateway/memory?limit=0&offset=-5")).body.items.length, 1, "nonsense bounds are clamped");
});

test("each item says where it came from and which agent learned it", async (t) => {
  const home = await tempHome(t);
  const { ids } = await seed(home);
  const s = await serve(t, home);
  const byId = Object.fromEntries((await s.call("GET", "/gateway/memory")).body.items.map((i) => [i.id, i]));
  assert.deepEqual(byId[ids.coach].source, { kind: "conversation", label: "From a conversation", sessionId: SESS_COACH, agentId: "p_coach01", agentName: "Coach" });
  assert.equal(byId[ids.episode].source.agentId, "ares", "the default thread is Ares");
  assert.equal(byId[ids.old].source.kind, "conversation");
  assert.equal(byId[ids.old].source.agentId, undefined, "a thread nobody owns any more is not blamed on an agent");
  assert.equal(byId[ids.old].source.label, "From an earlier conversation");
  assert.equal(byId[ids.pref].source.kind, "reflection");
  assert.equal(byId[ids.deploy].source.kind, "task");
  assert.deepEqual(byId[ids.noSource].source, { kind: "other", label: "Remembered earlier" });
  assert.match(byId[ids.pref].at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(byId[ids.pref].tags, ["preference"]);
  assert.equal(byId[ids.pref].uses, 0, "an honest zero: listing never reinforces");
  assert.equal(memorySource({ source: "synthesis" }).kind, "synthesis");
  assert.equal(memorySource({ source: "light-dreaming" }).kind, "dreaming");
  assert.equal(memorySource({ source: "mission" }).kind, "mission");
  assert.equal(memorySource({ source: "weird thing" }).kind, "other");
});

test("looking never changes memory: listing, searching and fetching leave the file byte for byte", async (t) => {
  const home = await tempHome(t);
  const { file, ids } = await seed(home);
  const s = await serve(t, home);
  const before = await fsp.readFile(file, "utf8");
  await s.call("GET", "/gateway/memory");
  await s.call("GET", "/gateway/memory?q=dark");
  await s.call("GET", `/gateway/memory/item?id=${ids.pref}`);
  assert.equal(await fsp.readFile(file, "utf8"), before);
});

test("secrets never leave the box: keys, tokens, card numbers and 'password is' are replaced, and the item says so", async (t) => {
  const home = await tempHome(t);
  const { ids } = await seed(home);
  const s = await serve(t, home);
  const item = (await s.call("GET", `/gateway/memory/item?id=${ids.secret}`)).body.item;
  assert.equal(item.redacted, true);
  assert.ok(!item.text.includes("sk-abcdefghijklmnopqrstuvwx"));
  assert.ok(!item.text.includes("hunter2"));
  assert.match(item.text, /router/, "the rest of the sentence is kept");
  const list = JSON.stringify((await s.call("GET", "/gateway/memory?q=router")).body);
  assert.ok(!list.includes("hunter2") && !list.includes("sk-abcdef"));
  for (const raw of ["card 4111 1111 1111 1111 expires", "ssn 123-45-6789", "Authorization: Bearer abcdefghijklmnop1234", "token = abc123def456"]) {
    const r = redactMemoryText(raw);
    assert.equal(r.redacted, true, raw);
    assert.ok(!/4111|123-45-6789|abcdefghijklmnop1234|abc123def456/.test(r.text), r.text);
  }
  assert.deepEqual(redactMemoryText("Likes oat milk and long walks"), { text: "Likes oat milk and long walks", redacted: false });
});

test("size caps: an item's text is at most 2000 characters", async (t) => {
  const home = await tempHome(t);
  const item = memoryItem({ id: "mem_x", kind: "semantic", content: "a".repeat(5000), at: new Date().toISOString(), activations: 0, strength: 1, lastActivatedAt: "", links: [], v: 3 });
  assert.equal(item.text.length, 2000);
  assert.ok(home);
});

test("item: one memory by id; a guest's is a 404", async (t) => {
  const home = await tempHome(t);
  const { ids } = await seed(home);
  const s = await serve(t, home);
  const ok = await s.call("GET", `/gateway/memory/item?id=${ids.coach}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.item.text, "Crix is training for a 10k in December");
  assert.equal((await s.call("GET", `/gateway/memory/item?id=mem_nope`)).status, 404);
  assert.equal((await s.call("GET", `/gateway/memory/item?id=${ids.guest}`)).status, 404);
  assert.equal((await s.call("GET", `/gateway/memory/item`)).status, 400);
  assert.equal((await s.call("GET", `/gateway/memory/item?id=../../etc/passwd`)).status, 400);
});

test("edit: the owner's correction lands verbatim, is marked as theirs, and is audited without its words", async (t) => {
  const home = await tempHome(t);
  const { file, ids } = await seed(home);
  const s = await serve(t, home);
  const r = await s.call("POST", "/gateway/memory/edit", { id: ids.coach, content: "  Crix is training for a half marathon in March\n" });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.text, "Crix is training for a half marathon in March");
  assert.equal(r.body.item.editedByOwner, true);
  assert.ok(r.body.item.editedAt);
  assert.equal(r.body.item.confidence, 1);
  assert.equal(r.body.item.source.agentName, "Coach", "who learned it is not rewritten by a correction");

  const onDisk = (await fsp.readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((n) => n.id === ids.coach);
  assert.equal(onDisk.content, "Crix is training for a half marathon in March");
  assert.equal(onDisk.editedBy, "owner");
  assert.equal((await s.call("GET", "/gateway/memory?q=marathon")).body.items[0].id, ids.coach);
  assert.equal((await s.call("GET", "/gateway/memory?q=10k")).body.items.length, 0, "the old words are gone");

  assert.deepEqual(s.audits.map((a) => [a.actor, a.action, a.target]), [["owner", "memory.edit", ids.coach]]);
  assert.ok(!JSON.stringify(s.audits).includes("marathon"), "the audit line names the memory, never its words");
});

test("edit: validation and refusals", async (t) => {
  const home = await tempHome(t);
  const { file, ids } = await seed(home);
  const s = await serve(t, home);
  const before = await fsp.readFile(file, "utf8");
  for (const body of [{}, { id: ids.pref }, { id: ids.pref, content: "" }, { id: ids.pref, content: "   " }, { id: ids.pref, content: 5 }, { id: ids.pref, content: "x".repeat(2001) }, { id: "../x", content: "ok" }, { content: "ok" }, []]) {
    assert.equal((await s.call("POST", "/gateway/memory/edit", body)).status, 400, JSON.stringify(body).slice(0, 50));
  }
  assert.equal((await s.call("POST", "/gateway/memory/edit", "not json{")).status, 400);
  assert.equal((await s.call("POST", "/gateway/memory/edit", "x".repeat(20_000))).status, 413);
  assert.equal((await s.call("POST", "/gateway/memory/edit", { id: "mem_nope", content: "ok" })).status, 404);
  assert.equal((await s.call("POST", "/gateway/memory/edit", { id: ids.guest, content: "overwritten" })).status, 404, "a guest's memory cannot be edited from the owner's phone");
  assert.equal((await s.call("POST", "/gateway/memory/edit", { id: ids.pref, content: "exactly 2000" + "x".repeat(1988) })).status, 200, "2000 characters is allowed");
  assert.notEqual(await fsp.readFile(file, "utf8"), before);
  assert.deepEqual(s.audits.map((a) => a.action), ["memory.edit"], "refusals are not audited as edits");
  assert.equal((await s.call("PUT", "/gateway/memory/edit", { id: ids.pref, content: "x" })).status, 404, "an unknown method falls through");
});

test("forget: gone for good, from the list, the counts and the file; a guest's is untouchable", async (t) => {
  const home = await tempHome(t);
  const { file, ids } = await seed(home);
  const s = await serve(t, home);
  assert.equal((await s.call("POST", "/gateway/memory/forget", { id: ids.episode })).status, 200);
  const after = (await s.call("GET", "/gateway/memory")).body;
  assert.equal(after.total, 6);
  assert.equal(after.counts.episodic, 1);
  assert.ok(!(await fsp.readFile(file, "utf8")).includes(ids.episode));
  assert.equal((await s.call("POST", "/gateway/memory/forget", { id: ids.episode })).status, 404, "forgetting twice is a 404");
  assert.equal((await s.call("POST", "/gateway/memory/forget", { id: ids.guest })).status, 404);
  assert.ok((await fsp.readFile(file, "utf8")).includes(ids.guest), "the guest's node is still there");
  assert.equal((await s.call("POST", "/gateway/memory/forget", {})).status, 400);
  assert.deepEqual(s.audits.map((a) => [a.action, a.target]), [["memory.forget", ids.episode]]);
  assert.ok(!JSON.stringify(s.audits).includes("Lisbon"));
});

test("another process holding the consolidation lock is a 409, and nothing is touched", async (t) => {
  const home = await tempHome(t);
  const { file, ids } = await seed(home);
  const s = await serve(t, home);
  await fsp.writeFile(path.join(path.dirname(file), ".consolidation.lock"), `${process.pid} ${new Date().toISOString()}\n`);
  const before = await fsp.readFile(file, "utf8");
  assert.equal((await s.call("POST", "/gateway/memory/edit", { id: ids.pref, content: "new words" })).status, 409);
  assert.equal((await s.call("POST", "/gateway/memory/forget", { id: ids.pref })).status, 409);
  assert.equal(await fsp.readFile(file, "utf8"), before);
  assert.deepEqual(s.audits, []);
  await fsp.rm(path.join(path.dirname(file), ".consolidation.lock"));
  assert.equal((await s.call("POST", "/gateway/memory/forget", { id: ids.pref })).status, 200, "and it works the moment the lock is free");
});

test("an empty memory is an empty list with zero counts, not an error", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home);
  const r = (await s.call("GET", "/gateway/memory")).body;
  assert.deepEqual(r.items, []);
  assert.equal(r.total, 0);
  assert.deepEqual(r.counts, { semantic: 0, procedural: 0, episodic: 0 });
});

test("selectMemories: scope, kinds, words, paging, newest first (a correction counts as fresh)", async () => {
  const mk = (id, over = {}) => ({ v: 3, id, kind: "semantic", content: `text ${id}`, at: "2026-01-01T00:00:00.000Z", strength: 1, activations: 0, lastActivatedAt: "", links: [], ...over });
  const nodes = [mk("a", { at: "2026-01-02T00:00:00.000Z" }), mk("b", { at: "2026-01-01T00:00:00.000Z", editedAt: "2026-01-05T00:00:00.000Z" }), mk("c", { scope: "guest:1" }), mk("d", { scope: "owner", kind: "episodic" })];
  const page = selectMemories(nodes, {});
  assert.deepEqual(page.nodes.map((n) => n.id), ["b", "a", "d"]);
  assert.deepEqual(page.counts, { semantic: 2, procedural: 0, episodic: 1 });
  assert.deepEqual(selectMemories(nodes, { kinds: ["episodic"] }).nodes.map((n) => n.id), ["d"]);
  assert.deepEqual(selectMemories(nodes, { scope: "guest:1" }).nodes.map((n) => n.id), ["c"]);
  assert.deepEqual(selectMemories(nodes, { limit: 1, offset: 1 }).nodes.map((n) => n.id), ["a"]);
  assert.equal(selectMemories(nodes, { limit: 1 }).total, 3);
});

// ── the single-writer path ───────────────────────────────────────────────────

async function withMnemosyne(t, home) {
  const server = new MnemosyneServer({ home, port: 0 });
  const { port } = await server.start();
  const token = await ensureToken(home);
  const client = new MnemosyneClient({ url: `ws://127.0.0.1:${port}`, token, client: "test" });
  await client.connect();
  t.after(async () => { client.close(); await server.close(); });
  return { server, client, port, token };
}

test("through Mnemosyne: a phone correction survives the next recall's persist, and so does a forget", async (t) => {
  const home = await tempHome(t);
  const { file, ids } = await seed(home);
  const { client } = await withMnemosyne(t, home);
  const s = await serve(t, home, { wire: async () => client });

  // The wire list is what the route serves.
  const listed = (await s.call("GET", "/gateway/memory")).body;
  assert.equal(listed.total, 7);
  assert.ok(!listed.items.some((i) => i.id === ids.guest));

  const edited = await s.call("POST", "/gateway/memory/edit", { id: ids.pref, content: "Crix likes light mode now" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.item.editedByOwner, true);
  const gone = await s.call("POST", "/gateway/memory/forget", { id: ids.deploy });
  assert.equal(gone.status, 200);

  // A turn recalls with reinforcement: the server persists its whole map.
  await client.recall("mode replies light", { reinforce: true });
  await client.recall("anything at all", { reinforce: true });

  const onDisk = (await fsp.readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(onDisk.find((n) => n.id === ids.pref).content, "Crix likes light mode now", "the correction is still there after recall persisted");
  assert.equal(onDisk.find((n) => n.id === ids.deploy), undefined, "the forgotten memory did not come back");
  assert.ok(onDisk.find((n) => n.id === ids.guest), "the guest's node is untouched");

  assert.equal((await s.call("POST", "/gateway/memory/edit", { id: "mem_nope", content: "x" })).status, 404);
  assert.equal((await s.call("POST", "/gateway/memory/forget", { id: "mem_nope" })).status, 404);
  assert.deepEqual(s.audits.map((a) => a.action), ["memory.edit", "memory.forget"]);
});

test("through Mnemosyne: listing does not reinforce what it shows", async (t) => {
  const home = await tempHome(t);
  const { file } = await seed(home);
  const { client } = await withMnemosyne(t, home);
  const s = await serve(t, home, { wire: async () => client });
  const before = await fsp.readFile(file, "utf8");
  await s.call("GET", "/gateway/memory?q=dark");
  await s.call("GET", "/gateway/memory");
  assert.equal(await fsp.readFile(file, "utf8"), before);
  assert.ok((await s.call("GET", "/gateway/memory")).body.items.every((i) => i.uses === 0));
});

test("a wire that fails falls back to the file; a wire that is not there does too", async (t) => {
  const home = await tempHome(t);
  const { file, ids } = await seed(home);
  const broken = { listMemories: async () => { throw new Error("socket closed"); }, editMemory: async () => { throw new Error("socket closed"); }, forgetMemory: async () => { throw new Error("socket closed"); } };
  const s = await serve(t, home, { wire: async () => broken });
  assert.equal((await s.call("GET", "/gateway/memory")).body.total, 7);
  assert.equal((await s.call("POST", "/gateway/memory/edit", { id: ids.pref, content: "via the file" })).status, 200);
  assert.equal((await s.call("POST", "/gateway/memory/forget", { id: ids.deploy })).status, 200);
  const onDisk = (await fsp.readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(onDisk.find((n) => n.id === ids.pref).content, "via the file");
  assert.equal(onDisk.find((n) => n.id === ids.deploy), undefined);

  const t2 = await tempHome(t);
  await seed(t2);
  const s2 = await serve(t, t2, { wire: async () => null });
  assert.equal((await s2.call("GET", "/gateway/memory")).body.total, 7);
});

test("the wire speaks memory.list / memory.edit / memory.forget, and an unknown frame answers instead of hanging", async (t) => {
  const home = await tempHome(t);
  const { ids } = await seed(home);
  const { client, port, token } = await withMnemosyne(t, home);
  const page = await client.listMemories({ query: "dark", limit: 5 });
  assert.deepEqual(page.nodes.map((n) => n.id), [ids.pref]);
  assert.equal(page.counts.semantic, 4);
  const edit = await client.editMemory(ids.pref, "changed");
  assert.equal(edit.before.content, "Crix prefers dark mode and short replies");
  assert.equal(edit.after.editedBy, "owner");
  await assert.rejects(() => client.editMemory("mem_nope", "x"), /no memory/);
  await client.forgetMemory(ids.pref);
  await assert.rejects(() => client.forgetMemory(ids.pref), /no memory/);
  assert.equal((await client.listMemories({})).total, 6);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "hello", token, client: "raw", proto: 1 }));
  await new Promise((r) => setTimeout(r, 100));
  ws.send(JSON.stringify({ type: "memory.teleport", req: "r42" }));
  await new Promise((r) => setTimeout(r, 100));
  ws.close();
  const err = frames.find((f) => f.type === "error");
  assert.ok(err, "an unknown frame is answered");
  assert.equal(err.re, "r42", "and the answer carries the request id, so a client does not wait out its timeout");
});
