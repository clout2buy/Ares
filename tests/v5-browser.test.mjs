// Verifies O6 — browser connector + visual proof (the eyes):
//   1. The mock connector drives a DOM-first form flow (find by role/label, fill,
//      screenshot) — no real browser, no dependency.
//   2. The filmstrip records frames in order as real PNG files on disk.
//   3. Browser actions flow through the O2 rails: a reversible navigate commits
//      (and films a frame); an irreversible click on a leash-1 domain is STAGED,
//      not performed — proving the eyes obey the conscience.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MockBrowser,
  Filmstrip,
  navigateEffect,
  clickEffect,
} from "../packages/connectors/dist/index.js";

import { runEffect, Ledger, Budget, KillSwitch } from "../packages/effects/dist/index.js";
import { exists } from "../packages/agent/dist/index.js";

async function makeDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "crix-o6-"));
}

// ── 1. DOM-first flow ────────────────────────────────────────────────────────

test("browser: mock connector drives a DOM-first form flow", async () => {
  const browser = new MockBrowser({
    "https://signup.test": {
      url: "https://signup.test",
      title: "Sign up",
      tree: [
        { role: "textbox", name: "Email", selector: "label:Email" },
        { role: "button", name: "Create account", selector: "button:Create account" },
      ],
    },
  });

  await browser.navigate("https://signup.test");
  const tree = await browser.accessibilityTree();
  assert.ok(tree.some((n) => n.role === "textbox" && n.name === "Email"), "found the field by structure, not pixels");

  await browser.fillByLabel("Email", "crix@example.com");
  assert.deepEqual(browser.filled[0], { label: "Email", value: "crix@example.com" });

  const shot = await browser.screenshot();
  assert.equal(shot.format, "png");
  assert.ok(shot.bytes.length > 0);
});

// ── 2. filmstrip ─────────────────────────────────────────────────────────────

test("filmstrip: records frames in order and writes real PNG files", async () => {
  const dir = await makeDir();
  const film = new Filmstrip(dir);
  for (const action of ["navigate", "fill", "click"]) {
    await film.record({ action, url: "https://x.test", screenshot: { format: "png", bytes: Buffer.from(action).toString("base64") } });
  }
  const frames = await film.load();
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => f.action), ["navigate", "fill", "click"]);
  assert.ok(await exists(frames[0].file), "frame written to disk");
  await fs.rm(dir, { recursive: true, force: true });
});

// ── 3. the eyes obey the conscience (O6 × O2) ───────────────────────────────

test("browser: actions flow through the rails — navigate commits, irreversible click is staged", async () => {
  const dir = await makeDir();
  const browser = new MockBrowser({
    "https://signup.test": {
      url: "https://signup.test",
      tree: [{ role: "button", name: "Submit", selector: "button:Submit" }],
    },
  });
  const filmstrip = new Filmstrip(dir);
  const rails = { ledger: Ledger.memory(), budget: new Budget(), killSwitch: KillSwitch.memory(), leashOf: () => 1 };

  // Reversible navigate → commits, and leaves a filmstrip frame.
  const nav = await runEffect(navigateEffect(browser, "https://signup.test", { filmstrip }), rails);
  assert.equal(nav.status, "committed");
  assert.equal((await browser.state()).url, "https://signup.test");
  assert.ok((await filmstrip.load()).length >= 1, "navigate produced a visual-proof frame");

  // Irreversible click on a leash-1 domain → STAGED, never actually clicked.
  const click = await runEffect(clickEffect(browser, "button", "Submit", { irreversibility: "irreversible", filmstrip }), rails);
  assert.equal(click.status, "staged");
  assert.equal(browser.clicks.length, 0, "the irreversible click was held for approval, not fired");

  await fs.rm(dir, { recursive: true, force: true });
});
