// Live build: the Forge shows a `model` / `story` explain block materialising
// WHILE the model is still writing the tool call, instead of after it finishes.
//
// The desktop already receives the partial tool-input JSON (`tool_use_input_delta`).
// ExplainStream turns that raw delta stream into finished, sanitised pieces —
// one per completed part / scene — the moment each one closes. The Forge loads
// buildLiveStageHtml() (an empty kit page whose engines run in live mode) and
// posts the pieces to it; the engines pace them in one by one. When the real
// `explain` call lands, the final page replaces the stage with
// window.__aresInstant set so it opens already complete (no second build).
//
// Pure string/JSON code on purpose: the desktop frontend imports this file.

import { sanitizeAnim, sanitizeModelPart, sanitizeScene } from "./forgeBlocks.js";

export type LivePiece =
  | { op: "begin"; idx: number; kind: "model" | "story"; title?: string; style?: string; look?: string }
  | { op: "title"; idx: number; title: string }
  | { op: "part"; idx: number; parts: Record<string, unknown>[]; partial?: boolean }
  | { op: "scene"; idx: number; scene: Record<string, unknown> }
  | { op: "anim"; idx: number; anim: Record<string, unknown> }
  | { op: "end"; idx: number };

interface Frame { t: "o" | "a"; key: string | null; start: number; expectKey: boolean; curKey: string | null }

/** Incremental scanner over the streamed Browser-tool input JSON. Feed it
 *  deltas in any chunking; it returns the pieces that completed. Chunk
 *  boundaries never matter (tests feed it one char at a time). */
export class ExplainStream {
  private buf = "";
  private pos = 0;
  private stack: Frame[] = [];
  private inStr = false;
  private esc = false;
  private strStart = 0;
  private blockIdx = -1;
  private begun = new Map<number, "model" | "story">();
  private style = new Map<number, string>();
  private look = new Map<number, string>();
  private edge = new Map<number, string>();
  private counts = new Map<number, number>();

  feed(delta: string): LivePiece[] {
    this.buf += delta;
    const out: LivePiece[] = [];
    for (; this.pos < this.buf.length; this.pos++) {
      const c = this.buf[this.pos]!, i = this.pos, top = this.stack[this.stack.length - 1];
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === "\\") this.esc = true;
        else if (c === "\"") {
          this.inStr = false;
          const raw = this.buf.slice(this.strStart + 1, i);
          if (top && top.t === "o") {
            if (top.expectKey) { top.curKey = raw; top.expectKey = false; }
            else if (this.stack.length === 3 && this.blockIdx >= 0 && this.stack[1]?.key === "blocks") this.blockString(top.curKey, raw, out);
            else if (this.stack.length === 1) this.rootString(top.curKey, raw);
          }
        }
        continue;
      }
      if (c === "\"") { this.inStr = true; this.strStart = i; continue; }
      if (c === "{" || c === "[") {
        const key = top ? (top.t === "o" ? top.curKey : top.key) : null;
        if (top && top.t === "a" && this.stack.length === 2 && top.key === "blocks" && c === "{") this.blockIdx++;
        this.stack.push({ t: c === "{" ? "o" : "a", key, start: i, expectKey: c === "{", curKey: null });
        continue;
      }
      if (c === "}" || c === "]") {
        const f = this.stack.pop();
        if (f && f.t === "o") this.closed(f, i, out);
        continue;
      }
      if (c === "," && top && top.t === "o") top.expectKey = true;
    }
    return out;
  }

  private sculptSoFar(depth: number, end: number, out: LivePiece[]): void {
    const part = this.stack[depth - 2], list = this.stack[depth - 3];
    const rootParts = depth === 4 && list?.key === "parts";
    const blockParts = depth === 6 && list?.key === "parts" && this.stack[1]?.key === "blocks";
    if (!part || part.t !== "o" || !(rootParts || blockParts)) return;
    if (rootParts && this.blockIdx < 0) this.blockIdx = 0;
    if (this.blockIdx < 0) return;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(this.buf.slice(part.start, end + 1) + "]}") as Record<string, unknown>; } catch { return; }
    if (raw.shape !== "sculpt" || !raw.name) return;
    const idx = this.blockIdx;
    this.begin("model", out);
    const parts = sanitizeModelPart({ ...raw, res: Math.min(Number(raw.res) || 64, 30) }, this.style.get(idx) ?? "", 2, this.edge.get(idx) ?? "");
    if (parts.length && parts[0]!.shape === "sculpt") out.push({ op: "part", idx, parts, partial: true });
  }

  private begin(kind: "model" | "story", out: LivePiece[]): void {
    if (this.begun.has(this.blockIdx)) return;
    this.begun.set(this.blockIdx, kind);
    out.push({ op: "begin", idx: this.blockIdx, kind, style: this.style.get(this.blockIdx), look: this.look.get(this.blockIdx) });
  }

  /** action:"model" keeps style/look/edge at the root of the call, next to parts[]. */
  private rootString(key: string | null, val: string): void {
    if (key === "style") this.style.set(0, val);
    else if (key === "look") this.look.set(0, val);
    else if (key === "edge") this.edge.set(0, val);
  }

  private blockString(key: string | null, raw: string, out: LivePiece[]): void {
    let val = raw;
    try { val = JSON.parse(`"${raw}"`) as string; } catch { /* keep the raw slice */ }
    const kind = this.begun.get(this.blockIdx);
    if (key === "type" && (val === "model" || val === "story")) this.begin(val, out);
    else if (key === "style") this.style.set(this.blockIdx, val);
    else if (key === "look") this.look.set(this.blockIdx, val);
    else if (key === "edge") this.edge.set(this.blockIdx, val);
    else if (key === "title" && kind) out.push({ op: "title", idx: this.blockIdx, title: val.slice(0, 60) });
  }

  private closed(f: Frame, end: number, out: LivePiece[]): void {
    const depth = this.stack.length, parent = this.stack[depth - 1];
    if (!parent || parent.t !== "a") return;
    // a sculpt grows blob by blob: each finished blob re-sends the part so far (coarse), so the clay is seen melting together
    if (parent.key === "blobs" && depth >= 4) this.sculptSoFar(depth, end, out);
    // blocks[i].parts[j] / blocks[i].scenes[j]
    const inBlocks = depth === 4 && this.stack[1]?.key === "blocks";
    const rootAnims = depth === 2 && parent.key === "anims";
    if (rootAnims && this.blockIdx < 0) this.blockIdx = 0;
    if ((inBlocks || rootAnims) && parent.key === "anims" && this.blockIdx >= 0) {
      let raw: unknown;
      try { raw = JSON.parse(this.buf.slice(f.start, end + 1)); } catch { return; }
      const anim = sanitizeAnim(raw);
      if (anim) out.push({ op: "anim", idx: this.blockIdx, anim });
      return;
    }
    // action:"model" puts parts at the root: { parts:[...] } is one model block
    if (depth === 2 && parent.key === "parts" && this.blockIdx < 0) this.blockIdx = 0;
    const rootParts = depth === 2 && parent.key === "parts";
    if ((inBlocks || rootParts) && (parent.key === "parts" || parent.key === "scenes") && this.blockIdx >= 0) {
      let raw: unknown;
      try { raw = JSON.parse(this.buf.slice(f.start, end + 1)); } catch { return; }
      const idx = this.blockIdx, n = this.counts.get(idx) ?? 0;
      if (n >= 220) return;
      if (parent.key === "parts") {
        this.begin("model", out);
        const parts = sanitizeModelPart(raw, this.style.get(idx) ?? "", 220 - n, this.edge.get(idx) ?? "");
        this.counts.set(idx, n + parts.length);
        if (parts.length) out.push({ op: "part", idx, parts });
      } else {
        this.begin("story", out);
        const scene = sanitizeScene(raw);
        this.counts.set(idx, n + 1);
        if (scene && n < 24) out.push({ op: "scene", idx, scene });
      }
      return;
    }
    if (depth === 2 && parent.key === "blocks" && this.begun.has(this.blockIdx)) out.push({ op: "end", idx: this.blockIdx });
  }
}

/** Runs inside the live stage page (classic script, no module). Queues posted
 *  pieces until the engine modules have registered, then drives them. */
export const LIVE_RUNTIME_JS = `
(function(){
  var q=[],els={};
  function eng(kind){var b=window.__aresBuild;return b&&b[kind==="story"?"tale":"rig"]}
  function handle(m){
    var host=document.getElementById("lv-host"),el;
    if(m.op==="begin"){
      el=document.createElement("div");el.className=m.kind==="story"?"k-tale":"k-rig";
      el.setAttribute("data-spec",JSON.stringify({live:true,parts:[],scenes:[],title:"",caption:"",style:m.style||"",look:m.look||""}));
      var h2=document.createElement("h2");h2.textContent="…";host.appendChild(h2);els["t"+m.idx]=h2;
      host.appendChild(el);eng(m.kind)(el);els[m.idx]=el;
      if(m.kind==="model"||m.kind==="story")document.body.setAttribute("data-live",m.kind);
      return}
    el=els[m.idx];if(m.op==="title"){var h=els["t"+m.idx];if(h)h.textContent=m.title}
    if(!el||!el.__live)return;
    if(m.op==="part"&&m.partial&&el.__live.sculpt)el.__live.sculpt(m.parts);
    else if(m.op==="part")el.__live.addParts(m.parts);
    else if(m.op==="scene")el.__live.addScene(m.scene);
    else if(m.op==="anim")el.__live.addAnim(m.anim);
    else if(m.op==="end")el.__live.finish();
  }
  function drain(){
    while(q.length){var m=q[0];if(m.op==="begin"&&!eng(m.kind))return;q.shift();try{handle(m)}catch(e){console.error(e)}}
  }
  window.__aresDrain=drain;
  addEventListener("message",function(e){var m=e.data;if(m&&m.ares==="live"&&m.piece){q.push(m.piece);drain()}});
})();
`.trim();
