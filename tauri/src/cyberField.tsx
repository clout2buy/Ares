// The Cyber room's backdrop: a GPU point cloud, driven by a point map spec.
//
// One WebGL draw call of a few thousand points. The spec (see pointMaps.ts)
// picks the shape — a volumetric nebula, a low horizon bowl, a rolling sheet,
// or rings in orbit — and how it drifts, spreads, sits and glows. Depth sets
// size and alpha so the far side dissolves into the room. Motion is a slow
// drift and nothing ever pulses or flashes; under prefers-reduced-motion it
// renders one still frame. It paces itself: 30fps cap, DPR capped at 1.5,
// parked when the tab is hidden or the element is off-screen.
import React, { useEffect, useRef } from "react";
import { hexToRgb01, type PointMapSpec } from "./pointMaps";

const VERT = `
attribute vec3 aP;      // u, v in 0..1 and a per-point seed
uniform float uTime;
uniform vec2 uView;
uniform float uKind;    // 0 nebula, 1 horizon, 2 waves, 3 orbit
uniform float uAmp;
uniform float uSpread;
uniform float uLift;
uniform float uSize;
varying float vDepth;
varying float vLight;
varying float vSeed;

float hash(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  float u = aP.x * 2.0 - 1.0;
  float v = aP.y * 2.0 - 1.0;
  float s = aP.z;
  vec3 p;
  if (uKind < 0.5) {
    // nebula: a gaussian-ish volume, each point on its own slow arc
    float r = pow(hash(s * 3.1), 0.55);
    float th = hash(s * 5.7) * 6.2831 + uTime * 0.05 * (0.5 + hash(s * 9.1));
    float ph = (hash(s * 7.3) - 0.5) * 2.4;
    p = vec3(cos(th) * cos(ph) * r * 1.5, sin(ph) * r * 0.75, sin(th) * cos(ph) * r);
    p.y += 0.12 * uAmp * sin(uTime * 0.3 + s * 4.0);
    p.x += 0.08 * uAmp * cos(uTime * 0.22 + s * 2.0);
  } else if (uKind < 1.5) {
    // horizon: a shallow bowl with two ridge waves
    float rr = length(vec2(u, v));
    float y = 0.42 * rr * rr + uAmp * (0.10 * sin(u * 3.2 + uTime * 0.35 + s * 0.5) * cos(v * 2.4 - uTime * 0.27) + 0.06 * sin((u + v) * 5.0 - uTime * 0.2)) - 0.34;
    p = vec3(u * 1.4, y * 0.9 - v * 0.34, v * 0.8 + y * 0.3);
  } else if (uKind < 2.5) {
    // waves: a wide sheet, rolling
    float y = uAmp * (0.16 * sin(u * 4.0 + uTime * 0.4) * cos(v * 3.0 - uTime * 0.3) + 0.08 * sin((u * 2.0 - v) * 3.0 + uTime * 0.25)) - 0.1;
    p = vec3(u * 1.7, y - v * 0.42, v * 0.9);
  } else if (uKind < 4.5) {
    // galaxy: two log-spiral arms with scatter, a dense bulge, seen at a tilt
    float arm = step(0.5, hash(s * 3.7));
    float t = pow(hash(s * 5.3), 0.7) * 3.2;
    float ang = t * 2.1 + arm * 3.1416 + uTime * 0.05 - t * 0.15;
    float rad = 0.12 + t * 0.32;
    float scatter = (hash(s * 8.1) - 0.5) * (0.12 + t * 0.06) * (1.0 + uAmp);
    float bulge = step(hash(s * 2.9), 0.18);
    vec3 disk = vec3(cos(ang) * rad + scatter, (hash(s * 6.7) - 0.5) * 0.05 * (1.0 + uAmp), sin(ang) * rad + scatter * 0.7);
    vec3 core = vec3(hash(s * 4.1) - 0.5, (hash(s * 9.9) - 0.5) * 0.5, hash(s * 7.7) - 0.5) * 0.28;
    vec3 g = mix(disk, core, bulge);
    float tilt = 1.05;
    p = vec3(g.x * 1.25, g.y * cos(tilt) - g.z * sin(tilt) * 0.55, g.y * sin(tilt) + g.z * cos(tilt));
  } else {
    // aurora: tall curtains, each a ribbon rippling sideways, fading upward
    float curtain = floor(hash(s * 2.2) * 4.0);
    float x = u * 1.6 + (curtain - 1.5) * 0.12;
    float h = pow(hash(s * 6.3), 0.6);
    float ripple = uAmp * (0.18 * sin(x * 2.6 + uTime * 0.5 + curtain) + 0.08 * sin(x * 6.0 - uTime * 0.35));
    float sway = uAmp * 0.12 * sin(h * 4.0 + uTime * 0.3 + curtain * 1.7);
    p = vec3(x + sway * 0.4, h * 1.5 - 0.55 + ripple * 0.3, (curtain - 1.5) * 0.35 + ripple + v * 0.15);
  }
  if (uKind > 2.5 && uKind < 3.5) {
    // orbit: three tilted rings and a sparse shell
    float band = floor(hash(s * 2.3) * 4.0);
    float a = hash(s * 4.9) * 6.2831 + uTime * (0.06 + band * 0.02);
    if (band < 3.0) {
      float rad = 0.55 + band * 0.22;
      float tilt = 0.35 + band * 0.4;
      vec3 q = vec3(cos(a) * rad, 0.0, sin(a) * rad);
      p = vec3(q.x, q.z * sin(tilt) + uAmp * 0.02 * sin(a * 6.0 + uTime), q.z * cos(tilt));
    } else {
      float ph = (hash(s * 6.1) - 0.5) * 3.1416;
      p = vec3(cos(a) * cos(ph), sin(ph), sin(a) * cos(ph)) * 1.15;
    }
  }
  p *= uSpread;
  float depth = clamp((p.z + 1.5) / 3.0, 0.0, 1.0);
  float persp = 1.0 / (1.8 + p.z * 0.4);
  vec2 ndc = vec2(p.x * persp, p.y * persp + uLift);
  ndc.x *= uView.y / uView.x * 1.6;
  gl_Position = vec4(ndc, 0.0, 1.0);
  float size = (2.4 - depth * 1.5) * (uView.y / 900.0 + 0.5) * uSize * (0.7 + 0.6 * hash(s * 8.8));
  gl_PointSize = max(1.0, size);
  vDepth = depth;
  vLight = clamp(0.3 + 0.7 * (p.x * 0.35 + 0.5) * (0.6 + 0.4 * (1.0 - depth)), 0.0, 1.0);
  vSeed = s;
}`;

const FRAG = `
precision mediump float;
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uAlpha;
varying float vDepth;
varying float vLight;
varying float vSeed;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float m = 1.0 - smoothstep(0.30, 0.5, length(d));
  if (m <= 0.0) discard;
  vec3 col = mix(uColA, uColB, vLight);
  float a = m * (0.08 + 0.42 * (1.0 - vDepth)) * (0.7 + 0.3 * fract(vSeed * 7.31)) * uAlpha;
  gl_FragColor = vec4(col * a, a);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn("cyberField shader:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function parseRgb(value: string, fallback: [number, number, number]): [number, number, number] {
  const m = value.match(/(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
  if (!m) return fallback;
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
}

const KIND_INDEX = { nebula: 0, horizon: 1, waves: 2, orbit: 3, galaxy: 4, aurora: 5 } as const;

export function CyberField({ spec }: { spec: PointMapSpec }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;
  // density changes rebuild the buffer; everything else is a uniform
  const density = spec.density;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, premultipliedAlpha: true, powerPreference: "low-power" });
    if (!gl) return;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    const n = density;
    const cols = Math.ceil(Math.sqrt(n * 1.7));
    const rows = Math.ceil(n / cols);
    const data = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const i = k % cols;
      const j = Math.floor(k / cols);
      data[k * 3] = (i + 0.5 + (Math.random() - 0.5) * 0.7) / cols;
      data[k * 3 + 1] = (j + 0.5 + (Math.random() - 0.5) * 0.7) / rows;
      data[k * 3 + 2] = Math.random() * 100;
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aP");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);

    const U = (name: string) => gl.getUniformLocation(prog, name);
    const uTime = U("uTime"), uView = U("uView"), uKind = U("uKind"), uAmp = U("uAmp"), uSpread = U("uSpread"), uLift = U("uLift"), uSize = U("uSize"), uColA = U("uColA"), uColB = U("uColB"), uAlpha = U("uAlpha");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = 0;
    let visible = !document.hidden;
    let onScreen = true;
    let disposed = false;
    const start = performance.now();
    let speed = 0.3;

    const applySpec = () => {
      const s = specRef.current;
      speed = s.speed;
      gl.uniform1f(uKind, KIND_INDEX[s.kind]);
      gl.uniform1f(uAmp, s.amplitude);
      gl.uniform1f(uSpread, s.spread);
      gl.uniform1f(uLift, s.lift);
      gl.uniform1f(uSize, s.size);
      gl.uniform1f(uAlpha, s.opacity);
      let a: [number, number, number];
      let b: [number, number, number];
      if (s.colors === "accent") {
        const cs = getComputedStyle(canvas);
        a = parseRgb(cs.getPropertyValue("--accent-rgb"), [91 / 255, 124 / 255, 250 / 255]);
        // the high end leans toward white, like the mark
        b = [Math.min(1, a[0] * 0.5 + 0.55), Math.min(1, a[1] * 0.5 + 0.6), Math.min(1, a[2] * 0.4 + 0.7)];
      } else {
        a = hexToRgb01(s.colors[0]);
        b = hexToRgb01(s.colors[1]);
      }
      gl.uniform3f(uColA, a[0], a[1], a[2]);
      gl.uniform3f(uColB, b[0], b[1], b[2]);
    };

    const resize = () => {
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uView, w, h);
    };

    const draw = (now: number) => {
      resize();
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uTime, reduced ? 0 : ((now - start) / 1000) * (0.2 + speed * 1.6));
      gl.drawArrays(gl.POINTS, 0, n);
    };

    const tick = (now: number) => {
      if (disposed) return;
      raf = 0;
      if (!visible || !onScreen) return;
      if (now - last >= 33) {
        last = now;
        draw(now);
      }
      if (!reduced && speed > 0) raf = requestAnimationFrame(tick);
    };
    const wake = () => {
      if (disposed || raf) return;
      if (visible && onScreen) raf = requestAnimationFrame(tick);
    };

    applySpec();
    draw(performance.now());
    wake();

    const onVis = () => { visible = !document.hidden; if (visible) wake(); };
    document.addEventListener("visibilitychange", onVis);
    const io = new IntersectionObserver((entries) => { onScreen = entries.some((e) => e.isIntersecting); if (onScreen) wake(); });
    io.observe(canvas);
    const ro = new ResizeObserver(() => { resize(); if (reduced) draw(performance.now()); });
    ro.observe(canvas);
    const mo = new MutationObserver(() => { applySpec(); draw(performance.now()); wake(); });
    const root = canvas.closest(".ares");
    if (root) mo.observe(root, { attributes: true, attributeFilter: ["data-accent", "data-surface", "data-theme", "data-pointmap"] });

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      io.disconnect();
      ro.disconnect();
      mo.disconnect();
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, [density]);

  // a spec change that keeps the density is a uniform refresh: nudge the
  // observer by bumping an attribute the component itself owns
  useEffect(() => {
    const canvas = ref.current;
    canvas?.setAttribute("data-spec", `${spec.id}:${spec.kind}:${spec.amplitude}:${spec.speed}:${spec.spread}:${spec.lift}:${spec.size}:${spec.opacity}:${String(spec.colors)}`);
    const root = canvas?.closest(".ares");
    root?.setAttribute("data-pointmap", spec.id + ":" + Date.now());
  }, [spec]);

  return <canvas ref={ref} className="cyberField" aria-hidden="true" />;
}
