// Ares Godot provider — handler. Runs in the isolated skill child process and
// returns a contract receipt for every operation (see capability.json).
//
//   health | locate | inspect | mutate | check | run | screenshot | asset | docs | video | discover
//
// Live path: the editor bridge (addons/ares_bridge) on the project's bridge
// port. Offline path: .tscn / .gd / project.godot edits on disk, headless
// godot for verification. Both report truthfully — a mutation is listed with
// its post-write hash, a screenshot is fresh evidence or it is an error.

import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as tscn from "./lib/tscn.js";
import * as mesh from "./lib/mesh.js";
import * as net from "./lib/net.js";
import * as godot from "./lib/godot.js";

const PROVIDER_ID = "ares/godot";

export default async function handler(input, ctx) {
  const op = ctx.operation || (input && input.op);
  const root = path.resolve(ctx.targetRoot || ctx.workspace || process.cwd());
  const started = Date.now();
  const receipt = {
    contractVersion: 1,
    ok: true,
    providerId: PROVIDER_ID,
    providerHash: ctx.providerHash,
    operation: op,
    targetRoot: root,
    mutations: [],
    evidence: [],
    diagnostics: [],
  };
  const fn = OPS[op];
  if (!fn) {
    return { ...receipt, ok: false, error: `unknown operation '${op}'. Known: ${Object.keys(OPS).join(", ")}` };
  }
  try {
    const out = await fn(input ?? {}, { ...ctx, root, started });
    receipt.ok = out.ok !== false;
    if (out.result !== undefined) receipt.result = out.result;
    if (out.mutations) receipt.mutations = out.mutations;
    if (out.evidence) receipt.evidence = out.evidence;
    if (out.diagnostics) receipt.diagnostics = out.diagnostics;
    if (out.error) receipt.error = out.error;
    if (!receipt.ok && !receipt.error) receipt.error = "operation reported failure";
    return receipt;
  } catch (error) {
    return { ...receipt, ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }
}

// ---- shared ---------------------------------------------------------------

async function sha256File(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function hashIfExists(file) {
  try {
    return await sha256File(file);
  } catch {
    return null;
  }
}

async function mutationFor(file, beforeHash) {
  return { path: file, beforeHash: beforeHash ?? null, afterHash: await hashIfExists(file) };
}

async function screenshotEvidence(file) {
  const buf = await fs.readFile(file);
  return { kind: "screenshot", uri: file, sha256: createHash("sha256").update(buf).digest("hex"), observedAt: new Date().toISOString() };
}

function shotsDir(root) {
  return path.join(root, ".ares", "godot", "shots");
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function slug(s) {
  return String(s ?? "shot").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "shot";
}

async function context(ctx) {
  const project = await godot.readProject(ctx.root);
  const cfg = await godot.readAresConfig(ctx.root, ctx.home);
  return { project, cfg };
}

async function bridge(cfg) {
  const pong = await net.rpcPing(cfg.bridgePort, 800);
  return pong ? { port: cfg.bridgePort, pong, call: (m, p, t) => net.rpcCall(cfg.bridgePort, m, p, t ?? 20_000) } : null;
}

async function runtime(cfg) {
  const pong = await net.rpcPing(cfg.runtimePort, 800);
  return pong ? { port: cfg.runtimePort, pong, call: (m, p, t) => net.rpcCall(cfg.runtimePort, m, p, t ?? 20_000) } : null;
}

async function ensureGodot(ctx, project) {
  const found = await godot.locateGodot({ root: ctx.root, home: ctx.home, dotnet: !!project?.dotnet, verify: true });
  if (found.found && found.version) await godot.rememberGodot(ctx.home, found.path, found.version).catch(() => {});
  return found;
}

// ---- operations ---------------------------------------------------------------

const OPS = {
  async health(input, ctx) {
    const { project, cfg } = await context(ctx);
    const diagnostics = [];
    if (!project) {
      return { ok: false, error: `no project.godot at ${ctx.root} — pass target_root pointing at a Godot project (or create one with mutate scene.new)`, diagnostics };
    }
    const found = await godot.locateGodot({ root: ctx.root, home: ctx.home, dotnet: project.dotnet, verify: input?.verify !== false });
    const addonInstalled = await godot.exists(path.join(ctx.root, "addons", "ares_bridge", "plugin.gd"));
    const editor = await net.rpcPing(cfg.bridgePort, 600);
    const game = await net.rpcPing(cfg.runtimePort, 400);
    if (!found.found) diagnostics.push(`Godot executable not found. ${found.hint}`);
    else if (found.version) await godot.rememberGodot(ctx.home, found.path, found.version).catch(() => {});
    if (!addonInstalled) diagnostics.push("Ares bridge addon not installed in this project — run `ares godot init <project>` for live editor control (offline .tscn editing and headless checks still work).");
    else if (!project.aresBridgeEnabled) diagnostics.push("Ares bridge addon present but not enabled in project.godot [editor_plugins]; `ares godot init` enables it.");
    if (addonInstalled && project.aresBridgeEnabled && !editor) diagnostics.push(`Editor bridge not reachable on 127.0.0.1:${cfg.bridgePort} — open the project in the Godot editor to enable live mode.`);
    if (project.dotnet) diagnostics.push("C# project: `check` runs `dotnet build`; a mono/.NET Godot build is preferred.");
    return {
      ok: true,
      result: {
        project: { name: project.name, mainScene: project.mainScene, engineVersion: project.engineVersion, dotnet: project.dotnet, renderer: project.renderer },
        godot: found.found ? { path: found.path, version: found.version, from: found.from, mono: found.mono } : null,
        bridge: { addonInstalled, enabled: project.aresBridgeEnabled, port: cfg.bridgePort, editorLive: !!editor, editorScene: editor?.scene ?? null, runtimeLive: !!game },
        mode: editor ? "live-editor" : game ? "live-game" : "offline",
      },
      diagnostics,
    };
  },

  async locate(input, ctx) {
    const { project, cfg } = await context(ctx);
    const found = await godot.locateGodot({ root: ctx.root, home: ctx.home, dotnet: !!project?.dotnet, verify: input?.verify !== false });
    if (found.found && found.version) await godot.rememberGodot(ctx.home, found.path, found.version).catch(() => {});
    return {
      ok: true,
      result: { ...found, config: cfg, project: project ? { name: project.name, mainScene: project.mainScene, engineVersion: project.engineVersion, dotnet: project.dotnet } : null, editorLive: !!(await net.rpcPing(cfg.bridgePort, 500)), runtimeLive: !!(await net.rpcPing(cfg.runtimePort, 400)) },
      diagnostics: found.found ? [] : [found.hint],
    };
  },

  async install(input, ctx) {
    const { project } = await context(ctx);
    const version = String(input.version ?? project?.engineVersion ?? "4.3");
    const mono = input.mono ?? !!project?.dotnet;
    const progress = [];
    if (!input.force) {
      const found = await godot.locateGodot({ root: ctx.root, home: ctx.home, dotnet: mono, verify: true });
      const wantMajorMinor = version.split(".").slice(0, 2).join(".");
      if (found.found && (!input.version || String(found.version ?? "").startsWith(wantMajorMinor)) && (!mono || found.mono)) {
        return { ok: true, result: { installed: false, already: true, path: found.path, version: found.version, from: found.from, note: "an engine is already available; pass force:true or version to fetch another" } };
      }
    }
    try {
      const r = await godot.installGodot({ home: ctx.home, version, mono, dir: input.dir, force: !!input.force, onProgress: (m) => progress.push(m) });
      const check = await godot.exec(r.path, ["--version"], { timeoutMs: 15_000 }).catch((e) => ({ stdout: "", stderr: String(e) }));
      const reported = (check.stdout + check.stderr).trim().split(/\r?\n/).find((l) => /^\d+\.\d+/.test(l)) ?? null;
      return { ok: true, result: { ...r, reportedVersion: reported, mono, license: "MIT (Godot Engine contributors); notice written beside the executable", progress: progress.slice(-3) }, diagnostics: reported ? [] : ["the executable did not report a version — it may be the wrong platform build"] };
    } catch (error) {
      return { ok: false, error: `install failed: ${String(error.message ?? error)}`, result: { version, mono, progress: progress.slice(-5) } };
    }
  },

  async inspect(input, ctx) {
    const what = String(input.what ?? "project");
    const { project, cfg } = await context(ctx);
    const live = input.live === false ? null : await bridge(cfg);
    const diagnostics = [];
    const sceneRes = input.scene ?? project?.mainScene ?? null;

    switch (what) {
      case "project": {
        if (!project) return { ok: false, error: `no project.godot at ${ctx.root}` };
        const assets = await godot.listAssets(ctx.root, { limit: 1500 });
        const counts = Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, v.length]));
        return {
          ok: true,
          result: {
            ...project,
            sections: undefined,
            counts,
            scenes: assets.scenes.slice(0, 80),
            scripts: assets.scripts.slice(0, 120),
            bridge: { port: cfg.bridgePort, editorLive: !!live, editorScene: live?.pong?.scene ?? null },
            aresConfig: cfg,
          },
        };
      }
      case "tree": {
        if (live) {
          try {
            const result = await live.call("scene.tree", { path: sceneRes ?? undefined, depth: input.depth ?? 12 });
            return { ok: true, result: { source: "editor", ...result } };
          } catch (error) {
            diagnostics.push(`editor bridge failed, falling back to file: ${String(error.message ?? error)}`);
          }
        }
        if (!sceneRes) return { ok: false, error: "no scene given and project has no main scene" };
        const file = godot.resToAbs(ctx.root, sceneRes);
        const text = await fs.readFile(file, "utf8").catch(() => null);
        if (text === null) return { ok: false, error: `scene file not found: ${file}` };
        const doc = tscn.parseTscn(text);
        return { ok: true, result: { source: "file", scene: sceneRes, file, ...tscn.summarizeTscn(doc, { withProps: input.props !== false }) }, diagnostics };
      }
      case "scene-file": {
        if (!sceneRes) return { ok: false, error: "scene required" };
        const file = godot.resToAbs(ctx.root, sceneRes);
        const text = await fs.readFile(file, "utf8");
        return { ok: true, result: { scene: sceneRes, file, text: text.length > 60_000 ? text.slice(0, 60_000) + "\n…(truncated)" : text } };
      }
      case "node": {
        if (!input.path) return { ok: false, error: "path required (node path relative to scene root)" };
        if (live) {
          if (sceneRes && live.pong.scene !== sceneRes && input.scene) await live.call("scene.open", { path: sceneRes });
          const result = await live.call("node.get", { path: input.path, props: input.props ?? [] });
          let signals;
          if (input.signals) signals = await live.call("signal.list", { path: input.path }).catch(() => null);
          return { ok: true, result: { source: "editor", ...result, signals: signals?.signals } };
        }
        if (!sceneRes) return { ok: false, error: "scene required when the editor is not live" };
        const doc = tscn.parseTscn(await fs.readFile(godot.resToAbs(ctx.root, sceneRes), "utf8"));
        const block = tscn.findNode(doc, input.path);
        if (!block) return { ok: false, error: `node not found in ${sceneRes}: ${input.path}` };
        const props = tscn.propsOf(block);
        return { ok: true, result: { source: "file", path: tscn.nodePath(block), type: block.attrs.type ?? "(instance)", instance: block.attrs.instance, props, connections: doc.connections.filter((c) => c.attrs.from === tscn.nodePath(block) || c.attrs.to === tscn.nodePath(block)).map((c) => c.attrs) } };
      }
      case "inputmap": {
        if (live) {
          const result = await live.call("input.list", {});
          return { ok: true, result: { source: "editor", ...result } };
        }
        const ini = godot.parseGodotIni(await fs.readFile(path.join(ctx.root, "project.godot"), "utf8"));
        const actions = {};
        for (const [name, raw] of Object.entries(ini.input ?? {})) {
          const keys = [...String(raw).matchAll(/"keycode":(\d+),"physical_keycode":(\d+)/g)].map((m) => keyName(Number(m[2]) || Number(m[1])));
          const buttons = [...String(raw).matchAll(/"button_index":(\d+)/g)].map((m) => `button${m[1]}`);
          actions[name] = [...keys, ...buttons];
        }
        return { ok: true, result: { source: "file", actions, builtin: "ui_accept ui_cancel ui_left ui_right ui_up ui_down ui_select ui_focus_next ui_focus_prev (always exist)" } };
      }
      case "scripts": {
        if (input.path) {
          const file = godot.resToAbs(ctx.root, input.path);
          const text = await fs.readFile(file, "utf8");
          return { ok: true, result: { path: input.path, file, lines: text.split(/\r?\n/).length, text: text.length > 80_000 ? text.slice(0, 80_000) + "\n…(truncated)" : text } };
        }
        const files = await godot.listScripts(ctx.root, { exts: ["gd", "cs", "gdshader"] });
        const list = [];
        for (const file of files) {
          const stat = await fs.stat(file);
          const head = (await fs.readFile(file, "utf8")).split(/\r?\n/);
          const ext = head.find((l) => /^(extends|class_name|public (partial )?class)/.test(l.trim())) ?? "";
          list.push({ path: godot.absToRes(ctx.root, file), bytes: stat.size, lines: head.length, declares: ext.trim().slice(0, 80) });
        }
        return { ok: true, result: { count: list.length, scripts: list } };
      }
      case "assets": {
        const assets = await godot.listAssets(ctx.root, { limit: input.limit ?? 800 });
        if (input.group) return { ok: true, result: { [input.group]: assets[input.group] ?? [] } };
        return { ok: true, result: assets };
      }
      case "signals": {
        if (live && input.path) {
          const result = await live.call("signal.list", { path: input.path });
          return { ok: true, result: { source: "editor", ...result } };
        }
        if (!sceneRes) return { ok: false, error: "scene required" };
        const doc = tscn.parseTscn(await fs.readFile(godot.resToAbs(ctx.root, sceneRes), "utf8"));
        return { ok: true, result: { source: "file", connections: doc.connections.map((c) => c.attrs) } };
      }
      case "class": {
        if (!input.class) return { ok: false, error: "class required" };
        if (live) {
          const result = await live.call("class.info", { class: input.class });
          return { ok: true, result: { source: "editor", ...result } };
        }
        return { ok: false, error: "class introspection needs the live editor; use the docs operation for the reference instead" };
      }
      case "selection": {
        if (!live) return { ok: false, error: "editor not live" };
        return { ok: true, result: await live.call("editor.selection", {}) };
      }
      case "find": {
        if (live) return { ok: true, result: { source: "editor", ...(await live.call("node.find", { pattern: input.pattern ?? "*", type: input.type ?? "" })) } };
        if (!sceneRes) return { ok: false, error: "scene required" };
        const doc = tscn.parseTscn(await fs.readFile(godot.resToAbs(ctx.root, sceneRes), "utf8"));
        const re = new RegExp("^" + String(input.pattern ?? "*").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
        const nodes = doc.nodes.filter((b) => re.test(String(b.attrs.name)) && (!input.type || b.attrs.type === input.type)).map((b) => ({ path: tscn.nodePath(b), type: b.attrs.type }));
        return { ok: true, result: { source: "file", nodes } };
      }
      default:
        return { ok: false, error: `unknown inspect target '${what}'. Use: project, tree, node, inputmap, scripts, assets, signals, class, selection, find, scene-file` };
    }
  },

  async mutate(input, ctx) {
    const ops = Array.isArray(input.ops) ? input.ops : input.op ? [input] : [];
    if (ops.length === 0) return { ok: false, error: "mutate requires ops: [{op: 'node.add', ...}, ...]" };
    const { project, cfg } = await context(ctx);
    const live = input.live === false ? null : await bridge(cfg);
    const diagnostics = [];
    const results = [];
    const touched = new Map(); // abs file -> beforeHash

    const track = async (file) => {
      if (!touched.has(file)) touched.set(file, await hashIfExists(file));
    };

    let sceneRes = input.scene ?? null;
    if (live) {
      // Live editor path — every op is one bridge call; the scene is saved at the end.
      if (sceneRes && live.pong.scene !== sceneRes) {
        await live.call("scene.open", { path: sceneRes });
      }
      const current = async () => (await live.call("ping", {})).scene;
      for (const op of ops) {
        const { op: name, ...params } = op;
        try {
          if (name === "scene.new") {
            const file = godot.resToAbs(ctx.root, params.path);
            await track(file);
            if (params.main) await track(path.join(ctx.root, "project.godot"));
            results.push({ op: name, ...(await live.call("scene.new", params)) });
            sceneRes = params.path;
            continue;
          }
          if (name === "script.create") {
            const file = godot.resToAbs(ctx.root, params.path);
            await track(file);
            results.push({ op: name, ...(await live.call("script.create", params)) });
            continue;
          }
          if (name === "project.set" || name === "input.add" || name === "input.remove") {
            await track(path.join(ctx.root, "project.godot"));
            results.push({ op: name, ...(await live.call(name, params)) });
            continue;
          }
          if (name === "scene.save_as") {
            await track(godot.resToAbs(ctx.root, params.path));
            results.push({ op: name, ...(await live.call(name, params)) });
            continue;
          }
          if (!LIVE_OPS.has(name)) throw new Error(`unknown op '${name}'`);
          results.push({ op: name, ...(await live.call(name, params)) });
        } catch (error) {
          results.push({ op: name, ok: false, error: String(error.message ?? error) });
          if (input.stopOnError !== false) break;
        }
      }
      const scene = await current().catch(() => sceneRes);
      if (scene && input.save !== false && ops.some((o) => !NON_SCENE_OPS.has(o.op))) {
        await track(godot.resToAbs(ctx.root, scene));
        try {
          await live.call("scene.save", {});
          results.push({ op: "scene.save", scene });
        } catch (error) {
          results.push({ op: "scene.save", ok: false, error: String(error.message ?? error) });
        }
      }
      const mutations = [];
      for (const [file, before] of touched) {
        const m = await mutationFor(file, before);
        if (m.afterHash !== before) mutations.push(m);
      }
      const failed = results.filter((r) => r.ok === false);
      return { ok: failed.length === 0, error: failed.length ? failed.map((f) => `${f.op}: ${f.error}`).join("; ") : undefined, result: { source: "editor", scene, results }, mutations, diagnostics };
    }

    // Offline path — edit files directly.
    diagnostics.push("editor not live: editing .tscn/.gd/project.godot on disk (open the project in Godot for live mode)");
    let doc = null;
    let sceneFile = null;
    const loadScene = async (res) => {
      sceneFile = godot.resToAbs(ctx.root, res);
      await track(sceneFile);
      const text = await fs.readFile(sceneFile, "utf8").catch(() => null);
      if (text === null) throw new Error(`scene not found: ${res}`);
      doc = tscn.parseTscn(text);
      sceneRes = res;
    };
    if (sceneRes) await loadScene(sceneRes);
    for (const op of ops) {
      const { op: name, ...p } = op;
      try {
        switch (name) {
          case "scene.new": {
            const res = String(p.path);
            sceneFile = godot.resToAbs(ctx.root, res);
            await track(sceneFile);
            doc = tscn.newScene(p.root_type ?? "Node3D", p.name ?? "Main", p.props ?? {});
            sceneRes = res;
            if (p.main) {
              const pg = path.join(ctx.root, "project.godot");
              await track(pg);
              await setProjectSetting(pg, "application", "run/main_scene", JSON.stringify(res));
            }
            results.push({ op: name, scene: res });
            break;
          }
          case "scene.open":
            await loadScene(String(p.path));
            results.push({ op: name, scene: sceneRes });
            break;
          case "scene.save":
            results.push({ op: name, scene: sceneRes });
            break;
          case "node.add": {
            if (!doc) throw new Error("no scene loaded (pass scene or use scene.new/scene.open first)");
            const r = tscn.addNode(doc, { parent: p.parent ?? ".", type: p.type ?? "Node", name: p.name, props: p.props ?? {}, script: p.script, groups: p.groups });
            results.push({ op: name, path: r.path, type: p.type });
            break;
          }
          case "scene.instance": {
            if (!doc) throw new Error("no scene loaded");
            const r = tscn.addNode(doc, { parent: p.parent ?? ".", type: String(p.scene), name: p.name, props: p.props ?? {} });
            results.push({ op: name, path: r.path, instance: p.scene });
            break;
          }
          case "node.set": {
            if (!doc) throw new Error("no scene loaded");
            const block = tscn.findNode(doc, p.path);
            if (!block) throw new Error(`node not found: ${p.path}`);
            tscn.setProps(doc, block, p.props ?? {});
            results.push({ op: name, path: tscn.nodePath(block), props: Object.keys(p.props ?? {}) });
            break;
          }
          case "node.remove": {
            if (!doc) throw new Error("no scene loaded");
            results.push({ op: name, removed: tscn.removeNode(doc, p.path) });
            break;
          }
          case "node.rename": {
            if (!doc) throw new Error("no scene loaded");
            results.push({ op: name, path: tscn.renameNode(doc, p.path, p.name) });
            break;
          }
          case "script.attach": {
            if (!doc) throw new Error("no scene loaded");
            results.push({ op: name, path: tscn.attachScript(doc, p.path, p.script), script: p.script });
            break;
          }
          case "script.create": {
            const file = godot.resToAbs(ctx.root, p.path);
            await track(file);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, String(p.content ?? ""), "utf8");
            results.push({ op: name, path: p.path, bytes: String(p.content ?? "").length });
            if (p.attach_to) {
              if (!doc) throw new Error("attach_to needs a loaded scene");
              tscn.attachScript(doc, p.attach_to, p.path);
              results.push({ op: "script.attach", path: p.attach_to, script: p.path });
            }
            break;
          }
          case "signal.connect": {
            if (!doc) throw new Error("no scene loaded");
            results.push({ op: name, added: tscn.connectSignal(doc, p) });
            break;
          }
          case "input.add": {
            const pg = path.join(ctx.root, "project.godot");
            await track(pg);
            await addInputAction(pg, p);
            results.push({ op: name, action: p.action });
            break;
          }
          case "input.remove": {
            const pg = path.join(ctx.root, "project.godot");
            await track(pg);
            await removeIniKey(pg, "input", String(p.action));
            results.push({ op: name, action: p.action });
            break;
          }
          case "project.set": {
            const pg = path.join(ctx.root, "project.godot");
            await track(pg);
            const [section, ...rest] = String(p.key).split("/");
            await setProjectSetting(pg, section, rest.join("/"), typeof p.value === "string" && !/^[A-Z]\w*\(/.test(p.value) ? JSON.stringify(p.value) : String(p.value));
            results.push({ op: name, key: p.key });
            break;
          }
          case "editor.play":
          case "editor.focus":
          case "editor.screenshot":
          case "node.call":
            throw new Error(`${name} needs the live editor`);
          default:
            throw new Error(`unknown op '${name}'`);
        }
      } catch (error) {
        results.push({ op: name, ok: false, error: String(error.message ?? error) });
        if (input.stopOnError !== false) break;
      }
    }
    if (doc && sceneFile && input.save !== false) {
      await fs.mkdir(path.dirname(sceneFile), { recursive: true });
      await fs.writeFile(sceneFile, tscn.serializeTscn(doc), "utf8");
    }
    const mutations = [];
    for (const [file, before] of touched) {
      const m = await mutationFor(file, before);
      if (m.afterHash !== before && m.afterHash !== null) mutations.push(m);
    }
    const failed = results.filter((r) => r.ok === false);
    return { ok: failed.length === 0, error: failed.length ? failed.map((f) => `${f.op}: ${f.error}`).join("; ") : undefined, result: { source: "file", scene: sceneRes, results, next: "run `check` (headless parse/boot) and then `run` with a screenshot to verify" }, mutations, diagnostics };
  },

  async check(input, ctx) {
    const { project } = await context(ctx);
    if (!project) return { ok: false, error: `no project.godot at ${ctx.root}` };
    const found = await ensureGodot(ctx, project);
    if (!found.found) return { ok: false, error: `Godot executable not found. ${found.hint}` };
    const diagnostics = [];
    const result = { godot: { path: found.path, version: found.version }, passed: true, scripts: null, boot: null, dotnet: null };
    if (project.dotnet && input.build !== false) {
      result.dotnet = await godot.dotnetBuild(ctx.root);
      if (!result.dotnet.ok) result.passed = false;
    }
    if (input.scripts !== false) {
      let files = Array.isArray(input.scripts) ? input.scripts.map((s) => godot.resToAbs(ctx.root, s)) : await godot.listScripts(ctx.root, { exts: ["gd"], limit: input.limit ?? 150 });
      files = files.filter((f) => !f.includes(`${path.sep}addons${path.sep}`) || input.includeAddons);
      const checks = await godot.checkScripts(found.path, ctx.root, files, { concurrency: input.concurrency ?? 4 });
      const failing = checks.filter((c) => !c.ok);
      result.scripts = { checked: checks.length, failing: failing.length, errors: failing.flatMap((c) => c.errors.map((e) => ({ ...e, file: e.file ?? c.file }))).slice(0, 60), warnings: checks.flatMap((c) => c.warnings).slice(0, 30) };
      if (failing.length) result.passed = false;
    }
    if (input.boot !== false) {
      const scene = input.scene ?? undefined;
      result.boot = await godot.bootCheck(found.path, ctx.root, { scene, frames: input.frames ?? 3, timeoutMs: input.timeoutMs ?? 90_000 });
      if (result.boot.errors.length || result.boot.timedOut) result.passed = false;
      if (result.boot.timedOut) diagnostics.push("boot check timed out — the main scene may block the main loop (infinite loop, awaiting input) or --quit-after is unsupported on this Godot version");
    }
    if (!result.passed) diagnostics.push("check FAILED — fix the listed errors before claiming the change works");
    return { ok: true, result, diagnostics };
  },

  async run(input, ctx) {
    const { project, cfg } = await context(ctx);
    if (!project) return { ok: false, error: `no project.godot at ${ctx.root}` };
    const diagnostics = [];
    const evidence = [];
    const shots = [];
    const stepResults = [];
    const asserts = [];
    const runId = stamp();
    const dir = shotsDir(ctx.root);
    await fs.mkdir(dir, { recursive: true });
    let shotIndex = 0;
    const takeShot = async (call, label) => {
      const file = path.join(dir, `${runId}-${String(++shotIndex).padStart(2, "0")}-${slug(label)}.png`);
      const r = await call("screenshot", { file }, 15_000);
      evidence.push(await screenshotEvidence(file));
      shots.push(file);
      return { file, width: r.width, height: r.height, frame: r.frame };
    };

    const steps = Array.isArray(input.steps) ? input.steps : [];
    let session = null;
    let call;
    let attached = false;
    const existing = input.attach === false ? null : await runtime(cfg);
    if (existing && (input.attach || steps.length)) {
      attached = true;
      call = existing.call;
      diagnostics.push(`attached to the already-running game on port ${cfg.runtimePort}`);
    } else {
      const found = await ensureGodot(ctx, project);
      if (!found.found) return { ok: false, error: `Godot executable not found. ${found.hint}` };
      const addon = await godot.exists(path.join(ctx.root, "addons", "ares_bridge", "ares_runtime.gd"));
      if (!addon || !project.aresBridgeEnabled) {
        return { ok: false, error: "the Ares bridge addon is not installed/enabled in this project, so the game cannot be driven. Run `ares godot init <project>` (or ensure addons/ares_bridge exists and is enabled) and retry." };
      }
      session = await godot.launchGame(found.path, ctx.root, {
        scene: input.scene,
        runtimePort: cfg.runtimePort,
        width: input.width ?? project.viewport.width,
        height: input.height ?? project.viewport.height,
        headless: !!input.headless,
        extraArgs: input.args ?? [],
        startupTimeoutMs: input.startupTimeoutMs ?? 45_000,
      });
      if (!session.ready) {
        const diag = godot.classifyOutput(session.output);
        await session.stop(500);
        return { ok: false, error: `game did not reach the Ares runtime within the startup window (exited=${session.exited}, code=${session.exitCode}). ${diag.errors[0]?.message ?? ""}`.trim(), result: { errors: diag.errors.slice(0, 20), tail: session.output.split(/\r?\n/).slice(-30) }, diagnostics };
      }
      call = session.call;
    }

    const deadline = Date.now() + (input.timeoutMs ?? 90_000);
    const settle = input.settleMs ?? 600;
    if (!attached && settle > 0) await net.sleep(settle);
    try {
      for (const step of steps) {
        if (Date.now() > deadline) {
          stepResults.push({ step, ok: false, error: "run timeout reached" });
          break;
        }
        if (session?.exited) {
          stepResults.push({ step, ok: false, error: `game exited (code ${session.exitCode}) before this step` });
          break;
        }
        try {
          stepResults.push({ step, ok: true, result: await runStep(step, call, takeShot, asserts) });
        } catch (error) {
          stepResults.push({ step, ok: false, error: String(error.message ?? error) });
          if (input.stopOnError) break;
        }
      }
      if (shots.length === 0) {
        try {
          stepResults.push({ step: { screenshot: "final" }, ok: true, result: await takeShot(call, "final") });
        } catch (error) {
          stepResults.push({ step: { screenshot: "final" }, ok: false, error: String(error.message ?? error) });
        }
      }
      if (input.stats !== false) {
        try {
          stepResults.push({ step: { stats: true }, ok: true, result: await call("stats", {}, 5000) });
        } catch {
          // optional
        }
      }
    } finally {
      if (session && !input.keepAlive) await session.stop();
      else if (session) {
        session.detach();
        diagnostics.push(`game left running (pid ${session.pid}) on runtime port ${cfg.runtimePort}; later run calls attach to it`);
      }
    }
    const diag = session ? godot.classifyOutput(session.output) : { errors: [], warnings: [], info: [] };
    const failedSteps = stepResults.filter((s) => !s.ok);
    const failedAsserts = asserts.filter((a) => !a.passed);
    if (diag.errors.length) diagnostics.push(`${diag.errors.length} runtime error(s) in engine output — see result.errors`);
    if (failedAsserts.length) diagnostics.push(`${failedAsserts.length} assertion(s) failed — see result.asserts`);
    if (shots.length === 0) return { ok: false, error: "no screenshot could be captured; the run cannot serve as visual evidence", result: { steps: stepResults, errors: diag.errors }, diagnostics };
    return {
      ok: true,
      result: {
        runId,
        mode: attached ? "attached" : "launched",
        scene: input.scene ?? project.mainScene,
        exitCode: session?.exitCode ?? null,
        durationMs: Date.now() - ctx.started,
        screenshots: shots,
        steps: stepResults,
        asserts: { passed: asserts.length - failedAsserts.length, failed: failedAsserts.length, list: asserts },
        errors: diag.errors.slice(0, 40),
        warnings: diag.warnings.slice(0, 20),
        healthy: diag.errors.length === 0 && failedSteps.length === 0 && failedAsserts.length === 0,
        logTail: session ? session.output.split(/\r?\n/).filter(Boolean).slice(-25) : [],
        next: "Read the screenshot files (Read tool shows PNGs) and compare against the intended result before reporting.",
      },
      evidence,
      diagnostics,
    };
  },

  async screenshot(input, ctx) {
    const { cfg } = await context(ctx);
    const dir = shotsDir(ctx.root);
    await fs.mkdir(dir, { recursive: true });
    const source = input.source ?? "auto";
    const file = path.join(dir, `${stamp()}-${slug(input.label ?? source)}.png`);
    const game = source === "editor" ? null : await runtime(cfg);
    if (game && source !== "editor") {
      const r = await game.call("screenshot", { file }, 15_000);
      return { ok: true, result: { source: "game", file, width: r.width, height: r.height, next: "Read the PNG to look at it" }, evidence: [await screenshotEvidence(file)] };
    }
    const editor = await bridge(cfg);
    if (!editor) return { ok: false, error: `neither the running game (port ${cfg.runtimePort}) nor the editor bridge (port ${cfg.bridgePort}) is reachable. Open the project in Godot, or use run with a screenshot step.` };
    if (input.focus) await editor.call("editor.focus", { path: input.focus }).catch(() => {});
    const r = await editor.call("editor.screenshot", { file, view: input.view ?? "3d", index: input.index ?? 0 }, 15_000);
    return { ok: true, result: { source: "editor", file, width: r.width, height: r.height, view: r.view, next: "Read the PNG to look at it" }, evidence: [await screenshotEvidence(file)] };
  },

  async asset(input, ctx) {
    const kind = String(input.kind ?? "box");
    const name = slug(input.name ?? kind).replace(/-/g, "_");
    const dirRes = String(input.dir ?? "res://assets/generated");
    const dir = godot.resToAbs(ctx.root, dirRes);
    await fs.mkdir(dir, { recursive: true });
    const mutations = [];
    const written = [];
    const write = async (file, content) => {
      const before = await hashIfExists(file);
      await fs.writeFile(file, content, "utf8");
      mutations.push(await mutationFor(file, before));
      written.push(godot.absToRes(ctx.root, file));
    };

    if (kind === "download") {
      if (!input.url) return { ok: false, error: "download needs url" };
      const { buffer, contentType } = await net.fetchBinary(String(input.url), { maxBytes: input.maxBytes ?? 200_000_000 });
      const fileName = input.file ?? decodeURIComponent(new URL(String(input.url)).pathname.split("/").pop() || "download.bin");
      const file = path.join(dir, fileName);
      const before = await hashIfExists(file);
      await fs.writeFile(file, buffer);
      mutations.push(await mutationFor(file, before));
      return { ok: true, result: { file, res: godot.absToRes(ctx.root, file), bytes: buffer.length, contentType, note: "Godot imports glb/gltf/obj/png on the next editor scan (or run `check` to trigger a headless import)." }, mutations };
    }

    if (kind === "terrain-script" || (kind === "terrain" && input.format === "gdscript")) {
      const file = path.join(dir, `${name}.gd`);
      await write(file, mesh.terrainGdscript(input.params ?? {}));
      return { ok: true, result: { kind: "terrain-script", files: written, how: `Add a MeshInstance3D, attach ${godot.absToRes(ctx.root, file)}; exports rebuild the mesh + trimesh collision live in the editor.` }, mutations };
    }

    let geometry = mesh.generate(kind, input.params ?? {});
    if (input.transform) geometry = mesh.transformMesh(geometry, input.transform);
    if (Array.isArray(input.parts)) {
      // composite: extra pieces merged in with their own transforms
      for (const part of input.parts) {
        let g = mesh.generate(part.kind, part.params ?? {});
        if (part.transform) g = mesh.transformMesh(g, part.transform);
        geometry.append(g);
      }
    }
    const suffix = input.collision === "trimesh" ? "-col" : input.collision === "convex" ? "-convcol" : input.collision === "only" ? "-colonly" : input.collision === "rigid" ? "-rigid" : "";
    const objName = `${name}${suffix}`;
    let mtlName = null;
    if (input.material) {
      mtlName = `${name}.mtl`;
      await write(path.join(dir, mtlName), mesh.toMtl(`${name}_mat`, input.material));
    }
    const obj = mesh.toObj(geometry, { name: objName, mtl: mtlName, material: mtlName ? `${name}_mat` : undefined });
    const file = path.join(dir, `${name}.obj`);
    await write(file, obj);
    const bounds = geometry.bounds();
    return {
      ok: true,
      result: {
        kind,
        files: written,
        triangles: geometry.triangleCount,
        bounds,
        objectName: objName,
        how: `In a scene: node.add type MeshInstance3D with props {"mesh": "${godot.absToRes(ctx.root, file)}"}${suffix ? "; the name suffix makes Godot generate collision when the OBJ is imported as a scene (instance it) — for a MeshInstance3D mesh, add a StaticBody3D + CollisionShape3D or call create_trimesh_collision()" : ""}. Units are metres, Y up.`,
      },
      mutations,
    };
  },

  async docs(input, ctx) {
    const home = ctx.home;
    if (input.class) {
      const classes = Array.isArray(input.class) ? input.class : [input.class];
      const out = [];
      for (const cls of classes.slice(0, 4)) {
        try {
          const doc = await net.fetchClassDoc(home, cls, { refresh: !!input.refresh });
          const text = input.section ? net.sectionOf(doc.text, input.section, { after: input.maxChars ?? 3000 }) : doc.text.slice(0, input.maxChars ?? 14_000);
          out.push({ class: cls, url: doc.url, cached: doc.cached, section: input.section ?? null, found: text !== null, text: text ?? `section '${input.section}' not found in ${cls}; headings: ${headings(doc.text).slice(0, 30).join(", ")}` });
        } catch (error) {
          out.push({ class: cls, error: String(error.message ?? error) });
        }
      }
      return { ok: true, result: { pages: out } };
    }
    if (input.page) {
      const doc = await net.fetchDocPage(home, input.page, { refresh: !!input.refresh });
      const text = input.section ? net.sectionOf(doc.text, input.section, { after: input.maxChars ?? 4000 }) : doc.text.slice(0, input.maxChars ?? 16_000);
      return { ok: true, result: { page: doc.slug, url: doc.url, cached: doc.cached, text } };
    }
    if (input.query) {
      const hits = await net.searchDocsCache(home, input.query, { limit: input.limit ?? 12 });
      return { ok: true, result: { query: input.query, hits, note: hits.length ? undefined : "nothing cached matches; fetch the relevant class first (docs {class}) or search the web (WebSearch) — tutorial slugs look like tutorials/physics/using_character_body_2d" } };
    }
    return { ok: false, error: "docs needs class (e.g. CharacterBody3D), page (tutorials/... slug), or query" };
  },

  async video(input, ctx) {
    const home = ctx.home;
    if (input.search) {
      const r = await net.youtubeSearch(home, String(input.search), { limit: input.limit ?? 12 });
      return { ok: true, result: { ...r, next: "pick a video and call video {url} to read its transcript; prefer channels like GDQuest, KidsCanCode, Godotneers, Bramwell, Brackeys" } };
    }
    const target = input.url ?? input.id;
    if (!target) return { ok: false, error: "video needs url/id (to watch) or search (to find)" };
    const r = await net.youtubeTranscript(home, String(target), { lang: input.lang ?? "en", refresh: !!input.refresh });
    if (!r.transcript) return { ok: true, result: r, diagnostics: [r.error ?? "no transcript"] };
    let transcript = r.transcript;
    if (input.from != null || input.to != null) {
      const lines = transcript.split("\n");
      const sec = (t) => {
        const parts = t.split(":").map(Number);
        return parts.reduce((a, b) => a * 60 + b, 0);
      };
      transcript = lines.filter((l) => {
        const m = l.match(/^\[([\d:]+)\]/);
        if (!m) return true;
        const s = sec(m[1]);
        return (input.from == null || s >= Number(input.from)) && (input.to == null || s <= Number(input.to));
      }).join("\n");
    }
    const max = input.maxChars ?? 24_000;
    return { ok: true, result: { ...r, transcript: transcript.length > max ? transcript.slice(0, max) + `\n…(truncated; ${transcript.length} chars total — use from/to seconds to page)` : transcript } };
  },

  async discover(input, ctx) {
    const home = ctx.home;
    const source = String(input.source ?? "all");
    const out = {};
    const diagnostics = [];
    if (source === "sources" || source === "all") out.sources = input.query ? net.LEARNING_SOURCES.filter((s) => `${s.name} ${s.bestFor}`.toLowerCase().includes(String(input.query).toLowerCase())) : net.LEARNING_SOURCES;
    if (source === "assetlib" || source === "all") {
      try {
        out.assetLibrary = await net.assetLibrarySearch(home, { query: input.query ?? "", godotVersion: input.godotVersion ?? "4.3", category: input.category, type: input.type === "project" ? "project" : "addon", maxResults: input.limit ?? 15, sort: input.sort ?? "rating" });
      } catch (error) {
        diagnostics.push(`asset library: ${String(error.message ?? error)}`);
      }
    }
    if (source === "polyhaven" || source === "all") {
      try {
        out.polyhaven = await net.polyhavenSearch(home, { query: input.query ?? "", type: input.polyType ?? input.type ?? "models", limit: input.limit ?? 15 });
      } catch (error) {
        diagnostics.push(`poly haven: ${String(error.message ?? error)}`);
      }
    }
    if (source === "polyhaven-files") {
      if (!input.id) return { ok: false, error: "polyhaven-files needs id" };
      out.files = await net.polyhavenFiles(home, String(input.id), { resolution: input.resolution ?? "1k" });
      out.next = "asset {kind: 'download', url: files.gltf.url, dir: 'res://assets/models/<name>'} — also download each files.gltf.include entry (bin + textures) into the same dir";
    }
    return { ok: true, result: out, diagnostics };
  },
};

const LIVE_OPS = new Set(["scene.open", "scene.save", "scene.reload", "scene.instance", "node.add", "node.remove", "node.set", "node.get", "node.call", "node.rename", "node.reparent", "node.find", "script.attach", "script.detach", "signal.connect", "signal.disconnect", "editor.play", "editor.stop", "editor.scan", "editor.focus", "editor.screenshot"]);
const NON_SCENE_OPS = new Set(["project.set", "input.add", "input.remove", "script.create", "editor.play", "editor.stop", "editor.scan", "editor.screenshot"]);

// ---- run steps --------------------------------------------------------------

async function runStep(step, call, takeShot, asserts) {
  if (typeof step === "string") step = parseStepString(step);
  if (step.wait != null) {
    await net.sleep(Number(step.wait));
    return { waited: Number(step.wait) };
  }
  if (step.press != null) return call("input.press", { actions: Array.isArray(step.press) ? step.press : [step.press], ms: step.ms ?? 120, strength: step.strength ?? 1 }, 5000);
  if (step.hold != null) {
    const r = await call("input.press", { actions: Array.isArray(step.hold) ? step.hold : [step.hold], ms: step.ms ?? 1000, strength: step.strength ?? 1 }, 5000);
    if (step.block !== false) await net.sleep(Number(step.ms ?? 1000) + 30);
    return r;
  }
  if (step.release != null) return call("input.release", { action: step.release }, 5000);
  if (step.key != null) return call("input.key", { key: step.key, ms: step.ms ?? 100 }, 5000);
  if (step.mouse != null) return call("input.mouse", step.mouse, 5000);
  if (step.axis != null) return call("input.axis", step.axis, 5000);
  if (step.screenshot != null) return takeShot(call, step.screenshot === true ? "shot" : String(step.screenshot));
  if (step.get != null) return call("node.get", { path: step.get, props: step.props ?? [] }, 8000);
  if (step.set != null) return call("node.set", { path: step.set, props: step.props ?? {} }, 8000);
  if (step.state != null) return call("physics.state", { path: step.state }, 8000);
  if (step.call != null) return call("node.call", step.call, 10_000);
  if (step.find != null) return call("node.find", typeof step.find === "string" ? { pattern: step.find } : step.find, 8000);
  if (step.tree != null) return call("scene.tree", { depth: step.depth ?? 6 }, 8000);
  if (step.stats) return call("stats", {}, 5000);
  if (step.scene != null) return call("scene.change", { path: step.scene }, 10_000);
  if (step.timeScale != null) return call("time.scale", { value: step.timeScale }, 5000);
  if (step.pause != null) return call("pause", { value: !!step.pause }, 5000);
  if (step.assert != null) {
    const a = step.assert;
    const state = await call("physics.state", { path: a.path }, 8000);
    const actual = readProp(state, a.prop);
    const passed = compare(actual, a.op ?? "==", a.value);
    const record = { path: a.path, prop: a.prop, op: a.op ?? "==", expected: a.value, actual, passed, label: a.label };
    asserts.push(record);
    return record;
  }
  throw new Error(`unknown step: ${JSON.stringify(step)}`);
}

function parseStepString(s) {
  const [verb, ...rest] = s.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (verb) {
    case "wait":
      return { wait: Number(arg || 500) };
    case "press":
      return { press: arg.split(/[+,]/), ms: 120 };
    case "hold": {
      const m = arg.match(/^(.+?)\s+(\d+)$/);
      return m ? { hold: m[1].split(/[+,]/), ms: Number(m[2]) } : { hold: arg.split(/[+,]/), ms: 1000 };
    }
    case "key":
      return { key: arg };
    case "shot":
    case "screenshot":
      return { screenshot: arg || "shot" };
    case "state":
      return { state: arg };
    case "stats":
      return { stats: true };
    default:
      throw new Error(`unknown step string '${s}' (wait N | press a+b | hold a N | key K | shot label | state path | stats)`);
  }
}

function readProp(state, prop) {
  const [name, comp] = String(prop).split(".");
  const raw = state[name];
  if (raw === undefined) return undefined;
  if (comp === undefined) return raw;
  const v = tscn.parseVariant(raw);
  if (!v) return undefined;
  const idx = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 }[comp];
  return idx === undefined ? undefined : v.values[idx];
}

function compare(actual, op, expected) {
  if (actual === undefined) return false;
  const a = typeof actual === "string" && /^-?\d/.test(actual) ? Number(actual) : actual;
  switch (op) {
    case ">":
      return a > expected;
    case ">=":
      return a >= expected;
    case "<":
      return a < expected;
    case "<=":
      return a <= expected;
    case "!=":
      return a !== expected;
    case "~=":
      return Math.abs(Number(a) - Number(expected)) <= 1e-3;
    case "truthy":
      return !!a;
    case "falsy":
      return !a;
    default:
      return a === expected;
  }
}

function headings(text) {
  return [...text.matchAll(/^#+ (.+)$/gm)].map((m) => m[1].trim());
}

// ---- project.godot editing (offline) ---------------------------------------

async function setProjectSetting(file, section, key, literal) {
  let text = await fs.readFile(file, "utf8").catch(() => "; Engine configuration file.\n; It's best edited using the editor UI and not directly,\n; since the parameters that go here are not all obvious.\n\nconfig_version=5\n");
  const lines = text.split(/\r?\n/);
  const header = `[${section}]`;
  let start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", header, "", `${key}=${literal}`);
    await fs.writeFile(file, lines.join("\n") + "\n", "utf8");
    return;
  }
  let end = lines.findIndex((l, i) => i > start && /^\[.+\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  const idx = lines.findIndex((l, i) => i > start && i < end && l.startsWith(`${key}=`));
  if (idx >= 0) {
    // remove multi-line continuation of the old value
    let j = idx + 1;
    while (j < end && !/^[\w/.]+=/.test(lines[j]) && lines[j].trim() !== "") j++;
    lines.splice(idx, j - idx, `${key}=${literal}`);
  } else {
    let insert = end;
    while (insert > start + 1 && lines[insert - 1].trim() === "") insert--;
    lines.splice(insert, 0, `${key}=${literal}`);
  }
  await fs.writeFile(file, lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n", "utf8");
}

async function removeIniKey(file, section, key) {
  const text = await fs.readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (start < 0) return;
  let end = lines.findIndex((l, i) => i > start && /^\[.+\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  const idx = lines.findIndex((l, i) => i > start && i < end && l.startsWith(`${key}=`));
  if (idx < 0) return;
  let j = idx + 1;
  while (j < end && !/^[\w/.]+=/.test(lines[j]) && lines[j].trim() !== "") j++;
  lines.splice(idx, j - idx);
  await fs.writeFile(file, lines.join("\n") + "\n", "utf8");
}

// Godot 4 Key enum values for the keys agents actually bind.
const KEYS = { ESCAPE: 4194305, TAB: 4194306, BACKSPACE: 4194308, ENTER: 4194309, KP_ENTER: 4194310, INSERT: 4194311, DELETE: 4194312, HOME: 4194317, END: 4194318, LEFT: 4194319, UP: 4194320, RIGHT: 4194321, DOWN: 4194322, PAGEUP: 4194323, PAGEDOWN: 4194324, SHIFT: 4194325, CTRL: 4194326, META: 4194327, ALT: 4194328, CAPSLOCK: 4194329, F1: 4194332, F2: 4194333, F3: 4194334, F4: 4194335, F5: 4194336, F6: 4194337, F7: 4194338, F8: 4194339, F9: 4194340, F10: 4194341, F11: 4194342, F12: 4194343, SPACE: 32 };

function keyCode(name) {
  const n = String(name).trim().toUpperCase().replace(/^KEY_/, "");
  if (KEYS[n] !== undefined) return KEYS[n];
  if (n.length === 1) return n.charCodeAt(0);
  if (/^KP_\d$/.test(n)) return 4194438 + Number(n.slice(3));
  throw new Error(`unknown key name '${name}' (use letters, digits, SPACE, SHIFT, CTRL, ALT, ESCAPE, ENTER, TAB, arrows, F1-F12)`);
}

function keyName(code) {
  for (const [k, v] of Object.entries(KEYS)) if (v === code) return k;
  if (code >= 32 && code < 127) return String.fromCharCode(code);
  return `key${code}`;
}

async function addInputAction(file, { action, keys = [], mouse_buttons = [], joy_buttons = [], deadzone = 0.5, physical = true }) {
  if (!action) throw new Error("input.add needs action");
  const events = [];
  for (const k of keys) {
    const code = keyCode(k);
    events.push(`Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":${physical ? 0 : code},"physical_keycode":${physical ? code : 0},"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)`);
  }
  for (const b of mouse_buttons) {
    events.push(`Object(InputEventMouseButton,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"button_mask":0,"position":Vector2(0, 0),"global_position":Vector2(0, 0),"factor":1.0,"button_index":${Number(b)},"canceled":false,"pressed":false,"double_click":false,"script":null)`);
  }
  for (const b of joy_buttons) {
    events.push(`Object(InputEventJoypadButton,"resource_local_to_scene":false,"resource_name":"","device":-1,"button_index":${Number(b)},"pressed":false,"pressure":0.0,"script":null)`);
  }
  const literal = `{\n"deadzone": ${Number(deadzone).toFixed(1)},\n"events": [${events.join(", ")}]\n}`;
  await setProjectSetting(file, "input", String(action), literal);
}

export { OPS, runStep, compare, readProp, keyCode, keyName, setProjectSetting, addInputAction };
