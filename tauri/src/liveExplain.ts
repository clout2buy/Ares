// Live explain: while Ares is still WRITING a Browser `explain` call, show its
// `model` / `story` blocks building in the Forge piece by piece. Feeds the
// partial tool-input stream (tool_use_input_delta) through ExplainStream, loads
// the live stage page into the embedded browser, and posts each finished part /
// scene to it. When the real explain page lands, handoff() tells the loader to
// open it already settled (window.__aresInstant) so nothing replays.

import { ExplainStream, type LivePiece } from "../../packages/cli/src/entry/forgeLive";
import { buildLiveStageHtml } from "../../packages/cli/src/entry/forgeKit";

interface LiveHost {
  load: (html: string) => Promise<{ ok: boolean }>;
  post: (msg: unknown) => void;
}

interface LiveEv { type?: string; id?: string; name?: string; deltaJson?: string }

export function createLiveExplain(deps: { host: () => LiveHost | null; show: () => void }) {
  let cur: { id: string; stream: ExplainStream; loading: Promise<boolean> | null; shown: boolean; queue: LivePiece[] } | null = null;

  const deliver = (c: NonNullable<typeof cur>, pieces: LivePiece[]): void => {
    const h = deps.host();
    if (c.loading || !c.shown || !h) { c.queue.push(...pieces); return; }
    for (const piece of pieces) h.post(piece);
  };

  const start = (c: NonNullable<typeof cur>): void => {
    if (c.shown || c.loading) return;
    deps.show();
    c.loading = (async () => {
      let h = deps.host();
      for (let i = 0; i < 40 && !h; i++) { await new Promise((r) => setTimeout(r, 33)); h = deps.host(); }
      if (!h) return false;
      const r = await h.load(buildLiveStageHtml());
      if (!r.ok || cur !== c) return false;
      c.shown = true;
      c.loading = null;
      const q = c.queue.splice(0);
      for (const piece of q) h.post(piece);
      return true;
    })();
  };

  return {
    onEvent(ev: LiveEv): void {
      if (ev.type === "tool_use_start") { cur = ev.name === "Browser" && ev.id ? { id: ev.id, stream: new ExplainStream(), loading: null, shown: false, queue: [] } : null; return; }
      if (!cur || ev.id !== cur.id) return;
      if (ev.type === "tool_use_input_delta" && ev.deltaJson) {
        let pieces: LivePiece[] = [];
        try { pieces = cur.stream.feed(ev.deltaJson); } catch { return; }
        if (!pieces.length) return;
        if (!cur.shown && !cur.loading) start(cur);
        deliver(cur, pieces);
      }
    },
    /** True when a live stage is on screen for the call that is now loading its
     *  final page. Consumes the live state either way. */
    handoff(): boolean {
      const had = !!cur && (cur.shown || !!cur.loading);
      cur = null;
      return had;
    },
  };
}

/** Make a kit page open already finished (skips the pixel resolve + the build). */
export function settled(html: string): string {
  return html.replace(/<head>/i, "<head><script>window.__aresInstant=1</script>");
}
