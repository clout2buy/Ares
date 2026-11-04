// Curated memory is typed facts, not raw quotes — and dreams that change
// nothing leave no trace.
//
// Field evidence (owner's ~/.ares, 2026-11-02):
//   - MEMORY.md: 45 entries, every one a raw chat line ("[USER#41] User asked:
//     just login lol ..."), the same line up to six times under six ids;
//   - DREAMS.md: 470 of 542 ticks were "LIGHT found no durable memory
//     candidates."; "DEEP promoted 33 memory candidate(s)" ten nights running;
//     "[acquire] godot: marked acquiring" 34 times;
//   - IDENTITY.md: the box at 192.168.1.41 in one paragraph and .237 in the
//     correction below it, never reconciled.
//
// Pinned here: typed facts with a why, deterministic signature dedupe, the
// `ares mind tidy` migration, staged notes distilled by the model only when
// staged, quiet dreams, and the weekly self-file proposal.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MemoryRouter,
  MemoryStore,
  factSignature,
  isRawQuote,
  mergeCuratedFacts,
  mergeDurableFacts,
  parseCuratedMemory,
  tidyCuratedMemory,
} from "../packages/mind/dist/index.js";
import {
  createMemoryStore,
  defaultAgentConfig,
  dreamStagingFile,
  findContradictions,
  onLifecycle,
  runDeepDream,
  runLightDream,
  runRemDream,
  runSelfFileRefresh,
  tidyMemoryFile,
} from "../packages/agent/dist/index.js";

async function makeTmp(prefix = "ares-curated-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const readOr = (file) => fs.readFile(file, "utf8").catch(() => "");

/** A MEMORY.md shaped like the field file. */
const FIELD_MEMORY = [
  "# Memory",
  "",
  "_(Curated long-term memory. Only DEEP dreaming writes here.)_",
  "",
  "- [USER#12] User asked: this is your home. forever . remember that",
  "- [USER#15] User asked: this is your home. forever . remember that",
  "- [USER#18] User asked: this is your home. forever . remember that",
  "- [USER#32] User asked: i dont have one lmao, can u just make it playable",
  "- [USER#33] User asked: i dont have one lmao, can u just make it playable",
  "- [PROJECT#50] The parkour map uses three.js.",
  "- [PROJECT#51] the parkour map uses three.js",
  "- [USER#52] Noah works 12-hour welding shifts.",
  "",
].join("\n");

// ── signatures + merge ──────────────────────────────────────────────────────

test("factSignature is deterministic over case, punctuation and word order — and keeps distinct facts apart", () => {
  assert.equal(factSignature("The parkour map uses three.js."), factSignature("three.js: the PARKOUR map uses"));
  assert.equal(factSignature("Noah works 12-hour shifts"), factSignature("noah works 12 hour shifts!"));
  assert.notEqual(factSignature("doingbox is at 192.168.1.41"), factSignature("doingbox is at 192.168.1.237"), "a different address is a different fact");
  assert.ok(isRawQuote("User asked: just login lol"));
  assert.ok(!isRawQuote("Noah prefers short replies."));
});

test("mergeCuratedFacts: one record per signature, newest phrasing and why win, quotes refused", () => {
  const out = mergeCuratedFacts([
    { type: "user", content: "Noah prefers dark mode" },
    { type: "user", content: "User asked: make it dark" },
    { type: "user", content: "noah prefers DARK mode.", why: "said it twice" },
    { type: "project", content: "Builds target 60 fps", pinned: true },
    { type: "project", content: "builds target 60 FPS" },
  ]);
  assert.equal(out.facts.length, 2);
  assert.equal(out.merged, 2);
  assert.deepEqual(out.quotes, ["User asked: make it dark"]);
  assert.equal(out.facts[0].content, "noah prefers DARK mode.");
  assert.equal(out.facts[0].why, "said it twice");
  assert.equal(out.facts[1].pinned, true, "pinned is sticky through a merge");
});

// ── the migration ───────────────────────────────────────────────────────────

test("tidyCuratedMemory dedupes identical lines and moves raw quotes out", () => {
  const report = tidyCuratedMemory(FIELD_MEMORY);
  assert.equal(report.changed, true);
  assert.equal(report.kept, 2, "three.js (twice) + welding shifts");
  assert.deepEqual(report.quotes, ["User asked: this is your home. forever . remember that", "User asked: i dont have one lmao, can u just make it playable"]);
  assert.doesNotMatch(report.text, /User asked/);
  assert.match(report.text, /^- \[project\] the parkour map uses three\.js$/m, "the newer phrasing of a duplicate wins");
  assert.match(report.text, /^- \[user\] Noah works 12-hour welding shifts\.$/m);
  assert.equal(tidyCuratedMemory(report.text).changed, false, "tidy is idempotent");
  assert.deepEqual(parseCuratedMemory(report.text).map((f) => f.type), ["project", "user"]);
});

test("ares mind tidy: --dry-run writes nothing; a real run keeps a backup and moves quotes to the daily log", async () => {
  const home = await makeTmp();
  const memoryFile = path.join(home, "MEMORY.md");
  await fs.writeFile(memoryFile, FIELD_MEMORY, "utf8");
  const now = new Date("2026-11-02T12:00:00Z");

  const dry = await tidyMemoryFile({ home, dryRun: true, now });
  assert.equal(dry.changed, true);
  assert.equal(dry.movedQuotes, 2);
  assert.equal(await readOr(memoryFile), FIELD_MEMORY, "a dry run leaves MEMORY.md alone");
  assert.equal(await readOr(path.join(home, "memory", "2026-11-02.md")), "", "a dry run writes no daily log");

  const real = await tidyMemoryFile({ home, now });
  assert.equal(real.kept, 2);
  assert.doesNotMatch(await readOr(memoryFile), /User asked/);
  assert.equal(await readOr(real.backup), FIELD_MEMORY, "the original is kept beside the daily logs");
  const daily = await readOr(path.join(home, "memory", "2026-11-02.md"));
  assert.match(daily, /this is your home\. forever/);
  assert.equal(daily.match(/this is your home/g).length, 1, "each quote moves once, not six times");

  const again = await tidyMemoryFile({ home, now });
  assert.equal(again.changed, false, "a second tidy is a no-op");
});

// ── the write spine ─────────────────────────────────────────────────────────

test("mergeDurableFacts: typed with a why, quotes refused, a repeat reinforces ONE record", async () => {
  const store = MemoryStore.memory();
  const first = await mergeDurableFacts(store, [
    { content: "Noah's always-on box is doingbox at 192.168.1.237", kind: "reference", importance: 0.9, why: "everything that must survive the laptop sleeping runs there" },
    { content: "User asked: just login lol", kind: "user", importance: 0.9 },
  ]);
  assert.equal(first.added, 1);
  const node = store.all()[0];
  assert.ok(node.tags.includes("type:reference"));
  assert.ok(node.tags.some((t) => t.startsWith("why:everything that must survive")));
  const before = node.activations;
  const again = await mergeDurableFacts(store, [{ content: "Noah's always-on box is doingbox at 192.168.1.237.", kind: "reference", importance: 0.9 }]);
  assert.equal(again.added, 0);
  assert.equal(store.all().length, 1, "no copy");
  assert.ok(store.all()[0].activations > before, "the repeat reinforced the existing record");
});

// ── dreaming ────────────────────────────────────────────────────────────────

async function lightDreamWith(home, workspace, texts, sessionId = "sess_a") {
  const transcript = path.join(workspace, `${sessionId}.jsonl`);
  await fs.writeFile(
    transcript,
    texts.map((text) => JSON.stringify({ event: { type: "turn_start", userMessage: { content: [{ type: "text", text }] } } })).join("\n") + "\n",
    "utf8",
  );
  return runLightDream({ home, workspace, sessionId, transcriptPath: transcript, config: defaultAgentConfig(home) });
}

test("deep dream: MEMORY.md is typed facts — raw quotes in the legacy store never reach it, duplicates collapse", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-curated-ws-");
  const config = defaultAgentConfig(home);
  config.memory.dimensions = 32;
  const v4 = await createMemoryStore(config, home);
  for (let i = 0; i < 6; i++) {
    await v4.add({ category: "USER", workspace, content: "User asked: this is your home. forever . remember that", source: "light-dreaming", score: 0.9, embeddingDim: 32 });
  }
  await v4.add({ category: "PROJECT", workspace, content: "Use pnpm verify.", source: "light-dreaming", score: 0.9, embeddingDim: 32 });
  await v4.add({ category: "PROJECT", workspace, content: "use pnpm verify", source: "light-dreaming", score: 0.9, embeddingDim: 32 });
  const living = await MemoryStore.open(path.join(home, "mind", "memory.jsonl"));
  await mergeDurableFacts(living, [{ content: "Noah wants one change per small ask, nothing extra.", kind: "feedback", why: "extra passes cost him time", importance: 0.9 }]);

  await runDeepDream({ home, workspace, config });
  const memory = await readOr(path.join(home, "MEMORY.md"));
  assert.doesNotMatch(memory, /User asked/);
  assert.equal((memory.match(/pnpm verify/gi) ?? []).length, 1, "the duplicate collapsed");
  assert.match(memory, /^- \[feedback\] Noah wants one change per small ask, nothing extra\. — why: extra passes cost him time$/m);
});

test("dreams that change nothing leave no diary line and fire no dream phase; repeats collapse", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-curated-ws-");
  const config = defaultAgentConfig(home);
  const living = await MemoryStore.open(path.join(home, "mind", "memory.jsonl"));
  await mergeDurableFacts(living, [{ content: "Noah's girlfriend is named Jamara.", kind: "user", importance: 0.9 }]);
  process.env.ARES_SELF_REFRESH_DAYS = "0";
  try {
    const first = await runDeepDream({ home, workspace, config });
    assert.match(first.report, /curated 1 fact/);
    const diary = await readOr(path.join(home, "DREAMS.md"));
    const seen = [];
    const off = onLifecycle((e) => seen.push(e.type));
    try {
      const second = await runDeepDream({ home, workspace, config });
      assert.equal(second.report, "DEEP found nothing new.");
      assert.equal(second.promoted, 0);
      const third = await runRemDream({ home, config });
      assert.equal(third.promoted, 0);
    } finally {
      off();
    }
    assert.equal(await readOr(path.join(home, "DREAMS.md")), diary, "no new diary line for a dream that changed nothing / an empty REM");
    assert.deepEqual(seen.filter((t) => t.startsWith("dream_phase")), [], "no dream phase events either");

    // REM with a daily file reports once; the identical report the next night does not repeat.
    await fs.mkdir(path.join(home, "memory"), { recursive: true });
    await fs.writeFile(path.join(home, "memory", "2026-11-01.md"), "- x\n", "utf8");
    await runRemDream({ home, config });
    await runRemDream({ home, config });
    assert.equal(((await readOr(path.join(home, "DREAMS.md"))).match(/REM scanned 1/g) ?? []).length, 1);
  } finally {
    delete process.env.ARES_SELF_REFRESH_DAYS;
  }
});

test("light dream stages notes; deep dream calls the model ONLY when something is staged, and promotes what it distills", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-curated-ws-");
  const config = defaultAgentConfig(home);
  process.env.ARES_SELF_REFRESH_DAYS = "0";
  try {
    const light = await lightDreamWith(home, workspace, ["From now on always run the tests before saying something is done."]);
    assert.equal(light.promoted, 1);
    assert.match(await readOr(dreamStagingFile(home)), /always run the tests/);

    // No model: the notes stay staged and nothing raw reaches MEMORY.md.
    await runDeepDream({ home, workspace, config });
    assert.match(await readOr(dreamStagingFile(home)), /always run the tests/, "kept for a dream with a model");
    assert.doesNotMatch(await readOr(path.join(home, "MEMORY.md")), /User asked/);

    const calls = [];
    const model = {
      distill: async (notes) => {
        calls.push(notes);
        return [{ content: "Noah wants tests run before anything is called done.", kind: "feedback", why: "unverified 'done' cost him a release", importance: 0.9 }];
      },
    };
    const deep = await runDeepDream({ home, workspace, config, model });
    assert.equal(calls.length, 1, "one call for the staged batch");
    assert.equal(calls[0].length, 1);
    assert.match(calls[0][0], /always run the tests/);
    assert.match(deep.report, /distilled 1 staged note\(s\) into 1 fact\(s\)/);
    assert.equal((await readOr(dreamStagingFile(home))).trim(), "", "staging cleared once distilled");
    assert.match(await readOr(path.join(home, "MEMORY.md")), /^- \[feedback\] Noah wants tests run before anything is called done\. — why: unverified 'done' cost him a release$/m);

    await runDeepDream({ home, workspace, config, model });
    assert.equal(calls.length, 1, "nothing staged → no model call");
  } finally {
    delete process.env.ARES_SELF_REFRESH_DAYS;
  }
});

// ── weekly self-file refresh ────────────────────────────────────────────────

const IDENTITY = [
  "# Identity",
  "",
  "- Name: Rook",
  "",
  "## Home",
  "",
  "My permanent home is `doingbox` — a mini PC running Ubuntu Server 24.04 at `192.168.1.41`.",
  "",
  "- **Address correction (2026-09-18):** the Home section above says doingbox is at `192.168.1.41` — that is STALE. The box is at **192.168.1.237** (user `mrdoing`).",
  "",
].join("\n");

test("findContradictions: one host with two addresses, one identity field with two values", () => {
  const found = findContradictions(`${IDENTITY}\n- Name: Ares\n`);
  assert.ok(found.includes("doingbox: 192.168.1.41 vs 192.168.1.237"), JSON.stringify(found));
  assert.ok(found.includes("name: Rook vs Ares"), JSON.stringify(found));
  assert.deepEqual(findContradictions("Anything that must survive runs on doingbox (192.168.1.237, user mrdoing)."), []);
});

test("self-file refresh proposes a rewrite beside IDENTITY.md, never touches it, and runs weekly", async () => {
  const home = await makeTmp();
  const identity = path.join(home, "IDENTITY.md");
  await fs.writeFile(identity, IDENTITY, "utf8");
  await fs.writeFile(path.join(home, "USER.md"), "# User\n\n- Name: Noah\n", "utf8");
  const now = new Date("2026-11-02T12:00:00Z");
  const records = [
    { type: "reference", content: "The Minecraft server runs on doingbox under /mnt/MistiqueSSD/minecraft." },
    { type: "user", content: "Noah's girlfriend is named Jamara." },
  ];

  const first = await runSelfFileRefresh({ home, now, records });
  assert.equal(first.ran, true);
  assert.equal(await readOr(identity), IDENTITY, "IDENTITY.md itself is never overwritten");
  const idProposal = first.proposals.find((p) => p.name === "IDENTITY.md");
  assert.ok(idProposal, "an IDENTITY proposal");
  assert.equal(idProposal.file, path.join(home, "IDENTITY.proposed.md"));
  const text = await readOr(idProposal.file);
  assert.match(text, /doingbox: 192\.168\.1\.41 vs 192\.168\.1\.237/);
  assert.match(text, /Minecraft server runs on doingbox/, "recent records it does not reflect yet");
  assert.match(await readOr(path.join(home, "USER.proposed.md")), /girlfriend is named Jamara/, "user facts go to USER.md's proposal");

  const soon = await runSelfFileRefresh({ home, now: new Date("2026-11-05T12:00:00Z"), records });
  assert.equal(soon.ran, false, "not again within the week");

  const rewrites = [];
  const later = await runSelfFileRefresh({
    home,
    now: new Date(Date.now() + 8 * 86_400_000), // the marker is the file's real mtime, so "a week later" must follow the real clock
    records,
    rewrite: async (input) => {
      rewrites.push(input);
      return input.name === "IDENTITY.md" ? "# Identity\n\nMy home is doingbox at 192.168.1.237.\n" : "";
    },
  });
  assert.equal(later.ran, true, "due again after a week");
  assert.ok(rewrites.find((r) => r.name === "IDENTITY.md").contradictions.length > 0, "the model is told what contradicts");
  assert.match(await readOr(path.join(home, "IDENTITY.proposed.md")), /My home is doingbox at 192\.168\.1\.237\./, "the model's rewrite is the proposal");
  assert.equal(await readOr(identity), IDENTITY, "still untouched");
});

test("the deep dream runs the self-file refresh on its own cadence and reports it", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-curated-ws-");
  await fs.writeFile(path.join(home, "IDENTITY.md"), IDENTITY, "utf8");
  const result = await runDeepDream({ home, workspace, config: defaultAgentConfig(home) });
  assert.ok(result.selfRefresh?.ran, "first deep dream: the refresh is due");
  assert.match(result.report, /proposed IDENTITY\.md rewrite \(1 contradiction\(s\) flagged\)/);
  assert.match(await readOr(path.join(home, "DREAMS.md")), /proposed IDENTITY\.md rewrite/);
  const next = await runDeepDream({ home, workspace, config: defaultAgentConfig(home) });
  assert.equal(next.selfRefresh?.ran, false, "the next dream the same week does not redo it");
});

// ── #26, write side ─────────────────────────────────────────────────────────

test("#26 (write side): the router's similar/exact dedupe never crosses tenant scopes", async () => {
  const store = MemoryStore.memory();
  const router = new MemoryRouter(store);
  await router.write("conversation", [{ kind: "semantic", content: "Likes green tea every morning", scope: "guest:42", salience: 0.9 }]);
  const owner = await router.write("conversation", [{ kind: "semantic", content: "Likes green tea every morning", salience: 0.9 }]);
  assert.equal(owner.written.length, 1, "the owner's fact is not swallowed by a guest's identical one");
  await router.write("witness", [{ kind: "semantic", content: "Bash fails on long paths", scope: "guest:42" }]);
  const ownerWitness = await router.write("witness", [{ kind: "semantic", content: "Bash fails on long paths" }]);
  assert.equal(ownerWitness.written.length, 1);
  const again = await router.write("conversation", [{ kind: "semantic", content: "likes green tea every morning!", salience: 0.9 }]);
  assert.equal(again.written.length, 0, "same scope still dedupes");
  assert.equal(store.all().length, 4);
});
