// The terminal probe — pure function of env + platform. Pins the platform
// matrix the owner actually hit: macOS Terminal.app, Linux 256-color, Windows
// Terminal, legacy conhost, TERM=linux, CI/no-TTY, and explicit overrides.
import test from "node:test";
import assert from "node:assert/strict";
import { probeTerminal, glyphsFor, UNICODE_GLYPHS, ASCII_GLYPHS } from "../../dist/ui/term.js";
import { textWidth, CHROME_SEPARATOR } from "../../dist/tuiChrome.js";

const probe = (env, platform = "linux", isTTY = true) => probeTerminal({ env, platform, isTTY });

test("probe: macOS Terminal.app is 256-color unicode; iTerm is truecolor", () => {
  assert.deepEqual(probe({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color", LANG: "en_US.UTF-8" }, "darwin"), { colorLevel: 2, unicode: true, legacyConsole: false });
  assert.equal(probe({ TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color", COLORTERM: "truecolor" }, "darwin").colorLevel, 3);
});

test("probe: Linux — COLORTERM wins, else 256, TERM=linux is 16-color ascii, no-UTF8 locale is ascii", () => {
  assert.equal(probe({ TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8" }).colorLevel, 3);
  assert.equal(probe({ TERM: "xterm-256color", LANG: "C.UTF-8" }).colorLevel, 2);
  assert.deepEqual(probe({ TERM: "linux" }), { colorLevel: 1, unicode: false, legacyConsole: false });
  assert.equal(probe({ TERM: "xterm-256color", LANG: "C" }).unicode, false);
  assert.equal(probe({ TERM: "xterm-256color" }).unicode, true, "no locale set → assume utf-8");
});

test("probe: Windows — Windows Terminal is truecolor unicode; bare conhost is legacy ascii", () => {
  assert.deepEqual(probe({ WT_SESSION: "abc" }, "win32"), { colorLevel: 3, unicode: true, legacyConsole: false });
  assert.deepEqual(probe({}, "win32"), { colorLevel: 3, unicode: false, legacyConsole: true });
  assert.equal(probe({ TERM_PROGRAM: "vscode" }, "win32").legacyConsole, false);
});

test("probe: overrides + no-TTY", () => {
  assert.equal(probe({ WT_SESSION: "1", NO_COLOR: "1" }, "win32").colorLevel, 0);
  assert.equal(probe({ ARES_TUI_COLOR: "16", COLORTERM: "truecolor" }).colorLevel, 1);
  assert.equal(probe({ ARES_TUI_ASCII: "1", WT_SESSION: "1" }, "win32").unicode, false);
  assert.equal(probe({ ARES_TUI_ASCII: "0" }, "win32").unicode, true);
  assert.equal(probe({ COLORTERM: "truecolor" }, "linux", false).colorLevel, 0);
});

test("glyph sets: every glyph is single-cell (no emoji), separators match the chrome width", () => {
  for (const g of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
    for (const [k, v] of Object.entries(g)) {
      if (k === "border" || k === "sep" || k === "ellipsis") continue;
      const vals = Array.isArray(v) ? v : [v];
      for (const s of vals) assert.equal(textWidth(s), 1, `${k}=${JSON.stringify(s)} must be one cell`);
    }
    assert.equal(textWidth(g.sep), textWidth(CHROME_SEPARATOR));
  }
  assert.equal(glyphsFor({ colorLevel: 3, unicode: false, legacyConsole: true }), ASCII_GLYPHS);
  assert.equal(glyphsFor({ colorLevel: 3, unicode: true, legacyConsole: false }), UNICODE_GLYPHS);
});
