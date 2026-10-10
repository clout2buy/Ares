// A fake `claude` / `codex` that behaves like the real login: prints an authorize
// URL, opens a loopback listener, accepts the callback, writes a credential file.
// The test writes this file as the CLI binary (the script is named claude or codex).
// Behaviour switches live in $HOME/.mockcli.json so the scrubbed env needs no extras.
export const MOCK_CLI_SOURCE = String.raw`#!/usr/bin/env node
const fs = require("fs"), path = require("path"), http = require("http"), cp = require("child_process");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const home = process.env.HOME;
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(home, ".mockcli.json"), "utf8")); } catch {}
const credFile = name === "claude" ? path.join(home, ".claude", ".credentials.json") : path.join(home, ".codex", "auth.json");
const hasCred = () => fs.existsSync(credFile);
const writeCred = () => { fs.mkdirSync(path.dirname(credFile), { recursive: true }); fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-ACCESS", refreshToken: "FAKE-REFRESH", expiresAt: Date.now() + 3600e3 } })); };
const line = (s) => process.stdout.write(s + "\n");

if (args[0] === "auth" && args[1] === "status") { line(JSON.stringify({ loggedIn: hasCred(), authMethod: hasCred() ? "claude.ai" : "none", email: hasCred() ? "owner@example.com" : undefined })); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { process.exit(hasCred() ? 0 : 1); }
if ((args[0] === "auth" && args[1] === "logout") || args[0] === "logout") { try { fs.rmSync(credFile); } catch {} process.exit(0); }

const login = args[0] === "auth" ? args[1] === "login" : args[0] === "login";
if (!login) process.exit(2);

if (args.includes("--device-auth")) {
  line("Open https://mock.example/device and enter the one-time code ABCD-EF12");
  const t = setInterval(() => { if (fs.existsSync(path.join(home, ".approve-device"))) { clearInterval(t); writeCred(); process.exit(0); } }, 150);
  return;
}

const state = "st" + Math.random().toString(36).slice(2, 12);
const cbPath = name === "claude" ? "/callback" : "/auth/callback";
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname !== cbPath) { res.writeHead(404); return res.end(); }
  if (u.searchParams.get("state") !== state || !u.searchParams.get("code")) { res.writeHead(400); res.end("bad"); return; }
  if (cfg.failOnCallback) { res.writeHead(500); res.end("x"); line("error: exchange failed access_token=SECRETSECRET1234567890 sk-ant-oat01-" + "A".repeat(40) + " code=" + u.searchParams.get("code")); setTimeout(() => process.exit(1), 50); return; }
  writeCred(); res.writeHead(200); res.end("ok"); setTimeout(() => process.exit(0), 50);
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const redirect = cfg.noLoopback ? "https://platform.example/oauth/code/callback" : "http://localhost:" + port + cbPath;
  const authorize = "https://mock.example/oauth/authorize?code=true&client_id=mock&response_type=code&redirect_uri=" + encodeURIComponent(redirect) + "&code_challenge=CH&code_challenge_method=S256&state=" + state;
  const manual = "https://mock.example/oauth/authorize?code=true&client_id=mock&response_type=code&redirect_uri=" + encodeURIComponent("https://platform.example/oauth/code/callback") + "&code_challenge=CH&state=" + state;
  if (name === "claude") {
    line("Opening browser to sign in…");
    if (!cfg.noOpen) { try { cp.execFileSync(process.env.BROWSER, [authorize]); } catch {} }
    line("If the browser didn't open, visit: " + manual);
    process.stdout.write("Paste code here if prompted > ");
    process.stdin.setEncoding("utf8");
    let buf = "";
    process.stdin.on("data", (d) => { buf += d; const m = buf.split(/[\r\n]+/); buf = m.pop(); for (const l of m) if (l.trim() === "PASTECODE-123456") { writeCred(); setTimeout(() => process.exit(0), 50); } else if (l.trim()) line("error: invalid code " + l.trim()); });
  } else {
    line("Starting local login server on http://localhost:" + port + ".");
    line("If your browser did not open, navigate to this URL to authenticate:");
    line(authorize);
    if (!cfg.noOpen) { try { cp.execFileSync(process.env.BROWSER, [authorize]); } catch {} }
  }
});
`;
