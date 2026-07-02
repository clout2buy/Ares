// Edit — diff-anchor / fuzzy match (Layer 3).
//
// Proves the third matching tier: when exact and whitespace-tolerant matching
// both miss, Edit anchors on the first & last non-blank lines of old_string and
// verifies the interior modulo indentation / blank-line drift. A unique anchored
// region is replaced; multiple candidates FAIL loudly (never guess); a genuinely
// absent block still fails with the helpful error.
//
// Style mirrors tests/m1-tools.test.mjs: real temp dirs, an inline
// RichToolContext, tools invoked through their dist build.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ReadTool, EditTool } from "../packages/tools/dist/index.js";

async function makeTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ares-anchor-"));
}

function ctx(workspace) {
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

// Read-before-write is enforced, so every edit test reads first.
async function seedAndRead(c, file, content) {
  await fs.writeFile(file, content, "utf8");
  await ReadTool.call({ file_path: file }, c);
}

// A small multi-line block used across several tests.
const BLOCK = [
  "function greet(name) {",
  "  const msg = `hello ${name}`;",
  "  console.log(msg);",
  "  return msg;",
  "}",
].join("\n");

// ─── (a) exact match still works (happy path unchanged) ────────────────────

test("anchor: exact match still lands via the exact tier", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "a.js");
  const c = ctx(tmp);
  await seedAndRead(c, file, `${BLOCK}\n`);

  const r = await EditTool.call(
    { file_path: file, old_string: "  console.log(msg);", new_string: "  console.debug(msg);", replace_all: false },
    c,
  );
  assert.equal(r.output.matchedBy, "exact");
  assert.equal(r.output.replacements, 1);
  const after = await fs.readFile(file, "utf8");
  assert.match(after, /console\.debug\(msg\);/);
});

// ─── (b) whitespace-drifted old_string succeeds via the anchor tier ────────
// The interior line's INDENTATION differs from the file (2 spaces on disk, 4 in
// old_string) AND a blank line is present in old_string that the file lacks —
// past what the trailing-whitespace tier can absorb, so the anchor tier lands it.

test("anchor: indentation + blank-line drift lands via the anchor tier", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "b.js");
  const c = ctx(tmp);
  await seedAndRead(c, file, `const x = 1;\n${BLOCK}\nconst y = 2;\n`);

  // old_string: same lines, wrong indentation on the interior, plus an extra
  // blank line the file does not contain.
  const drifted = [
    "function greet(name) {",
    "      const msg = `hello ${name}`;",
    "",
    "        console.log(msg);",
    "    return msg;",
    "}",
  ].join("\n");
  const replacement = [
    "function greet(name) {",
    "  return `hi ${name}`;",
    "}",
  ].join("\n");

  const r = await EditTool.call(
    { file_path: file, old_string: drifted, new_string: replacement, replace_all: false },
    c,
  );
  assert.equal(r.output.matchedBy, "anchor");
  assert.equal(r.output.replacements, 1);
  const after = await fs.readFile(file, "utf8");
  assert.match(after, /return `hi \$\{name\}`;/);
  assert.doesNotMatch(after, /console\.log/); // whole region replaced
  assert.match(after, /const x = 1;/); // surrounding lines untouched
  assert.match(after, /const y = 2;/);
});

// ─── (c) a line-shifted edit succeeds ──────────────────────────────────────
// The target block is the SAME text, but many lines were inserted above it so
// its absolute position shifted. Anchoring is position-independent, so it lands.

test("anchor: a line-shifted block still matches", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "c.js");
  const c = ctx(tmp);
  const preamble = Array.from({ length: 40 }, (_, i) => `// header line ${i + 1}`).join("\n");
  await seedAndRead(c, file, `${preamble}\n${BLOCK}\n`);

  // old_string with drifted indentation so the exact/whitespace tiers miss and
  // the anchor tier has to do the work despite the shift.
  const drifted = [
    "function greet(name) {",
    "        const msg = `hello ${name}`;",
    "        console.log(msg);",
    "        return msg;",
    "}",
  ].join("\n");

  const r = await EditTool.call(
    { file_path: file, old_string: drifted, new_string: "function greet(name) {\n  return name;\n}", replace_all: false },
    c,
  );
  assert.equal(r.output.matchedBy, "anchor");
  const after = await fs.readFile(file, "utf8");
  assert.match(after, /return name;/);
  assert.match(after, /header line 40/); // preamble intact
});

// ─── (d) an ambiguous anchor FAILS loudly rather than editing the wrong place ─

test("anchor: ambiguous region fails loudly with candidate line numbers", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "d.js");
  const c = ctx(tmp);
  // TWO identical blocks. Drifted old_string can't match exactly/whitespace-wise
  // (indentation differs), and the anchor tier finds BOTH — it must refuse.
  const doubled = `${BLOCK}\nconst sep = 0;\n${BLOCK}\n`;
  await seedAndRead(c, file, doubled);

  const drifted = [
    "function greet(name) {",
    "        const msg = `hello ${name}`;",
    "        console.log(msg);",
    "        return msg;",
    "}",
  ].join("\n");

  await assert.rejects(
    EditTool.call(
      { file_path: file, old_string: drifted, new_string: "function greet(name) { return name; }", replace_all: false },
      c,
    ),
    (err) => {
      assert.match(err.message, /ambiguous/i);
      assert.match(err.message, /2 regions/); // count reported
      assert.match(err.message, /NOT applied/); // reassures nothing was changed
      return true;
    },
  );

  // Prove the file was left completely untouched.
  assert.equal(await fs.readFile(file, "utf8"), doubled);
});

// ─── (e) a genuinely-absent old_string still fails with the helpful error ──

test("anchor: absent block fails with the three-tier helpful error", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "e.js");
  const c = ctx(tmp);
  await seedAndRead(c, file, `${BLOCK}\n`);

  const absent = [
    "function farewell(name) {",
    "  const bye = `goodbye ${name}`;",
    "  return bye;",
    "}",
  ].join("\n");

  await assert.rejects(
    EditTool.call(
      { file_path: file, old_string: absent, new_string: "function farewell() {}", replace_all: false },
      c,
    ),
    (err) => {
      assert.match(err.message, /not found/i);
      assert.match(err.message, /diff-anchor/); // mentions all three tiers were tried
      return true;
    },
  );
  // File untouched.
  assert.equal(await fs.readFile(file, "utf8"), `${BLOCK}\n`);
});

// ─── extra guard: anchor never fires on a single-line target ───────────────
// A single-line old_string that isn't present must NOT be anchored (one line is
// too loose to anchor safely) — it falls through to not-found.

test("anchor: refuses to anchor on a single significant line", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "f.js");
  const c = ctx(tmp);
  await seedAndRead(c, file, "const alpha = 1;\nconst beta = 2;\n");

  await assert.rejects(
    EditTool.call(
      { file_path: file, old_string: "const gamma = 3;", new_string: "const gamma = 30;", replace_all: false },
      c,
    ),
    /not found/i,
  );
});
