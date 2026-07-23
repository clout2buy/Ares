// Vanguard engine over-the-air updates — the engine ships faster than the app.
//
// Ares installers vendor a Vanguard engine, but engine fixes land far more
// often than app releases. A rolling GitHub release tag ("vanguard-engine")
// on the Ares repo carries a manifest + tarball; the daemon checks it at
// boot, verifies the tarball hash, extracts under the Ares home, and both
// the host module and session workers prefer the downloaded engine over the
// bundled copy via ARES_VANGUARD_ENGINE_DIR. The bundled engine remains the
// permanent fallback — a bad download can never brick drive mode.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const RELEASE_BASE = process.env.ARES_VANGUARD_ENGINE_CHANNEL
  || "https://github.com/clout2buy/Ares/releases/download/vanguard-engine";

interface EngineManifest {
  readonly version: string;
  readonly tarball: string;
  readonly sha256: string;
}

interface CurrentEngine {
  readonly version: string;
  readonly dir: string;
}

/** Numeric dotted-version compare: newer(a, b) is true when a > b. */
function newer(a: string, b: string): boolean {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) return l > r;
  }
  return false;
}

function engineHome(home: string): string {
  return path.join(home, "vanguard-engine");
}

/** The downloaded engine already on disk, when its entrypoints still exist. */
export async function currentVanguardEngine(home: string): Promise<CurrentEngine | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(engineHome(home), "current.json"), "utf8")) as { version?: unknown };
    if (typeof raw.version !== "string" || raw.version.length === 0) return undefined;
    const dir = path.join(engineHome(home), raw.version);
    if (!existsSync(path.join(dir, "engine", "src", "index.js"))
      || !existsSync(path.join(dir, "engine", "src", "cli.js"))) return undefined;
    return { version: raw.version, dir };
  } catch {
    return undefined;
  }
}

async function installedVersion(home: string, bundledVersion: string | undefined): Promise<string> {
  const current = await currentVanguardEngine(home);
  if (current !== undefined && (bundledVersion === undefined || newer(current.version, bundledVersion))) {
    return current.version;
  }
  return bundledVersion ?? current?.version ?? "0.0.0";
}

/** Version of the engine vendored into this build, if resolvable. */
export async function bundledVanguardEngineVersion(bundledPackageJson: string | undefined): Promise<string | undefined> {
  if (bundledPackageJson === undefined) return undefined;
  try {
    const raw = JSON.parse(await readFile(bundledPackageJson, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

function extractTarball(tarball: string, destination: string): Promise<void> {
  // bsdtar ships with Windows 10+, macOS, and every mainstream Linux. On
  // Windows the System32 copy is addressed explicitly — a GNU tar earlier on
  // PATH (Git Bash) treats drive-letter paths as remote hosts.
  const tar = process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ["-xzf", tarball, "-C", destination], { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with ${code}`));
    });
  });
}

/**
 * Checks the rolling channel and installs a newer engine when one exists.
 * Returns the engine dir to use (fresh install or existing download), or
 * undefined when the bundled engine is already the best available.
 */
export async function updateVanguardEngine(
  home: string,
  bundledVersion: string | undefined,
  log: (line: string) => void = () => {},
): Promise<string | undefined> {
  try {
    const response = await fetch(`${RELEASE_BASE}/manifest.json`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return (await currentVanguardEngine(home))?.dir;
    const manifest = await response.json() as EngineManifest;
    if (typeof manifest.version !== "string" || typeof manifest.tarball !== "string" || typeof manifest.sha256 !== "string") {
      return (await currentVanguardEngine(home))?.dir;
    }
    const have = await installedVersion(home, bundledVersion);
    if (!newer(manifest.version, have)) return (await currentVanguardEngine(home))?.dir;

    log(`vanguard engine ${manifest.version} available (have ${have}) — downloading`);
    const tarballResponse = await fetch(`${RELEASE_BASE}/${manifest.tarball}`, { signal: AbortSignal.timeout(120_000) });
    if (!tarballResponse.ok) throw new Error(`tarball fetch: HTTP ${tarballResponse.status}`);
    const bytes = Buffer.from(await tarballResponse.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== manifest.sha256.toLowerCase()) throw new Error("tarball hash mismatch — refusing to install");

    const root = engineHome(home);
    const staging = path.join(root, `.staging-${manifest.version}-${Date.now()}`);
    const final = path.join(root, manifest.version);
    await mkdir(staging, { recursive: true });
    const tarballFile = path.join(staging, manifest.tarball);
    await writeFile(tarballFile, bytes);
    await extractTarball(tarballFile, staging);
    await rm(tarballFile, { force: true });
    if (!existsSync(path.join(staging, "engine", "src", "index.js"))
      || !existsSync(path.join(staging, "engine", "src", "cli.js"))) {
      throw new Error("tarball did not contain a complete engine");
    }
    await rm(final, { recursive: true, force: true });
    await rename(staging, final);
    // current.json is written LAST — a crash mid-install leaves the previous
    // engine (or the bundled one) in charge.
    await writeFile(path.join(root, "current.json"), JSON.stringify({ version: manifest.version }, null, 2), "utf8");
    log(`vanguard engine ${manifest.version} installed`);
    return final;
  } catch (error) {
    log(`vanguard engine update skipped: ${error instanceof Error ? error.message : String(error)}`);
    return (await currentVanguardEngine(home))?.dir;
  }
}
