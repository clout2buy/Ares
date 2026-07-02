// ComputerUse vision verification loop — after state-changing actions the tool
// takes ONE post-action capture of the region the model last saw, attaches it,
// and hash-compares against the pre-action capture ("clicked blind" → "clicked
// and looked"). Runs against an injected fake runner: no real screen needed.

import test from "node:test";
import assert from "node:assert/strict";

import { makeComputerUseTool } from "../packages/tools/dist/index.js";

process.env.ARES_COMPUTERUSE_SETTLE_MS = "0";

const PNG_A = Buffer.from("fake-image-A").toString("base64");
const PNG_B = Buffer.from("fake-image-B").toString("base64");

function shot(image) {
  return {
    ok: true,
    action: "screenshot",
    image,
    width: 100,
    height: 80,
    captureW: 200,
    captureH: 160,
    scale: 2,
    originX: 10,
    originY: 20,
  };
}

function fakeRunner(script) {
  const calls = [];
  const runner = async (input, lastShot) => {
    calls.push({ input, lastShot });
    const step = script.shift();
    if (!step) throw new Error(`fake runner exhausted at ${input.action}`);
    return step;
  };
  runner.calls = calls;
  return runner;
}

function ctx() {
  return {
    workspace: process.cwd(),
    signal: new AbortController().signal,
    permissionMode: "bypass",
    fileReadStamps: new Map(),
  };
}

test("click with unchanged screen reports 'may have missed' and attaches the capture", async () => {
  const runner = fakeRunner([
    shot(PNG_A),
    { ok: true, action: "click", x: 30, y: 40 },
    { ...shot(PNG_A), action: "zoom" },
  ]);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  const r = await tool.call({ action: "click", x: 15, y: 25 }, ctx());

  // Verify capture re-shoots the exact region the model last saw.
  const verifyCall = runner.calls[2];
  assert.equal(verifyCall.input.action, "zoom");
  assert.equal(verifyCall.input.x, 10);
  assert.equal(verifyCall.input.y, 20);
  assert.equal(verifyCall.input.w, 200);
  assert.equal(verifyCall.input.h, 160);

  assert.equal(r.output.verified, true);
  assert.equal(r.output.changed, false);
  assert.match(r.output.note, /screen unchanged after click — the click may have missed/);
  assert.match(r.display, /the click may have missed/);
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0].data, PNG_A);
});

test("click that changes the screen reports changed and attaches the new capture", async () => {
  const runner = fakeRunner([
    shot(PNG_A),
    { ok: true, action: "click", x: 30, y: 40 },
    { ...shot(PNG_B), action: "zoom" },
  ]);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  const r = await tool.call({ action: "click", x: 15, y: 25 }, ctx());

  assert.equal(r.output.verified, true);
  assert.equal(r.output.changed, true);
  assert.match(r.output.note, /screen changed after the action/);
  assert.match(r.display, /verified \(screen changed\)/);
  assert.equal(r.images[0].data, PNG_B);
});

test("type with unchanged screen says the input may not have registered", async () => {
  const runner = fakeRunner([
    shot(PNG_A),
    { ok: true, action: "type" },
    { ...shot(PNG_A), action: "zoom" },
  ]);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  const r = await tool.call({ action: "type", text: "hello" }, ctx());

  assert.equal(r.output.changed, false);
  assert.match(r.output.note, /screen unchanged after type — the input may not have registered/);
});

test("ARES_COMPUTERUSE_VERIFY=0 disables the loop entirely", async () => {
  process.env.ARES_COMPUTERUSE_VERIFY = "0";
  try {
    const runner = fakeRunner([
      shot(PNG_A),
      { ok: true, action: "click", x: 30, y: 40 },
    ]);
    const tool = makeComputerUseTool(runner);
    await tool.call({ action: "screenshot" }, ctx());
    const r = await tool.call({ action: "click", x: 15, y: 25 }, ctx());

    assert.equal(runner.calls.length, 2, "no verification capture may be taken");
    assert.equal(r.output.verified, undefined);
    assert.equal(r.output.changed, undefined);
    assert.equal(r.images, undefined);
  } finally {
    delete process.env.ARES_COMPUTERUSE_VERIFY;
  }
});

test("no prior screenshot: verify falls back to a full capture with no change claim", async () => {
  const runner = fakeRunner([
    { ok: true, action: "key" },
    shot(PNG_A),
  ]);
  const tool = makeComputerUseTool(runner);
  const r = await tool.call({ action: "key", key: "{ENTER}" }, ctx());

  assert.equal(runner.calls[1].input.action, "screenshot");
  assert.equal(r.output.verified, true);
  assert.equal(r.output.changed, undefined);
  assert.match(r.output.note, /no prior capture to compare/);
  assert.equal(r.images[0].data, PNG_A);
});

test("non-state-changing actions do not trigger verification", async () => {
  const runner = fakeRunner([
    shot(PNG_A),
    { ok: true, action: "move", x: 5, y: 6 },
  ]);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  const r = await tool.call({ action: "move", x: 5, y: 6 }, ctx());

  assert.equal(runner.calls.length, 2);
  assert.equal(r.output.verified, undefined);
  assert.equal(r.images, undefined);
});

test("verification capture failure degrades with a note, not an error", async () => {
  const runner = fakeRunner([
    shot(PNG_A),
    { ok: true, action: "click", x: 30, y: 40 },
    { ok: false, error: "capture boom" },
  ]);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  const r = await tool.call({ action: "click", x: 15, y: 25 }, ctx());

  assert.equal(r.output.ok, true);
  assert.equal(r.output.verified, undefined);
  assert.match(r.output.note, /verification capture failed \(capture boom\)/);
  assert.equal(r.images, undefined);
});

test("scroll is verified; the post capture becomes the next click baseline", async () => {
  const runner = fakeRunner([
    shot(PNG_A),
    { ok: true, action: "scroll" },
    { ...shot(PNG_B), action: "zoom", originX: 10, originY: 20 },
    { ok: true, action: "click", x: 1, y: 2 },
    { ...shot(PNG_B), action: "zoom" },
  ]);
  const tool = makeComputerUseTool(runner);
  await tool.call({ action: "screenshot" }, ctx());
  const scrolled = await tool.call({ action: "scroll", amount: -3 }, ctx());
  assert.equal(scrolled.output.changed, true);

  // The click after the scroll maps against the verify capture's meta.
  const r = await tool.call({ action: "click", x: 15, y: 25 }, ctx());
  const clickCall = runner.calls[3];
  assert.equal(clickCall.lastShot.originX, 10);
  assert.equal(clickCall.lastShot.captureW, 200);
  // Same image as the baseline → unchanged.
  assert.equal(r.output.changed, false);
});
