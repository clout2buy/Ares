// On-demand documentation for studio scripts: `Browser action:"model" help:true`
// returns this. Ares reads it when it needs to build something the engine has
// no feature for (water, lava, rain, textures, physics, in-scene controls) so
// the always-on prompt stays small. The examples are patterns to adapt, not
// engine features: nothing in the studio knows what a "pond" or a "chest" is.

export const FORGE_SCRIPT_DOCS = `SCULPT: creatures, characters, anything organic (animals, people, monsters, food, plants, blobs).
Do NOT stack spheres/cylinders/lofts for a living thing: that is the toy look. Use ONE sculpt part whose blobs MELT together like clay
into a single smooth mesh (one surface, real silhouettes, soft creases that darken on their own), bend it with joints, snap eyes/nose/claws on.
  {name:"body", shape:"sculpt", mat:"fur"|"skin"|"clay"|"matte"|"plastic", color:"#5b3a22" (default blob colour), blobs:[...],
   res?:64 (mesh detail; 96 for a close-up hero, 24 + style lowpoly = faceted low-poly), tint?:0.06 (organic colour variation),
   fuzz?:0.5 (fur grain, mat fur), ao?:1 (crease darkening), noise?:{amp:0.01,scale:8} (lumpy rock/bark/skin surface)}
Blobs (applied IN ORDER: each melts into or carves what is already there):
  {id:"chest", s:"ball", at:[x,y,z], r:[rx,ry,rz], rot?:[deg]}      masses: chest, belly, hips, skull, cheeks, muscles, ears (flattened)
  {id:"neck",  s:"stick", at:[x,y,z], to:[x,y,z], r:0.3, r2:0.2}    tapered: limbs, neck, muzzle, tail, horns, fingers
  {id:"tail",  s:"chain", pts:[[x,y,z,r],[x,y,z,r],...]}            a bent limb / tail / neck / tentacle in one blob
  {id:"hoof",  s:"box", at, r:[half sizes], round:0.03, rot?}       hooves, blocky toys, armour plates
  k: how far it melts in (0.02 crisp seam .. 0.3 soft clay). Big masses 0.2-0.3; a limb into the body 0.08-0.15; small features 0.03-0.08.
  sub:true  carves (eye sockets, nostrils, mouth line, ear hollows) - keep carves shallow and small.
  paint:true, soft:0.05  colour ONLY, never changes the shape: the skin INSIDE the blob takes its colour, feathered over soft beyond it.
                         Muzzle, belly, bib, socks, stripes, spots, inner ears, tail tip, a grizzled back.
  color (per blob), bone:"legF" (the joint it bends with), mirror:true (adds the left/right copy; its bone becomes "legF (mirror)").
  Edit one blob without re-sending all of them: {op:"blob", name:"body", id:"muzzle", r2:0.08} | {op:"blob",name:"body",id:"horn",s:"stick",...} (new id = add) | {..., remove:true}.
Joints: {name:"legF", shape:"joint", pos:[x,y,z] (= the pivot: shoulder, elbow, hip, knee, neck base, tail base), parent?:"...", mirror:true}.
  Invisible bones. Blobs with bone:"legF" bend with it; weights blend where blobs melt, so ONE skin bends smoothly at the joint. Clips animate joints like any part.
Snap: rigid parts that sit ON the skin: {name:"eye", shape:"sphere", size:0.06, mat:"glossy", color:"#120c08", pos:[rough spot], snap:"body", out:-0.01, parent:"head", mirror:true}
  pos is projected to the nearest surface point, then pushed along the normal by out (negative = sunk in). align:true turns the part's +y to the normal (horns, spikes, claws, fins).

METHOD - what separates a real model from a toy (do it in this order, LOOK at views after each step):
 1. Proportions before anything. From the reference picture (ref) or anatomy you know: body length, shoulder height, head size, leg length, tail.
    Bear: shoulder hump higher than the rump, small head, short thick plantigrade legs (whole foot flat). Fox/dog/cat: slim, digitigrade (walks on toes, hock bends BACK).
    Horse/deer: long legs, hooves, deep chest, long head. Human: head = 1/7.5 of height, shoulders 2 heads wide, elbows at the waist, wrists at the crotch.
 2. Primary masses: 3-5 big overlapping balls (chest, belly, hips / skull). Check side + top: is the silhouette right? Fix it BEFORE any detail.
 3. Limbs: sticks from INSIDE the mass to the joint and on (upper segment thicker), flattened balls for paws/feet. Bones on every segment.
 4. Head: skull ball, tapered muzzle stick, cheek/brow/jaw balls; ears = flattened rotated balls with a dark paint inside.
 5. Snap features: eyes ON the surface (glossy, about 1/10 of the head width), nose, claws/teeth/horns (align:true).
 6. Paint: lighter muzzle/belly/chest, darker legs, markings - soft paint blobs; mat "fur" + tint 0.06-0.1 for fur.
 7. Joints at the real anatomical pivots; clips swing them (walk = legs in opposite phase, pawF/knees bend a beat later).
 8. views ["side","front","top","3q"] (and "side@0.4" for a pose). Compare with the reference; fix with op blob; repeat until it reads at a glance.
WORKED EXAMPLE - a grizzly (adapt the method, not the numbers):
 {name:"body",shape:"sculpt",mat:"fur",color:"#5b3a22",tint:0.08,blobs:[
  {id:"chest",s:"ball",at:[0,1.05,0.5],r:[0.5,0.5,0.58]}, {id:"hump",s:"ball",at:[0,1.42,0.42],r:[0.36,0.24,0.4],k:0.3},
  {id:"belly",s:"ball",at:[0,0.95,-0.15],r:[0.52,0.48,0.62],k:0.3}, {id:"hips",s:"ball",at:[0,1,-0.72],r:[0.46,0.46,0.46],k:0.3},
  {id:"rump",s:"ball",at:[0,1.16,-0.78],r:[0.36,0.26,0.38],k:0.2},
  {id:"neck",s:"stick",at:[0,1.18,0.8],to:[0,1.2,1.12],r:0.38,r2:0.3,k:0.18,bone:"head"},
  {id:"skull",s:"ball",at:[0,1.22,1.24],r:[0.3,0.28,0.3],k:0.12,bone:"head"},
  {id:"cheek",s:"ball",at:[0.16,1.12,1.3],r:[0.16,0.16,0.18],k:0.1,bone:"head",mirror:true},
  {id:"brow",s:"ball",at:[0,1.3,1.4],r:[0.19,0.08,0.12],k:0.1,bone:"head"},
  {id:"muzzle",s:"stick",at:[0,1.15,1.38],to:[0,1.07,1.8],r:0.165,r2:0.1,k:0.12,color:"#b48c60",bone:"head"},
  {id:"chin",s:"ball",at:[0,1,1.62],r:[0.1,0.05,0.14],k:0.06,color:"#b48c60",bone:"head"},
  {id:"ear",s:"ball",at:[0.23,1.46,1.16],r:[0.09,0.09,0.05],rot:[0,0,-20],k:0.06,bone:"head",mirror:true},
  {id:"earIn",s:"ball",at:[0.235,1.46,1.22],r:[0.05,0.05,0.04],paint:true,soft:0.02,color:"#2e1d12",mirror:true},
  {id:"shoulder",s:"ball",at:[0.3,1.02,0.58],r:[0.2,0.34,0.28],k:0.2,bone:"legF",mirror:true},
  {id:"arm",s:"stick",at:[0.32,0.95,0.6],to:[0.33,0.55,0.64],r:0.22,r2:0.18,k:0.08,bone:"legF",mirror:true},
  {id:"forearm",s:"stick",at:[0.33,0.55,0.64],to:[0.33,0.16,0.66],r:0.18,r2:0.15,k:0.06,bone:"pawF",mirror:true},
  {id:"pawF",s:"ball",at:[0.33,0.085,0.74],r:[0.16,0.085,0.21],k:0.06,color:"#2e1d12",bone:"pawF",mirror:true},
  {id:"thigh",s:"ball",at:[0.3,0.92,-0.72],r:[0.22,0.36,0.33],k:0.2,bone:"legB",mirror:true},
  {id:"shin",s:"stick",at:[0.32,0.7,-0.62],to:[0.33,0.32,-0.82],r:0.2,r2:0.15,k:0.08,bone:"legB",mirror:true},
  {id:"heel",s:"stick",at:[0.33,0.32,-0.82],to:[0.33,0.1,-0.84],r:0.15,r2:0.13,k:0.05,bone:"pawB",mirror:true},
  {id:"foot",s:"stick",at:[0.33,0.08,-0.86],to:[0.33,0.075,-0.6],r:0.11,r2:0.13,k:0.06,color:"#2e1d12",bone:"pawB",mirror:true},
  {id:"tail",s:"ball",at:[0,1.06,-1.2],r:[0.09,0.08,0.08],k:0.06},
  {id:"grizzle",s:"ball",at:[0,1.5,0.3],r:[0.42,0.25,0.65],paint:true,soft:0.18,color:"#9a7348"},
  {id:"legsF",s:"ball",at:[0.33,0.25,0.65],r:[0.22,0.32,0.25],paint:true,soft:0.12,color:"#2e1d12",mirror:true},
  {id:"legsB",s:"ball",at:[0.33,0.25,-0.8],r:[0.22,0.3,0.25],paint:true,soft:0.12,color:"#2e1d12",mirror:true}]},
 {name:"head",shape:"joint",pos:[0,1.2,0.92]}, {name:"legF",shape:"joint",pos:[0.32,1,0.6],mirror:true},
 {name:"pawF",shape:"joint",pos:[0.33,0.55,0.64],parent:"legF",mirror:true}, {name:"legB",shape:"joint",pos:[0.32,0.9,-0.66],mirror:true},
 {name:"pawB",shape:"joint",pos:[0.33,0.32,-0.82],parent:"legB",mirror:true},
 {name:"eye",shape:"sphere",pos:[0.13,1.27,1.5],size:0.065,color:"#120c08",mat:"glossy",parent:"head",mirror:true,snap:"body",out:-0.012},
 {name:"nose",shape:"sphere",pos:[0,1.1,1.92],size:[0.15,0.1,0.09],color:"#1a1210",mat:"glossy",parent:"head",snap:"body",out:-0.01},
 {name:"claw",shape:"cone",pos:[0.24,0.05,0.94],size:[0.035,0.11,0.035],rot:[100,0,0],color:"#e6dcc4",mat:"glossy",parent:"pawF",mirror:true,snap:"body",out:0.02,repeat:{n:4,step:[0.06,0,0]}}
 Walk: {name:"walk",dur:1.4,motion:[{part:"legF",kind:"swing",axis:"x",amp:22,speed:0.714},{part:"legB",kind:"swing",axis:"x",amp:22,speed:0.714,phase:3.14},
   {part:"pawF",kind:"swing",axis:"x",amp:18,speed:0.714,phase:1.2},{part:"pawB",kind:"swing",axis:"x",amp:18,speed:0.714,phase:4.3},{part:"head",kind:"swing",axis:"x",amp:4,speed:1.43}]}
 Same blobs + style "lowpoly" (res 24, flat facets) = the faceted low-poly look; mat "clay"/"plastic" + bigger eyes + rounder masses = toon.
Hard-surface things (a sword, a chest, a car, a building) stay with box/extrude/lathe/tube parts; a creature's armour or saddle = those parts snapped on and parented to joints.

MODELS: parts and clips (what the tool wants)
Part: {name, shape, pos:[x,y,z], size:[x,y,z], rot:[deg], color, mat, pivot:[x,y,z], parent:"name", mirror:true, ...}. y is up; origin on the ground. size is the bounding box (a sphere of size [2,1,3] is an ellipsoid).
A part with a pivot rotates ABOUT that point when animated; parent makes it follow another part (a lid follows its chest base). Unknown fields, unknown shapes and bad vectors come back as warnings (problems), never silently.
Textures: texture:{kind:"planks|bricks|noise|checker|stripes|dots",colors:["#8a5a2b","#5a3818"],scale:1,repeat:[2,1],pixel:true} on a part; it is part of the model JSON so it exports to the game with no script (frost = kind "noise" with pale blues).
Variants (one model, many colourways, no copied parts or clips): {op:"variant",name:"frost",set:{"base":{texture:{...}},"lid*":{color:"#9fd0ff",mat:"glossy"},"strap*":{color:"#e8f4ff"}}}; preview with view:{variant:"frost"}; in the game instance({variant:"frost"}).
Curved shapes: loft{sections:[[x,y,z,rx,ry],...]} for organic bodies, extrude{pts:[[x,y]...],depth} for any 2D profile, lathe{pts:[[radius,y]...]} for round things, tube{pts:[[x,y,z]...],r,r2}.
  Curved chest lid = a half-ellipse profile extruded along the chest depth:
  {name:"lid",shape:"extrude",pts:[[1,0],[0.97,0.13],[0.87,0.25],[0.71,0.35],[0.5,0.43],[0.26,0.48],[0,0.5],[-0.26,0.48],[-0.5,0.43],[-0.71,0.35],[-0.87,0.25],[-0.97,0.13],[-1,0]],depth:1.3,pos:[0,1.1,0],pivot:[0,1.1,-0.65],parent:"base"}
Clip: {name, dur, loop?, tracks:[{part, rot|pos|scale:[[t,[x,y,z]],...]}], motion:[{part,kind:"swing|wag|bob|spin|pulse",axis,amp,speed,phase}], events:[{t,name,data?}]}
  rot is degrees about the part's pivot, as a DELTA from its rest pose; times are seconds; "leg*" targets every part starting with leg (mirrors follow).
  A chest opening:  {name:"open",dur:1.2,loop:false,tracks:[{part:"lid",rot:[[0,[0,0,0]],[0.9,[-105,0,0]]]}],events:[{t:0.9,name:"lid-up"}]}
  A clip that drives nothing is reported back, with this format. Reading a result: anims lists each clip with its track / motion / event counts.
Views (view:{...}): wire, smooth, spin, rig, camera:3q|front|back|side|top, zoom:0.3-3, anim:"clip", play:bool, speed, t:seconds (freeze the clip at that moment: check the open pose), fit:"anim" (frame the whole clip so an opened lid is not cropped) | "rest".

STUDIO SCRIPTS — write the behaviour yourself.
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
  refreshEdges(partName)                        after you change a part's geometry in a script, redraw its edge lines (otherwise faint outlines of the old shape linger)

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
   Variants: m.variants lists them; chest.instance({variant:"frost"}) builds that colourway (geometry shared per variant). Clips are the same for every variant.
  Same core as the studio: geometry, facet colours, joints, clips and events match. Then Edit the game's own code to place instances, load it with Browser preview, and check it in the real game from every side.

Not in the engine on purpose: water, lava, rain, fire, wind, textures, UI, physics. Write them.`;
