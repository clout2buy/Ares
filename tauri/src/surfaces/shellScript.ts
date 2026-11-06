// A Shell script swapped live. The page used to reload for every change, because
// a running script could not be undone: everyone landed on the splash, and an
// agent checking its work saw its own chat vanish. So a script now runs with
// tracked versions of what it would otherwise leave behind. Replacing it stops
// the old one first, with nothing reloaded.
//
// Tracked: MutationObserver, setInterval, setTimeout, addEventListener and
// elements from document.createElement. For anything else the script returns a
// function that undoes it.

export function wrapShellScript(script: string): string {
  return `window.__aresShellFault=null;try{(function(){
var stop=window.__aresShellStop;
window.__aresShellStop=null;
if(stop){try{stop()}catch(e){console.error("[shell script]",e)}}
var observers=[],timers=[],listeners=[],made=[],undo=null;
window.__aresShellStop=function(){
  observers.forEach(function(o){o.disconnect()});
  timers.forEach(function(t){clearTimeout(t);clearInterval(t)});
  listeners.forEach(function(l){removeEventListener(l[0],l[1],l[2])});
  made.forEach(function(n){n.remove()});
  if(typeof undo==="function")undo();
};
function Observer(cb){var o=new window.MutationObserver(cb);observers.push(o);return o}
function every(f,ms){var t=setInterval(f,ms);timers.push(t);return t}
function later(f,ms){var t=setTimeout(f,ms);timers.push(t);return t}
function listen(a,b,c){listeners.push([a,b,c]);addEventListener(a,b,c)}
var doc=new Proxy(document,{get:function(t,k){
  if(k==="createElement")return function(a,b){var n=t.createElement(a,b);made.push(n);return n};
  var v=t[k];return typeof v==="function"?v.bind(t):v;
}});
undo=(function(MutationObserver,setInterval,setTimeout,addEventListener,document){${script}
})(Observer,every,later,listen,doc);
})()}catch(e){console.error("[shell script]",e);window.__aresShellFault=String(e&&e.stack||e)}`;
}
