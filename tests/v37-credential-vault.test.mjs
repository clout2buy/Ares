// Verifies the in-house credential vault — the one place every tool reads
// secrets from:
//   1. set → get round-trips the plaintext.
//   2. Secrets are ENCRYPTED at rest (the file never holds the plaintext).
//   3. Resolution order: vault first, then process.env fallback, then envFallback.
//   4. list returns names only; delete removes.
//   5. A missing/empty secret resolves to undefined (not "").

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getCredential,
  setCredential,
  deleteCredential,
  listCredentialNames,
  hasCredential,
} from "../packages/core/dist/index.js";

async function freshHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-v37-"));
  process.env.ARES_HOME = home;
  return home;
}

test("vault: set → get round-trips the plaintext", async () => {
  const home = await freshHome();
  await setCredential("RESEND_API_KEY", "re_live_abc123", { home });
  assert.equal(await getCredential("RESEND_API_KEY", { home }), "re_live_abc123");
});

test("vault: secrets are encrypted at rest — plaintext never hits disk", async () => {
  const home = await freshHome();
  await setCredential("STRIPE_SECRET_KEY", "sk_test_supersecret", { home });
  const onDisk = await fs.readFile(path.join(home, "credentials.json"), "utf8");
  assert.ok(!onDisk.includes("sk_test_supersecret"), "plaintext secret leaked to disk");
  assert.ok(onDisk.includes("enc:v1:"), "value is stored as an enc:v1 token");
  // …but it still decrypts back to the original.
  assert.equal(await getCredential("STRIPE_SECRET_KEY", { home }), "sk_test_supersecret");
});

test("vault: resolution prefers the vault, then env, then envFallback", async () => {
  const home = await freshHome();
  delete process.env.MY_TOKEN;
  delete process.env.MY_TOKEN_ALT;

  // 1. nothing anywhere → undefined
  assert.equal(await getCredential("MY_TOKEN", { home }), undefined);

  // 2. env only → env wins
  process.env.MY_TOKEN = "from-env";
  assert.equal(await getCredential("MY_TOKEN", { home }), "from-env");

  // 3. vault set → vault overrides env
  await setCredential("MY_TOKEN", "from-vault", { home });
  assert.equal(await getCredential("MY_TOKEN", { home }), "from-vault");

  // 4. envFallback name is tried when the primary is absent
  delete process.env.MY_TOKEN;
  await deleteCredential("MY_TOKEN", { home });
  process.env.MY_TOKEN_ALT = "from-alt";
  assert.equal(await getCredential("MY_TOKEN", { home, envFallback: ["MY_TOKEN_ALT"] }), "from-alt");

  delete process.env.MY_TOKEN;
  delete process.env.MY_TOKEN_ALT;
});

test("vault: list returns names only, delete removes, has reflects presence", async () => {
  const home = await freshHome();
  await setCredential("VERCEL_TOKEN", "v1", { home });
  await setCredential("RESEND_API_KEY", "r1", { home });

  assert.deepEqual(await listCredentialNames({ home }), ["RESEND_API_KEY", "VERCEL_TOKEN"]);
  assert.equal(await hasCredential("VERCEL_TOKEN", { home }), true);

  assert.equal(await deleteCredential("VERCEL_TOKEN", { home }), true);
  assert.equal(await deleteCredential("VERCEL_TOKEN", { home }), false, "second delete is a no-op");
  assert.equal(await hasCredential("VERCEL_TOKEN", { home }), false);
  assert.deepEqual(await listCredentialNames({ home }), ["RESEND_API_KEY"]);
});

test("vault: an empty stored value resolves to undefined, never ''", async () => {
  const home = await freshHome();
  await setCredential("BLANK", "   ", { home });
  assert.equal(await getCredential("BLANK", { home }), undefined);
});
