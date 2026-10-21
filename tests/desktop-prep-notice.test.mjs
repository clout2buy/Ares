// The daemon tells the owner when a slow context gather was skipped
// ("Memory and workspace context took over Ns…"). foldEvent only surfaces an
// allowlist of reminders, so the notice must be on it or the desktop stays
// silent about why a reply came without memory.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));

test("desktop shows the skipped-context notice and still hides plumbing reminders", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-prep-notice-"));
  try {
    const outfile = path.join(tmp, "fold-event.mjs");
    await esbuild({
      entryPoints: [path.join(here, "..", "tauri", "src", "state", "foldEvent.ts")],
      bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
    });
    const { foldEvent } = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
    const base = { id: "s", title: "t", items: [], busy: true, workflowMode: "build", tokensIn: 0, cacheReadTokens: 0, tokensOut: 0, todos: [], steerQueued: 0 };
    const shown = foldEvent(base, {
      type: "system_reminder_injected", source: "verifier",
      text: "Memory and workspace context took over 20s to gather, so this reply goes ahead without them.",
    });
    assert.ok(shown.items.some((i) => i.kind === "notice" && /took over 20s/.test(i.text)));
    const hidden = foldEvent(base, { type: "system_reminder_injected", source: "verifier", text: "Repository map: ..." });
    assert.equal(hidden.items.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a turn silent in preparation shows a counter and a hint before it looks frozen", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-prep-hint-"));
  try {
    const bundle = async (name, file) => {
      const outfile = path.join(tmp, name);
      await esbuild({ entryPoints: [path.join(here, "..", "tauri", "src", "state", file)], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
      return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
    };
    const { workingHintFor } = await bundle("session.mjs", "session.ts");
    const { foldEvent } = await bundle("fold.mjs", "foldEvent.ts");
    assert.equal(workingHintFor("marshalling", 3), null);
    assert.match(workingHintFor("marshalling", 9), /gathering memory/);
    assert.match(workingHintFor("marshalling", 25), /Stop is available/);
    assert.match(workingHintFor("generating", 7), /first token/);
    assert.equal(workingHintFor("writing", 90), null);
    assert.equal(workingHintFor("writing", 90, 60), null, "a minute of quiet is normal");
    assert.match(workingHintFor("running Bash", 200, 95), /nothing heard for 95s/);
    assert.match(workingHintFor("running Bash", 400, 300), /nothing heard for 5m/);
    const base = { id: "s", title: "t", items: [], busy: false, workflowMode: "build", tokensIn: 0, cacheReadTokens: 0, tokensOut: 0, todos: [], steerQueued: 0 };
    const started = foldEvent(base, { type: "turn_start" });
    assert.equal(typeof started.lastEventAt, "number", "every event stamps the session so silence can be measured");
    assert.equal(typeof started.activityAt, "number", "the elapsed clock starts at turn_start, not at the first provider attempt");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
