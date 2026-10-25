// Regression tests for issue #27 — the credential vault losing credentials.
//
// The module caches the machine key for the life of the process, so each test
// that needs a DIFFERENT ~/.ares (a damaged key, a fresh first run) imports a
// fresh copy of the module via a cache-busting query string after pointing
// ARES_HOME at its own temp dir.

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

type Vault = typeof import("./credentials.js");

let fresh = 0;
async function vaultIn(home: string): Promise<Vault> {
  process.env.ARES_HOME = home;
  return (await import(`./credentials.js?fresh=${++fresh}`)) as Vault;
}

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "ares-cred27-"));
}

test("corrupt vault: setCredential refuses, the bad bytes are copied aside, the original is untouched", async () => {
  const home = await tempHome();
  const vault = await vaultIn(home);
  const file = path.join(home, "credentials.json");

  await vault.setCredential("A", "alpha", { home });
  await vault.setCredential("B", "beta", { home });
  // Simulate the field failure: the file truncated mid-write to 40 bytes.
  const good = await readFile(file, "utf8");
  const truncated = good.slice(0, 40);
  await writeFile(file, truncated);

  await assert.rejects(vault.setCredential("C", "gamma", { home }), (err: unknown) => {
    assert.ok(err instanceof vault.CredentialVaultCorruptError, `expected CredentialVaultCorruptError, got ${String(err)}`);
    assert.ok(err.copy, "a .corrupt copy was made");
    return true;
  });

  // The original is still exactly the truncated bytes — nothing overwrote it.
  assert.equal(await readFile(file, "utf8"), truncated);
  const copies = (await readdir(home)).filter((n) => n.startsWith("credentials.json.corrupt-"));
  assert.equal(copies.length, 1, "exactly one quarantine copy");
  assert.equal(await readFile(path.join(home, copies[0]!), "utf8"), truncated, "the copy holds the original bytes");

  // Reads do not throw (the vault is treated as empty) and do not make a
  // second copy — tools poll the vault constantly.
  assert.equal(await vault.getCredential("A", { home }), undefined);
  assert.deepEqual(await vault.listCredentialNames({ home }), []);
  await assert.rejects(vault.deleteCredential("A", { home }), vault.CredentialVaultCorruptError);
  assert.equal((await readdir(home)).filter((n) => n.startsWith("credentials.json.corrupt-")).length, 1);

  await rm(home, { recursive: true, force: true });
});

test("concurrent setCredential: eight parallel writers, eight survivors", async () => {
  const home = await tempHome();
  const vault = await vaultIn(home);

  const names = Array.from({ length: 8 }, (_, i) => `TOKEN_${i}`);
  await Promise.all(names.map((n, i) => vault.setCredential(n, `secret-${i}`, { home })));

  assert.deepEqual(await vault.listCredentialNames({ home }), [...names].sort());
  for (const [i, n] of names.entries()) assert.equal(await vault.getCredential(n, { home }), `secret-${i}`);
  // The lock is released: no stray lock or tmp files remain.
  const leftovers = (await readdir(home)).filter((n) => n.endsWith(".lock") || n.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);

  await rm(home, { recursive: true, force: true });
});

test("damaged key: a 16-byte .keysecret is never regenerated and ciphertext is never returned", async () => {
  const home = await tempHome();
  const keyFile = path.join(home, ".keysecret");

  // First process: store a secret with a real key.
  const first = await vaultIn(home);
  await first.setCredential("STRIPE", "sk_live_real", { home });
  const originalKey = await readFile(keyFile);
  assert.equal(originalKey.length, 32);

  // The key file gets truncated (disk sync gone wrong) — next process starts.
  const damaged = originalKey.subarray(0, 16);
  await writeFile(keyFile, damaged);
  const second = await vaultIn(home);

  await assert.rejects(second.setCredential("OTHER", "x", { home }), (err: unknown) => {
    assert.ok(err instanceof second.KeySecretCorruptError, `expected KeySecretCorruptError, got ${String(err)}`);
    assert.match(err.message, /\.keysecret/, "names the file");
    assert.match(err.message, /16 bytes/, "names the length");
    return true;
  });
  assert.deepEqual(await readFile(keyFile), damaged, "the damaged key was NOT replaced");

  // getCredential never hands back `enc:v1:…` as if it were the secret.
  const got = await second.getCredential("STRIPE", { home });
  assert.equal(got, undefined);
  const probe = await second.probeCredentialEncryption();
  assert.equal(probe.available, false);
  assert.match(probe.reason ?? "", /16 bytes/);

  // The vault file itself was not touched by the refused write.
  assert.deepEqual(await second.listCredentialNames({ home }), ["STRIPE"]);

  await rm(home, { recursive: true, force: true });
});

test("first run: the key is created once and survives a losing racer", async () => {
  const home = await tempHome();
  const vault = await vaultIn(home);
  await Promise.all([vault.setCredential("A", "1", { home }), vault.setCredential("B", "2", { home })]);
  const key = await readFile(path.join(home, ".keysecret"));
  assert.equal(key.length, 32);
  assert.equal(await vault.getCredential("A", { home }), "1");
  assert.equal(await vault.getCredential("B", { home }), "2");
  await rm(home, { recursive: true, force: true });
});
