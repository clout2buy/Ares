// Harness — changing Ares itself, safely (docs/CREATOR-MODE-DESIGN.md, Layer 3).
//
// A surface or an extension cannot fix a bug in the daemon's own code. The
// path that can already exists (docs/ELITE-SELFIMPROVE.md): the Maintainer
// builds the change in a forge worktree, `ares-verify` signs a green suite,
// the owner gets a Deploy? card, `ares-deploy` smoke-tests and rolls back.
// This tool is the model's front door to it: file the issue the Maintainer
// works from, read the proposals it produced, and tell the owner where the
// pipeline stands. It never edits the live tree, never deploys, and never
// pretends a proposal exists before the Maintainer wrote one.

import { z } from "zod";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { aresHome } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";
import { genuiGate } from "./genui.js";

const inputSchema = z
  .object({
    action: z.enum(["source", "apply", "revert", "propose", "proposals", "status"]).describe(
      "source: fetch Ares's own source for this version into <home>/source; edit it there with the normal tools, then build it (pnpm install, pnpm build, then node ../scripts/package-tauri-runtime.mjs from tauri/ with Node 22). apply: smoke-test the built runtime and stage it; this install's daemon runs it from the next launch, and a build that never reaches ready falls back by itself. revert: back to the shipped backend at next launch. propose: file a change for the Maintainer — a title and what is wrong, with evidence; it builds the fix in a throwaway worktree, verifies, and asks the owner before anything deploys. proposals: the proposals the Maintainer has produced and their status. status: whether the Maintainer is wired on this install and what it has pending.",
    ),
    runtime_dir: z.string().optional().describe("apply: the built runtime folder (default <home>/source/tauri/src-tauri/runtime)."),
    title: z.string().max(140).optional().describe("apply/propose: one line naming the change."),
    summary: z.string().max(2000).optional().describe("propose: what is wrong, what should happen instead, how to reproduce — the Maintainer's whole brief."),
    evidence: z.array(z.string().max(400)).max(8).optional().describe("propose: error text, session ids, file paths."),
    high_risk: z.boolean().optional().describe("propose: true when the change touches policy, permissions, secrets, the updater or tests (the card says HIGH RISK)."),
  })
  .strict();

export interface HarnessOutput {
  message: string;
  file?: string;
  proposals?: Array<{ id: string; title: string; status: string; createdAt?: string; risk?: string; branch?: string }>;
  wired?: boolean;
  pending?: number;
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 180_000 }, (err, _out, stderr) => resolve(err ? (stderr || err.message).slice(0, 400) : null));
  });
}

/** Boot the candidate against a throwaway home with the mock provider; it
 * must reach daemon_ready. */
async function smokeTest(node: string, cli: string): Promise<string | null> {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), "ares-smoke-"));
  const result = await new Promise<string | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(node, [cli, "daemon", "--json"], { cwd: tmpHome, windowsHide: true, env: { ...process.env, ARES_HOME: tmpHome, ARES_PROVIDER: "mock", ARES_MODEL: "mock" }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve(`the runtime's node could not start: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let out = "";
    let err = "";
    const done = (value: string | null) => { clearTimeout(timer); child.kill(); resolve(value); };
    const timer = setTimeout(() => done(`no daemon_ready within 90s. ${err.slice(0, 300)}`), 90_000);
    child.stdout?.on("data", (d) => { out += String(d); if (out.includes('"daemon_ready"')) done(null); });
    child.stderr?.on("data", (d) => { err += String(d); });
    child.on("exit", (code) => done(`exited with code ${code}. ${err.slice(0, 300)}`));
    child.on("error", (e) => done(e.message));
  });
  await rm(tmpHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  return result;
}

function maintainerRoot(home: string): string {
  return path.join(home, "maintainer");
}

async function readProposals(home: string): Promise<HarnessOutput["proposals"]> {
  const dir = path.join(maintainerRoot(home), "proposals");
  let names: string[];
  try { names = (await readdir(dir)).filter((n) => n.endsWith(".json")); } catch { return []; }
  const rows = await Promise.all(names.map(async (n) => {
    try {
      const doc = JSON.parse(await readFile(path.join(dir, n), "utf8")) as { id?: string; title?: string; status?: string; createdAt?: string; risk?: { class?: string }; branch?: string };
      return { id: String(doc.id ?? n.replace(/\.json$/, "")), title: String(doc.title ?? ""), status: String(doc.status ?? "unknown"), ...(doc.createdAt ? { createdAt: doc.createdAt } : {}), ...(doc.risk?.class ? { risk: doc.risk.class } : {}), ...(doc.branch ? { branch: doc.branch } : {}) };
    } catch { return null; }
  }));
  return rows.filter((r): r is NonNullable<typeof r> => r !== null).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

async function maintainerWired(home: string): Promise<boolean> {
  try { await readdir(maintainerRoot(home)); return true; } catch { return false; }
}

export const HarnessTool = buildTool<typeof inputSchema, HarnessOutput>({
  name: "Harness",
  description:
    "Change Ares's own code. source / apply / revert rebuild THIS install's backend: fetch the source, edit and build it, apply boots it in a test and stages it, the next launch runs it, a build that never reaches ready falls back. propose instead hands a change to the Maintainer, the verified pipeline: it files a change for the Maintainer (it builds the fix in a forge worktree off the live commit, runs the full suite, and asks the owner on their phone before deploying; a failed smoke test rolls back by itself). Use it when a bug or gap is in Ares itself — the daemon, a tool's code, the desktop — and no surface or extension can cover it. proposals / status read what the pipeline has done. Never edit the live tree yourself for this.",
  safety: "read-only",
  dynamicSafety: (input) => (input.action === "proposals" || input.action === "status" ? "read-only" : "external-state"),
  ownerDecisions: true,
  concurrency: "exclusive",
  inputZod: inputSchema,
  validateInput: async (input) => genuiGate(input.action !== "status" && input.action !== "proposals"),
  watchdogTimeoutMs: 240_000,
  activityDescription: (i) => (i.action === "propose" ? `Proposing a change: ${i.title ?? ""}` : "Reading the Maintainer"),
  async checkPermissions(input, ctx) {
    if (input.action === "proposals" || input.action === "status") return { kind: "allow" };
    if (ctx.permissionMode === "plan") return { kind: "deny", reason: "The Maintainer can only be read in plan mode." };
    if (input.action === "source") return { kind: "ask", prompt: "Download Ares's source for this version into the Ares folder so it can be edited?", suggestion: "allow_once" };
    if (input.action === "revert") return { kind: "ask", prompt: "Go back to the shipped backend the next time Ares starts?", suggestion: "allow_once" };
    if (input.action === "apply") return { kind: "ask", prompt: `Run a rebuilt Ares backend from the next launch${input.title ? `: ${input.title}` : ""}? It replaces the daemon on this install, including the permission gate, and runs with your full permissions. If it never reaches ready, Ares falls back by itself; if it starts but misbehaves, Ctrl+K, Use the shipped backend.`, suggestion: "allow_once", ownerDecision: true };
    return {
      kind: "ask",
      prompt: `File "${input.title ?? "a change"}" for the Maintainer? It will build the fix in a throwaway worktree, run the full test suite, and ask you before anything deploys${input.high_risk ? " — HIGH RISK: it touches policy, secrets, the updater or tests, so the Deploy card will need your explicit acknowledgement" : ""}. Nothing changes until you approve the proposal.`,
      suggestion: "allow_once",
      ownerDecision: true,
    };
  },
  async call(input): Promise<ToolResult<HarnessOutput>> {
    const home = aresHome();
    try {
      switch (input.action) {
        case "source": {
          const version = process.env.ARES_DESKTOP_VERSION;
          const dir = path.join(home, "source");
          const ref = version ? `v${version}` : "main";
          await rm(dir, { recursive: true, force: true, maxRetries: 3 });
          const failed = await run("git", ["clone", "--depth", "1", "--branch", ref, "https://github.com/clout2buy/Ares.git", dir]);
          if (failed) return failResult<HarnessOutput>(`Could not fetch the source (${ref}): ${failed}. Git must be installed.`);
          return okResult({ file: dir, message: `Source for ${ref} is at ${dir}. Edit it, then from that folder: pnpm install, pnpm build, and from tauri/: node ../scripts/package-tauri-runtime.mjs (Node 22). Then Harness apply. Those need Node 22 and pnpm on this machine; say so if they are missing.` });
        }
        case "apply": {
          const from = input.runtime_dir ?? path.join(home, "source", "tauri", "src-tauri", "runtime");
          const node = path.join(from, "bin", process.platform === "win32" ? "node.exe" : "node");
          const cli = path.join(from, "cli", "ares-cli.mjs");
          for (const file of [node, cli]) {
            const info = await stat(file).catch(() => null);
            if (!info?.size) return failResult<HarnessOutput>(`No built runtime: ${file} is missing or empty.`);
          }
          const smoke = await smokeTest(node, cli);
          if (smoke) return failResult<HarnessOutput>(`The rebuilt backend did not boot, so nothing changed: ${smoke}`);
          const next = path.join(home, "runtime-next");
          await rm(next, { recursive: true, force: true, maxRetries: 3 });
          await cp(from, next, { recursive: true });
          await writeFile(path.join(next, ".version"), process.env.ARES_DESKTOP_VERSION ?? "", "utf8");
          await writeFile(path.join(next, ".ready"), JSON.stringify({ title: input.title ?? "", at: new Date().toISOString() }), "utf8");
          await rm(path.join(home, "runtime-revert"), { force: true });
          return okResult({ file: next, message: "The rebuilt backend passed its boot test and is staged. Restart Ares to run it." });
        }
        case "revert": {
          await rm(path.join(home, "runtime-next"), { recursive: true, force: true, maxRetries: 3 });
          await writeFile(path.join(home, "runtime-revert"), new Date().toISOString(), "utf8");
          return okResult({ message: "Ares returns to the shipped backend at its next start." });
        }
        case "status": {
          const wired = await maintainerWired(home);
          const proposals = (await readProposals(home)) ?? [];
          const pending = proposals.filter((p) => p.status === "pending").length;
          return okResult({ wired, pending, message: wired ? `The Maintainer is wired on this install: ${proposals.length} proposal(s), ${pending} pending the owner.` : "The Maintainer is not wired on this install (it runs with the garrison, see docs/ELITE-SELFIMPROVE.md); propose still files the issue for when it is." });
        }
        case "proposals": {
          const proposals = (await readProposals(home)) ?? [];
          return okResult({ proposals, message: proposals.length ? proposals.slice(0, 20).map((p) => `${p.id}: ${p.title} — ${p.status}${p.risk ? ` (risk ${p.risk})` : ""}`).join("\n") : "No proposals yet." });
        }
        case "propose": {
          if (!input.title?.trim() || !input.summary?.trim()) return failResult<HarnessOutput>("propose needs title and summary.");
          // The Maintainer collects owner bug reports from <home>/bug-reports;
          // a proposal from the model is the same shape with its provenance
          // stated, so the existing collector, ranking and budget apply.
          const dir = path.join(home, "bug-reports");
          await mkdir(dir, { recursive: true });
          const id = `harness-${Date.now().toString(36)}`;
          const file = path.join(dir, `${id}.json`);
          const doc = {
            id,
            source: "harness",
            createdAt: new Date().toISOString(),
            title: input.title.trim(),
            description: `${input.title.trim()} — ${input.summary.trim()}`,
            summary: input.summary.trim(),
            evidence: input.evidence ?? [],
            highRisk: input.high_risk === true,
          };
          await writeFile(file, JSON.stringify(doc, null, 2), "utf8");
          const wired = await maintainerWired(home);
          return okResult({ file, wired, message: `Filed ${id} for the Maintainer${wired ? "; its next run will pick it up, build in a worktree, verify, and ask the owner to deploy." : ". The Maintainer is not wired on this install, so this waits until it is (docs/ELITE-SELFIMPROVE.md)."}` });
        }
      }
    } catch (err) {
      return failResult<HarnessOutput>(err instanceof Error ? err.message : String(err));
    }
  },
});
