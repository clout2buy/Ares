// The surface ledger and the Surface tool (docs/CREATOR-MODE-DESIGN.md).
//
// The daemon has no DOM, so region patches are applied on the HTML text; these
// pin the walker, the revision ledger under a temp ARES_HOME, the bus events
// the desktop will fold, the doctrine scan (nothing may flash) and the owner
// decision that any surface with feeds or actions must ask for once.

import test from "node:test";
process.env.ARES_GENUI = "1";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applySurfaceMutations,
  findSurfaceRegion,
  parseSurfaceFeeds,
  regionsInSurfaceHtml,
  scanSurfaceDoctrine,
  surfaceHtmlProblem,
} from "../packages/protocol/dist/index.js";
import {
  SurfaceTool,
  adaptToolForEngine,
  createSurface,
  listSurfaceRevisions,
  listSurfaces,
  mutateSurface,
  readSurface,
  removeSurface,
  rollbackSurface,
  surfaceBus,
} from "../packages/tools/dist/index.js";

const tmpHome = () => mkdtemp(path.join(os.tmpdir(), "ares-surfaces-"));

const PAGE = `<main data-ares-region="main"><h1>Bills</h1><section data-ares-region="list"><ul><li>Rent</li></ul></section><footer data-ares-region="status">ok</footer></main>`;

test("region walker balances nested tags and void elements", () => {
  const html = `<div data-ares-region="a"><div><br><div></div></div><img src="data:x"></div><div data-ares-region="b">x</div>`;
  const a = findSurfaceRegion(html, "a");
  assert.ok(a);
  assert.equal(html.slice(a.start, a.end), `<div data-ares-region="a"><div><br><div></div></div><img src="data:x"></div>`);
  const b = findSurfaceRegion(html, "b");
  assert.equal(html.slice(b.innerStart, b.innerEnd), "x");
  assert.equal(findSurfaceRegion(html, "zzz"), null);
  assert.deepEqual(regionsInSurfaceHtml(PAGE), ["main", "list", "status"]);
});

test("mutations patch regions, posts never change the document", () => {
  const doc = { title: "t", html: PAGE, css: "", js: "" };
  const r = applySurfaceMutations(doc, [
    { op: "replace_region", target: "list", html: "<ul><li>Rent</li><li>Power</li></ul>" },
    { op: "append_region", target: "status", html: " · 2 bills" },
    { op: "set_title", title: "Bills, updated" },
    { op: "post", payload: { total: 2 } },
  ]);
  assert.equal(r.documentChanged, true);
  assert.deepEqual(r.posts, [{ total: 2 }]);
  assert.match(r.next.html, /<li>Power<\/li>/);
  assert.match(r.next.html, /ok · 2 bills/);
  assert.equal(r.next.title, "Bills, updated");
  const only = applySurfaceMutations(doc, [{ op: "post", payload: 1 }]);
  assert.equal(only.documentChanged, false);
  assert.throws(() => applySurfaceMutations(doc, [{ op: "replace_region", target: "nope", html: "x" }]), /does not exist/);
  assert.throws(() => applySurfaceMutations(doc, [{ op: "remove_region", target: "main" }]), /at least one data-ares-region/);
});

test("the ledger refuses frames, external URLs and flashing", () => {
  assert.match(surfaceHtmlProblem(`<div data-ares-region="m"><iframe src="x"></iframe></div>`), /iframe/);
  assert.match(surfaceHtmlProblem(`<div data-ares-region="m"><img src="https://x/y.png"></div>`), /external URLs/);
  assert.equal(surfaceHtmlProblem(`<div data-ares-region="m"><img src="data:image/png;base64,AA"><a href="#top">t</a></div>`), null);
  const flashing = scanSurfaceDoctrine(`@keyframes blink { 50% { opacity: 0 } } .x { animation: blink 0.1s infinite; }`, "");
  assert.equal(flashing.length, 1);
  assert.match(flashing[0].message, /flash/);
  // A slow pulse and a fast spin are both fine: motion is not a flash.
  assert.equal(scanSurfaceDoctrine(`@keyframes pulse { 50% { opacity: .4 } } .x { animation: pulse 1.6s infinite; } @keyframes spin { to { transform: rotate(1turn) } } .y { animation: spin .2s infinite; }`, "").length, 0);
  assert.equal(scanSurfaceDoctrine("", "setInterval(() => { el.style.opacity = on ? 1 : 0; on = !on; }, 40)").length, 1);
  assert.equal(scanSurfaceDoctrine("", "setInterval(tick, 40)").length, 0);
});

test("feeds are validated and cadences floored", () => {
  const ok = parseSurfaceFeeds([{ kind: "time", everySec: 1 }, { kind: "tool", tool: "Weather", everySec: 5, input: { city: "x" } }, { kind: "session.status" }]);
  assert.deepEqual(ok.feeds, [{ kind: "time", everySec: 5 }, { kind: "tool", tool: "Weather", input: { city: "x" }, everySec: 30 }, { kind: "session.status" }]);
  assert.match(parseSurfaceFeeds([{ kind: "weird" }]).error, /unknown kind/);
  assert.match(parseSurfaceFeeds([{ kind: "file" }]).error, /path required/);
});

test("ledger: create, mutate, rollback, revisions pruned, remove; bus events fire", async () => {
  const home = await tmpHome();
  const seen = [];
  const off = surfaceBus.subscribe((e) => seen.push(e));
  try {
    const created = await createSurface({ name: "bills", title: "Bills", placement: "rail", document: { html: PAGE, css: "", js: "" }, feeds: [], actions: [], sessionId: "s1", note: "first" }, home);
    assert.equal(created.manifest.revision, 1);
    assert.equal(created.manifest.state, "kept");
    assert.equal(created.manifest.sessionId, "s1");
    const files = await readdir(path.join(home, "surfaces", "bills", "revisions"));
    assert.deepEqual(files, ["00001.json"]);
    const manifest = JSON.parse(await readFile(path.join(home, "surfaces", "bills", "surface.json"), "utf8"));
    assert.equal(manifest.placement, "rail");

    await assert.rejects(mutateSurface("bills", 7, [{ op: "set_title", title: "x" }], undefined, home), /at revision 1, not 7/);
    const m = await mutateSurface("bills", 1, [{ op: "replace_region", target: "list", html: "<ul><li>Rent</li><li>Gas</li></ul>" }, { op: "post", payload: { n: 2 } }], "added gas", home);
    assert.equal(m.manifest.revision, 2);
    assert.deepEqual(m.posts, [{ n: 2 }]);
    const postOnly = await mutateSurface("bills", 2, [{ op: "post", payload: "hi" }], undefined, home);
    assert.equal(postOnly.manifest.revision, 2);
    assert.equal(postOnly.documentChanged, false);

    const back = await rollbackSurface("bills", 1, home);
    assert.equal(back.manifest.revision, 3);
    assert.doesNotMatch(back.document.html, /Gas/);
    const revs = await listSurfaceRevisions("bills", home);
    assert.deepEqual(revs.map((r) => r.revision), [1, 2, 3]);
    assert.equal(revs[1].note, "added gas");

    for (let i = 0; i < 52; i += 1) await mutateSurface("bills", 3 + i, [{ op: "set_title", title: `t${i}` }], undefined, home);
    const pruned = await listSurfaceRevisions("bills", home);
    assert.equal(pruned.length, 50);
    assert.equal(pruned[0].revision, 6);

    assert.equal((await listSurfaces(home)).length, 1);
    assert.equal((await readSurface("bills", home)).manifest.revision, 55);
    assert.equal(await removeSurface("bills", home), true);
    assert.equal(await removeSurface("bills", home), false);
    assert.equal((await listSurfaces(home)).length, 0);

    const types = seen.map((e) => e.type);
    assert.equal(types[0], "surface_revision");
    assert.equal(seen[0].origin, "create");
    assert.ok(types.includes("surface_post"));
    assert.equal(types.at(-1), "surface_removed");
    const rollbackEvent = seen.find((e) => e.origin === "rollback");
    assert.ok(rollbackEvent && rollbackEvent.document.html === PAGE);
  } finally {
    off();
  }
});

test("names are strict and bad documents never land in the ledger", async () => {
  const home = await tmpHome();
  await assert.rejects(createSurface({ name: "Bad Name", title: "x", placement: "card", document: { html: PAGE }, feeds: [], actions: [] }, home), /lowercase/);
  await assert.rejects(createSurface({ name: "noregion", title: "x", placement: "card", document: { html: "<div>hi</div>" }, feeds: [], actions: [] }, home), /data-ares-region/);
  await assert.rejects(createSurface({ name: "flashy", title: "x", placement: "card", document: { html: PAGE, css: "@keyframes b{50%{opacity:0}} .x{animation:b .05s infinite}" }, feeds: [], actions: [] }, home), /flash/);
  assert.equal((await listSurfaces(home)).length, 0);
});

test("Surface tool: drawing-only create runs; feeds/actions are an owner decision; mutate reports stale bases", async () => {
  const home = await tmpHome();
  process.env.ARES_HOME = home;
  const asks = [];
  const ctx = (permissionMode = "workspace-write") => ({
    workspace: home,
    sessionId: "sess-1",
    signal: new AbortController().signal,
    permissionMode,
    fileReadStamps: new Map(),
    async requestPermission(req) {
      asks.push(req);
      return "allow_once";
    },
  });
  const tool = adaptToolForEngine(SurfaceTool, (b) => b);

  const created = await tool.call({ action: "create", name: "hello", title: "Hello", html: PAGE, css: "", js: "" }, ctx());
  assert.equal(created.output.revision, 1);
  assert.equal(created.output.placement, "card");
  assert.deepEqual(created.output.regions, ["main", "list", "status"]);
  assert.equal(asks.length, 0, "a drawing-only surface asks nobody");

  await tool.call({ action: "create", name: "quiet", title: "Quiet", placement: "rail", html: PAGE, feeds: [{ kind: "session.status" }, { kind: "time", everySec: 10 }] }, ctx("bypass"));
  assert.equal(asks.length, 0, "a clock and this chat's status ask nobody");
  const fed = await tool.call({ action: "create", name: "watch", title: "Watch", placement: "rail", html: PAGE, feeds: [{ kind: "session.status" }], actions: ["Weather"] }, ctx("bypass"));
  assert.equal(fed.output.revision, 1);
  assert.equal(asks.length, 1, "feeds/actions ask once, even in free mode");
  assert.equal(asks[0].ownerDecision, true);
  assert.match(asks[0].reason ?? asks[0].prompt ?? "", /watch this chat's status/);
  assert.match(asks[0].reason ?? asks[0].prompt ?? "", /Weather/);

  // Same capabilities again: no second ask. Wider capabilities: asks again.
  await tool.call({ action: "create", name: "watch", title: "Watch", placement: "rail", html: PAGE, feeds: [{ kind: "session.status" }], actions: ["Weather"] }, ctx("bypass"));
  assert.equal(asks.length, 1);
  await tool.call({ action: "create", name: "watch", title: "Watch", placement: "rail", html: PAGE, feeds: [{ kind: "session.status" }, { kind: "time", everySec: 10 }], actions: ["Weather"] }, ctx("bypass"));
  assert.equal(asks.length, 2);

  const stale = await tool.call({ action: "mutate", name: "hello", base_revision: 0, mutations: [{ op: "set_title", title: "x" }] }, ctx());
  assert.match(stale.output.message, /at revision 1, not 0/);
  const good = await tool.call({ action: "mutate", name: "hello", base_revision: 1, mutations: [{ op: "append_region", target: "list", html: "<p>more</p>" }, { op: "post", payload: { x: 1 } }] }, ctx());
  assert.equal(good.output.revision, 2);
  const shown = await tool.call({ action: "show", name: "hello" }, ctx());
  assert.match(shown.output.html, /more/);
  assert.equal(shown.output.revisions.length, 2);
  const listed = await tool.call({ action: "list" }, ctx());
  assert.equal(listed.output.surfaces.length, 3);
  const kept = await tool.call({ action: "keep", name: "hello" }, ctx());
  assert.equal(kept.output.state, "kept");
  await assert.rejects(tool.call({ action: "create", name: "p", title: "p", html: PAGE }, ctx("plan")), /plan mode/);
});

test("the whole window is always the owner's call: placing a surface at root asks even in free mode", async () => {
  const home = await tmpHome();
  process.env.ARES_HOME = home;
  const asks = [];
  const ctx = { workspace: home, sessionId: "s1", signal: new AbortController().signal, permissionMode: "bypass", fileReadStamps: new Map(), async requestPermission(req) { asks.push(req); return "allow_once"; } };
  const tool = adaptToolForEngine(SurfaceTool, (b) => b);
  await tool.call({ action: "create", name: "shell", title: "My Shell", html: PAGE }, ctx);
  assert.equal(asks.length, 0);
  const placed = await tool.call({ action: "place", name: "shell", placement: "root" }, ctx);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].ownerDecision, true);
  assert.match(asks[0].reason ?? asks[0].prompt ?? "", /whole window/);
  assert.match(asks[0].reason ?? asks[0].prompt ?? "", /Restore default shell/);
  assert.equal(placed.output.placement, "root");
});

test("shell layouts are versioned, css cannot reach out, hiding approvals needs its own word", async () => {
  const { ShellTool, readShellLayout, shellCssProblem } = await import("../packages/tools/dist/index.js");
  const home = await tmpHome();
  process.env.ARES_HOME = home;
  const asks = [];
  const ctx = { workspace: home, sessionId: "s1", signal: new AbortController().signal, permissionMode: "bypass", fileReadStamps: new Map(), async requestPermission(req) { asks.push(req); return "allow_once"; } };
  const tool = adaptToolForEngine(ShellTool, (b) => b);
  assert.match(shellCssProblem("@import 'x';"), /@import/);
  assert.match(shellCssProblem(".a{background:url(https://x/y)}"), /data:/);
  assert.equal(shellCssProblem(".a{background:url(data:image/png;base64,AA)}"), null);
  const dead = await tool.call({ action: "set", nav: [{ id: "x-tab", label: "X", surface: "missing" }] }, ctx);
  assert.match(dead.failure ?? "", /No surface named missing/);
  await createSurface({ name: "bills", title: "Bills", placement: "pane", document: { html: PAGE }, feeds: [], actions: [] }, home);
  const one = await tool.call({ action: "set", css: ".rail{width:90px}", hide: ["status"], tabs: [{ id: "bills", label: "Bills", surface: "bills" }] }, ctx);
  assert.equal(asks.length, 0, "a reversible layout change asks nobody");
  assert.equal(one.output.layout.revision, 1);
  const two = await tool.call({ action: "set", hide: [] }, ctx);
  assert.equal(two.output.layout.css, ".rail{width:90px}", "fields not given keep their value");
  const refused = await tool.call({ action: "set", hide: ["approvals"] }, ctx);
  assert.match(refused.failure ?? "", /allow_hide_approvals/);
  await tool.call({ action: "set", hide: ["approvals"], allow_hide_approvals: true }, ctx);
  assert.equal(asks.at(-1).ownerDecision, true);
  await tool.call({ action: "rollback", revision: 1 }, ctx);
  assert.deepEqual((await readShellLayout(home)).hide, ["status"]);
  const before = asks.length;
  const scripted = await tool.call({ action: "set", script: "console.log(1)", note: "fix" }, ctx);
  assert.equal(scripted.output.layout.script, "console.log(1)");
  assert.equal(asks.length, before + 1, "a page script is always an owner decision");
  assert.equal(asks.at(-1).ownerDecision, true);
  assert.match(asks.at(-1).reason ?? asks.at(-1).prompt ?? "", /full authority/);
  await tool.call({ action: "reset" }, ctx);
  const reset = await readShellLayout(home);
  assert.equal(reset.script, "");
  assert.deepEqual([reset.hide, reset.css], [[], ""]);
});

test("slots are valid placements; unknown regions are not", async () => {
  const { isSurfacePlacement } = await import("../packages/protocol/dist/index.js");
  assert.equal(isSurfacePlacement("slot:composer.dock"), true);
  assert.equal(isSurfacePlacement("at:inside:.msTitlebar"), true);
  assert.equal(isSurfacePlacement("at:replace:.settingsFooter button"), true);
  assert.equal(isSurfacePlacement("at:sideways:.x"), false);
  assert.equal(isSurfacePlacement("slot:nowhere"), false);
  assert.equal(isSurfacePlacement("free"), true);
  assert.equal(isSurfacePlacement("root"), true);
});
