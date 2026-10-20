// The page driver: runs INSIDE a page Ares serves (injected with the Forge
// sensor), so Ares works on the very page the owner is looking at — the
// Forge's frame in the browser preview, an "Open separate copy" tab, any
// window — instead of a hidden copy streamed as screenshots (owner,
// 2026-10-20: "it needs to not do it inside its own hidden browser").
//
// It long-polls its own server for commands (/__ares/drive) and posts the
// result back. Plain ES5-ish, no dependencies, never throws into the page.
// Input is synthesized DOM events: what a page's own listeners see, which is
// what games and apps react to (pointer lock and other trusted-only browser
// features are the exception, and the result says so).

export const DRIVE_PATH = "/__ares/drive";

export const PAGE_DRIVER_SOURCE = `(function(){
  if (window.__aresPageDriver || !window.fetch) return; window.__aresPageDriver = 1;
  // ── step mode: time stands still while the agent thinks ──────────────────
  // An agent takes seconds per decision; a real-time game kept running
  // between its calls and killed it mid-thought. __aresFreeze(true) parks
  // requestAnimationFrame and stops the page's clocks between commands; each
  // command runs in real time. The owner's own input, or two idle minutes
  // (the agent's turn ended), releases it.
  var origRaf = window.requestAnimationFrame.bind(window), origNow = performance.now.bind(performance), origDateNow = Date.now;
  var stepMode = false, frozen = false, frozenAt = 0, lag = 0, parked = [], releaseTimer = null;
  window.requestAnimationFrame = function(cb){ if (frozen) { parked.push(cb); return 0; } return origRaf(function(t){ cb(t - lag); }); };
  performance.now = function(){ return (frozen ? frozenAt : origNow()) - lag; };
  Date.now = function(){ return origDateNow() - lag - (frozen ? origNow() - frozenAt : 0); };
  function freeze(){
    if (frozen) return; frozen = true; frozenAt = origNow();
    clearTimeout(releaseTimer); releaseTimer = setTimeout(function(){ stepMode = false; thaw(); }, 120000);
  }
  function thaw(){
    clearTimeout(releaseTimer);
    if (!frozen) return; lag += origNow() - frozenAt; frozen = false;
    var q = parked; parked = []; q.forEach(function(cb){ window.requestAnimationFrame(cb); });
  }
  window.__aresFreeze = function(on){ stepMode = !!on; if (!stepMode) thaw(); return stepMode; };
  ["keydown", "mousedown", "pointerdown", "wheel"].forEach(function(t){
    window.addEventListener(t, function(e){ if (e.isTrusted && stepMode) { stepMode = false; thaw(); } }, true);
  });
  var pid = "p" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  var logs = [], mouse = { x: 0, y: 0, known: false }, held = {};
  function keep(level, args){
    try {
      var text = Array.prototype.map.call(args, function(a){ return a instanceof Error ? (a.stack || a.message) : (typeof a === "object" ? JSON.stringify(a) : String(a)); }).join(" ");
      logs.push({ level: level, text: text.length > 600 ? text.slice(0, 600) + "…" : text, at: new Date().toISOString() });
      if (logs.length > 200) logs.splice(0, logs.length - 200);
    } catch (e) {}
  }
  ["log", "info", "warn", "error"].forEach(function(level){
    var orig = console[level];
    console[level] = function(){ keep(level, arguments); return orig.apply(console, arguments); };
  });
  window.addEventListener("error", function(ev){ if (ev && ev.message) keep("error", [ev.message]); });
  window.addEventListener("unhandledrejection", function(ev){ var r = ev && ev.reason; keep("error", ["unhandled rejection: " + (r && r.message ? r.message : r)]); });

  var TAP_MS = 60;
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  function visible(el){
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  }
  function textOf(el){ return String(el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title")) || el.innerText || el.value || el.textContent || "").replace(/\\s+/g, " ").trim(); }
  var ROLE_TAGS = { button: "button,[role=button],input[type=button],input[type=submit]", link: "a[href],[role=link]", textbox: "input:not([type]),input[type=text],input[type=email],input[type=search],input[type=password],input[type=number],textarea,[role=textbox],[contenteditable=true]", checkbox: "input[type=checkbox],[role=checkbox]", tab: "[role=tab]", menuitem: "[role=menuitem]", option: "option,[role=option]", heading: "h1,h2,h3,h4,h5,h6,[role=heading]", combobox: "select,[role=combobox]" };
  function roleOf(el){
    var r = el.getAttribute("role"); if (r) return r;
    for (var k in ROLE_TAGS) { try { if (el.matches(ROLE_TAGS[k])) return k; } catch (e) {} }
    return el.tagName.toLowerCase();
  }
  function findText(q){
    try { var bySel = document.querySelector(q); if (bySel && visible(bySel)) return bySel; } catch (e) {}
    var want = String(q).toLowerCase(), best = null, bestLen = 1e9;
    var all = document.querySelectorAll("button,a,[role],input,label,summary,li,span,div,p,h1,h2,h3,h4,td");
    for (var i = 0; i < all.length; i++) {
      var el = all[i]; if (!visible(el)) continue;
      var t = textOf(el).toLowerCase();
      if (t && t.indexOf(want) !== -1 && t.length < bestLen) { best = el; bestLen = t.length; }
    }
    return best;
  }
  function findRole(role, name){
    var sel = ROLE_TAGS[role] || "[role=" + role + "]", list = document.querySelectorAll(sel), want = String(name || "").toLowerCase(), loose = null;
    for (var i = 0; i < list.length; i++) {
      var el = list[i]; if (!visible(el)) continue;
      var t = textOf(el).toLowerCase();
      if (!want || t === want) return el;
      if (!loose && t.indexOf(want) !== -1) loose = el;
    }
    return loose;
  }
  function findField(label){
    try { var bySel = document.querySelector(label); if (bySel) return bySel; } catch (e) {}
    var want = String(label).toLowerCase(), labels = document.querySelectorAll("label");
    for (var i = 0; i < labels.length; i++) {
      if (textOf(labels[i]).toLowerCase().indexOf(want) === -1) continue;
      if (labels[i].control) return labels[i].control;
      var inner = labels[i].querySelector("input,textarea,select"); if (inner) return inner;
    }
    var fields = document.querySelectorAll("input,textarea,select,[contenteditable=true]");
    for (var j = 0; j < fields.length; j++) {
      var f = fields[j], hint = (f.getAttribute("aria-label") || f.getAttribute("placeholder") || f.getAttribute("name") || f.id || "").toLowerCase();
      if (hint && hint.indexOf(want) !== -1) return f;
    }
    return null;
  }
  function setValue(el, value){
    el.focus && el.focus();
    if (el.isContentEditable) { el.textContent = value; }
    else {
      var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // movementX/Y is what mouse-look games read. Only a MOVE carries it (the
  // same delta on pointermove AND mousemove); a click "teleports" with zero
  // movement. The cursor's first position is unknown, so the first move is a
  // teleport too — otherwise the first gesture reported a jump from (0,0) and
  // flipped a game camera.
  function mouseAt(type, x, y, extra){
    var el = document.elementFromPoint(x, y) || document.body;
    var mv = (extra && extra.mv) || [0, 0];
    var init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: (extra && extra.button) || 0, buttons: /down$/.test(type) || (extra && extra.held) ? 1 : 0, movementX: mv[0], movementY: mv[1] };
    if (type.indexOf("pointer") === 0) { init.pointerId = 1; init.pointerType = "mouse"; init.isPrimary = true; el.dispatchEvent(new PointerEvent(type, init)); }
    else if (type === "wheel") { init.deltaX = (extra && extra.dx) || 0; init.deltaY = (extra && extra.dy) || 0; el.dispatchEvent(new WheelEvent("wheel", init)); }
    else el.dispatchEvent(new MouseEvent(type, init));
    mouse = { x: x, y: y, known: true };
    return el;
  }
  function moveTo(x, y, extra){
    // Whole pixels: movementX/Y are integers in the browser, so a fractional
    // step (a short drag split 12 ways) truncated to 0 and the drag vanished.
    // Rounded positions keep every step's delta whole and the sum exact.
    x = Math.round(x); y = Math.round(y);
    var mv = mouse.known ? [x - mouse.x, y - mouse.y] : [0, 0];
    var o = { button: extra && extra.button, held: extra && extra.held, mv: mv };
    mouseAt("pointermove", x, y, o); mouseAt("mousemove", x, y, o);
  }
  function teleport(x, y){ x = Math.round(x); y = Math.round(y); mouseAt("pointermove", x, y); mouseAt("mousemove", x, y); }
  async function clickEl(el){
    if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
    var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    teleport(x, y);
    mouseAt("pointerdown", x, y); mouseAt("mousedown", x, y);
    if (el.focus) el.focus();
    mouseAt("pointerup", x, y); mouseAt("mouseup", x, y);
    if (el.click) el.click(); else mouseAt("click", x, y);
  }
  async function pointer(g){
    var b = g.button === "right" ? 2 : g.button === "middle" ? 1 : 0, opt = { button: b };
    if (g.kind === "move") { moveTo(g.x, g.y); return; }
    if (g.kind === "wheel") { mouseAt("wheel", g.x, g.y, { dx: g.dx, dy: g.dy }); window.scrollBy(g.dx || 0, g.dy || 0); return; }
    if (g.kind === "down") { mouseAt("pointerdown", g.x, g.y, opt); mouseAt("mousedown", g.x, g.y, opt); return; }
    if (g.kind === "up") { mouseAt("pointerup", g.x, g.y, opt); mouseAt("mouseup", g.x, g.y, opt); return; }
    if (g.kind === "drag") {
      teleport(g.x, g.y);
      mouseAt("pointerdown", g.x, g.y, opt); mouseAt("mousedown", g.x, g.y, opt);
      var steps = 12, tx = g.toX == null ? g.x : g.toX, ty = g.toY == null ? g.y : g.toY;
      for (var i = 1; i <= steps; i++) { var x = g.x + (tx - g.x) * i / steps, y = g.y + (ty - g.y) * i / steps; moveTo(x, y, { button: b, held: true }); await sleep(16); }
      mouseAt("pointerup", tx, ty, opt); mouseAt("mouseup", tx, ty, opt); return;
    }
    var times = g.kind === "double" ? 2 : 1;
    teleport(g.x, g.y);
    for (var n = 0; n < times; n++) {
      mouseAt("pointerdown", g.x, g.y, opt); mouseAt("mousedown", g.x, g.y, opt);
      // A real click lasts a few frames; a same-tick down+up is invisible to a
      // game that reads the button state once per frame.
      await sleep(TAP_MS);
      mouseAt("pointerup", g.x, g.y, opt); mouseAt("mouseup", g.x, g.y, opt);
      mouseAt(b === 2 ? "contextmenu" : "click", g.x, g.y, opt);
    }
    if (times === 2) mouseAt("dblclick", g.x, g.y, opt);
  }
  var CODES = { " ": "Space", Space: "Space", Enter: "Enter", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", Shift: "ShiftLeft", Control: "ControlLeft", Alt: "AltLeft", Meta: "MetaLeft" };
  var KEYCODES = { Space: 32, Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ShiftLeft: 16, ControlLeft: 17, AltLeft: 18, MetaLeft: 91 };
  function keyInfo(k){
    if (k === "Space") k = " ";
    var code = CODES[k] || (k.length === 1 ? (/[a-z]/i.test(k) ? "Key" + k.toUpperCase() : /[0-9]/.test(k) ? "Digit" + k : k) : k);
    var keyCode = KEYCODES[code] || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
    return { key: k, code: code, keyCode: keyCode };
  }
  function keyEvent(type, k, mods){
    var info = keyInfo(k), target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    var init = { key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode, bubbles: true, cancelable: true, composed: true, ctrlKey: !!mods.Control, shiftKey: !!mods.Shift, altKey: !!mods.Alt, metaKey: !!mods.Meta };
    var ev = new KeyboardEvent(type, init);
    try { Object.defineProperty(ev, "keyCode", { get: function(){ return info.keyCode; } }); Object.defineProperty(ev, "which", { get: function(){ return info.keyCode; } }); } catch (e) {}
    target.dispatchEvent(ev);
    return target;
  }
  async function press(keys, holdMs, repeat){
    var parts = String(keys).split("+"), mods = {}, main = parts[parts.length - 1];
    for (var r = 0; r < Math.max(1, repeat || 1); r++) {
      for (var i = 0; i < parts.length - 1; i++) { mods[parts[i]] = true; keyEvent("keydown", parts[i], mods); }
      var target = keyEvent("keydown", main, mods);
      if (main.length === 1 && !mods.Control && !mods.Meta && target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) setValue(target, (target.value || "") + main);
      await sleep(holdMs || TAP_MS); // a tap is held a few frames too (per-frame key polling)
      keyEvent("keyup", main, mods);
      for (var j = parts.length - 2; j >= 0; j--) { keyEvent("keyup", parts[j], mods); delete mods[parts[j]]; }
      if (repeat > 1) await sleep(30);
    }
  }
  function tree(){
    var out = [], list = document.querySelectorAll("a[href],button,input,textarea,select,[role],h1,h2,h3,label,canvas,[contenteditable=true]");
    for (var i = 0; i < list.length && out.length < 300; i++) {
      var el = list[i]; if (!visible(el)) continue;
      var node = { role: roleOf(el), name: textOf(el).slice(0, 120) };
      if (el.value !== undefined && el.tagName !== "BUTTON" && el.value !== "") node.value = String(el.value).slice(0, 120);
      if (el.tagName === "CANVAS") { var r = el.getBoundingClientRect(); node.name = "canvas " + Math.round(r.width) + "x" + Math.round(r.height) + " at " + Math.round(r.left) + "," + Math.round(r.top); }
      out.push(node);
    }
    return out;
  }
  // What is on screen, the way the owner sees it: the page's HTML (HUD, menus,
  // overlays) composed over its canvases. WebGL keeps its picture only until
  // the frame is shown, so every canvas is read inside a frame callback,
  // after the page's own drawing for that frame; the canvases then go into a
  // copy of the page as images and the whole copy is painted through an SVG
  // foreignObject with the page's own CSS.
  function canvasShots(list){
    return new Promise(function(res){ requestAnimationFrame(function(){ res(list.map(function(c){ try { return c.toDataURL("image/png"); } catch (e) { return ""; } })); }); });
  }
  function pageCss(){
    var out = [];
    for (var i = 0; i < document.styleSheets.length; i++) {
      try { var rules = document.styleSheets[i].cssRules; for (var j = 0; j < rules.length; j++) out.push(rules[j].cssText); } catch (e) {}
    }
    return out.join("\\n");
  }
  function loadImage(src){
    return new Promise(function(res){ var img = new Image(); img.onload = function(){ res(img); }; img.onerror = function(){ res(null); }; img.src = src; });
  }
  async function capture(){
    var w = Math.max(1, innerWidth), h = Math.max(1, innerHeight), scale = Math.min(1, 1280 / w);
    var canvases = Array.prototype.slice.call(document.querySelectorAll("canvas"));
    var shots = await canvasShots(canvases);
    var clone = document.documentElement.cloneNode(true);
    var copies = clone.querySelectorAll("canvas");
    for (var i = 0; i < copies.length && i < canvases.length; i++) {
      var src = canvases[i], r = src.getBoundingClientRect(), img = document.createElement("img");
      if (shots[i]) img.setAttribute("src", shots[i]);
      if (src.id) img.setAttribute("id", src.id);
      if (src.getAttribute("class")) img.setAttribute("class", src.getAttribute("class"));
      img.setAttribute("style", (src.getAttribute("style") || "") + ";width:" + r.width + "px;height:" + r.height + "px");
      copies[i].parentNode.replaceChild(img, copies[i]);
    }
    Array.prototype.forEach.call(clone.querySelectorAll("script,link,iframe,video,audio,noscript"), function(n){ n.parentNode && n.parentNode.removeChild(n); });
    var css = pageCss().replace(/&/g, "&amp;").replace(/</g, "&lt;");
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:' + w + 'px;height:' + h + 'px;overflow:hidden"><style>' + css + '</style><div style="transform:translate(' + (-scrollX) + 'px,' + (-scrollY) + 'px)">' + new XMLSerializer().serializeToString(clone) + '</div></div></foreignObject></svg>';
    var out = document.createElement("canvas"); out.width = Math.round(w * scale); out.height = Math.round(h * scale);
    var g = out.getContext("2d"); g.scale(scale, scale);
    // What the browser paints behind the page: the html/body background, or
    // white when both are transparent. Never leave the image transparent —
    // a WebGL canvas with alpha would read as pale slabs to the model.
    var bg = [document.documentElement, document.body].map(function(el){ return el ? getComputedStyle(el).backgroundColor : ""; }).filter(function(c){ return c && !/^rgba\\(.*,\\s*0\\)$|^transparent$/.test(c); })[0] || "#fff";
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    var page = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
    if (page) g.drawImage(page, 0, 0, w, h);
    else {
      // The page's markup would not render as an image: at least its canvases.
      for (var k = 0; k < canvases.length; k++) {
        var shot = shots[k] ? await loadImage(shots[k]) : null, cr = canvases[k].getBoundingClientRect();
        if (shot) g.drawImage(shot, cr.left, cr.top, cr.width, cr.height);
      }
    }
    var data = "";
    try { data = out.toDataURL("image/png"); } catch (e) { throw new Error("the page drew cross-origin content, so it can't be captured"); }
    return { format: "png", bytes: data.slice(data.indexOf(",") + 1), width: out.width, height: out.height };
  }
  async function waitFor(u, timeoutMs){
    var t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      var hit = u.url ? location.href.indexOf(u.url) !== -1 : u.selector ? (function(){ try { return !!document.querySelector(u.selector); } catch (e) { return false; } })() : u.text ? (document.body && document.body.innerText.toLowerCase().indexOf(String(u.text).toLowerCase()) !== -1) : true;
      if (u.gone ? !hit : hit) return { met: true, waitedMs: Date.now() - t0 };
      await sleep(150);
    }
    return { met: false, waitedMs: Date.now() - t0 };
  }
  function safe(v){ try { return v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); } }
  async function run(c){
    var a = c.args || {};
    switch (c.op) {
      case "state": return { url: location.href, title: document.title };
      case "navigate": setTimeout(function(){ location.href = a.url; }, 0); return { url: a.url, title: document.title };
      case "eval": return safe(await (0, eval)(a.js));
      case "press": await press(a.keys, a.holdMs, a.repeat); return true;
      case "pointer": await pointer(a); return true;
      case "clickText":
        var el = findText(a.query);
        if (!el) {
          // Say WHY: a selector that matches a hidden element (a menu already
          // closed) is a different situation from one that isn't there.
          var hidden = (function(){ try { return document.querySelector(a.query); } catch (e) { return null; } })();
          throw new Error(hidden ? JSON.stringify(a.query) + " is on the page but not visible right now (hidden or zero-size) — check the page state" : "nothing on the page matches " + JSON.stringify(a.query));
        }
        await clickEl(el); return true;
      case "clickRole": var er = findRole(a.role, a.name); if (!er) throw new Error("no " + a.role + " named " + JSON.stringify(a.name)); await clickEl(er); return true;
      case "fill": var f = a.selector ? (function(){ try { return document.querySelector(a.selector); } catch (e) { return null; } })() : findField(a.label); if (!f) throw new Error("no field " + JSON.stringify(a.selector || a.label)); setValue(f, a.value); return true;
      case "tree": return tree();
      case "screenshot": return await capture();
      case "console": return logs.filter(function(l){ return !a.onlyErrors || l.level === "error"; }).slice(-(a.limit || 50));
      case "waitFor": return await waitFor(a, a.timeoutMs || 10000);
      default: throw new Error("unknown op " + c.op);
    }
  }
  async function loop(){
    for (;;) {
      var cmd = null;
      try {
        var res = await fetch("${DRIVE_PATH}?page=" + pid + "&url=" + encodeURIComponent(location.href), { cache: "no-store" });
        if (res.status === 200) cmd = await res.json();
        else if (res.status !== 204) await sleep(2000);
      } catch (e) { await sleep(2000); continue; }
      if (!cmd) continue;
      if (stepMode) thaw();
      var reply;
      try { reply = { id: cmd.id, ok: true, value: await run(cmd) }; }
      catch (e) { reply = { id: cmd.id, ok: false, error: String(e && e.message || e) }; }
      if (stepMode) freeze();
      try { await fetch("${DRIVE_PATH}?page=" + pid, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reply) }); } catch (e) {}
    }
  }
  // Leaving (reload, navigation, closed tab): say so at once, so Ares moves to
  // the next copy instead of waiting out a command this page will never answer.
  window.addEventListener("pagehide", function(){ try { navigator.sendBeacon("${DRIVE_PATH}?page=" + pid + "&bye=1", ""); } catch (e) {} });
  loop();
})();`;
