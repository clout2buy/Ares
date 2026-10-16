// The `story` explain block: a tiny live 2D pixel stage that plays an
// explanation out — people appear, buildings rise, armies march, walls fall,
// meters climb and drop — instead of describing it. The agent writes scenes of
// a few short actions (see forgeBlocks.sanitizeStory); this engine owns the
// sprites, staging and timing, so a whole "rise and fall of X" is a few
// hundred tokens and plays at once. Canvas 2D at 160x90 logical pixels,
// integer-snapped and scaled up crisp.
//
// Motion is slow and smooth: nothing blinks or strobes (photosensitive
// doctrine). Under prefers-reduced-motion the story does not autoplay and
// scenes land in their finished state when stepped.
//
// TypeScript template literal: NO backticks, NO dollar-brace, NO backslashes.

export const FORGE_STORY_JS = `
var reduced=!!(matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches);
var W=160,H=90,P=4,GY=66,ctx=null,T=0;
function mk(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function rng(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;var t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function hash(s){var h=7;for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;return h}
function R(dx,dy,w,h,col){ctx.fillStyle=col;ctx.fillRect(dx*P,dy*P,w*P,h*P)}
function circ(r,col,cy){for(var dy=-r;dy<=r;dy++){var hw=Math.floor(Math.sqrt(r*r-dy*dy+0.5));R(-hw,dy+(cy||0),2*hw+1,1,col)}}
function hx(c){return[parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)]}
function lerpHex(a,b,k){var x=hx(a),y=hx(b);return"rgb("+Math.round(x[0]+(y[0]-x[0])*k)+","+Math.round(x[1]+(y[1]-x[1])*k)+","+Math.round(x[2]+(y[2]-x[2])*k)+")"}
var BG={
  day:{sky:["#4a86e0","#5f9bec","#7fb2f5","#a9d0ff"],g:"#4a8f3a",tuft:"#3b7a2e",star:0},
  dawn:{sky:["#2b3a7a","#7a5aa8","#e08a6a","#ffd08a"],g:"#3f6b3a",tuft:"#325a2e",star:0.3},
  dusk:{sky:["#1b2a5e","#5a3a8a","#c8563f","#f0a32f"],g:"#3a5a35",tuft:"#2c4a2b",star:0.4},
  night:{sky:["#05081a","#0a1236","#10205a","#15347a"],g:"#16302a",tuft:"#0f241f",star:1},
  desert:{sky:["#6fa8e8","#8ec0f0","#c8dcf0","#f0e0b0"],g:"#d9b36a",tuft:"#c49a4e",star:0},
  sea:{sky:["#4a86e0","#5f9bec","#7fb2f5","#a9d0ff"],g:"#2f6df0",tuft:"#9cc5ff",star:0},
  storm:{sky:["#222a3a","#2f3a52","#3c4a68","#4a5a7c"],g:"#2d3b2a",tuft:"#222f20",star:0},
  snow:{sky:["#8aa0c8","#a0b4d8","#b8c8e8","#d4e0f4"],g:"#e8f0ff",tuft:"#c8d8f0",star:0}
};
var HT={person:10,soldier:13,house:13,temple:22,column:19,tower:25,wall:12,castle:24,tree:13,ship:15,horse:13,flag:14,mountain:22,sun:7,moon:6,cloud:5,coin:6,fire:6,arrow:3,pyramid:18,scroll:7,crown:7,sword:10,label:6};
var RISE={house:1,temple:1,column:1,tower:1,wall:1,castle:1,tree:1,pyramid:1,mountain:1};
var BODY={person:1,soldier:1,horse:1};
var DEFY={sun:14,moon:14,cloud:12,mountain:66,label:20};
var TUNIC=["#c8563f","#2f6df0","#f0a32f","#4a9a3a","#8a5ad0","#e8e2d0"];
var SP={
  person:function(c,t,e){var b=e.walk?Math.floor(t*4)%2:0;R(-1,-3,1,3,"#2a2f45");R(1,-3,1,b?2:3,"#2a2f45");R(-1,-7,3,4,c);R(-2,-7,1,3,"#e8b48a");R(2,-7,1,3,"#e8b48a");R(-1,-10,3,3,"#e8b48a");R(-1,-10,3,1,"#3a2a22")},
  soldier:function(c,t,e){SP.person(c,t,e);R(-3,-7,2,4,"#f0a32f");R(3,-14,1,14,"#cfd6e6");R(3,-15,1,1,"#ffffff");R(-1,-11,3,1,"#8a8f9c")},
  house:function(c){c=c||"#d9b38c";R(-6,-8,12,8,c);for(var i=0;i<5;i++)R(-7+i,-13+i,14-2*i,1,"#b5442f");R(-1,-4,3,4,"#3a2a22");R(-5,-6,2,2,"#9cc5ff")},
  temple:function(){R(-12,-2,24,2,"#e8e2d0");for(var i=0;i<5;i++)R(-10+i*5,-14,2,12,"#f4efe0");R(-12,-17,24,3,"#e8e2d0");for(var j=0;j<5;j++)R(-12+j*2,-22+j,24-4*j,1,"#f4efe0")},
  column:function(){R(-3,-3,6,3,"#e8e2d0");R(-2,-17,4,14,"#f4efe0");R(-3,-19,6,2,"#e8e2d0")},
  tower:function(c){c=c||"#8a8f9c";R(-5,-22,10,22,c);R(-5,-25,3,3,c);R(-1,-25,3,3,c);R(3,-25,3,3,c);R(-1,-15,2,5,"#2a2f45");R(-5,-8,10,1,"#6f7482")},
  wall:function(c){c=c||"#8a8f9c";R(-12,-9,24,9,c);R(-12,-5,24,1,"#6f7482");for(var i=0;i<4;i++)R(-12+i*7,-12,4,3,c)},
  castle:function(c){c=c||"#8a8f9c";R(-14,-14,28,14,c);R(-16,-24,7,24,c);R(9,-24,7,24,c);for(var i=0;i<4;i++)R(-12+i*7,-17,4,3,c);R(-16,-27,3,3,c);R(-12,-27,3,3,c);R(9,-27,3,3,c);R(13,-27,3,3,c);R(-3,-8,6,8,"#2a2f45");R(-1,-20,2,4,"#2a2f45")},
  tree:function(c){R(-1,-5,2,5,"#7a4a2b");R(-4,-11,8,6,c||"#4a9a3a");R(-3,-13,6,2,c||"#4a9a3a")},
  ship:function(c,t){var b=Math.round(Math.sin(t*1.4));R(-9,-3+b,18,2,"#7a4a2b");R(-7,-1+b,14,2,"#5a3820");R(0,-15+b,1,12,"#4a3220");R(1,-14+b,8,9,"#f4efe0");R(-6,-12+b,6,6,"#e8e2d0");R(1,-15+b,3,1,c||"#c8453a")},
  horse:function(c){c=c||"#7a4a2b";R(-6,-9,11,4,c);R(-6,-5,1,5,"#3a2a22");R(-3,-5,1,5,"#3a2a22");R(2,-5,1,5,"#3a2a22");R(4,-5,1,5,"#3a2a22");R(4,-13,3,6,c);R(6,-13,4,3,c);R(3,-13,1,5,"#3a2a22");R(-8,-9,2,5,"#3a2a22")},
  flag:function(c,t){R(0,-14,1,14,"#cfd6e6");for(var i=0;i<8;i++)R(1+i,-14+Math.round(Math.sin(t*2+i*0.7)),1,5,c||"#c8453a")},
  mountain:function(c){for(var i=0;i<22;i++){R(-i,-22+i,2*i+1,1,i<5?"#f4f8ff":(c||"#6b7a99"));if(i>=5)R(1,-22+i,i,1,"#56658a")}},
  sun:function(){circ(7,"#f0a32f");circ(5,"#ffd36a")},
  moon:function(){circ(6,"#dfe7ff");circ(4,"#f4f8ff")},
  cloud:function(c){c=c||"#e6efff";R(-8,-2,16,3,c);R(-5,-5,9,3,c);R(2,-4,6,3,c)},
  coin:function(c){circ(3,"#c98a1f",-3);circ(2,c||"#ffd36a",-3)},
  fire:function(c,t){for(var i=-2;i<=2;i++){var h=3+Math.round(2+2*Math.sin(t*2.3+i*1.7));R(i*2-1,-h,2,h,i%2?"#ffd36a":"#ff8a3a")}R(-5,-1,10,1,"#3a2a22")},
  arrow:function(c){c=c||"#f0a32f";R(-8,-1,12,2,c);R(4,-3,1,6,c);R(5,-2,1,4,c);R(6,-1,1,2,c)},
  pyramid:function(){for(var i=0;i<18;i++){R(-i,-18+i,2*i+1,1,"#e0b85a");R(1,-18+i,i,1,"#c49a4e")}},
  scroll:function(){R(-4,-6,8,6,"#f4efe0");R(-5,-7,10,1,"#c49a4e");R(-3,-5,6,1,"#9a8a6a");R(-3,-3,4,1,"#9a8a6a")},
  crown:function(c){c=c||"#f0a32f";R(-4,-4,8,3,c);R(-4,-6,2,2,c);R(-1,-7,2,3,c);R(2,-6,2,2,c);R(-3,-3,1,1,"#c8453a")},
  sword:function(){R(0,-10,1,8,"#cfd6e6");R(-2,-3,5,1,"#f0a32f");R(0,-2,1,2,"#7a4a2b")},
  label:function(c,t,e){ctx.font="bold "+(P*3)+"px monospace";ctx.textAlign="center";ctx.fillStyle="#070a13";ctx.fillText(e.text||"",P,P*-1+P);ctx.fillStyle=c||"#ffd36a";ctx.fillText(e.text||"",0,-P*0.3)}
};
function rubble(){R(-6,-2,12,2,"#6f7482");R(-4,-4,5,2,"#8a8f9c");R(2,-3,4,1,"#59606e")}
function autoColor(sp,r){if(sp==="person")return TUNIC[Math.floor(r()*TUNIC.length)];if(sp==="soldier")return"#b5282f";if(sp==="label")return"#ffd36a";return undefined}

function build(el){
  var spec={};try{spec=JSON.parse(el.getAttribute("data-spec")||"{}")}catch(e){}
  var scenes=spec.scenes||[],NS=scenes.length,live=!!spec.live,inst=!!window.__aresInstant,still=reduced||inst;
  var head=mk("div","k-sim-head"),stage=mk("div","k-stage"),cap=mk("div","k-cap"),panel=mk("div","k-panel");
  var tag=mk("span","k-sim-tag","story · "+NS+" scenes");head.appendChild(tag);
  var bar=mk("span","k-sim-btns"),bPrev=mk("button","k-btn","prev"),bPlay=mk("button","k-btn",reduced?"next":"pause"),bNext=mk("button","k-btn","next");
  [bPrev,bPlay].concat(reduced?[]:[bNext]).forEach(function(b){b.type="button";bar.appendChild(b)});head.appendChild(bar);
  var capT=mk("b","k-cap-n",""),capX=mk("span","k-cap-x","");cap.appendChild(capT);cap.appendChild(capX);
  var chips=mk("div","k-chips");panel.appendChild(chips);
  var srow=mk("label","k-slider"),sOut=mk("b","","1"),sIn=document.createElement("input");sIn.type="range";sIn.min="0.4";sIn.max="3";sIn.step="0.1";sIn.value="1";
  srow.appendChild(mk("span","","Playback speed"));srow.appendChild(sOut);srow.appendChild(sIn);if(!reduced)panel.appendChild(srow);
  el.appendChild(head);el.appendChild(stage);el.appendChild(cap);el.appendChild(panel);
  if(spec.title)el.appendChild(mk("p","k-sim-cap",spec.title));
  if(!NS&&!live){stage.appendChild(mk("p","k-sim-cap","no scenes"));return}
  var cv=document.createElement("canvas");cv.width=W*P;cv.height=H*P;stage.appendChild(cv);ctx=cv.getContext("2d");
  var speed=1,playing=!reduced,idx=-1,sceneT0=0,sceneDur=3,ents=[],groups={},meters={},bgFrom="day",bgTo="day",bgT0=-99,cnt=0,last=0,finished=false;
  sIn.addEventListener("input",function(){speed=+sIn.value;sOut.textContent=String(speed)});
  var chipEls=[];function addChip(s,i){var b=mk("button","k-btn k-chip",s.t||String(i+1));b.type="button";b.addEventListener("click",function(){jump(i,true)});chips.appendChild(b);chipEls.push(b)}
  scenes.forEach(addChip);

  function resetWorld(){ents=[];groups={};meters={};bgFrom=bgTo=(scenes[0]&&scenes[0].bg)||"day";bgT0=-99;cnt=0}
  function members(id){return groups[id]||[]}
  function doOp(o,st){
    var list,i,e;
    if(o.op==="spawn"){
      var n=o.n||1,id=o.id||(o.sprite+(++cnt)),at=o.at||[80,DEFY[o.sprite]||74],sp=o.spread||(n>1?[40,12]:[0,0]),r=rng(hash(id));list=groups[id]=groups[id]||[];
      for(i=0;i<n;i++){e={id:id,sp:o.sprite,x:at[0]+(r()-0.5)*sp[0],y:at[1]+(r()-0.5)*sp[1],c:o.color||autoColor(o.sprite,r),s:o.scale||1,flip:!!o.flip,text:o.text,born:st+i*0.07,ph:r()*5,mv:null,fall:null,fade:null,rise:!!RISE[o.sprite]};if(ents.length<400){ents.push(e);list.push(e)}}
      return st+n*0.07+0.9}
    if(o.op==="move"){
      list=members(o.id);if(!list.length)return st;var cx=0,cy=0;list.forEach(function(m){cx+=m.x;cy+=m.y});cx/=list.length;cy/=list.length;
      list.forEach(function(m,k){var x1=o.to[0]+(m.x-cx),y1=o.to[1]+(m.y-cy);m.mv={x0:m.x,y0:m.y,x1:x1,y1:y1,t0:st+k*0.04,d:o.dur||1.8};if(Math.abs(x1-m.x)>1)m.flip=x1<m.x;m.x=x1;m.y=y1});
      return st+(o.dur||1.8)+list.length*0.04}
    if(o.op==="fall"){list=members(o.id);list.forEach(function(m,k){m.fall=st+k*0.08;m.fdir=k%2?1:-1});return st+0.9+list.length*0.08}
    if(o.op==="fade"){list=members(o.id);list.forEach(function(m,k){m.fade={t0:st+k*0.04,d:1}});return st+1+list.length*0.04}
    if(o.op==="tint"){members(o.id).forEach(function(m){m.c=o.color});return st}
    if(o.op==="clear"){ents.forEach(function(m){if(!m.fade)m.fade={t0:st,d:0.8}});return st+0.9}
    if(o.op==="meter"){var mt=meters[o.id];meters[o.id]={label:o.label,value:o.value,color:o.color,shown:mt?mt.shown:(st<T-10?o.value:0),order:mt?mt.order:Object.keys(meters).length};return st+0.8}
    return st}
  function applyScene(sc,t0){
    var end=t0;if(sc.bg&&sc.bg!==bgTo){bgFrom=bgTo;bgTo=sc.bg;bgT0=t0}
    (sc.do||[]).forEach(function(o,j){var x=doOp(o,t0+j*0.2);if(x>end)end=x});return end}
  function ui(){
    var s=scenes[idx];if(!s)return;capT.textContent=s.t||"";capX.textContent=s.say||"";
    chipEls.forEach(function(b,i){b.classList.toggle("on",i===idx)});
    bPlay.textContent=reduced?"next":(finished?"replay":playing?"pause":"play");bPrev.disabled=idx<=0;bNext.disabled=idx>=NS-1}
  function enter(i){
    idx=i;sceneT0=T;var end=applyScene(scenes[i],still?T-60:T);
    sceneDur=Math.max(2.4,(scenes[i].say||"").length*0.04+1.2,end-T+0.7);finished=false;ui()}
  function jump(i,keep){
    resetWorld();T=1000;for(var k=0;k<i;k++)applyScene(scenes[k],T-60);
    Object.keys(meters).forEach(function(m){meters[m].shown=meters[m].value});
    enter(i);if(keep&&!reduced)playing=true;if(reduced)draw()}
  bPrev.addEventListener("click",function(){jump(Math.max(0,idx-1),false)});
  bNext.addEventListener("click",function(){if(idx<NS-1){reduced?jump(idx+1,false):enter(idx+1)}});
  bPlay.addEventListener("click",function(){
    if(reduced){if(idx<NS-1)jump(idx+1,false);return}
    if(finished){jump(0,true);return}playing=!playing;ui()});
  function ent(e){
    if(T<e.born)return;var age=T-e.born,x=e.x,y=e.y,alpha=1,moving=false,mv=e.mv;
    if(mv){var k=Math.min(1,Math.max(0,(T-mv.t0)/mv.d));k=k*k*(3-2*k);x=mv.x0+(mv.x1-mv.x0)*k;y=mv.y0+(mv.y1-mv.y0)*k;moving=T>=mv.t0&&T<mv.t0+mv.d}
    if(e.sp==="cloud"&&!mv)x=((e.x+T*0.8+30)%220)-30;
    if(e.fade){var f=(T-e.fade.t0)/e.fade.d;if(f>=1)return;if(f>0)alpha=1-f}
    var ht=HT[e.sp]||10,sc=1,rot=0,dy=0,body=!!BODY[e.sp],ground=!!e.rise||(!body&&e.sp!=="label"&&e.fall!=null&&T>=e.fall),dust=0;
    if(e.rise){var pr=Math.min(1,age/0.9);pr=1-Math.pow(1-pr,3);dy=(1-pr)*ht}
    else{var pk=Math.min(1,age/0.35);sc=pk<1?1+2.70158*Math.pow(pk-1,3)+1.70158*Math.pow(pk-1,2):1}
    var fallen=false;
    if(e.fall!=null&&T>=e.fall){var p=Math.min(1,(T-e.fall)/0.9);if(body){rot=p*1.45*e.fdir;alpha*=1-0.4*p}else{dy=p*ht*0.8;ground=true;if(p>=1)fallen=true}dust=1-p}
    if(body&&!moving&&e.fall==null)dy-=Math.floor(T*1.1+e.ph)%2;
    ctx.save();ctx.globalAlpha=alpha;ctx.translate(Math.round(x)*P,Math.round(y)*P);
    if(ground){ctx.beginPath();ctx.rect(-400,-800,800,800);ctx.clip()}
    ctx.translate(0,Math.round(dy)*P);var s=e.s*sc;ctx.scale((e.flip?-1:1)*s,s);if(rot)ctx.rotate(rot);
    e.walk=moving;if(fallen)rubble();else SP[e.sp](e.c,T,e);
    ctx.restore();
    if(dust>0&&dust<1){ctx.save();ctx.globalAlpha=dust*0.6;ctx.translate(Math.round(x)*P,Math.round(y)*P);for(var q=0;q<5;q++)R((q-2)*4,-(1-dust)*9-q,2,2,"#c8c8c8");ctx.restore()}
  }
  function draw(){
    var bk=Math.min(1,Math.max(0,(T-bgT0)/1.2)),A=BG[bgFrom]||BG.day,B=BG[bgTo]||BG.day,i;
    for(i=0;i<4;i++){ctx.fillStyle=lerpHex(A.sky[i],B.sky[i],bk);ctx.fillRect(0,Math.round(GY/4*i)*P,W*P,Math.ceil(GY/4+1)*P)}
    var star=(A.star+(B.star-A.star)*bk),r=rng(7);
    if(star>0.02){ctx.fillStyle="#9cc5ff";ctx.globalAlpha=star*0.8;for(i=0;i<34;i++)ctx.fillRect(Math.floor(r()*W)*P,Math.floor(r()*(GY-8))*P,P,P);ctx.globalAlpha=1}
    ctx.fillStyle=lerpHex(A.g,B.g,bk);ctx.fillRect(0,GY*P,W*P,(H-GY)*P);
    r=rng(3);ctx.fillStyle=lerpHex(A.tuft,B.tuft,bk);var sea=bgTo==="sea";
    for(i=0;i<90;i++){var tx=Math.floor(r()*W),ty=GY+1+Math.floor(r()*(H-GY-2));if(sea)tx+=Math.round(Math.sin(T*0.6+i)*2);ctx.fillRect(tx*P,ty*P,(sea?3:2)*P,P)}
    ents.slice().sort(function(a,b){return a.y-b.y}).forEach(ent);
    ctx.textAlign="left";ctx.font="bold "+(P*2.6)+"px monospace";
    Object.keys(meters).forEach(function(id){var m=meters[id];m.shown+=(m.value-m.shown)*0.06;var y=3+m.order*9;
      ctx.fillStyle="rgba(7,10,19,.7)";ctx.fillRect(2*P,y*P,50*P,8*P);ctx.fillStyle="#9cc5ff";ctx.fillText(m.label.toUpperCase(),3*P,(y+3)*P);
      ctx.fillStyle="#15347a";ctx.fillRect(3*P,(y+4)*P,46*P,3*P);ctx.fillStyle=m.color;ctx.fillRect(4*P,(y+5)*P,Math.round(44*m.shown/100)*P,P)});
    var s=scenes[idx];if(s&&s.t){ctx.textAlign="right";ctx.font="bold "+(P*4.2)+"px monospace";ctx.globalAlpha=Math.min(1,(T-sceneT0)/0.6);ctx.fillStyle="rgba(7,10,19,.55)";ctx.fillText(s.t,(W-3)*P+P/2,11*P+P/2);ctx.fillStyle="#ffd36a";ctx.fillText(s.t,(W-3)*P,11*P);ctx.globalAlpha=1}
  }
  if(!NS)capX.textContent="waiting for the first scene";
  el.__live={
    addScene:function(sc){scenes.push(sc);NS=scenes.length;tag.textContent="story · "+NS+" scenes";addChip(sc,NS-1);if(reduced)jump(NS-1,false);else if(idx<0){jump(0,false);playing=true}else ui()},
    finish:function(){live=false;ui()}
  };
  if(NS){jump(inst?NS-1:0,false);if(inst){playing=false;finished=true;ui()}}
  draw();
  if(!reduced){last=performance.now();(function loop(now){var dt=Math.min(0.05,(now-last)/1000)*speed;last=now;
    if(playing){T+=dt;if(idx>=0&&T>=sceneT0+sceneDur){if(idx<NS-1)enter(idx+1);else if(!live){playing=false;finished=true;ui()}}}
    draw();requestAnimationFrame(loop)})(last)}
}
window.__aresBuild=window.__aresBuild||{};window.__aresBuild.tale=build;
if(window.__aresDrain)window.__aresDrain();
document.querySelectorAll(".k-tale").forEach(function(el){try{build(el)}catch(e){el.textContent="story view unavailable: "+e.message}});
`.trim();
