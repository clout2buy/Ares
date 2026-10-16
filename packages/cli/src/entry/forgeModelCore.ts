// The model core: geometry builders, facet painting, materials, noise, joint
// hierarchy and animation sampling. ONE source for two consumers: the Forge
// studio page (forgeModel.ts) and the standalone runtime a game imports
// (forgeRuntime.ts), so a model looks and moves identically in both.
// It refers to three.js as the free identifier T in either world.
//
// TypeScript template literal: NO backticks, NO dollar-brace, NO backslashes.

export const FORGE_MODEL_CORE_JS = `
var RAD=Math.PI/180;
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
function ease(k){var c=1.70158;return 1+(c+1)*Math.pow(k-1,3)+c*Math.pow(k-1,2)}
function lat(i,j,k){var h=Math.imul(i,73856093)^Math.imul(j,19349663)^Math.imul(k,83492791);h=Math.imul(h^(h>>>13),1274126177);return(((h^(h>>>16))>>>0)%100000)/100000}
function sm(t){return t*t*(3-2*t)}
function noise3(x,y,z){y=y||0;z=z||0;var xi=Math.floor(x),yi=Math.floor(y),zi=Math.floor(z),fx=sm(x-xi),fy=sm(y-yi),fz=sm(z-zi),a=function(dx,dy,dz){return lat(xi+dx,yi+dy,zi+dz)},l=function(p,q,t){return p+(q-p)*t};
  return l(l(l(a(0,0,0),a(1,0,0),fx),l(a(0,1,0),a(1,1,0),fx),fy),l(l(a(0,0,1),a(1,0,1),fx),l(a(0,1,1),a(1,1,1),fx),fy),fz)}
function fbm(x,y,z,oct){var v=0,amp=0.5,f=1;for(var i=0;i<(oct||4);i++){v+=amp*noise3(x*f,(y||0)*f,(z||0)*f);f*=2;amp*=0.5}return v}

function rigMatch(parts,sel,i){
  var n=parts[i].name,mir=/ [(]mirror[)]$/.test(n),base=mir?n.slice(0,-9):n;
  if(sel.charAt(sel.length-1)==="*"){var b=sel.slice(0,-1);return base.indexOf(b)===0?(mir?2:1):0}
  if(sel===n)return 1;
  return mir&&sel===base?2:(!mir&&sel===base?1:0)}
function rigSample(ks,t,c){
  var dur=c.dur||1;t=c.loop?((t%dur)+dur)%dur:Math.max(0,Math.min(dur,t));
  if(ks.length===1||t<=ks[0][0])return ks[0][1];
  for(var i=1;i<ks.length;i++){if(t<=ks[i][0]){var a=ks[i-1],b=ks[i],k=(t-a[0])/Math.max(1e-6,b[0]-a[0]);k=k*k*(3-2*k);return[a[1][0]+(b[1][0]-a[1][0])*k,a[1][1]+(b[1][1]-a[1][1])*k,a[1][2]+(b[1][2]-a[1][2])*k]}}
  return ks[ks.length-1][1]}
function rigApply(parts,nodes,c,t){
  var N=parts.length,i,rot=[],pos=[],sca=[];
  for(i=0;i<N;i++){rot[i]=[0,0,0];pos[i]=[0,0,0];sca[i]=[1,1,1]}
  (c.tracks||[]).forEach(function(tr){for(var i=0;i<N;i++){var m=rigMatch(parts,tr.part,i);if(!m)continue;var fl=m===2?-1:1;
    if(tr.rot){var v=rigSample(tr.rot,t,c);rot[i][0]+=v[0];rot[i][1]+=v[1]*fl;rot[i][2]+=v[2]*fl}
    if(tr.pos){var q=rigSample(tr.pos,t,c);pos[i][0]+=q[0]*fl;pos[i][1]+=q[1];pos[i][2]+=q[2]}
    if(tr.scale){var z=rigSample(tr.scale,t,c);sca[i][0]*=z[0];sca[i][1]*=z[1];sca[i][2]*=z[2]}}});
  (c.motion||[]).forEach(function(mo){for(var i=0;i<N;i++){var m=rigMatch(parts,mo.part,i);if(!m)continue;
    var ph=mo.phase+(m===2&&mo.mirror&&mo.kind==="swing"?Math.PI:0),a=2*Math.PI*mo.speed*t+ph,ax=mo.axis==="x"?0:mo.axis==="y"?1:2;
    if(mo.kind==="swing"||mo.kind==="wag")rot[i][ax]+=mo.amp*Math.sin(a);
    else if(mo.kind==="spin")rot[i][ax]+=360*mo.speed*t;
    else if(mo.kind==="bob")pos[i][ax]+=mo.amp*Math.sin(a);
    else if(mo.kind==="pulse"){var s2=1+mo.amp*Math.sin(a);sca[i][0]*=s2;sca[i][1]*=s2;sca[i][2]*=s2}}});
  for(i=0;i<N;i++){var nd=nodes[i],rs=nd.userData.rest;nd.rotation.set(rot[i][0]*RAD,rot[i][1]*RAD,rot[i][2]*RAD);nd.position.set(rs.x+pos[i][0],rs.y+pos[i][1],rs.z+pos[i][2]);nd.scale.set(sca[i][0],sca[i][1],sca[i][2])}
}

// one part -> a Group (mesh [+ tube end caps] [+ edge lines]) already placed relative to its pivot. o.cache shares geometry/material across instances.
function buildPartObject(p,o){
  o=o||{};var g=new T.Group(),c=o.cache,gm=c&&c.gm;
  if(!gm){gm=geo(p);if(p.facets||p.fcolors){if(gm.index)gm=gm.toNonIndexed();paint(gm,p)}if(c)c.gm=gm}
  var m=(c&&c.m)||material(p);if(c)c.m=m;
  if(p.texture&&!(c&&c.tx)){m.map=procTexture(p.texture);m.color.set(0xffffff);m.vertexColors=false;m.needsUpdate=true;if(c)c.tx=1}
  var mesh=new T.Mesh(gm,m);mesh.castShadow=true;mesh.receiveShadow=true;g.add(mesh);
  if(p.shape==="tube"&&p.caps){[[0,p.r],[p.pts.length-1,p.r2]].forEach(function(cc){var cp=p.pts[cc[0]],cm=(p.facets||p.fcolors)?new T.MeshStandardMaterial({color:cc[0]===0?p.color:(p.color2||p.color),roughness:0.85,flatShading:!!p.low}):m,cap=new T.Mesh(new T.SphereGeometry(cc[1],p.low?6:16,p.low?4:12),cm);cap.position.set(cp[0],cp[1],cp[2]);cap.castShadow=true;g.add(cap)})}
  var ed=null;
  if(o.edges){var wc=p.mat==="holo"&&!p.edgeColor?"#bfe0ff":(p.edgeColor||"#d9a441");ed=(p.wire||p.mat==="holo")?new T.LineSegments(new T.WireframeGeometry(gm),new T.LineBasicMaterial({color:wc,transparent:true,opacity:0.85})):new T.LineSegments(new T.EdgesGeometry(gm,28),new T.LineBasicMaterial({color:0x070a13,transparent:true,opacity:0.4}));ed.visible=edgeVis(p);g.add(ed)}
  var pv=p.pivot||p.pos,RAD=Math.PI/180;
  g.name=p.name;g.position.set(p.pos[0]-pv[0],p.pos[1]-pv[1],p.pos[2]-pv[2]);g.rotation.set(p.rot[0]*RAD,p.rot[1]*RAD,p.rot[2]*RAD);g.scale.set(p.size[0],p.size[1],p.size[2]);
  g.userData={base:[p.size[0],p.size[1],p.size[2]],y:p.pos[1]-pv[1],ed:ed,mat:m,mesh:mesh};
  return g}
// joint hierarchy: each part hangs off a node at its pivot; a part's parent is another part by name (mirrors follow mirrors). Sets node positions relative to the parent's pivot.
function rigLink(parts,nodes,root){
  var byName={},pidx=[],hasKids=[],i;parts.forEach(function(q,k){if(byName[q.name]===undefined)byName[q.name]=k});
  for(i=0;i<parts.length;i++){
    var q=parts[i],par=-1;
    if(q.parent){var nm=/ [(]mirror[)]$/.test(q.name)&&byName[q.parent+" (mirror)"]!==undefined?q.parent+" (mirror)":q.parent;if(byName[nm]!==undefined&&byName[nm]!==i)par=byName[nm]}
    for(var hop=0,j=par;j>=0&&hop<40;hop++){var pp=parts[j].parent;if(!pp)break;var nx=byName[pp];if(nx===i){par=-1;break}j=nx===undefined?-1:nx}
    pidx[i]=par}
  for(i=0;i<parts.length;i++){var nd=nodes[i],pr=pidx[i],pn=pr>=0?nodes[pr]:root,pv=parts[i].pivot||parts[i].pos,pp2=pr>=0?(parts[pr].pivot||parts[pr].pos):[0,0,0];
    if(nd.parent!==pn)pn.add(nd);nd.position.set(pv[0]-pp2[0],pv[1]-pp2[1],pv[2]-pp2[2]);nd.userData.rest=nd.position.clone();if(pr>=0)hasKids[pr]=true}
  return{pidx:pidx,hasKids:hasKids}}
// free GPU resources of an object tree; keep (a Set) holds shared geometries/materials that other instances still use
function disposeObject(g,keep){
  g.traverse(function(o){
    if(o.geometry&&!(keep&&keep.has(o.geometry)))o.geometry.dispose();
    var m=o.material;if(!m)return;
    (Array.isArray(m)?m:[m]).forEach(function(x){if(keep&&keep.has(x))return;if(x.map)x.map.dispose();x.dispose()})})}
// data-driven procedural textures (kind + colours + scale): they live in the model JSON, so they survive export to a game with no script
var texCache={};
function parseHex(c){c=String(c||"#888888");return[parseInt(c.slice(1,3),16)||0,parseInt(c.slice(3,5),16)||0,parseInt(c.slice(5,7),16)||0]}
function mixc(a,b,t){return[Math.round(a[0]+(b[0]-a[0])*t),Math.round(a[1]+(b[1]-a[1])*t),Math.round(a[2]+(b[2]-a[2])*t)]}
function procTexture(t){
  var key=JSON.stringify(t);if(texCache[key])return texCache[key];
  var n=t.size||64,cols=(t.colors&&t.colors.length?t.colors:["#8a5a2b","#5a3818"]).map(parseHex),seed=t.seed||1,k=t.kind||"noise",sc=t.scale||1;
  var tex=makeCanvasTexture(n,n,function(x,w,h){
    for(var j=0;j<h;j++)for(var i=0;i<w;i++){
      var c,u=i/w,v=j/h,g=fbm(i*0.12*sc+seed*7,j*(k==="planks"?0.9:0.12)*sc+seed,0,3);
      if(k==="planks"){var rows=8,row=Math.floor(v*rows),edge=(j%Math.max(1,Math.floor(h/rows))===0)?0.55:1,tone=0.75+0.25*hsh(row*13+seed);c=mixc(cols[0],cols[1],Math.min(1,g*0.9)).map(function(q){return Math.round(q*edge*tone)})}
      else if(k==="bricks"){var rows2=6,row2=Math.floor(v*rows2),off=(row2%2)*0.5,bu=(u*3+off)%1,bv=(v*rows2)%1;c=(bu<0.06||bv<0.1)?cols[1]:mixc(cols[0],cols[2]||cols[0],Math.min(1,g*0.8+0.2*hsh(row2*7+Math.floor(u*3+off)*3+seed)))}
      else if(k==="checker"){c=((Math.floor(u*4*sc)+Math.floor(v*4*sc))%2)?cols[0]:cols[1]}
      else if(k==="stripes"){c=(Math.floor(v*8*sc)%2)?cols[0]:cols[1]}
      else if(k==="dots"){var du=(u*6*sc)%1-0.5,dv=(v*6*sc)%1-0.5;c=(du*du+dv*dv<0.12)?cols[1]:cols[0]}
      else c=mixc(cols[0],cols[1],Math.min(1,g));
      x.fillStyle="rgb("+c[0]+","+c[1]+","+c[2]+")";x.fillRect(i,j,1,1)}},{repeat:t.repeat||[1,1],pixel:t.pixel!==false});
  texCache[key]=tex;return tex}
function makeCanvasTexture(w,h,draw,o){
  o=o||{};var c=document.createElement("canvas");c.width=w;c.height=h;var x=c.getContext("2d");draw(x,w,h);
  var t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;t.wrapS=t.wrapT=T.RepeatWrapping;if(o.repeat)t.repeat.set(o.repeat[0],o.repeat[1]);
  if(o.pixel!==false){t.magFilter=T.NearestFilter;t.minFilter=T.NearestFilter;t.generateMipmaps=false}else t.anisotropy=8;
  t.needsUpdate=true;return t}
`.trim();
