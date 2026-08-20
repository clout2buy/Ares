// AgentComputer — the sandbox manager and its tool surface, exercised against
// a scripted fake wsl.exe so tests run anywhere (no WSL required).

import assert from "node:assert/strict";
import test from "node:test";

import {
  WslSandbox,
  SANDBOX_DISTRO,
  guiInputRefusal,
  makeAgentComputerTools,
} from "../packages/tools/dist/index.js";

/** A scripted runner: match wsl.exe argv against expectations in order. */
function scriptedRunner(script) {
  const calls = [];
  const runner = async (args) => {
    calls.push([...args]);
    for (const entry of script) {
      if (entry.match(args)) return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...entry.result };
    }
    return { stdout: "", stderr: `unscripted call: ${args.join(" ")}`, exitCode: 1, timedOut: false };
  };
  runner.calls = calls;
  return runner;
}

const provisionedScript = [
  { match: (a) => a[0] === "--status", result: { exitCode: 0 } },
  { match: (a) => a[0] === "--list", result: { stdout: `Ubuntu\n${SANDBOX_DISTRO}\n` } },
  { match: (a) => a.join(" ").includes("cat /etc/ares-computer-release"), result: { stdout: "version=1\nprovisionedAt=2026-08-19T00:00:00Z\n" } },
];

test("guiInputRefusal bans shell-driven GUI input and allows normal commands", () => {
  assert.match(guiInputRefusal("xdotool key Return") ?? "", /may not drive the GUI/);
  assert.match(guiInputRefusal("sudo apt install xte && xte 'key Return'") ?? "", /may not drive the GUI/);
  assert.equal(guiInputRefusal("python3 train.py --xdotoolish-name"), null);
  assert.equal(guiInputRefusal("ls -la && git status"), null);
});

test("exec runs as the sandbox user inside the distro with a cwd prefix", async () => {
  const runner = scriptedRunner([
    ...provisionedScript,
    { match: (a) => a.includes("bash"), result: { stdout: "hello\n", exitCode: 0 } },
  ]);
  const box = new WslSandbox(runner);
  const result = await box.exec("echo hello");
  assert.equal(result.stdout, "hello\n");
  const execCall = runner.calls.find((c) => c.at(-1)?.includes("echo hello"));
  assert.deepEqual(execCall.slice(0, 4), ["-d", SANDBOX_DISTRO, "-u", "ares"]);
  assert.match(execCall.at(-1), /^cd '\/home\/ares' 2>\/dev\/null; echo hello$/);
});

test("exec refuses to run before the sandbox is provisioned", async () => {
  const runner = scriptedRunner([
    { match: (a) => a[0] === "--status", result: { exitCode: 0 } },
    { match: (a) => a[0] === "--list", result: { stdout: "Ubuntu\n" } },
  ]);
  const box = new WslSandbox(runner);
  await assert.rejects(box.exec("echo hi"), /not set up yet/);
});

test("sandbox paths reject Windows paths and .. traversal; relative resolves under home", () => {
  const box = new WslSandbox(scriptedRunner(provisionedScript));
  assert.equal(box.resolveSandboxPath("notes.txt"), "/home/ares/notes.txt");
  assert.equal(box.resolveSandboxPath("/tmp/x"), "/tmp/x");
  assert.throws(() => box.resolveSandboxPath("C:\\Users\\x"), /Windows path/);
  assert.throws(() => box.resolveSandboxPath("../etc/passwd"), /'\.\.'/);
  assert.equal(box.uncPath("/home/ares/a.txt"), `\\\\wsl.localhost\\${SANDBOX_DISTRO}\\home\\ares\\a.txt`);
});

test("the display lease admits one holder and refuses a contested grab", () => {
  const box = new WslSandbox(scriptedRunner(provisionedScript));
  box.acquireLease(1, "agent", "pixel work");
  assert.equal(box.lease(1)?.holder, "agent");
  assert.throws(() => box.acquireLease(1, "owner", "grabbing"), /lease is held by agent/);
  box.releaseLease(1);
  box.acquireLease(1, "owner", "2FA");
  assert.equal(box.lease(1)?.holder, "owner");
  box.releaseLease(1);
});

test("ComputerExec tool surfaces the GUI-input doctrine as a correctable validation", async () => {
  const box = new WslSandbox(scriptedRunner(provisionedScript));
  const tools = makeAgentComputerTools({ sandbox: box });
  const exec = tools.find((t) => t.schema.name === "ComputerExec");
  const verdict = await exec.validateInput(
    { command: "xdotool click 1", description: "clicks", timeout: 1000 },
    {},
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /may not drive the GUI/);
  const fine = await exec.validateInput(
    { command: "uname -a", description: "kernel", timeout: 1000 },
    {},
  );
  assert.equal(fine.ok, true);
});

test("tool surface: safety classes match the sandbox-free / host-gated split", () => {
  const tools = makeAgentComputerTools({ sandbox: new WslSandbox(scriptedRunner(provisionedScript)) });
  const byName = new Map(tools.map((t) => [t.schema.name, t]));
  assert.deepEqual(
    [...byName.keys()].sort(),
    ["ComputerAdmin", "ComputerBrowser", "ComputerExec", "ComputerFile", "ComputerHandoff", "ComputerScreenshot", "ComputerTransfer"],
  );
  assert.equal(byName.get("ComputerScreenshot").schema.safety, "read-only");
  assert.equal(byName.get("ComputerExec").schema.safety, "workspace-write");
  // dynamic: reads are read-only, mutations are workspace-write
  assert.equal(byName.get("ComputerFile").effectiveSafety({ action: "read", path: "a" }), "read-only");
  assert.equal(byName.get("ComputerFile").effectiveSafety({ action: "write", path: "a", content: "x" }), "workspace-write");
  assert.equal(byName.get("ComputerBrowser").effectiveSafety({ action: "read", display: 1 }), "read-only");
  assert.equal(byName.get("ComputerBrowser").effectiveSafety({ action: "navigate", url: "https://x", display: 1 }), "workspace-write");
  // admin: status reads, rebuild/snapshot ask
  assert.equal(byName.get("ComputerAdmin").effectiveSafety({ action: "status", view_only: false }), "read-only");
  assert.equal(byName.get("ComputerAdmin").effectiveSafety({ action: "rebuild", view_only: false }), "external-state");
});

test("manifest parses, tolerates a corrupt file, and validates package names", async () => {
  const runner = scriptedRunner([
    ...provisionedScript,
    { match: (a) => a.join(" ").includes(".ares-manifest.json"), result: { stdout: '{"packages":["ffmpeg","jq"]}' } },
  ]);
  const box = new WslSandbox(runner);
  assert.deepEqual(await box.manifest(), { packages: ["ffmpeg", "jq"] });
  await assert.rejects(box.manifestInstall("bad name; rm -rf /"), /not a valid Debian package name/);
});
