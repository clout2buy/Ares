import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

test("stabilization: clean/startup contract is explicit", async () => {
  const [packageRaw, cleanRaw, developmentRaw] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "scripts", "clean.mjs"), "utf8"),
    readFile(path.join(root, "docs", "DEVELOPMENT.md"), "utf8"),
  ]);
  const rootPackage = JSON.parse(packageRaw);

  assert.equal(rootPackage.scripts.clean, "node scripts/clean.mjs");
  assert.equal(rootPackage.scripts.ares, "node packages/cli/dist/entry.js");
  assert.match(cleanRaw, /packagesDir/);
  assert.match(cleanRaw, /path\.join\(packageDir, "dist"\)/);
  assert.match(cleanRaw, /path\.join\(root, "\.ares"\)/);
  assert.match(cleanRaw, /src-tauri", "gen"/);
  assert.match(developmentRaw, /Use `pnpm build` before running `pnpm ares`/);
});

test("stabilization: root CLI script launches the built entrypoint", () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "ares-startup-smoke-"));
  const result = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "pnpm --silent ares help"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, ARES_HOME: testHome, ARES_AGENT_ENABLED: "0" },
      })
    : spawnSync("pnpm", ["--silent", "ares", "help"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, ARES_HOME: testHome, ARES_AGENT_ENABLED: "0" },
      });

  assert.equal(result.status, 0, `pnpm ares help failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /ares v0\.11\.0/);
  assert.match(result.stdout, /autonomous AI agent/);
});

test("stabilization: direct CLI entrypoint launches", () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "ares-entry-smoke-"));
  const result = spawnSync(process.execPath, [path.join(root, "packages", "cli", "dist", "entry.js"), "help"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ARES_HOME: testHome, ARES_AGENT_ENABLED: "0" },
  });

  assert.equal(result.status, 0, `node entry.js help failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /ares v0\.11\.0/);
  assert.match(result.stdout, /autonomous AI agent/);
});

test("stabilization: Tauri daemon launch expectation is build-gated", async () => {
  const [mainRaw, configRaw] = await Promise.all([
    readFile(path.join(root, "tauri", "src-tauri", "src", "main.rs"), "utf8"),
    readFile(path.join(root, "tauri", "src-tauri", "tauri.conf.json"), "utf8"),
  ]);
  const config = JSON.parse(configRaw);

  // The CLI entry path is assembled via join("packages")...join("entry.js")
  // since the alpha.2 runtime-resolution rework — assert the chain, not a literal.
  assert.match(mainRaw, /join\("packages"\)[\s\S]*?join\("cli"\)[\s\S]*?join\("dist"\)[\s\S]*?join\("entry\.js"\)/);
  assert.match(mainRaw, /Could not find Ares runtime\. Rebuild the desktop runtime before launching the app\./);
  assert.equal(config.build.beforeDevCommand, "pnpm dev:vite");
  assert.equal(config.build.beforeBuildCommand, "pnpm build:web");
});
