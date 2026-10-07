// `ares godot` — wire a Godot 4 project up for Ares.
//
//   ares godot init [project] [--godot <exe>] [--port 6505]   install the bridge addon, enable it, write .ares/godot.json
//   ares godot doctor [project]                              provider healthcheck (godot exe, bridge, runtime)
//   ares godot check [project]                               headless parse + boot check
//   ares godot shot [project] [--view 3d|2d]                 screenshot the editor viewport (editor must be open)
//   ares godot skill                                         (re)install the bundled provider into ~/.ares/skills
//
// Everything runs through the same capability provider the agent uses
// (~/.ares/skills/godot), so what the CLI reports is what the model sees.

import { promises as fs } from "node:fs";
import path from "node:path";
import { agentPaths, aresAgentHome, installBundledSkills, runSkill } from "@ares/agent";
import type { ParsedArgs } from "./args.js";

export async function godotCommand(parsed: ParsedArgs): Promise<number> {
  const action = parsed.positionals[0] ?? "doctor";
  const home = aresAgentHome(process.env.ARES_HOME);
  const paths = agentPaths(home);
  const installed = await installBundledSkills(paths.skillsDir, { only: ["godot"] });
  const skillDir = path.join(paths.skillsDir, "godot");
  if (action === "skill") {
    const forced = await installBundledSkills(paths.skillsDir, { only: ["godot"], force: parsed.flags.has("force") });
    for (const item of forced) console.log(`${item.action}: ${item.name}${item.version ? ` v${item.version}` : ""} → ${item.dir}`);
    if (forced.length === 0) console.error("bundled skills directory not found (packages/agent/skills or runtime/skills)");
    return forced.length ? 0 : 1;
  }
  const project = path.resolve(parsed.positionals[1] ?? parsed.flags.get("project") ?? process.cwd());
  const projectFile = path.join(project, "project.godot");
  const hasProject = await fs.stat(projectFile).then((s) => s.isFile(), () => false);
  if (!hasProject) {
    console.error(`no project.godot in ${project}\nusage: ares godot <init|doctor|check|shot> [project-dir]`);
    return 2;
  }
  const invoke = async (operation: string, input: Record<string, unknown>, timeoutMs = 120_000) =>
    runSkill({ home, name: "godot", operation, input, targetRoot: project, workspace: project, timeoutMs });

  if (action === "init") {
    const addonSource = path.join(skillDir, "addon", "ares_bridge");
    const addonTarget = path.join(project, "addons", "ares_bridge");
    await fs.mkdir(addonTarget, { recursive: true });
    await fs.cp(addonSource, addonTarget, { recursive: true, force: true });
    console.log(`addon  → ${addonTarget}`);

    const pluginEntry = "res://addons/ares_bridge/plugin.cfg";
    let text = await fs.readFile(projectFile, "utf8");
    if (!text.includes(pluginEntry)) {
      const m = text.match(/\[editor_plugins\]\s*\n\s*enabled=PackedStringArray\(([^)]*)\)/);
      if (m) {
        const list = m[1].trim();
        const next = list ? `${list}, "${pluginEntry}"` : `"${pluginEntry}"`;
        text = text.replace(m[0], m[0].replace(`PackedStringArray(${m[1]})`, `PackedStringArray(${next})`));
      } else {
        text = text.replace(/\s*$/, `\n\n[editor_plugins]\n\nenabled=PackedStringArray("${pluginEntry}")\n`);
      }
      await fs.writeFile(projectFile, text, "utf8");
      console.log("plugin → enabled in project.godot");
    } else {
      console.log("plugin → already enabled");
    }

    const cfgDir = path.join(project, ".ares");
    await fs.mkdir(cfgDir, { recursive: true });
    const cfgFile = path.join(cfgDir, "godot.json");
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(await fs.readFile(cfgFile, "utf8")) as Record<string, unknown>;
    } catch {
      // fresh
    }
    const port = Number(parsed.flags.get("port") ?? cfg.bridgePort ?? 6505);
    cfg.bridgePort = port;
    cfg.runtimePort = Number(parsed.flags.get("runtime-port") ?? cfg.runtimePort ?? port + 1);
    const godotFlag = parsed.flags.get("godot");
    if (godotFlag) {
      const exe = path.resolve(godotFlag);
      if (!(await fs.stat(exe).then((s) => s.isFile(), () => false))) {
        console.error(`--godot path is not a file: ${exe}`);
        return 2;
      }
      cfg.godotPath = exe;
      const homeCfg = path.join(home, "godot.json");
      let hc: Record<string, unknown> = {};
      try {
        hc = JSON.parse(await fs.readFile(homeCfg, "utf8")) as Record<string, unknown>;
      } catch {
        // fresh
      }
      hc.godotPath = exe;
      await fs.writeFile(homeCfg, JSON.stringify(hc, null, 2) + "\n", "utf8");
      console.log(`godot  → ${exe} (remembered in ${homeCfg})`);
    }
    await fs.writeFile(cfgFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    console.log(`config → ${cfgFile} (bridge ${cfg.bridgePort}, runtime ${cfg.runtimePort})`);

    const gi = path.join(project, ".gitignore");
    const ignore = await fs.readFile(gi, "utf8").catch(() => "");
    if (!ignore.includes(".ares/godot/")) {
      await fs.writeFile(gi, `${ignore.replace(/\s*$/, "")}\n# Ares run artifacts (screenshots, caches)\n.ares/godot/\n`.replace(/^\n/, ""), "utf8");
      console.log("git    → .ares/godot/ ignored");
    }
    console.log("\nOpen the project in Godot (the editor prints `Ares bridge listening on 127.0.0.1:<port>`), then:\n  ares godot doctor " + JSON.stringify(project));
    const run = await invoke("health", { verify: true }, 40_000);
    printRun(run);
    return 0;
  }

  if (action === "doctor" || action === "health") {
    const run = await invoke("health", { verify: true }, 40_000);
    printRun(run);
    if (installed.some((i) => i.action === "installed" || i.action === "updated")) console.log(`(bundled provider ${installed[0].action} → ${skillDir})`);
    return run.ok ? 0 : 1;
  }
  if (action === "check") {
    const run = await invoke("check", { boot: !parsed.flags.has("no-boot"), scripts: !parsed.flags.has("no-scripts") }, 600_000);
    printRun(run);
    const passed = (run.result as { passed?: boolean } | undefined)?.passed;
    return run.ok && passed !== false ? 0 : 1;
  }
  if (action === "shot" || action === "screenshot") {
    const run = await invoke("screenshot", { source: parsed.flags.get("source") ?? "auto", view: parsed.flags.get("view") ?? "3d", label: "cli" }, 60_000);
    printRun(run);
    return run.ok ? 0 : 1;
  }
  if (action === "run") {
    const steps = parsed.positionals.slice(2);
    const run = await invoke("run", { scene: parsed.flags.get("scene"), steps: steps.length ? steps : ["wait 800", "shot cli"], keepAlive: parsed.flags.has("keep") }, 300_000);
    printRun(run);
    return run.ok ? 0 : 1;
  }
  console.error(`unknown godot subcommand: ${action}\nusage: ares godot <init|doctor|check|shot|run|skill> [project-dir] [--godot <exe>] [--port N]`);
  return 2;
}

function printRun(run: Awaited<ReturnType<typeof runSkill>>): void {
  if (run.result !== undefined) console.log(JSON.stringify(run.result, null, 2));
  for (const line of run.receipt?.diagnostics ?? []) console.log(`! ${line}`);
  if (!run.ok) console.error(`error: ${run.error ?? "provider failed"}`);
  if (run.logs.trim() && process.env.ARES_DEBUG) console.error(run.logs);
}
