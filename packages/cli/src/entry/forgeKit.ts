// The Forge kit: generative UI in the Forge's own 2-bit pixel language.
//
// Owner, 2026-10-15: Ares should show and explain things with generated UI
// (CopilotKit's Open Intelligent UI as the inspiration), rendered in the Forge
// and looking like the Forge — pixel rim, four-tone blues, HUD pills, stat
// tiles, step flows, timelines, callouts — "generated with the pixel theme".
//
// Ares writes a self-contained .html and puts `<!--ares:kit-->` in <head>;
// the Browser tool expands that marker into the inline kit (expandForgeKit),
// so the page needs no network and renders identically from a temp file, the
// embedded browser, or a served folder (/__ares/kit.css + /__ares/kit.js).
// The kit's JS gives every page the same pixel resolve on load.

import { FORGE_SIM_JS } from "./forgeSim.js";
import { FORGE_MODEL_JS } from "./forgeModel.js";
import { FORGE_STORY_JS } from "./forgeStory.js";
import { sanitizeModel, sanitizeStory } from "./forgeBlocks.js";
import { LIVE_RUNTIME_JS } from "./forgeLive.js";

export const FORGE_KIT_MARKER = /<!--\s*ares:kit\s*-->|<link\b[^>]*rel=["']ares-kit["'][^>]*>/i;

export const FORGE_KIT_CSS = `
:root{--k0:#07122b;--k1:#15347a;--k2:#2f6df0;--k3:#9cc5ff;--ink:#070a13;--panel:rgba(10,14,27,.92);--text:#dfe7ff;--muted:rgba(190,205,240,.7);--faint:rgba(190,205,240,.42);--gold:#ffd36a;--ember:#ff8a3a;--mint:#7ef0c3;--red:#ff8a6a;--mono:"JetBrains Mono","Cascadia Mono","Fira Code",ui-monospace,Consolas,monospace;--sans:"Inter","Segoe UI",system-ui,sans-serif}
*{box-sizing:border-box}[hidden]{display:none!important}html,body{margin:0;min-height:100%}
body{background:radial-gradient(1200px 500px at 110% -10%,rgba(47,109,240,.16),transparent 60%),radial-gradient(700px 420px at -20% 110%,rgba(255,138,58,.08),transparent 60%),linear-gradient(180deg,#0c1120,#070a13);color:var(--text);font:14px/1.6 var(--sans);padding:26px 28px 48px;position:relative}
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:repeating-linear-gradient(0deg,transparent 0 31px,rgba(47,109,240,.05) 31px 32px),repeating-linear-gradient(90deg,transparent 0 31px,rgba(47,109,240,.05) 31px 32px);mask-image:radial-gradient(ellipse at 50% 40%,#000 20%,transparent 85%)}
h1,h2,h3{font-family:var(--mono);letter-spacing:.08em;color:#fff;margin:1.1em 0 .45em;line-height:1.25}
h1{font-size:22px;text-transform:uppercase;letter-spacing:.22em;text-shadow:0 0 16px rgba(47,109,240,.55);padding-bottom:10px;border-bottom:1px solid rgba(47,109,240,.22)}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.2em;color:var(--gold)}h3{font-size:13px;color:#cfdcff}
p{margin:.5em 0;color:var(--muted)}a{color:#8fb3ff}
code{font:12px/1.4 var(--mono);color:var(--gold);background:rgba(47,109,240,.12);padding:1px 6px;border-radius:4px}
pre{background:rgba(2,4,10,.8);border:1px solid rgba(47,109,240,.2);border-radius:10px;padding:12px 14px;overflow:auto;font:12px/1.55 var(--mono)}pre code{background:none;color:var(--text);padding:0}
.k-eyebrow{font:700 9.5px/1 var(--mono);letter-spacing:.3em;text-transform:uppercase;color:var(--k3);text-shadow:0 0 10px rgba(47,109,240,.6);display:flex;align-items:center;gap:8px}
.k-eyebrow::before{content:"";width:7px;height:7px;background:var(--k2);box-shadow:0 0 8px var(--k2);display:inline-block}
.k-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:12px 0}
.k-card{position:relative;padding:14px 15px 13px;border-radius:12px;border:1px solid rgba(47,109,240,.2);background:linear-gradient(180deg,rgba(47,109,240,.1),rgba(47,109,240,.025))}
.k-card::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:2px;background:linear-gradient(180deg,var(--k2),rgba(47,109,240,.1));box-shadow:0 0 8px rgba(47,109,240,.6);border-radius:2px}
.k-card h3,.k-card .k-label{margin:0 0 6px;font:700 9.5px/1.4 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:#fff}
.k-card p{margin:0;font-size:12.5px}
.k-stat{display:grid;gap:4px}.k-stat b{font:800 26px/1 var(--mono);color:#fff;text-shadow:0 0 14px rgba(47,109,240,.5)}.k-stat b.gold{color:var(--gold);text-shadow:0 0 14px rgba(255,211,106,.4)}.k-stat b.mint{color:var(--mint);text-shadow:0 0 14px rgba(126,240,195,.4)}.k-stat b.red{color:var(--red)}
.k-stat small{font:700 9.5px/1.4 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
.k-pills{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.k-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;border:1px solid rgba(47,109,240,.22);background:rgba(3,6,14,.55);color:var(--muted);font:700 9.5px/1.3 var(--mono);letter-spacing:.12em;text-transform:uppercase}
.k-pill i{width:6px;height:6px;background:var(--k2);box-shadow:0 0 8px var(--k2)}.k-pill.ok{color:var(--mint);border-color:rgba(126,240,195,.4)}.k-pill.ok i{background:var(--mint);box-shadow:0 0 8px var(--mint)}
.k-pill.warn{color:var(--gold);border-color:rgba(255,211,106,.4)}.k-pill.warn i{background:var(--gold);box-shadow:0 0 8px var(--gold)}.k-pill.bad{color:var(--red);border-color:rgba(255,87,64,.5)}.k-pill.bad i{background:var(--red);box-shadow:0 0 8px var(--red)}
.k-steps{list-style:none;margin:12px 0;padding:0;display:grid;gap:8px;counter-reset:k}
.k-steps li{position:relative;padding:10px 14px 10px 46px;border-radius:10px;border:1px solid rgba(47,109,240,.18);background:rgba(47,109,240,.05);counter-increment:k;font-size:12.5px;color:var(--muted)}
.k-steps li::before{content:counter(k,decimal-leading-zero);position:absolute;left:12px;top:10px;font:800 11px/1.4 var(--mono);color:var(--k3);text-shadow:0 0 8px rgba(47,109,240,.7)}
.k-steps li b{color:#fff;font:700 10px/1.6 var(--mono);letter-spacing:.14em;text-transform:uppercase;display:block}
.k-steps li.done{border-color:rgba(126,240,195,.35)}.k-steps li.done::before{content:"✓";color:var(--mint)}.k-steps li.now{border-color:rgba(47,109,240,.6);box-shadow:0 0 16px rgba(47,109,240,.2)}
.k-timeline{margin:12px 0;padding:0 0 0 18px;border-left:1px solid rgba(47,109,240,.3);display:grid;gap:12px}
.k-timeline > div{position:relative;font-size:12.5px;color:var(--muted)}.k-timeline > div::before{content:"";position:absolute;left:-22px;top:6px;width:7px;height:7px;background:var(--k2);box-shadow:0 0 8px var(--k2)}
.k-timeline time{display:block;font:700 9.5px/1.6 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--k3)}
.k-bar{height:8px;border-radius:2px;background:rgba(47,109,240,.14);overflow:hidden;margin:6px 0}.k-bar > span{display:block;height:100%;background:repeating-linear-gradient(90deg,var(--k2) 0 6px,var(--k3) 6px 8px);box-shadow:0 0 10px rgba(47,109,240,.6)}
.k-callout{margin:12px 0;padding:10px 14px;border-radius:10px;border:1px solid rgba(255,211,106,.35);background:rgba(255,211,106,.07);color:var(--text);font-size:12.5px}.k-callout.bad{border-color:rgba(255,87,64,.45);background:rgba(255,87,64,.08)}.k-callout.ok{border-color:rgba(126,240,195,.35);background:rgba(126,240,195,.06)}
.k-callout b{font:700 9.5px/1.8 var(--mono);letter-spacing:.16em;text-transform:uppercase;display:block;color:var(--gold)}.k-callout.bad b{color:var(--red)}.k-callout.ok b{color:var(--mint)}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:12.5px}th,td{border:1px solid rgba(47,109,240,.18);padding:7px 10px;text-align:left}th{background:rgba(47,109,240,.1);font:700 9.5px/1.6 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:#fff}
.k-kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;font-size:12.5px;margin:8px 0}.k-kv dt{font:700 9.5px/1.9 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}.k-kv dd{margin:0;color:var(--text)}
.k-rim{position:fixed;inset:0;pointer-events:none;z-index:9;image-rendering:pixelated}
.k-reveal{position:fixed;inset:0;pointer-events:none;z-index:10;image-rendering:pixelated}
.k-scene{position:relative;height:260px;margin:12px 0;border:1px solid rgba(47,109,240,.22);border-radius:12px;background:radial-gradient(ellipse at 50% 60%,rgba(47,109,240,.18),transparent 65%),rgba(3,6,14,.6);overflow:hidden;display:grid;place-items:center;perspective:700px}.k-scene canvas{position:absolute;inset:0;width:100%;height:100%}
.k-cube{position:relative;width:90px;height:90px;transform-style:preserve-3d;animation:kspin 14s linear infinite}.k-cube i{position:absolute;inset:0;border:1px solid #2f6df0;background:rgba(47,109,240,.1)}.k-cube i:nth-child(1){transform:translateZ(45px)}.k-cube i:nth-child(2){transform:rotateY(180deg) translateZ(45px)}.k-cube i:nth-child(3){transform:rotateY(90deg) translateZ(45px)}.k-cube i:nth-child(4){transform:rotateY(-90deg) translateZ(45px)}.k-cube i:nth-child(5){transform:rotateX(90deg) translateZ(45px)}.k-cube i:nth-child(6){transform:rotateX(-90deg) translateZ(45px)}@keyframes kspin{to{transform:rotateX(-24deg) rotateY(360deg)}}
.k-grow{transform-origin:bottom;animation:kgrow .9s cubic-bezier(.2,.9,.3,1) both;transform-box:fill-box}@keyframes kgrow{from{transform:scaleY(0)}}.k-draw{stroke-dasharray:1200;stroke-dashoffset:1200;animation:kdraw 1.4s ease forwards}@keyframes kdraw{to{stroke-dashoffset:0}}
.k-play,.k-rig,.k-tale{margin:14px 0;border:1px solid #2f6df0;background:rgba(3,6,14,.72);box-shadow:3px 3px 0 #15347a}
.k-sim-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 10px;border-bottom:1px solid #15347a;background:rgba(47,109,240,.1)}
.k-sim-tag{font:700 9.5px/1.3 var(--mono);letter-spacing:.2em;text-transform:uppercase;color:#9cc5ff}
.k-sim-cap{margin:0;padding:8px 12px;font:12px/1.5 var(--mono);color:var(--muted);border-top:1px solid #15347a}
.k-stage{position:relative;min-height:120px;background:radial-gradient(ellipse at 50% 70%,rgba(47,109,240,.16),transparent 65%)}.k-stage canvas{display:block;width:100%;image-rendering:pixelated}
.k-panel{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px 18px;padding:10px 12px;border-top:1px solid #15347a}.k-panel:empty{display:none}
.k-slider{display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:center;font:700 9.5px/1.4 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:#9cc5ff}
.k-slider input{grid-column:1/-1;width:100%;height:14px;margin:0;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer}
.k-slider input::-webkit-slider-runnable-track{height:4px;background:#15347a;border:1px solid #2f6df0}.k-slider input::-moz-range-track{height:4px;background:#15347a;border:1px solid #2f6df0}
.k-slider input::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:14px;margin-top:-6px;background:#f0a32f;border:1px solid #070a13;border-radius:0}.k-slider input::-moz-range-thumb{width:10px;height:14px;background:#f0a32f;border:1px solid #070a13;border-radius:0}
.k-slider input:focus-visible{outline:1px solid #9cc5ff;outline-offset:3px}
.k-slider b{color:#f0a32f;font-weight:800;letter-spacing:.04em}
.k-btn{font:700 9.5px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:#070a13;background:#9cc5ff;border:1px solid #2f6df0;border-radius:0;padding:6px 11px;cursor:pointer;box-shadow:2px 2px 0 #15347a}.k-btn:hover{background:#fff}.k-btn:active{transform:translate(2px,2px);box-shadow:none}.k-btn:focus-visible{outline:1px solid #f0a32f;outline-offset:2px}
.k-sim-btns{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}.k-btn:disabled{opacity:.4;cursor:default;box-shadow:none}
.k-cap{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;padding:9px 12px;border-top:1px solid #15347a;font:13px/1.5 var(--sans);color:var(--text);min-height:44px}.k-cap-n{font:800 11px/1.4 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:#f0a32f}.k-cap-x{flex:1;min-width:0}
.k-prog{flex-basis:100%;height:4px;background:#15347a;border:1px solid #2f6df0}.k-prog span{display:block;height:100%;width:0;background:repeating-linear-gradient(90deg,#2f6df0 0 6px,#9cc5ff 6px 8px)}
.k-chips{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px}.k-chip{background:transparent;color:#9cc5ff;box-shadow:none;padding:5px 9px}.k-chip.on{background:#f0a32f;color:#070a13;border-color:#f0a32f}
.k-insp{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 18px;padding:10px;border:1px solid #f0a32f;background:rgba(240,163,47,.05)}.k-insp-h{grid-column:1/-1;font:800 10.5px/1.4 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:#f0a32f}.k-insp-btns{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px}
.k-color{height:22px;padding:0;border:1px solid #2f6df0;background:#070a13;border-radius:0;cursor:pointer;width:100%}.k-sel{grid-column:1/-1;font:700 11px var(--mono);color:#dfe7ff;background:#070a13;border:1px solid #2f6df0;border-radius:0;padding:4px 6px;text-transform:uppercase}
.k-btn.on{background:#f0a32f;border-color:#f0a32f}
.k-stage{overflow:hidden}.k-backdrop{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;pointer-events:none}.k-stage canvas{position:relative;z-index:1}
.k-hud{position:absolute;left:8px;top:8px;z-index:3;display:flex;flex-direction:column;gap:5px;max-width:min(300px,60%);padding:8px;border:1px solid #2f6df0;background:rgba(7,10,19,.86);box-shadow:3px 3px 0 #15347a}.k-hud:empty{display:none}
.k-hud-h{font:800 10.5px/1.3 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:#f0a32f}.k-hud-t{font:11px/1.45 var(--mono);color:#cfdcff;white-space:pre-wrap}
.k-hud-b{font:700 9.5px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:#9cc5ff;background:transparent;border:1px solid #2f6df0;border-radius:0;padding:6px 9px;cursor:pointer;text-align:left}.k-hud-b:hover{background:rgba(47,109,240,.2)}.k-hud-b.on{background:#f0a32f;color:#070a13;border-color:#f0a32f}
.k-hud-r{display:grid;grid-template-columns:1fr auto;gap:2px 8px;font:700 9px/1.4 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:#9cc5ff}.k-hud-r input,.k-hud-r select{grid-column:1/-1;width:100%}.k-hud-r b{color:#f0a32f}
.k-ref{position:absolute;right:8px;top:8px;width:26%;max-width:230px;border:1px solid #f0a32f;background:#070a13;box-shadow:3px 3px 0 #15347a;z-index:2;cursor:pointer;transition:opacity .2s}
@media(prefers-reduced-motion:reduce){.k-reveal,.k-rim{display:none}.k-cube,.k-grow,.k-draw{animation:none}.k-draw{stroke-dashoffset:0}}
`.trim();

export const FORGE_KIT_JS = `
(function kit(){
  // a page the Forge opens right after showing it live (?settled=1) opens finished: no second resolve / build
  if(/[?&]settled=1/.test(location.search))window.__aresInstant=1;
  // the kit lives in <head>; wait for <body> before touching it
  if(!document.body){document.addEventListener("DOMContentLoaded",kit);return}
  var P=["#07122b","#15347a","#2f6df0","#9cc5ff"];
  function noise(x,y,s){var h=(x*73856093)^(y*19349663)^(s*83492791);h^=h<<13;h^=h>>>17;h^=h<<5;return((h>>>0)%10000)/10000}
  function fit(c){var d=Math.min(2,devicePixelRatio||1),w=innerWidth,h=innerHeight;if(c.width!==w*d||c.height!==h*d){c.width=w*d;c.height=h*d}return{w:w,h:h,d:d}}
  if(matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches)return;
  // resolve-in: the page appears out of pixel blocks, like the Forge itself
  // (a page handed over from the live stage opens already settled: no second resolve)
  if(!window.__aresInstant){var rv=document.createElement("canvas");rv.className="k-reveal";document.body.appendChild(rv);var ctx=rv.getContext("2d"),t0=performance.now(),cell=10;
  (function frame(now){var f=fit(rv),raw=Math.min(1,(now-t0)/720),t=1-Math.pow(1-raw,2.2);ctx.setTransform(f.d,0,0,f.d,0,0);ctx.clearRect(0,0,f.w,f.h);var cols=Math.ceil(f.w/cell),rows=Math.ceil(f.h/cell),cx=cols/2,cy=rows/2,md=Math.hypot(cx,cy)||1;
    for(var y=0;y<rows;y++)for(var x=0;x<cols;x++){var d=Math.hypot(x+.5-cx,y+.5-cy)/md,th=d*.72+noise(x,y,5)*.28;if(th<=t)continue;var e=th-t,tone=e<.04?3:e<.1?2:e<.2?1:0;ctx.fillStyle=P[tone];ctx.fillRect(x*cell,y*cell,cell-1,cell-1)}
    if(raw<1)requestAnimationFrame(frame);else rv.remove()})(t0);}
  // rim: a dotted pixel border with a travelling pulse
  var rc=document.createElement("canvas");rc.className="k-rim";document.body.appendChild(rc);var rx=rc.getContext("2d"),c6=6,start=performance.now();
  (function rim(now){var f=fit(rc);rx.setTransform(f.d,0,0,f.d,0,0);rx.clearRect(0,0,f.w,f.h);var cols=Math.max(2,Math.floor(f.w/c6)),rows=Math.max(2,Math.floor(f.h/c6)),per=[];
    for(var x=0;x<cols;x++)per.push([x,0]);for(var y=1;y<rows;y++)per.push([cols-1,y]);for(x=cols-2;x>=0;x--)per.push([x,rows-1]);for(y=rows-2;y>=1;y--)per.push([0,y]);
    var N=per.length,head=((now-start)%8000)/8000*N;
    for(var i=0;i<N;i++){var p=per[i],n=noise(p[0],p[1],11),tone=-1,b=head-i;if(b<0)b+=N;if(b<4)tone=3;else if(b<12)tone=2;else if(b<26)tone=1;else if(n<.42)tone=0;
      var corner=(p[0]<3&&(p[1]===0||p[1]===rows-1))||(p[0]>cols-4&&(p[1]===0||p[1]===rows-1))||(p[1]<3&&(p[0]===0||p[0]===cols-1))||(p[1]>rows-4&&(p[0]===0||p[0]===cols-1));if(corner)tone=Math.max(tone,2);if(tone<0)continue;
      rx.globalAlpha=tone===0?.5:tone===1?.75:1;rx.fillStyle=P[tone];rx.fillRect(p[0]*c6,p[1]*c6,c6-1,c6-1)}
    rx.globalAlpha=1;requestAnimationFrame(rim)})(start);
  document.querySelectorAll('.k-scene').forEach(function(el){var s=document.createElement('script');s.type='module';s.textContent='import*as T from"https://esm.sh/three@0.160.0";var el=document.getElementById("' + el.id + '"),sh=el.dataset.shape,col=el.dataset.color;try{var r=new T.WebGLRenderer({antialias:true,alpha:true});r.setPixelRatio(Math.min(2,devicePixelRatio));el.appendChild(r.domElement);var sc=new T.Scene(),cam=new T.PerspectiveCamera(45,1,.1,100);cam.position.set(0,0,4.2);var g={cube:new T.BoxGeometry(1.6,1.6,1.6),sphere:new T.SphereGeometry(1.1,24,18),torus:new T.TorusGeometry(1,.38,16,40),pyramid:new T.ConeGeometry(1.2,1.8,4),knot:new T.TorusKnotGeometry(.8,.28,90,12)}[sh]||new T.BoxGeometry(1.6,1.6,1.6);var m=new T.Mesh(g,new T.MeshBasicMaterial({color:col,wireframe:true})),m2=new T.Mesh(g,new T.MeshBasicMaterial({color:col,transparent:true,opacity:.12}));sc.add(m);sc.add(m2);function fit(){var w=el.clientWidth,h=el.clientHeight;r.setSize(w,h,false);cam.aspect=w/h;cam.updateProjectionMatrix()}fit();addEventListener("resize",fit);el.querySelector(".k-cube").style.display="none";(function a(){m.rotation.x+=.006;m.rotation.y+=.01;m2.rotation.copy(m.rotation);r.render(sc,cam);requestAnimationFrame(a)})()}catch(e){}';document.head.appendChild(s)});
  // animated bars + counters
  document.querySelectorAll(".k-bar > span").forEach(function(s){var w=s.getAttribute("data-w")||s.style.width||"0%";s.style.width="0%";requestAnimationFrame(function(){s.style.transition="width 900ms cubic-bezier(.2,.9,.3,1)";s.style.width=w})});
  document.querySelectorAll("[data-count]").forEach(function(el){var to=parseFloat(el.getAttribute("data-count")),dec=(String(to).split(".")[1]||"").length,t1=performance.now();(function tick(n){var k=Math.min(1,(n-t1)/900),v=to*(1-Math.pow(1-k,3));el.textContent=v.toFixed(dec);if(k<1)requestAnimationFrame(tick)})(t1)});
})();
`.trim();

/** Expand the kit marker in a page Ares wrote. Idempotent: a page without the
 *  marker comes back unchanged. */
export function expandForgeKit(html: string, force: readonly ("sim" | "model" | "story")[] = []): string {
  if (!FORGE_KIT_MARKER.test(html)) return html;
  // interactive blocks ship their ES module only on pages that use them
  const mod = (re: RegExp, attr: "sim" | "model" | "story", js: string): string => (re.test(html) || force.includes(attr) ? `<script type="module" data-ares-${attr}>${js}</script>` : "");
  const extra = mod(/\bk-play\b/, "sim", FORGE_SIM_JS) + mod(/\bk-rig\b/, "model", FORGE_MODEL_JS) + mod(/\bk-tale\b/, "story", FORGE_STORY_JS);
  return html.replace(FORGE_KIT_MARKER, () => `<style data-ares-kit>${FORGE_KIT_CSS}</style><script data-ares-kit>${FORGE_KIT_JS}</script>${extra}`);
}

// ── explain: a compact block list → a finished kit page ──────────────────────
// Writing a whole HTML page costs ~280 lines of output (minutes on a small
// model) and failed outright in the field (base64 + a "PLACEHOLDER" preview,
// 2026-10-16). `Browser explain` takes ~500 tokens of blocks and renders the
// page here, so an explainer is fast, always valid, and always on-theme.

type Block = Record<string, unknown>;
const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const tone = (v: unknown): string => (["ok", "warn", "bad"].includes(String(v)) ? ` ${String(v)}` : "");

const MATH_IDS = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "exp", "log", "log2", "log10", "sqrt", "cbrt", "abs", "pow", "min", "max", "floor", "ceil", "round", "sign", "PI", "E"]);
const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,15}$/;
/** A plot formula is evaluated in the page, so it is whitelisted here: only
 *  arithmetic, x, the slider keys and Math names; no property access, strings
 *  or calls to anything else. Returns null when it doesn't pass. */
function safeFormula(raw: unknown, keys: string[]): string | null {
  const f = String(raw ?? "").trim();
  if (!f || f.length > 120 || !/^[0-9A-Za-z_+\-*/%^().,\s]+$/.test(f) || /[A-Za-z_)]\s*\./.test(f)) return null;
  const ok = new Set(["x", ...keys]);
  for (const id of f.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) if (!ok.has(id) && !MATH_IDS.has(id) && !/^\d+e\d+$/i.test(id)) return null;
  return f.replace(/\^/g, "**");
}
const num = (v: unknown, d: number): number => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : d);
function simParams(v: unknown): Block[] {
  return arr(v).slice(0, 6).flatMap((c) => {
    const p = c as Block; const key = String(p.key ?? "");
    if (!KEY_RE.test(key)) return [];
    const min = num(p.min, 0), max = Math.max(min + 1e-6, num(p.max, 10));
    return [{ key, label: String(p.label ?? key).slice(0, 32), min, max, value: Math.min(max, Math.max(min, num(p.value, min))), step: num(p.step, (max - min) / 100) || (max - min) / 100 }];
  });
}
const playDiv = (spec: Block, cls = "k-play"): string => `<div class="${cls}" data-spec="${esc(JSON.stringify(spec))}"></div>`;

function renderBlock(b: Block): string {
  switch (b.type) {
    case "text":
      return `<p>${esc(b.text)}</p>`;
    case "heading":
      return `<h2>${esc(b.text)}</h2>`;
    case "cards":
      return `<div class="k-grid">${arr(b.items).map((c) => { const x = c as Block; return `<div class="k-card"><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p></div>`; }).join("")}</div>`;
    case "stats":
      return `<div class="k-grid">${arr(b.items).map((c) => { const x = c as Block; const n = Number(x.value); const num = Number.isFinite(n) ? `<b class="${esc(x.tone ?? "")}" data-count="${n}">0</b>` : `<b class="${esc(x.tone ?? "")}">${esc(x.value)}</b>`; return `<div class="k-card k-stat"><small>${esc(x.label)}</small>${num}${x.note ? `<p>${esc(x.note)}</p>` : ""}</div>`; }).join("")}</div>`;
    case "steps":
      return `<ol class="k-steps">${arr(b.items).map((c) => { const x = c as Block; return `<li class="${esc(x.state ?? "")}"><b>${esc(x.title)}</b>${esc(x.text)}</li>`; }).join("")}</ol>`;
    case "timeline":
      return `<div class="k-timeline">${arr(b.items).map((c) => { const x = c as Block; return `<div><time>${esc(x.when)}</time><b style="color:#fff">${esc(x.title)}</b> ${esc(x.text)}</div>`; }).join("")}</div>`;
    case "pills":
      return `<div class="k-pills">${arr(b.items).map((c) => { const x = c as Block; return `<span class="k-pill${tone(x.tone)}"><i></i>${esc(x.text)}</span>`; }).join("")}</div>`;
    case "bars":
      return arr(b.items).map((c) => { const x = c as Block; return `<div class="k-label" style="margin-top:8px;font:700 9.5px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--faint)">${esc(x.label)} · ${esc(x.value)}%</div><div class="k-bar"><span data-w="${Math.max(0, Math.min(100, Number(x.value) || 0))}%"></span></div>`; }).join("");
    case "callout":
      return `<div class="k-callout${tone(b.tone)}"><b>${esc(b.title)}</b>${esc(b.text)}</div>`;
    case "kv":
      return `<dl class="k-kv">${arr(b.items).map((c) => { const x = c as Block; return `<dt>${esc(x.key)}</dt><dd>${esc(x.value)}</dd>`; }).join("")}</dl>`;
    case "table": {
      const cols = arr(b.columns), rows = arr(b.rows);
      return `<table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${arr(r).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
    }
    case "code":
      return `<pre><code>${esc(b.text)}</code></pre>`;
    case "chart": {
      const labels = arr(b.labels).map(String), vals = arr(b.values).map((v) => Number(v) || 0);
      const max = Math.max(1, ...vals), W = 560, H = 190, pad = 26, n = Math.max(1, vals.length);
      const kind = String(b.kind || "bar");
      if (kind === "donut") {
        const sum = vals.reduce((a, c) => a + c, 0) || 1; let acc = 0; const R = 70, C = 2 * Math.PI * R; const cols = ["#2f6df0", "#f0a32f", "#7ef0c3", "#ff8a6a", "#9cc5ff", "#c78bff"];
        const segs = vals.map((v, i) => { const len = (v / sum) * C; const s = `<circle r="${R}" cx="95" cy="95" fill="none" stroke="${cols[i % cols.length]}" stroke-width="26" stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}" stroke-dashoffset="${(-acc).toFixed(1)}" transform="rotate(-90 95 95)"/>`; acc += len; return s; }).join("");
        const leg = labels.map((l, i) => `<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--muted)"><i style="width:9px;height:9px;background:${cols[i % cols.length]}"></i>${esc(l)} · ${esc(vals[i])}</div>`).join("");
        return `<div style="display:flex;gap:22px;align-items:center;flex-wrap:wrap;margin:12px 0"><svg width="190" height="190" viewBox="0 0 190 190">${segs}</svg><div style="display:grid;gap:6px">${leg}</div></div>`;
      }
      const bw = (W - pad * 2) / n;
      const x = (i: number) => pad + i * bw + bw / 2, y = (v: number) => H - pad - (v / max) * (H - pad * 2);
      const body = kind === "line"
        ? `<polyline class="k-draw" fill="none" stroke="#2f6df0" stroke-width="2.4" points="${vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>${vals.map((v, i) => `<rect x="${(x(i) - 3).toFixed(1)}" y="${(y(v) - 3).toFixed(1)}" width="6" height="6" fill="#9cc5ff"/>`).join("")}`
        : vals.map((v, i) => `<rect class="k-grow" x="${(x(i) - bw * 0.3).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw * 0.6).toFixed(1)}" height="${(H - pad - y(v)).toFixed(1)}" fill="#2f6df0"/>`).join("");
      const ax = labels.map((l, i) => `<text x="${x(i).toFixed(1)}" y="${H - 8}" fill="#8da0c8" font-size="9.5" text-anchor="middle" font-family="monospace">${esc(l)}</text>`).join("");
      return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:640px;margin:12px 0"><line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="rgba(47,109,240,.35)"/>${body}${ax}</svg>`;
    }
    case "diagram": {
      const nodes = arr(b.nodes).map((c) => c as Block);
      const w = 150, h = 46, gap = 54, cols = Math.min(4, nodes.length || 1);
      const pos = new Map<string, [number, number]>();
      nodes.forEach((nd, i) => pos.set(String(nd.id ?? i), [20 + (i % cols) * (w + gap), 20 + Math.floor(i / cols) * (h + 50)]));
      const rows = Math.ceil(nodes.length / cols), W = 40 + cols * (w + gap) - gap, H = 40 + rows * (h + 50) - 30;
      const links = arr(b.links).map((l) => arr(l).map(String)).map(([a, c]) => { const p = pos.get(a!), q = pos.get(c!); if (!p || !q) return ""; const same = p[1] === q[1]; const x1 = same ? p[0] + w : p[0] + w / 2, y1 = same ? p[1] + h / 2 : p[1] + h, x2 = same ? q[0] : q[0] + w / 2, y2 = same ? q[1] + h / 2 : q[1]; return `<line class="k-draw" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#9cc5ff" stroke-width="1.6" marker-end="url(#k-arrow)"/>`; }).join("");
      const boxes = nodes.map((nd, i) => { const [px, py] = pos.get(String(nd.id ?? i))!; return `<rect x="${px}" y="${py}" width="${w}" height="${h}" fill="rgba(47,109,240,.12)" stroke="#2f6df0"/><text x="${px + w / 2}" y="${py + h / 2 + 4}" fill="#fff" font-size="11" text-anchor="middle" font-family="monospace">${esc(nd.text ?? nd.id)}</text>`; }).join("");
      return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;margin:12px 0"><defs><marker id="k-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#9cc5ff"/></marker></defs>${links}${boxes}</svg>`;
    }
    case "model": {
      const m = sanitizeModel(b);
      return (m.parts as unknown[]).length ? playDiv(m, "k-rig") : "";
    }
    case "story": {
      const st = sanitizeStory(b);
      return (st.scenes as unknown[]).length ? playDiv(st, "k-tale") : "";
    }
    case "sim": {
      const kind = ["projectile", "pendulum", "orbit", "plot"].includes(String(b.kind)) ? String(b.kind) : "projectile";
      let params = simParams(b.params);
      const spec: Block = { kind, caption: b.caption ? String(b.caption).slice(0, 240) : undefined };
      if (kind === "plot") {
        if (!params.length) params = simParams([{ key: "a", min: 0, max: 5, value: 2, step: 0.1 }, { key: "b", min: 0.2, max: 6, value: 1.5, step: 0.1 }]);
        spec.formula = safeFormula(b.formula, params.map((p) => String(p.key))) ?? "a*sin(b*x)";
        spec.xmin = num(b.xmin, -10);
        spec.xmax = num(b.xmax, 10);
      }
      if (params.length) spec.params = params;
      return playDiv(spec);
    }
    case "scene3d": {
      const shape = ["cube", "sphere", "torus", "pyramid", "knot"].includes(String(b.shape)) ? String(b.shape) : "cube";
      const colour = /^#[0-9a-fA-F]{6}$/.test(String(b.color)) ? String(b.color) : "#2f6df0";
      if (b.interactive === true || b.controls) {
        const ctl = Array.isArray(b.controls) ? simParams(b.controls) : [];
        return playDiv({ kind: "shape", shape, color: colour, caption: b.caption ? String(b.caption).slice(0, 240) : undefined, ...(ctl.length ? { params: ctl } : {}) });
      }
      const id = `s3d${Math.floor(Math.random() * 1e6)}`;
      return `<div class="k-scene" id="${id}" data-shape="${shape}" data-color="${esc(b.color ?? "#2f6df0")}"><div class="k-cube"><i></i><i></i><i></i><i></i><i></i><i></i></div></div>${b.caption ? `<p style="text-align:center;font-size:12px">${esc(b.caption)}</p>` : ""}`;
    }
    default:
      return "";
  }
}

/** Render a finished explainer page from { title, eyebrow?, blocks[] }. */
export function renderExplainer(spec: { title?: unknown; eyebrow?: unknown; blocks?: unknown }): string {
  const title = esc(spec.title || "Explainer");
  const body = arr(spec.blocks).map((b) => renderBlock((b ?? {}) as Block)).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><!--ares:kit--></head><body><div class="k-eyebrow">${esc(spec.eyebrow || "Ares · explainer")}</div><h1>${title}</h1>\n${body}\n</body></html>`;
}

/** The empty page the Forge shows while a `model` / `story` block is still being
 *  written: engines in live mode, fed by postMessage (see forgeLive). */
export function buildLiveStageHtml(): string {
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Building live</title><!--ares:kit--></head><body><div class="k-eyebrow">Ares · building live</div><div id="lv-host"></div><script data-ares-live>${LIVE_RUNTIME_JS}</script></body></html>`;
  return expandForgeKit(page, ["model", "story"]);
}

/** The persistent model-studio page: an empty live rig that polls /__ares/studio/<id> (see modelStudio.ts). */
export function buildStudioHtml(id: string, title = "Model studio"): string {
  const spec = esc(JSON.stringify({ studio: id, parts: [], title }));
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><!--ares:kit--></head><body><div class="k-eyebrow">Ares · model studio</div><h1>${esc(title)}</h1><div class="k-rig" data-spec="${spec}"></div></body></html>`;
  return expandForgeKit(page);
}
