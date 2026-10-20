// Rooms playtest — two REAL clients through the room's game relay, before
// anyone is told a multiplayer thing works.
//
// The stick-fight game (room "Doing & Cupid", 2026-10-20) shipped five times
// as "Not playtested yet": the relay sent binary frames, the page parsed
// nothing, and the guest sat on a grey screen. A Forge screenshot of one
// page cannot see that; two sockets that each must receive the other's JSON
// as a TEXT frame can. This is that check, plus a read of the shared page
// for the habits that broke it (peer-to-peer, its own relay, no close
// handler). It proves the path the page uses, not the game's own logic —
// the result says so, so an agent can't report more than it ran.
import WebSocket from "ws";
import { roomRelayUrl } from "../../roomRelay.js";

export interface PlaytestResult {
  ok: boolean;
  relay: string;
  /** What ran, in order, with timings. */
  steps: string[];
  /** What failed (empty when ok). */
  problems: string[];
  /** Findings from reading the shared page (when one was named). */
  page: string[];
  /** What this did NOT prove. */
  unproven: string;
}

interface Client { ws: WebSocket; inbox: Array<{ text: string; binary: boolean }>; closed?: { code: number; reason: string }; waiters: Array<() => void> }

function connect(url: string): Client {
  const c: Client = { ws: new WebSocket(url), inbox: [], waiters: [] };
  const wake = () => { for (const w of c.waiters.splice(0)) w(); };
  c.ws.on("message", (data, isBinary) => { c.inbox.push({ text: Buffer.isBuffer(data) ? data.toString("utf8") : String(data), binary: isBinary }); wake(); });
  c.ws.on("close", (code, reason) => { c.closed = { code, reason: reason.toString() }; wake(); });
  c.ws.on("error", () => wake());
  return c;
}

/** Wait for the first message (from `from` on) matching `want`. */
async function expect(c: Client, want: (m: Record<string, unknown>) => boolean, timeoutMs: number, label: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  for (;;) {
    for (; seen < c.inbox.length; seen++) {
      const m = c.inbox[seen]!;
      if (m.binary) throw new Error(`${label}: got a BINARY frame — browsers hand that to the page as a Blob and JSON.parse fails`);
      let parsed: unknown;
      try { parsed = JSON.parse(m.text); } catch { throw new Error(`${label}: got text that is not JSON: ${m.text.slice(0, 80)}`); }
      if (parsed && typeof parsed === "object" && want(parsed as Record<string, unknown>)) return parsed as Record<string, unknown>;
    }
    if (c.closed) throw new Error(`${label}: the socket closed (code ${c.closed.code}${c.closed.reason ? `: ${c.closed.reason}` : ""})`);
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`${label}: nothing within ${timeoutMs} ms`);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, left);
      c.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }
}

/** Two clients on a fresh code: both get hello, A sees B join, each one's
 *  JSON reaches the other as text, A sees B leave. */
export async function twoClientCheck(relay: string, timeoutMs = 8_000): Promise<Pick<PlaytestResult, "ok" | "steps" | "problems">> {
  const steps: string[] = [];
  const problems: string[] = [];
  const t0 = Date.now();
  const mark = (s: string) => steps.push(`${s} (${Date.now() - t0} ms)`);
  const a = connect(relay);
  let b: Client | undefined;
  try {
    const helloA = await expect(a, (m) => m.relay === "hello", timeoutMs, "client A");
    mark(`A connected as ${String(helloA.you)} (host ${String(helloA.host)})`);
    b = connect(relay);
    const helloB = await expect(b, (m) => m.relay === "hello", timeoutMs, "client B");
    mark(`B connected as ${String(helloB.you)}; host is ${String(helloB.host)}`);
    await expect(a, (m) => m.relay === "join" && m.id === helloB.you, timeoutMs, "client A (waiting for B's join)");
    mark("A saw B join");
    const ping = { t: "playtest", from: "A", n: Math.floor(Math.random() * 1e9) };
    a.ws.send(JSON.stringify(ping));
    await expect(b, (m) => m.t === "playtest" && m.n === ping.n, timeoutMs, "client B (waiting for A's message)");
    mark("A → B: JSON arrived as a text frame");
    const pong = { t: "playtest", from: "B", n: ping.n + 1 };
    b.ws.send(JSON.stringify(pong));
    await expect(a, (m) => m.t === "playtest" && m.n === pong.n, timeoutMs, "client A (waiting for B's message)");
    mark("B → A: JSON arrived as a text frame");
    b.ws.close(1000, "playtest done");
    await expect(a, (m) => m.relay === "leave" && m.id === helloB.you, timeoutMs, "client A (waiting for B to leave)");
    mark("A saw B leave");
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    a.ws.terminate();
    b?.ws.terminate();
  }
  return { ok: problems.length === 0, steps, problems };
}

/** What a shared page does that broke multiplayer before. Heuristic: it
 *  reads the source, it does not run it. */
export function pageFindings(html: string): string[] {
  const out: string[] = [];
  const ws = /new\s+WebSocket\s*\(/.test(html);
  if (/peerjs|RTCPeerConnection/i.test(html)) out.push("uses peer-to-peer (PeerJS/WebRTC), which hangs behind many home routers — connect to the room relay instead");
  if (ws && !/\/relay\//.test(html)) out.push("opens its own WebSocket server, not the room relay (…/relay/<CODE> on the page's own host)");
  if (ws && !/onclose|addEventListener\(\s*["']close/.test(html)) out.push("no close handler — show the close code and reason on screen so a failed join is visible, not a grey screen");
  if (ws && /JSON\.parse\(\s*\w+\.data\s*\)/.test(html) && !/try\s*\{/.test(html)) out.push("JSON.parse(ev.data) with no try — a bad frame throws silently; catch it and show it");
  if (!ws && !/peerjs|RTCPeerConnection/i.test(html)) out.push("no networking found in the page — if this is multiplayer, it is not connecting to anything");
  return out;
}

export const PLAYTEST_UNPROVEN =
  "This proves two real clients can reach each other through the room relay. It does not prove the game itself: " +
  "for that, drive two headless pages (e.g. a Playwright script with two browser contexts, run from the shell — not the Forge) through join → a move → seeing the other's move.";

export function relayFor(fileUrl: string): string {
  return roomRelayUrl(fileUrl, `T${Math.random().toString(36).slice(2, 9).toUpperCase()}`);
}
