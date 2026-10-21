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
