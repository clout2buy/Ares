// A window reload while the daemon keeps running must re-ask for everything the
// rail shows. daemon_ready only fires when the daemon starts, so anything that
// is requested only there (agents, rooms, the people directory) vanished on a
// refresh even though it was saved on disk (owner, 2026-10-20: "agents don't
// save when I refresh", "claiming a username doesn't save").
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const app = await fs.readFile(path.resolve("tauri/src/App.tsx"), "utf8");

test("reload hydrates agents, rooms and the directory from the running daemon", () => {
  const i = app.indexOf("Reload survival (F5 / webview crash)");
  assert.ok(i > 0, "the reload block exists");
  const block = app.slice(i, app.indexOf("background_list", i));
  for (const type of ["sessions_list", "agents_list", "rooms_list", "directory_status"]) {
    assert.ok(block.includes(`"${type}"`), `reload requests ${type}`);
  }
});
