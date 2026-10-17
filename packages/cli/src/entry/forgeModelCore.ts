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
  if(b.s==="cyl"){
    // capped cylinder from at to to (exact), bevelled by round
    var bb=b.l2,pb=px*b.ba[0]+py*b.ba[1]+pz*b.ba[2],qx=px*bb-b.ba[0]*pb,qy=py*bb-b.ba[1]*pb,qz=pz*bb-b.ba[2]*pb,cx=Math.sqrt(qx*qx+qy*qy+qz*qz)-b.r1*bb,cy=Math.abs(pb-bb*0.5)-bb*0.5,
      cd=Math.max(cx,cy)<0?-Math.min(cx*cx,cy*cy*bb):((cx>0?cx*cx:0)+(cy>0?cy*cy*bb:0));
    return Math.sign(cd)*Math.sqrt(Math.abs(cd))/bb-b.round}
  if(b.m){var m=b.m,rx=m[0]*px+m[1]*py+m[2]*pz,ry=m[3]*px+m[4]*py+m[5]*pz,rz=m[6]*px+m[7]*py+m[8]*pz;px=rx;py=ry;pz=rz}
  if(b.s==="profile"){
    // an outline drawn in a plane (pts [u,v]), extruded +-r along the axis, edges rounded by round, narrowing by taper as v rises
    var U,Vv,W;if(b.ax==="y"){U=px;Vv=pz;W=py}else if(b.ax==="z"){U=px;Vv=py;W=pz}else{U=pz;Vv=py;W=px}
    var Q=b.pts,NQ=Q.length,dd=1e18,sg=1,i,j;
    for(i=0,j=NQ-1;i<NQ;j=i++){var ex=Q[j][0]-Q[i][0],ey=Q[j][1]-Q[i][1],wx=U-Q[i][0],wy=Vv-Q[i][1],el=ex*ex+ey*ey,tq=el>0?Math.max(0,Math.min(1,(wx*ex+wy*ey)/el)):0,bx=wx-ex*tq,by=wy-ey*tq,qq=bx*bx+by*by;if(qq<dd)dd=qq;
      var c1=Vv>=Q[i][1],c2=Vv<Q[j][1],c3=ex*wy>ey*wx;if((c1&&c2&&c3)||(!c1&&!c2&&!c3))sg=-sg}
    var d2=sg*Math.sqrt(dd)+b.round,hw=b.hw*(1-b.taper*Math.max(0,Math.min(1,(Vv-b.vmin)/b.vspan))),dw=Math.abs(W)-hw+b.round,qx2=Math.max(d2,0),qy2=Math.max(dw,0);
    return Math.sqrt(qx2*qx2+qy2*qy2)+Math.min(Math.max(d2,dw),0)-b.round}
  var a=b.r[0],c=b.r[1],e=b.r[2];
  if(b.s==="torus"){var tq=Math.sqrt(px*px+pz*pz)-b.tR;return Math.sqrt(tq*tq+py*py)-b.tr}
  if(b.s==="box"){var o=b.round,ux=Math.abs(px)-a+o,uy=Math.abs(py)-c+o,uz=Math.abs(pz)-e+o,mx=Math.max(ux,0),my=Math.max(uy,0),mz=Math.max(uz,0);return Math.sqrt(mx*mx+my*my+mz*mz)+Math.min(Math.max(ux,uy,uz),0)-o}
  if(a===c&&c===e)return Math.sqrt(px*px+py*py+pz*pz)-a;
  var k0=Math.sqrt(px*px/(a*a)+py*py/(c*c)+pz*pz/(e*e)),k1=Math.sqrt(px*px/(a*a*a*a)+py*py/(c*c*c*c)+pz*pz/(e*e*e*e));
  return k1<1e-9?-Math.min(a,c,e):k0*(k0-1)/k1}
// surface materials per blob: [roughness, metalness, emissive]; surface detail kinds the shader draws (fur, scales, wrinkles...)
var SC_MAT={matte:[0.85,0.05,0],clay:[0.62,0,0],plastic:[0.3,0,0],metal:[0.3,0.92,0],glossy:[0.2,0.1,0],glass:[0.06,0.1,0],glow:[0.5,0,1],holo:[0.2,0,0.6],fur:[0.92,0,0],skin:[0.56,0,0],leather:[0.5,0,0],wood:[0.72,0,0],stone:[0.9,0,0],cloth:[0.95,0,0],paint:[0.3,0.5,0],rubber:[0.88,0,0],chrome:[0.08,1,0]};
var SC_TEX=["fur","scales","wrinkles","rock","wood","cloth","hammered","pores"],SC_MATTEX={fur:"fur",stone:"rock",leather:"wrinkles",wood:"wood",cloth:"cloth",skin:"pores"};
function scSurf(mat,tex,fb){var rm=SC_MAT[mat]||fb.rm,t=tex!==undefined?tex:(mat&&SC_MAT[mat]?SC_MATTEX[mat]||"none":fb.tex);return{rm:rm,ti:SC_TEX.indexOf(t)}}
function sculptPrep(p){
  var B=[],mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9],bones=[""],nz=p.noise||{},kmax=0,base=scSurf(p.mat,p.tex,{rm:SC_MAT.matte,tex:"none"});base={rm:base.rm,tex:p.tex!==undefined?p.tex:(SC_MATTEX[p.mat]||"none")};
  (p.blobs||[]).forEach(function(q){
    var sf=scSurf(q.mat,q.tex,base);
    var b={s:q.s,at:q.at,r:q.r,k:Math.max(1e-4,q.k||0.08),sub:!!q.sub,and:!!q.and,paint:!!q.paint,soft:q.soft||0.05,col:new T.Color(q.color||p.color),m:null,round:q.round||0,bi:0,rm:sf.rm,ti:sf.ti,pm:q.paint&&(q.mat!==undefined||q.tex!==undefined),pc:!q.paint||q.color!==undefined,fl:q.flow||p.flow||[0,-0.45,-1],sg:q.shag!==undefined?q.shag:(p.shag===undefined?0.5:p.shag)};
    var bn=q.bone||p.bone;if(bn&&!b.sub&&!b.paint){var bi=bones.indexOf(bn);if(bi<0&&bones.length<32){bones.push(bn);bi=bones.length-1}b.bi=Math.max(0,bi)}
    if(q.s==="stick"||q.s==="cyl"){var A=q.at,C=q.to,ba=[C[0]-A[0],C[1]-A[1],C[2]-A[2]],l2=ba[0]*ba[0]+ba[1]*ba[1]+ba[2]*ba[2],r2=q.s==="cyl"?q.r:q.r2,rr=q.r-r2,a2=l2-rr*rr;
      if(a2<=1e-8||l2<1e-8){var R0=Math.max(q.r,r2);b.s="ball";b.r=[R0,R0,R0];b.at=q.r>=r2?A:C}
      else if(q.s==="cyl"){var L=Math.sqrt(l2),rd=Math.min(b.round,q.r*0.95,L*0.45),ux=ba[0]/L,uy=ba[1]/L,uz=ba[2]/L,A2=[A[0]+ux*rd,A[1]+uy*rd,A[2]+uz*rd],C2=[C[0]-ux*rd,C[1]-uy*rd,C[2]-uz*rd];
        b.at=A2;b.ba=[C2[0]-A2[0],C2[1]-A2[1],C2[2]-A2[2]];b.l2=b.ba[0]*b.ba[0]+b.ba[1]*b.ba[1]+b.ba[2]*b.ba[2];b.r1=q.r-rd;b.round=rd;b.c=[(A[0]+C[0])/2,(A[1]+C[1])/2,(A[2]+C[2])/2];b.R=Math.sqrt(L*L/4+q.r*q.r)}
      else{b.ba=ba;b.l2=l2;b.r1=q.r;b.r2=q.r2;b.rr=rr;b.a2=a2;b.il2=1/l2;b.c=[(A[0]+C[0])/2,(A[1]+C[1])/2,(A[2]+C[2])/2];b.R=Math.sqrt(l2)/2+Math.max(q.r,q.r2)}}
    if(b.s!=="stick"&&b.s!=="cyl"){
      if(q.rot&&(q.rot[0]||q.rot[1]||q.rot[2])){var el=new T.Matrix4().makeRotationFromEuler(new T.Euler(q.rot[0]*RAD,q.rot[1]*RAD,q.rot[2]*RAD)).elements;b.m=[el[0],el[1],el[2],el[4],el[5],el[6],el[8],el[9],el[10]]}
      if(b.s==="torus"){b.tR=q.r[0];b.tr=q.r2||q.r[1]||0.05;b.R=b.tR+b.tr}
      if(b.s==="profile"){b.pts=q.pts;b.ax=q.axis||"x";b.hw=q.r[0];b.taper=q.taper||0;var u0=1e9,u1=-1e9,v0=1e9,v1=-1e9;q.pts.forEach(function(pp){u0=Math.min(u0,pp[0]);u1=Math.max(u1,pp[0]);v0=Math.min(v0,pp[1]);v1=Math.max(v1,pp[1])});
        b.vmin=v0;b.vspan=Math.max(1e-6,v1-v0);var cu=(u0+u1)/2,cv=(v0+v1)/2,lo2=b.ax==="y"?[cu,0,cv]:b.ax==="z"?[cu,cv,0]:[0,cv,cu],mm=b.m;
        var wo=mm?[mm[0]*lo2[0]+mm[3]*lo2[1]+mm[6]*lo2[2],mm[1]*lo2[0]+mm[4]*lo2[1]+mm[7]*lo2[2],mm[2]*lo2[0]+mm[5]*lo2[1]+mm[8]*lo2[2]]:lo2;
        b.pc0=[q.at[0]+wo[0],q.at[1]+wo[1],q.at[2]+wo[2]];b.R=Math.sqrt(Math.pow((u1-u0)/2,2)+Math.pow((v1-v0)/2,2)+b.hw*b.hw)+b.round}
      b.c=b.pc0||b.at;if(b.s!=="torus"&&b.s!=="profile")b.R=b.s==="box"?Math.sqrt(b.r[0]*b.r[0]+b.r[1]*b.r[1]+b.r[2]*b.r[2]):Math.max(b.r[0],b.r[1],b.r[2])}
    if(!b.sub&&!b.paint&&!b.and){for(var j=0;j<3;j++){mn[j]=Math.min(mn[j],b.c[j]-b.R-b.k);mx[j]=Math.max(mx[j],b.c[j]+b.R+b.k)}}
    if(!b.paint)kmax=Math.max(kmax,b.k);
    B.push(b)});
  var amp=nz.amp||0;for(var j2=0;j2<3;j2++){mn[j2]-=amp;mx[j2]+=amp}
  return{B:B,P:B.filter(function(b){return b.paint}),F:B.filter(function(b){return !b.paint}),min:mn,max:mx,amp:amp,fs:nz.scale||6,bones:bones,kmax:kmax,ok:mn[0]<mx[0]}}
// the field; L = an optional shorter list of the blobs that can matter here (built per 4x4x4 block)
function sField(S,x,y,z,L){
  var B=L||S.F,d=1e9,i;
  for(i=0;i<B.length;i++){var b=B[i];
    var dx=x-b.c[0],dy=y-b.c[1],dz=z-b.c[2],lb=Math.sqrt(dx*dx+dy*dy+dz*dz)-b.R;
    if(b.and){d=smax(d,sdBlob(b,x,y,z),b.k);continue}
    if(b.sub){if(lb>=b.k-d)continue;d=smax(d,-sdBlob(b,x,y,z),b.k)}
    else{if(lb>=d+b.k)continue;d=smin(d,sdBlob(b,x,y,z),b.k)}}
  if(S.amp)d+=S.amp*(fbm(x*S.fs,y*S.fs,z*S.fs,3)-0.44)*2;
  return d}
function sculptGeo(p){
  var S=sculptPrep(p),hard=!!p.hard;if(!S.ok)return new T.SphereGeometry(0.3,12,8);
  // detail follows the finest feature: thin blades, toes and wrap rings get enough cells to exist (auto, capped for speed)
  var feat=1e9;S.F.forEach(function(b){if(b.sub)return;var f=b.s==="stick"?Math.min(b.r1,b.r2):b.s==="cyl"?b.r1+b.round:b.s==="torus"?b.tr:b.s==="profile"?Math.max(b.round*2,Math.min(b.hw,0.05)):Math.min(b.r[0],b.r[1],b.r[2]);if(f>0)feat=Math.min(feat,f)});
  var ext0=Math.max(S.max[0]-S.min[0],S.max[1]-S.min[1],S.max[2]-S.min[2]),lo=!!p.low,res=p.res||(lo?72:Math.round(Math.max(96,Math.min(128,ext0*2.6/feat)))),mn=S.min,mx=S.max,ext=Math.max(mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2]),h=ext/res;
  var ox=mn[0]-h*2,oy=mn[1]-h*2,oz=mn[2]-h*2,nx=Math.ceil((mx[0]-mn[0])/h)+5,ny=Math.ceil((mx[1]-mn[1])/h)+5,nz=Math.ceil((mx[2]-mn[2])/h)+5;
  var NXY=nx*ny,F=new Float32Array(NXY*nz),V=new Int32Array(NXY*nz).fill(-1),i,j,k,n,pos=[];
  // 4x4x4 blocks: one probe at the centre. Far from the surface the block just takes the probe's value (only the SIGN
  // matters there); near it, only the blobs that can reach the block are evaluated (the rest provably change nothing)
  var BS=4,bR=BS*0.5*h*Math.sqrt(3),far=bR*1.3+S.amp*2,bi,bj,bk,BX=Math.ceil(nx/BS),BY=Math.ceil(ny/BS),BL=[];
  for(bk=0;bk<nz;bk+=BS)for(bj=0;bj<ny;bj+=BS)for(bi=0;bi<nx;bi+=BS){
    var cx0=ox+(bi+BS*0.5)*h,cy0=oy+(bj+BS*0.5)*h,cz0=oz+(bk+BS*0.5)*h,fc=sField(S,cx0,cy0,cz0),i1=Math.min(nx,bi+BS),j1=Math.min(ny,bj+BS),k1=Math.min(nz,bk+BS),fill=Math.abs(fc)>far,L=null;
    if(!fill){var reach=Math.abs(fc)+2*bR+S.kmax+S.amp*2;L=S.F.filter(function(b){if(b.and)return true;var dx=cx0-b.c[0],dy=cy0-b.c[1],dz=cz0-b.c[2];return Math.sqrt(dx*dx+dy*dy+dz*dz)-b.R<reach});BL[(bi/BS)+BX*((bj/BS)+BY*(bk/BS))]=L}
    for(k=bk;k<k1;k++)for(j=bj;j<j1;j++)for(i=bi;i<i1;i++)F[i+nx*j+NXY*k]=fill?fc:sField(S,ox+i*h,oy+j*h,oz+k*h,L)}
  var CO=[],ED=[];for(n=0;n<8;n++)CO.push([n&1,(n>>1)&1,(n>>2)&1]);
  for(n=0;n<8;n++)[1,2,4].forEach(function(bit){if(!(n&bit))ED.push([n,n|bit])});
  var cv=new Float32Array(8),VL=[];
  // only blocks near the surface can hold surface cells (BL is set exactly for those)
  function near(i,j,k){return !!BL[((i/BS)|0)+BX*(((j/BS)|0)+BY*((k/BS)|0))]}
  for(k=0;k<nz-1;k++)for(j=0;j<ny-1;j++)for(i=0;i<nx-1;i++){
    if(!near(i,j,k)){i+=BS-1-(i%BS);continue}
    var neg=0;for(n=0;n<8;n++){cv[n]=F[(i+CO[n][0])+nx*(j+CO[n][1])+NXY*(k+CO[n][2])];if(cv[n]<0)neg++}
    if(neg===0||neg===8)continue;
    var sx=0,sy=0,sz=0,cnt=0;
    for(n=0;n<12;n++){var e0=ED[n][0],e1=ED[n][1],a=cv[e0],b=cv[e1];if((a<0)===(b<0))continue;var t=a/(a-b);
      sx+=CO[e0][0]+(CO[e1][0]-CO[e0][0])*t;sy+=CO[e0][1]+(CO[e1][1]-CO[e0][1])*t;sz+=CO[e0][2]+(CO[e1][2]-CO[e0][2])*t;cnt++}
    var vx=ox+(i+sx/cnt)*h,vy=oy+(j+sy/cnt)*h,vz=oz+(k+sz/cnt)*h,LBc=BL[((i/BS)|0)+BX*(((j/BS)|0)+BY*((k/BS)|0))]||null;
    if(hard){
      // dual contouring: the vertex that best fits every crossing's tangent plane (QEF, pulled toward the mass point),
      // so edges and corners land ON the sharp feature instead of being averaged round
      var a00=0,a01=0,a02=0,a11=0,a12=0,a22=0,b0=0,b1=0,b2=0,de=h*0.05;
      for(n=0;n<12;n++){var f0=ED[n][0],f1=ED[n][1],ca=cv[f0],cb=cv[f1];if((ca<0)===(cb<0))continue;var tt2=ca/(ca-cb),
          qx=ox+(i+CO[f0][0]+(CO[f1][0]-CO[f0][0])*tt2)*h,qy=oy+(j+CO[f0][1]+(CO[f1][1]-CO[f0][1])*tt2)*h,qz=oz+(k+CO[f0][2]+(CO[f1][2]-CO[f0][2])*tt2)*h,
          gx=sField(S,qx+de,qy,qz,LBc)-sField(S,qx-de,qy,qz,LBc),gy=sField(S,qx,qy+de,qz,LBc)-sField(S,qx,qy-de,qz,LBc),gz=sField(S,qx,qy,qz+de,LBc)-sField(S,qx,qy,qz-de,LBc),gn=Math.sqrt(gx*gx+gy*gy+gz*gz)||1;
        gx/=gn;gy/=gn;gz/=gn;var dq=gx*qx+gy*qy+gz*qz;
        a00+=gx*gx;a01+=gx*gy;a02+=gx*gz;a11+=gy*gy;a12+=gy*gz;a22+=gz*gz;b0+=gx*dq;b1+=gy*dq;b2+=gz*dq}
      var lam=0.06,m00=a00+lam,m11=a11+lam,m22=a22+lam,r0=b0-(a00*vx+a01*vy+a02*vz),r1=b1-(a01*vx+a11*vy+a12*vz),r2=b2-(a02*vx+a12*vy+a22*vz),
        det=m00*(m11*m22-a12*a12)-a01*(a01*m22-a12*a02)+a02*(a01*a12-m11*a02);
      if(Math.abs(det)>1e-12){
        var ux2=(r0*(m11*m22-a12*a12)-a01*(r1*m22-a12*r2)+a02*(r1*a12-m11*r2))/det,uy2=(m00*(r1*m22-a12*r2)-r0*(a01*m22-a12*a02)+a02*(a01*r2-r1*a02))/det,uz2=(m00*(m11*r2-r1*a12)-a01*(a01*r2-r1*a02)+r0*(a01*a12-m11*a02))/det,
          nx2=vx+ux2,ny2=vy+uy2,nz2=vz+uz2,mg=h*0.25;
        if(nx2>ox+i*h-mg&&nx2<ox+(i+1)*h+mg&&ny2>oy+j*h-mg&&ny2<oy+(j+1)*h+mg&&nz2>oz+k*h-mg&&nz2<oz+(k+1)*h+mg){vx=nx2;vy=ny2;vz=nz2}}}
    V[i+nx*j+NXY*k]=pos.length/3;pos.push(vx,vy,vz);
    VL.push(LBc)}
  // one vertex per surface cell: watertight, but two sheets crossing ONE cell (features thinner than a cell) share it,
  // leaving a few 4-triangle edges - invisible; res (auto from the finest feature) keeps them rare
  var idx=[],VC=function(a,b,c){return V[a+nx*b+NXY*c]};
  function quad(q,inside){
    if(q[0]<0||q[1]<0||q[2]<0||q[3]<0)return;
    // the cells are listed counter-clockwise about the +axis edge, so that order faces +axis: right when the inside is behind
    if(!inside)q=[q[3],q[2],q[1],q[0]];
    var d02=0,d13=0;for(var c=0;c<3;c++){d02+=Math.pow(pos[q[0]*3+c]-pos[q[2]*3+c],2);d13+=Math.pow(pos[q[1]*3+c]-pos[q[3]*3+c],2)}
    if(d02<=d13)idx.push(q[0],q[1],q[2],q[0],q[2],q[3]);else idx.push(q[0],q[1],q[3],q[1],q[2],q[3])}
  for(k=1;k<nz-1;k++)for(j=1;j<ny-1;j++)for(i=1;i<nx-1;i++){
    // every quad around the three edges leaving this grid point uses THIS cell's vertex: no vertex, no quads
    if(V[i+nx*j+NXY*k]<0)continue;
    var f0=F[i+nx*j+NXY*k],in0=f0<0;
    if(in0!==(F[i+1+nx*j+NXY*k]<0))quad([VC(i,j-1,k-1),VC(i,j,k-1),VC(i,j,k),VC(i,j-1,k)],in0);
    if(in0!==(F[i+nx*(j+1)+NXY*k]<0))quad([VC(i-1,j,k-1),VC(i-1,j,k),VC(i,j,k),VC(i,j,k-1)],in0);
    if(in0!==(F[i+nx*j+NXY*(k+1)]<0))quad([VC(i-1,j-1,k),VC(i,j-1,k),VC(i,j,k),VC(i-1,j,k)],in0)}
  // project every vertex onto the real surface (two Newton steps); normals from the field gradient (smooth, no grid faceting)
  var NV=pos.length/3,P=new Float32Array(pos),NR=new Float32Array(NV*3),eps=h*0.3,g=[0,0,0],LL=null;
  function grad(x,y,z){g[0]=sField(S,x+eps,y,z,LL)-sField(S,x-eps,y,z,LL);g[1]=sField(S,x,y+eps,z,LL)-sField(S,x,y-eps,z,LL);g[2]=sField(S,x,y,z+eps,LL)-sField(S,x,y,z-eps,LL);return g}
  for(n=0;n<NV;n++){var x=P[3*n],y=P[3*n+1],z=P[3*n+2],gl=0,it;LL=VL[n];
    for(it=0;it<(hard?0:1);it++){var f=sField(S,x,y,z,LL);grad(x,y,z);gl=g[0]*g[0]+g[1]*g[1]+g[2]*g[2];if(gl<1e-12)break;
      var sq=Math.sqrt(gl),mv=Math.max(-h,Math.min(h,f*2*eps/sq))/sq;x-=g[0]*mv;y-=g[1]*mv;z-=g[2]*mv}
    P[3*n]=x;P[3*n+1]=y;P[3*n+2]=z;grad(x,y,z);gl=g[0]*g[0]+g[1]*g[1]+g[2]*g[2];
    var il=gl>1e-12?1/Math.sqrt(gl):0;NR[3*n]=g[0]*il;NR[3*n+1]=g[1]*il;NR[3*n+2]=g[2]*il}
  // per vertex: colour (blobs blend where they melt, paint lays soft markings), material (roughness/metal/glow),
  // surface detail weights for the shader (fur, scales, wrinkles...), crease darkening (SDF ambient occlusion), skin weights
  var SHD=new Float32Array(NV),COL=new Float32Array(NV*3),FLW=new Float32Array(NV*3),SHG=new Float32Array(NV),fl=[0,0,0],sgv=0,RME=new Float32Array(NV*3),DA=new Float32Array(NV*4),DB=new Float32Array(NV*4),nb=S.bones.length,skin=nb>1,SI=skin?new Uint16Array(NV*4):null,SW=skin?new Float32Array(NV*4):null,acc=new Float64Array(nb),tc=new T.Color(),ao=p.ao===undefined?1:p.ao,tint=p.tint===undefined?0.06:p.tint,fq=4/Math.max(0.2,ext);
  // the grid already holds the field: crease darkening samples it (trilinear) instead of re-evaluating every blob
  function fAt(x,y,z){var fx=(x-ox)/h,fy=(y-oy)/h,fz=(z-oz)/h;fx=Math.max(0,Math.min(nx-1.001,fx));fy=Math.max(0,Math.min(ny-1.001,fy));fz=Math.max(0,Math.min(nz-1.001,fz));
    var i0=fx|0,j0=fy|0,k0=fz|0,tx=fx-i0,ty=fy-j0,tz=fz-k0,b0=i0+nx*j0+NXY*k0,
      c00=F[b0]+(F[b0+1]-F[b0])*tx,c10=F[b0+nx]+(F[b0+nx+1]-F[b0+nx])*tx,c01=F[b0+NXY]+(F[b0+NXY+1]-F[b0+NXY])*tx,c11=F[b0+NXY+nx]+(F[b0+NXY+nx+1]-F[b0+NXY+nx])*tx,
      c0=c00+(c10-c00)*ty,c1=c01+(c11-c01)*ty;return c0+(c1-c0)*tz}
  // markings drawn per PIXEL on the GPU (crisp at any mesh resolution): up to 16 colour paints, profiles up to 24 points; the rest bake
  var GP=[];if(!lo&&p.crisp!==false)S.P.forEach(function(pb){if(!pb.pc||GP.length>=16||(pb.s==="profile"&&pb.pts.length>24))return;pb.gpu=true;GP.push(pb)});
  var aoD=[0.012,0.035,0.07,0.13].map(function(v){return v*ext}),aoW=[0.42,0.3,0.18,0.1],rm=[0,0,0],dt=new Float64Array(8),hasDet=[0,0,0,0,0,0,0,0];
  for(n=0;n<NV;n++){
    var X=P[3*n],Y=P[3*n+1],Z=P[3*n+2],best=1e9,q2,LB=VL[n]||S.F,dists=new Array(LB.length);
    var bestK=1;for(q2=0;q2<LB.length;q2++){var bb=LB[q2];if(bb.sub||bb.and){dists[q2]=1e9;continue}var dd=sdBlob(bb,X,Y,Z);dists[q2]=dd;if(dd<best){best=dd;bestK=bb.k}}
    var r0=0,g0=0,b0=0,ws=0;for(q2=0;q2<nb;q2++)acc[q2]=0;rm[0]=rm[1]=rm[2]=0;fl[0]=fl[1]=fl[2]=0;sgv=0;for(q2=0;q2<8;q2++)dt[q2]=0;
    for(q2=0;q2<LB.length;q2++){var bl=LB[q2];if(bl.sub||bl.and)continue;var dz=(dists[q2]-best)/Math.max(0.004,Math.min(bl.k,bestK)*0.45),w=Math.exp(-dz*dz);if(w<1e-4)continue;
      r0+=bl.col.r*w;g0+=bl.col.g*w;b0+=bl.col.b*w;ws+=w;acc[bl.bi]+=w;rm[0]+=bl.rm[0]*w;rm[1]+=bl.rm[1]*w;rm[2]+=bl.rm[2]*w;fl[0]+=bl.fl[0]*w;fl[1]+=bl.fl[1]*w;fl[2]+=bl.fl[2]*w;sgv+=bl.sg*w;if(bl.ti>=0)dt[bl.ti]+=w}
    if(ws<=0){ws=1;r0=tc.r;g0=tc.g;b0=tc.b}
    tc.setRGB(r0/ws,g0/ws,b0/ws);rm[0]/=ws;rm[1]/=ws;rm[2]/=ws;for(q2=0;q2<8;q2++)dt[q2]/=ws;
    for(q2=0;q2<S.P.length;q2++){var pb=S.P[q2];if(pb.gpu&&!pb.pm)continue;var pd=sdBlob(pb,X,Y,Z),tt=Math.max(0,Math.min(1,1-pd/pb.soft));if(tt<=0)continue;tt=tt*tt*(3-2*tt);
        if(pb.pc&&!pb.gpu)tc.lerp(pb.col,tt);
      if(pb.pm){rm[0]+=(pb.rm[0]-rm[0])*tt;rm[1]+=(pb.rm[1]-rm[1])*tt;rm[2]+=(pb.rm[2]-rm[2])*tt;for(var d8=0;d8<8;d8++)dt[d8]*=1-tt;if(pb.ti>=0)dt[pb.ti]+=tt}}
    var occ=0;for(q2=0;q2<4;q2++){var hh=aoD[q2],fv=fAt(X+NR[3*n]*hh,Y+NR[3*n+1]*hh,Z+NR[3*n+2]*hh);occ+=aoW[q2]*Math.max(0,(hh-fv)/hh)}
    var shade=(1-ao*Math.min(0.62,occ*1.15))*(1+tint*((fbm(X*fq*3,Y*fq*3,Z*fq*3,3)-0.44)*2.2));
    COL[3*n]=tc.r*shade;COL[3*n+1]=tc.g*shade;COL[3*n+2]=tc.b*shade;SHD[n]=shade;SHG[n]=sgv/ws;FLW[3*n]=fl[0]/ws;FLW[3*n+1]=fl[1]/ws;FLW[3*n+2]=fl[2]/ws;RME[3*n]=rm[0];RME[3*n+1]=rm[1];RME[3*n+2]=rm[2];
    for(q2=0;q2<4;q2++){DA[4*n+q2]=dt[q2];DB[4*n+q2]=dt[q2+4];if(dt[q2]>0.01)hasDet[q2]=1;if(dt[q2+4]>0.01)hasDet[q2+4]=1}
    if(skin){var top=[];for(q2=0;q2<nb;q2++)if(acc[q2]>0)top.push([acc[q2],q2]);top.sort(function(u,v){return v[0]-u[0]});top=top.slice(0,4);var tw=0;top.forEach(function(e){tw+=e[0]});
      for(q2=0;q2<4;q2++){SI[4*n+q2]=top[q2]?top[q2][1]:0;SW[4*n+q2]=top[q2]&&tw>0?top[q2][0]/tw:(q2?0:1)}}}
  // fur locks in the GEOMETRY (the sculpted look): flow-aligned clumps push the skin in and out where the surface is fur, so the
  // silhouette itself is shaggy - long along the hair flow, narrow across it. shag 0 turns it off; low-poly skips it.
  var displaced=false;
  if(!lo&&hasDet[0]){var cs=58/Math.max(0.2,ext),amp=0.008*ext;
    for(n=0;n<NV;n++){var wf=DA[4*n]*SHG[n];if(wf<0.02)continue;
      var nX=NR[3*n],nY=NR[3*n+1],nZ=NR[3*n+2],fx=FLW[3*n],fy=FLW[3*n+1],fz=FLW[3*n+2],fd=fx*nX+fy*nY+fz*nZ;fx-=fd*nX;fy-=fd*nY;fz-=fd*nZ;var fll=Math.sqrt(fx*fx+fy*fy+fz*fz)||1;fx/=fll;fy/=fll;fz/=fll;
      var sX=nY*fz-nZ*fy,sY=nZ*fx-nX*fz,sZ=nX*fy-nY*fx,px=P[3*n],py=P[3*n+1],pz=P[3*n+2],
        u=(px*sX+py*sY+pz*sZ)*cs,vv2=(px*fx+py*fy+pz*fz)*cs*0.36,ww=(px*nX+py*nY+pz*nZ)*cs*0.5,
        r1=1-Math.abs(noise3(u,vv2,ww)*2-1),r2=1-Math.abs(noise3(u*2.1+5.1,vv2*1.9,ww*2.1)*2-1),
        lock=0.7*r1*r1+0.3*r2,dsp=amp*wf*(lock-0.45)*2.2;
      P[3*n]+=nX*dsp;P[3*n+1]+=nY*dsp;P[3*n+2]+=nZ*dsp;displaced=true}}
  var gm=new T.BufferGeometry();gm.setAttribute("position",new T.BufferAttribute(P,3));gm.setAttribute("normal",new T.BufferAttribute(NR,3));gm.setAttribute("color",new T.BufferAttribute(COL,3));gm.setAttribute("flow",new T.BufferAttribute(FLW,3));
  gm.setAttribute("rme",new T.BufferAttribute(RME,3));gm.setAttribute("shd",new T.BufferAttribute(SHD,1));gm.setAttribute("dtA",new T.BufferAttribute(DA,4));gm.setAttribute("dtB",new T.BufferAttribute(DB,4));
  if(skin){gm.setAttribute("skinIndex",new T.BufferAttribute(SI,4));gm.setAttribute("skinWeight",new T.BufferAttribute(SW,4))}
  gm.setIndex(NV>65535?new T.Uint32BufferAttribute(idx,1):new T.Uint16BufferAttribute(idx,1));
  if(displaced)gm.computeVertexNormals();
  gm.userData.bones=skin?S.bones:null;gm.userData.sculpt=true;gm.userData.det=hasDet;gm.userData.ext=ext;
  gm.userData.gp=GP.map(function(b){var K={ball:0,box:1,stick:2,cyl:3,profile:4,torus:5}[b.s]||0,to=b.ba?[b.at[0]+b.ba[0],b.at[1]+b.ba[1],b.at[2]+b.ba[2]]:[0,0,0];
    return{k:K,at:b.at,r:K<=1?b.r:K===5?[b.tR,0,0]:[b.r1||0,0,0],round:b.round||0,to:K===4?[b.hw,b.taper,b.ax==="y"?1:b.ax==="z"?2:0]:to,e:K===4?[b.pts.length,b.vmin,b.vspan,0]:[0,0,0,K===5?b.tr:(b.r2||0)],m:b.m,col:[b.col.r,b.col.g,b.col.b],soft:b.soft,pts:b.pts||null}});
  // poly = a triangle budget: decimate the high-detail surface (game LODs; and the real low-poly look)
  var budget=p.poly||(lo?1400:0);if(budget)gm=decimate(gm,budget);
  if(hard&&!lo)gm=autoSmooth(gm,p.crease===undefined?32:p.crease);
  if(lo){var ud=gm.userData;gm=gm.toNonIndexed();gm.userData=ud;var fs=p.shade===undefined?0.07:p.shade;
    ["color","rme"].forEach(function(nm){var ca=gm.attributes[nm];for(n=0;n<ca.count;n+=3){var jt=nm==="color"?1+(hsh(n*7+3)-0.5)*2*fs:1;for(var ch=0;ch<3;ch++){var av=(ca.array[n*3+ch]+ca.array[n*3+3+ch]+ca.array[n*3+6+ch])/3*jt;ca.array[n*3+ch]=ca.array[n*3+3+ch]=ca.array[n*3+6+ch]=av}}});gm.computeVertexNormals()}
  return gm}
// auto-smooth (Blender's): a face corner averages only the neighbouring faces within crease degrees of its own face, so
// flat panels shade flat, curves stay smooth and every edge sharper than the crease angle is a crisp line
function autoSmooth(gm,deg){
  // stays INDEXED: a vertex is split only where its corners disagree (a crease), so a hard mesh keeps ~1.2x its vertex count
  var I=gm.index.array,P=gm.attributes.position.array,NF=I.length/3,NV=P.length/3,FN=new Float32Array(NF*3),VF=[],f,v,k,cosT=Math.cos(deg*RAD);
  for(v=0;v<NV;v++)VF.push([]);
  for(f=0;f<NF;f++){var a=I[3*f],b=I[3*f+1],c=I[3*f+2],ux=P[3*b]-P[3*a],uy=P[3*b+1]-P[3*a+1],uz=P[3*b+2]-P[3*a+2],wx=P[3*c]-P[3*a],wy=P[3*c+1]-P[3*a+1],wz=P[3*c+2]-P[3*a+2],
    x=uy*wz-uz*wy,y=uz*wx-ux*wz,z=ux*wy-uy*wx,l=Math.sqrt(x*x+y*y+z*z)||1;FN[3*f]=x;FN[3*f+1]=y;FN[3*f+2]=z;VF[a].push(f);VF[b].push(f);VF[c].push(f)}
  var atts=Object.keys(gm.attributes).filter(function(n){return n!=="normal"}).map(function(n){return{n:n,a:gm.attributes[n].array,s:gm.attributes[n].itemSize}});
  var outV=[],outN=[],NI=new Uint32Array(NF*3);
  for(v=0;v<NV;v++){var fl=VF[v],clusters=[];
    for(k=0;k<fl.length;k++){var g=fl[k],gx=FN[3*g],gy=FN[3*g+1],gz=FN[3*g+2],gl=Math.sqrt(gx*gx+gy*gy+gz*gz)||1,sx=0,sy=0,sz=0;
      for(var m=0;m<fl.length;m++){var h=fl[m],hx=FN[3*h],hy=FN[3*h+1],hz=FN[3*h+2],hl=Math.sqrt(hx*hx+hy*hy+hz*hz)||1;if((gx*hx+gy*hy+gz*hz)/(gl*hl)>=cosT){sx+=hx;sy+=hy;sz+=hz}}
      var ln=Math.sqrt(sx*sx+sy*sy+sz*sz)||1;sx/=ln;sy/=ln;sz/=ln;
      var hit=-1;for(var q=0;q<clusters.length;q++){var cc=clusters[q];if(cc[0]*sx+cc[1]*sy+cc[2]*sz>0.9995){hit=cc[3];break}}
      if(hit<0){hit=outV.length;outV.push(v);outN.push(sx,sy,sz);clusters.push([sx,sy,sz,hit])}
      for(var j=0;j<3;j++)if(I[3*g+j]===v)NI[3*g+j]=hit}}
  var out=new T.BufferGeometry(),n2=outV.length;
  atts.forEach(function(at){var src=gm.attributes[at.n],arr=new src.array.constructor(n2*at.s);for(var i=0;i<n2;i++)for(var j=0;j<at.s;j++)arr[i*at.s+j]=at.a[outV[i]*at.s+j];out.setAttribute(at.n,new T.BufferAttribute(arr,at.s))});
  out.setAttribute("normal",new T.BufferAttribute(new Float32Array(outN),3));
  out.setIndex(n2>65535?new T.BufferAttribute(NI,1):new T.BufferAttribute(new Uint16Array(NI),1));out.userData=gm.userData;return out}
// decimation (quadric error metrics, the Blender "Decimate" collapse): big flat facets where the form is flat, small ones where
// it curves. Every attribute rides along (colour, material, detail, flow lerp; skin weights snap to the nearer end).
// Edge collapses that would flip a face or pinch the surface (link condition) are refused, so the mesh stays closed.
function decimate(gm,target){
  var P=gm.attributes.position.array,I=gm.index.array,NV=P.length/3,NF=I.length/3;if(NF<=target)return gm;
  var Q=new Float64Array(NV*10),fA=new Uint8Array(NF).fill(1),vA=new Uint8Array(NV).fill(1),ver=new Int32Array(NV),F=new Int32Array(I),VF=[],v,f,k;
  for(v=0;v<NV;v++)VF.push([]);
  for(f=0;f<NF;f++){var a=F[3*f],b=F[3*f+1],c=F[3*f+2];VF[a].push(f);VF[b].push(f);VF[c].push(f);
    var ux=P[3*b]-P[3*a],uy=P[3*b+1]-P[3*a+1],uz=P[3*b+2]-P[3*a+2],wx=P[3*c]-P[3*a],wy=P[3*c+1]-P[3*a+1],wz=P[3*c+2]-P[3*a+2],nx=uy*wz-uz*wy,ny=uz*wx-ux*wz,nz=ux*wy-uy*wx,l=Math.sqrt(nx*nx+ny*ny+nz*nz);if(l<1e-12)continue;
    var ar=l*0.5;nx/=l;ny/=l;nz/=l;var d=-(nx*P[3*a]+ny*P[3*a+1]+nz*P[3*a+2]),q=[nx*nx,nx*ny,nx*nz,nx*d,ny*ny,ny*nz,ny*d,nz*nz,nz*d,d*d];
    [a,b,c].forEach(function(vv){for(var j=0;j<10;j++)Q[vv*10+j]+=q[j]*ar})}
  function err(qa,qb,x,y,z){var m=function(j){return Q[qa*10+j]+Q[qb*10+j]};
    return m(0)*x*x+2*m(1)*x*y+2*m(2)*x*z+2*m(3)*x+m(4)*y*y+2*m(5)*y*z+2*m(6)*y+m(7)*z*z+2*m(8)*z+m(9)}
  // binary heap of [cost, a, b, verA, verB, t]
  var H=[];function push(e){H.push(e);var i=H.length-1;while(i>0){var pi=(i-1)>>1;if(H[pi][0]<=H[i][0])break;var tmp=H[pi];H[pi]=H[i];H[i]=tmp;i=pi}}
  function pop(){var top=H[0],last=H.pop();if(H.length){H[0]=last;var i=0;for(;;){var l=2*i+1,r=l+1,m=i;if(l<H.length&&H[l][0]<H[m][0])m=l;if(r<H.length&&H[r][0]<H[m][0])m=r;if(m===i)break;var tmp=H[m];H[m]=H[i];H[i]=tmp;i=m}}return top}
  function cand(a,b){var best=null;[0,0.5,1].forEach(function(t){var x=P[3*a]+(P[3*b]-P[3*a])*t,y=P[3*a+1]+(P[3*b+1]-P[3*a+1])*t,z=P[3*a+2]+(P[3*b+2]-P[3*a+2])*t,e=err(a,b,x,y,z);if(!best||e<best[0])best=[e,t]});
    var lx=P[3*a]-P[3*b],ly=P[3*a+1]-P[3*b+1],lz=P[3*a+2]-P[3*b+2];push([best[0]+1e-9*(lx*lx+ly*ly+lz*lz),a,b,ver[a],ver[b],best[1]])}
  function nbrs(a){var o={};VF[a].forEach(function(ff){if(!fA[ff])return;for(var j=0;j<3;j++){var w=F[3*ff+j];if(w!==a)o[w]=1}});return o}
  for(f=0;f<NF;f++)for(k=0;k<3;k++){var e0=F[3*f+k],e1=F[3*f+(k+1)%3];if(e0<e1)cand(e0,e1)}
  var alive=NF,atts=Object.keys(gm.attributes).filter(function(n){return n!=="position"}).map(function(n){return{n:n,a:gm.attributes[n].array,s:gm.attributes[n].itemSize,snap:n==="skinIndex"||n==="skinWeight"}});
  function ok(a,b,x,y,z){
    var na=nbrs(a),nb=nbrs(b),common=0;Object.keys(na).forEach(function(w){if(nb[w])common++});if(common!==2)return false;
    var faces=VF[a].concat(VF[b]);
    for(var i=0;i<faces.length;i++){var ff=faces[i];if(!fA[ff])continue;var i0=F[3*ff],i1=F[3*ff+1],i2=F[3*ff+2];if((i0===a||i1===a||i2===a)&&(i0===b||i1===b||i2===b))continue;
      var pts=[i0,i1,i2].map(function(vv){return vv===a||vv===b?[x,y,z]:[P[3*vv],P[3*vv+1],P[3*vv+2]]}),old=[i0,i1,i2].map(function(vv){return[P[3*vv],P[3*vv+1],P[3*vv+2]]});
      var n0=tri(old),n1=tri(pts);if(n1[3]<1e-14)return false;if((n0[0]*n1[0]+n0[1]*n1[1]+n0[2]*n1[2])<0.25*Math.sqrt(n0[3]*n1[3]))return false}
    return true}
  function tri(p){var ux=p[1][0]-p[0][0],uy=p[1][1]-p[0][1],uz=p[1][2]-p[0][2],wx=p[2][0]-p[0][0],wy=p[2][1]-p[0][1],wz=p[2][2]-p[0][2],x=uy*wz-uz*wy,y=uz*wx-ux*wz,z=ux*wy-uy*wx;return[x,y,z,x*x+y*y+z*z]}
  var guard=0;
  while(alive>target&&H.length&&guard++<NF*8){
    var e=pop(),a2=e[1],b2=e[2];if(!vA[a2]||!vA[b2]||ver[a2]!==e[3]||ver[b2]!==e[4])continue;
    var t=e[5],x=P[3*a2]+(P[3*b2]-P[3*a2])*t,y=P[3*a2+1]+(P[3*b2+1]-P[3*a2+1])*t,z=P[3*a2+2]+(P[3*b2+2]-P[3*a2+2])*t;
    if(!ok(a2,b2,x,y,z))continue;
    P[3*a2]=x;P[3*a2+1]=y;P[3*a2+2]=z;
    atts.forEach(function(at){for(var j=0;j<at.s;j++){var ia=a2*at.s+j,ib=b2*at.s+j;at.a[ia]=at.snap?(t>0.5?at.a[ib]:at.a[ia]):at.a[ia]+(at.a[ib]-at.a[ia])*t}});
    for(k=0;k<10;k++)Q[a2*10+k]+=Q[b2*10+k];
    VF[b2].forEach(function(ff){if(!fA[ff])return;var has=F[3*ff]===a2||F[3*ff+1]===a2||F[3*ff+2]===a2;if(has){fA[ff]=0;alive--;return}for(var j=0;j<3;j++)if(F[3*ff+j]===b2)F[3*ff+j]=a2;VF[a2].push(ff)});
    VF[a2]=VF[a2].filter(function(ff){return fA[ff]});vA[b2]=0;ver[a2]++;
    var nn=nbrs(a2);Object.keys(nn).forEach(function(w){cand(a2,+w)})}
  var map=new Int32Array(NV).fill(-1),nv=0;for(f=0;f<NF;f++)if(fA[f])for(k=0;k<3;k++){var vv=F[3*f+k];if(map[vv]<0)map[vv]=nv++}
  var out=new T.BufferGeometry(),np=new Float32Array(nv*3);for(v=0;v<NV;v++)if(map[v]>=0){np[3*map[v]]=P[3*v];np[3*map[v]+1]=P[3*v+1];np[3*map[v]+2]=P[3*v+2]}
  out.setAttribute("position",new T.BufferAttribute(np,3));
  atts.forEach(function(at){var src=gm.attributes[at.n],arr2=new src.array.constructor(nv*at.s);for(v=0;v<NV;v++)if(map[v]>=0)for(var j=0;j<at.s;j++)arr2[map[v]*at.s+j]=at.a[v*at.s+j];out.setAttribute(at.n,new T.BufferAttribute(arr2,at.s))});
  var ni=[];for(f=0;f<NF;f++)if(fA[f])ni.push(map[F[3*f]],map[F[3*f+1]],map[F[3*f+2]]);
  out.setIndex(nv>65535?new T.Uint32BufferAttribute(ni,1):new T.Uint16BufferAttribute(ni,1));out.computeVertexNormals();
  out.userData=gm.userData;return out}
// the sculpt surface shader: per-vertex roughness / metalness / glow, and procedural surface detail drawn per pixel from the
// REST position (so it sticks to the skin as it bends): fur grain, scales, wrinkles, rock, wood grain, cloth weave, hammered metal, pores
var SG_NL=String.fromCharCode(10);
var SG_FN=[
"float sh1(vec3 p){p=fract(p*0.3183099+0.1);p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}",
"float svn(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);return mix(mix(mix(sh1(i),sh1(i+vec3(1,0,0)),f.x),mix(sh1(i+vec3(0,1,0)),sh1(i+vec3(1,1,0)),f.x),f.y),mix(mix(sh1(i+vec3(0,0,1)),sh1(i+vec3(1,0,1)),f.x),mix(sh1(i+vec3(0,1,1)),sh1(i+vec3(1,1,1)),f.x),f.y),f.z);}",
"float sfb(vec3 p){return 0.5*svn(p)+0.25*svn(p*2.03+7.1)+0.125*svn(p*4.01+3.7);}",
"vec3 sgr(vec3 p,float e,int k){vec3 a=vec3(e,0.0,0.0),b=vec3(0.0,e,0.0),c=vec3(0.0,0.0,e);if(k==0)return vec3(sfb(p+a)-sfb(p-a),sfb(p+b)-sfb(p-b),sfb(p+c)-sfb(p-c))/(2.0*e);",
"  return vec3(svn(p+a)-svn(p-a),svn(p+b)-svn(p-b),svn(p+c)-svn(p-c))/(2.0*e);}",
"vec4 svor(vec3 q){vec3 ip=floor(q),fp=fract(q),cv=vec3(0.0);float f1=8.0,f2=8.0,id=0.0;",
"  for(int k=-1;k<=1;k++)for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){vec3 g=vec3(float(i),float(j),float(k)),o=vec3(sh1(ip+g),sh1(ip+g+17.31),sh1(ip+g+41.17))*0.8+0.1,r=g+o-fp;float d=dot(r,r);",
"    if(d<f1){f2=f1;f1=d;cv=r;id=sh1(ip+g+5.0);}else if(d<f2){f2=d;}}",
"  return vec4(cv,clamp((sqrt(f2)-sqrt(f1))*6.0,0.0,1.0)+id*0.0001);}",
"vec3 sdG;float sdC;",
"void sDetail(vec3 p,vec4 A,vec4 B,vec3 nO,vec3 fl){sdG=vec3(0.0);sdC=1.0;",
"  if(A.x>0.01){vec3 t=fl-dot(fl,nO)*nO;t=length(t)>1e-4?normalize(t):normalize(cross(nO,vec3(0.0,1.0,0.0))+1e-4);vec3 s=cross(nO,t);",
"    vec3 q=p*1.7;q-=t*dot(q,t)*0.88;float r=1.0-abs(svn(q)*2.0-1.0),r2=1.0-abs(svn(q*2.3+7.7)*2.0-1.0),cl=svn(p*0.55+3.0);",
"    float aa=clamp(1.9-length(fwidth(q))*1.2,0.0,1.0),strand=mix(0.55,smoothstep(0.3,1.0,0.65*r+0.35*r2),aa);sdC*=mix(1.0,(0.5+0.75*strand)*(0.78+0.44*cl),A.x);",
"    vec3 e=s*0.05;float rp=1.0-abs(svn(q+e*1.7)*2.0-1.0),rm=1.0-abs(svn(q-e*1.7)*2.0-1.0);sdG+=A.x*aa*s*(rp-rm)*2.2;}","  if(A.y>0.01){vec3 q=p*1.15;vec4 v=svor(q);float id=sh1(floor(q+v.xyz+0.5));sdC*=mix(1.0,(0.42+0.58*smoothstep(0.0,0.35,v.w))*(0.82+0.36*id),A.y);sdG-=A.y*1.1*v.xyz*smoothstep(0.0,0.5,v.w);}",
"  if(A.z>0.01){vec3 q=vec3(p.x*0.8,p.y*2.8,p.z*0.8);float w=1.0-abs(svn(q)*2.0-1.0);sdC*=1.0-0.32*A.z*smoothstep(0.7,1.0,w);sdG+=A.z*0.5*sgr(q,0.05,1)*sign(0.5-svn(q));}",
"  if(A.w>0.01){vec3 q=p*0.4;sdC*=mix(1.0,0.68+0.6*sfb(q),A.w);sdG+=A.w*0.9*sgr(q,0.06,0);}",
"  if(B.x>0.01){vec3 q=vec3(p.x*2.5,p.y*0.12,p.z*2.5);float r=fract(length(p.xz)*0.18+svn(q)*1.2);sdC*=mix(1.0,0.72+0.28*smoothstep(0.0,0.35,r)*smoothstep(1.0,0.7,r)+0.12*(svn(q*vec3(3.0,1.0,3.0))-0.5),B.x);sdG+=B.x*0.2*sgr(q,0.08,1);}",
"  if(B.y>0.01){float a=sin(p.x*5.0+p.z*5.0),b=sin(p.y*5.0);sdC*=1.0-0.14*B.y*(0.5+0.5*a*b)-0.06*B.y*svn(p*3.0);sdG+=B.y*0.25*vec3(cos(p.x*5.0+p.z*5.0)*b,a*cos(p.y*5.0),cos(p.x*5.0+p.z*5.0)*b);}",
"  if(B.z>0.01){vec4 v=svor(p*0.35);sdG+=B.z*0.9*v.xyz;sdC*=1.0-0.06*B.z*(1.0-v.w);}",
"  if(B.w>0.01){sdG+=B.w*0.35*(vec3(svn(p*6.0),svn(p*6.0+9.1),svn(p*6.0+3.3))-0.5);sdC*=1.0-0.05*B.w*svn(p*3.0);}}"
].join(SG_NL);
// image textures on a sculpt (no UVs: triplanar from the rest position). Albedo is divided by its own average colour (its smallest
// mip level, read on the GPU), so it adds
// real photographic detail while the painted colours (markings, muzzle, metal vs leather) stay; normal + roughness maps add relief.
var SG_MAPS=[
"vec3 tpW(vec3 n){vec3 w=pow(abs(n),vec3(4.0));return w/(w.x+w.y+w.z);}",
"vec4 tpS(sampler2D t,vec3 p,vec3 w){return texture2D(t,p.zy)*w.x+texture2D(t,p.xz)*w.y+texture2D(t,p.xy)*w.z;}",
"vec3 tpN(sampler2D t,vec3 p,vec3 w){vec3 a=texture2D(t,p.zy).xyz*2.0-1.0,b=texture2D(t,p.xz).xyz*2.0-1.0,c=texture2D(t,p.xy).xyz*2.0-1.0;return vec3(0.0,a.y,a.x)*w.x+vec3(b.x,0.0,b.y)*w.y+vec3(c.x,c.y,0.0)*w.z;}"
].join(SG_NL);
var MP_ON={all:"1.0",fur:"vDtA.x",scales:"vDtA.y",wrinkles:"vDtA.z",rock:"vDtA.w",wood:"vDtB.x",cloth:"vDtB.y",hammered:"vDtB.z",pores:"vDtB.w"};
function sculptMaps(mp){
  var U={mpS:{value:1/(mp.scale||0.5)},mpStr:{value:mp.strength===undefined?1:mp.strength},mpMA:{value:0},mpMN:{value:0},mpMR:{value:0},mpA:{value:null},mpN:{value:null},mpR:{value:null}},mix=mp.mix===undefined?1:mp.mix;
  if(typeof document==="undefined")return{U:U,has:{}};
  var L=new T.TextureLoader(),has={};
  [["albedo","mpA","mpMA"],["normal","mpN","mpMN"],["rough","mpR","mpMR"]].forEach(function(k){
    var url=mp[k[0]];if(!url)return;has[k[0]]=1;
    var tx=L.load(url,function(){U[k[2]].value=mix},undefined,function(){});
    tx.wrapS=tx.wrapT=T.RepeatWrapping;tx.anisotropy=8;if(k[0]==="albedo")tx.colorSpace=T.SRGBColorSpace;U[k[1]].value=tx});
  return{U:U,has:has}}
var SG_PAINT=[
"uniform int pN;uniform vec4 pA[16];uniform vec4 pB[16];uniform vec4 pC[16];uniform vec4 pD[16];uniform vec4 pE[16];uniform mat3 pM[16];uniform vec2 pP[384];varying float vShd;",
"float gBox(vec3 p,vec3 b,float r){vec3 q=abs(p)-b+r;return length(max(q,0.0))+min(max(q.x,max(q.y,q.z)),0.0)-r;}",
"float gEll(vec3 p,vec3 r){if(abs(r.x-r.y)<1e-6&&abs(r.y-r.z)<1e-6)return length(p)-r.x;float k0=length(p/r),k1=length(p/(r*r));return k1<1e-9?-min(r.x,min(r.y,r.z)):k0*(k0-1.0)/k1;}",
"float gCone(vec3 p,vec3 a,vec3 b,float r1,float r2){vec3 ba=b-a;float l2=dot(ba,ba),rr=r1-r2,a2=l2-rr*rr,il2=1.0/l2;vec3 pa=p-a;float y=dot(pa,ba),z=y-l2;vec3 xv=pa*l2-ba*y;float x2=dot(xv,xv),y2=y*y*l2,z2=z*z*l2,k=sign(rr)*rr*rr*x2;",
"  if(sign(z)*a2*z2>k)return sqrt(x2+z2)*il2-r2;if(sign(y)*a2*y2<k)return sqrt(x2+y2)*il2-r1;return(sqrt(x2*a2*il2)+y*rr)*il2-r1;}",
"float gCyl(vec3 p,vec3 a,vec3 b,float r){vec3 ba=b-a,pa=p-a;float bb=dot(ba,ba),pb=dot(pa,ba),x=length(pa*bb-ba*pb)-r*bb,y=abs(pb-bb*0.5)-bb*0.5,d=(max(x,y)<0.0)?-min(x*x,y*y*bb):(((x>0.0)?x*x:0.0)+((y>0.0)?y*y*bb:0.0));return sign(d)*sqrt(abs(d))/bb;}",
"float gProf(vec3 q,int i){float ax=pC[i].z,U,V,W;if(ax>1.5){U=q.x;V=q.y;W=q.z;}else if(ax>0.5){U=q.x;V=q.z;W=q.y;}else{U=q.z;V=q.y;W=q.x;}",
"  int n=int(pE[i].x);float dd=1e18,sg=1.0;vec2 pt=vec2(U,V);",
"  for(int j=0;j<24;j++){if(j>=n)break;int jj=j==0?n-1:j-1;vec2 vi=pP[i*24+j],vj=pP[i*24+jj],e=vj-vi,w=pt-vi;float el=dot(e,e);vec2 bq=w-e*clamp(el>0.0?dot(w,e)/el:0.0,0.0,1.0);dd=min(dd,dot(bq,bq));",
"    bvec3 c=bvec3(pt.y>=vi.y,pt.y<vj.y,e.x*w.y>e.y*w.x);if(all(c)||all(not(c)))sg=-sg;}",
"  float rd=pB[i].w,d2=sg*sqrt(dd)+rd,hw=pC[i].x*(1.0-pC[i].y*clamp((V-pE[i].y)/pE[i].z,0.0,1.0)),dw=abs(W)-hw+rd;return length(max(vec2(d2,dw),0.0))+min(max(d2,dw),0.0)-rd;}",
"float gSd(vec3 p,int i){int k=int(pA[i].w+0.5);vec3 a=pA[i].xyz;if(k==2)return gCone(p,a,pC[i].xyz,pB[i].x,pE[i].w);if(k==3)return gCyl(p,a,pC[i].xyz,pB[i].x)-pB[i].w;",
"  vec3 q=pM[i]*(p-a);if(k==1)return gBox(q,pB[i].xyz,pB[i].w);if(k==4)return gProf(q,i);if(k==5){vec2 t=vec2(length(q.xz)-pB[i].x,q.y);return length(t)-pE[i].w;}return gEll(q,pB[i].xyz);}",
"void gPaint(inout vec3 col,vec3 p){for(int i=0;i<16;i++){if(i>=pN)break;float d=gSd(p,i),s=max(pD[i].w,fwidth(d)*1.5),t=clamp(1.0-d/s,0.0,1.0);t=t*t*(3.0-2.0*t);col=mix(col,pD[i].rgb*vShd,t);}}"
].join(SG_NL);
function paintUniforms(gp){
  var A=[],B=[],C=[],D=[],E=[],M=[],P=[],i,j;
  for(i=0;i<16;i++){var g=gp[i];
    if(!g){A.push(new T.Vector4());B.push(new T.Vector4());C.push(new T.Vector4());D.push(new T.Vector4());E.push(new T.Vector4());M.push(new T.Matrix3());continue}
    A.push(new T.Vector4(g.at[0],g.at[1],g.at[2],g.k));B.push(new T.Vector4(g.r[0],g.r[1],g.r[2],g.round));C.push(new T.Vector4(g.to[0],g.to[1],g.to[2],0));
    D.push(new T.Vector4(g.col[0],g.col[1],g.col[2],g.soft));E.push(new T.Vector4(g.e[0],g.e[1],g.e[2],g.e[3]));
    var m=g.m,mm=new T.Matrix3();if(m)mm.set(m[0],m[1],m[2],m[3],m[4],m[5],m[6],m[7],m[8]);M.push(mm)}
  for(i=0;i<16;i++)for(j=0;j<24;j++){var q=gp[i]&&gp[i].pts&&gp[i].pts[j];P.push(new T.Vector2(q?q[0]:0,q?q[1]:0))}
  return{pN:{value:Math.min(16,gp.length)},pA:{value:A},pB:{value:B},pC:{value:C},pD:{value:D},pE:{value:E},pM:{value:M},pP:{value:P}}}
function sculptMaterial(p,gm){
  var det=gm.userData.det||[],lo=!!p.low,fur=det[0],o={color:0xffffff,vertexColors:true,flatShading:lo,roughness:1,metalness:1};
  if(fur){o.sheen=0.4;o.sheenRoughness=0.75;o.sheenColor=new T.Color(0.22,0.2,0.18)}
  if(p.mat==="plastic"||p.mat==="glossy"){o.clearcoat=0.5;o.clearcoatRoughness=0.3}
  if(p.mat==="skin"){o.clearcoat=0.1;o.clearcoatRoughness=0.55}
  var m=new T.MeshPhysicalMaterial(o),useDet=det.some(function(x){return x}),ds=(90/Math.max(0.02,gm.userData.ext||1))*(p.grain||1),NL=SG_NL;
  var MP=p.maps?sculptMaps(p.maps):{U:{},has:{}},H=MP.has,MW=p.maps&&MP_ON[p.maps.on]||"1.0",useN=useDet||!!H.normal,GP=gm.userData.gp||[],PU=GP.length?paintUniforms(GP):null;
  var blobMats=(p.blobs||[]).map(function(b){return b.mat});
  if(p.mat==="paint"||blobMats.indexOf("paint")>=0){m.clearcoat=1;m.clearcoatRoughness=0.06}
  if(p.mat==="glass"){m.transparent=true;m.opacity=0.6;m.depthWrite=false;m.side=T.DoubleSide;m.envMapIntensity=2.4;m.clearcoat=1;m.clearcoatRoughness=0.02;m.specularIntensity=1}
  m.userData.maps=MP.U;
  m.onBeforeCompile=function(sh){
    sh.uniforms.sdS={value:ds};Object.keys(MP.U).forEach(function(k){sh.uniforms[k]=MP.U[k]});if(PU)Object.keys(PU).forEach(function(k){sh.uniforms[k]=PU[k]});
    sh.vertexShader=sh.vertexShader.replace("#include <common>","#include <common>"+NL+"attribute vec3 rme;attribute vec4 dtA;attribute vec4 dtB;attribute vec3 flow;attribute float shd;varying float vShd;varying vec3 vFlow;varying vec3 vRme;varying vec4 vDtA;varying vec4 vDtB;varying vec3 vRest;varying vec3 vObjN;varying vec3 vNM0;varying vec3 vNM1;varying vec3 vNM2;")
      .replace("#include <begin_vertex>","#include <begin_vertex>"+NL+"vRest=position;vShd=shd;vFlow=flow;vObjN=normal;vRme=rme;vDtA=dtA;vDtB=dtB;vNM0=normalMatrix*vec3(1.0,0.0,0.0);vNM1=normalMatrix*vec3(0.0,1.0,0.0);vNM2=normalMatrix*vec3(0.0,0.0,1.0);");
    var mapU=(H.albedo||H.normal||H.rough)?"uniform float mpS;uniform float mpStr;uniform float mpMA;uniform float mpMN;uniform float mpMR;uniform sampler2D mpA;uniform sampler2D mpN;uniform sampler2D mpR;"+NL+SG_MAPS:"";
    var mapC=H.albedo?NL+"{vec3 mw3=tpW(normalize(vObjN));vec3 ta=tpS(mpA,vRest*mpS,mw3).rgb,avg=textureLod(mpA,vec2(0.5),14.0).rgb;diffuseColor.rgb*=mix(vec3(1.0),clamp(ta/max(avg,vec3(0.02)),0.0,3.0),mpMA*"+MW+");}":"";
    var fs=sh.fragmentShader.replace("#include <common>","#include <common>"+NL+"uniform float sdS;varying vec3 vFlow;varying vec3 vRme;varying vec4 vDtA;varying vec4 vDtB;varying vec3 vRest;varying vec3 vObjN;varying vec3 vNM0;varying vec3 vNM1;varying vec3 vNM2;"+NL+SG_FN+NL+mapU+(PU?NL+SG_PAINT:""))
      .replace("#include <color_fragment>","#include <color_fragment>"+NL+(PU?"gPaint(diffuseColor.rgb,vRest);"+NL:"")+(useDet?"sDetail(vRest*sdS,vDtA,vDtB,normalize(vObjN),normalize(vFlow+vec3(1e-5)));diffuseColor.rgb*=sdC;":"sdG=vec3(0.0);sdC=1.0;")+mapC)
      .replace("#include <roughnessmap_fragment>","#include <roughnessmap_fragment>"+NL+"roughnessFactor=clamp(vRme.x*(1.0+0.25*(1.0-sdC)),0.04,1.0);"+(H.rough?NL+"roughnessFactor=mix(roughnessFactor,clamp(tpS(mpR,vRest*mpS,tpW(normalize(vObjN))).g,0.04,1.0),mpMR*"+MW+");":""))
      .replace("#include <metalnessmap_fragment>","#include <metalnessmap_fragment>"+NL+"metalnessFactor=vRme.y;")
      .replace("#include <emissivemap_fragment>","#include <emissivemap_fragment>"+NL+"totalEmissiveRadiance+=diffuseColor.rgb*vRme.z*1.6;");
    if(useN)fs=fs.replace("#include <normal_fragment_maps>","#include <normal_fragment_maps>"+NL+"{vec3 nO=normalize(vObjN);"+(H.normal?"sdG-=tpN(mpN,vRest*mpS,tpW(nO))*mpStr*mpMN*"+MW+"*2.4;":"")+"vec3 gT=sdG-dot(sdG,nO)*nO;normal=normalize(normal-(vNM0*gT.x+vNM1*gT.y+vNM2*gT.z)*0.35);}");
    if(fur)fs=fs.replace("#include <lights_physical_fragment>","#include <lights_physical_fragment>"+NL+"#ifdef USE_SHEEN"+NL+"material.sheenColor*=vDtA.x;"+NL+"#endif");
    sh.fragmentShader=fs};
  m.customProgramCacheKey=function(){return "sculpt"+(useDet?1:0)+(fur?1:0)+(H.albedo?"a":"")+(H.normal?"n":"")+(H.rough?"r":"")+MW+(PU?"p":"")};
  m.userData.sculpt=1;return m}
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
  if(s==="joint"||s==="gltf")return new T.BoxGeometry(0.001,0.001,0.001);
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
// keyframe easing (per track): smooth (default), linear, in, out, inout, back (anticipation overshoot), elastic, bounce
function rigEase(k,e){
  if(e==="linear")return k;if(e==="in")return k*k*k;if(e==="out")return 1-Math.pow(1-k,3);if(e==="inout")return k<0.5?4*k*k*k:1-Math.pow(-2*k+2,3)/2;
  if(e==="back"){var c1=1.70158,c3=c1+1;return 1+c3*Math.pow(k-1,3)+c1*Math.pow(k-1,2)}
  if(e==="elastic")return k===0||k===1?k:Math.pow(2,-10*k)*Math.sin((k*10-0.75)*2.0944)+1;
  if(e==="bounce"){var n1=7.5625,d1=2.75;if(k<1/d1)return n1*k*k;if(k<2/d1){k-=1.5/d1;return n1*k*k+0.75}if(k<2.5/d1){k-=2.25/d1;return n1*k*k+0.9375}k-=2.625/d1;return n1*k*k+0.984375}
  return k*k*(3-2*k)}
function rigSample(ks,t,c,ease){
  var dur=c.dur||1;t=c.loop?((t%dur)+dur)%dur:Math.max(0,Math.min(dur,t));
  if(ks.length===1||t<=ks[0][0])return ks[0][1];
  for(var i=1;i<ks.length;i++){if(t<=ks[i][0]){var a=ks[i-1],b=ks[i],k=rigEase((t-a[0])/Math.max(1e-6,b[0]-a[0]),ease);return[a[1][0]+(b[1][0]-a[1][0])*k,a[1][1]+(b[1][1]-a[1][1])*k,a[1][2]+(b[1][2]-a[1][2])*k]}}
  return ks[ks.length-1][1]}
// gait: a limb plants and pushes back for duty of the cycle (stance, linear), then lifts and swings forward (swing, eased);
// lift flexes a lower joint (knee, hock, paw) only during the swing - feet stay planted instead of skating on a sine
function rigGait(u,duty){u=u-Math.floor(u);if(u<duty)return -1+2*u/duty;var s=(u-duty)/(1-duty);return 1-2*s*s*(3-2*s)}
function rigLift(u,duty){u=u-Math.floor(u);if(u<duty)return 0;return Math.sin(Math.PI*(u-duty)/(1-duty))}
function rigApply(parts,nodes,c,t){
  var N=parts.length,i,rot=[],pos=[],sca=[];
  for(i=0;i<N;i++){rot[i]=[0,0,0];pos[i]=[0,0,0];sca[i]=[1,1,1]}
  (c.tracks||[]).forEach(function(tr){for(var i=0;i<N;i++){var m=rigMatch(parts,tr.part,i);if(!m)continue;var fl=m===2?-1:1;
    if(tr.rot){var v=rigSample(tr.rot,t,c,tr.ease);rot[i][0]+=v[0];rot[i][1]+=v[1]*fl;rot[i][2]+=v[2]*fl}
    if(tr.pos){var q=rigSample(tr.pos,t,c,tr.ease);pos[i][0]+=q[0]*fl;pos[i][1]+=q[1];pos[i][2]+=q[2]}
    if(tr.scale){var z=rigSample(tr.scale,t,c,tr.ease);sca[i][0]*=z[0];sca[i][1]*=z[1];sca[i][2]*=z[2]}}});
  (c.motion||[]).forEach(function(mo){for(var i=0;i<N;i++){var m=rigMatch(parts,mo.part,i);if(!m)continue;
    var gaitK=mo.kind==="step"||mo.kind==="lift",ph=mo.phase+(m===2&&mo.mirror&&(mo.kind==="swing"||gaitK)?Math.PI:0),a=2*Math.PI*mo.speed*t+ph,ax=mo.axis==="x"?0:mo.axis==="y"?1:2;
    if(mo.kind==="swing"||mo.kind==="wag")rot[i][ax]+=mo.amp*Math.sin(a);
    else if(mo.kind==="step")rot[i][ax]+=mo.amp*rigGait(a/(2*Math.PI),mo.duty||0.6);
    else if(mo.kind==="lift")rot[i][ax]+=mo.amp*rigLift(a/(2*Math.PI),mo.duty||0.6);
    else if(mo.kind==="spin")rot[i][ax]+=360*mo.speed*t;
    else if(mo.kind==="bob")pos[i][ax]+=mo.amp*Math.sin(a);
    else if(mo.kind==="pulse"){var s2=1+mo.amp*Math.sin(a);sca[i][0]*=s2;sca[i][1]*=s2;sca[i][2]*=s2}}});
  for(i=0;i<N;i++){var nd=nodes[i],rs=nd.userData.rest;nd.rotation.set(rot[i][0]*RAD,rot[i][1]*RAD,rot[i][2]*RAD);nd.position.set(rs.x+pos[i][0],rs.y+pos[i][1],rs.z+pos[i][2]);nd.scale.set(sca[i][0],sca[i][1],sca[i][2])}
}

// crossfade between clips: snapshot the joints when a new clip starts, then blend from it for fade seconds
function rigSnap(nodes){return nodes.map(function(nd){return{q:nd.quaternion.clone(),p:nd.position.clone(),s:nd.scale.clone()}})}
function rigBlend(nodes,snap,k){if(!snap||k>=1)return;k=k*k*(3-2*k);nodes.forEach(function(nd,i){var a=snap[i];if(!a)return;nd.quaternion.copy(a.q.clone().slerp(nd.quaternion,k));nd.position.lerpVectors(a.p,nd.position.clone(),k);nd.scale.lerpVectors(a.s,nd.scale.clone(),k)})}
// one part -> a Group (mesh [+ tube end caps] [+ edge lines]) already placed relative to its pivot. o.cache shares geometry/material across instances.
// imported real models (glTF / GLB): the consumer installs a loader (the studio: three's GLTFLoader; a game: its own or the runtime's)
var gltfLoad=null,gltfCache={};
function setGltfLoader(fn){gltfLoad=fn}
function loadGltf(src){if(!gltfLoad)return Promise.reject(new Error("no glTF loader"));return gltfCache[src]||(gltfCache[src]=gltfLoad(src))}
// a gltf part: the model is placed with its bottom centre at pos, scaled uniformly to height (metres) when given, times size
function gltfPart(p,o){
  var g=new T.Group(),holder=new T.Group(),m=new T.MeshStandardMaterial({visible:false}),mesh=new T.Mesh(new T.BufferGeometry(),m);mesh.visible=false;g.add(mesh);g.add(holder);
  var pv=p.pivot||p.pos;g.name=p.name;g.position.set(p.pos[0]-pv[0],p.pos[1]-pv[1],p.pos[2]-pv[2]);g.rotation.set(p.rot[0]*RAD,p.rot[1]*RAD,p.rot[2]*RAD);g.scale.set(p.size[0],p.size[1],p.size[2]);
  g.userData={base:[p.size[0],p.size[1],p.size[2]],y:p.pos[1]-pv[1],ed:null,mat:m,mesh:mesh,gltf:holder};
  if(p.src)loadGltf(p.src).then(function(sc){
    var obj=sc.clone(true),bb=new T.Box3().setFromObject(obj),sz=bb.getSize(new T.Vector3()),k=p.height?p.height/Math.max(1e-6,sz.y):1;
    obj.scale.multiplyScalar(k);obj.position.set(-(bb.min.x+bb.max.x)/2*k,-bb.min.y*k,-(bb.min.z+bb.max.z)/2*k);
    obj.traverse(function(q){if(q.isMesh){q.castShadow=true;q.receiveShadow=true}});holder.add(obj);
    if(o&&o.onLoad)o.onLoad(g,obj)},function(e){if(o&&o.onError)o.onError(p,e)});
  return g}
function buildPartObject(p,o){
  if(p.shape==="gltf")return gltfPart(p,o);
  o=o||{};var g=new T.Group(),c=o.cache,gm=c&&c.gm;
  if(!gm){gm=geo(p);if((p.facets||p.fcolors)&&!gm.userData.sculpt){if(gm.index)gm=gm.toNonIndexed();paint(gm,p)}if(c)c.gm=gm}
  var m=(c&&c.m)||(gm.userData.sculpt?sculptMaterial(p,gm):material(p));if(c)c.m=m;
  if(p.mat==="fur"&&!m.userData.fur&&!m.userData.sculpt){gm.computeBoundingBox();var bs=gm.boundingBox.getSize(new T.Vector3());furPatch(m,90/Math.max(0.02,bs.x,bs.y,bs.z),p.fuzz===undefined?0.5:p.fuzz);m.userData.fur=1}
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
