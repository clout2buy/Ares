// On-demand documentation for studio scripts: `Browser action:"model" help:true`
// returns this. Ares reads it when it needs to build something the engine has
// no feature for (water, lava, rain, textures, physics, in-scene controls) so
// the always-on prompt stays small. The examples are patterns to adapt, not
// engine features: nothing in the studio knows what a "pond" or a "chest" is.

export const FORGE_SCRIPT_DOCS = `STUDIO SCRIPTS — write the behaviour yourself.
A script is {name, code}. code defines any of: function init(api){...} (may be async), function update(api){...} (every frame), function cleanup(api){...}.
Edit a script by sending the same name again; the old one is cleaned up (everything it add()ed is removed). Errors come back in the tool result (problems / scriptLogs) - read them, fix, resend.

api:
  THREE, scene, camera, renderer, root          three.js r160 + the live scene
  time, dt, state{}                             seconds since the script started, frame delta, your own memory
  part(name) -> {group, mesh, geometry, node, spec} | null      a model part (mesh.material, geometry.attributes.position...)
  parts() -> list of the same                   every part
  add(obj3d) / remove(obj3d)                    put your own meshes/lights/points in the scene (auto-disposed on change)
  on(event, fn) / emit(event, data)             events: "parts" (parts were rebuilt - re-apply material/texture tweaks), "key" {code,key,down},
                                                "click" {point:[x,y,z], part|null}, plus any clip event {t,name,data} from an animation
  canvasTexture(w,h,draw(ctx,w,h),{repeat:[x,y], pixel:true}) -> THREE.CanvasTexture   procedural textures (pixel:true = crisp nearest-neighbour)
  noise(x,y,z), fbm(x,y,z,octaves)              smooth value noise 0..1
  rand()                                        seeded 0..1
  lib(name) -> Promise                          real physics: "cannon-es", "rapier"
  ui.title/text/button/toggle/slider/select     a control panel over the stage (variants, open/close, LOD, debug toggles); ui.text(...).set(str) for live readouts
  stats() -> {draws, tris, parts}               draw calls / triangles right now
  log(msg)                                      comes back to you in the tool result

PATTERNS (adapt them; they are examples, not features):

1) Procedural pixel texture on a part (wood planks):
   function init(api){
     function apply(){
       var p = api.part("lid"); if(!p) return;
       p.mesh.material.map = api.canvasTexture(64,64,function(x,w,h){
         for(var j=0;j<h;j++)for(var i=0;i<w;i++){var g=api.fbm(i*0.12,j*0.9,0,3),plank=(j%16===0)?0.55:1;
           x.fillStyle="rgb("+Math.round((90+60*g)*plank)+","+Math.round((52+36*g)*plank)+","+Math.round((24+18*g)*plank)+")";x.fillRect(i,j,1,1)}},{repeat:[2,1]});
       p.mesh.material.color.set(0xffffff); p.mesh.material.vertexColors=false; p.mesh.material.needsUpdate=true;
     }
     apply(); api.on("parts", apply);
   }

2) Live water (you build the surface; ripples come from a clip event or a click):
   function init(api){
     var T=api.THREE, g=new T.PlaneGeometry(4,4,64,64); g.rotateX(-Math.PI/2);
     var base=g.attributes.position.array.slice(), m=new T.Mesh(g,new T.MeshPhysicalMaterial({color:0x4f9fd6,roughness:0.05,transparent:true,opacity:0.8,clearcoat:1}));
     m.position.set(0,0.03,3.6); api.add(m); var rip=[];
     api.on("splash",function(d){rip.push({x:d.x,z:d.z,t:api.time})});            // clip event {t:1.2,name:"splash",data:{x:0,z:2.4}}
     api.on("click",function(d){if(d.part===null||d.part==="ground")rip.push({x:d.point[0],z:d.point[2],t:api.time})});
     api.state.tick=function(){var p=g.attributes.position;for(var k=0;k<p.count;k++){var x=base[3*k]+m.position.x,z=base[3*k+2]+m.position.z,
       y=0.02*Math.sin(x*2+api.time*1.3)+0.015*Math.sin(z*3-api.time);
       rip.forEach(function(r){var age=api.time-r.t,d=Math.hypot(x-r.x,z-r.z);if(age<5)y+=0.09*Math.sin(9*(d-1.6*age))*Math.exp(-1.2*age-0.9*d)});
       p.setY(k,y)}p.needsUpdate=true;g.computeVertexNormals()};
   }
   function update(api){api.state.tick()}
   (Lava = same idea with an emissive colour animated by fbm; rain = a THREE.Points system you move in update(); wind = sin offsets on a part's geometry.)

3) Controls + live stats (variants, open/close, toggles):
   function init(api){
     api.ui.title("Chest kit"); var s=api.ui.text("");
     api.ui.select("Variant",["wooden","iron","frost"],"wooden",function(v){api.state.variant=v; /* recolour parts */});
     api.ui.toggle("Open",false,function(on){api.emit("open",on)});
     api.ui.slider("Light",0,3,1.2,function(v){/* scene lights */});
     api.state.s=s;
   }
   function update(api){var st=api.stats();api.state.s.set("tris "+st.tris+" - draws "+st.draws)}

4) Physics: var C=await api.lib("cannon-es") inside an async init; build a world, mirror bodies to your meshes in update (world.step(1/60, dt)).

5) Game integration (put the model INTO the game, like a real asset):
   Browser model {export:true}  ->  assets/ares-model.js + assets/models/<id>.game.json   (export:"src/lib" changes the folder; three:"<url>" if the game has no import map)
   In the game:   import { loadModel, attachScripts } from "./assets/ares-model.js";
                  const m = await loadModel("assets/models/chest.game.json");
                  const chest = m.instance({ material: (part, shared) => tinted(part, shared) });  // instances share geometry; override materials for variants
                  scene.add(chest.group); chest.group.position.set(x,0,z); chest.play("open",{loop:false});   // each frame: chest.update(dt)
                  chest.on("lid-up", fn); chest.part("lid"); chest.triangles();
   Model scripts (water, glow...) are NOT run in the game unless you call attachScripts(m, chest, {scene,camera,renderer}); skip them when they would cost too much there.
   Same core as the studio: geometry, facet colours, joints, clips and events match. Then Edit the game's own code to place instances, load it with Browser preview, and check it in the real game from every side.

Not in the engine on purpose: water, lava, rain, fire, wind, textures, UI, physics. Write them.`;
