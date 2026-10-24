import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTitle } from "../packages/cli/dist/entry/daemon/autoTitle.js";

test("chat names come back clean, and non-names are refused", () => {
  assert.equal(cleanTitle("Paradise Run Parkour Game"), "Paradise Run Parkour Game");
  assert.equal(cleanTitle('"WeMod Trainer Hashes."'), "WeMod Trainer Hashes");
  assert.equal(cleanTitle("Title: Party Video to MP3\nbecause the owner asked"), "Party Video to MP3");
  assert.equal(cleanTitle("**Godot Export Setup**"), "Godot Export Setup");
  assert.equal(cleanTitle("SKIP"), null);
  assert.equal(cleanTitle("  skip. "), null);
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle("This chat is about a lot of different things that the owner asked for today"), null);
});
