// Extracted from entry.ts — browserBridge.

import { projectPath, studioDir, studioVideo } from "./modelStudio.js";
import { copyFile } from "node:fs/promises";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { stdout } from "node:process";
import { approvedCheckout, buildTool, looksLikeOrderSubmission, pageShowsAmount, spendCheckoutApproval, type RichToolContext, type ToolDef } from "@ares/tools";
import { handleSite, registerStoppable } from "@ares/core";
import { getBrowserWatchHub, type BrowserWatch } from "../browserWatch.js";
import {
  SecretFingerprints,
  auditFill,
  describeHandleForApproval,
  fillSiteOf,
  performFillSecret,
  performLogin,
  redactDeep,
  savedLoginDomain,
} from "../browserSecrets.js";
import { z } from "zod";
import { loadUiSettings, type UiSettings } from "../uiSettings.js";
import { TrustGovernor } from "@ares/operator";
import { MemoryStore } from "@ares/mind";
import { Filmstrip, browserActionEffect, clickEffect, createPlaywrightBrowser, fillEffect, navigateEffect, challengePrompt, type BrowserConnector, type HumanCheckHandler } from "@ares/connectors";
import { Budget, KillSwitch, Ledger, ownerLeash, runEffect, type ApprovalDecision, type RailsContext, type BudgetLimits } from "@ares/effects";
import { CliRuntimeContext } from "./runtime.js";
import { drivableRoots, lastRescueFor, serveDevServer, serveLocalTarget, servedForUrl, waitForDrivablePage } from "./previewServer.js";
import { createServedPageBrowser } from "./servedPageBrowser.js";
import { claimForge, forgeCdpUrl, forgeViewUp, forgeWaitMs, isForgeStrategy } from "./forgeView.js";
import { FORGE_KIT_MARKER, buildStudioHtml, expandForgeKit, renderExplainer } from "./forgeKit.js";
import { FORGE_SCRIPT_DOCS } from "./forgeScriptDocs.js";
import { agentStudioId } from "./agentScope.js";
import { applyEdit, drainStudioLogs, ensureStudio, exportGame, saveStudio, studioId, studioSpec } from "./modelStudio.js";
import { BrowserBridgeServer, ExtensionBrowserConnector } from "@ares/browser-extension-connector";

// ── Embedded-browser bridge: the daemon ⇄ UI request/response channel that lets
// the agent drive Ares's OWN in-app browser (the same-origin iframe in the Forge).
// exec() emits a webview_cmd event to stdout (→ UI), and awaits the matching
// webview_result command the UI sends back. No Playwright — the page renders and
// runs IN the Ares window.
interface WebviewResult { ok: boolean; result?: unknown; error?: string; }

class EmbeddedBrowserBridge {
  private readonly pending = new Map<string, (r: WebviewResult) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;
  emit: ((obj: Record<string, unknown>) => void) | null = null;
  get attached(): boolean { return this.emit !== null; }
  exec(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<WebviewResult> {
    if (!this.emit) return Promise.resolve({ ok: false, error: "embedded browser unavailable — open the Ares desktop window" });
    const cmdId = `wv_${process.pid}_${++this.seq}`;
    return new Promise<WebviewResult>((resolve) => {
      this.pending.set(cmdId, resolve);
      this.timers.set(cmdId, setTimeout(() => {
        this.pending.delete(cmdId); this.timers.delete(cmdId);
        resolve({ ok: false, error: "embedded browser timed out" });
      }, timeoutMs));
      this.emit!({ type: "webview_cmd", cmdId, op, ...args });
    });
  }
  resolve(cmdId: string, payload: WebviewResult): void {
    const r = this.pending.get(cmdId);
    if (!r) return;
    const t = this.timers.get(cmdId);
    if (t) clearTimeout(t);
    this.pending.delete(cmdId); this.timers.delete(cmdId);
    r(payload);
  }
}

// ── Browser model: edit a persistent 3D model that the Forge shows live ──────
export async function runModelAction(
  i: z.infer<typeof browserInput>,
  br: BrowserConnector,
  d: { cwd: string; sessionId?: string; emitTarget: (state: { url?: string; title?: string }, mode?: "project" | "explain") => void; filmstripDir: string },
): Promise<BrowserResult> {
  if (i.help) return { output: { action: "model", status: "ok", result: { docs: FORGE_SCRIPT_DOCS }, filmstripDir: d.filmstripDir }, display: "studio scripts reference" };
  // Each desktop agent has its own studios (agentScope.agentStudioId).
  const id = agentStudioId(d.sessionId, studioId(i.model ?? i.title));
  const st = ensureStudio(id);
  let backdrop: string | undefined;
  if (i.backdrop !== undefined) {
    backdrop = "";
    if (i.backdrop) {
      let asUrl: URL | null = null;
      try { asUrl = new URL(i.backdrop); } catch { asUrl = null; }
      if (asUrl) {
        if (!/^https?:$/.test(asUrl.protocol) || !["127.0.0.1", "localhost"].includes(asUrl.hostname) || asUrl.username || asUrl.password) throw new Error("backdrop URL must be a plain http(s)://127.0.0.1 or localhost address");
        backdrop = asUrl.href;
      } else {
        const target = path.resolve(d.cwd, i.backdrop);
        if (target !== path.resolve(d.cwd) && !target.startsWith(path.resolve(d.cwd) + path.sep)) throw new Error("backdrop must be inside the project or a localhost URL");
        const hosted = await serveLocalTarget(target, { sessionId: d.sessionId });
        if (!hosted) throw new Error(`could not serve backdrop ${i.backdrop}`);
        backdrop = hosted.url;
      }
    }
  }
  const { touched, errors: edited } = await applyEdit(st, { backdrop, title: i.title, style: i.style, look: i.look, edge: i.edge, reset: i.reset, parts: i.parts, ops: i.ops, remove: i.remove, anims: i.anims, ref: i.ref, load: i.load, scripts: i.scripts, view: i.view }, d.cwd);
  // the quality bar rides separately from errors: it is not a failure, it is what to improve next
  const errors = edited.filter((e) => !e.startsWith("quality:")), quality = edited.filter((e) => e.startsWith("quality:")).map((e) => e.slice(9));
  let state = await br.state().catch(() => ({ url: "", title: "" } as { url?: string; title?: string }));
  const firstOpen = !st.url || !state.url || String(state.url).split("#")[0] !== st.url.split("#")[0];
  if (firstOpen) {
    const dir = studioDir(id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "index.html");
    await writeFile(file, buildStudioHtml(id, st.title || "Model studio"), "utf8");
    const hosted = await serveLocalTarget(file, { sessionId: d.sessionId });
    const url = (hosted ? hosted.url : pathToFileURL(file).href) + "?settled=1";
    st.url = url;
    await br.navigate(url);
    state = await br.state();
  }
  // every call: the Forge steps back to the studio page (a live stage from the streaming path never lingers)
  d.emitTarget(state, "explain");
  // wait for a page to pick the edit up, then let the morph finish
  const t0 = Date.now();
  while (st.seen < st.version && Date.now() - t0 < 7000) await new Promise((r) => setTimeout(r, 120));
  await new Promise((r) => setTimeout(r, 900));
  if ((studioSpec(st).scripts as unknown[]).length) await new Promise((r) => setTimeout(r, 400));
  const scriptLogs = drainStudioLogs(st);
  // views: "side", or "side@1.2" = from the side with the clip frozen at 1.2s (a deterministic pose: check the open lid, not a random moment)
  const wanted = (i.views && i.views.length ? i.views : ["3q"]).map((raw) => {
    const [n, at] = String(raw).split("@");
    const t = at !== undefined && Number.isFinite(Number(at)) ? Math.min(20, Math.max(0, Number(at))) : undefined;
    return { name: ["front", "back", "side", "top", "3q"].includes(String(n)) ? String(n) : "3q", t };
  }).slice(0, 4);
  const images: Array<{ mediaType: string; data: string }> = [];
  for (const v of wanted) {
    if (br.evaluate) await br.evaluate(`window.__aresView && window.__aresView(${JSON.stringify(v.name)}${v.t === undefined ? "" : `, ${v.t}`})`).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 450));
    const shot = await br.screenshot();
    images.push({ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes });
  }
  if (br.evaluate) await br.evaluate("window.__aresResume && window.__aresResume()").catch(() => undefined);
  let video: { file: string; bytes: number } | undefined;
  if (i.record && br.evaluate) {
    const before = studioVideo(id)?.at ?? 0, secs = Math.max(1, Math.min(30, i.record.seconds ?? 6));
    const started = await br.evaluate(`window.__aresRecord ? window.__aresRecord(${JSON.stringify(i.record)}) : "no recorder"`).catch((e) => String(e));
    const t1 = Date.now();
    while ((studioVideo(id)?.at ?? 0) <= before && Date.now() - t1 < (secs + 20) * 1000) await new Promise((r) => setTimeout(r, 250));
    const got = studioVideo(id);
    if (got && got.at > before) {
      const rel = i.record.file && i.record.file.endsWith(".webm") ? i.record.file : `assets/video/${id}.webm`;
      try { const dst = await projectPath(d.cwd, rel); await mkdir(path.dirname(dst), { recursive: true }); await copyFile(got.file, dst); video = { file: rel, bytes: got.bytes }; }
      catch (err) { errors.push(`record: ${err instanceof Error ? err.message : String(err)}`); }
    } else errors.push(`record: no video arrived (${String(started)}); the stage needs a WebGL canvas and MediaRecorder`);
  }
  let exported: { runtime: string; model: string; usage: string } | undefined;
  if (i.export) exported = await exportGame(st, d.cwd, { dir: typeof i.export === "string" ? i.export : undefined, three: i.three }).catch((err) => { errors.push(`export: ${err instanceof Error ? err.message : String(err)}`); return undefined; });
  let saved: string | undefined;
  if (i.save) saved = await saveStudio(st, d.cwd, i.save).catch((err) => { errors.push(`save: ${err instanceof Error ? err.message : String(err)}`); return undefined; });
  scriptLogs.push(...drainStudioLogs(st));
  const spec = studioSpec(st) as { parts: Array<{ name: string }>; anims: Array<{ name: string }> };
  return {
    output: {
      action: "model",
      status: errors.length ? "edited-with-warnings" : "ok",
      result: { model: id, version: st.version, parts: spec.parts.length, names: spec.parts.map((p) => p.name).slice(0, 80), anims: (studioSpec(st).anims as Array<{ name: string; dur: number; loop: boolean; tracks: unknown[]; motion: unknown[]; events: unknown[] }>).map((a) => ({ name: a.name, dur: a.dur, loop: a.loop, tracks: a.tracks.length, motion: a.motion.length, events: a.events.length })), changed: touched.slice(0, 40), ...(errors.length ? { problems: errors } : {}), ...(quality.length ? { quality } : {}), ...(scriptLogs.length ? { scriptLogs: scriptLogs.slice(-15) } : {}), ...(saved ? { saved } : {}), ...(exported ? { exported } : {}), ...(video ? { video } : {}), views: wanted.map((w) => (w.t === undefined ? w.name : `${w.name}@${w.t}`)) },
      filmstripDir: d.filmstripDir,
      ...(errors.length || quality.length ? { note: [errors.length ? `Warnings (the edit was applied except where a warning says otherwise): ${errors.join("; ")}` : "", quality.length ? `Below the quality bar - fold these into your next edit, unasked (no separate re-check pass): ${quality.join(" | ")}` : ""].filter(Boolean).join("\n") } : {}),
    },
    display: `model ${id}: ${touched.length} change${touched.length === 1 ? "" : "s"}, ${spec.parts.length} parts`,
    images,
  };
}

export const embeddedBridge = new EmbeddedBrowserBridge();

// One authenticated loopback server belongs to the daemon process. Browser
// tool instances are per conversation, but each can create its own lightweight
// tab connector over this shared transport.
let extensionBridge: BrowserBridgeServer | null = null;

export function setExtensionBrowserBridge(bridge: BrowserBridgeServer | null): void {
  extensionBridge = bridge;
}

/** Keyboard, pointer and wait fields shared by the tool and its act steps. */
const gestureFields = {
  keys: z.string().max(60).optional().describe("press: a key or combo — Enter, Escape, Tab, ArrowLeft, Space, w, Control+L, Shift+Tab."),
  holdMs: z.number().int().min(0).max(10_000).optional().describe("press: hold the key down this long (a game move: ArrowRight for 600 ms). click_at: hold the mouse button down this long (mine a block, charge a shot, long-press)."),
  repeat: z.number().int().min(1).max(50).optional().describe("press: press it this many times."),
  x: z.number().optional().describe("click_at/drag/scroll: viewport x in CSS pixels (from a screenshot of the page)."),
  y: z.number().optional().describe("click_at/drag/scroll: viewport y in CSS pixels."),
  toX: z.number().optional().describe("drag: where to release, x."),
  toY: z.number().optional().describe("drag: where to release, y."),
  dx: z.number().optional().describe("scroll: horizontal wheel delta."),
  dy: z.number().optional().describe("scroll: vertical wheel delta (positive = down)."),
  button: z.enum(["left", "right", "middle"]).optional().describe("click_at/drag: mouse button (default left)."),
  double: z.boolean().optional().describe("click_at: double-click."),
  text: z.string().max(200).optional().describe("wait: until the page shows this text."),
  gone: z.boolean().optional().describe("wait: until the text/selector is GONE instead (a spinner, a sign-in form)."),
  timeoutSec: z.number().min(1).max(300).optional().describe("wait: give up after this many seconds (default 60, max 300)."),
  ms: z.number().int().min(1).max(60_000).optional().describe("wait: just let the page run this many milliseconds (no text/selector/url) — e.g. let a game play out for 1000 ms. profile: how long to sample (default 3000)."),
};

const browserStep = z
  .object({
    action: z.enum(["open", "click", "click_text", "fill", "fill_selector", "eval", "press", "click_at", "drag", "scroll", "wait"]),
    ...gestureFields,
    url: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    value: z.string().optional(),
    query: z.string().optional(),
    selector: z.string().optional(),
    js: z.string().optional(),
  })
  .strict();

const browserInput = z
  .object({
    action: z
      .enum(["open", "act", "handshake", "tabs", "attach", "preview", "explain", "model", "tree", "screenshot", "fill", "fill_selector", "click", "click_text", "console", "eval", "state", "close", "filmstrip", "login", "fill_secret", "press", "click_at", "drag", "scroll", "wait", "network", "devtools", "profile"])
      .describe(
        "Browser action. DOM-first web actions: open/tree/fill/click/screenshot/state/close. " +
        "PREVIEW & VERIFY (drives a VISIBLE browser with an animated cursor so the owner watches Ares test the UI): " +
        "'preview' opens a URL visibly; 'click_text' clicks a button/link/tab by visible text or CSS selector; " +
        "'fill_selector' types into a CSS selector; 'console' reads console logs/errors after acting; " +
        "'eval' runs JS in the page to inspect state or call a function. " +
        "Use 'handshake' to attach ONLY to an already-open CDP-enabled Chrome/Edge without launching a replacement. " +
        "Use 'act' with steps for a complete multi-control job; it executes the sequence and returns one final visual verification instead of burning a model round-trip per click. " +
        "'login' signs in with the owner's SAVED login for the current https page (username + password from the vault — you never see them; the owner approves each fill). " +
        "'fill_secret' fills a secret handle (\"sec_…\", e.g. an emailed sign-in code another tool gave you) into one field by selector or label, after the owner approves. " +
        "HANDS: 'press' real keys (keys, holdMs, repeat — shortcuts, Enter, a game's ArrowRight held 600 ms); 'click_at' (holdMs = hold the button) / 'drag' / 'scroll' at exact viewport x,y from the screenshot (canvas, WebGL, maps — no DOM there). All of them (and 'wait') also work as act steps, so a whole play-through is ONE call. Real-time game in the Forge: eval `__aresFreeze(true)` once and the page stands still between your calls (your thinking costs no game time); the owner's own input releases it. " +
        "'wait' blocks until the page shows (or, gone:true, stops showing) text / selector / a url fragment — e.g. after asking the owner to sign in in the Forge. " +
        "'network' = devtools for the page: failed requests, HTTP errors, and every WebSocket (text vs BINARY frames, last frames, close code + reason). Use it first when anything online misbehaves. " +
        "'devtools' = the Console + Performance tabs in one call: uncaught errors WITH stack traces, console errors, failed requests, long tasks (>50 ms), fps and page metrics (JS heap, DOM nodes, layouts, listeners) — read it when a page is broken or slow, instead of guessing. " +
        "'profile' = a CPU profile over `ms` (default 3000): the hottest functions by file:line and their share of time, plus idle/GC — the answer to \"why does it stutter\".",
      ),
    ...gestureFields,
    url: z.string().optional().describe("URL for open/preview (e.g. http://localhost:1420)."),
    label: z.string().optional().describe("Accessible label for fill."),
    value: z.string().optional().describe("Value for fill / fill_selector."),
    role: z.string().optional().describe("ARIA role for click."),
    name: z.string().optional().describe("Accessible name for click."),
    query: z.string().optional().describe("Visible text or CSS selector for click_text."),
    selector: z.string().optional().describe("CSS selector for fill_selector."),
    js: z.string().optional().describe("JS expression/IIFE to run in the page for eval (e.g. 'document.querySelectorAll(\".item\").length')."),
    onlyErrors: z.boolean().optional().describe("console: return only errors/warnings."),
    engine: z.enum(["playwright", "embedded"]).optional().describe(
      "Which browser: 'playwright' (default) drives a streamed headless browser for ANY url (localhost dev servers, real web). " +
      "'embedded' renders self-contained HTML you pass via `html` INSIDE the Ares window (same-origin) and drives it directly — use this to test the apps/games/UIs YOU build as a single .html, with a real visible cursor and zero popup. " +
      "Embedded actions: preview(html) to load, then click_text/fill_selector/eval/console/screenshot(snapshot).",
    ),
    html: z.string().optional().describe("Self-contained HTML to render in the embedded browser (engine:'embedded', action:'preview')."),
    title: z.string().optional().describe("explain: the page title."),
    eyebrow: z.string().optional().describe("explain: small label above the title."),
    blocks: z.array(z.record(z.string(), z.unknown())).optional().describe("explain: ordered blocks, each {type, ...}: text{text} heading{text} cards{items:[{title,text}]} stats{items:[{label,value,note?,tone?}]} steps{items:[{title,text,state?:done|now}]} timeline{items:[{when,title,text}]} pills{items:[{text,tone?:ok|warn|bad}]} bars{items:[{label,value 0-100}]} callout{title,text,tone?} kv{items:[{key,value}]} table{columns,rows} code{text} chart{kind:bar|line|donut,labels,values} diagram{nodes:[{id,text}],links:[[a,b]]} scene3d{shape:cube|sphere|torus|pyramid|knot,color?,caption?,interactive?:true (drag to orbit),controls?:true|[{key:speed|scale,label,min,max,value,step}]} sim{kind:projectile|pendulum|orbit|plot,params?:[{key,label,min,max,value,step}],formula? (plot: x + param keys + Math fns, e.g. \"a*sin(b*x)\"),xmin?,xmax?,caption?} model{title?,style?:smooth|lowpoly|wire (lowpoly = faceted triangles; wire = + triangle wireframe),look?:studio|clay|slate|pastel|gallery|noir|holo,edge?:colour,parts:[{name,shape:sculpt{blobs} (creatures, see below)|joint (invisible bone)|box|sphere|cylinder|cone|pyramid|prism|torus|capsule|poly{detail?,jitter?} (faceted blob/rock)|loft{sections:[[x,y,z,rx,ry]..] (ordered cross-section rings along a spine: BEST for organic bodies, necks, heads, legs, tails; rx=0 closes a tip),seg?}|mesh{verts:[[x,y,z]..],faces:[[i,j,k(,l)]..],fcolors?:[colour per face]} (hand-placed triangles)|arch|stairs{steps?}|extrude{pts:[[x,y]..],depth,bevel?}|lathe{pts:[[radius,y]..]}|tube{pts:[[x,y,z]..],r,r2?},pos:[x,y,z],size:[x,y,z] (bbox),rot:[deg],color:#hex|name,color2?+grad?:x|y|z+mid?:0-1 (facet gradient: color at the low end → color2 at the high end; mid = where it switches),shade? (facet variation 0-.5),mat?:matte|clay|plastic|metal|glossy|glass|glow|holo,smooth?,mirror?:true (copy across x),repeat?:{n,step:[x,y,z]},stage?:label (blockout|form|detail|paint),parent?:part name,pivot?:[x,y,z] (joint to rotate about; default pos),scenery?:true (environment: ignored when framing the camera)}],anims?:[{name,dur,loop?,events?:[{t,name,data?}] (named moments scripts can react to),motion:[{part,kind:swing|wag|bob|spin|pulse|step|lift (gait: foot plants, then lifts),axis,amp,speed (Hz),phase,duty?}],tracks:[{part,ease?:smooth|linear|in|out|inout|back|elastic|bounce,rot?|pos?|scale?:[[t,[x,y,z]]..]}]}] (part \"leg*\" = prefix; mirrors follow)} = a coloured 3D model that BUILDS itself part by part while you write it (y up, origin on the ground; order = build order: big forms first, then details; 20-60 parts; viewer can orbit, click parts to recolour/move/resize, play anims, show the rig, export GLB / copy asset JSON). EVERY model (creatures AND props) = ONE sculpt part per object {shape:\"sculpt\",mat:fur|skin|leather|metal|wood|stone|cloth|clay,color,bone?:default joint,blobs:[{id,s:ball{at,r:[rx,ry,rz]}|stick{at,to,r,r2}|chain{pts:[[x,y,z,r]..]}|box{at,r,round}|cyl{at,to,r,round}|torus{at,r,r2},k (melt 0.004 hard .. 0.3 clay),color?,mat?,tex?:fur|scales|wrinkles|rock|wood|cloth|hammered|pores,paint?:true (colour/material only),sub?:true (carve),bone?,mirror?}]} - blobs melt into one smooth high-poly skin with real surface detail; 40-75 blobs for a creature; + {shape:\"joint\",pos:pivot,parent} rig (root>chest>head, limbs); eyes/claws as small parts with snap:\"body\". Never stack spheres/lofts. Always rig + animate unasked: idle + walk (motion kind step + lift: feet plant) + a signature action (tracks with ease). Browser model help:true has the method + a worked grizzly and sword. story{title?,scenes:[{t:\"753 BC\",say,bg?:day|dawn|dusk|night|desert|sea|storm|snow,do:[{op:spawn,sprite,n?,at?:[x,y],spread?:[w,h],scale?:1-4,color?,text?,id?}|{op:move,id,to:[x,y],dur?}|{op:fall|fade,id}|{op:tint,id,color}|{op:meter,id,label,value 0-100}|{op:clear}]}]} = a live animated 2D pixel story (world 160x90, ground y 66-86; sprites person soldier house temple column tower wall castle tree ship horse flag mountain sun moon cloud coin fire arrow pyramid scroll crown sword label{text}; ~6-10 scenes, 2-4 ops each). sim/scene3d-interactive = live sliders. \"interactive\"/\"simulate\" → sim; make/build/show a 3D model → model; explain history/process visually → story."),
    model: z.string().optional().describe("model: studio id (a short slug). One id = one persistent 3D model you keep editing."),
    parts: z.array(z.record(z.string(), z.unknown())).optional().describe("model: parts to add or replace by name. EVERYTHING (creatures, characters, props, weapons) is sculpted: one shape \"sculpt\" part per object whose blobs (ball/stick/chain/box/cyl/torus, k = melt radius, paint, sub = carve, per-blob mat + tex surface detail, bone, mirror, id) melt into one smooth high-poly mesh, + shape \"joint\" parts (the rig the blobs' bones name), + eyes/claws with snap:\"<sculpt>\" (out, align) so they sit ON the skin; edit one blob with ops blob. Ship it painted, rigged and animated (idle, walk with step+lift, an action) without being asked. Realistic vehicles/characters/props: a real downloaded model as {shape:\"gltf\", src:\"assets/models/x.glb\", height} (Poly Pizza, Kenney, Quaternius, Sketchfab CC0) beats sculpting; machines that ARE sculpted get hard:true (sharp edges). Read help:true first - the method, a worked grizzly and car. Part fields: name, shape (sculpt|joint|box|sphere|cylinder|cone|pyramid|prism|torus|capsule|poly|mesh|loft|arch|stairs|extrude|lathe|tube), pos [x,y,z], size [x,y,z], rot [deg], color, color2+grad+mid, mat, texture {kind:planks|bricks|noise|checker|stripes|dots, colors:[#hex..], scale, repeat:[x,y], pixel, seed} (survives export, no script), smooth, pivot [x,y,z] (joint it rotates about), parent (part name it follows), mirror, repeat {n,step}, plus shape data (pts, sections, verts+faces, depth...). Unknown fields come back as warnings."),
    ops: z.array(z.record(z.string(), z.unknown())).optional().describe("model: ordered edits {op:set,name|\"leg*\",<any part field>,move?:[dx,dy,dz],scale?:n,to?:newName} {op:remove,name} {op:add,parts} {op:use,file,names?,at?,scale?,prefix?,anims?:true|[names],scripts?:[names],parts?:false} (pull parts, clips and scripts from a saved .model.json; at moves a copy, prefix renames parts AND the clips that target them) {op:anim,anim} {op:remove_anim,name} {op:variant,name,set:{\"lid*\":{color,color2,mat,texture}}} (a colourway: one model + clips, many looks; show with view:{variant}; the game picks per instance with instance({variant})) {op:remove_variant,name} {op:blob,name:<sculpt>,id,<blob fields>|remove:true} (patch/add/remove ONE blob of a sculpt by id)."),
    remove: z.array(z.string()).optional().describe("model: part names to delete (\"leg*\" = prefix)."),
    anims: z.array(z.record(z.string(), z.unknown())).optional().describe("model: animation clips to add or replace by name. A clip: {name, dur, loop?, tracks:[{part, ease?:smooth|linear|in|out|inout|back|elastic|bounce, rot|pos|scale:[[t,[x,y,z]],...]}] (rot in degrees about the part's pivot, values are DELTAS from rest), motion:[{part,kind:swing|wag|bob|spin|pulse|step|lift,axis,amp,speed,phase,duty?}] (walks: step on upper limbs + lift on lower limbs = planted feet), events:[{t,name,data?}]}. Hinged lid: {name:\"open\",dur:1,loop:false,tracks:[{part:\"lid\",rot:[[0,[0,0,0]],[0.9,[-105,0,0]]]}]} (give the lid a pivot at its hinge and parent:\"base\"). part \"leg*\" = prefix. Clips that drive nothing come back as warnings."),
    style: z.string().optional().describe("model: smooth|lowpoly|wire."),
    look: z.string().optional().describe("model: studio|clay|slate|pastel|gallery|noir|holo|sunset|night|flat."),
    edge: z.string().optional().describe("model: wire/edge colour."),
    reset: z.boolean().optional().describe("model: clear the model first."),
    ref: z.string().optional().describe("model: a reference picture (png/jpg/webp ≤2MB, project path or data: URL) shown beside the model, so you and the owner compare."),
    save: z.union([z.boolean(), z.string()]).optional().describe("model: write the model (parts, clips, scripts) to a project file: true = assets/models/<id>.model.json, or a path ending .model.json. Reload with load; reuse parts or scripts with ops use."),
    load: z.string().optional().describe("model: load a saved .model.json into this studio."),
    backdrop: z.string().optional().describe("model: a project page (html path, or a localhost URL) shown BEHIND the model, so you build the asset inside the actual game and see how it sits in it. \"\" removes it."),
    scripts: z.array(z.record(z.string(), z.unknown())).optional().describe("model: [{name, code}] JS the studio runs every frame - YOUR way to make anything the engine has no feature for (water, lava, rain, wind, fire, physics, particles, deforming a mesh). code defines function init(api){…} (may be async), update(api){…}, cleanup(api){…}. api: THREE, scene, camera, renderer, time, dt, state (yours), part(name)→{group,mesh,geometry,node,spec}, parts(), add(obj3d)/remove(obj3d) (auto-cleaned), on(event,fn)/emit(event,data) (events: clip events, \"click\" {point:[x,y,z],part}), lib(name) (async; physics: \"cannon-es\",\"rapier\"), rand(), noise(x,y,z), log(msg). Errors come back to you in the tool result (problems/scriptLogs) - read them and fix."),
    export: z.union([z.boolean(), z.string()]).optional().describe("model: GAME INTEGRATION. Writes ares-model.js (a standalone three.js runtime) + models/<id>.game.json into the project (dir = the string, default assets/). The game then does loadModel(url).instance(), play(clip), update(dt). Same geometry, materials, joints and animation as the Forge. See help."),
    three: z.string().optional().describe("model export: how the game imports three: \"three\" (import map, default), an https URL, or a relative path."),
    view: z.record(z.string(), z.unknown()).optional().describe("model: how the studio shows it: {wire?:bool (wireframe), smooth?:bool (smooth vs faceted shading), spin?:bool (turntable), rig?:bool (bones/joints), camera?:3q|front|back|side|top, anim?:clip name, play?:bool, speed?:0.1-3}. The screen is a bare viewport; YOU do wireframe/spin/rig/camera/playback when the owner asks, in words. Also variant:name, zoom:0.3-3, t:seconds (freeze a clip at that moment to check a pose), fit:\"anim\" (frame the whole clip so nothing is cropped)."),
    record: z.object({
      seconds: z.number().optional().describe("length, 1-30 (default 6)."),
      clip: z.string().optional().describe("animation clip to play while recording."),
      orbit: z.boolean().optional().describe("camera circles the model (default true); false = the current view."),
      turns: z.number().optional().describe("orbit turns over the recording (default 1)."),
      size: z.array(z.number()).optional().describe("[width,height] pixels (default the stage size; 1280x720, 1920x1080, 1080x1920 for vertical)."),
      file: z.string().optional().describe("project path to save to (default assets/video/<model>.webm)."),
    }).optional().describe("model: RECORD A VIDEO of this stage (the model, its clip, its scripts: water, particles, a scene): the canvas is captured in the browser and saved as a .webm in the project. No external service. Turntables, animation reels, trailers, shots for a game page."),
    help: z.boolean().optional().describe("model: return the studio reference and edit nothing: SCULPTING creatures/characters (the method + a worked, rigged bear), parts/clips, scripts with worked patterns (procedural textures, live water, control panels, physics), game export. Read it before your first creature or script."),
    views: z.array(z.string()).optional().describe("model: angles to screenshot after the edit: 3q (default), front, back, side, top; \"side@1.2\" freezes the clip at 1.2s for a deterministic pose (check the OPEN lid). Look at them, then edit again."),
    headless: z.boolean().optional().describe("Run headless (invisible). DEFAULT true. 'preview' is ALWAYS headless (the value is ignored): the owner watches in the Forge, which shows the page you preview. For other actions pass false ONLY when the owner explicitly asks to watch a real browser window."),
    note: z.string().optional().describe("Optional note attached to screenshot frames."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum tree/filmstrip/console entries returned."),
    steps: z.array(browserStep).min(1).max(24).optional().describe("act: ordered DOM-first actions to execute as one transaction, followed by one screenshot and page-state verification."),
    allowRepeat: z.boolean().optional().describe("Permit an intentional repeat of a recently committed click/act. Default false prevents accidental duplicate sends/submits."),
    domain: z.string().optional().describe("login: the site whose saved login to use (default: the current page's domain)."),
    username_selector: z.string().optional().describe("login: CSS selector of the username/email field when the default guess misses."),
    password_selector: z.string().optional().describe("login: CSS selector of the password field (default input[type=password])."),
    submit: z.boolean().optional().describe("login / fill_secret: submit the form after filling."),
    handle: z.string().optional().describe("fill_secret: the secret handle (sec_…) to fill. Never a raw value."),
  })
  .strict();

const READ_ONLY_BROWSER_ACTIONS = new Set([
  "explain",
  "open",
  "handshake",
  "tabs",
  "attach",
  "preview",
  "tree",
  "screenshot",
  "console",
  "state",
  "filmstrip",
]);

type BrowserResult = { output: BrowserToolOutput; display: string; images?: Array<{ mediaType: string; data: string }> };

interface BrowserToolOutput {
  action: string;
  status: string;
  result?: unknown;
  /** The owner took over this browser and handed it back since Ares last looked. */
  ownerTookOver?: boolean;
  /** CDP attachment or Ares-owned launch strategy, when Playwright exposes it. */
  browserStrategy?: string;
  /** Loud warning when a rails-gated action did NOT commit (staged/denied). */
  note?: string;
  filmstripDir: string;
}

export function makeBrowserTool(
  context: CliRuntimeContext,
  createBrowser: typeof createPlaywrightBrowser = createPlaywrightBrowser,
) {
  let browser: BrowserConnector | null = null;
  let filmstrip: Filmstrip | null = null;
  let sequence = 0;
  const recentOutwardActions = new Map<string, number>();
  // Set per-call to the current turn's progress emitter, so the persistent
  // browser streams its live frames into THIS turn's UI panel.
  let frameSink: ((jpegBase64: string) => void) | null = null;
  // Set while Ares works in a served page the owner has open (page driver):
  // later calls keep acting there until an open goes somewhere else.
  let pageRoot: string | null = null;
  // Set per-call to the current turn's permission prompt, so the PERSISTENT
  // browser's challenge handler (bound once at creation) reaches THIS turn's
  // approval card instead of only the garrison gateway.
  let promptApprover: RailsContext["requestApproval"] | null = null;
  // The owner's stop-all closes the browser Ares is driving (ownerControl.ts
  // in core): a kill switch that leaves a checkout tab mid-click is not one.
  // Registered for the tool's lifetime; stop() reports false when no browser
  // is open so the owner's count stays honest. The next Browser call simply
  // opens a fresh one.
  registerStoppable({
    kind: "browser",
    id: `browser:${context.home}`,
    label: "Ares browser",
    persistent: true,
    stop: async () => {
      const open = browser;
      if (!open) return false;
      browser = null;
      await open.close().catch(() => undefined);
      return true;
    },
  });

  // ── watch / take over, vault fills, checkout guard ──
  // The owner's live view of THIS browser (null without a garrison origin).
  let watch: BrowserWatch | null = null;
  let watchedBrowser: BrowserConnector | null = null;
  // Progress for the current call, redacted (set per call like frameSink).
  let progressSink: ((data: Record<string, unknown>) => void) | null = null;
  // Fingerprints of every secret filled into this browser — never the values.
  const prints = new SecretFingerprints();
  // toolUseId → the page a fill was approved for (checkPermissions → call).
  const approvedFills = new Map<string, { origin: string; domain?: string }>();
  // Per-call flags (the tool is exclusive, so one call at a time).
  let callState: { handbackNote?: string; forgeNote?: string; orderSubmission?: boolean; release?: () => void } = {};

  const endWatch = () => {
    if (!watch) return;
    const ended = watch;
    watch = null;
    watchedBrowser = null;
    if (ended.ended) return;
    ended.end();
    progressSink?.({ kind: "browser_live", sessionId: ended.sessionId, url: ended.url, label: ended.label, state: "ended" });
  };

  /** Once per browser session: mint the watch link and tell the phone. */
  const announceWatch = (br: BrowserConnector, i: { url?: string }, ctx: RichToolContext) => {
    if (watch && watchedBrowser === br && !watch.ended) return;
    if (watch) endWatch();
    const hub = getBrowserWatchHub();
    if (!hub || !br.livePage) return;
    const label = watchLabel(i.url, br.livePage());
    const opened = hub.open({ page: () => br.livePage?.(), label, conversationId: ctx.sessionId });
    if (!opened) return;
    watch = opened;
    watchedBrowser = br;
    callState.release = opened.agentBegin();
    progressSink?.({ kind: "browser_live", sessionId: opened.sessionId, url: opened.url, label, state: "active" });
  };

  /**
   * Single controller: while the owner drives, wait (bounded, abortable, off
   * the watchdog clock). A handback — waited for now or happened between
   * calls — always reaches the agent as a re-read notice, and a mutating
   * action queued behind it is NOT run against a page the agent hasn't seen.
   */
  const holdForOwner = async (i: { action: string }, ctx: RichToolContext): Promise<BrowserResult | null> => {
    const current = watch;
    if (!current || current.ended) return null;
    let note: string | undefined;
    if (current.controller === "owner") {
      const release = ctx.pauseWatchdog?.();
      try {
        const waited = await current.waitForControl({
          signal: ctx.signal,
          timeoutMs: takeoverWaitMs(),
          onWaiting: () => progressSink?.({ kind: "browser_control", sessionId: current.sessionId, controller: "owner", url: current.url }),
        });
        if (waited.waited && waited.outcome === "timeout") {
          return {
            output: {
              action: i.action,
              status: "owner_has_control",
              note: `ACTION NOT PERFORMED — the owner took over this browser and hasn't handed it back after ${Math.round(takeoverWaitMs() / 60_000)} minutes. Tell them you're waiting for "Hand back to Ares" (or ask what they want); don't work around it.`,
              filmstripDir: "",
            },
            display: "waiting for the owner to hand the browser back",
          };
        }
        if (waited.waited && waited.outcome === "handed_back") note = waited.notice?.note;
        progressSink?.({ kind: "browser_control", sessionId: current.sessionId, controller: "ares", url: current.url });
      } finally {
        release?.();
      }
    }
    note ??= current.takeNotice()?.note;
    if (note) {
      const text = `The owner took over and handed back. ${note}`;
      if (!OBSERVE_ONLY_ACTIONS.has(i.action)) {
        return {
          output: { action: i.action, status: "owner_handed_back", ownerTookOver: true, note: `ACTION NOT PERFORMED — ${text}`, filmstripDir: "" },
          display: "the owner took over and handed back — re-reading first",
        };
      }
      callState.handbackNote = text;
    }
    if (!current.ended) callState.release = current.agentBegin();
    return null;
  };

  /** A click that places an order needs an approved, unspent Checkout review whose total is still on the page. */
  const checkoutGuard = async (br: BrowserConnector, i: z.infer<typeof browserInput>, ctx: RichToolContext): Promise<BrowserResult | null> => {
    const targets =
      i.action === "click" ? [i.name] :
      i.action === "click_text" ? [i.query] :
      i.action === "act" ? (i.steps ?? []).filter((s) => s.action === "click" || s.action === "click_text").map((s) => s.name ?? s.query) :
      [];
    const submitting = targets.find((t) => looksLikeOrderSubmission(t));
    if (!submitting) return null;
    const refuse = (status: string, note: string): BrowserResult => ({
      output: { action: i.action, status, note, filmstripDir: "" },
      display: status === "checkout_review_required" ? "order not placed — needs a Checkout review first" : "order not placed — the total changed",
    });
    const approval = approvedCheckout(ctx.sessionId);
    if (!approval) {
      return refuse(
        "checkout_review_required",
        `ACTION NOT PERFORMED — "${submitting}" would place an order. First call Checkout {action:"review"} with the real cart and the exact total read from this page (merchant, items, fees, tax, tip, total, payment method). Once the owner approves, repeat this click.`,
      );
    }
    if (approval.amount !== null && br.evaluate) {
      const text = String(await br.evaluate("document.body ? document.body.innerText : ''").catch(() => ""));
      if (text && !pageShowsAmount(text, approval.amount)) {
        return refuse(
          "checkout_total_mismatch",
          `ACTION NOT PERFORMED — the owner approved ${approval.total} at ${approval.merchant}, but this page no longer shows that total. Read the cart again and call Checkout review with what the page shows now.`,
        );
      }
    }
    callState.orderSubmission = true;
    return null;
  };

  const currentFillSite = async () => {
    if (!browser) return fillSiteOf("");
    const state = await browser.state().catch(() => ({ url: "" }));
    return fillSiteOf(state.url);
  };

  /** login / fill_secret: fills a secret the model never sees, on the page the owner approved. */
  const fillFromVault = async (br: BrowserConnector, i: z.infer<typeof browserInput>, ctx: RichToolContext): Promise<BrowserResult> => {
    const approved = approvedFills.get(ctx.toolUseId ?? "");
    approvedFills.delete(ctx.toolUseId ?? "");
    const site = fillSiteOf((await br.state()).url);
    if ("error" in site) throw new Error(site.error);
    // The approval named an exact origin. A redirect or a click since then
    // means the owner approved a different page: fail closed.
    if (!approved || approved.origin !== site.origin) {
      throw new Error(`not filled — the page is now ${site.origin}, not the ${approved?.origin ?? "(unapproved)"} the owner approved. Call ${i.action} again on the right page.`);
    }
    if (i.action === "login") {
      const domain = approved.domain ?? (await savedLoginDomain(site.host, { domain: i.domain, home: context.home }));
      if (!domain) throw new Error(`no saved login for ${site.host} — call Connect with service "login:${handleSite(site.host)}"`);
      const outcome = await performLogin(br, {
        domain,
        home: context.home,
        ...(i.username_selector ? { usernameSelector: i.username_selector } : {}),
        ...(i.password_selector ? { passwordSelector: i.password_selector } : {}),
        submit: i.submit === true,
        prints,
      });
      auditFill({ home: context.home, sessionId: ctx.sessionId, action: "browser.login", target: site.origin, params: { domain, fields: outcome.filled, submit: i.submit === true }, result: `filled ${outcome.filled.join(" + ")}${outcome.submitted ? ", submitted" : ""}` });
      const state = await br.state().catch(() => ({ url: site.origin }));
      return {
        output: { action: i.action, status: "filled", result: { domain, filled: outcome.filled, submitted: outcome.submitted, state }, filmstripDir: "" },
        display: `filled the saved ${domain} ${outcome.filled.join(" and ")}${outcome.submitted ? " and signed in" : ""}`,
      };
    }
    if (!i.handle) throw new Error("fill_secret needs handle (sec_…)");
    const outcome = await performFillSecret(br, { handle: i.handle, host: site.host, selector: i.selector, label: i.label, submit: i.submit === true, prints });
    auditFill({ home: context.home, sessionId: ctx.sessionId, action: "browser.fill_secret", target: site.origin, params: { site: outcome.site, purpose: outcome.purpose, field: i.selector ?? i.label }, result: outcome.submitted ? "filled, submitted" : "filled" });
    const state = await br.state().catch(() => ({ url: site.origin }));
    return {
      output: { action: i.action, status: "filled", result: { site: outcome.site, purpose: outcome.purpose, submitted: outcome.submitted, state }, filmstripDir: "" },
      display: `filled the ${outcome.purpose} for ${outcome.site}`,
    };
  };

  const ensureBrowser = async (headless?: boolean, attachOnly = false, cdpUrl?: string): Promise<BrowserConnector> => {
    if (browser?.strategy === "extension:native-messaging" && !extensionBridge?.connected()) {
      await browser.close().catch(() => undefined);
      browser = null;
    }
    if (browser) {
      try {
        await browser.state();
      } catch (error) {
        // Users routinely close the visible preview window. Retaining that dead
        // connector made every subsequent action fail with "Target page,
        // context or browser has been closed". Re-acquire transparently on the
        // next call; unrelated state errors still surface honestly.
        if (!isClosedBrowserError(error)) throw error;
        await browser.close().catch(() => undefined);
        browser = null;
      }
      if (browser && attachOnly && !browser.strategy?.startsWith("cdp:")) {
        await browser.close().catch(() => undefined);
        browser = null;
      }
    }
    if (!browser && extensionBridge?.connected() && attachOnly) {
      browser = new ExtensionBrowserConnector(extensionBridge);
    }
    if (!browser) {
      // CAPTCHA handoff: a challenge surfaces through the SAME Gate as approvals
      // (so it renders on Telegram/UI). The owner solves it in their CDP-attached
      // Chrome and approves → "solved"; deny → "skip". The approver is resolved
      // at FIRE time: garrison gateway first, else the current turn's permission
      // card (promptApprover). Neither wired (plain CLI) → challenges are
      // detected but navigation just proceeds, as before.
      const onChallenge: HumanCheckHandler = async (info) => {
        const requestApproval = context.approvals?.requestApproval ?? promptApprover;
        if (!requestApproval) return "solved";
        const decision = await requestApproval({
          id: `captcha:${info.url}`.slice(0, 200),
          kind: "human-check",
          domain: "browser",
          irreversibility: "reversible",
          reason: challengePrompt(info),
        });
        return decision.verb === "deny" ? "skip" : "solved";
      };
      browser = await createBrowser({
        headless: headless ?? true,
        attachOnly,
        cdpUrl,
        onChallenge,
        // The Forge view IS the live page the owner sees: never stream frames of it.
        ...(cdpUrl && cdpUrl === forgeCdpUrl() ? {} : { onFrame: (jpeg: string) => frameSink?.(jpeg) }),
        // In the Forge the owner watches Ares work in their own panel: a
        // visible but quick glide, not a slow demo (ARES_BROWSER_PACE_MS wins).
        paceMs: Number(process.env.ARES_BROWSER_PACE_MS) || (cdpUrl && cdpUrl === forgeCdpUrl() ? 160 : 480),
      });
    }
    return browser;
  };

  const ensureFilmstrip = (): Filmstrip => {
    if (!filmstrip) {
      const dir = path.join(context.browserFilmstripRoot, `${new Date().toISOString().slice(0, 10)}-${process.pid}`);
      filmstrip = new Filmstrip(dir);
    }
    return filmstrip;
  };

  const def: ToolDef<typeof browserInput, BrowserToolOutput> = {
    name: "Browser",
    description:
      "Ares's DOM-first eyes and hands for the web — the ONLY tool for anything inside a web page. It drives CDP/Playwright input without touching the owner's OS mouse. Before opening a duplicate page it reuses a matching attached tab; use tabs/attach when the owner names an already-open tab. For multi-field or multi-click work use one act call with ordered steps, then inspect its final screenshot; do not spend one model call per click. Use APIs/MCP/CLI first when better. ComputerUse is forbidden for browser content. On the desktop app the Forge is a REAL browser and this tool drives that very page: every site loads there (nothing refuses it), the owner watches, clicks and signs in there, and logins persist — so show the owner a page by opening its real link, never with a screenshot, a local copy or \"I can't open it\". A sign-in only the owner can do: open the page and ask them to sign in in the Forge, then carry on. Elsewhere (CLI, phone, Telegram) it runs a background browser. Screenshots in results are YOUR eyes (accessibility text alone cannot verify canvas/WebGL), not something to hand the owner. Self-contained HTML must inline JS/CSS because offline webviews block CDN scripts. NEVER verify time-dependent behaviour (timers, countdowns, intervals, animations, anything \"every N seconds/minutes\") by sleeping and re-checking — real-time waiting cannot prove a minute-scale rule and burns the turn. Instead drive the logic directly with eval: call the page's own update/tick/randomise function N times in a loop and collect the results, or stub the clock (override Date.now/performance.now, or call the interval callback yourself) and assert on the returned values. One eval that exercises 60 ticks proves more than ten screenshots taken a minute apart.",
    safety: "workspace-write",
    dynamicSafety: (i) => (READ_ONLY_BROWSER_ACTIONS.has(i.action) || (i.action === "model" && !i.save && !i.load && !i.export)) ? "read-only" : "external-state",
    concurrency: "exclusive",
    inputZod: browserInput,
    // login / fill_secret ask the owner afresh every time, naming the exact
    // page — even in YOLO, and never answered by an "always" grant.
    ownerDecisions: true,
    async checkPermissions(i, ctx) {
      if (i.action !== "login" && i.action !== "fill_secret") return { kind: "allow" };
      const site = await currentFillSite();
      if ("error" in site) return { kind: "deny", reason: site.error };
      if (i.action === "login") {
        const domain = await savedLoginDomain(site.host, { domain: i.domain, home: context.home });
        if (!domain) {
          const wanted = handleSite(i.domain ?? site.host);
          return { kind: "deny", reason: `No saved login for ${wanted}. Call Connect {action:"connect", service:"login:${wanted}"} — the owner saves it in a secure form — then call Browser login again. Never ask for the password in chat.` };
        }
        approvedFills.set(ctx.toolUseId ?? "", { origin: site.origin, domain });
        return { kind: "ask", ownerDecision: true, suggestion: "allow_once", prompt: `Fill your saved ${domain} username and password on ${site.where}${i.submit ? " and sign in" : ""}?` };
      }
      const info = describeHandleForApproval(i.handle ?? "");
      if (!info) return { kind: "deny", reason: "That secret handle is unknown or expired — get a fresh one. Never ask for the value in chat." };
      const bound = site.host === info.site || site.host.endsWith(`.${info.site}`);
      if (!bound) return { kind: "deny", reason: `That ${info.purpose} is for ${info.site}; this page is ${site.host}. Refusing to fill it here.` };
      approvedFills.set(ctx.toolUseId ?? "", { origin: site.origin });
      return { kind: "ask", ownerDecision: true, suggestion: "allow_once", prompt: `Fill your ${info.site} ${info.purpose} on ${site.where}?` };
    },
    activityDescription: (i) => {
      // Label honestly: opening a local file or driving the in-app page is NOT
      // "Browsing the web" — that wording made users think Ares went to the
      // internet instead of opening their file (bug report 4c5f1efc).
      const embedded = i.engine === "embedded" || (!i.url && !!i.html);
      const target = (u?: string) => {
        if (!u) return embedded ? "your page in the Ares window" : "a page";
        try {
          const parsed = new URL(u.includes("://") ? u : `https://${u}`);
          if (parsed.protocol === "file:")
            return `local file ${decodeURIComponent(parsed.pathname.split("/").pop() ?? "")}`.trim();
          if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return `local app ${parsed.host}`;
          return parsed.host.replace(/^www\./, "") || u;
        } catch {
          return u;
        }
      };
      if (i.action === "open") return `Opening ${target(i.url)}`;
      if (i.action === "act") return `Completing ${i.steps?.length ?? 0} browser actions`;
      if (i.action === "handshake") return "Attaching to an already-open browser";
      if (i.action === "tabs") return "Listing controllable browser tabs";
      if (i.action === "attach") return `Attaching to ${i.query ?? i.url ?? "an open tab"}`;
      if (i.action === "preview") return `Previewing ${target(i.url)}`;
      if (i.action === "tree") return "Reading the page";
      if (i.action === "screenshot" || i.action === "filmstrip") return embedded ? "Reading the in-app page" : "Capturing the screen";
      if (i.action === "fill") return i.label ? `Filling “${i.label}”` : "Filling a field";
      if (i.action === "fill_selector") return i.selector ? `Typing into ${i.selector}` : "Filling a field";
      if (i.action === "click") return i.name ? `Clicking “${i.name}”` : "Clicking a control";
      if (i.action === "click_text") return i.query ? `Clicking “${i.query}”` : "Clicking a control";
      if (i.action === "console") return "Reading the console";
      if (i.action === "devtools") return "Reading devtools";
      if (i.action === "profile") return "Profiling the page";
      if (i.action === "eval") return "Testing in the page";
      if (i.action === "state") return "Checking the page state";
      if (i.action === "close") return "Closing the browser";
      if (i.action === "login") return "Signing in with your saved login";
      if (i.action === "fill_secret") return "Filling a secret field";
      return embedded ? "Using the in-app browser" : "Browsing the web";
    },

    async call(input, ctx): Promise<{ output: BrowserToolOutput; display: string; images?: Array<{ mediaType: string; data: string }> }> {
      // explain: ~500 tokens of blocks → a finished kit page, previewed in the Forge
      // A lone gesture (press / click_at / drag / scroll / wait) is a one-step
      // act: same rails, same final screenshot + state, one code path.
      const gesture = (["press", "click_at", "drag", "scroll", "wait"] as const).find((g) => g === input.action);
      const i = input.action === "explain"
        ? { ...input, action: "preview" as const, html: renderExplainer(input), url: undefined, engine: undefined }
        : gesture
          ? {
              ...input,
              action: "act" as const,
              steps: [{
                action: gesture,
                ...Object.fromEntries((["keys", "holdMs", "repeat", "x", "y", "toX", "toY", "dx", "dy", "button", "double", "text", "gone", "timeoutSec", "ms", "selector", "url"] as const)
                  .filter((k) => input[k] !== undefined).map((k) => [k, input[k]])),
              }] as z.infer<typeof browserStep>[],
            }
          : input;
      const strip = ensureFilmstrip();
      // mode: "explain" when the page is a Forge-kit explainer Ares generated
      // (the Forge goes warm and bursts), "project" for a real app or site.
      // driven: Ares already navigated the Forge view itself, so the Forge only
      // shows it (navigating it again would cancel Ares's own load).
      const emitTarget = (state: { url?: string; title?: string }, mode: "project" | "explain" = "project") => {
        if (state.url) ctx?.emitProgress?.({ kind: "browser_target", url: state.url, title: state.title ?? "", mode, ...(isForgeStrategy(browser?.strategy, forgeCdpUrl()) ? { driven: true } : {}) });
      };
      // Route the browser's live frames into THIS turn's UI panel (the embedded
      // browser the owner watches). Cleared when the call ends.
      // ~8 fps is plenty to watch Ares work; an animating page would otherwise
      // push a full JPEG per repaint into the UI.
      let lastFrameAt = 0;
      frameSink = ctx?.emitProgress
        ? (jpeg) => {
            const now = Date.now();
            if (now - lastFrameAt < 120) return;
            lastFrameAt = now;
            ctx.emitProgress?.({ kind: "browser_frame", image: jpeg } as Record<string, unknown>);
          }
        : null;
      // This turn's approval surface for staged effects and challenge handoffs —
      // the engine permission card, same transport as every gated tool.
      const requestPermission = ctx?.requestPermission;
      promptApprover = requestPermission
        ? async (staged): Promise<ApprovalDecision> => {
            const verb = await requestPermission({
              toolName: "Browser",
              input: { kind: staged.kind, domain: staged.domain, irreversibility: staged.irreversibility },
              reason: `${staged.kind} — ${staged.reason}`,
            });
            return { id: staged.id, verb, at: new Date().toISOString(), approver: "owner" };
          }
        : null;

      // ── EMBEDDED ENGINE — drive Ares's own in-app browser (same-origin HTML) ──
      if (i.engine === "embedded") {
        const done = (status: string, result: unknown, display: string) =>
          ({ output: { action: i.action, status, result, filmstripDir: filmstripDir(strip) } as BrowserToolOutput, display });
        const snap = async () => (await embeddedBridge.exec("snapshot")).result;
        if (i.action === "preview" || i.action === "open") {
          if (!i.html) throw new Error("embedded preview requires `html` (the self-contained page to render)");
          const r = await embeddedBridge.exec("load", { html: expandForgeKit(i.html), explainer: FORGE_KIT_MARKER.test(i.html) });
          if (!r.ok) throw new Error(r.error ?? "embedded load failed");
          return done("ok", await snap(), "rendered in the embedded browser");
        }
        if (i.action === "click" || i.action === "click_text") {
          const r = await embeddedBridge.exec("click", { query: i.query ?? i.name ?? "" });
          if (!r.ok) throw new Error((r.result as { error?: string })?.error ?? r.error ?? "click failed");
          return done("ok", { click: r.result, page: await snap() }, `clicked "${i.query ?? i.name}"`);
        }
        if (i.action === "fill" || i.action === "fill_selector") {
          const r = await embeddedBridge.exec("type", { selector: i.selector ?? i.label ?? "", value: i.value ?? "" });
          if (!r.ok) throw new Error((r.result as { error?: string })?.error ?? r.error ?? "fill failed");
          return done("ok", r.result, `typed into ${i.selector ?? i.label}`);
        }
        if (i.action === "eval") {
          if (!i.js) throw new Error("eval requires js");
          const r = await embeddedBridge.exec("eval", { js: i.js });
          return done(r.ok ? "ok" : "error", r.result, "eval");
        }
        if (i.action === "console") {
          const r = await embeddedBridge.exec("console", { onlyErrors: i.onlyErrors });
          if (!r.ok) throw new Error(r.error ?? "embedded console failed");
          const logs = (r.result as unknown[]) ?? [];
          return done("ok", logs, `${logs.length} console entr${logs.length === 1 ? "y" : "ies"}`);
        }
        // tree / screenshot / state / snapshot → the page's DOM-text snapshot.
        const r = await embeddedBridge.exec("snapshot");
        // A dead bridge used to fall through as status:"ok" with an undefined
        // result in ~1ms — the model then "verified" pages it never saw.
        if (!r.ok) throw new Error(r.error ?? "embedded snapshot failed");
        if (i.action === "screenshot") {
          // The embedded engine has NO pixel capture. Never dress a DOM-text
          // dump up as a screenshot: canvas/WebGL/chart content is invisible in
          // text, so "status ok" here let models claim charts rendered when all
          // four canvases were blank (bug f0bbee26). Degrade loudly instead.
          return done(
            "degraded",
            {
              warning:
                "TEXT SNAPSHOT ONLY — the embedded engine cannot capture pixels. Canvas/WebGL/chart content is INVISIBLE here; do NOT claim anything rendered correctly based on this. To actually see the page, use action:'preview' with the playwright engine (pass the html or a file url) — that returns a real screenshot.",
              snapshot: r.result,
            },
            "text snapshot only — no pixels (use playwright preview to SEE the page)",
          );
        }
        return done("ok", r.result, "snapshot");
      }

      if (i.action === "filmstrip") {
        const result = (await strip.load()).slice(-(i.limit ?? 20));
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: `filmstrip ${result.length} frame(s)`,
        };
      }

      if (i.action === "close") {
        endWatch();
        if (browser) await browser.close();
        browser = null;
        return {
          output: { action: i.action, status: "closed", filmstripDir: filmstripDir(strip) },
          display: "browser closed",
        };
      }

      // Handshake is attach-only: it must never pretend success by quietly
      // launching a different, unauthenticated browser profile.
      // tabs/attach/handshake prefer the paired extension so Ares can take over
      // a real logged-in tab without launching another profile. Once attached,
      // the connector remains selected for subsequent act/click/fill calls.
      const extensionAttach = extensionBridge?.connected() && ["handshake", "tabs", "attach"].includes(i.action);
      // preview used to FORCE a visible browser window "so the owner can watch".
      // The owner watches in the Forge (the Live tab embeds the served page or
      // streams the filmstrip); a second Edge window popping over the desktop
      // read as "wtf it opened a browser" (2026-10-15). Headless unless asked.
      // preview is ALWAYS headless, whatever the model passes: small models
      // kept sending headless:false out of habit and a second Edge window
      // popped over the desktop every time. The Forge toolbar's "Open separate
      // copy" is the owner's way to a real window.
      // On the desktop, every page Ares works on is the Forge's native view —
      // the real page the owner sees, never a background copy streamed as
      // frames (forgeView.ts). The first call wakes the view (the Forge opens
      // a blank page) and waits for it; only if it never comes up does this
      // fall back to the background browser, and the result says so.
      const forge = forgeCdpUrl();
      let forgeNote: string | undefined;
      let onForge = false;
      // Local pages FIRST, on every build: a file, a page Ares serves, or the
      // project's dev server opens in the Forge as a served page and is driven
      // in place (the page driver) — the path proven live, with no native view
      // in the loop. The native view is for real websites only. (2026-10-21: a
      // friend's game never loaded because the desktop's native view sat
      // hidden; the served page needs none of that machinery.)
      const openUrl = (i.action === "open" || i.action === "preview") ? i.url : i.action === "act" && i.steps?.[0]?.action === "open" ? i.steps[0].url : undefined;
      const localOpen = openUrl !== undefined && (isLoopbackUrl(openUrl) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(openUrl));
      const continuingServed = openUrl === undefined && !!pageRoot?.startsWith("page:") && !NOT_PAGE_DRIVEN.has(i.action);
      // The served page has no DevTools protocol; waking the native view here
      // would answer about a blank page instead.
      if (openUrl === undefined && pageRoot?.startsWith("page:") && (i.action === "devtools" || i.action === "profile" || i.action === "network")) {
        throw new Error(`${i.action} is not available for this page (it runs in the Forge as a served page, driven in place). Use console, eval and screenshot here; the Forge sensor already reports its errors and frame rate to you.`);
      }
      let pageBr: BrowserConnector | null = null;
      if ((localOpen || continuingServed) && !extensionAttach) {
        pageBr = await servedPageFor(i, ctx, emitTarget, pageRoot, context.workspace);
      }
      if (!pageBr && openUrl !== undefined) pageRoot = null; // a website open leaves the served page behind
      if (pageBr) { /* the served page is the browser; the Forge view is not touched */ }
      else if (forge && !extensionAttach && i.action !== "handshake" && !claimForge(ctx?.sessionId ?? "")) {
        if (isForgeStrategy(browser?.strategy, forge)) { await browser!.close().catch(() => undefined); browser = null; }
        forgeNote = "The Forge is in use by another chat right now, so this ran in Ares's background browser — the owner cannot see or use this page.";
      } else if (forge && !extensionAttach && i.action !== "handshake") {
        if (isForgeStrategy(browser?.strategy, forge)) onForge = true;
        else {
          if (!(await forgeViewUp(forge, 300))) {
            ctx?.emitProgress?.({ kind: "browser_target", url: "about:blank", title: "", mode: "project", driven: true });
          }
          if (await forgeViewUp(forge, forgeWaitMs())) {
            if (browser) await browser.close().catch(() => undefined);
            browser = null;
            onForge = true;
          } else {
            forgeNote = "The Forge view did not come up (is the Ares window open?), so this ran in Ares's background browser — the owner cannot see or use this page.";
          }
        }
      }
      // No native Forge view (the browser preview / dev): a local page is
      // shown in the Forge and Ares drives THAT copy through its page driver
      // — never a hidden browser streamed as screenshots.
      if (!pageBr && !onForge && !forge && !extensionAttach) pageBr = await servedPageFor(i, ctx, emitTarget, pageRoot, context.workspace);
      // A new page takes over; a refused one leaves the current page in place.
      if (pageBr && (i.action === "open" || i.action === "preview" || (i.action === "act" && i.steps?.[0]?.action === "open"))) pageRoot = pageBr.strategy ?? null;
      // Never a hidden browser (owner, 2026-10-20: "none should use the hidden
      // browser ever"): Ares works only where the owner can see it — the
      // Forge's native view, a served page open in the Forge, or the owner's
      // own Chrome (extension / handshake). ARES_HIDDEN_BROWSER=1 is for a
      // screenless server; test doubles of the launcher are unaffected.
      if (!pageBr && !onForge && !extensionAttach && i.action !== "handshake" && createBrowser === createPlaywrightBrowser && process.env.ARES_HIDDEN_BROWSER !== "1") {
        // A local address with nothing behind it is not a "no Forge" problem:
        // say what is wrong and what fixes it, so the agent fixes it itself.
        const wanted = (i.action === "open" || i.action === "preview") ? i.url : i.action === "act" && i.steps?.[0]?.action === "open" ? i.steps[0].url : undefined;
        const local = wanted ? (() => { try { const u = new URL(wanted); return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) && u.port ? u : null; } catch { return null; } })() : null;
        if (local) {
          throw new Error(`Nothing is running at ${local.origin}. Start the project's dev server in the background (find its folder yourself), wait until it listens, then open ${local.href} again — it shows in the Forge.`);
        }
        throw new Error(
          forge
            ? forgeNote?.startsWith("The Forge is in use")
              ? "Another chat is using the Forge right now. Ares never browses in a hidden browser — wait for that chat to finish, or tell the owner."
              : "The Forge view did not come up (is the Ares window open with the Forge showing?). Ares never browses in a hidden browser — tell the owner."
            : "There is no Forge here to show this website in: local pages, files and your own dev servers (http://127.0.0.1:<port>) open in the Forge in any build; other websites need the Ares desktop app's Forge. Do NOT open it another way — no Start-Process, no browser of your own, no installing Playwright: tell the owner in one line and carry on with the rest.",
        );
      }
      const br = pageBr
        ? pageBr
        : onForge
        ? await ensureBrowser(true, true, forge)
        : await ensureBrowser(i.action === "preview" ? true : i.headless, i.action === "handshake" || !!extensionAttach, i.url);
      if (forgeNote) callState.forgeNote = forgeNote;
      announceWatch(br, i, ctx);
      if (i.action === "model") return runModelAction(i, br, { cwd: context.workspace, sessionId: ctx?.sessionId, emitTarget, filmstripDir: filmstripDir(strip) });
      if (i.action === "login" || i.action === "fill_secret") return fillFromVault(br, i, ctx);
      const orderRefusal = await checkoutGuard(br, i, ctx);
      if (orderRefusal) return orderRefusal;

      if (i.action === "handshake") {
        if (!br.strategy?.startsWith("cdp:") && br.strategy !== "extension:native-messaging") {
          throw new Error("browser handshake did not attach to an owner-visible browser");
        }
        const tabs = br.tabs ? await br.tabs() : [];
        if (br.strategy === "extension:native-messaging") {
          if (!tabs.length || !br.attachToExisting || !(await br.attachToExisting(""))) {
            throw new Error("the extension is paired but no controllable web tab is open");
          }
        }
        const state = await br.state();
        emitTarget(state);
        return {
          output: {
            action: i.action,
            status: "attached",
            browserStrategy: br.strategy,
            result: { state, tabs, handshake: "owner-visible browser bridge accepted" },
            filmstripDir: filmstripDir(strip),
          },
          display: `attached to the open browser via ${br.strategy} (${tabs.length} tab${tabs.length === 1 ? "" : "s"})`,
        };
      }

      if (i.action === "tabs") {
        if (!br.tabs) throw new Error("tab discovery is not supported by this browser connector");
        const result = await br.tabs();
        return {
          output: { action: i.action, status: "ok", result, browserStrategy: br.strategy, filmstripDir: filmstripDir(strip) },
          display: `${result.length} controllable tab(s) via ${br.strategy ?? br.name}`,
        };
      }

      if (i.action === "attach") {
        const query = i.query ?? i.url;
        if (!query) throw new Error("Browser attach requires query or url");
        if (!br.attachToExisting || !(await br.attachToExisting(query))) throw new Error(`no controllable open tab matched "${query}"`);
        const result = await br.state();
        emitTarget(result);
        return {
          output: { action: i.action, status: "ok", result, browserStrategy: br.strategy, filmstripDir: filmstripDir(strip) },
          display: `attached to ${result.title ?? result.url} via ${br.strategy ?? br.name}`,
        };
      }

      if (i.action === "network") {
        if (!br.network) throw new Error("network is not supported by this browser connector");
        const report = await br.network({ limit: i.limit ?? 20 });
        const binary = report.sockets.filter((sk) => sk.binary > 0);
        const abnormal = report.sockets.filter((sk) => sk.close && sk.close.code !== 1000 && sk.close.code !== 1001);
        const hints = [
          ...binary.map((sk) => `${sk.url}: ${sk.binary} BINARY frame(s) — a page that does JSON.parse(ev.data) gets a Blob and fails silently; send text (JSON.stringify) on both ends.`),
          ...abnormal.map((sk) => `${sk.url}: closed ${sk.close!.code}${sk.close!.reason ? ` "${sk.close!.reason}"` : ""} — that code is the cause; fix what it names before anything else.`),
          ...report.sockets.filter((sk) => sk.open && sk.sent > 0 && sk.received === 0).map((sk) => `${sk.url}: sent ${sk.sent}, received nothing — the other side or the relay isn't answering.`),
        ];
        const display = `network: ${report.failed.length} failed, ${report.httpErrors.length} HTTP errors, ${report.sockets.length} socket(s)${hints.length ? ` — ${hints.length} problem(s)` : ""}`;
        return {
          output: { action: i.action, status: "ok", result: report, ...(hints.length ? { note: hints.join(" ") } : {}), filmstripDir: filmstripDir(strip) },
          display,
        };
      }

      if (i.action === "act") {
        if (!i.steps?.length) throw new Error("Browser act requires steps");
        const initial = await br.state();
        const hasClick = i.steps.some((step) => step.action === "click" || step.action === "click_text");
        const intendedUrl = i.steps.find((step) => step.action === "open" && step.url)?.url ?? initial.url;
        const journalKey = `act:${intendedUrl}:${JSON.stringify(i.steps)}`;
        const recent = recentOutwardActions.get(journalKey);
        if (hasClick && !i.allowRepeat && recent && Date.now() - recent < 15_000) {
          return {
            output: {
              action: i.action,
              status: "duplicate_suppressed",
              note: "ACTION NOT PERFORMED — this identical outward browser sequence committed less than 15 seconds ago. Verify the existing outcome or pass allowRepeat:true if repetition is intentional.",
              filmstripDir: filmstripDir(strip),
            },
            display: "duplicate browser sequence suppressed",
          };
        }
        const rails = await browserRailsContext(context, promptApprover);
        const effect = browserActionEffect(
          "browser.act",
          // A canvas click/drag can hit "Buy" like any click, and Enter or a
          // Ctrl/⌘ combo can submit: those stay under the click rule. Arrows,
          // letters, Space, Escape, Tab move a game or a cursor and don't.
          hasClick || i.steps.some((step) => step.action === "click_at" || step.action === "drag" || (step.action === "press" && /(^|\+)(enter|control|ctrl|meta|cmd|command)(\+|$)/i.test(step.keys ?? ""))) ? "recoverable" : "reversible",
          `act:${sequence++}`,
          async () => {
            const completed: Array<{ step: number; action: string; state?: unknown; result?: unknown }> = [];
            for (let index = 0; index < i.steps!.length; index += 1) {
              const step = i.steps![index];
              try {
                if (step.action === "open") {
                  if (!step.url) throw new Error("open needs url");
                  await br.attachToExisting?.(step.url).catch(() => false);
                  await br.navigate(step.url);
                } else if (step.action === "click") {
                  if (!step.role || !step.name) throw new Error("click needs role and name");
                  await br.clickByRole(step.role, step.name);
                } else if (step.action === "click_text") {
                  if (!step.query || !br.clickByText) throw new Error("click_text needs query and connector support");
                  await br.clickByText(step.query);
                } else if (step.action === "fill") {
                  if (!step.label || step.value === undefined) throw new Error("fill needs label and value");
                  await br.fillByLabel(step.label, step.value);
                } else if (step.action === "fill_selector") {
                  if (!step.selector || step.value === undefined || !br.fillBySelector) throw new Error("fill_selector needs selector, value, and connector support");
                  await br.fillBySelector(step.selector, step.value);
                } else if (step.action === "press") {
                  if (!step.keys || !br.press) throw new Error("press needs keys (e.g. Enter, ArrowLeft, Control+L) and connector support");
                  await br.press(step.keys, { holdMs: step.holdMs, repeat: step.repeat });
                } else if (step.action === "click_at" || step.action === "drag" || step.action === "scroll") {
                  if (step.x === undefined || step.y === undefined || !br.pointer) throw new Error(`${step.action} needs x and y (viewport CSS pixels, from the screenshot) and connector support`);
                  if (step.action === "drag" && (step.toX === undefined || step.toY === undefined)) throw new Error("drag needs toX and toY");
                  if (step.action === "click_at" && step.holdMs) {
                    // A held press: down, hold, up at the same point. A zero-length
                    // drag (what agents improvised) is an instant tap.
                    await br.pointer({ kind: "move", x: step.x, y: step.y });
                    await br.pointer({ kind: "down", x: step.x, y: step.y, button: step.button });
                    await new Promise((r) => setTimeout(r, step.holdMs));
                    await br.pointer({ kind: "up", x: step.x, y: step.y, button: step.button });
                    completed.push({ step: index + 1, action: step.action, result: { heldMs: step.holdMs }, state: await br.state() });
                    continue;
                  }
                  await br.pointer({
                    kind: step.action === "drag" ? "drag" : step.action === "scroll" ? "wheel" : step.double ? "double" : "click",
                    x: step.x, y: step.y, toX: step.toX, toY: step.toY, dx: step.dx, dy: step.dy ?? (step.action === "scroll" ? 400 : undefined), button: step.button,
                  });
                } else if (step.action === "wait") {
                  if (step.ms && !step.text && !step.selector && !step.url) {
                    // A plain pause: the page runs (a game plays out) for ms.
                    await new Promise((r) => setTimeout(r, step.ms));
                    completed.push({ step: index + 1, action: step.action, result: { waitedMs: step.ms }, state: await br.state() });
                    continue;
                  }
                  if (!step.text && !step.selector && !step.url) throw new Error("wait needs text, selector, url — or ms to just let the page run");
                  if (!br.waitFor) throw new Error("wait is not supported by this browser connector");
                  const waited = await br.waitFor({ text: step.text, selector: step.selector, url: step.url, gone: step.gone }, (step.timeoutSec ?? 60) * 1000, ctx?.signal);
                  completed.push({ step: index + 1, action: step.action, result: waited, state: await br.state() });
                  if (!waited.met) throw new Error(`waited ${Math.round(waited.waitedMs / 1000)}s and the page never ${step.gone ? "lost" : "showed"} ${step.text ? `"${step.text}"` : step.selector ?? step.url}`);
                  continue;
                } else {
                  if (!step.js || !br.evaluate) throw new Error("eval needs js and connector support");
                  completed.push({ step: index + 1, action: step.action, result: await br.evaluate(step.js) });
                  continue;
                }
                completed.push({ step: index + 1, action: step.action, state: await br.state() });
              } catch (error) {
                throw new Error(`browser act stopped at step ${index + 1}/${i.steps!.length} (${step.action}): ${error instanceof Error ? error.message : String(error)}`);
              }
            }
            const [shot, state, observed] = await Promise.all([
              br.screenshot(),
              br.state(),
              br.accessibilityTree().then((nodes) => nodes.slice(0, i.limit ?? 40)),
            ]);
            const frame = await strip.record({ action: `act ${i.steps!.length} steps`, url: state.url, screenshot: shot, note: i.note });
            return { completed, state, observed, shot, frame: frame.frame };
          },
          { idemPrefix: `browser:${process.pid}:${Date.now()}` },
        );
        const outcome = await runEffect(effect, rails);
        if (outcome.status !== "committed" || !outcome.result) {
          return {
            output: { action: i.action, status: outcome.status, result: outcome, note: railsOutcomeNote(outcome), filmstripDir: filmstripDir(strip) },
            display: `browser sequence: ${outcome.status}`,
          };
        }
        if (hasClick) recentOutwardActions.set(journalKey, Date.now());
        const { shot, ...verified } = outcome.result;
        emitTarget(verified.state);
        return {
          output: { action: i.action, status: "committed", result: verified, filmstripDir: filmstripDir(strip) },
          display: `completed ${i.steps.length} browser actions · verified ${verified.state.title ?? verified.state.url}`,
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }

      if (i.action === "tree") {
        const result = (await br.accessibilityTree()).slice(0, i.limit ?? 80);
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: `accessibility tree: ${result.length} node(s)`,
        };
      }

      if (i.action === "state") {
        const result = await br.state();
        emitTarget(result);
        return {
          output: { action: i.action, status: "ok", result, browserStrategy: br.strategy, filmstripDir: filmstripDir(strip) },
          display: `${result.title ?? "(untitled)"} ${result.url} via ${br.strategy ?? br.name}`,
        };
      }

      if (i.action === "screenshot") {
        const [shot, state] = await Promise.all([br.screenshot(), br.state()]);
        emitTarget(state);
        const frame = await strip.record({ action: "manual screenshot", url: state.url, screenshot: shot, note: i.note });
        return {
          output: { action: i.action, status: "ok", result: frame, filmstripDir: filmstripDir(strip) },
          display: `screenshot frame ${frame.frame}`,
          // Hand the actual pixels to the model — without this it browses blind
          // off the accessibility tree alone and can't verify a click or read a
          // layout-dependent page. The viewport is 1280×800, under the vision limit.
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }

      // ── PREVIEW / VERIFY loop — visible cursor, click by text, console, eval ──
      if (i.action === "preview") {
        let url = i.url;
        if (!url && i.html) {
          // Inline HTML → write to a temp .html and open it. The reliable way to
          // preview a self-contained page (the embedded engine's inline render is
          // flaky — agents waste turns on its blank result; a real file always works).
          // Served, not file://: the desktop frame cannot load a temp file
          // (blank stage, 2026-10-16). Each page gets its own folder under
          // the OS temp dir and the local server hosts it, like a project.
          const dir = path.join(os.tmpdir(), "ares-explainers", `p${Date.now()}`);
          await mkdir(dir, { recursive: true });
          const tmp = path.join(dir, "index.html");
          // `<!--ares:kit-->` becomes the inline Forge kit (pixel theme).
          await writeFile(tmp, expandForgeKit(i.html), "utf8");
          const hosted = await serveLocalTarget(tmp, { sessionId: ctx?.sessionId });
          url = hosted ? hosted.url : pathToFileURL(tmp).href;
        }
        const explainer = !!i.html && FORGE_KIT_MARKER.test(i.html);
        if (!url) throw new Error("Browser preview requires `url` (or `html` to render inline)");
        // A project file is hosted, not file://-opened: its folder is served on
        // 127.0.0.1 so module scripts, import maps and relative assets resolve,
        // and the Forge embeds the localhost origin. Inline html (temp file)
        // stays file:// — it is self-contained by contract.
        const served = i.url ? await serveLocalTarget(i.url, { sessionId: ctx?.sessionId, cwd: context.workspace }) : null;
        if (served) url = served.url;
        await br.navigate(url);
        // The import map (if any) is decided while the HTML is served, i.e.
        // during that navigate — read it back now for the result note.
        const rescue = served ? await lastRescueFor(served.root) : undefined;
        const [shot, state] = await Promise.all([br.screenshot(), br.state()]);
        emitTarget(state, explainer ? "explain" : "project");
        const frame = await strip.record({ action: "preview", url: state.url, screenshot: shot, note: i.note });
        // The page's errors ride along with the preview: the model learns what
        // broke in the SAME call (no follow-up console round-trip), and the
        // Forge shows them over the Live tab instead of a silent grey canvas.
        const consoleErrors = br.consoleLogs
          ? await br.consoleLogs({ onlyErrors: true, limit: 8 }).then((logs) => logs.map((l) => `${l.type}: ${l.text}`.slice(0, 400))).catch(() => [] as string[])
          : [];
        ctx?.emitProgress?.({ kind: "browser_console", url: state.url, errors: consoleErrors, served: served ? { root: served.root, origin: served.origin } : null });
        const servedNote = served ? `Serving ${served.root} at ${served.origin} (static, loopback only) — paths in the page resolve against that folder. The Forge sensor is on this page: its errors, warnings and frame rate reach you as reminders while the owner tests it.` : undefined;
        const rescueNote = rescue ? `Bare imports had no import map; one was injected (${rescue.source}): ${Object.entries(rescue.mapped).map(([k, v]) => `${k} → ${v}`).join(", ")}. The project file is untouched — add a real import map or vendor the package when you ship.` : undefined;
        const errorNote = consoleErrors.length ? `${consoleErrors.length} console error(s) on load — see result.consoleErrors.` : undefined;
        const note = [servedNote, rescueNote, errorNote].filter(Boolean).join(" ") || undefined;
        return {
          output: { action: i.action, status: "ok", result: { ...state, frame: frame.frame, consoleErrors, ...(served ? { served: { root: served.root, origin: served.origin, ...(rescue ? { importMap: rescue } : {}) } } : {}) }, ...(note ? { note } : {}), filmstripDir: filmstripDir(strip) },
          display: served ? `preview ${state.url} (serving ${served.root})` : `preview ${state.url}`,
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }

      if (i.action === "click_text") {
        if (!i.query) throw new Error("Browser click_text requires query (visible text or CSS selector)");
        if (!br.clickByText) throw new Error("click_text not supported by this browser");
        const before = await br.state();
        const journalKey = `click_text:${before.url}:${i.query}`;
        const recent = recentOutwardActions.get(journalKey);
        if (!i.allowRepeat && recent && Date.now() - recent < 15_000) {
          return {
            output: { action: i.action, status: "duplicate_suppressed", note: "ACTION NOT PERFORMED — this identical click committed less than 15 seconds ago. Verify the existing outcome or pass allowRepeat:true.", filmstripDir: filmstripDir(strip) },
            display: "duplicate click suppressed",
          };
        }
        const rails = await browserRailsContext(context, promptApprover);
        const effect = browserActionEffect(
          "browser.click_text",
          "recoverable",
          `click-text:${i.query}`,
          async () => {
            await br.clickByText!(i.query!);
            const [shot, state, observed] = await Promise.all([br.screenshot(), br.state(), br.accessibilityTree().then((nodes) => nodes.slice(0, i.limit ?? 40))]);
            await strip.record({ action: `click ${i.query}`, url: state.url, screenshot: shot });
            return { shot, state, observed };
          },
          { idemPrefix: `browser:${process.pid}:${Date.now()}:${sequence++}` },
        );
        const outcome = await runEffect(effect, rails);
        if (outcome.status !== "committed" || !outcome.result) {
          return { output: { action: i.action, status: outcome.status, result: outcome, note: railsOutcomeNote(outcome), filmstripDir: filmstripDir(strip) }, display: `click "${i.query}": ${outcome.status}` };
        }
        recentOutwardActions.set(journalKey, Date.now());
        const { shot, ...verified } = outcome.result;
        emitTarget(verified.state);
        return {
          output: { action: i.action, status: "committed", result: verified, filmstripDir: filmstripDir(strip) },
          display: `clicked "${i.query}"`,
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }

      if (i.action === "fill_selector") {
        if (!i.selector || i.value === undefined) throw new Error("Browser fill_selector requires selector and value");
        if (!br.fillBySelector) throw new Error("fill_selector not supported by this browser");
        const rails = await browserRailsContext(context, promptApprover);
        const effect = browserActionEffect("browser.fill_selector", "reversible", `fill-selector:${i.selector}`, () => br.fillBySelector!(i.selector!, i.value!), { idemPrefix: `browser:${process.pid}:${Date.now()}:${sequence++}` });
        const outcome = await runEffect(effect, rails);
        return {
          output: { action: i.action, status: outcome.status, result: outcome, note: railsOutcomeNote(outcome), filmstripDir: filmstripDir(strip) },
          display: `fill ${i.selector}: ${outcome.status}`,
        };
      }

      if (i.action === "console") {
        if (!br.consoleLogs) throw new Error("console not supported by this browser");
        const logs = await br.consoleLogs({ onlyErrors: i.onlyErrors, limit: i.limit ?? 40 });
        return {
          output: { action: i.action, status: "ok", result: logs, filmstripDir: filmstripDir(strip) },
          display: `${logs.length} console entr${logs.length === 1 ? "y" : "ies"}${i.onlyErrors ? " (errors)" : ""}`,
        };
      }

      if (i.action === "devtools") {
        if (!br.devtools) throw new Error("devtools needs the Forge's embedded browser (not available for this page)");
        const report = await br.devtools();
        const notes: string[] = [];
        if (report.errors.length) notes.push(`${report.errors.length} uncaught error(s) — fix the first one first: ${report.errors[0]!.message}`);
        if (report.longTasks.some((t) => t.ms >= 200)) notes.push(`main thread blocked ${Math.max(...report.longTasks.map((t) => t.ms))} ms at a time — profile to see which function.`);
        if (report.fps !== null && report.fps < 30) notes.push(`${report.fps} fps — profile it.`);
        if ((report.metrics.domNodes ?? 0) > 5000) notes.push(`${report.metrics.domNodes} DOM nodes — the DOM itself is the cost.`);
        const display = `devtools: ${report.errors.length} error(s), ${report.console.length} console warning/error(s), ${report.failedRequests.length} failed request(s), ${report.longTasks.length} long task(s)${report.fps !== null ? `, ${report.fps} fps` : ""}${report.metrics.jsHeapMb !== undefined ? `, heap ${report.metrics.jsHeapMb} MB` : ""}`;
        return {
          output: { action: i.action, status: "ok", result: report, ...(notes.length ? { note: notes.join(" ") } : {}), filmstripDir: filmstripDir(strip) },
          display,
        };
      }

      if (i.action === "profile") {
        if (!br.profile) throw new Error("profile needs the Forge's embedded browser (not available for this page)");
        const report = await br.profile(i.ms ?? 3000);
        const head = report.top.slice(0, 3).map((t) => `${t.fn} ${t.pct}%`).join(", ");
        return {
          output: { action: i.action, status: "ok", result: report, filmstripDir: filmstripDir(strip) },
          display: `profile ${report.sampledMs} ms: ${head || "nothing ran"}; idle ${report.idlePct}%, gc ${report.gcPct}%`,
        };
      }

      if (i.action === "eval") {
        if (!i.js) throw new Error("Browser eval requires js");
        if (!br.evaluate) throw new Error("eval not supported by this browser");
        const result = await br.evaluate(i.js);
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: "eval ok",
        };
      }

      const rails = await browserRailsContext(context, promptApprover);
      const idemPrefix = `browser:${process.pid}:${Date.now()}:${sequence++}`;
      // A non-committed rails outcome must be UNMISSABLE: "staged" means the
      // action did NOT run (held for an approval surface that may not exist),
      // "denied" means it was refused. A bare status string let models read
      // either as success and "verify" clicks that never happened.
      const railsNote = (result: { status: string; reason?: string }): string | undefined =>
        result.status === "staged"
          ? `ACTION NOT PERFORMED — held for owner approval and never committed (${result.reason ?? "no approver available"}). Do not claim it happened; tell the owner it needs their approval.`
          : result.status === "denied"
            ? `ACTION NOT PERFORMED — refused (${result.reason ?? "approval denied"}). Do not retry the same call; tell the owner.`
            : undefined;

      if (i.action === "open") {
        if (!i.url) throw new Error("Browser open requires url");
        // Same hosting rule as preview: a local project file is served from
        // its folder and opened over localhost (see previewServer.ts).
        const served = await serveLocalTarget(i.url, { sessionId: ctx?.sessionId, cwd: context.workspace });
        const openUrl = served ? served.url : i.url;
        // If CDP can see a matching user/Ares tab, bind to it before navigating.
        // This preserves that tab's authenticated context and avoids duplicates.
        await br.attachToExisting?.(openUrl).catch(() => false);
        const effect = navigateEffect(br, openUrl, { filmstrip: strip, idemPrefix });
        // Showing a page on this machine (a served project file, a local dev
        // server) touches nothing in the world, so the operator kill switch —
        // which halts outward commits — must not stop it: it left the owner
        // unable to see their own game in the Forge.
        const result = await runEffect(effect, isLoopbackUrl(openUrl) ? { ...rails, killSwitch: KillSwitch.memory() } : rails);
        emitTarget(await br.state());
        const note = [railsNote(result), served ? `Serving ${served.root} at ${served.origin} (static, loopback only).` : undefined].filter(Boolean).join(" ") || undefined;
        return {
          output: { action: i.action, status: result.status, result, note, filmstripDir: filmstripDir(strip) },
          display: `open ${openUrl}: ${result.status}`,
        };
      }

      if (i.action === "fill") {
        if (!i.label) throw new Error("Browser fill requires label");
        if (i.value === undefined) throw new Error("Browser fill requires value");
        const effect = fillEffect(br, i.label, i.value, { filmstrip: strip, idemPrefix });
        const result = await runEffect(effect, rails);
        return {
          output: { action: i.action, status: result.status, result, note: railsNote(result), filmstripDir: filmstripDir(strip) },
          display: `fill ${i.label}: ${result.status}`,
        };
      }

      if (!i.role || !i.name) throw new Error("Browser click requires role and name");
      const before = await br.state();
      const journalKey = `click:${before.url}:${i.role}:${i.name}`;
      const recent = recentOutwardActions.get(journalKey);
      if (!i.allowRepeat && recent && Date.now() - recent < 15_000) {
        return {
          output: { action: i.action, status: "duplicate_suppressed", note: "ACTION NOT PERFORMED — this identical click committed less than 15 seconds ago. Verify the existing outcome or pass allowRepeat:true.", filmstripDir: filmstripDir(strip) },
          display: "duplicate click suppressed",
        };
      }
      const effect = clickEffect(br, i.role, i.name, { filmstrip: strip, idemPrefix });
      const result = await runEffect(effect, rails);
      if (result.status === "committed") {
        recentOutwardActions.set(journalKey, Date.now());
        const [shot, state, observed] = await Promise.all([br.screenshot(), br.state(), br.accessibilityTree().then((nodes) => nodes.slice(0, i.limit ?? 40))]);
        emitTarget(state);
        return {
          output: { action: i.action, status: result.status, result: { effect: result, state, observed }, filmstripDir: filmstripDir(strip) },
          display: `click ${i.role}:${i.name}: committed · verified`,
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }
      return {
        output: { action: i.action, status: result.status, result, note: railsNote(result), filmstripDir: filmstripDir(strip) },
        display: `click ${i.role}:${i.name}: ${result.status}`,
      };
    },
  };

  const act = def.call;
  return buildTool({
    ...def,
    async call(i, ctx) {
      callState = {};
      // Everything page-derived is scanned for filled secrets before it leaves
      // (frames are pixels of masked fields, and pass through untouched).
      const redact = (text: string) => prints.redact(text);
      progressSink = ctx.emitProgress
        ? (data) => ctx.emitProgress?.(data.kind === "browser_frame" || !prints.size ? data : redactDeep(data, redact))
        : null;
      const redactedCtx: RichToolContext = { ...ctx, ...(progressSink ? { emitProgress: (data: unknown) => progressSink?.(data as Record<string, unknown>) } : {}) };
      try {
        if (i.engine !== "embedded" && i.action !== "filmstrip") {
          const held = await holdForOwner(i, redactedCtx);
          if (held) return prints.size ? redactDeep(held, redact) : held;
        }
        const result = await act(i, redactedCtx);
        if (callState.orderSubmission && result.output.status === "committed") spendCheckoutApproval(ctx.sessionId);
        if (callState.handbackNote) {
          result.output = { ...result.output, ownerTookOver: true, note: [callState.handbackNote, result.output.note].filter(Boolean).join(" ") };
        }
        if (callState.forgeNote) result.output = { ...result.output, note: [callState.forgeNote, result.output.note].filter(Boolean).join(" ") };
        if (!prints.size) return result;
        return { ...result, output: redactDeep(result.output, redact), ...(result.display ? { display: redact(result.display) } : {}) };
      } catch (err) {
        if (err instanceof Error && prints.size) err.message = redact(err.message);
        throw err;
      } finally {
        callState.release?.();
        // The screencast keeps firing on every repaint after the call: a game
        // repaints 60x a second, and each ~150KB frame went to a turn that had
        // ended — the daemon heap hit 4GB in under five minutes and died.
        frameSink = null;
        progressSink = null;
      }
    },
  });
}

/** What the watch card calls this browser: the site it's on, else a plain name. */
function watchLabel(url: string | undefined, page: unknown): string {
  const hostOf = (value: string | undefined) => {
    try {
      const host = value ? new URL(value.includes("://") ? value : `https://${value}`).hostname : "";
      return host.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  let current = "";
  try {
    current = String((page as { url?: () => string } | undefined)?.url?.() ?? "");
  } catch {
    current = "";
  }
  return hostOf(url) || (/^https?:/.test(current) ? hostOf(current) : "") || "Ares's browser";
}

/** How long a Browser action waits for the owner to hand back (ARES_BROWSER_TAKEOVER_WAIT_MS, default 10 min). */
function takeoverWaitMs(): number {
  const env = Number(process.env.ARES_BROWSER_TAKEOVER_WAIT_MS);
  return Number.isFinite(env) && env > 0 ? env : 10 * 60_000;
}

/** Actions that only look (or, like close, act on no page content) — safe to run right after a handback, carrying the re-read notice. */
const OBSERVE_ONLY_ACTIONS = new Set(["tabs", "tree", "screenshot", "console", "state", "filmstrip", "close", "devtools", "profile"]);

function isClosedBrowserError(error: unknown): boolean {
  return /target (?:page|context|browser) has been closed|browser has been closed|page has been closed/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function railsOutcomeNote(result: { status: string; reason?: string }): string | undefined {
  if (result.status === "staged") {
    return `ACTION NOT PERFORMED — held for owner approval and never committed (${result.reason ?? "no approver available"}). Do not claim it happened; tell the owner it needs their approval.`;
  }
  if (result.status === "denied") {
    return `ACTION NOT PERFORMED — refused (${result.reason ?? "approval denied"}). Do not retry the same call; tell the owner.`;
  }
  return undefined;
}

/**
 * V8 — which leash governs outward effects:
 *   guarded (default): autonomy is earned through the TrustGovernor.
 *   unleashed (dangerousBypass: true): the owner's dial, wide open.
 *   derives each domain's leash from the Crucible (confirmed procedures with
 *   net-positive records), and every level change lands in leash.jsonl next to
 *   the effects ledger with the evidence that justified it.
 */
async function resolveLeash(context: CliRuntimeContext): Promise<(domain: string) => number> {
  const settings = await loadUiSettings();
  if (settings.dangerousBypass === true) return ownerLeash();
  try {
    const store = await MemoryStore.open(context.mind.memoryFile);
    const leashLog = path.join(context.effects.effectsDir, "leash.jsonl");
    const governor = new TrustGovernor({
      nodes: () => store.all(),
      append: (change) =>
        mkdir(path.dirname(leashLog), { recursive: true })
          .then(() => appendFile(leashLog, JSON.stringify(change) + "\n"))
          .catch(() => undefined),
    });
    return (domain) => governor.leashOf(domain);
  } catch {
    // No readable memory: guarded mode falls back to the shortest leash.
    return ownerLeash({ trust: 1 });
  }
}

/** Budget ceilings from env — ARES_BUDGET_DAILY (dollars) and ARES_BUDGET_PER_DOMAIN
 *  ("domain=amount,domain2=amount2"). Mirrors the ARES_OPERATOR_* env-config
 *  convention used elsewhere in this file rather than a UiSettings field, since
 *  the budget ceiling is an operator-wide guardrail, not a per-session UI knob. */
function budgetLimitsFromEnv(): BudgetLimits {
  const limits: BudgetLimits = {};
  const daily = Number(process.env.ARES_BUDGET_DAILY);
  if (Number.isFinite(daily) && daily > 0) limits.daily = daily;
  const perDomainRaw = process.env.ARES_BUDGET_PER_DOMAIN;
  if (perDomainRaw) {
    const perDomain: Record<string, number> = {};
    for (const pair of perDomainRaw.split(",")) {
      const [domain, amountRaw] = pair.split("=").map((v) => v.trim());
      const amount = Number(amountRaw);
      if (domain && Number.isFinite(amount) && amount > 0) perDomain[domain] = amount;
    }
    if (Object.keys(perDomain).length) limits.perDomain = perDomain;
  }
  return limits;
}

async function browserRailsContext(
  context: CliRuntimeContext,
  promptApprover?: RailsContext["requestApproval"] | null,
): Promise<RailsContext> {
  const paths = context.effects;
  // Approver precedence: the garrison gateway when it's up, else THIS turn's
  // engine permission prompt (the same card/transport every gated tool uses).
  // Before the fallback existed, a desktop session had NO approver at all, so a
  // staged click (guarded mode, browser leash 1 < recoverable's required 2) was
  // held forever and the tool reported "staged" — a click that silently never
  // happened. Now it pauses on a real approval card and commits or refuses.
  const requestApproval: RailsContext["requestApproval"] =
    context.approvals?.requestApproval ?? promptApprover ?? undefined;
  return {
    ledger: await Ledger.open(paths.ledgerFile),
    // The ceiling only bites once some effect actually carries a nonzero
    // EffectCost.dollars — none do today (see EffectCost in @ares/effects).
    // This wiring makes the ceiling REAL and configurable for when that
    // changes; it is not an active spend guard yet.
    budget: new Budget(budgetLimitsFromEnv()),
    killSwitch: new KillSwitch(paths.killSwitchFile),
    leashOf: await resolveLeash(context),
    requestApproval,
  };
}

function filmstripDir(strip: Filmstrip): string {
  return (strip as unknown as { dir?: string }).dir ?? "filmstrip";
}

/** http(s) on this machine only — 127.0.0.1, localhost, [::1]. */
function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Actions that need a whole browser (tabs, sign-ins, extension) or build their own page. */
const NOT_PAGE_DRIVEN = new Set(["handshake", "tabs", "attach", "login", "fill_secret", "model", "close", "network", "filmstrip", "devtools", "profile"]);

/**
 * The page Ares should act in when there is no native Forge view: the copy of
 * a served page the owner has open. `open`/`preview` of a local file serves it,
 * shows it in the Forge and waits for that copy to connect; anything else
 * continues on the page already open there. Null = no such page (an http site,
 * no Forge watching): the caller falls back to the background browser.
 */
async function servedPageFor(
  i: { action: string; url?: string; steps?: Array<{ action: string; url?: string }> },
  ctx: RichToolContext | undefined,
  emitTarget: (state: { url?: string; title?: string }) => void,
  continuing: string | null,
  cwd: string,
): Promise<BrowserConnector | null> {
  if (NOT_PAGE_DRIVEN.has(i.action) || process.env.ARES_PAGE_DRIVER === "0") return null;
  // An act that opens a page first ("open, wait, click Play") is an open too.
  const openUrl = (i.action === "open" || i.action === "preview") ? i.url
    : i.action === "act" && i.steps?.[0]?.action === "open" ? i.steps[0].url : undefined;
  if (openUrl) {
    // A file path, or the loopback address of a page Ares already serves.
    // A file path, the loopback address of a page Ares serves, or the
    // project's own dev server (Vite & co), fronted so its pages can be driven.
    const served = (await serveLocalTarget(openUrl, { sessionId: ctx?.sessionId, cwd }).catch(() => null))
      ?? (await servedForUrl(openUrl))
      ?? (await serveDevServer(openUrl, { sessionId: ctx?.sessionId }).catch(() => null));
    if (!served) return null;
    const open = (await drivableRoots()).find((r) => r.root === served.root);
    if (!open) emitTarget({ url: served.url });
    const page = await waitForDrivablePage(served.root, Number(process.env.ARES_PAGE_DRIVER_WAIT_MS) || 8_000);
    return page ? createServedPageBrowser(served.root, served.origin, page) : null;
  }
  if (!continuing) return null;
  const newest = (await drivableRoots()).find((r) => `page:${new URL(r.url).origin}` === continuing);
  if (!newest) return null;
  const page = await waitForDrivablePage(newest.root, 0);
  return page ? createServedPageBrowser(newest.root, new URL(newest.url).origin, page) : null;
}
