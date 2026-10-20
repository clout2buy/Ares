// Workspaces — a VPS the owner's agents work on (owner, 2026-10-20: "an option
// to add a VPS for your agent… and in group chats pick a VPS").
//
// Pinned here (with a fake OpenSSH — no network):
//   1. Adding a box makes Ares's OWN ed25519 key (ssh-keygen) and returns the
//      public half; no password or private key is ever asked for. Bad
//      addresses and user names are refused.
//   2. Test reports what the box is, or turns "Permission denied" into
//      "add the key"; the status is saved.
//   3. Every command runs over key-only, batch-mode SSH, pinned host keys,
//      inside ~/ares-work/<folder> — never a shell string on this PC.
//   4. Remove deletes the key.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DesktopWorkspaces, workFolder } from "../packages/cli/dist/entry/daemon/workspaces.js";
import { makeWorkspaceTool, setWorkspaceHost } from "../packages/cli/dist/entry/workspaceTool.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-ws-"));

function fakeSsh({ allow = true } = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "ssh-keygen") {
      const f = args[args.indexOf("-f") + 1];
      await fs.writeFile(f, "PRIVATE");
      await fs.writeFile(`${f}.pub`, "ssh-ed25519 AAAAC3NzaFAKE ares-test\n");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (cmd === "icacls") return { code: 0, stdout: "", stderr: "", timedOut: false };
    if (cmd === "ssh") {
      if (!allow) return { code: 255, stdout: "", stderr: "root@203.0.113.7: Permission denied (publickey).", timedOut: false };
      const remote = args.at(-1);
      if (remote.includes("PRETTY_NAME")) return { code: 0, stdout: "Ubuntu 24.04.1 LTS · 4 CPU · 7.6 GB\n", stderr: "", timedOut: false };
      if (remote.includes("ARES_SETUP")) return { code: 0, stdout: "git:yes node:v22.12.0 python:3.12.3\n", stderr: "", timedOut: false };
      return { code: 0, stdout: `ran: ${remote}\n`, stderr: "", timedOut: false };
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { run, calls };
}

test("adding a box makes Ares's own key and refuses bad addresses", async () => {
  const home = await tmp();
  const { run, calls } = fakeSsh();
  const events = [];
  const w = new DesktopWorkspaces({ home, run, emit: (e) => events.push(e) });
  await w.load();
  await assert.rejects(w.add({ host: "http://203.0.113.7/" }), /IP or a hostname/);
  await assert.rejects(w.add({ host: "203.0.113.7", user: "Root; rm -rf" }), /user name/);
  const ws = await w.add({ host: "203.0.113.7", label: "Game box" });
  assert.equal(ws.user, "root");
  assert.equal(ws.port, 22);
  assert.match(ws.publicKey, /^ssh-ed25519 /);
  assert.equal(ws.status, "new");
  assert.ok(calls.some((c) => c.cmd === "ssh-keygen" && c.args.includes("ed25519") && c.args.includes("")), "an ed25519 key with no passphrase");
  // persisted and listed
  const again = new DesktopWorkspaces({ home, run, emit: () => undefined });
  assert.equal((await again.load())[0].label, "Game box");
  assert.ok(events.some((e) => e.type === "workspaces_list"));
});

test("test reports the box, or says to add the key; commands run key-only inside the work folder", async () => {
  const home = await tmp();
  const denied = fakeSsh({ allow: false });
  const w = new DesktopWorkspaces({ home, run: denied.run, emit: () => undefined });
  await w.load();
  const ws = await w.add({ host: "203.0.113.7" });
  const bad = await w.test(ws.id);
  assert.equal(bad.status, "error");
  assert.match(bad.error, /doesn't know Ares's key yet/);

  const ok = fakeSsh();
  const w2 = new DesktopWorkspaces({ home, run: ok.run, emit: () => undefined });
  await w2.load();
  const good = await w2.test(ws.id);
  assert.equal(good.status, "ok");
  assert.match(good.info, /Ubuntu 24\.04/);
  const set = await w2.setUp(ws.id);
  assert.equal(set.setUp, true);
  assert.match(set.info, /node:v22/);

  await w2.exec(ws.id, "node build.js", { folder: "Neon Brawl!" });
  const call = ok.calls.filter((c) => c.cmd === "ssh").at(-1);
  for (const flag of ["BatchMode=yes", "IdentitiesOnly=yes", "StrictHostKeyChecking=accept-new"]) assert.ok(call.args.includes(flag), flag);
  assert.ok(call.args.some((a) => a.startsWith("UserKnownHostsFile=")), "host keys pinned per box");
  assert.equal(call.args.at(-2), "root@203.0.113.7");
  assert.match(call.args.at(-1), /^mkdir -p ~\/ares-work\/neon-brawl && cd ~\/ares-work\/neon-brawl && node build\.js$/);
  assert.equal(workFolder("Crix & Cupid"), "crix-cupid");

  await w2.remove(ws.id);
  assert.equal(w2.list().length, 0);
  await assert.rejects(fs.stat(path.join(home, "workspaces", ws.id, "id_ed25519")));
});

test("the Workspace tool asks the host which box and folder, and shows the output", async () => {
  const seen = [];
  setWorkspaceHost({
    resolve: () => ({ id: "ws_1", label: "Game box", folder: "brawl", host: "203.0.113.7" }),
    run: async (sid, command) => { seen.push({ sid, command }); return { code: 0, stdout: "built\n", stderr: "", timedOut: false, label: "Game box", folder: "brawl" }; },
    put: async () => ({ ok: true, label: "Game box", folder: "brawl" }),
    get: async () => ({ ok: true, path: "/tmp/x" }),
  });
  const tool = makeWorkspaceTool();
  const out = await tool.call({ action: "run", command: "node build.js" }, { sessionId: "sess_seat" });
  assert.deepEqual(seen, [{ sid: "sess_seat", command: "node build.js" }]);
  assert.match(out.display, /Game box:~\/ares-work\/brawl \$ node build\.js[\s\S]*exit 0[\s\S]*built/);
  const where = await tool.call({ action: "where" }, { sessionId: "sess_seat" });
  assert.match(where.display, /Game box \(203\.0\.113\.7\) · ~\/ares-work\/brawl/);
  setWorkspaceHost(undefined);
});
