#!/usr/bin/env node
// Print the release body for a tag, generated from tauri/src/changelog.ts.
//
// The workflow used to carry the body inline, so it froze: v0.50.0's notes were
// published verbatim for v0.50.0, v0.51.0, v0.51.1 AND v0.52.0 — on the GitHub
// release page and in the updater prompt every user sees. Nobody noticed,
// because a release "succeeding" says nothing about what it said.
//
// changelog.ts already calls itself the single source of truth. This makes that
// literally so, and refuses to emit anything when the top entry does not match
// the tag being built — a release that forgot its changelog should fail loudly,
// not ship the previous one's story.
//
//   node scripts/release-notes.mjs v0.52.0

import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");

/** changelog.ts is TypeScript; transpile it rather than regex it. */
async function loadChangelog() {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-notes-"));
  const outfile = path.join(dir, "changelog.mjs");
  try {
    await build({
      entryPoints: [path.join(repoRoot, "tauri/src/changelog.ts")],
      outfile,
      format: "esm",
      bundle: false,
      logLevel: "silent",
    });
    const mod = await import(pathToFileURL(outfile).href);
    return mod.CHANGELOG;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function render(entry) {
  const lines = [
    `Ares ${entry.version} — ${entry.title}.`,
    "",
    entry.tagline,
    "",
  ];
  for (const h of entry.highlights) {
    const tag = h.tag ? ` _(${h.tag})_` : "";
    lines.push(`### ${h.icon} ${h.title}${tag}`, "", h.blurb, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

const tag = process.argv[2];
if (!tag) {
  console.error("usage: release-notes.mjs <tag>   e.g. v0.52.0");
  process.exit(2);
}
const wanted = tag.replace(/^v/, "");

const changelog = await loadChangelog();
const entry = changelog?.[0];
if (!entry) {
  console.error("changelog.ts has no entries");
  process.exit(1);
}
if (entry.version !== wanted) {
  console.error(
    `changelog.ts top entry is ${entry.version} but the tag is ${tag}.\n` +
    `Add the ${wanted} entry to tauri/src/changelog.ts (newest first) before tagging — ` +
    `otherwise this release publishes the previous one's notes, which is exactly ` +
    `what happened for 0.51.0 and 0.51.1.`,
  );
  process.exit(1);
}

// Sanity: the version the updater compares against lives in package.json.
const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
if (pkg.version !== wanted) {
  console.error(`package.json is ${pkg.version} but the tag is ${tag} — the manifests were not bumped.`);
  process.exit(1);
}

process.stdout.write(render(entry));
