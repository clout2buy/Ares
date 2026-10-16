// The Ares model runtime: a standalone ES module that loads a model built in the
// Forge studio into ANY three.js game. `Browser model export` writes it into the
// project next to the model's `<id>.game.json`; the game then does
//
//   import { loadModel } from "./ares-model.js";
//   const chest = await loadModel("assets/models/chest.game.json");
//   const a = chest.instance();          // cheap: geometry + materials are shared
//   scene.add(a.group); a.play("open");  // a.update(dt) each frame
//
// It is built from the SAME core as the studio page (forgeModelCore.ts), so a
// model has the same geometry, facet colours, materials, joints and animation in
// the game as on the stage. No lights, camera or renderer: the game owns those.
//
// TypeScript template literal: NO backticks, NO dollar-brace, NO backslashes.

import { FORGE_MODEL_CORE_JS } from "./forgeModelCore.js";

const RUNTIME_BODY = `
var LIBS={"cannon-es":"https://esm.sh/cannon-es@0.20.0","rapier":"https://esm.sh/@dimforge/rapier3d-compat@0.12.1"};
function mkEvents(){var L={};return{on:function(n,f){(L[n]=L[n]||[]).push(f);return function(){var k=(L[n]||[]).indexOf(f);if(k>=0)L[n].splice(k,1)}},emit:function(n,d){(L[n]||[]).slice().forEach(function(f){f(d)})}}}

export function buildModel(doc,opts){
  opts=opts||{};
  if(!doc||doc.expanded!==true||!Array.isArray(doc.parts))throw new Error("ares-model: pass the <id>.game.json that Browser model export writes");
  var parts=snapParts(doc.parts),clips={},cache={},variants=doc.variants||{};
  function vhit(sel,name){var base=name.replace(/ [(]mirror[)]$/,"");return sel.charAt(sel.length-1)==="*"?base.indexOf(sel.slice(0,-1))===0:(sel===name||sel===base)}
  function partFor(p,variant){var v=variant&&variants[variant];if(!v)return p;var q=p;Object.keys(v).forEach(function(sel){if(vhit(sel,p.name))q=Object.assign({},q,v[sel])});return q}
  (doc.anims||[]).forEach(function(c){clips[c.name]=c});
  var model={doc:doc,clips:Object.keys(clips),variants:Object.keys(variants),instance:null,dispose:function(){Object.keys(cache).forEach(function(k){var c=cache[k];if(c.gm)c.gm.dispose();if(c.m&&c.m.dispose)c.m.dispose()})}};

  // io: {variant:"frost", edges, shadows:false, material(part, shared) -> per-instance material override}
  model.instance=function(io){
    io=io||{};
    var group=new T.Group(),items=[],nodes=[],byName={},ev=mkEvents(),cur=null,clock=0,playing=false,speed=1,loop=true,hold=false;
    group.name=doc.title||"ares-model";
    parts.forEach(function(p,i){
      var vk=(io.variant||"")+":"+i,pv0=partFor(p,io.variant);cache[vk]=cache[vk]||{};
      var g=buildPartObject(pv0,{edges:!!(io.edges||opts.edges),cache:cache[vk]});
      if(io.material){var m2=io.material(p,g.userData.mat);if(m2)g.userData.mesh.material=m2}
      if(io.shadows===false||opts.shadows===false)g.traverse(function(o){if(o.isMesh){o.castShadow=false;o.receiveShadow=false}});
      var node=new T.Group(),pv=p.pivot||p.pos;node.add(g);node.position.set(pv[0],pv[1],pv[2]);node.userData.rest=node.position.clone();
      group.add(node);items.push(g);nodes.push(node);if(!byName[p.name])byName[p.name]={group:g,mesh:g.userData.mesh,node:node,spec:p};
    });
    rigLink(parts,nodes,group);skinLink(parts,nodes,items);
    function pose(c,t){rigApply(parts,nodes,c,t)}
    function rest(){nodes.forEach(function(nd){nd.rotation.set(0,0,0);nd.scale.set(1,1,1);nd.position.copy(nd.userData.rest)})}
    var inst={group:group,part:function(n){return byName[n]||null},parts:function(){return parts.map(function(p){return byName[p.name]})},
      on:ev.on,emit:ev.emit,
      triangles:function(){var n=0;group.traverse(function(o){if(o.isMesh&&o.geometry){var g=o.geometry;n+=(g.index?g.index.count:g.attributes.position.count)/3}});return n},
      get playing(){return playing},get clip(){return cur?cur.name:null},get time(){return clock},
      // play(name,{loop,speed,restart}); a clip with loop:false holds its last pose and emits "end"
      play:function(name,o){var c=clips[name];if(!c)throw new Error("ares-model: no clip "+name+" (have: "+model.clips.join(", ")+")");o=o||{};if(cur===c&&playing&&!o.restart)return inst;cur=c;clock=0;playing=true;hold=false;speed=o.speed||1;loop=o.loop!==undefined?o.loop:c.loop!==false;pose(c,0);return inst},
      stop:function(){playing=false;cur=null;rest();return inst},
      update:function(dt){
        if(!playing||!cur)return inst;
        var d=cur.dur||1,prev=clock;clock+=dt*speed;
        if(!loop&&clock>=d){clock=d;playing=false;hold=true}
        pose(cur,clock);
        (cur.events||[]).forEach(function(e){var a=((prev%d)+d)%d,b=((clock%d)+d)%d,hit=b>=a?(e.t>a&&e.t<=b):(e.t>a||e.t<=b);if(!loop&&clock>=d&&prev<d&&e.t<=d&&e.t>a)hit=true;if(hit)ev.emit(e.name,e.data)});
        if(hold){hold=false;ev.emit("end",cur.name)}
        return inst},
      // frees this instance (edges, caps, per-instance materials); the model's shared geometry/materials stay until model.dispose()
      dispose:function(){var keep=new Set();Object.keys(cache).forEach(function(k){var c=cache[k];if(c.gm)keep.add(c.gm);if(c.m)keep.add(c.m)});disposeObject(group,keep);group.removeFromParent();nodes.forEach(function(nd){nd.removeFromParent()})}};
    return inst};
  return model}

export function loadModel(url,opts){
  return fetch(url).then(function(r){if(!r.ok)throw new Error("ares-model: "+url+" -> "+r.status);return r.json()}).then(function(d){return buildModel(d,opts)})}

// Optional: run the model's authored scripts (water, glow, rain...) inside THIS game.
// ctx: {scene, camera, renderer} ; returns {update(dt), dispose()}. The control-panel api (ui) is a no-op here.
export function attachScripts(model,instance,ctx){
  ctx=ctx||{};var runs=[],clock=0,created=[],none=function(){return{set:function(){}}};
  (model.doc.scripts||[]).filter(function(s){return s.enabled!==false}).forEach(function(s){
    var seed=hash(s.name),owned=[],offs=[],api={THREE:T,scene:ctx.scene,camera:ctx.camera,renderer:ctx.renderer,root:instance.group,time:0,dt:0,state:{},
      part:instance.part,parts:instance.parts,add:function(o){(ctx.scene||instance.group).add(o);owned.push(o);return o},remove:function(o){o.removeFromParent();var k=owned.indexOf(o);if(k>=0)owned.splice(k,1)},
      on:function(n,f){var off=instance.on(n,f);offs.push(off);return off},emit:instance.emit,lib:function(n){var u=(ctx.libs&&ctx.libs[n])||LIBS[n];return u?import(u):Promise.reject(new Error("unknown lib "+n))},
      rand:function(){seed=(Math.imul(seed,1664525)+1013904223)|0;return((seed>>>0)%1000003)/1000003},noise:noise3,fbm:fbm,
      log:function(m){console.log("[ares-model "+s.name+"] "+m)},stats:function(){var i=ctx.renderer&&ctx.renderer.info;return i?{draws:i.render.calls,tris:i.render.triangles,parts:parts_len(model)}:{draws:0,tris:0,parts:0}},
      canvasTexture:function(w,h,d,o){var t=makeCanvasTexture(w,h,d,o);owned.push({dispose:function(){t.dispose()}});return t},ui:{title:none,text:none,button:none,toggle:none,slider:none,select:none}};
    var NL=String.fromCharCode(10),fns;
    try{fns=new Function("api","'use strict';"+NL+s.code+NL+";return {init:typeof init==='function'?init:null,update:typeof update==='function'?update:null,cleanup:typeof cleanup==='function'?cleanup:null};")(api)}catch(e){console.error("[ares-model "+s.name+"] compile: "+e.message);return}
    var run={api:api,fns:fns,ready:false,dead:false,owned:owned,offs:offs};runs.push(run);
    try{Promise.resolve(fns.init?fns.init(api):0).then(function(){run.ready=true},function(e){run.dead=true;console.error("[ares-model "+s.name+"] init: "+(e&&e.message||e))})}catch(e){run.dead=true;console.error("[ares-model "+s.name+"] init: "+e.message)}});
  return{update:function(dt){clock+=dt;runs.forEach(function(r){if(!r.ready||r.dead||!r.fns.update)return;r.api.time=clock;r.api.dt=dt;try{r.fns.update(r.api)}catch(e){r.dead=true;console.error("[ares-model] update: "+e.message)}})},
    dispose:function(){runs.forEach(function(r){r.offs.forEach(function(f){f()});try{if(r.fns&&r.fns.cleanup)r.fns.cleanup(r.api)}catch(e){}r.owned.forEach(function(o){if(o.removeFromParent)o.removeFromParent();if(o.dispose)o.dispose();if(o.geometry&&o.geometry.dispose)o.geometry.dispose();if(o.material&&o.material.dispose)o.material.dispose()})});runs.length=0}}}
function parts_len(model){return model.doc.parts.length}
`;

/** The runtime as ES module text. `three` is the import specifier the game resolves (bare "three" with an import map, or a URL). */
export function buildRuntimeModule(three = "three"): string {
  return `// Generated by Ares (Browser model export). Edit the model in the Forge and re-export; do not hand-edit this file.\nimport * as T from ${JSON.stringify(three)};\n${FORGE_MODEL_CORE_JS}\n${RUNTIME_BODY.trim()}\n`;
}
