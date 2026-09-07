// The Telegram remote-PC intent detector short-circuits the message — a match
// never reaches the agent. So it must only fire on phrasings that cannot mean
// anything but "someone else's machine". Everything vaguer belongs to the LLM
// via RemotePC.generate_link.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectRemotePcIntent } from "../packages/channels/dist/telegram/remotePC.js";

describe("detectRemotePcIntent — unmistakable phrasings fire", () => {
  const hits = [
    ["/pc", "coworker's PC"],
    ["/pc john", "john's PC"],
    ["/remote-pc Sarah's PC", "Sarah's PC"],
    ["I'm at Sarah's PC", "Sarah's PC"],
    ["im on Dave's laptop rn", "Dave's PC"],
    ["connect to Dave's laptop", "Dave's PC"],
    ["can you remote into Mary Ann's computer", "Mary Ann's PC"],
    ["I'm at a coworker's PC", "coworker's PC"],
    ["sitting at my friend's computer", "coworker's PC"],
    ["Sarah's laptop isn't working", "Sarah's PC"],
    ["John's PC keeps crashing", "John's PC"],
    ["Sarah’s laptop won't boot", "Sarah's PC"],
  ];
  for (const [text, label] of hits) {
    it(`"${text}" → ${label}`, () => {
      assert.equal(detectRemotePcIntent(text)?.label, label);
    });
  }
});

describe("detectRemotePcIntent — ordinary owner chat falls through to the agent", () => {
  const misses = [
    "my deploy isn't working",
    "the server can't reach the db",
    "this doesn't work",
    "the login button is having issues",
    "shadow DOM is broken in the preview",
    "the shadow on that card looks off",
    "I'm helping a client with their API",
    "my boss can't make the meeting",
    "my friend is having trouble",
    "sarah needs help",
    "the machine learning model isn't converging",
    "run this on my computer",
    "how do I connect to the database",
    "what's on my desktop",
  ];
  for (const text of misses) {
    it(`"${text}" → null`, () => {
      assert.equal(detectRemotePcIntent(text), null);
    });
  }
});

// ─── OS → shell hint (so Ares runs dir on Windows, ls on Mac) ──────────────

import { shellHintForOs } from "../packages/channels/dist/telegram/remotePC.js";

describe("shellHintForOs maps reported OS to the right command style", () => {
  const cases = [
    ["Windows 11 Pro", /Windows.*cmd/i],
    ["Windows 10", /cmd\.exe/i],
    ["Darwin 23.5.0", /Mac.*sh/i],
    ["macOS 14", /Mac/i],
    ["Linux 6.1.0", /Linux.*sh/i],
    ["", /Windows cmd\.exe vs Unix sh/i],
  ];
  for (const [os, re] of cases) {
    it(`"${os}"`, () => assert.match(shellHintForOs(os), re));
  }
});
