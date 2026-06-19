// Drive the Playwright connector against a test page and verify the human-like
// cursor: real mouse moves (hover fires), click registers, frames stream.
import { createPlaywrightBrowser } from "../packages/connectors/dist/index.js";
import { writeFileSync } from "node:fs";

const frames = [];
const br = await createPlaywrightBrowser({ headless: true, onFrame: (f) => frames.push(f), paceMs: 600 });

const page = `<!doctype html><html><head><meta charset=utf8><style>
  body{font:18px system-ui;background:#101418;color:#e6edf3;margin:0;padding:60px;height:100vh}
  button{padding:16px 28px;font-size:18px;border-radius:10px;border:2px solid #2f81f7;background:#161b22;color:#e6edf3;cursor:pointer;transition:.15s}
  button:hover{background:#2f81f7;color:#fff;transform:scale(1.05)}
  #out{margin-top:28px;font-size:22px;color:#3fb950}
  input{margin-top:24px;padding:12px;font-size:16px;width:320px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3}
</style></head><body>
  <button id="b" onmouseenter="document.getElementById('h').textContent='HOVERED'" onclick="document.getElementById('out').textContent='CLICKED ✓'">Run the build</button>
  <div id="h" style="color:#d29922;margin-top:10px"></div>
  <div id="out"></div>
  <input id="name" placeholder="type here" />
</body></html>`;

await br.navigate("data:text/html," + encodeURIComponent(page));
await br.clickByText("Run the build");
await br.fillBySelector("#name", "Ares was here");

const clicked = await br.evaluate("document.getElementById('out').textContent");
const hovered = await br.evaluate("document.getElementById('h').textContent");
const typed = await br.evaluate("document.getElementById('name').value");

console.log("frames streamed:", frames.length);
console.log("hover fired:", JSON.stringify(hovered));
console.log("click registered:", JSON.stringify(clicked));
console.log("typed value:", JSON.stringify(typed));

if (frames.length) {
  writeFileSync("D:/Ares/tauri/public/cursor-test.jpg", Buffer.from(frames[Math.floor(frames.length * 0.45)], "base64"));
  console.log("saved a mid-motion frame to tauri/public/cursor-test.jpg");
}
await br.close();
