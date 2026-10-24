// Dev-only: make a plain browser tab behave like the desktop shell by routing
// Tauri commands to scripts/dev-web-bridge.mjs (a real daemon on loopback).
// Active only in `vite dev` AND with ?bridge=<url>; inert in every build.

type Internals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback: (cb: unknown) => number;
  convertFileSrc: (path: string) => string;
  metadata: unknown;
};

(function installDevBridge() {
  try {
    if (!import.meta.env.DEV) return;
    const g = globalThis as unknown as { isTauri?: boolean; __ARES_DEV_BRIDGE__?: string; __TAURI_INTERNALS__?: Internals; __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown };
    if (g.isTauri) return;
    const base = new URLSearchParams(location.search).get("bridge");
    if (!base) return;
    const url = base.replace(/\/+$/, "");
    g.isTauri = true;
    // Native-only views (the Forge's child webview) check this to fall back to HTML.
    g.__ARES_DEV_BRIDGE__ = url;
    g.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    // The desktop shell PUSHES each daemon event ("ares:event-buffered"); the
    // app's 4s drain is only a safety net. Without a push here every reply in
    // the preview waited up to 4s, so a skill toggle looked dead (2026-10-23).
    // Fake the push: poll the bridge fast and hand events to the listener; the
    // app drops any seq it has already seen, so the slow drain can't double up.
    const callbacks = new Map<number, (event: unknown) => void>();
    let nextCallback = 1;
    let pushing = false;
    const startPush = (handler: number) => {
      if (pushing) return;
      pushing = true;
      let after = 0;
      const tick = async () => {
        try {
          const res = await fetch(`${url}/invoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "ares_drain_events", args: { after } }) });
          const body = (await res.json()) as { ok: boolean; value?: Array<{ seq: number }> };
          for (const buffered of body.value ?? []) {
            after = Math.max(after, buffered.seq);
            callbacks.get(handler)?.({ event: "ares:event-buffered", id: 0, payload: buffered });
          }
        } catch { /* bridge restarting: the next tick catches up */ }
        setTimeout(tick, 150);
      };
      void tick();
    };
    g.__TAURI_INTERNALS__ = {
      transformCallback: (cb: unknown) => {
        const id = nextCallback++;
        if (typeof cb === "function") callbacks.set(id, cb as (event: unknown) => void);
        return id;
      },
      convertFileSrc: (p: string) => `${url}/file?path=${encodeURIComponent(p)}`,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd.startsWith("plugin:event|listen")) {
          if (args?.event === "ares:event-buffered" && typeof args.handler === "number") startPush(args.handler);
          return 1;
        }
        if (cmd.startsWith("plugin:")) return null;
        const res = await fetch(`${url}/invoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd, args: args ?? {} }) });
        const body = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
        if (!body.ok) throw new Error(body.error ?? `${cmd} failed`);
        return body.value;
      },
    };
    console.info(`[ares dev bridge] attached to ${url}`);
  } catch (err) {
    console.warn("[ares dev bridge] not installed:", err);
  }
})();
