import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

test("Linux boot sets html data-perf=lite and defaults flame to minimal", () => {
  const prefs = read("tauri", "src", "state", "prefs.ts");
  assert.match(prefs, /export const IS_LINUX/);
  assert.match(prefs, /document\.documentElement\.dataset\.perf = "lite"/);
  assert.match(prefs, /flameMode: IS_LINUX \? "minimal" : "glow"/);
});

test("perf-lite clears both backdrop-filter spellings WebKitGTK actually composites", () => {
  const styles = read("tauri", "src", "styles.css");
  const liteStar = styles.match(/html\[data-perf="lite"\] \* \{[^}]+\}/);
  assert.ok(liteStar, "missing html[data-perf=lite] * rule");
  assert.match(liteStar[0], /-webkit-backdrop-filter: none !important;/);
  assert.match(liteStar[0], /backdrop-filter: none !important;/);
});

test("perf-lite freezes idle full-viewport paint (blur, emberRise, astrolabe)", () => {
  const styles = read("tauri", "src", "styles.css");
  assert.match(styles, /html\[data-perf="lite"\] \.backdrop::before \{[\s\S]*?animation: none !important;[\s\S]*?filter: none !important;/);
  assert.match(styles, /html\[data-perf="lite"\] \.backdrop \.depthField,/);
  assert.match(styles, /html\[data-perf="lite"\] \.embers,/);
  assert.match(styles, /html\[data-perf="lite"\] \.backdrop \.ringSlow,/);
  assert.match(styles, /html\[data-perf="lite"\] \.screenFlame,/);
  assert.match(styles, /html\[data-perf="lite"\] \.hackerRain \{ display: none !important; \}/);
});

test("Linux does not mount ScreenFlame or SMIL feTurbulence filter defs", () => {
  const app = read("tauri", "src", "App.tsx");
  assert.match(app, /IS_LINUX \? null : <ScreenFlame \/>/);
  assert.match(app, /Never mount this on Linux: WebKitGTK keeps running the SMIL/);
  assert.match(app, /\{IS_LINUX \? null : \(\s*<svg width="0" height="0"/);
  assert.match(app, /prefs\.ultra && !IS_LINUX \? <HackerRain/);
});

test("ScryingBasin skips SMIL boil animation on Linux", () => {
  const app = read("tauri", "src", "App.tsx");
  assert.match(app, /function ScryingBasin/);
  assert.match(app, /\{IS_LINUX \? null : \(\s*<animate attributeName="baseFrequency"/);
  assert.match(app, /filter=\{IS_LINUX \? undefined : "url\(#boil\)"\}/);
});

test("perf-lite freezes working-state background-position and stage pulses", () => {
  const styles = read("tauri", "src", "styles.css");
  assert.match(styles, /html\[data-perf="lite"\] \.workGlow,/);
  assert.match(styles, /html\[data-perf="lite"\] \.workingForge,/);
  assert.match(styles, /html\[data-perf="lite"\] \.ares\[data-working="1"\]::after,/);
  assert.match(styles, /html\[data-perf="lite"\] \.turn\.assistant\[data-streaming="1"\] \.prose::after/);
});

test("demo session ends its second turn so Linux idle is not forever working", () => {
  const app = read("tauri", "src", "App.tsx");
  const demo = app.slice(app.indexOf("function demoSession"), app.indexOf("function noUsableKeys"));
  assert.match(demo, /const deepseekRounds/);
  assert.match(demo, /type: "turn_end", status: "completed"/);
  assert.match(demo, /type: "turn_settled"/);
  const ends = demo.match(/type: "turn_end"/g) ?? [];
  const settled = demo.match(/type: "turn_settled"/g) ?? [];
  assert.ok(ends.length >= 2, `demoSession should end both turns, got ${ends.length}`);
  assert.ok(settled.length >= 2, `demoSession should settle both turns, got ${settled.length}`);
});
