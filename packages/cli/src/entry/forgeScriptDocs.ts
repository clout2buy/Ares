// On-demand documentation for studio scripts: `Browser action:"model" help:true`
// returns this. Ares reads it when it needs to build something the engine has
// no feature for (water, lava, rain, textures, physics, in-scene controls) so
// the always-on prompt stays small. The examples are patterns to adapt, not
// engine features: nothing in the studio knows what a "pond" or a "chest" is.

export const FORGE_SCRIPT_DOCS = `THE QUALITY BAR (always, unasked): every model is sculpted, painted, rigged and animated like a finished game asset.
The owner should never have to ask for detail, colour, joints or motion. "make a bear" means a realistic, furry, rigged bear with idle,
walk and a signature action. Build it to this bar in the FIRST pass; the tool result's "quality" notes name anything still missing - fold
them into your next edit. One look at the views, no separate re-check passes.
Know the object first: parts, counts, sizes, how it moves (a car = 4 wheels on 2 axles, front pair steers; a horse's hock bends back):
SkillRead gamedev -> references/objects.md, or a reference picture for a specific real model.

SCULPT: the ONE process for every model - creatures, characters, props, weapons, furniture, rocks, food, vehicles.
ONE sculpt part per object: its blobs MELT together like clay into a single smooth, watertight, high-poly mesh (real silhouettes, bevelled
edges, carved grooves, creases that shade themselves). Never stack spheres/cylinders/lofts for anything organic: that is the toy look.
  {name:"body", shape:"sculpt", mat:"fur", color:"#5b3a22" (default blob colour), bone:"root" (default bone for blobs without one), blobs:[...],
   res?:auto (96-128 from the finest feature; 140-160 for thin blades, 24 + style lowpoly = faceted low-poly),
   tint?:0.06 (organic colour variation), grain?:1 (surface-detail size: 2 = finer), ao?:1 (crease darkening), noise?:{amp:0.01,scale:8} (lumpy geometry)}
Blobs (applied IN ORDER: each melts into, or carves, what is already there):
  {id:"chest", s:"ball", at:[x,y,z], r:[rx,ry,rz], rot?:[deg]}      masses: chest, belly, hips, skull, cheeks, muscles, pommels, gems
  {id:"neck",  s:"stick", at:[x,y,z], to:[x,y,z], r:0.3, r2:0.2}    tapered + rounded: limbs, neck, muzzle, tail, horns, fingers, claws
  {id:"tail",  s:"chain", pts:[[x,y,z,r],[x,y,z,r],...]}            a bent limb / tail / neck / tentacle / cable in one blob
  {id:"grip",  s:"cyl", at, to, r, round:0.006}                     flat-ended cylinder (bevel = round): handles, barrels, wheels, posts, logs
  {id:"blade", s:"box", at, r:[half sizes], round:0.006, rot?}      bevelled box: blades, planks, plates, hooves, buildings, panels
  {id:"wrap",  s:"torus", at, r:0.026, r2:0.0065, rot?}             rings: grip wraps, bands, rims, eyelets, tyres, collars
  k: how far it melts in (0.002 crisp hard-surface seam .. 0.3 soft clay). Organic masses 0.2-0.3; a limb into the body 0.08-0.15;
     features 0.03-0.08; hard-surface 0.004-0.015.
  sub:true  carves (boolean): eye sockets, nostrils, mouth lines, ear cups, fullers, grooves, panel lines, bevels, holes.
  paint:true, soft:0.05  colour ONLY (the skin INSIDE the blob takes it, feathered over soft): muzzle, belly, socks, stripes, spots, edges.
  color, mat (per blob: one sculpt can be steel + gold + leather), tex (surface detail), bone, mirror:true (left/right copy, bone follows).
  mat: matte clay plastic glossy metal glass glow holo fur skin leather wood stone cloth. A mat brings its detail: fur=fur grain, skin=pores,
       leather=wrinkles, stone=rock, wood=wood grain, cloth=weave. tex overrides: none fur scales wrinkles rock wood cloth hammered pores
       (dragons/fish/lizards: tex "scales"; elephants/rhinos: "wrinkles"; armour: "hammered"). Paint blobs may carry mat/tex too (a gold inlay).
  Edit one blob without re-sending all of them: {op:"blob", name:"body", id:"muzzle", r2:0.08} | new id = add | {..., remove:true}.
Joints (the rig): {name:"root", shape:"joint", pos:[pivot]}, {name:"chest", shape:"joint", pos, parent:"root"}, {name:"head", ..., parent:"chest"},
  limbs parented to chest (front) / root (hind), lower limbs to upper, tail to root; mirror:true for left/right. Invisible bones.
  EVERY blob needs a bone once there is a root (set the sculpt's bone:"root" as the default); weights blend where blobs melt, so ONE skin
  bends smoothly. Animate joints with clips. Rigid parts (eyes, claws, armour) parent to a joint and move with it.
Snap: rigid parts that sit ON the skin: {name:"eye", shape:"sphere", size:0.07, mat:"glossy", color:"#1c0f08", pos:[rough spot], snap:"body", out:-0.018, parent:"head", mirror:true}
  pos is projected to the nearest surface point, then pushed along the normal by out (negative = set into a socket). align:true turns +y to the normal.

METHOD - blockout, form, detail, paint, rig, animate (LOOK at views after each stage; the quality notes say what is missing):
 1. Proportions before anything, from the reference picture (ref) or anatomy/engineering you know. Bear: shoulder hump above the rump, small head,
    thick plantigrade legs. Fox/dog/cat: slim, digitigrade (hock bends BACK). Horse/deer: long legs, deep chest. Human: 7.5 heads tall,
    shoulders 2 heads wide, elbows at the waist. Longsword: blade 3/4 of the length, guard 1/2 the blade length wide.
 2. Blockout: 3-6 big masses. Side + top views: silhouette right? Fix it BEFORE detail.
 3. Form: secondary masses (muscle groups, haunches, cheeks, brow, belly sag; for props: bevels, ricasso, collars), limbs from INSIDE the mass.
 4. Detail: toes/knuckles/lips/ear cups/nostrils/mouth line/eye sockets (small balls + shallow carves); props: fullers, rivets, wraps, gems.
    A finished creature has 40-75 blobs. A finished prop 15-40.
 5. Snap features: eyes into their sockets, claws/teeth/horns (align:true).
 6. Paint + materials: lighter muzzle/belly, darker legs and back, markings, edge highlights on metal; mat per blob; tex where the real thing has it.
 7. Rig: root -> chest -> head, limbs, tail at the real anatomical pivots; bones on every blob.
 8. Animate (always): idle (chest pulse 0.01-0.015 at 0.3 Hz, slow head/tail drift), walk/run (kind step + lift, below), and its signature action
    (roar, attack, open, swing) with eased tracks. Show idle by default. Props get an idle too (slow spin, sway, pulse of a gem).
 9. views ["side","front","3q"] on the build call itself: compare with the reference; fix what is off with op blob in the same flow.
 When the owner points at something ("left ear too low", "snout too short"): change exactly that blob/part/clip with op blob / op set,
 nothing else, and show one view of it.
ANIMATION THAT LOOKS REAL:
  walk/run/trot = motion kind:"step" on each upper limb (the foot plants forward, pushes back linearly for duty of the cycle, then lifts and
  swings forward) + kind:"lift" on the lower limb (flexes only while the foot is in the air), same speed/phase; mirror:true offsets left/right.
  Walk duty 0.6-0.65, trot 0.5, run/gallop 0.35-0.4. Lateral walk: hind legs lead the front by a quarter cycle (phase -1.57).
  Body: root bob at TWICE the step speed (amp 0.02-0.04), a little roll (wag on z), head counter-bob (swing x, phase offset), tail sway.
  Actions: tracks with ease: anticipation first (a small move the other way), then the action with ease "back" or "out", hold, then settle.
  ease per track: smooth (default) linear in out inout back elastic bounce. Games: play(name,{fade:0.25}) crossfades between clips.
WORKED EXAMPLE - a grizzly at the quality bar (adapt the method, not the numbers):
[
  {name:"body",shape:"sculpt",mat:"fur",color:"#5b3a22",tint:0.08,res:112,bone:"root",blobs:[
    {id:"chest",s:"ball",at:[0,1.05,0.5],r:[0.5,0.5,0.58],bone:"chest"},
    {id:"hump",s:"ball",at:[0,1.42,0.42],r:[0.36,0.24,0.4],k:0.3,bone:"chest"},
    {id:"belly",s:"ball",at:[0,0.92,-0.12],r:[0.52,0.47,0.62],k:0.3},
    {id:"sag",s:"ball",at:[0,0.68,0.05],r:[0.34,0.14,0.45],k:0.25},
    {id:"hips",s:"ball",at:[0,1,-0.72],r:[0.46,0.46,0.46],k:0.3},
    {id:"rump",s:"ball",at:[0,1.16,-0.78],r:[0.36,0.26,0.38],k:0.2},
    {id:"neck",s:"stick",at:[0,1.18,0.8],to:[0,1.2,1.12],r:0.38,r2:0.3,k:0.18,bone:"head"},
    {id:"ruff",s:"ball",at:[0.2,1.12,1.06],r:[0.16,0.21,0.16],k:0.15,bone:"head",mirror:true},
    {id:"skull",s:"ball",at:[0,1.23,1.24],r:[0.3,0.28,0.3],k:0.12,bone:"head"},
    {id:"cheek",s:"ball",at:[0.16,1.12,1.3],r:[0.16,0.16,0.18],k:0.1,bone:"head",mirror:true},
    {id:"brow",s:"ball",at:[0.1,1.33,1.42],r:[0.1,0.05,0.08],k:0.06,bone:"head",mirror:true},
    {id:"stop",s:"ball",at:[0,1.3,1.47],r:[0.11,0.06,0.08],k:0.08,bone:"head"},
    {id:"muzzle",s:"stick",at:[0,1.15,1.38],to:[0,1.07,1.8],r:0.165,r2:0.1,k:0.12,color:"#b8915f",bone:"head"},
    {id:"bridge",s:"ball",at:[0,1.17,1.62],r:[0.08,0.05,0.16],k:0.06,color:"#b8915f",bone:"head"},
    {id:"lip",s:"ball",at:[0.05,1.03,1.73],r:[0.055,0.04,0.07],k:0.03,color:"#b8915f",bone:"head",mirror:true},
    {id:"chin",s:"ball",at:[0,0.99,1.62],r:[0.09,0.05,0.13],k:0.06,color:"#b8915f",bone:"head"},
    {id:"mouth",s:"stick",at:[0.13,1.02,1.5],to:[0.035,1.005,1.77],r:0.009,sub:true,k:0.012,mirror:true},
    {id:"nose",s:"ball",at:[0,1.1,1.885],r:[0.085,0.062,0.058],k:0.02,color:"#16100c",mat:"glossy",tex:"pores",bone:"head"},
    {id:"nostril",s:"ball",at:[0.034,1.088,1.938],r:[0.019,0.014,0.02],sub:true,k:0.006,mirror:true},
    {id:"socket",s:"ball",at:[0.13,1.27,1.5],r:[0.045,0.035,0.035],sub:true,k:0.025,mirror:true},
    {id:"ear",s:"ball",at:[0.23,1.46,1.16],r:[0.09,0.09,0.05],rot:[0,0,-20],k:0.06,bone:"head",mirror:true},
    {id:"earCup",s:"ball",at:[0.235,1.46,1.215],r:[0.05,0.05,0.03],sub:true,k:0.02,mirror:true},
    {id:"shoulder",s:"ball",at:[0.3,1.02,0.58],r:[0.2,0.34,0.28],k:0.2,bone:"legF",mirror:true},
    {id:"elbow",s:"ball",at:[0.34,0.64,0.52],r:[0.13,0.12,0.14],k:0.08,bone:"legF",mirror:true},
    {id:"arm",s:"stick",at:[0.32,0.95,0.6],to:[0.33,0.55,0.64],r:0.22,r2:0.18,k:0.08,bone:"legF",mirror:true},
    {id:"forearm",s:"stick",at:[0.33,0.55,0.64],to:[0.33,0.16,0.66],r:0.18,r2:0.15,k:0.06,bone:"pawF",mirror:true},
    {id:"pawF",s:"ball",at:[0.33,0.085,0.74],r:[0.17,0.085,0.21],k:0.06,color:"#2b1b10",bone:"pawF",mirror:true},
    {id:"toeF0",s:"ball",at:[0.24000000000000002,0.07,0.873],r:[0.036,0.034,0.05],k:0.03,color:"#2b1b10",bone:"pawF",mirror:true},
    {id:"toeF1",s:"ball",at:[0.30000000000000004,0.07,0.891],r:[0.036,0.034,0.05],k:0.03,color:"#2b1b10",bone:"pawF",mirror:true},
    {id:"toeF2",s:"ball",at:[0.36,0.07,0.891],r:[0.036,0.034,0.05],k:0.03,color:"#2b1b10",bone:"pawF",mirror:true},
    {id:"toeF3",s:"ball",at:[0.42000000000000004,0.07,0.873],r:[0.036,0.034,0.05],k:0.03,color:"#2b1b10",bone:"pawF",mirror:true},
    {id:"thigh",s:"ball",at:[0.3,0.92,-0.72],r:[0.22,0.36,0.33],k:0.2,bone:"legB",mirror:true},
    {id:"haunch",s:"ball",at:[0.27,1.06,-0.86],r:[0.2,0.24,0.24],k:0.2,mirror:true},
    {id:"shin",s:"stick",at:[0.32,0.7,-0.62],to:[0.33,0.32,-0.82],r:0.2,r2:0.15,k:0.08,bone:"legB",mirror:true},
    {id:"heel",s:"stick",at:[0.33,0.32,-0.82],to:[0.33,0.1,-0.84],r:0.15,r2:0.13,k:0.05,bone:"pawB",mirror:true},
    {id:"foot",s:"stick",at:[0.33,0.08,-0.86],to:[0.33,0.075,-0.6],r:0.11,r2:0.13,k:0.06,color:"#2b1b10",bone:"pawB",mirror:true},
    {id:"toeB0",s:"ball",at:[0.24000000000000002,0.065,-0.547],r:[0.036,0.034,0.05],k:0.03,color:"#2b1b10",bone:"pawB",mirror:true},
    {id:"toeB1",s:"ball",at:[0.30000000000000004,0.065,-0.529],r:[0.036,0.034,0.05],k:0.03,color:"#2b1b10",bone:"pawB",mirror:true},
    {id:"toeB2",s:"ball",at:[0.36,0.065,-0.529],r:[0.036,0.034,0.05],k:0.03,color:"#2b1b10",bone:"pawB",mirror:true},
    {id:"toeB3",s:"ball",at:[0.42000000000000004,0.065,-0.547],r:[0.036,0.034,0.05],k:0.03,color:"#2b1b10",bone:"pawB",mirror:true},
    {id:"tail",s:"ball",at:[0,1.06,-1.2],r:[0.09,0.08,0.08],k:0.06,bone:"tail"},
    {id:"grizzle",s:"ball",at:[0,1.5,0.3],r:[0.42,0.22,0.65],paint:true,soft:0.2,color:"#a27b4f"},
    {id:"browTint",s:"ball",at:[0,1.42,1.25],r:[0.16,0.08,0.16],paint:true,soft:0.08,color:"#7d5a37"},
    {id:"legsF",s:"ball",at:[0.33,0.25,0.65],r:[0.22,0.3,0.25],paint:true,soft:0.14,color:"#2b1b10",mirror:true},
    {id:"legsB",s:"ball",at:[0.33,0.25,-0.75],r:[0.22,0.28,0.3],paint:true,soft:0.14,color:"#2b1b10",mirror:true},
    {id:"earIn",s:"ball",at:[0.235,1.46,1.21],r:[0.05,0.05,0.04],paint:true,soft:0.02,color:"#2b1b10",mirror:true}]},
  {name:"root",shape:"joint",pos:[0,1,-0.4]},
  {name:"chest",shape:"joint",pos:[0,1.1,0.2],parent:"root"},
  {name:"head",shape:"joint",pos:[0,1.2,0.92],parent:"chest"},
  {name:"legF",shape:"joint",pos:[0.32,1,0.6],parent:"chest",mirror:true},
  {name:"pawF",shape:"joint",pos:[0.33,0.55,0.64],parent:"legF",mirror:true},
  {name:"legB",shape:"joint",pos:[0.32,0.9,-0.66],parent:"root",mirror:true},
  {name:"pawB",shape:"joint",pos:[0.33,0.32,-0.82],parent:"legB",mirror:true},
  {name:"tail",shape:"joint",pos:[0,1.06,-1.1],parent:"root"},
  {name:"eye",shape:"sphere",pos:[0.13,1.27,1.52],size:0.07,color:"#1c0f08",mat:"glossy",parent:"head",mirror:true,snap:"body",out:-0.018},
  {name:"claw",shape:"cone",pos:[0.24,0.05,0.96],size:[0.03,0.12,0.03],rot:[105,0,0],color:"#d8cdb2",mat:"glossy",parent:"pawF",mirror:true,snap:"body",out:0.025,repeat:{n:4,step:[0.06,0,0]}},
  {name:"clawB",shape:"cone",pos:[0.24,0.045,-0.46],size:[0.025,0.07,0.025],rot:[100,0,0],color:"#d8cdb2",mat:"glossy",parent:"pawB",mirror:true,snap:"body",out:0.015,repeat:{n:4,step:[0.06,0,0]}}]
CLIPS:
[
  {name:"idle",dur:6,motion:[{part:"chest",kind:"pulse",amp:0.012,speed:0.33},{part:"head",kind:"swing",axis:"x",amp:3,speed:0.17},{part:"head",kind:"wag",axis:"y",amp:7,speed:0.083,phase:1},{part:"tail",kind:"wag",axis:"y",amp:10,speed:0.33}]},
  {name:"walk",dur:1.4,motion:[{part:"legF",kind:"step",axis:"x",amp:20,speed:0.714,duty:0.62},{part:"pawF",kind:"lift",axis:"x",amp:40,speed:0.714,duty:0.62},{part:"legB",kind:"step",axis:"x",amp:18,speed:0.714,duty:0.62,phase:-1.57},{part:"pawB",kind:"lift",axis:"x",amp:-30,speed:0.714,duty:0.62,phase:-1.57},{part:"root",kind:"bob",axis:"y",amp:0.025,speed:1.43},{part:"root",kind:"wag",axis:"z",amp:2,speed:0.714},{part:"head",kind:"swing",axis:"x",amp:4,speed:1.43,phase:1.2},{part:"tail",kind:"wag",axis:"y",amp:8,speed:0.714}]},
  {name:"roar",dur:2.4,loop:false,events:[{t:0.7,name:"roar"}],tracks:[{part:"root",ease:"back",rot:[[0,[0,0,0]],[0.6,[-6,0,0]],[1.7,[-6,0,0]],[2.4,[0,0,0]]]},{part:"head",ease:"back",rot:[[0,[0,0,0]],[0.25,[10,0,0]],[0.7,[-32,0,0]],[1.7,[-28,0,0]],[2.4,[0,0,0]]]},{part:"legF",ease:"out",rot:[[0,[0,0,0]],[0.6,[-28,0,0]],[1.7,[-28,0,0]],[2.4,[0,0,0]]]},{part:"pawF",ease:"out",rot:[[0,[0,0,0]],[0.6,[45,0,0]],[1.7,[45,0,0]],[2.4,[0,0,0]]]}]}]
HARD SURFACE EXAMPLE - a longsword: ONE sculpt, bevelled boxes, a carved fuller, leather wraps (torus), gold, a glowing gem:
[
  {name:"sword",shape:"sculpt",color:"#c9ced6",mat:"metal",res:140,blobs:[
    {id:"blade",s:"box",at:[0,1.55,0],r:[0.055,0.62,0.012],round:0.006,k:0.01},
    {id:"tip",s:"box",at:[0,2.2,0],r:[0.04,0.04,0.012],rot:[0,0,45],round:0.004,k:0.03},
    {id:"tipCut",s:"box",at:[0.07,2.25,0],r:[0.05,0.12,0.05],rot:[0,0,22],sub:true,k:0.004,mirror:true},
    {id:"fuller",s:"box",at:[0,1.42,0.016],r:[0.012,0.42,0.008],round:0.006,sub:true,k:0.006},
    {id:"fuller2",s:"box",at:[0,1.42,-0.016],r:[0.012,0.42,0.008],round:0.006,sub:true,k:0.006},
    {id:"ricasso",s:"box",at:[0,0.97,0],r:[0.045,0.04,0.016],round:0.005,k:0.01},
    {id:"guard",s:"box",at:[0,0.92,0],r:[0.24,0.022,0.03],round:0.012,k:0.012,color:"#c9962e",mat:"metal",tex:"hammered"},
    {id:"quillon",s:"ball",at:[0.255,0.935,0],r:[0.035,0.035,0.035],k:0.02,color:"#c9962e",mat:"metal",mirror:true},
    {id:"langet",s:"box",at:[0,0.95,0],r:[0.02,0.05,0.036],round:0.01,k:0.01,color:"#c9962e",mat:"metal"},
    {id:"grip",s:"cyl",at:[0,0.9,0],to:[0,0.62,0],r:0.026,round:0.006,k:0.01,color:"#4a2c1a",mat:"leather"},
    {id:"wrap0",s:"torus",at:[0,0.875,0],r:0.026,r2:0.0065,k:0.004,color:"#4a2c1a",mat:"leather"},
    {id:"wrap1",s:"torus",at:[0,0.83,0],r:0.026,r2:0.0065,k:0.004,color:"#4a2c1a",mat:"leather"},
    {id:"wrap2",s:"torus",at:[0,0.785,0],r:0.026,r2:0.0065,k:0.004,color:"#4a2c1a",mat:"leather"},
    {id:"wrap3",s:"torus",at:[0,0.74,0],r:0.026,r2:0.0065,k:0.004,color:"#4a2c1a",mat:"leather"},
    {id:"wrap4",s:"torus",at:[0,0.6950000000000001,0],r:0.026,r2:0.0065,k:0.004,color:"#4a2c1a",mat:"leather"},
    {id:"wrap5",s:"torus",at:[0,0.65,0],r:0.026,r2:0.0065,k:0.004,color:"#4a2c1a",mat:"leather"},
    {id:"collar",s:"cyl",at:[0,0.625,0],to:[0,0.6,0],r:0.032,round:0.004,k:0.006,color:"#c9962e",mat:"metal"},
    {id:"pommel",s:"ball",at:[0,0.565,0],r:[0.045,0.04,0.03],k:0.01,color:"#c9962e",mat:"metal",tex:"hammered"},
    {id:"gem",s:"ball",at:[0,0.565,0.026],r:[0.02,0.02,0.012],k:0.004,color:"#d12a3a",mat:"glow"},
    {id:"gemBack",s:"ball",at:[0,0.565,-0.026],r:[0.02,0.02,0.012],k:0.004,color:"#d12a3a",mat:"glow"},
    {id:"edge",s:"box",at:[0.05,1.55,0],r:[0.008,0.62,0.02],paint:true,soft:0.004,color:"#eef1f5",mirror:true}]}]
Same blobs + style "lowpoly" (res 24, flat facets) = the faceted low-poly look; mat "clay"/"plastic", bigger eyes and rounder masses = toon.

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
