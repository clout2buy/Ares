import * as T from "https://esm.sh/three@0.160.0";
import { OrbitControls } from "https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js";
var DEFAULTS = {
  projectile: [["angle", "Launch angle", 5, 85, 45, 1], ["speed", "Speed", 5, 40, 22, 1], ["gravity", "Gravity", 1, 25, 9.8, 0.1], ["drag", "Air drag", 0, 0.5, 0.05, 0.01]],
  pendulum: [["length", "Length", 1, 6, 3, 0.1], ["gravity", "Gravity", 1, 25, 9.8, 0.1], ["damping", "Damping", 0, 0.5, 0.03, 0.01], ["angle", "Start angle", 10, 80, 50, 1]],
  orbit: [["gm", "Sun mass", 20, 200, 80, 1], ["dist", "Start distance", 3, 9, 6, 0.1], ["speed", "Start speed", 1, 12, 3.6, 0.1]],
  plot: []
};
function mk(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function build(el) {
  var spec = {};
  try { spec = JSON.parse(el.getAttribute("data-spec") || "{}"); } catch (e) {}
  var kind = spec.kind || "projectile";
  var params = (spec.params && spec.params.length ? spec.params.map(function (p) { return [p.key, p.label || p.key, +p.min, +p.max, +p.value, +(p.step || (p.max - p.min) / 100)]; }) : DEFAULTS[kind] || []);
  var vals = {}; params.forEach(function (p) { vals[p[0]] = p[4]; });
  var stage = mk("div", "k-stage"), panel = mk("div", "k-panel"), head = mk("div", "k-sim-head");
  head.appendChild(mk("span", "k-sim-tag", "interactive · " + kind));
  var btn = mk("button", "k-btn", kind === "plot" ? "reset" : "launch"); head.appendChild(btn);
  el.appendChild(head); el.appendChild(stage); el.appendChild(panel);
  var onParam = function () {};
  params.forEach(function (p) {
    var row = mk("label", "k-slider"), name = mk("span", "", p[1]), out = mk("b", "", String(p[4])), inp = document.createElement("input");
    inp.type = "range"; inp.min = p[2]; inp.max = p[3]; inp.step = p[5]; inp.value = p[4];
    inp.addEventListener("input", function () { vals[p[0]] = +inp.value; out.textContent = (+inp.value).toFixed(2).replace(/\.?0+$/, ""); onParam(p[0]); });
    row.appendChild(name); row.appendChild(inp); row.appendChild(out); panel.appendChild(row);
  });
  if (kind === "plot") { plot(stage, spec, vals, params, function (f) { onParam = f; }, btn, panel); return; }
  var w = stage.clientWidth || 600, h = 300;
  var r = new T.WebGLRenderer({ antialias: true, alpha: true }); r.setPixelRatio(Math.min(2, devicePixelRatio)); r.setSize(w, h); stage.appendChild(r.domElement);
  var sc = new T.Scene(), cam = new T.PerspectiveCamera(50, w / h, 0.1, 200);
  var ctl = new OrbitControls(cam, r.domElement); ctl.enableDamping = true;
  var grid = new T.GridHelper(40, 40, 0x2f6df0, 0x15347a); sc.add(grid);
  var col = 0x9cc5ff, warm = 0xf0a32f;
  var ball = new T.Mesh(new T.SphereGeometry(0.35, 16, 12), new T.MeshBasicMaterial({ color: warm })); sc.add(ball);
  var trailPts = [], trail = new T.Line(new T.BufferGeometry(), new T.LineBasicMaterial({ color: col })); sc.add(trail);
  var rod = new T.Line(new T.BufferGeometry(), new T.LineBasicMaterial({ color: 0x2f6df0 })); sc.add(rod);
  var sun = null;
  if (kind === "orbit") { sun = new T.Mesh(new T.SphereGeometry(0.8, 20, 14), new T.MeshBasicMaterial({ color: 0xffd36a })); sc.add(sun); }
  var st = {};
  function reset() {
    trailPts = [];
    if (kind === "projectile") { var a = vals.angle * Math.PI / 180; st = { x: 0, y: 0.35, z: 0, vx: Math.cos(a) * vals.speed, vy: Math.sin(a) * vals.speed, live: true }; cam.position.set(14, 9, 22); ctl.target.set(14, 3, 0); }
    if (kind === "pendulum") { st = { th: vals.angle * Math.PI / 180, om: 0 }; cam.position.set(0, -2, 12); ctl.target.set(0, -2, 0); }
    if (kind === "orbit") { st = { x: vals.dist, z: 0, vx: 0, vz: vals.speed }; cam.position.set(0, 14, 14); ctl.target.set(0, 0, 0); }
    ctl.update();
  }
  onParam = function () { if (kind === "pendulum" || kind === "orbit" || kind === "projectile") reset(); };
  btn.addEventListener("click", reset); reset();
  var last = performance.now();
  (function loop(now) {
    var dt = Math.min(0.03, (now - last) / 1000); last = now;
    if (kind === "projectile" && st.live) {
      for (var i = 0; i < 4; i++) { var d = dt / 4; var sp = Math.hypot(st.vx, st.vy); st.vx -= vals.drag * sp * st.vx * d; st.vy -= (vals.gravity + vals.drag * sp * st.vy) * d; st.x += st.vx * d; st.y += st.vy * d; }
      if (st.y <= 0.35) { st.y = 0.35; st.live = false; }
      ball.position.set(st.x, st.y, 0); trailPts.push(new T.Vector3(st.x, st.y, 0));
    }
    if (kind === "pendulum") {
      for (var j = 0; j < 4; j++) { var e = dt / 4; st.om += (-(vals.gravity / vals.length) * Math.sin(st.th) - vals.damping * st.om) * e; st.th += st.om * e; }
      var bx = Math.sin(st.th) * vals.length, by = -Math.cos(st.th) * vals.length;
      ball.position.set(bx, by, 0); rod.geometry.setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(bx, by, 0)]); trailPts.push(new T.Vector3(bx, by, 0));
    }
    if (kind === "orbit") {
      for (var k = 0; k < 8; k++) { var f = dt / 8, d2 = st.x * st.x + st.z * st.z, d3 = Math.pow(d2, 1.5) + 0.01; st.vx += -vals.gm * st.x / d3 * f; st.vz += -vals.gm * st.z / d3 * f; st.x += st.vx * f; st.z += st.vz * f; }
      ball.position.set(st.x, 0.2, st.z); trailPts.push(new T.Vector3(st.x, 0.2, st.z));
    }
    if (trailPts.length > 600) trailPts.shift();
    if (trailPts.length > 1) trail.geometry.setFromPoints(trailPts);
    ctl.update(); r.render(sc, cam); requestAnimationFrame(loop);
  })(last);
  addEventListener("resize", function () { var nw = stage.clientWidth; r.setSize(nw, h); cam.aspect = nw / h; cam.updateProjectionMatrix(); });
}
function plot(stage, spec, vals, params, setOn, btn, panel) {
  var c = document.createElement("canvas"); c.height = 280; stage.appendChild(c);
  var ctx = c.getContext("2d"), expr = spec.formula || "a*sin(b*x)";
  if (!params.length) { params = [["a", "a", 0, 5, 2, 0.1], ["b", "b", 0.2, 6, 1.5, 0.1]]; params.forEach(function (p) { vals[p[0]] = p[4]; }); }
  var xmin = spec.xmin != null ? +spec.xmin : -10, xmax = spec.xmax != null ? +spec.xmax : 10;
  var fn; try { fn = new Function("x", "v", "with(Math){with(v){return (" + expr + ")}}"); } catch (e) { fn = function () { return 0; }; }
  function draw() {
    var W = c.width = stage.clientWidth || 600, H = c.height; ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(47,109,240,.25)"; ctx.lineWidth = 1;
    for (var gx = 0; gx <= 10; gx++) { ctx.beginPath(); ctx.moveTo(gx * W / 10, 0); ctx.lineTo(gx * W / 10, H); ctx.stroke(); }
    for (var gy = 0; gy <= 6; gy++) { ctx.beginPath(); ctx.moveTo(0, gy * H / 6); ctx.lineTo(W, gy * H / 6); ctx.stroke(); }
    var ys = [], mn = 1e9, mx = -1e9, i;
    for (i = 0; i <= 240; i++) { var x = xmin + (xmax - xmin) * i / 240, y = 0; try { y = fn(x, vals); } catch (e) {} if (!isFinite(y)) y = 0; ys.push(y); mn = Math.min(mn, y); mx = Math.max(mx, y); }
    if (mx - mn < 1e-6) { mx += 1; mn -= 1; }
    ctx.strokeStyle = "#2f6df0"; ctx.lineWidth = 2.4; ctx.shadowColor = "#2f6df0"; ctx.shadowBlur = 8; ctx.beginPath();
    for (i = 0; i < ys.length; i++) { var px = i * W / 240, py = H - 12 - (ys[i] - mn) / (mx - mn) * (H - 24); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
    ctx.stroke(); ctx.shadowBlur = 0; ctx.fillStyle = "#8da0c8"; ctx.font = "11px monospace"; ctx.fillText("y = " + expr, 10, 16);
  }
  setOn(draw); btn.addEventListener("click", function () { params.forEach(function (p) { vals[p[0]] = p[4]; }); panel.querySelectorAll("input").forEach(function (inp, i) { inp.value = params[i][4]; }); draw(); });
  draw(); addEventListener("resize", draw);
}
document.querySelectorAll(".k-play").forEach(function (el) { try { build(el); } catch (e) { el.textContent = "interactive view unavailable: " + e.message; } });
