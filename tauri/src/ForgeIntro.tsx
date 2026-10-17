// The Forge tour: a short interactive cutscene that shows every new system by
// RUNNING it. Nothing here is a mock-up: the stories, the live build, the edit
// loop and the chests are the real engines (story, model studio, ExplainStream)
// fed by the same data the tools produce. Opens from What's New, Settings, or
// the "ares:show-forge-intro" event; ?forgetour forces it for testing.
//
// Motion is calm by design (fades, typing, slow camera): nothing flashes.
// Under prefers-reduced-motion the text appears at once and scenes only
// advance when you do.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExplainStream } from "../../packages/cli/src/entry/forgeLive";
import { FOX_EDITS, chestsSpec, foxCallJson, foxSpec, liveStageHtml, manualStudioHtml, romeHtml, type StudioSpec } from "./forgeIntroData";

const reducedMotion = (): boolean => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

/** Types `text` out while `on`; with reduced motion (or on=false after finishing) it is simply the whole text. */
function useTyped(text: string, on: boolean, cps = 60): string {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) { setN(0); return; }
    if (reducedMotion()) { setN(text.length); return; }
    setN(0);
    const t0 = performance.now();
    const id = window.setInterval(() => {
      const k = Math.min(text.length, Math.floor(((performance.now() - t0) / 1000) * cps));
      setN(k);
      if (k >= text.length) window.clearInterval(id);
    }, 40);
    return () => window.clearInterval(id);
  }, [text, on, cps]);
  return text.slice(0, n);
}

/** A kit page in a sandboxed iframe that a scene can talk to by postMessage. */
function useFrame(html: string) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const ready = useRef(false);
  const pending = useRef<unknown[]>([]);
  const send = useCallback((msg: unknown) => {
    if (ready.current) ref.current?.contentWindow?.postMessage(msg, "*");
    else pending.current.push(msg);
  }, []);
  useEffect(() => {
    ready.current = false;
    const onMsg = (e: MessageEvent): void => {
      if (e.source !== ref.current?.contentWindow) return;
      if ((e.data as { ares?: string } | null)?.ares === "studio-ready") {
        ready.current = true;
        for (const m of pending.current.splice(0)) ref.current?.contentWindow?.postMessage(m, "*");
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [html]);
  const el = <iframe ref={ref} className="fiFrame" title="Forge tour demo" sandbox="allow-scripts" srcDoc={html} />;
  return { el, send, ref, markReady: () => { ready.current = true; for (const m of pending.current.splice(0)) ref.current?.contentWindow?.postMessage(m, "*"); } };
}

interface SceneProps { active: boolean }

// 1 ── Explain anything: the story engine plays a history out instead of describing it.
function SceneExplain({ active }: SceneProps): React.ReactElement {
  const prompt = useTyped("explain the rise and fall of rome", active, 26);
  const html = useMemo(() => romeHtml(), []);
  return (
    <div className="fiScene">
      <div className="fiSide">
        <div className="fiChat"><i>you</i><span>{prompt}<b className="fiCaret" /></span></div>
        <p className="fiLine">Ask Ares to explain anything. It <b>plays it out</b> on the Forge: people appear, cities rise, armies march, walls fall.</p>
        <p className="fiLine fiDim">Stories, charts, timelines, physics, plans. One short call, a finished page.</p>
      </div>
      <div className="fiStage">{active ? <iframe className="fiFrame" title="Story demo" sandbox="allow-scripts" srcDoc={html} /> : null}</div>
    </div>
  );
}

// 2 ── Live build: the call being written on the left is what builds the fox on the right.
function SceneLive({ active }: SceneProps): React.ReactElement {
  const html = useMemo(() => liveStageHtml(), []);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [shown, setShown] = useState("");
  const text = useMemo(() => foxCallJson(), []);
  useEffect(() => {
    if (!active || !loaded) { setShown(""); return; }
    const stream = new ExplainStream();
    let pos = 0;
    const step = reducedMotion() ? text.length : 46;
    const id = window.setInterval(() => {
      const chunk = text.slice(pos, pos + step);
      pos += step;
      setShown(text.slice(0, Math.min(pos, text.length)));
      for (const piece of stream.feed(chunk)) frame.current?.contentWindow?.postMessage({ ares: "live", piece }, "*");
      if (pos >= text.length) window.clearInterval(id);
    }, 45);
    return () => window.clearInterval(id);
  }, [active, loaded, text]);
  const tail = shown.slice(-900);
  return (
    <div className="fiScene">
      <div className="fiSide">
        <p className="fiLine">Ask for a <b>3D model</b> and watch it get built <b>piece by piece, while Ares is still writing it</b>.</p>
        <pre className="fiCode fiTail" aria-label="The tool call as Ares writes it">{tail}<b className="fiCaret" /></pre>
        <p className="fiLine fiDim">Creatures are sculpted: each blob melts into the clay the moment it is written. No waiting for a finished file.</p>
      </div>
      <div className="fiStage">{active ? <iframe ref={frame} className="fiFrame" title="Live build demo" sandbox="allow-scripts" srcDoc={html} onLoad={() => setLoaded(true)} /> : null}</div>
    </div>
  );
}

// 3 ── The edit loop: say what you want; Ares edits the same model in place and you watch it change.
function SceneEdit({ active }: SceneProps): React.ReactElement {
  const html = useMemo(() => manualStudioHtml("Fox"), []);
  const f = useFrame(html);
  const [step, setStep] = useState(-1);
  useEffect(() => {
    if (!active) { setStep(-1); return; }
    f.send({ ares: "studio", spec: foxSpec() });
    if (reducedMotion()) { setStep(FOX_EDITS.length - 1); f.send({ ares: "studio", spec: FOX_EDITS[FOX_EDITS.length - 1]!.spec() }); return; }
    let i = 0;
    const id = window.setInterval(() => {
      if (i >= FOX_EDITS.length) { window.clearInterval(id); return; }
      setStep(i);
      f.send({ ares: "studio", spec: FOX_EDITS[i]!.spec() });
      i++;
    }, 3600);
    return () => window.clearInterval(id);
  }, [active, f]);
  const cur = step >= 0 ? FOX_EDITS[step] : null;
  const prompt = useTyped(cur?.say ?? "", !!cur, 30);
  return (
    <div className="fiScene">
      <div className="fiSide">
        <p className="fiLine">Then just <b>talk to it</b>. Ares edits the same model in place and looks at the result from any angle before it answers.</p>
        <div className="fiChat"><i>you</i><span>{prompt || "…"}<b className="fiCaret" /></span></div>
        <pre className="fiCode">{cur ? `Browser model\n  ${cur.op}` : "Browser model"}</pre>
        <p className="fiLine fiDim">Wireframe, rig, camera, lighting, backdrops: Ares does them when you ask. The screen stays clean.</p>
      </div>
      <div className="fiStage">{active ? f.el : null}</div>
    </div>
  );
}

// 4 ── Game-ready: the same model, three variants, one animation, loaded into any three.js game.
const GAME_CODE = `import { loadModel } from "./assets/ares-model.js";

const chest = await loadModel("assets/models/chest.game.json");
const a = chest.instance({ material: tint("frost") });
scene.add(a.group);
a.play("open");           // joints, clips, events
a.on("lid-up", spawnLoot);`;
function SceneGame({ active }: SceneProps): React.ReactElement {
  const html = useMemo(() => manualStudioHtml("Chests"), []);
  const f = useFrame(html);
  const code = useTyped(GAME_CODE, active, 48);
  useEffect(() => { if (active) f.send({ ares: "studio", spec: chestsSpec() }); }, [active, f]);
  return (
    <div className="fiScene">
      <div className="fiSide">
        <p className="fiLine">When it looks right, <b>export it into your game</b>. Ares writes a tiny runtime into your project: same shapes, joints and animations, shared by every instance.</p>
        <pre className="fiCode">{code}<b className="fiCaret" /></pre>
        <p className="fiLine fiDim">Ares then places it in the game, runs the game, and checks it from every side.</p>
      </div>
      <div className="fiStage">{active ? f.el : null}</div>
    </div>
  );
}

// 5 ── Anything else is a script Ares writes itself: water, lava, rain, textures, physics.
const WATER_CODE = `function init(api){
  var m = api.add(waterMesh());
  api.on("splash", d => ripple(d.x, d.z));
  api.on("click",  d => ripple(d.point[0], d.point[2]));
}
function update(api){ animateWaves(api.time); }`;
function SceneScripts({ active }: SceneProps): React.ReactElement {
  const code = useTyped(WATER_CODE, active, 44);
  const cv = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = cv.current;
    if (!active || !c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const W = 480, H = 300;
    c.width = W; c.height = H;
    const rip: Array<{ x: number; y: number; t: number }> = [];
    const addRip = (x: number, y: number): void => { rip.push({ x, y, t: performance.now() / 1000 }); if (rip.length > 10) rip.shift(); };
    const onDown = (e: PointerEvent): void => { const r = c.getBoundingClientRect(); addRip(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H); };
    c.addEventListener("pointerdown", onDown);
    let raf = 0;
    let next = 0;
    const draw = (now: number): void => {
      const t = now / 1000;
      if (!reducedMotion() && t > next) { addRip(120 + Math.random() * 240, 90 + Math.random() * 120); next = t + 1.6; }
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#15347a"); g.addColorStop(1, "#2f6df0");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const cell = 10;
      for (let y = 0; y < H; y += cell) for (let x = 0; x < W; x += cell) {
        let h = 0.08 * Math.sin(x * 0.05 + t * 1.2) + 0.06 * Math.sin(y * 0.07 - t);
        for (const r of rip) { const age = t - r.t; if (age > 5) continue; const d = Math.hypot(x - r.x, y - r.y); h += 0.4 * Math.sin(0.14 * (d - 70 * age)) * Math.exp(-1.2 * age - d * 0.006); }
        const v = Math.max(0, Math.min(1, 0.5 + h));
        ctx.fillStyle = v > 0.72 ? "#9cc5ff" : v > 0.55 ? "#5b97f5" : v > 0.42 ? "#2f6df0" : "#15347a";
        ctx.fillRect(x, y, cell - 1, cell - 1);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); c.removeEventListener("pointerdown", onDown); };
  }, [active]);
  return (
    <div className="fiScene">
      <div className="fiSide">
        <p className="fiLine">The engine has <b>no built-in water, lava, rain or physics</b>. On purpose.</p>
        <p className="fiLine">Ares <b>writes the behaviour itself</b>: a short script that runs live, reads real errors back, and fixes itself. Try the pond: click it.</p>
        <pre className="fiCode">{code}<b className="fiCaret" /></pre>
      </div>
      <div className="fiStage fiStageCanvas"><canvas ref={cv} className="fiCanvas" aria-label="A pond Ares wrote as a script. Click to make ripples." /></div>
    </div>
  );
}

// 6 ── It is all conversational.
const ASKS: Array<{ say: string; does: string }> = [
  { say: "generate this as a 3D model for my game", does: "model · parts built live · it opens in the Forge" },
  { say: "add color and a pastel backdrop", does: "model · look: pastel · recolour in place" },
  { say: "put it in our game next to the pond", does: "model · export · edits the game · previews it" },
  { say: "now give it a walk animation", does: "model · clip: walk · joints · plays in game" },
  { say: "make the pond ripple when it drinks", does: "model · script: water · clip event · live" },
];
function SceneSay({ active }: SceneProps): React.ReactElement {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) { setN(0); return; }
    if (reducedMotion()) { setN(ASKS.length); return; }
    let i = 0;
    const id = window.setInterval(() => { i++; setN(i); if (i >= ASKS.length) window.clearInterval(id); }, 1700);
    setN(1);
    return () => window.clearInterval(id);
  }, [active]);
  return (
    <div className="fiScene fiSceneWide">
      <div className="fiAsks">
        {ASKS.slice(0, n).map((a) => (
          <div key={a.say} className="fiAsk">
            <div className="fiChat"><i>you</i><span>{a.say}</span></div>
            <div className="fiDoes"><i>Ares</i><span>{a.does}</span></div>
          </div>
        ))}
      </div>
      <p className="fiLine fiCenter">No settings to learn. No buttons to find. <b>Say what you want.</b> The Forge shows it, live, and stays simple to look at.</p>
    </div>
  );
}

// 7 ── Finale
function SceneDone(): React.ReactElement {
  return (
    <div className="fiScene fiSceneWide fiDone">
      <h3>That is the new Forge.</h3>
      <ul>
        <li><b>Explain it</b>: stories, charts and simulations that play out live.</li>
        <li><b>Build it</b>: sculpted creatures and characters, props piece by piece, in many styles.</li>
        <li><b>Edit it</b>: say what to change; Ares edits and checks its own work.</li>
        <li><b>Ship it</b>: export into your game, with joints and animation.</li>
        <li><b>Script it</b>: Ares writes water, lava, rain and physics itself.</li>
      </ul>
      <p className="fiLine fiDim">Try: <i>"sculpt a grizzly bear for my game and make it walk"</i></p>
    </div>
  );
}

const SCENES: Array<{ kicker: string; title: string; ms: number; node: (active: boolean) => React.ReactElement }> = [
  { kicker: "Explain", title: "Ask for anything. Watch it play out.", ms: 12000, node: (a) => <SceneExplain active={a} /> },
  { kicker: "Build", title: "Models, built while Ares writes them.", ms: 15000, node: (a) => <SceneLive active={a} /> },
  { kicker: "Edit", title: "Say what to change. It changes in front of you.", ms: 16000, node: (a) => <SceneEdit active={a} /> },
  { kicker: "Ship", title: "Straight into your game.", ms: 15000, node: (a) => <SceneGame active={a} /> },
  { kicker: "Script", title: "Water, lava, rain. Ares writes its own.", ms: 13000, node: (a) => <SceneScripts active={a} /> },
  { kicker: "Talk", title: "It is all just conversation.", ms: 11000, node: (a) => <SceneSay active={a} /> },
  { kicker: "Go", title: "You are set.", ms: 8000, node: () => <SceneDone /> },
];

export function ForgeIntro(): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [t, setT] = useState(0);

  useEffect(() => {
    const show = (): void => { setIdx(0); setT(0); setPlaying(!reducedMotion()); setOpen(true); };
    window.addEventListener("ares:show-forge-intro", show);
    try { if (new URLSearchParams(window.location.search).has("forgetour")) show(); } catch { /* no window.location */ }
    return () => window.removeEventListener("ares:show-forge-intro", show);
  }, []);

  const close = useCallback(() => setOpen(false), []);
  const go = useCallback((n: number) => { setIdx(Math.max(0, Math.min(SCENES.length - 1, n))); setT(0); }, []);

  // calm auto-advance: a thin progress bar per scene
  useEffect(() => {
    if (!open || !playing) return;
    const ms = SCENES[idx]!.ms;
    const id = window.setInterval(() => {
      setT((v) => {
        const nv = v + 100;
        if (nv >= ms) {
          if (idx < SCENES.length - 1) { setIdx(idx + 1); return 0; }
          window.clearInterval(id);
          return ms;
        }
        return nv;
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [open, playing, idx]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" || e.key === "Enter") go(idx + 1);
      else if (e.key === "ArrowLeft") go(idx - 1);
      else if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, idx, go, close]);

  if (!open) return null;
  const scene = SCENES[idx]!;
  return (
    <div className="scrim center fiScrim" role="dialog" aria-modal="true" aria-label="Forge tour" onClick={close}>
      <div className="fiCard" onClick={(e) => e.stopPropagation()}>
        <header className="fiHead">
          <div className="fiSteps" aria-hidden="true">
            {SCENES.map((s, i) => (
              <button key={s.kicker} className="fiStep" data-state={i < idx ? "done" : i === idx ? "now" : "next"} onClick={() => go(i)} tabIndex={-1}>
                <i style={{ width: i < idx ? "100%" : i === idx ? `${Math.min(100, (t / scene.ms) * 100)}%` : "0%" }} />
              </button>
            ))}
          </div>
          <div className="fiTitleRow">
            <span className="fiKicker">{String(idx + 1).padStart(2, "0")} · {scene.kicker}</span>
            <h2 className="fiTitle">{scene.title}</h2>
            <button className="fiSkip" onClick={close}>Skip tour</button>
          </div>
        </header>
        <div className="fiBody" key={idx}>{scene.node(true)}</div>
        <footer className="fiFoot">
          <button className="fiBtn" onClick={() => go(idx - 1)} disabled={idx === 0}>Back</button>
          <button className="fiBtn" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
          <span className="fiHint">← → to move · space to pause · esc to close</span>
          {idx < SCENES.length - 1
            ? <button className="fiBtn fiPrimary" onClick={() => go(idx + 1)}>Next</button>
            : <button className="fiBtn fiPrimary" onClick={close}>Start building</button>}
        </footer>
      </div>
    </div>
  );
}
