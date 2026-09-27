// Two things the owner could see from the chat header down.
//
// 1. Every phone session was named after the briefing the app prepends to the
//    first message, so the header read "(System: This conversa…" and the
//    session list was a column of identical rows.
// 2. Pages Ares builds in the system temp dir linked to "not found", because
//    temp was not a served root. Serving it means a symlink out of it must not
//    be — /tmp is world-writable.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { rehydrateSession, rolloutPath, sessionsDir } from "../packages/garrison/dist/index.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";

const PREAMBLE =
  "(System: This conversation is over the Ares iPhone app; the user is on their phone, away from the computer. " +
  "They cannot see your screen, tool output, or files (sorry!) — describe what matters, briefly.)";

async function sessionWith(t, firstUserText, storedTitle) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-home-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.mkdir(sessionsDir(home), { recursive: true });
  const id = "sess_title";
  await fsp.writeFile(
    rolloutPath(home, id),
    JSON.stringify({
      ts: "2026-09-22T08:00:00.000Z",
      event: {
        type: "input_admitted",
        inputId: "input_1",
        sessionId: id,
        delivery: "queue",
        userMessage: { id: "m1", role: "user", content: [{ type: "text", text: firstUserText }] },
      },
    }) + "\n",
  );
  if (storedTitle !== undefined) {
    await fsp.writeFile(path.join(sessionsDir(home), `${id}.meta.json`), JSON.stringify({ title: storedTitle }));
  }
  return rehydrateSession(home, id);
}

test("a phone session is named after what the owner said, not the briefing", async (t) => {
  const session = await sessionWith(t, `${PREAMBLE}\n\nfix the minecraft server`);
  assert.equal(session?.title, "fix the minecraft server");
});

test("a title already written with the briefing in it heals on read", async (t) => {
  const session = await sessionWith(t, `${PREAMBLE}\n\nfix the minecraft server`, `${PREAMBLE} fix the minecraft server`);
  assert.match(session?.title ?? "", /^fix the minecraft server/, "no migration needed for old threads");
  assert.doesNotMatch(session?.title ?? "", /System:/);
});

test("a message that is only a briefing does not become the title", async (t) => {
  const session = await sessionWith(t, PREAMBLE);
  assert.equal(session?.title, "untitled session");
});

test("an ordinary message keeps its parentheses", async (t) => {
  const plain = await sessionWith(t, "check the logs (the docker ones) please");
  assert.equal(plain?.title, "check the logs (the docker ones) please");
  // A ")" inside the note must not end it early — that is why this scans
  // parentheses instead of matching a regex.
  const nested = await sessionWith(t, "(System: note (with parens) inside) the real ask");
  assert.equal(nested?.title, "the real ask");
});

test("pages Ares builds in temp actually open", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dbx-grid-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const page = path.join(dir, "index.html");
  await fsp.writeFile(page, "<h1>grid</h1>");

  const server = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok",
    phoneApi: { artifactRoots: [os.tmpdir()] },
  });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { authorization: "Bearer tok" };

  const ok = await fetch(`${base}/gateway/file?path=${encodeURIComponent(page)}`, { headers: auth });
  assert.equal(ok.status, 200, "this is the link that used to 404");
  assert.match(await ok.text(), /grid/);

  // Serving a world-writable root means a symlink out of it must not be.
  const secret = path.join(dir, "..", `secret-${process.pid}.key`);
  await fsp.writeFile(secret, "PRIVATE KEY");
  t.after(() => fsp.rm(secret, { force: true }));
  const bait = path.join(dir, "report.html");
  await fsp.symlink(secret, bait);
  const blocked = await fetch(`${base}/gateway/file?path=${encodeURIComponent(bait)}`, { headers: auth });
  assert.equal(blocked.status, 404, "an .html that IS a symlink to a key is refused");

  const outside = await fetch(`${base}/gateway/file?path=${encodeURIComponent("/etc/hosts")}`, { headers: auth });
  assert.equal(outside.status, 404, "and nothing outside a root is served at all");
});
