// V0 — rebrand mechanics. The home migration must be copy-not-move and
// idempotent; a fresh home must need no legacy ~/.crix; legacy env vars must
// still be honored. See docs/roadmap/NEXT-ARES.md (V0).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  aresHome,
  migrateLegacyHome,
  bridgeLegacyEnv,
  __resetHomeMigrationForTests,
} from "../packages/mind/dist/index.js";

function makeLegacyHome(root) {
  const legacy = path.join(root, ".crix");
  mkdirSync(path.join(legacy, "mind"), { recursive: true });
  writeFileSync(path.join(legacy, "IDENTITY.md"), "# I am Crix\n");
  writeFileSync(path.join(legacy, "mind", "memory.jsonl"), '{"id":"m1","content":"old soul"}\n');
  return legacy;
}

test("migration copies the legacy home — never moves it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ares-rebrand-"));
  try {
    const legacy = makeLegacyHome(root);
    const target = path.join(root, ".ares");

    assert.equal(migrateLegacyHome(target, legacy), true);

    // Target has the full copy.
    assert.equal(readFileSync(path.join(target, "IDENTITY.md"), "utf8"), "# I am Crix\n");
    assert.ok(existsSync(path.join(target, "mind", "memory.jsonl")));

    // Legacy is INTACT (copy, not move) and carries the breadcrumb.
    assert.ok(existsSync(path.join(legacy, "IDENTITY.md")));
    assert.ok(existsSync(path.join(legacy, "mind", "memory.jsonl")));
    const breadcrumb = readFileSync(path.join(legacy, "MIGRATED.md"), "utf8");
    assert.match(breadcrumb, /COPIED to/);
    assert.ok(breadcrumb.includes(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration is idempotent — an existing target home is never touched", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ares-rebrand-"));
  try {
    const legacy = makeLegacyHome(root);
    const target = path.join(root, ".ares");

    assert.equal(migrateLegacyHome(target, legacy), true);
    // Mutate the new home after migration — a re-run must not clobber it.
    writeFileSync(path.join(target, "IDENTITY.md"), "# I am Ares now\n");
    assert.equal(migrateLegacyHome(target, legacy), false);
    assert.equal(readFileSync(path.join(target, "IDENTITY.md"), "utf8"), "# I am Ares now\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh home needs no legacy ~/.crix at all", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ares-rebrand-"));
  try {
    const target = path.join(root, ".ares");
    // No legacy dir exists → no-op, no throw, no target created out of thin air.
    assert.equal(migrateLegacyHome(target, path.join(root, ".crix")), false);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit and env-selected homes resolve without auto-migration", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ares-rebrand-"));
  const savedAres = process.env.ARES_HOME;
  const savedCrix = process.env.CRIX_HOME;
  try {
    __resetHomeMigrationForTests();
    const explicit = path.join(root, "custom-home");
    assert.equal(aresHome(explicit), path.resolve(explicit));

    // Legacy env var still honored when ARES_HOME is unset.
    delete process.env.ARES_HOME;
    process.env.CRIX_HOME = path.join(root, "legacy-env-home");
    assert.equal(aresHome(), path.resolve(path.join(root, "legacy-env-home")));

    // New env var wins over legacy.
    process.env.ARES_HOME = path.join(root, "new-env-home");
    assert.equal(aresHome(), path.resolve(path.join(root, "new-env-home")));
  } finally {
    if (savedAres === undefined) delete process.env.ARES_HOME;
    else process.env.ARES_HOME = savedAres;
    if (savedCrix === undefined) delete process.env.CRIX_HOME;
    else process.env.CRIX_HOME = savedCrix;
    __resetHomeMigrationForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridgeLegacyEnv mirrors CRIX_* onto ARES_* without overwriting", () => {
  const env = {
    CRIX_THEME: "ember",
    CRIX_OPENAI_MODEL: "gpt-5",
    ARES_OPENAI_MODEL: "already-set",
    PATH: "/usr/bin",
  };
  const bridged = bridgeLegacyEnv(env);
  assert.equal(bridged, 1);
  assert.equal(env.ARES_THEME, "ember"); // bridged
  assert.equal(env.ARES_OPENAI_MODEL, "already-set"); // never overwritten
  assert.equal(env.CRIX_THEME, "ember"); // legacy untouched
  assert.equal(env.PATH, "/usr/bin"); // unrelated untouched
});
