// The phone Terminal tab, server side (docs/TERMINAL.md). Real RemoteAgentServer,
// real WebSocket client, real tmux: needs the tmux binary (doingbox has it);
// without one the suite skips rather than lying.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fsp, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { createTerminalApi, utf8CompleteLength, buildTerminalEnv, remoteClass, scrubText, tokenEquals, OutputRing } from "../packages/cli/dist/phoneTerminal.js";
import { ownerPause, stopAllStoppables, readAudit } from "../packages/core/dist/index.js";

const OWNER = "owner-token-0123456789abcdef";
const haveTmux = spawnSync("tmux", ["-V"]).status === 0 && process.platform === "linux";
const skip = haveTmux ? false : "tmux is not available here";

let counter = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A real server with the terminal mounted, a private home and a private tmux socket. */
async function rig(t, over = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-term-test-"));
  const socket = `ares-term-test-${process.pid}-${++counter}`;
  const terminal = createTerminalApi({ home, ownerToken: () => OWNER, socket, server: "direct", pollMs: 100, ...over });
  const srv = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: OWNER, phoneApi: { terminal } });
  await srv.start();
  const base = `http://127.0.0.1:${srv.port}`;
  const rigObj = {
    home, socket, terminal, srv, base,
    call: (method, p, body, token = OWNER) =>
      fetch(base + p, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    async create(body = {}) {
      const r = await rigObj.call("POST", "/gateway/terminal/sessions", { cols: 100, rows: 30, ...body });
      assert.equal(r.status, 200, await r.clone().text());
      return (await r.json()).id;
    },
    open(id, { cols = 100, rows = 30, since, token = OWNER } = {}) {
      return openClient(srv.port, id, { cols, rows, since, token });
    },
  };
  t.after(async () => {
    await terminal.killAll("test cleanup").catch(() => {});
    terminal.dispose();
    spawnSync("tmux", ["-L", socket, "kill-server"]);
    await srv.close();
    await fsp.rm(home, { recursive: true, force: true });
  });
  return rigObj;
}

/** A WebSocket client that records every frame. */
function openClient(port, id, { cols, rows, since, token }) {
  const qs = new URLSearchParams({ cols: String(cols), rows: String(rows), ...(since !== undefined ? { since: String(since) } : {}) });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway/terminal/${id}?${qs}`);
  const c = { ws, frames: [], closed: null, text: "", lastSeq: 0 };
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    c.frames.push(f);
    if (f.t === "out" || f.t === "replay") { c.text += f.d; c.lastSeq = f.seq; }
  });
  ws.on("close", (code) => { c.closed = code; });
  c.opened = new Promise((resolve, reject) => { ws.once("open", () => { ws.send(JSON.stringify({ t: "hello", token })); resolve(); }); ws.once("error", reject); });
  c.send = (obj) => ws.send(JSON.stringify(obj));
  c.type = (s) => c.send({ t: "in", d: s });
  c.waitText = (needle, ms = 8000) => until(() => (typeof needle === "string" ? c.text.includes(needle) : needle.test(c.text)), ms, `text ${needle}`);
  c.waitFrame = (pred, ms = 8000) => until(() => c.frames.find(pred), ms, "frame");
  c.ready = async () => { await c.opened; await c.waitFrame((f) => f.t === "replay" || f.t === "error"); return c; };
  c.close = () => new Promise((r) => { if (c.closed !== null) return r(); ws.once("close", () => r()); ws.close(); });
  return c;
}

const pgrep = (pattern) => spawnSync("pgrep", ["-f", pattern]).stdout.toString().trim().split("\n").filter(Boolean);

// ── pure pieces ──────────────────────────────────────────────────────────────

test("utf8CompleteLength holds back a split character and nothing else", () => {
  const euro = Buffer.from("a€b", "utf8"); // 61 e2 82 ac 62
  assert.equal(utf8CompleteLength(euro), 5);
  assert.equal(utf8CompleteLength(euro.subarray(0, 2)), 1); // 'a' + first byte of the euro
  assert.equal(utf8CompleteLength(euro.subarray(0, 3)), 1);
  assert.equal(utf8CompleteLength(euro.subarray(0, 4)), 4);
  const emoji = Buffer.from("x\u{1F642}", "utf8");
  for (let n = 2; n < 5; n++) assert.equal(utf8CompleteLength(emoji.subarray(0, n)), 1, `cut at ${n}`);
  assert.equal(utf8CompleteLength(emoji), 5);
  assert.equal(utf8CompleteLength(Buffer.from([0x80, 0x80])), 2, "stray continuation bytes are not waited for");
  assert.equal(utf8CompleteLength(Buffer.alloc(0)), 0);
});

test("OutputRing keeps an absolute byte offset across trimming", () => {
  const ring = new OutputRing(10, 1000);
  ring.push(Buffer.from("abcdef"));
  ring.push(Buffer.from("ghijkl"));
  assert.equal(ring.head, 1012);
  assert.equal(ring.start, 1006, "oldest chunk dropped whole");
  assert.equal(ring.slice(1000), null, "gone");
  assert.equal(ring.slice(1006).toString(), "ghijkl");
  assert.equal(ring.slice(1008, 1010).toString(), "ij");
  assert.equal(ring.slice(1013), null, "from the future");
});

test("the child environment is an allowlist, never the garrison's own", () => {
  const env = buildTerminalEnv({
    PATH: "/usr/bin", HOME: "/home/x", USER: "x", ARES_HOME: "/h", ARES_APNS_KEY_PATH: "/k.p8", EXPO_TOKEN: "e", OPENAI_API_KEY: "o",
    ANTHROPIC_API_KEY: "a", GITHUB_CLIENT_SECRET: "g", LANG: "C", TERM: "dumb",
  });
  assert.deepEqual(Object.keys(env).sort(), ["COLORTERM", "HOME", "LANG", "LOGNAME", "PATH", "TERM", "USER"]);
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(buildTerminalEnv({ PATH: "/p", FOO_OK: "1" }, ["FOO_OK"]).FOO_OK, "1", "explicit opt-in works");
});

test("transport classes: only loopback sockets can be 'tunnel'; LAN is never trusted by its headers", () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.deepEqual(remoteClass(req("127.0.0.1")), { cls: "loopback", plainHttp: false });
  assert.deepEqual(remoteClass(req("::ffff:127.0.0.1", { "cf-connecting-ip": "1.2.3.4", "x-forwarded-proto": "https" })), { cls: "tunnel", plainHttp: false });
  assert.deepEqual(remoteClass(req("127.0.0.1", { "cf-ray": "x", "x-forwarded-proto": "http" })), { cls: "tunnel", plainHttp: true });
  assert.equal(remoteClass(req("192.168.1.9", { "x-forwarded-proto": "https", "cf-ray": "x" })).cls, "lan");
  assert.equal(remoteClass(req("192.168.1.9")).plainHttp, true);
});

test("scrubText and tokenEquals", () => {
  assert.equal(scrubText("a sk_live_abcdefgh1234 b"), "a [redacted] b");
  assert.equal(scrubText("tok=supersecretvalue1", ["supersecretvalue1"]), "tok=[redacted]");
  assert.match(scrubText("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"), /^\[redacted\]$/);
  assert.equal(tokenEquals("abc", "abc"), true);
  assert.equal(tokenEquals("abd", "abc"), false);
  assert.equal(tokenEquals("", ""), false);
  assert.equal(tokenEquals("abc", undefined), false);
});

// ── the real thing ───────────────────────────────────────────────────────────

test("create, echo roundtrip, listing and rename", { skip }, async (t) => {
  const r = await rig(t);
  const id = await r.create({ title: "  my\u0007 box  " });
  assert.match(id, /^t-[0-9a-f]{8}$/);
  const c = await r.open(id).ready();
  assert.equal(c.frames[0].t, "ready");
  c.type("echo hello-$((6*7))\n");
  await c.waitText("hello-42");
  const list = await (await r.call("GET", "/gateway/terminal")).json();
  assert.equal(list.enabled, true);
  assert.equal(list.max, 6);
  assert.equal(list.sessions.length, 1);
  const s = list.sessions[0];
  assert.equal(s.id, id);
  assert.equal(s.title, "my box");
  assert.equal(s.alive, true);
  assert.equal(s.attached, true);
  assert.equal(s.cols, 100);
  assert.ok(Date.parse(s.createdAt) > 0 && Date.parse(s.lastActiveAt) > 0);
  assert.equal((await (await r.call("POST", `/gateway/terminal/sessions/${id}/rename`, { title: "renamed" })).json()).title, "renamed");
  assert.equal((await (await r.call("GET", "/gateway/terminal")).json()).sessions[0].title, "renamed");
  assert.equal((await r.call("POST", `/gateway/terminal/sessions/t-00000000/rename`, { title: "x" })).status, 404);
  assert.equal((await r.call("POST", `/gateway/terminal/sessions/..%2Fx/rename`, { title: "x" })).status, 404);
  const shellEnv = await new Promise((resolve) => { c.type("echo HOME=$HOME PWD=$PWD SHLVL=$SHLVL TERM=$TERM LANG=$LANG\n"); resolve(c.waitText(/HOME=\S+ PWD=\S+ SHLVL=\d+ TERM=xterm-256color LANG=en_US\.UTF-8/)); });
  assert.ok(shellEnv);
  await c.close();
});

test("a real controlling terminal: stty size follows the resize frame and the connect query", { skip }, async (t) => {
  const r = await rig(t);
  const id = await r.create({ cols: 90, rows: 28 });
  const c = await r.open(id, { cols: 120, rows: 40 }).ready();
  c.type("stty size\n");
  await c.waitText("40 120");
  c.send({ t: "resize", cols: 77, rows: 33 });
  await until(async () => (await (await r.call("GET", "/gateway/terminal")).json()).sessions[0].cols === 77, 5000, "resize");
  c.type("stty size\n");
  await c.waitText("33 77");
  await c.close();
});

test("detach and reattach: since= replays exactly what was missed, no since= gives a fresh snapshot", { skip }, async (t) => {
  const r = await rig(t);
  const id = await r.create();
  const a = await r.open(id).ready();
  a.type("echo before-detach-1\n");
  await a.waitText("before-detach-1");
  a.type("(sleep 1; echo LATE-MARK-77) &\n");
  await a.waitText("[1]");
  const seq = a.lastSeq;
  await a.close();
  await until(async () => !(await (await r.call("GET", "/gateway/terminal")).json()).sessions[0].attached, 4000, "detached");
  await sleep(1500);
  const b = await r.open(id, { since: seq }).ready();
  const replay = b.frames.find((f) => f.t === "replay");
  assert.equal(replay.reset, false, "exact continuation");
  assert.ok(replay.d.includes("LATE-MARK-77"), "the output produced while away is replayed");
  assert.ok(!replay.d.includes("before-detach-1"), "and only that");
  assert.ok(replay.seq > seq);
  b.type("echo after-reattach\n");
  await b.waitText("after-reattach");
  await b.close();
  const c = await r.open(id).ready();
  const snap = c.frames.find((f) => f.t === "replay");
  assert.equal(snap.reset, true);
  assert.ok(snap.d.includes("before-detach-1") && snap.d.includes("LATE-MARK-77") && snap.d.includes("after-reattach"), "snapshot has the scrollback and the screen");
  assert.ok(Buffer.byteLength(snap.d) <= 256 * 1024);
  await c.close();
  // a since= from another incarnation of the stream is not trusted
  const d = await r.open(id, { since: 5 }).ready();
  assert.equal(d.frames.find((f) => f.t === "replay").reset, true);
  await d.close();
});

test("vim-style full screen apps survive a reattach (alternate screen snapshot)", { skip }, async (t) => {
  const r = await rig(t);
  const id = await r.create();
  const a = await r.open(id).ready();
  a.type("printf '\\033[?1049h\\033[2J\\033[5;10HALT-SCREEN-TEXT'; sleep 30\n");
  await a.waitText("ALT-SCREEN-TEXT");
  await a.close();
  const b = await r.open(id).ready();
  const snap = b.frames.find((f) => f.t === "replay");
  assert.ok(snap.d.includes("ALT-SCREEN-TEXT"));
  assert.ok(snap.d.includes("\u001b[?1049h"), "back into the alternate screen");
  b.type("\x03");
  await b.close();
});

test("ctrl-c interrupts a sleep (job control through the real tty)", { skip }, async (t) => {
  const r = await rig(t);
  const id = await r.create();
  const c = await r.open(id).ready();
  c.type("sleep 4172\n");
  await until(() => pgrep("sleep 4172").length > 0, 4000, "sleep running");
  c.type("\x03");
  await until(() => pgrep("sleep 4172").length === 0, 4000, "sleep interrupted");
  c.type("echo after-int-$?\n");
  await c.waitText("after-int-130");
  c.type("sleep 4173\n");
  await until(() => pgrep("sleep 4173").length > 0, 4000);
  c.type("\x1a"); // ctrl-z: stopped, not killed
  await c.waitText("Stopped");
  assert.equal(pgrep("sleep 4173").length, 1);
  c.type("kill %1\n");
  await c.close();
});

test("exit frame carries the shell's exit code and the exited terminal stays listed", { skip }, async (t) => {
  const r = await rig(t);
  const id = await r.create();
  const c = await r.open(id).ready();
  c.type("echo last-words; exit 7\n");
  const exit = await c.waitFrame((f) => f.t === "exit");
  assert.equal(exit.code, 7);
  assert.ok(c.text.includes("last-words"), "output before exit is not lost");
  await until(() => c.closed !== null, 3000, "socket closed after exit");
  const list = await (await r.call("GET", "/gateway/terminal")).json();
  assert.equal(list.sessions[0].alive, false);
  assert.equal(list.sessions[0].exitCode, 7);
  const again = await r.open(id).ready();
  await again.waitFrame((f) => f.t === "exit");
  assert.ok(again.frames.find((f) => f.t === "replay").d.includes("last-words"));
  // command mode: the terminal IS the command
  const id2 = await r.create({ command: "echo cmd-mode; exit 3" });
  const c2 = await r.open(id2).ready();
  assert.equal((await c2.waitFrame((f) => f.t === "exit")).code, 3);
});

test("DELETE kills the whole process tree and the tmux session; no orphans", { skip }, async (t) => {
  const r = await rig(t);
  const id = await r.create();
  const c = await r.open(id).ready();
  c.type("sleep 4174 & bash -c 'sleep 4175 & sleep 4176 & wait' & sleep 4177\n");
  await until(() => ["4174", "4175", "4176", "4177"].every((n) => pgrep(`sleep ${n}`).length > 0), 6000, "tree running");
  assert.equal((await (await r.call("DELETE", `/gateway/terminal/sessions/${id}`)).json()).ok, true);
  await until(() => ["4174", "4175", "4176", "4177"].every((n) => pgrep(`sleep ${n}`).length === 0), 5000, "no orphans");
  await until(() => c.closed !== null, 3000, "client closed");
  assert.notEqual(spawnSync("tmux", ["-L", r.socket, "has-session", "-t", id]).status, 0, "tmux session gone");
  assert.equal((await (await r.call("GET", "/gateway/terminal")).json()).sessions.length, 0);
  assert.equal((await r.call("DELETE", `/gateway/terminal/sessions/${id}`)).status, 404);
  const gone = await fsp.readdir(path.join(r.home, "terminal", "run"));
  assert.ok(!gone.some((f) => f.startsWith(id)), "fifo removed");
});

test("auth: no bearer 401, any non-owner token 403 on every route and on the socket", { skip }, async (t) => {
  const r = await rig(t);
  const id = await r.create();
  const routes = [
    ["GET", "/gateway/terminal"],
    ["POST", "/gateway/terminal/sessions", { cols: 80, rows: 24 }],
    ["POST", `/gateway/terminal/sessions/${id}/rename`, { title: "x" }],
    ["DELETE", `/gateway/terminal/sessions/${id}`],
    ["POST", "/gateway/terminal/run", { command: "id" }],
  ];
  for (const [m, p, b] of routes) {
    assert.equal((await r.call(m, p, b, null)).status, 401, `${m} ${p} anonymous`);
    assert.equal((await r.call(m, p, b, "a-guest-token")).status, 403, `${m} ${p} guest`);
    assert.equal((await r.call(m, p, b, OWNER.slice(0, -1) + "x")).status, 403, `${m} ${p} near miss`);
  }
  assert.equal((await (await r.call("GET", "/gateway/terminal")).json()).sessions.length, 1, "nothing was killed or created by the denied calls");
  const bad = r.open(id, { token: "a-guest-token" });
  await bad.opened;
  await until(() => bad.closed !== null, 3000, "refused");
  assert.equal(bad.closed, 4403);
  assert.equal(bad.frames.find((f) => f.t === "error").message, "owner only");
  // a frame before hello is not a free pass
  const ws = new WebSocket(`ws://127.0.0.1:${r.srv.port}/gateway/terminal/${id}`);
  await new Promise((res) => ws.once("open", res));
  ws.send(JSON.stringify({ t: "in", d: "echo pwned\n" }));
  await new Promise((res) => ws.once("close", (code) => res(code)));
  assert.equal(pgrep("pwned").length, 0);
  // the denials are audited
  const denied = (await readAudit({ home: r.home, actionPrefix: "terminal.denied", limit: 50 })).length;
  assert.ok(denied >= routes.length * 2 + 1, `denials audited (${denied})`);
  // a server with no terminal hook answers 401/404 like any unknown route, and refuses the socket
  const plain = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: OWNER });
  await plain.start();
  t.after(() => plain.close());
  assert.equal((await fetch(`http://127.0.0.1:${plain.port}/gateway/terminal`, { headers: { authorization: `Bearer ${OWNER}` } })).status, 404);
});

test("kill switch ARES_TERMINAL=0, owner stop, owner pause", { skip }, async (t) => {
  const r = await rig(t);
  const id = await r.create();
  const live = await r.open(id).ready();

  // owner pause: new work refused, live sockets closed, shell kept
  ownerPause.pause();
  try {
    assert.equal((await r.call("POST", "/gateway/terminal/sessions", { cols: 80, rows: 24 })).status, 423);
    assert.equal((await r.call("POST", "/gateway/terminal/run", { command: "id" })).status, 423);
    await until(() => live.closed !== null, 3000, "paused socket closed");
    assert.equal(live.closed, 4423);
    const refused = await r.open(id).opened.then(() => null);
    assert.equal(refused, null);
  } finally {
    ownerPause.resume();
  }
  assert.equal((await (await r.call("GET", "/gateway/terminal")).json()).sessions.length, 1, "pause does not kill the shell");

  // owner stop (the big red button) kills terminals as stoppable jobs
  const stopped = await stopAllStoppables("stopped by owner");
  assert.equal(stopped.job, 1);
  await until(async () => (await (await r.call("GET", "/gateway/terminal")).json()).sessions.length === 0, 4000, "stopped");

  // kill switch
  const id2 = await r.create();
  const before = await r.open(id2).ready();
  process.env.ARES_TERMINAL = "0";
  try {
    const list = await (await r.call("GET", "/gateway/terminal")).json();
    assert.equal(list.enabled, false);
    assert.deepEqual(list.sessions, []);
    const create = await r.call("POST", "/gateway/terminal/sessions", { cols: 80, rows: 24 });
    assert.equal(create.status, 503);
    assert.equal((await create.json()).enabled, false);
    assert.equal((await r.call("POST", "/gateway/terminal/run", { command: "id" })).status, 503);
    const sock = r.open(id2);
    await sock.opened;
    await until(() => sock.closed !== null, 3000);
    assert.equal(sock.closed, 4503);
  } finally {
    delete process.env.ARES_TERMINAL;
  }
  await before.close();
});

test("max concurrent terminals and creation rate limit", { skip }, async (t) => {
  const r = await rig(t, { max: 2, createsPerMinute: 3 });
  await r.create();
  await r.create();
  const third = await r.call("POST", "/gateway/terminal/sessions", { cols: 80, rows: 24 });
  assert.equal(third.status, 409);
  assert.equal((await third.json()).max, 2);
  const bad = [{ cols: 80, rows: 24, cwd: "relative/path" }, { cols: 80, rows: 24, cwd: "/definitely/not/here" }, { cols: 80, rows: 24, command: "x".repeat(5000) }];
  for (const b of bad) assert.equal((await r.call("POST", "/gateway/terminal/sessions", b)).status, 400, JSON.stringify(b).slice(0, 50));
  const rate = await rig(t, { max: 6, createsPerMinute: 2 });
  await rate.create();
  await rate.create();
  const limited = await rate.call("POST", "/gateway/terminal/sessions", { cols: 80, rows: 24 });
  assert.equal(limited.status, 429);
  assert.ok((await limited.json()).retryAfterSec >= 1);
});

test("the shell's environment carries none of Ares's secrets", { skip }, async (t) => {
  const planted = {
    ARES_TEST_GATEWAY_TOKEN: "ares-secret-aaaa1111", ARES_APNS_KEY_PATH: "/secret/AuthKey_ZZZ.p8", APNS_KEY_ID: "apnskey-bbbb2222",
    GOOGLE_OAUTH_CLIENT_SECRET: "oauth-secret-cccc3333", EXPO_TOKEN: "expo-secret-dddd4444", ANTHROPIC_API_KEY: "sk-ant-eeee5555",
  };
  Object.assign(process.env, planted);
  t.after(() => { for (const k of Object.keys(planted)) delete process.env[k]; });
  const r = await rig(t);
  const id = await r.create();
  const c = await r.open(id).ready();
  c.type("env | sort; echo ENV-DONE-$((6*7))\n");
  await c.waitText("ENV-DONE-42");
  assert.match(c.text, /TERM=xterm-256color/);
  assert.match(c.text, /LANG=en_US\.UTF-8/);
  assert.match(c.text, /HOME=/);
  for (const [k, v] of Object.entries(planted)) {
    assert.ok(!c.text.includes(v), `${k} value leaked`);
    assert.ok(!new RegExp(`^${k}=`, "m").test(c.text), `${k} present`);
  }
  assert.ok(!/^ARES_/m.test(c.text), "no ARES_ variable at all");
  const run = await (await r.call("POST", "/gateway/terminal/run", { command: "env" })).json();
  for (const v of Object.values(planted)) assert.ok(!run.stdout.includes(v));
  assert.equal(run.exitCode, 0);
  await c.close();
});

test("idle timeout kills a terminal nobody is attached to (fake short timer)", { skip }, async (t) => {
  const r = await rig(t, { idleMs: 700 });
  const kept = await r.create();
  const idle = await r.create();
  const holder = await r.open(kept).ready();
  await until(async () => (await (await r.call("GET", "/gateway/terminal")).json()).sessions.length === 1, 6000, "idle terminal reaped");
  const left = (await (await r.call("GET", "/gateway/terminal")).json()).sessions;
  assert.equal(left[0].id, kept, "the attached terminal is never idle");
  // the list shrinks first; the tmux session is killed and the audit entry written right after
  await until(() => spawnSync("tmux", ["-L", r.socket, "has-session", "-t", idle]).status !== 0, 4000, "idle tmux session killed");
  await until(async () => (await readAudit({ home: r.home, actionPrefix: "terminal.idle", limit: 5 })).length >= 1, 4000, "idle reap audited");
  const entries = await readAudit({ home: r.home, actionPrefix: "terminal.idle", limit: 5 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].target, `terminal:${idle}`);
  await sleep(900);
  assert.equal((await (await r.call("GET", "/gateway/terminal")).json()).sessions.length, 1, "still alive while attached, long past the idle limit");
  await holder.close();
  await until(async () => (await (await r.call("GET", "/gateway/terminal")).json()).sessions.length === 0, 6000, "reaped after detach");
});

test("UTF-8: a character split across chunks arrives whole, and input round-trips", { skip }, async (t) => {
  const r = await rig(t, { flushMs: 5 });
  const id = await r.create();
  const c = await r.open(id).ready();
  c.type("printf 'a\\342\\202'; sleep 0.4; printf '\\254b\\360\\237'; sleep 0.4; printf '\\231\\202c\\n'; echo SPLIT-$((6*7))\n");
  // a marker the shell computes: the echo of the typed line must not satisfy the wait
  await c.waitText("SPLIT-42");
  assert.ok(c.text.includes("a€b\u{1F642}c"), "split euro and emoji reassembled");
  assert.ok(!c.text.includes("�"), "no replacement characters");
  for (const f of c.frames.filter((x) => x.t === "out")) assert.ok(!f.d.includes("�"));
  c.type("echo 'héllo € \u{1F642} 日本'\n");
  await c.waitText("héllo € \u{1F642} 日本\r\n");
  // seq always lands on a character boundary, so a resume from it is clean
  const seqs = c.frames.filter((x) => x.t === "out").map((x) => x.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  await c.close();
});

test("slow client: output is dropped and resynced, the server never blocks, other clients and HTTP stay live", { skip }, async (t) => {
  const r = await rig(t, { flushMs: 10, highWaterBytes: 64 * 1024, maxLagBytes: 128 * 1024 });
  const id = await r.create();
  const fast = await r.open(id).ready();
  const slow = await r.open(id).ready();
  slow.ws._socket.pause(); // the phone stops reading
  fast.type("yes abcdefghijklmnopqrstuvwxyz0123456789 | head -c 40000000; echo FLOOD-$((6*7))\n");
  const started = Date.now();
  await fast.waitText("FLOOD-42", 30000);
  const flood = Date.now() - started;
  assert.ok(flood < 25000, `the engine was not held back by the slow phone (${flood} ms)`);
  // http answers promptly while the slow socket is still stalled
  const t0 = Date.now();
  const run = await (await r.call("POST", "/gateway/terminal/run", { command: "echo alive" })).json();
  assert.equal(run.stdout.trim(), "alive");
  assert.ok(Date.now() - t0 < 3000);
  // the phone wakes up: it is resynced with a snapshot, not fed 40 MB
  slow.ws._socket.resume();
  await slow.waitFrame((f) => f.t === "replay" && f.reset === true && slow.frames.indexOf(f) > 0, 15000);
  await until(() => slow.text.includes("FLOOD-42"), 15000, "slow client catches up to the end");
  const received = slow.frames.filter((f) => f.t === "out").reduce((n, f) => n + f.d.length, 0);
  assert.ok(received < 20_000_000, `slow client received ${received} bytes of a 40 MB flood: it was resynced, not fed everything`);
  // (no "fast received more than slow": a flood this size outruns any client, so the fast one is
  // resynced too by design. What matters is that the stalled phone held nobody back, asserted above.)
  await slow.close();
  await fast.close();
});

test("audit: create/attach/detach/kill recorded with sizes, never keystroke content", { skip }, async (t) => {
  const r = await rig(t);
  const id = await r.create();
  const c = await r.open(id).ready();
  c.type("echo KEYSTROKE-CANARY-9931 && sleep 0.2\n");
  await c.waitText("KEYSTROKE-CANARY-9931");
  await c.close();
  await until(async () => (await readAudit({ home: r.home, actionPrefix: "terminal.detach", limit: 5 })).length === 1, 4000, "detach audited");
  await r.call("DELETE", `/gateway/terminal/sessions/${id}`);
  await until(async () => (await readAudit({ home: r.home, actionPrefix: "terminal.kill", limit: 5 })).length === 1, 4000, "kill audited");
  const all = await readAudit({ home: r.home, actionPrefix: "terminal.", limit: 50 });
  const actions = all.map((e) => e.action).sort();
  assert.deepEqual(actions, ["terminal.attach", "terminal.create", "terminal.detach", "terminal.kill"]);
  const detach = all.find((e) => e.action === "terminal.detach");
  assert.ok(detach.params.bytesIn > 0 && detach.params.bytesOut > 0 && detach.params.remote === "loopback");
  const raw = await fsp.readFile(path.join(r.home, "audit", `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
  assert.ok(!raw.includes("KEYSTROKE-CANARY"), "no keystroke content in the audit trail");
  assert.ok(!raw.includes(OWNER), "no token in the audit trail");
  await assert.rejects(fsp.stat(path.join(r.home, "terminal", "logs")), "no transcript unless asked");
});

test("ARES_TERMINAL_LOG=1 writes a 0600 output transcript", { skip }, async (t) => {
  process.env.ARES_TERMINAL_LOG = "1";
  t.after(() => delete process.env.ARES_TERMINAL_LOG);
  const r = await rig(t);
  const id = await r.create();
  const c = await r.open(id).ready();
  c.type("echo TRANSCRIPT-LINE-5\n");
  await c.waitText("TRANSCRIPT-LINE-5");
  const file = path.join(r.home, "terminal", "logs", `${id}.log`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await until(async () => (await fsp.readFile(file, "utf8")).includes("TRANSCRIPT-LINE-5"), 3000, "transcript written");
  await c.close();
});

test("one-shot run: exit code, stderr, timeout, truncation, scrubbing, cwd", { skip }, async (t) => {
  const r = await rig(t);
  const run = async (b) => (await r.call("POST", "/gateway/terminal/run", b)).json();
  let out = await run({ command: "echo out; echo err 1>&2; exit 3" });
  assert.deepEqual([out.exitCode, out.stdout, out.stderr, out.timedOut], [3, "out\n", "err\n", false]);
  out = await run({ command: "echo sk_live_abcdefgh12345678 and token", timeoutSec: 5 });
  assert.equal(out.stdout, "[redacted] and token\n");
  const t0 = Date.now();
  out = await run({ command: "sleep 4178", timeoutSec: 1 });
  assert.equal(out.timedOut, true);
  assert.ok(Date.now() - t0 < 4000);
  await until(() => pgrep("sleep 4178").length === 0, 3000, "timed-out command killed");
  out = await run({ command: "head -c 300000 /dev/zero | tr '\\0' a" });
  assert.equal(out.truncated, true);
  assert.equal(out.stdout.length, 64 * 1024);
  out = await run({ command: "pwd", cwd: "/tmp" });
  assert.equal(out.stdout.trim(), "/tmp");
  assert.equal((await r.call("POST", "/gateway/terminal/run", { command: "" })).status, 400);
  assert.equal((await r.call("POST", "/gateway/terminal/run", { command: "id", cwd: "rel" })).status, 400);
  assert.equal((await run({ command: "echo hi", timeoutSec: 9999 })).exitCode, 0, "timeout is clamped, not rejected");
  // the audit append is asynchronous: the last run's entry can land just after its response
  await until(async () => (await readAudit({ home: r.home, actionPrefix: "terminal.run", limit: 20 })).length >= 6, 4000, "all six runs audited");
  const audited = await readAudit({ home: r.home, actionPrefix: "terminal.run", limit: 20 });
  assert.ok(!JSON.stringify(audited).includes("sk_live_abcdefgh12345678"), "secret shapes are redacted in the audit too");
});

test("terminals are re-adopted by a fresh service on the same socket (garrison restart)", { skip }, async (t) => {
  const r = await rig(t);
  const id = await r.create({ title: "survivor" });
  const c = await r.open(id).ready();
  c.type("echo remember-me-42\n");
  await c.waitText("remember-me-42");
  await c.close();
  r.terminal.dispose();
  const terminal2 = createTerminalApi({ home: r.home, ownerToken: () => OWNER, socket: r.socket, server: "direct", pollMs: 100 });
  const srv2 = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: OWNER, phoneApi: { terminal: terminal2 } });
  await srv2.start();
  t.after(async () => { terminal2.dispose(); await srv2.close(); });
  const list = await (await fetch(`http://127.0.0.1:${srv2.port}/gateway/terminal`, { headers: { authorization: `Bearer ${OWNER}` } })).json();
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].title, "survivor");
  assert.equal(list.sessions[0].id, id);
  const d = await openClient(srv2.port, id, { cols: 100, rows: 30, token: OWNER }).ready();
  assert.ok(d.frames.find((f) => f.t === "replay").d.includes("remember-me-42"));
  d.type("echo still-here\n");
  await d.waitText("still-here");
  await d.close();
  await terminal2.killAll("done");
});
