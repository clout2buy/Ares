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
// ── sculpt: blobs (ellipsoids, tapered limbs, rounded boxes) MELTED into one smooth surface, like clay.
//    A signed distance field (smooth union / smooth carve, authored order) meshed with surface nets, each vertex
//    projected back onto the true surface; colours blend between blobs, crevices darken (SDF ambient occlusion),
//    and a blob's bone becomes a smooth skin weight so ONE mesh bends at its joints. ──
function smin(a,b,k){var h=Math.max(k-Math.abs(a-b),0)/k;return Math.min(a,b)-h*h*k*0.25}
function smax(a,b,k){return -smin(-a,-b,k)}
function sdBlob(b,x,y,z){
  var px=x-b.at[0],py=y-b.at[1],pz=z-b.at[2];
  if(b.s==="stick"){
    var y1=px*b.ba[0]+py*b.ba[1]+pz*b.ba[2],z1=y1-b.l2,xx=px*b.l2-b.ba[0]*y1,xy=py*b.l2-b.ba[1]*y1,xz=pz*b.l2-b.ba[2]*y1,x2=xx*xx+xy*xy+xz*xz,y2=y1*y1*b.l2,z2=z1*z1*b.l2,k=Math.sign(b.rr)*b.rr*b.rr*x2;
    if(Math.sign(z1)*b.a2*z2>k)return Math.sqrt(x2+z2)*b.il2-b.r2;
    if(Math.sign(y1)*b.a2*y2<k)return Math.sqrt(x2+y2)*b.il2-b.r1;
    return(Math.sqrt(x2*b.a2*b.il2)+y1*b.rr)*b.il2-b.r1}
  if(b.m){var m=b.m,rx=m[0]*px+m[1]*py+m[2]*pz,ry=m[3]*px+m[4]*py+m[5]*pz,rz=m[6]*px+m[7]*py+m[8]*pz;px=rx;py=ry;pz=rz}
  var a=b.r[0],c=b.r[1],e=b.r[2];
  if(b.s==="box"){var o=b.round,qx=Math.abs(px)-a+o,qy=Math.abs(py)-c+o,qz=Math.abs(pz)-e+o,mx=Math.max(qx,0),my=Math.max(qy,0),mz=Math.max(qz,0);return Math.sqrt(mx*mx+my*my+mz*mz)+Math.min(Math.max(qx,qy,qz),0)-o}
  if(a===c&&c===e)return Math.sqrt(px*px+py*py+pz*pz)-a;
  var k0=Math.sqrt(px*px/(a*a)+py*py/(c*c)+pz*pz/(e*e)),k1=Math.sqrt(px*px/(a*a*a*a)+py*py/(c*c*c*c)+pz*pz/(e*e*e*e));
  return k1<1e-9?-Math.min(a,c,e):k0*(k0-1)/k1}
function sculptPrep(p){
  var B=[],mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9],bones=[""],nz=p.noise||{};
  (p.blobs||[]).forEach(function(q){
    var b={s:q.s,at:q.at,r:q.r,k:Math.max(1e-4,q.k||0.08),sub:!!q.sub,paint:!!q.paint,soft:q.soft||0.05,col:new T.Color(q.color||p.color),m:null,round:q.round||0,bi:0};
    if(q.bone&&!b.sub&&!b.paint){var bi=bones.indexOf(q.bone);if(bi<0&&bones.length<32){bones.push(q.bone);bi=bones.length-1}b.bi=Math.max(0,bi)}
    if(q.s==="stick"){var A=q.at,C=q.to,ba=[C[0]-A[0],C[1]-A[1],C[2]-A[2]],l2=ba[0]*ba[0]+ba[1]*ba[1]+ba[2]*ba[2],rr=q.r-q.r2,a2=l2-rr*rr;
      if(a2<=1e-8){var R0=Math.max(q.r,q.r2);b.s="ball";b.r=[R0,R0,R0];b.at=q.r>=q.r2?A:C}
      else{b.ba=ba;b.l2=l2;b.r1=q.r;b.r2=q.r2;b.rr=rr;b.a2=a2;b.il2=1/l2;b.c=[(A[0]+C[0])/2,(A[1]+C[1])/2,(A[2]+C[2])/2];b.R=Math.sqrt(l2)/2+Math.max(q.r,q.r2)}}
    if(b.s!=="stick"){
      if(q.rot&&(q.rot[0]||q.rot[1]||q.rot[2])){var el=new T.Matrix4().makeRotationFromEuler(new T.Euler(q.rot[0]*RAD,q.rot[1]*RAD,q.rot[2]*RAD)).elements;b.m=[el[0],el[1],el[2],el[4],el[5],el[6],el[8],el[9],el[10]]}
      b.c=b.at;b.R=b.s==="box"?Math.sqrt(b.r[0]*b.r[0]+b.r[1]*b.r[1]+b.r[2]*b.r[2]):Math.max(b.r[0],b.r[1],b.r[2])}
    if(!b.sub&&!b.paint)for(var j=0;j<3;j++){mn[j]=Math.min(mn[j],b.c[j]-b.R-b.k);mx[j]=Math.max(mx[j],b.c[j]+b.R+b.k)}
    B.push(b)});
  var amp=nz.amp||0;for(var j2=0;j2<3;j2++){mn[j2]-=amp;mx[j2]+=amp}
  return{B:B,min:mn,max:mx,amp:amp,fs:nz.scale||6,bones:bones,ok:mn[0]<mx[0]}}
function sField(S,x,y,z){
  var B=S.B,d=1e9,i;
  for(i=0;i<B.length;i++){var b=B[i];if(b.paint)continue;
    var dx=x-b.c[0],dy=y-b.c[1],dz=z-b.c[2],lb=Math.sqrt(dx*dx+dy*dy+dz*dz)-b.R;
    if(b.sub){if(lb>=b.k-d)continue;d=smax(d,-sdBlob(b,x,y,z),b.k)}
    else{if(lb>=d+b.k)continue;d=smin(d,sdBlob(b,x,y,z),b.k)}}
  if(S.amp)d+=S.amp*(fbm(x*S.fs,y*S.fs,z*S.fs,3)-0.44)*2;
  return d}
function sculptGeo(p){
  var S=sculptPrep(p);if(!S.ok)return new T.SphereGeometry(0.3,12,8);
  var lo=!!p.low,res=p.res||(lo?22:64),mn=S.min,mx=S.max,ext=Math.max(mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2]),h=ext/res;
  var ox=mn[0]-h*2,oy=mn[1]-h*2,oz=mn[2]-h*2,nx=Math.ceil((mx[0]-mn[0])/h)+5,ny=Math.ceil((mx[1]-mn[1])/h)+5,nz=Math.ceil((mx[2]-mn[2])/h)+5;
  var NXY=nx*ny,F=new Float32Array(NXY*nz),V=new Int32Array(NXY*nz).fill(-1),i,j,k,n,pos=[];
  // 4x4x4 blocks: one probe at the centre; a block whose probe is farther from the surface than its corners cannot
  // contain the surface, so it takes the probe's value (only the SIGN matters away from the surface)
  var BS=4,far=BS*0.5*h*Math.sqrt(3)*1.3+S.amp*2,bi,bj,bk;
  for(bk=0;bk<nz;bk+=BS)for(bj=0;bj<ny;bj+=BS)for(bi=0;bi<nx;bi+=BS){
    var fc=sField(S,ox+(bi+BS*0.5)*h,oy+(bj+BS*0.5)*h,oz+(bk+BS*0.5)*h),i1=Math.min(nx,bi+BS),j1=Math.min(ny,bj+BS),k1=Math.min(nz,bk+BS),fill=Math.abs(fc)>far;
    for(k=bk;k<k1;k++)for(j=bj;j<j1;j++)for(i=bi;i<i1;i++)F[i+nx*j+NXY*k]=fill?fc:sField(S,ox+i*h,oy+j*h,oz+k*h)}
  var CO=[],ED=[];for(n=0;n<8;n++)CO.push([n&1,(n>>1)&1,(n>>2)&1]);
  for(n=0;n<8;n++)[1,2,4].forEach(function(bit){if(!(n&bit))ED.push([n,n|bit])});
  var cv=new Float32Array(8);
  for(k=0;k<nz-1;k++)for(j=0;j<ny-1;j++)for(i=0;i<nx-1;i++){
    var neg=0;for(n=0;n<8;n++){cv[n]=F[(i+CO[n][0])+nx*(j+CO[n][1])+NXY*(k+CO[n][2])];if(cv[n]<0)neg++}
    if(neg===0||neg===8)continue;
    var sx=0,sy=0,sz=0,cnt=0;
    for(n=0;n<12;n++){var e0=ED[n][0],e1=ED[n][1],a=cv[e0],b=cv[e1];if((a<0)===(b<0))continue;var t=a/(a-b);
      sx+=CO[e0][0]+(CO[e1][0]-CO[e0][0])*t;sy+=CO[e0][1]+(CO[e1][1]-CO[e0][1])*t;sz+=CO[e0][2]+(CO[e1][2]-CO[e0][2])*t;cnt++}
    V[i+nx*j+NXY*k]=pos.length/3;pos.push(ox+(i+sx/cnt)*h,oy+(j+sy/cnt)*h,oz+(k+sz/cnt)*h)}
  var idx=[],VC=function(a,b,c){return V[a+nx*b+NXY*c]};
  function quad(q,inside){
    if(q[0]<0||q[1]<0||q[2]<0||q[3]<0)return;
    // the cells are listed counter-clockwise about the +axis edge, so that order faces +axis: right when the inside is behind
    if(!inside)q=[q[3],q[2],q[1],q[0]];
    var d02=0,d13=0;for(var c=0;c<3;c++){d02+=Math.pow(pos[q[0]*3+c]-pos[q[2]*3+c],2);d13+=Math.pow(pos[q[1]*3+c]-pos[q[3]*3+c],2)}
    if(d02<=d13)idx.push(q[0],q[1],q[2],q[0],q[2],q[3]);else idx.push(q[0],q[1],q[3],q[1],q[2],q[3])}
  for(k=1;k<nz-1;k++)for(j=1;j<ny-1;j++)for(i=1;i<nx-1;i++){
    var f0=F[i+nx*j+NXY*k],in0=f0<0;
    if(in0!==(F[i+1+nx*j+NXY*k]<0))quad([VC(i,j-1,k-1),VC(i,j,k-1),VC(i,j,k),VC(i,j-1,k)],in0);
    if(in0!==(F[i+nx*(j+1)+NXY*k]<0))quad([VC(i-1,j,k-1),VC(i-1,j,k),VC(i,j,k),VC(i,j,k-1)],in0);
    if(in0!==(F[i+nx*j+NXY*(k+1)]<0))quad([VC(i-1,j-1,k),VC(i,j-1,k),VC(i,j,k),VC(i-1,j,k)],in0)}
  // project every vertex onto the real surface; normals from the field gradient (smooth, no faceting from the grid)
  var NV=pos.length/3,P=new Float32Array(pos),NR=new Float32Array(NV*3),eps=h*0.3,g=[0,0,0];
  function grad(x,y,z){g[0]=sField(S,x+eps,y,z)-sField(S,x-eps,y,z);g[1]=sField(S,x,y+eps,z)-sField(S,x,y-eps,z);g[2]=sField(S,x,y,z+eps)-sField(S,x,y,z-eps);return g}
  for(n=0;n<NV;n++){var x=P[3*n],y=P[3*n+1],z=P[3*n+2],f=sField(S,x,y,z);grad(x,y,z);var gl=g[0]*g[0]+g[1]*g[1]+g[2]*g[2];
    if(gl>1e-12){var sq=Math.sqrt(gl),mv=Math.max(-h,Math.min(h,f*2*eps/sq))/sq;x-=g[0]*mv;y-=g[1]*mv;z-=g[2]*mv;P[3*n]=x;P[3*n+1]=y;P[3*n+2]=z;grad(x,y,z);gl=g[0]*g[0]+g[1]*g[1]+g[2]*g[2]}
    var il=gl>1e-12?1/Math.sqrt(gl):0;NR[3*n]=g[0]*il;NR[3*n+1]=g[1]*il;NR[3*n+2]=g[2]*il}
  // colour: blobs blend where they melt; paint blobs lay soft markings; crevices darken; a little fbm keeps it organic
  var COL=new Float32Array(NV*3),nb=S.bones.length,skin=nb>1,SI=skin?new Uint16Array(NV*4):null,SW=skin?new Float32Array(NV*4):null,acc=new Float64Array(nb),B=S.B,tc=new T.Color(),ao=p.ao===undefined?1:p.ao,tint=p.tint===undefined?0.06:p.tint,fq=4/Math.max(0.2,ext);
  var aoD=[0.012,0.035,0.07,0.13].map(function(v){return v*ext}),aoW=[0.42,0.3,0.18,0.1];
  for(n=0;n<NV;n++){
    var X=P[3*n],Y=P[3*n+1],Z=P[3*n+2],best=1e9,dists=[],q2;
    for(q2=0;q2<B.length;q2++){var bb=B[q2];if(bb.sub||bb.paint){dists.push(0);continue}var dd=sdBlob(bb,X,Y,Z);dists.push(dd);if(dd<best)best=dd}
    var r0=0,g0=0,b0=0,ws=0;for(q2=0;q2<nb;q2++)acc[q2]=0;
    for(q2=0;q2<B.length;q2++){var bl=B[q2];if(bl.sub||bl.paint)continue;var dz=(dists[q2]-best)/Math.max(0.006,bl.k*0.45),w=Math.exp(-dz*dz);if(w<1e-4)continue;r0+=bl.col.r*w;g0+=bl.col.g*w;b0+=bl.col.b*w;ws+=w;acc[bl.bi]+=w}
    tc.setRGB(r0/ws,g0/ws,b0/ws);
    for(q2=0;q2<B.length;q2++){var pb=B[q2];if(!pb.paint)continue;var pd=sdBlob(pb,X,Y,Z),tt=Math.max(0,Math.min(1,1-pd/pb.soft));if(tt>0)tc.lerp(pb.col,tt*tt*(3-2*tt))}
    var occ=0;for(q2=0;q2<4;q2++){var hh=aoD[q2],fv=sField(S,X+NR[3*n]*hh,Y+NR[3*n+1]*hh,Z+NR[3*n+2]*hh);occ+=aoW[q2]*Math.max(0,(hh-fv)/hh)}
    var shade=(1-ao*Math.min(0.62,occ*1.15))*(1+tint*((fbm(X*fq*3,Y*fq*3,Z*fq*3,3)-0.44)*2.2));
    COL[3*n]=tc.r*shade;COL[3*n+1]=tc.g*shade;COL[3*n+2]=tc.b*shade;
    if(skin){var top=[];for(q2=0;q2<nb;q2++)if(acc[q2]>0)top.push([acc[q2],q2]);top.sort(function(u,v){return v[0]-u[0]});top=top.slice(0,4);var tw=0;top.forEach(function(e){tw+=e[0]});
      for(q2=0;q2<4;q2++){SI[4*n+q2]=top[q2]?top[q2][1]:0;SW[4*n+q2]=top[q2]?top[q2][0]/tw:0}}}
  var gm=new T.BufferGeometry();gm.setAttribute("position",new T.BufferAttribute(P,3));gm.setAttribute("normal",new T.BufferAttribute(NR,3));gm.setAttribute("color",new T.BufferAttribute(COL,3));
  if(skin){gm.setAttribute("skinIndex",new T.BufferAttribute(SI,4));gm.setAttribute("skinWeight",new T.BufferAttribute(SW,4))}
  gm.setIndex(NV>65535?new T.Uint32BufferAttribute(idx,1):new T.Uint16BufferAttribute(idx,1));
  if(lo){gm=gm.toNonIndexed();var ca=gm.attributes.color;for(n=0;n<ca.count;n+=3)for(var ch=0;ch<3;ch++){var av=(ca.array[n*3+ch]+ca.array[n*3+3+ch]+ca.array[n*3+6+ch])/3;ca.array[n*3+ch]=ca.array[n*3+3+ch]=ca.array[n*3+6+ch]=av}gm.computeVertexNormals()}
  gm.userData.bones=skin?S.bones:null;gm.userData.sculpt=true;
  return gm}
// snap: put a part ON a sculpt's surface (eyes, nose, claws, horns, buttons): its centre is projected to the nearest surface point,
// pushed out along the normal by p.out; align turns its +y to the surface normal. Returns new part objects; the input is untouched.
var snapCache={};
function snapParts(list,all){
  var byName={};(all||list).forEach(function(q){if(q.shape==="sculpt"&&!byName[q.name])byName[q.name]=q});
  return list.map(function(p){
    var q=p.snap&&byName[p.snap];if(!q)return p;
    var key=JSON.stringify([q.blobs,q.noise]),S=snapCache[key];if(!S){S=sculptPrep(q);if(Object.keys(snapCache).length>40)snapCache={};snapCache[key]=S}
    if(!S.ok)return p;
    var G=new T.Matrix4().compose(new T.Vector3(q.pos[0],q.pos[1],q.pos[2]),new T.Quaternion().setFromEuler(new T.Euler(q.rot[0]*RAD,q.rot[1]*RAD,q.rot[2]*RAD)),new T.Vector3(q.size[0],q.size[1],q.size[2])),Gi=G.clone().invert();
    var v=new T.Vector3(p.pos[0],p.pos[1],p.pos[2]).applyMatrix4(Gi),ext=Math.max(S.max[0]-S.min[0],S.max[1]-S.min[1],S.max[2]-S.min[2]),e=ext*0.002,n=new T.Vector3(),it;
    function gr(){n.set(sField(S,v.x+e,v.y,v.z)-sField(S,v.x-e,v.y,v.z),sField(S,v.x,v.y+e,v.z)-sField(S,v.x,v.y-e,v.z),sField(S,v.x,v.y,v.z+e)-sField(S,v.x,v.y,v.z-e))}
    for(it=0;it<12;it++){var f=sField(S,v.x,v.y,v.z);gr();var gl=n.lengthSq();if(gl<1e-14)break;v.addScaledVector(n,-f*2*e/gl);if(Math.abs(f)<ext*1e-4)break}
    gr();n.normalize();v.addScaledVector(n,p.out||0);
    var w=v.applyMatrix4(G),nw=n.transformDirection(G),out=Object.assign({},p),d=[w.x-p.pos[0],w.y-p.pos[1],w.z-p.pos[2]],pv=p.pivot||p.pos;
    out.pos=[w.x,w.y,w.z];
    if(pv[0]===p.pos[0]&&pv[1]===p.pos[1]&&pv[2]===p.pos[2])out.pivot=out.pos.slice();
    if(p.align){var qa=new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),nw).multiply(new T.Quaternion().setFromEuler(new T.Euler(p.rot[0]*RAD,p.rot[1]*RAD,p.rot[2]*RAD))),eu=new T.Euler().setFromQuaternion(qa);out.rot=[eu.x/RAD,eu.y/RAD,eu.z/RAD]}
    out.snapped=d;return out})}
// bind sculpted meshes to the joint nodes their blobs named: bone 0 = the sculpt's own joint, rest pose computed from pivots (not from whatever pose the scene is in)
function skinLink(parts,nodes,objs){
  var byName={};parts.forEach(function(q,k){if(byName[q.name]===undefined)byName[q.name]=k});
  objs.forEach(function(g,i){
    var mesh=g&&g.userData.mesh;if(!mesh||!mesh.isSkinnedMesh)return;
    var p=parts[i],names=mesh.geometry.userData.bones||[""],bones=[],inv=[];
    (mesh.userData.bones||[]).forEach(function(b){b.removeFromParent()});if(mesh.skeleton)mesh.skeleton.dispose();
    names.forEach(function(nm,bi){
      var j=i;if(bi>0){if(byName[nm]!==undefined)j=byName[nm];else{var base=nm.replace(/ [(]mirror[)]$/,"");if(byName[base]!==undefined)j=byName[base]}}
      var bone=new T.Bone(),pv=parts[j].pivot||parts[j].pos;bone.name="b"+bi;nodes[j].add(bone);bones.push(bone);inv.push(new T.Matrix4().makeTranslation(-pv[0],-pv[1],-pv[2]))});
    mesh.userData.bones=bones;
    var G=new T.Matrix4().compose(new T.Vector3(p.pos[0],p.pos[1],p.pos[2]),new T.Quaternion().setFromEuler(new T.Euler(p.rot[0]*RAD,p.rot[1]*RAD,p.rot[2]*RAD)),new T.Vector3(p.size[0],p.size[1],p.size[2]));
    mesh.bind(new T.Skeleton(bones,inv),G);mesh.frustumCulled=false})}
function geo(p){
  var s=p.shape,pts=p.pts||[],i,lo=!!p.low;
  if(s==="sculpt")return sculptGeo(p);
  if(s==="joint")return new T.BoxGeometry(0.001,0.001,0.001);
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
// fur: a fine fuzz in the shader (normal jitter + speckle from 3D noise on the REST position, so it sticks to the body as it moves)
var FUR_NL=String.fromCharCode(10),FUR_GLSL="float fh(vec3 p){p=fract(p*0.3183099+0.1);p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}"+FUR_NL+
  "float fnz(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);return mix(mix(mix(fh(i),fh(i+vec3(1,0,0)),f.x),mix(fh(i+vec3(0,1,0)),fh(i+vec3(1,1,0)),f.x),f.y),mix(mix(fh(i+vec3(0,0,1)),fh(i+vec3(1,0,1)),f.x),mix(fh(i+vec3(0,1,1)),fh(i+vec3(1,1,1)),f.x),f.y),f.z);}"+FUR_NL;
function furPatch(m,scale,amt){
  m.onBeforeCompile=function(sh){
    sh.uniforms.furS={value:scale};sh.uniforms.furA={value:amt};
    sh.vertexShader=sh.vertexShader.replace("#include <common>","#include <common>"+FUR_NL+"varying vec3 vFurP;").replace("#include <begin_vertex>","#include <begin_vertex>"+FUR_NL+"vFurP=position;");
    sh.fragmentShader=sh.fragmentShader.replace("#include <common>","#include <common>"+FUR_NL+"varying vec3 vFurP;uniform float furS;uniform float furA;"+FUR_NL+FUR_GLSL)
      .replace("#include <color_fragment>","#include <color_fragment>"+FUR_NL+"{vec3 fp=vFurP*furS;diffuseColor.rgb*=1.0-furA*0.55+furA*1.1*(0.6*fnz(fp*1.7)+0.4*fnz(fp*4.1));}")
      .replace("#include <normal_fragment_maps>","#include <normal_fragment_maps>"+FUR_NL+"{vec3 fp=vFurP*furS*2.3;normal=normalize(normal+furA*0.9*(vec3(fnz(fp),fnz(fp+17.3),fnz(fp+41.7))-0.5));}")};
  m.customProgramCacheKey=function(){return "fur"+scale.toFixed(3)+"_"+amt}}
function edgeVis(p){if(p.shape==="sculpt"||p.shape==="joint")return false;return !!p.wire||p.mat==="holo"||(!p.smooth&&p.mat!=="glass")}
function material(p){
  var o={color:p.color,flatShading:!p.smooth,roughness:0.85,metalness:0.05},m=p.mat;
  if(p.facets||p.fcolors){o.color=0xffffff;o.vertexColors=true;o.flatShading=true}
  if(p.shape==="mesh"||p.shape==="loft")o.side=T.DoubleSide;
  if(p.shape==="sculpt"){o.color=0xffffff;o.vertexColors=true;o.flatShading=!!p.low}
  if(m==="clay"){o.roughness=0.62;o.metalness=0}
  if(m==="plastic"){o.roughness=0.3;o.metalness=0;o.clearcoat=0.7;o.clearcoatRoughness=0.25}
  if(m==="holo"){o.transparent=true;o.opacity=0.55;o.emissive=p.color;o.emissiveIntensity=0.55;o.roughness=0.2;o.depthWrite=false;o.flatShading=true}
  if(m==="metal"){o.roughness=0.32;o.metalness=0.85}
  if(m==="glossy"){o.roughness=0.22;o.metalness=0.1}
  if(m==="glass"){o.roughness=0.08;o.metalness=0.1;o.transparent=true;o.opacity=0.42;o.depthWrite=false}
  if(m==="glow"){o.emissive=p.color;o.emissiveIntensity=0.9;o.roughness=0.5}
  // fur: soft sheen at grazing angles (velvet/fuzz) over a rough base; skin: a thin, rough clearcoat (no tinted sheen: it would wash clothes painted on the same skin)
  if(m==="fur"){o.roughness=0.92;o.metalness=0;o.sheen=0.4;o.sheenRoughness=0.75;o.sheenColor=new T.Color(0.22,0.2,0.18)}
  if(m==="skin"){o.roughness=0.6;o.metalness=0;o.clearcoat=0.1;o.clearcoatRoughness=0.55}
  return m==="plastic"||m==="fur"||m==="skin"?new T.MeshPhysicalMaterial(o):new T.MeshStandardMaterial(o);
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
  if(!gm){gm=geo(p);if((p.facets||p.fcolors)&&!gm.userData.sculpt){if(gm.index)gm=gm.toNonIndexed();paint(gm,p)}if(c)c.gm=gm}
  var m=(c&&c.m)||material(p);if(c)c.m=m;
  if(p.mat==="fur"&&!m.userData.fur){gm.computeBoundingBox();var bs=gm.boundingBox.getSize(new T.Vector3());furPatch(m,90/Math.max(0.02,bs.x,bs.y,bs.z),p.fuzz===undefined?0.5:p.fuzz);m.userData.fur=1}
  if(p.texture&&!(c&&c.tx)){m.map=procTexture(p.texture);m.color.set(0xffffff);m.vertexColors=false;m.needsUpdate=true;if(c)c.tx=1}
  var mesh=gm.userData.bones?new T.SkinnedMesh(gm,m):new T.Mesh(gm,m);mesh.castShadow=p.shape!=="joint";mesh.receiveShadow=true;if(p.shape==="joint")mesh.visible=false;g.add(mesh);
  if(p.shape==="tube"&&p.caps){[[0,p.r],[p.pts.length-1,p.r2]].forEach(function(cc){var cp=p.pts[cc[0]],cm=(p.facets||p.fcolors)?new T.MeshStandardMaterial({color:cc[0]===0?p.color:(p.color2||p.color),roughness:0.85,flatShading:!!p.low}):m,cap=new T.Mesh(new T.SphereGeometry(cc[1],p.low?6:16,p.low?4:12),cm);cap.position.set(cp[0],cp[1],cp[2]);cap.castShadow=true;g.add(cap)})}
  var ed=null;
  if(o.edges&&(p.shape==="sculpt"||p.shape==="joint")){ed=new T.LineSegments(new T.BufferGeometry(),new T.LineBasicMaterial({color:0x070a13}));ed.visible=false;g.add(ed)}
  else if(o.edges){var wc=p.mat==="holo"&&!p.edgeColor?"#bfe0ff":(p.edgeColor||"#d9a441");ed=(p.wire||p.mat==="holo")?new T.LineSegments(new T.WireframeGeometry(gm),new T.LineBasicMaterial({color:wc,transparent:true,opacity:0.85})):new T.LineSegments(new T.EdgesGeometry(gm,28),new T.LineBasicMaterial({color:0x070a13,transparent:true,opacity:0.4}));ed.visible=edgeVis(p);g.add(ed)}
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
  var bones=[];
  g.traverse(function(o){
    if(o.isSkinnedMesh){bones=bones.concat(o.userData.bones||[]);if(o.skeleton)o.skeleton.dispose()}
    if(o.geometry&&!(keep&&keep.has(o.geometry)))o.geometry.dispose();
    var m=o.material;if(!m)return;
    (Array.isArray(m)?m:[m]).forEach(function(x){if(keep&&keep.has(x))return;if(x.map)x.map.dispose();x.dispose()})});
  bones.forEach(function(b){b.removeFromParent()})}
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
