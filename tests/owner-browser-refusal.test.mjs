// Owner, 2026-10-21: "ares should only use embedded browser". A shell line
// that would open a page or a browser on the owner's desktop is refused and
// pointed at the Forge (Browser open/preview).
import test from "node:test";
import assert from "node:assert/strict";
import { ownerBrowserRefusal, irrecoverableShellRefusal } from "../packages/tools/dist/_shared.js";

test("opening a page or a browser from the shell is refused", () => {
  const refused = [
    'Start-Process "C:\\Users\\nikol\\Desktop\\Projects\\vibeland\\index.html"',
    "Start-Process http://127.0.0.1:5183",
    "start chrome http://localhost:3000",
    "start msedge.exe http://localhost:3000",
    'Invoke-Item .\\dist\\index.html',
    "ii game.html",
    "explorer http://127.0.0.1:8080/",
    "xdg-open http://localhost:5173",
    "open -a Safari http://localhost:5173",
    "open index.html",
    'cmd /c start "" "C:\\game\\index.html"',
    "rundll32 url.dll,FileProtocolHandler http://localhost:9000",
    '& "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" http://localhost:3000',
    "npm run build; Start-Process http://localhost:4173",
    // an agent once took the Forge's DevTools port with its own Chrome
    'Start-Process "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -ArgumentList "--remote-debugging-port=9333"',
    "& 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' --remote-debugging-port=9333 --user-data-dir=C:\\tmp\\p",
    "chrome --headless --remote-debugging-port=9222",
    "start msedge",
    "msedge.exe",
    "Start-Process chrome",
  ];
  for (const c of refused) {
    const r = ownerBrowserRefusal(c);
    assert.ok(r, `should refuse: ${c}`);
    assert.match(r, /Forge/);
    assert.match(irrecoverableShellRefusal(c) ?? "", /Refused/);
  }
});

test("ordinary shell work is not refused", () => {
  for (const c of [
    "Start-Process node -ArgumentList server.js",
    "Start-Process -FilePath npm -ArgumentList 'run dev' -WindowStyle Hidden",
    "npm start",
    "node scripts/build.mjs && echo done",
    "open ./notes.txt",
    "Invoke-Item .\\report.pdf",
    "git log --oneline | head",
    "cat index.html",
    "curl -s http://127.0.0.1:5183/ | head -c 200",
    "Get-Content game.html -TotalCount 40",
    "start-sleep 2",
    "explorer .",
    "kill-opener.sh",
  ]) assert.equal(ownerBrowserRefusal(c), null, `should allow: ${c}`);
});

test("a hidden browser through Playwright/Puppeteer/Selenium from the shell is refused; project test runs are not", async () => {
  const { ownerBrowserRefusal } = await import("../packages/tools/dist/_shared.js");
  for (const cmd of [
    `node -e "const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();})()"`,
    `node shot.mjs && node -e "require('puppeteer').launch()"`,
    `npx playwright screenshot http://127.0.0.1:5173 out.png`,
    `python -c "from playwright.sync_api import sync_playwright; sync_playwright().start()"`,
    `node -e "firefox.launchPersistentContext('x')"`,
  ]) assert.ok(ownerBrowserRefusal(cmd), `refused: ${cmd}`);
  for (const cmd of [`npx playwright install chromium`, `npx playwright test`, `pnpm test`, `grep -rn playwright package.json`]) {
    assert.equal(ownerBrowserRefusal(cmd), null, `allowed: ${cmd}`);
  }
});
