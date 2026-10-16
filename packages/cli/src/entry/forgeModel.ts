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

export const FORGE_MODEL_JS = FORGE_THREE_LOAD + `
var reduced=!!(matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches);
function mk(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function hsh(n){n=Math.imul(n^(n>>>15),2246822519);n=Math.imul(n^(n>>>13),3266489917);return((n^(n>>>16))>>>0)/4294967296}
function hash(s){var h=7;s=String(s);for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;return h}
function jit(g,amt,seed){
  var pa=g.attributes.position,i;
  for(i=0;i<pa.count;i++){var x=pa.getX(i),y=pa.getY(i),z=pa.getZ(i),k=(Math.round(x*997)*73856093)^(Math.round(y*997)*19349663)^(Math.round(z*997)*83492791)^seed;pa.setXYZ(i,x+(hsh(k)-0.5)*2*amt,y+(hsh(k+1)-0.5)*2*amt,z+(hsh(k+2)-0.5)*2*amt)}
  g.computeVertexNormals();return g}
function geo(p){
  var s=p.shape,pts=p.pts||[],i,lo=!!p.low;
  if(s==="sphere")return new T.SphereGeometry(0.5,lo?7:28,lo?5:20);
  if(s==="cylinder")return new T.CylinderGeometry(0.5,0.5,1,lo?7:24);
  if(s==="cone")return new T.ConeGeometry(0.5,1,lo?6:24);
  if(s==="pyramid"){var g=new T.ConeGeometry(0.7071,1,4);g.rotateY(Math.PI/4);return g}
  if(s==="prism")return new T.CylinderGeometry(0.58,0.58,1,3);
  if(s==="torus")return new T.TorusGeometry(0.38,0.12,lo?6:14,lo?10:36);
  if(s==="capsule")return new T.CapsuleGeometry(0.35,0.3,lo?2:6,lo?6:16);
  if(s==="poly"){var ig=new T.IcosahedronGeometry(0.5,p.detail||0);if(p.jitter)jit(ig,p.jitter,hash(p.name||"p"));return ig}
  if(s==="mesh"){
    var pos=[],tf=[];p.faces.forEach(function(f,fi){for(var k=1;k<f.length-1;k++){[f[0],f[k],f[k+1]].forEach(function(vi){var v=p.verts[vi];pos.push(v[0],v[1],v[2])});tf.push(fi)}});
    var mg=new T.BufferGeometry();mg.setAttribute("position",new T.Float32BufferAttribute(pos,3));mg.computeVertexNormals();mg.userData.tf=tf;mg.userData.fc=p.fcolors||null;return mg}
  if(s==="loft"){
    // cross-section rings along a spine: [x,y,z,rx,ry] per ring; ellipse oriented by the spine direction
    var sec=p.sections,seg=p.seg||8,rings=[],sub=lo?1:4,ci=new T.CatmullRomCurve3(sec.map(function(q){return new T.Vector3(q[0],q[1],q[2])}),false,"catmullrom",0.5),ri=new T.CatmullRomCurve3(sec.map(function(q){return new T.Vector3(q[3],q[4],0)}),false,"catmullrom",0.5),nr=(sec.length-1)*sub+1,k;
    for(k=0;k<nr;k++){var u=k/(nr-1),c=ci.getPoint(u),rr=ri.getPoint(u),tn=ci.getTangent(u).normalize(),up=Math.abs(tn.y)>0.95?new T.Vector3(1,0,0):new T.Vector3(0,1,0),sd=new T.Vector3().crossVectors(up,tn).normalize(),ud=new T.Vector3().crossVectors(tn,sd).normalize();rings.push({c:c,sd:sd.multiplyScalar(Math.max(0,rr.x)),ud:ud.multiplyScalar(Math.max(0,rr.y))})}
    var lp=[],pt=function(r,j){var a=j/seg*Math.PI*2;return new T.Vector3().copy(r.c).addScaledVector(r.sd,Math.cos(a)).addScaledVector(r.ud,Math.sin(a))},push=function(v){lp.push(v.x,v.y,v.z)};
    for(k=0;k<nr-1;k++)for(var j=0;j<seg;j++){var a0=pt(rings[k],j),a1=pt(rings[k],j+1),b0=pt(rings[k+1],j),b1=pt(rings[k+1],j+1);push(a0);push(b0);push(a1);push(a1);push(b0);push(b1)}
    for(var e=0;e<2;e++){var rg=rings[e?nr-1:0];for(j=0;j<seg;j++){var q0=pt(rg,j),q1=pt(rg,j+1);if(e){push(rg.c);push(q1);push(q0)}else{push(rg.c);push(q0);push(q1)}}}
    var lg=new T.BufferGeometry();lg.setAttribute("position",new T.Float32BufferAttribute(lp,3));lg.computeVertexNormals();return lg}
  if(s==="arch"){
    var as=new T.Shape();as.moveTo(-0.5,0);as.lineTo(0.5,0);as.lineTo(0.5,1);as.lineTo(-0.5,1);as.closePath();
    var ah=new T.Path();ah.moveTo(-0.28,0);ah.lineTo(-0.28,0.5);ah.absarc(0,0.5,0.28,Math.PI,0,true);ah.lineTo(0.28,0);as.holes.push(ah);
    var ag=new T.ExtrudeGeometry(as,{depth:1,bevelEnabled:false,curveSegments:lo?4:16});ag.translate(0,0,-0.5);return ag}
  if(s==="stairs"){
    var n2=p.steps||4,ss=new T.Shape();ss.moveTo(-0.5,0);for(i=0;i<n2;i++){ss.lineTo(-0.5+i/n2,(i+1)/n2);ss.lineTo(-0.5+(i+1)/n2,(i+1)/n2)}ss.lineTo(0.5,0);ss.closePath();
    var sg=new T.ExtrudeGeometry(ss,{depth:1,bevelEnabled:false});sg.translate(0,0,-0.5);return sg}
  if(s==="extrude"){
    var sh=new T.Shape();sh.moveTo(pts[0][0],pts[0][1]);for(i=1;i<pts.length;i++)sh.lineTo(pts[i][0],pts[i][1]);sh.closePath();
    var bv=p.bevel||0,d=Math.max(0.01,(p.depth||1)-bv*2),eg=new T.ExtrudeGeometry(sh,{depth:d,bevelEnabled:bv>0,bevelThickness:bv,bevelSize:bv,bevelSegments:2,curveSegments:8});
    eg.translate(0,0,-d/2);return eg}
  if(s==="lathe"){var v=pts.map(function(q){return new T.Vector2(Math.max(0,q[0]),q[1])});return new T.LatheGeometry(v,lo?8:36)}
  if(s==="tube"){
    var cv=new T.CatmullRomCurve3(pts.map(function(q){return new T.Vector3(q[0],q[1],q[2])})),seg=Math.max(lo?4:8,pts.length*(lo?3:8)),rs=lo?5:12,tg=new T.TubeGeometry(cv,seg,1,rs,false),pa=tg.attributes.position,ring=rs+1,v3=new T.Vector3(),c3;
    for(i=0;i<pa.count;i++){var ri=Math.floor(i/ring),k2=ri/seg;c3=cv.getPointAt(Math.min(1,k2));v3.fromBufferAttribute(pa,i).sub(c3).multiplyScalar(p.r+(p.r2-p.r)*k2).add(c3);pa.setXYZ(i,v3.x,v3.y,v3.z)}
    tg.computeVertexNormals();return tg}
  return new T.BoxGeometry(1,1,1);
}
// facet colouring: per-triangle colour (gradient along an axis, per-face overrides, light/dark variation)
function paint(g,p){
  var pa=g.attributes.position,n=pa.count/3,col=new Float32Array(pa.count*3),c1=new T.Color(p.color),c2=p.color2?new T.Color(p.color2):null,ax=p.grad||"y",mn=0,mx=1,tmp=new T.Color(),i,j;
  if(c2){g.computeBoundingBox();mn=g.boundingBox.min[ax];mx=g.boundingBox.max[ax]}
  for(i=0;i<n;i++){
    var cx=(pa.getX(3*i)+pa.getX(3*i+1)+pa.getX(3*i+2))/3,cy=(pa.getY(3*i)+pa.getY(3*i+1)+pa.getY(3*i+2))/3,cz=(pa.getZ(3*i)+pa.getZ(3*i+1)+pa.getZ(3*i+2))/3,cv=ax==="x"?cx:ax==="y"?cy:cz;
    var fc=g.userData.fc&&g.userData.tf?g.userData.fc[g.userData.tf[i]]:null;
    tmp.copy(c1);
    if(fc)tmp.set(fc);else if(c2){var t=Math.max(0,Math.min(1,((cv-mn)/Math.max(1e-6,mx-mn)-((p.mid||0.5)-0.15))/0.3));tmp.lerp(c2,t)}
    tmp.multiplyScalar(1+(hsh(i*7+13)-0.5)*2*(p.shade||0));
    for(j=0;j<3;j++){col[(3*i+j)*3]=tmp.r;col[(3*i+j)*3+1]=tmp.g;col[(3*i+j)*3+2]=tmp.b}
  }
  g.setAttribute("color",new T.BufferAttribute(col,3));
}
function edgeVis(p){return !!p.wire||p.mat==="holo"||(!p.smooth&&p.mat!=="glass")}
function material(p){
  var o={color:p.color,flatShading:!p.smooth,roughness:0.85,metalness:0.05},m=p.mat;
  if(p.facets||p.fcolors){o.color=0xffffff;o.vertexColors=true;o.flatShading=true}
  if(p.shape==="mesh"||p.shape==="loft")o.side=T.DoubleSide;
  if(m==="clay"){o.roughness=0.62;o.metalness=0}
  if(m==="plastic"){o.roughness=0.3;o.metalness=0;o.clearcoat=0.7;o.clearcoatRoughness=0.25}
  if(m==="holo"){o.transparent=true;o.opacity=0.55;o.emissive=p.color;o.emissiveIntensity=0.55;o.roughness=0.2;o.depthWrite=false;o.flatShading=true}
  if(m==="metal"){o.roughness=0.32;o.metalness=0.85}
  if(m==="glossy"){o.roughness=0.22;o.metalness=0.1}
  if(m==="glass"){o.roughness=0.08;o.metalness=0.1;o.transparent=true;o.opacity=0.42;o.depthWrite=false}
  if(m==="glow"){o.emissive=p.color;o.emissiveIntensity=0.9;o.roughness=0.5}
  return m==="plastic"?new T.MeshPhysicalMaterial(o):new T.MeshStandardMaterial(o);
}
function envMap(r){
  var es=new T.Scene(),sky=new T.Mesh(new T.SphereGeometry(20,24,12),new T.MeshBasicMaterial({vertexColors:true,side:T.BackSide})),pa=sky.geometry.attributes.position,cols=[],c=new T.Color(),i;
  for(i=0;i<pa.count;i++){var y=(pa.getY(i)/20+1)/2;c.setRGB(0.06+0.5*y*y,0.1+0.6*y*y,0.2+0.8*y);cols.push(c.r,c.g,c.b)}
  sky.geometry.setAttribute("color",new T.Float32BufferAttribute(cols,3));es.add(sky);
  [[8,10,6,6],[-9,6,-4,4],[0,12,-9,5]].forEach(function(q){var b=new T.Mesh(new T.BoxGeometry(q[3],0.4,q[3]),new T.MeshBasicMaterial({color:0xffffff}));b.position.set(q[0],q[1],q[2]);b.lookAt(0,0,0);es.add(b)});
  var pm=new T.PMREMGenerator(r),rt=pm.fromScene(es,0.02);pm.dispose();return rt.texture;
}
function ease(k){var c=1.70158;return 1+(c+1)*Math.pow(k-1,3)+c*Math.pow(k-1,2)}
var LOOKS={
  studio:{bg:"radial-gradient(ellipse at 50% 70%,rgba(47,109,240,.2),transparent 65%),rgba(3,6,14,.6)",sun:0xffffff,si:2.6,rim:0x6fa0ff,hemi:0xcfe0ff,hg:0x1a2340,hi:0.8,ex:1},
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
  var parts=spec.parts||[],N=parts.length,live=!!spec.live,inst=!!window.__aresInstant,studio=spec.studio||"";
  var head=mk("div","k-sim-head"),stage=mk("div","k-stage"),cap=mk("div","k-cap"),panel=mk("div","k-panel");
  var tag=mk("span","k-sim-tag","3D studio · "+N+" parts");head.appendChild(tag);
  var bar=mk("span","k-sim-btns"),bPlay=mk("button","k-btn","pause"),bRe=mk("button","k-btn","replay"),bStep=mk("button","k-btn","step"),bWire=mk("button","k-btn","wireframe"),bSpin=mk("button","k-btn","turntable"),bCopy=mk("button","k-btn","copy asset"),bGlb=mk("button","k-btn","export glb"),bShade=mk("button","k-btn","smooth shading");
  [bPlay,bRe,bStep,bWire,bShade,bSpin,bCopy,bGlb].forEach(function(b){b.type="button";bar.appendChild(b)});head.appendChild(bar);
  var capT=mk("b","k-cap-n","0/"+N),capX=mk("span","k-cap-x","ready"),prog=mk("div","k-prog"),progI=mk("span");prog.appendChild(progI);
  cap.appendChild(capT);cap.appendChild(capX);cap.appendChild(prog);
  el.appendChild(head);el.appendChild(stage);el.appendChild(cap);el.appendChild(panel);
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
  var w=stage.clientWidth||600,h=380;
  var r=new T.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:false});r.setPixelRatio(Math.min(2,devicePixelRatio));r.setSize(w,h);stage.appendChild(r.domElement);
  var sc=new T.Scene(),cam=new T.PerspectiveCamera(42,w/h,0.05,500);
  r.shadowMap.enabled=true;r.shadowMap.type=T.PCFSoftShadowMap;sc.environment=envMap(r);
  var hemi=new T.HemisphereLight(0xcfe0ff,0x1a2340,0.8),sun=new T.DirectionalLight(0xffffff,2.6),rim=new T.DirectionalLight(0x6fa0ff,1.1);rim.position.set(-6,3,-5);sc.add(hemi);sc.add(sun);sc.add(rim);
  var ctl=new OrbitControls(cam,r.domElement);ctl.enableDamping=true;ctl.autoRotate=!reduced;ctl.autoRotateSpeed=1.4;
  ctl.addEventListener("start",function(){ctl.autoRotate=false;bSpin.classList.remove("on")});
  var root=new T.Group(),items=[],mats=[],edges=[];sc.add(root);
  function make(p){
    var g=new T.Group(),gm=geo(p);if(p.facets||p.fcolors){if(gm.index)gm=gm.toNonIndexed();paint(gm,p)}var m=material(p),mesh=new T.Mesh(gm,m);mesh.castShadow=true;mesh.receiveShadow=true;g.add(mesh);
    if(p.shape==="tube"&&p.caps){[[0,p.r],[p.pts.length-1,p.r2]].forEach(function(c){var cp=p.pts[c[0]],cm=(p.facets||p.fcolors)?new T.MeshStandardMaterial({color:c[0]===0?p.color:(p.color2||p.color),roughness:0.85,flatShading:!!p.low}):m,cap=new T.Mesh(new T.SphereGeometry(c[1],p.low?6:16,p.low?4:12),cm);cap.position.set(cp[0],cp[1],cp[2]);cap.castShadow=true;g.add(cap)})}
    var wc=p.mat==="holo"&&!p.edgeColor?"#bfe0ff":(p.edgeColor||"#d9a441"),ed=(p.wire||p.mat==="holo")?new T.LineSegments(new T.WireframeGeometry(gm),new T.LineBasicMaterial({color:wc,transparent:true,opacity:0.85})):new T.LineSegments(new T.EdgesGeometry(gm,28),new T.LineBasicMaterial({color:0x070a13,transparent:true,opacity:0.4}));ed.visible=edgeVis(p);g.add(ed);
    // every part hangs off a joint node (the pivot) so animation can rotate it - and its children - about that point
    var pv=p.pivot||p.pos,node=new T.Group();node.name="n"+(uid++);g.name=p.name;
    g.position.set(p.pos[0]-pv[0],p.pos[1]-pv[1],p.pos[2]-pv[2]);g.rotation.set(p.rot[0]*Math.PI/180,p.rot[1]*Math.PI/180,p.rot[2]*Math.PI/180);
    g.userData={base:[p.size[0],p.size[1],p.size[2]],y:p.pos[1]-pv[1],ed:ed,mat:m,mesh:mesh,node:node};g.scale.set(p.size[0],p.size[1],p.size[2]);
    node.add(g);node.position.set(pv[0],pv[1],pv[2]);node.userData.rest=node.position.clone();
    root.add(node);items.push(g);mats.push(m);edges.push(ed);return g}
  var uid=0,pidx=[],hasKids=[];
  function relink(){
    var byName={},i;parts.forEach(function(q,k){if(byName[q.name]===undefined)byName[q.name]=k});
    pidx=[];hasKids=[];
    for(i=0;i<parts.length;i++){
      var q=parts[i],par=-1;
      if(q.parent){var nm=/ [(]mirror[)]$/.test(q.name)&&byName[q.parent+" (mirror)"]!==undefined?q.parent+" (mirror)":q.parent;if(byName[nm]!==undefined&&byName[nm]!==i)par=byName[nm]}
      // break cycles: walk up; if we meet ourselves, cut the link
      for(var hop=0,j=par;j>=0&&hop<40;hop++){var pp=parts[j].parent;if(!pp)break;var nx=byName[pp];if(nx===i){par=-1;break}j=nx===undefined?-1:nx}
      pidx[i]=par;
    }
    for(i=0;i<parts.length;i++){var g=items[i],nd=g.userData.node,pr=pidx[i],pn=pr>=0?items[pr].userData.node:root,pv=parts[i].pivot||parts[i].pos,pp2=pr>=0?(parts[pr].pivot||parts[pr].pos):[0,0,0];
      if(nd.parent!==pn)pn.add(nd);nd.position.set(pv[0]-pp2[0],pv[1]-pp2[1],pv[2]-pp2[2]);nd.userData.rest=nd.position.clone();if(pr>=0)hasKids[pr]=true}
    root.updateMatrixWorld(true);
  }
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
    var ms=document.createElement("select");ms.className="k-sel";["matte","clay","plastic","metal","glossy","glass","glow"].forEach(function(k){var o=document.createElement("option");o.value=k;o.textContent=k;if(k===p.mat)o.selected=true;ms.appendChild(o)});
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
  function match(sel,i){
    var n=parts[i].name,mir=/ [(]mirror[)]$/.test(n),base=mir?n.slice(0,-9):n;
    if(sel.charAt(sel.length-1)==="*"){var b=sel.slice(0,-1);return base.indexOf(b)===0?(mir?2:1):0}
    if(sel===n)return 1;
    return mir&&sel===base?2:(!mir&&sel===base?1:0)}
  function sample(ks,t,c){
    var dur=c.dur||1;t=c.loop?((t%dur)+dur)%dur:Math.max(0,Math.min(dur,t));
    if(ks.length===1||t<=ks[0][0])return ks[0][1];
    for(var i=1;i<ks.length;i++){if(t<=ks[i][0]){var a=ks[i-1],b=ks[i],k=(t-a[0])/Math.max(1e-6,b[0]-a[0]);k=k*k*(3-2*k);return[a[1][0]+(b[1][0]-a[1][0])*k,a[1][1]+(b[1][1]-a[1][1])*k,a[1][2]+(b[1][2]-a[1][2])*k]}}
    return ks[ks.length-1][1]}
  function applyAnim(c,t){
    var i,rot=[],pos=[],sca=[];
    for(i=0;i<N;i++){rot[i]=[0,0,0];pos[i]=[0,0,0];sca[i]=[1,1,1]}
    (c.tracks||[]).forEach(function(tr){for(var i=0;i<N;i++){var m=match(tr.part,i);if(!m)continue;var fl=m===2?-1:1;
      if(tr.rot){var v=sample(tr.rot,t,c);rot[i][0]+=v[0];rot[i][1]+=v[1]*fl;rot[i][2]+=v[2]*fl}
      if(tr.pos){var q=sample(tr.pos,t,c);pos[i][0]+=q[0]*fl;pos[i][1]+=q[1];pos[i][2]+=q[2]}
      if(tr.scale){var z=sample(tr.scale,t,c);sca[i][0]*=z[0];sca[i][1]*=z[1];sca[i][2]*=z[2]}}});
    (c.motion||[]).forEach(function(mo){for(var i=0;i<N;i++){var m=match(mo.part,i);if(!m)continue;
      var ph=mo.phase+(m===2&&mo.mirror&&mo.kind==="swing"?Math.PI:0),a=2*Math.PI*mo.speed*t+ph,ax=mo.axis==="x"?0:mo.axis==="y"?1:2;
      if(mo.kind==="swing"||mo.kind==="wag")rot[i][ax]+=mo.amp*Math.sin(a);
      else if(mo.kind==="spin")rot[i][ax]+=360*mo.speed*t;
      else if(mo.kind==="bob")pos[i][ax]+=mo.amp*Math.sin(a);
      else if(mo.kind==="pulse"){var s2=1+mo.amp*Math.sin(a);sca[i][0]*=s2;sca[i][1]*=s2;sca[i][2]*=s2}}});
    for(i=0;i<N;i++){var nd=items[i].userData.node,rs=nd.userData.rest;nd.rotation.set(rot[i][0]*D,rot[i][1]*D,rot[i][2]*D);nd.position.set(rs.x+pos[i][0],rs.y+pos[i][1],rs.z+pos[i][2]);nd.scale.set(sca[i][0],sca[i][1],sca[i][2])}
  }
  function restPose(){for(var i=0;i<N;i++){var nd=items[i].userData.node;nd.rotation.set(0,0,0);nd.scale.set(1,1,1);nd.position.copy(nd.userData.rest)}}
  var arow=mk("div","k-insp"),aSel=document.createElement("select"),bAnim=mk("button","k-btn","pause"),bRig=mk("button","k-btn","show rig"),aSpd;
  aSel.className="k-sel";aSel.style.gridColumn="auto";arow.style.borderColor="#2f6df0";arow.style.background="rgba(47,109,240,.05)";
  arow.appendChild(mk("b","k-insp-h","Animation"));arow.appendChild(aSel);
  aSpd=slider("Anim speed",0.1,3,0.05,1,function(v){animSpeed=v});arow.appendChild(aSpd);
  var abtns=mk("div","k-insp-btns");bAnim.type=bRig.type="button";abtns.appendChild(bAnim);abtns.appendChild(bRig);arow.appendChild(abtns);panel.appendChild(arow);
  function refreshAnimUI(){
    aSel.textContent="";anims.forEach(function(a,i){var o=document.createElement("option");o.value=i;o.textContent=a.name;aSel.appendChild(o)});aSel.value=curA;
    arow.hidden=!(anims.length||hasKids.some(Boolean));aSel.hidden=bAnim.hidden=aSpd.hidden=!anims.length;bAnim.textContent=animOn?"pause":"play"}
  aSel.addEventListener("change",function(){curA=+aSel.value;animT=0;if(!animOn)applyAnim(anims[curA],0);draw()});
  bAnim.addEventListener("click",function(){animOn=!animOn;if(animOn&&reduced)animOn=false;bAnim.textContent=animOn?"pause":"play"});
  var rigOn=false,rigPts=new T.Points(new T.BufferGeometry(),new T.PointsMaterial({color:0xf0a32f,size:0.11,depthTest:false,transparent:true})),rigLines=new T.LineSegments(new T.BufferGeometry(),new T.LineBasicMaterial({color:0xf4efe0,depthTest:false,transparent:true,opacity:0.9}));
  rigPts.renderOrder=rigLines.renderOrder=999;rigPts.visible=rigLines.visible=false;rigPts.frustumCulled=rigLines.frustumCulled=false;sc.add(rigPts);sc.add(rigLines);
  function updateRig(){
    if(!rigOn)return;var pp=[],ll=[],v=new T.Vector3(),w=new T.Vector3(),i;
    for(i=0;i<N;i++){var par=pidx[i];if(!(par>=0)&&!hasKids[i])continue;items[i].userData.node.getWorldPosition(v);pp.push(v.x,v.y,v.z);if(par>=0){items[par].userData.node.getWorldPosition(w);ll.push(w.x,w.y,w.z,v.x,v.y,v.z)}}
    rigPts.geometry.setAttribute("position",new T.Float32BufferAttribute(pp,3));rigLines.geometry.setAttribute("position",new T.Float32BufferAttribute(ll,3))}
  bRig.addEventListener("click",function(){rigOn=!rigOn;rigPts.visible=rigLines.visible=rigOn;bRig.textContent=rigOn?"hide rig":"show rig";bRig.classList.toggle("on",rigOn);updateRig();draw()});
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
  function report(name,msg){
    try{console.error("[studio script "+name+"] "+msg)}catch(e){}
    if(studio)try{fetch("/__ares/studio/"+studio+"/log",{method:"POST",body:JSON.stringify({name:name,msg:String(msg).slice(0,260)})}).catch(function(){})}catch(e){}}
  function emit(n,d){(evHandlers[n]||[]).slice().forEach(function(h){try{h.fn(d)}catch(e){report(h.owner,"on("+n+"): "+(e&&e.message||e))}})}
  function lat(i,j,k){var h=Math.imul(i,73856093)^Math.imul(j,19349663)^Math.imul(k,83492791);h=Math.imul(h^(h>>>13),1274126177);return(((h^(h>>>16))>>>0)%100000)/100000}
  function sm(t){return t*t*(3-2*t)}
  function noise3(x,y,z){y=y||0;z=z||0;var xi=Math.floor(x),yi=Math.floor(y),zi=Math.floor(z),fx=sm(x-xi),fy=sm(y-yi),fz=sm(z-zi),a=function(dx,dy,dz){return lat(xi+dx,yi+dy,zi+dz)},l=function(p,q,t){return p+(q-p)*t};
    return l(l(l(a(0,0,0),a(1,0,0),fx),l(a(0,1,0),a(1,1,0),fx),fy),l(l(a(0,0,1),a(1,0,1),fx),l(a(0,1,1),a(1,1,1),fx),fy),fz)}
  function fbm(x,y,z,oct){var v=0,amp=0.5,f=1;for(var i=0;i<(oct||4);i++){v+=amp*noise3(x*f,(y||0)*f,(z||0)*f);f*=2;amp*=0.5}return v}
  function makeApi(name){
    var created=[],mine=[],seed=hash(name),hudEl=function(){if(!window.__hud){window.__hud=document.createElement("div");window.__hud.className="k-hud";stage.appendChild(window.__hud)}return window.__hud},api={THREE:T,scene:sc,camera:cam,renderer:r,root:root,time:0,dt:0,state:{},
      part:function(n){var i=parts.findIndex(function(q){return q.name===n});if(i<0)return null;var g=items[i];return{group:g,mesh:g.userData.mesh,geometry:g.userData.mesh.geometry,node:g.userData.node,spec:parts[i]}},
      parts:function(){return items.map(function(g,i){return{group:g,mesh:g.userData.mesh,geometry:g.userData.mesh.geometry,node:g.userData.node,spec:parts[i]}})},
      add:function(o){sc.add(o);created.push(o);return o},remove:function(o){sc.remove(o);var k=created.indexOf(o);if(k>=0)created.splice(k,1)},
      on:function(n2,fn){var h={fn:fn,owner:name};(evHandlers[n2]=evHandlers[n2]||[]).push(h);mine.push([n2,h])},emit:emit,
      lib:function(n2){if(!LIBS[n2])return Promise.reject(new Error("unknown lib "+n2+" (have: "+Object.keys(LIBS).join(", ")+")"));return libCache[n2]||(libCache[n2]=import(LIBS[n2]))},
      rand:function(){seed=(Math.imul(seed,1664525)+1013904223)|0;return((seed>>>0)%1000003)/1000003},noise:noise3,fbm:fbm,log:function(m){report(name,m)},
      stats:function(){var i=r.info;return{draws:i.render.calls,tris:i.render.triangles,parts:items.length}},
      canvasTexture:function(w,h,draw,o){o=o||{};var c=document.createElement("canvas");c.width=w;c.height=h;var x=c.getContext("2d");draw(x,w,h);var t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;t.wrapS=t.wrapT=T.RepeatWrapping;if(o.repeat)t.repeat.set(o.repeat[0],o.repeat[1]);if(o.pixel!==false){t.magFilter=T.NearestFilter;t.minFilter=T.NearestFilter;t.generateMipmaps=false}else t.anisotropy=8;t.needsUpdate=true;created.push({dispose:function(){t.dispose()}});return t},
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
  bWire.addEventListener("click",function(){wire=!wire;mats.forEach(function(m){m.wireframe=wire});edges.forEach(function(e,k){e.visible=!wire&&edgeVis(parts[k])});bWire.textContent=wire?"solid":"wireframe";draw()});
  // sculpt-style progression: faceted (raw low-poly) <-> smooth-shaded (refined): average normals across shared vertices
  var smoothOn=false;
  function weld(g,on){
    if(g.userData.flatN===undefined&&g.attributes.normal)g.userData.flatN=g.attributes.normal.array.slice();
    var pa=g.attributes.position,na=g.attributes.normal;if(!na||g.index)return;
    if(!on){if(g.userData.flatN){na.array.set(g.userData.flatN);na.needsUpdate=true}return}
    var acc={},i,k;for(i=0;i<pa.count;i++){k=Math.round(pa.getX(i)*500)+","+Math.round(pa.getY(i)*500)+","+Math.round(pa.getZ(i)*500);var a=acc[k]||(acc[k]=[0,0,0]);a[0]+=g.userData.flatN[3*i];a[1]+=g.userData.flatN[3*i+1];a[2]+=g.userData.flatN[3*i+2]}
    for(i=0;i<pa.count;i++){k=Math.round(pa.getX(i)*500)+","+Math.round(pa.getY(i)*500)+","+Math.round(pa.getZ(i)*500);var v=acc[k],l=Math.hypot(v[0],v[1],v[2])||1;na.setXYZ(i,v[0]/l,v[1]/l,v[2]/l)}
    na.needsUpdate=true}
  bShade.addEventListener("click",function(){smoothOn=!smoothOn;items.forEach(function(g){var u=g.userData;if(u.mesh.geometry.attributes.color||parts[items.indexOf(g)].shape==="mesh"||parts[items.indexOf(g)].shape==="poly"){weld(u.mesh.geometry,smoothOn);u.mat.flatShading=!smoothOn;u.mat.needsUpdate=true;u.ed.visible=!smoothOn&&edgeVis(parts[items.indexOf(g)])&&!wire}});bShade.textContent=smoothOn?"faceted":"smooth shading";draw()});
  function flash(b,t){var o=b.textContent;b.textContent=t;setTimeout(function(){b.textContent=o},1600)}
  bCopy.addEventListener("click",function(){var txt=JSON.stringify({format:"ares-model/1",style:spec.style||"",look:lookSel.value,parts:parts,anims:anims});try{navigator.clipboard.writeText(txt).then(function(){flash(bCopy,"copied")},function(){flash(bCopy,"copy failed")})}catch(e){flash(bCopy,"copy failed")}});
  bGlb.addEventListener("click",function(){
    import("https://esm.sh/three@0.160.0/examples/jsm/exporters/GLTFExporter.js").then(function(M){
      selBox.visible=false;var clips=buildClips();new M.GLTFExporter().parse(root,function(buf){var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([buf],{type:"model/gltf-binary"}));a.download=(spec.title||"model")+".glb";document.body.appendChild(a);a.click();a.remove();flash(bGlb,"exported")},function(){flash(bGlb,"export failed")},{binary:true,animations:clips})
    }).catch(function(){flash(bGlb,"export failed")})});
  var pending=[],nextAt=0;
  function addOne(p){
    parts.push(p);N=parts.length;if(N===1)box.makeEmpty();var g=make(p);g.userData.born=reduced?-1e9:performance.now();headP=N;
    relink();if(!p.scenery)box.expandByObject(g);fitWorld();if(reduced||inst){ctr.copy(tctr);rad=trad}
  }
  el.__live={
    addParts:function(list){(list||[]).forEach(function(p){if(parts.length+pending.length<220)pending.push(p)});if(reduced)flushAll()},
    addAnim:function(a){anims.push(a);if(curA<0){curA=0;animOn=!reduced}refreshAnimUI()},
    finish:function(){flushAll();live=false;settleUntil=performance.now()+3000;headP=N;pose();bPlay.hidden=bRe.hidden=false;draw()}
  };
  function flushAll(){while(pending.length)addOne(pending.shift());pose();draw()}
  if(live){bPlay.hidden=bRe.hidden=bStep.hidden=true;tag.textContent="3D studio · building live"}

  // ── studio mode: Ares edits this model while you watch. The server holds the document; this page polls it and
  //    reconciles in place - unchanged parts morph to their new transform, new/changed parts pop in, removed ones shrink out ──
  var tweens=[],ghosts=[],refImg=null,settledOnce=false;
  function geoKey(p){return JSON.stringify([p.shape,p.pts,p.sections,p.verts,p.faces,p.seg,p.detail,p.jitter,p.low,p.steps,p.depth,p.bevel,p.r,p.r2,p.caps,p.facets,p.color,p.color2,p.grad,p.mid,p.shade,p.mat,p.smooth,p.fcolors,p.wire,p.edgeColor])}
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
    var now=performance.now(),oldByName={},oldItems=items.slice(),oldParts=parts.slice(),keep={},nItems=[],nMats=[],nEdges=[],nParts=ns.parts||[];
    oldParts.forEach(function(q,k){oldByName[q.name]=k});
    nParts.forEach(function(np){
      var k=oldByName[np.name],g;
      if(k!==undefined&&geoKey(oldParts[k])===geoKey(np)){
        g=oldItems[k];keep[k]=1;var u=g.userData,pv=np.pivot||np.pos;
        tweens.push({g:g,t0:now,dur:560,b0:u.base.slice(),b1:[np.size[0],np.size[1],np.size[2]],p0:[g.position.x,u.y,g.position.z],p1:[np.pos[0]-pv[0],np.pos[1]-pv[1],np.pos[2]-pv[2]],r0:[g.rotation.x,g.rotation.y,g.rotation.z],r1:[np.rot[0]*D,np.rot[1]*D,np.rot[2]*D]});
      }else{g=make(np);g.userData.born=(reduced||(inst&&!settledOnce))?-1e9:now;items.pop();mats.pop();edges.pop()}
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
    setRef(ns.ref);setBackdrop(ns.backdrop);emit("parts",null);syncScripts(ns.scripts);select(-1);settledOnce=true;pose();draw()}
  function stepTweens(now){
    var i;for(i=tweens.length-1;i>=0;i--){var t=tweens[i],k=Math.min(1,(now-t.t0)/t.dur),e=k*k*(3-2*k),u=t.g.userData,j;
      if(items.indexOf(t.g)<0){tweens.splice(i,1);continue}
      for(j=0;j<3;j++)u.base[j]=t.b0[j]+(t.b1[j]-t.b0[j])*e;
      t.g.position.x=t.p0[0]+(t.p1[0]-t.p0[0])*e;u.y=t.p0[1]+(t.p1[1]-t.p0[1])*e;t.g.position.z=t.p0[2]+(t.p1[2]-t.p0[2])*e;
      t.g.rotation.set(t.r0[0]+(t.r1[0]-t.r0[0])*e,t.r0[1]+(t.r1[1]-t.r0[1])*e,t.r0[2]+(t.r1[2]-t.r0[2])*e);
      if(k>=1)tweens.splice(i,1)}
    for(i=ghosts.length-1;i>=0;i--){var gh=ghosts[i],q=Math.min(1,(now-gh.t0)/260),s3=1-q;gh.g.scale.set(Math.max(0.001,gh.g.userData.base[0]*s3),Math.max(0.001,gh.g.userData.base[1]*s3),Math.max(0.001,gh.g.userData.base[2]*s3));
      if(q>=1){var nd=gh.g.userData.node;if(nd.parent)nd.parent.remove(nd);gh.g.userData.mesh.geometry.dispose();ghosts.splice(i,1)}}}
  window.__aresView=function(name){
    var dirs={front:[0,0.12,1],back:[0,0.12,-1],side:[1,0.12,0],top:[0,1,0.001],"3q":[1.05,0.55,1.55]},d=dirs[name]||dirs["3q"],v=new T.Vector3(d[0],d[1],d[2]).normalize();
    ctl.autoRotate=false;bSpin.classList.remove("on");userTook=true;sel=-1;ctl.target.copy(tctr);cam.position.copy(tctr).addScaledVector(v,trad*2.7);ctl.update();
    if(el.scrollIntoView)el.scrollIntoView({block:"center"});draw();return name};
  if(studio){
    capX.textContent="waiting for Ares";var sv=0;
    (function poll(){fetch("/__ares/studio/"+studio+"?since="+sv,{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){if(d&&d.spec&&d.v>sv){sv=d.v;setModel(d.spec)}else if(d&&d.v!==undefined&&d.v>sv)sv=d.v}).catch(function(){}).then(function(){setTimeout(poll,350)})})()}
  pose();draw();
  if(!reduced){var last=performance.now();(function loop(now){var dt=Math.min(0.05,(now-last)/1000);last=now;
    if(live&&pending.length&&now>=nextAt){addOne(pending.shift());nextAt=now+Math.max(40,170-pending.length*25)}
    if((live||now<settleUntil)&&!userTook){ctl.target.lerp(tctr,0.08);var off=cam.position.clone().sub(ctl.target),dd=off.length();off.setLength(dd+(trad*1.95-dd)*0.06);cam.position.copy(ctl.target).add(off)}
    if(playing&&headP<N){headP=Math.min(N,headP+dt*rate);pose();if(headP>=N)playing=false}
    if(tweens.length||ghosts.length)stepTweens(now);if(studio)pose();
    if(animOn&&curA>=0){var pT=animT;animT+=dt*animSpeed;applyAnim(anims[curA],animT);var cd=anims[curA].dur||1;fireEvents(anims[curA],((pT%cd)+cd)%cd,((animT%cd)+cd)%cd)}
    stepScripts(dt);
    updateRig();if(live)pose();draw();requestAnimationFrame(loop)})(last)}
  else ctl.addEventListener("change",draw);
  addEventListener("resize",function(){var nw=stage.clientWidth||w;r.setSize(nw,h);cam.aspect=nw/h;cam.updateProjectionMatrix();draw()});
}
window.__aresBuild=window.__aresBuild||{};window.__aresBuild.rig=build;
if(window.__aresDrain)window.__aresDrain();
document.querySelectorAll(".k-rig").forEach(function(el){try{build(el)}catch(e){el.textContent="model view unavailable: "+e.message}});
`.trim();
