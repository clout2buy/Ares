// The `model` explain block: a 3D model that assembles itself part by part in
// the Forge, in real colours (flat-shaded low-poly with pixel-theme edges), so
// "make a 3D model of a fox / a plane / a game prop" is watched being built
// instead of hand-coded. The agent supplies ordered primitives (see
// forgeBlocks.sanitizeModel); this module animates them in, frames the camera,
// and lets the viewer orbit, change build speed, toggle wireframe, or copy the
// parts JSON for their own game. Same pinned three + OrbitControls as sim.
//
// TypeScript template literal: NO backticks, NO dollar-brace, NO backslashes.

import { FORGE_THREE_LOAD } from "./forgeSim.js";
import { FORGE_MODEL_CORE_JS } from "./forgeModelCore.js";

export const FORGE_MODEL_JS = FORGE_THREE_LOAD + FORGE_MODEL_CORE_JS + `
var reduced=!!(matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches);
function mk(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function envMap(r){
  var es=new T.Scene(),sky=new T.Mesh(new T.SphereGeometry(20,24,12),new T.MeshBasicMaterial({vertexColors:true,side:T.BackSide})),pa=sky.geometry.attributes.position,cols=[],c=new T.Color(),i;
  for(i=0;i<pa.count;i++){var y=(pa.getY(i)/20+1)/2;c.setRGB(0.04+0.42*y*y,0.04+0.42*y*y,0.05+0.45*y*y);cols.push(c.r,c.g,c.b)}
  sky.geometry.setAttribute("color",new T.Float32BufferAttribute(cols,3));es.add(sky);
  [[8,10,6,6],[-9,6,-4,4],[0,12,-9,5]].forEach(function(q){var b=new T.Mesh(new T.BoxGeometry(q[3],0.4,q[3]),new T.MeshBasicMaterial({color:0xffffff}));b.position.set(q[0],q[1],q[2]);b.lookAt(0,0,0);es.add(b)});
  var pm=new T.PMREMGenerator(r),rt=pm.fromScene(es,0.02);pm.dispose();return rt.texture;
}
var LOOKS={
  studio:{bg:"radial-gradient(ellipse at 50% 70%,rgba(47,109,240,.2),transparent 65%),rgba(3,6,14,.6)",sun:0xfff4e6,si:2.8,rim:0x8fb4ff,hemi:0xe8eeff,hg:0x2a2620,hi:0.45,ex:1.1},
  sunset:{bg:"linear-gradient(180deg,#2a1a4a,#c8563f 70%,#f0a32f)",sun:0xffc890,si:3.2,rim:0x7a5aff,hemi:0xffb890,hg:0x2a1a3a,hi:0.7,ex:1.05},
  night:{bg:"linear-gradient(180deg,#02040c,#0a1236)",sun:0x9cc5ff,si:1.4,rim:0x2f6df0,hemi:0x3a5aa0,hg:0x05081a,hi:0.5,ex:0.95},
  clay:{bg:"radial-gradient(ellipse at 50% 85%,#efe8dc,#d2c9ba 70%,#bdb3a2)",sun:0xfff1dd,si:2.5,rim:0xffffff,hemi:0xffffff,hg:0xb8ad9c,hi:1.0,ex:1,grid:0},
  slate:{bg:"radial-gradient(ellipse at 50% 60%,#939ea8,#59626b)",sun:0xffffff,si:2.3,rim:0xaecbff,hemi:0xe8f0ff,hg:0x4a525a,hi:0.9,ex:1,grid:0},
  pastel:{bg:"radial-gradient(ellipse at 50% 80%,#c7c3f5,#a9a4ec 70%,#9892e0)",sun:0xffffff,si:2.2,rim:0xffd6f0,hemi:0xf3f0ff,hg:0x8a84d8,hi:1.1,ex:1,grid:0},
  gallery:{bg:"radial-gradient(ellipse at 50% 70%,#7f8a96,#55606b)",sun:0xfff7ec,si:2.6,rim:0xcfe0ff,hemi:0xffffff,hg:0x4a525a,hi:0.9,ex:1,grid:0},
  noir:{bg:"radial-gradient(ellipse at 50% 60%,#1a1a1c,#050506)",sun:0xffe2a0,si:1.8,rim:0xd9a441,hemi:0x6a5a3a,hg:0x050506,hi:0.5,ex:1,grid:0},
  holo:{bg:"radial-gradient(ellipse at 50% 90%,#12307a,#080c24 60%,#2a0f4a)",sun:0x9cc5ff,si:1.6,rim:0xb06bff,hemi:0x6a8cff,hg:0x0a1030,hi:0.6,ex:1.05},
  flat:{bg:"#1a2036",sun:0xffffff,si:1.2,rim:0xffffff,hemi:0xffffff,hg:0xffffff,hi:1.6,ex:1}
};
function build(el){
  var spec={};try{spec=JSON.parse(el.getAttribute("data-spec")||"{}")}catch(e){}
  var parts=(spec.parts||[]).slice(),N=parts.length,live=!!spec.live,inst=!!window.__aresInstant,studio=spec.studio||"";
  var head=mk("div","k-sim-head"),stage=mk("div","k-stage"),cap=mk("div","k-cap"),panel=mk("div","k-panel");
  var tag=mk("span","k-sim-tag","3D studio · "+N+" parts");head.appendChild(tag);
  var bar=mk("span","k-sim-btns"),bPlay=mk("button","k-btn","pause"),bRe=mk("button","k-btn","replay"),bStep=mk("button","k-btn","step"),bWire=mk("button","k-btn","wireframe"),bSpin=mk("button","k-btn","turntable"),bCopy=mk("button","k-btn","copy asset"),bGlb=mk("button","k-btn","export glb"),bShade=mk("button","k-btn","smooth shading");
  [bPlay,bRe,bStep,bWire,bShade,bSpin,bCopy,bGlb].forEach(function(b){b.type="button";bar.appendChild(b)});head.appendChild(bar);
  var capT=mk("b","k-cap-n","0/"+N),capX=mk("span","k-cap-x","ready"),prog=mk("div","k-prog"),progI=mk("span");prog.appendChild(progI);
  cap.appendChild(capT);cap.appendChild(capX);cap.appendChild(prog);
  // the screen is a bare viewport: tools stay hidden until asked for; Ares does wireframe/spin/rig/camera/playback itself (spec.view)
  el.classList.add("k-min");el.appendChild(head);el.appendChild(stage);el.appendChild(cap);el.appendChild(panel);
  var mini=mk("div","k-mini",""),miniTxt="",tb=mk("button","k-tools","tools");tb.type="button";stage.appendChild(mini);stage.appendChild(tb);
  function stageH(){return studio&&el.classList.contains("k-min")?Math.max(360,innerHeight-6):380}
  if(spec.caption)el.appendChild(mk("p","k-sim-cap",spec.caption));
  if(!N&&!live&&!studio){stage.appendChild(mk("p","k-sim-cap","no parts to build"));return}
  if(!T||!OrbitControls){stage.appendChild(mk("p","k-sim-cap","3D view needs the three.js CDN (esm.sh) and it did not load."));return}
  var rate=Math.max(2,Math.min(10,N/6));
  function slider(lab,min,max,step,val,on){var row=mk("label","k-slider"),out=mk("b","",String(Math.round(val*100)/100)),inp=document.createElement("input");inp.type="range";inp.min=min;inp.max=max;inp.step=step;inp.value=val;row.appendChild(mk("span","",lab));row.appendChild(out);row.appendChild(inp);inp.addEventListener("input",function(){out.textContent=String(Math.round(+inp.value*100)/100);on(+inp.value)});row._set=function(v){inp.value=v;out.textContent=String(Math.round(v*100)/100)};return row}
  var spd=slider("Build speed (parts/s)",0.5,14,0.1,rate,function(v){rate=v});panel.appendChild(spd);
  var lookRow=mk("label","k-slider"),lookSel=document.createElement("select");lookSel.className="k-sel";Object.keys(LOOKS).forEach(function(k){var o=document.createElement("option");o.value=k;o.textContent=k;lookSel.appendChild(o)});
  lookRow.appendChild(mk("span","","Lighting"));lookRow.appendChild(mk("b","",""));lookRow.appendChild(lookSel);panel.appendChild(lookRow);
  var insp=mk("div","k-insp");insp.hidden=true;panel.appendChild(insp);
  var hint=mk("p","k-sim-cap","Click a part to edit its colour, material and shape. Drag to orbit, scroll to zoom.");hint.style.gridColumn="1/-1";hint.style.border="0";panel.appendChild(hint);
  var w=stage.clientWidth||600,h=stageH();
  var r=new T.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:false});r.setPixelRatio(Math.min(2,devicePixelRatio));r.setSize(w,h);stage.appendChild(r.domElement);
  var sc=new T.Scene(),cam=new T.PerspectiveCamera(42,w/h,0.05,500);
  tb.addEventListener("click",function(){var m=el.classList.toggle("k-min");tb.textContent=m?"tools":"hide";h=stageH();r.setSize(stage.clientWidth||w,h);cam.aspect=(stage.clientWidth||w)/h;cam.updateProjectionMatrix();draw()});
  r.shadowMap.enabled=true;r.shadowMap.type=T.PCFSoftShadowMap;sc.environment=envMap(r);
  // filmic response: highlights roll off instead of clipping, so darks keep their colour (fur, wood, skin read as themselves)
  r.toneMapping=T.ACESFilmicToneMapping;
  var hemi=new T.HemisphereLight(0xcfe0ff,0x1a2340,0.8),sun=new T.DirectionalLight(0xffffff,2.6),rim=new T.DirectionalLight(0x6fa0ff,1.1);rim.position.set(-6,3,-5);sc.add(hemi);sc.add(sun);sc.add(rim);
  var ctl=new OrbitControls(cam,r.domElement);ctl.enableDamping=true;ctl.autoRotate=!reduced;ctl.autoRotateSpeed=1.4;
  ctl.addEventListener("start",function(){ctl.autoRotate=false;bSpin.classList.remove("on")});
  var root=new T.Group(),items=[],mats=[],edges=[];sc.add(root);
  function make(p){
    var g=buildPartObject(p,{edges:true}),m=g.userData.mat,mesh=g.userData.mesh,ed=g.userData.ed;
    // every part hangs off a joint node (the pivot) so animation can rotate it - and its children - about that point
    var pv=p.pivot||p.pos,node=new T.Group();node.name="n"+(uid++);
    g.userData.node=node;
    node.add(g);node.position.set(pv[0],pv[1],pv[2]);node.userData.rest=node.position.clone();
    root.add(node);items.push(g);mats.push(m);edges.push(ed);return g}
  var uid=0,pidx=[],hasKids=[];
  function relink(){var nds=items.map(function(g){return g.userData.node}),rl=rigLink(parts,nds,root);pidx=rl.pidx;hasKids=rl.hasKids;skinLink(parts,nds,items);root.updateMatrixWorld(true)}
  if(T)parts=snapParts(parts);
  parts.forEach(make);relink();
  root.updateMatrixWorld(true);
  var box=new T.Box3(),ctr=new T.Vector3(0,1.2,0),rad=3,tctr=ctr.clone(),trad=rad;
  function rebox(){root.updateMatrixWorld(true);box.makeEmpty();items.forEach(function(g,i){if(!(parts[i]&&parts[i].scenery))box.expandByObject(g)});if(box.isEmpty())items.forEach(function(g){box.expandByObject(g)})}
  if(N){rebox()}else box.set(new T.Vector3(-1.5,0,-1.5),new T.Vector3(1.5,3,1.5));
  var grid=new T.GridHelper(60,60,0x2f6df0,0x15347a);sc.add(grid);
  var gp=new T.Mesh(new T.PlaneGeometry(60,60),new T.ShadowMaterial({opacity:0.35}));gp.rotation.x=-Math.PI/2;gp.receiveShadow=true;sc.add(gp);
  sun.target.position.copy(ctr);sc.add(sun.target);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);var shc=sun.shadow.camera;shc.near=0.1;sun.shadow.bias=-0.0004;
  function fitWorld(){
    tctr=box.getCenter(new T.Vector3());trad=Math.max(0.5,box.getSize(new T.Vector3()).length()/2);
    var s2=Math.max(0.2,Math.min(20,trad/3.5));grid.scale.set(s2,1,s2);gp.scale.set(s2,s2,1);grid.position.y=box.min.y;gp.position.y=box.min.y+0.002;
    sun.position.set(tctr.x+trad*1.6,tctr.y+trad*2.6,tctr.z+trad*1.8);sun.target.position.copy(tctr);
    shc.left=shc.bottom=-trad*1.6;shc.right=shc.top=trad*1.6;shc.far=trad*8;shc.updateProjectionMatrix();
  }
  fitWorld();ctr.copy(tctr);rad=trad;
  cam.position.set(ctr.x+rad*1.05,ctr.y+rad*0.55,ctr.z+rad*1.55);ctl.target.copy(ctr);ctl.update();
  var userTook=false,settleUntil=0;ctl.addEventListener("start",function(){userTook=true});
  var still=reduced||inst,headP=live||still?N:0,playing=!still&&!live,wire=false,sel=-1,selBox=new T.BoxHelper(root,0xf0a32f);selBox.visible=false;sc.add(selBox);
  function setCap(){
    var cur=Math.min(N,Math.ceil(headP));
    capT.textContent=live?N+" parts":cur+"/"+N;var stg=function(k){return k>0&&parts[k-1].stage?parts[k-1].stage+" · ":""};capX.textContent=live?(N?"building · "+stg(N)+parts[N-1].name:"waiting for the first part"):headP>=N?"complete · click a part to edit":(cur>0?stg(cur)+parts[cur-1].name:"ready");progI.style.width=(100*Math.min(1,headP/Math.max(1,N)))+"%";
    bPlay.textContent=headP>=N?"done":playing?"pause":"play";tag.textContent="3D studio · "+N+" parts";
    var mt=(spec.title||"")+(N?(spec.title?" · ":"")+N+" parts":"")+(curA>=0&&anims[curA]?" · "+anims[curA].name:"")+(live?" · building":"");if(mt!==miniTxt){miniTxt=mt;mini.textContent=mt}
  }
  function pose(){
    for(var i=0;i<N;i++){
      var g=items[i],k=g.userData.born!=null?Math.min(1,(performance.now()-g.userData.born)/360):Math.max(0,Math.min(1,headP-i)),b=g.userData.base;
      if(k<=0){g.visible=false;continue}
      g.visible=true;var e=reduced?1:ease(k);g.scale.set(b[0]*e,b[1]*e,b[2]*e);g.position.y=g.userData.y+(reduced?0:(1-k)*0.6);
    }
    setCap();
  }
  function draw(){if(sel>=0&&items[sel]){selBox.setFromObject(items[sel]);selBox.visible=true}else selBox.visible=false;ctl.update();r.render(sc,cam)}
  function look(k){var L=LOOKS[k];sun.color.setHex(L.sun);sun.intensity=L.si;rim.color.setHex(L.rim);hemi.color.setHex(L.hemi);hemi.groundColor.setHex(L.hg);hemi.intensity=L.hi;r.toneMappingExposure=L.ex;stage.style.background=L.bg;grid.visible=L.grid!==0;draw()}
  lookSel.addEventListener("change",function(){look(lookSel.value)});
  var curLook="studio";if(spec.look&&LOOKS[spec.look]){lookSel.value=spec.look;look(spec.look);curLook=spec.look}
  // ── studio inspector: edit the selected part live ──
  var inspRows={};
  function buildInsp(){
    insp.textContent="";var p=parts[sel],g=items[sel],u=g.userData,sp=Math.max(2,rad*2.2),i;
    insp.appendChild(mk("b","k-insp-h",p.name));
    var ci=document.createElement("input");ci.type="color";ci.value=p.color;ci.className="k-color";ci.addEventListener("input",function(){p.color=ci.value;if(p.facets||p.fcolors)paint(u.mesh.geometry,p);else u.mat.color.set(ci.value);if(p.mat==="glow")u.mat.emissive.set(ci.value);draw()});
    var cr=mk("label","k-slider");cr.appendChild(mk("span","","Colour"));cr.appendChild(mk("b","",""));cr.appendChild(ci);insp.appendChild(cr);
    var ms=document.createElement("select");ms.className="k-sel";["matte","clay","plastic","metal","glossy","glass","glow","fur","skin","leather","wood","stone","cloth"].forEach(function(k){var o=document.createElement("option");o.value=k;o.textContent=k;if(k===p.mat)o.selected=true;ms.appendChild(o)});
    ms.addEventListener("change",function(){p.mat=ms.value;var nm=material(p);u.mesh.material=nm;u.mat=nm;mats[sel]=nm;u.ed.visible=edgeVis(p)&&!wire;draw()});
    var mr=mk("label","k-slider");mr.appendChild(mk("span","","Material"));mr.appendChild(mk("b","",""));mr.appendChild(ms);insp.appendChild(mr);
    var sm=mk("button","k-btn",p.smooth?"smooth":"faceted");sm.type="button";sm.addEventListener("click",function(){p.smooth=!p.smooth;sm.textContent=p.smooth?"smooth":"faceted";u.mat.flatShading=!p.smooth;u.mat.needsUpdate=true;u.ed.visible=edgeVis(p)&&!wire;draw()});
    var AX=["x","y","z"];
    for(i=0;i<3;i++)(function(i){insp.appendChild(slider("Pos "+AX[i],-sp,sp,0.01,p.pos[i],function(v){p.pos[i]=v;var pvv=(p.pivot||p.pos)[i];if(i===1)u.y=v-pvv;else g.position[AX[i]]=v-pvv;pose();draw()}))})(i);
    for(i=0;i<3;i++)(function(i){insp.appendChild(slider("Size "+AX[i],0.02,Math.max(4,sp),0.01,p.size[i],function(v){p.size[i]=v;u.base[i]=v;pose();draw()}))})(i);
    for(i=0;i<3;i++)(function(i){insp.appendChild(slider("Rot "+AX[i]+" deg",-180,180,1,p.rot[i],function(v){p.rot[i]=v;g.rotation[AX[i]]=v*Math.PI/180;draw()}))})(i);
    var row=mk("div","k-insp-btns"),bd=mk("button","k-btn","duplicate"),bx=mk("button","k-btn","delete");row.appendChild(sm);row.appendChild(bd);row.appendChild(bx);insp.appendChild(row);
    bd.type=bx.type="button";
    bd.addEventListener("click",function(){var c=JSON.parse(JSON.stringify(p));c.name=p.name+" copy";c.pos[0]+=0.3;parts.splice(sel+1,0,c);var ng=make(c);items.pop();mats.pop();edges.pop();items.splice(sel+1,0,ng);mats.splice(sel+1,0,ng.userData.mat);edges.splice(sel+1,0,ng.userData.ed);N=parts.length;headP=N;relink();select(sel+1);pose();draw()});
    bx.addEventListener("click",function(){var g2=items[sel];items.splice(sel,1);mats.splice(sel,1);edges.splice(sel,1);parts.splice(sel,1);N=parts.length;relink();if(g2.userData.node.parent)g2.userData.node.parent.remove(g2.userData.node);headP=Math.min(headP,N);select(-1);pose();draw()});
  }
  function select(i){sel=i;if(i<0){insp.hidden=true;hint.hidden=false}else{buildInsp();insp.hidden=false;hint.hidden=true}draw()}
  var ray=new T.Raycaster(),ndc=new T.Vector2(),down=null;
  r.domElement.addEventListener("pointerdown",function(e){down=[e.clientX,e.clientY]});
  r.domElement.addEventListener("pointerup",function(e){
    if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;
    var rc=r.domElement.getBoundingClientRect();ndc.set(((e.clientX-rc.left)/rc.width)*2-1,-((e.clientY-rc.top)/rc.height)*2+1);ray.setFromCamera(ndc,cam);
    var meshes=items.filter(function(g){return g.visible}).map(function(g){return g.userData.mesh}),hit=ray.intersectObjects(meshes,false)[0];
    var allM=[];sc.traverse(function(o){if(o.isMesh&&o.visible)allM.push(o)});var ch=ray.intersectObjects(allM,false)[0];
    if(ch){var hp=items.findIndex(function(g){return g.userData.mesh===ch.object});emit("click",{point:[ch.point.x,ch.point.y,ch.point.z],part:hp>=0?parts[hp].name:null})}
    if(!hit){select(-1);return}
    for(var i=0;i<items.length;i++)if(items[i].userData.mesh===hit.object){headP=N;pose();select(i);return}});
  bPlay.addEventListener("click",function(){if(headP>=N){headP=0}playing=!playing;if(reduced){headP=N;pose()}draw()});
  bRe.addEventListener("click",function(){headP=reduced?N:0;playing=!reduced;select(-1);pose();draw()});
  bStep.addEventListener("click",function(){playing=false;headP=Math.min(N,Math.floor(headP+0.0001)+1);pose();draw()});
  bSpin.classList.toggle("on",ctl.autoRotate);bSpin.addEventListener("click",function(){ctl.autoRotate=!ctl.autoRotate;bSpin.classList.toggle("on",ctl.autoRotate)});

  // ── animation: keyframe tracks + procedural motions over named parts; joints = each part's pivot ──
  var anims=(spec.anims||[]).slice(),curA=anims.length?0:-1,animOn=anims.length>0&&!reduced,animT=0,animSpeed=1,D=Math.PI/180;
  function applyAnim(c,t){rigApply(parts,items.map(function(g){return g.userData.node}),c,t)}
  function restPose(){for(var i=0;i<N;i++){var nd=items[i].userData.node;nd.rotation.set(0,0,0);nd.scale.set(1,1,1);nd.position.copy(nd.userData.rest)}}
  var arow=mk("div","k-insp"),aSel=document.createElement("select"),bAnim=mk("button","k-btn","pause"),bRig=mk("button","k-btn","show rig"),aSpd;
  aSel.className="k-sel";aSel.style.gridColumn="auto";arow.style.borderColor="#2f6df0";arow.style.background="rgba(47,109,240,.05)";
  arow.appendChild(mk("b","k-insp-h","Animation"));arow.appendChild(aSel);
  aSpd=slider("Anim speed",0.1,3,0.05,1,function(v){animSpeed=v});arow.appendChild(aSpd);
  var abtns=mk("div","k-insp-btns");bAnim.type=bRig.type="button";abtns.appendChild(bAnim);abtns.appendChild(bRig);arow.appendChild(abtns);panel.appendChild(arow);
  function refreshAnimUI(){
    aSel.textContent="";anims.forEach(function(a,i){var o=document.createElement("option");o.value=i;o.textContent=a.name;aSel.appendChild(o)});aSel.value=curA;
    arow.hidden=!(anims.length||hasKids.some(Boolean)||parts.some(function(q){return q.shape==="joint"}));aSel.hidden=bAnim.hidden=aSpd.hidden=!anims.length;bAnim.textContent=animOn?"pause":"play"}
  var xf=null;function crossfade(){xf={s:rigSnap(items.map(function(g){return g.userData.node})),t:0}}
  aSel.addEventListener("change",function(){crossfade();curA=+aSel.value;animT=0;if(!animOn)applyAnim(anims[curA],0);draw()});
  bAnim.addEventListener("click",function(){animOn=!animOn;if(animOn&&reduced)animOn=false;bAnim.textContent=animOn?"pause":"play"});
  var rigOn=false,rigPts=new T.Points(new T.BufferGeometry(),new T.PointsMaterial({color:0xf0a32f,size:0.11,depthTest:false,transparent:true})),rigLines=new T.LineSegments(new T.BufferGeometry(),new T.LineBasicMaterial({color:0xf4efe0,depthTest:false,transparent:true,opacity:0.9}));
  rigPts.renderOrder=rigLines.renderOrder=999;rigPts.visible=rigLines.visible=false;rigPts.frustumCulled=rigLines.frustumCulled=false;sc.add(rigPts);sc.add(rigLines);
  function updateRig(){
    if(!rigOn)return;var pp=[],ll=[],v=new T.Vector3(),w=new T.Vector3(),i;
    for(i=0;i<N;i++){var par=pidx[i];if(!(par>=0)&&!hasKids[i]&&parts[i].shape!=="joint")continue;items[i].userData.node.getWorldPosition(v);pp.push(v.x,v.y,v.z);if(par>=0){items[par].userData.node.getWorldPosition(w);ll.push(w.x,w.y,w.z,v.x,v.y,v.z)}}
    rigPts.geometry.setAttribute("position",new T.Float32BufferAttribute(pp,3));rigLines.geometry.setAttribute("position",new T.Float32BufferAttribute(ll,3))}
  function setRig(b){rigOn=!!b;rigPts.visible=rigLines.visible=rigOn;bRig.textContent=rigOn?"hide rig":"show rig";bRig.classList.toggle("on",rigOn);updateRig();draw()}
  bRig.addEventListener("click",function(){setRig(!rigOn)});
  function buildClips(){
    var out=[];
    anims.forEach(function(c){
      var step=1/30,n=Math.ceil(c.dur/step)+1,times=[],q=items.map(function(){return[]}),ps=items.map(function(){return[]}),mv=items.map(function(){return false}),k,i;
      for(k=0;k<n;k++){times.push(Math.min(c.dur,k*step));applyAnim(c,times[k]);for(i=0;i<N;i++){var nd=items[i].userData.node,rs=nd.userData.rest;q[i].push(nd.quaternion.x,nd.quaternion.y,nd.quaternion.z,nd.quaternion.w);ps[i].push(nd.position.x,nd.position.y,nd.position.z);if(Math.abs(nd.quaternion.w)<0.99999||nd.position.distanceTo(rs)>1e-5)mv[i]=true}}
      var tr=[];for(i=0;i<N;i++)if(mv[i]){var nm=items[i].userData.node.name;tr.push(new T.QuaternionKeyframeTrack(nm+".quaternion",times,q[i]),new T.VectorKeyframeTrack(nm+".position",times,ps[i]))}
      if(tr.length)out.push(new T.AnimationClip(c.name,c.dur,tr))});
    if(curA>=0)applyAnim(anims[curA],animT);else restPose();
    return out}

  // ── scripts: JS Ares writes for anything the engine has no feature for (water, lava, rain, wind, physics, particles...).
  //    Each runs in its own api with init/update/cleanup; objects it adds are removed when it changes; errors go back to Ares. ──
  var NL=String.fromCharCode(10),LIBS={"cannon-es":"https://esm.sh/cannon-es@0.20.0","rapier":"https://esm.sh/@dimforge/rapier3d-compat@0.12.1"},libCache={},runs={},evHandlers={},sClock=0,lastEvT=0;
  function report(name,msg,info){
    try{console[info?"log":"error"]("[studio script "+name+"] "+msg)}catch(e){}
    if(studio)try{fetch("/__ares/studio/"+studio+"/log",{method:"POST",body:JSON.stringify({name:name,msg:String(msg).slice(0,260)})}).catch(function(){})}catch(e){}}
  function emit(n,d){(evHandlers[n]||[]).slice().forEach(function(h){try{h.fn(d)}catch(e){report(h.owner,"on("+n+"): "+(e&&e.message||e))}})}
  function makeApi(name){
    var created=[],mine=[],seed=hash(name),hudEl=function(){if(!window.__hud){window.__hud=document.createElement("div");window.__hud.className="k-hud";stage.appendChild(window.__hud)}return window.__hud},api={THREE:T,scene:sc,camera:cam,renderer:r,root:root,time:0,dt:0,state:{},
      part:function(n){var i=parts.findIndex(function(q){return q.name===n});if(i<0)return null;var g=items[i];return{group:g,mesh:g.userData.mesh,geometry:g.userData.mesh.geometry,node:g.userData.node,spec:parts[i]}},
      parts:function(){return items.map(function(g,i){return{group:g,mesh:g.userData.mesh,geometry:g.userData.mesh.geometry,node:g.userData.node,spec:parts[i]}})},
      add:function(o){sc.add(o);created.push(o);return o},remove:function(o){sc.remove(o);var k=created.indexOf(o);if(k>=0)created.splice(k,1)},
      on:function(n2,fn){var h={fn:fn,owner:name};(evHandlers[n2]=evHandlers[n2]||[]).push(h);mine.push([n2,h])},emit:emit,
      lib:function(n2){if(!LIBS[n2])return Promise.reject(new Error("unknown lib "+n2+" (have: "+Object.keys(LIBS).join(", ")+")"));return libCache[n2]||(libCache[n2]=import(LIBS[n2]))},
      rand:function(){seed=(Math.imul(seed,1664525)+1013904223)|0;return((seed>>>0)%1000003)/1000003},noise:noise3,fbm:fbm,log:function(m){report(name,m,true)},
      refreshEdges:function(n2){var i=parts.findIndex(function(q){return q.name===n2});if(i<0)return;var u=items[i].userData,gm=u.mesh.geometry;u.ed.geometry.dispose();u.ed.geometry=(parts[i].wire||parts[i].mat==="holo")?new T.WireframeGeometry(gm):new T.EdgesGeometry(gm,28)},
      stats:function(){var i=r.info;return{draws:i.render.calls,tris:i.render.triangles,parts:items.length}},
      canvasTexture:function(w,h,draw,o){var t=makeCanvasTexture(w,h,draw,o);created.push({dispose:function(){t.dispose()}});return t},
      ui:{}};
    // in-scene controls: a HUD over the stage (buttons, toggles, sliders, selects, live text) - removed with the script
    var dom=[];function node(el){hudEl().appendChild(el);dom.push(el);return el}
    api.ui.title=function(t){return node(mk("div","k-hud-h",t))};
    api.ui.text=function(t){var e=node(mk("div","k-hud-t",t||""));return{set:function(v){e.textContent=v}}};
    api.ui.button=function(label,fn){var b=node(mk("button","k-hud-b",label));b.type="button";b.addEventListener("click",function(){try{fn(b)}catch(e){report(name,"ui: "+(e&&e.message||e))}});return b};
    api.ui.toggle=function(label,on,fn){var b=node(mk("button","k-hud-b"+(on?" on":""),label));b.type="button";b.addEventListener("click",function(){on=!on;b.classList.toggle("on",on);try{fn(on)}catch(e){report(name,"ui: "+(e&&e.message||e))}});return b};
    api.ui.slider=function(label,min,max,val,fn,step){var row=node(mk("label","k-hud-r")),out=mk("b","",String(val)),inp=document.createElement("input");inp.type="range";inp.min=min;inp.max=max;inp.step=step||(max-min)/100;inp.value=val;row.appendChild(mk("span","",label));row.appendChild(out);row.appendChild(inp);inp.addEventListener("input",function(){out.textContent=String(Math.round(+inp.value*100)/100);try{fn(+inp.value)}catch(e){report(name,"ui: "+(e&&e.message||e))}});return inp};
    api.ui.select=function(label,opts,val,fn){var row=node(mk("label","k-hud-r")),sel=document.createElement("select");sel.className="k-sel";opts.forEach(function(o){var op=document.createElement("option");op.value=o;op.textContent=o;sel.appendChild(op)});sel.value=val;row.appendChild(mk("span","",label));row.appendChild(sel);sel.addEventListener("change",function(){try{fn(sel.value)}catch(e){report(name,"ui: "+(e&&e.message||e))}});return sel};

    api._dispose=function(){dom.forEach(function(e){e.remove()});dom.length=0;created.forEach(function(o){sc.remove(o);if(o.geometry)o.geometry.dispose&&o.geometry.dispose();if(o.material&&o.material.dispose)o.material.dispose()});created.length=0;mine.forEach(function(m){var L=evHandlers[m[0]]||[],k=L.indexOf(m[1]);if(k>=0)L.splice(k,1)});mine.length=0};
    return api}
  function stopScript(name){var r0=runs[name];if(!r0)return;try{if(r0.fns&&r0.fns.cleanup)r0.fns.cleanup(r0.api)}catch(e){}r0.api._dispose();delete runs[name]}
  function syncScripts(list){
    var want={};(list||[]).forEach(function(sc2){want[sc2.name]=sc2});
    Object.keys(runs).forEach(function(n){if(!want[n]||!want[n].enabled||runs[n].code!==want[n].code)stopScript(n)});
    Object.keys(want).forEach(function(n){
      var sc2=want[n];if(!sc2.enabled||runs[n])return;
      var run={code:sc2.code,api:makeApi(n),fns:null,ready:false,dead:false};runs[n]=run;
      try{run.fns=new Function("api","'use strict';"+NL+sc2.code+NL+";return {init:typeof init==='function'?init:null,update:typeof update==='function'?update:null,cleanup:typeof cleanup==='function'?cleanup:null};")(run.api)}
      catch(e){run.dead=true;report(n,"compile: "+(e&&e.message||e));return}
      try{Promise.resolve(run.fns.init?run.fns.init(run.api):0).then(function(){run.ready=true},function(e){run.dead=true;report(n,"init: "+(e&&e.message||e))})}
      catch(e){run.dead=true;report(n,"init: "+(e&&e.message||e))}})}
  function stepScripts(dt){
    sClock+=dt;
    Object.keys(runs).forEach(function(n){var r0=runs[n];if(!r0.ready||r0.dead||!r0.fns.update)return;r0.api.time=sClock;r0.api.dt=dt;
      try{r0.fns.update(r0.api)}catch(e){r0.dead=true;report(n,"update: "+(e&&e.message||e)+" (script stopped; edit it to restart)")}})}
  function fireEvents(c,prev,cur){
    (c.events||[]).forEach(function(e){var hit=cur>=prev?(e.t>prev&&e.t<=cur):(e.t>prev||e.t<=cur);if(hit)emit(e.name,e.data)})}
  addEventListener("keydown",function(e){if(!/^(INPUT|SELECT|TEXTAREA)$/.test((e.target&&e.target.tagName)||""))emit("key",{code:e.code,key:e.key,down:true})});
  addEventListener("keyup",function(e){emit("key",{code:e.code,key:e.key,down:false})});
  if(spec.scripts)syncScripts(spec.scripts);
  refreshAnimUI();if(anims.length&&reduced)applyAnim(anims[0],0);
  function setWire(b){wire=!!b;mats.forEach(function(m){m.wireframe=wire});edges.forEach(function(e,k){e.visible=!wire&&edgeVis(parts[k])});bWire.textContent=wire?"solid":"wireframe";draw()}
  bWire.addEventListener("click",function(){setWire(!wire)});
  // sculpt-style progression: faceted (raw low-poly) <-> smooth-shaded (refined): average normals across shared vertices
  var smoothOn=false;
  function weld(g,on){
    if(g.userData.flatN===undefined&&g.attributes.normal)g.userData.flatN=g.attributes.normal.array.slice();
    var pa=g.attributes.position,na=g.attributes.normal;if(!na||g.index)return;
    if(!on){if(g.userData.flatN){na.array.set(g.userData.flatN);na.needsUpdate=true}return}
    var acc={},i,k;for(i=0;i<pa.count;i++){k=Math.round(pa.getX(i)*500)+","+Math.round(pa.getY(i)*500)+","+Math.round(pa.getZ(i)*500);var a=acc[k]||(acc[k]=[0,0,0]);a[0]+=g.userData.flatN[3*i];a[1]+=g.userData.flatN[3*i+1];a[2]+=g.userData.flatN[3*i+2]}
    for(i=0;i<pa.count;i++){k=Math.round(pa.getX(i)*500)+","+Math.round(pa.getY(i)*500)+","+Math.round(pa.getZ(i)*500);var v=acc[k],l=Math.hypot(v[0],v[1],v[2])||1;na.setXYZ(i,v[0]/l,v[1]/l,v[2]/l)}
    na.needsUpdate=true}
  function setSmoothShade(b){smoothOn=!!b;items.forEach(function(g){var u=g.userData;if(u.mesh.geometry.attributes.color||parts[items.indexOf(g)].shape==="mesh"||parts[items.indexOf(g)].shape==="poly"){weld(u.mesh.geometry,smoothOn);u.mat.flatShading=!smoothOn;u.mat.needsUpdate=true;u.ed.visible=!smoothOn&&edgeVis(parts[items.indexOf(g)])&&!wire}});bShade.textContent=smoothOn?"faceted":"smooth shading";draw()}
  bShade.addEventListener("click",function(){setSmoothShade(!smoothOn)});
  function flash(b,t){var o=b.textContent;b.textContent=t;setTimeout(function(){b.textContent=o},1600)}
  bCopy.addEventListener("click",function(){var txt=JSON.stringify({format:"ares-model/1",style:spec.style||"",look:lookSel.value,parts:parts,anims:anims});try{navigator.clipboard.writeText(txt).then(function(){flash(bCopy,"copied")},function(){flash(bCopy,"copy failed")})}catch(e){flash(bCopy,"copy failed")}});
  bGlb.addEventListener("click",function(){
    import("https://esm.sh/three@0.160.0/examples/jsm/exporters/GLTFExporter.js").then(function(M){
      selBox.visible=false;var clips=buildClips();new M.GLTFExporter().parse(root,function(buf){var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([buf],{type:"model/gltf-binary"}));a.download=(spec.title||"model")+".glb";document.body.appendChild(a);a.click();a.remove();flash(bGlb,"exported")},function(){flash(bGlb,"export failed")},{binary:true,animations:clips})
    }).catch(function(){flash(bGlb,"export failed")})});
  var pending=[],nextAt=0,rough={},roughAt=0;
  // replace a part in place (a sculpt growing blob by blob, or its final full-resolution version)
  function replaceOne(p,i){
    p=snapParts([p],parts)[0];var old=items[i],g=make(p);items.pop();mats.pop();edges.pop();
    items[i]=g;mats[i]=g.userData.mat;edges[i]=g.userData.ed;parts[i]=p;
    if(old.userData.node.parent)old.userData.node.parent.remove(old.userData.node);disposeObject(old);
    relink();rebox();if(!box.isEmpty())fitWorld();if(reduced||inst){ctr.copy(tctr);rad=trad}pose()}
  function stepRough(now){
    if(now<roughAt)return;var ks=Object.keys(rough);if(!ks.length)return;var t0=performance.now();
    ks.forEach(function(n){var p=rough[n],i=parts.findIndex(function(q){return q.name===n});delete rough[n];
      if(i>=0)replaceOne(p,i);else{p=snapParts([p],parts.concat([p]))[0];parts.push(p);N=parts.length;var g=make(p);g.userData.born=-1e9;headP=N;relink();rebox();fitWorld();if(reduced||inst){ctr.copy(tctr);rad=trad}}});
    roughAt=now+Math.max(160,(performance.now()-t0)*1.5)}
  function addOne(p){
    delete rough[p.name];var ex=parts.findIndex(function(q){return q.name===p.name});if(ex>=0){replaceOne(p,ex);return}
    p=snapParts([p],parts.concat([p]))[0];parts.push(p);N=parts.length;if(N===1)box.makeEmpty();var g=make(p);g.userData.born=reduced?-1e9:performance.now();headP=N;
    relink();if(!p.scenery)box.expandByObject(g);fitWorld();if(reduced||inst){ctr.copy(tctr);rad=trad}
  }
  el.__live={
    addParts:function(list){(list||[]).forEach(function(p){if(parts.length+pending.length<220)pending.push(p)});if(reduced)flushAll()},
    sculpt:function(list){(list||[]).forEach(function(p){rough[p.name]=p});if(reduced){stepRough(1e15);draw()}},
    addAnim:function(a){anims.push(a);if(curA<0){curA=0;animOn=!reduced}refreshAnimUI()},
    finish:function(){rough={};flushAll();live=false;settleUntil=performance.now()+3000;headP=N;pose();bPlay.hidden=bRe.hidden=false;draw()}
  };
  function flushAll(){while(pending.length)addOne(pending.shift());pose();draw()}
  if(live){bPlay.hidden=bRe.hidden=bStep.hidden=true;tag.textContent="3D studio · building live"}

  // ── studio mode: Ares edits this model while you watch. The server holds the document; this page polls it and
  //    reconciles in place - unchanged parts morph to their new transform, new/changed parts pop in, removed ones shrink out ──
  var tweens=[],ghosts=[],refImg=null,settledOnce=false;
  function geoKey(p){return JSON.stringify([p.shape,p.pts,p.sections,p.verts,p.faces,p.seg,p.detail,p.jitter,p.low,p.steps,p.depth,p.bevel,p.r,p.r2,p.caps,p.facets,p.color,p.color2,p.grad,p.mid,p.shade,p.mat,p.smooth,p.fcolors,p.wire,p.edgeColor,p.texture,p.blobs,p.res,p.noise,p.tint,p.ao,p.fuzz,p.tex,p.grain,p.bone])}
  function setRef(src){
    if(!src){if(refImg){refImg.remove();refImg=null}return}
    if(!refImg){refImg=document.createElement("img");refImg.className="k-ref";refImg.alt="reference";refImg.title="reference - click to fade";refImg.addEventListener("click",function(){refImg.style.opacity=refImg.style.opacity==="0.2"?"1":"0.2"});stage.appendChild(refImg)}
    if(refImg.getAttribute("src")!==src)refImg.src=src}
  var bdUrl="",bdFrame=null;
  function setBackdrop(u){
    u=u||"";if(u===bdUrl)return;bdUrl=u;
    if(!u){if(bdFrame){bdFrame.remove();bdFrame=null}return}
    if(!bdFrame){bdFrame=document.createElement("iframe");bdFrame.className="k-backdrop";bdFrame.setAttribute("tabindex","-1");bdFrame.setAttribute("aria-hidden","true");stage.insertBefore(bdFrame,stage.firstChild)}
    bdFrame.src=u}
  function setModel(ns){
    var now=performance.now(),oldByName={},oldItems=items.slice(),oldParts=parts.slice(),keep={},nItems=[],nMats=[],nEdges=[],nParts=snapParts(ns.parts||[]);
    oldParts.forEach(function(q,k){oldByName[q.name]=k});
    var fresh=nParts.filter(function(np){var k=oldByName[np.name];return k===undefined||geoKey(oldParts[k])!==geoKey(np)}).length,gap=Math.min(90,1600/Math.max(1,fresh)),nth=0;
    nParts.forEach(function(np){
      var k=oldByName[np.name],g;
      if(k!==undefined&&geoKey(oldParts[k])===geoKey(np)){
        g=oldItems[k];keep[k]=1;var u=g.userData,pv=np.pivot||np.pos;
        tweens.push({g:g,t0:now,dur:560,b0:u.base.slice(),b1:[np.size[0],np.size[1],np.size[2]],p0:[g.position.x,u.y,g.position.z],p1:[np.pos[0]-pv[0],np.pos[1]-pv[1],np.pos[2]-pv[2]],r0:[g.rotation.x,g.rotation.y,g.rotation.z],r1:[np.rot[0]*D,np.rot[1]*D,np.rot[2]*D]});
      }else{g=make(np);g.userData.born=reduced?-1e9:now+(nth++)*gap;items.pop();mats.pop();edges.pop()}
      nItems.push(g);nMats.push(g.userData.mat);nEdges.push(g.userData.ed)});
    oldItems.forEach(function(g,k){if(!keep[k])ghosts.push({g:g,t0:now})});
    items.length=0;mats.length=0;edges.length=0;nItems.forEach(function(g){items.push(g)});nMats.forEach(function(m){mats.push(m)});nEdges.forEach(function(e){edges.push(e)});
    parts.length=0;nParts.forEach(function(q){parts.push(q)});N=parts.length;headP=N;
    relink();
    rebox();if(!box.isEmpty())fitWorld();
    if(reduced){ctr.copy(tctr);rad=trad}
    settleUntil=now+2500;
    anims.length=0;(ns.anims||[]).forEach(function(a){anims.push(a)});if(curA>=anims.length)curA=anims.length-1;if(curA<0&&anims.length){curA=0;animOn=!reduced}if(!anims.length)restPose();
    refreshAnimUI();
    if(ns.look&&LOOKS[ns.look]&&ns.look!==curLook){curLook=ns.look;lookSel.value=ns.look;look(ns.look)}
    if(ns.title)tag.textContent="3D studio · "+ns.title;
    setRef(ns.ref);setBackdrop(ns.backdrop);emit("parts",null);syncScripts(ns.scripts);applyView(ns.view);
    if(curA>=0&&!animOn&&animT>0)applyAnim(anims[curA],animT);select(-1);settledOnce=true;pose();draw()}
  var lastView={},viewZoom=1,lastCam="3q";
  function applyView(v0){
    if(!v0)return;var v={};Object.keys(v0).forEach(function(k){if(JSON.stringify(v0[k])!==JSON.stringify(lastView[k]))v[k]=v0[k]});lastView=JSON.parse(JSON.stringify(v0));
    if(typeof v.wire==="boolean"&&v.wire!==wire)setWire(v.wire);
    if(typeof v.smooth==="boolean"&&v.smooth!==smoothOn)setSmoothShade(v.smooth);
    if(typeof v.rig==="boolean"&&v.rig!==rigOn)setRig(v.rig);
    if(typeof v.spin==="boolean"){ctl.autoRotate=v.spin;bSpin.classList.toggle("on",v.spin)}
    if(typeof v.speed==="number"){animSpeed=v.speed}
    if(typeof v.anim==="string"){var ai=anims.findIndex(function(a){return a.name===v.anim});if(ai>=0&&ai!==curA){crossfade();curA=ai;animT=0;aSel.value=ai;if(!animOn)applyAnim(anims[curA],0)}}
    if(typeof v.play==="boolean"&&anims.length){animOn=v.play&&!reduced;bAnim.textContent=animOn?"pause":"play"}
    if(typeof v.t==="number"&&curA>=0){animOn=false;animT=v.t;applyAnim(anims[curA],v.t);bAnim.textContent="play"}
    if(v.fit==="anim"&&curA>=0)fitAnim(anims[curA]);else if(v.fit==="rest"){rebox();fitWorld()}
    if(typeof v.zoom==="number")viewZoom=v.zoom;
    if(typeof v.camera==="string"&&window.__aresView)lastCam=v.camera;
    if((typeof v.camera==="string"||typeof v.zoom==="number"||v.fit)&&window.__aresView)window.__aresView(lastCam)}
  // frame the model across its WHOLE clip (an opened lid or a leaping fox must not be cropped)
  function fitAnim(c){
    var fb=new T.Box3(),dur=c.dur||1,k;
    for(k=0;k<=8;k++){applyAnim(c,dur*k/8);root.updateMatrixWorld(true);items.forEach(function(g,i){if(!(parts[i]&&parts[i].scenery))fb.expandByObject(g)})}
    if(curA>=0&&!animOn&&animT>0)applyAnim(c,animT);else if(!animOn)restPose();
    if(!fb.isEmpty()){box.copy(fb);fitWorld()}}
  function stepTweens(now){
    var i;for(i=tweens.length-1;i>=0;i--){var t=tweens[i],k=Math.min(1,(now-t.t0)/t.dur),e=k*k*(3-2*k),u=t.g.userData,j;
      if(items.indexOf(t.g)<0){tweens.splice(i,1);continue}
      for(j=0;j<3;j++)u.base[j]=t.b0[j]+(t.b1[j]-t.b0[j])*e;
      t.g.position.x=t.p0[0]+(t.p1[0]-t.p0[0])*e;u.y=t.p0[1]+(t.p1[1]-t.p0[1])*e;t.g.position.z=t.p0[2]+(t.p1[2]-t.p0[2])*e;
      t.g.rotation.set(t.r0[0]+(t.r1[0]-t.r0[0])*e,t.r0[1]+(t.r1[1]-t.r0[1])*e,t.r0[2]+(t.r1[2]-t.r0[2])*e);
      if(k>=1)tweens.splice(i,1)}
    for(i=ghosts.length-1;i>=0;i--){var gh=ghosts[i],q=Math.min(1,(now-gh.t0)/260),s3=1-q;gh.g.scale.set(Math.max(0.001,gh.g.userData.base[0]*s3),Math.max(0.001,gh.g.userData.base[1]*s3),Math.max(0.001,gh.g.userData.base[2]*s3));
      if(q>=1){var nd=gh.g.userData.node;if(nd.parent)nd.parent.remove(nd);disposeObject(gh.g);ghosts.splice(i,1)}}}
  // a deterministic pose for screenshots: __aresView("side", 1.2) freezes the current clip at t=1.2s; __aresResume() lets it play on
  var heldPlay=null;
  window.__aresResume=function(){if(heldPlay!==null){animOn=heldPlay&&!reduced;heldPlay=null;bAnim.textContent=animOn?"pause":"play"}};
  window.__aresView=function(name,t){
    if(typeof t==="number"&&curA>=0){if(heldPlay===null)heldPlay=animOn;animOn=false;animT=t;applyAnim(anims[curA],t)}
    var dirs={front:[0,0.12,1],back:[0,0.12,-1],side:[1,0.12,0],top:[0,1,0.001],"3q":[1.05,0.55,1.55]},d=dirs[name]||dirs["3q"],v=new T.Vector3(d[0],d[1],d[2]).normalize();
    ctl.autoRotate=false;bSpin.classList.remove("on");userTook=true;sel=-1;ctl.target.copy(tctr);cam.position.copy(tctr).addScaledVector(v,trad*2.7*viewZoom);ctl.update();
    if(el.scrollIntoView)el.scrollIntoView({block:"center"});draw();return name};
  // a hosting page that opted in (spec.manual, e.g. the in-app tour) drives the studio by postMessage instead of polling a server
  if(studio&&spec.manual){
    addEventListener("message",function(e){var m=e.data;if(e.source!==parent||!m||typeof m!=="object")return;
      if(m.ares==="studio"&&m.spec){try{setModel(m.spec)}catch(err){report("studio","apply: "+(err&&err.message||err))}}
      else if(m.ares==="view"&&typeof m.name==="string"&&window.__aresView)window.__aresView(m.name)})
    try{parent.postMessage({ares:"studio-ready"},"*")}catch(err){}}
  if(studio&&!spec.manual){
    capX.textContent="waiting for Ares";var sv=0;
    (function poll(){fetch("/__ares/studio/"+studio+"?since="+sv,{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){if(d&&d.v!==undefined&&d.v<sv)sv=0;if(d&&d.spec&&d.v>sv){sv=d.v;try{setModel(d.spec)}catch(e){report("studio","apply: "+(e&&e.message||e))}}else if(d&&d.v!==undefined&&d.v>sv)sv=d.v}).catch(function(){}).then(function(){setTimeout(poll,350)})})()}
  pose();draw();
  if(!reduced){var last=performance.now();(function loop(now){var dt=Math.min(0.05,(now-last)/1000);last=now;
    if(live&&pending.length&&now>=nextAt){addOne(pending.shift());nextAt=now+Math.max(40,170-pending.length*25)}
    if(live)stepRough(now);
    if((live||now<settleUntil)&&!userTook){ctl.target.lerp(tctr,0.08);var off=cam.position.clone().sub(ctl.target),dd=off.length();off.setLength(dd+(trad*1.95-dd)*0.06);cam.position.copy(ctl.target).add(off)}
    if(playing&&headP<N){headP=Math.min(N,headP+dt*rate);pose();if(headP>=N)playing=false}
    if(tweens.length||ghosts.length)stepTweens(now);if(studio)pose();
    if(animOn&&curA>=0){var pT=animT;animT+=dt*animSpeed;applyAnim(anims[curA],animT);if(xf){xf.t+=dt;rigBlend(items.map(function(g){return g.userData.node}),xf.s,xf.t/0.3);if(xf.t>=0.3)xf=null}var cd=anims[curA].dur||1;fireEvents(anims[curA],((pT%cd)+cd)%cd,((animT%cd)+cd)%cd)}
    stepScripts(dt);
    updateRig();if(live)pose();draw();requestAnimationFrame(loop)})(last)}
  else ctl.addEventListener("change",draw);
  addEventListener("resize",function(){var nw=stage.clientWidth||w;h=stageH();r.setSize(nw,h);cam.aspect=nw/h;cam.updateProjectionMatrix();draw()});
}
window.__aresBuild=window.__aresBuild||{};window.__aresBuild.rig=build;
if(window.__aresDrain)window.__aresDrain();
document.querySelectorAll(".k-rig").forEach(function(el){try{build(el)}catch(e){el.textContent="model view unavailable: "+e.message}});
`.trim();
