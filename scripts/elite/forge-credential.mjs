#!/usr/bin/env node
// forge-credential: git credential helper + one-time setter for the forge's GitHub token, backed by
// the Ares credential vault (AES-256-GCM, ~/.ares/credentials.json) so no token ever sits in a
// shell history, a git config, a chat, or this repo.
//
//   store   read the token from STDIN (not argv - argv shows in `ps`) and put it in the vault
//             printf %s "$TOKEN" | node scripts/elite/forge-credential.mjs store
//   forget  remove it from the vault
//   get     the git credential-helper protocol (git calls this; prints username/password to git only)
//   status  prints "present" or "missing" - never the value
//
// Token: a FINE-GRAINED personal access token limited to the one repository, "Contents: read and
// write" (push of auto/* branches) and nothing else; or use a deploy key instead (see bootstrap-forge.sh).
// The vault entry name is FORGE_GITHUB_TOKEN; the env var of the same name overrides it (CI).

import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const NAME = "FORGE_GITHUB_TOKEN";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function vault() {
  const mod = await import(pathToFileURL(path.join(root, "packages", "core", "dist", "index.js")).href).catch(() => null);
  if (!mod?.getCredential) throw new Error("the Ares build is not available next to this script (packages/core/dist); run pnpm build first");
  return mod;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const cmd = process.argv[2] ?? "";
try {
  if (cmd === "store") {
    const token = (await readStdin()).trim();
    if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new Error("that does not look like a GitHub token (expected 20+ letters, digits, underscores)");
    await (await vault()).setCredential(NAME, token);
    console.error("stored in the Ares vault as FORGE_GITHUB_TOKEN");
  } else if (cmd === "forget") {
    await (await vault()).deleteCredential(NAME);
    console.error("removed");
  } else if (cmd === "status") {
    const token = process.env[NAME] || (await (await vault()).getCredential(NAME).catch(() => undefined));
    console.log(token ? "present" : "missing");
  } else if (cmd === "get") {
    const request = Object.fromEntries((await readStdin()).split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
    if (request.protocol === "https" && request.host === "github.com") {
      const token = process.env[NAME] || (await (await vault()).getCredential(NAME).catch(() => undefined));
      if (token) process.stdout.write(`username=x-access-token\npassword=${token}\n`);
    }
  } else if (cmd === "erase") {
    // git also calls erase after a failed auth: nothing to erase, the vault is the source of truth
  } else {
    console.error("usage: forge-credential.mjs store|forget|status|get");
    process.exit(2);
  }
} catch (err) {
  console.error(`forge-credential: ${err?.message ?? err}`);
  process.exit(1);
}
