// Remote-turn memory capture — the Garrison seam Telegram rides through.
// A guest's words land in guest:<chatId>; the owner's stay unscoped; greetings
// are dropped by the turn channel's salience floor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureRemoteTurn } from "../packages/cli/dist/entry/turnPipeline.js";

async function tempContext() {
  const home = await mkdtemp(path.join(tmpdir(), "ares-remote-capture-"));
  const mindDir = path.join(home, "mind");
  await mkdir(mindDir, { recursive: true });
  return { home, mind: { memoryFile: path.join(mindDir, "memory.jsonl") } };
}

async function nodes(context) {
  const raw = await readFile(context.mind.memoryFile, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("guest capture is scoped; owner capture stays unscoped; greetings dropped", async () => {
  const context = await tempContext();
  await captureRemoteTurn(context, "I always want you to answer me in Spanish", { role: "guest", chatId: "99" }, "sess_g");
  await captureRemoteTurn(context, "I prefer the dark theme for the dashboard work", { role: "owner" }, "sess_o");
  await captureRemoteTurn(context, "hey", { role: "guest", chatId: "99" }, "sess_g");
  const all = await nodes(context);
  const guest = all.filter((n) => n.scope === "guest:99");
  const owner = all.filter((n) => n.scope === undefined && String(n.content ?? "").includes("dark theme"));
  assert.equal(guest.length, 1, JSON.stringify(all));
  assert.equal(owner.length, 1);
  assert.ok(!all.some((n) => String(n.content ?? "") === "hey"), "greeting must not be captured");
});

test("a memory failure never throws out of the seam", async () => {
  // A file path that cannot be a file (its parent is a file) forces the store open to fail.
  const context = await tempContext();
  const broken = { ...context, mind: { memoryFile: path.join(context.mind.memoryFile, "impossible", "memory.jsonl") } };
  await assert.doesNotReject(() => captureRemoteTurn(broken, "real content that would be captured", { role: "owner" }, "s"));
});
